import dotenv from "dotenv"
dotenv.config()

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import P from "pino"
import axios from "axios"
import QRCode from "qrcode"
import makeWASocket, { DisconnectReason, downloadMediaMessage, useMultiFileAuthState } from "@whiskeysockets/baileys"
import { extractMediaInfo } from "./helpers/wa-media-helpers.js"


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const mediaStore = new Map()

export function rememberMediaMessage(perid){
    const id = perid.key?.id
    if(!id) return
    mediaStore.set(id, perid)

    setTimeout(()=> mediaStore.delete(id), 10*60*1000)
}

export function getMediaMessage(id){
    return mediaStore.get(id)
}

function ensureDir(p) {
    if(!fs.existsSync(p)) fs.mkdirSync(P, {recursive: true})
}

function guessExt(mimetype, kind) {
    if(!mimetype){
        if (kind === 'image') return '.jpg'
        if (kind === 'video') return '.mp4'
        if (kind === 'audio') return '.ogg'
        if (kind === 'sticker') return '.webp'
        return ''
    }
    if (mimetype.includes('jpeg')) return '.jpg'
    if (mimetype.includes('png')) return '.png'
    if (mimetype.includes('webp')) return '.webp'
    if (mimetype.includes('mp4')) return '.mp4'
    if (mimetype.includes('pdf')) return '.pdf'
    if (mimetype.includes('ogg')) return '.ogg'
    return ''
}

export async function downloadIncomingMedia(webMessageInfo) {
    const info = extractMediaInfo(webMessageInfo)
    if(!info) return null

    const downloadsDir = path.join(__dirname, 'download')
    ensureDir(downloadsDir)

    const mimetype = info.content.mimetype
    const ext = guessExt(mimetype, info.kind)

    const messageId = webMessageInfo.key?.id || `${Date.now()}`
    const remoteJid = (webMessageInfo.key?.remoteJid || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
    const fileBase = `${remoteJid}_${messageId}${ext}`
    const filePath = path.join(downloadsDir, fileBase)
    
    const buffer = await downloadMediaMessage(webMessageInfo, 'buffer', {}, logger)

    fs.writeFileSync(filePath, buffer)

    return {
        kind: info.kind, 
        mimetype, 
        caption: info.caption || null,
        fileName: info.fileName || fileBase,
        savedAs: fileBase,
        path: filePath,
        size: buffer.length
    }
}



const logger = P({level: process.env.LOG_LEVEL || 'info'})

let sock = null
let latestQR = null
let connectionState = 'idle'

function safeJson(err){
    return{
        message: err?.message,
        name: err?.name,
        stack: err?.stack,
        responseStatus: err?.response?.status,
        responseData: err?.response?.data
    }
}

async function postWebhook(eventName, payload) {
    const url = process.env.WEBHOOK_URL
    if(!url) return
    try {
        await axios.post(url, {
            event: eventName,
            ts: Date.now(),
            data: payload
        }, 
        {
            headers: { Authorization: `Bearer ${process.env.N8N_TOKEN}`},
            timeout: 10_000 
        })
        
    } catch (e) {
        logger.warn({err: safeJson(e)}, 'Webhook post failed')
    }
}

export function getWAStatus() {
    return {
        connectionState,
        hasSocket: !!sock,
        hasQR: !!latestQR
    }
}

export async function getLatestQRAsTerminal() {
    if(!latestQR) return null
    return await QRCode.toString(latestQR, {type: 'terminal'})
}

export async function startWA() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_demo')

    sock = makeWASocket({
        auth: state,
        logger,
        getMessage: async () => undefined
    })

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if(qr) {
            latestQR = qr
            connectionState = 'qr'
            logger.info('QR Updated (scan from phone)')
            await postWebhook('coonection.qr', {qr})
        }

        if(connection){
            connectionState = connection
            logger.info({connection}, 'Connection state update')
            await postWebhook('connection.update', {connection})
        }

        if(connection === 'close'){
            const statusCode = lastDisconnect?.error?.output?.statusCode
            logger.warn({statusCode}, 'Connection closed')

            if(statusCode === DisconnectReason.restartRequired){
                logger.warn('Restart required, recreating socket...')
                await startWA()
            }
        }

        if(connection === 'open'){
            latestQR = null
            await postWebhook('connection.open', {ok: true})
        }
    })

    sock.ev.on('messages.upsert', async ({type, messages}) => {
        for(const m of messages){
            if(!m?.message) continue
            const fromMe = m.key?.fromMe
            if (fromMe) continue
            const remoteJid = m.key?.remoteJid

            const msgType = Object.keys(m.message || {})[0] || 'unknown'

            const text = m.message?.conversation || m.message?.extendedTextMessage?.text || null

            const hasMedia = !!(
                m.message?.imageMessage || 
                m.message?.videoMessage ||
                m.message?.documentMessage ||
                m.message?.audioMessage ||
                m.message?.stickerMessage
            )
            if(hasMedia){
                // auto download media
                const mediaInfo = extractMediaInfo(m)
                if(mediaInfo){
                    rememberMediaMessage(m)

                    await postWebhook('media.received', {
                        remoteJid: m.key?.remoteJid,
                        messageId: m.key?.id,
                        kind: mediaInfo.kind,
                        mimetype: mediaInfo.content?.mimetype || null,
                        caption: mediaInfo.caption || null,
                        fileName: mediaInfo.fileName || null,
                        fetchUrl: `${process.env.PUBLIC_BASE_URL}/media/${m.key?.id}`
                    })
                }
                continue
            }else {
                await postWebhook('messages.upsert', {
                    upsertType: type,
                    remoteJid,
                    fromMe,
                    msgType,
                    text, 
                    hasMedia, 
                    messageId: m.key?.id,
                    participant: m.key?.participant,
                    timestamp: m.messageTimestamp
                    
                })
            }
        }
    })

    sock.ev.on('messages.update', async (updates) => {
        await postWebhook('messages.update', updates)
    })
    sock.ev.on('messages.delete', async (item) => {
        await postWebhook('messages.delete', item)
    })

    sock.ev.on('messages.reaction', async (reactions) => {
        await postWebhook('messages.reaction', reactions)
    })

    // ====== Contacts/Groups/Chats (optional) ======
    sock.ev.on('chats.upsert', async (chats) => postWebhook('chats.upsert', chats))
    sock.ev.on('chats.update', async (chats) => postWebhook('chats.update', chats))
    sock.ev.on('groups.upsert', async (groups) => postWebhook('groups.upsert', groups))
    sock.ev.on('groups.update', async (groups) => postWebhook('groups.update', groups))
    sock.ev.on('group-participants.update', async (u) => postWebhook('group-participants.update', u))

    return sock
}

export async function sendText(toJid, text) {
    if(!sock) throw new Error("Socket not initialized");
    return await sock.sendMessage(toJid, {text})
}

export async function downloadMedia(webMessageInfo) {
    if (!sock) throw new Error('Socket not initialized')
    const buffer = await downloadMediaMessage(
        webMessageInfo,
        'buffer',
        {},
        { logger }
    )
    return buffer
}

export async function requestPairingCode(phoneNumberE164NoPlus) {
    if(!sock) throw new Error("Socket not initialized");
    if(!phoneNumberE164NoPlus) throw new Error("Phone number is required");

    const code = await sock.requestPairingCode(phoneNumberE164NoPlus)
    return code   
}

export async function resendMedia(toJid, webMessageInfo, overrideCaption = null) {
    const info = extractMediaInfo(webMessageInfo)
    if(!info) throw new Error("No media in message");
    
    const buffer = await downloadMediaMessage(webMessageInfo, 'buffer', {})
    if(info.kind === 'image'){
        return await sock.sendMessage(toJid, { image: buffer, caption: overrideCaption ?? info.caption ?? ''})
    }

    throw new Error("Unsupported media kind");
    
}

export function getSocket(){
    return sock
}
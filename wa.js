if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv')
  dotenv.config()
}

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import P from "pino"
import axios from "axios"
import QRCode from "qrcode"
import makeWASocket, { DisconnectReason, downloadMediaMessage, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys"
import { extractMediaInfo } from "./helpers/wa-media-helpers.js"
import { useRedisAuthState, deleteRedisSession } from "./middleware/redis-auth.js"
import { storeMediaMessage } from "./helpers/media-store.js"
import { detachAllListeners, hardCloseSocket, onSockEvent } from "./wa-connection.js"


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const mediaStore = new Map()

import readline from "readline"
import pino from "pino"

function question(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(promptText, (ans) => {
      rl.close()
      resolve(ans)
    })
  )
}

function getWebhookUrls() {
  const isProd = process.env.NODE_ENV === 'production'
  const raw = (isProd ? process.env.N8N_WEBHOOK_URLS_PROD : process.env.N8N_WEBHOOK_URLS_DEV) || ''
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}


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
    if(!fs.existsSync(p)) fs.mkdirSync(p, {recursive: true})
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
    const url = getWebhookUrls()
    if(url.length === 0) return

    const body = {
        event: eventName,
        ts: Date.now(),
        data: payload
    }

    const config = {
        headers: process.env.N8N_TOKEN ? 
        { Authorization: `Bearer ${process.env.N8N_TOKEN}` } :
        undefined,
        timeout: 10_000,
    }

    const result = await Promise.allSettled(
        url.map(perdi => axios.post(perdi, body, config))
    )

    const failed = result
        .map((r, i) => ({r, url: url[i]}))
        .filter(x => x.r.status === 'rejected')

    if (failed.length){
        logger.warn(
            {failed: failed.map(f => ({url: f.url, err: safeJson(f.r.reason)}))},
            'some webhook posts failed'
        )
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

let saveCredsFn = null;
let sessionIdActive = null;
let reloading = false;
let reconnectAttempts = 0;
const RECONNECT_BACKOFF_MS = [0, 2000, 5000, 10000];

function getReconnectDelayMs() {
    return RECONNECT_BACKOFF_MS[Math.min(reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let pairingInProgress = false
let pairingMode = false
let lastPairingCode = null
let lastPairingCodeAt = 0

export function setPairingMode(v) { pairingMode = v }

export async function beginPairing({ phoneNumberE164NoPlus, deviceName = "BOT" }) {
  if (!sock) throw new Error("Socket not initialized")
  if (sock.authState.creds.registered) return { alreadyPaired: true, code: null }

  // ✅ If already in progress, return last code if still fresh
  if (pairingInProgress) {
    const fresh = Date.now() - lastPairingCodeAt < 60_000
    return { alreadyPaired: false, code: fresh ? lastPairingCode : null, pending: true }
  }

  pairingInProgress = true
  pairingMode = true

  try {
    const phone = phoneNumberE164NoPlus.replace(/^\+/, "").replace(/\s+/g, "")
    const code = await sock.requestPairingCode(phone, deviceName)

    lastPairingCode = code
    lastPairingCodeAt = Date.now()

    return { alreadyPaired: false, code, pending: false }
  } finally {
    setTimeout(() => { pairingInProgress = false }, 8000)
  }
}

export function bindWAHandlers(sock) {
    onSockEvent(sock, "creds.update", async () => {
        try {
            await saveCredsFn?.();
            if (sock?.authState?.creds?.registered) {
                pairingMode = false
            }
        } catch (e) {
            logger.warn({ err: safeJson(e) }, "Failed to save WA creds");
        }
    });

    onSockEvent(sock, "connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionState = "qr";
            logger.info("QR Updated (scan from phone)");
            await postWebhook("connection.qr", { qr });
        }

        if (connection) {
            connectionState = connection;
            logger.info({ connection }, "Connection state update");
            await postWebhook("connection.update", { connection });
        }

        if (connection === "close") {
            const statusCode =
                lastDisconnect?.error?.output?.statusCode ||
                lastDisconnect?.error?.output?.payload?.statusCode

            // ✅ if we are pairing, don’t hard reload loop
            if (pairingMode) {
                logger.warn({ statusCode }, "Closed during pairing; not forcing reload loop")
                return
            }
            if (!sock?.authState?.creds?.registered) {
                logger.warn({ statusCode }, "Closed during registration; not forcing reload")
                return
            }

            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut &&
                statusCode !== DisconnectReason.badSession

            if (shouldReconnect) {
                const delayMs = getReconnectDelayMs()
                reconnectAttempts += 1
                if (delayMs > 0) await sleep(delayMs)
                await reloadWA({ force: true }, bindWAHandlers)
            }
        }

        if (connection === "open") {
            pairingMode = false
            pairingInProgress = false
            latestQR = null;
            reconnectAttempts = 0;
            await postWebhook("connection.open", { ok: true });
        }
    });

    onSockEvent(sock, "messages.upsert", async ({ type, messages }) => {
        for (const m of messages) {
            if (!m?.message) continue;
            const fromMe = m.key?.fromMe;
            if (fromMe) continue;

            const msgType = Object.keys(m.message || {})[0] || "unknown";
            const text = m.message?.conversation || m.message?.extendedTextMessage?.text || null;

            const hasMedia = !!(
                m.message?.imageMessage ||
                m.message?.videoMessage ||
                m.message?.documentMessage ||
                m.message?.audioMessage ||
                m.message?.stickerMessage
            );

            if (hasMedia) {
                // auto download media
                await storeMediaMessage(m.key?.id, m, 600);
                const mediaInfo = extractMediaInfo(m);
                if (mediaInfo) {
                    rememberMediaMessage(m);

                    await postWebhook("media.received", {
                        remoteJid: m.key?.remoteJidAlt ?? m.key?.remoteJid,
                        messageId: m.key?.id,
                        mkey: m.key,
                        kind: mediaInfo.kind,
                        mimetype: mediaInfo.content?.mimetype || null,
                        caption: mediaInfo.caption || null,
                        fileName: mediaInfo.fileName || null,
                        fetchUrl: `${process.env.PUBLIC_BASE_URL}/media/${m.key?.id}`
                    });
                }
                continue;
            }

            await postWebhook("messages.upsert", {
                upsertType: type,
                remoteJid: m.key?.remoteJidAlt ?? m.key?.remoteJid,
                mkey: m.key,
                fromMe,
                msgType,
                text,
                hasMedia,
                messageId: m.key?.id,
                participant: m.key?.participant,
                timestamp: m.messageTimestamp
            });
        }
    });

    // Optional events (enable as needed)
    // onSockEvent(sock, "messages.update", async (updates) => postWebhook("messages.update", updates));
    // onSockEvent(sock, "messages.delete", async (item) => postWebhook("messages.delete", item));
    // onSockEvent(sock, "messages.reaction", async (reactions) => postWebhook("messages.reaction", reactions));
    // onSockEvent(sock, "groups.upsert", async (groups) => postWebhook("groups.upsert", groups));
    // onSockEvent(sock, "groups.update", async (groups) => postWebhook("groups.update", groups));
    // onSockEvent(sock, "group-participants.update", async (u) => postWebhook("group-participants.update", u));
}

export async function startWA(
  sessionId = process.env.WA_SESSION_ID || "main",
  bindHandlersFn = bindWAHandlers,
  {
    usePairingCode = true,
    pairingDeviceName = process.env.WA_PAIR_DEVICE_NAME || "MIKU21MD",
    phoneNumberE164NoPlus = process.env.WA_PHONE_NO_PLUS || null,
  } = {}
) {
  sessionIdActive = sessionId
  const { state, saveCreds } = await useRedisAuthState(sessionId)
  saveCredsFn = saveCreds

  const cachedKeys = makeCacheableSignalKeyStore(state.keys, logger)

  sock = makeWASocket({
    printQRInTerminal: !usePairingCode,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000,
    generateHighQualityLinkPreview: true,
    patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
            message.buttonsMessage ||
            message.templateMessage ||
            message.listMessage
        );
        if (requiresPatch) {
            message = {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadataVersion: 2,
                            deviceListMetadata: {},
                        },
                        ...message,
                    },
                },
            };
        }

        return message;
    },
    version: [99963, 950125916, 0],
    logger: pino({
        level: 'silent' // Set 'fatal' for production
    }),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino().child({
            level: 'silent',
            stream: 'store'
        })),
    }
  })

  // bind handlers
  if (typeof bindHandlersFn === "function") bindHandlersFn(sock)

  // ✅ AUTO-PAIR if not registered
  if (usePairingCode && !sock.authState.creds.registered) {
    let phone = phoneNumberE164NoPlus

    if (!phone) {
      phone = (await question("Enter phone number (E.164 no plus, ex: 62812xxxx): ")).trim()
    }

    // Baileys expects E.164 WITHOUT "+"
    phone = phone.replace(/^\+/, "").replace(/\s+/g, "")

    console.log("WOI", phone)
    const code = await sock.requestPairingCode(phone)
    console.log("WOI", code)
    logger.info({ phone }, "Pairing code generated. Enter this code in WhatsApp > Linked devices.")
    console.log(`\nPAIRING CODE: ${code}\n`)
  }

  return sock
}

export async function reloadWA({ force = false } = {}, bindHandlersFn = bindWAHandlers) {
  if (!sessionIdActive) sessionIdActive = process.env.WA_SESSION_ID || "main"
  if (reloading) return sock
  reloading = true

  logger.warn({ force }, "Reloading WA socket")

  try {
    if (sock) {
      // 1) detach known handlers (prevents duplicates)
      detachAllListeners(sock)

      // 2) close socket hard
      if (force) {
        hardCloseSocket(sock)
      }

      // ✅ 3) IMPORTANT: allow fresh socket creation
      sock = null
      latestQR = null
      connectionState = "idle"
    }

    // 4) recreate
    await startWA(sessionIdActive, bindHandlersFn, { usePairingCode: true })
    return sock
  } finally {
    reloading = false
  }
}

export async function sendText(toJid, text) {
    if(!sock) throw new Error("Socket not initialized");
    return await sock.sendMessage(toJid, {text})
}
export async function sendTyping(toJid) {
    if(!sock) throw new Error("Socket not initialized");
    return await sock.sendPresenceUpdate('composing', toJid)
}

export async function sendAvailable(toJid) {
    if(!sock) throw new Error("Socket not initialized");
    return await sock.sendPresenceUpdate('available', toJid)
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

export async function unpairWA() {
    if (!sock) throw new Error("Socket not initialized");

    logger.warn("Unpairing / logging out WhatsApp session...");

    try {
        // 1. Logout from WhatsApp
        await sock.logout();
    } catch (e) {
        logger.warn({ err: e?.message }, "Logout failed (maybe already disconnected)");
    }

    try {
        // 2. Close socket hard
        hardCloseSocket(sock);
    } catch (e) {
        logger.warn({ err: e?.message }, "Hard close failed");
    }

    // 3. Clear local state
    sock = null;
    latestQR = null;
    connectionState = "idle";
    reconnectAttempts = 0;

    // 4. Delete session from Redis
    if (sessionIdActive) {
        await deleteRedisSession(sessionIdActive);
    }

    return true;
}
import dotenv from "dotenv"
dotenv.config()

import express from 'express'
import multer from 'multer'
import { getLatestQRAsTerminal, getMediaMessage, getSocket, getWAStatus, requestPairingCode, sendAvailable, sendText, sendTyping, startWA } from './wa.js'
import path from "path"
import { downloadMediaMessage } from "@whiskeysockets/baileys"

const app = express()
const upload = multer()

app.use(express.json({limit: '2mb'}))

app.get('/health', (req, res) =>{
    res.json({ok: true, service: 'wa-express-app'})
})

app.get('/wa/status', async (req, res) => {
    res.json(getWAStatus())
})

app.get('/wa/qr', async (req,res) => {
    const qr = await getLatestQRAsTerminal()
    if(!qr) return res.status(404).json({ok: false, message: 'No QR available (maybe already connected)' })
    res.type('text/plain').send(qr)
})

app.post('/wa/pair', async (req, res) => {
    const { phone } = req.body || {}
    if(!phone) return res.status(400).json({ok: false, message: 'phone is required (E.164 without +)'})

    try {
        const code = await requestPairingCode(phone)
        res.json({ok: true, code})
    }catch(e){
        res.status(500).json({ ok: false, error: e?.message})
    }
})

app.post('/send-image', async (req, res) => {
    const { to, url, caption } = req.body || {}
    if(!to || !url) return res.status(400).json({ok: false, message: 'to and url required'})

    try {
        const toJID = to.includes('@') ? to : `${to}@s.whatsapp.net`
        const result = await getSocket().sendMessage(toJID, {
            image: { url },
            caption: caption || ""
        })
        res.json({ ok: true, result})
    } catch (e) {
        res.status(500).json({ok: false, error: e?.message})
    }
})

app.post('/send-text', async (req, res) => {
    const {to, text} = req.body || {}
    if (!to || !text) return res.status(400).json({ok: false, message: 'to and text are required'})
    
    try {
        const toJID = to.endsWith("@s.whatsapp.net") ? to : to + "@s.whatsapp.net"
        const result = await sendText(toJID, text)
        res.json({ok: true, result})
    } catch (e) {
        res.status(500).json({ok: false, error: e?.message})
    }
})

app.post('/send-typing', async (req, res) => {
    const {to} = req.body || {}
    if(!to)  return res.status(400).json({ok: false, message: 'to jid parameter are required'})
    try {
        const toJID = to.endsWith("@s.whatsapp.net") ? to : to + "@s.whatsapp.net"
        const result = await sendTyping(toJID)
        res.json({ok: true, result})
    } catch (error) {
        res.status(500).json({ok: false, error: e?.message})
    }
})

app.post('/send-online', async (req, res) => {
    const {to} = req.body || {}
    if(!to)  return res.status(400).json({ok: false, message: 'to jid parameter are required'})
    try {
        const toJID = to.endsWith("@s.whatsapp.net") ? to : to + "@s.whatsapp.net"
        const result = await sendAvailable(toJID)
        res.json({ok: true, result})
    } catch (error) {
        res.status(500).json({ok: false, error: e?.message})
    }
})

app.get('/media/:messageId', async (req,res) => {
    const {messageId} = req.params
    const perid = getMediaMessage(messageId)
    if(!perid) return res.status(404).json({ ok: false, message: 'Media not found/expired' })
    
    try {
        const buffer = await downloadMediaMessage(perid, 'buffer', {}, {logger: getSocket()?.logger})
        const msg = perid.message
        const mediaNode = msg?.imageMessage || msg?.videoMessage || msg?.documentMessage || msg?.audioMessage || msg?.stickerMessage ||
      msg?.viewOnceMessage?.message?.imageMessage ||
      msg?.viewOnceMessage?.message?.videoMessage

        const mimetype = mediaNode?.mimetype || 'application/octet-stream'
        res.setHeader('Content-Type', mimetype)
        res.setHeader('Content-Length', buffer.length)

        if(mediaNode?.fileName){
            res.setHeader('Content-Disposition', `attachment; filename="${mediaNode.fileName}"`)            
        }
        res.send(buffer)
    } catch (e) {
        res.status(500).json({ ok: false, error: e?.message })
    }
})
app.use('/download', express.static(path.resolve('./download')))


const PORT = process.env.PORT || 3333
// console.log(process.env)
app.listen(PORT, async () => {
    console.log(`API listening on http://localhost:${PORT}`)
    await startWA()
})
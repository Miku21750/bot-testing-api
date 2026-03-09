if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv')
  dotenv.config()
}


import express from 'express'
import multer from 'multer'
import { beginPairing, bindWAHandlers, getLatestQRAsTerminal, getMediaMessage, getSocket, getWAStatus, reloadWA, requestPairingCode, sendAvailable, sendText, sendTyping, startWA, unpairWA  } from './wa.js'
import path from "path"
import { downloadMediaMessage } from "@whiskeysockets/baileys"
import { requireBearer } from "./middleware/auth-http.js"
import { loadMediaMessage } from "./helpers/media-store.js"
import { downloadMessageMediaBuffer, getAudioNode } from './helpers/wa-download-media.js'

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

app.post("/wa/pair", async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ ok: false, error: "phone required" })

    if (!getSocket()) {
      await startWA(process.env.WA_SESSION_ID || "main", bindWAHandlers, { usePairingCode: true })
    }

    const result = await beginPairing({ phoneNumberE164NoPlus: phone })
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message })
  }
})

app.post('/wa/unpair', requireBearer, async (req, res) => {
    try {
        await unpairWA();

        res.json({
            ok: true,
            message: "WhatsApp session unpaired. Please re-pair."
        });
    } catch (e) {
        res.status(500).json({
            ok: false,
            error: e?.message
        });
    }
});

app.post('/send-image', requireBearer, async (req, res) => {
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

app.post('/send-text', requireBearer, async (req, res) => {
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
    console.log('[1] request mediaId =', messageId)
    // const perid = getMediaMessage(messageId)
    const perdisock = getSocket()
    if(!perdisock) return res.status(503).json({ ok: false, error: 'WA socket not available' })
    const perid = await loadMediaMessage(messageId)
    console.log('[2] loaded from redis =', !!perid)
    if(!perid) return res.status(404).json({ ok: false, message: 'Media not found/expired' })
    
    try {
        console.log('[3] start downloadMediaMessage')
        const buffer = await downloadMediaMessage(perid, 'buffer', {})
        console.log('[4] download finished, size =', buffer?.length)
        const msg = perid.message
        const mediaNode = msg?.imageMessage || msg?.videoMessage || msg?.documentMessage || msg?.audioMessage || msg?.stickerMessage ||
      msg?.viewOnceMessage?.message?.imageMessage ||
      msg?.viewOnceMessage?.message?.videoMessage

        console.log('[5] mediaNode =', !!mediaNode)

        const mimetype = mediaNode?.mimetype || 'application/octet-stream'
        res.setHeader('Content-Type', mimetype)
        res.setHeader('Content-Length', buffer.length)

        if(mediaNode?.fileName){
            res.setHeader('Content-Disposition', `attachment; filename="${mediaNode.fileName}"`)            
        }
        res.send(buffer)
    } catch (e) {
    console.error('[ERR] /media:', e)
        res.status(500).json({ ok: false, error: e?.message })
    }
})

app.get("/media/audio/:messageId", async (req,res) => {
    const { messageId } = req.params

    try {
        const perid = await loadMediaMessage(messageId)
        if(!perid) 
            return res.status(404).json({ ok: false, message: "Audio not found/expired" })
        
        const audioNode = getAudioNode(perid)
        if(!audioNode) return res.status(400).json({ ok: false, message: "Message is not an audio/voice note" })
        const buffer = await downloadMessageMediaBuffer(perid)

        const mimetype = audioNode.mimetype || "audio/ogg"        
        const ext = 
            mimetype.includes("ogg") ? "ogg" :
            mimetype.includes("mpeg") ? "mp3" :
            mimetype.includes("mp4") ? "m4a":
            "bin"
        const filename = audioNode.ptt 
            ? `voice-note-${messageId}.${ext}`
            : `audio-${messageId}.${ext}`
        res.setHeader("Content-Type", mimetype)
        res.setHeader("Content-Length", buffer.length)
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)

        return res.send(buffer);
    } catch (e) {
        console.error("GET /media/audio/:messageId error:", e)
        return res.status(500).json({
            ok: false,
            error: e?.message || "Unknown error"
        })
    }
})

app.get("/media/audio-base64/:messageId", async (req, res) => {
    const { messageId } = req.params

    try {
        const perid = await loadMediaMessage(messageId)
        if (!perid) {
            return res.status(404).json({
                ok: false,
                message: "Audio not found/expired"
            })
        }

        const audioNode = getAudioNode(perid)
        if (!audioNode) {
            return res.status(400).json({
                ok: false,
                message: "Message is not an audio/voice note"
            })
        }

        const buffer = await downloadMessageMediaBuffer(perid)

        return res.json({
            ok: true,
            messageId,
            kind: audioNode.ptt ? "voice-note" : "audio",
            ptt: !!audioNode.ptt,
            seconds: audioNode.seconds || null,
            mimetype: audioNode.mimetype || "audio/ogg",
            bytes: buffer.length,
            base64: buffer.toString("base64")
        })
    } catch (e) {
        console.error("GET /media/audio-base64/:messageId error:", e)
        return res.status(500).json({
            ok: false,
            error: e?.message || "Unknown error"
        })
    }
})
app.use('/download', express.static(path.resolve('./download')))


const PORT = process.env.PORT || 3333
// console.log(process.env)
app.listen(PORT, async () => {
    console.log(`API listening on http://localhost:${PORT}`)
    await startWA()
})
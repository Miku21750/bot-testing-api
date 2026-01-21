import { downloadMediaMessage } from "@whiskeysockets/baileys"

export function extractMediaInfo(webMessage) {
    const perid = webMessage?.message
    if(!perid) return null

    const viewOnce = perid.viewOnceMessage?.message ||
    perid.viewOnceMessageV2?.message || null

    const msg = viewOnce || perid

    if(msg.imageMessage) {
        return { kind: 'image', content: msg.imageMessage, caption: msg.imageMessage.caption || null}
    }
    if (msg.videoMessage) {
        return { kind: 'video', content: msg.videoMessage, caption: msg.videoMessage.caption || null }
    }
    if (msg.documentMessage) {
        return {
            kind: 'document',
            content: msg.documentMessage,
            caption: msg.documentMessage.caption || null,
            fileName: msg.documentMessage.fileName || 'file'
        }
    }
    if (msg.audioMessage) {
        return { kind: 'audio', content: msg.audioMessage, caption: null }
    }
    if (msg.stickerMessage) {
        return { kind: 'sticker', content: msg.stickerMessage, caption: null }
    }
    return null
}
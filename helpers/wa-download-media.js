import { downloadMediaMessage } from "@whiskeysockets/baileys"

export async function downloadMessageMediaBuffer(webMessageInfo, timeoutMs = 20000) {
    const downloadPromise = downloadMediaMessage(webMessageInfo, "buffer", {})
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Media download timeout")), timeoutMs)
    )

    const buffer = await Promise.race([downloadPromise, timeoutPromise])
    return buffer
}

export function getAudioNode(webMessageInfo) {
    const perid = webMessageInfo?.message
    if (!perid) return null

    const viewOnce =
        perid.viewOnceMessage?.message ||
        perid.viewOnceMessageV2?.message ||
        null

    const msg = viewOnce || perid

    return msg.audioMessage || null
}

export function getMediaNode(webMessageInfo) {
    const perid = webMessageInfo?.message
    if (!perid) return null

    const viewOnce =
        perid.viewOnceMessage?.message ||
        perid.viewOnceMessageV2?.message ||
        null

    const msg = viewOnce || perid

    return (
        msg.imageMessage ||
        msg.videoMessage ||
        msg.documentMessage ||
        msg.audioMessage ||
        msg.stickerMessage ||
        null
    )
}
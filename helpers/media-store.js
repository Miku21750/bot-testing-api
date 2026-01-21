import { BufferJSON } from "@whiskeysockets/baileys";
import Redis from "ioredis";
const redis = new Redis(process.env.REDIS_URL)

const kMedia = (id) => `wa:media:${id}`

export async function storeMediaMessage(messageId, webMessageInfo, ttlSec = 600) {
    await redis.set(kMedia(messageId), JSON.stringify(webMessageInfo, BufferJSON.replacer), 'EX', ttlSec)
}

export async function loadMediaMessage(messageId) {
    const raw = await redis.get(kMedia(messageId))
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null
}
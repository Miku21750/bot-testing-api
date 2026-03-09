if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv')
  dotenv.config()
}

import { BufferJSON, proto } from "@whiskeysockets/baileys";
import Redis from "ioredis";
const redis = new Redis(process.env.REDIS_URL)

const kMedia = (id) => `wa:media:${id}`

export async function storeMediaMessage(messageId, webMessageInfo, ttlSec = 600) {
    const bytes = proto.WebMessageInfo.encode(webMessageInfo).finish()
    await redis.set(kMedia(messageId), Buffer.from(bytes).toString('base64'), 'EX', ttlSec)
}

export async function loadMediaMessage(messageId) {
    const raw = await redis.get(kMedia(messageId))
    if(!raw) return null

    const bytes = Buffer.from(raw, 'base64')
    return proto.WebMessageInfo.decode(bytes);
    // return raw ? JSON.parse(raw, BufferJSON.reviver) : null
}
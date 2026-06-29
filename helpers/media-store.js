if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv')
  dotenv.config()
}
import baileys from "@whiskeysockets/baileys";
import Redis from "ioredis";

const { proto, downloadContentFromMessage  } = baileys;
const redisurl = process.env.REDIS_URL + process.env.DB_REDIS_LEVEL
const redis = new Redis(redisurl)

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

export function getMediaNode(webMessageInfo) {
  const msg = webMessageInfo?.message;
  if (!msg) return null;

  return (
    msg.imageMessage ||
    msg.videoMessage ||
    msg.documentMessage ||
    msg.audioMessage ||
    msg.stickerMessage ||
    msg.viewOnceMessage?.message?.imageMessage ||
    msg.viewOnceMessage?.message?.videoMessage ||
    msg.viewOnceMessageV2?.message?.imageMessage ||
    msg.viewOnceMessageV2?.message?.videoMessage
  );
}

export function getMediaType(webMessageInfo) {
  const msg = webMessageInfo?.message;
  if (!msg) return null;

  if (msg.imageMessage || msg.viewOnceMessage?.message?.imageMessage || msg.viewOnceMessageV2?.message?.imageMessage) {
    return "image";
  }

  if (msg.videoMessage || msg.viewOnceMessage?.message?.videoMessage || msg.viewOnceMessageV2?.message?.videoMessage) {
    return "video";
  }

  if (msg.audioMessage) return "audio";
  if (msg.documentMessage) return "document";
  if (msg.stickerMessage) return "sticker";

  return null;
}

export async function downloadMessageMediaBuffer(webMessageInfo) {
  const mediaNode = getMediaNode(webMessageInfo);
  const mediaType = getMediaType(webMessageInfo);

  if (!mediaNode || !mediaType) {
    throw new Error("Message does not contain downloadable media");
  }

  const stream = await downloadContentFromMessage(mediaNode, mediaType);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}
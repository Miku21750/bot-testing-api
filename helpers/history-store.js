import { BufferJSON } from "baileys"
import { getRedisClient } from "../middleware/redis-auth.js"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const PIPELINE_BATCH_SIZE = 250

function encodeKeyPart(value) {
  return encodeURIComponent(String(value || "unknown"))
}

function sessionPrefix(sessionId) {
  return `wa:${encodeKeyPart(sessionId)}:history`
}

function messageKey(sessionId, messageId) {
  return `${sessionPrefix(sessionId)}:message:${encodeKeyPart(messageId)}`
}

function messageIndexKey(sessionId, jid) {
  return `${sessionPrefix(sessionId)}:messages:${encodeKeyPart(jid)}`
}

function chatKey(sessionId) {
  return `${sessionPrefix(sessionId)}:chats`
}

function contactKey(sessionId) {
  return `${sessionPrefix(sessionId)}:contacts`
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "bigint") return Number(value)
  if (value && typeof value.toNumber === "function") return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function unwrapMessage(message) {
  let current = message
  for (let i = 0; i < 5 && current; i += 1) {
    const nested =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message

    if (!nested) break
    current = nested
  }
  return current || {}
}

export function extractMessageText(message) {
  const content = unwrapMessage(message)
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    null
  )
}

function getMessageType(message) {
  return Object.keys(unwrapMessage(message))[0] || "unknown"
}

function uniqueJids(message) {
  return [...new Set([
    message?.key?.remoteJidAlt,
    message?.key?.remoteJid,
  ].filter(Boolean))]
}

function serialize(value) {
  return JSON.stringify(value, BufferJSON.replacer)
}

function deserialize(value) {
  return value ? JSON.parse(value, BufferJSON.reviver) : null
}

function buildRecord(message) {
  const timestamp = toNumber(message?.messageTimestamp)
  const jids = uniqueJids(message)

  return {
    messageId: message?.key?.id,
    jid: jids[0] || null,
    aliases: jids,
    timestamp,
    fromMe: !!message?.key?.fromMe,
    participant: message?.key?.participantAlt || message?.key?.participant || null,
    pushName: message?.pushName || null,
    type: getMessageType(message?.message),
    text: extractMessageText(message?.message),
    raw: message,
  }
}

async function executeInBatches(operations) {
  const redis = getRedisClient()

  for (let offset = 0; offset < operations.length; offset += PIPELINE_BATCH_SIZE) {
    const pipeline = redis.pipeline()
    for (const operation of operations.slice(offset, offset + PIPELINE_BATCH_SIZE)) {
      operation(pipeline)
    }
    const results = await pipeline.exec()
    const error = results?.find(([pipelineError]) => pipelineError)?.[0]
    if (error) throw error
  }
}

export async function persistMessages(sessionId, messages = []) {
  const records = messages
    .filter(message => message?.key?.id && message?.message)
    .map(buildRecord)

  const operations = []
  for (const record of records) {
    const encoded = serialize(record)
    operations.push(pipeline => pipeline.set(messageKey(sessionId, record.messageId), encoded))

    for (const jid of record.aliases) {
      operations.push(pipeline => pipeline.zadd(
        messageIndexKey(sessionId, jid),
        record.timestamp,
        record.messageId,
      ))
    }
  }

  await executeInBatches(operations)
  return records.length
}

export async function persistHistoryPayload(sessionId, { chats = [], contacts = [], messages = [] } = {}) {
  const metadataOperations = []

  for (const chat of chats) {
    if (!chat?.id) continue
    metadataOperations.push(pipeline => pipeline.hset(chatKey(sessionId), chat.id, serialize(chat)))
  }

  for (const contact of contacts) {
    if (!contact?.id) continue
    metadataOperations.push(pipeline => pipeline.hset(contactKey(sessionId), contact.id, serialize(contact)))
  }

  await Promise.all([
    executeInBatches(metadataOperations),
    persistMessages(sessionId, messages),
  ])

  return {
    chats: chats.filter(chat => chat?.id).length,
    contacts: contacts.filter(contact => contact?.id).length,
    messages: messages.filter(message => message?.key?.id && message?.message).length,
  }
}

export async function getMessageContent(sessionId, key) {
  if (!key?.id) return undefined
  const raw = await getRedisClient().get(messageKey(sessionId, key.id))
  return deserialize(raw)?.raw?.message || undefined
}

export async function getStoredMessage(sessionId, messageId) {
  if (!messageId) return null
  const raw = await getRedisClient().get(messageKey(sessionId, messageId))
  return deserialize(raw)
}

export function normalizeHistoryJid(value) {
  if (!value) throw new Error("jid is required")
  const jid = String(value).trim()
  if (jid.includes("@")) return jid
  const phone = jid.replace(/\D/g, "")
  if (!phone) throw new Error("invalid jid")
  return `${phone}@s.whatsapp.net`
}

export async function listHistoryMessages(sessionId, jidValue, options = {}) {
  const jid = normalizeHistoryJid(jidValue)
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const before = Number(options.before)
  const maxScore = Number.isFinite(before) ? `(${before}` : "+inf"
  const redis = getRedisClient()
  const ids = await redis.zrevrangebyscore(
    messageIndexKey(sessionId, jid),
    maxScore,
    "-inf",
    "LIMIT",
    0,
    limit,
  )

  if (ids.length === 0) {
    return { jid, messages: [], nextCursor: null }
  }

  const pipeline = redis.pipeline()
  for (const id of ids) pipeline.get(messageKey(sessionId, id))
  const results = await pipeline.exec()
  const records = (results || [])
    .map(([error, value]) => error ? null : deserialize(value))
    .filter(Boolean)
    .map(record => options.includeRaw === true ? record : { ...record, raw: undefined })

  const last = records.at(-1)
  return {
    jid,
    messages: records,
    nextCursor: records.length === limit && last ? last.timestamp : null,
  }
}

export async function buildAIContext(sessionId, jid, options = {}) {
  const result = await listHistoryMessages(sessionId, jid, {
    limit: Math.min(Number(options.limit) || 30, 100),
  })

  const messages = result.messages
    .filter(message => message.text)
    .reverse()
    .map(message => ({
      role: message.fromMe ? "assistant" : "user",
      content: message.text,
      timestamp: message.timestamp,
      messageId: message.messageId,
      participant: message.participant,
      pushName: message.pushName,
    }))

  return { jid: result.jid, messages }
}

export async function getOldestStoredMessage(sessionId, jid) {
  const normalizedJid = normalizeHistoryJid(jid)
  const [messageId] = await getRedisClient().zrange(messageIndexKey(sessionId, normalizedJid), 0, 0)
  return messageId ? getStoredMessage(sessionId, messageId) : null
}


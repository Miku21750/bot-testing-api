import fs from "node:fs/promises"
import path from "node:path"

import {
  useMultiFileAuthState,
} from "@whiskeysockets/baileys"

import {
  deleteRedisSession,
  useRedisAuthState,
  writeRedisAuthCreds,
} from "../middleware/redis-auth.js"

const sessionId =
  process.argv[2] || "main"

const authDirectory = path.resolve(
  process.argv[3] || "./baileys_auth"
)

const KNOWN_KEY_TYPES = [
  "app-state-sync-key",
  "app-state-sync-version",
  "sender-key-memory",
  "sender-key",
  "lid-mapping",
  "pre-key",
  "session",
]

function detectKeyType(fileName) {
  if (
    fileName === "creds.json" ||
    !fileName.endsWith(".json")
  ) {
    return null
  }

  const base = fileName.slice(
    0,
    -".json".length
  )

  const type = KNOWN_KEY_TYPES.find(
    candidate =>
      base.startsWith(`${candidate}-`)
  )

  if (!type) {
    return null
  }

  return {
    type,
    id: base.slice(type.length + 1),
  }
}

function assertBrowserAuthCreds(creds) {
  const missing = []

  if (!creds.me?.id) {
    missing.push("me.id")
  }

  if (!creds.me?.lid) {
    missing.push("me.lid")
  }

  if (!creds.account) {
    missing.push("account")
  }

  if (!creds.signalIdentities?.length) {
    missing.push("signalIdentities")
  }

  if (!creds.platform) {
    missing.push("platform")
  }

  if (!creds.noiseKey) {
    missing.push("noiseKey")
  }

  if (!creds.signedIdentityKey) {
    missing.push("signedIdentityKey")
  }

  if (!creds.signedPreKey) {
    missing.push("signedPreKey")
  }

  if (!creds.advSecretKey) {
    missing.push("advSecretKey")
  }

  if (missing.length > 0) {
    throw new Error(
      `Browser auth tidak lengkap. Field hilang: ${missing.join(", ")}`
    )
  }
}

async function main() {
  console.log({
    sessionId,
    authDirectory,
  })

  const fileAuth =
    await useMultiFileAuthState(
      authDirectory
    )

  const creds = fileAuth.state.creds

  console.log("Source auth:", {
    registered: creds.registered,
    jid: creds.me?.id || null,
    lid: creds.me?.lid || null,
    hasAccount: Boolean(creds.account),
    signalIdentities:
      creds.signalIdentities?.length || 0,
    platform: creds.platform || null,
    fields: Object.keys(creds).sort(),
  })

  assertBrowserAuthCreds(creds)

  /*
   * Hapus state lama supaya QR registration
   * sebelumnya tidak bercampur dengan browser auth.
   */
  await deleteRedisSession(sessionId)

  /*
   * Simpan creds persis seperti hasil bridge.
   */
  await writeRedisAuthCreds(
    sessionId,
    creds
  )

  const files =
    await fs.readdir(authDirectory)

  const grouped = new Map()

  for (const fileName of files) {
    const detected =
      detectKeyType(fileName)

    if (!detected) continue

    if (!grouped.has(detected.type)) {
      grouped.set(detected.type, [])
    }

    grouped
      .get(detected.type)
      .push(detected.id)
  }

  const redisAuth =
    await useRedisAuthState(sessionId)

  let importedKeys = 0

  for (const [type, ids] of grouped) {
    const values =
      await fileAuth.state.keys.get(
        type,
        ids
      )

    const valid = {}

    for (const id of ids) {
      if (
        values[id] !== undefined &&
        values[id] !== null
      ) {
        valid[id] = values[id]
      }
    }

    const count =
      Object.keys(valid).length

    if (count === 0) continue

    await redisAuth.state.keys.set({
      [type]: valid,
    })

    importedKeys += count

    console.log({
      type,
      count,
    })
  }

  /*
   * Verifikasi ulang dari Redis.
   */
  const verification =
    await useRedisAuthState(sessionId)

  assertBrowserAuthCreds(
    verification.state.creds
  )

  console.log("Redis verification:", {
    registered:
      verification.state.creds.registered,

    jid:
      verification.state.creds.me?.id,

    lid:
      verification.state.creds.me?.lid,

    hasAccount:
      Boolean(
        verification.state.creds.account
      ),

    signalIdentities:
      verification.state.creds
        .signalIdentities?.length || 0,

    platform:
      verification.state.creds.platform,

    importedKeys,
  })

  await verification.redis.quit()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
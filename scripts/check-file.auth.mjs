import fs from "node:fs/promises"
import path from "node:path"

import {
  BufferJSON,
} from "@whiskeysockets/baileys"

const authDirectory = path.resolve(
  process.argv[2] || "./baileys_auth"
)

const credsPath = path.join(
  authDirectory,
  "creds.json"
)

const raw = await fs.readFile(
  credsPath,
  "utf8"
)

const creds = JSON.parse(
  raw,
  BufferJSON.reviver
)

console.log({
  authDirectory,
  credsPath,

  registered: creds.registered === true,

  me: creds.me
    ? {
        id: creds.me.id || null,
        lid: creds.me.lid || null,
        name: creds.me.name || null,
      }
    : null,

  hasAccount: Boolean(creds.account),

  hasAccountDetails: Boolean(
    creds.account?.details
  ),

  hasAccountSignatureKey: Boolean(
    creds.account?.accountSignatureKey
  ),

  hasAccountSignature: Boolean(
    creds.account?.accountSignature
  ),

  hasDeviceSignature: Boolean(
    creds.account?.deviceSignature
  ),

  signalIdentitiesCount:
    creds.signalIdentities?.length || 0,

  platform: creds.platform || null,

  hasNoiseKey: Boolean(creds.noiseKey),
  hasSignedIdentityKey: Boolean(
    creds.signedIdentityKey
  ),
  hasSignedPreKey: Boolean(
    creds.signedPreKey
  ),
  hasAdvSecretKey: Boolean(
    creds.advSecretKey
  ),

  fields: Object.keys(creds).sort(),
})
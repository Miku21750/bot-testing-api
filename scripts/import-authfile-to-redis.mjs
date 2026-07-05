import baileys from '@whiskeysockets/baileys'

import {
  useRedisAuthState,
} from '../middleware/redis-auth.js'

const {
  useMultiFileAuthState,
} = baileys

const sessionId = process.argv[2] || 'main'
const authDirectory = process.argv[3] || './baileys_auth'

async function main() {
  console.log(`Reading file auth from: ${authDirectory}`)
  console.log(`Importing into Redis session: ${sessionId}`)

  const fileAuth = await useMultiFileAuthState(authDirectory)
  const redisAuth = await useRedisAuthState(sessionId)

  if (!fileAuth.state.creds.registered) {
    throw new Error(
      'File auth belum registered. Jalankan extractor dan pastikan WhatsApp Web sudah login.'
    )
  }

  /*
   * Import credentials utama.
   *
   * Object.assign dipakai agar referensi redisAuth.state.creds
   * tidak diganti sepenuhnya. Ini lebih aman untuk implementasi
   * saveCreds yang menangkap referensi object tersebut.
   */
  Object.assign(
    redisAuth.state.creds,
    fileAuth.state.creds
  )

  await redisAuth.saveCreds()

  console.log('Credentials imported.')

  /*
   * Jenis Signal key yang umum digunakan Baileys.
   *
   * Kita membaca ID file berdasarkan nama file yang dihasilkan
   * useMultiFileAuthState, lalu meminta key melalui state.keys.get().
   */
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const files = await fs.readdir(authDirectory)

  const keyFiles = files.filter(
    filename => filename !== 'creds.json' && filename.endsWith('.json')
  )

  const groupedKeys = new Map()

  for (const filename of keyFiles) {
    const withoutExtension = filename.slice(0, -'.json'.length)

    /*
     * Nama file multi-file auth berbentuk:
     *
     * pre-key-123.json
     * session-628xxx.0.json
     * sender-key-628xxx--group-id.json
     * app-state-sync-key-ABC.json
     *
     * Jenis key harus dicocokkan dari prefix yang dikenal.
     */
    const knownTypes = [
      'pre-key',
      'session',
      'sender-key',
      'sender-key-memory',
      'app-state-sync-key',
      'app-state-sync-version',
    ]

    const type = knownTypes.find(candidate =>
      withoutExtension.startsWith(`${candidate}-`)
    )

    if (!type) {
      console.warn(`Skipping unknown auth file: ${filename}`)
      continue
    }

    const id = withoutExtension.slice(type.length + 1)

    if (!groupedKeys.has(type)) {
      groupedKeys.set(type, [])
    }

    groupedKeys.get(type).push(id)
  }

  let totalImported = 0

  for (const [type, ids] of groupedKeys.entries()) {
    const values = await fileAuth.state.keys.get(type, ids)

    if (!values || Object.keys(values).length === 0) {
      continue
    }

    await redisAuth.state.keys.set({
      [type]: values,
    })

    totalImported += Object.keys(values).length

    console.log(
      `Imported ${Object.keys(values).length} key(s) of type ${type}`
    )
  }

  /*
   * Simpan ulang creds karena proses key import atau middleware
   * tertentu mungkin melakukan normalisasi.
   */
  await redisAuth.saveCreds()

  console.log('')
  console.log('Import completed.')
  console.log(`Registered: ${redisAuth.state.creds.registered}`)
  console.log(`Signal keys imported: ${totalImported}`)
  console.log('')
  console.log(
    'Sekarang tutup Chrome/WhatsApp Web lalu jalankan bot dengan Redis auth.'
  )
}

main().catch(error => {
  console.error('Import failed:')
  console.error(error)
  process.exit(1)
})
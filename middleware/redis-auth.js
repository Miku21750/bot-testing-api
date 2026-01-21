if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv')
  dotenv.config()
}

import { BufferJSON } from "@whiskeysockets/baileys";
import Redis from "ioredis";



const redis = new Redis(process.env.REDIS_URL)
const kCreds = (sid) => `wa:${sid}:creds`
const kKey = (sid, type, id) => `wa:${sid}:keys:${type}:${id}`

export async function useRedisAuthState(sessionId) {
    //loads creds
    const credsRaw = await redis.get(kCreds(sessionId))
    const creds = credsRaw ? JSON.parse(credsRaw, BufferJSON.reviver) : null

    //key adapter
    const keys = {
        get: async (type, ids) => {
            const pipeline = redis.pipeline()
            for (const id of ids) pipeline.get(kKey(sessionId, type, id))
            const results = await pipeline.exec()

            const out = {}
            ids.forEach((id, idx) => {
                const val = results?.[idx]?.[1]
                out[id] = val ? JSON.parse(val, BufferJSON.reviver) : undefined
            });
            return out
        },
        set: async (data) => {
            const pipeline = redis.pipeline()
            for(const type in data){
                for(const id in data[type]){
                    const value = data[type][id]
                    const key = kKey(sessionId, type, id)
                    if(value) pipeline.set(key, JSON.stringify(value, BufferJSON.replacer))
                        else pipeline.del(key)
                }
            }
            await pipeline.exec()
        }
    }

    //state shape baileys expected
    const state = {
        creds: creds || (await import('@whiskeysockets/baileys')).initAuthCreds(), 
        keys
    }

    //save creds
    const saveCreds = async () => {
        await redis.set(kCreds(sessionId), JSON.stringify(state.creds, BufferJSON.replacer))
    }

    return {state, saveCreds, redis}

}
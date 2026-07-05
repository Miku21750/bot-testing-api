import {
  deleteRedisSession,
} from "../middleware/redis-auth.js"

const sessionId =
  process.argv[2] || "main"

const deleted =
  await deleteRedisSession(sessionId)

console.log({
  sessionId,
  deleted,
})

process.exit(0)
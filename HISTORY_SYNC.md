# WhatsApp history sync

History sync is persisted in the existing Redis database and separated by
`WA_SESSION_ID`. Messages have no TTL. Chats and contacts are stored alongside
the original Baileys message payload so `getMessage` can serve retries and poll
decryption.

## Configuration

```env
# Both default to true. Set either to false to disable it.
WA_HISTORY_SYNC_ENABLED=true
WA_SYNC_FULL_HISTORY=true
```

Full sync uses the macOS desktop browser profile. On a large WhatsApp account,
the first connection can use considerably more time, memory, network bandwidth,
and Redis storage.

## API

All endpoints below require the same bearer token as `/send-text`.

```text
GET /history/6281234567890?limit=50
GET /history/6281234567890?limit=50&before=1712345678
GET /history/6281234567890/ai-context?limit=30
POST /wa/history/fetch
```

`GET /history/:jid` returns newest-first message metadata. Add
`includeRaw=true` only when the full Baileys payload is needed.

`GET /history/:jid/ai-context` returns chronological text messages shaped as
`role: user|assistant` plus message metadata, ready to be inserted into an AI
prompt. The endpoint does not call an AI provider by itself.

To request older messages from the primary phone:

```json
{
  "jid": "6281234567890",
  "count": 100
}
```

The request uses the oldest locally stored message as its cursor. The response
is HTTP 202 because Baileys delivers the result later through
`messaging-history.set`, where it is persisted automatically.

History sync is not an unlimited backup: WhatsApp decides what history is
available to a linked device. Back up Redis if the stored history must survive
host or volume loss.

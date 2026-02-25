const listenerMap = new WeakMap() // sock -> Map(eventName -> Set(handlers))

export function onSockEvent(sock, eventName, handler) {
  if (!sock?.ev) return

  sock.ev.on(eventName, handler)

  let m = listenerMap.get(sock)
  if (!m) {
    m = new Map()
    listenerMap.set(sock, m)
  }

  let set = m.get(eventName)
  if (!set) {
    set = new Set()
    m.set(eventName, set)
  }

  set.add(handler)
}

export function detachAllListeners(sock) {
  if (!sock?.ev) return

  const m = listenerMap.get(sock)
  if (!m) return

  for (const [eventName, set] of m.entries()) {
    for (const handler of set) {
      try { sock.ev.off(eventName, handler) } catch {}
    }
  }

  m.clear()
}

export function hardCloseSocket(sock) {
  try { sock?.ws?.close() } catch {}
  try { sock?.ev?.removeAllListeners?.() } catch {}
}
const listenerMap = new Map();

export function onSockEvent(sock, eventName, handler) {
    if (!sock?.ev) return;
    sock.ev.on(eventName, handler);
    listenerMap.set(eventName, handler);
}

export function detachAllListeners(sock) {
    if (!sock?.ev) return;
    for (const [eventName, handler] of listenerMap.entries()) {
        try { sock.ev.off(eventName, handler); } catch {}
    }
    listenerMap.clear();
}

export function hardCloseSocket(sock) {
    try { sock?.ws?.close(); } catch {}
    try { sock?.ev?.removeAllListeners?.(); } catch {}
}

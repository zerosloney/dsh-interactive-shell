/**
 * Remote WebSocket & Stream Transport Adapters for dsh-interactive-shell.
 *
 * Allows web clients, Electron apps, and headless UI consumers to stream
 * terminal sessions over network boundaries (WebSocket / Local Memory).
 *
 * @module
 */
/**
 * In-memory local transport bridge (zero network overhead).
 */
export class LocalStreamTransport {
    hub;
    listeners = new Set();
    unsubscribeHub;
    constructor(hub, sessionId) {
        this.hub = hub;
        if (sessionId) {
            this.unsubscribeHub = this.hub.subscribe(sessionId, (frame) => {
                this.emit(frame);
            });
        }
        else {
            this.unsubscribeHub = this.hub.onFrame((frame) => {
                this.emit(frame);
            });
        }
    }
    send(message) {
        if (message.type === 'input') {
            this.hub.sendUserInput(message.sessionId, message.data);
        }
        else if (message.type === 'acquire_lock') {
            this.hub.acquireLock(message.sessionId, message.lockedBy ?? 'user');
        }
        else if (message.type === 'release_lock') {
            this.hub.releaseLock(message.sessionId, message.summary);
        }
    }
    onFrame(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    close() {
        this.unsubscribeHub();
        this.listeners.clear();
    }
    emit(frame) {
        for (const l of this.listeners) {
            try {
                l(frame);
            }
            catch {
                // Safe dispatch
            }
        }
    }
}
/**
 * Attach a WebSocket connection to the StreamHub on the server side.
 */
export function attachWsServerConnection(socket, hub) {
    let activeSessionId;
    const send = (msg) => {
        try {
            socket.send(JSON.stringify(msg));
        }
        catch {
            // Socket might be closed
        }
    };
    // Forward hub frames to client socket
    const unsubscribeHub = hub.onFrame((frame) => {
        if (!activeSessionId || frame.sessionId === activeSessionId) {
            send({ type: 'frame', frame });
        }
    });
    const handleMessageText = (text) => {
        try {
            const msg = JSON.parse(text);
            if (msg.type === 'ping') {
                send({ type: 'pong' });
            }
            else if (msg.type === 'subscribe') {
                activeSessionId = msg.sessionId;
            }
            else if (msg.type === 'input') {
                hub.sendUserInput(msg.sessionId, msg.data);
            }
            else if (msg.type === 'acquire_lock') {
                hub.acquireLock(msg.sessionId, msg.lockedBy ?? 'user');
            }
            else if (msg.type === 'release_lock') {
                hub.releaseLock(msg.sessionId, msg.summary);
            }
        }
        catch (err) {
            send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
    };
    if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('message', (ev) => handleMessageText(String(ev.data)));
        socket.addEventListener('close', () => unsubscribeHub());
    }
    else if (typeof socket.on === 'function') {
        socket.on('message', (data) => handleMessageText(data.toString()));
        socket.on('close', () => unsubscribeHub());
    }
    return () => {
        unsubscribeHub();
    };
}
/**
 * Client-side WebSocket transport adapter connecting Web UI / CLI clients to remote StreamHub.
 */
export class WsClientTransport {
    options;
    socket = null;
    listeners = new Set();
    queue = [];
    connected = false;
    constructor(options = {}) {
        this.options = options;
        if (options.url) {
            this.connect(options.url);
        }
    }
    /** Connect or reconnect to remote WebSocket server. */
    connect(url) {
        const factory = this.options.webSocketFactory ?? ((u) => new globalThis.WebSocket(u));
        const sock = factory(url);
        this.socket = sock;
        const handleMessage = (data) => {
            try {
                const text = typeof data === 'string' ? data : data?.data ? String(data.data) : String(data);
                const msg = JSON.parse(text);
                if (msg.type === 'frame') {
                    this.emit(msg.frame);
                }
            }
            catch {
                // Safe dispatch
            }
        };
        if (typeof sock.addEventListener === 'function') {
            sock.addEventListener('message', handleMessage);
            sock.addEventListener('open', () => this.onOpen());
            sock.addEventListener('close', () => { this.connected = false; });
        }
        else if (typeof sock.on === 'function') {
            sock.on('message', handleMessage);
            sock.on('open', () => this.onOpen());
            sock.on('close', () => { this.connected = false; });
        }
    }
    onOpen() {
        this.connected = true;
        if (this.options.sessionId) {
            this.send({ type: 'subscribe', sessionId: this.options.sessionId });
        }
        while (this.queue.length > 0) {
            const msg = this.queue.shift();
            if (msg)
                this.send(msg);
        }
    }
    send(message) {
        if (this.socket && this.connected) {
            try {
                this.socket.send(JSON.stringify(message));
            }
            catch {
                // Socket closed
            }
        }
        else {
            this.queue.push(message);
        }
    }
    onFrame(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    close() {
        this.connected = false;
        this.socket?.close();
        this.listeners.clear();
        this.queue = [];
    }
    emit(frame) {
        for (const l of this.listeners) {
            try {
                l(frame);
            }
            catch {
                // Safe dispatch
            }
        }
    }
}
//# sourceMappingURL=transport.js.map
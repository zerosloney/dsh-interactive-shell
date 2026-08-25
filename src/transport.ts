/**
 * Remote WebSocket & Stream Transport Adapters for dsh-interactive-shell.
 *
 * Allows web clients, Electron apps, and headless UI consumers to stream
 * terminal sessions over network boundaries (WebSocket / Local Memory).
 *
 * @module
 */

import { StreamHub } from './stream.js'
import type { TermFrame } from './stream.js'

/** Messages sent from client to server. */
export type ClientMessage =
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'acquire_lock'; sessionId: string; lockedBy?: string }
  | { type: 'release_lock'; sessionId: string; summary?: string }
  | { type: 'subscribe'; sessionId?: string }
  | { type: 'ping' }

/** Messages sent from server to client. */
export type ServerMessage =
  | { type: 'frame'; frame: TermFrame }
  | { type: 'pong' }
  | { type: 'error'; message: string }

/** Generic transport interface for terminal streaming. */
export interface TermTransport {
  send(message: ClientMessage): void | Promise<void>
  onFrame(listener: (frame: TermFrame) => void): () => void
  close(): void
}

/**
 * In-memory local transport bridge (zero network overhead).
 */
export class LocalStreamTransport implements TermTransport {
  private listeners = new Set<(frame: TermFrame) => void>()
  private unsubscribeHub: () => void

  constructor(private readonly hub: StreamHub, sessionId?: string) {
    if (sessionId) {
      this.unsubscribeHub = this.hub.subscribe(sessionId, (frame) => {
        this.emit(frame)
      })
    } else {
      this.unsubscribeHub = this.hub.onFrame((frame) => {
        this.emit(frame)
      })
    }
  }

  send(message: ClientMessage): void {
    if (message.type === 'input') {
      this.hub.sendUserInput(message.sessionId, message.data)
    } else if (message.type === 'acquire_lock') {
      this.hub.acquireLock(message.sessionId, message.lockedBy ?? 'user')
    } else if (message.type === 'release_lock') {
      this.hub.releaseLock(message.sessionId, message.summary)
    }
  }

  onFrame(listener: (frame: TermFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.unsubscribeHub()
    this.listeners.clear()
  }

  private emit(frame: TermFrame): void {
    for (const l of this.listeners) {
      try {
        l(frame)
      } catch {
        // Safe dispatch
      }
    }
  }
}

/** Minimal WebSocket interface compatible with standard Web API and 'ws' package. */
export interface MinimalWebSocket {
  send(data: string): void
  close(): void
  addEventListener?(type: 'message', listener: (event: { data: any }) => void): void
  addEventListener?(type: 'open' | 'close', listener: () => void): void
  on?(type: 'message', listener: (data: any) => void): void
  on?(type: 'open' | 'close', listener: () => void): void
}

/**
 * Attach a WebSocket connection to the StreamHub on the server side.
 */
export function attachWsServerConnection(
  socket: MinimalWebSocket,
  hub: StreamHub,
): () => void {
  let activeSessionId: string | undefined

  const send = (msg: ServerMessage) => {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // Socket might be closed
    }
  }

  // Forward hub frames to client socket
  const unsubscribeHub = hub.onFrame((frame) => {
    if (!activeSessionId || frame.sessionId === activeSessionId) {
      send({ type: 'frame', frame })
    }
  })

  const handleMessageText = (text: string) => {
    try {
      const msg = JSON.parse(text) as ClientMessage
      if (msg.type === 'ping') {
        send({ type: 'pong' })
      } else if (msg.type === 'subscribe') {
        activeSessionId = msg.sessionId
      } else if (msg.type === 'input') {
        hub.sendUserInput(msg.sessionId, msg.data)
      } else if (msg.type === 'acquire_lock') {
        hub.acquireLock(msg.sessionId, msg.lockedBy ?? 'user')
      } else if (msg.type === 'release_lock') {
        hub.releaseLock(msg.sessionId, msg.summary)
      }
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('message', (ev) => handleMessageText(String(ev.data)))
    socket.addEventListener('close', () => unsubscribeHub())
  } else if (typeof socket.on === 'function') {
    socket.on('message', (data) => handleMessageText(data.toString()))
    socket.on('close', () => unsubscribeHub())
  }

  return () => {
    unsubscribeHub()
  }
}

/** Configuration options for WsClientTransport. */
export interface WsClientTransportOptions {
  /** Target WebSocket URL. */
  url?: string
  /** Custom WebSocket constructor / factory (for testing or Node environments). */
  webSocketFactory?: (url: string) => MinimalWebSocket
  /** Automatically subscribe to specific sessionId upon connection. */
  sessionId?: string
}

/**
 * Client-side WebSocket transport adapter connecting Web UI / CLI clients to remote StreamHub.
 */
export class WsClientTransport implements TermTransport {
  private socket: MinimalWebSocket | null = null
  private listeners = new Set<(frame: TermFrame) => void>()
  private queue: ClientMessage[] = []
  private connected = false

  constructor(private readonly options: WsClientTransportOptions = {}) {
    if (options.url) {
      this.connect(options.url)
    }
  }

  /** Connect or reconnect to remote WebSocket server. */
  connect(url: string): void {
    const factory = this.options.webSocketFactory ?? ((u: string) => new (globalThis as any).WebSocket(u))
    const sock = factory(url)
    this.socket = sock

    const handleMessage = (data: any) => {
      try {
        const text = typeof data === 'string' ? data : data?.data ? String(data.data) : String(data)
        const msg = JSON.parse(text) as ServerMessage
        if (msg.type === 'frame') {
          this.emit(msg.frame)
        }
      } catch {
        // Safe dispatch
      }
    }

    if (typeof sock.addEventListener === 'function') {
      sock.addEventListener('message', handleMessage)
      sock.addEventListener('open', () => this.onOpen())
      sock.addEventListener('close', () => { this.connected = false })
    } else if (typeof sock.on === 'function') {
      sock.on('message', handleMessage)
      sock.on('open', () => this.onOpen())
      sock.on('close', () => { this.connected = false })
    }
  }

  private onOpen(): void {
    this.connected = true
    if (this.options.sessionId) {
      this.send({ type: 'subscribe', sessionId: this.options.sessionId })
    }
    while (this.queue.length > 0) {
      const msg = this.queue.shift()
      if (msg) this.send(msg)
    }
  }

  send(message: ClientMessage): void {
    if (this.socket && this.connected) {
      try {
        this.socket.send(JSON.stringify(message))
      } catch {
        // Socket closed
      }
    } else {
      this.queue.push(message)
    }
  }

  onFrame(listener: (frame: TermFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.connected = false
    this.socket?.close()
    this.listeners.clear()
    this.queue = []
  }

  private emit(frame: TermFrame): void {
    for (const l of this.listeners) {
      try {
        l(frame)
      } catch {
        // Safe dispatch
      }
    }
  }
}

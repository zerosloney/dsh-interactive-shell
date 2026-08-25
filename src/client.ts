/**
 * Web UI Client & Viewport Adapter for dsh-interactive-shell:
 * Provides client-side state management, virtual ANSI buffer tracking,
 * pluggable Xterm/Canvas renderer binding, and stream event ingestion.
 *
 * @module
 */

import type { StreamHub, TermFrame, TermLockFrame } from './stream.js'

/** Status of the terminal session from the client view. */
export type SessionClientStatus = 'starting' | 'running' | 'exited' | 'killed'

/** Structured snapshot of the client session state. */
export interface ClientSessionState {
  sessionId: string
  command: string
  mode: string
  status: SessionClientStatus
  exitCode: number | null
  lockState: 'agent_driving' | 'user_takeover'
  lockedBy?: string
  lastEvent?: string
  totalLines: number
  updatedAt: number
}

/** Pluggable terminal renderer interface (e.g. for @xterm/xterm or custom canvas). */
export interface TerminalRenderer {
  /** Write raw chunk (with ANSI escape sequences) into the terminal view. */
  write(chunk: string): void
  /** Clear terminal view. */
  clear?(): void
  /** Resize terminal dimensions. */
  resize?(cols: number, rows: number): void
  /** Cleanup and dispose renderer. */
  dispose?(): void
}

/** ANSI Escape Sequence Regular Expression for text stripping. */
// oxlint-disable no-control-regex
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = new RegExp(
  '[\u001B\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%_~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%_~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
)

/** Strip ANSI color/control codes from a string for plain-text extraction. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

/**
 * Headless in-memory virtual terminal buffer: maintains lines and raw ANSI text
 * with a bounded scrollback limit.
 */
export class VirtualTerminalBuffer {
  private rawChunks: string[] = []
  private plainLines: string[] = []
  private readonly maxLines: number

  constructor(maxLines = 1000) {
    this.maxLines = maxLines
  }

  /** Write an output chunk into the buffer (alias for append). */
  write(chunk: string): void {
    this.append(chunk)
  }

  /** Append an output chunk into the buffer. */
  append(chunk: string): void {
    this.rawChunks.push(chunk)

    // Handle full-screen erase sequences (e.g. \x1B[2J, \x1B[3J)
    if (chunk.includes('\x1B[2J') || chunk.includes('\x1B[3J')) {
      const clearIdx = Math.max(chunk.lastIndexOf('\x1B[2J'), chunk.lastIndexOf('\x1B[3J'))
      if (clearIdx >= 0) {
        this.plainLines = []
        chunk = chunk.slice(clearIdx + 4)
      }
    }

    const stripped = stripAnsi(chunk)
    if (stripped.length === 0) return

    // Normalize CRLF to LF so remaining \r are true standalone cursor rewinds
    const normalized = stripped.replace(/\r\n/g, '\n')
    const newLines = normalized.split('\n')

    for (let i = 0; i < newLines.length; i++) {
      const rawLine = newLines[i]

      if (i === 0 && this.plainLines.length > 0) {
        if (rawLine.startsWith('\r')) {
          const rParts = rawLine.split('\r').filter(Boolean)
          this.plainLines[this.plainLines.length - 1] = rParts.length > 0 ? rParts[rParts.length - 1] : ''
        } else if (rawLine.includes('\r')) {
          const rParts = rawLine.split('\r')
          this.plainLines[this.plainLines.length - 1] = rParts[rParts.length - 1]
        } else {
          this.plainLines[this.plainLines.length - 1] += rawLine
        }
      } else {
        if (rawLine.includes('\r')) {
          const rParts = rawLine.split('\r')
          this.plainLines.push(rParts[rParts.length - 1])
        } else {
          this.plainLines.push(rawLine)
        }
      }
    }

    // Retain up to maxLines (+ 1 if trailing line is an open newline)
    const maxEntries =
      this.plainLines.length > 0 && this.plainLines[this.plainLines.length - 1] === ''
        ? this.maxLines + 1
        : this.maxLines

    if (this.plainLines.length > maxEntries) {
      this.plainLines = this.plainLines.slice(this.plainLines.length - maxEntries)
    }
  }

  /** Get all plain text lines. */
  getLines(): readonly string[] {
    if (this.plainLines.length > 0 && this.plainLines[this.plainLines.length - 1] === '') {
      return this.plainLines.slice(0, -1)
    }
    return this.plainLines
  }

  /** Get full plain text as a single string. */
  getText(): string {
    return this.getLines().join('\n')
  }

  /** Get raw concatenated ANSI text. */
  getRawText(): string {
    return this.rawChunks.join('')
  }

  /** Clear all buffer content. */
  clear(): void {
    this.rawChunks = []
    this.plainLines = []
  }
}

export interface TermStreamClientOptions {
  /** Initial command name if known prior to stream init frame. */
  initialCommand?: string
  /** Initial mode if known prior to stream init frame. */
  initialMode?: 'interactive' | 'hands-free' | 'dispatch' | 'monitor'
  /** Maximum scrollback lines in the virtual buffer (default: 1000). */
  maxScrollback?: number
  /** Callback invoked when input should be sent to backend PTY (during user takeover). */
  onSendInput?: (sessionId: string, input: string) => void
  /** Callback invoked when user requests takeover lock acquire/release. */
  onLockRequest?: (sessionId: string, action: 'acquire' | 'release', user?: string) => void
}

/**
 * Client-side session manager: consumes stream frames, maintains live session
 * state, populates virtual buffer, and feeds attached terminal renderers (Xterm.js).
 */
export class TermStreamClient {
  readonly sessionId: string
  private state: ClientSessionState
  private readonly buffer: VirtualTerminalBuffer
  private readonly renderers = new Set<TerminalRenderer>()
  private readonly stateListeners = new Set<(state: Readonly<ClientSessionState>) => void>()
  private readonly outputListeners = new Set<(chunk: string) => void>()
  onSendInput?: (sessionId: string, input: string) => void
  onLockRequest?: (sessionId: string, action: 'acquire' | 'release', user?: string) => void
  private streamDisposer?: () => void

  constructor(sessionId: string, options: TermStreamClientOptions = {}) {
    this.sessionId = sessionId
    this.buffer = new VirtualTerminalBuffer(options.maxScrollback ?? 1000)
    this.onSendInput = options.onSendInput
    this.onLockRequest = options.onLockRequest
    this.state = {
      sessionId,
      command: options.initialCommand ?? '',
      mode: options.initialMode ?? 'interactive',
      status: 'starting',
      exitCode: null,
      lockState: 'agent_driving',
      totalLines: 0,
      updatedAt: Date.now(),
    }
  }

  /** Get current snapshot of the session state. */
  getState(): Readonly<ClientSessionState> {
    return this.state
  }

  /** Get the virtual terminal buffer. */
  getBuffer(): VirtualTerminalBuffer {
    return this.buffer
  }

  /**
   * Ingest and process a streaming frame from the backend.
   */
  handleFrame(frame: TermFrame): void {
    if (frame.sessionId !== this.sessionId) return

    switch (frame.type) {
      case 'term:init': {
        this.state = {
          ...this.state,
          command: frame.command,
          mode: frame.mode,
          status: 'running',
          updatedAt: frame.time,
        }
        if (frame.motd) {
          this.writeOutput(frame.motd + '\r\n')
        }
        this.notifyState()
        break
      }
      case 'term:output': {
        this.writeOutput(frame.chunk)
        this.state = {
          ...this.state,
          status: 'running',
          totalLines: frame.lineEnd,
          updatedAt: frame.time,
        }
        this.notifyState()
        break
      }
      case 'term:lock': {
        const lockFrame = frame as TermLockFrame
        this.state = {
          ...this.state,
          lockState: lockFrame.state,
          lockedBy: lockFrame.lockedBy,
          updatedAt: lockFrame.time,
        }
        this.notifyState()
        break
      }
      case 'term:event': {
        if (frame.event === 'session-killed') {
          this.state = {
            ...this.state,
            status: 'killed',
            lastEvent: frame.event,
            updatedAt: frame.time,
          }
        } else if (frame.event === 'dispatch-completed') {
          this.state = {
            ...this.state,
            status: 'exited',
            lastEvent: frame.event,
            updatedAt: frame.time,
          }
        } else {
          this.state = {
            ...this.state,
            lastEvent: frame.event,
            updatedAt: frame.time,
          }
        }
        this.notifyState()
        break
      }
      case 'term:exit': {
        this.state = {
          ...this.state,
          status: 'exited',
          exitCode: frame.exitCode,
          updatedAt: frame.time,
        }
        this.notifyState()
        break
      }
    }
  }

  /** Write an output chunk to buffer, renderers, and output listeners. */
  private writeOutput(chunk: string): void {
    this.buffer.append(chunk)

    for (const renderer of this.renderers) {
      try {
        renderer.write(chunk)
      } catch {
        // Safe dispatch to renderers
      }
    }

    for (const listener of this.outputListeners) {
      try {
        listener(chunk)
      } catch {
        // Safe dispatch
      }
    }
  }

  /** Notify state change listeners. */
  private notifyState(): void {
    for (const listener of this.stateListeners) {
      try {
        listener(this.state)
      } catch {
        // Safe dispatch
      }
    }
  }

  /**
   * Attach a terminal renderer (e.g. Xterm.js instance).
   * Replays current buffer to the renderer immediately.
   * @returns Disposer function to detach renderer.
   */
  attachRenderer(renderer: TerminalRenderer): () => void {
    this.renderers.add(renderer)

    // Replay current raw buffer into renderer
    const raw = this.buffer.getRawText()
    if (raw.length > 0) {
      try {
        renderer.write(raw)
      } catch {
        // Safe replay
      }
    }

    return () => {
      this.renderers.delete(renderer)
    }
  }

  /**
   * Send user input keystrokes from the Web UI to the backend PTY (Takeover Mode).
   */
  sendInput(input: string): void {
    this.onSendInput?.(this.sessionId, input)
  }

  /**
   * Request user takeover of the terminal session.
   */
  requestTakeover(user = 'user'): void {
    this.onLockRequest?.(this.sessionId, 'acquire', user)
  }

  /**
   * Release takeover back to agent driving.
   */
  releaseTakeover(summary?: string): void {
    this.onLockRequest?.(this.sessionId, 'release', summary)
  }

  /** Subscribe to state change notifications. */
  onStateChange(listener: (state: Readonly<ClientSessionState>) => void): () => void {
    this.stateListeners.add(listener)
    try {
      listener(this.state)
    } catch {
      // Safe initial notification
    }
    return () => this.stateListeners.delete(listener)
  }

  /** Subscribe to raw output chunks. */
  onOutput(listener: (chunk: string) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  /**
   * Connect this client directly to a StreamHub instance with automatic history replay.
   */
  connectHub(hub: StreamHub, replay = true): () => void {
    this.streamDisposer?.()
    const unsub = hub.subscribe(this.sessionId, (frame) => this.handleFrame(frame), replay)
    this.onLockRequest = (sessionId, action, userOrSummary) => {
      if (action === 'acquire') hub.acquireLock(sessionId, userOrSummary)
      else hub.releaseLock(sessionId, userOrSummary)
    }
    this.onSendInput = (sessionId, input) => {
      hub.sendUserInput(sessionId, input).catch(() => {})
    }
    this.streamDisposer = unsub
    return unsub
  }

  /** Dispose all resources, listeners, and renderer attachments. */
  dispose(): void {
    this.streamDisposer?.()
    this.streamDisposer = undefined
    for (const renderer of this.renderers) {
      try {
        renderer.dispose?.()
      } catch {
        // Safe cleanup
      }
    }
    this.renderers.clear()
    this.stateListeners.clear()
    this.outputListeners.clear()
    this.buffer.clear()
  }
}

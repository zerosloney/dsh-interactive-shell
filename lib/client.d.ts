/**
 * Web UI Client & Viewport Adapter for dsh-interactive-shell:
 * Provides client-side state management, virtual ANSI buffer tracking,
 * pluggable Xterm/Canvas renderer binding, and stream event ingestion.
 *
 * @module
 */
import type { StreamHub, TermFrame } from './stream.js';
/** Status of the terminal session from the client view. */
export type SessionClientStatus = 'starting' | 'running' | 'exited' | 'killed';
/** Structured snapshot of the client session state. */
export interface ClientSessionState {
    sessionId: string;
    command: string;
    mode: string;
    status: SessionClientStatus;
    exitCode: number | null;
    lockState: 'agent_driving' | 'user_takeover';
    lockedBy?: string;
    lastEvent?: string;
    totalLines: number;
    updatedAt: number;
}
/** Pluggable terminal renderer interface (e.g. for @xterm/xterm or custom canvas). */
export interface TerminalRenderer {
    /** Write raw chunk (with ANSI escape sequences) into the terminal view. */
    write(chunk: string): void;
    /** Clear terminal view. */
    clear?(): void;
    /** Resize terminal dimensions. */
    resize?(cols: number, rows: number): void;
    /** Cleanup and dispose renderer. */
    dispose?(): void;
}
/** Strip ANSI color/control codes from a string for plain-text extraction. */
export declare function stripAnsi(text: string): string;
/**
 * Headless in-memory virtual terminal buffer: maintains lines and raw ANSI text
 * with a bounded scrollback limit.
 */
export declare class VirtualTerminalBuffer {
    private rawChunks;
    private plainLines;
    private readonly maxLines;
    constructor(maxLines?: number);
    /** Write an output chunk into the buffer (alias for append). */
    write(chunk: string): void;
    /** Append an output chunk into the buffer. */
    append(chunk: string): void;
    /** Get all plain text lines. */
    getLines(): readonly string[];
    /** Get full plain text as a single string. */
    getText(): string;
    /** Get raw concatenated ANSI text. */
    getRawText(): string;
    /** Clear all buffer content. */
    clear(): void;
}
export interface TermStreamClientOptions {
    /** Initial command name if known prior to stream init frame. */
    initialCommand?: string;
    /** Initial mode if known prior to stream init frame. */
    initialMode?: 'interactive' | 'hands-free' | 'dispatch' | 'monitor';
    /** Maximum scrollback lines in the virtual buffer (default: 1000). */
    maxScrollback?: number;
    /** Callback invoked when input should be sent to backend PTY (during user takeover). */
    onSendInput?: (sessionId: string, input: string) => void;
    /** Callback invoked when user requests takeover lock acquire/release. */
    onLockRequest?: (sessionId: string, action: 'acquire' | 'release', user?: string) => void;
}
/**
 * Client-side session manager: consumes stream frames, maintains live session
 * state, populates virtual buffer, and feeds attached terminal renderers (Xterm.js).
 */
export declare class TermStreamClient {
    readonly sessionId: string;
    private state;
    private readonly buffer;
    private readonly renderers;
    private readonly stateListeners;
    private readonly outputListeners;
    onSendInput?: (sessionId: string, input: string) => void;
    onLockRequest?: (sessionId: string, action: 'acquire' | 'release', user?: string) => void;
    private streamDisposer?;
    constructor(sessionId: string, options?: TermStreamClientOptions);
    /** Get current snapshot of the session state. */
    getState(): Readonly<ClientSessionState>;
    /** Get the virtual terminal buffer. */
    getBuffer(): VirtualTerminalBuffer;
    /**
     * Ingest and process a streaming frame from the backend.
     */
    handleFrame(frame: TermFrame): void;
    /** Write an output chunk to buffer, renderers, and output listeners. */
    private writeOutput;
    /** Notify state change listeners. */
    private notifyState;
    /**
     * Attach a terminal renderer (e.g. Xterm.js instance).
     * Replays current buffer to the renderer immediately.
     * @returns Disposer function to detach renderer.
     */
    attachRenderer(renderer: TerminalRenderer): () => void;
    /**
     * Send user input keystrokes from the Web UI to the backend PTY (Takeover Mode).
     */
    sendInput(input: string): void;
    /**
     * Request user takeover of the terminal session.
     */
    requestTakeover(user?: string): void;
    /**
     * Release takeover back to agent driving.
     */
    releaseTakeover(summary?: string): void;
    /** Subscribe to state change notifications. */
    onStateChange(listener: (state: Readonly<ClientSessionState>) => void): () => void;
    /** Subscribe to raw output chunks. */
    onOutput(listener: (chunk: string) => void): () => void;
    /**
     * Connect this client directly to a StreamHub instance with automatic history replay.
     */
    connectHub(hub: StreamHub, replay?: boolean): () => void;
    /** Dispose all resources, listeners, and renderer attachments. */
    dispose(): void;
}

/**
 * Remote WebSocket & Stream Transport Adapters for dsh-interactive-shell.
 *
 * Allows web clients, Electron apps, and headless UI consumers to stream
 * terminal sessions over network boundaries (WebSocket / Local Memory).
 *
 * @module
 */
import { StreamHub } from './stream.js';
import type { TermFrame } from './stream.js';
/** Messages sent from client to server. */
export type ClientMessage = {
    type: 'input';
    sessionId: string;
    data: string;
} | {
    type: 'acquire_lock';
    sessionId: string;
    lockedBy?: string;
} | {
    type: 'release_lock';
    sessionId: string;
    summary?: string;
} | {
    type: 'subscribe';
    sessionId?: string;
} | {
    type: 'ping';
};
/** Messages sent from server to client. */
export type ServerMessage = {
    type: 'frame';
    frame: TermFrame;
} | {
    type: 'pong';
} | {
    type: 'error';
    message: string;
};
/** Generic transport interface for terminal streaming. */
export interface TermTransport {
    send(message: ClientMessage): void | Promise<void>;
    onFrame(listener: (frame: TermFrame) => void): () => void;
    close(): void;
}
/**
 * In-memory local transport bridge (zero network overhead).
 */
export declare class LocalStreamTransport implements TermTransport {
    private readonly hub;
    private listeners;
    private unsubscribeHub;
    constructor(hub: StreamHub, sessionId?: string);
    send(message: ClientMessage): void;
    onFrame(listener: (frame: TermFrame) => void): () => void;
    close(): void;
    private emit;
}
/** Minimal WebSocket interface compatible with standard Web API and 'ws' package. */
export interface MinimalWebSocket {
    send(data: string): void;
    close(): void;
    addEventListener?(type: 'message', listener: (event: {
        data: any;
    }) => void): void;
    addEventListener?(type: 'open' | 'close', listener: () => void): void;
    on?(type: 'message', listener: (data: any) => void): void;
    on?(type: 'open' | 'close', listener: () => void): void;
}
/**
 * Attach a WebSocket connection to the StreamHub on the server side.
 */
export declare function attachWsServerConnection(socket: MinimalWebSocket, hub: StreamHub): () => void;
/** Configuration options for WsClientTransport. */
export interface WsClientTransportOptions {
    /** Target WebSocket URL. */
    url?: string;
    /** Custom WebSocket constructor / factory (for testing or Node environments). */
    webSocketFactory?: (url: string) => MinimalWebSocket;
    /** Automatically subscribe to specific sessionId upon connection. */
    sessionId?: string;
}
/**
 * Client-side WebSocket transport adapter connecting Web UI / CLI clients to remote StreamHub.
 */
export declare class WsClientTransport implements TermTransport {
    private readonly options;
    private socket;
    private listeners;
    private queue;
    private connected;
    constructor(options?: WsClientTransportOptions);
    /** Connect or reconnect to remote WebSocket server. */
    connect(url: string): void;
    private onOpen;
    send(message: ClientMessage): void;
    onFrame(listener: (frame: TermFrame) => void): () => void;
    close(): void;
    private emit;
}

/**
 * Session Recorder, Time-Travel Snapshot Engine, and Asciinema v2 Exporter.
 *
 * @module
 */
import type { TermFrame } from './stream.js';
export interface AsciinemaHeader {
    version: 2;
    width: number;
    height: number;
    timestamp: number;
    title?: string;
    env?: Record<string, string>;
}
export type AsciinemaEvent = [number, 'o' | 'i', string];
export interface TimelineSegment {
    actor: 'agent' | 'user';
    startTime: number;
    endTime: number;
    chunkCount: number;
    totalBytes: number;
}
export interface RecordedSession {
    sessionId: string;
    command?: string;
    startTime: number;
    endTime?: number;
    frames: TermFrame[];
    lockHistory: Array<{
        time: number;
        state: 'agent_driving' | 'user_takeover';
        actor: string;
    }>;
}
/**
 * In-memory session recorder capable of timeline slicing, time-travel reconstruction,
 * and exporting to standard Asciinema v2 (.cast) files.
 */
export declare class SessionRecorder {
    private sessions;
    /** Record an incoming streaming frame. */
    record(frame: TermFrame): void;
    /**
     * Export recorded session to standard Asciinema v2 (.cast) format string.
     */
    exportAsciinema(sessionId: string, options?: {
        width?: number;
        height?: number;
        title?: string;
    }): string;
    /**
     * Compute timeline attribution segments (Agent execution vs Human takeover periods).
     */
    getTimelineAttribution(sessionId: string): TimelineSegment[];
    /**
     * Time-Travel Engine: Reconstruct virtual terminal screen buffer at an arbitrary timestamp.
     */
    getTimeTravelSnapshot(sessionId: string, targetTimestamp: number, maxLines?: number): readonly string[];
    /** Get recorded session by ID. */
    getSession(sessionId: string): RecordedSession | undefined;
    /** Clear recorded session history. */
    clear(sessionId?: string): void;
}

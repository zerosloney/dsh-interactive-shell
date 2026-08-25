/**
 * Session Recorder, Time-Travel Snapshot Engine, and Asciinema v2 Exporter.
 *
 * @module
 */
import { VirtualTerminalBuffer } from './client.js';
/**
 * In-memory session recorder capable of timeline slicing, time-travel reconstruction,
 * and exporting to standard Asciinema v2 (.cast) files.
 */
export class SessionRecorder {
    sessions = new Map();
    /** Record an incoming streaming frame. */
    record(frame) {
        let sess = this.sessions.get(frame.sessionId);
        if (!sess) {
            sess = {
                sessionId: frame.sessionId,
                startTime: frame.time,
                frames: [],
                lockHistory: [{ time: frame.time, state: 'agent_driving', actor: 'agent' }],
            };
            this.sessions.set(frame.sessionId, sess);
        }
        sess.frames.push(frame);
        if (frame.type === 'term:init') {
            sess.command = frame.command;
            sess.startTime = frame.time;
        }
        else if (frame.type === 'term:lock') {
            sess.lockHistory.push({
                time: frame.time,
                state: frame.state,
                actor: frame.state === 'user_takeover' ? (frame.lockedBy ?? 'user') : 'agent',
            });
        }
        else if (frame.type === 'term:exit') {
            sess.endTime = frame.time;
        }
    }
    /**
     * Export recorded session to standard Asciinema v2 (.cast) format string.
     */
    exportAsciinema(sessionId, options = {}) {
        const sess = this.sessions.get(sessionId);
        if (!sess) {
            throw new Error(`SessionRecorder: session '${sessionId}' not found`);
        }
        const header = {
            version: 2,
            width: options.width ?? 80,
            height: options.height ?? 24,
            timestamp: Math.floor(sess.startTime / 1000),
            title: options.title ?? sess.command ?? `dsh-session-${sessionId}`,
            env: {
                SHELL: process.env.SHELL || 'bash',
                TERM: 'xterm-256color',
            },
        };
        const lines = [JSON.stringify(header)];
        for (const frame of sess.frames) {
            if (frame.type === 'term:output') {
                const offsetSec = Math.max(0, (frame.time - sess.startTime) / 1000);
                const ev = [
                    Number(offsetSec.toFixed(4)),
                    'o',
                    frame.chunk,
                ];
                lines.push(JSON.stringify(ev));
            }
        }
        return lines.join('\n') + '\n';
    }
    /**
     * Compute timeline attribution segments (Agent execution vs Human takeover periods).
     */
    getTimelineAttribution(sessionId) {
        const sess = this.sessions.get(sessionId);
        if (!sess || sess.frames.length === 0)
            return [];
        const segments = [];
        let currentActor = 'agent';
        let currentSegment = null;
        for (const frame of sess.frames) {
            if (frame.type !== 'term:output' && frame.type !== 'term:lock')
                continue;
            if (frame.type === 'term:lock') {
                currentActor = frame.state === 'user_takeover' ? 'user' : 'agent';
                continue;
            }
            const out = frame;
            if (!currentSegment || currentSegment.actor !== currentActor) {
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = {
                    actor: currentActor,
                    startTime: out.time,
                    endTime: out.time,
                    chunkCount: 1,
                    totalBytes: out.chunk.length,
                };
            }
            else {
                currentSegment.endTime = out.time;
                currentSegment.chunkCount++;
                currentSegment.totalBytes += out.chunk.length;
            }
        }
        if (currentSegment) {
            segments.push(currentSegment);
        }
        return segments;
    }
    /**
     * Time-Travel Engine: Reconstruct virtual terminal screen buffer at an arbitrary timestamp.
     */
    getTimeTravelSnapshot(sessionId, targetTimestamp, maxLines = 1000) {
        const sess = this.sessions.get(sessionId);
        if (!sess)
            return [];
        const buffer = new VirtualTerminalBuffer(maxLines);
        for (const frame of sess.frames) {
            if (frame.time > targetTimestamp)
                break;
            if (frame.type === 'term:output') {
                buffer.append(frame.chunk);
            }
        }
        return buffer.getLines();
    }
    /** Get recorded session by ID. */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    /** Clear recorded session history. */
    clear(sessionId) {
        if (sessionId) {
            this.sessions.delete(sessionId);
        }
        else {
            this.sessions.clear();
        }
    }
}
//# sourceMappingURL=recorder.js.map
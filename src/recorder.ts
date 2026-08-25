/**
 * Session Recorder, Time-Travel Snapshot Engine, and Asciinema v2 Exporter.
 *
 * @module
 */

import type { TermFrame, TermOutputFrame } from './stream.js'
import { VirtualTerminalBuffer } from './client.js'

export interface AsciinemaHeader {
  version: 2
  width: number
  height: number
  timestamp: number
  title?: string
  env?: Record<string, string>
}

export type AsciinemaEvent = [number, 'o' | 'i', string]

export interface TimelineSegment {
  actor: 'agent' | 'user'
  startTime: number
  endTime: number
  chunkCount: number
  totalBytes: number
}

export interface RecordedSession {
  sessionId: string
  command?: string
  startTime: number
  endTime?: number
  frames: TermFrame[]
  lockHistory: Array<{ time: number; state: 'agent_driving' | 'user_takeover'; actor: string }>
}

/**
 * In-memory session recorder capable of timeline slicing, time-travel reconstruction,
 * and exporting to standard Asciinema v2 (.cast) files.
 */
export class SessionRecorder {
  private sessions = new Map<string, RecordedSession>()

  /** Record an incoming streaming frame. */
  record(frame: TermFrame): void {
    let sess = this.sessions.get(frame.sessionId)
    if (!sess) {
      sess = {
        sessionId: frame.sessionId,
        startTime: frame.time,
        frames: [],
        lockHistory: [{ time: frame.time, state: 'agent_driving', actor: 'agent' }],
      }
      this.sessions.set(frame.sessionId, sess)
    }

    sess.frames.push(frame)

    if (frame.type === 'term:init') {
      sess.command = frame.command
      sess.startTime = frame.time
    } else if (frame.type === 'term:lock') {
      sess.lockHistory.push({
        time: frame.time,
        state: frame.state,
        actor: frame.state === 'user_takeover' ? (frame.lockedBy ?? 'user') : 'agent',
      })
    } else if (frame.type === 'term:exit') {
      sess.endTime = frame.time
    }
  }

  /**
   * Export recorded session to standard Asciinema v2 (.cast) format string.
   */
  exportAsciinema(sessionId: string, options: { width?: number; height?: number; title?: string } = {}): string {
    const sess = this.sessions.get(sessionId)
    if (!sess) {
      throw new Error(`SessionRecorder: session '${sessionId}' not found`)
    }

    const header: AsciinemaHeader = {
      version: 2,
      width: options.width ?? 80,
      height: options.height ?? 24,
      timestamp: Math.floor(sess.startTime / 1000),
      title: options.title ?? sess.command ?? `dsh-session-${sessionId}`,
      env: {
        SHELL: process.env.SHELL || 'bash',
        TERM: 'xterm-256color',
      },
    }

    const lines: string[] = [JSON.stringify(header)]

    for (const frame of sess.frames) {
      if (frame.type === 'term:output') {
        const offsetSec = Math.max(0, (frame.time - sess.startTime) / 1000)
        const ev: AsciinemaEvent = [
          Number(offsetSec.toFixed(4)),
          'o',
          frame.chunk,
        ]
        lines.push(JSON.stringify(ev))
      }
    }

    return lines.join('\n') + '\n'
  }

  /**
   * Compute timeline attribution segments (Agent execution vs Human takeover periods).
   */
  getTimelineAttribution(sessionId: string): TimelineSegment[] {
    const sess = this.sessions.get(sessionId)
    if (!sess || sess.frames.length === 0) return []

    const segments: TimelineSegment[] = []
    let currentActor: 'agent' | 'user' = 'agent'
    let currentSegment: TimelineSegment | null = null

    for (const frame of sess.frames) {
      if (frame.type !== 'term:output' && frame.type !== 'term:lock') continue

      if (frame.type === 'term:lock') {
        currentActor = frame.state === 'user_takeover' ? 'user' : 'agent'
        continue
      }

      const out = frame as TermOutputFrame
      if (!currentSegment || currentSegment.actor !== currentActor) {
        if (currentSegment) {
          segments.push(currentSegment)
        }
        currentSegment = {
          actor: currentActor,
          startTime: out.time,
          endTime: out.time,
          chunkCount: 1,
          totalBytes: out.chunk.length,
        }
      } else {
        currentSegment.endTime = out.time
        currentSegment.chunkCount++
        currentSegment.totalBytes += out.chunk.length
      }
    }

    if (currentSegment) {
      segments.push(currentSegment)
    }

    return segments
  }

  /**
   * Time-Travel Engine: Reconstruct virtual terminal screen buffer at an arbitrary timestamp.
   */
  getTimeTravelSnapshot(sessionId: string, targetTimestamp: number, maxLines = 1000): readonly string[] {
    const sess = this.sessions.get(sessionId)
    if (!sess) return []

    const buffer = new VirtualTerminalBuffer(maxLines)

    for (const frame of sess.frames) {
      if (frame.time > targetTimestamp) break
      if (frame.type === 'term:output') {
        buffer.append(frame.chunk)
      }
    }

    return buffer.getLines()
  }

  /** Get recorded session by ID. */
  getSession(sessionId: string): RecordedSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Clear recorded session history. */
  clear(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId)
    } else {
      this.sessions.clear()
    }
  }
}

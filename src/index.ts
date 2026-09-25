/**
 * dsh-interactive-shell: the agent drives real interactive CLIs over the
 * harness `ctx.terminals` PTY seam — a port of pi-interactive-shell's
 * Monitor/Dispatch product layer onto DeepSeek Harness.
 *
 * One `interactive_shell` tool with an `action` field (spawn / send / status
 * / read / kill / attach-monitor), not one tool per verb — the per-request
 * schema-budget lesson from the Pi-vs-DSH benchmark. Modes:
 *
 * - interactive: stable sessionId; agent sends input, checks status.
 * - hands-free: agent polls and receives quiet-window output tails.
 * - dispatch:   fire-and-forget; the agent is woken once on completion
 *               (exit / quiet / timeout / kill) with the output tail.
 * - monitor:    event-driven wake-up on stream triggers or file watching —
 *               zero polling between events.
 *
 * @module dsh-interactive-shell
 */
import { watch } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { TerminalSessionId, TerminalSessionService } from '@deepseek-ai/dsh-terminal'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  dispatchCompleted,
  monitorBudgetExhausted,
  monitorCooldownElapsed,
  resolveMode,
  triggerMatches,
  truncateTail,
  underSessionBudget,
} from './pure.js'
import type { ShellMode, ShellToolArgs } from './pure.js'
import { NO_AGENT_MESSAGE, PTY_UNAVAILABLE_MESSAGE, requireTerminals } from './seam.js'
import { TraceSink } from './trace.js'
import { StreamHub } from './stream.js'
import type { TermFrame } from './stream.js'

export * from './stream.js'
export * from './client.js'
export * from './ui.js'
export * from './security.js'
export * from './component.js'
export * from './transport.js'
export * from './recorder.js'
export * from './prompts.js'

import { evaluateCommandSafety, redactSensitiveData, StreamCircuitBreaker } from './security.js'
import type { SecurityPolicyLevel } from './security.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'interactive-shell'

/**
 * `terminals` is an optional dependency: the bridge activates without a PTY
 * backend (e.g. headless profiles that do not mount dsh-terminal) and simply
 * registers no tool, rather than failing the whole composition. `tools` is
 * required — the registry is the bridge's only reason to exist.
 */
export const inject = ['tools']

/** Plugin configuration; every field maps to a row in cordis.patch.yml. */
export interface Config {
  defaultMode: ShellMode
  maxSessions: number
  outputTailBytes: number
  dispatchQuietMs: number
  dispatchTimeoutMs: number
  monitorCooldownMs: number
  monitorMaxEvents: number
  /** JSONL 事件台账路径；空 = `$DSH_HOME`/`~/.dsh` 下的 interactive-shell/traces.jsonl。 */
  tracePath: string
  /**
   * Registered PTY backend type for new sessions (`terminal-bash.backendType`,
   * default `shell`). Omitted rows fall back in code because a directly
   * applied config carries no schema defaults.
   */
  backendType?: string
  /** Output bytes/second mirrored to stream clients before frames are throttled (default 512 KB/s). */
  maxOutputBytesPerSec?: number
  /** Global security policy level ('permissive' | 'balanced' | 'strict'). */
  securityPolicy?: SecurityPolicyLevel
  /** List of command prefixes or regexes to block. */
  blockedCommands?: string[]
  /** Whitelist of permitted command prefixes (empty = all allowed). */
  allowedCommandsOnly?: string[]
  /** Whether to redact sensitive API keys and secrets (default: true). */
  redactSensitiveData?: boolean
}

export const Config = z.object({
  defaultMode: z.union([
    z.const('interactive'),
    z.const('hands-free'),
    z.const('dispatch'),
    z.const('monitor'),
  ]).default('monitor'),
  maxSessions: z.number().step(1).min(1).max(16).default(4),
  outputTailBytes: z.number().min(256).max(65536).default(4096),
  dispatchQuietMs: z.number().min(500).max(600000).default(5000),
  dispatchTimeoutMs: z.number().min(1000).max(3600000).default(600000),
  monitorCooldownMs: z.number().min(0).max(60000).default(2000),
  monitorMaxEvents: z.number().step(1).min(1).max(1000).default(100),
  tracePath: z.string().default(''),
  backendType: z.string().min(1).default('shell'),
  maxOutputBytesPerSec: z.number().step(1024).min(1024).max(67108864).default(524288),
  securityPolicy: z.union([z.const('permissive'), z.const('balanced'), z.const('strict')]).default('balanced'),
  blockedCommands: z.array(z.string()).default([]),
  allowedCommandsOnly: z.array(z.string()).default([]),
  redactSensitiveData: z.boolean().default(true),
}) as unknown as z<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    interactiveShellStream: StreamHub
  }
  interface Events {
    /** A session spawned by this bridge became live. */
    'interactive-shell/session-started'(payload: {
      sessionId: string
      mode: ShellMode
      command: string
    }): void
    /** A dispatch session completed; the agent should be woken once. */
    'interactive-shell/dispatch-completed'(payload: {
      sessionId: string
      exitCode: number | null
      tail: string
    }): void
    /** A monitor trigger fired; the agent should be woken. */
    'interactive-shell/monitor-triggered'(payload: {
      sessionId: string
      trigger: string
      tail: string
    }): void
    /** A streaming frame was broadcasted to Web UI / stream subscribers (Phase 1). */
    'interactive-shell/stream-frame'(frame: TermFrame): void
    /** Takeover lock status changed between Agent and User (Phase 1). */
    'interactive-shell/lock-changed'(payload: {
      sessionId: string
      state: 'agent_driving' | 'user_takeover'
      lockedBy?: string
    }): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Wake-up notices this bridge injects into its owning agent's conversation.
     *
     * dsh 0.1.7 retired the catch-all `plugin` kind (session format v4 refuses
     * it outright), so every producer declares its own kind here.
     */
    'interactive-shell': { kind: 'interactive-shell' } & ContextFormed
  }
}

/** Per-session supervisor state owned by this bridge. */
interface SessionState {
  sessionId: TerminalSessionId
  /** The agent that spawned this session; used for every seam call (owner-verified). */
  owner: Agent
  /**
   * The PTY registry this session lives in, resolved for `owner` at spawn.
   * Since dsh 0.1.7 that registry is preset-scoped, so a session is only
   * addressable through the instance its owner resolved.
   */
  term: TerminalSessionService
  mode: ShellMode
  command: string
  /** Absolute dispatch deadline (ms): per-call `timeoutMs` when given, else `dispatchTimeoutMs`. */
  timeoutMs: number
  /** Monitor trigger regex source; attach-monitor may (re)set it later. */
  trigger: string | undefined
  /** Monitor file watch target path. */
  watch: string | undefined
  /** Disposer for the attached file watcher (if any). */
  watcherDispose: (() => void) | undefined
  /**
   * Retained-line cursor: how many scrollback lines this bridge has already
   * delivered. `read()` offsets count backwards from the newest line, so the
   * delta is derived from `totalLines` instead (see {@link readTail}).
   */
  seenTotal: number
  /**
   * Text of the last delivered line. A PTY that rewrites its current line
   * (progress bar, spinner, prompt redraw) keeps `seenTotal` unchanged, so the
   * rewrite is detected by comparing this value.
   */
  seenLastLine: string
  /** When the session last produced new output (dispatch quiet-window base). */
  lastOutputAt: number
  /** Last monitor wake-up timestamp (cooldown gate). */
  lastEventAt: number | undefined
  /** How many monitor events fired (budget gate). */
  eventsFired: number
  /** When the session was spawned (dispatch timeout base). */
  startedAt: number
  /** Whether a monitor loop is attached. */
  monitoring: boolean
  /** Cleanup disposers. */
  dispose: () => void
}

/** Lines requested when resynchronizing after the bounded scrollback was trimmed. */
const DELTA_PAGE_LINES = 200

/** Hard cap on lines one delta read may request (the backend still bounds bytes). */
const DELTA_MAX_LINES = 2000

/** Per-call dispatch deadline bounds, mirroring the `dispatchTimeoutMs` Config bounds. */
const MIN_DISPATCH_TIMEOUT_MS = 1000
const MAX_DISPATCH_TIMEOUT_MS = 3600000

/**
 * Mount the interactive-shell bridge: register the single dispatch tool and
 * wire session lifecycle events.
 *
 * @param ctx - plugin context carrying terminals and tools services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): () => void {
  // Availability is per agent since dsh 0.1.7: the PTY family is mounted by an
  // agent preset behind an isolate realm, so the host-plane row that mounts
  // this bridge cannot know at load time whether any preset supplies one. The
  // tool is therefore always registered and resolves the seam per call; a row
  // that instead registered nothing would present a missing capability as a
  // missing tool with no diagnostic.
  if (ctx.get('terminals') === undefined && ctx.get('agentPresets') === undefined) {
    ctx.logger.warn(`interactive-shell: no PTY seam in this composition — ${PTY_UNAVAILABLE_MESSAGE}`)
  }

  /**
   * The exact calling agent of one tool call. Every PTY operation is
   * owner-verified, so a call without an agent is refused here instead of
   * being handed a synthetic owner.
   *
   * @param agent - the tool call's agent, when the caller supplied one.
   * @returns the same agent, narrowed to a definite value.
   */
  function requireAgent(agent: Agent | undefined): Agent {
    if (agent === undefined) throw new Error(NO_AGENT_MESSAGE)
    return agent
  }

  const sessions = new Map<string, SessionState>()
  const pollers = new Set<() => void>()
  /** Session ids this bridge created; the `maxSessions` budget counts only these. */
  const spawnedIds = new Set<string>()
  /** Output mirror rate guard (M5): protects stream clients from PTY floods. */
  const breaker = new StreamCircuitBreaker(config.maxOutputBytesPerSec ?? 512 * 1024)
  // 事件台账：关键生命周期与错误持久化，供运行回溯审计（最小收集：只记事件与摘要）。
  const trace = TraceSink.create(config.tracePath)

  // M4 Phase 1 & 3: 实时流广播、用户按键直通与控制权接管管理器
  const streamHub = new StreamHub({
    onBroadcast: (frame) => {
      ctx.emit('interactive-shell/stream-frame', frame)
      if (frame.type === 'term:lock') {
        ctx.emit('interactive-shell/lock-changed', {
          sessionId: frame.sessionId,
          state: frame.state,
          lockedBy: frame.lockedBy,
        })
      }
    },
    onUserInput: async (sessionId, input) => {
      const state = sessions.get(sessionId)
      if (state === undefined) {
        throw new Error(`interactive-shell: session ${sessionId} not found or not active`)
      }
      const op = state.term.startSend(state.owner, state.sessionId, {
        text: input,
        submit: false,
      })
      const result = await op.done
      readTail(state)
      return result.viewport
    },
    onReleaseLock: (sessionId, summary) => {
      const state = sessions.get(sessionId)
      if (state === undefined) return
      const tail = truncateTail(readTail(state), config.outputTailBytes)
      wakeAgent(
        state.owner,
        `User released control of shell session ${sessionId}`,
        `[interactive_shell] User released interactive control back to you for session ${sessionId} (${state.command}).${summary ? `\nUser note: ${summary}` : ''}\n\nCurrent tail:\n${tail}`,
      )
    },
  })
  ctx.provide('interactiveShellStream', streamHub)

  /**
   * P0: Deliver a model-visible user-turn notice to the owning agent to wake its driver loop.
   * M5: Redact sensitive API keys and secrets before sending to LLM context.
   */
  function wakeAgent(owner: Agent | undefined, summary: string, text: string): void {
    if (owner === undefined || typeof owner.followup !== 'function') return
    try {
      const sanitizedText = config.redactSensitiveData !== false
        ? redactSensitiveData(text).text
        : text
      const sanitizedSummary = config.redactSensitiveData !== false
        ? redactSensitiveData(summary).text
        : summary
      const wakeMsg = createUserMessage({
        content: [{ type: 'text', text: sanitizedText }],
        source: {
          kind: 'interactive-shell',
          form: 'notice',
          // The durable log carries a bounded one-line account (dsh-llm bounds it).
          summary: boundContextSummary(sanitizedSummary),
        },
      })
      owner.followup(wakeMsg)
    } catch (err) {
      trace.record('error', {
        action: 'wake-agent',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * P2: Attach a file watcher for event-driven wake-up upon file changes.
   */
  function attachFileWatch(state: SessionState, filePath: string): () => void {
    try {
      const fsWatcher = watch(filePath, (eventType) => {
        state.lastOutputAt = Date.now()
        if (state.mode === 'monitor') {
          if (!monitorCooldownElapsed(state.lastEventAt, Date.now(), config.monitorCooldownMs)) return
          if (monitorBudgetExhausted(state.eventsFired, config.monitorMaxEvents)) {
            state.monitoring = false
            return
          }
          state.lastEventAt = Date.now()
          state.eventsFired += 1
          const tail = `[watch] File '${filePath}' changed (${eventType})`
          ctx.emit('interactive-shell/monitor-triggered', {
            sessionId: state.sessionId,
            trigger: `watch:${filePath}`,
            tail,
          })
          trace.record('monitor-triggered', { sessionId: state.sessionId, trigger: `watch:${filePath}` })
          streamHub.broadcast({
            type: 'term:event',
            sessionId: state.sessionId,
            event: 'monitor-triggered',
            payload: { trigger: `watch:${filePath}`, tail },
            time: Date.now(),
          })
          wakeAgent(
            state.owner,
            `Shell session ${state.sessionId} file '${filePath}' changed`,
            `[interactive_shell] Session ${state.sessionId} (${state.command}) watch triggered on file '${filePath}' (${eventType}).`,
          )
        }
      })
      return () => fsWatcher.close()
    } catch (err) {
      trace.record('error', {
        action: 'attach-file-watch',
        message: err instanceof Error ? err.message : String(err),
      })
      return () => {}
    }
  }

  /**
   * Read the raw output produced since the previous read for one session.
   *
   * `ctx.terminals.read()` pages scrollback with an offset counted *backwards*
   * from the newest retained line, so `lineEnd` is not a forward cursor —
   * feeding it back as `offset` re-reads older lines and drifts away from the
   * newest output (the P0 defect this replaces). The delta is derived from
   * `totalLines` instead:
   *
   * - more retained lines: deliver the lines past the delivered count, plus the
   *   previously delivered line when the PTY completed that line in place;
   * - same retained count and a different last line: the PTY rewrote its
   *   current line (progress bar, spinner, prompt redraw), so deliver that line;
   * - fewer retained lines, or a page that no longer reaches the delivered
   *   cursor (bounded ring buffer, byte-bounded page): deliver the whole page.
   *
   * A successful read also refreshes the dispatch quiet-window base and
   * broadcasts the real-time chunk frame to the Web UI stream hub.
   *
   * @param state - the session supervisor state holding the cursor.
   * @returns the raw newly produced output; `''` when nothing changed. Callers truncate what reaches the model.
   */
  function readTail(state: SessionState): string {
    // The cheap head read yields the retained-line count and the current last
    // line without materializing the scrollback.
    const head = state.term.read(state.owner, state.sessionId, { offset: 0, count: 1 })
    const lastLine = head.text
    const pending = head.totalLines - state.seenTotal
    let chunk = ''
    let lineBegin = state.seenTotal
    let lineEnd = head.totalLines

    if (pending === 0) {
      // No new line: only an in-place rewrite of the current line is possible.
      if (lastLine !== state.seenLastLine) chunk = lastLine
      lineBegin = Math.max(0, head.totalLines - 1)
    } else if (pending > 0) {
      const page = state.term.read(state.owner, state.sessionId, {
        offset: 0,
        count: Math.min(pending + 1, DELTA_MAX_LINES),
      })
      const lines = page.text.length === 0 ? [] : page.text.split('\n')
      // `totalLines - returnedLines` is the retained index of the page's first
      // line, so the delivered cursor maps into the page by subtraction.
      const firstIndex = Math.max(0, page.totalLines - lines.length)
      const previousIndex = state.seenTotal - 1 - firstIndex
      const previousUnchanged = previousIndex >= 0
        && previousIndex < lines.length
        && lines[previousIndex] === state.seenLastLine
      const from = previousIndex < 0
        ? 0
        : previousUnchanged ? previousIndex + 1 : previousIndex
      chunk = lines.slice(from).join('\n')
      lineBegin = Math.max(0, firstIndex + from)
      lineEnd = page.totalLines
    } else {
      // Retained scrollback shrank (bounded ring): resynchronize on the page.
      const page = state.term.read(state.owner, state.sessionId, { offset: 0, count: DELTA_PAGE_LINES })
      chunk = page.text
      lineBegin = 0
      lineEnd = page.totalLines
    }

    state.seenLastLine = lastLine
    state.seenTotal = Math.max(0, lineEnd)
    if (chunk !== '') {
      state.lastOutputAt = Date.now()
      // M5 circuit breaker: the quiet-window base above always refreshes, but
      // the *mirror* to stream clients is rate-limited so a runaway program
      // cannot flood Web viewers (the model still gets the tail via read/status).
      const verdict = breaker.check(Buffer.byteLength(chunk, 'utf8'))
      if (verdict.allowed) {
        streamHub.broadcast({
          type: 'term:output',
          sessionId: state.sessionId,
          chunk,
          lineBegin,
          lineEnd,
          time: Date.now(),
        })
      } else if (verdict.tripped) {
        trace.record('output-throttled', {
          sessionId: state.sessionId,
          droppedBytes: verdict.droppedBytes,
        })
        streamHub.broadcast({
          type: 'term:event',
          sessionId: state.sessionId,
          event: 'output-throttled',
          payload: { droppedBytes: verdict.droppedBytes },
          time: Date.now(),
        })
      }
    }
    return chunk
  }

  /** One dispatch poll: read new output first (refreshing the quiet-window
   *  base), then detect quiet/exit/timeout completion and wake once.
   *  @param state - the dispatch session under supervision.
   *  @returns whether this tick produced new output (drives adaptive polling).
   */
  function pollDispatch(state: SessionState): boolean {
    const snap = state.term.list(state.owner).find((s) => s.sessionId === state.sessionId)
    const exited = snap?.status.kind === 'exited'
    // 先读增量再判定：readTail 在有新输出时刷新 lastOutputAt，静默窗的
    // 基准才真实。此前 readTail 只在完成路径调用，lastOutputAt 永远停在
    // spawn 时刻，第一次 tick 就误判完成（P0 fix 的补全）。
    const delta = readTail(state)
    const hadOutput = delta !== ''
    const completed = dispatchCompleted({
      exited,
      lastOutputAt: state.lastOutputAt,
      quietMs: config.dispatchQuietMs,
      now: Date.now(),
      timeoutMs: state.timeoutMs,
      startedAt: state.startedAt,
    })
    if (!completed) return hadOutput
    const exitCode = snap?.status.kind === 'exited' ? snap.status.exitCode : null
    const tail = truncateTail(delta, config.outputTailBytes)
    ctx.emit('interactive-shell/dispatch-completed', {
      sessionId: state.sessionId,
      exitCode,
      tail,
    })
    trace.record('dispatch-completed', { sessionId: state.sessionId, exitCode })
    streamHub.broadcast({
      type: 'term:event',
      sessionId: state.sessionId,
      event: 'dispatch-completed',
      payload: { exitCode, tail },
      time: Date.now(),
    })
    if (exited) {
      streamHub.broadcast({
        type: 'term:exit',
        sessionId: state.sessionId,
        exitCode,
        time: Date.now(),
      })
    }
    // P0: 唤醒 Agent 对话回路
    wakeAgent(
      state.owner,
      `Shell session ${state.sessionId} completed (exitCode=${exitCode})`,
      `[interactive_shell] Session ${state.sessionId} (${state.command}) completed (exitCode=${exitCode}).\n\nOutput tail:\n${tail}`,
    )
    stopPolling(state)
    // 会话已结束：从本地登记表移除，避免长时间运行后堆积（P0 附修）。
    sessions.delete(state.sessionId)
    return hadOutput
  }

  /** Publish one monitor trigger: event, trace, stream frame, and one agent wake-up. */
  function fireMonitor(state: SessionState, delta: string): void {
    if (state.trigger === undefined) return
    const tail = truncateTail(delta, config.outputTailBytes)
    state.lastEventAt = Date.now()
    state.eventsFired += 1
    ctx.emit('interactive-shell/monitor-triggered', {
      sessionId: state.sessionId,
      trigger: state.trigger,
      tail,
    })
    trace.record('monitor-triggered', { sessionId: state.sessionId, trigger: state.trigger })
    streamHub.broadcast({
      type: 'term:event',
      sessionId: state.sessionId,
      event: 'monitor-triggered',
      payload: { trigger: state.trigger, tail },
      time: Date.now(),
    })
    // P0: 唤醒 Agent 对话回路
    wakeAgent(
      state.owner,
      `Shell session ${state.sessionId} triggered on /${state.trigger}/`,
      `[interactive_shell] Session ${state.sessionId} (${state.command}) triggered on /${state.trigger}/.\n\nOutput tail:\n${tail}`,
    )
  }

  /** One monitor poll: match new output against the state's trigger; cooldown + budget.
   *  @param state - the monitor session under supervision.
   *  @returns whether this tick produced new output (drives adaptive polling).
   */
  function pollMonitor(state: SessionState): boolean {
    if (state.trigger === undefined) return false
    const snap = state.term.list(state.owner).find((s) => s.sessionId === state.sessionId)
    if (snap === undefined || snap.status.kind === 'exited') {
      // 会话已退出：停止轮询并清理登记（P1 附修：原实现不清理）。
      state.monitoring = false
      sessions.delete(state.sessionId)
      stopPolling(state)
      return false
    }
    if (monitorBudgetExhausted(state.eventsFired, config.monitorMaxEvents)) {
      state.monitoring = false
      return false
    }
    if (!monitorCooldownElapsed(state.lastEventAt, Date.now(), config.monitorCooldownMs)) return false
    const delta = readTail(state)
    if (delta === '') return false
    // Match the raw delta, never the truncated model-facing tail: truncation
    // drops the middle of a large delta and could hide the trigger line.
    if (!triggerMatches(state.trigger, delta)) return true
    fireMonitor(state, delta)
    return true
  }

  /**
   * Zero-wait monitor probe for `attach-monitor`: match the *current* page
   * instead of the delta, so a trigger attached after the interesting line
   * already scrolled still fires on the attach call, then resynchronize the
   * cursor so later wake-ups only consider output produced after the probe.
   * @param state - the session being attached to monitor mode.
   */
  function probeMonitor(state: SessionState): void {
    if (state.trigger === undefined) return
    const page = state.term.read(state.owner, state.sessionId, { offset: 0, count: DELTA_PAGE_LINES })
    const lines = page.text.length === 0 ? [] : page.text.split('\n')
    state.seenTotal = Math.max(0, page.totalLines)
    state.seenLastLine = lines.length === 0 ? '' : lines[lines.length - 1] ?? ''
    if (page.text === '') return
    if (monitorBudgetExhausted(state.eventsFired, config.monitorMaxEvents)) {
      state.monitoring = false
      return
    }
    if (!monitorCooldownElapsed(state.lastEventAt, Date.now(), config.monitorCooldownMs)) return
    if (!triggerMatches(state.trigger, page.text)) return
    fireMonitor(state, page.text)
  }

  /** Wire an adaptive poller for one session mode; returns the stop function. */
  function startPolling(state: SessionState): () => void {
    let active = true
    let currentDelayMs = 50
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = () => {
      if (!active) return

      let hasActivity = false
      if (state.mode === 'dispatch') {
        hasActivity = pollDispatch(state)
        if (!sessions.has(state.sessionId)) return
      } else if (state.mode === 'monitor') {
        hasActivity = pollMonitor(state)
        if (!sessions.has(state.sessionId) || !state.monitoring) return
      }

      // Adaptive backoff: fast probe (100ms) when output is actively flowing,
      // smoothly backs off to 500ms when idle
      if (hasActivity) {
        currentDelayMs = 100
      } else {
        currentDelayMs = Math.min(500, Math.floor(currentDelayMs * 1.5))
      }

      if (active) {
        timer = setTimeout(tick, currentDelayMs)
      }
    }

    timer = setTimeout(tick, 50)

    const dispose = () => {
      active = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pollers.delete(dispose)
    }

    pollers.add(dispose)
    return dispose
  }

  function stopPolling(state: SessionState): void {
    state.watcherDispose?.()
    state.watcherDispose = undefined
    state.dispose()
  }

  const tool: ToolDefinition = defineTool({
    name: 'interactive_shell',
    description:
      'Drive an interactive CLI (vim, psql, ssh, dev server) in a real PTY. ' +
      'actions: spawn (start a session), send (write input), status (report ' +
      'session state + tail), read (bounded tail), kill (terminate), ' +
      'attach-monitor (event-driven wake-up on a regex trigger or file watch). ' +
      'Modes: interactive / hands-free / dispatch (wake once on completion) / ' +
      'monitor (wake on trigger only).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['spawn', 'send', 'status', 'read', 'kill', 'attach-monitor'],
        description: 'Operation to perform on a PTY session.',
      },
      command: { type: 'string', description: 'spawn: the command line to run in the new PTY session.' },
      mode: {
        type: 'string',
        enum: ['interactive', 'hands-free', 'dispatch', 'monitor'],
        description:
          'spawn: how results come back. interactive = agent drives it; dispatch = one wake-up on exit, quiet window, or deadline; monitor = wake only when a trigger matches.',
      },
      sessionId: {
        type: 'string',
        description: 'send | status | read | kill | attach-monitor: the id returned by spawn.',
      },
      input: {
        type: 'string',
        description: 'send: text written to the PTY — keystrokes for an interactive program, a command line with submit=true.',
      },
      submit: { type: 'boolean', description: 'send: append the backend Enter sequence after input.' },
      trigger: {
        type: 'string',
        description: 'spawn | attach-monitor: regex matched against new output; a match wakes the agent.',
      },
      watch: {
        type: 'string',
        description: 'spawn | attach-monitor: file path whose changes wake the agent.',
      },
      timeoutMs: {
        type: 'integer',
        description:
          'spawn in dispatch mode: absolute deadline in ms for this run (1000-3600000). Defaults to the configured dispatchTimeoutMs.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          text: { type: 'string', required: true },
          exited: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const a = args as ShellToolArgs
      const sanitizeOutput = (text: string): string =>
        config.redactSensitiveData !== false ? redactSensitiveData(text).text : text

      try {
      switch (a.action) {
        case 'spawn': {
          if (a.command === undefined || a.command === '') {
            throw new Error('interactive_shell spawn requires a command')
          }
          if (a.timeoutMs !== undefined
            && (a.timeoutMs < MIN_DISPATCH_TIMEOUT_MS || a.timeoutMs > MAX_DISPATCH_TIMEOUT_MS)) {
            throw new Error(
              `interactive_shell timeoutMs must be between ${MIN_DISPATCH_TIMEOUT_MS} and ${MAX_DISPATCH_TIMEOUT_MS} ms`,
            )
          }
          // M5: 生产安全沙箱与高危指令检查
          const safety = evaluateCommandSafety(a.command, {
            policyLevel: config.securityPolicy,
            blockedCommands: config.blockedCommands,
            allowedCommandsOnly: config.allowedCommandsOnly,
          })
          if (!safety.allowed) {
            const errorMsg = `interactive-shell security policy violation [${safety.riskLevel}]: ${safety.reason}`
            trace.record('error', { action: 'spawn', command: a.command, reason: safety.reason, riskLevel: safety.riskLevel })
            throw new Error(errorMsg)
          }

          const owner = requireAgent(exec.agent)
          const term = requireTerminals(ctx, owner)
          // 预算只计本插件创建且仍存活的会话：term.list(owner) 还包含其他工具
          // （persistent-bash / tool-terminal）持有的 PTY，拿它当预算会误拒。
          const listed = term.list(owner)
          const listedIds = new Set(listed.map((entry) => String(entry.sessionId)))
          for (const id of spawnedIds) {
            if (!listedIds.has(id)) spawnedIds.delete(id)
          }
          const live = listed.filter(
            (entry) => spawnedIds.has(String(entry.sessionId)) && entry.status.kind === 'running',
          ).length
          if (!underSessionBudget(live, config.maxSessions)) {
            throw new Error(
              `interactive-shell: session budget exceeded (${live}/${config.maxSessions}) — kill a session first`,
            )
          }
          const mode = resolveMode(a.mode, config.defaultMode)
          // P1: 不将单次 tool call 的 exec.signal 传递给长期运行的后台 PTY 进程
          // 不传 name：PTY 的 owner 内显示名必须唯一，重复命令会触发 DUPLICATE_NAME，
          // 与本插件「同一命令并行跑多个会话」的用法冲突；命令文本由台账与事件承载。
          const result = await term.spawn(owner, { type: config.backendType ?? 'shell' })
          spawnedIds.add(String(result.sessionId))
          const state: SessionState = {
            sessionId: result.sessionId,
            owner,
            term,
            mode,
            command: a.command,
            timeoutMs: a.timeoutMs ?? config.dispatchTimeoutMs,
            trigger: a.trigger,
            watch: a.watch,
            watcherDispose: undefined,
            seenTotal: 0,
            seenLastLine: '',
            lastOutputAt: Date.now(),
            lastEventAt: undefined,
            eventsFired: 0,
            startedAt: Date.now(),
            monitoring: mode === 'monitor',
            dispose: () => {},
          }
          // Resynchronize the delta cursor on the spawn-time scrollback: this
          // call already returns the motd, so only output produced after it
          // counts as new.
          const head = term.read(owner, result.sessionId, { offset: 0, count: 1 })
          state.seenTotal = head.totalLines
          state.seenLastLine = head.text
          if (a.watch !== undefined && a.watch !== '') {
            state.watcherDispose = attachFileWatch(state, a.watch)
          }
          state.dispose = startPolling(state)
          sessions.set(result.sessionId, state)
          ctx.emit('interactive-shell/session-started', {
            sessionId: result.sessionId,
            mode,
            command: a.command,
          })
          trace.record('session-started', { sessionId: result.sessionId, mode, command: a.command })
          streamHub.broadcast({
            type: 'term:init',
            sessionId: result.sessionId,
            command: a.command,
            mode,
            motd: result.motd,
            time: Date.now(),
          })
          streamHub.broadcast({
            type: 'term:event',
            sessionId: result.sessionId,
            event: 'session-started',
            payload: { mode, command: a.command },
            time: Date.now(),
          })
          return { sessionId: result.sessionId, text: sanitizeOutput(result.motd), exited: false }
        }
        case 'send': {
          if (a.sessionId === undefined || a.input === undefined) {
            throw new Error('interactive_shell send requires sessionId and input')
          }
          // M5: 生产安全沙箱与高危指令检查
          if (a.input !== '') {
            const safety = evaluateCommandSafety(a.input, {
              policyLevel: config.securityPolicy,
              blockedCommands: config.blockedCommands,
              allowedCommandsOnly: config.allowedCommandsOnly,
            })
            if (!safety.allowed) {
              const errorMsg = `interactive-shell security policy violation [${safety.riskLevel}]: ${safety.reason}`
              trace.record('error', { action: 'send', sessionId: a.sessionId, reason: safety.reason, riskLevel: safety.riskLevel })
              throw new Error(errorMsg)
            }
          }

          const lock = streamHub.getLockState(a.sessionId)
          if (lock.state === 'user_takeover') {
            throw new Error(
              `interactive-shell: session ${a.sessionId} is currently locked by user takeover (${lock.lockedBy ?? 'user'}) — wait for user to release control`,
            )
          }
          const owner = requireAgent(exec.agent)
          const session = sessions.get(a.sessionId)
          const term = session?.term ?? requireTerminals(ctx, owner)
          const op = term.startSend(owner, TerminalSessionId(a.sessionId), {
            text: a.input,
            submit: a.submit ?? false,
            signal: exec.signal,
          })
          const result = await op.done
          return { sessionId: a.sessionId, text: sanitizeOutput(result.viewport), exited: false }
        }
        case 'status': {
          if (a.sessionId === undefined) throw new Error('interactive_shell status requires sessionId')
          const owner = requireAgent(exec.agent)
          const tracked = sessions.get(a.sessionId)
          const term = tracked?.term ?? requireTerminals(ctx, owner)
          const snap = term.list(owner).find((s) => s.sessionId === a.sessionId)
          if (snap === undefined) {
            const state = sessions.get(a.sessionId)
            if (state !== undefined) stopPolling(state)
            sessions.delete(a.sessionId)
            streamHub.cleanup(a.sessionId)
            return { text: `session ${a.sessionId} not found`, exited: false }
          }
          const tail = truncateTail(
            term.read(owner, TerminalSessionId(a.sessionId)).text,
            config.outputTailBytes,
          )
          const exited = snap.status.kind === 'exited'
          if (exited) {
            // P1: 处于已退出状态的会话从 Map 中移除并停止监听
            const state = sessions.get(a.sessionId)
            if (state !== undefined) stopPolling(state)
            sessions.delete(a.sessionId)
            streamHub.cleanup(a.sessionId)
          }
          return { sessionId: a.sessionId, text: sanitizeOutput(`status=${snap.status.kind}${exited ? ` exit=${(snap.status as { exitCode: number | null }).exitCode}` : ''}\n${tail}`), exited }
        }
        case 'read': {
          if (a.sessionId === undefined) throw new Error('interactive_shell read requires sessionId')
          const owner = requireAgent(exec.agent)
          const term = sessions.get(a.sessionId)?.term ?? requireTerminals(ctx, owner)
          const result = term.read(owner, TerminalSessionId(a.sessionId))
          return { sessionId: a.sessionId, text: sanitizeOutput(truncateTail(result.text, config.outputTailBytes)), exited: false }
        }
        case 'kill': {
          if (a.sessionId === undefined) throw new Error('interactive_shell kill requires sessionId')
          const owner = requireAgent(exec.agent)
          const term = sessions.get(a.sessionId)?.term ?? requireTerminals(ctx, owner)
          await term.kill(owner, TerminalSessionId(a.sessionId), 'interactive-shell kill')
          const state = sessions.get(a.sessionId)
          if (state !== undefined) stopPolling(state)
          sessions.delete(a.sessionId)
          spawnedIds.delete(a.sessionId)
          trace.record('session-killed', { sessionId: a.sessionId })
          streamHub.broadcast({
            type: 'term:event',
            sessionId: a.sessionId,
            event: 'session-killed',
            payload: {},
            time: Date.now(),
          })
          streamHub.cleanup(a.sessionId)
          return { sessionId: a.sessionId, text: 'terminated', exited: true }
        }
        case 'attach-monitor': {
          if (a.sessionId === undefined || (a.trigger === undefined && a.watch === undefined)) {
            throw new Error('interactive_shell attach-monitor requires sessionId and trigger or watch')
          }
          const state = sessions.get(a.sessionId)
          if (state === undefined) throw new Error(`interactive-shell: session ${a.sessionId} not owned`)
          if (state.monitoring && a.trigger === undefined && a.watch === undefined) {
            return { sessionId: a.sessionId, text: 'already monitoring', exited: false }
          }
          state.monitoring = true
          state.mode = 'monitor'
          if (a.trigger !== undefined) {
            state.trigger = a.trigger
          }
          if (a.watch !== undefined && a.watch !== '') {
            state.watch = a.watch
            state.watcherDispose?.()
            state.watcherDispose = attachFileWatch(state, a.watch)
          }
          // Zero-wait instant check if trigger was updated: probe the current
          // page (not the delta) so an already-printed line still fires, and
          // resynchronize the delta cursor for subsequent wake-ups.
          if (state.trigger !== undefined) {
            probeMonitor(state)
          }
          return {
            sessionId: a.sessionId,
            text: `monitoring for ${state.trigger ? `/${state.trigger}/` : ''}${state.watch ? ` watch:${state.watch}` : ''}`.trim(),
            exited: false,
          }
        }
        default:
          throw new Error(`interactive_shell: unknown action ${(a as { action: string }).action}`)
      }
      } catch (error) {
        // 所有动作的失败都落台账（最小收集：action + 错误消息），再原样抛出。
        trace.record('error', {
          action: a.action,
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  })

  ctx.effect(() => {
    const disposeTool = ctx.tools.register(tool)
    return () => {
      disposeTool()
      for (const stop of pollers) stop()
      pollers.clear()
      for (const state of sessions.values()) {
        state.watcherDispose?.()
      }
      sessions.clear()
      streamHub.dispose()
    }
  }, 'interactive-shell.tool')

  // Return the effect disposer so callers (and tests) can stop polling.
  return () => {
    for (const stop of pollers) stop()
    pollers.clear()
    for (const state of sessions.values()) {
      state.watcherDispose?.()
    }
    sessions.clear()
    streamHub.dispose()
  }
}

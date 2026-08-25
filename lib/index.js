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
import { watch } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal';
import { dispatchCompleted, monitorBudgetExhausted, monitorCooldownElapsed, resolveMode, triggerMatches, truncateTail, underSessionBudget, } from './pure.js';
import { TraceSink } from './trace.js';
import { StreamHub } from './stream.js';
export * from './stream.js';
export * from './client.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'interactive-shell';
/**
 * `terminals` is an optional dependency: the bridge activates without a PTY
 * backend (e.g. headless profiles that do not mount dsh-terminal) and simply
 * registers no tool, rather than failing the whole composition. `tools` is
 * required — the registry is the bridge's only reason to exist.
 */
export const inject = ['tools'];
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
});
/**
 * Mount the interactive-shell bridge: register the single dispatch tool and
 * wire session lifecycle events.
 *
 * @param ctx - plugin context carrying terminals and tools services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
    const terminals = ctx.get('terminals');
    if (terminals === undefined) {
        // Honest degradation: no PTY backend mounted (e.g. headless), so the
        // bridge registers no tool instead of failing the composition. The
        // plugin activates and waits for an HMR reload with terminals present.
        ctx.logger.info('interactive-shell: no terminals service mounted — tool not registered');
        return () => { };
    }
    // Non-null local for closures: the guard above settled presence, and
    // TypeScript cannot narrow a captured variable across function boundaries.
    const term = terminals;
    const sessions = new Map();
    const pollers = new Set();
    // 事件台账：关键生命周期与错误持久化，供运行回溯审计（最小收集：只记事件与摘要）。
    const trace = TraceSink.create(config.tracePath);
    // M4 Phase 1: 实时流广播与控制权管理器
    const streamHub = new StreamHub({
        onBroadcast: (frame) => {
            ctx.emit('interactive-shell/stream-frame', frame);
            if (frame.type === 'term:lock') {
                ctx.emit('interactive-shell/lock-changed', {
                    sessionId: frame.sessionId,
                    state: frame.state,
                    lockedBy: frame.lockedBy,
                });
            }
        },
    });
    ctx.provide('interactiveShellStream', streamHub);
    /**
     * P0: Deliver a model-visible user-turn notice to the owning agent to wake its driver loop.
     */
    function wakeAgent(owner, summary, text) {
        if (owner === undefined || typeof owner.followup !== 'function')
            return;
        try {
            const wakeMsg = createUserMessage({
                content: [{ type: 'text', text }],
                source: {
                    kind: 'plugin',
                    plugin: 'interactive-shell',
                    form: 'notice',
                    summary,
                },
            });
            owner.followup(wakeMsg);
        }
        catch (err) {
            trace.record('error', {
                action: 'wake-agent',
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
    /**
     * P2: Attach a file watcher for event-driven wake-up upon file changes.
     */
    function attachFileWatch(state, filePath) {
        try {
            const fsWatcher = watch(filePath, (eventType) => {
                state.lastOutputAt = Date.now();
                if (state.mode === 'monitor') {
                    if (!monitorCooldownElapsed(state.lastEventAt, Date.now(), config.monitorCooldownMs))
                        return;
                    if (monitorBudgetExhausted(state.eventsFired, config.monitorMaxEvents)) {
                        state.monitoring = false;
                        return;
                    }
                    state.lastEventAt = Date.now();
                    state.eventsFired += 1;
                    const tail = `[watch] File '${filePath}' changed (${eventType})`;
                    ctx.emit('interactive-shell/monitor-triggered', {
                        sessionId: state.sessionId,
                        trigger: `watch:${filePath}`,
                        tail,
                    });
                    trace.record('monitor-triggered', { sessionId: state.sessionId, trigger: `watch:${filePath}` });
                    streamHub.broadcast({
                        type: 'term:event',
                        sessionId: state.sessionId,
                        event: 'monitor-triggered',
                        payload: { trigger: `watch:${filePath}`, tail },
                        time: Date.now(),
                    });
                    wakeAgent(state.owner, `Shell session ${state.sessionId} file '${filePath}' changed`, `[interactive_shell] Session ${state.sessionId} (${state.command}) watch triggered on file '${filePath}' (${eventType}).`);
                }
            });
            return () => fsWatcher.close();
        }
        catch (err) {
            trace.record('error', {
                action: 'attach-file-watch',
                message: err instanceof Error ? err.message : String(err),
            });
            return () => { };
        }
    }
    /**
     * Read the bounded tail of one session since the last read, using the
     * owning agent (never a fabricated owner object) so the terminals seam's
     * owner checks see the real caller.
     *
     * P1: Pass state.lastRead as offset to ensure pagination/cursor correctness.
     * M4 Phase 1: Broadcast real-time chunk output frame to Web UI stream hub.
     */
    function readTail(state) {
        const result = term.read(state.owner, TerminalSessionId(state.sessionId), { count: 200, offset: state.lastRead });
        state.lastRead = result.lineEnd;
        if (result.text.length > 0) {
            state.lastOutputAt = Date.now();
            streamHub.broadcast({
                type: 'term:output',
                sessionId: state.sessionId,
                chunk: result.text,
                lineBegin: result.lineBegin,
                lineEnd: result.lineEnd,
                time: Date.now(),
            });
        }
        return truncateTail(result.text, config.outputTailBytes);
    }
    /** One dispatch poll: read new output first (refreshing the quiet-window
     *  base), then detect quiet/exit/timeout completion and wake once. */
    function pollDispatch(state) {
        const snap = term.list(state.owner).find((s) => s.sessionId === state.sessionId);
        const exited = snap?.status.kind === 'exited';
        // 先读增量再判定：readTail 在有新输出时刷新 lastOutputAt，静默窗的
        // 基准才真实。此前 readTail 只在完成路径调用，lastOutputAt 永远停在
        // spawn 时刻，第一次 tick 就误判完成（P0 fix 的补全）。
        const delta = readTail(state);
        const completed = dispatchCompleted({
            exited,
            lastOutputAt: state.lastOutputAt,
            quietMs: config.dispatchQuietMs,
            now: Date.now(),
            timeoutMs: config.dispatchTimeoutMs,
            startedAt: state.startedAt,
        });
        if (!completed)
            return;
        const exitCode = snap?.status.kind === 'exited' ? snap.status.exitCode : null;
        ctx.emit('interactive-shell/dispatch-completed', {
            sessionId: state.sessionId,
            exitCode,
            tail: delta,
        });
        trace.record('dispatch-completed', { sessionId: state.sessionId, exitCode });
        streamHub.broadcast({
            type: 'term:event',
            sessionId: state.sessionId,
            event: 'dispatch-completed',
            payload: { exitCode, tail: delta },
            time: Date.now(),
        });
        if (exited) {
            streamHub.broadcast({
                type: 'term:exit',
                sessionId: state.sessionId,
                exitCode,
                time: Date.now(),
            });
        }
        // P0: 唤醒 Agent 对话回路
        wakeAgent(state.owner, `Shell session ${state.sessionId} completed (exitCode=${exitCode})`, `[interactive_shell] Session ${state.sessionId} (${state.command}) completed (exitCode=${exitCode}).\n\nOutput tail:\n${delta}`);
        stopPolling(state);
        // 会话已结束：从本地登记表移除，避免长时间运行后堆积（P0 附修）。
        sessions.delete(state.sessionId);
    }
    /** One monitor poll: match new output against the state's trigger; cooldown + budget. */
    function pollMonitor(state) {
        if (state.trigger === undefined)
            return;
        const snap = term.list(state.owner).find((s) => s.sessionId === state.sessionId);
        if (snap === undefined || snap.status.kind === 'exited') {
            // 会话已退出：停止轮询并清理登记（P1 附修：原实现不清理）。
            state.monitoring = false;
            sessions.delete(state.sessionId);
            stopPolling(state);
            return;
        }
        if (monitorBudgetExhausted(state.eventsFired, config.monitorMaxEvents)) {
            state.monitoring = false;
            return;
        }
        if (!monitorCooldownElapsed(state.lastEventAt, Date.now(), config.monitorCooldownMs))
            return;
        const delta = readTail(state);
        if (delta === '' || !triggerMatches(state.trigger, delta))
            return;
        state.lastEventAt = Date.now();
        state.eventsFired += 1;
        ctx.emit('interactive-shell/monitor-triggered', {
            sessionId: state.sessionId,
            trigger: state.trigger,
            tail: delta,
        });
        trace.record('monitor-triggered', { sessionId: state.sessionId, trigger: state.trigger });
        streamHub.broadcast({
            type: 'term:event',
            sessionId: state.sessionId,
            event: 'monitor-triggered',
            payload: { trigger: state.trigger, tail: delta },
            time: Date.now(),
        });
        // P0: 唤醒 Agent 对话回路
        wakeAgent(state.owner, `Shell session ${state.sessionId} triggered on /${state.trigger}/`, `[interactive_shell] Session ${state.sessionId} (${state.command}) triggered on /${state.trigger}/.\n\nOutput tail:\n${delta}`);
    }
    /** Wire a poller for one session mode; returns the stop function. */
    function startPolling(state) {
        const timer = setInterval(() => {
            // trigger/模式都从 state 实时读取：attach-monitor 后续设置的
            // trigger 能真正生效（P0 fix：原实现把 trigger 固化在闭包里）。
            if (state.mode === 'dispatch')
                pollDispatch(state);
            else if (state.mode === 'monitor')
                pollMonitor(state);
        }, 500);
        pollers.add(timer);
        return () => {
            clearInterval(timer);
            pollers.delete(timer);
        };
    }
    function stopPolling(state) {
        state.watcherDispose?.();
        state.watcherDispose = undefined;
        state.dispose();
    }
    const tool = {
        name: 'interactive_shell',
        description: 'Drive an interactive CLI (vim, psql, ssh, dev server) in a real PTY. ' +
            'actions: spawn (start a session), send (write input), status (report ' +
            'session state + tail), read (bounded tail), kill (terminate), ' +
            'attach-monitor (event-driven wake-up on a regex trigger or file watch). ' +
            'Modes: interactive / hands-free / dispatch (wake once on completion) / ' +
            'monitor (wake on trigger only).',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['spawn', 'send', 'status', 'read', 'kill', 'attach-monitor'] },
                command: { type: 'string' },
                mode: { type: 'string', enum: ['interactive', 'hands-free', 'dispatch', 'monitor'] },
                sessionId: { type: 'string' },
                input: { type: 'string' },
                submit: { type: 'boolean' },
                trigger: { type: 'string' },
                watch: { type: 'string' },
                timeoutMs: { type: 'number' },
            },
            required: ['action'],
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string' },
                    text: { type: 'string' },
                    exited: { type: 'boolean' },
                },
                required: ['text'],
                additionalProperties: false,
            },
            render(_args, value) {
                const v = value;
                return [{ type: 'text', text: v.text ?? '' }];
            },
        },
        async execute(args, exec) {
            const a = (args ?? {});
            try {
                switch (a.action) {
                    case 'spawn': {
                        if (a.command === undefined || a.command === '') {
                            throw new Error('interactive_shell spawn requires a command');
                        }
                        const live = term.list(exec.agent).length;
                        if (!underSessionBudget(live, config.maxSessions)) {
                            throw new Error(`interactive-shell: session budget exceeded (${live}/${config.maxSessions}) — kill a session first`);
                        }
                        const mode = resolveMode(a.mode, config.defaultMode);
                        // P1: 不将单次 tool call 的 exec.signal 传递给长期运行的后台 PTY 进程
                        const result = await terminals.spawn(exec.agent, {
                            type: 'shell',
                            name: a.command,
                        });
                        const state = {
                            sessionId: result.sessionId,
                            owner: exec.agent,
                            mode,
                            command: a.command,
                            trigger: a.trigger,
                            watch: a.watch,
                            watcherDispose: undefined,
                            lastRead: 0,
                            lastOutputAt: Date.now(),
                            lastEventAt: undefined,
                            eventsFired: 0,
                            startedAt: Date.now(),
                            monitoring: mode === 'monitor',
                            dispose: () => { },
                        };
                        if (a.watch !== undefined && a.watch !== '') {
                            state.watcherDispose = attachFileWatch(state, a.watch);
                        }
                        state.dispose = startPolling(state);
                        sessions.set(result.sessionId, state);
                        ctx.emit('interactive-shell/session-started', {
                            sessionId: result.sessionId,
                            mode,
                            command: a.command,
                        });
                        trace.record('session-started', { sessionId: result.sessionId, mode, command: a.command });
                        streamHub.broadcast({
                            type: 'term:init',
                            sessionId: result.sessionId,
                            command: a.command,
                            mode,
                            motd: result.motd,
                            time: Date.now(),
                        });
                        streamHub.broadcast({
                            type: 'term:event',
                            sessionId: result.sessionId,
                            event: 'session-started',
                            payload: { mode, command: a.command },
                            time: Date.now(),
                        });
                        return { sessionId: result.sessionId, text: result.motd, exited: false };
                    }
                    case 'send': {
                        if (a.sessionId === undefined || a.input === undefined) {
                            throw new Error('interactive_shell send requires sessionId and input');
                        }
                        const op = term.startSend(exec.agent, TerminalSessionId(a.sessionId), {
                            text: a.input,
                            submit: a.submit ?? false,
                            signal: exec.signal,
                        });
                        const result = await op.done;
                        return { sessionId: a.sessionId, text: result.viewport, exited: false };
                    }
                    case 'status': {
                        if (a.sessionId === undefined)
                            throw new Error('interactive_shell status requires sessionId');
                        const snap = term.list(exec.agent).find((s) => s.sessionId === a.sessionId);
                        if (snap === undefined) {
                            const state = sessions.get(a.sessionId);
                            if (state !== undefined)
                                stopPolling(state);
                            sessions.delete(a.sessionId);
                            streamHub.cleanup(a.sessionId);
                            return { text: `session ${a.sessionId} not found`, exited: false };
                        }
                        const tail = truncateTail(term.read(exec.agent, TerminalSessionId(a.sessionId)).text, config.outputTailBytes);
                        const exited = snap.status.kind === 'exited';
                        if (exited) {
                            // P1: 处于已退出状态的会话从 Map 中移除并停止监听
                            const state = sessions.get(a.sessionId);
                            if (state !== undefined)
                                stopPolling(state);
                            sessions.delete(a.sessionId);
                            streamHub.cleanup(a.sessionId);
                        }
                        return { sessionId: a.sessionId, text: `status=${snap.status.kind}${exited ? ` exit=${snap.status.exitCode}` : ''}\n${tail}`, exited };
                    }
                    case 'read': {
                        if (a.sessionId === undefined)
                            throw new Error('interactive_shell read requires sessionId');
                        const result = term.read(exec.agent, TerminalSessionId(a.sessionId));
                        return { sessionId: a.sessionId, text: truncateTail(result.text, config.outputTailBytes), exited: false };
                    }
                    case 'kill': {
                        if (a.sessionId === undefined)
                            throw new Error('interactive_shell kill requires sessionId');
                        await term.kill(exec.agent, TerminalSessionId(a.sessionId), 'interactive-shell kill');
                        const state = sessions.get(a.sessionId);
                        if (state !== undefined)
                            stopPolling(state);
                        sessions.delete(a.sessionId);
                        trace.record('session-killed', { sessionId: a.sessionId });
                        streamHub.broadcast({
                            type: 'term:event',
                            sessionId: a.sessionId,
                            event: 'session-killed',
                            payload: {},
                            time: Date.now(),
                        });
                        streamHub.cleanup(a.sessionId);
                        return { sessionId: a.sessionId, text: 'terminated', exited: true };
                    }
                    case 'attach-monitor': {
                        if (a.sessionId === undefined || (a.trigger === undefined && a.watch === undefined)) {
                            throw new Error('interactive_shell attach-monitor requires sessionId and trigger or watch');
                        }
                        const state = sessions.get(a.sessionId);
                        if (state === undefined)
                            throw new Error(`interactive-shell: session ${a.sessionId} not owned`);
                        if (state.monitoring && a.trigger === undefined && a.watch === undefined) {
                            return { sessionId: a.sessionId, text: 'already monitoring', exited: false };
                        }
                        state.monitoring = true;
                        state.mode = 'monitor';
                        if (a.trigger !== undefined) {
                            state.trigger = a.trigger;
                        }
                        if (a.watch !== undefined && a.watch !== '') {
                            state.watch = a.watch;
                            state.watcherDispose?.();
                            state.watcherDispose = attachFileWatch(state, a.watch);
                        }
                        return {
                            sessionId: a.sessionId,
                            text: `monitoring for ${state.trigger ? `/${state.trigger}/` : ''}${state.watch ? ` watch:${state.watch}` : ''}`.trim(),
                            exited: false,
                        };
                    }
                    default:
                        throw new Error(`interactive_shell: unknown action ${a.action}`);
                }
            }
            catch (error) {
                // 所有动作的失败都落台账（最小收集：action + 错误消息），再原样抛出。
                trace.record('error', {
                    action: a.action,
                    message: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        },
    };
    ctx.effect(() => {
        const disposeTool = ctx.tools.register(tool);
        return () => {
            disposeTool();
            for (const poller of pollers)
                clearInterval(poller);
            pollers.clear();
            for (const state of sessions.values()) {
                state.watcherDispose?.();
            }
            sessions.clear();
            streamHub.dispose();
        };
    }, 'interactive-shell.tool');
    // Return the effect disposer so callers (and tests) can stop polling.
    return () => {
        for (const poller of pollers)
            clearInterval(poller);
        pollers.clear();
        for (const state of sessions.values()) {
            state.watcherDispose?.();
        }
        sessions.clear();
        streamHub.dispose();
    };
}
//# sourceMappingURL=index.js.map
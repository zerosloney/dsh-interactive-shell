import z from '@deepseek-ai/schemastery';
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal';
import { dispatchCompleted, monitorBudgetExhausted, monitorCooldownElapsed, resolveMode, triggerMatches, truncateTail, underSessionBudget, } from './pure.js';
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
    /**
     * Read the bounded tail of one session since the last read, using the
     * owning agent (never a fabricated owner object) so the terminals seam's
     * owner checks see the real caller.
     */
    function readTail(state) {
        const result = term.read(state.owner, TerminalSessionId(state.sessionId), { count: 200 });
        state.lastRead = result.lineEnd;
        if (result.text.length > 0)
            state.lastOutputAt = Date.now();
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
            state.dispose();
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
                    const result = await terminals.spawn(exec.agent, {
                        type: 'shell',
                        name: a.command,
                    }, exec.signal);
                    const state = {
                        sessionId: result.sessionId,
                        owner: exec.agent,
                        mode,
                        command: a.command,
                        trigger: a.trigger,
                        lastRead: 0,
                        lastOutputAt: Date.now(),
                        lastEventAt: undefined,
                        eventsFired: 0,
                        startedAt: Date.now(),
                        monitoring: mode === 'monitor',
                        dispose: () => { },
                    };
                    state.dispose = startPolling(state);
                    sessions.set(result.sessionId, state);
                    ctx.emit('interactive-shell/session-started', {
                        sessionId: result.sessionId,
                        mode,
                        command: a.command,
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
                    if (snap === undefined)
                        return { text: `session ${a.sessionId} not found`, exited: false };
                    const tail = truncateTail(term.read(exec.agent, TerminalSessionId(a.sessionId)).text, config.outputTailBytes);
                    const exited = snap.status.kind === 'exited';
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
                    return { sessionId: a.sessionId, text: 'terminated', exited: true };
                }
                case 'attach-monitor': {
                    if (a.sessionId === undefined || a.trigger === undefined) {
                        throw new Error('interactive_shell attach-monitor requires sessionId and trigger');
                    }
                    const state = sessions.get(a.sessionId);
                    if (state === undefined)
                        throw new Error(`interactive-shell: session ${a.sessionId} not owned`);
                    if (state.monitoring)
                        return { sessionId: a.sessionId, text: 'already monitoring', exited: false };
                    state.monitoring = true;
                    state.mode = 'monitor';
                    // 关键修复：把 trigger 写回会话状态——poller 从 state 实时读取，
                    // 此前固化在 spawn 时闭包导致 attach-monitor 永不生效（P0 fix）。
                    state.trigger = a.trigger;
                    return { sessionId: a.sessionId, text: `monitoring for /${a.trigger}/`, exited: false };
                }
                default:
                    throw new Error(`interactive_shell: unknown action ${a.action}`);
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
            sessions.clear();
        };
    }, 'interactive-shell.tool');
    // Return the effect disposer so callers (and tests) can stop polling.
    return () => {
        for (const poller of pollers)
            clearInterval(poller);
        pollers.clear();
        sessions.clear();
    };
}
//# sourceMappingURL=index.js.map
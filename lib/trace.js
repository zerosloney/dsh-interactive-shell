/**
 * JSONL 事件台账（TraceSink）：关键生命周期事件与错误追加写入持久化文件，
 * 供运行回溯审计。最小收集原则：只记事件名与结构化摘要，不记录会话输出内容，
 * 自动对写入字段实施敏感凭据脱敏。
 *
 * - 默认路径：`$DSH_HOME`（未设置时 `~/.dsh`）下的
 *   interactive-shell/traces.jsonl（`tracePath` 可配）
 * - 超限轮转：超过 maxBytes 时把当前文件改名为 .1（覆盖旧 .1），继续写新文件
 * - best-effort：写入失败只计数，绝不抛出、绝不影响插件主流程
 *
 * @module dsh-interactive-shell/trace
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { redactSensitiveData } from './security.js';
/** Harness home directory name used when `$DSH_HOME` is unset. */
const DSH_HOME_DIR_NAME = '.dsh';
/** Expand a leading `~` against the OS home directory. */
function expandHomePath(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return join(homedir(), path.slice(2));
    return path;
}
/**
 * Resolve the default ledger path under the harness home.
 *
 * The harness keeps every user artifact under one root (`$DSH_HOME`, else
 * `~/.dsh`), so a plugin must not scatter files into the OS home next to it.
 * `@deepseek-ai/dsh-util-home-paths` is not published to npm, so the same
 * precedence is applied here rather than adding an unresolvable dependency.
 *
 * @param env - environment to read `DSH_HOME` from.
 * @returns absolute path of the default JSONL ledger.
 */
export function defaultTracePath(env = process.env) {
    const override = env.DSH_HOME?.trim();
    const home = override !== undefined && override !== ''
        ? resolve(expandHomePath(override))
        : join(homedir(), DSH_HOME_DIR_NAME);
    return join(home, 'interactive-shell', 'traces.jsonl');
}
/** 默认台账路径（由配置项 tracePath 覆盖；随 `DSH_HOME` 变化）。 */
export const DEFAULT_TRACE_PATH = defaultTracePath();
/** Sanitize detail object recursively to redact any sensitive tokens or passwords. */
function sanitizeDetail(obj) {
    const clean = {};
    for (const [key, val] of Object.entries(obj)) {
        if (typeof val === 'string') {
            clean[key] = redactSensitiveData(val).text;
        }
        else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            clean[key] = sanitizeDetail(val);
        }
        else {
            clean[key] = val;
        }
    }
    return clean;
}
export class TraceSink {
    filePath;
    maxBytes;
    seq = 0;
    writeErrors = 0;
    constructor(filePath, maxBytes) {
        this.filePath = filePath;
        this.maxBytes = maxBytes;
    }
    static create(path, maxBytes = 5 * 1024 * 1024) {
        // Resolved per call so a later `$DSH_HOME` change is honoured.
        return new TraceSink(path === undefined || path === '' ? defaultTracePath() : path, maxBytes);
    }
    /** 台账文件路径（供文档与排查引用）。 */
    get path() {
        return this.filePath;
    }
    /** 写入失败累计次数（0 = 全部成功）。 */
    get failureCount() {
        return this.writeErrors;
    }
    /** 追加一条事件；永不抛出。 */
    record(event, detail = {}) {
        this.seq += 1;
        const cleanDetail = sanitizeDetail(detail);
        const entry = { seq: this.seq, ts: new Date().toISOString(), event, detail: cleanDetail };
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            if (existsSync(this.filePath)) {
                try {
                    if (statSync(this.filePath).size > this.maxBytes) {
                        renameSync(this.filePath, `${this.filePath}.1`);
                    }
                }
                catch {
                    // 轮转失败（如文件被占用）就继续追加，不阻塞主流程。
                }
            }
            appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        }
        catch {
            this.writeErrors += 1;
        }
    }
}
//# sourceMappingURL=trace.js.map
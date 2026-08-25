/**
 * JSONL 事件台账（TraceSink）：关键生命周期事件与错误追加写入持久化文件，
 * 供运行回溯审计。最小收集原则：只记事件名与结构化摘要，不记录会话输出内容。
 *
 * - 默认路径：~/.dsh-interactive-shell/traces.jsonl（`tracePath` 可配）
 * - 超限轮转：超过 maxBytes 时把当前文件改名为 .1（覆盖旧 .1），继续写新文件
 * - best-effort：写入失败只计数，绝不抛出、绝不影响插件主流程
 *
 * @module dsh-interactive-shell/trace
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 默认台账路径（由配置项 tracePath 覆盖）。 */
export const DEFAULT_TRACE_PATH = join(homedir(), '.dsh-interactive-shell', 'traces.jsonl')

/** 一条台账记录（JSON 安全，整行写入）。 */
export interface TraceEntry {
  seq: number
  ts: string
  event: string
  detail: Record<string, unknown>
}

export class TraceSink {
  private seq = 0
  private writeErrors = 0

  private constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
  ) {}

  static create(path: string | undefined, maxBytes: number = 5 * 1024 * 1024): TraceSink {
    return new TraceSink(path === undefined || path === '' ? DEFAULT_TRACE_PATH : path, maxBytes)
  }

  /** 台账文件路径（供文档与排查引用）。 */
  get path(): string {
    return this.filePath
  }

  /** 写入失败累计次数（0 = 全部成功）。 */
  get failureCount(): number {
    return this.writeErrors
  }

  /** 追加一条事件；永不抛出。 */
  record(event: string, detail: Record<string, unknown> = {}): void {
    this.seq += 1
    const entry: TraceEntry = { seq: this.seq, ts: new Date().toISOString(), event, detail }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath)) {
        try {
          if (statSync(this.filePath).size > this.maxBytes) {
            renameSync(this.filePath, `${this.filePath}.1`)
          }
        } catch {
          // 轮转失败（如文件被占用）就继续追加，不阻塞主流程。
        }
      }
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      this.writeErrors += 1
    }
  }
}
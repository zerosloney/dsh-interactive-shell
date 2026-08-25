/** 默认台账路径（由配置项 tracePath 覆盖）。 */
export declare const DEFAULT_TRACE_PATH: string;
/** 一条台账记录（JSON 安全，整行写入）。 */
export interface TraceEntry {
    seq: number;
    ts: string;
    event: string;
    detail: Record<string, unknown>;
}
export declare class TraceSink {
    private readonly filePath;
    private readonly maxBytes;
    private seq;
    private writeErrors;
    private constructor();
    static create(path: string | undefined, maxBytes?: number): TraceSink;
    /** 台账文件路径（供文档与排查引用）。 */
    get path(): string;
    /** 写入失败累计次数（0 = 全部成功）。 */
    get failureCount(): number;
    /** 追加一条事件；永不抛出。 */
    record(event: string, detail?: Record<string, unknown>): void;
}

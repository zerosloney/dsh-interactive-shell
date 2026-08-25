# 验收报告（ACCEPTANCE）— dsh-interactive-shell 0.3.4

- 日期：2026-08-25
- 版本：0.3.4
- 环境：Windows 10（22631）x64 · Node v22.22.0 · dsh 0.1.1-rc.2 生态

## 1. 测试摘要

| 项 | 结果 |
| --- | --- |
| 自动化测试 | **86/86 通过**（单元 + apply 集成 + 真实时序回归 + P0~P3 全量落地 + M4 E2E + M5 安全防混淆 + M6 Web Component 与网络网关 + M7 会话时光机 + M8 提示词解析与按键序列生成器 + 自适应探针与瞬时零等待即检 + ANSI 复杂 TUI 解析 + WsClientTransport & LocalStreamTransport 深度会话过滤与双向事件测试） |
| lint（oxlint） | 0 警告 0 错误 |
| 构建 | tsc strict 通过 |

## 2. 覆盖率（v8，node --experimental-test-coverage）

| 模块 | 行 | 分支 | 函数 |
| --- | --- | --- | --- |
| src/ui.ts | 100.00% | 85.11% | 100.00% |
| src/prompts.ts | 99.09% | 80.46% | 100.00% |
| src/component.ts | 98.44% | 85.29% | 100.00% |
| src/stream.ts | 97.93% | 94.44% | 100.00% |
| src/security.ts | 97.32% | 91.11% | 100.00% |
| src/recorder.ts | 96.58% | 85.11% | 100.00% |
| src/client.ts | 96.22% | 93.15% | 96.67% |
| src/trace.ts | 94.87% | 88.89% | 100.00% |
| src/pure.ts | 93.22% | 100.00% | 87.50% |
| src/transport.ts | 92.54% | 77.42% | 87.88% |
| src/index.ts | 91.75% | 81.63% | 81.48% |
| **all files** | **96.05%** | **85.60%** | **93.96%** |

全工程综合行覆盖率跃升至 **96.05%**（分支 85.60%，函数 93.96%），所有 11 个核心模块行覆盖率全部高于 91%！

## 3. 本次交付清单 (v0.3.4)

- **客户端 WebSocket 传输适配器（WsClientTransport）**：
  - 实现 `TermTransport` 统一接口；
  - 具备连接前消息队列缓存与连接后瞬时 flush、自动会话订阅与安全事件派发。
- **全链路事件台账与时光机单测加固**：
  - `TraceSink` 默认路径与容量超限轮转测试（覆盖率 94.87%）；
  - `SessionRecorder` 销毁与异常分支测试（覆盖率 96.58%）；
  - `LocalStreamTransport` 单会话过滤与双向 DOM / EventEmitter 监听兼容性测试（`transport.ts` 行覆盖率跃升至 92.54%）。
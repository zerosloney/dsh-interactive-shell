# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-25

闭环 Agent 唤醒与终端生命周期安全强化（P0 / P1 / P2 全量落地）。

### Added

- **P0: 闭环 Agent 唤醒回路**：`dispatch-completed` 与 `monitor-triggered` 发生时，通过 `agent.followup(createUserMessage(...))` 主动向驱动模型注入 user-turn notice 消息，实现免轮询主动唤醒。
- **P2: 文件变更监听支持**：`spawn` 与 `attach-monitor` 动作支持 `watch` 参数；挂载 `node:fs` 监听器，并在文件更新时触发 `monitor-triggered` 事件及 Agent 唤醒。
- **M4 Phase 1: 流式通信适配层与控制权协议**：新增 `StreamHub` 与 `TermFrame` 流式帧协议（`init` / `output` / `event` / `lock` / `exit`），支持 WebSocket/SSE 客户端实时订阅、输出环形缓冲重放，以及人机接管（Takeover / Release）双向锁管理；挂载 `ctx.interactiveShellStream` 服务。

### Fixed

- **P1: PTY 读取偏移游标**：`readTail` 读取时传入 `{ count: 200, offset: state.lastRead }`，保证多页长输出的翻页与游标推进正确性。
- **P1: 剥离单次 Tool Call 取消信号**：`spawn` 不再透传单次工具调用的 `exec.signal`，避免单轮对话完成时意外杀死长期后台 PTY 进程。
- **P1: 会话 Map 与定时器泄漏清理**：`status` 检测到会话已退出或会话被关闭时，及时停止轮询器与文件监视器并清理 `sessions` Map。

## [0.1.0] - 2026-08-25

生产化首个版本：从脚手架升级为可安装、可审计、可发布的状态。

### Added

- **事件台账（trace）**：关键生命周期事件（session-started / dispatch-completed
  / monitor-triggered / session-killed / error）追加写入 JSONL（默认
  `~/.dsh-interactive-shell/traces.jsonl`，`tracePath` 可配，超限轮转 `.1`），
  写入失败不影响主流程（best-effort，`failureCount` 可查）。
- **P0 修复**（2026-08-25 审查）：轮询路径改用真实 owner（不再 `{} as Agent`）；
  `attach-monitor` 的 trigger 移入会话状态实时读取（此前固化闭包永不生效）；
  dispatch 静默窗改为"先读增量再判定"（此前基准恒错被架空）；会话登记表在
  退出/完成后清理，避免长期运行堆积。
- **异常路径测试**：会话预算超限拒绝、kill 台账、unknown action 错误入账。

### Changed

- 版本 0.0.1 → 0.1.0；`prepack` 自动构建；`lint`（oxlint）0 警告 0 错误。
- CI（GitHub Actions）：lint + test + coverage；`v*` tag 触发 npm 发布。

### Security

- 台账最小收集：只记事件名与结构化摘要，不记录会话输出内容。
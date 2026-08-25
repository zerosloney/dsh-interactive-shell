# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
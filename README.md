# dsh-interactive-shell

让 agent 亲手驱动交互式 CLI（vim / psql / ssh / `npm run dev` / `docker logs -f`），用户实时观看、随时接管。移植自 [pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell)（Pi 生态 562★），落在 DeepSeek Harness 的 `ctx.terminals` PTY seam 上。

**状态：脚手架。** 本仓库当前只有 seam 接线与配置面；按 §里程碑 实施。

## 为什么做

- 传统 bash 工具是一锤子买卖：执行 → 等结束 → 拿输出。需要持续输入或不自己退出的程序（编辑器、REPL、dev server）它搞不定。
- 长任务靠轮询看护是反模式：每次轮询都是一轮模型请求。Monitor 模式用触发器把"轮询"变成"事件唤醒"，省 token 也省延迟。
- DSH 侧查重（DSH Get，2026-08-24 快照）：`interactive terminal` 命中 5 个全是 TUI 聊天外壳，`pty monitor` 0 命中——空白。

## 设计

骑在宿主 `ctx.terminals` seam 上（base bundle 的 `terminal-bash` 行提供 PTY 后端：就绪检测、sandbox 组合、有界回滚——这些不重写），本插件只做产品层：

| 模式 | agent 等吗 | 输出怎么到 agent | 场景 |
|---|---|---|---|
| interactive | 不等 | 稳定 `sessionId`，随时发输入、查状态 | vim / psql / SSH，人可接管 |
| hands-free | 不等 | 轮询 + 静默窗推送 | dev server、长构建 |
| dispatch | 不等 | 仅完成时唤醒一次（带输出尾） | 派发子任务 |
| monitor | 不等 | 仅触发条件命中时唤醒 | 盯日志/文件/测试状态 |

关键取舍：

- **单工具 + `action` 分发**：一个 `interactive_shell` 工具（`action`: spawn / send / status / kill / attach-monitor…），不是每个动词一个工具。依据：Pi-vs-DSH 基准测显示 DSH 每请求 19 个工具 schema 对本地小模型是实打实的 token 税。
- **model-visible ⟺ logged**：唤醒时送给模型的输出尾属于模型可见输入，实施 M1 时必须走 session 事件；插件自己的 Events（`interactive-shell/*`）仅供 UI/遥测。
- **用户接管在 Web UI**（M4）：`dsh` 是 web-first，可观察 overlay 与接管入口做成 Web 面板，浏览器半包单独发布（参考 `ui-*` 客户端插件形态）。

## 配置

见 [cordis.patch.yml](cordis.patch.yml)，字段与默认值与 `src/index.ts` 的 `Config` 一一对应。

## 里程碑

- **M1 dispatch**：spawn + 静默/退出/超时检测 + 单次唤醒（带尾）。验收：agent 派发 `npm test`，自己继续干别的，结束才收到一次通知。
- **M2 monitor**：流触发器（正则）、poll-diff、文件监听、冷却与事件预算。验收：盯日志等 `ERROR`，期间零模型请求。
- **M3 工具注册**：单 dispatch 工具 + 全模式接线 + 沙箱策略遵循。
- **M4 Web UI**：live 输出面板 + 用户接管/交还。

每步先 `npm run typecheck`，行为验收走真实 `dsh --patch` 会话。

## 参考

- 上游：[nicobailon/pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell)（zigpty、四模式设计）
- DSH 侧底座：`@deepseek-ai/dsh-terminal`、`terminal-bash`（见 deepseek-harness `packages/terminal/`）
- 查重记录：DSH Get 2026-08-24 快照；相关工作 [BrowserSkill](https://github.com/Tencent/BrowserSkill)（浏览器接管形态验证）

# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **P0：PTY 缝隙改为按 agent 解析（dsh 0.1.7 兼容）**。0.1.7 起
  `@deepseek-ai/dsh-terminal` + `terminal-bash` 由 agent preset 挂载在
  `isolate` 隔离域内，host 平面的 `ctx.get('terminals')` 恒为 `undefined`，
  原实现因此**静默不注册工具**。新增 `src/seam.ts`：按
  `ctx.agentPresets.serviceFor(agent, 'terminals')` → `ctx.get('terminals')`
  的顺序逐调用解析；每个会话绑定 spawn 时解析到的实例；两者皆无时工具调用
  抛出可操作的安装指引（`PTY_UNAVAILABLE_MESSAGE`），并在组合缺失 PTY 时
  启动告警。工具始终注册（可用性只能在调用点判定）。
- **P0：输出增量游标修正**。`ctx.terminals.read()` 的 `offset` 是「距最新行
  的回退偏移」，原实现把 `lineEnd` 当前进游标复用，导致 monitor 触发与
  dispatch 静默窗读到的是**陈旧/重复的旧输出**（实测：新增 `error:` 行永不
  命中）。改为基于 `totalLines` 的差分交付，覆盖三类情形：新增整行、
  同行原地改写（进度条/spinner）、有界 scrollback 裁剪后的重新对齐；
  `attach-monitor` 保留零等待**快照**探针以维持「挂载即检」语义，随后
  重同步游标。触发匹配改用未截断的原始增量（截断只作用于模型可见尾部）。
- **P0：唤醒消息源类型**。dsh 0.1.7 退役了通配的 `source.kind: 'plugin'`
  （session format v4 显式拒绝该值），改用本插件自己的
  `declare module '@deepseek-ai/dsh-llm'` 声明 `'interactive-shell'` kind，
  并按 harness 约定用 `boundContextSummary` 将 notice summary 截断到 120 字符。
- **测试假体对齐真实契约**：`apply/e2e` 的 terminals 双端改为「可追加的
  scrollback + 最新相对偏移分页」的忠实实现（原先整缓冲 + 前进游标恰好
  掩盖了上述游标缺陷）；新增 `test/p0-regression.test.mjs`（7 例）覆盖
  seam 解析、增量不重不漏、行内改写、scrollback 裁剪与消息源类型。
- **P1：工具注册改为 `defineTool`**：模型参数按 schema 校验（`action`/`mode`
  枚举、`timeoutMs` 整数、输出必含 `text`），每个参数补齐模型可见的
  `description`；未知 action / 非法 mode 现在由 schema 直接拒绝
  （`invalid arguments`），不再落到执行期。
- **P1：spawn 不再占用 PTY 显示名**：PTY 的 owner 内名字必须唯一，把整条命令
  当 `name` 会让「同命令并行跑多个会话」触发 `DUPLICATE_NAME`；改为不传
  `name`，命令文本仍由台账与 `interactive-shell/session-started` 事件承载。
- **P1：PTY 后端类型可配**：新增 `Config.backendType`（默认 `shell`，对应
  `terminal-bash.backendType`），不再硬编码。
- **P1：会话预算只计本插件的存活会话**：此前用 `term.list(agent)` 统计，会把
  其他工具（`tool-bash-persistent` / `tool-terminal`）持有的 PTY 也算进
  `maxSessions` 而误拒；现按本插件登记的 session id 且状态为 running 计数，
  并在 kill / 会话消失时回收。
- **P1：`timeoutMs` 真正生效**：工具参数里的 dispatch 绝对 deadline 已接线
  （`SessionState.timeoutMs`，越界报出可操作错误），此前该参数是死字段。
- **P2：台账默认路径迁入 harness home**：`tracePath` 留空时写
  `$DSH_HOME`（未设置则 `~/.dsh`）下的 `interactive-shell/traces.jsonl`，
  而不再是散落在 OS home 的 `~/.dsh-interactive-shell/`（`@deepseek-ai/dsh-util-home-paths`
  未发布到 npm，故在插件内按同等优先级解析 `$DSH_HOME`）。
- **P2：`StreamCircuitBreaker` 接入广播路径**：新增
  `Config.maxOutputBytesPerSec`（默认 512 KB/s）。超限窗口内不再向
  `StreamHub` 广播 `term:output` 帧，仅在首次触发时广播
  `term:event` 的 `output-throttled`（并落台账），Web 端可用 `read` 重取；
  模型侧的 `read`/`status` 不受该限流影响。

### Changed

- **最低 dsh 版本提升到 `0.1.7-rc.2`**：全部 `@deepseek-ai/*` peer/dev
  依赖从 `^0.1.1-rc.2` 改为 `^0.1.7-rc.2`（semver 预发布规则下
  `^0.1.1-rc.2` 本就**不匹配** 0.1.7-rc.2，正是类型漂移未被发现的原因），
  并新增 `@deepseek-ai/dsh-agent-preset-registry` peer（仅类型依赖，
  用于 `Context.agentPresets` 增强）。
- **无调用 agent 时响亮失败**：`spawn` 等动作不再以 `exec.agent as Agent`
  强转，而是由 `requireAgent` 抛出明确的 owner 作用域错误。
- **发布卫生**：补齐 MIT `LICENSE` 并纳入发布包；`docs/packages/*.tgz` 改为
  本地发布产物（`.gitignore`），不再随仓库入库。
- **恢复 GitHub Actions 发布流水线**（`.github/workflows/publish.yml`，`v*` tag
  推送触发，也可手动 dispatch）：门禁（lint + 单测 + 覆盖率）→ `npm pack`
  → `npm publish --access public`（`NPM_TOKEN` secret）→ 创建 GitHub Release
  并附 tarball；发布前 `npm view <pkg>@<version>` 判重（幂等）并用
  `concurrency` 防止同一 tag 并发发包。`scripts/release.mjs` 相应改为默认
  **不**在本机 `npm publish`（tag 推送后交给 CI），需要纯本机发布时用新增的
  `--publish-locally`（建议配合 `--skip-git`）；`--skip-publish` 保留为兼容
  开关，`--gh-release` 在 tag 已推送时自动跳过。

- **发布流程改为本机执行，保留 GitHub CI**：保留 `.github/workflows/ci.yml`
  （lint + 单测 + 覆盖率门禁仍由 GitHub Actions 执行），删除发布流水线
  `.github/workflows/publish.yml`，新增 `scripts/release.mjs` 本地一键发布
  脚本（`npm run release`）。发布前在本机复跑与 CI 相同的门禁
  （lint + 单测 + 覆盖率），随后递增版本、产出 tarball 至 `docs/packages/`，
  并完成 git 提交、`vX.Y.Z` 注解 tag、推送与 `npm publish`，不再依赖
  `NPM_TOKEN` secret 与 `v*` tag 触发；支持 `--dry-run` / `--skip-publish` /
  `--skip-git` / `--gh-release` 控制各环节。
- **发布源固定与镜像下载并行**：`publishConfig.registry` 固定指向
  `https://registry.npmjs.org/`（`.npmrc` 同步配置 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`
  环境变量凭证），`npm publish` 始终发往官方源，`npm install` 继续走 npmmirror 镜像。

## [0.3.4] - 2026-08-25

客户端 WebSocket 传输适配器（WsClientTransport）与全链路审计台账/会话录制测试加固。

### Added

- **客户端 WebSocket 传输适配器（WsClientTransport）**：
  - 新增 `WsClientTransport` 实现 `TermTransport` 统一接口，支持与服务端 `attachWsServerConnection` / `StreamHub` 跨网络双向互联；
  - 具备连接前消息队列自动缓存、连通后瞬时刷新、自动会话订阅（`sessionId`）及全生命周期销毁回收。
- **全链路事件台账与时光机单测加固**：
  - `TraceSink` 补齐路径默认值、容量超限轮转与写入审计测试，覆盖率提升至 **94.87%（函数 100%）**；
  - `SessionRecorder` 补齐 `clear`、`getSession` 及异常导出分支测试，覆盖率提升至 **96.58%（函数 100%）**；
  - 全工程综合行覆盖率达到 **96.05%**（分支 85.60%），函数覆盖率突破 **93.96%**。

## [0.3.3] - 2026-08-25

智能提示词数字序号菜单（Numbered Menus）与多选按键序列生成器（Multi-select Key Sequence Generator）。

### Added

- **数字序号菜单自动识别与响应（Numbered Select Menus）**：
  - `parseInteractivePrompt` 支持提取 `1) Option A  2) Option B` / `[1] Option A  [2] Option B` 等数字序号选择列表；
  - `generatePromptAnswer` 支持按选项名称（`preferredChoice: 'Staging'`）或选项序号（`preferredChoice: '2'`）直接生成对应序号按键与回车（`'2\n'`）。
- **多选复选框智能按键序列生成（Multi-Select Keystroke Generator）**：
  - `generatePromptAnswer` 支持 `preferredChoices: ['TypeScript', 'Prettier']`，自动计算光标相对位移并生成空格切换（`\x20`）与方向键（`\x1B[B` / `\x1B[A`）组合序列与最终回车。
- **扩展确认与多位置光标解析**：
  - 支持 `(yes/no)`、`(y/n/c)` 等多语言变体确认格式；
  - 完善单选列表上下光标相对导航计算。

## [0.3.2] - 2026-08-25

自适应极速探针（Adaptive Heartbeat）与 ANSI 光标/清屏复杂 TUI 序列解析增强。

### Added

- **自适应极速探针与零等待即检（Adaptive Heartbeat & Zero-Wait Probe）**：
  - `startPolling` 由固定 500ms 改造为自适应调度：活跃输出时以 50ms~100ms 极速快检，平稳期自动平滑退避至 500ms，大幅消除感知延迟；
  - `attach-monitor` 挂载瞬间立即执行第 0 次零等待瞬时探测，已有匹配内容即刻唤醒 Agent。
- **ANSI 光标重定位与复杂 TUI 擦除序列解析**：
  - `VirtualTerminalBuffer` 增加 `\x1B[2J` / `\x1B[3J` 全屏擦除处理（如 `vim`、`htop`、`clear` 场景）；
  - 增加独立回车符 `\r` 覆写解析，精准处理终端进度条（`[==> ]`）与 Spinner 动态刷新，彻底消除文本拼接乱码。

## [0.3.1] - 2026-08-25

安全沙箱混淆/编码绕过深度拦截与 Web Component DOM 交互全量测试补齐。

### Added

- **安全沙箱深度混淆与 Base64 解码拦截**：
  - `evaluateCommandSafety` 增加 `OBFUSCATION_PATTERNS` 模式检测，支持拦截 `base64 -d | sh`、Windows `certutil -decode`、PowerShell `-EncodedCommand`、十六进制 `\x... | sh` 与 Python/Node 内联 base64 执行；
  - 增加递归 Base64 负载反解探针，即使高危指令（如 `rm -rf /`）被 Base64 编码隐藏，也能在运行时被解码识别并置为 `critical` 风险阻断。
- **Web Component DOM 交互全量测试覆盖**：
  - 新增 `test/component.test.mjs`，补齐 `<dsh-shell-dock>` 内部 Shadow DOM 事件委托（Tab 切换、Takeover、Theme 切换、快捷动作派发与属性监听）的完整单测；
  - `src/component.ts` 单测行覆盖率从 **24.22% 提升至 98.44%**，带动全工程综合覆盖率达到 **94.92%**。

## [0.3.0] - 2026-08-25

里程碑 M5 ~ M8 全面落地：生产安全沙箱、Web Component SDK、会话时光机与智能 CLI 交互中枢。

### Added

- **M5: 生产安全沙箱、敏感数据脱敏与熔断保护 (P0)**：
  - 新增 `src/security.ts`，内置安全策略分级（`permissive` / `balanced` / `strict`），自动拦截破坏性高危命令（如 `rm -rf /`、`mkfs`、`dd`、`chmod 777 /`、fork bomb、`format c:`、`del /s /q`、`curl | sh`）；
  - 敏感凭据自动脱敏引擎（`redactSensitiveData`），覆盖 OpenAI/DeepSeek API Key、GitHub Token、AWS Key、Slack Token、JWT 以及各类私钥与敏感密码字段；
  - `StreamCircuitBreaker` 流量熔断器，防止海量恶意/死循环输出打爆缓冲区；
  - Trace 审计台账与输出流全面集成脱敏与拦截。
- **M6: 标准 Web Component SDK 与远程 WebSocket 网关 (P1)**：
  - 新增 `src/component.ts`，基于 Custom Elements v1 和 Shadow DOM 封装原生 `<dsh-shell-dock>` 元素，样式与宿主完全隔离，具备 SSR/Node.js 同构容错，支持双向 DOM 事件与属性观察；
  - 新增 `src/transport.ts`，提供 `LocalStreamTransport` 与 `attachWsServerConnection` 网关适配器，支持跨进程与跨网络（WebSocket/SSE）的低开销双向终端流推送。
- **M7: 会话时光机录制与 Asciinema 兼容导出 (P2)**：
  - 新增 `src/recorder.ts`，提供 `SessionRecorder`；
  - 支持导出标准 Asciinema v2（`.cast`）录像文件，可直接在 Asciinema 播放器中回放；
  - 智能人机协作时间轴分段归因分析（`getTimelineAttribution`），精准量化人类接管与 Agent 执行阶段；
  - 时光机历史回溯（`getTimeTravelSnapshot`），支持按任意历史时间戳重构虚拟屏幕缓冲区状态。
- **M8: 智能 CLI 交互提示词与菜单结构化解析 (P3)**：
  - 新增 `src/prompts.ts`，自动解析终端文本中的交互式提问（确认提示、密码/令牌输入、单选光标菜单、多选复选框、文本输入框）；
  - `generatePromptAnswer` 智能按键生成器，支持一键确认、密码映射与菜单光标上下按键自动计算（避免大模型反复猜键浪费 Token）。

## [0.2.0] - 2026-08-25

里程碑 M4：Web UI 实时流投影、人机双向接管与多会话交互面板全量落地。

### Added

- **M4 Phase 1: 流式通信适配层与控制权协议**：新增 `StreamHub` 与 `TermFrame` 流式帧协议（`init` / `output` / `event` / `lock` / `exit`），支持 WebSocket/SSE 客户端实时订阅、输出环形缓冲重放，以及人机接管（Takeover / Release）双向锁管理；挂载 `ctx.interactiveShellStream` 服务。
- **M4 Phase 2: Web 终端客户端适配器与 ANSI 虚拟缓冲区**：新增 `src/client.ts`（包含 `TermStreamClient`、`VirtualTerminalBuffer`、`stripAnsi` 以及 `TerminalRenderer` 接口），支持无缝对接 Xterm.js 实例渲染，维持状态机快照与历史回放，并支持双向指令/控制权派发。
- **M4 Phase 3: 用户接管直通、锁冲突拦截与交还唤醒**：`StreamHub` 支持 `sendUserInput` 键盘输入直通底层 PTY；在 `user_takeover` 期间拦截 Agent 驱动 `send` 工具调用；用户交还控制权（`releaseLock` / `handback`）时自动携带用户操作备注与尾部输出向 Agent 注入上下文唤醒驱动回路。
- **M4 Phase 4: Web UI 浮层交互面板与快捷动作中枢**：新增 `src/ui.ts`（包含 `DshShellPanelController`、`renderShellPanelCss` 与 `renderShellPanelHtml`），支持多会话 Tab 切换、折叠浮层 Dock、Takeover / Hand Back 切换、快捷键动作（Ctrl+C, Ctrl+D, Enter, Clear, Kill）以及状态徽章响应式渲染。
- **现代化浅色主题与动态切换**：`DshShellPanelController` 支持 `theme` 属性（`'dark' | 'light'`）与 `toggleTheme()`，CSS 全面采用现代高对比 CSS 变量（高雅浅色/深色双配色调色板），Header 自带一键切换按钮（☀️/🌙）。
- **M4 Phase 5: 端到端集成套件与完整文档**：新增 `test/e2e.test.mjs` 覆盖多方协同（Agent + 终端 PTY + 流式中枢 + 客户端 + 浮层面板 + 人机接管）全生命周期用例，完善 README 架构与接入指南。

## [0.1.1] - 2026-08-25

闭环 Agent 唤醒与终端生命周期安全强化（P0 / P1 / P2 全量落地）。

### Added

- **P0: 闭环 Agent 唤醒回路**：`dispatch-completed` 与 `monitor-triggered` 发生时，通过 `agent.followup(createUserMessage(...))` 主动向驱动模型注入 user-turn notice 消息，实现免轮询主动唤醒。
- **P2: 文件变更监听支持**：`spawn` 与 `attach-monitor` 动作支持 `watch` 参数；挂载 `node:fs` 监听器，并在文件更新时触发 `monitor-triggered` 事件及 Agent 唤醒。

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
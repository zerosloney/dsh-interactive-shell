# 开发者文档（DEVELOPMENT）

本插件面向 DeepSeek Harness 生态，开发环境要求：Node.js ≥ 22.19、pnpm/npm。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖（含 devDependencies） |
| `npm run build` | tsc 构建到 `lib/`（发布前自动执行，见 `prepack`） |
| `npm run typecheck` | 类型检查（tsc --noEmit） |
| `npm run lint` | oxlint 静态检查（CI 与发布双门禁，0 警告 0 错误） |
| `npm test` | 构建 + node:test 全量测试 |
| `npm run release` | 本机一键发布：lint → 测试 → 覆盖率 → 打包 → tag → 推送 → npm publish（见"发布流程"） |
| `npm run release:dry-run` | 发布预览：门禁 + 打包清单，不修改任何文件 |
| `node --experimental-test-coverage --test "test/*.test.mjs"` | 覆盖率报告（v8，见下方"覆盖率"一节） |
| `npm pack` | 产出可分发 tarball（含版本号，`docs/packages/`） |

## 覆盖率

```bash
node --experimental-test-coverage --test "test/*.test.mjs"
```

## 架构摘要

- `src/pure.ts` —— 零依赖纯函数（可独立单测，无 harness 运行时）；
- `src/index.ts` —— Cordis 插件装配：`apply(ctx, config)` 注册服务/工具，
  所有 seam 调用（llm / subprocess / terminals / sessions）由插件配置注入；
- `src/trace.ts` —— JSONL 事件台账（best-effort，永不抛错）；
- `cordis.patch.yml` —— bundle 插入清单（配置项与 `Config` schema 一一对应）。

## 发布流程（推送 tag → GitHub Actions 发布）

两条 GitHub Actions 流水线：

| 流水线 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push / PR 到 `master`、`main` | `npm ci` → `oxlint` → `npm test` → 覆盖率 |
| `.github/workflows/publish.yml` | 推送 `v*` tag（也可手动 `workflow_dispatch`） | `npm ci` → lint + 单测 + 覆盖率门禁 → `npm pack` → **npm publish** → **GitHub Release**（附 tarball） |

仓库需配置一个 secret：**`NPM_TOKEN`**（发布凭证，写入官方 registry）。发布源
固定为官方 registry（`package.json` 的 `publishConfig.registry` →
`https://registry.npmjs.org/`），`npm install` 仍可走本机 `.npmrc` 的镜像。
`publish.yml` 发布前先 `npm view <pkg>@<version>` 判重，版本已存在则跳过（幂等），
并用 `concurrency` 阻止同一 tag 并发发两次。

本机脚本 `scripts/release.mjs` 只负责**门禁 + 版本递增 + 打包 + 提交/tag/推送**；
tag 一推送，npm 发布与 GitHub Release 交由 CI 完成（避免本机与 CI 抢同一版本）：

```bash
npm run release              # 默认 patch 递增（0.3.5 → 0.3.6）并推送 tag
npm run release -- minor     # minor 递增（0.3.5 → 0.4.0）
node scripts/release.mjs 0.4.0   # 直接指定目标版本
npm run release:dry-run      # 预览：门禁 + 打包清单，不改动任何文件
```

`scripts/release.mjs` 按序执行：

1. **门禁**：复跑与 GitHub CI 相同的 `npm run lint` → `npm test`（构建 + node:test 全量）→ 覆盖率报告；
2. **工作区洁净检查**：要求工作区干净，避免把无关改动卷进发布提交；
3. **版本递增**：按参数将 `package.json` 与 `package-lock.json` 版本号递增（semver）；
4. **打包**：`npm pack` 产出 `docs/packages/dsh-interactive-shell-<version>.tgz`
   （`prepack` 自动构建；该目录已 gitignore，CI 会自行打包作为 Release 附件）；
5. **git 发布**：提交、打注解 tag `vX.Y.Z`、推送分支与 tag → 触发 `publish.yml`；
6. **（可选）本机 npm 发布 / GitHub Release**：见下表。

| 开关 | 说明 |
| --- | --- |
| `--dry-run` | 只跑门禁与 `npm pack --dry-run` 清单预览，不修改任何文件 |
| `--publish-locally` | 本机执行 `npm publish`（默认交给 CI；建议同时 `--skip-git`） |
| `--skip-publish` | 历史开关，保留兼容：行为与默认一致（由 CI 发布） |
| `--skip-git` | 跳过 git 提交/tag/推送（版本号与 tag 自行处理） |
| `--gh-release` | 未推送 tag 时用 `gh` CLI 创建 GitHub Release（tag 已推送时由 CI 负责，自动跳过） |

本机直接发布（不经 CI）时的认证二选一：设置环境变量 `NPM_TOKEN`
（本机 `.npmrc` 已配置 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`），
或执行 `npm login --registry https://registry.npmjs.org/`。

## 已知约束

- 本插件不包含 PTY/调试器等外部后端，依赖宿主提供的 seam（terminals / subprocess / llm / sessions）。**dsh 0.1.7-rc.2 起 PTY 家族由 agent preset 挂载在 `isolate` 隔离域内**（默认 `standard` preset 不含 PTY），插件按调用方 agent 解析注册表；所选 preset 必须挂载 `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash`（如自带的 `minimal` preset），否则 `interactive_shell` 调用会抛出安装指引；
- 台账遵循最小收集原则：只记事件名与结构化摘要，不记录输出内容。
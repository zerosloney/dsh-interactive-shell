# 开发者文档（DEVELOPMENT）

本插件面向 DeepSeek Harness 生态，开发环境要求：Node.js ≥ 22.19、pnpm/npm。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖（含 devDependencies） |
| `npm run build` | tsc 构建到 `lib/`（发布前自动执行，见 `prepack`） |
| `npm run typecheck` | 类型检查（tsc --noEmit） |
| `npm run lint` | oxlint 静态检查（CI 门禁，0 警告 0 错误） |
| `npm test` | 构建 + node:test 全量测试 |
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

## 发布流程

1. `CHANGELOG.md` 记录变更；`package.json` 版本号递增（semver）；
2. 打 tag 推送：`git tag v0.1.0 && git push origin v0.1.0`；
3. GitHub Actions `publish.yml` 监听 `v*` tag：lint + test 通过后 `npm publish`
   （需仓库配置 `NPM_TOKEN` secret，environment: npm）。

## 已知约束

- 本插件不包含 PTY/调试器等外部后端，依赖 harness 基础 bundle 提供的
  seam（terminals / subprocess / llm / sessions）；
- 台账遵循最小收集原则：只记事件名与结构化摘要，不记录输出内容。
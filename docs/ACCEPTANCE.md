# 验收报告（ACCEPTANCE）— dsh-interactive-shell 0.1.1

- 日期：2026-08-25
- 版本：0.1.1
- 环境：Windows 10（22631）x64 · Node v22.22.0 · dsh 0.1.1-rc.2 生态

## 1. 测试摘要

| 项 | 结果 |
| --- | --- |
| 自动化测试 | **49/49 通过**（单元 + apply 集成 + 真实时序回归 + P0/P1/P2 闭环 + M4 Phase 1/Phase 2/Phase 3/Phase 4 全量套件） |
| lint（oxlint） | 0 警告 0 错误 |
| 构建 | tsc strict 通过 |

## 2. 覆盖率（v8，node --experimental-test-coverage）

| 模块 | 行 | 分支 | 函数 |
| --- | --- | --- | --- |
| src/client.ts | 95.54% | 87.50% | 96.67% |
| src/index.ts | 87.80% | 68.75% | 80.77% |
| src/pure.ts | 93.22% | 100% | 87.50% |
| src/stream.ts | 96.79% | 91.67% | 100% |
| src/trace.ts | 83.05% | 72.73% | 66.67% |
| src/ui.ts | 99.21% | 74.70% | 100% |
| **all files** | **93.32%** | **78.74%** | **91.67%** |

行覆盖 93.32% ≥ 80% 门槛；关键分支（预算守卫、静默窗时序、attach-monitor 触发、错误入账、M4 流式广播与锁状态、Web UI 状态机）均有专项测试。

## 3. 安装验证（干净环境从零安装）

1. 新建临时 `DSH_HOME` + `smoke` profile；
2. `dsh plugin --profile smoke add dsh-interactive-shell-0.1.1.tgz` → 依赖解析完成；
3. `dsh --profile smoke --dump-config` → `id: interactive-shell` 已插入组合树；
4. 无 `terminals` seam 的 headless 场景：插件优雅降级（不注册工具，日志提示），不阻断 composition。

## 4. 性能基线（3 次采样中位数）

| 指标 | 值 |
| --- | --- |
| 模块加载耗时 | 21.39 ms |
| 进程 RSS | 51.0 MB（含 Node 基线） |
| 轮询间隔 | 500 ms/tick（本地，不产生模型请求） |

## 5. 兼容性矩阵

| 平台 | Node | 结果 |
| --- | --- | --- |
| Windows 10 x64 | 22.22 | ✅ 实测（构建/测试/安装/时序） |
| Linux (ubuntu-latest) | 22.x | ⏳ CI 已配置（`.github/workflows/ci.yml`），待 tag push 首跑 |
| macOS | ≥22.19 | ⏳ 未测（声明支持，见 README engines） |

## 6. 已知问题与上线建议

- **遗留**：M4 Web UI 面板（live 输出 + 用户接管）未实施——当前模型通过工具调用的文本视图驱动；不影响核心链路。
- **tab 未激活的 monitor 效率**：monitor 模式为 500ms 本地轮询（不耗模型 token），与 README"事件驱动"表述存在差距，后续可换 seam 触发器。
- **建议**：tag `v0.1.1` 触发 publish workflow（需仓库 `NPM_TOKEN` secret）；上线后以台账 `~/.dsh-interactive-shell/traces.jsonl` 观察错误密度。

## 7. 分发包校验

- 文件：`docs/packages/dsh-interactive-shell-0.1.1.tgz`（33224 bytes）
- SHA256：`2F78AE9AEB3979E2B0695B65497B5250C9DDECF3279E748FC9BDCA00425518FE`
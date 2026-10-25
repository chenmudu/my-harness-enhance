# my-harness-enhance

> 英文版本见 [README.md](README.md)。

**一个面向长周期任务的、跨 harness 的控制面（control plane）。**

**主指标是注意力密度**：进入 conductor context 的内容里，
当前决策真正需要的那个比例。
context 增长速度是预算，
token 成本是经济约束，不是目标；见 [docs/metrics.md](docs/metrics.md)。

宿主 harness 仍然负责运行 agent：模型循环、工具运行时、会话、
压缩、权限和子 agent 都保持原生。这一层位于它们之上，
决定 conductor 看到什么、派发什么、什么算完成、度量什么；
它不拥有模型循环，也不拥有工具运行时。

它让主会话保持唯一的 conductor：主模型只判断、路由、验收、
综合；调研、执行、验证、起草交给隔离的原生 worker。
持久状态放在 workspace 之外，
共享 brief + 确定性检查替代
“先全部执行，再做一次 LLM 全量审计”的昂贵循环。

它不是 harness 替代品，不是多 agent 框架，
也不是第二套运行时。目标是让长周期任务
比单会话全包更快、更可靠。

## 它不是什么

- 不是新的 agent 框架，也不是 agent 社会。
- 不是运行时：模型循环、工具执行、会话存储、压缩和权限都归宿主。
- 不是 Qoder 专用工具：Qoder 是第一个验证通过的 adapter；ZCode 是第二个；Codex、DSH 及其他常用 agent harness 是 adapter 目标。
- 不是目标仓库模板：状态和个人 agent 永不写入正在工作的项目仓库。

## 边界

| 宿主 harness 负责 | mhe 负责 |
|---|---|
| 模型循环、工具运行时、会话、压缩、权限、子 agent | 策略、envelope 契约、capsule/状态、确定性检查、度量、adapter 映射 |

## 核心模型

- **一个 conductor**：唯一决策者；worker 隔离、无状态、不协商。
- **fan-out 前先有 brief**：术语表、格式、输入 hash、ownership、检查项共享给每个 worker。
- **验收前先检查**：结构、数字、hash、scope、测试检查由代码完成；全量语义审计只在失败或歧义时触发。
- **状态在 workspace 之外**：持久状态在 `~/.my-harness-enhance/`；个人 agent 在 repo/用户级 overlay，安装到用户级 harness 配置。

## Adapter

- **Qoder**：第一个验证通过的 adapter（hooks、MCP、原生 subagent）。
- **ZCode**：第二个 adapter；原生 subagent、hooks、MCP、conductor 注入。支持项目级和全局模式；`reason` 使用内置 `Explore` 的只读兼容模式（ZCode 没有 no-tools agent）；派发时必须内嵌 worker contract，并用 synthetic job 补偿缺失的 SubagentStop。原生没有 result rewrite。
- **Codex、DSH 及其他常用 agent harness**：adapter 目标。核心 contract、brief、检查和状态与 harness 无关。
- Adapter 契约与能力矩阵：[docs/adapters.md](docs/adapters.md)。Qoder 专属细节在 [docs/qoder-adapter.md](docs/qoder-adapter.md)；它描述第一个 adapter，不是仓库边界。

## 状态

- **327/327 测试通过（Windows）**；CI 已在 macOS 与 Linux 上跑这套测试，但这两个平台还没有人工跑过。
- Qoder 已在只读、写、验证会话上端到端验证；
  同一 workspace 下的两个并发会话各自持有独立的状态分片。
- ZCode adapter 已实现项目级和全局模式；
  `reason` 使用只读 Explore 兼容模式，worker contract 强制内嵌，
  synthetic job 补偿 SubagentStop。
  原生仍没有 result rewrite/SubagentStop/PreCompact。
- **机制已验证；主指标还没有实现。**
  conductor 每轮仍然收到完整策略和整份 capsule，
  也没有任何东西在采注意力密度或行为信号
  （下一步动作、做错任务、重读、恢复）。
  现有的长周期 A/B 只测 token 增长。
- 待验证：不重启 CLI 的 wall-clock 对比、并发代码集成冲突、
  长周期压缩、Codex/DSH adapter。

## 文档

- [docs/README.md](docs/README.md) — 文档地图与权威顺序。
- [INSTALL.md](INSTALL.md) — Qoder 与 ZCode 安装及回滚 runbook。
- [docs/architecture.md](docs/architecture.md) — 架构与不变量。
- [docs/adapters.md](docs/adapters.md) — adapter 契约与能力矩阵。
- [docs/worktrees.md](docs/worktrees.md) — 代码任务的隔离 git worktree。
- [docs/brief-checks.md](docs/brief-checks.md) — 共享 brief 与确定性检查。
- [docs/retention.md](docs/retention.md) — 保留期限与垃圾回收。
- [overlays/README.md](overlays/README.md) — 个人 agent overlay 与安全安装/卸载。
- [docs/roadmap.md](docs/roadmap.md) — adapter 与控制面路线图。
- 运行记录留在本机 `docs/others/`；它们是证据，不是文档。

## License

MIT

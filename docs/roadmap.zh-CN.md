# 路线图

> 本文是 [roadmap.md](roadmap.md) 的中文译本，如与原文有出入，以原文为准。

## v0.2（当前）

- 核心 contract、用户级状态注册表（state registry）、artifact store、capsule、指标。
- Qoder adapter：复用官方 `general-purpose`/`Explore`；仅当官方缺少
  no-tools 等价物时才安装 `mhe-reasoner`。
- auto conductor：不做 agent/model 选择；已注册项目里的每个主会话
  都是 conductor。
- 用户级状态：`~/.my-harness-enhance/projects/<hash>/`；仓库里没有 `.router`。
- 全局模式：每台机器安装一次；任意 workspace 的新会话
  自动注册；MCP 工具按 `project`/env/cwd 路由；已有会话不会被
  retrofit。
- 202 个测试；demo；基准测试；带 1 个 fallback agent 的 Qoder 安装；Qoder 只读、
  写+验证会话；已安装环境的 hook 模拟。
- 一个 conductor + 原生 worker；worker 都是叶子节点（禁止 Agent/Task），所以
  不存在静默的嵌套扇出。

## v0.3

### Qoder 真实会话加固

- 验证 `SessionStart`、`SubagentStart`、`SubagentStop`、`PostToolUse` 的
  实际 hook 载荷与输出结构（schema）。
- 确认 conductor 的原生主 agent 遵循注入的策略，并实测注入前后真实的
  上下文构成（context composition）。
- 依据真实运行调优 capsule 大小、envelope 上限和仅错误（errors-only）日志。
- 验证 `mhe-reasoner` 的 fallback 契约；旧 `reasoner` 文件
  只保留给旧会话。

### ZCode adapter（已实现；项目级 + 全局）

- hook：SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop；原生没有
  SubagentStop/PreCompact/result rewrite。
- worker：官方 `general-purpose`/`Explore`，如存在则用用户自定义 agent，并为
  no-tools reason 角色提供内置 `mhe-reasoner` fallback。
- 当前补偿：`reason` -> 内置 `Explore` 只读兼容、dispatch 必须内嵌 worker
  contract、synthetic FIFO job 生命周期、Stop/compact-source capsule 注入。
- 剩余：精确的 per-agent job 关联、ZCode 若增加 result rewrite 则接入、
  overlay/skill 安装。

### 能力/运行时

- 基于探测的能力验证（小规模标准化任务），按
  agent/harness 版本缓存。
- 运行时升级：失败或返回非法 envelope 时，尝试该角色的下一个候选。
- 按成本/能力路由；单任务预算和扇出上限。
- 若引入嵌套 worker，需实现并强制执行明确的深度/扇出
  上限；当前 worker 都是叶子节点。

## v0.4

- 跨 harness 的 worker，配统一的 delegate/status/result/send/cancel
  契约；conductor 仍然只在一个 harness 上。
- 可观测性：上下文构成、任务树（job tree）、非法 envelope 率、召回
  命中率、单任务成本。
- 多机器安装 runbook 验证（Windows/macOS/Linux）。

## 非目标

- 搞一个同级协商的多 agent 社会。决策者只有一个。
- 纯提示词约定。能确定的地方就用确定性机制强制执行。
- 在官方/用户 agent 已经够用的时候，再装一套新的 agent 集群。

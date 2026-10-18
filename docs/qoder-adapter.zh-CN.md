# Qoder 适配器（v0.2）

> 本文是 [qoder-adapter.md](qoder-adapter.md) 的中文译本，如与原文有出入，以原文为准。

主要的安装 runbook 是 [INSTALL.md](../INSTALL.md)。本文件给出的是
adapter 级别的细节。

## 路径

| 路径 | 用途 |
|---|---|
| `~/.qoder-cn/` | Qoder CN |
| `~/.qoder/` | Qoder 国际版 |
| `QODER_CONFIG_DIR` | 显式覆盖 |

状态是用户级的：`~/.my-harness-enhance/projects/<hash>/`。项目仓库
里没有 `.router`。

## 安装

全局模式（推荐；每台机器安装一次）：

```bash
node bin/mhe.mjs install qoder --global --dry-run
node bin/mhe.mjs install qoder --global
# restart Qoder once for the MCP server to reload in global mode
# then open ANY workspace and start a NEW session; it auto-registers
node bin/mhe.mjs doctor --root "<any-workspace>"
```

project-scoped 模式仍然可用：

```bash
node bin/mhe.mjs install qoder --root "<project>"
node bin/mhe.mjs capabilities --root "<project>"
```

全局安装：

- 写入 `~/.my-harness-enhance/global.json`，其中 `autoRegister: true`；
- 合并 8 个 hooks 和一个全局的 `harness-enhance` MCP server（不绑定固定项目）；
- 不向任何 workspace 写入；
- 删除遗留的 `hr-*` agent（我们创建的那些），保留官方/用户 agent；
- 保留旧的 `bash-delegate` hook 并发出告警。

在任意 workspace 中**新开**的第一个会话
（`SessionStart` source startup/new/clear）里，hook 会注册该 workspace、解析能力、
创建用户级状态，并注入 conductor 策略。已在跑的会话不会被 retrofit。
MCP 工具从 capsule 中取 `project: <PROJECT>`；若省略，server 会回退到
`MY_HARNESS_ENHANCE_PROJECT` 或它自己的 cwd。它不使用全局 `active.json`，
所以两个打开的 workspace 无法读取彼此的状态。

项目安装还会立即写入该项目的 `config.json` /
`capabilities.json`，并能为能力缺口安装 `mhe-*` fallback agent。

## 能力复用

| 角色 | 优先复用 | 次选 | 仅缺口时安装 |
|---|---|---|---|
| investigate | `Explore` | `general-purpose` | `mhe-investigator` |
| plan | `Explore` | `general-purpose` | `mhe-planner` |
| execute | `general-purpose` | — | `mhe-executor` |
| verify_read | `Explore` | `general-purpose` | `mhe-verifier` |
| verify_run | `general-purpose` | — | `mhe-verifier` |
| write | `general-purpose` | — | `mhe-writer` |
| reason | — | — | `mhe-reasoner` |
| lead | `general-purpose` | — | `mhe-lead` |

工具策略：

- `Explore`：只读；允许原生 Bash 做只读排查；禁止
  Write/Edit/Agent/Task。
- `general-purpose`：官方执行器/lead；文件系统工具全开；作为 worker 时
  禁止 Agent/Task。
- `env-runner`：旧的用户执行器；不再被选中。
- `reasoner`：旧的无工具 agent；保留在磁盘上，但不再被选中。
- `mhe-reasoner`：无工具。
- `mhe-*`：与角色策略一致；所有 worker 都是叶子节点。

运行时升级：当首选 worker 失败或返回非法 envelope 时，conductor 会尝试
该角色的下一个候选。非法的 worker job 会带上 `retryable: true` 和一条
`next` 指令。

## Hooks

| 事件 | 行为 |
|---|---|
| `SessionStart` | auto conductor；写入角色标记；注入策略 + capsule |
| `UserPromptSubmit` | 首个 prompt 成为 goal；注入 capsule |
| `PreToolUse` | conductor 工具白名单；按 agent 类型应用原生 worker 策略；禁止原生 TaskCreate/Get/Update/List |
| `SubagentStart` | 创建 job；注入角色 + envelope 契约；worker 都是叶子节点 |
| `SubagentStop` | 解析/存储 envelope；更新 job；无效结果会加上 retryable + next |
| `PostToolUse` | 规范化 conductor 的 `Agent` 结果；捕获过大的 worker 输出；无效结果会包含原始 artifact handle |
| `PreCompact` | 从状态重建 capsule |
| `Stop` | 写 capsule；code worktree 未 land 时阻止完成 |

未知 agent（不在 `capabilities.agents` 中）保持静默：不注入契约、不设工具
策略、不写日志。已注册项目之外的无关主会话处于休眠状态。

## MCP 工具

Server：`harness-enhance`（stdio）。工具：

`enhance_state`, `enhance_goal`, `enhance_plan`, `enhance_decide`,
`enhance_job`, `enhance_recall`, `enhance_artifact`, `enhance_capabilities`,
`enhance_worker_contract`.

conductor 只看到这些工具；已有的 MCP/connectors 仍然是 worker 的工具。

## 状态

```
~/.my-harness-enhance/projects/<hash>/
  config.json
  capabilities.json
  goal.json
  plan.json
  decisions.jsonl
  jobs.json
  capsule.md
  artifacts/
  logs/            # errors-only by default
  metrics.jsonl
```

`logs/` 默认只记录错误，除非在 `config.json` 中设置了 `logging: "decisions"`。
`capsule.md` 是紧凑的工作状态，不是聊天记录。

## 验证

参见 [INSTALL.md](../INSTALL.md) 第 6 节和 [validation.md](validation.md)。

真实会话检查清单：在该项目里新开会话（不做任何选择）；
conductor 应当只调用 `Agent`/`enhance_*`；worker 应当是上文列出的原生
agent；无效的 worker 结果必须被替换成失败 envelope；
只有在 conductor/worker 活动时才应出现状态文件。

## 回滚

```bash
node bin/mhe.mjs disable --root "<project>"
node bin/mhe.mjs enable --root "<project>"
node bin/mhe.mjs uninstall qoder --root "<project>"
```

`uninstall` 会移除我们的 hooks/MCP/`mhe-*`/`hr-*` agent，保留官方 agent 和用户
自建的 agent，并保留用户级状态以便查看。

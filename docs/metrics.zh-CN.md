# 指标与验证

> 本文是 [metrics.md](metrics.md) 的中文译本，如与原文有出入，以原文为准。

## 主指标

注意力密度——注入的 token 里，当前决策真正需要的那一份——
才是这一层的目标。其余量都是约束或代理，
单独报任何一个都会把目标说窄：

| 量 | 角色 | 状态 |
| --- | --- | --- |
| 注意力密度 | 主指标 | packet 占比已采集；payload 占比待补 |
| `b`（每轮增长） | 预算 | 逐轮以 `context_usage_ratio` × 会话窗口采集 |
| `M_T`（收尾主 context） | 窗口检查 | 仅模拟 |
| `B`（累积输入） | 成本 | 未采集 |
| `C`（实际计费） | 经济 | 每次运行以 `credits` 采集 |

排序是 注意力密度 > context 结构 > 增长速度 > token 成本。
只显示当前任务就能把这个比值做到接近 100%，同时把账本其余部分藏起来；
所以它只有和任务成功率、成本、行为信号一起看才有意义。
账本是完整事实源，注意力包只是 view——view 可以窄，账本不能丢。
不要把模拟的 `M_T` 缩减当标题。

## Token 估算器

`estimateTokens` 不依赖任何第三方库，并且刻意做得粗略：

- CJK 码点：每个 ~0.6 token（按 1.0 会把中文 payload 高估约 1.7 倍）；
- 其他非空白字符：每个 ~0.28 token（约 3.6 chars/token）；
- 空白字符：0。

A/B 对比的两侧要使用同一个估算器。
绝对数值只是近似值，所以只比较同一个估算器产出的数字。

## 模拟场景

`node bin/mhe.mjs bench` 对比的是：

- **baseline**：system + 全量工具 schema + 每一个工具结果 + 主 context 中的每一条
  推理轨迹；
- **conductor**：system + conductor 侧工具 schema + 紧凑 state + 每个 worker 结果对应一个
  envelope。原始工具输出和 worker 的推理都留在主 context
  之外。

本机当前输出：

| 场景 | fixed | artifacts | assembly | conductor 合计 | baseline 合计 | 缩减 |
|---|---:|---:|---:|---:|---:|---:|
| light（3 步） | 5,448 | 1,722 | 0 | 7,170 | 34,122 | 79.0% |
| medium（8 步） | 5,448 | 3,613 | 0 | 9,061 | 92,623 | 90.2% |
| heavy（16 步） | 5,448 | 7,293 | 0 | 12,741 | 244,023 | 94.8% |

`fixed` 是 system 加工具 schema（每个请求都要重新付），`artifacts` 是这一层自己的
state 与 envelope，`assembly` 是 baseline 留在主 context 里的任务内容。
这一层把 assembly 移出去，改为支付一小笔 fixed 与 artifacts 成本。

每个场景的假设：system 8KB、全量工具 75KB、conductor 工具 11KB、
state 3KB，每一步的工具输出与推理取值见 `src/core/metrics.mjs`。
如果你的任务画像不同，请自行修改这些数字。

`node bin/mhe.mjs demo` 走的是真实的 state/contract/artifact 路径：

- 3 个 plan 任务、4 个 envelope、3 项校验器（verifier）检查（2 项通过）；
- worker envelope：估算 ~715 tokens；
- capsule：估算 ~389 tokens；
- 模拟 baseline 54,767 -> conductor 7,457（缩减 86.4%）。

该 demo **不会**调用模型；它证明的是管线接通，不是模型质量。

## Hook 遥测（Qoder v0.2）

hooks 只向 `metrics.jsonl` 追加计数和体积，不记录 prompt、摘要或原始工具输出。
用 `mhe report` 读取；
加 `--json` 输出原始汇总：

| 事件 | 记录字段 |
|---|---|
| `session_start` | model、source、session id、`session`、capsule 字符/tokens |
| `prompt_submitted` | prompt 字符数、goal 字符数、capsule tokens、注入字符/tokens、mode（anchor/delta）、变化段落 |
| `dispatch` / `tool_denied` | tool、allow、gate |
| `job_start` / `job_stop` | agent 类型、job id、status、valid、retryable、错误分类、结果 tokens |
| `agent_result` | valid、status、原始与压缩后 envelope tokens |
| `behavior_label` | 轮次、next-action 命中、做错任务数、重读、失败、恢复（由 `mhe ab` 写入） |
| `now_after_tool` | tool、chars（追加到工具结果的 frontier 提醒） |
| `tool_output_captured` | bytes、mode |
| `compaction` / `session_stop` | trigger、capsule tokens、blocked、未 land 数 |

`mhe report` 汇总 job 数、非法率、envelope 大小、capsule tokens、拒绝数、
捕获字节数以及按 agent 的统计；
它也会打印**未**测量的项。

`mhe report --session <id>` 过滤到单个会话分片并打印解析出的会话；
每个 hook 事件都带 `session`。不带该参数时报告聚合全部条目，
并列出按会话的计数。

### 已采集与未采集

| 量 | 状态 | 来源 |
|---|---|---|
| `M_T`（收尾主 context） | 仅模拟 | `bench`、`demo` |
| `b`（每轮增长） | 逐轮采集 | `mhe ab` 里的 `context_usage_ratio` × 会话窗口 |
| `B`（累积输入） | 未采集 | 需要逐轮 context 记账 |
| `C`（实际计费） | 每次运行采集 | `mhe ab` 里 conductor 与 `subagents/agent-*.jsonl` 的 credits 之和 |
| 构成 | 从 transcript 量出来 | assistant / 工具结果 / worker 结果 |
| envelope / capsule tokens | 已采集 | hook 遥测 |
| 行为标签 | 每次运行采集 | `mhe ab` 写入的 `behavior_label` 行 |
| 注意力密度 | packet 占比已采集；payload 占比另算 | `prompt_submitted` 的 packet/relevant/injected tokens |

`density` = `relevant_tokens / packet_tokens`，
其中 relevant 指除去 PARKED 与 MORE 之外的部分。
它说明 packet 里有多少是关于当前决策的；
它不说明模型是否照此行动，那要靠行为标签。

packet 占比只覆盖每轮的增量注入，而一次请求的 payload 是整段对话。
两个数都要报：`density`（packet 构成）与注入 tokens 除以 `context_tokens`
（payload 占比）。当 CLI 把 provider 的 usage 字段清零时，输入/输出拆分
保持不可得；报告会直说不可得，而不是编一个数。

hook 看不到完整主 context，因此 `agent_result.compact_tokens` 是
“本次进入主 context 的量”的最佳代理；
而构成必须读 CLI transcript。
不要把模拟的 `M_T` 缩减当成增长速率测量。

## 真实会话测量（Qoder）

Qoder 提供了一个 context 用量面板，类别包括 `system_prompt`、
`system_tools`、`skills`、`messages`、`other`、`free_space`、`auto_compact`。
在第 1 步、第 5 步和第 10 步各记录一个快照。

Baseline（不加这一层）：

1. 用普通 agent 跑一个真实的长任务。
2. 每个快照记录总百分比，以及 `messages` /
   `system_tools` 的占比。
3. 统计：工具调用次数、同一文件的重复读取、重复执行的命令、
   goal 复述次数、约束违反次数以及人工干预次数。

实验组（auto conductor）：

1. 用 auto conductor 跑同一个任务。
2. 记录同样的快照。主 `messages` 占比应保持大致持平，
   而不是随原始工具输出增长；如果 conductor 的白名单生效，`system_tools`
   应当下降。
3. 统计 worker 调用次数、envelope 大小、非法 envelope、`needs_split` 以及
   校验器失败次数。
4. 对比任务成功率、墙钟时间（wall-clock）和成本。

预期的形态不是“主 context 一直很小”，而是**主 context 随决策和结果摘要增长，
而不是随执行细节增长**。

## 长时 A/B runner

`mhe ab` 会把同一个多轮脚本任务跑两遍：一遍对着普通的 Qoder 配置
（baseline），一遍对着装了这个 harness 的配置（treatment）。
每次 run 只起一个 CLI 进程，
所有 prompt 以 `stream-json` 的 user 消息写入，
turn 的边界是一个 `result` 事件，
所以 `SessionStart` 每次 run 只触发一次，和真实会话一致。

这个改动之前，runner 每轮新起一个进程。
那会让 `SessionStart` 每轮重触发，把 treatment 一侧抬高：
15 轮的 run 里，conductor 策略加 capsule 进入 transcript 共 29 次
（60.6k tokens），其中 29.1k 是真实会话不付的重启开销。
那些数字高估了注入成本；现在的 runner 不会再产生它们。

要归因“到底什么进了 conductor”，读 CLI 的会话 transcript：
`<config-dir>/projects/<workspace-key>/<session>.jsonl`，
按条目类型累加（`user` 工具结果、`attachment` hook 注入、
`assistant` 文本与思考）。

行为标签从同一份 transcript 算出来，且只覆盖主会话：
transcript 里记录的是 conductor 的工具调用，不含 worker 的。

| 标签 | 定义 |
| --- | --- |
每一轮的口径是「脚本表 + prompt 里点名的路径」：
prompt 改写过只会放宽期望，不会让标签失效。
同一份 transcript 永远得到同样的数字。

| next-action 命中 | 一轮的第一个动作指向 prompt 期望的路径 |
| wrong-task 写入 | 写操作落在该轮期望路径之外 |
| re-read | 同一会话里重复读同一个文件 |
| recovery | 失败轮之后的一轮仍然从期望路径开始 |

```
mhe ab --baseline-config <dir> --treatment-config <dir> --treatment-home <dir> \
  --arm both --turns 15 --repeats 2 --model GLM-5.3-Flash
```

runner 强制遵守的规则：

- 两个 arm 都必须指向隔离的配置目录；正常的 `~/.qoder-cn` 和
  `~/.zcode` 会被拒绝，baseline arm 也不能带有 harness hook；
- treatment 的状态目录是独立的 `MY_HARNESS_ENHANCE_HOME`；
- 模型必须固定写死，`Auto` 会被拒绝；
- 两个 arm 都传入同一个显式 `--context-window`（默认 200,000）；如果两边仍报
  不同窗口，这次 run 标为 `context.valid: false`，比值直接作废，而不只是警告；
- `--repeats` 按中位数 [最小-最大] 报告；少于 3 次运行的结论标为
  冒烟测试，不能用来支撑成本比值；
- credits 是 conductor 会话与每个 `subagents/agent-*.jsonl` 之和；
  缺少 worker 用量的历史 run 标为 `conductor-only`；
- 结果写在仓库之外（默认
  `~/.my-harness-enhance/ab-results/<stamp>`）；
- 返回 `is_error` 的 turn 会把 CLI 自己的错误文本记下来；
  免费模型档有每日用量上限，
  长跑可能以 `error_code` 110 收场而不是结果。

每轮会记录模型返回的 `context_usage_ratio`、CLI 耗时、
fixture 的测试结果，以及 treatment arm 的 hook 计数。
每次运行会写出 `summary.json` 和 `summary.md`，以及每个 run 的原始文件。

每次运行还会在输出目录下留下每个 arm 的 `workspace/`。保留
`summary.json`、`summary.md` 与 `runs/*/result.json`，其余 workspace 删掉；
`npm test` 已改为只用一个可丢弃的临时根目录，不再往真实 `%TEMP%` 里堆。

该比率是最后一次请求的 `input_tokens / max_input_tokens`，裁剪到 0..1，
而 token 明细字段本身被 CLI 置零。分母按会话而非按模型确定：CLI 解析到模型时
为 200,000，回退时为 1,048,576，所以同一份内容在两个 arm 上的读数能差 5 倍。
因此 runner 还会读取会话的 `runtime-config.contextWindow`，
逐轮存下 `context_tokens = ratio × window`。
两个 arm 报告的窗口不同时，`summary.json` 把 `context.comparable` 置为
`false`；某个 arm 完全没报窗口时置为 `null`。
`summary.md` 会声明这些比率只能作相对参考，不能跨 arm 比较。

`--fixture-kind` 选择任务形状：

- `library`（默认）：一个零依赖的小库，每轮新增一个函数，
  配一个测试文件；确定性检查用 `node --test`。
- `review`：15 个 patch，每个新增一个小模块，
  里面恰好埋一个来自固定词表的缺陷；
  答案是规则 id，检查器把它和埋的值比对。
  这项工作需要对整个 hunk 做判断，关键词搜索抄不了近路。
  `--patch-size small|medium|large` 把一个 patch 放大到约 500、2,000、8,000 行。

### 任务形状交叉点（1 次、GLM-5.3-Flash）

三档补丁、各 3 轮：

| patch 行数 | baseline credits（仅 conductor） | treatment credits（仅 conductor） | 比值 | 墙钟（分钟） | baseline 工具 tokens | treatment 工具 + worker |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 491 | 1.80 | 3.11 | 1.73x | 1.0 / 4.5 | 7,881 | 3,050 |
| 1,931 | 3.37 | 4.84 | 1.44x | 1.0 / 6.4 | 31,401 | 3,198 |
| 7,691 | 4.03 | 3.28 | 0.81x | 2.9 / 7.6 | 15,634 | 3,484 |

同一形状、只改轮数（1,931 行）：

| 轮数 | baseline credits（仅 conductor） | treatment credits（仅 conductor） | 比值 | 墙钟（分钟） | baseline 工具 tokens | treatment 工具 + worker |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 3.37 | 4.84 | 1.44x | 1.0 / 6.4 | 31,401 | 3,198 |
| 15 | 23.66 | 19.59 | 0.83x | 6.7 / 21.8 | 98,535 | 13,280 |

机制在内容列里：`Read` 是普通工具，baseline 读到的内容留在 conductor，
之后每一次请求都要重发；这层在 worker 里读，只把结果带回来。
15 轮下来是 98.5k 的累积补丁内容对 13.3k。

credits 同时跟着请求数和上下文走，不是单独跟某一个：
按本轮数据，每请求约有 0.15 的底价，再加每 1k tokens 约 0.003，
所以只砍请求数或只压上下文，都只能拿到一半收益。
15 轮时 treatment 的请求数是 baseline 的 2.4 倍（78 + 47 对 52），
但每请求的上下文更小，所以仍便宜 17%。墙钟反过来，慢 3.3 倍。

两个前提。7,691 行时宿主拒绝超过 25k tokens 的整文件 Read，
两边都退化成 `limit` 读加 Grep，那一行测的是抽样发生在哪里，不是谁读得更多。
另外重读次数不是稳定信号：491 行时 14 次，1,931 行 3 轮时 2 次，
1,931 行 15 轮时 0 次。

### task card 策略（3 次重复，Qwen3.8-Flash）

`review` fixture、1,931 行、3 轮。这一格加入 worker task card、
分段注入预算和 brief/task hash 握手；上面的表属于更早的策略，不能与它混读。

| arm | 最终检查 | 下一步命中 | 主 context（tokens） | credits（含 worker） | 墙钟（分钟） |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 3/3 | 8/9 | 79,829 | 3.84 | 1.3 |
| treatment | 3/3 | 9/9 | 38,043 | 6.68 | 4.4 |

密度保持在 packet 的 0.924（上一策略为 0.918），9 次派工全部带匹配的
`task_id` 和 hash 握手。多出的成本来自 worker 会话本身：每次运行
27–33 个请求里的 12–15 个、5.9–6.9 credits 里的 3.6–4.1 个。
即使把 conductor 开销全去掉，worker 循环仍在，所以 2x 墙钟和
1.25x 计费 credits 两个 gate 仍未过；这是委派结构的属性，
不是 conductor 上下文大小；
缩 conductor 上下文不会改变 worker 循环。

## 验收指标

| 指标 | 证明了什么 | 目标 |
|---|---|---|
| 注意力密度 | conductor 看到的是当前决策需要的 | 逐轮 packet 占比 + payload 占比；每次运行有行为标签 |
| 主 context 增长（`b`） | 执行细节留在主 context 之外 | 同一任务形状下低于 baseline；尚未证明 |
| 工具 schema 占比 | conductor 的工具面很小 | 主 context 的 <25% |
| 非法 envelope 泄漏率 | contract 约束生效 | 主 context 中 0 个原始非法 blob |
| goal 保持 | conductor 守住了 goal | 压缩（compaction）后能正确复述 |
| 决策一致性 | 决策是持久的 | 与 `decisions.jsonl` 无矛盾 |
| 冗余动作率 | worker 不重复干活 | 低于 baseline |
| 压缩保真度 | capsule 保住了关键事实 | compact 之后关键约束仍在 |
| 人工干预 | 自动化是真的 | 不高于 baseline |
| 任务成功 | 这一层解决了问题 | 不低于 baseline |
| 成本/延迟 | 效率 | 在约定的预算之内 |

## 大海捞针测试（Needle test）

在 goal 早期放一条唯一约束（例如“永不修改文件 X”或一段秘密代码），
跑 N 步，再让 conductor 复述它。在多个不同的 context 深度
（窗口的 10%、30%、50%、70%）重复该测试，用来找到模型的
注意力拐点（attention knee）。把压缩阈值设在该拐点之下。

## 什么情况会证伪这套设计

- conductor 不看 evidence 就接受每一个 envelope（橡皮图章）。
- 主 context 仍然随原始工具输出增长（规范化失败）。
- 多数情况下 worker 返回非法 JSON（prompt 与 contract 不匹配）。
- 任务树比需要的更深，延迟/成本随之暴涨。
- 校验器放过了人类评审会驳回的工作。
- 免费 worker 的限流让任务比自己直接动手还慢。

一旦出现上述任何一种情况，先修好这一层或策略，再考虑增加更多
拓扑。

# Harness adapter 契约

> 本文是 [adapters.md](adapters.md) 的中文译本，如与原文有出入，以原文为准。

本仓库是一个与 harness 无关的增强层。adapter 边界
才是让这一说法在代码层面成立的东西，而不只是写在 README 里的
契约。**Qoder 是第一个 adapter 实现，ZCode 是第二个，而两者都不是
目标范围**：这条契约是为 Codex 和任何其他 harness 照着实现而存在的。
adapter 允许声明得比 Qoder 少
—— ZCode adapter 确实如此 —— 但它不允许声明自己
没有做到的东西。

adapter 不运行 agent。
它只把控制面映射到宿主已有的原生机制；
模型循环、工具、会话、压缩和权限仍归宿主。

模块：

| 文件 | 职责 |
|---|---|
| `src/adapters/spec.mjs` | 能力 schema、`defineAdapter()`、`describeAdapter()`。纯契约，零依赖。 |
| `src/adapters/registry.mjs` | 按 id 在内存中 register/get/list/unregister/detect。没有进程侧效应；import 本身什么都不做。 |
| `src/adapters/qoder/adapter.mjs` | Qoder adapter：把已有的 `install.mjs`/`overlay.mjs` 函数包装到契约上。行为没有变化。 |
| `src/adapters/zcode/adapter.mjs` | ZCode adapter：hooks 合并进 `config.json`、共享的 MCP server、以及在 ZCode 原生 Agent subagent 之上施加的 conductor 策略。 |
| `src/adapters/zcode/install.mjs` | ZCode 的 detect/install/uninstall/doctor/refresh：带备份的 config.json 合并、幂等（idempotent）条目、保留用户自有的条目。 |
| `src/adapters/zcode/hook.mjs` | ZCode 的 hook 脚本，用于 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`。所有输出都是 ZCode hook JSON。 |
| `src/core/hook-policy.mjs` | 两个 adapter 共同导入的、与 harness 无关的策略核心：payload 访问器、工具允许/拒绝决策，以及派发闸门。adapter 只保留 payload 形状和各自 harness 的补偿逻辑。 |

测试：`node --test test/adapters.test.mjs test/zcode.test.mjs test/adapter-conformance.test.mjs`.

## 契约的形态

`defineAdapter(spec)` 恰好接受四个字段，并用 `TypeError` 拒绝任何其他
内容：

- `id` —— 小写标识符（`a-z`、数字、点、短横、下划线）。会 trim 并转小写；
  内部空格是错误，不会被静默改写。
- `label` —— 人类可读名称，非空。
- `capabilities` —— 把 `ADAPTER_CAPABILITIES` 中的名字映射到布尔值的
  对象。未知的名字会被拒绝（这就是一个虚假声明变响亮失败的方式）。
  `false` 会被规范化掉：不存在就是不存在。
- `lifecycle` —— 可选对象，其键必须来自
  `LIFECYCLE_STAGES`，其值必须是函数。

结果是冻结的（frozen），并带有 `Symbol.for('my-harness-enhance.adapter')`。
`isAdapter()` 检查这个 brand；注册表（registry）只接受带 brand 的对象，
所以单纯长得像的对象进不了这套系统。

`describeAdapter(adapter)` 返回一个可 JSON 序列化的描述 ——
`{ id, label, capabilities: [names], lifecycle: [stage names] }` —— 里面
没有任何函数。用它来做日志、doctor 输出和文档；永远不要泄漏
闭包。

## 生命周期（lifecycle）阶段及其职责

| 阶段 | 契约 |
|---|---|
| `detect({ env, payload, ... })` | 回答这个 adapter 是否匹配当前的机器/会话。真值 = 匹配（Qoder 返回它解析出的 config dir）。必须开销小且无副作用；不能靠猜测来探测（probe） —— 没有信号，就返回 falsy。 |
| `install(options)` | 把增强层接入 harness（hooks、MCP server、agents、overlays）并产出状态。幂等；在 harness 允许的范围内支持 dry-run。 |
| `uninstall(options)` | 精确移除 `install` 加入的东西；保留用户自有的文件。 |
| `doctor(options)` | 对安装做自检（self-check），并报告 `{ ok, checks[] }`。绝不做任何修改。 |
| `refresh(options)` | 重新探测 harness 能力（可用的 agents、models），并更新持久化的能力 plan，而不改动 harness 设置。 |

## 能力 schema

`ADAPTER_CAPABILITIES` 是 adapter 唯一可以声明的词表（vocabulary）：

| 能力 | 含义 |
|---|---|
| `subagents` | harness 能启动被派发出去的 worker/subagent 运行。 |
| `hooks` | harness 支持生命周期 hooks（会话、prompt、工具、subagent 事件）。 |
| `resultRewrite` | hook 可以在模型看到工具结果之前改写它。 |
| `preCompact` | harness 会触发一个压缩前（pre-compaction）事件，adapter 能对它采取行动。 |
| `mcp` | harness 能运行 MCP server。 |
| `installer` | adapter 能安装/卸载自己的集成并做自检。 |
| `overlay` | adapter 在核心角色之上同步用户级的 agent/内容 overlay。 |
| `sessionMap` | adapter 维护每个会话的角色状态（例如 conductor 的 session map）。 |
| `skills` | harness 支持可复用的 skill 包，adapter 可以安装它们。 |
| `modelSelection` | adapter 能通过某种 harness 机制来选择/引导 conductor 或 worker 的 model。 |
| `statusLine` | harness 暴露一个状态行（status line），adapter 往其中渲染内容。 |
| `crossSession` | 除了共享状态文件之外，adapter 还能跨并发会话做协调。 |

核心层可以依据已声明的能力来分支，
但它必须容忍一个把可选能力全都不声明的 adapter。
schema 没有覆盖的能力保持不可表示，直到某个真实 adapter 需要它们 ——
不放投机性的条目。

## 注册表与探测

`detectAdapter({ env, payload, explicit })` 严格按以下顺序解析：

1. `explicit` 指定的 id（大小写不敏感）。未知的 id 是一个硬错误，
   并会列出已注册的 adapter。
2. `MY_HARNESS_ENHANCE_HARNESS` 环境变量（`HARNESS_ENV_VAR`）。未知的
   值是同一个硬错误。
3. 按 id 顺序调用每个已注册 adapter 的 `detect()`；第一个真值匹配
   胜出。抛异常的 `detect()` 算作不匹配 —— 探测不能把
   路由搞崩。
4. 无匹配：一条清晰的错误，提示你设置环境变量或注册一个 adapter。
   静默的 null 会掩盖配置错误，所以默认是响亮报错。

注册是显式的。`registry.mjs` 只持有一个 `Map` 和若干函数；内置的默认集合
（Qoder 和 ZCode）由 `registerDefaultAdapters()` 接好线，而每一次查询
（`get`/`list`/`detect`）也都会先把它跑一次，作为幂等的惰性 bootstrap。
避免 import 时的魔法：import 注册表从不碰文件系统、环境变量或
harness 配置。
注册表是通用的 —— `registerAdapter()` 接受任何带 brand 的
adapter（见 fake-adapter 测试），所以路由里没有任何关于这两个内置
harness 的硬编码。

## Qoder 状态（第一个实现）

`src/adapters/qoder/adapter.mjs` 诚实声明了：

| 声明了什么 | 现有代码中的证据 |
|---|---|
| `hooks` | `install.mjs` 为 SessionStart、UserPromptSubmit、PreToolUse、SubagentStart、SubagentStop、PostToolUse、PreCompact、Stop 合并 hook 条目。 |
| `subagents` | 由 `core/capabilities.mjs` 解析出的原生 worker 派发。 |
| `resultRewrite` | `hooks/hook.mjs` 的 PostToolUse 会发出 `updatedToolOutput`；frontier 变化时附带 `[NOW]` 提醒。 |
| `preCompact` | `hooks/hook.mjs` 的 `onPreCompact`。 |
| `mcp` | 通过 `mergeMcp` 注册的 stdio server `src/mcp/recall-server.mjs`。 |
| `installer` | 包装过的 `installQoder` / `uninstallQoder` / `doctorQoder`。 |
| `overlay` | `overlay.mjs` 的 sync/uninstall/doctor，在 install/uninstall/doctor 内部运行（结果里包含一份 `overlay` 报告）；对需要它的调用方，通过 `qoderOverlay` 只暴露 overlay 部分。 |
| `sessionMap` | 每会话的 conductor map：`core/store.mjs` 的 `readSessions`/`markSession` 加上 `core/hook-policy.mjs` 的 `sessionIsConductor`。 |

未声明（也没有假装声明）：`skills`、`modelSelection`、`statusLine`、
`crossSession`。

生命周期映射：`detect` 包装了 `detectConfigDir`，但只有在存在真实信号时才
给出答复（`QODER_CONFIG_DIR` 或显式传入的 config dir）；它从不根据众所周知
的主目录去猜。`install` / `uninstall` / `doctor` / `refresh` 只是
`installQoder` / `uninstallQoder` / `doctorQoder` / `refreshCapabilities`
的薄包装。Qoder 的 hook、MCP 或 install 行为一点都没变 —— adapter 是边
界，不是重构。

## ZCode 状态（第二个实现）

`src/adapters/zcode/adapter.mjs` 诚实声明了：

| 声明了什么 | adapter 中的证据 |
|---|---|
| `hooks` | `install.mjs` 把条目合并进 `<configDir>/config.json` 的 `hooks.events` 之下：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop。条目形如 `{ type: 'process', command: <node>, args: [<absolute hook.mjs>, <Event>], timeoutMs }`，并且 `hooks.enabled` 会被打开。 |
| `subagents` | ZCode 原生的 Agent 派发；能力解析使用内置 agent（`general-purpose`、`Explore`）。ZCode 的自定义 agent 由 plugin 提供，并且前面隔着一道手动 UI 步骤，所以它们不属于自动化探测的一部分；`<configDir>/agents` 是运行时 subagent 会话存储，从不被扫描来寻找定义。 |
| `mcp` | stdio server `harness-enhance` 被合并进 `mcp.servers`，指向与 harness 无关的 `src/mcp/recall-server.mjs`，并带上 `MY_HARNESS_ENHANCE_HARNESS=zcode`；项目级（project-scoped）安装还会钉住 `MY_HARNESS_ENHANCE_PROJECT`，全局安装设置 `MY_HARNESS_ENHANCE_GLOBAL=1` 且不钉住任何 workspace。 |
| `installer` | `installZCode` / `uninstallZCode` / `doctorZCode` / `refreshZCode`：config.json 备份、幂等合并、dry-run 什么都不写、遇到损坏的配置直接拒绝而不是覆盖掉，卸载时把 `hooks.enabled` 交还给它在安装前的值。支持项目级和 `--global` 两种模式。config.json 是安装器在 config dir 下写入的唯一文件 —— 永远不写任何 agent 文件。 |
| `sessionMap` | `hook.mjs` 在 `sessions.json` 里标记 conductor 会话（source 为 startup/new/resume/clear 的 SessionStart），并以这张 map 作为强制执行的门禁（gate）。 |

未声明，因为 ZCode 不提供那个机制：

| 缺失 | 原因 |
|---|---|
| `resultRewrite` | ZCode 的 PostToolUse 没有更新工具输出的通道。hook 会存储 artifact、记录 job、写日志 —— 然后什么都不发出。`[NOW]` 提醒因此随下一轮 packet 一起到达。 |
| `preCompact` | 没有 PreCompact 事件。capsule 的存档点发生在 `Stop`；带 `source=compact` 的 `SessionStart` 会重新注入 capsule —— 那是注入，不是压缩 hook，也没有被声明成压缩 hook。 |
| worker 事件 | 没有 SubagentStart/SubagentStop。adapter 不声明它们；它用下文的契约门禁和 synthetic job 生命周期来*补偿*。补偿（compensation）是围绕 ZCode 确实会触发的那些事件所施加的强制行为，不是原生能力。 |
| `overlay`、`skills`、`modelSelection`、`statusLine`、`crossSession` | 什么都没接线：没有个人 overlay 同步、没有 skill 安装器、没有 model 引导、没有状态行、没有跨会话协调。安装器除了 config.json 本身以外，从不在 ZCode 的 config dir 下放任何文件；`reason` 不需要文件，因为它通过下文的只读兼容（read-only compatibility）来解析。 |

### 补偿（变通办法，不是被声明的能力）

ZCode 的五个事件比 Qoder 的八个少，所以有两个行为要绕着它们
重建。两者都留在已声明的能力集合之内：`resultRewrite` 保持
false，SubagentStart/Stop 与 PreCompact
都仍然缺失。

**通过只读兼容实现 reason 角色。** ZCode 没有 no-tools agent，
它也没有可写的自定义 agent 目录：`<configDir>/agents` 是运行时
subagent 会话存储（`sess_…` / `agent_…` 目录），所以一个把
`mhe-reasoner.md` 丢进那里的自动化安装会污染 harness 状态。
自定义 agent 由 plugin 提供，并且前面隔着一道手动 UI 步骤，
这会破坏零 context 的自动化安装 —— 因此在 config dir 的任何
位置都不会安装、扫描或删除 agent 文件。取而代之的是，能力解析
只做一次显式且有标注的替换：当 `reason` 没有专属 agent 时，它
解析到内置的 `Explore`，并在该角色上带上
`compatibility: 'readonly'` 与 `policy: 'readonly'`。于是 plan
读起来就是 `reason -> Explore (read-only compatibility)`。
conductor 派发一个普通的 Explore worker，并指示它只根据任务里
给到的材料推理、不要使用工具；真正约束住它的是 Explore 自己的
只读策略 —— 这是一次兼容性替换，从不被宣传成 no-tools agent。
这个替换在项目安装、refresh、以及全局首次会话的自动注册中都
完全一致（`resolveZcodePlan` 是唯一来源），而 doctor 报告的是
只读兼容这一行，而不是 missing fallback。严格的 no-tools 需要
另行安装一个由 plugin 提供的 agent；如果那件事哪天真的以可脚本
化的机制落地，能力解析可以先优先选用它，再回退到 Explore 这个
替换。

**Subagent 派发生命周期。** 没有 SubagentStart 就没有注入槽位；
没有 SubagentStop 就没有完成事件。hook 在 conductor 的 `Agent`/`Task`
工具调用上做补偿：

- PreToolUse，在白名单（allowlist）和 code 档案（profile）的依赖门禁之后，要求
  worker 契约文本出现在 prompt 或 description 内部 —— 也就是
  `enhance_worker_contract` 的输出，通过它的标记
  `[MY-HARNESS-ENHANCE WORKER CONTRACT]` 来识别。缺失 → 拒绝，并给出
  嵌入它的指令。正是这一点让原始 worker 结果保持有界，因为并不存在
  result rewrite 可以在事后再修正它们。
- 被接受的派发会记录一个 **synthetic** 的 running job（生成的 id、来自
  `subagent_type` 的 worker 类型、角色、prompt 里点名了任务时的 task id、
  session id）。`agent_id` 是刻意留空的：ZCode 没有给 hooks 真实的
  subagent id，假装有别的东西就是错误的关联。
- PostToolUse 完成该 worker 类型和会话中最旧的、匹配上的 running
  job —— **FIFO，尽力而为**。并发的同类型派发只能按派发顺序匹配；
  这种歧义是那个缺失事件本身固有的，从不被掩盖。没有匹配到
  running job 的结果（派发绕过了这一层）仍然会被记录成一个已
  完成的 job，所以不会丢失任何结果。两条路径都一样：解析
  envelope、把原始结果作为 artifact 存储、通过 `task_id` 同步
  plan、把 job 设为 envelope 的状态或者 `invalid_result` +
  `retryable`，并且**不发出任何输出** —— 模型看到的就是原始的
  工具响应。

hook 的输入/输出遵循 ZCode 文档里记载的形态：payload 携带
`hook_event_name` / `session_id` / `cwd` / `model` / `tool_name` /
`tool_input` / `agent_type`；输出永远是合法的 hook JSON ——
SessionStart/UserPromptSubmit 用 `hookSpecificOutput.additionalContext`，
PreToolUse 用 `permissionDecision: deny`，其余情况保持静默。
PreToolUse 的强制执行在策略上与 Qoder 的完全一致：conductor 白名单
（带已注册 subagent 类型的 Agent、AskUserQuestion、`enhance_*` MCP
工具；拒绝 Bash/Read/Write/Edit 之类），Explore 只读，worker 都是叶子
节点（没有嵌套的 Agent/Task）。code 档案的派发依赖门禁与 Qoder 完全
镜像（共享核心，不共享 hook 代码）：当当前 brief 的档案是 `code`
时，conductor 的 `Agent`/`Task` 调用必须在 prompt 或 description
里点名它的 plan 任务（`task_id: T2` / `task_id=T2`） —— id 缺失、
任务不在 plan 里、或者任何 `depends_on` 的任务不是 `completed`
（拒绝提示会列出这些 id 和状态）都会阻断派发；
合法的派发放行，而非 code 的 brief、缺失的 brief、worker 事件和其他
工具都不受影响。

探测只在真实信号上给出答复：`ZCODE_CONFIG_DIR`、显式传入的 config dir
参数，或者已经存在的 `~/.zcode/cli`；探测从不创建或写入任何东西。
Install 会拒绝缺失的 config dir 和损坏的 `config.json`（永不覆盖它）。
两种安装模式：

- **项目级**（默认）：`mhe install zcode --root <workspace>` 会把
  `MY_HARNESS_ENHANCE_PROJECT` 钉进 MCP 条目，并在核心状态里注册这个
  workspace；在其他任何目录里 hook 都完全休眠。
- **全局**：`mhe install zcode --global` 接好用户级的 hooks/MCP，不绑定
  固定项目，并设置 ZCode 标记 `{ zcode: { autoRegister: true,
  configDir, hooksEnabledBefore } }` 在
  `~/.my-harness-enhance/global.json` 之内 —— 这是一个嵌套键，所以
  Qoder 全局安装的顶层键会被保留，而 `uninstall zcode --global` 只把
  `zcode.autoRegister` 翻回去。随后 hook 会在**新开**的 SessionStart
  source（`startup`/`new`/`resume`/`clear`）上，用与 install 相同的核心
  能力解析，自动注册一个尚未注册的 workspace；`source=compact` 只注入
  capsule 而从不注册，PreToolUse 以及所有其他事件都从不 retrofit 一个
  正在运行的会话，而系统目录/主目录通过 `isExcludedProject` 保持被排除。

## Codex（或任何后续）adapter 必须提供什么

最小诚实形态（要看一个提供的事件比 Qoder 更少的 harness 的可用参照，
参见 `src/adapters/zcode/adapter.mjs`）：

```js
export const codexAdapter = defineAdapter({
  id: 'codex',
  label: 'Codex',
  capabilities: { /* only what is truly wired */ },
  lifecycle: {
    detect: ({ env, payload }) => /* match on a real signal */,
    install: (options) => /* wire hooks/servers, write state, idempotent */,
    uninstall: (options) => /* remove exactly what install added */,
    doctor: (options) => /* non-mutating self-check */,
    refresh: (options) => /* re-probe harness capabilities */,
  },
});
registerAdapter(codexAdapter); // or extend registerDefaultAdapters()
```

对于一个想声明这些能力的 harness，逐项能力的期望是：

- `hooks` / `resultRewrite` / `preCompact`：adapter 必须证明 harness
  会触发这些事件并兑现改写输出，然后把它们路由到已有的核心 hook 逻辑。
- `subagents`：一套派发机制，加上能力探测，好让 `refresh` 能产出一个
  角色 plan。
- `mcp`：一种在 harness 设置里注册 MCP server 的方法。
- `installer`：针对那个 harness 的 config 布局做 install/uninstall/
  doctor，并具备和 Qoder 一样的备份、dry-run 与幂等。
- `sessionMap`：把每个会话的角色状态存放在共享的用户级状态根之下，
  好让核心行为能看到它。
- `skills` / `modelSelection` / `statusLine` / `crossSession`：只有在那个
  harness 机制确实存在之后才做；
  要么实现，要么省略，不放占位内容。

在这样一个 adapter 被注册之前，`MY_HARNESS_ENHANCE_HARNESS=codex` 按设计
就是一条清晰的 "Unknown harness" 错误 —— 契约已经就绪，实现还没有，
而仓库不会假装相反。两个内置值（`qoder`、`zcode`）之所以能解析，是因为
它们的 adapter 存在，且各自恰好带着自己那套能力集合：ZCode
声明得比 Qoder 少，是契约在按预期工作，
而不是一个需要遮掩的缺陷。

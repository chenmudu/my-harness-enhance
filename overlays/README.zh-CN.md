# 个人 overlay

> 本文是 [README.md](README.md) 的中文译本，如与原文有出入，以原文为准。

这个目录存放的是你自己 harness 的个人默认配置。它们留在本仓库里以便版本
管理，安装时写入用户级的 Qoder 配置目录。它们从不写入目标工作区或项目
仓库。

## 生效的 overlay 默认为空

`overlays/qoder/agents/` 不附带任何 `.md` agent。生效的个人 overlay 默认为空，
每一个个人 agent 都由你显式添加。

已废弃的遗留产物——例如可能仍留在
`~/.qoder-cn/agents` 里的旧 `env-runner` 和 `reasoner`——
不属于个人默认值。它们不会被复制到此处、不会被安装，
本工具对它们不做处理，也不纳管。

## 两层结构

共有两层，按文件名合并：

1. **仓库 overlay**（`overlays/qoder/agents/*.md`）——你的个人默认值，
   由 git 跟踪。要改变所有机器的默认配置，就在这里编辑。在你添加文件
   之前它是空的。
2. **用户级 overlay**（`~/.my-harness-enhance/overlays/qoder/agents/*.md`）——
   仅本机生效的覆盖。用于只适用于某一台机器、
   且不该提交的微调。

### 优先级

用户级文件在与它同名的仓库文件之上生效。
只存在于仓库里的文件原样使用；
只存在于用户级目录里的文件作为叠加添加。

## 安装目标

sync 会把合并后的结果复制到 `<Qoder configDir>/agents`，其中
`configDir` 是用户级的 Qoder 目录（`~/.qoder-cn` 或 `~/.qoder`，或由
`--config-dir` / `QODER_CONFIG_DIR` 指定的路径）。目标工作区的仓库
不会被触碰——你通过 `--root` 传入的项目目录下
不会写入任何东西。

## 清单与安全

被安装的文件记录在 `~/.my-harness-enhance/overlays/qoder/manifest.json` 中，
以目标 agents 目录为键，记录写入时的 SHA256 以及
`origin`（`installed` | `updated` | `adopted`）。正是这一点让这一层
变得安全：

- **幂等。** 源文件哈希已经与目标一致的，
  保持不动。
- **不覆盖手改。** 如果你手工修改了某个已安装的 agent 文件，
  下一次 sync 会发现目标哈希与记录的哈希不一致，跳过该文件，
  并报告 conflict，而不是覆盖它。
- **不覆盖非本工具管理的文件。** 如果目标已存在且内容不同，
  而它并非本工具安装的，这个差异会被报告为
  conflict，并保持原样。
- **只接管，不删除。** 如果目标已存在，且与 overlay 源逐字节相同，
  它会被 *adopted*（`origin: adopted`），不重写。
  在 overlay 纳管之前就已存在的文件，
  **卸载时绝不删除**——卸载只移除清单条目，
  文件留在原地，并报告 `kept adopted overlay agent`。
- **卸载只删除它自己创建的文件。** 由本工具安装/更新的文件，
  仅在仍未被修改时才会随卸载删除；被改过的保留。
  官方 agent 与无关 agent 永远不在考虑范围内。

## 平台约束

`overlays/qoder/agents.platforms.json` 把文件名映射到它们允许安装的
平台，例如：

```json
{
  "env-runner.md": ["win32"],
  "portable-tool.md": ["win32", "darwin", "linux"]
}
```

带平台约束的仓库源文件在不兼容的平台上会被跳过，并报告为
`skipped-platform`；不写入任何东西，也不记录任何东西。
用户级覆盖文件是本机私有的，**不会**被这份仓库元数据过滤——
覆盖永远优先、永远安装。默认没有附带任何约束
（`{}`）。

这就是把某台机器专用的 agent（比如只在 Windows 上用的 shim）留在
可移植仓库里、同时不把它装到 macOS/Linux 上的办法。

## 命令

overlay 同步作为 `mhe install qoder` 的一部分运行（`--global` 与
项目级都是），清理则作为 `mhe uninstall qoder` 的一部分。在默认的
空 overlay 下，在你添加个人 agent 之前这些都是 no-op：

```
node bin/mhe.mjs install qoder --global --dry-run   # preview, writes nothing
node bin/mhe.mjs install qoder --global             # merge + copy into configDir/agents
node bin/mhe.mjs doctor                              # shows managed/adopted/conflict/skipped counts
node bin/mhe.mjs uninstall qoder --global            # removes only clean installed files
```

## 与产品回退 agent 的关系

`mhe-*` 回退 agent（例如 `mhe-reasoner`）是另一个产品层面的东西，位于
`src/adapters/qoder/templates/agents`。它们不属于这个个人
overlay，也不会被复制到此处。overlay 同步发生在能力解析之后，
因此永远不会改变装上哪个 `mhe-*` 回退。

## 添加一个生效的个人 agent

1. 创建 `overlays/qoder/agents/<name>.md`，带上 frontmatter 块
   （`name`、`description`、`model`、`tools`）。文件名就是键。
2. 如果这个 agent 与平台相关，把它的文件名加进
   `overlays/qoder/agents.platforms.json`。
3. 运行 `mhe install qoder`（先加 `--dry-run` 预览）。文件会被复制到
   `<configDir>/agents/<name>.md`，并记录为 `origin: installed`。
4. 想在不提交的情况下做单机覆盖，就把同名文件放进
   `~/.my-harness-enhance/overlays/qoder/agents/`。它会在下一次同步时
   优先，并且不受平台过滤。
5. 只想回退自己的手改，就直接编辑已安装的文件；同步会报告 conflict
   并保留它。要彻底重置，删掉已安装的文件
   并重新运行 sync。

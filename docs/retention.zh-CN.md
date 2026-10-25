# 保留策略与垃圾回收

> 本文是 [retention.md](retention.md) 的中文译本，如与原文有出入，以原文为准。

`mhe gc` 回收 `~/.my-harness-enhance/` 下的用户级状态。它只先出计划，
只有加上 `--apply` 才会真正执行。

```
mhe gc [--root <project>] [--apply] [--json] [--include-decisions]
```

## 默认值

| 数据 | 阈值 | 动作 |
|---|---|---|
| `metrics.jsonl` | 30 天、5 MB | 先删过期行，再删超出上限的最旧行 |
| `logs/*.jsonl`、`logs/*.log` | 30 天、5 MB | 同样的裁剪 |
| `artifacts/*.txt` | 30 天，再加 7 天无人引用期 | 删除文件并移除索引条目 |
| `decisions.jsonl`、会话 journal | 180 天 | 默认关闭，用 `--include-decisions` 打开 |
| worktree | 7 天 | 只有任务已落地且工作树干净时才回收 |

## 安全规则

- 最近 10 分钟内改动过的文件会被跳过；
- 被 job、decision、brief、capsule 或会话文件引用的 artifact 会保留；
- 有未提交改动的 worktree 会保留；
- 收集计划并执行期间会持有项目状态锁；
- artifact 的年龄取自索引条目，无人引用期叠加在保留窗口之上，
  所以刚刚失去引用的 artifact 还能完整活过一段宽限期，
  这是为了避免刚失去引用就被立刻删除。

## 不回收的部分

`sessions/<id>/` 下的会话分片保存 goal、plan、jobs 和 capsule。
它们体积很小，又承载着持久的任务图，所以 `mhe gc` 不动它们。
不需要的会话请手动删除。

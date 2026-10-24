# 文档地图

> 本文是 [README.md](README.md) 的中文译本，如与原文有出入，以原文为准。

本页是仓库文档的索引与权威顺序。两页冲突时，按该问题的“权威”列取值。

| 页面 | 回答什么 | 权威性 |
|---|---|---|
| [../README.md](../README.md) | 这个项目是什么、状态、文档清单 | 入口 |
| [../INSTALL.md](../INSTALL.md) | 安装、升级、回滚、doctor | 命令与安装步骤 |
| [architecture.md](architecture.md) | 不变量、状态模型、hook 生命周期 | 运行时设计 |
| [adapters.md](adapters.md) | adapter 契约与各 harness 能力矩阵 | harness 支持 |
| [qoder-adapter.md](qoder-adapter.md) | Qoder 路径、安装布局、hook 载荷 | Qoder 专属设置 |
| [worktrees.md](worktrees.md) | 代码 worktree、派发门禁、land | 代码交付 |
| [brief-checks.md](brief-checks.md) | brief 字段、检查器 id、验收 | 验收 |
| [metrics.md](metrics.md) | 度量什么、数字怎么读 | 度量 |
| [roadmap.md](roadmap.md) | 计划中的工作 | 计划，不是当前行为 |
| [validation.md](validation.md) | 本地验证记录 | 历史证据 |
| [../overlays/README.md](../overlays/README.md) | 个人 agent overlay | overlay 安装 |

## 约定

- 英文是默认版本；`docs/` 下的页面和两个根页面都有 `.zh-CN.md` 译本，第 3 行回链。`overlays/README.md` 是运维说明，有意不提供译本。若有出入，以英文页为准。
- 围栏内的代码、命令、JSON 和标识符在两版中逐字一致，不翻译。
- 每个页面描述当前 commit；`validation.md` 是带日期的记录，不是规范。
- 个人笔记在 `docs/others/`，被 gitignore；它们不是仓库文档。
- 仓库不强制行尾；`core.autocrlf` 可能在检出时重写工作区文件。

## 验证

```bash
npm test
node --test test/state-root.test.mjs
```

链接与双语检查尚未自动化；可加一个小脚本比较标题层级并解析所有相对链接。

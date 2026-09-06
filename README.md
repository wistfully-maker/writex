# WriteX

WriteX 是一套面向中文长篇小说的创作工作流：过程中的每一步都可检查（inspectable）、可恢复（recoverable）。

- **可检查**：配置、正典、大纲、状态账本与每一笔运行记录都以明文文件落盘，作者与工具随时可以查看「现在作品处于什么状态、为什么是这种状态」。
- **可恢复**：章节目录、时间线等任何一次多文件写入都通过带清单（manifest）的事务提交，进程中断后可回滚到一致状态。
- **当前形态**：以命令行为主（CLI-first），聚焦文学质量与长程一致性（long-range consistency），为后续接入真实模型留出接口。

## 开发

```bash
pnpm install      # 安装依赖
pnpm typecheck    # 全仓库 TypeScript 类型检查
pnpm test         # 运行全部单元与端到端测试（Vitest）
```

## 命令行示例

```bash
# 初始化一部新小说的工作区
pnpm writex novel init ./my-novel --title "长夜来信"

# 查看一部小说的当前状态
pnpm writex status ./my-novel
```

## 持久 DSH 会话驱动

`packages/dsh-session-driver` 让 Codex 用**一个长期存活的 JSONL 进程**复用一个 DeepSeek Harness（DSH）命名会话，把多个相关的实现提示依次送进同一个模型上下文，并在空闲时落盘工作流登记（registry）与压缩胶囊（compaction capsule）。

```bash
pnpm dsh:driver        # 启动长生命周期 JSONL 控制进程（保持其存活）
```

Codex 在该进程的 stdin 上逐行写入 JSON 命令，stdout 每行返回一个紧凑 JSON 响应：

```json
{"id":"1","type":"open","controllerRoot":"D:/program/writex","config":{"schemaVersion":1,"workstreamId":"model-evaluation-v1","sessionId":"session-model-evaluation-v1","branch":"feature/model-evaluation-v1","workspace":"D:/program/writex/.worktrees/model-evaluation-v1","profile":"sdk","provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high","maxTokens":8192}}
{"id":"2","type":"send","message":"第一个相关操作"}
{"id":"3","type":"capsule","capsule":{"schemaVersion":1,"objective":"…","completed":["…"],"decisions":["…"],"currentState":{"branch":"…","worktree":"…","lastCommit":"…","dirtyFiles":[]},"verification":["…"],"openIssues":["…"],"nextAction":"…"}}
{"id":"4","type":"close"}
```

运行约定：

- **进程必须保持存活**：会话复用依赖驱动进程内的 SDK 运行时与命名会话句柄；进程退出即丢失上下文，只能重新开题。
- **模型调用花钱**：每条 `send` 都是一次真实的 DeepSeek 计费请求；`open`/`capsule`/`close` 不产生模型调用。
- **原始提示不进登记**：registry 与 capsule 只记录计数、用量、状态与胶囊；不含任何提示文本、模型回复或推理内容。
- **自动压缩只观察、不伪造**：驱动只统计 wire 上真实出现的 `compaction/*` 事件，绝不把 `/compact` 当提示发给模型。
- **Git 归主控**：驱动不执行任何 `git add/commit/push`，也不改动 Git 元数据。
- **写锁**：同一工作区同时只允许一个活跃 DSH 写入者；异常残留锁会按 pid 存活与否自动回收。
- **真人验证**：`pnpm test:dsh-live` 默认只打印跳过信息；经 Codex 审查并授权后 `pnpm test:dsh-live -- --live` 会对 `deepseek-v4-flash` 跑一次付费探针。

## 当前实现说明

本仓库的小说生产主链路当前仍处于 **foundation（地基）阶段**，尚未接入真实文学模型。章节评估、质量门槛（quality gate）等环节目前由确定性的本地代码与测试替身完成，模型网关（`packages/model-gateway`）仅提供假的客户端占位，供后续接入真实模型时替换。上面的 DSH 会话驱动属于开发基础设施，只有执行 `send` 或显式运行 `--live` 探针时才会产生真实 DeepSeek 模型调用；运行记录中的 `inputHash` 等字段本身不会触发网络请求。

## 详细设计

- 详细设计文档：[docs/superpowers/specs/2026-09-02-writex-mvp-design.md](docs/superpowers/specs/2026-09-02-writex-mvp-design.md)
- 实施计划：[docs/superpowers/plans/2026-09-02-writex-foundation.md](docs/superpowers/plans/2026-09-02-writex-foundation.md)

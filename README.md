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

## 当前实现说明

本仓库当前是 **foundation（地基）阶段**：尚不包含任何真实模型 API 调用。章节评估、质量门槛（quality gate）等环节目前由确定性的本地代码与测试替身完成，模型网关（`packages/model-gateway`）仅提供假的客户端占位，供将来接入真实模型时替换。运行记录中的 `inputHash` 等字段用于追踪输入来源，并不触发网络请求。

## 详细设计

- 详细设计文档：[docs/superpowers/specs/2026-09-02-writex-mvp-design.md](docs/superpowers/specs/2026-09-02-writex-mvp-design.md)
- 实施计划：[docs/superpowers/plans/2026-09-02-writex-foundation.md](docs/superpowers/plans/2026-09-02-writex-foundation.md)

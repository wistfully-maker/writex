# WriteX 持久 DSH 协作开发协议

- 状态：已批准
- 日期：2026-09-03
- 适用范围：WriteX 仓库内由 Codex 主控、DeepSeek Harness 执行的开发工作

## 1. 目标

本协议规定 WriteX 如何在保留 Codex 主对话统一决策和审核的同时，充分利用 DeepSeek Harness 的长上下文、提示缓存和连续工具状态。

核心目标是：

1. 同一开发阶段尽可能复用一个 DSH 会话。
2. 避免重复发送仓库背景、设计规范、实施计划和静态约束。
3. 将相关任务组成完整垂直切片，减少微任务切换成本。
4. 由 Codex 主控提供独立审核，防止长会话中的错误假设未经检查持续扩散。
5. 在上下文压力增大时优先 compact，而不是直接放弃已有缓存和工作记忆。

## 2. 角色与职责

### 2.1 用户：产品负责人

- 决定产品目标、审美方向、成本边界和重大取舍。
- 批准设计规范及明显扩大范围的变更。
- 对文学质量提供最终人工偏好判断。

### 2.2 Codex：主控与审核者

- 维护项目全局目标、设计规范和实施计划。
- 判断哪些工作属于同一阶段、哪些工作应拆成新会话。
- 为 DSH 准备一次性的阶段上下文包。
- 在检查点读取实际 diff、运行测试并审查代码。
- 将所有审查问题合并为一条有优先级的反馈，发回原 DSH 会话。
- 负责 Git 暂存、提交、推送、PR 和分支清理。
- 对完成状态作最终判断，不直接采信执行者自报结果。

### 2.3 DSH：阶段执行者

- 在指定工作树内实现已批准的垂直切片。
- 采用测试先行或等价的可验证开发方式。
- 优先运行目标测试，在阶段检查点运行完整测试。
- 保存结构化进度、阻塞原因和验证证据。
- 接收主控的集中反馈并在同一会话内返修。
- 不执行 Git 暂存、提交、合并、推送或工作树管理。
- 不自行扩展产品范围或修改已批准的设计。

## 3. 会话模型

### 3.1 一个阶段一个主会话

一个 `workstream` 对应：

- 一个明确的阶段目标；
- 一个功能分支；
- 一个隔离工作树；
- 一个持久 DSH `sessionId`；
- 多个连续任务和返修回合；
- 多个由 Codex 主控执行的审核检查点。

只要任务仍服务于同一阶段目标、依赖相同上下文并修改同一组相关组件，就必须继续使用原会话。

### 3.2 允许新建会话的条件

仅在以下情况新建 DSH 会话：

1. 新任务与当前 workstream 的目标或代码区域明显无关。
2. 上下文已接近模型限制，完成 compact 后仍无法容纳必要状态。
3. 原会话反复依赖错误假设，集中纠正后仍无法恢复。
4. 会话的工具、工作树或持久状态已损坏且无法安全恢复。
5. 任务明确需要一个没有既有上下文偏见的独立评审者。
6. 安全或权限边界要求使用不同的执行环境。

“任务很小”“出现一个测试失败”“主控提出一条审查意见”都不是新建会话的理由。

## 4. 阶段上下文包

Codex 第一次启动阶段会话时只发送一次完整上下文包：

```yaml
workstream:
  id: model-evaluation-v1
  objective: 本阶段唯一目标
  branch: feature/model-evaluation-v1
  worktree: 绝对路径
  model: deepseek-v4-flash
  permissions: workspace-write

authoritative_inputs:
  design_spec: 已批准规范路径
  implementation_plan: 当前计划路径
  relevant_contracts:
    - 必须遵循的接口路径

scope:
  included:
    - 本阶段允许完成的能力
  excluded:
    - 本阶段禁止扩展的能力

verification:
  targeted_tests:
    - 目标测试命令
  checkpoint_tests:
    - 类型检查
    - 完整测试

stop_conditions:
  - 需要新的产品决策
  - 涉及未授权的外部写入
  - 连续两次返修仍无法满足同一规范
```

后续消息只发送：新增任务、当前 diff 的审查意见、改变后的约束和必要状态摘要。不得重复粘贴完整背景。

## 5. 执行循环

```text
Codex 创建 workstream 与持久 DSH 会话
→ DSH 确认目标、范围和测试入口
→ DSH 连续实现一组相关任务
→ DSH 输出检查点报告
→ Codex 检查实际 diff 并独立运行验证
→ Codex 一次性发送集中审查意见
→ 原 DSH 会话返修
→ Codex 重新审核
→ 通过后由 Codex 提交 Git
→ 原 DSH 会话继续下一个相关任务组
```

### 5.1 检查点粒度

检查点应对应一个可运行、可测试的垂直切片，例如：

- 一个模型适配器及其契约测试；
- 一套评测用例加载、执行和结果落盘；
- 一条从场景输入到候选稿保存的最小链路。

下列内容通常不应成为独立会话或独立检查点：

- 添加一个类型字段；
- 修复一个断言；
- 调整一个错误消息；
- 处理一条代码审查意见。

## 6. 审查协议

DSH 的自检不能替代主控审查。每个检查点至少经过两层审核：

### 6.1 规范符合性

- 是否实现全部要求。
- 是否加入未批准功能。
- 是否改变既有契约或产品边界。
- 测试是否真的证明其声称的行为。

### 6.2 代码质量与风险

- 失败是否明确、可恢复且不会污染正式状态。
- 文件路径、凭据、并发和外部调用是否安全。
- 数据是否可追踪、可复现。
- 是否存在仅在当前测试环境下成立的假设。
- 是否出现不必要的供应商耦合。

Codex 必须把发现的问题合并为一条反馈，按 `blocking`、`important`、`minor` 分组。DSH 在原会话内集中返修，然后主控重新验证所有 blocking 和 important 项。

## 7. 上下文与 compact

### 7.1 何时 compact

出现任一信号时应准备 compact：

- 上下文仪表显示使用率持续升高并接近安全阈值；
- 模型开始重复已完成的调查或忘记已经确认的约束；
- 工具结果和历史 diff 占据大量上下文；
- 一个大检查点已完成，但后续工作仍属于同一 workstream。

若可获得上下文百分比，70% 作为准备压缩的软阈值，85% 作为执行压缩的硬阈值。模型或 Harness 未提供可靠百分比时，以重复、遗忘和输入增长趋势作为判断依据。

### 7.2 压缩胶囊

compact 前必须生成并持久保存一份 `compaction capsule`：

```yaml
objective: 当前阶段目标
completed:
  - 已完成并通过主审的检查点
decisions:
  - 不得丢失的架构决策
current_state:
  branch: 当前分支
  worktree: 当前工作树
  last_commit: 最近由主控创建的提交
  dirty_files:
    - 未提交文件
verification:
  last_commands:
    - 命令及结果
open_issues:
  - 尚未解决的问题
next_action: 压缩后的第一项动作
```

压缩后继续使用同一 `sessionId`，并先核对胶囊中的目标、分支、未完成问题和下一动作。

## 8. 成本与缓存规则

- 阶段静态上下文只发送一次，并保持稳定前缀以提高缓存命中。
- 后续反馈只包含变化量，不重复大段设计文档。
- 相关小任务合并成一个实现批次。
- DSH 在开发过程中运行目标测试；完整测试由检查点和主控最终验证负责。
- 不为格式调整、单个断言或小范围返修创建新会话。
- 记录每个会话的模型、累计输入/输出 token、缓存命中率、compact 次数和完成的检查点数。
- 成本比较以“完成一个通过主审的垂直切片”为单位，而不是以单次模型调用价格为单位。

## 9. Git 与工作树

- Codex 为每个 workstream 创建或选择一个隔离工作树。
- 一个工作树同时只能有一个写入型 DSH 会话。
- DSH 的文件权限限定在工作树内。
- DSH 不访问或修改 `.git`、公共 Git 目录或其他工作树。
- Codex 在主审通过后执行 `git add` 和 `git commit`。
- PR 创建后保留工作树，直到 PR 合并或用户决定清理。
- 未经用户授权，不进行强制推送、历史重写或分支删除。

## 10. 权限与安全

- API 密钥只能通过环境变量或 Harness 凭据存储传入，不得进入提示词、日志、代码或提交。
- 阶段上下文只包含完成任务必需的文件和信息。
- 遇到需要审批但 headless 会话没有审批通道的操作，DSH 必须返回结构化阻塞，不得循环尝试升级。
- 外部发布、提交 PR、付费模型调用和其他有外部影响的操作由 Codex 主控按照用户授权执行。
- DSH 发现任务需要扩大范围时必须停止并请求主控决策。

## 11. 传输与驱动方式

### 11.1 正式方式

使用长生命周期的 DSH SDK/JSON-RPC 驱动器：

```ts
interface DshSessionDriver {
  open(workstream: WorkstreamConfig): Promise<SessionHandle>
  send(sessionId: string, message: string): Promise<MessageReceipt>
  waitForIdle(sessionId: string): Promise<SessionCheckpoint>
  saveCompactionCapsule(sessionId: string, capsule: CompactionCapsule): Promise<void>
  close(sessionId: string): Promise<void>
}
```

驱动器必须：

- 固定并复用 `sessionId`；
- 监听 durable session events，而不是解析终端展示文本；
- 在会话进入 idle、blocked、failed 或 cancelled 时返回；
- 支持发送主控集中反馈；
- 监测并记录 `compaction/*` 事件，在自动 compact 后继续使用原会话；
- 保存会话与 workstream 的映射；
- 防止同一工作树出现并发写入会话。

当前 DSH SDK JSON-RPC 只提供 `initialize`、`session/prompt` 和 `shutdown` 请求，没有手动 compact 请求。第一版驱动器依赖 SDK profile 的自动压缩能力，并在压缩前后持久保存胶囊、监测 `compaction/*` 事件。不得把 `/compact` 当作普通模型消息发送来伪造压缩。若以后需要主控主动压缩，应通过独立的 DSH 控制插件或上游新增的正式协议方法实现。

### 11.2 临时兼容方式

`dsh --profile headless "任务"` 每次会创建新会话，只允许在驱动器尚未可用时用于一次性诊断或引导。Windows 下通过 CLI 传递多行参数可能只保留第一行；不得将其作为正式阶段协议。若必须临时使用，应把短任务编码为单个命令行参数并核对 Harness 实际收到的消息。

## 12. 会话登记

驱动器应为每个 workstream 保存非敏感登记信息：

```yaml
workstream_id: model-evaluation-v1
session_id: opaque-session-id
model: deepseek-v4-flash
branch: feature/model-evaluation-v1
worktree: D:/program/writex/.worktrees/model-evaluation-v1
status: active
created_at: 2026-09-03T00:00:00Z
last_checkpoint: provider-contracts
compact_count: 0
```

登记文件不得包含 API 密钥、访问令牌、完整提示内容或模型隐藏推理。

## 13. 完成标准

本协议的自动化实现只有满足以下条件才算可用：

1. 同一 DSH `sessionId` 能连续完成两个最小相关操作和一次主控返修。测试只需使用临时夹具与确定性断言，例如先写入一个会话标记，再在后续消息中引用该标记完成修改；不得为验证驱动器而实现额外产品功能。
2. 第二个操作不需要重新发送完整设计与仓库背景，并能正确使用第一个操作建立的上下文。
3. 主控能够等待 idle 并取得最终消息、工具结果摘要和状态。
4. 驱动器能识别自动 `compaction/*` 事件，并在 compact 后继续使用同一会话；单元验收使用合成事件，真实开发会话在自然触发压缩时补充现场验证，不为验收故意制造高 token 消耗。
5. DSH 无法写 Git 元数据，Codex 可以在审核后正常提交。
6. 同一工作树的并发写入会话会被拒绝。
7. 会话登记和成本指标中不包含凭据或隐藏推理。

## 14. 下一步

在接入真实创作模型和文学评测流水线前，先实现并验证持久 `DshSessionDriver`。验证通过后，使用一个阶段会话完成“DeepSeek 与 OpenAI 模型适配器、最小文学评测集、匿名输出和对比报告”，避免重演每个微任务创建新会话的模式。

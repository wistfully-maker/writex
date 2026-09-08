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

## 文学模型评测（DeepSeek Flash / Pro）

`packages/evaluation` 提供可复现的小规模文学模型评测：三个独立场景题 + 一段三步连续续写，共 12 次正文生成，然后匿名盲选、可选 LLM 诊断与揭盲报告。完整设计见 [2026-09-07-literary-model-evaluation-design](docs/superpowers/specs/2026-09-07-literary-model-evaluation-design.md)。

```bash
# 1. 准备评测配置（复制示例并按需修改预算/价格）
cp packages/evaluation/config.example.json ./eval-config.json

# 2. 初始化运行根（create-only），打印 configHash/fixtureHash
pnpm writex eval init ./eval-run --config ./eval-config.json

# 3. 计划（dry）：打印确定的 12 次请求与预算估算，零网络调用
pnpm writex eval plan ./eval-run --json

# 4. 生成：默认 dry（零网络）；显式 --live 才调用真实 DeepSeek API
pnpm writex eval run ./eval-run                 # dry
pnpm writex eval run ./eval-run --live          # 12 次真实正文生成
pnpm writex eval run ./eval-run --live --retry-failed   # 恢复中断/失败项

# 5. 匿名导出：每题一个 Markdown + 投票模板；模型映射保存在
#    ./eval-run/blind/mapping.json，绝不写入盲选文件名或正文元数据
pnpm writex eval export ./eval-run

# 6. 人工盲选：编辑导出模板 ballot.template.json——把每组的 choice 从 null
#    改成 "A" / "B" / "tie"(并列) / "neither"(全部不合格)，可附 reason；
#    四个绑定哈希（configHash/fixtureHash/mappingHash/artifactsHash）保持
#    原样（缺失或改动都会被拒绝）。例：
#    { "reunion": { "choice": "tie", "reason": "A 开篇更好，B 收束更准" },
#      "costly-choice": { "choice": "neither", "reason": "两篇都偏直白" },
#      "limited-reveal": { "choice": "A" },
#      "continuity": { "choice": "B" } }
pnpm writex eval vote ./eval-run --ballot ./ballot.json

# 7. 可选诊断：必须先记录完整投票。8 个候选各一次诊断请求
pnpm writex eval diagnose ./eval-run                  # dry，先看计划
pnpm writex eval diagnose ./eval-run --live           # 8 次诊断
pnpm writex eval diagnose ./eval-run --live --model pro   # 诊断裁判用 Pro

# 8. 揭盲报告：人工选择 +（可用的）诊断分数 + 用量费用 + 局限说明
pnpm writex eval report ./eval-run
pnpm writex eval report ./eval-run --gate ./my-gate.json   # 自定义权重重算，无需 API
```

本机密钥设置（在本地 PowerShell 完成，密钥不落盘到评测产物，也请不要粘贴到聊天/报告中）：

```powershell
# 隐藏输入；只设置当前终端及其子进程的环境变量
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'DeepSeek API key' -AsSecureString)).Password
# 在同一个终端执行上面的 eval run / diagnose --live 命令。
# 全部调用完成后清除当前终端中的密钥：
# Remove-Item Env:DEEPSEEK_API_KEY
```

运行约定：

- **DeepSeek API 密钥只来自环境变量**：配置里的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）只存变量名，密钥值永不落盘或进入报告；配置示例、价格表来源与生效日期都写在 `config.json`。
- **无 `--live` 不产生任何网络生成请求**；认证失败立即停止整批；限流/超时/服务错误记录为失败，首版不自动重发可能已计费的请求。
- **预算在每次请求前检查并预留**（失败/不确定项保留预留额），生成与诊断共用同一份预算；未知用量/价格显示未知，绝不当作零。预留与花费都是估算，不是计费账单。
- **成功结果从不自动重跑**；崩溃恢复后 `in-flight` 项变成 `uncertain`，只有显式 `--retry-failed` 才会重试，重试成功会清除该次的错误记录但保留累计预留（历史）。
- **流程门**：盲选导出需要 12 篇全部成功；诊断与揭盲报告需要已记录的完整投票；诊断必须逐字引用原文，任何捏造引用/越界分数都记为该诊断失败，绝不悄悄修复或打零分。
- **局限披露**：每模型每任务只有 1 个样本；诊断裁判与生成同厂商（默认 `deepseek-v4-flash`），报告会注明同厂商裁判偏差；工程测试通过 ≠ 文学质量结论。
- **凭据边界**：真实文学评测使用上面的 `DEEPSEEK_API_KEY`；DSH 开发会话凭据属于开发基础设施，二者分离，本评测代码不读取 DSH 内部凭据，也不使用 OpenAI。

## 当前实现说明

本仓库的小说生产主链路仍处于 **foundation（地基）阶段**：常规写作/质量工作流尚未接入真实文学模型。与此同时，本仓库已具备可运行的**真实模型评测**：`packages/model-gateway` 提供经注入式 HTTP 测试替身验证的 DeepSeek 适配器（无 OpenAI），`pnpm writex eval …` 仅在显式 `--live` 时通过 `DEEPSEEK_API_KEY` 调用真实 DeepSeek Flash/Pro（盲选/诊断/揭盲报告流程见上文）；日常测试全部使用本地替身，默认不产生任何网络请求。DSH 会话驱动属于开发基础设施，同样只在执行 `send` 或显式 live 探针时产生模型调用。

## 详细设计

- 详细设计文档：[docs/superpowers/specs/2026-09-02-writex-mvp-design.md](docs/superpowers/specs/2026-09-02-writex-mvp-design.md)
- 实施计划：[docs/superpowers/plans/2026-09-02-writex-foundation.md](docs/superpowers/plans/2026-09-02-writex-foundation.md)

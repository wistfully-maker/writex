import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import type { GenerationRequest, ModelGateway } from '@writex/contracts'
import type { DeepSeekModelId } from '@writex/model-gateway'
import { DeepSeekModelGateway } from '@writex/model-gateway'
import type { EvaluationConfig } from '@writex/evaluation'
import {
  EvaluationStore,
  buildEvaluationReport,
  exportBlind,
  parseEvaluationConfig,
  parseQualityGate,
  planEvaluation,
  recordBallot,
  renderEvaluationReport,
  runDiagnosis,
  runEvaluation,
} from '@writex/evaluation'

export type MakeGateway = (root: string) => ModelGateway
export type WriteFn = (chunk: string) => unknown

/** Builds one gateway for a concrete DeepSeek model (injectable in tests). */
export type DeepSeekGatewayFactory = (
  config: EvaluationConfig,
  model: DeepSeekModelId,
) => ModelGateway

function defaultDeepSeekFactory(config: EvaluationConfig, model: DeepSeekModelId): ModelGateway {
  return new DeepSeekModelGateway({
    model,
    apiKeyEnv: config.apiKeyEnv,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    thinking: config.thinking,
    ...(config.reasoningEffort !== undefined
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
  })
}

/**
 * Real live gateway: routes each request to a per-model DeepSeek adapter by
 * `request.metadata.model`, so one CLI process serves Flash and Pro drafts
 * plus the configurable diagnostic judge model. Instances are created lazily,
 * so dry runs never touch the environment or the network. `factory` is
 * injectable so tests can substitute mocked fetch/env per model.
 */
export function deepSeekRoutingGateway(
  root: string,
  factory: DeepSeekGatewayFactory = defaultDeepSeekFactory,
): ModelGateway {
  const store = new EvaluationStore(root)
  const configPromise = store.readConfig()
  const instances = new Map<string, ModelGateway>()
  return {
    async generate(request: GenerationRequest) {
      const config = await configPromise
      const model = request.metadata.model
      if (model !== 'deepseek-v4-flash' && model !== 'deepseek-v4-pro') {
        throw new Error(`CLI gateway cannot route model: ${model}`)
      }
      let gateway = instances.get(model)
      if (gateway === undefined) {
        gateway = factory(config, model)
        instances.set(model, gateway)
      }
      return gateway.generate(request)
    },
  }
}

function printJson(writeOut: WriteFn, value: unknown): void {
  writeOut(`${JSON.stringify(value, null, 2)}\n`)
}

async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON file: ${path}`)
  }
}

export interface EvaluationCommandHooks {
  makeGateway?: MakeGateway
  /** Human-oriented channel (defaults to stderr); stdout stays machine-clean. */
  writeErr?: WriteFn
}

export function registerEvaluationCommands(
  program: Command,
  writeOut: WriteFn,
  hooks: EvaluationCommandHooks = {},
): void {
  const errWrite = hooks.writeErr ?? process.stderr.write.bind(process.stderr)
  const evalCommand = program
    .command('eval')
    .description('文学模型评测：12 篇正文生成、盲选、诊断与揭盲报告')

  evalCommand
    .command('init <path>')
    .description('从配置 JSON 初始化一个评测运行根目录（create-only）')
    .requiredOption('--config <file>', '评测配置 JSON 文件路径（含预算与价格表）')
    .action(async (target: string, options: { config: string }) => {
      const root = resolve(target)
      const value = await readJsonFile(resolve(options.config))
      const config = parseEvaluationConfig(value, resolve(options.config))
      const summary = await new EvaluationStore(root).init(config)
      writeOut(
        `Initialized evaluation run ${root}\nconfigHash=${summary.configHash}\nfixtureHash=${summary.fixtureHash}\n`,
      )
    })

  evalCommand
    .command('plan <path>')
    .description('打印确定性的 12 次生成请求计划与预算估算')
    .option('--json', '以 JSON 格式输出')
    .action(async (target: string, options: { json?: boolean }) => {
      const root = resolve(target)
      const plan = await planEvaluation(root)
      if (options.json) {
        printJson(writeOut, plan)
        return
      }
      writeOut(
        `计划 ${plan.callCount} 次正文生成（${plan.modelCount} 个模型）；预算 USD ${plan.budgetUsd}；预留估算合计 USD ${plan.reserveTotalUsd}\n`,
      )
      for (const row of plan.attempts) {
        writeOut(
          `  ${row.attemptId}  ${row.model}  ${row.taskId}${row.step !== null ? ` #${row.step}` : ''}  预留 ${row.reservedUsd.toFixed(8)}\n`,
        )
      }
      for (const assumption of plan.assumptions) {
        writeOut(`备注：${assumption}\n`)
      }
    })

  evalCommand
    .command('run <path>')
    .description('运行正文生成。默认 dry（零网络请求）；加 --live 才调用真实/注入网关')
    .option('--live', '显式启用真实生成请求')
    .option('--retry-failed', '显式重试之前 failed/uncertain 的生成项')
    .option('--json', '以 JSON 格式输出')
    .action(
      async (
        target: string,
        options: { live?: boolean; retryFailed?: boolean; json?: boolean },
      ) => {
        const root = resolve(target)
        const resolveGateway = hooks.makeGateway ?? deepSeekRoutingGateway
        const json = options.json === true
        if (options.live === true) {
          // Show the deterministic request plan and reserve estimate BEFORE
          // any network call starts. Under --json this advisory goes to the
          // error channel so stdout stays exactly one JSON document.
          const plan = await planEvaluation(root)
          const preflight = `计划 ${plan.callCount} 次正文生成；预留估算合计 USD ${plan.reserveTotalUsd.toFixed(8)}；预算 USD ${plan.budgetUsd}\n`
          if (json) {
            errWrite(preflight)
          } else {
            writeOut(preflight)
          }
        }
        const report =
          options.live === true
            ? await runEvaluation(root, {
                live: true,
                gateway: resolveGateway(root),
                retryFailed: options.retryFailed === true,
              })
            : await runEvaluation(root, {
                live: false,
                retryFailed: options.retryFailed === true,
              })
        if (json) {
          printJson(writeOut, report)
          return
        }
        const counts = new Map<string, number>()
        for (const attempt of report.attempts) {
          counts.set(attempt.status, (counts.get(attempt.status) ?? 0) + 1)
        }
        const label = [...counts.entries()]
          .map(([status, count]) => `${status}=${count}`)
          .join(' ')
        writeOut(
          `${report.dryRun ? 'dry' : 'live'} run: gatewayCalls=${report.gatewayCalls} stoppedReason=${report.stoppedReason ?? '—'} ${label}\n`,
        )
      },
    )

  evalCommand
    .command('export <path>')
    .description('导出匿名 Markdown 稿与投票模板（模型映射单独保存，不写入盲选文件）')
    .action(async (target: string) => {
      const root = resolve(target)
      const summary = await exportBlind(root)
      for (const path of summary.exports) {
        writeOut(`${path}\n`)
      }
      writeOut(`${summary.ballotTemplatePath}\n`)
      writeOut('模型映射保存在该根目录的 blind/mapping.json（揭盲前请勿外泄）；上面的导出文件均不含模型信息。\n')
    })

  evalCommand
    .command('vote <path>')
    .description('记录一份完整人工盲选投票（每个盲选组 A/B/并列/全部不合格）')
    .requiredOption('--ballot <file>', '人工填写的投票 JSON 文件路径')
    .option('--json', '以 JSON 格式输出')
    .action(
      async (target: string, options: { ballot: string; json?: boolean }) => {
        const root = resolve(target)
        const input = await readJsonFile(resolve(options.ballot))
        const ballot = await recordBallot(root, input)
        if (options.json) {
          printJson(writeOut, ballot)
          return
        }
        writeOut(`Ballot recorded for ${root}\n`)
      },
    )

  evalCommand
    .command('diagnose <path>')
    .description('对 8 个匿名候选运行 LLM 诊断（需先记录完整投票）。默认 dry；加 --live 才调用')
    .option('--live', '显式启用真实诊断请求')
    .option('--model <flash|pro>', '诊断裁判模型', 'flash')
    .option('--retry-failed', '显式重试之前 failed/uncertain 的诊断项')
    .option('--json', '以 JSON 格式输出')
    .action(
      async (
        target: string,
        options: {
          live?: boolean
          model?: string
          retryFailed?: boolean
          json?: boolean
        },
      ) => {
        const root = resolve(target)
        if (options.model !== 'flash' && options.model !== 'pro') {
          throw new Error(
            `unsupported diagnostic model: ${options.model ?? '(missing)'}; choose --model flash or --model pro`,
          )
        }
        const model =
          options.model === 'pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
        const json = options.json === true
        const resolveGateway = hooks.makeGateway ?? deepSeekRoutingGateway
        if (options.live === true) {
          // Real eight-call estimate BEFORE any network request. Under --json
          // it goes to the error channel; stdout stays a single JSON doc.
          const plan = await runDiagnosis(root, {
            live: false,
            model,
            retryFailed: options.retryFailed === true,
          })
          const estimate = plan.candidates.reduce(
            (sum, candidate) => sum + candidate.reservedUsd,
            0,
          )
          const preflight = `诊断计划：${plan.candidates.length} 次调用（预留估算合计 USD ${estimate.toFixed(8)}）\n`
          if (json) {
            errWrite(preflight)
          } else {
            writeOut(preflight)
          }
        }
        const summary =
          options.live === true
            ? await runDiagnosis(root, {
                live: true,
                gateway: resolveGateway(root),
                model,
                retryFailed: options.retryFailed === true,
              })
            : await runDiagnosis(root, {
                live: false,
                model,
                retryFailed: options.retryFailed === true,
              })
        if (json) {
          printJson(writeOut, summary)
          return
        }
        const reserveEstimate = summary.candidates.reduce(
          (sum, candidate) => sum + candidate.reservedUsd,
          0,
        )
        writeOut(
          `${summary.dryRun ? 'dry' : 'live'} diagnosis: gatewayCalls=${summary.gatewayCalls} stoppedReason=${summary.stoppedReason ?? '—'} candidates=${summary.candidates.length} reserveEstimateUsd=${reserveEstimate.toFixed(8)}\n`,
        )
      },
    )

  evalCommand
    .command('report <path>')
    .description('生成揭盲评测报告：人工选择 + 诊断评分 + 用量费用（需投票；诊断可选）')
    .option('--gate <file>', '质量门槛 JSON（权重/最低分）；缺省用内置默认门槛')
    .option('--json', '以 JSON 格式输出原始数据')
    .action(
      async (target: string, options: { gate?: string; json?: boolean }) => {
        const root = resolve(target)
        const gate =
          options.gate === undefined
            ? undefined
            : parseQualityGate(
                await readJsonFile(resolve(options.gate)),
                resolve(options.gate),
              )
        const report = await buildEvaluationReport(
          root,
          gate === undefined ? {} : { gate },
        )
        if (options.json) {
          printJson(writeOut, report)
          return
        }
        writeOut(renderEvaluationReport(report))
      },
    )
}

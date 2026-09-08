import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  GenerationRequest,
  GenerationResult,
  ModelGateway,
} from '@writex/contracts'
import { qualityDimensions, type CandidateEvaluation } from '@writex/contracts'
import {
  DeepSeekModelGateway,
  type DeepSeekFetch,
} from '@writex/model-gateway'
import { EvaluationStore, parseEvaluationConfig } from '@writex/evaluation'
import { createProgram, type WriteFn } from '../src/index.js'
import { deepSeekRoutingGateway } from '../src/evaluation.js'

const dirs: string[] = []

async function makeDir(prefix = 'writex-cli-eval-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

function capture(): { outputs: string[]; write: WriteFn } {
  const outputs: string[] = []
  return {
    outputs,
    write: (chunk: string) => {
      outputs.push(String(chunk))
    },
  }
}

const configJson = {
  schemaVersion: 1,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 60000,
  maxOutputTokens: 4096,
  thinking: { type: 'disabled' },
  budgetUsd: 100,
  priceTable: {
    currency: 'USD',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    effectiveDate: '2026-09-07',
    perMTokens: {
      'deepseek-v4-flash': {
        inputCacheHitUsdPerMTokens: 0.014,
        inputCacheMissUsdPerMTokens: 0.44,
        outputUsdPerMTokens: 1.32,
      },
      'deepseek-v4-pro': {
        inputCacheHitUsdPerMTokens: 0.044,
        inputCacheMissUsdPerMTokens: 1.32,
        outputUsdPerMTokens: 3.96,
      },
    },
  },
}

const draftPhrase = '共同的旧事压在沉默里'

function validDiagnosisJson(groupId: string, score = 80): string {
  const dimensions = {} as CandidateEvaluation['dimensions']
  for (const name of qualityDimensions) {
    dimensions[name] = {
      score,
      evidence: [draftPhrase],
      diagnosis: `关于${name}的诊断说明`,
      revisionInstruction: `针对${name}的修改指令`,
    }
  }
  const payload: Record<string, unknown> = { dimensions, vetoes: [] }
  if (groupId === 'continuity') {
    payload.continuityIssues = []
  }
  return JSON.stringify(payload)
}

/** Deterministic fake gateway: generation drafts + diagnostic JSON, no network. */
function makeFakeGateway(): ModelGateway {
  const requests: GenerationRequest[] = []
  const gateway: ModelGateway & { requests: GenerationRequest[] } = {
    requests,
    async generate(request: GenerationRequest): Promise<GenerationResult> {
      requests.push(structuredClone(request))
      const text =
        request.purpose === 'eval-diagnosis'
          ? validDiagnosisJson(request.metadata.groupId ?? 'reunion')
          : `正文-${request.requestId}。${draftPhrase}。`
      return {
        requestId: request.requestId,
        provider: 'fake',
        model: 'fake-v1',
        text,
        usage: {
          inputTokens: request.system.length + request.prompt.length,
          outputTokens: text.length,
        },
        finishReason: 'stop',
      }
    },
  }
  return gateway
}

async function parseLastJson(outputs: string[]): Promise<Record<string, unknown>> {
  const last = outputs[outputs.length - 1]
  if (last === undefined) {
    throw new Error('expected captured program output')
  }
  return JSON.parse(last) as Record<string, unknown>
}

describe('eval CLI lifecycle (deterministic fake gateway)', () => {
  it('walks init/plan/run/export/vote/diagnose/report end to end', async () => {
    const dir = await makeDir()
    const run = join(dir, 'run')
    const configPath = join(dir, 'config.json')
    await writeFile(configPath, JSON.stringify(configJson), 'utf8')
    const { outputs, write } = capture()
    const errs: string[] = []
    const events: string[] = []
    const makeGateway = (): ModelGateway => {
      const inner = makeFakeGateway()
      return {
        async generate(request) {
          events.push('gateway')
          return inner.generate(request)
        },
      }
    }
    const hooks = {
      makeGateway,
      writeErr: (chunk: string) => {
        events.push('stderr')
        errs.push(String(chunk))
      },
    }

    // init: create-only run root from validated config.
    await createProgram(write, hooks).parseAsync(
      ['eval', 'init', run, '--config', configPath],
      { from: 'user' },
    )
    expect(outputs[0]).toContain('Initialized evaluation run')
    expect(outputs[0]).toContain('configHash=')

    // plan: deterministic 12-call JSON plan with zero gateway calls.
    await createProgram(write, hooks).parseAsync(['eval', 'plan', run, '--json'], {
      from: 'user',
    })
    const plan = (await parseLastJson(outputs)) as { callCount: number }
    expect(plan.callCount).toBe(12)

    // run without --live is a dry run (no gateway, zero network).
    await createProgram(write, hooks).parseAsync(['eval', 'run', run, '--json'], {
      from: 'user',
    })
    const dry = (await parseLastJson(outputs)) as {
      dryRun: boolean
      gatewayCalls: number
    }
    expect(dry.dryRun).toBe(true)
    expect(dry.gatewayCalls).toBe(0)

    // live run through the injected fake gateway completes all twelve.
    const runStartOutputs = outputs.length
    const runStartEvents = events.length
    await createProgram(write, hooks).parseAsync(
      ['eval', 'run', run, '--live', '--json'],
      { from: 'user' },
    )
    // stdout must be EXACTLY one JSON document (no prose mixed in).
    const runStdout = outputs.slice(runStartOutputs).join('\n')
    const live = JSON.parse(runStdout) as {
      dryRun: boolean
      gatewayCalls: number
      stoppedReason: string
      attempts: Array<{ status: string }>
    }
    expect(live.dryRun).toBe(false)
    expect(live.gatewayCalls).toBe(12)
    expect(live.stoppedReason).toBe('completed')
    expect(live.attempts).toHaveLength(12)
    expect(live.attempts.every((attempt) => attempt.status === 'succeeded')).toBe(true)
    // The preflight plan/cost estimate went to the error channel BEFORE any
    // gateway call, keeping stdout machine-parseable.
    const runEvents = events.slice(runStartEvents)
    expect(runEvents[0]).toBe('stderr')
    expect(runEvents.filter((event) => event === 'gateway')).toHaveLength(12)
    expect(errs.some((chunk) => chunk.includes('预留估算合计'))).toBe(true)
    expect(errs.join('\n')).toContain('12 次正文生成')

    // export: blind markdown + ballot template; no model names in exports.
    const beforeExport = outputs.length
    await createProgram(write, hooks).parseAsync(['eval', 'export', run], {
      from: 'user',
    })
    const exportLines = outputs
      .slice(beforeExport)
      .filter((line) => line.startsWith(dir))
      .map((line) => line.trim())
    expect(exportLines).toHaveLength(5) // four group files + ballot template
    const templatePath = exportLines.find((line) =>
      line.includes('ballot.template.json'),
    )
    expect(templatePath).toBeTruthy()
    const reunionMd = exportLines.find((line) => line.includes('reunion.md'))
    expect(reunionMd).toBeTruthy()
    const md = await readFile(reunionMd as string, 'utf8')
    expect(md).not.toContain('deepseek-v4-flash')
    expect(md).not.toContain('deepseek-v4-pro')
    // The export command's own output must never leak the model mapping.
    const exportStdout = outputs.slice(beforeExport).join('\n')
    expect(exportStdout).not.toContain('deepseek-v4-flash')
    expect(exportStdout).not.toContain('deepseek-v4-pro')

    // The exported template starts EMPTY and must be filled in by the human;
    // voting with the untouched template is rejected.
    const templateText = await readFile(templatePath as string, 'utf8')
    const template = JSON.parse(templateText) as {
      configHash: string
      fixtureHash: string
      mappingHash: string
      artifactsHash: string
      choices: Record<string, { choice: string | null; reason: string }>
    }
    expect(template.artifactsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(template.choices['reunion']?.choice).toBeNull()
    await expect(
      createProgram(write, hooks).parseAsync(
        ['eval', 'vote', run, '--ballot', templatePath as string],
        { from: 'user' },
      ),
    ).rejects.toThrowError(/requires an explicit human selection/)

    const ballotPath = join(dir, 'ballot.json')
    for (const entry of Object.values(template.choices)) {
      entry.choice = 'A'
    }
    await writeFile(ballotPath, JSON.stringify(template), 'utf8')
    await createProgram(write, hooks).parseAsync(
      ['eval', 'vote', run, '--ballot', ballotPath, '--json'],
      { from: 'user' },
    )
    const ballot = (await parseLastJson(outputs)) as {
      mappingHash: string
      artifactsHash: string
    }
    expect(ballot.mappingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(ballot.artifactsHash).toMatch(/^[0-9a-f]{64}$/)

    // diagnose dry (zero calls) then live: exactly eight diagnostic requests.
    await createProgram(write, hooks).parseAsync(
      ['eval', 'diagnose', run, '--json'],
      { from: 'user' },
    )
    const diagnoseDry = (await parseLastJson(outputs)) as {
      dryRun: boolean
      candidates: Array<{ reservedUsd: number }>
    }
    expect(diagnoseDry.dryRun).toBe(true)
    expect(diagnoseDry.candidates).toHaveLength(8)
    // Dry diagnosis planning shows real eight-call reserve estimates.
    expect(
      diagnoseDry.candidates.every((candidate) => candidate.reservedUsd > 0),
    ).toBe(true)

    const diagnoseStartOutputs = outputs.length
    await createProgram(write, hooks).parseAsync(
      ['eval', 'diagnose', run, '--live', '--json'],
      { from: 'user' },
    )
    // Same contract as run --json: stdout is a single JSON document and the
    // preflight estimate went to the error channel.
    const diagnoseStdout = outputs.slice(diagnoseStartOutputs).join('\n')
    const diagnoseLive = JSON.parse(diagnoseStdout) as {
      gatewayCalls: number
      stoppedReason: string
      candidates: Array<{ status: string }>
    }
    expect(diagnoseLive.gatewayCalls).toBe(8)
    expect(diagnoseLive.stoppedReason).toBe('completed')
    expect(
      diagnoseLive.candidates.every((candidate) => candidate.status === 'succeeded'),
    ).toBe(true)
    expect(errs.join('\n')).toContain('诊断计划')
    expect(errs.join('\n')).toContain('预留估算合计')

    // report: reveal requires the ballot (already recorded) and scores the
    // persisted diagnostics without any further model calls.
    await createProgram(write, hooks).parseAsync(['eval', 'report', run, '--json'], {
      from: 'user',
    })
    const report = (await parseLastJson(outputs)) as {
      human: unknown[]
      diagnostics: Array<{ status: string; total: number }>
      cost: { knownCostUsd: number }
    }
    expect(report.human).toHaveLength(4)
    expect(report.diagnostics).toHaveLength(8)
    expect(
      report.diagnostics.every((row) => row.status === 'succeeded'),
    ).toBe(true)
    expect(report.diagnostics.every((row) => row.total === 80)).toBe(true)
    expect(report.cost.knownCostUsd).toBeGreaterThan(0)
  })

  it('refuses a live run before the root exists and report before any ballot', async () => {
    const dir = await makeDir()
    const missing = join(dir, 'missing')
    const { outputs, write } = capture()
    await expect(
      createProgram(write, { makeGateway: makeFakeGateway }).parseAsync(
        ['eval', 'plan', missing],
        { from: 'user' },
      ),
    ).rejects.toThrow()
    await expect(
      createProgram(write, { makeGateway: makeFakeGateway }).parseAsync(
        ['eval', 'report', missing],
        { from: 'user' },
      ),
    ).rejects.toThrow()
  })

  it('rejects an invalid --model instead of silently choosing flash', async () => {
    const dir = await makeDir()
    const { write } = capture()
    await expect(
      createProgram(write, { makeGateway: makeFakeGateway }).parseAsync(
        ['eval', 'diagnose', join(dir, 'run'), '--model', 'gpt-4'],
        { from: 'user' },
      ),
    ).rejects.toThrowError(/choose --model flash or --model pro/)
  })
})

describe('deepSeekRoutingGateway routes each request to the wire model from metadata', () => {
  it('selects the respective DeepSeek wire model for Flash and Pro without any real network', async () => {
    const dir = await makeDir()
    const run = join(dir, 'run')
    const config = parseEvaluationConfig(
      structuredClone(configJson),
      join(dir, 'config.json'),
    )
    await new EvaluationStore(run).init(config)

    const wireBodies: Array<{ model: string }> = []
    const headers: string[] = []
    const fakeFetch: DeepSeekFetch = async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      const parsed = JSON.parse(
        String((init?.body as string | undefined) ?? '{}'),
      ) as { model: string }
      wireBodies.push(parsed)
      const authorization = (init?.headers as Record<string, string> | undefined)
        ?.Authorization
      headers.push(String(authorization ?? ''))
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-routing',
          choices: [
            {
              message: { content: '正文内容足够长，供路由测试使用。' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        }),
        { status: 200 },
      )
    }
    const gateway = deepSeekRoutingGateway(run, (_cfg, model) => {
      return new DeepSeekModelGateway({
        model,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        fetch: fakeFetch,
        lookupEnv: () => 'test-key',
      })
    })

    await gateway.generate({
      requestId: 'routing-flash',
      purpose: 'routing-test',
      system: '系统',
      prompt: '提示',
      metadata: { attemptId: 'routing-flash', model: 'deepseek-v4-flash' },
    })
    await gateway.generate({
      requestId: 'routing-pro',
      purpose: 'routing-test',
      system: '系统',
      prompt: '提示',
      metadata: { attemptId: 'routing-pro', model: 'deepseek-v4-pro' },
    })

    expect(wireBodies).toHaveLength(2)
    expect(wireBodies.map((body) => body.model)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
    expect(headers.every((authorization) => authorization === 'Bearer test-key')).toBe(true)
  })
})

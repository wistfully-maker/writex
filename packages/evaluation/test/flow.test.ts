import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  GenerationRequest,
  GenerationResult,
  GenerationUsage,
  ModelGateway,
} from '@writex/contracts'
import { qualityDimensions, type CandidateEvaluation } from '@writex/contracts'
import { defaultQualityGate } from '@writex/quality'
import {
  blindGroupIds,
  evaluationBallotSchemaVersion,
  type BlindGroupId,
  type BlindLabel,
  type DiagnosisResult,
  type EvaluationBallot,
} from '../src/contracts.js'
import {
  EvaluationStore,
  createBlindMapping,
  exportBlind,
  loadCandidateManuscript,
  mappingHash,
  readBlindMapping,
  readBallot,
  recordBallot,
  runDiagnosis,
  runEvaluation,
  sha256Hex,
  storePaths,
} from '../src/index.js'
import {
  cleanupRoots,
  makeConfig,
  makeRoot,
  type ConfigOverrides,
} from './helpers.js'

afterEach(cleanupRoots)

const draftPhrase = '共同的旧事压在沉默里'

class GenerationGateway implements ModelGateway {
  readonly requests: GenerationRequest[] = []

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(structuredClone(request))
    const text = `正文-${request.requestId}。${draftPhrase}。`
    return {
      requestId: request.requestId,
      provider: 'scripted',
      model: 'scripted-v1',
      text,
      usage: {
        inputTokens: request.system.length + request.prompt.length,
        outputTokens: text.length,
      },
      finishReason: 'stop',
    }
  }
}

async function initRun(
  overrides: ConfigOverrides = {},
): Promise<{ root: string; config: ReturnType<typeof makeConfig> }> {
  const root = await makeRoot()
  const config = makeConfig(overrides)
  await new EvaluationStore(root).init(config)
  return { root, config }
}

async function generateAll(
  root: string,
  overrides: ConfigOverrides = {},
): Promise<void> {
  const { config } = await initRun(overrides)
  const report = await runEvaluation(root, {
    live: true,
    gateway: new GenerationGateway(),
  })
  if (report.stoppedReason !== 'completed') {
    throw new Error(`generation did not complete: ${report.stoppedReason}`)
  }
  void config
}

function validDiagnosisJson(groupId: BlindGroupId, score = 80): string {
  const dimensions = {} as CandidateEvaluation['dimensions']
  for (const name of qualityDimensions) {
    dimensions[name] = {
      score,
      evidence: [draftPhrase],
      diagnosis: `关于${name}的诊断说明`,
      revisionInstruction: `针对${name}的修改指令`,
    }
  }
  const payload: Record<string, unknown> = {
    dimensions,
    vetoes: [],
  }
  if (groupId === 'continuity') {
    payload.continuityIssues = []
  }
  return JSON.stringify(payload)
}

class JsonGateway implements ModelGateway {
  readonly requests: GenerationRequest[] = []

  constructor(
    private readonly responses: ReadonlyMap<string, string | Error>,
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(structuredClone(request))
    const response = this.responses.get(request.requestId)
    if (response instanceof Error) {
      throw response
    }
    if (response === undefined) {
      throw new Error(`json gateway: no response for ${request.requestId}`)
    }
    return {
      requestId: request.requestId,
      provider: 'scripted-diag',
      model: 'scripted-diag-v1',
      text: response,
      usage: {
        inputTokens: 10,
        outputTokens: response.length,
      },
      finishReason: 'stop',
    }
  }
}

function allDiagnosisIds(): string[] {
  const ids: string[] = []
  for (const groupId of blindGroupIds) {
    for (const label of ['A', 'B'] as const) {
      ids.push(`${groupId}-${label.toLowerCase()}`)
    }
  }
  return ids
}

function diagnosisResponses(
  override: Partial<Record<string, string | Error>> = {},
): Map<string, string | Error> {
  const map = new Map<string, string | Error>()
  for (const groupId of blindGroupIds) {
    for (const label of ['A', 'B'] as const) {
      const id = `${groupId}-${label.toLowerCase()}`
      map.set(id, validDiagnosisJson(groupId))
    }
  }
  for (const [id, value] of Object.entries(override)) {
    if (value === undefined) {
      continue
    }
    map.set(id, value)
  }
  return map
}

/** Shape of the exported ballot template (bound to the run's four hashes). */
interface TemplateBallot {
  schemaVersion: number
  configHash: string
  fixtureHash: string
  mappingHash: string
  artifactsHash: string
  choices: Record<string, { choice: string | null; reason: string }>
}

async function readExportedTemplate(root: string): Promise<TemplateBallot> {
  const templatePath = storePaths(root).ballotPath.replace(
    'ballot.json',
    'ballot.template.json',
  )
  return JSON.parse(await readFile(templatePath, 'utf8')) as TemplateBallot
}

async function ballotFor(root: string): Promise<EvaluationBallot> {
  const template = await readExportedTemplate(root)
  for (const entry of Object.values(template.choices)) {
    entry.choice = 'A'
  }
  return recordBallot(root, template)
}

describe('blind mapping and exports', () => {
  it('creates a frozen per-group A/B mapping reused by later calls', async () => {
    const { root } = await initRun()
    const first = await createBlindMapping(root, {
      random: () => 0.42,
      now: () => '2026-09-07T00:00:00.000Z',
    })
    for (const groupId of blindGroupIds) {
      const assignment = first.groups[groupId]
      expect(new Set([assignment.A, assignment.B])).toEqual(
        new Set(['deepseek-v4-flash', 'deepseek-v4-pro']),
      )
    }
    // A second call with a different random source reuses the persisted map.
    const second = await createBlindMapping(root, {
      random: () => 0.99,
      now: () => '2026-09-08T00:00:00.000Z',
    })
    expect(second).toEqual(first)
    expect(second.createdAt).toBe('2026-09-07T00:00:00.000Z')
    const mappingText = await readFile(storePaths(root).blindMappingPath, 'utf8')
    expect(mappingText).toContain('deepseek-v4-')
  })

  it('exports blind markdown with zero model leakage once all drafts succeed', async () => {
    const root = await makeRoot()
    const config = makeConfig()
    await new EvaluationStore(root).init(config)
    // Missing outputs block the export.
    await expect(exportBlind(root)).rejects.toThrowError(/not the exact twelve/)

    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    const summary = await exportBlind(root)
    expect(summary.exports).toHaveLength(4)
    const ballotTemplate = await readFile(
      summary.ballotTemplatePath,
      'utf8',
    )
    for (const groupId of blindGroupIds) {
      expect(ballotTemplate).toContain(groupId)
    }
    for (const path of summary.exports) {
      const text = await readFile(path, 'utf8')
      expect(text).not.toContain('deepseek-v4-flash')
      expect(text).not.toContain('deepseek-v4-pro')
      expect(text).toContain('候选 A')
      expect(text).toContain('候选 B')
      expect(text).toContain(draftPhrase)
    }
    // Continuity exports contain all three segments under each label.
    const continuity = await readFile(
      join(storePaths(root).blindExportDir, 'continuity.md'),
      'utf8',
    )
    expect(continuity.split('第 1 段')).toHaveLength(3)
    expect(continuity.split('第 3 段')).toHaveLength(3)
  })

  it('loads candidate manuscripts from mapping-bound outputs', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    const mapping = await readBlindMapping(root)
    for (const groupId of blindGroupIds) {
      const manuscript = await loadCandidateManuscript(root, groupId, 'A')
      expect(manuscript.model).toBe(mapping.groups[groupId].A)
      const expectedSegments = groupId === 'continuity' ? 3 : 1
      expect(manuscript.segments).toHaveLength(expectedSegments)
      expect(manuscript.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('ballot recording', () => {
  it('records a complete ballot from the exported template and refuses bad input', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    const mapping = await readBlindMapping(root)

    // Votes are recorded from the exported template: fill every choice.
    const template = await readExportedTemplate(root)
    for (const groupId of blindGroupIds) {
      template.choices[groupId] = { choice: 'tie', reason: `并列：${groupId}` }
    }
    const recorded = await recordBallot(root, template)
    expect(recorded.choices.reunion.choice).toBe('tie')
    const reread = await readBallot(root)
    expect(reread.mappingHash).toBe(mappingHash(mapping))
    expect(reread.configHash).toBe(mapping.configHash)
    expect(reread.artifactsHash).toBe(template.artifactsHash)

    // Missing group, invalid choice and unknown group are refused.
    const missingGroup = structuredClone(template)
    delete (missingGroup as { choices: Record<string, unknown> }).choices['reunion']
    await expect(recordBallot(root, missingGroup)).rejects.toThrowError(
      /missing group choices/,
    )
    await expect(
      recordBallot(root, {
        ...template,
        choices: {
          ...template.choices,
          reunion: { choice: 'maybe', reason: '' },
        },
      }),
    ).rejects.toThrowError(/A, B, tie, neither/)
    await expect(
      recordBallot(root, {
        ...template,
        choices: { ...template.choices, extraGroup: { choice: 'A' } },
      }),
    ).rejects.toThrowError(/unknown group/)
  })

  it('refuses a ballot before the blind mapping exists', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    const choices = {} as Record<string, unknown>
    for (const groupId of blindGroupIds) {
      choices[groupId] = { choice: 'A' }
    }
    await expect(
      recordBallot(root, { schemaVersion: 1, choices }),
    ).rejects.toThrow()
  })
})

describe('ballot binding and tamper resistance', () => {
  async function exportedRunRoot(): Promise<string> {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    return root
  }

  it('rejects the unchanged exported ballot template until every choice is filled', async () => {
    const root = await exportedRunRoot()
    const templatePath = storePaths(root).ballotPath.replace(
      'ballot.json',
      'ballot.template.json',
    )
    const template = JSON.parse(await readFile(templatePath, 'utf8'))
    // Export summary carries no mapping; the template carries every binding.
    expect(template.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(template.fixtureHash).toMatch(/^[0-9a-f]{64}$/)
    expect(template.mappingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(template.artifactsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(template.choices.reunion.choice).toBeNull()

    // Unchanged template (empty choices) must be rejected.
    await expect(recordBallot(root, template)).rejects.toThrowError(
      /requires an explicit human selection/,
    )

    // Filling every group makes the SAME exported template votable.
    for (const groupId of blindGroupIds) {
      template.choices[groupId].choice = 'A'
    }
    const ballot = await recordBallot(root, template)
    expect(ballot.artifactsHash).toBe(template.artifactsHash)
  })

  it('requires every binding hash on an external ballot (missing hash rejected)', async () => {
    const root = await exportedRunRoot()
    const template = await readExportedTemplate(root)
    for (const entry of Object.values(template.choices)) {
      entry.choice = 'A'
    }
    const withoutConfig = { ...template } as Partial<TemplateBallot>
    delete withoutConfig.configHash
    await expect(recordBallot(root, withoutConfig)).rejects.toThrowError(
      /configHash is required/,
    )
    const withoutArtifacts = { ...template } as Partial<TemplateBallot>
    delete withoutArtifacts.artifactsHash
    await expect(recordBallot(root, withoutArtifacts)).rejects.toThrowError(
      /artifactsHash is required/,
    )
    const withoutMapping = { ...template } as Partial<TemplateBallot>
    delete withoutMapping.mappingHash
    await expect(recordBallot(root, withoutMapping)).rejects.toThrowError(
      /mappingHash is required/,
    )
    // With every hash intact the same ballot records fine.
    await expect(recordBallot(root, template)).resolves.toMatchObject({
      mappingHash: template.mappingHash,
    })
  })

  it('readBallot and diagnosis reject manuscripts modified after the ballot', async () => {
    const root = await exportedRunRoot()
    await ballotFor(root)

    const outputPath = storePaths(root).outputsDir + '/flash-reunion.txt'
    await writeFile(outputPath, '篡改后的正文内容\n', 'utf8')

    await expect(readBallot(root)).rejects.toThrowError(/manuscript outputs changed/)
    await expect(runDiagnosis(root, { live: false })).rejects.toThrowError(
      /manuscript outputs changed/,
    )
  })

  it('preserves a corrupted blind mapping and fails closed instead of re-randomizing', async () => {
    const root = await exportedRunRoot()
    const mappingPath = storePaths(root).blindMappingPath
    await writeFile(mappingPath, '{"broken": true', 'utf8')

    await expect(createBlindMapping(root)).rejects.toThrowError(
      /cannot reuse existing blind mapping/,
    )
    await expect(exportBlind(root)).rejects.toThrowError(
      /cannot reuse existing blind mapping/,
    )
    // The corrupted file is never overwritten or auto-repaired.
    await expect(readFile(mappingPath, 'utf8')).resolves.toContain('"broken"')
  })

  it('reports prior uncertain call costs as unknown even after a successful retry', async () => {
    const root = await exportedRunRoot()
    await ballotFor(root)
    const store = new EvaluationStore(root)
    const stamp = '2026-09-07T02:00:00.000Z'
    const current = await store.readAttempt('flash-reunion')
    const firstReserve = (current.reservedUsd ?? 0) / 2
    const secondReserve = (current.reservedUsd ?? 0) - firstReserve
    // Simulate: an earlier crashed call (uncertain, charge unknown) followed
    // by a successful retry that reported its own usage.
    await store.writeAttempt({
      ...current,
      status: 'succeeded',
      reservedUsd: firstReserve + secondReserve,
      attemptCalls: [
        {
          seq: 1,
          status: 'uncertain',
          startedAt: stamp,
          finishedAt: stamp,
          reservedUsd: firstReserve,
          failure: null,
          usage: null,
          costUsd: null,
          costUnknown: true,
          responseId: null,
          responseModel: null,
          finishReason: null,
        },
        {
          seq: 2,
          status: 'succeeded',
          startedAt: stamp,
          finishedAt: stamp,
          reservedUsd: secondReserve,
          failure: null,
          usage: current.usage,
          costUsd: current.costUsd,
          costUnknown: current.costUnknown,
          responseId: current.responseId,
          responseModel: current.responseModel,
          finishReason: current.finishReason,
        },
      ],
    })

    const { buildEvaluationReport } = await import('../src/index.js')
    const report = await buildEvaluationReport(root)
    // The final call's cost is known, the crashed call's is unknown, and the
    // succeeded attempt still retains the historical uncertain call's reserve
    // (that charge may have been billed server-side).
    expect(report.cost.generationKnownCostUsd).toBeGreaterThan(0)
    expect(report.cost.generationUnknownCount).toBeGreaterThanOrEqual(1)
    expect(report.cost.unknownTotalDisclosed).toBe(true)
    expect(report.cost.reservedUsd).toBe(firstReserve)
  })
})

describe('diagnosis lifecycle', () => {
  it('refuses diagnosis until a ballot is recorded (dry and live)', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    await expect(runDiagnosis(root, { live: false })).rejects.toThrowError(
      /no ballot recorded/,
    )
    await expect(
      runDiagnosis(root, { live: true, gateway: new JsonGateway(new Map()) }),
    ).rejects.toThrowError(/no ballot recorded/)
  })

  it('runs exactly eight diagnostics, persists results, and validates them', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    await ballotFor(root)

    const dry = await runDiagnosis(root, { live: false })
    expect(dry.gatewayCalls).toBe(0)
    expect(dry.candidates).toHaveLength(8)
    expect(dry.candidates.every((candidate) => candidate.status === 'pending')).toBe(true)
    // Dry planning reports REAL per-call reserve estimates (not zeros).
    expect(
      dry.candidates.every((candidate) => candidate.reservedUsd > 0),
    ).toBe(true)

    const gateway = new JsonGateway(diagnosisResponses())
    const summary = await runDiagnosis(root, {
      live: true,
      gateway,
      model: 'deepseek-v4-pro',
    })
    expect(summary.gatewayCalls).toBe(8)
    expect(summary.stoppedReason).toBe('completed')
    expect(summary.candidates.every((candidate) => candidate.status === 'succeeded')).toBe(true)
    expect(
      gateway.requests.every((request) => request.metadata.model === 'deepseek-v4-pro'),
    ).toBe(true)

    const store = new EvaluationStore(root)
    const diagnoses = await store.listDiagnoses()
    expect(diagnoses).toHaveLength(8)
    for (const diagnosis of diagnoses) {
      expect(diagnosis.resultHash).toMatch(/^[0-9a-f]{64}$/)
      expect(diagnosis.costUnknown).toBe(false)
      expect(diagnosis.status).toBe('succeeded')
      const result = await store.readDiagnosisResult(diagnosis.diagnosisId)
      expect(result.sourceHash).toBe(diagnosis.sourceHash)
      for (const name of qualityDimensions) {
        expect(result.evaluation.dimensions[name].score).toBe(80)
        expect(result.evaluation.dimensions[name].evidence[0]).toBe(draftPhrase)
      }
      if (diagnosis.groupId === 'continuity') {
        expect(result.continuityIssues).toEqual([])
      }
    }

    // A second live run never regenerates succeeded diagnostics.
    const again = await runDiagnosis(root, {
      live: true,
      gateway: new JsonGateway(new Map()),
    })
    expect(again.gatewayCalls).toBe(0)
  })

  it('records an invalid diagnostic as failure without fabricating evidence or scores', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    await ballotFor(root)

    const fakeQuotes = JSON.stringify({
      dimensions: (() => {
        const dims = {} as Record<string, unknown>
        for (const name of qualityDimensions) {
          dims[name] = {
            score: 80,
            evidence: ['这段引用在稿中并不存在'],
            diagnosis: 'd',
            revisionInstruction: 'r',
          }
        }
        return dims
      })(),
      vetoes: [],
    })
    const invalidJson = '这不是 JSON'
    const summary = await runDiagnosis(root, {
      live: true,
      gateway: new JsonGateway(
        diagnosisResponses({
          'reunion-a': fakeQuotes,
          'reunion-b': invalidJson,
        }),
      ),
    })
    const byId = new Map(summary.candidates.map((c) => [c.diagnosisId, c]))
    expect(byId.get('reunion-a')?.status).toBe('failed')
    expect(byId.get('reunion-a')?.failureKind).toBe('invalid-response')
    expect(byId.get('reunion-b')?.status).toBe('failed')
    expect(byId.get('reunion-b')?.failureKind).toBe('invalid-response')
    // The other six still diagnosed and nothing was auto-retried.
    expect(
      summary.candidates.filter((c) => c.status === 'succeeded'),
    ).toHaveLength(6)
    const store = new EvaluationStore(root)
    const failed = await store.readDiagnosis('reunion-a')
    expect(failed.failure?.message).toContain('not a verbatim quote')
    // Failed diagnostics never produce a result file or a zero score.
    await expect(store.readDiagnosisResult('reunion-a')).rejects.toThrow()
  })

  it('diagnosis retries preserve per-call history and clear the active error', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    await ballotFor(root)

    const firstResponses = diagnosisResponses({
      'reunion-a': '这不是合法 JSON',
    })
    const first = await runDiagnosis(root, {
      live: true,
      gateway: new JsonGateway(firstResponses),
      retryFailed: false,
    })
    expect(
      first.candidates.find((c) => c.diagnosisId === 'reunion-a')?.status,
    ).toBe('failed')

    // Retrying an already-attempted diagnosis with a DIFFERENT judge model
    // must be rejected instead of mislabeling the earlier call.
    await expect(
      runDiagnosis(root, {
        live: true,
        gateway: new JsonGateway(diagnosisResponses()),
        model: 'deepseek-v4-pro',
        retryFailed: true,
      }),
    ).rejects.toThrowError(/judge mismatch|same --model/)

    const retryResponses = diagnosisResponses({
      'reunion-a': validDiagnosisJson('reunion'),
    })
    const retry = await runDiagnosis(root, {
      live: true,
      gateway: new JsonGateway(retryResponses),
      retryFailed: true,
    })
    expect(retry.gatewayCalls).toBe(1)
    const store = new EvaluationStore(root)
    const finalRecord = await store.readDiagnosis('reunion-a')
    expect(finalRecord.status).toBe('succeeded')
    expect(finalRecord.failure).toBeNull()
    // Per-call history preserved: one failed call then one successful retry.
    expect(finalRecord.attemptCalls).toHaveLength(2)
    expect(finalRecord.attemptCalls?.[0]?.status).toBe('failed')
    expect(finalRecord.attemptCalls?.[1]?.status).toBe('succeeded')
    expect(finalRecord.attemptCalls?.[1]?.reservedUsd).toBeGreaterThan(0)
    expect(finalRecord.reservedUsd).toBeGreaterThan(
      finalRecord.attemptCalls?.[1]?.reservedUsd ?? 0,
    )
  })

  it('shares the generation budget: diagnosis reserves count against the same cap', async () => {
    const root = await makeRoot()
    const config = makeConfig({ budgetUsd: 100 })
    await new EvaluationStore(root).init(config)
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    await ballotFor(root)

    const store = new EvaluationStore(root)
    // Simulate prior spending by editing a retained reserve upward.
    const reunion = await store.readAttempt('flash-reunion')
    await store.writeAttempt({ ...reunion, reservedUsd: 99.999 })

    const summary = await runDiagnosis(root, {
      live: true,
      gateway: new JsonGateway(diagnosisResponses()),
    })
    expect(summary.gatewayCalls).toBe(0)
    expect(summary.stoppedReason).toBe('budget')
  })
})

describe('reveal report', () => {
  async function fullFlowRoot(): Promise<string> {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    await ballotFor(root)
    await runDiagnosis(root, {
      live: true,
      gateway: new JsonGateway(diagnosisResponses()),
    })
    return root
  }

  it('refuses to reveal before the human ballot is recorded', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    const { buildEvaluationReport } = await import('../src/index.js')
    await expect(buildEvaluationReport(root)).rejects.toThrowError(
      /no ballot recorded/,
    )
  })

  it('reports human decisions, scored diagnostics, reveal and cost after the ballot', async () => {
    const root = await fullFlowRoot()
    const { buildEvaluationReport, renderEvaluationReport } = await import('../src/index.js')
    const mapping = await readBlindMapping(root)
    const ballot = await readBallot(root)
    const report = await buildEvaluationReport(root)
    expect(report.human).toHaveLength(4)
    expect(report.diagnostics).toHaveLength(8)
    for (const row of report.diagnostics) {
      expect(row.status).toBe('succeeded')
      expect(row.total).toBe(80)
      expect(row.passed).toBe(true)
      expect(row.model).toBe(mapping.groups[row.groupId][row.label as BlindLabel])
      // Judge model comes from the persisted record (Flash by default here),
      // and every dimension is surfaced for review.
      expect(row.judgeModel).toBe('deepseek-v4-flash')
      expect(row.resultVerified).toBe(true)
      expect(row.dimensions).toHaveLength(5)
      for (const dimension of row.dimensions) {
        expect(dimension.score).toBe(80)
        expect(dimension.evidence).toContain(draftPhrase)
        expect(dimension.diagnosis).toBeTruthy()
        expect(dimension.revisionInstruction).toBeTruthy()
      }
    }
    expect(report.cost.generationKnownCostUsd).toBeGreaterThan(0)
    expect(report.cost.knownCostUsd).toBeGreaterThan(0)
    expect(report.cost.unknownTotalDisclosed).toBe(false)
    expect(report.ballot).toEqual(ballot)

    const text = renderEvaluationReport(report)
    expect(text).toContain('揭盲')
    expect(text).toContain('deepseek-v4-flash')
    expect(text).toContain('通过')
    expect(text).toContain('同厂商裁判偏差')
    expect(text).toContain('永恒情感')
    expect(text).toContain('证据引用')
    expect(text).toContain('裁判模型')
  })

  it('keeps human results when no diagnosis is available', async () => {
    const root = await makeRoot()
    await new EvaluationStore(root).init(makeConfig())
    await runEvaluation(root, { live: true, gateway: new GenerationGateway() })
    await exportBlind(root)
    await ballotFor(root)
    const { buildEvaluationReport } = await import('../src/index.js')
    const report = await buildEvaluationReport(root)
    expect(report.diagnostics).toHaveLength(8)
    expect(report.diagnostics.every((row) => row.status === 'pending')).toBe(true)
    expect(report.human[0]?.choice).toBe('A')
    expect(report.cost.generationKnownCostUsd).toBeGreaterThan(0)
  })

  it('re-weights persisted scores through a different gate with zero model calls', async () => {
    const root = await fullFlowRoot()
    const { buildEvaluationReport } = await import('../src/index.js')
    const weightedGate = {
      scale: 100 as const,
      dimensions: {
        eternal_emotion: { weight: 0.05, minimum: 0 },
        fresh_situation: { weight: 0.05, minimum: 0 },
        difficult_choice: { weight: 0.05, minimum: 0 },
        character_truth: { weight: 0.8, minimum: 0 },
        narrative_control: { weight: 0.05, minimum: 0 },
      },
      passing: {
        minimumTotal: 0,
        requireEveryDimension: true,
        maxRevisionRounds: 0,
      },
    }
    const reportDefault = await buildEvaluationReport(root)
    const reportReweighted = await buildEvaluationReport(root, {
      gate: weightedGate,
    })
    // All dimensions scored 80 so an extreme weight on one dimension keeps
    // the total at 80; proving the gate flows through scoring. Use per-group
    // differing scores to observe a change: rewrite one stored result as a
    // legitimate re-persist (file + record resultHash updated together) so
    // report verification still passes.
    const store = new EvaluationStore(root)
    const result = await store.readDiagnosisResult('reunion-a')
    const dimensions = {} as CandidateEvaluation['dimensions']
    for (const [index, name] of qualityDimensions.entries()) {
      dimensions[name] = {
        ...result.evaluation.dimensions[name],
        score: [100, 100, 100, 100, 10][index] ?? 100,
      }
    }
    const rewritten: DiagnosisResult = {
      ...result,
      evaluation: { dimensions, vetoes: [] },
    }
    const rewrittenText = `${JSON.stringify(rewritten, null, 2)}\n`
    await store.writeDiagnosisResult(rewritten)
    const record = await store.readDiagnosis('reunion-a')
    await store.writeDiagnosis({
      ...record,
      resultHash: sha256Hex(rewrittenText),
    })
    const reportAfter = await buildEvaluationReport(root)
    const reweightedAfter = await buildEvaluationReport(root, {
      gate: weightedGate,
    })
    const rowDefault = reportAfter.diagnostics.find(
      (row) => row.diagnosisId === 'reunion-a',
    )
    const rowWeighted = reweightedAfter.diagnostics.find(
      (row) => row.diagnosisId === 'reunion-a',
    )
    expect(rowDefault?.resultVerified).toBe(true)
    expect(rowDefault?.total).not.toBe(rowWeighted?.total)
    expect(rowDefault?.total).not.toBeNull()
    void reportDefault
    void reportReweighted
  })

  it('marks a tampered diagnosis result as unavailable instead of scoring it', async () => {
    const root = await fullFlowRoot()
    const store = new EvaluationStore(root)
    const resultPath = join(storePaths(root).diagnosesDir, 'reunion-a.result.json')
    const original = await readFile(resultPath, 'utf8')
    await writeFile(resultPath, `${original}\n"tampered": true}`, 'utf8')

    const { buildEvaluationReport, renderEvaluationReport } = await import('../src/index.js')
    const report = await buildEvaluationReport(root)
    const row = report.diagnostics.find((d) => d.diagnosisId === 'reunion-a')
    expect(row?.status).toBe('succeeded')
    expect(row?.resultVerified).toBe(false)
    expect(row?.total).toBeNull()
    expect(row?.dimensions[0]?.score).toBeNull()
    const text = renderEvaluationReport(report)
    expect(text).toContain('结果校验失败')
    // Other candidates are unaffected and still scored.
    const healthy = report.diagnostics.find((d) => d.diagnosisId === 'reunion-b')
    expect(healthy?.resultVerified).toBe(true)
    expect(healthy?.total).toBe(80)
  })
})

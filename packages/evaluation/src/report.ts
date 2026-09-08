import type { QualityGateConfig, QualityDimension } from '@writex/contracts'
import {
  defaultQualityGate,
  scoreQuality,
  validateQualityGateConfig,
} from '@writex/quality'
import { qualityDimensions } from '@writex/contracts'
import {
  blindGroupIds,
  type AttemptCallRecord,
  type BallotChoice,
  type BlindGroupId,
  type BlindLabel,
  type BlindMapping,
  type ContinuityIssue,
  type DiagnosisResult,
  type EvaluationBallot,
  type PersistedAttempt,
  type PersistedDiagnosis,
} from './contracts.js'
import { sha256Hex } from './fixtures.js'
import { loadCandidateManuscript, readBlindMapping } from './blind.js'
import { readBallot } from './ballot.js'
import { EvaluationStore } from './store.js'

/** Quality gate loaded from an external JSON file, fully validated. */
export function parseQualityGate(
  value: unknown,
  source: string,
): QualityGateConfig {
  const candidate = value as QualityGateConfig
  try {
    validateQualityGateConfig(candidate)
  } catch (error) {
    throw new Error(
      `${source}: ${error instanceof Error ? error.message : 'invalid quality gate'}`,
    )
  }
  return candidate
}

const groupTitles: Record<BlindGroupId, string> = {
  reunion: '重逢',
  'costly-choice': '选择',
  'limited-reveal': '有限视角揭示',
  continuity: '连续续写',
}

const dimensionTitles: Record<QualityDimension, string> = {
  eternal_emotion: '永恒情感',
  fresh_situation: '新鲜处境',
  difficult_choice: '艰难选择',
  character_truth: '人物真实性',
  narrative_control: '叙事控制',
}

/** One of the five diagnosis dimensions, fully surfaced for review. */
export interface DiagnosticDimensionRow {
  name: QualityDimension
  title: string
  score: number | null
  evidence: string[]
  diagnosis: string | null
  revisionInstruction: string | null
}

export interface HumanDecisionRow {
  groupId: BlindGroupId
  title: string
  choice: BallotChoice
  reason: string | null
  reveal: Record<BlindLabel, string>
}

export interface DiagnosticRow {
  diagnosisId: string
  groupId: BlindGroupId
  label: BlindLabel
  /** Candidate model — only shown at reveal (this report is post-ballot). */
  model: string
  /** Actual judge model from the persisted diagnosis record/result. */
  judgeModel: string
  status: PersistedDiagnosis['status']
  failureKind: string | null
  total: number | null
  passed: boolean | null
  vetoes: string[]
  failedDimensions: string[]
  continuityIssues: ContinuityIssue[]
  sourceHash: string | null
  /**
   * True only when the persisted result file re-verifies against its stored
   * hash AND the record metadata/source hash/current manuscript. A tampered
   * or unverifiable result is never scored.
   */
  resultVerified: boolean
  dimensions: DiagnosticDimensionRow[]
}

export interface CostSummary {
  generationKnownCostUsd: number
  generationUnknownCount: number
  diagnosisKnownCostUsd: number
  diagnosisUnknownCount: number
  knownCostUsd: number
  reservedUsd: number
  spentEstimateUsd: number
  unknownTotalDisclosed: boolean
}

export interface EvaluationReportData {
  root: string
  ballot: EvaluationBallot
  mapping: BlindMapping
  human: HumanDecisionRow[]
  diagnostics: DiagnosticRow[]
  cost: CostSummary
  gate: QualityGateConfig
  caveats: string[]
}

interface CostedItem {
  status: string
  costUsd: number | null
  costUnknown: boolean
  reservedUsd: number
  attemptCalls?: AttemptCallRecord[]
}

/** Known cost + unknown-cost flag from per-call history (calls win). */
function itemCostBreakdown(item: CostedItem): { known: number; unknown: boolean } {
  const calls = item.attemptCalls ?? []
  if (calls.length > 0) {
    let known = 0
    let unknown = false
    for (const call of calls) {
      if (call.costUnknown || call.costUsd === null) {
        unknown = true
      } else {
        known += call.costUsd
      }
    }
    return { known, unknown }
  }
  return {
    known: item.costUsd ?? 0,
    unknown: item.costUnknown || item.costUsd === null,
  }
}

/**
 * Reserve still retained after a report: every non-succeeded item keeps its
 * full reserve; a succeeded item keeps reserves from HISTORICAL calls whose
 * charge stayed unknown (they may still have been billed server-side).
 */
function itemRetainedReserve(item: CostedItem): number {
  if (item.status !== 'succeeded') {
    return item.reservedUsd
  }
  const calls = item.attemptCalls ?? []
  if (calls.length > 0) {
    return calls.reduce(
      (sum, call) =>
        call.costUnknown || call.costUsd === null
          ? sum + call.reservedUsd
          : sum,
      0,
    )
  }
  return item.costUnknown || item.costUsd === null ? item.reservedUsd : 0
}

function emptyDimensions(): DiagnosticDimensionRow[] {
  return qualityDimensions.map((name) => ({
    name,
    title: dimensionTitles[name],
    score: null,
    evidence: [],
    diagnosis: null,
    revisionInstruction: null,
  }))
}

/**
 * Re-verify a persisted successful diagnosis before trusting it: the result
 * file must hash to the stored resultHash, its metadata must match the
 * record, and its source hash must equal both the record's and the CURRENT
 * manuscript the candidate exports. Anything that fails returns null and the
 * row is reported invalid/unavailable instead of being scored.
 */
async function verifiedDiagnosisResult(
  store: EvaluationStore,
  record: PersistedDiagnosis,
  groupId: BlindGroupId,
  label: BlindLabel,
  currentSourceHash: string,
): Promise<DiagnosisResult | null> {
  if (record.status !== 'succeeded' || record.resultHash === null) {
    return null
  }
  try {
    const text = await store.readDiagnosisResultText(record.diagnosisId)
    if (sha256Hex(text) !== record.resultHash) {
      return null
    }
    const parsed = await store.readDiagnosisResult(record.diagnosisId)
    if (
      parsed.diagnosisId !== record.diagnosisId ||
      parsed.groupId !== groupId ||
      parsed.label !== label ||
      parsed.model !== record.model ||
      parsed.sourceHash !== record.sourceHash ||
      record.sourceHash !== currentSourceHash
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Build the reveal report. Requires a recorded, complete human ballot; the
 * model mapping is revealed only here, after diagnosis. Diagnostics are
 * optional: their validated scores are re-weighted through the provided gate
 * with zero model calls, and their absence never changes the human results.
 */
export async function buildEvaluationReport(
  root: string,
  options: { gate?: QualityGateConfig } = {},
): Promise<EvaluationReportData> {
  const store = new EvaluationStore(root)
  const state = await store.readState()
  const ballot = await readBallot(root)
  const mapping = await readBlindMapping(root)
  const gate = options.gate ?? defaultQualityGate

  const attempts = await store.listAttempts()
  const diagnoses = await store.listDiagnoses()

  const human: HumanDecisionRow[] = []
  for (const groupId of blindGroupIds) {
    const entry = ballot.choices[groupId]
    human.push({
      groupId,
      title: groupTitles[groupId],
      choice: entry.choice,
      reason: entry.reason ?? null,
      reveal: {
        A: mapping.groups[groupId].A,
        B: mapping.groups[groupId].B,
      },
    })
  }

  const diagnostics: DiagnosticRow[] = []
  for (const groupId of blindGroupIds) {
    for (const label of ['A', 'B'] as const) {
      const diagnosisId = `${groupId}-${label.toLowerCase()}`
      const record = diagnoses.find((d) => d.diagnosisId === diagnosisId)
      const candidateModel = mapping.groups[groupId][label]
      const rowBase = {
        diagnosisId,
        groupId,
        label,
        model: candidateModel,
      }
      if (record === undefined) {
        diagnostics.push({
          ...rowBase,
          judgeModel: '',
          status: 'pending',
          failureKind: null,
          total: null,
          passed: null,
          vetoes: [],
          failedDimensions: [],
          continuityIssues: [],
          sourceHash: null,
          resultVerified: false,
          dimensions: emptyDimensions(),
        })
        continue
      }
      // Current manuscript hash binds the result to what is exported today.
      let currentSourceHash: string | null = null
      try {
        const manuscript = await loadCandidateManuscript(root, groupId, label)
        currentSourceHash = manuscript.sourceHash
      } catch {
        currentSourceHash = null
      }
      const result =
        currentSourceHash === null
          ? null
          : await verifiedDiagnosisResult(
              store,
              record,
              groupId,
              label,
              currentSourceHash,
            )
      const verified = result !== null
      let total: number | null = null
      let passed: boolean | null = null
      let vetoes: string[] = []
      let failedDimensions: string[] = []
      let continuityIssues: ContinuityIssue[] = []
      let dimensions = emptyDimensions()
      if (verified && result !== null) {
        const decision = scoreQuality(result.evaluation, gate)
        total = decision.total
        passed = decision.passed
        vetoes = decision.vetoes
        failedDimensions = decision.failedDimensions
        continuityIssues = result.continuityIssues
        dimensions = qualityDimensions.map((name) => {
          const evaluation = result.evaluation.dimensions[name]
          return {
            name,
            title: dimensionTitles[name],
            score: evaluation.score,
            evidence: [...evaluation.evidence],
            diagnosis: evaluation.diagnosis,
            revisionInstruction: evaluation.revisionInstruction,
          }
        })
      }
      diagnostics.push({
        ...rowBase,
        judgeModel: (verified ? result?.model : null) ?? record.model,
        status: record.status,
        failureKind: record.failure?.kind ?? null,
        total,
        passed,
        vetoes,
        failedDimensions,
        continuityIssues,
        sourceHash: record.sourceHash,
        resultVerified: verified,
        dimensions,
      })
    }
  }

  let generationKnownCostUsd = 0
  let generationUnknownCount = 0
  for (const attempt of attempts) {
    const breakdown = itemCostBreakdown(attempt)
    generationKnownCostUsd += breakdown.known
    if (breakdown.unknown) {
      generationUnknownCount += 1
    }
  }
  let diagnosisKnownCostUsd = 0
  let diagnosisUnknownCount = 0
  for (const diagnosis of diagnoses) {
    const breakdown = itemCostBreakdown(diagnosis)
    diagnosisKnownCostUsd += breakdown.known
    if (breakdown.unknown) {
      diagnosisUnknownCount += 1
    }
  }
  const reservedUsd =
    attempts.reduce(
      (sum, attempt) => sum + itemRetainedReserve(attempt),
      0,
    ) +
    diagnoses.reduce(
      (sum, diagnosis) => sum + itemRetainedReserve(diagnosis),
      0,
    )
  const knownCostUsd = generationKnownCostUsd + diagnosisKnownCostUsd
  const spentEstimateUsd = knownCostUsd + reservedUsd

  const caveats = [
    '模型映射仅在人工盲选与诊断完成后的本报告中揭示；盲选导出文件不含任何模型、价格或延迟信息。',
    '诊断模型与生成模型同属 DeepSeek（默认诊断模型为 deepseek-v4-flash），存在同厂商裁判偏差的可能；自动分数只是诊断证据，不替代人工选择。',
    '每题每模型仅一个样本（共 12 篇正文），样本量小，结论不能外推为长篇能力或投稿质量。',
    '费用为按上报用量与配置价格表估算的结果，非计费账单；未知用量与价格一律披露为未知，不当作零；历史不确定调用的预留额在报告中保留。',
    '诊断结果仅在重校验通过（文件哈希/元数据/稿件哈希一致）后才计入报告；被篡改或无法校验的结果标注为不可用，不会被悄悄计分。',
    '生成与诊断共用同一预算；失败的生成/诊断项需显式 --retry-failed 才会重试，成功结果从不自动重跑。',
  ]

  return {
    root,
    ballot,
    mapping,
    human,
    diagnostics,
    cost: {
      generationKnownCostUsd,
      generationUnknownCount,
      diagnosisKnownCostUsd,
      diagnosisUnknownCount,
      knownCostUsd,
      reservedUsd,
      spentEstimateUsd,
      unknownTotalDisclosed:
        generationUnknownCount > 0 || diagnosisUnknownCount > 0,
    },
    gate,
    caveats,
  }
}

function humanChoiceLabel(
  choice: BallotChoice,
  reveal: Record<BlindLabel, string>,
): string {
  if (choice === 'tie') return '并列'
  if (choice === 'neither') return '全部不合格'
  return `候选 ${choice}（${reveal[choice]}）`
}

function renderRowDetails(lines: string[], row: DiagnosticRow): void {
  lines.push(`### 候选 ${row.label} — ${groupTitles[row.groupId]}`)
  lines.push('')
  if (row.status !== 'succeeded') {
    lines.push(
      `状态：${row.status}${row.failureKind ? `（${row.failureKind}）` : ''}；该候选暂无可用诊断。`,
    )
    lines.push('')
    return
  }
  lines.push(`- 生成模型（揭盲）：${row.model}；裁判模型：${row.judgeModel || '未知'}`)
  if (!row.resultVerified) {
    lines.push(
      '- 结果校验失败或不可用（文件哈希/元数据/稿件不一致），自动分数不显示，人工结果不受影响。',
    )
    lines.push('')
    return
  }
  const passLabel =
    row.passed === null
      ? '—'
      : row.passed
        ? '通过'
        : '未过'
  const vetoText = row.vetoes.length > 0 ? row.vetoes.join('；') : '无'
  const failedText =
    row.failedDimensions.length > 0
      ? `（未达门槛维度：${row.failedDimensions.join(', ')}）`
      : ''
  lines.push(`- 加权总分：${row.total}（${passLabel}）${failedText}；否决：${vetoText}`)
  for (const dimension of row.dimensions) {
    if (dimension.score === null) {
      continue
    }
    lines.push(`- ${dimension.title}：${dimension.score}`)
    if (dimension.evidence.length > 0) {
      lines.push(`  - 证据引用：${dimension.evidence.map((e) => `“${e}”`).join('；')}`)
    }
    if (dimension.diagnosis !== null) {
      lines.push(`  - 诊断：${dimension.diagnosis}`)
    }
    if (dimension.revisionInstruction !== null) {
      lines.push(`  - 修改建议：${dimension.revisionInstruction}`)
    }
  }
  if (row.continuityIssues.length > 0) {
    lines.push('  - 连续性冲突：')
    for (const issue of row.continuityIssues) {
      const quote = issue.quote !== null ? `（引用：${issue.quote}）` : ''
      lines.push(`    - ${issue.conflict}${quote} → ${issue.suggestion}`)
    }
  }
  lines.push('')
}

export function renderEvaluationReport(data: EvaluationReportData): string {
  const lines: string[] = []
  lines.push('# 文学模型评测报告（揭盲）')
  lines.push('')
  lines.push('## 一、人工盲选结果')
  lines.push('')
  lines.push('| 题目 | 人工选择 | 备注 | A→模型 | B→模型 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of data.human) {
    lines.push(
      `| ${row.title} | ${humanChoiceLabel(row.choice, row.reveal)} | ${row.reason ?? '—'} | ${row.reveal.A} | ${row.reveal.B} |`,
    )
  }
  lines.push('')
  lines.push('## 二、LLM 诊断（自动分数仅供参考，逐维度细节见下）')
  lines.push('')
  if (data.diagnostics.every((row) => row.status !== 'succeeded')) {
    lines.push('尚无成功诊断；本报告保留人工结果，分数区域标注为不可用。')
    lines.push('')
  }
  lines.push('| 题目 | 候选(模型) | 裁判 | 状态 | 加权总分 | 门槛 | 否决 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of data.diagnostics) {
    const scoreText =
      row.status !== 'succeeded' || row.total === null || !row.resultVerified
        ? '不可用'
        : `${String(row.total)}${row.passed === true ? '（通过）' : row.passed === false ? '（未过）' : ''}`
    const vetoText = row.vetoes.length > 0 ? row.vetoes.join('；') : '—'
    lines.push(
      `| ${groupTitles[row.groupId]} | ${row.label}（${row.model}） | ${row.judgeModel || '—'} | ${row.status}${row.failureKind ? `：${row.failureKind}` : ''} | ${scoreText} | ${row.failedDimensions.length > 0 ? row.failedDimensions.join(', ') : '—'} | ${vetoText} |`,
    )
  }
  lines.push('')
  for (const row of data.diagnostics) {
    renderRowDetails(lines, row)
  }
  lines.push('## 三、用量与费用（估算，非账单）')
  lines.push('')
  lines.push(`- 生成正文已知费用：USD ${data.cost.generationKnownCostUsd.toFixed(8)}${data.cost.generationUnknownCount > 0 ? `（另有 ${data.cost.generationUnknownCount} 项费用未知）` : ''}`)
  lines.push(`- 诊断已知费用：USD ${data.cost.diagnosisKnownCostUsd.toFixed(8)}${data.cost.diagnosisUnknownCount > 0 ? `（另有 ${data.cost.diagnosisUnknownCount} 项费用未知）` : ''}`)
  lines.push(`- 保留预留（未决项/历史未知调用）：USD ${data.cost.reservedUsd.toFixed(8)}`)
  lines.push(`- 花费估算合计：USD ${data.cost.spentEstimateUsd.toFixed(8)}`)
  lines.push('')
  lines.push('## 四、局限说明')
  lines.push('')
  for (const caveat of data.caveats) {
    lines.push(`- ${caveat}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

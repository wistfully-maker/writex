import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CandidateEvaluation,
  DimensionEvaluation,
  RunEvent,
} from '../../packages/contracts/src/index.js'
import { RunStore } from '../../packages/core/src/index.js'
import { defaultQualityGate, scoreQuality } from '../../packages/quality/src/index.js'
import {
  appendRunEvent,
  initNovelWorkspace,
  readRunEvents,
  WorkspaceTransaction,
} from '../../packages/workspace/src/index.js'

const parents: string[] = []

afterEach(async () => {
  await Promise.all(parents.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixedTime = '2026-09-02T00:00:00.000Z'
const clock = (): string => fixedTime

const chapterOne: DimensionEvaluation = {
  score: 80,
  evidence: ['信纸背面与开篇伏笔逐字呼应，情绪由撕信的动作承载而非旁白说明'],
  diagnosis: '长夜意象与来信动机一致，五维均达线，无断裂',
  revisionInstruction: '保持现状，无需修改',
}

function acceptedEvaluation(): CandidateEvaluation {
  return {
    dimensions: {
      eternal_emotion: { ...chapterOne },
      fresh_situation: { ...chapterOne },
      difficult_choice: { ...chapterOne },
      character_truth: { ...chapterOne },
      narrative_control: { ...chapterOne },
    },
    vetoes: [],
  }
}

describe('WriteX foundation end-to-end', () => {
  it('composes init -> run -> quality gate -> transaction commit -> event -> succeeded', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'writex-e2e-'))
    parents.push(parent)
    const novelRoot = join(parent, 'novel')

    // 1. Init a novel workspace at a child root below the mkdtemp parent.
    await initNovelWorkspace(novelRoot, { title: '长夜来信', style: 'youth-mythic-melancholy' })

    // 2. Create a run with a fixed clock, then start it.
    const store = new RunStore(novelRoot, clock)
    await store.create({ runId: 'run-1', command: 'chapter accept 1', inputHash: 'fixture-hash' })
    await store.transition('run-1', 'running')

    // 3. Score a clean five-dimension evaluation against the default gate.
    const decision = scoreQuality(acceptedEvaluation(), defaultQualityGate)
    expect(decision.passed).toBe(true)
    expect(decision.total).toBe(80)

    // 4. Stage the chapter manuscript and the updated timeline, then commit.
    const tx = new WorkspaceTransaction(novelRoot, 'run-1')
    await tx.stageText('manuscript/chapter-001.md', '# 第一章\n\n正文。\n')
    await tx.stageText('state/timeline.json', '[{"chapter":1,"event":"开端"}]\n')
    await tx.commit()

    // 5. Record the accepted chapter event, then finish the run.
    const event: RunEvent = {
      schemaVersion: 1,
      eventId: 'evt-run-1-accept-chapter-1',
      runId: 'run-1',
      type: 'chapter/accepted',
      occurredAt: fixedTime,
      payload: { chapter: 1, score: decision.total },
    }
    await appendRunEvent(novelRoot, event)
    await store.transition('run-1', 'succeeded')

    // 6. Assert the workspace, run, event ledger, and manifest all agree.
    await expect(readFile(join(novelRoot, 'manuscript/chapter-001.md'), 'utf8')).resolves.toBe(
      '# 第一章\n\n正文。\n',
    )
    await expect(readFile(join(novelRoot, 'state/timeline.json'), 'utf8')).resolves.toBe(
      '[{"chapter":1,"event":"开端"}]\n',
    )

    const persisted = await new RunStore(novelRoot, clock).read('run-1')
    expect(persisted.status).toBe('succeeded')
    expect(persisted.command).toBe('chapter accept 1')
    expect(persisted.inputHash).toBe('fixture-hash')

    const events = await readRunEvents(novelRoot)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('chapter/accepted')
    expect(events[0]?.runId).toBe('run-1')
    expect(events[0]?.occurredAt).toBe(fixedTime)
    expect(events[0]?.payload.score).toBe(80)

    const manifest = await tx.readManifest()
    expect(manifest.status).toBe('committed')
    expect(manifest.runId).toBe('run-1')
    expect(manifest.files).toEqual(['manuscript/chapter-001.md', 'state/timeline.json'])
  })
})

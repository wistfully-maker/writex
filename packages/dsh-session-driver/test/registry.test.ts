import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompactionCapsule, UsageSummary, WorkstreamRecord } from '../src/contracts.js'
import { WorkstreamRegistry } from '../src/registry.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-registry-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const zeroUsage = (): UsageSummary => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

function record(workstreamId: string, createdAt = '2026-09-06T00:00:00.000Z'): WorkstreamRecord {
  return {
    schemaVersion: 1,
    workstreamId,
    sessionId: `session-${workstreamId}`,
    model: 'deepseek-v4-flash',
    branch: `feature/${workstreamId}`,
    worktree: process.cwd(),
    status: 'opening',
    createdAt,
    updatedAt: createdAt,
    lastCheckpoint: null,
    promptCount: 0,
    compactCount: 0,
    usage: zeroUsage(),
  }
}

function capsule(workstreamId: string): CompactionCapsule {
  return {
    schemaVersion: 1,
    objective: `finish ${workstreamId}`,
    completed: ['defined contracts'],
    decisions: ['one writer per workspace'],
    currentState: {
      branch: `feature/${workstreamId}`,
      worktree: process.cwd(),
      lastCommit: '0000000',
      dirtyFiles: [],
    },
    verification: ['pnpm test'],
    openIssues: [],
    nextAction: 'verify green',
  }
}

describe('WorkstreamRegistry', () => {
  it('persists a registry record without prompts or credentials', async () => {
    const root = await makeRoot()
    const registry = new WorkstreamRegistry(root)

    await registry.create(record('registry-v1'))

    const text = await readFile(
      join(root, '.writex', 'dev', 'workstreams', 'registry-v1.json'),
      'utf8',
    )
    const persisted = JSON.parse(text) as Record<string, unknown>
    expect(persisted.schemaVersion).toBe(1)
    expect(text.endsWith('\n')).toBe(true)
    expect(persisted.promptCount).toBe(0)
    for (const key of Object.keys(persisted)) {
      if (key === 'promptCount') continue
      expect(key).not.toMatch(/key|token|prompt|message/i)
    }
    expect(text).not.toMatch(/api[_-]?key|secret|bearer/i)
  })

  it('updates status, prompt count, usage, and compaction count atomically', async () => {
    const root = await makeRoot()
    let nowValue = '2026-09-06T00:00:00.000Z'
    const registry = new WorkstreamRegistry(root, () => nowValue)
    await registry.create(record('registry-v1'))

    nowValue = '2026-09-06T00:00:01.000Z'
    const busy = await registry.update('registry-v1', (current) => ({
      ...current,
      status: 'busy',
      promptCount: current.promptCount + 1,
      compactCount: current.compactCount + 1,
      usage: { ...current.usage, inputTokens: current.usage.inputTokens + 10 },
    }))
    expect(busy.status).toBe('busy')
    expect(busy.updatedAt).toBe(nowValue)

    nowValue = '2026-09-06T00:00:02.000Z'
    await registry.update('registry-v1', (current) => ({
      ...current,
      status: 'idle',
      promptCount: current.promptCount + 1,
      usage: { ...current.usage, outputTokens: current.usage.outputTokens + 5 },
    }))

    const persisted = await registry.read('registry-v1')
    expect(persisted.status).toBe('idle')
    expect(persisted.promptCount).toBe(2)
    expect(persisted.compactCount).toBe(1)
    expect(persisted.usage.inputTokens).toBe(10)
    expect(persisted.usage.outputTokens).toBe(5)
    expect(persisted.updatedAt).toBe('2026-09-06T00:00:02.000Z')
  })

  it('creates each initial record exactly once', async () => {
    const root = await makeRoot()
    const registry = new WorkstreamRegistry(root)

    await registry.create(record('registry-v1'))
    await expect(registry.create(record('registry-v1'))).rejects.toThrow(/EEXIST|already exists/i)
  })

  it('rejects unsafe workstream ids', async () => {
    const root = await makeRoot()
    const registry = new WorkstreamRegistry(root)

    for (const workstreamId of ['../escape', 'run.', 'sub/dir']) {
      await expect(registry.create(record(workstreamId))).rejects.toThrow('invalid workstreamId')
    }
    await expect(registry.saveCapsule('../escape', capsule('safe'))).rejects.toThrow(
      'invalid workstreamId',
    )
  })

  it('rejects Windows reserved device names in workstream ids', async () => {
    const root = await makeRoot()
    const registry = new WorkstreamRegistry(root)

    for (const workstreamId of ['CON', 'NUL.txt', 'COM1.json', 'LPT9']) {
      await expect(registry.create(record(workstreamId))).rejects.toThrow('invalid workstreamId')
      await expect(registry.saveCapsule(workstreamId, capsule('safe'))).rejects.toThrow(
        'invalid workstreamId',
      )
    }
  })

  it('stores a compaction capsule without model responses or reasoning', async () => {
    const root = await makeRoot()
    const registry = new WorkstreamRegistry(root)

    const path = await registry.saveCapsule('registry-v1', capsule('registry-v1'))

    expect(path).toBe(join(root, '.writex', 'dev', 'capsules', 'registry-v1.json'))
    const text = await readFile(path, 'utf8')
    const persisted = JSON.parse(text) as Record<string, unknown>
    expect(persisted.schemaVersion).toBe(1)
    expect(text).not.toMatch(/api[_-]?key|secret|bearer/i)
    expect(text).not.toMatch(/"finalResponse"/)
  })
})

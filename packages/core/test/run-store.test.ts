import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunStore } from '@writex/core'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'writex-core-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixedTime = '2026-09-02T00:00:00.000Z'
const clock = (): string => fixedTime

describe('RunStore', () => {
  it('persists queued -> running -> succeeded with stable timestamps', async () => {
    const root = await makeRoot()
    const store = new RunStore(root, clock)

    await store.create({ runId: 'run-1', command: 'novel init', inputHash: 'abc' })
    await store.transition('run-1', 'running')
    const updated = await store.transition('run-1', 'succeeded')
    expect(updated.status).toBe('succeeded')

    const persisted = await new RunStore(root, clock).read('run-1')
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.runId).toBe('run-1')
    expect(persisted.command).toBe('novel init')
    expect(persisted.inputHash).toBe('abc')
    expect(persisted.status).toBe('succeeded')
    expect(persisted.createdAt).toBe(fixedTime)
    expect(persisted.updatedAt).toBe(fixedTime)
  })

  it('rejects a transition out of the cancelled terminal state', async () => {
    const root = await makeRoot()
    const store = new RunStore(root, clock)

    await store.create({ runId: 'run-1', command: 'novel init', inputHash: 'abc' })
    await store.transition('run-1', 'cancelled')

    await expect(store.transition('run-1', 'running')).rejects.toThrow(/illegal run transition/)

    const persisted = await store.read('run-1')
    expect(persisted.status).toBe('cancelled')
  })

  it('rejects a duplicate create for the same runId instead of overwriting', async () => {
    const root = await makeRoot()
    const store = new RunStore(root, clock)

    await store.create({ runId: 'run-1', command: 'novel init', inputHash: 'abc' })
    await expect(
      store.create({ runId: 'run-1', command: 'novel init', inputHash: 'abc' }),
    ).rejects.toThrow()

    const persisted = await store.read('run-1')
    expect(persisted.status).toBe('queued')
    expect(persisted.createdAt).toBe(fixedTime)
  })

  it('rejects an invalid runId and creates nothing outside root/.writex/runs', async () => {
    const root = await makeRoot()
    const store = new RunStore(root, clock)

    await expect(
      store.create({ runId: '../escape', command: 'novel init', inputHash: 'abc' }),
    ).rejects.toThrow(/invalid runId/)
    await expect(store.read('../escape')).rejects.toThrow(/invalid runId/)
    await expect(store.transition('../escape', 'running')).rejects.toThrow(/invalid runId/)

    await expect(readFile(join(root, '.writex', 'escape', 'state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('atomically claims the run directory so concurrent creates of one runId settle exactly once', async () => {
    const root = await makeRoot()
    const store = new RunStore(root, clock)
    const input = { runId: 'run-1', command: 'novel init', inputHash: 'abc' }

    const results = await Promise.allSettled([store.create(input), store.create(input)])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const persisted = await store.read('run-1')
    expect(persisted.status).toBe('queued')
    expect(persisted.createdAt).toBe(fixedTime)
  })
})

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedAttempt } from '../src/index.js'
import {
  EvaluationStore,
  currentFixtureHash,
  serializeFixtures,
} from '../src/index.js'
import { cleanupRoots, makeConfig, makeRoot } from './helpers.js'

const hexA = 'a'.repeat(64)
const hexB = 'b'.repeat(64)

function pendingAttempt(
  attemptId: string,
  overrides: Partial<PersistedAttempt> = {},
): PersistedAttempt {
  const stamp = '2026-09-07T00:00:00.000Z'
  return {
    schemaVersion: 1,
    attemptId,
    model: 'deepseek-v4-flash',
    taskId: 'reunion',
    kind: 'scene',
    step: null,
    status: 'pending',
    createdAt: stamp,
    updatedAt: stamp,
    configHash: hexA,
    fixtureHash: hexB,
    promptHash: null,
    reservedUsd: 0,
    blockReason: null,
    failure: null,
    responseId: null,
    responseModel: null,
    finishReason: null,
    usage: null,
    costUsd: null,
    costUnknown: false,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

async function initStore(root: string): Promise<EvaluationStore> {
  const store = new EvaluationStore(root)
  await store.init(makeConfig())
  return store
}

afterEach(cleanupRoots)

describe('EvaluationStore init and immutability', () => {
  it('creates a fresh run root with config, fixtures, state and directories', async () => {
    const root = await makeRoot()
    const config = makeConfig()
    const summary = await new EvaluationStore(root).init(config)

    expect(summary.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(summary.fixtureHash).toBe(currentFixtureHash())

    const state = JSON.parse(
      await readFile(join(root, 'state.json'), 'utf8'),
    ) as { configHash: string; fixtureHash: string }
    expect(state.configHash).toBe(summary.configHash)
    expect(state.fixtureHash).toBe(summary.fixtureHash)

    const fixturesOnDisk = await readFile(join(root, 'fixtures.json'), 'utf8')
    expect(fixturesOnDisk).toBe(serializeFixtures())

    const store = new EvaluationStore(root)
    await expect(store.assertUsable()).resolves.toBeUndefined()
    expect((await store.listAttempts()).length).toBe(0)
    await expect(store.readConfig()).resolves.toMatchObject({
      budgetUsd: config.budgetUsd,
      maxOutputTokens: config.maxOutputTokens,
    })
  })

  it('creates missing parent directories before claiming the run root atomically', async () => {
    const root = await makeRoot()
    const nested = join(root, 'a', 'b', 'run')
    const summary = await new EvaluationStore(nested).init(makeConfig())

    expect(summary.configHash).toMatch(/^[0-9a-f]{64}$/)
    await expect(readFile(join(nested, 'state.json'), 'utf8')).resolves.toContain(
      summary.configHash,
    )
  })

  it('is create-only and refuses an existing root (atomic claim)', async () => {
    const root = await makeRoot()
    const store = new EvaluationStore(root)
    await store.init(makeConfig())
    await expect(store.init(makeConfig({ budgetUsd: 3 }))).rejects.toThrowError(
      /already exists \(create-only\)/,
    )
  })

  it('refuses work after config.json is modified (immutable hash)', async () => {
    const root = await makeRoot()
    const store = await initStore(root)
    await appendFile(join(root, 'config.json'), '\n// tampered\n', 'utf8')

    await expect(store.assertUsable()).rejects.toThrowError(/hash mismatch/)
    await expect(store.readConfig()).rejects.toThrowError(/hash mismatch/)
  })

  it('refuses work after fixtures.json is modified', async () => {
    const root = await makeRoot()
    const store = await initStore(root)
    await appendFile(join(root, 'fixtures.json'), 'extra', 'utf8')

    await expect(store.assertUsable()).rejects.toThrowError(/hash mismatch/)
  })
})

describe('EvaluationStore attempts and outputs', () => {
  it('round-trips attempts and outputs atomically', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    const attempt = pendingAttempt('flash-reunion', {
      reservedUsd: 0.001,
      status: 'in-flight',
    })
    await store.writeAttempt(attempt)
    const read = await store.readAttempt('flash-reunion')
    expect(read).toEqual(attempt)
    expect(await store.listAttemptIds()).toEqual(['flash-reunion'])

    await store.writeOutput('flash-reunion', '正文第一稿')
    await expect(store.readOutput('flash-reunion')).resolves.toBe('正文第一稿')
  })

  it('rejects invalid attempt ids: traversal, trailing dot and Windows reserved names', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    for (const bad of [
      '../escape',
      'flash-reunion.',
      'CON',
      'con',
      'com1',
      'lpt9',
      'CON.json',
      'nul.json',
    ]) {
      await expect(store.writeAttempt(pendingAttempt(bad))).rejects.toThrowError(
        /invalid attemptId/,
      )
    }
    await expect(store.readAttempt('../escape')).rejects.toThrowError(/invalid attemptId/)
    await expect(store.readAttempt('missing')).rejects.toThrow()
    await expect(store.readOutput('missing')).rejects.toThrow()

    await writeFile(join(root, 'attempts', 'broken.json'), 'not json', 'utf8')
    await expect(store.readAttempt('broken')).rejects.toThrowError(/not JSON/)
  })

  it('fully validates persisted attempts before use (budget and identity fields)', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    const writeBad = async (
      id: string,
      patch: Record<string, unknown>,
    ): Promise<void> => {
      const content = JSON.stringify({ ...pendingAttempt(id), ...patch })
      await writeFile(join(root, 'attempts', `${id}.json`), content, 'utf8')
      await expect(store.readAttempt(id)).rejects.toThrow()
    }

    await writeBad('neg-reserve', { reservedUsd: -0.001 })
    await writeBad('neg-cost', { costUsd: -5 })
    await writeBad('bad-hash', { configHash: 'not-hex' })
    await writeBad('bad-prompt-hash', { promptHash: 'xyz' })
    await writeBad('bad-status', { status: 'bogus' })
    await writeBad('unknown-field', { extra: 1 })
    await writeBad('bad-failure', {
      failure: { kind: 'nonsense', message: 'x' },
    })
    await writeBad('bad-usage', { usage: { outputTokens: -3 } })
    await writeBad('continuation-null-step', {
      taskId: 'three-step-continuity',
      kind: 'continuation',
      step: null,
    })
    await writeBad('scene-with-step', {
      kind: 'scene',
      step: 2,
    })
    await writeBad('bad-model', { model: 'gpt-4' })

    // Well-formed costs on a failed attempt survive a round trip.
    const valid = pendingAttempt('flash-reunion', {
      status: 'failed',
      failure: { kind: 'truncated', message: 'hit max tokens' },
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.0004,
      costUnknown: false,
      reservedUsd: 0.001,
    })
    await store.writeAttempt(valid)
    expect(await store.readAttempt('flash-reunion')).toEqual(valid)
  })

  it('keeps reserved charges and prompt hash when recovering interrupted in-flight attempts', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    await store.writeAttempt(
      pendingAttempt('pro-continuity-2', {
        model: 'deepseek-v4-pro',
        taskId: 'three-step-continuity',
        kind: 'continuation',
        step: 2,
        status: 'in-flight',
        reservedUsd: 0.02,
        promptHash: hexA,
      }),
    )
    const recovered = await store.recoverInterruptedInFlight()
    expect(recovered).toBe(1)
    const attempt = await store.readAttempt('pro-continuity-2')
    expect(attempt.status).toBe('uncertain')
    expect(attempt.reservedUsd).toBe(0.02)
    expect(attempt.promptHash).toBe(hexA)
  })
})

describe('EvaluationStore exclusive writer lock', () => {
  it('holds an exclusive lock, refuses concurrent writers and releases cleanly', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    const token = await store.acquireLock()
    expect(token).toBeTruthy()
    await expect(store.acquireLock()).rejects.toThrowError(/locked by process/)

    await store.releaseLock(token)
    const second = await store.acquireLock()
    expect(second).not.toBe(token)
    await store.releaseLock(second)
    // Releasing when there is no lock is the only silent case.
    await expect(store.releaseLock(second)).resolves.toBeUndefined()
  })

  it('refuses stale locks left by dead processes instead of racing an unlink', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    const stale = {
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: 'stale-token',
      createdAt: '2026-09-07T00:00:00.000Z',
    }
    await writeFile(join(root, 'lock.json'), `${JSON.stringify(stale)}\n`, 'utf8')

    await expect(store.acquireLock()).rejects.toThrowError(
      /locked by process 2147483647.*remove .*lock\.json manually/,
    )
    // The stale lock is never deleted by the library.
    const lockText = await readFile(join(root, 'lock.json'), 'utf8')
    expect(JSON.parse(lockText)).toMatchObject({ token: 'stale-token' })

    // Explicit operator recovery: verify and remove, then acquire succeeds.
    await import('node:fs/promises').then(({ rm }) =>
      rm(join(root, 'lock.json')),
    )
    const token = await store.acquireLock()
    expect(token).not.toBe('stale-token')
  })

  it('fails closed on malformed or partial lock files and never deletes them', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    const malformedBodies: Array<[string, string, RegExp]> = [
      ['partial', '{"schemaVersion":1,"pid":', /malformed|invalid/],
      ['garbage', 'not-json-at-all', /malformed|invalid/],
      ['bad-pid', JSON.stringify({ schemaVersion: 1, pid: -5, token: 't', createdAt: 'c' }), /malformed|invalid/],
      ['missing-token', JSON.stringify({ schemaVersion: 1, pid: 123 }), /malformed|invalid/],
    ]
    for (const [name, body, pattern] of malformedBodies) {
      await writeFile(join(root, 'lock.json'), body, 'utf8')
      await expect(store.acquireLock()).rejects.toThrowError(pattern)
      const after = await readFile(join(root, 'lock.json'), 'utf8')
      expect(after).toBe(body)
      await import('node:fs/promises').then(({ rm }) =>
        rm(join(root, 'lock.json'), { force: true }),
      )
    }
  })

  it('never deletes a lock it failed to acquire, even when its owner is gone', async () => {
    const root = await makeRoot()
    const store = await initStore(root)
    // Simulate another writer's freshly created lock.
    const other = {
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: 'winner-token',
      createdAt: '2026-09-07T00:00:00.000Z',
    }
    await writeFile(join(root, 'lock.json'), `${JSON.stringify(other)}\n`, 'utf8')

    await expect(store.acquireLock()).rejects.toThrowError(/locked by process/)
    const lockText = await readFile(join(root, 'lock.json'), 'utf8')
    expect(JSON.parse(lockText)).toMatchObject({ token: 'winner-token' })
  })

  it('reports ownership and unreadable/malformed release problems except ENOENT', async () => {
    const root = await makeRoot()
    const store = await initStore(root)

    // Ownership mismatch.
    await store.acquireLock()
    await expect(store.releaseLock('someone-elses-token')).rejects.toThrowError(
      /owned by another process/,
    )
    await expect(readFile(join(root, 'lock.json'), 'utf8')).resolves.toBeTruthy()

    // Malformed lock on release.
    await writeFile(join(root, 'lock.json'), '{"schemaVersion":1', 'utf8')
    await expect(store.releaseLock('x')).rejects.toThrowError(/malformed/)
  })
})

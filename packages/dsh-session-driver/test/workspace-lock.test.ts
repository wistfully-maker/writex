import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceLock } from '../src/workspace-lock.js'
import type { IsPidAlive } from '../src/workspace-lock.js'

const roots: string[] = []

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lock-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const lockPath = (workspace: string): string =>
  join(workspace, '.writex', 'dev', 'driver.lock')

describe('WorkspaceLock', () => {
  it('allows one workspace writer and rejects a second live writer', async () => {
    const workspace = await makeWorkspace()
    const isPidAlive: IsPidAlive = () => true

    const first = await WorkspaceLock.acquire(workspace, 'writer-a', isPidAlive)
    const persisted = JSON.parse(await readFile(lockPath(workspace), 'utf8')) as Record<
      string,
      unknown
    >
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.pid).toBe(process.pid)
    expect(persisted.token).toEqual(expect.any(String))
    expect(persisted.workstreamId).toBe('writer-a')
    expect(persisted.createdAt).toEqual(expect.any(String))

    await expect(
      WorkspaceLock.acquire(workspace, 'writer-b', isPidAlive),
    ).rejects.toThrow('workspace already has an active DSH writer')

    await first.release()
    const second = await WorkspaceLock.acquire(workspace, 'writer-b', isPidAlive)
    await second.release()
  })

  it('reclaims a lock whose owner pid is no longer alive', async () => {
    const workspace = await makeWorkspace()
    const isPidAlive: IsPidAlive = () => false

    const stale = await WorkspaceLock.acquire(workspace, 'writer-a', isPidAlive)
    const staleToken = (JSON.parse(await readFile(lockPath(workspace), 'utf8')) as {
      token: string
    }).token
    const replacement = await WorkspaceLock.acquire(workspace, 'writer-b', isPidAlive)

    expect(replacement).toBeInstanceOf(WorkspaceLock)
    const persisted = JSON.parse(await readFile(lockPath(workspace), 'utf8')) as Record<
      string,
      unknown
    >
    expect(persisted.workstreamId).toBe('writer-b')
    expect(persisted.token).not.toBe(staleToken)
    // the stale lock object must not delete the replacement's lock file
    await expect(stale.release()).rejects.toThrow('workspace lock ownership changed')
    await replacement.release()
  })

  it('releases only the lock token owned by this driver', async () => {
    const workspace = await makeWorkspace()
    const isPidAlive: IsPidAlive = () => true

    const owner = await WorkspaceLock.acquire(workspace, 'writer-a', isPidAlive)
    // Simulate an ownership change written behind this driver's back.
    await writeFile(
      lockPath(workspace),
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'other-token', workstreamId: 'writer-b', createdAt: new Date().toISOString() })}\n`,
      'utf8',
    )

    await expect(owner.release()).rejects.toThrow('workspace lock ownership changed')
    // the replaced lock file survives the failed release
    await expect(readFile(lockPath(workspace), 'utf8')).resolves.toContain('other-token')
  })

  it('is idempotent when the lock file is already absent', async () => {
    const workspace = await makeWorkspace()
    const isPidAlive: IsPidAlive = () => true

    const lock = await WorkspaceLock.acquire(workspace, 'writer-a', isPidAlive)
    await rm(lockPath(workspace))
    await expect(lock.release()).resolves.toBeUndefined()
    await expect(lock.release()).resolves.toBeUndefined()
  })

  it('fails closed on a malformed lock file and never removes it', async () => {
    const workspace = await makeWorkspace()
    const isPidAlive: IsPidAlive = () => false
    await mkdir(join(workspace, '.writex', 'dev'), { recursive: true })
    await writeFile(lockPath(workspace), 'not-json', 'utf8')

    await expect(WorkspaceLock.acquire(workspace, 'writer-a', isPidAlive)).rejects.toThrow(
      'workspace lock is malformed',
    )
    await expect(readFile(lockPath(workspace), 'utf8')).resolves.toBe('not-json')
  })

  it('requires an absolute workspace path', async () => {
    await expect(WorkspaceLock.acquire('./relative', 'writer-a', () => true)).rejects.toThrow(
      'workspace must be absolute',
    )
  })
})

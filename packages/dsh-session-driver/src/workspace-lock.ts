import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'

interface LockRecord {
  schemaVersion: 1
  pid: number
  token: string
  workstreamId: string
  createdAt: string
}

export type IsPidAlive = (pid: number) => boolean

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class WorkspaceLock {
  private released = false

  private constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}

  static async acquire(
    workspace: string,
    workstreamId: string,
    isPidAlive: IsPidAlive = defaultIsPidAlive,
  ): Promise<WorkspaceLock> {
    if (!isAbsolute(workspace)) throw new Error('workspace must be absolute')
    const path = join(workspace, '.writex', 'dev', 'driver.lock')
    await mkdir(dirname(path), { recursive: true })
    const token = randomUUID()
    const value: LockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      token,
      workstreamId,
      createdAt: new Date().toISOString(),
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx')
        try {
          await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        } finally {
          await handle.close()
        }
        return new WorkspaceLock(path, token)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let existing: LockRecord
        try {
          existing = JSON.parse(await readFile(path, 'utf8')) as LockRecord
        } catch {
          throw new Error('workspace lock is malformed')
        }
        if (!Number.isSafeInteger(existing.pid) || typeof existing.token !== 'string') {
          throw new Error('workspace lock is malformed')
        }
        if (isPidAlive(existing.pid)) throw new Error('workspace already has an active DSH writer')
        await rm(path)
      }
    }
    throw new Error('could not acquire workspace lock')
  }

  async release(): Promise<void> {
    if (this.released) return
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8')) as LockRecord
      if (current.token !== this.token) throw new Error('workspace lock ownership changed')
      await rm(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.released = true
  }
}

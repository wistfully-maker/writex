import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { atomicWriteFile } from '@writex/workspace'
import type { CompactionCapsule, WorkstreamRecord } from './contracts.js'

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

function recordText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function assertSafeId(value: string): void {
  if (!safeId.test(value) || /[. ]$/.test(value) || reserved.test(value)) {
    throw new Error('invalid workstreamId')
  }
}

export class WorkstreamRegistry {
  constructor(
    private readonly root: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!isAbsolute(root)) throw new Error('controllerRoot must be absolute')
  }

  private recordPath(id: string): string {
    assertSafeId(id)
    return join(this.root, '.writex', 'dev', 'workstreams', `${id}.json`)
  }

  async create(record: WorkstreamRecord): Promise<void> {
    const path = this.recordPath(record.workstreamId)
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(recordText(record), 'utf8')
    } finally {
      await handle.close()
    }
  }

  async read(id: string): Promise<WorkstreamRecord> {
    return JSON.parse(await readFile(this.recordPath(id), 'utf8')) as WorkstreamRecord
  }

  async update(
    id: string,
    mutate: (current: WorkstreamRecord) => WorkstreamRecord,
  ): Promise<WorkstreamRecord> {
    const current = await this.read(id)
    const next = { ...mutate(structuredClone(current)), updatedAt: this.now() }
    if (next.workstreamId !== id) throw new Error('workstreamId is immutable')
    await atomicWriteFile(this.recordPath(id), recordText(next))
    return next
  }

  async saveCapsule(id: string, capsule: CompactionCapsule): Promise<string> {
    assertSafeId(id)
    const path = join(this.root, '.writex', 'dev', 'capsules', `${id}.json`)
    await atomicWriteFile(path, recordText(capsule))
    return path
  }
}

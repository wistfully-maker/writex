import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeVerifiedProbeTempDir } from './safe-temp-cleanup.js'

const created: string[] = []

async function makeTempChild(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('removeVerifiedProbeTempDir', () => {
  it('removes an actual mkdtemp child for each allowed prefix', async () => {
    for (const prefix of ['dsh-live-root-', 'dsh-live-ws-'] as const) {
      const child = await makeTempChild(prefix)
      await removeVerifiedProbeTempDir(child, prefix)
      await expect(stat(child)).rejects.toThrow(/ENOENT/)
    }
  })

  it('rejects a temp-root child with the wrong prefix without removing it', async () => {
    const child = await makeTempChild('dsh-live-root-')
    await expect(removeVerifiedProbeTempDir(child, 'dsh-live-ws-')).rejects.toThrow(
      'refusing to remove unverified probe temp directory',
    )
    await expect(stat(child)).resolves.toBeDefined()
  })

  it('rejects a correctly-prefixed nested child without removing it', async () => {
    const parent = await makeTempChild('dsh-live-root-')
    const nested = join(parent, 'dsh-live-root-nested')
    await mkdir(nested)
    await expect(removeVerifiedProbeTempDir(nested, 'dsh-live-root-')).rejects.toThrow(
      'refusing to remove unverified probe temp directory',
    )
    await expect(stat(nested)).resolves.toBeDefined()
  })
})

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initNovelWorkspace, loadNovelConfig } from '@writex/workspace'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'writex-workspace-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('initNovelWorkspace', () => {
  it('creates a loadable config, the state ledger files, and a brief', async () => {
    const root = await makeRoot()

    await initNovelWorkspace(root, { title: '长夜来信', style: 'youth-mythic-melancholy' })

    const config = await loadNovelConfig(root)
    expect(config.title).toBe('长夜来信')
    expect(config.language).toBe('zh-CN')
    expect(config.style).toBe('youth-mythic-melancholy')

    const stateFiles = (await readdir(join(root, 'state'))).sort()
    expect(stateFiles).toEqual([
      'character-knowledge.json',
      'motif-ledger.json',
      'promises.json',
      'timeline.json',
    ])

    const brief = await readFile(join(root, 'brief.md'), 'utf8')
    expect(brief).toContain('# 长夜来信')

    await expect(readFile(join(root, 'canon/world.md'), 'utf8')).resolves.toBe('# 世界正典\n')
    await expect(readFile(join(root, 'outline/main-arc.md'), 'utf8')).resolves.toBe('# 全书主线\n')
    await expect(readFile(join(root, 'state/timeline.json'), 'utf8')).resolves.toBe('[]\n')
    await expect(readFile(join(root, 'state/character-knowledge.json'), 'utf8')).resolves.toBe('{}\n')
    await expect(readFile(join(root, 'state/motif-ledger.json'), 'utf8')).resolves.toBe('[]\n')
    await expect(readFile(join(root, 'state/promises.json'), 'utf8')).resolves.toBe('[]\n')
  })

  it('rejects an existing non-empty directory and leaves existing files unchanged', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'keep.txt'), 'original', 'utf8')

    await expect(
      initNovelWorkspace(root, { title: '长夜来信', style: 'youth-mythic-melancholy' }),
    ).rejects.toThrow(/not empty/)

    await expect(readFile(join(root, 'keep.txt'), 'utf8')).resolves.toBe('original')
  })
})

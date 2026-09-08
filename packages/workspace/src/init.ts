import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import type { NovelConfig } from '@writex/contracts'
import { atomicWriteFile } from './atomic.js'
import { novelDirectories } from './layout.js'

export interface InitNovelInput {
  title: string
  style: string
}

export async function initNovelWorkspace(root: string, input: InitNovelInput): Promise<void> {
  const title = input.title.trim()
  const style = input.style.trim()
  if (title === '') {
    throw new Error('title must not be blank')
  }
  if (style === '') {
    throw new Error('style must not be blank')
  }

  await mkdir(root, { recursive: true })
  const existing = await readdir(root)
  if (existing.length > 0) {
    throw new Error(`directory is not empty: ${root}`)
  }

  for (const directory of novelDirectories) {
    await mkdir(join(root, directory), { recursive: true })
  }

  const config: NovelConfig = {
    schemaVersion: 1,
    title,
    language: 'zh-CN',
    style,
    qualityProfile: 'default',
  }

  await atomicWriteFile(join(root, 'writex.yaml'), stringify(config))
  await atomicWriteFile(join(root, 'brief.md'), `# ${title}\n\n## 创作意图\n\n`)
  await atomicWriteFile(join(root, 'canon/world.md'), '# 世界正典\n')
  await atomicWriteFile(join(root, 'canon/relationships.yaml'), 'relationships: []\n')
  await atomicWriteFile(join(root, 'outline/main-arc.md'), '# 全书主线\n')
  await atomicWriteFile(join(root, 'state/timeline.json'), '[]\n')
  await atomicWriteFile(join(root, 'state/character-knowledge.json'), '{}\n')
  await atomicWriteFile(join(root, 'state/motif-ledger.json'), '[]\n')
  await atomicWriteFile(join(root, 'state/promises.json'), '[]\n')
  await atomicWriteFile(join(root, '.writex/events.jsonl'), '')
}

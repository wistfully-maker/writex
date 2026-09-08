import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write `content` to `target` atomically: parent directories are created
 * recursively, content is written to a unique sibling temp file, and the temp
 * file is renamed over the target.
 */
export async function atomicWriteFile(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, content, 'utf8')
  await rename(temp, target)
}

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

function sameDir(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function removeVerifiedProbeTempDir(
  target: string | undefined,
  expectedPrefix: 'dsh-live-root-' | 'dsh-live-ws-',
): Promise<void> {
  if (!target) return
  const resolvedTarget = resolve(target)
  const tempRoot = resolve(tmpdir())
  const base = basename(resolvedTarget)
  const verified =
    sameDir(dirname(resolvedTarget), tempRoot) &&
    base.startsWith(expectedPrefix) &&
    base.length > expectedPrefix.length
  if (!verified) {
    throw new Error('refusing to remove unverified probe temp directory')
  }
  await rm(resolvedTarget, { recursive: true, force: true })
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTransaction } from '@writex/workspace'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'writex-transaction-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WorkspaceTransaction', () => {
  it('commits staged artifacts to both targets and records a committed manifest', async () => {
    const root = await makeRoot()
    const transaction = new WorkspaceTransaction(root, 'run-1')

    await transaction.stageText('manuscript/chapter-001.md', '正文\n')
    await transaction.stageText('state/timeline.json', '[{"chapter":1}]\n')
    await transaction.commit()

    await expect(readFile(join(root, 'manuscript', 'chapter-001.md'), 'utf8')).resolves.toBe('正文\n')
    await expect(readFile(join(root, 'state', 'timeline.json'), 'utf8')).resolves.toBe(
      '[{"chapter":1}]\n',
    )
    await expect(transaction.readManifest()).resolves.toMatchObject({ status: 'committed' })
  })

  it('restores the original timeline when a later apply fails and leaves the new file absent', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'timeline.json'), 'old\n', 'utf8')

    const transaction = new WorkspaceTransaction(root, 'run-2', async (index) => {
      if (index === 1) throw new Error('injected apply failure')
    })
    await transaction.stageText('state/timeline.json', 'new\n')
    await transaction.stageText('manuscript/chapter-001.md', '正文\n')

    await expect(transaction.commit()).rejects.toThrow('injected apply failure')

    await expect(readFile(join(root, 'state', 'timeline.json'), 'utf8')).resolves.toBe('old\n')
    await expect(readFile(join(root, 'manuscript', 'chapter-001.md'), 'utf8')).rejects.toThrow(
      /ENOENT/,
    )
    await expect(transaction.readManifest()).resolves.toMatchObject({ status: 'rolled-back' })
  })

  it('rejects traversal, absolute, and infrastructure artifact paths', async () => {
    const root = await makeRoot()
    const transaction = new WorkspaceTransaction(root, 'run-3')
    const unsafePaths = [
      '../escape.txt',
      '..\\escape.txt',
      '/etc/escape.txt',
      'C:\\escape.txt',
      '\\\\server\\share\\escape.txt',
      '.git/config',
      '.writex/events.jsonl',
    ]
    for (const path of unsafePaths) {
      await expect(transaction.stageText(path, 'bad')).rejects.toThrow(/unsafe artifact path/)
    }
  })

  it('rejects an invalid runId in the constructor', async () => {
    const root = await makeRoot()
    expect(() => new WorkspaceTransaction(root, '../escape')).toThrow(/invalid runId/)
  })

  it('recovers a transaction interrupted mid-commit by restoring the backup', async () => {
    const root = await makeRoot()
    const base = join(root, '.writex', 'staged', 'run-4')
    await mkdir(join(root, 'state'), { recursive: true })
    await mkdir(join(base, 'backups', 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'timeline.json'), 'new\n', 'utf8')
    await writeFile(join(base, 'backups', 'state', 'timeline.json'), 'old\n', 'utf8')
    await writeFile(
      join(base, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'run-4',
        status: 'committing',
        files: ['state/timeline.json'],
        applied: ['state/timeline.json'],
        current: null,
      }),
      'utf8',
    )

    const transaction = new WorkspaceTransaction(root, 'run-4')
    expect(await transaction.recover()).toBe('rolled-back')
    await expect(readFile(join(root, 'state', 'timeline.json'), 'utf8')).resolves.toBe('old\n')

    // Recovery is idempotent: a second recover leaves the file restored.
    expect(await transaction.recover()).toBe('rolled-back')
    await expect(readFile(join(root, 'state', 'timeline.json'), 'utf8')).resolves.toBe('old\n')
  })

  it('refuses to stage new artifacts after a commit has finished', async () => {
    const root = await makeRoot()
    const transaction = new WorkspaceTransaction(root, 'run-5')
    await transaction.stageText('state/timeline.json', '[{"chapter":1}]\n')
    await transaction.commit()

    await expect(transaction.stageText('manuscript/chapter-002.md', '正文\n')).rejects.toThrow(
      /not staging/,
    )
  })

  it('recovers a crash after the current file was installed but before the applied save', async () => {
    const root = await makeRoot()
    const base = join(root, '.writex', 'staged', 'run-6')
    await mkdir(join(root, 'state'), { recursive: true })
    await mkdir(join(base, 'backups', 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'timeline.json'), 'new\n', 'utf8')
    await writeFile(join(base, 'backups', 'state', 'timeline.json'), 'old\n', 'utf8')
    await writeFile(
      join(base, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'run-6',
        status: 'committing',
        files: ['state/timeline.json'],
        applied: [],
        current: { path: 'state/timeline.json', installed: true },
      }),
      'utf8',
    )

    const transaction = new WorkspaceTransaction(root, 'run-6')
    expect(await transaction.recover()).toBe('rolled-back')
    await expect(readFile(join(root, 'state', 'timeline.json'), 'utf8')).resolves.toBe('old\n')
  })

  it('recovers a crash after the staged rename but before the installed save', async () => {
    const root = await makeRoot()
    const base = join(root, '.writex', 'staged', 'run-7')
    await mkdir(join(root, 'state'), { recursive: true })
    await mkdir(join(base, 'backups', 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'timeline.json'), 'new\n', 'utf8')
    await writeFile(join(base, 'backups', 'state', 'timeline.json'), 'old\n', 'utf8')
    await writeFile(
      join(base, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'run-7',
        status: 'committing',
        files: ['state/timeline.json'],
        applied: [],
        current: { path: 'state/timeline.json', installed: false },
      }),
      'utf8',
    )

    const transaction = new WorkspaceTransaction(root, 'run-7')
    expect(await transaction.recover()).toBe('rolled-back')
    await expect(readFile(join(root, 'state', 'timeline.json'), 'utf8')).resolves.toBe('old\n')
  })

  it('leaves a committed workspace untouched when recover finds no crash', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'timeline.json'), 'committed\n', 'utf8')
    const base = join(root, '.writex', 'staged', 'run-8')
    await mkdir(base, { recursive: true })
    await writeFile(
      join(base, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'run-8',
        status: 'committed',
        files: ['state/timeline.json'],
        applied: ['state/timeline.json'],
        current: null,
      }),
      'utf8',
    )

    const transaction = new WorkspaceTransaction(root, 'run-8')
    expect(await transaction.recover()).toBe('committed')
    await expect(readFile(join(root, 'state', 'timeline.json'), 'utf8')).resolves.toBe('committed\n')
  })

  it('recover rejects an unsafe artifact path in a committing manifest and never rolls it back', async () => {
    const root = await makeRoot()
    const base = join(root, '.writex', 'staged', 'run-corrupt')
    await mkdir(base, { recursive: true })
    await writeFile(
      join(base, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'run-corrupt',
        status: 'committing',
        files: ['.git/config'],
        applied: ['.git/config'],
        current: null,
      }),
      'utf8',
    )

    const transaction = new WorkspaceTransaction(root, 'run-corrupt')
    await expect(transaction.recover()).rejects.toThrow(/invalid transaction manifest/)
    await expect(transaction.readManifest()).rejects.toThrow(/invalid transaction manifest/)
  })

  it('rejects stageText paths with reserved device names, invalid characters, or trailing dots and spaces', async () => {
    const root = await makeRoot()
    const transaction = new WorkspaceTransaction(root, 'run-9')
    const unsafePaths = [
      'state/file.txt:secret',
      'state/CON',
      'state/NUL.txt',
      'state/name.',
      'state/name ',
    ]
    for (const path of unsafePaths) {
      await expect(transaction.stageText(path, 'bad')).rejects.toThrow(/unsafe artifact path/)
    }
  })

  it('rejects runIds ending in a dot or space or matching a reserved device name', async () => {
    const root = await makeRoot()
    for (const runId of ['run.', 'CON', 'NUL.txt']) {
      expect(() => new WorkspaceTransaction(root, runId)).toThrow(/invalid runId/)
    }
  })

  describe('recover manifest validation', () => {
    const validManifest = {
      schemaVersion: 1,
      runId: 'run-malformed',
      status: 'committing',
      files: ['state/target.txt'],
      applied: ['state/target.txt'],
      current: null,
    }
    const malformed: Array<{ name: string; override: Record<string, unknown> }> = [
      { name: 'schemaVersion 2', override: { schemaVersion: 2 } },
      { name: 'runId differing from the constructor runId', override: { runId: 'run-other' } },
      { name: 'an unknown status', override: { status: 'unknown' } },
      { name: 'files that are not a string array', override: { files: [42] } },
      {
        name: 'an applied path absent from files',
        override: { files: ['state/other.txt'], applied: ['state/target.txt'] },
      },
      {
        name: 'a current path absent from files',
        override: {
          files: ['state/other.txt'],
          current: { path: 'state/target.txt', installed: true },
        },
      },
      {
        name: 'a current entry whose installed flag is not boolean',
        override: { current: { path: 'state/target.txt', installed: 'yes' } },
      },
    ]

    it.each(malformed)(
      'recover rejects an invalid transaction manifest ($name) before touching any artifact',
      async ({ override }) => {
        const root = await makeRoot()
        const base = join(root, '.writex', 'staged', 'run-malformed')
        await mkdir(join(root, 'state'), { recursive: true })
        await writeFile(join(root, 'state', 'target.txt'), 'SENTINEL\n', 'utf8')
        await mkdir(join(base, 'backups', 'state'), { recursive: true })
        await writeFile(join(base, 'backups', 'state', 'target.txt'), 'BACKUP\n', 'utf8')
        const manifestText = JSON.stringify({ ...validManifest, ...override })
        await mkdir(base, { recursive: true })
        await writeFile(join(base, 'manifest.json'), manifestText, 'utf8')

        const transaction = new WorkspaceTransaction(root, 'run-malformed')
        await expect(transaction.recover()).rejects.toThrow(/invalid transaction manifest/)
        await expect(readFile(join(root, 'state', 'target.txt'), 'utf8')).resolves.toBe('SENTINEL\n')
        await expect(readFile(join(base, 'manifest.json'), 'utf8')).resolves.toBe(manifestText)
      },
    )

    it('recover rejects an unsafe artifact path in files even when the status is committed', async () => {
      const root = await makeRoot()
      const base = join(root, '.writex', 'staged', 'run-unsafe')
      await mkdir(join(root, 'state'), { recursive: true })
      await writeFile(join(root, 'state', 'target.txt'), 'SENTINEL\n', 'utf8')
      await mkdir(base, { recursive: true })
      const manifestText = JSON.stringify({
        schemaVersion: 1,
        runId: 'run-unsafe',
        status: 'committed',
        files: ['.git/config'],
        applied: [],
        current: null,
      })
      await writeFile(join(base, 'manifest.json'), manifestText, 'utf8')

      const transaction = new WorkspaceTransaction(root, 'run-unsafe')
      await expect(transaction.recover()).rejects.toThrow(/invalid transaction manifest/)
      await expect(readFile(join(root, 'state', 'target.txt'), 'utf8')).resolves.toBe('SENTINEL\n')
      await expect(readFile(join(base, 'manifest.json'), 'utf8')).resolves.toBe(manifestText)
    })
  })
})

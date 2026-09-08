import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { atomicWriteFile } from './atomic.js'

export interface Manifest {
  schemaVersion: 1
  runId: string
  status: 'staging' | 'committing' | 'committed' | 'rolled-back'
  files: string[]
  applied: string[]
  current: { path: string; installed: boolean } | null
}

export type BeforeApply = (index: number, relativePath: string) => Promise<void>

const validRunId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const reservedDeviceNames = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

/**
 * True when a single normalized path component is unsafe on common
 * platforms: it contains control characters or Windows-reserved filename
 * characters, ends in a dot or space, or its base name (before the first
 * dot) case-insensitively matches a reserved device name such as CON, NUL,
 * or COM1.
 */
function unsafePathComponent(component: string): boolean {
  return (
    /[\u0000-\u001f\u007f<>:"|?*]/.test(component) ||
    /[. ]$/.test(component) ||
    reservedDeviceNames.has((component.split('.')[0] ?? '').toUpperCase())
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/**
 * Validate `value` as an artifact path relative to the workspace root and
 * return it in normalized forward-slash form. Both slash styles are treated as
 * separators before validation so that Windows-style traversal, drive-letter,
 * and UNC paths are rejected even when the platform separator differs.
 */
function safeRelativePath(value: string): string {
  const canonical = posix.normalize(value.replace(/\\/g, '/'))
  const absolute =
    canonical.startsWith('/') ||
    canonical.startsWith('//') ||
    /^[A-Za-z]:\//.test(canonical)
  if (
    value.trim() === '' ||
    canonical === '' ||
    canonical === '.' ||
    canonical === '..' ||
    absolute ||
    canonical.startsWith('../') ||
    canonical === '.git' ||
    canonical.startsWith('.git/') ||
    canonical === '.writex' ||
    canonical.startsWith('.writex/')
  ) {
    throw new Error(`unsafe artifact path: ${value}`)
  }
  for (const segment of canonical.split('/')) {
    if (unsafePathComponent(segment)) {
      throw new Error(`unsafe artifact path: ${value}`)
    }
  }
  return canonical
}

/**
 * A staged, multi-artifact transaction over a workspace root. Files are staged
 * under root/.writex/staged/<runId>/files, applied to the workspace one at a
 * time with backups under root/.writex/staged/<runId>/backups, and the
 * transaction manifest at root/.writex/staged/<runId>/manifest.json records
 * enough state to roll a process interruption back to a consistent workspace.
 */

const allowedManifestStatuses = new Set(['staging', 'committing', 'committed', 'rolled-back'])

function invalidManifest(reason: string): never {
  throw new Error(`invalid transaction manifest: ${reason}`)
}

/**
 * Validate a persisted manifest read from disk and return it in normalized
 * form. Every path in `files`, `applied`, and `current` passes through
 * `safeRelativePath` so only safe artifact paths can ever be restored. Any
 * failure throws `invalid transaction manifest: <reason>` with only a short
 * reason category, never an untrusted path from the manifest itself.
 */
function parseManifest(raw: string, expectedRunId: string): Manifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalidManifest('not json')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidManifest('invalid shape')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    invalidManifest('unsupported schema version')
  }
  if (record.runId !== expectedRunId) {
    invalidManifest('run id mismatch')
  }
  if (
    typeof record.status !== 'string' ||
    !allowedManifestStatuses.has(record.status)
  ) {
    invalidManifest('unknown status')
  }
  if (!Array.isArray(record.files) || record.files.some((entry) => typeof entry !== 'string')) {
    invalidManifest('files not string array')
  }
  if (!Array.isArray(record.applied) || record.applied.some((entry) => typeof entry !== 'string')) {
    invalidManifest('applied not string array')
  }
  let files: string[]
  try {
    files = (record.files as string[]).map((path) => safeRelativePath(path))
  } catch {
    invalidManifest('unsafe path in files')
  }
  let applied: string[]
  try {
    applied = (record.applied as string[]).map((path) => safeRelativePath(path))
  } catch {
    invalidManifest('unsafe path in applied')
  }
  if (new Set(files).size !== files.length) {
    invalidManifest('duplicate path in files')
  }
  if (new Set(applied).size !== applied.length) {
    invalidManifest('duplicate path in applied')
  }
  const fileSet = new Set(files)
  for (const path of applied) {
    if (!fileSet.has(path)) {
      invalidManifest('applied path not in files')
    }
  }
  let current: Manifest['current'] = null
  if (record.current !== null) {
    if (typeof record.current !== 'object' || Array.isArray(record.current)) {
      invalidManifest('invalid current')
    }
    const currentRecord = record.current as Record<string, unknown>
    if (typeof currentRecord.path !== 'string' || typeof currentRecord.installed !== 'boolean') {
      invalidManifest('invalid current')
    }
    let currentPath: string
    try {
      currentPath = safeRelativePath(currentRecord.path)
    } catch {
      invalidManifest('unsafe path in current')
    }
    if (!fileSet.has(currentPath)) {
      invalidManifest('current path not in files')
    }
    current = { path: currentPath, installed: currentRecord.installed }
  }
  return {
    schemaVersion: 1,
    runId: expectedRunId,
    status: record.status as Manifest['status'],
    files,
    applied,
    current,
  }
}
export class WorkspaceTransaction {
  private readonly base: string
  private readonly filesRoot: string
  private readonly backupsRoot: string
  private readonly manifestPath: string
  private manifest: Manifest

  constructor(
    private readonly root: string,
    private readonly runId: string,
    private readonly beforeApply: BeforeApply = async () => undefined,
  ) {
    if (!validRunId.test(runId) || unsafePathComponent(runId)) {
      throw new Error(`invalid runId: ${runId}`)
    }
    this.base = join(root, '.writex', 'staged', runId)
    this.filesRoot = join(this.base, 'files')
    this.backupsRoot = join(this.base, 'backups')
    this.manifestPath = join(this.base, 'manifest.json')
    this.manifest = {
      schemaVersion: 1,
      runId,
      status: 'staging',
      files: [],
      applied: [],
      current: null,
    }
  }

  private async saveManifest(): Promise<void> {
    await atomicWriteFile(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`)
  }

  async stageText(relativePath: string, content: string): Promise<void> {
    if (this.manifest.status !== 'staging') {
      throw new Error(
        `stageText requires status staging, got ${this.manifest.status}: not staging`,
      )
    }
    const path = safeRelativePath(relativePath)
    if (!this.manifest.files.includes(path)) {
      this.manifest.files.push(path)
    }
    await mkdir(dirname(join(this.filesRoot, path)), { recursive: true })
    await writeFile(join(this.filesRoot, path), content, 'utf8')
    await this.saveManifest()
  }

  /**
   * Undo an interrupted or failed commit. Handles both a partially installed
   * `current` file and fully applied files recorded in `applied`. Only
   * validated artifact paths are ever touched, so root infrastructure like
   * `.git` and `.writex` is never removed.
   */
  private async restoreApplied(): Promise<void> {
    const visited = new Set<string>()
    const restoreOne = async (path: string, installedFlag: boolean | null): Promise<void> => {
      const safe = safeRelativePath(path)
      if (visited.has(safe)) {
        return
      }
      visited.add(safe)
      const staged = join(this.filesRoot, safe)
      // A path is considered installed when the manifest says so or when its
      // staged source is gone (the rename to the target already happened).
      const installed = installedFlag === null ? !(await exists(staged)) : installedFlag || !(await exists(staged))
      if (installed) {
        await mkdir(dirname(join(this.root, safe)), { recursive: true })
        await rm(join(this.root, safe), { force: true })
      }
      const backup = join(this.backupsRoot, safe)
      if (await exists(backup)) {
        const target = join(this.root, safe)
        await mkdir(dirname(target), { recursive: true })
        await rename(backup, target)
      }
    }

    if (this.manifest.current) {
      await restoreOne(this.manifest.current.path, this.manifest.current.installed)
    }
    for (const path of [...this.manifest.applied].reverse()) {
      await restoreOne(path, null)
    }
    this.manifest.current = null
    this.manifest.status = 'rolled-back'
    await this.saveManifest()
  }

  async commit(): Promise<void> {
    if (this.manifest.status !== 'staging') {
      throw new Error(`commit requires status staging, got ${this.manifest.status}`)
    }
    if (this.manifest.files.length === 0) {
      throw new Error('commit requires at least one staged file')
    }
    this.manifest.status = 'committing'
    await this.saveManifest()
    try {
      for (const [index, path] of this.manifest.files.entries()) {
        await this.beforeApply(index, path)
        const staged = join(this.filesRoot, path)
        const target = join(this.root, path)
        const backup = join(this.backupsRoot, path)
        this.manifest.current = { path, installed: false }
        await this.saveManifest()
        await mkdir(dirname(target), { recursive: true })
        if (await exists(target)) {
          await mkdir(dirname(backup), { recursive: true })
          await rename(target, backup)
        }
        await rename(staged, target)
        this.manifest.current = { path, installed: true }
        await this.saveManifest()
        this.manifest.applied.push(path)
        this.manifest.current = null
        await this.saveManifest()
      }
      this.manifest.status = 'committed'
      await this.saveManifest()
    } catch (error) {
      try {
        await this.restoreApplied()
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `commit failed and rollback also failed for run ${this.runId}`,
        )
      }
      throw error
    }
  }

  /**
   * Reload the manifest from disk. A manifest left in `committing` by a
   * crashed process is rolled back; the other statuses require no file
   * changes. Returns the resulting status.
   */
  async recover(): Promise<Manifest['status']> {
    const raw = await readFile(this.manifestPath, 'utf8')
    this.manifest = parseManifest(raw, this.runId)
    if (this.manifest.status === 'committing') {
      await this.restoreApplied()
    }
    return this.manifest.status
  }

  async readManifest(): Promise<Manifest> {
    const raw = await readFile(this.manifestPath, 'utf8')
    return parseManifest(raw, this.runId)
  }
}

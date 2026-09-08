import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendRunEvent, readRunEvents } from '@writex/workspace'
import type { RunEvent } from '@writex/contracts'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'writex-events-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const runCreatedEvent = {
  schemaVersion: 1,
  eventId: 'event-1',
  runId: 'run-1',
  type: 'run/created',
  occurredAt: '2026-09-02T00:00:00.000Z',
  payload: {},
} satisfies RunEvent

describe('appendRunEvent / readRunEvents', () => {
  it('appends a run event as a single JSON line and reads it back equal', async () => {
    const root = await makeRoot()

    await appendRunEvent(root, runCreatedEvent)

    const events = await readRunEvents(root)
    expect(events).toEqual([runCreatedEvent])

    const raw = await readFile(join(root, '.writex', 'events.jsonl'), 'utf8')
    expect(raw).toBe(`${JSON.stringify(runCreatedEvent)}\n`)
  })

  it('returns [] when the events file does not exist', async () => {
    const root = await makeRoot()

    await expect(readRunEvents(root)).resolves.toEqual([])
  })

  it('ignores blank and whitespace-only lines around a valid event', async () => {
    const root = await makeRoot()
    const dir = join(root, '.writex')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'events.jsonl'),
      `\n   \n\t \n${JSON.stringify(runCreatedEvent)}\n  \n`,
      'utf8',
    )

    await expect(readRunEvents(root)).resolves.toEqual([runCreatedEvent])
  })
})

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunEvent } from '@writex/contracts'

function eventsPath(root: string): string {
  return join(root, '.writex', 'events.jsonl')
}

/** Append `event` as one JSON line to root/.writex/events.jsonl, creating parents as needed. */
export async function appendRunEvent(root: string, event: RunEvent): Promise<void> {
  const path = eventsPath(root)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
}

/**
 * Read every appended event in order. Blank and whitespace-only lines are
 * ignored. A root without an events file yields []; any other read/parse error
 * is rethrown.
 */
export async function readRunEvents(root: string): Promise<RunEvent[]> {
  let raw: string
  try {
    raw = await readFile(eventsPath(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const events: RunEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    events.push(JSON.parse(line) as RunEvent)
  }
  return events
}

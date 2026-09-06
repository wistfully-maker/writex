import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { CompactionCapsule, DriverCheckpoint, DriverOpenOptions } from './contracts.js'
import { PersistentDshSessionDriver } from './driver.js'

interface DriverLike {
  send(message: string): Promise<DriverCheckpoint>
  saveCompactionCapsule(capsule: CompactionCapsule): Promise<string>
  close(): Promise<void>
}

export type OpenDriver = (options: DriverOpenOptions) => Promise<DriverLike>

type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('command must be an object')
  return value as Record<string, unknown>
}

function exact(record: Record<string, unknown>, fields: string[]): void {
  const allowed = new Set(fields)
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`unknown command field: ${key}`)
}

export class JsonlController {
  private driver: DriverLike | undefined

  constructor(
    private readonly openDriver: OpenDriver,
    private readonly harnessFactory: DriverOpenOptions['harnessFactory'],
  ) {}

  async handle(input: unknown): Promise<Response> {
    let id = 'unknown'
    try {
      const command = object(input)
      if (typeof command.id !== 'string' || command.id === '') throw new Error('command id is required')
      id = command.id
      if (command.type === 'open') {
        exact(command, ['id', 'type', 'controllerRoot', 'config'])
        if (this.driver) throw new Error('driver is already open')
        if (typeof command.controllerRoot !== 'string') throw new Error('controllerRoot is required')
        this.driver = await this.openDriver({
          config: command.config,
          controllerRoot: command.controllerRoot,
          harnessFactory: this.harnessFactory,
        })
        return { id, ok: true, result: { status: 'idle' } }
      }
      if (!this.driver) throw new Error('driver is not open')
      if (command.type === 'send') {
        exact(command, ['id', 'type', 'message'])
        if (typeof command.message !== 'string') throw new Error('message is required')
        return { id, ok: true, result: await this.driver.send(command.message) }
      }
      if (command.type === 'capsule') {
        exact(command, ['id', 'type', 'capsule'])
        return {
          id,
          ok: true,
          result: { path: await this.driver.saveCompactionCapsule(command.capsule as CompactionCapsule) },
        }
      }
      if (command.type === 'close') {
        exact(command, ['id', 'type'])
        await this.shutdown()
        return { id, ok: true, result: { status: 'closed' } }
      }
      throw new Error('unknown command type')
    } catch (error) {
      return {
        id,
        ok: false,
        error: { code: 'DSH_DRIVER_ERROR', message: error instanceof Error ? error.message : 'unknown error' },
      }
    }
  }

  async shutdown(): Promise<void> {
    const driver = this.driver
    if (!driver) return
    try {
      await driver.close()
      this.driver = undefined
    } catch (error) {
      this.driver = driver
      throw error
    }
  }
}

export async function startJsonlLoop(
  input: Readable,
  output: Writable,
  controller: JsonlController,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  let chain = Promise.resolve()
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      let closed = false
      chain = chain.then(async () => {
        let command: unknown
        try {
          command = JSON.parse(line)
        } catch {
          output.write(`${JSON.stringify({ id: 'unknown', ok: false, error: { code: 'INVALID_JSON', message: 'invalid JSON' } })}\n`)
          return
        }
        const response = await controller.handle(command)
        output.write(`${JSON.stringify(response)}\n`)
        if (
          response.ok &&
          typeof command === 'object' &&
          command !== null &&
          (command as { type?: unknown }).type === 'close'
        ) {
          closed = true
        }
      })
      await chain
      if (closed) {
        lines.close()
        break
      }
    }
  } finally {
    await controller.shutdown()
  }
}

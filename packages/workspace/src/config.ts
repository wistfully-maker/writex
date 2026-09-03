import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { NovelConfig } from '@writex/contracts'

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Read and validate the writex.yaml at `root`, returning the parsed config. */
export async function loadNovelConfig(root: string): Promise<NovelConfig> {
  const configPath = join(root, 'writex.yaml')

  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch {
    throw new Error(`cannot read config file: ${configPath}`)
  }

  const data: unknown = parse(text)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`config file must contain an object: ${configPath}`)
  }

  const record = data as Record<string, unknown>

  if (record.schemaVersion !== 1) {
    throw new Error('unsupported schemaVersion: expected 1')
  }
  if (!isNonBlankString(record.title)) {
    throw new Error('title must be a non-blank string')
  }
  if (!isNonBlankString(record.style)) {
    throw new Error('style must be a non-blank string')
  }
  if (!isNonBlankString(record.qualityProfile)) {
    throw new Error('qualityProfile must be a non-blank string')
  }
  if (record.language !== 'zh-CN') {
    throw new Error('language must be "zh-CN"')
  }

  return {
    schemaVersion: 1,
    title: record.title as string,
    language: 'zh-CN',
    style: record.style as string,
    qualityProfile: record.qualityProfile as string,
  }
}

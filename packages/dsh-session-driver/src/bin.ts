#!/usr/bin/env node
import { JsonlController, startJsonlLoop } from './jsonl-controller.js'
import { PersistentDshSessionDriver } from './driver.js'
import { createOfficialDshHarness } from './sdk-adapter.js'

const controller = new JsonlController(
  (options) => PersistentDshSessionDriver.open(options),
  createOfficialDshHarness,
)

await startJsonlLoop(process.stdin, process.stdout, controller)

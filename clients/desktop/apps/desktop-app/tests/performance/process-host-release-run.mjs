#!/usr/bin/env node

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from '@playwright/test';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');
const benchmarkPath = path.join(
  currentDir,
  'process-host-release-benchmark.mjs',
);
const outputPath =
  process.env.CANOPY_PROCESS_HOST_BENCHMARK_OUTPUT ??
  path.join(repoRoot, '.performance', 'desktop', 'process-host-release.json');
const env = {
  ...process.env,
  CANOPY_PROCESS_HOST_BENCHMARK_OUTPUT: outputPath,
  PROCESS_HOST_BENCHMARK_NODE_BINARY: process.execPath,
};
delete env.ELECTRON_RUN_AS_NODE;

await rm(outputPath, { force: true });
const electronApp = await electron.launch({
  executablePath: electronPath,
  cwd: repoRoot,
  args: ['--use-mock-keychain', benchmarkPath],
  env,
});
await electronApp.waitForEvent('close');
process.stdout.write(await readFile(outputPath, 'utf8'));
process.stdout.write(`Wrote ${outputPath}\n`);

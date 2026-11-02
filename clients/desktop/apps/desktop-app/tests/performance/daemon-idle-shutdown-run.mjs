#!/usr/bin/env node

/**
 * Standalone daemon idle/shutdown population (macOS). Each launch gets a fresh
 * disposable data root, a leased client renewing at desktop's 15 s cadence,
 * a declared warm-up, one idle window and one stop; see
 * docs/desktop-app-performance.md#daemon-idle-and-shutdown-populations-can-4608.
 *
 * Usage: node --import tsx daemon-idle-shutdown-run.mjs [--executable <path>]
 *   [--arm standalone|product-on|flag-off] [--stop signal|idle-grace]
 *   [--cycles <n>] [--output <path>]
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createCanopyClientLease } from '@canopy/core-client';
import { connectCanopyClient } from '@canopy/core-client/node';
import { CANOPY_RUNTIME_QUERY_DEFINITIONS } from '@canopy/core-runtime';
import { CORE_TRANSPORT_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';
import { daemonName } from '../../../../packages/protocol/src/brand.ts';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import {
  LIFECYCLE_DEFAULTS,
  POPULATION_ARMS,
  POPULATION_DEFAULTS,
  STOP_MODES,
  collectContext,
  interruptOnSignals,
  listProcessTable,
  runIdleShutdownPopulation,
  runnerExitCode,
} from './daemon-idle-shutdown.mjs';
import { createNetworkResourceReader } from './network-resources.mjs';
import { createNativeResourceReader } from './process-resources.mjs';

const RENEWAL_INTERVAL_MS = 15_000;
const here = import.meta.dirname;
const repoRoot = path.resolve(here, '../../../..');
const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
const { values } = parseArgs({
  options: {
    executable: { type: 'string' },
    arm: { type: 'string', default: 'standalone' },
    stop: { type: 'string', default: 'signal' },
    cycles: { type: 'string', default: String(POPULATION_DEFAULTS.cycles) },
    output: { type: 'string' },
  },
});
// Validated before the output path is built or cleared.
if (!POPULATION_ARMS.includes(values.arm))
  throw new Error(`--arm must be one of ${POPULATION_ARMS.join(', ')}`);
if (!STOP_MODES.includes(values.stop))
  throw new Error(`--stop must be one of ${STOP_MODES.join(', ')}`);
const cycles = Number(values.cycles);
if (!Number.isSafeInteger(cycles) || cycles < 1)
  throw new Error('--cycles must be a positive integer');
const outputDirectory = path.join(repoRoot, '.performance', 'desktop');
const output = path.resolve(
  values.output ??
    path.join(
      outputDirectory,
      `daemon-idle-shutdown-${values.arm}-${values.stop}.json`,
    ),
);
if (values.output === undefined && path.dirname(output) !== outputDirectory)
  throw new Error(`Default output escapes ${outputDirectory}: ${output}`);
// An aborted run must not leave an earlier run's result at this path.
rmSync(output, { force: true });
const executable = path.resolve(
  values.executable ??
    path.join(repoRoot, 'dist', 'core-daemon', daemonName(brand)),
);

const native = await createNativeResourceReader();
if (native.unavailable) throw new Error(native.unavailable);
const network = await createNetworkResourceReader({ resourceReader: native });
statSync(executable);

/** Without `GIT_*`, so a run from a Git hook never targets this checkout. */
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function createDataRoot() {
  // Native: the daemon compares against the native realpath.
  const dataRoot = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'daemon-idle-')),
  );
  chmodSync(dataRoot, 0o700);
  return dataRoot;
}

/**
 * Deliberate exception to apps/desktop-app AGENTS.md's central binary lookup
 * and enhanced environment rule: like scripts/smoke-core-daemon.mjs, the
 * standalone population measures the built artifact itself under a controlled
 * environment, not the desktop launch path. Product arms launch nothing until
 * CAN-4603.
 */
function spawnDaemon(dataRoot) {
  return spawn(executable, ['--data-root', dataRoot, '--runtime-mode', 'dev'], {
    env: environment,
    stdio: ['ignore', 'inherit', 'inherit'],
    // Own process group, so late group members stay attributable after exit.
    detached: true,
  });
}

async function attach(descriptor, dataRoot) {
  const client = await connectCanopyClient({
    endpoint: {
      kind: 'socket',
      path: descriptor.endpoint.path,
      auth: {
        secret: await readFile(descriptor.tokenRef, 'utf8'),
        dataRootHash: createHash('sha256').update(dataRoot).digest('hex'),
      },
    },
    clientName: 'daemon-idle-shutdown',
    clientVersion: '0',
    definitions: {
      queries: CANOPY_RUNTIME_QUERY_DEFINITIONS,
      instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
  });
  let renewals = 0;
  const errors = [];
  const counted = {
    get signal() {
      return client.signal;
    },
    instruction(method, ...rest) {
      if (method === 'core.client.lease.renew') renewals += 1;
      return client.instruction(method, ...rest);
    },
    close: () => client.close(),
  };
  try {
    const health = await client.query('core.runtime.health.get', {});
    if (health.runtime.state !== 'ready')
      throw new Error(`Daemon is ${health.runtime.state}, not ready.`);
    const lease = createCanopyClientLease({
      client: counted,
      // A reconnect would change the measured connection; fail the trial instead.
      attach: () =>
        Promise.reject(new Error('Reconnect is outside this measurement.')),
      identity: {
        clientInstanceId: randomUUID(),
        interfaceKind: 'cli',
        label: 'Daemon idle measurement',
      },
      renewalIntervalMs: RENEWAL_INTERVAL_MS,
      presence: () => ({ interactive: false, foreground: false }),
      onError: (error) => errors.push(error.message),
    });
    await lease.acquire();
    return {
      renewals: () => renewals,
      async release() {
        try {
          await lease.release('normal_shutdown');
          if (errors.length)
            throw new Error(`Lease errors: ${errors.join('; ')}`);
        } finally {
          await client.close();
        }
      },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

const context = await collectContext({
  executable,
  collectors: [
    path.join(here, 'daemon-idle-shutdown.mjs'),
    path.join(here, 'daemon-idle-shutdown-run.mjs'),
    path.join(here, 'process-resources.mjs'),
    path.join(here, 'network-resources.mjs'),
  ],
  options: { brand: brand.id, renewalIntervalMs: RENEWAL_INTERVAL_MS },
});
// Each daemon runs in its own process group, so it never sees the terminal's
// SIGINT; default termination here would strand it and its data root.
const interruption = interruptOnSignals();
const artifact = await runIdleShutdownPopulation(
  {
    ...POPULATION_DEFAULTS,
    arm: values.arm,
    stop: values.stop,
    cycles,
    censorMs: LIFECYCLE_DEFAULTS.censorMs,
  },
  {
    createDataRoot,
    spawnDaemon,
    attach,
    native,
    network: network.unavailable ? null : network,
    listTable: listProcessTable,
    signal: interruption.signal,
    context: { ...context, network: network.unavailable ?? 'nettop' },
    onTrial: (trial, index) =>
      console.log(
        `Launch ${index + 1}: ${trial.outcome}${trial.reason ? ` (${trial.reason})` : ''}`,
      ),
  },
);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${output}`);
if (['failed', 'interrupted'].includes(artifact.population.status))
  console.error(
    `Population ${artifact.population.status}: ${artifact.population.reason}`,
  );
process.exitCode = runnerExitCode(artifact);
interruption.dispose();

/**
 * Same-host production verification on hosted macOS or guarded physical Macs.
 * Local execution is qualification-only; no bypass, retries or stable switch.
 * Fresh headless studies use two independent checkouts: qualification is 33 driver
 * invocations; exploratory retains 66. No stable execution or acceptance.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  lstat,
  readlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  applyDevScriptSafetyWithWait,
  MEMORY_PRESSURE_THRESHOLD_ENV,
} from '../../../../scripts/lib/dev-script-safety.mjs';
import {
  assertHeadlessStudyMetadata,
  assertProductionHeadlessEvidence,
  assertProductionHeadlessTerminal,
  HEADLESS_STUDY_MODE,
  HEADLESS_STUDY_VIEWPORT,
} from './browser-profiles-evidence.mjs';

import {
  RELEASE_TASK_COUNTS,
  validateReleaseSample,
  validateReleaseStructure,
  classifyReleaseReport,
} from './browser-profiles-release-evidence.mjs';

/** pnpm checkouts carry pnpm-lock.yaml; older (npm) checkouts package-lock.json. */
async function stagePackageManager(root) {
  try {
    await lstat(path.join(root, 'pnpm-lock.yaml'));
    return {
      lockfile: 'pnpm-lock.yaml',
      executable: 'pnpm',
      install: ['install', '--frozen-lockfile'],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      lockfile: 'package-lock.json',
      executable: 'npm',
      install: ['ci'],
    };
  }
}
export {
  RELEASE_TASK_COUNTS,
  validateReleaseSample,
  validateReleaseStructure,
  classifyReleaseReport,
};
const finite = (value, label) =>
  assert(Number.isFinite(value) && value >= 0, `Missing/invalid ${label}`);

export const BASELINE_SHA = '50ad63d648b27f867aa248cf3e8517aac0b4308d';
const BASELINE_TREE = '7e063f1552bea71e55690d57538ccbbb71bf730a';
const DRIVER_ROOT = 'apps/desktop-app/tests/performance/';
const MODES = [
  'common',
  'maintenance',
  'startup',
  'cold',
  'veto',
  'inventory',
  'retirement',
];
const MATCHED = ['common', 'startup', 'cold', 'veto'];
const PROFILE_E2E_HOOKS = [
  '__CANOPY_E2E_DISPATCH_BROWSER_ACTION__',
  '__CANOPY_E2E_BROWSER_MCP_ROUTE__',
  '__CANOPY_E2E_BROWSER_DOWNLOADS__',
  '__CANOPY_E2E_BROWSER_RESTORE_BARRIER__',
];
const REVIEWED_RELEASE_OVERLAYS = Object.freeze({
  'apps/desktop-app/tests/performance/browser-profiles-release-evidence.mjs':
    null,
  'apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs':
    null,
  'apps/desktop-app/tests/performance/browser-profiles-production-headless-preflight.mjs':
    null,
  'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs':
    '1f8f99a193256929cc4d70e8731e193a6482bff9e2334889449ae3f9af37a5f8',
  'apps/desktop-app/tests/performance/diagnostics.mjs':
    '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
  'apps/desktop-app/tests/electron/launchCanopy.mjs':
    'fd591e8a4999aecea184e1201bc4167f2e954efcbab0e6fef1481f6254be7c4a',
  'apps/desktop-app/tests/electron/canopyApp.mjs':
    '32901c00d59424d256ae6d84e307da3204240d454a9a2c3a86f05e9ce92dde7a',
  'apps/desktop-app/tests/performance/monitor.mjs':
    '5d644bd000078fce4776cc0f8d09072cfc3ec719cf98da331dd1e27db53de02c',
  'apps/desktop-app/tests/performance/process-tree-supervisor.mjs':
    '0cff1607b1d40332ef15c1e96135a4d53c73d3ca5e9aed45dc67eaf53851a04d',
  'apps/desktop-app/tests/performance/profiles.mjs':
    '63217c1d9d4714ec0602a0f4cca00f157322ea101a2a207e3ea4d3c9f9a10667',
  'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs': null,
  'apps/desktop-app/tests/performance/browser-profile-data-workload.mjs': null,
  'apps/desktop-app/tests/performance/browser-profiles-startup-run.mjs': null,
  'apps/desktop-app/tests/performance/browser-profiles-startup-sampler.mjs':
    null,
  'apps/desktop-app/tests/performance/browser-profiles-supplemental-run.mjs':
    null,
  'apps/desktop-app/tests/electron/seeders/browser-profile-state.mjs':
    '4f4983f03a92f571f7c339e503a3b6a9151f773b523df9ef901e33ce465290fc',
  'apps/desktop-app/tests/electron/seeders/seedWorktreeChat.mjs':
    'f43372c5fd3486929f3e426ebd665d07b815b744f62d8f81331a3c816c12ae1d',
  'scripts/lib/e2e-harness-measurement.mjs': null,
});
const REVIEWED_FRAME_TRACE_DIAGNOSTIC_OVERLAYS = Object.freeze({
  'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs': {
    original:
      'ad9de48370ee82ba2d12b3df923f0535ded2c1d2bb2d63b9ce3080cdbce70003',
    installed:
      'a4c8f61e7752fbfa0869b1483fe957cc6ce43e09b5f9d97a27ab2981bd070a21',
  },
  'apps/desktop-app/tests/performance/diagnostics.mjs': {
    original:
      '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
    installed:
      '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
  },
});
export function assertReviewedReleaseOverlay(
  file,
  previousSha256,
  installedSha256,
) {
  if (previousSha256 === installedSha256) return;
  assert(
    Object.hasOwn(REVIEWED_RELEASE_OVERLAYS, file),
    `Unreviewed release helper delta: ${file}`,
  );
  assert.equal(
    previousSha256,
    REVIEWED_RELEASE_OVERLAYS[file],
    `Original release helper bytes changed: ${file}`,
  );
}
export function assertReviewedFrameTraceDiagnosticOverlay(
  file,
  previousSha256,
  installedSha256,
) {
  const identity = REVIEWED_FRAME_TRACE_DIAGNOSTIC_OVERLAYS[file];
  assert(identity, `Unreviewed frame-trace diagnostic overlay: ${file}`);
  assert.equal(
    previousSha256,
    identity.original,
    `Original frame-trace diagnostic bytes changed: ${file}`,
  );
  assert.equal(
    installedSha256,
    identity.installed,
    `Installed frame-trace diagnostic bytes changed: ${file}`,
  );
}
export function assertProductionBootstrapImports(source, ts) {
  let productTargets = 0;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      assert(
        node.expression.kind !== ts.SyntaxKind.ImportKeyword,
        'Bootstrap dynamic imports prohibited',
      );
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
        assert(
          node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
          'Nonliteral bootstrap import',
        );
        const target = node.arguments[0].text;
        assert(
          target === './index.js' ||
            target === 'electron' ||
            target.startsWith('node:'),
          'Unexpected bootstrap target',
        );
        if (target === './index.js') productTargets++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(
    ts.createSourceFile('bootstrap.cjs', source, ts.ScriptTarget.Latest, true),
  );
  assert.equal(
    productTargets,
    1,
    'Bootstrap must have one literal production sibling target',
  );
}
export function comparablePackage(value) {
  const result = structuredClone(value);
  // Reviewed delta: candidate adds --import tsx to this unit-test command.
  // Every other script, dependency/workspace/override/pin/brand field must match.
  delete result.scripts['test:desktop-performance'];
  return result;
}
const EXPLICIT_ENV = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  CANOPY_SKIP_BINARY_STAGING_POSTINSTALL: 'true',
  CANOPY_CLOUD_BASE_URL: 'http://127.0.0.1:4011',
  CANOPY_E2E_BUILD: '0',
  CANOPY_BRAND: 'canopy',
  CANOPY_RELEASE_FLAVOR: 'stable',
  CANOPY_DATADOG_ENABLED: 'false',
  // Current builds never obfuscate; these keep the pinned historical baseline,
  // which still reads them, building a comparable unobfuscated renderer.
  CANOPY_RENDERER_OBFUSCATION: 'false',
  CANOPY_RENDERER_OBFUSCATE_VENDOR: 'false',
  CANOPY_DATADOG_SOURCEMAPS: 'false',
  CANOPY_OLLAMA_ENABLED: 'true',
  CANOPY_DESKTOP_SHARED_SIDEBAR: 'false',
  CANOPY_DESKTOP_SIDEBAR_SHADOW: 'false',
  LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID: '',
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
};
let traversalDeadline = Infinity;
const checkTraversal = () =>
  assert(
    Date.now() < traversalDeadline,
    'Evidence traversal deadline exhausted',
  );
const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, function (_key, entry) {
    return entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry;
  });
const equal = (a, b, message) =>
  assert.equal(canonical(a), canonical(b), message);
export function requireHostedMac(
  env = process.env,
  platform = process.platform,
) {
  assert(
    platform === 'darwin' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.CI === 'true' &&
      env.RUNNER_OS === 'macOS' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      /^\d+$/.test(env.GITHUB_RUN_ID ?? '') &&
      /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') &&
      env.GITHUB_WORKSPACE &&
      env.RUNNER_TEMP &&
      env.ImageOS?.startsWith('macos'),
    'Only a real GitHub-hosted macOS Actions job is supported; no local bypass',
  );
}
export function schedule(protocol = 'exploratory') {
  assert(
    ['exploratory', 'qualification', 5].includes(protocol),
    'Only closed exploratory/qualification protocols are enabled',
  );
  const samples = protocol === 'qualification' ? 2 : 5;
  return MODES.flatMap((mode) => {
    const stages = MATCHED.includes(mode)
      ? ['baseline', 'candidate']
      : ['candidate'];
    return Array.from({ length: samples + 1 }, (_, index) => index - 1).flatMap(
      (pair) =>
        (pair >= 0 && pair % 2 ? [...stages].reverse() : stages).map(
          (stage) => ({
            mode,
            stage,
            phase: pair < 0 ? 'warmup' : 'measured',
            pair,
          }),
        ),
    );
  });
}
export function quantile(values, q) {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    return null;
  const sorted = [...values].sort((a, b) => a - b),
    position = (sorted.length - 1) * q;
  return (
    sorted[Math.floor(position)] +
    (sorted[Math.ceil(position)] - sorted[Math.floor(position)]) *
      (position % 1)
  );
}
export function compareMetric(name, before, after) {
  return {
    name,
    before,
    after,
    statistics: [
      ['median', 0.5],
      ['p95', 0.95],
    ].map(([statistic, q]) => {
      const baseline = quantile(before, q),
        candidate = quantile(after, q);
      const complete =
        before.length === 5 &&
        after.length === 5 &&
        baseline !== null &&
        candidate !== null;
      return {
        statistic,
        baseline,
        candidate,
        ratio:
          complete &&
          [...before, ...after].every((value) => value >= 0) &&
          baseline > 0
            ? candidate / baseline
            : null,
        status: !complete
          ? 'missing-measurement'
          : [...before, ...after].some((value) => value < 0)
            ? 'invalid-negative-measurement'
            : baseline === 0
              ? candidate === 0
                ? 'unmeasurable-both-zero'
                : 'zero-baseline-review-required'
              : candidate <= baseline * 1.1
                ? 'within-10-percent-exploratory-point-estimate'
                : 'over-10-percent-budget',
      };
    }),
  };
}
const COMMAND_TERM_GRACE_MS = 30_000;
const COMMAND_KILL_GRACE_MS = 10_000;
function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
async function waitForGroupExit(pgid, graceMs) {
  const deadline = Date.now() + graceMs;
  while (processGroupExists(pgid)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}
/** Signal only the dedicated group whose ID came from our own detached spawn. */
async function cleanupOwnedGroup(pgid, termGraceMs, killGraceMs) {
  const record = {
    processGroupId: pgid ?? null,
    termSent: false,
    killSent: false,
    groupGone: !pgid,
    errors: [],
  };
  if (!pgid) return record;
  const signalGroup = (signal) => {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  try {
    if (!processGroupExists(pgid)) {
      record.groupGone = true;
      return record;
    }
    record.termSent = signalGroup('SIGTERM');
    record.groupGone = await waitForGroupExit(pgid, termGraceMs);
    if (!record.groupGone) {
      record.killSent = signalGroup('SIGKILL');
      record.groupGone = await waitForGroupExit(pgid, killGraceMs);
    }
  } catch (error) {
    record.errors.push(String(error));
  }
  return record;
}
export const WINDOWS_COMMAND_CLEANUP_ALLOWANCE_MS = 4 * 60_000;

/** Pure launch description. Only the outer CLI retains workflow/tee writers. */
export function commandLaunchPlan({
  platform = process.platform,
  executable,
  args,
  cwd,
  env,
  ownerPid = process.pid,
  stdio,
}) {
  if (platform !== 'win32')
    return { executable, args, options: { cwd, env, stdio, detached: true } };
  return {
    executable: process.execPath,
    args: [
      fileURLToPath(new URL('./process-tree-supervisor.mjs', import.meta.url)),
      ...args,
    ],
    options: {
      cwd,
      env: {
        ...env,
        CANOPY_E2E_SUPERVISED_EXECUTABLE: executable,
        CANOPY_E2E_OWNER_PID: String(ownerPid),
      },
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  };
}

async function runWindowsCommandProcess({
  executable,
  args,
  cwd,
  env,
  timeoutMs,
  signal,
  onSpawn,
  spawnProcess,
  stdout,
  stderr,
  cleanupAllowanceMs,
}) {
  const cleanup = {
    status: 'unverified',
    supervisorPid: null,
    cooperativeRequestSent: false,
    forwardingStreamsClosedAfterUnverifiedCleanup: false,
    supervisorExitCode: null,
    errors: [],
  };
  const failure = (error) => {
    if (cleanup.errors.length < 8)
      cleanup.errors.push(String(error).slice(0, 512));
  };
  if (signal?.aborted)
    return {
      code: null,
      signal: null,
      timedOut: false,
      interrupted: true,
      error: 'Command aborted before launch',
      cleanup,
    };
  const plan = commandLaunchPlan({
    platform: 'win32',
    executable,
    args,
    cwd,
    env,
  });
  let child;
  try {
    child = spawnProcess(plan.executable, plan.args, plan.options);
  } catch (error) {
    failure(error);
    return {
      code: null,
      signal: null,
      timedOut: false,
      interrupted: false,
      error: 'Supervisor launch failed',
      cleanup,
    };
  }
  cleanup.supervisorPid = child.pid ?? null;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let spawnError;
  child.once('error', (error) => {
    spawnError = String(error).slice(0, 512);
    failure(error);
  });
  child.once('close', (code, signal) => {
    cleanup.supervisorExitCode = code;
    resolveClosed({
      code,
      signal,
      ...(spawnError ? { error: spawnError } : {}),
    });
  });
  const forwarding = [
    [child.stdout, stdout],
    [child.stderr, stderr],
  ];
  for (const [read, destination] of forwarding) {
    read.on('error', failure);
    read.pipe(destination, { end: false });
  }
  let reason, resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  const request = (next) => {
    if (reason) return;
    reason = next;
    resolveStopped(null);
    try {
      child.send({ type: 'request-owned-cleanup', reason: next }, (error) => {
        if (error) failure(error);
      });
      cleanup.cooperativeRequestSent = true;
    } catch (error) {
      failure(error);
    }
  };
  const interrupt = () => request('interruption');
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const timer = setTimeout(() => request('timeout'), timeoutMs);
  let graceTimer, outcome;
  try {
    try {
      onSpawn(child);
    } catch (error) {
      failure(error);
      request('interruption');
    }
    outcome = await Promise.race([closed, stopped]);
    if (!outcome) {
      outcome = await Promise.race([
        closed,
        new Promise((resolve) => {
          graceTimer = setTimeout(() => resolve(null), cleanupAllowanceMs);
        }),
      ]);
    }
    if (!outcome) {
      // Never abruptly terminate a Windows supervisor or its possibly reused PID.
      // Only our private read endpoints are disposable; tee belongs to the CLI.
      cleanup.forwardingStreamsClosedAfterUnverifiedCleanup = true;
      for (const [read, destination] of forwarding) {
        read.unpipe(destination);
        read.removeListener('error', failure);
        read.destroy();
      }
      try {
        if (child.connected) child.disconnect();
      } catch (error) {
        failure(error);
      }
      child.channel?.unref();
      child.unref();
      outcome = {
        code: null,
        signal: null,
        error: 'Supervisor cleanup allowance exhausted; cleanup unverified',
      };
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    signal?.removeEventListener('abort', interrupt);
    for (const [read, destination] of forwarding) {
      read.unpipe(destination);
      read.removeListener('error', failure);
    }
  }
  return {
    ...outcome,
    timedOut: reason === 'timeout',
    interrupted: reason === 'interruption',
    cleanup,
    ...(cleanup.errors.length
      ? { error: 'Supervisor control or stream failure; cleanup unverified' }
      : {}),
  };
}

/**
 * Await command completion AND bounded owned-process-group teardown. A leader
 * exiting first never cancels descendant escalation. Separately detached app
 * descendants remain the Electron supervisor's responsibility.
 */
export async function runCommandProcess({
  executable,
  args,
  cwd,
  env,
  stdio,
  timeoutMs,
  termGraceMs = COMMAND_TERM_GRACE_MS,
  killGraceMs = COMMAND_KILL_GRACE_MS,
  onSpawn = () => {},
  signal,
  platform = process.platform,
  spawnProcess = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  cleanupAllowanceMs = WINDOWS_COMMAND_CLEANUP_ALLOWANCE_MS,
}) {
  if (platform === 'win32') {
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
    assert(
      Number.isFinite(cleanupAllowanceMs) &&
        cleanupAllowanceMs > 0 &&
        cleanupAllowanceMs <= WINDOWS_COMMAND_CLEANUP_ALLOWANCE_MS,
    );
    return runWindowsCommandProcess({
      executable,
      args,
      cwd,
      env,
      timeoutMs,
      signal,
      onSpawn,
      spawnProcess,
      stdout,
      stderr,
      cleanupAllowanceMs,
    });
  }
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
  assert(
    Number.isFinite(termGraceMs) &&
      termGraceMs >= 0 &&
      Number.isFinite(killGraceMs) &&
      killGraceMs > 0,
  );
  if (signal?.aborted)
    return {
      code: null,
      interrupted: true,
      timedOut: false,
      error: 'Command aborted before launch',
      cleanup: { processGroupId: null, groupGone: true },
    };
  const child = spawn(executable, args, { cwd, env, stdio, detached: true });
  const leaderDone = new Promise((resolve) => {
    child.once('error', (error) =>
      resolve({ error: String(error), code: null }),
    );
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let stopReason, resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const requestStop = (reason) => {
    if (!stopReason) {
      stopReason = reason;
      resolveStop({ stopped: true });
    }
  };
  const interrupt = () => requestStop('interruption');
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const timeout = setTimeout(() => requestStop('timeout'), timeoutMs);
  let outcome,
    cleanup,
    descendantsAfterLeaderExit = false,
    callbackError;
  try {
    try {
      onSpawn(child);
    } catch (error) {
      callbackError = String(error);
      requestStop('callback-error');
    }
    outcome = await Promise.race([leaderDone, stopped]);
    if (!outcome.stopped && child.pid)
      descendantsAfterLeaderExit = processGroupExists(child.pid);
  } finally {
    clearTimeout(timeout);
    // This await is deliberately independent of the leader close event.
    cleanup = await cleanupOwnedGroup(child.pid, termGraceMs, killGraceMs);
    signal?.removeEventListener('abort', interrupt);
  }
  let reapTimer;
  try {
    outcome = await Promise.race([
      leaderDone,
      new Promise((resolve) => {
        reapTimer = setTimeout(
          () =>
            resolve({
              code: null,
              error: 'Command leader did not reap within cleanup bound',
            }),
          killGraceMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(reapTimer);
  }
  return {
    ...outcome,
    timedOut: stopReason === 'timeout',
    interrupted: stopReason === 'interruption',
    descendantsAfterLeaderExit,
    cleanup,
    ...(callbackError ? { error: callbackError } : {}),
    ...(!cleanup.groupGone || cleanup.errors.length
      ? { error: 'Owned command group cleanup incomplete' }
      : {}),
  };
}
export function runtimeComparisonReasons(mode, actual, expected) {
  const observed = actual?.samples?.[0]?.runtime,
    reference = expected?.samples?.[0]?.runtime;
  const fields = ['electron', 'chromium', 'node'];
  if (
    [observed, reference].some((runtime) =>
      fields.some(
        (field) =>
          typeof runtime?.[field] !== 'string' || !runtime[field].trim(),
      ),
    )
  )
    return ['Driver runtime version identity missing'];
  return fields.some((field) => observed[field] !== reference[field])
    ? ['Driver runtime version mismatch']
    : [];
}
export function metricPermitsExploration(metric) {
  // Both-zero is explicitly outside measurable relative comparisons; never
  // turn positive candidate/zero baseline into automatic next-stage readiness.
  return metric.statistics.every((entry) =>
    [
      'within-10-percent-exploratory-point-estimate',
      'unmeasurable-both-zero',
    ].includes(entry.status),
  );
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    checkTraversal();
    hash.update(chunk);
  }
  return hash.digest('hex');
}
export async function manifest(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    checkTraversal();
    const relative = path.join(prefix, entry.name),
      absolute = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected artifact symlink: ${relative}`);
    if (entry.isDirectory())
      Object.assign(result, await manifest(absolute, relative));
    else if (entry.isFile()) result[relative] = await hashFile(absolute);
  }
  return result;
}
const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
export async function sourceManifest(cwd) {
  const files = [
    ...new Set(
      git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const result = {};
  // Keep file descriptors bounded even for the full monorepo, on both stages.
  for (let offset = 0; offset < files.length; offset += 16) {
    checkTraversal();
    const entries = await Promise.all(
      files.slice(offset, offset + 16).map(async (file) => {
        const absolute = path.join(cwd, file),
          info = await lstat(absolute);
        assert(
          info.isFile() || info.isSymbolicLink(),
          `Unsupported source entry: ${file}`,
        );
        return [
          file,
          info.isSymbolicLink()
            ? { symlink: await readlink(absolute) }
            : await hashFile(absolute),
        ];
      }),
    );
    Object.assign(result, Object.fromEntries(entries));
  }
  return result;
}

export function validateReleaseHeadlessReport(raw, expected) {
  assert.equal(
    raw?.schemaVersion,
    2,
    'Release headless reports require schema 2',
  );
  assertHeadlessStudyMetadata(raw.environment);
  const sourceAdapter = raw.source?.headlessAdapter;
  assert.equal(
    sourceAdapter?.adapterVersion,
    'production-hidden-native-v1',
    'Archived adapter source missing',
  );
  assert.match(sourceAdapter.adapterSha256 ?? '', /^[a-f0-9]{64}$/);
  assert(
    typeof sourceAdapter.sourcePath === 'string' &&
      sourceAdapter.sourcePath.endsWith(
        '/apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs',
      ),
  );
  if (expected)
    assert.equal(sourceAdapter.adapterSha256, expected.adapterSha256);
  assert(
    Array.isArray(raw.samples) && raw.samples.length > 0,
    'Missing headless samples',
  );
  for (const sample of [...(raw.warmup ? [raw.warmup] : []), ...raw.samples]) {
    assert(
      Array.isArray(sample.adapterLaunches) &&
        sample.adapterLaunches.length > 0,
      'Missing staged adapter launch identities',
    );
    assert.equal(
      sample.adapterLaunches.length,
      raw.mode === 'retirement' ? 2 : 1,
      'Unexpected native launch/relaunch count',
    );
    for (const launch of sample.adapterLaunches) {
      assert.equal(launch.adapterSha256, sourceAdapter.adapterSha256);
      assert.equal(launch.adapterVersion, sourceAdapter.adapterVersion);
      assert.equal(launch.sourcePath, sourceAdapter.sourcePath);
      assert(
        typeof launch.archivePath === 'string' &&
          launch.archivePath.endsWith('.adapter.cjs'),
      );
    }
    const evidence = Array.isArray(sample.monitoring)
      ? sample.monitoring.map((entry) => entry.windowEvidence)
      : [sample.windowEvidence];
    assert(evidence.length, 'Missing headless windowEvidence');
    const seenLaunches = new Set();
    for (const window of evidence) {
      const observed = window?.adapterAtSetup;
      const matching = sample.adapterLaunches.find(
        (launch) =>
          launch.pid === observed?.pid &&
          launch.productMainEntryPath === observed?.productMainEntryPath &&
          launch.launchEntryPath === observed?.launchEntryPath &&
          launch.productMainSha256 === observed?.productMainSha256,
      );
      assert(matching, 'Unrecorded production launch');
      seenLaunches.add(observed.pid);
      assert.equal(
        window?.adapterAtSetup?.adapterSha256,
        sourceAdapter.adapterSha256,
        'Archived adapter source does not match native snapshot',
      );
      assertProductionHeadlessEvidence(window, expected);
    }
    for (const launch of sample.adapterLaunches) {
      const measurements = evidence
        .flatMap((window) => [
          window.adapterAtSetup,
          window.adapterAtStart,
          window.adapterAtEnd,
        ])
        .filter((snapshot) => snapshot.pid === launch.pid);
      assertProductionHeadlessTerminal(
        launch.terminalEvidence,
        launch,
        measurements,
      );
    }
    assert.equal(
      seenLaunches.size,
      sample.adapterLaunches.length,
      'Missing or duplicate relaunch evidence',
    );
  }
}
export function assertReleaseRawIdentity(raw, stage) {
  equal(raw.source?.bundles, stage.bundles, 'Driver bundle identity mismatch');
  assert.equal(
    raw.source?.commit,
    stage.commit,
    'Driver source commit mismatch',
  );
  assert.equal(raw.configuration?.samples, 1);
  assert.equal(raw.configuration?.warmups, 0);
  assert.equal(
    raw.samples?.length,
    1,
    'Expected exactly one retained independent sample',
  );
  assert.equal(
    raw.warmup,
    null,
    'Outer warmup must be the only excluded sample',
  );
  assert(
    typeof raw.environment?.power === 'string' &&
      raw.environment.power.includes('AC Power'),
    'AC power unestablished',
  );
  assert.equal(
    runtimeComparisonReasons('', raw, raw).length,
    0,
    'Actual runtime version evidence missing',
  );
}

export function assertReleaseComparability(batch, mode, raw) {
  batch.comparability ??= {};
  const reference = batch.comparability[mode] ?? raw;
  const reasons = [];
  if (canonical(raw.configuration) !== canonical(reference.configuration))
    reasons.push('Driver configuration mismatch');
  reasons.push(...runtimeComparisonReasons(mode, raw, reference));
  equalFields(
    raw.environment,
    reference.environment,
    [
      'platform',
      'architecture',
      'release',
      'cpu',
      'memoryBytes',
      'node',
      'viewport',
      'studyViewportPreset',
      'studyWindowMode',
      'windowVisible',
      'settings',
      'powerSettings',
      'effectiveEnvironmentValueHashes',
    ],
    reasons,
    'environment',
  );
  if (batch.actualRuntime)
    reasons.push(
      ...runtimeComparisonReasons(mode, raw, {
        samples: [{ runtime: batch.actualRuntime }],
      }),
    );
  assert.equal(reasons.length, 0, reasons.join('; '));
  batch.actualRuntime ??= raw.samples[0].runtime;
  batch.comparability[mode] ??= {
    configuration: raw.configuration,
    environment: raw.environment,
    samples: [{ runtime: raw.samples[0].runtime }],
  };
}

export async function validateReleaseArchives(raw, reportPath, expected) {
  validateReleaseHeadlessReport(raw, expected);
  for (const [index, launch] of raw.samples[0].adapterLaunches.entries()) {
    assert.equal(
      launch.archivePath,
      `${reportPath}.sample-0-launch-${index}.adapter.cjs`,
    );
    assert.equal(
      await hashFile(launch.archivePath),
      expected.adapterSha256,
      'Staged adapter archive changed',
    );
    assert.equal(launch.terminalPath, `${launch.archivePath}.lifecycle.jsonl`);
    assert.equal(
      await hashFile(launch.terminalPath),
      launch.terminalEvidence.fileSha256,
      'Terminal archive changed',
    );
    const journal = await readFile(launch.terminalPath, 'utf8');
    assert.equal(
      Buffer.byteLength(journal),
      launch.terminalEvidence.size,
      'Terminal archive size mismatch',
    );
    equal(
      journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      launch.terminalEvidence.records,
      'Terminal archive records mismatch',
    );
  }
}

export function validateReleaseNativePreflight(
  value,
  expected,
  { qualification = false, raw, code, thresholds } = {},
) {
  assert(
    [2, 3].includes(value?.schemaVersion),
    'Unknown native preflight version',
  );
  assert.equal(
    value.kind,
    value.schemaVersion === 3
      ? 'native-production-headless-capability-v2'
      : 'native-production-headless-capability-v1',
  );
  if (qualification || value.schemaVersion === 3) {
    assert.equal(
      value.schemaVersion,
      3,
      'Qualification requires fresh versioned preflight',
    );
    assert.equal(value.structuralStatus, 'valid');
    assert.equal(value.structuralCapability, 'established');
    if (raw) {
      const classification = classifyReleaseReport(
        'cold',
        raw,
        code,
        thresholds,
      );
      for (const key of [
        'structuralStatus',
        'performanceStatus',
        'passed',
        'violations',
        'recordedAssessments',
        'raw',
      ])
        equal(
          value[key],
          classification[key],
          `Preflight ${key} contradicts raw report`,
        );
      equal(value.source, raw.source, 'Preflight raw source mismatch');
      equal(
        value.runtime,
        raw.samples[0].runtime,
        'Preflight raw runtime mismatch',
      );
      equal(
        value.environment,
        raw.environment,
        'Preflight raw environment mismatch',
      );
      equal(
        value.adapterLaunches,
        raw.samples[0].adapterLaunches,
        'Preflight raw launches mismatch',
      );
      equal(
        value.windowEvidence,
        raw.samples[0].monitoring.map((entry) => entry.windowEvidence),
        'Preflight raw windows mismatch',
      );
    }
    assert.equal(
      value.status,
      value.performanceStatus === 'passed' ? 'available' : 'performance-failed',
    );
    assert.equal(value.passed, value.performanceStatus === 'passed');
  }
  if (!qualification)
    assert.equal(value.status, 'available', 'Native capability unavailable');
  assertHeadlessStudyMetadata(value.environment);
  assert.equal(value.adapter?.sha256, expected.adapterSha256);
  assert(
    Array.isArray(value.adapterLaunches) && value.adapterLaunches.length === 1,
    'Native prerequisite launch identity missing',
  );
  equal(
    value.bundlesBefore,
    value.bundlesAfter,
    'Preflight changed production bytes',
  );
  assert(
    Array.isArray(value.windowEvidence) && value.windowEvidence.length >= 2,
    'Main and Advisor preflight missing',
  );
  for (const evidence of value.windowEvidence)
    assertProductionHeadlessEvidence(evidence, expected);
  for (const launch of value.adapterLaunches)
    assertProductionHeadlessTerminal(
      launch.terminalEvidence,
      launch,
      value.windowEvidence.flatMap((evidence) => [
        evidence.adapterAtSetup,
        evidence.adapterAtStart,
        evidence.adapterAtEnd,
      ]),
    );
  const final = value.windowEvidence.at(-1).adapterAtEnd;
  assert(
    final.windows.length >= 2 &&
      final.windows.every((entry) => entry.readyToShow >= 1),
    'Native main/Advisor ready-to-show missing',
  );
  const owners = value.windowEvidence.map((evidence) => evidence.atEnd);
  assert(
    new Set(owners.map((owner) => owner.id)).size >= 2 &&
      owners.some(
        (owner) =>
          new URL(owner.nativeUrl).searchParams.get('surface') ===
          'app-advisor',
      ),
    'Native Advisor boundary missing',
  );
  assert(
    final.calls.some(
      (call) => call.method === 'show' && call.id === owners[0].id,
    ),
    'Production main activation path was not exercised',
  );
  assert.equal(
    value.bundlesBefore?.['main/index.js'],
    expected.productMainSha256,
    'Native preflight production main identity mismatch',
  );
}

export function metrics(mode, sample) {
  try {
    validateReleaseSample(mode, sample);
  } catch {
    return {};
  }
  return classifiedMetrics(mode, sample);
}
export function classifiedMetrics(mode, sample) {
  validateReleaseStructure(mode, sample);
  const monitors = Array.isArray(sample.monitoring)
    ? sample.monitoring.filter((entry) => entry.scope !== 'setup')
    : [sample.monitoring];
  const peaks = monitors.map((entry) => entry?.summary?.totalWorkingSetMb.max);
  const result = {
    peakWorkingSetMb:
      peaks.length && peaks.every(Number.isFinite) ? Math.max(...peaks) : null,
  };
  if (mode === 'startup') {
    result.firstWindowMs = sample.milestones?.firstWindowMs;
    result.usableShellMs = sample.milestones?.usableShellMs;
    result.usableComposerMs = sample.milestones.usableComposerMs;
    result.preWindowProcessTreePeakRssKiB =
      sample.earlyCoverage.preWindowPeakRssKb;
    result.pidToShellProcessTreePeakRssKiB = Math.max(
      ...sample.startupResources.samples
        .filter(
          (x) => x.collectionCompletedMs <= sample.milestones.usableShellMs,
        )
        .map((x) => x.rssKb),
    );
    result.preWindowObservedCumulativeCpuMs =
      sample.earlyCoverage.preWindowObservedCumulativeCpuMs;
  } else if (mode === 'common') {
    result.firstWindowMs = sample.firstWindowMs;
    result.shellMs = sample.shellMs;
  }
  for (const kind of new Set((sample.tasks ?? []).map((entry) => entry.kind))) {
    const times = sample.tasks
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.durationMs);
    result[`${kind}.medianWithinRunMs`] = quantile(times, 0.5);
    result[`${kind}.p95WithinRunMs`] = quantile(times, 0.95);
  }
  if (['common', 'maintenance', 'startup'].includes(mode)) {
    result.settledPeakWorkingSetMiB =
      sample.settled.summary.totalWorkingSetMb.max;
    result.settledMeanCpuPercent = sample.settled?.summary.totalCpuPercent.mean;
    result.settledP95CpuPercent = sample.settled?.summary.totalCpuPercent.p95;
  }
  if (mode === 'inventory') {
    result.inventoryWorkerPeakWorkingSetKiB =
      sample.inventory.workerResources.workingSetSizeKb.max;
    result.inventoryWorkerMeanCpuPercent =
      sample.inventory.workerResources.cpuPercent.mean;
    result.inventoryWorkerP95CpuPercent =
      sample.inventory.workerResources.cpuPercent.p95;
  }
  for (const [name, value] of Object.entries(result)) finite(value, name);
  return result;
}

/** Planning evidence only. Complete finite failures provide observed costs, never qualified capacity. */
export function qualificationCapacity(batch) {
  const classified = batch.schemaVersion === 3;
  const result = {
    acceptance: false,
    qualified: false,
    observedCostsComplete: false,
    performanceFailed: Boolean(batch.performanceFailed),
    headroom: 1.2,
    stableExecutionEnabled: false,
    setupAllowanceMinutes: 5,
    cleanupUploadReserveMinutes: 30,
    finalizationReserveMinutes: 5,
    maximumProjectedMinutes: 315,
    orchestratorLimitMinutes: 320,
    combinations: [],
    status: 'capacity-gap-incomplete-qualified-costs',
    limitation:
      batch.execution === 'local-physical'
        ? 'Local measured costs under the inherited hosted capacity planning policy; no local stable execution bound is enabled. Review actual local admission/preparation and host capacity before defining a stable protocol.'
        : 'Fixed 5-minute setup allowance requires review against actual hosted job setup; larger observed setup reduces the 315-minute allowance',
  };
  for (const mode of MODES)
    for (const stage of MATCHED.includes(mode)
      ? ['baseline', 'candidate']
      : ['candidate']) {
      const entries = batch.attempts.filter(
        (x) => x.mode === mode && x.stage === stage,
      );
      const durations = entries.map(
        (x) =>
          batch.commands.find((c) => c.label === x.commandLabel)?.durationMs,
      );
      result.combinations.push({
        mode,
        stage,
        expected: 3,
        observed: entries.length,
        complete:
          entries.length === 3 &&
          canonical(entries.map((x) => x.pair).sort((a, b) => a - b)) ===
            canonical([-1, 0, 1]) &&
          entries.every(
            (x) =>
              (classified
                ? x.structuralStatus === 'valid' && x.verified
                : x.status === 'ok') &&
              x.phase === (x.pair < 0 ? 'warmup' : 'measured'),
          ) &&
          durations.every((x) => Number.isFinite(x) && x > 0),
        durationsMs: durations,
        maximumCompleteMs: durations.length ? Math.max(...durations) : null,
      });
    }
  const before = batch.checks
      .filter((x) => /^before-\d+$/.test(x.label))
      .map((x) => x.durationMs),
    after = batch.checks
      .filter((x) => /^after-\d+$/.test(x.label))
      .map((x) => x.durationMs);
  if (
    batch.fatalError ||
    !(classified
      ? batch.collectionComplete
      : batch.qualificationEvidenceComplete) ||
    canonical(batch.schedule) !== canonical(schedule('qualification')) ||
    !result.combinations.every((x) => x.complete) ||
    (classified &&
      (batch.attempts.length !== 33 ||
        !batch.attempts.every((attempt, ordinal) => {
          const plan = batch.schedule[ordinal];
          const records = batch.commands.filter(
            (command) => command.label === attempt.commandLabel,
          );
          const command = records[0];
          return (
            attempt.ordinal === ordinal &&
            plan?.mode === attempt.mode &&
            plan.stage === attempt.stage &&
            plan.pair === attempt.pair &&
            plan.phase === attempt.phase &&
            records.length === 1 &&
            command.cleanup?.groupGone &&
            !command.timedOut &&
            !command.signal &&
            !command.error &&
            !command.interrupted &&
            !command.descendantsAfterLeaderExit
          );
        }))) ||
    !before.length ||
    !after.length ||
    (classified &&
      (before.length !== 33 ||
        after.length !== 33 ||
        !batch.schedule.every(
          (_, index) =>
            batch.checks.filter((check) => check.label === `before-${index}`)
              .length === 1 &&
            batch.checks.filter((check) => check.label === `after-${index}`)
              .length === 1,
        ))) ||
    ![...before, ...after, batch.preparationMs].every(
      (x) => Number.isFinite(x) && x >= 0,
    )
  )
    return result;
  result.verificationBeforeMaxMs = Math.max(...before);
  result.verificationAfterMaxMs = Math.max(...after);
  result.preparationMs = batch.preparationMs;
  result.projectedStableMinutes =
    (1.2 *
      (21 *
        result.combinations.reduce((sum, x) => sum + x.maximumCompleteMs, 0) +
        231 *
          (result.verificationBeforeMaxMs + result.verificationAfterMaxMs))) /
      60000 +
    Math.max(10, (1.2 * batch.preparationMs) / 60000) +
    5;
  result.observedCostsComplete = true;
  result.qualified = !batch.performanceFailed;
  result.observedCostStatus = batch.performanceFailed
    ? 'observed-cost-projection-with-performance-failures'
    : 'observed-cost-projection';
  result.status =
    result.projectedStableMinutes <= 315 && result.projectedStableMinutes <= 320
      ? 'planning-capacity-within-reserves'
      : 'capacity-gap-exceeds-reserves';
  if (
    batch.performanceFailed &&
    result.status === 'planning-capacity-within-reserves'
  )
    result.status = 'capacity-gap-performance-failed';
  return result;
}
function releaseModeCompleteStatus(qualification) {
  return qualification
    ? 'qualification-workload-complete'
    : 'exploratory-protocol-passed';
}
export function finalizeReleaseAnalysis(batch, analysis, qualification) {
  const classified = qualification && batch.schemaVersion === 3;
  batch.performanceFailed ||= [
    ...Object.values(batch.nativePreflights ?? {}),
    ...batch.attempts,
  ].some((record) => record.performanceStatus === 'failed');
  const expected = schedule('qualification');
  const complete =
    !batch.fatalError &&
    !batch.interruption &&
    !batch.cleanupError &&
    !analysis.missingAttempts &&
    (classified
      ? canonical(batch.schedule) === canonical(expected) &&
        batch.attempts.length === expected.length &&
        batch.attempts.every(
          (attempt, index) =>
            attempt.ordinal === index &&
            expected[index].mode === attempt.mode &&
            expected[index].stage === attempt.stage &&
            expected[index].pair === attempt.pair &&
            expected[index].phase === attempt.phase &&
            attempt.structuralStatus === 'valid' &&
            attempt.verified,
        ) &&
        Object.keys(batch.nativePreflights ?? {}).length === 2 &&
        ['baseline', 'candidate'].every(
          (stage) =>
            batch.nativePreflights[stage]?.structuralStatus === 'valid' &&
            batch.nativePreflights[stage].verified,
        ) &&
        batch.studyProcessCleanup === 'no-leftover-stage-electron-processes' &&
        MODES.every((mode) => analysis.modes[mode]?.collectionComplete)
      : !analysis.failures.length &&
        Object.keys(analysis.modes).length === MODES.length &&
        MODES.every(
          (name) =>
            analysis.modes[name]?.status ===
            releaseModeCompleteStatus(qualification),
        ));
  if (qualification) {
    batch.collectionComplete = Boolean(complete);
    batch.qualificationPassed = Boolean(complete && !batch.performanceFailed);
    Object.assign(analysis, {
      collectionComplete: batch.collectionComplete,
      performanceFailed: Boolean(batch.performanceFailed),
      qualificationPassed: batch.qualificationPassed,
      passed: batch.qualificationPassed,
      releaseAcceptance: false,
      finalAcceptance: false,
      stableExecutionEnabled: false,
    });
    Object.assign(batch, {
      passed: batch.qualificationPassed,
      finalAcceptance: false,
      releaseAcceptance: false,
      stableExecutionEnabled: false,
    });
  }
  analysis.status = complete
    ? qualification
      ? batch.performanceFailed
        ? 'qualification-collected-performance-failed'
        : 'qualification-complete-no-acceptance'
      : 'exploratory-protocol-passed-not-final-acceptance'
    : qualification
      ? 'qualification-incomplete-or-failed'
      : 'exploratory-incomplete-or-failed';
  if (qualification)
    analysis.capacity = qualificationCapacity({
      ...batch,
      qualificationEvidenceComplete: complete && !batch.performanceFailed,
    });
  return analysis;
}

export async function outputFootprint(
  directory,
  deadline = Date.now() + 300000,
) {
  const result = {
    files: 0,
    bytes: 0,
    scope:
      'existing files before final evidence manifest; excludes upload transport',
  };
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      assert(Date.now() < deadline, 'Output inspection deadline exhausted');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        result.files++;
        result.bytes += (await lstat(file)).size;
      }
    }
  }
  await visit(directory);
  return result;
}

export function parseReleaseOptions(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      execution: { type: 'string', default: 'hosted' },
      workspace: { type: 'string' },
      'candidate-commit': { type: 'string' },
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      output: { type: 'string' },
      protocol: { type: 'string', default: 'exploratory' },
      'window-mode': { type: 'string', default: 'headless' },
    },
  });
  assert.equal(
    values['window-mode'],
    'headless',
    'Only headless window mode is supported',
  );
  assert(
    args.filter(
      (arg) => arg === '--window-mode' || arg.startsWith('--window-mode='),
    ).length <= 1,
    'Repeated window mode',
  );
  assert(
    values.baseline && values.candidate && values.output,
    'Required: --baseline DIR --candidate DIR --output FRESH_DIR',
  );
  assert(
    ['exploratory', 'qualification'].includes(values.protocol),
    'Unsupported protocol',
  );
  assert(
    ['hosted', 'local-physical'].includes(values.execution),
    'Unsupported execution',
  );
  if (values.execution === 'local-physical') {
    assert.equal(
      values.protocol,
      'qualification',
      'Local physical execution is qualification-only',
    );
    assert(values.workspace, 'Local physical execution requires --workspace');
    assert(
      /^[a-f0-9]{40}$/.test(values['candidate-commit'] ?? ''),
      'Local physical execution requires an exact full --candidate-commit SHA',
    );
  } else {
    assert(
      !values.workspace && !values['candidate-commit'],
      'Local workspace/commit options require --execution local-physical',
    );
  }
  return values;
}

export function requireLocalPhysicalMac(
  env = process.env,
  platform = process.platform,
  version = process.version,
) {
  for (const key of Object.keys(env)) {
    assert(
      !/^(?:CI$|GITHUB_|RUNNER_|ImageOS$|ImageVersion$)/.test(key),
      `Local physical qualification rejects environment marker: ${key}`,
    );
    assert(
      ![
        MEMORY_PRESSURE_THRESHOLD_ENV,
        'CANOPY_DEV_PERF_SUITE_MAX_RUN_CONCURRENCY',
        'CANOPY_DEV_E2E_SUITE_MAX_RUN_CONCURRENCY',
      ].includes(key),
      `Local physical qualification rejects safety override: ${key}`,
    );
  }
  assert.equal(
    platform,
    'darwin',
    'Local physical qualification requires Darwin',
  );
  assert.equal(
    version,
    'v24.22.1',
    'Local physical qualification requires actual Node v24.22.1',
  );
}

const localLeaseOwners = new WeakSet();
export async function withLocalReleaseLease(
  operation,
  { env = process.env, signal, acquire = applyDevScriptSafetyWithWait } = {},
) {
  const safety = await acquire({ suite: 'performance', env, signal });
  const owner = { memory: safety.memory, lease: safety.lease?.metadata };
  try {
    assert(
      !safety.ciBypass && !safety.memory.skipped && safety.lease,
      'Local qualification requires the actual normal performance lease',
    );
    signal?.throwIfAborted();
    localLeaseOwners.add(owner);
    return await operation(owner);
  } finally {
    localLeaseOwners.delete(owner);
    await safety.lease?.release();
  }
}

export function releaseDriverPrefix(execution, owner) {
  if (execution === 'local-physical') {
    assert(
      localLeaseOwners.has(owner),
      'Local driver requires the controller-owned active lease',
    );
    return ['--import', 'tsx'];
  }
  assert.equal(execution, 'hosted');
  return [
    'scripts/run-guarded-dev-script.mjs',
    '--suite',
    'performance',
    '--',
    process.execPath,
    '--import',
    'tsx',
  ];
}

export function releaseChildEnvironment(execution, source = process.env) {
  assert(['hosted', 'local-physical'].includes(execution));
  const keys = ['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL'];
  const settings = { ...EXPLICIT_ENV };
  if (execution === 'hosted')
    keys.push(
      'RUNNER_TEMP',
      'RUNNER_OS',
      'RUNNER_ENVIRONMENT',
      'GITHUB_WORKSPACE',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
      'ImageOS',
      'ImageVersion',
    );
  else {
    delete settings.CI;
    delete settings.GITHUB_ACTIONS;
  }
  const result = {
    ...Object.fromEntries(
      keys
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]]),
    ),
    ...settings,
  };
  if (execution === 'local-physical')
    result.PATH = `${path.dirname(process.execPath)}${path.delimiter}${result.PATH ?? ''}`;
  return result;
}

export function assertReleaseStageIdentity(
  stage,
  commit,
  tree,
  candidateCommit,
) {
  assert(
    /^[a-f0-9]{40}$/.test(candidateCommit ?? ''),
    'Candidate commit must be an exact full SHA',
  );
  assert.equal(
    commit,
    stage === 'baseline' ? BASELINE_SHA : candidateCommit,
    `${stage} commit does not match selected identity`,
  );
  if (stage === 'baseline')
    assert.equal(tree, BASELINE_TREE, 'Baseline tree mismatch');
  assert(/^[a-f0-9]{40}$/.test(tree), `${stage} tree must be a full SHA`);
}

export async function prepareReleasePaths(
  values,
  hostedWorkspace = process.env.GITHUB_WORKSPACE,
) {
  const workspace = await realpath(
    values.execution === 'local-physical' ? values.workspace : hostedWorkspace,
  );
  const roots = {
    baseline: await realpath(values.baseline),
    candidate: await realpath(values.candidate),
  };
  for (const root of Object.values(roots))
    assert(
      root.startsWith(`${workspace}/`),
      'Use independent canonical checkout children of the execution workspace',
    );
  assert(
    roots.baseline !== roots.candidate &&
      !roots.baseline.startsWith(`${roots.candidate}/`) &&
      !roots.candidate.startsWith(`${roots.baseline}/`),
    'Stage roots must be disjoint',
  );
  const requestedOutput = path.resolve(values.output);
  const output = path.join(
    await realpath(path.dirname(requestedOutput)),
    path.basename(requestedOutput),
  );
  assert(
    output.startsWith(`${workspace}/`) &&
      Object.values(roots).every(
        (root) =>
          !output.startsWith(`${root}/`) &&
          output !== root &&
          !root.startsWith(`${output}/`),
      ),
    'Fresh output must be outside stage roots and inside the canonical workspace',
  );
  if (values.execution === 'local-physical') {
    for (const root of Object.values(roots)) {
      for (const relative of ['node_modules', 'out', 'out-e2e', '.cache']) {
        try {
          await lstat(path.join(root, relative));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        assert.fail(
          `Local stage must be fresh: ${path.join(root, relative)} already exists`,
        );
      }
    }
  }
  await mkdir(output); // Atomic collision refusal; never reuse or merge populations.
  return { workspace, roots, output };
}

export async function withReleaseInterruption(operation) {
  const interruption = new AbortController();
  const interrupt = (name) => {
    // A late signal must fail the process even while evidence writes are finishing.
    process.exitCode = 1;
    interruption.abort(new Error(`Release study interrupted by ${name}`));
  };
  const terminate = () => interrupt('SIGTERM');
  const cancel = () => interrupt('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', cancel);
  try {
    return await operation(interruption.signal);
  } finally {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', cancel);
  }
}

async function main() {
  const values = parseReleaseOptions();
  const executionStartedAt = Date.now();
  await withReleaseInterruption(async (signal) => {
    if (values.execution === 'local-physical') {
      requireLocalPhysicalMac();
      await withLocalReleaseLease(
        (owner) => executeStudy(values, executionStartedAt, signal, owner),
        { signal },
      );
    } else {
      await executeStudy(values, executionStartedAt, signal);
    }
  });
}

async function executeStudy(values, executionStartedAt, signal, owner) {
  const local = values.execution === 'local-physical';
  if (!local) {
    requireHostedMac(); // Before all filesystem mutations and subprocesses.
    assert.equal(process.version, 'v24.22.1');
    assert.equal(
      os.userInfo().username,
      'runner',
      'Expected ephemeral hosted runner account',
    );
    assert(
      process.env.GITHUB_WORKSPACE.startsWith('/Users/runner/work/'),
      'Expected hosted macOS workspace',
    );
    let ancestorPid = process.ppid,
      runnerWorkerObserved = false;
    for (let depth = 0; ancestorPid > 1 && depth < 20; depth++) {
      const row = execFileSync(
        '/bin/ps',
        ['-p', String(ancestorPid), '-o', 'ppid=,comm='],
        { encoding: 'utf8', timeout: 30_000 },
      ).trim();
      const match = row.match(/^(\d+)\s+(.+)$/);
      assert(match, 'Cannot attest runner ancestry');
      if (path.basename(match[2]) === 'Runner.Worker')
        runnerWorkerObserved = true;
      ancestorPid = Number(match[1]);
    }
    assert(
      runnerWorkerObserved,
      'Expected real GitHub Actions Runner.Worker ancestry',
    );
  }
  const qualification = values.protocol === 'qualification';
  const deadlineMs = executionStartedAt + (qualification ? 90 : 320) * 60_000;
  signal.throwIfAborted();
  // Local admission, preparation, studies, cleanup and finalization share 90 minutes.
  const workDeadlineMs = local ? deadlineMs - 5 * 60_000 : deadlineMs;
  traversalDeadline = workDeadlineMs;
  checkTraversal();
  const { roots, output } = await prepareReleasePaths(values);
  const candidateCommit = local
    ? values['candidate-commit']
    : process.env.GITHUB_SHA;
  const saveJson = (name, value) =>
    writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  const env = releaseChildEnvironment(values.execution);
  const explicitBuildSettings = { ...EXPLICIT_ENV };
  if (local) {
    delete explicitBuildSettings.CI;
    delete explicitBuildSettings.GITHUB_ACTIONS;
  }
  const batch = {
    schemaVersion: 3,
    protocol: qualification
      ? 'same-host-qualification-headless-v4'
      : 'same-host-exploratory-headless-v4',
    studyWindowMode: HEADLESS_STUDY_MODE,
    studyViewportPreset: HEADLESS_STUDY_MODE,
    windowVisible: false,
    viewport: HEADLESS_STUDY_VIEWPORT,
    nativePreflights: {},
    performanceFailed: false,
    collectionComplete: false,
    qualificationPassed: false,
    releaseAcceptance: false,
    stableExecutionEnabled: false,
    nativePrerequisiteDriverInvocations: 2,
    nativePrerequisiteMainAppLaunches: 2,
    launchCountScope:
      'maximum fields describe the unchanged scheduled population; prerequisites are separate',
    maximumDriverInvocations: qualification ? 33 : 66,
    maximumMainAppLaunches: qualification ? 36 : 72,
    comparison: qualification
      ? 'not-applicable-to-qualification'
      : 'exploratory-only',
    startedAt: new Date().toISOString(),
    host: {
      machineHash: digest(os.hostname()),
      platform: process.platform,
      architecture: process.arch,
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      memoryBytes: os.totalmem(),
      imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
      node: process.version,
    },
    baselineReconstruction: {
      originalBase: 'cfb8f5198b',
      originalCheckpoint:
        '.playwright/browser-profiles/phase-2/source-checkpoint-final',
      filesVerified: 93,
      manifestSha256:
        '5aa206823067616c9c5758553f12746634a65fc687ac185c49b20e13fc3da964',
      recoveredFrom:
        'Original tracked.patch and untracked.tar.gz; mutable test helpers excluded',
      commit: BASELINE_SHA,
      tree: BASELINE_TREE,
    },
    execution: values.execution,
    safetyAdmission: local
      ? {
          kind: 'controller-owned-performance-lease',
          memory: owner.memory,
          lease: owner.lease,
        }
      : { kind: 'existing-hosted-child-guard' },
    control: {
      root: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../..',
      ),
      commit: git(path.dirname(fileURLToPath(import.meta.url)), [
        'rev-parse',
        'HEAD',
      ]).trim(),
      dirty: Boolean(
        git(path.dirname(fileURLToPath(import.meta.url)), [
          'status',
          '--porcelain',
        ]).trim(),
      ),
    },
    run: local
      ? { kind: 'local-physical', candidateCommit }
      : {
          id: process.env.GITHUB_RUN_ID,
          attempt: process.env.GITHUB_RUN_ATTEMPT,
          sha: process.env.GITHUB_SHA,
        },
    buildPopulation: local
      ? 'Fresh matched local production builds; no historical hosted-byte equivalence claimed'
      : 'Fresh matched hosted production builds',
    explicitBuildSettings,
    actualChildEnvironmentValueHashes: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, digest(value)]),
    ),
    orchestratorSha256: await hashFile(fileURLToPath(import.meta.url)),
    schedule: schedule(values.protocol),
    stages: {},
    overlay: [],
    attempts: [],
    checks: [],
    commands: [],
    finalAcceptance: false,
    executionDeadline: new Date(deadlineMs).toISOString(),
    studyWorkDeadline: new Date(workDeadlineMs).toISOString(),
    limitations: [
      qualification
        ? 'Two qualification observations prove only workload completeness/cost, never comparison or acceptance.'
        : 'Five exploratory samples never establish final acceptance; twenty stable paired samples and variance review remain required.',
      'Optimized unpackaged production builds, not signing/installer/ASAR performance.',
      'Cold/veto drivers do not measure settled CPU or typing; those remain unmeasured, not zero. Common/startup cover matched settled CPU.',
    ],
  };
  const save = () => saveJson('batch.json', batch);
  async function command(
    label,
    cwd,
    executable,
    args,
    timeoutMs = 30 * 60_000,
  ) {
    assert(
      !signal.aborted &&
        Date.now() <
          workDeadlineMs - COMMAND_TERM_GRACE_MS - 2 * COMMAND_KILL_GRACE_MS,
      'Job interrupted or study work deadline exhausted',
    );
    timeoutMs = Math.min(
      timeoutMs,
      workDeadlineMs -
        Date.now() -
        COMMAND_TERM_GRACE_MS -
        2 * COMMAND_KILL_GRACE_MS,
    );
    const log = createWriteStream(path.join(output, `${label}.log`), {
      flags: 'wx',
    });
    await new Promise((resolve, reject) => {
      log.once('open', resolve);
      log.once('error', reject);
    });
    const record = {
      label,
      cwd,
      command: [executable, ...args],
      startedAt: new Date().toISOString(),
      timeoutMs,
    };
    batch.commands.push(record);
    await save();
    let outcome;
    try {
      outcome = await runCommandProcess({
        executable,
        args,
        cwd,
        env,
        stdio: ['ignore', log.fd, log.fd],
        timeoutMs,
        signal,
      });
    } catch (error) {
      outcome = { code: null, error: error.stack ?? String(error) };
    } finally {
      await new Promise((resolve) => log.end(resolve));
    }
    Object.assign(record, outcome, {
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(record.startedAt),
    });
    await save();
    assert(
      !record.timedOut,
      `${label} timed out; stop to avoid overlapping orphaned descendants`,
    );
    assert(
      !record.signal &&
        !record.error &&
        !record.interrupted &&
        !record.descendantsAfterLeaderExit &&
        record.cleanup?.groupGone &&
        !signal.aborted,
      `${label} interrupted or could not start`,
    );
    return record;
  }
  function assertNoLeftoverStudyProcesses() {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 30_000,
    }).split('\n');
    const prefixes = Object.values(roots).map(
      (root) => `${root}/node_modules/electron/`,
    );
    const leftovers = rows.filter((row) =>
      prefixes.some((prefix) => row.includes(prefix)),
    );
    assert.equal(
      leftovers.length,
      0,
      'Stage Electron processes remain; stop without killing any process',
    );
  }
  let studyLaunched = false;
  let immutable;
  async function verify(label) {
    const startedAtMs = Date.now();
    assert(
      !signal.aborted && Date.now() < workDeadlineMs - 30_000,
      'Study work deadline reached; preserve partial evidence',
    );
    for (const [stage, root] of Object.entries(roots)) {
      equal(
        await manifest(path.join(root, 'out')),
        batch.stages[stage].bundles,
        `${label}: ${stage} bundle changed`,
      );
      equal(
        await sourceManifest(root),
        immutable[stage],
        `${label}: ${stage} source changed`,
      );
    }
    batch.checks.push({
      label,
      at: new Date().toISOString(),
      status: 'immutable',
      durationMs: Date.now() - startedAtMs,
    });
    await save();
  }
  try {
    await save();
    for (const [stage, root] of Object.entries(roots)) {
      assert.equal(
        git(root, ['status', '--porcelain']).trim(),
        '',
        `${stage} checkout must be pristine`,
      );
      const commit = git(root, ['rev-parse', 'HEAD']).trim(),
        tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
      assertReleaseStageIdentity(stage, commit, tree, candidateCommit);
      if (local) {
        assert.equal(
          await realpath(git(root, ['rev-parse', '--show-toplevel']).trim()),
          root,
          'Local stage must be a checkout root',
        );
        assert.equal(
          git(root, [
            'ls-files',
            '--others',
            '--ignored',
            '--exclude-standard',
          ]).trim(),
          '',
          'Local stage must have no reused ignored resources or environment files',
        );
      }
      const source = await sourceManifest(root);
      assert(
        !Object.keys(source).some((file) =>
          /(?:^|\/)\.env(?:\.(?:local|production|development|test)(?:\.local)?)?$/.test(
            file,
          ),
        ),
        'Tracked runtime env files are forbidden',
      );
      await saveJson(`${stage}-original-source.json`, source);
      batch.stages[stage] = {
        root,
        commit,
        tree,
        originalSourceManifestSha256: digest(canonical(source)),
        lockfileSha256: await hashFile(
          path.join(root, (await stagePackageManager(root)).lockfile),
        ),
      };
      await writeFile(
        path.join(output, `${stage}-original-diff.patch`),
        git(root, ['diff', '--binary', 'HEAD']),
      );
    }
    equal(
      batch.stages.baseline.lockfileSha256,
      batch.stages.candidate.lockfileSha256,
      'Lockfiles differ',
    );
    const packageValues = Object.fromEntries(
      await Promise.all(
        Object.entries(roots).map(async ([stage, root]) => [
          stage,
          JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')),
        ]),
      ),
    );
    equal(
      comparablePackage(packageValues.baseline),
      comparablePackage(packageValues.candidate),
      'Unreviewed package/runtime configuration difference',
    );
    const unitPrefix =
      'node scripts/run-guarded-dev-script.mjs --suite unit -- node ';
    assert.equal(
      packageValues.baseline.scripts['test:desktop-performance'],
      unitPrefix + '--test apps/desktop-app/tests/performance/*.test.mjs',
    );
    assert.equal(
      packageValues.candidate.scripts['test:desktop-performance'],
      unitPrefix +
        '--import tsx --test apps/desktop-app/tests/performance/*.test.mjs',
    );
    batch.allowedPackageDelta = {
      key: 'scripts.test:desktop-performance',
      baseline: packageValues.baseline.scripts['test:desktop-performance'],
      candidate: packageValues.candidate.scripts['test:desktop-performance'],
      ruling:
        'Explicitly reviewed unit-test launcher-only change; every other package field compared exactly',
    };
    await save();
    await writeFile(
      path.join(output, 'baseline-to-candidate.patch'),
      git(roots.candidate, ['diff', '--binary', BASELINE_SHA, candidateCommit]),
    );
    for (const [stage, root] of Object.entries(roots)) {
      const manager = await stagePackageManager(root);
      for (const [suffix, executable, args] of [
        ['install', manager.executable, manager.install],
        ['electron', process.execPath, ['node_modules/electron/install.js']],
        ['build', manager.executable, ['run', 'build']],
      ]) {
        const result = await command(
          `${stage}-${suffix}`,
          root,
          executable,
          args,
          45 * 60_000,
        );
        assert.equal(
          result.code,
          0,
          `${stage}-${suffix} failed; see preserved log`,
        );
      }
      assert.equal(
        packageValues[stage].scripts['check:no-e2e-seams'],
        'node scripts/check-no-e2e-seams.mjs',
      );
      const seams = await command(
        `${stage}-production-e2e-seams`,
        root,
        manager.executable,
        ['run', 'check:no-e2e-seams'],
      );
      assert.equal(seams.code, 0, `${stage} production E2E seam check failed`);
      const emitted = await manifest(path.join(root, 'out'));
      const hookHits = [];
      for (const relative of Object.keys(emitted).filter((file) =>
        /\.(?:js|cjs|mjs)$/.test(file),
      )) {
        const content = await readFile(
          path.join(root, 'out', relative),
          'utf8',
        );
        for (const hook of PROFILE_E2E_HOOKS)
          if (content.includes(hook)) hookHits.push({ relative, hook });
      }
      await saveJson(`${stage}-profile-e2e-seams.json`, {
        forbiddenHooks: PROFILE_E2E_HOOKS,
        hookHits,
      });
      assert.equal(
        hookHits.length,
        0,
        `${stage} emitted profile E2E hook present`,
      );
      const electronPackagePath = await realpath(
        path.join(root, 'node_modules', 'electron', 'package.json'),
      );
      assert(
        electronPackagePath.startsWith(`${root}/node_modules/`),
        `${stage} Electron metadata escaped its checkout dependency tree`,
      );
      const electronPackage = JSON.parse(
        await readFile(electronPackagePath, 'utf8'),
      );
      assert.equal(electronPackage.version, '42.3.0');
      // pnpm lockfiles have no install-path map; check every workspace link.
      const links =
        manager.lockfile === 'pnpm-lock.yaml'
          ? (await readdir(path.join(root, 'node_modules', '@canopy'))).map(
              (name) => [`node_modules/@canopy/${name}`, { link: true }],
            )
          : Object.entries(
              JSON.parse(
                await readFile(path.join(root, 'package-lock.json'), 'utf8'),
              ).packages ?? {},
            );
      for (const [relative, entry] of links)
        if (entry.link && relative.startsWith('node_modules/')) {
          const resolved = await realpath(path.join(root, relative));
          assert(
            resolved.startsWith(`${root}/`),
            `${stage} workspace alias escaped its checkout: ${relative}`,
          );
        }
      batch.stages[stage].electron = electronPackage.version;
      batch.stages[stage].bundles = await manifest(path.join(root, 'out'));
      assert(
        Object.keys(batch.stages[stage].bundles).length > 10,
        'Missing production bundle',
      );
      await saveJson(
        `${stage}-bundle-manifest.json`,
        batch.stages[stage].bundles,
      );
      const archivePath = path.join(output, `${stage}-production-out.tar.gz`);
      const archive = await command(
        `${stage}-archive-production-out`,
        root,
        'tar',
        ['-czf', archivePath, '-C', root, 'out'],
      );
      assert.equal(archive.code, 0, `${stage} production archive failed`);
      batch.stages[stage].productionArchive = {
        path: archivePath,
        sha256: await hashFile(archivePath),
      };
      equal(
        await manifest(path.join(root, 'out')),
        batch.stages[stage].bundles,
        `${stage} bundle changed while archiving`,
      );
      await saveJson(
        `${stage}-post-build-source.json`,
        await sourceManifest(root),
      );
      await writeFile(
        path.join(output, `${stage}-build-source-diff.patch`),
        git(root, ['diff', '--binary', 'HEAD']),
      );
      await save();
    }
    assert.notEqual(
      await realpath(path.join(roots.baseline, 'node_modules')),
      await realpath(path.join(roots.candidate, 'node_modules')),
    );
    batch.buildConfigExtractorSha256 = await hashFile(
      path.join(roots.candidate, 'scripts/browser-profiles-build-config.py'),
    );
    await copyFile(
      path.join(roots.candidate, 'scripts/browser-profiles-build-config.py'),
      path.join(output, 'browser-profiles-build-config.py'),
    );
    await save();
    const extraction = await command(
      'effective-build-configuration',
      roots.candidate,
      'python3',
      [
        path.join(roots.candidate, 'scripts/browser-profiles-build-config.py'),
        roots.baseline,
        roots.candidate,
        output,
      ],
    );
    assert.equal(
      extraction.code,
      0,
      'Effective emitted build configuration could not be matched',
    );
    batch.effectiveBuildConfiguration = JSON.parse(
      await readFile(path.join(output, 'effective-build-config.json'), 'utf8'),
    );
    for (const stage of Object.keys(roots)) {
      const sortedManifest = Object.fromEntries(
        Object.entries(batch.stages[stage].bundles).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
      assert.equal(
        batch.effectiveBuildConfiguration[stage].bundleManifestSha256,
        digest(JSON.stringify(sortedManifest)),
        `${stage} emitted configuration evidence belongs to another bundle`,
      );
    }
    const require = createRequire(path.join(roots.candidate, 'package.json')),
      ts = require('typescript');
    const files = new Set();
    async function visit(relative) {
      checkTraversal();
      if (files.has(relative)) return;
      assert(
        relative.startsWith('apps/desktop-app/tests/') ||
          relative.startsWith('demo-apps/'),
        `Unexpected production/config test import: ${relative}`,
      );
      files.add(relative);
      const absolute = path.join(roots.candidate, relative),
        source = ts.createSourceFile(
          absolute,
          await readFile(absolute, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
      if (
        relative ===
        DRIVER_ROOT + 'browser-profiles-production-headless-bootstrap.cjs'
      )
        assertProductionBootstrapImports(source.text, ts);
      const imports = [];
      function walk(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          assert(
            ts.isStringLiteral(node.arguments[0]),
            `Nonliteral dynamic test import: ${relative}`,
          );
          imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, walk);
      }
      walk(source);
      for (const specifier of imports.filter((entry) => entry.startsWith('.')))
        await visit(
          path.normalize(path.join(path.dirname(relative), specifier)),
        );
    }
    for (const file of [
      'browser-profiles-release-run.mjs',
      'browser-profiles-startup-run.mjs',
      'browser-profiles-supplemental-run.mjs',
      'browser-profiles-production-headless-bootstrap.cjs',
      'browser-profiles-production-headless-preflight.mjs',
    ])
      await visit(DRIVER_ROOT + file);
    await visit('demo-apps/seed-canopy-data.mjs'); // Spawned, not statically imported.
    for (const relative of [...files]
      .filter((file) => file.startsWith('demo-apps/'))
      .concat([
        (await stagePackageManager(roots.candidate)).lockfile,
        'demo-apps/catalog.json',
        'demo-apps/archives/ts-pnpm-vite.zip',
        'scripts/run-guarded-dev-script.mjs',
        'scripts/lib/dev-script-safety.mjs',
      ])) {
      const hash = await hashFile(path.join(roots.candidate, relative));
      assert.equal(
        await hashFile(path.join(roots.baseline, relative)),
        hash,
        `Read-only test support differs: ${relative}`,
      );
    }
    for (const relative of [...files]
      .filter((file) => file.startsWith('apps/desktop-app/tests/'))
      .sort()) {
      const beforePath = path.join(roots.baseline, relative),
        sourcePath = path.join(roots.candidate, relative);
      let previous = null;
      try {
        previous = await hashFile(beforePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const expected = await hashFile(sourcePath);
      assertReviewedReleaseOverlay(relative, previous, expected);
      const backup = path.join(output, 'overlay', relative);
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(sourcePath, backup);
      if (previous !== expected) {
        if (previous) {
          await mkdir(path.dirname(`${backup}.original`), { recursive: true });
          await copyFile(beforePath, `${backup}.original`);
        }
        await mkdir(path.dirname(beforePath), { recursive: true });
        await copyFile(sourcePath, beforePath);
      }
      assert.equal(await hashFile(beforePath), expected);
      batch.overlay.push({
        relative,
        previousSha256: previous,
        installedSha256: expected,
      });
    }
    await saveJson('overlay-manifest.json', batch.overlay);
    batch.overlayManifestSha256 = digest(canonical(batch.overlay));
    await writeFile(
      path.join(output, 'baseline-test-overlay.patch'),
      git(roots.baseline, [
        'diff',
        '--binary',
        'HEAD',
        '--',
        'apps/desktop-app/tests',
      ]),
    );
    immutable = Object.fromEntries(
      await Promise.all(
        Object.entries(roots).map(async ([stage, root]) => [
          stage,
          await sourceManifest(root),
        ]),
      ),
    );
    for (const stage of Object.keys(roots))
      await saveJson(`${stage}-immutable-source.json`, immutable[stage]);
    const { RESPONSIVENESS_THRESHOLDS } = await import(
      pathToFileURL(path.join(roots.candidate, DRIVER_ROOT, 'profiles.mjs'))
    );
    batch.canonicalResponsivenessThresholds = RESPONSIVENESS_THRESHOLDS;
    assertNoLeftoverStudyProcesses();
    await verify('before-studies');
    // Native prerequisites are retained separately and cannot consume/replace a
    // warmup or any of the exact 33/66 scheduled driver invocations.
    const adapterSha256 = await hashFile(
      path.join(
        roots.candidate,
        DRIVER_ROOT,
        'browser-profiles-production-headless-bootstrap.cjs',
      ),
    );
    batch.headlessAdapter = {
      adapterVersion: 'production-hidden-native-v1',
      adapterSha256,
    };
    for (const stage of Object.keys(roots)) {
      const reportPath = path.join(
        output,
        `${stage}-native-headless-preflight.json`,
      );
      await verify(`before-native-preflight-${stage}`);
      studyLaunched = true;
      const result = await command(
        `native-headless-preflight-${stage}`,
        roots[stage],
        process.execPath,
        [
          ...releaseDriverPrefix(values.execution, owner),
          DRIVER_ROOT + 'browser-profiles-production-headless-preflight.mjs',
          '--window-mode',
          values['window-mode'],
          '--output',
          reportPath,
        ],
      );
      batch.nativePreflights[stage] = { reportPath, code: result.code };
      await save();
      if (!qualification)
        assert.equal(
          result.code,
          0,
          'Native headless capability unavailable; measured population prohibited',
        );
      const preflight = JSON.parse(await readFile(reportPath, 'utf8'));
      const rawPath = `${reportPath}.cold.json`;
      assert.equal(
        preflight.rawPath,
        rawPath,
        'Preflight raw report link mismatch',
      );
      const raw = JSON.parse(await readFile(rawPath, 'utf8'));
      const expected = {
        ...batch.headlessAdapter,
        productMainSha256: batch.stages[stage].bundles['main/index.js'],
      };
      validateReleaseHeadlessReport(raw, expected);
      const classification = classifyReleaseReport(
        'cold',
        raw,
        result.code,
        RESPONSIVENESS_THRESHOLDS,
      );
      validateReleaseNativePreflight(preflight, expected, {
        qualification,
        raw,
        code: result.code,
        thresholds: RESPONSIVENESS_THRESHOLDS,
      });
      assertReleaseRawIdentity(raw, batch.stages[stage]);
      assertReleaseComparability(batch, 'cold', raw);
      await validateReleaseArchives(raw, rawPath, expected);
      equal(
        preflight.bundlesBefore,
        batch.stages[stage].bundles,
        'Native preflight bundle identity mismatch',
      );
      assert.equal(preflight.source.commit, batch.stages[stage].commit);
      await verify(`after-native-preflight-${stage}`);
      assertNoLeftoverStudyProcesses();
      Object.assign(batch.nativePreflights[stage], classification, {
        status: preflight.status,
        verified: true,
        rawPath,
        rawSha256: await hashFile(rawPath),
        reportSha256: await hashFile(reportPath),
      });
      batch.performanceFailed ||= !classification.passed;
      if (!classification.passed) process.exitCode = 1;
      await save();
    }
    batch.preparationMs = Date.now() - executionStartedAt;
    for (const [ordinal, plan] of batch.schedule.entries()) {
      await verify(`before-${ordinal}`);
      const name = `${String(ordinal).padStart(3, '0')}-${plan.mode}-${plan.stage}-${plan.phase}-${plan.pair}`;
      const reportPath = path.join(output, `${name}.json`);
      const driver =
        DRIVER_ROOT +
        (['common', 'maintenance'].includes(plan.mode)
          ? 'browser-profiles-release-run.mjs'
          : plan.mode === 'startup'
            ? 'browser-profiles-startup-run.mjs'
            : 'browser-profiles-supplemental-run.mjs');
      const args = [
        ...releaseDriverPrefix(values.execution, owner),
        driver,
        '--window-mode',
        values['window-mode'],
        '--samples',
        '1',
        '--warmups',
        '0',
        '--output',
        reportPath,
      ];
      if (plan.mode === 'maintenance') args.push('--maintenance');
      else if (plan.mode === 'startup')
        args.push(
          '--stage',
          plan.stage === 'baseline' ? 'frozenPhase2' : 'finalPhase3',
        );
      else if (!['common', 'maintenance'].includes(plan.mode))
        args.push('--mode', plan.mode);
      const attempt = {
        ...plan,
        ordinal,
        reportPath,
        commandLabel: name,
        status: 'running',
      };
      batch.attempts.push(attempt);
      await save();
      studyLaunched = true;
      const result = await command(
        name,
        roots[plan.stage],
        process.execPath,
        args,
      );
      attempt.code = result.code;
      try {
        attempt.rawSha256 = await hashFile(reportPath);
        const raw = JSON.parse(await readFile(reportPath, 'utf8'));
        assertReleaseRawIdentity(raw, batch.stages[plan.stage]);
        attempt.primary = {
          status: raw.samples?.[0]?.status,
          error: raw.samples?.[0]?.error,
          responsiveness: raw.samples?.[0]?.responsiveness,
        };
        if (!qualification) {
          assert.equal(result.code, 0);
          assert.equal(raw.summary?.passed, true);
          assert.equal(raw.samples[0].status, 'ok');
        }
        assert(
          typeof raw.environment?.power === 'string' &&
            raw.environment.power.includes('AC Power'),
          'AC power unestablished',
        );
        await validateReleaseArchives(raw, reportPath, {
          ...batch.headlessAdapter,
          productMainSha256: batch.stages[plan.stage].bundles['main/index.js'],
        });
        const classification = classifyReleaseReport(
          plan.mode,
          raw,
          result.code,
          RESPONSIVENESS_THRESHOLDS,
        );
        if (!qualification)
          assert(
            classification.passed,
            'Canonical absolute responsiveness gate failed',
          );
        assertReleaseComparability(batch, plan.mode, raw);
        await verify(`after-${ordinal}`);
        assertNoLeftoverStudyProcesses();
        Object.assign(attempt, classification, {
          verified: true,
        });
        batch.performanceFailed ||= !classification.passed;
        if (!classification.passed) process.exitCode = 1;
      } catch (error) {
        Object.assign(attempt, {
          status: 'failed',
          structuralStatus: 'invalid',
          performanceStatus: 'not-assessable',
          failureClass: 'structural',
          passed: false,
          error: error.stack ?? String(error),
        });
        await save();
        throw error;
      }
      await save();
      process.stdout.write(
        `${ordinal + 1}/${batch.schedule.length} ${name}: ${attempt.status}\n`,
      );
      // No retry or sample dropping. Ordinary gate failures remain and all finite
      // studies continue sequentially. Integrity/timeout failures abort above.
    }
  } catch (error) {
    batch.fatalError = error.stack ?? String(error);
    batch.collectionComplete = false;
    for (const record of [
      ...Object.values(batch.nativePreflights),
      ...batch.attempts,
    ])
      if (!record.verified)
        Object.assign(record, {
          structuralStatus: 'invalid',
          performanceStatus: 'not-assessable',
          failureClass: 'structural',
          passed: false,
          error: record.error ?? batch.fatalError,
        });
    process.exitCode = 1;
  } finally {
    const finalizationStartedAt = Date.now();
    traversalDeadline = local
      ? Math.min(deadlineMs, finalizationStartedAt + 5 * 60_000)
      : finalizationStartedAt + 5 * 60_000;
    if (studyLaunched) {
      try {
        assertNoLeftoverStudyProcesses();
        batch.studyProcessCleanup = 'no-leftover-stage-electron-processes';
      } catch (error) {
        batch.studyProcessCleanup = 'leftovers-or-inspection-failure';
        batch.cleanupError = error.stack ?? String(error);
        batch.fatalError ??= batch.cleanupError;
        process.exitCode = 1;
      }
    }
    for (const attempt of batch.attempts)
      if (attempt.status === 'running') attempt.status = 'incomplete';
    batch.completedAt = new Date().toISOString();
    batch.missingIds = batch.schedule
      .map((plan, ordinal) => ({ ...plan, ordinal }))
      .slice(batch.attempts.length);
    await save();
    const analysis = {
      status: qualification
        ? 'qualification-incomplete-or-failed'
        : 'exploratory-incomplete-or-failed',
      comparison: qualification
        ? 'not-applicable-to-qualification'
        : 'exploratory-only',
      finalAcceptance: false,
      studyWindowMode: batch.studyWindowMode,
      viewport: batch.viewport,
      windowVisible: batch.windowVisible,
      headlessAdapter: batch.headlessAdapter,
      nativePreflights: batch.nativePreflights,
      modes: {},
      failures: batch.attempts.filter((entry) => entry.status !== 'ok'),
      missingAttempts: batch.schedule.length - batch.attempts.length,
      limitations: batch.limitations,
      metricSemantics: {
        peakWorkingSetMb:
          'MiB; maximum summed Electron app.getAppMetrics working set across scored workload monitoring, excluding setup; not pre-window RSS',
        taskDurations:
          'Per-launch median/p95 within task kind; operations are not pooled across launches',
        settledResources:
          'Independent declared settled observation window; CPU percent vs working-set MiB',
        startupRss:
          'KiB; sampled owned process tree before window / PID through usable shell; not Electron working-set scope',
        inventoryWorker:
          'One actual inventory worker process; working set KiB and sampled CPU percent, only request-to-complete workload',
      },
    };
    try {
      for (const [stage, record] of Object.entries(batch.nativePreflights)) {
        assert(record.verified, 'Incomplete prerequisite');
        assert.equal(
          await hashFile(record.reportPath),
          record.reportSha256,
          'Retained preflight changed',
        );
        assert.equal(
          await hashFile(record.rawPath),
          record.rawSha256,
          'Retained prerequisite raw changed',
        );
        const raw = JSON.parse(await readFile(record.rawPath, 'utf8'));
        const value = JSON.parse(await readFile(record.reportPath, 'utf8'));
        const expected = {
          ...batch.headlessAdapter,
          productMainSha256: batch.stages[stage].bundles['main/index.js'],
        };
        validateReleaseNativePreflight(value, expected, {
          qualification,
          raw,
          code: record.code,
          thresholds: batch.canonicalResponsivenessThresholds,
        });
        await validateReleaseArchives(raw, record.rawPath, expected);
      }
    } catch (error) {
      batch.fatalError ??= error.stack ?? String(error);
      process.exitCode = 1;
    }
    const rows = await Promise.all(
      batch.attempts.map(async (attempt) => {
        try {
          return {
            attempt,
            raw: JSON.parse(await readFile(attempt.reportPath, 'utf8')),
          };
        } catch {
          return { attempt, raw: null };
        }
      }),
    );
    for (const mode of MODES) {
      checkTraversal();
      const modeRows = rows.filter(({ attempt }) => attempt.mode === mode);
      const expectedCount = batch.schedule.filter(
        (x) => x.mode === mode,
      ).length;
      const reasons = [];
      if (
        modeRows.length !== expectedCount ||
        modeRows.some(({ attempt }) =>
          qualification
            ? attempt.structuralStatus !== 'valid' || !attempt.verified
            : attempt.status !== 'ok',
        )
      )
        reasons.push('Missing/failed samples or warmups; all retained');
      const reference = modeRows[0]?.raw;
      for (const row of modeRows) {
        const { raw, attempt } = row;
        row.retainedValid = false;
        if (!raw || !reference) {
          reasons.push('Missing raw report');
          continue;
        }
        try {
          assert.equal(
            await hashFile(attempt.reportPath),
            attempt.rawSha256,
            'Retained report changed',
          );
          assertReleaseRawIdentity(raw, batch.stages[attempt.stage]);
          await validateReleaseArchives(raw, attempt.reportPath, {
            ...batch.headlessAdapter,
            productMainSha256:
              batch.stages[attempt.stage].bundles['main/index.js'],
          });
          const classification = classifyReleaseReport(
            mode,
            raw,
            attempt.code,
            batch.canonicalResponsivenessThresholds,
          );
          for (const key of [
            'structuralStatus',
            'performanceStatus',
            'violations',
            'raw',
          ])
            equal(
              classification[key],
              attempt[key],
              `Retained classification ${key} changed`,
            );
          if (!qualification) validateReleaseSample(mode, raw.samples?.[0]);
          row.retainedValid = true;
        } catch (error) {
          reasons.push(`Invalid retained workload report: ${String(error)}`);
          batch.fatalError ??= error.stack ?? String(error);
          attempt.retainedValidationError = String(error);
        }
        if (canonical(raw.configuration) !== canonical(reference.configuration))
          reasons.push('Driver configuration mismatch');
        reasons.push(...runtimeComparisonReasons(mode, raw, reference));
        equalFields(
          raw.environment,
          reference.environment,
          [
            'platform',
            'architecture',
            'release',
            'cpu',
            'memoryBytes',
            'node',
            'viewport',
            'studyViewportPreset',
            'studyWindowMode',
            'windowVisible',
            'settings',
            'powerSettings',
            'effectiveEnvironmentValueHashes',
          ],
          reasons,
          'environment',
        );
      }
      const stageMetrics = (stage) =>
        modeRows
          .filter(
            ({ attempt, retainedValid }) =>
              retainedValid &&
              attempt.stage === stage &&
              attempt.phase === 'measured' &&
              (qualification
                ? attempt.structuralStatus === 'valid'
                : attempt.status === 'ok'),
          )
          .sort((a, b) => a.attempt.pair - b.attempt.pair)
          .map(({ raw }) =>
            qualification
              ? classifiedMetrics(mode, raw?.samples?.[0])
              : metrics(mode, raw?.samples?.[0]),
          );
      const before = stageMetrics('baseline'),
        after = stageMetrics('candidate');
      const names = [...new Set([...before, ...after].flatMap(Object.keys))];
      const comparisons =
        !qualification && MATCHED.includes(mode)
          ? names.map((name) =>
              compareMetric(
                name,
                before.map((entry) => entry[name]),
                after.map((entry) => entry[name]),
              ),
            )
          : [];
      if (
        !qualification &&
        MATCHED.includes(mode) &&
        (!comparisons.length ||
          comparisons.some((metric) => !metricPermitsExploration(metric)))
      )
        reasons.push(
          'Missing required metric or exploratory 10% budget exceeded',
        );
      analysis.modes[mode] = {
        kind: qualification
          ? 'qualification-only'
          : MATCHED.includes(mode)
            ? 'matched-exploratory'
            : 'candidate-only-absolute',
        collectionComplete: reasons.length === 0,
        status: reasons.length
          ? 'failed-or-incomplete'
          : qualification &&
              modeRows.some(
                ({ attempt }) => attempt.performanceStatus === 'failed',
              )
            ? 'qualification-collected-performance-failed'
            : releaseModeCompleteStatus(qualification),
        reasons: [...new Set(reasons)],
        comparisons,
        baselineMetrics: before,
        candidateMetrics: after,
        observations: batch.schedule
          .map((plan, ordinal) => ({ ...plan, ordinal }))
          .filter((plan) => plan.mode === mode && plan.phase === 'measured')
          .map((plan) => {
            const row = modeRows.find(
              ({ attempt }) => attempt.ordinal === plan.ordinal,
            );
            return {
              stage: plan.stage,
              mode,
              pair: plan.pair,
              ordinal: plan.ordinal,
              reportPath: row?.attempt.reportPath ?? null,
              structuralStatus: row?.retainedValid
                ? row.attempt.structuralStatus
                : 'invalid',
              performanceStatus: row?.retainedValid
                ? row.attempt.performanceStatus
                : 'not-assessable',
              violations: row?.attempt.violations ?? [],
              metrics: row?.retainedValid
                ? classifiedMetrics(mode, row.raw.samples[0])
                : null,
            };
          }),
      };
    }
    await persistReleaseFinalization({
      batch,
      analysis,
      qualification,
      output,
      execution: values.execution,
      finalizationStartedAt,
      signal,
    });
  }
}
export async function persistReleaseFinalization(
  {
    batch,
    analysis,
    qualification,
    output,
    execution,
    finalizationStartedAt,
    signal,
  },
  {
    writeJson = (name, value) =>
      writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`),
  } = {},
) {
  const local = execution === 'local-physical';
  const saveJson = async (name, value) => {
    checkTraversal();
    await writeJson(name, value);
    checkTraversal();
  };
  const save = () => saveJson('batch.json', batch);
  const interruptedOnEntry = Boolean(signal?.aborted);
  const latchInterruption = () => {
    process.exitCode = 1;
    batch.interruption ??= {
      phase: interruptedOnEntry ? 'before-finalization' : 'finalization',
      at: new Date().toISOString(),
      reason: String(signal.reason ?? 'Release study interrupted'),
    };
    batch.fatalError ??= 'Release study interrupted';
    analysis.interruption = batch.interruption;
  };
  signal?.addEventListener('abort', latchInterruption, { once: true });
  if (interruptedOnEntry) latchInterruption();
  async function persist() {
    finalizeReleaseAnalysis(batch, analysis, qualification);
    if (qualification)
      await saveJson('qualification-capacity.json', analysis.capacity);
    await saveJson('analysis.json', analysis);
    await saveJson('next-stage-parameters.json', {
      executable: false,
      prerequisite:
        'Every exploratory mode passes plus variance/provenance review; a separately reviewed stable orchestrator is required',
      stages: batch.stages,
      modeOrder: MODES,
      matchedModes: MATCHED,
      independentSamplesPerStageAndMode: 20,
      excludedWarmupsPerStageAndMode: 1,
      pairOrder: 'AB for even pairs; BA for odd pairs',
      driverArgumentsPerLaunch: ['--samples', '1', '--warmups', '0'],
      maximumRegressionRatio: 1.1,
      requiredStatistics: ['median', 'p95'],
      requiredMeasures: [
        'operation latency',
        'peak working set',
        'settled CPU where measurable',
      ],
      varianceRule:
        'Budget-overlapping variance is inconclusive; gather more evidence without removing any sample',
      rawSampleRetention: 'all including failed samples and warmups',
    });
    await writeFile(
      path.join(output, 'report.md'),
      `# Browser profile release fixed study (${execution})\n\nStatus: **${analysis.status}**. Final acceptance: **false**.\n\n${batch.attempts.length}/${batch.schedule.length} independent launches attempted; ${analysis.failures.length} scheduled failures and ${Object.values(batch.nativePreflights ?? {}).filter((record) => record.performanceStatus === 'failed' || record.structuralStatus === 'invalid').length} prerequisite failures retained. One warmup per stage/mode excluded; ${qualification ? 'two qualification observations; no acceptance/comparison' : 'five measured samples required'}.\n\n${Object.entries(
        analysis.modes,
      )
        .map(([mode, value]) => `- ${mode}: ${value.status}`)
        .join(
          '\n',
        )}\n\nSee [analysis](analysis.json), [full provenance and attempts](batch.json), [emitted configuration](effective-build-config.json), and [inactive stable-stage protocol](next-stage-parameters.json). No older laptop measurements are included.\n\n${batch.limitations.join('\n\n')}\n\n${batch.fatalError ? `Fatal error is preserved in batch.json.\n` : ''}`,
    );
    batch.outputFootprint = await outputFootprint(output, traversalDeadline);
    batch.finalization = {
      interrupted: Boolean(batch.interruption),
      durationBeforeManifestMs: Date.now() - finalizationStartedAt,
      maximumMs: 300000,
      uploadTiming: local
        ? 'Local evidence only; no upload performed by orchestrator'
        : 'GitHub upload action and final timing step logs; no upload performed by orchestrator',
    };
    await save();
    const artifacts = await manifest(output);
    // The bounded interruption rewrite must not hash an earlier self-manifest.
    delete artifacts['artifact-manifest.json'];
    delete artifacts['finalization.json'];
    await saveJson('artifact-manifest.json', artifacts);
    await saveJson('finalization.json', {
      interrupted: Boolean(batch.interruption),
      durationMs: Date.now() - finalizationStartedAt,
      maximumMs: 300000,
      manifestExclusions: ['artifact-manifest.json', 'finalization.json'],
    });
    if (
      ![
        'qualification-complete-no-acceptance',
        'exploratory-protocol-passed-not-final-acceptance',
      ].includes(analysis.status)
    )
      process.exitCode = 1;
  }
  try {
    await persist();
    // A signal can arrive after analysis/report serialization, including during
    // the last finalization.json write. Rewrite once with the latched failure.
    // AbortSignal fires only once; repeated process signals cannot extend this
    // bounded pass or change the latched evidence. Keep the original deadline.
    if (signal?.aborted && !interruptedOnEntry) await persist();
  } catch (error) {
    process.exitCode = 1;
    batch.finalizationError ??= error.stack ?? String(error);
    batch.fatalError ??= batch.finalizationError;
    batch.collectionComplete = false;
    batch.qualificationPassed = false;
    finalizeReleaseAnalysis(batch, analysis, qualification);
    // One bounded best-effort failure rewrite. An unavailable destination cannot
    // be repaired here; preserve the original error and never claim completion.
    try {
      await persist();
    } catch (failure) {
      batch.finalizationRecoveryError = failure.stack ?? String(failure);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', latchInterruption);
  }
}

function equalFields(actual, expected, fields, reasons, label) {
  for (const field of fields)
    if (
      (![
        'settings',
        'powerSettings',
        'effectiveEnvironmentValueHashes',
      ].includes(field) &&
        (actual?.[field] === undefined || expected?.[field] === undefined)) ||
      canonical(actual?.[field]) !== canonical(expected?.[field])
    )
      reasons.push(`${label}.${field} mismatch`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

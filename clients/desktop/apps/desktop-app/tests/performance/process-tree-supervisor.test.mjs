import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBoundaryRecorder } from '../electron/browser-profile-test-lifecycle.mjs';
import {
  acceptanceCommandArgs,
  parseAcceptanceSupervisorProof,
} from './run-browser-profile-acceptance-command.mjs';
import * as supervisorModule from './process-tree-supervisor.mjs';
import {
  closeCanopy,
  launchCanopyApp,
  makeTestTreeOwnerWritable,
  reapSupervisedProcessTree,
  registerSupervisedProcessTree,
  removeTestDataDir,
} from '../electron/launchCanopy.mjs';
import {
  attachChildLifecycle,
  buildWindowsProcessTreeListScript,
  createPosixProcessTreeOwner,
  createProcessTreeOwner,
  createSupervisorProcessTreeOwner,
  createWindowsProcessTreeOwner,
  parsePosixProcessList,
  posixProcessGroupIsOwned,
  releaseWindowsSupervisedChild,
  resolveProcessTreeRefreshInterval,
  resolveSupervisorOwnerPid,
  startParentLivenessWatch,
  startProcessTreeOwnerRefresh,
} from './process-tree-supervisor.mjs';

const WINDOWS_FAILURE_MARKER = '[e2e-supervisor:windows-launch-failure] ';
const DEFAULT_WATCHDOG_FIXTURE_DEADLINE_MS = 3_000;
const WINDOWS_TEST_CREATION = Object.freeze({
  wrapper: '2026-09-15T00:00:00.0000000Z',
  target: '2026-09-15T00:00:01.0000000Z',
  helper: '2026-09-15T00:00:02.0000000Z',
  laterHelper: '2026-09-15T00:00:03.0000000Z',
  reusedWrapper: '2026-09-15T01:00:00.0000000Z',
  reusedTarget: '2026-09-15T01:00:01.0000000Z',
  reusedHelper: '2026-09-15T01:00:02.0000000Z',
  foreign: '2026-09-14T00:00:00.0000000Z',
});
// Fixture-only safety ceiling: 35,500 ms of configured one-target
// query/grace/poll windows plus 4,500 ms for scheduling. This is not a
// guaranteed production cleanup bound.
const WINDOWS_WATCHDOG_FIXTURE_SAFETY_CEILING_MS = 40_000;

function observeRawSnapshot(stdout) {
  return ({ observe, rootPid }) => {
    const parsed = supervisorModule.parseWindowsProcessList(stdout, rootPid);
    observe({
      outcome: 'completed',
      durationMs: 12,
      outputState: 'completed',
      outputBytes: Buffer.byteLength(stdout),
      ...parsed.metadata,
    });
    return parsed.rows;
  };
}

function filterWindowsSnapshot(rows, filterPid) {
  return rows.filter((row) => filterPid === undefined || row.pid === filterPid);
}

function rawWindowsProcessOutput(rows, { includeNoise = false } = {}) {
  return [
    'phase=ps-ready',
    ...(rows.length || includeNoise ? ['phase=cim-first-row'] : []),
    '',
    ...rows,
    ...(includeNoise ? ['9999\t1\t', 'malformed-system-row', ''] : []),
    'phase=cim-complete',
    '',
  ].join('\r\n');
}

function parseFailureLine(line) {
  assert.ok(line.startsWith(WINDOWS_FAILURE_MARKER));
  return JSON.parse(line.slice(WINDOWS_FAILURE_MARKER.length));
}

function mockChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function exitMockChild(child) {
  child.exitCode = 0;
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
}

function prepareWatchdogTestDiagnosticDirectory(
  directory,
  { platform = process.platform, mkdir = mkdirSync } = {},
) {
  if (platform !== 'win32') return false;
  try {
    mkdir(directory, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function processStartTime(pid, env = process.env) {
  try {
    const startTime = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env,
    }).trim();
    return startTime || null;
  } catch {
    return null;
  }
}

function sidecarTracksGroup(filePath, runNonce, pgid) {
  try {
    const [headerLine, ...recordLines] = readFileSync(filePath, 'utf8').split(
      /\r?\n/,
    );
    const header = JSON.parse(headerLine);
    return (
      header.v === 1 &&
      header.nonce === runNonce &&
      recordLines.some((line) => line && JSON.parse(line).pgid === pgid)
    );
  } catch {
    return false;
  }
}

function launchWatchdogTestProcesses(
  diagnosticDirectory,
  {
    platform = process.platform,
    mkdir = mkdirSync,
    spawnProcess = spawn,
    execPath = process.execPath,
  } = {},
) {
  const diagnosticDirectoryReady = prepareWatchdogTestDiagnosticDirectory(
    diagnosticDirectory,
    { platform, mkdir },
  );
  const supervisor = spawnProcess(
    execPath,
    ['-e', 'setInterval(() => undefined, 10_000)'],
    { stdio: 'ignore' },
  );
  const target = spawnProcess(
    execPath,
    ['-e', 'setInterval(() => undefined, 10_000)'],
    { detached: true, stdio: 'ignore' },
  );
  return { diagnosticDirectoryReady, supervisor, target };
}

function createWatchdogDeadline({
  platform = process.platform,
  error,
  record,
  supervisor,
  target,
  watchdog,
  setTimeoutFn = setTimeout,
  createPromise = (executor) => new Promise(executor),
}) {
  return createPromise((_, reject) =>
    setTimeoutFn(
      () => {
        record?.('watchdog-deadline', {
          outcome: 'rejected',
          exitCode: watchdog.exitCode,
          signalCode: watchdog.signalCode,
          lifecycle: {
            supervisorExited:
              supervisor.exitCode !== null || supervisor.signalCode !== null,
            targetExited:
              target.exitCode !== null || target.signalCode !== null,
            watchdogExited:
              watchdog.exitCode !== null || watchdog.signalCode !== null,
          },
        });
        reject(error);
      },
      platform === 'win32'
        ? WINDOWS_WATCHDOG_FIXTURE_SAFETY_CEILING_MS
        : DEFAULT_WATCHDOG_FIXTURE_DEADLINE_MS,
    ).unref(),
  );
}

async function runWatchdogEmergencyCleanup({
  supervisor,
  target,
  watchdog,
  watchdogClosed,
  observe,
}) {
  if (supervisor.exitCode === null && supervisor.signalCode === null) {
    observe('supervisor-stop', () => supervisor.kill('SIGTERM'));
  }
  if (watchdog.exitCode === null && watchdog.signalCode === null) {
    await observe('watchdog-stop', async () => {
      watchdog.kill('SIGTERM');
      await watchdogClosed;
    });
  }
  if (target.exitCode === null && target.signalCode === null) {
    observe('target-stop', () => target.kill('SIGTERM'));
  }
}

async function waitForCondition(predicate, failureMessage, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(failureMessage);
}

test('launchCanopyApp returns the low-level launch fields after shell readiness', async () => {
  const electronApp = {
    firstWindow: async () => ({ id: 'window' }),
  };
  const launchResult = {
    electronApp,
    userDataDir: '/tmp/launch-canopy-app-ready',
    killAbruptly() {},
  };
  const calls = [];
  class Driver {
    constructor(window) {
      this.window = window;
    }

    async waitForShell(options) {
      calls.push({ window: this.window, options });
    }
  }

  const result = await launchCanopyApp(
    { waitForShellOptions: { timeout: 12_345 } },
    {
      launch: async (options) => {
        assert.equal('waitForShellOptions' in options, false);
        return launchResult;
      },
      AppDriver: Driver,
    },
  );

  assert.equal(result.electronApp, electronApp);
  assert.deepEqual(result.window, { id: 'window' });
  assert.equal(result.app.window, result.window);
  assert.deepEqual(calls, [
    { window: { id: 'window' }, options: { timeout: 12_345 } },
  ]);
  assert.equal(result.killAbruptly, launchResult.killAbruptly);
});

test('launchCanopyApp closes failed launches and preserves only caller-owned data', async () => {
  for (const callerOwned of [false, true]) {
    const userDataDir = callerOwned
      ? '/tmp/launch-canopy-app-caller-owned'
      : '/tmp/launch-canopy-app-helper-owned';
    const electronApp = { firstWindow: async () => ({}) };
    const closeCalls = [];

    await assert.rejects(
      () =>
        launchCanopyApp(callerOwned ? { userDataDir } : {}, {
          launch: async () => ({ electronApp, userDataDir }),
          AppDriver: class {
            async waitForShell() {
              throw new Error('shell did not become ready');
            }
          },
          close: async (...args) => closeCalls.push(args),
        }),
      /shell did not become ready/,
    );

    assert.deepEqual(closeCalls, [
      [electronApp, userDataDir, { keepUserData: callerOwned }],
    ]);
  }
});

test('closeCanopy reaps the process tree before deleting both data roots', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'close-canopy-order-'),
  );
  const secureDir = `${userDataDir}-secure`;
  mkdirSync(secureDir);
  const calls = [];
  const electronApp = {
    close: async () => calls.push('close'),
  };
  registerSupervisedProcessTree(electronApp, 4321);

  try {
    await closeCanopy(electronApp, userDataDir, {
      reapTree: async (pid) => {
        assert.equal(pid, 4321);
        assert.equal(existsSync(userDataDir), true);
        assert.equal(existsSync(secureDir), true);
        calls.push('reap');
      },
      removeDataDir: async (target) => {
        calls.push(`remove:${target}`);
        rmSync(target, { recursive: true, force: true });
      },
    });

    assert.deepEqual(calls, [
      'close',
      'reap',
      `remove:${userDataDir}`,
      `remove:${secureDir}`,
    ]);
    assert.equal(existsSync(userDataDir), false);
    assert.equal(existsSync(secureDir), false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(secureDir, { recursive: true, force: true });
  }
});

test('closeCanopy still reaps and deletes after close failure, while keepUserData preserves roots', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'close-canopy-failure-'),
  );
  const secureDir = `${userDataDir}-secure`;
  mkdirSync(secureDir);
  const closeError = new Error('close failed');
  const calls = [];
  const electronApp = {
    close: async () => {
      calls.push('close');
      throw closeError;
    },
  };
  registerSupervisedProcessTree(electronApp, 5432);

  await assert.rejects(
    () =>
      closeCanopy(electronApp, userDataDir, {
        keepUserData: true,
        reapTree: async () => calls.push('reap'),
        removeDataDir: async () => calls.push('remove'),
      }),
    (error) => error === closeError,
  );
  assert.deepEqual(calls, ['close', 'reap']);
  assert.equal(existsSync(userDataDir), true);
  assert.equal(existsSync(secureDir), true);

  const cleanupApp = { close: async () => calls.push('cleanup-close') };
  registerSupervisedProcessTree(cleanupApp, 6543);
  await closeCanopy(cleanupApp, userDataDir, {
    reapTree: async () => calls.push('cleanup-reap'),
    removeDataDir: async (target) => {
      calls.push(`remove:${target}`);
      rmSync(target, { recursive: true, force: true });
    },
  });
  assert.deepEqual(calls.slice(-4), [
    'cleanup-close',
    'cleanup-reap',
    `remove:${userDataDir}`,
    `remove:${secureDir}`,
  ]);
});

test('test-data removal retries transient failures and repairs read-only roots', async () => {
  for (const code of ['ENOTEMPTY', 'EBUSY', 'EPERM']) {
    const calls = [];
    await removeTestDataDir('/tmp/injected-test-root', {
      remove: () => {
        calls.push('remove');
        if (calls.length === 1) {
          throw Object.assign(new Error(code), { code });
        }
      },
      makeWritable: () => calls.push('writable'),
    });
    assert.deepEqual(calls, ['remove', 'writable', 'remove']);
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'close-canopy-read-only-'));
  const nested = path.join(root, 'capability');
  mkdirSync(nested);
  writeFileSync(path.join(nested, 'SKILL.md'), 'read only');
  chmodSync(path.join(nested, 'SKILL.md'), 0o400);
  chmodSync(nested, 0o500);
  await removeTestDataDir(root);
  assert.equal(existsSync(root), false);
});

test('writable-tree repair does not follow symlinks outside the test root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'close-canopy-symlink-'));
  const external = mkdtempSync(
    path.join(os.tmpdir(), 'close-canopy-symlink-target-'),
  );
  const externalFile = path.join(external, 'keep-mode.txt');
  writeFileSync(externalFile, 'outside');
  chmodSync(externalFile, 0o400);
  const externalMode = lstatSync(externalFile).mode & 0o777;
  symlinkSync(external, path.join(root, 'external-link'));

  try {
    makeTestTreeOwnerWritable(root);
    assert.equal(lstatSync(externalFile).mode & 0o777, externalMode);
    assert.equal(readFileSync(externalFile, 'utf8'), 'outside');
  } finally {
    chmodSync(externalFile, 0o600);
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('closeCanopy reaps a delayed writer before deleting its profile', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'close-canopy-delayed-writer-'),
  );
  const markerPath = path.join(userDataDir, 'late-write.txt');
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'late'), 150); setTimeout(() => {}, 5000);`,
    ],
    { stdio: 'ignore' },
  );
  const electronApp = { close: async () => undefined };
  registerSupervisedProcessTree(electronApp, writer.pid);

  await closeCanopy(electronApp, userDataDir, {
    reapTree: async () => {
      writer.kill('SIGKILL');
      await new Promise((resolve) => writer.once('exit', resolve));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(existsSync(userDataDir), false);
  assert.equal(existsSync(markerPath), false);
});

test('process-tree owner escalates TERM to KILL when the child group stays alive', async () => {
  const child = mockChild();
  const signals = [];
  let alive = true;
  const owner = createProcessTreeOwner(child, {
    isAlive: () => alive,
    killProcessTree: async (_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') alive = false;
    },
    delay: async () => undefined,
    graceMs: 0,
  });

  await owner.stop();

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('process-tree owner stops after TERM when the child exits', async () => {
  const child = mockChild();
  const signals = [];
  let alive = true;
  const owner = createProcessTreeOwner(child, {
    isAlive: () => alive,
    killProcessTree: async (_pid, signal) => {
      signals.push(signal);
      alive = false;
      child.exitCode = 0;
      child.emit('exit', 0, null);
    },
    delay: async () => undefined,
  });

  await owner.stop();

  assert.deepEqual(signals, ['SIGTERM']);
});

test('process-tree owner polls and returns promptly when the child exits during grace', async () => {
  const child = mockChild();
  const signals = [];
  const waits = [];
  let alive = true;
  const owner = createProcessTreeOwner(child, {
    isAlive: () => alive,
    killProcessTree: async (_pid, signal) => signals.push(signal),
    graceMs: 5_000,
    pollIntervalMs: 50,
    delay: async (ms) => {
      waits.push(ms);
      alive = false;
    },
  });

  await owner.stop();

  assert.deepEqual(signals, ['SIGTERM']);
  assert.deepEqual(waits, [50]);
});

test('process-tree grace uses a wall-clock deadline when liveness checks are slow', async () => {
  const signals = [];
  let livenessChecks = 0;
  let nowMs = 0;
  const owner = createProcessTreeOwner(mockChild(), {
    isAlive: async () => {
      livenessChecks += 1;
      nowMs += 2_000;
      return true;
    },
    killProcessTree: async (_pid, signal) => signals.push(signal),
    graceMs: 5_000,
    pollIntervalMs: 100,
    now: () => nowMs,
    delay: async (ms) => {
      nowMs += ms;
    },
  });

  await owner.stop();

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(livenessChecks <= 4);
});

test('parent liveness watch invokes cleanup once when the harness parent dies', async () => {
  let check;
  let cleanupCalls = 0;
  const watch = startParentLivenessWatch({
    parentPid: 1234,
    isProcessAlive: () => false,
    onParentExit: async () => {
      cleanupCalls += 1;
    },
    setIntervalFn: (callback) => {
      check = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => undefined,
  });

  await check();
  await check();
  watch.stop();

  assert.equal(cleanupCalls, 1);
});

test('supervisor monitors an explicit harness owner above a Windows shell wrapper', () => {
  assert.equal(resolveSupervisorOwnerPid('2468', 1357), 2468);
  assert.equal(resolveSupervisorOwnerPid(undefined, 1357), 1357);
});

test('Windows process enumeration supports a validated PID filter while preserving the full-query default', () => {
  const script = buildWindowsProcessTreeListScript();
  const filteredScript = buildWindowsProcessTreeListScript(4321);
  const psReady = 'phase=ps-ready';
  const firstRow = 'phase=cim-first-row';
  const complete = 'phase=cim-complete';

  assert.match(script, /CreationDate/);
  assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'"));
  assert.match(
    script,
    /Get-CimInstance Win32_Process -ErrorAction Stop \| ForEach-Object/,
  );
  assert.doesNotMatch(script, /-Filter/);
  assert.match(
    filteredScript,
    /Get-CimInstance Win32_Process -Filter "ProcessId=4321" -ErrorAction Stop \| ForEach-Object/,
  );
  for (const invalidPid of [
    null,
    '4321',
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => buildWindowsProcessTreeListScript(invalidPid),
      /positive safe integer/,
    );
  }
  for (const marker of [psReady, firstRow, complete]) {
    assert.equal(script.split(marker).length - 1, 1);
    assert.equal(filteredScript.split(marker).length - 1, 1);
  }
  assert.ok(script.indexOf(psReady) < script.indexOf('Get-CimInstance'));
  assert.ok(script.indexOf('Get-CimInstance') < script.indexOf(firstRow));
  assert.ok(script.indexOf(firstRow) < script.indexOf('$created'));
  assert.ok(script.indexOf('$created') < script.indexOf(complete));
  assert.match(
    script,
    /WriteLine\("phase=ps-ready"\)\n\[Console\]::Out\.Flush\(\)/,
  );
  assert.match(
    script,
    /WriteLine\("phase=cim-first-row"\)\n {4}\[Console\]::Out\.Flush\(\)/,
  );
  assert.match(
    script,
    /WriteLine\("phase=cim-complete"\)\n\[Console\]::Out\.Flush\(\)/,
  );
});

test('Windows admission emission script is opt-in, fixed, bounded and nonthrowing', () => {
  const disabled = buildWindowsProcessTreeListScript(4321);
  const enabled = buildWindowsProcessTreeListScript(4321, {
    file: "C:\\owned\\launch's-admission-emission.jsonl",
  });

  assert.equal(
    disabled,
    [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::Out.WriteLine("phase=ps-ready")',
      '[Console]::Out.Flush()',
      '$_canopyFirstCimRow = $true',
      'Get-CimInstance Win32_Process -Filter "ProcessId=4321" -ErrorAction Stop | ForEach-Object {',
      '  if ($_canopyFirstCimRow) {',
      '    [Console]::Out.WriteLine("phase=cim-first-row")',
      '    [Console]::Out.Flush()',
      '    $_canopyFirstCimRow = $false',
      '  }',
      '  $created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("O") } else { "" }',
      '  Write-Output ("{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $created)',
      '}',
      '[Console]::Out.WriteLine("phase=cim-complete")',
      '[Console]::Out.Flush()',
    ].join('\n'),
  );
  assert.doesNotMatch(
    disabled,
    /admission-emission|AppendAllText|UtcNow\.Ticks/,
  );
  assert.match(enabled.split('\n')[0], /^try \{/);
  assert.equal(enabled.split('AppendAllText').length - 1, 4);
  assert.equal(enabled.split('catch {}').length - 1, 4);
  for (const stage of [
    'script-enter',
    'pre-cim',
    'first-row-callback',
    'post-pipeline',
  ])
    assert.equal(enabled.split(`"stage":"${stage}"`).length - 1, 1);
  assert.match(
    enabled,
    /\(\[DateTime\]::UtcNow\.Ticks\)\.ToString\(\[Globalization\.CultureInfo\]::InvariantCulture\)/,
  );
  assert.match(enabled, /C:\\owned\\launch''s-admission-emission\.jsonl/);
  assert.ok(
    enabled.indexOf('"stage":"script-enter"') <
      enabled.indexOf("$ErrorActionPreference = 'Stop'"),
  );
  assert.ok(
    enabled.indexOf('"stage":"pre-cim"') < enabled.indexOf('Get-CimInstance'),
  );
  assert.ok(
    enabled.indexOf('"stage":"first-row-callback"') <
      enabled.indexOf('phase=cim-first-row'),
  );
  assert.ok(
    enabled.indexOf('"stage":"post-pipeline"') > enabled.lastIndexOf('\n}'),
  );
  assert.throws(
    () =>
      buildWindowsProcessTreeListScript(4321, {
        file: 'C:\\owned\\bad\npath.jsonl',
      }),
    /emission path/,
  );
});

test('Windows admission emission parser preserves ticks and distinguishes complete-empty, partial and invalid evidence', () => {
  const row = (sequence, stage, utcTicks, powershellPid = 6789) =>
    JSON.stringify({
      schemaVersion: 1,
      sequence,
      stage,
      utcTicks,
      powershellPid,
    });
  const parse = supervisorModule.parseWindowsAdmissionEmissionRecords;
  const full = parse(
    [
      row(1, 'script-enter', '9007199254740992'),
      row(2, 'pre-cim', '638936064000000000'),
      row(3, 'first-row-callback', '638936064000000001'),
      row(4, 'post-pipeline', '638936064000000002'),
      '',
    ].join('\n'),
    6789,
  );
  assert.equal(full.status, 'valid');
  assert.equal(full.completedEmpty, false);
  assert.deepEqual(
    full.records.map(({ utcTicks }) => utcTicks),
    [
      '9007199254740992',
      '638936064000000000',
      '638936064000000001',
      '638936064000000002',
    ],
  );

  const empty = parse(
    [
      row(1, 'script-enter', '638936064000000000'),
      row(2, 'pre-cim', '638936064000000001'),
      row(3, 'post-pipeline', '638936064000000002'),
      '',
    ].join('\n'),
    6789,
  );
  assert.equal(empty.status, 'valid');
  assert.equal(empty.completedEmpty, true);
  assert.equal(
    parse(row(1, 'script-enter', '638936064000000000'), 6789).status,
    'partial',
  );

  for (const text of [
    row(1, 'pre-cim', '638936064000000000'),
    [
      row(1, 'script-enter', '638936064000000000'),
      row(2, 'script-enter', '638936064000000001'),
    ].join('\n'),
    [
      row(1, 'script-enter', '638936064000000001'),
      row(2, 'pre-cim', '638936064000000000'),
    ].join('\n'),
    row(1, 'script-enter', '638936064000000000', 6790),
    row(1, 'unknown', '638936064000000000'),
    row(1, 'script-enter', '0'),
    row(1, 'script-enter', '0638936064000000000'),
    row(1, 'script-enter', '+638936064000000000'),
    row(1, 'script-enter', '6.38936064000000000e17'),
    row(1, 'script-enter', '638936064000000000 '),
    row(1, 'script-enter', '12345678901234567890'),
    JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      stage: 'script-enter',
      utcTicks: 638936064000000000,
      powershellPid: 6789,
    }),
    JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      stage: 'script-enter',
      utcTicks: '638936064000000000',
    }),
    JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      stage: 'script-enter',
      utcTicks: '638936064000000000',
      powershellPid: 6789,
      commandLine: 'forbidden',
    }),
    [
      row(1, 'script-enter', '638936064000000000'),
      row(2, 'pre-cim', '638936064000000001'),
      row(3, 'first-row-callback', '638936064000000002'),
      row(4, 'post-pipeline', '638936064000000003'),
      row(5, 'post-pipeline', '638936064000000004'),
    ].join('\n'),
    row(1, 'script-enter', '638936064000000000') + '\n{',
    row(1, 'script-enter', '638936064000000000') + '\n\n',
    'x'.repeat(4097),
  ]) {
    const result = parse(text, 6789);
    assert.equal(result.status, 'invalid', text.slice(0, 80));
    assert.ok(result.error.length <= 128);
  }
});

test('generic Windows owners keep full initial enumeration by default', async () => {
  const filters = [];
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async ({ filterPid }) => {
      filters.push(filterPid);
      return [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }];
    },
  });

  assert.equal(await owner.ready, true);
  assert.deepEqual(filters, [undefined]);
});

test('Windows cleanup proof gets a bounded host-load enumeration budget', async () => {
  const queries = [];
  let queryCount = 0;
  const child = mockChild();
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ timeoutMs }) => {
      queries.push(timeoutMs);
      queryCount += 1;
      return queryCount === 1
        ? [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }]
        : [];
    },
    isProcessAlive: () => false,
  });

  assert.equal(await owner.ready, true);
  exitMockChild(child);
  await owner.stop();
  assert.deepEqual(queries, [5_000, 15_000]);
});

test('Windows launch gate filters admission and cleanup candidates while lineage and final proof stay full', async () => {
  const filters = [];
  const messages = [];
  const signals = [];
  const alive = new Set([4321]);
  let fullQueryCount = 0;
  const child = {
    pid: 4321,
    send(message) {
      messages.push(message);
    },
  };
  const owner = createSupervisorProcessTreeOwner(child, {
    useWindowsLaunchGate: true,
    listProcesses: async ({ filterPid }) => {
      filters.push(filterPid);
      if (filterPid !== undefined) {
        assert.equal(filterPid, 4321);
        return [
          {
            pid: 4321,
            parentPid: 1,
            creationDate: WINDOWS_TEST_CREATION.wrapper,
          },
        ];
      }
      fullQueryCount += 1;
      if (fullQueryCount === 1) {
        return [
          {
            pid: 4321,
            parentPid: 1,
            creationDate: WINDOWS_TEST_CREATION.wrapper,
          },
          {
            pid: 5000,
            parentPid: 4321,
            creationDate: WINDOWS_TEST_CREATION.target,
          },
          {
            pid: 5001,
            parentPid: 5000,
            creationDate: WINDOWS_TEST_CREATION.helper,
          },
        ];
      }
      return [
        {
          pid: 4321,
          parentPid: 1,
          creationDate: WINDOWS_TEST_CREATION.wrapper,
        },
        {
          pid: 5000,
          parentPid: 9999,
          creationDate: WINDOWS_TEST_CREATION.reusedTarget,
        },
        {
          pid: 5002,
          parentPid: 5000,
          creationDate: WINDOWS_TEST_CREATION.reusedHelper,
        },
      ];
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    delay: async () => undefined,
  });

  assert.equal(await releaseWindowsSupervisedChild(child, owner), true);
  assert.deepEqual(messages, ['start']);
  owner.trackOwnedPid(5000);
  await owner.refresh();
  alive.clear();
  alive.add(5001);
  assert.equal(await owner.isAlive(), true);

  await owner.refresh();
  alive.clear();
  alive.add(4321);
  await owner.stop();

  assert.equal(filters[0], 4321);
  assert.ok(filters.length >= 4);
  assert.deepEqual(filters, [
    4321,
    undefined,
    undefined,
    undefined,
    4321,
    undefined,
  ]);
  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
});

test('Windows launch gate aborts on unavailable or malformed filtered identity', async () => {
  for (const listProcesses of [
    async () => {
      throw new Error('identity query unavailable');
    },
    async () => [{ pid: 9000, parentPid: 1, creationDate: 'other-created' }],
    async () => [{ pid: 4321, parentPid: 1, creationDate: '' }],
  ]) {
    const filters = [];
    const messages = [];
    const child = {
      pid: 4321,
      send(message) {
        messages.push(message);
      },
    };
    const owner = createSupervisorProcessTreeOwner(child, {
      useWindowsLaunchGate: true,
      listProcesses: (options) => {
        filters.push(options.filterPid);
        return listProcesses(options);
      },
    });

    assert.equal(await releaseWindowsSupervisedChild(child, owner), false);
    assert.deepEqual(filters, [4321]);
    assert.deepEqual(messages, ['abort']);
  }
});

test('Windows launch-gate cleanup cancels pending filtered admission before ownership', async () => {
  let resolveInitialIdentity;
  const initialIdentity = new Promise((resolve) => {
    resolveInitialIdentity = resolve;
  });
  const filters = [];
  const alive = new Set([4321]);
  const signals = [];
  const owner = createSupervisorProcessTreeOwner(mockChild(), {
    useWindowsLaunchGate: true,
    listProcesses: ({ filterPid }) => {
      filters.push(filterPid);
      return filterPid === 4321 ? initialIdentity : []; // The aborted wrapper has exited before final verification.
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    delay: async () => undefined,
  });

  const stopping = owner.stop();
  await Promise.resolve();
  assert.deepEqual(filters, [4321]);
  resolveInitialIdentity([
    { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
  ]);
  await stopping;

  assert.equal(filters[0], 4321);
  assert.ok(filters.slice(1).every((filterPid) => filterPid === undefined));
  assert.equal(await owner.ready, false);
  assert.deepEqual(signals, []);
});

test('Windows process parser rejects phase markers while preserving ownership rows', async () => {
  const stdout = [
    'phase=ps-ready',
    'phase=cim-first-row',
    '4321\t1\troot-created',
    'phase=cim-complete',
  ].join('\r\n');
  const parsed = supervisorModule.parseWindowsProcessList(stdout, 4321);

  assert.deepEqual(parsed.rows, [
    { pid: 4321, parentPid: 1, creationDate: 'root-created' },
  ]);
  assert.equal(parsed.metadata.acceptedCount, 1);
  assert.equal(parsed.metadata.rejectedCount, 3);

  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: observeRawSnapshot(stdout),
  });
  assert.equal(await owner.ready, true);
  assert.equal(owner.getInitialDiagnosticSnapshot().root.ready, true);
});

test('POSIX process enumeration preserves spaced start times and rejects malformed rows', () => {
  assert.deepEqual(
    parsePosixProcessList(
      [
        '  4321     1  4321 Mon Sep 21 13:39:50 2026',
        'not-a-pid 1 2 Mon Sep 21 13:39:51 2026',
        '4322 missing 4322 Mon Sep 21 13:39:52 2026',
        '4323 4321 invalid Mon Sep 21 13:39:53 2026',
        'incomplete',
      ].join('\n'),
    ),
    [
      {
        pid: 4321,
        parentPid: 1,
        pgid: 4321,
        startTime: 'Mon Sep 21 13:39:50 2026',
      },
    ],
  );
});

test('POSIX tree refresh cadence accepts positive overrides and ignores junk', () => {
  assert.equal(resolveProcessTreeRefreshInterval('25'), 25);
  assert.equal(resolveProcessTreeRefreshInterval('0'), 1_000);
  assert.equal(resolveProcessTreeRefreshInterval('1.5'), 1_000);
  assert.equal(resolveProcessTreeRefreshInterval('junk'), 1_000);
});

const initialPosixTree = [
  {
    pid: 4321,
    parentPid: 1,
    pgid: 4321,
    startTime: 'root-created',
  },
  {
    pid: 4322,
    parentPid: 4321,
    pgid: 4321,
    startTime: 'intermediate-created',
  },
  {
    pid: 5000,
    parentPid: 4322,
    pgid: 5000,
    startTime: 'leader-created',
  },
  {
    pid: 5001,
    parentPid: 5000,
    pgid: 5000,
    startTime: 'member-created',
  },
];

test('POSIX owner records descendants that detach into another process group', async () => {
  const owner = createPosixProcessTreeOwner(mockChild(), {
    listProcesses: async () => initialPosixTree,
  });

  assert.equal(await owner.ready, true);
  assert.deepEqual(
    owner.trackedGroups().map((group) => ({
      pgid: group.pgid,
      leaderStart: group.leaderStart,
      members: Array.from(group.members),
    })),
    [
      {
        pgid: 4321,
        leaderStart: 'root-created',
        members: [
          [4321, 'root-created'],
          [4322, 'intermediate-created'],
        ],
      },
      {
        pgid: 5000,
        leaderStart: 'leader-created',
        members: [
          [5000, 'leader-created'],
          [5001, 'member-created'],
        ],
      },
    ],
  );
});

test('POSIX owner ignores unsafe process groups at or below one', async () => {
  const owner = createPosixProcessTreeOwner(mockChild(), {
    listProcesses: async () => [
      initialPosixTree[0],
      {
        pid: 4322,
        parentPid: 4321,
        pgid: 1,
        startTime: 'unsafe-member-created',
      },
    ],
  });

  assert.equal(await owner.ready, true);
  assert.deepEqual(
    owner.trackedGroups().map((group) => group.pgid),
    [4321],
  );
});

test('POSIX owner persists root-group member identities in its sidecar', async () => {
  let sidecarContents = '';
  const owner = createPosixProcessTreeOwner(mockChild(), {
    listProcesses: async () => initialPosixTree,
    trackedGroupsFile: '/injected/groups.ndjson',
    runNonce: 'current-run',
    writeFileAtomically: (_filePath, contents) => {
      sidecarContents = contents;
    },
  });

  assert.equal(await owner.ready, true);
  await owner.initializeSidecar();
  const [headerLine] = sidecarContents.split('\n');
  assert.deepEqual(JSON.parse(headerLine).rootMembers, [
    [4321, 'root-created'],
    [4322, 'intermediate-created'],
  ]);
});

async function stopPosixOwnerAgainst(revalidationRows) {
  let snapshots = 0;
  let alive = true;
  const signals = [];
  const owner = createPosixProcessTreeOwner(mockChild(), {
    listProcesses: async () => {
      snapshots += 1;
      return snapshots === 1 ? initialPosixTree : revalidationRows;
    },
    processGroupExists: () => alive,
    killProcessTree: async (pgid, signal) => {
      signals.push([pgid, signal]);
      if (pgid === 4321) alive = false;
    },
    graceMs: 0,
  });
  await owner.stop();
  return signals;
}

test('POSIX owner signals a detached group whose leader identity still matches', async () => {
  const signals = await stopPosixOwnerAgainst(initialPosixTree);
  assert.deepEqual(signals, [
    [5000, 'SIGTERM'],
    [4321, 'SIGTERM'],
  ]);
});

test('POSIX owner signals a leaderless group through a recorded member identity', async () => {
  const signals = await stopPosixOwnerAgainst([
    initialPosixTree[0],
    {
      pid: 5001,
      parentPid: 1,
      pgid: 5000,
      startTime: 'member-created',
    },
  ]);
  assert.deepEqual(signals, [
    [5000, 'SIGTERM'],
    [4321, 'SIGTERM'],
  ]);
});

test('POSIX owner never signals a group whose leader PID was reused', async () => {
  const signals = await stopPosixOwnerAgainst([
    initialPosixTree[0],
    {
      pid: 5000,
      parentPid: 9999,
      pgid: 5000,
      startTime: 'reused-leader',
    },
  ]);
  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
});

test('POSIX owner never signals a leaderless group with only unrecorded members', async () => {
  const signals = await stopPosixOwnerAgainst([
    initialPosixTree[0],
    {
      pid: 5002,
      parentPid: 1,
      pgid: 5000,
      startTime: 'unrecorded-member',
    },
  ]);
  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
});

test('POSIX owner never signals the root group after its leader PID is reused', async () => {
  const signals = await stopPosixOwnerAgainst([
    {
      pid: 4321,
      parentPid: 1,
      pgid: 4321,
      startTime: 'reused-root',
    },
  ]);
  assert.deepEqual(signals, []);
});

test('POSIX group ownership prefers a leader identity over unrelated matching data', () => {
  assert.equal(
    posixProcessGroupIsOwned(
      {
        pgid: 5000,
        leaderStart: 'leader-created',
        members: new Map([[5001, 'member-created']]),
      },
      [
        {
          pid: 5000,
          parentPid: 1,
          pgid: 5000,
          startTime: 'reused-leader',
        },
        {
          pid: 5001,
          parentPid: 1,
          pgid: 5000,
          startTime: 'member-created',
        },
      ],
    ),
    false,
  );
});

test('POSIX group ownership requires the leader to remain in the tracked group', () => {
  assert.equal(
    posixProcessGroupIsOwned(
      {
        pgid: 5000,
        leaderStart: 'leader-created',
        members: new Map([[5000, 'leader-created']]),
      },
      [
        {
          pid: 5000,
          parentPid: 9999,
          pgid: 6000,
          startTime: 'leader-created',
        },
      ],
    ),
    false,
  );
});

test('POSIX owner does not discover descendants from a reused root in another group', async () => {
  let snapshot = initialPosixTree;
  const owner = createPosixProcessTreeOwner(mockChild(), {
    listProcesses: async () => snapshot,
  });

  assert.equal(await owner.ready, true);
  snapshot = [
    {
      pid: 4321,
      parentPid: 9999,
      pgid: 6000,
      startTime: 'root-created',
    },
    {
      pid: 6001,
      parentPid: 4321,
      pgid: 6001,
      startTime: 'unrelated-descendant-created',
    },
  ];

  await owner.refresh();
  assert.deepEqual(owner.trackedGroups(), []);
});

function trackedGroupsText({
  nonce = 'current-run',
  rootMembers,
  records = [],
} = {}) {
  return [
    JSON.stringify({
      v: 1,
      nonce,
      rootPid: 4321,
      rootStart: 'root-created',
      ...(rootMembers ? { rootMembers } : {}),
    }),
    ...records.map((record) =>
      typeof record === 'string' ? record : JSON.stringify(record),
    ),
    '',
  ].join('\n');
}

const detachedGroupRecord = {
  pgid: 5000,
  leaderStart: 'leader-created',
  members: [
    [5000, 'leader-created'],
    [5001, 'member-created'],
  ],
};

test(
  'closeCanopy reaper kills a tracked group after the root group is gone',
  { skip: process.platform === 'win32' },
  async () => {
    const alive = new Set([5000]);
    const signals = [];
    await reapSupervisedProcessTree(4321, {
      trackedGroupsFile: '/injected/groups.ndjson',
      runNonce: 'current-run',
      readFile: () => trackedGroupsText({ records: [detachedGroupRecord] }),
      listProcesses: async () => [
        {
          pid: 5001,
          parentPid: 1,
          pgid: 5000,
          startTime: 'member-created',
        },
      ],
      treeExists: (pgid) => alive.has(pgid),
      killTree: async (pgid, signal) => {
        signals.push([pgid, signal]);
        alive.delete(pgid);
      },
    });
    assert.deepEqual(signals, [[5000, 'SIGKILL']]);
  },
);

test(
  'closeCanopy reaper rejects stale and invalid sidecar headers but still reaps the root',
  { skip: process.platform === 'win32' },
  async () => {
    const invalidSidecars = [
      () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      () => '{"v":1',
      () =>
        JSON.stringify({
          v: 2,
          nonce: 'current-run',
          rootPid: 4321,
          rootStart: 'root-created',
        }),
      () =>
        trackedGroupsText({
          nonce: 'previous-run',
          records: [detachedGroupRecord],
        }),
      () =>
        trackedGroupsText({
          rootMembers: [[4322, 'helper-created']],
        }),
    ];
    for (const readFile of invalidSidecars) {
      const alive = new Set([4321]);
      const signals = [];
      await reapSupervisedProcessTree(4321, {
        trackedGroupsFile: '/injected/groups.ndjson',
        runNonce: 'current-run',
        readFile,
        listProcesses: async () => {
          throw new Error('invalid sidecar must not be enumerated');
        },
        treeExists: (pgid) => alive.has(pgid),
        killTree: async (pgid, signal) => {
          signals.push([pgid, signal]);
          alive.delete(pgid);
        },
      });
      assert.deepEqual(signals, [[4321, 'SIGKILL']]);
    }
  },
);

test(
  'closeCanopy reaper skips malformed records while honoring valid records',
  { skip: process.platform === 'win32' },
  async () => {
    const alive = new Set([5000]);
    const signals = [];
    await reapSupervisedProcessTree(4321, {
      trackedGroupsFile: '/injected/groups.ndjson',
      runNonce: 'current-run',
      readFile: () =>
        trackedGroupsText({ records: ['not-json', detachedGroupRecord] }),
      listProcesses: async () => [
        {
          pid: 5000,
          parentPid: 1,
          pgid: 5000,
          startTime: 'leader-created',
        },
      ],
      treeExists: (pgid) => alive.has(pgid),
      killTree: async (pgid, signal) => {
        signals.push([pgid, signal]);
        alive.delete(pgid);
      },
    });
    assert.deepEqual(signals, [[5000, 'SIGKILL']]);
  },
);

test(
  'closeCanopy reaper rejects sidecar process groups at or below one',
  { skip: process.platform === 'win32' },
  async () => {
    const signals = [];
    await reapSupervisedProcessTree(4321, {
      trackedGroupsFile: '/injected/groups.ndjson',
      runNonce: 'current-run',
      readFile: () =>
        trackedGroupsText({
          records: [
            {
              pgid: 1,
              leaderStart: 'unsafe-leader-created',
              members: [[1, 'unsafe-leader-created']],
            },
          ],
        }),
      listProcesses: async () => [
        {
          pid: 1,
          parentPid: 0,
          pgid: 1,
          startTime: 'unsafe-leader-created',
        },
      ],
      treeExists: (pgid) => pgid === 1,
      killTree: async (pgid, signal) => signals.push([pgid, signal]),
    });
    assert.deepEqual(signals, []);
  },
);

test(
  'closeCanopy reaper revalidates sidecar groups instead of trusting recorded pgids',
  { skip: process.platform === 'win32' },
  async () => {
    const signals = [];
    await reapSupervisedProcessTree(4321, {
      trackedGroupsFile: '/injected/groups.ndjson',
      runNonce: 'current-run',
      readFile: () => trackedGroupsText({ records: [detachedGroupRecord] }),
      listProcesses: async () => [
        {
          pid: 5000,
          parentPid: 9999,
          pgid: 5000,
          startTime: 'reused-leader',
        },
      ],
      treeExists: (pgid) => pgid === 5000,
      killTree: async (pgid, signal) => signals.push([pgid, signal]),
    });
    assert.deepEqual(signals, []);
  },
);

test(
  'closeCanopy reaper revalidates the sidecar root before signaling it',
  { skip: process.platform === 'win32' },
  async () => {
    const signals = [];
    await reapSupervisedProcessTree(4321, {
      trackedGroupsFile: '/injected/groups.ndjson',
      runNonce: 'current-run',
      readFile: () => trackedGroupsText(),
      listProcesses: async () => [
        {
          pid: 4321,
          parentPid: 1,
          pgid: 4321,
          startTime: 'reused-root',
        },
      ],
      treeExists: () => true,
      killTree: async (pgid, signal) => signals.push([pgid, signal]),
    });
    assert.deepEqual(signals, []);
  },
);

test(
  'closeCanopy reaper signals a leaderless root group through a recorded helper identity',
  { skip: process.platform === 'win32' },
  async () => {
    const alive = new Set([4321]);
    const signals = [];
    await reapSupervisedProcessTree(4321, {
      trackedGroupsFile: '/injected/groups.ndjson',
      runNonce: 'current-run',
      readFile: () =>
        trackedGroupsText({
          rootMembers: [
            [4321, 'root-created'],
            [4322, 'helper-created'],
          ],
        }),
      listProcesses: async () => [
        {
          pid: 4322,
          parentPid: 1,
          pgid: 4321,
          startTime: 'helper-created',
        },
      ],
      treeExists: (pgid) => alive.has(pgid),
      killTree: async (pgid, signal) => {
        signals.push([pgid, signal]);
        alive.delete(pgid);
      },
    });
    assert.deepEqual(signals, [[4321, 'SIGKILL']]);
  },
);

test('Windows launch waits for root ownership before releasing a fast child', async () => {
  let resolveSnapshot;
  const snapshot = new Promise((resolve) => {
    resolveSnapshot = resolve;
  });
  const messages = [];
  const child = {
    pid: 4321,
    send(message) {
      messages.push(message);
    },
  };
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: () => snapshot,
  });

  const release = releaseWindowsSupervisedChild(child, owner);
  await Promise.resolve();
  assert.deepEqual(messages, []);

  resolveSnapshot([
    { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
  ]);
  assert.equal(await release, true);
  assert.deepEqual(messages, ['start']);
});

test('Windows launch is aborted when root ownership cannot be established', async () => {
  const messages = [];
  const child = {
    send(message) {
      messages.push(message);
    },
  };

  assert.equal(
    await releaseWindowsSupervisedChild(child, {
      ready: Promise.resolve(false),
    }),
    false,
  );
  assert.deepEqual(messages, ['abort']);
});

test('Windows launch diagnostic preserves distinct enumeration errors', async () => {
  for (const { expected, stdout, outputState } of [
    {
      expected: {
        name: 'Error',
        code: null,
        signal: 'SIGTERM',
        killed: true,
        message: 'enumeration timed out',
        stderr: 'timeout stderr',
      },
      stdout: '4321\t1\tpartial-created\r\n',
      outputState: 'partial',
    },
    {
      expected: {
        name: 'Error',
        code: 'ENOENT',
        signal: null,
        killed: false,
        message: 'powershell.exe was not found',
        stderr: '',
      },
      stdout: undefined,
      outputState: 'unavailable',
    },
  ]) {
    const error = Object.assign(new Error(expected.message), expected);
    if (stdout !== undefined) error.stdout = stdout;
    const child = { pid: 4321, send() {} };
    const owner = createWindowsProcessTreeOwner(child, {
      listProcesses: async () => {
        throw error;
      },
    });
    let releaseSnapshot;

    assert.equal(
      await releaseWindowsSupervisedChild(child, owner, {
        observeRelease: (snapshot) => {
          releaseSnapshot = snapshot;
        },
      }),
      false,
    );
    const snapshot = owner.getInitialDiagnosticSnapshot();
    assert.equal(snapshot.ownershipOutcome, 'enumeration-error');
    assert.equal(snapshot.enumeration.outcome, 'error');
    assert.equal(snapshot.enumeration.outputState, outputState);
    assert.deepEqual(snapshot.enumeration.error, expected);
    assert.deepEqual(releaseSnapshot, {
      owned: false,
      attemptedMessage: 'abort',
      sendOutcome: 'returned',
      returned: false,
      error: null,
    });
  }
});

test('Windows launch diagnostic derives phase booleans only from captured failure stdout', async () => {
  const phaseCases = [
    {
      stdout: 'phase=ps-ready\r\n',
      expected: { psReady: true, cimFirstRow: false, cimComplete: false },
    },
    {
      stdout: 'phase=ps-ready\r\nphase=cim-first-row\r\n',
      expected: { psReady: true, cimFirstRow: true, cimComplete: false },
    },
    {
      stdout: 'phase=ps-ready\r\nphase=cim-first-row\r\nphase=cim-complete\r\n',
      expected: { psReady: true, cimFirstRow: true, cimComplete: true },
    },
    {
      stdout: '',
      message:
        'command contained phase=ps-ready, phase=cim-first-row, and phase=cim-complete',
      expected: { psReady: false, cimFirstRow: false, cimComplete: false },
    },
  ];

  for (const phaseCase of phaseCases) {
    const error = Object.assign(
      new Error(phaseCase.message ?? 'enumeration timed out'),
      {
        signal: 'SIGTERM',
        killed: true,
        stdout: phaseCase.stdout,
      },
    );
    const owner = createWindowsProcessTreeOwner(mockChild(), {
      listProcesses: async () => {
        throw error;
      },
    });

    assert.equal(await owner.ready, false);
    const ownerSnapshot = owner.getInitialDiagnosticSnapshot();
    assert.deepEqual(ownerSnapshot.enumeration.phases, phaseCase.expected);
    const record = parseFailureLine(
      supervisorModule.formatWindowsLaunchFailureDiagnostic({
        ownerSnapshot,
      }),
    );
    assert.deepEqual(record.enumeration.phases, phaseCase.expected);
  }
});

test('Windows launch diagnostic identifies post-enumeration identity errors', async () => {
  const identityError = new Error('identity processing failed');
  const child = { pid: 4321, send() {} };
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: ({ observe }) => {
      observe({
        outcome: 'completed',
        durationMs: 8,
        timeoutMs: 5_000,
        outputState: 'completed',
        outputBytes: 20,
        lineCount: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        rootCandidateCount: 1,
        rootCandidates: [],
        fieldTruncationCount: 0,
        error: null,
      });
      return [
        Object.defineProperty({}, 'pid', {
          get() {
            throw identityError;
          },
        }),
      ];
    },
  });

  assert.equal(await owner.ready, false);
  const snapshot = owner.getInitialDiagnosticSnapshot();
  assert.equal(snapshot.ownershipOutcome, 'identity-processing-error');
  assert.equal(snapshot.enumeration.outcome, 'completed');
  assert.equal(snapshot.identityError.message, identityError.message);
});

test('Windows diagnostic fallback cannot consume stateful rows before ownership', async () => {
  let pidReads = 0;
  const messages = [];
  const child = {
    pid: 4321,
    send(message) {
      messages.push(message);
    },
  };
  const row = {
    get pid() {
      pidReads += 1;
      if (pidReads === 1) return 4321;
      throw new Error('diagnostic PID read failed');
    },
    parentPid: 1,
    creationDate: 'root-created',
  };
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => [row],
  });

  assert.equal(await releaseWindowsSupervisedChild(child, owner), true);
  assert.deepEqual(messages, ['start']);
  assert.equal(owner.getInitialDiagnosticSnapshot().root.ready, true);
});

test('Windows launch diagnostic distinguishes absent, rejected, and CRLF roots', async () => {
  const cases = [
    {
      stdout: '9000\t1\tother-created\r\n',
      expectedOutcome: 'completed-root-missing',
      expectedCandidates: [],
      expectedReady: false,
    },
    {
      stdout: '4321\tnot-a-parent\troot-created\r\n4321\t1\t\r\n',
      expectedOutcome: 'completed-root-missing',
      expectedCandidates: [
        {
          pid: 4321,
          parentPid: null,
          creationDatePresent: true,
          accepted: false,
          creationIdentity: 'root-created',
        },
        {
          pid: 4321,
          parentPid: 1,
          creationDatePresent: false,
          accepted: false,
          creationIdentity: null,
        },
      ],
      expectedReady: false,
    },
    {
      stdout: '4321\t1\troot-created\r\n',
      expectedOutcome: 'ready',
      expectedCandidates: [
        {
          pid: 4321,
          parentPid: 1,
          creationDatePresent: true,
          accepted: true,
          creationIdentity: 'root-created',
        },
      ],
      expectedReady: true,
    },
  ];

  for (const expected of cases) {
    const child = { pid: 4321, send() {} };
    const owner = createWindowsProcessTreeOwner(child, {
      listProcesses: observeRawSnapshot(expected.stdout),
    });

    assert.equal(await owner.ready, expected.expectedReady);
    const snapshot = owner.getInitialDiagnosticSnapshot();
    assert.equal(snapshot.ownershipOutcome, expected.expectedOutcome);
    assert.equal(snapshot.enumeration.outputState, 'completed');
    assert.deepEqual(
      snapshot.enumeration.rootCandidates,
      expected.expectedCandidates,
    );
    assert.equal(snapshot.root.tracked, expected.expectedReady);
    assert.equal(snapshot.root.ready, expected.expectedReady);
  }
});

test('Windows launch diagnostic preserves ownership and synchronous send failures', async () => {
  const startError = Object.assign(new Error('start send failed'), {
    code: 'ERR_IPC_CHANNEL_CLOSED',
  });
  const ownedChild = {
    pid: 4321,
    send(message) {
      assert.equal(message, 'start');
      throw startError;
    },
  };
  const ownedOwner = createWindowsProcessTreeOwner(ownedChild, {
    listProcesses: async () => [
      { pid: 4321, parentPid: 1, creationDate: 'root-created' },
    ],
  });
  let startRelease;
  assert.equal(
    await releaseWindowsSupervisedChild(ownedChild, ownedOwner, {
      observeRelease: (snapshot) => {
        startRelease = snapshot;
      },
    }),
    false,
  );
  assert.equal(ownedOwner.getInitialDiagnosticSnapshot().root.ready, true);
  assert.equal(startRelease.owned, true);
  assert.equal(startRelease.attemptedMessage, 'start');
  assert.equal(startRelease.sendOutcome, 'threw');
  assert.equal(startRelease.error.code, 'ERR_IPC_CHANNEL_CLOSED');

  const abortError = Object.assign(new Error('abort send failed'), {
    code: 'ERR_IPC_CHANNEL_CLOSED',
  });
  const unownedChild = {
    pid: 4321,
    send(message) {
      assert.equal(message, 'abort');
      throw abortError;
    },
  };
  const unownedOwner = createWindowsProcessTreeOwner(unownedChild, {
    listProcesses: async () => [],
  });
  let abortRelease;
  assert.equal(
    await releaseWindowsSupervisedChild(unownedChild, unownedOwner, {
      observeRelease: (snapshot) => {
        abortRelease = snapshot;
      },
    }),
    false,
  );
  assert.equal(
    unownedOwner.getInitialDiagnosticSnapshot().ownershipOutcome,
    'completed-root-missing',
  );
  assert.equal(abortRelease.owned, false);
  assert.equal(abortRelease.attemptedMessage, 'abort');
  assert.equal(abortRelease.sendOutcome, 'threw');
  assert.equal(abortRelease.error.code, 'ERR_IPC_CHANNEL_CLOSED');
});

test('Windows launch diagnostic keeps the initial snapshot and stays silent on success', async () => {
  let listCalls = 0;
  const messages = [];
  const output = [];
  const child = {
    pid: 4321,
    send(message) {
      messages.push(message);
    },
  };
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      listCalls += 1;
      return listCalls === 1
        ? [{ pid: 4321, parentPid: 1, creationDate: 'initial-created' }]
        : [{ pid: 4321, parentPid: 1, creationDate: 'later-created' }];
    },
  });
  let releaseSnapshot;

  const release = await releaseWindowsSupervisedChild(child, owner, {
    observeRelease: (snapshot) => {
      releaseSnapshot = snapshot;
    },
  });
  const initialSnapshot = owner.getInitialDiagnosticSnapshot();
  await Promise.all([owner.refresh(), owner.refresh(), owner.refresh()]);
  supervisorModule.writeWindowsLaunchFailureEvidence(
    {
      released: release,
      supervisorPid: 2000,
      ownerPid: 3000,
      child,
      owner,
      releaseSnapshot,
    },
    (chunk) => output.push(chunk),
  );

  assert.equal(release, true);
  assert.deepEqual(messages, ['start']);
  assert.equal(listCalls, 2);
  assert.deepEqual(owner.getInitialDiagnosticSnapshot(), initialSnapshot);
  assert.equal(initialSnapshot.root.creationIdentity, 'initial-created');
  assert.equal(Object.hasOwn(initialSnapshot.enumeration, 'phases'), false);
  assert.deepEqual(output, []);
});

test('Windows launch failure line is bounded after JSON escaping and Unicode truncation', async () => {
  const saturated = '\u0000\\"😀'.repeat(4_000);
  const enumerationError = Object.assign(new Error(saturated), {
    name: saturated,
    code: saturated,
    signal: saturated,
    killed: true,
    stderr: saturated,
    stdout: 'phase=ps-ready\r\nphase=cim-first-row\r\nphase=cim-complete\r\n',
  });
  const child = {
    pid: 4321,
    send() {
      const error = Object.assign(new Error(saturated), {
        code: saturated,
        stderr: saturated,
      });
      throw error;
    },
  };
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      throw enumerationError;
    },
  });
  let releaseSnapshot;
  const released = await releaseWindowsSupervisedChild(child, owner, {
    observeRelease: (snapshot) => {
      releaseSnapshot = snapshot;
    },
  });
  const output = [];

  supervisorModule.writeWindowsLaunchFailureEvidence(
    {
      released,
      supervisorPid: 2000,
      ownerPid: 3000,
      child,
      owner,
      releaseSnapshot,
    },
    (chunk) => output.push(chunk),
  );

  assert.equal(output.length, 2);
  assert.equal(
    output[0],
    '[e2e-supervisor] Failed to establish Windows process ownership before launch\n',
  );
  assert.ok(Buffer.byteLength(output[1]) <= 8_192);
  const record = parseFailureLine(output[1]);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.stage, 'initial-launch');
  assert.equal(record.ownership.outcome, 'enumeration-error');
  assert.equal(record.ownership.root.ready, false);
  assert.deepEqual(record.enumeration.phases, {
    psReady: true,
    cimFirstRow: true,
    cimComplete: true,
  });
  assert.equal(record.release.attemptedMessage, 'abort');
  assert.equal(record.release.sendOutcome, 'threw');
  assert.equal(record.release.returned, false);
  assert.equal(record.truncated, true);
  assert.ok(record.fieldTruncationCount > 0);
});

test('Windows launch diagnostic failures cannot change release behavior', async () => {
  const messages = [];
  const child = {
    pid: 4321,
    send(message) {
      messages.push(message);
    },
  };
  const owner = {
    ready: Promise.resolve(false),
    getInitialDiagnosticSnapshot() {
      throw new Error('getter failed');
    },
  };

  assert.equal(
    await releaseWindowsSupervisedChild(child, owner, {
      observeRelease() {
        throw new Error('observer failed');
      },
    }),
    false,
  );
  assert.deepEqual(messages, ['abort']);
  const fallbackOutput = [];
  supervisorModule.writeWindowsLaunchFailureEvidence(
    {
      released: false,
      supervisorPid: 2000,
      ownerPid: 3000,
      child,
      owner,
      releaseSnapshot: null,
    },
    (chunk) => fallbackOutput.push(chunk),
  );
  assert.equal(fallbackOutput.length, 2);
  assert.equal(
    parseFailureLine(fallbackOutput[1]).enumeration.outcome,
    'not-observed',
  );
  const formatterFallback =
    supervisorModule.formatWindowsLaunchFailureDiagnostic({
      ownerSnapshot: {
        enumeration: { rootCandidates: null },
      },
    });
  assert.ok(Buffer.byteLength(formatterFallback) <= 8_192);
  assert.equal(parseFailureLine(formatterFallback).truncated, true);
  assert.doesNotThrow(() =>
    supervisorModule.writeWindowsLaunchFailureEvidence(
      {
        released: false,
        supervisorPid: 2000,
        ownerPid: 3000,
        child,
        owner,
        releaseSnapshot: null,
      },
      () => {
        throw new Error('write failed');
      },
    ),
  );
});

test('Windows launch gate exits after its target reports completion', async () => {
  const supervisorPath = fileURLToPath(
    new URL('./process-tree-supervisor.mjs', import.meta.url),
  );
  const gate = spawn(
    process.execPath,
    [
      supervisorPath,
      '--canopy-windows-supervised-child',
      '-e',
      'process.exit(0)',
    ],
    {
      env: {
        ...process.env,
        CANOPY_E2E_SUPERVISED_EXECUTABLE: process.execPath,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const closed = new Promise((resolve, reject) => {
    gate.once('error', reject);
    gate.once('close', (code, signal) => resolve({ code, signal }));
  });
  gate.on('message', (message) => {
    if (message?.type === 'target-exit') {
      gate.send({ type: 'release-after-cleanup-snapshot', ready: true });
    }
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error('Windows launch gate remained alive')),
      2_000,
    ).unref();
  });

  try {
    gate.send('start');
    assert.deepEqual(await Promise.race([closed, timeout]), {
      code: 0,
      signal: null,
    });
  } finally {
    if (gate.exitCode === null && gate.signalCode === null) {
      gate.kill('SIGKILL');
    }
  }
});

test('Windows ownership refresh reuses one in-flight process snapshot', async () => {
  let activeSnapshots = 0;
  let maximumActiveSnapshots = 0;
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async () => {
      activeSnapshots += 1;
      maximumActiveSnapshots = Math.max(
        maximumActiveSnapshots,
        activeSnapshots,
      );
      await new Promise((resolve) => setImmediate(resolve));
      activeSnapshots -= 1;
      return [{ pid: 4321, parentPid: 1, creationDate: 'root-created' }];
    },
  });

  await owner.ready;
  await Promise.all([owner.refresh(), owner.refresh(), owner.refresh()]);

  assert.equal(maximumActiveSnapshots, 1);
});

test('Windows grace-period liveness checks reuse tracked process identities', async () => {
  let snapshots = 0;
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async () => {
      snapshots += 1;
      return [{ pid: 4321, parentPid: 1, creationDate: 'root-created' }];
    },
    isProcessAlive: () => true,
  });

  await owner.ready;
  await Promise.all([owner.isAlive(), owner.isAlive(), owner.isAlive()]);

  assert.equal(snapshots, 1);
});

test('Windows ownership polling schedules only after the prior refresh completes', async () => {
  let resolveRefresh;
  const refresh = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const scheduled = [];
  const loop = startProcessTreeOwnerRefresh({
    owner: { refresh: () => refresh, isAlive: () => true },
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn: () => undefined,
  });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1_000);
  const firstTick = scheduled.shift().callback();
  assert.equal(scheduled.length, 0);

  resolveRefresh(true);
  await firstTick;
  assert.equal(scheduled.length, 1);
  loop.stop();
});

test('Windows cleanup prioritizes creation-bound lineages before disappearing candidates exhaust full queries', async () => {
  const wrapper = {
    pid: 4321,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const target = {
    pid: 5000,
    parentPid: 4321,
    creationDate: WINDOWS_TEST_CREATION.target,
  };
  const descendants = Array.from({ length: 5 }, (_, index) => ({
    pid: 6000 + index,
    parentPid: 5000,
    creationDate: `2026-09-15T00:00:0${index + 2}.0000000Z`,
  }));
  const alive = new Map([wrapper, target].map((row) => [row.pid, row]));
  const signals = [],
    filters = [];
  let checkpoint = false,
    fullCandidates = 0;
  const child = mockChild(wrapper.pid);
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ filterPid }) => {
      filters.push(filterPid);
      if (checkpoint && filterPid === undefined) {
        if (fullCandidates === 5)
          throw new Error('full enumeration unavailable');
        alive.delete(descendants[fullCandidates++].pid);
      }
      if (filterPid !== undefined) {
        for (const row of descendants) alive.delete(row.pid);
        return alive.has(filterPid) ? [alive.get(filterPid)] : [];
      }
      return [...alive.values()];
    },
    onCleanupSnapshot: (ready) => {
      assert.equal(ready, true);
      checkpoint = true;
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      if (pid === child.pid) exitMockChild(child);
    },
    graceMs: 0,
  });
  await owner.ready;
  owner.trackOwnedPid(target.pid);
  for (const row of descendants) alive.set(row.pid, row);
  await owner.refresh();
  let failure;
  try {
    await owner.stop();
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(
    signals,
    [
      [target.pid, 'SIGTERM'],
      [wrapper.pid, 'SIGTERM'],
    ],
    `stable owned roots must receive cleanup attempts; ${failure?.message ?? 'cleanup completed'}`,
  );
  assert.equal(failure, undefined);
  assert.equal(alive.size, 0);
  assert.deepEqual(filters.slice(3, 5), [target.pid, wrapper.pid]);
  assert.equal(
    filters.at(-1),
    undefined,
    'final proof requires a full enumeration',
  );
});

for (const invalid of [
  'missing',
  'reused',
  'duplicate',
  'malformed',
  'extra',
  'unavailable',
])
  test(`Windows cleanup isolates ${invalid} candidate validation from owned siblings and reparented descendants`, async () => {
    const wrapper = {
      pid: 4321,
      parentPid: 1,
      creationDate: WINDOWS_TEST_CREATION.wrapper,
    };
    const target = {
      pid: 5000,
      parentPid: 4321,
      creationDate: WINDOWS_TEST_CREATION.target,
    };
    const helper = {
      pid: 6000,
      parentPid: 5000,
      creationDate: WINDOWS_TEST_CREATION.helper,
    };
    const foreign = {
      pid: 9999,
      parentPid: 1,
      creationDate: WINDOWS_TEST_CREATION.foreign,
    };
    const alive = new Map(
      [wrapper, target, helper, foreign].map((row) => [row.pid, row]),
    );
    const signals = [],
      filters = [],
      refreshes = [],
      checkpoints = [];
    const f = ownershipFixture();
    let pending = 0,
      maxPending = 0;
    const child = mockChild(wrapper.pid);
    const owner = createWindowsProcessTreeOwner(child, {
      listProcesses: async ({ rootPid, filterPid }) => {
        filters.push(filterPid);
        maxPending = Math.max(maxPending, ++pending);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if (filterPid === target.pid) {
            assert.equal(rootPid, target.pid);
            if (invalid === 'unavailable')
              throw new Error('candidate unavailable');
            return {
              missing: [],
              reused: [
                {
                  ...target,
                  creationDate: WINDOWS_TEST_CREATION.reusedTarget,
                },
              ],
              duplicate: [target, target],
              malformed: [{ ...target, creationDate: '' }],
              extra: [target, foreign],
            }[invalid];
          }
          return filterWindowsSnapshot([...alive.values()], filterPid);
        } finally {
          pending--;
        }
      },
      observeOperation: f.observe,
      observeRefresh: (snapshot) => {
        refreshes.push(snapshot);
        f.observe('ownership-refresh', snapshot);
      },
      onCleanupSnapshot: (ready) => checkpoints.push(ready),
      isProcessAlive: (pid) => alive.has(pid),
      killProcessTree: async (pid, signal) => {
        assert.equal(pending, 0, 'signals wait for candidate query settlement');
        signals.push([pid, signal]);
        alive.delete(pid);
        if (pid === child.pid) exitMockChild(child);
        if (pid === wrapper.pid) {
          alive.delete(target.pid);
          alive.set(helper.pid, { ...helper, parentPid: 1 });
        }
      },
      graceMs: 0,
    });
    await owner.ready;
    owner.trackOwnedPid(target.pid);
    await owner.refresh();
    f.observe('supervisor-cleanup', { outcome: 'entered' });
    const stopping = owner.stop();
    assert.equal(owner.stop(), stopping);
    await stopping;
    f.observe('supervisor-cleanup', { outcome: 'fulfilled' });
    f.observe('supervisor-exit', { code: 0 });
    assert.deepEqual(signals, [
      [wrapper.pid, 'SIGTERM'],
      [helper.pid, 'SIGTERM'],
    ]);
    assert.deepEqual(
      [...alive.keys()],
      [foreign.pid],
      'unrelated sibling is never signaled or discovered',
    );
    assert.deepEqual(checkpoints, [true]);
    assert.deepEqual(filters, [
      undefined,
      undefined,
      undefined,
      target.pid,
      wrapper.pid,
      helper.pid,
      undefined,
    ]);
    assert.equal(
      refreshes.length,
      4,
      'filtered queries do not project a partial tree as a full refresh',
    );
    assert.equal(
      maxPending,
      1,
      'candidate queries remain sequential and bounded',
    );
    const summary = f.rows().at(-1);
    assert.equal(summary.finalResult, 'verified-empty');
    if (['unavailable', 'malformed', 'duplicate', 'extra'].includes(invalid)) {
      assert.equal(summary.observationGap, true);
      assert.equal(summary.completeObservation, false);
    }
  });

test('Windows cleanup preserves an absent admitted target lineage for later descendant discovery', async () => {
  const root = {
    pid: 4321,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const target = {
    pid: 5000,
    parentPid: 4321,
    creationDate: WINDOWS_TEST_CREATION.target,
  };
  const helper = {
    pid: 6000,
    parentPid: 5000,
    creationDate: WINDOWS_TEST_CREATION.helper,
  };
  const alive = new Map([root, target].map((row) => [row.pid, row]));
  const signals = [];
  const child = mockChild();
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ filterPid }) => {
      if (filterPid === target.pid) {
        alive.delete(target.pid);
        alive.set(helper.pid, helper);
        return [];
      }
      return filterWindowsSnapshot([...alive.values()], filterPid);
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') {
        alive.delete(pid);
        if (pid === child.pid) exitMockChild(child);
      }
    },
    graceMs: 0,
  });
  await owner.ready;
  owner.trackOwnedPid(target.pid);
  await owner.refresh();
  await owner.stop();
  assert.deepEqual(signals, [
    [root.pid, 'SIGTERM'],
    [root.pid, 'SIGKILL'],
    [helper.pid, 'SIGKILL'],
  ]);
  assert.equal(
    alive.size,
    0,
    'target absence must not discard its admitted descendant lineage',
  );
});

test('Windows cleanup skips candidates retired by a completed refresh before their query', async () => {
  const root = {
    pid: 4321,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const target = {
    pid: 5000,
    parentPid: 4321,
    creationDate: WINDOWS_TEST_CREATION.target,
  };
  const helper = {
    pid: 6000,
    parentPid: 5000,
    creationDate: WINDOWS_TEST_CREATION.helper,
  };
  const alive = new Map([root, target, helper].map((row) => [row.pid, row]));
  const filters = [],
    signals = [];
  const child = mockChild();
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ filterPid }) => {
      filters.push(filterPid);
      return filterWindowsSnapshot([...alive.values()], filterPid);
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      if (pid === child.pid) exitMockChild(child);
      if (pid === target.pid) {
        alive.delete(helper.pid);
        await owner.refresh();
      }
    },
    graceMs: 0,
  });
  await owner.ready;
  owner.trackOwnedPid(target.pid);
  await owner.refresh();
  await owner.stop();
  assert.deepEqual(signals, [
    [target.pid, 'SIGTERM'],
    [root.pid, 'SIGTERM'],
  ]);
  assert.equal(
    filters.includes(helper.pid),
    false,
    'retired candidate spends no query',
  );
});

for (const raw of [
  '',
  '5000\t4321\tforeign-reused-target\n',
  '5000\t4321\t\n',
  '5000\t4321\ttarget\n5000\t4321\ttarget\n',
  '5000\t4321\ttarget\n5000\t4321\t\n',
  '5000\t4321\ttarget\n9999\t1\tforeign\n',
  '5000\t4321\ttarget\nmalformed-row\n',
  '5000\t4321\ttarget\textra-column\n',
  '5000\t4321\ttarget\t\n',
  '5000\t4321\ttarget\t \r\n',
])
  test(`Windows cleanup rejects ambiguous raw candidate response ${JSON.stringify(raw)}`, async () => {
    const alive = new Map([
      [4321, '4321\t1\twrapper\r\n'],
      [5000, '5000\t4321\ttarget\n'],
    ]);
    const signals = [],
      queries = [],
      timeouts = [];
    const implementation = await supervisorWithQueryIo({
      now: () => performance.now(),
      execFileAsync: async (file, args, options) => {
        assert.equal(file, 'powershell.exe');
        timeouts.push(options.timeout);
        const filter = args.at(-1).match(/-Filter "ProcessId=(\d+)"/);
        const pid = filter ? Number(filter[1]) : undefined;
        queries.push(pid);
        return {
          stdout: rawWindowsProcessOutput(
            (pid === 5000
              ? raw
              : pid
                ? (alive.get(pid) ?? '')
                : [...alive.values()].join('')
            )
              .split(/\r?\n/)
              .filter(Boolean),
          ),
        };
      },
    });
    const child = mockChild();
    const owner = implementation.createWindowsProcessTreeOwner(child, {
      isProcessAlive: (pid) => alive.has(pid),
      killProcessTree: async (pid, signal) => {
        signals.push([pid, signal]);
        alive.clear();
        exitMockChild(child);
      },
      graceMs: 0,
    });
    await owner.ready;
    owner.trackOwnedPid(5000);
    await owner.refresh();
    await owner.stop();
    assert.deepEqual(signals, [[4321, 'SIGTERM']]);
    assert.deepEqual(queries, [
      undefined,
      undefined,
      undefined,
      5000,
      4321,
      undefined,
    ]);
    assert.deepEqual(timeouts, [5_000, 5_000, 15_000, 15_000, 15_000, 15_000]);
  });

test('raw Windows enumeration cannot drop a child with unknown creation identity from cleanup proof', async () => {
  const wrapper = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
  const unknownChild = '4322\t4321\t';
  const alive = new Set([4321, 4322]);
  const signals = [];
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async (_file, args) => {
      const filter = args.at(-1).match(/-Filter "ProcessId=(\d+)"/);
      const pid = filter ? Number(filter[1]) : undefined;
      const rows = pid
        ? pid === 4321 && alive.has(pid)
          ? [wrapper]
          : []
        : [
            ...(alive.has(4321) ? [wrapper] : []),
            ...(alive.has(4322) ? [unknownChild] : []),
          ];
      return {
        stdout: rawWindowsProcessOutput(rows, {
          includeNoise: pid === undefined,
        }),
      };
    },
  });
  const owner = implementation.createWindowsProcessTreeOwner(mockChild(), {
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  await assert.rejects(
    owner.stop(),
    /Windows process cleanup verification unavailable/,
  );
  assert.equal(
    signals.some(([pid]) => pid === 4322),
    false,
    'an unknown child identity cannot authorize a signal',
  );
  assert.equal(alive.has(4322), true);
});

test('raw Windows enumeration cannot treat a present unknown owned anchor as vanished', async () => {
  const wrapper = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
  const target = `5000\t4321\t${WINDOWS_TEST_CREATION.target}`;
  const unknownTarget = '5000\t4321\t';
  const helper = `6000\t5000\t${WINDOWS_TEST_CREATION.helper}`;
  const alive = new Set([4321, 5000]);
  const signals = [];
  let unreadable = false;
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async (_file, args) => {
      const filter = args.at(-1).match(/-Filter "ProcessId=(\d+)"/);
      const pid = filter ? Number(filter[1]) : undefined;
      let rows;
      if (pid !== undefined) {
        rows =
          pid === 4321 && alive.has(pid)
            ? [wrapper]
            : pid === 6000 && alive.has(pid)
              ? [helper]
              : [];
      } else if (unreadable) {
        rows = [
          ...(alive.has(4321) ? [wrapper] : []),
          ...(alive.has(5000) ? [unknownTarget] : []),
          ...(alive.has(6000) ? [helper] : []),
        ];
      } else {
        rows = [wrapper, target];
      }
      return {
        stdout: rawWindowsProcessOutput(rows, {
          includeNoise: pid === undefined,
        }),
      };
    },
  });
  const owner = implementation.createWindowsProcessTreeOwner(mockChild(), {
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  owner.trackOwnedPid(5000);
  assert.equal(await owner.refresh(), true);
  unreadable = true;
  alive.add(6000);

  await assert.rejects(
    owner.stop(),
    /Windows process cleanup verification unavailable/,
  );
  assert.equal(
    signals.some(([pid]) => pid === 6000),
    false,
    'a helper cannot be inferred through a known-present unknown anchor',
  );
  assert.equal(alive.has(6000), true);
});

test('raw Windows enumeration preserves true absent-anchor discovery with unrelated malformed noise', async () => {
  const wrapper = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
  const target = `5000\t4321\t${WINDOWS_TEST_CREATION.target}`;
  const helper = `6000\t5000\t${WINDOWS_TEST_CREATION.helper}`;
  const alive = new Set([4321, 5000]);
  const signals = [];
  let targetCaptured = false;
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async (_file, args) => {
      const filter = args.at(-1).match(/-Filter "ProcessId=(\d+)"/);
      const pid = filter ? Number(filter[1]) : undefined;
      const rows = pid
        ? [
            ...(pid === 4321 && alive.has(pid) ? [wrapper] : []),
            ...(pid === 6000 && alive.has(pid) ? [helper] : []),
          ]
        : [
            ...(alive.has(4321) ? [wrapper] : []),
            ...(!targetCaptured && alive.has(5000) ? [target] : []),
            ...(alive.has(6000) ? [helper] : []),
          ];
      return {
        stdout: rawWindowsProcessOutput(rows, {
          includeNoise: pid === undefined,
        }),
      };
    },
  });
  const child = mockChild();
  const owner = implementation.createWindowsProcessTreeOwner(child, {
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      if (pid === child.pid) exitMockChild(child);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  owner.trackOwnedPid(5000);
  assert.equal(await owner.refresh(), true);
  targetCaptured = true;
  alive.delete(5000);
  alive.add(6000);
  await owner.stop();

  assert.deepEqual(signals, [
    [4321, 'SIGTERM'],
    [6000, 'SIGTERM'],
  ]);
  assert.equal(alive.size, 0);
});

test('raw Windows enumeration rejects a malformed intermediate reached through a new parent', async () => {
  const wrapper = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
  const parent = `5000\t4321\t${WINDOWS_TEST_CREATION.target}`;
  const rejectedIntermediate = `6000\t5000\t${WINDOWS_TEST_CREATION.helper}\textra`;
  const descendant = `7000\t6000\t${WINDOWS_TEST_CREATION.laterHelper}`;
  const alive = new Set([4321]);
  const signals = [];
  let expanded = false;
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async (_file, args) => {
      const filter = args.at(-1).match(/-Filter "ProcessId=(\d+)"/);
      const pid = filter ? Number(filter[1]) : undefined;
      const rows = pid
        ? [
            ...(pid === 4321 && alive.has(pid) ? [wrapper] : []),
            ...(pid === 5000 && alive.has(pid) ? [parent] : []),
            ...(pid === 7000 && alive.has(pid) ? [descendant] : []),
          ]
        : [
            ...(alive.has(4321) ? [wrapper] : []),
            ...(expanded && alive.has(5000) ? [parent] : []),
            ...(expanded && alive.has(6000) ? [rejectedIntermediate] : []),
            ...(expanded && alive.has(7000) ? [descendant] : []),
          ];
      return {
        stdout: rawWindowsProcessOutput(rows, {
          includeNoise: pid === undefined,
        }),
      };
    },
  });
  const owner = implementation.createWindowsProcessTreeOwner(mockChild(), {
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  expanded = true;
  alive.add(5000);
  alive.add(6000);
  alive.add(7000);

  await assert.rejects(
    owner.stop(),
    /Windows process cleanup verification unavailable/,
  );
  assert.equal(
    signals.some(([pid]) => pid === 7000),
    false,
    'a rejected intermediate cannot authorize its accepted descendant',
  );
});

test('raw Windows enumeration rejects an accepted and rejected duplicate at a newly reached PID', async () => {
  const wrapper = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
  const parent = `5000\t4321\t${WINDOWS_TEST_CREATION.target}`;
  const intermediate = `6000\t5000\t${WINDOWS_TEST_CREATION.helper}`;
  const rejectedDuplicate = `${intermediate}\textra`;
  const descendant = `7000\t6000\t${WINDOWS_TEST_CREATION.laterHelper}`;
  const alive = new Set([4321]);
  const signals = [];
  let expanded = false;
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async (_file, args) => {
      const filter = args.at(-1).match(/-Filter "ProcessId=(\d+)"/);
      const pid = filter ? Number(filter[1]) : undefined;
      const rows = pid
        ? [
            ...(pid === 4321 && alive.has(pid) ? [wrapper] : []),
            ...(pid === 5000 && alive.has(pid) ? [parent] : []),
            ...(pid === 6000 && alive.has(pid) ? [intermediate] : []),
            ...(pid === 7000 && alive.has(pid) ? [descendant] : []),
          ]
        : [
            ...(alive.has(4321) ? [wrapper] : []),
            ...(expanded && alive.has(5000) ? [parent] : []),
            ...(expanded && alive.has(6000)
              ? [intermediate, rejectedDuplicate]
              : []),
            ...(expanded && alive.has(7000) ? [descendant] : []),
          ];
      return {
        stdout: rawWindowsProcessOutput(rows, {
          includeNoise: pid === undefined,
        }),
      };
    },
  });
  const owner = implementation.createWindowsProcessTreeOwner(mockChild(), {
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  expanded = true;
  alive.add(5000);
  alive.add(6000);
  alive.add(7000);

  await assert.rejects(
    owner.stop(),
    /Windows process cleanup verification unavailable/,
  );
  assert.equal(
    signals.some(([pid]) => pid === 6000 || pid === 7000),
    false,
    'an accepted row cannot conceal a rejected duplicate at the same PID',
  );
});

test('raw Windows enumeration collects a valid newly discovered multilevel subtree', async () => {
  const wrapper = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
  const parent = `5000\t4321\t${WINDOWS_TEST_CREATION.target}`;
  const intermediate = `6000\t5000\t${WINDOWS_TEST_CREATION.helper}`;
  const descendant = `7000\t6000\t${WINDOWS_TEST_CREATION.laterHelper}`;
  const alive = new Set([4321]);
  const signals = [];
  let expanded = false;
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async (_file, args) => {
      const filter = args.at(-1).match(/-Filter "ProcessId=(\d+)"/);
      const pid = filter ? Number(filter[1]) : undefined;
      const rows = [
        ...(alive.has(4321) ? [wrapper] : []),
        ...(expanded && alive.has(5000) ? [parent] : []),
        ...(expanded && alive.has(6000) ? [intermediate] : []),
        ...(expanded && alive.has(7000) ? [descendant] : []),
      ].filter((row) => pid === undefined || row.startsWith(`${pid}\t`));
      return {
        stdout: rawWindowsProcessOutput(rows, {
          includeNoise: pid === undefined,
        }),
      };
    },
  });
  const child = mockChild();
  const owner = implementation.createWindowsProcessTreeOwner(child, {
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      if (pid === child.pid) exitMockChild(child);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  expanded = true;
  alive.add(5000);
  alive.add(6000);
  alive.add(7000);
  await owner.stop();

  assert.deepEqual(
    signals.map(([pid]) => pid).sort((left, right) => left - right),
    [4321, 5000, 6000, 7000],
  );
  assert.equal(alive.size, 0);
});

test('Windows owner rejects a same-identity survivor after forced cleanup', async () => {
  const signals = [];
  let snapshots = 0;
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async ({ filterPid }) => {
      snapshots++;
      return filterWindowsSnapshot(
        [
          { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
          { pid: 9999, parentPid: 1, creationDate: 'unrelated-created' },
        ],
        filterPid,
      );
    },
    isProcessAlive: () => true,
    killProcessTree: async (pid, signal) => signals.push([pid, signal]),
    graceMs: 0,
    delay: async () => undefined,
  });

  const stopping = owner.stop();
  assert.equal(owner.stop(), stopping);
  await assert.rejects(stopping, /Windows process cleanup.*4321/);
  assert.deepEqual(signals, [
    [4321, 'SIGTERM'],
    [4321, 'SIGKILL'],
  ]);
  assert.equal(snapshots, 6, 'one fresh final snapshot after both signals');
});

test('Windows owner rejects unavailable final verification without repeating cleanup', async () => {
  let snapshots = 0;
  let alive = true;
  const signals = [];
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async () => {
      snapshots++;
      if (snapshots === 4) throw new Error('snapshot unavailable');
      return [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }];
    },
    isProcessAlive: () => alive,
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    },
  });
  const stopping = owner.stop();
  await assert.rejects(
    stopping,
    /Windows process cleanup verification unavailable/,
  );
  assert.equal(owner.stop(), stopping);
  assert.equal(snapshots, 4);
  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
});

test('Windows owner preserves the original signal error without final verification', async () => {
  let snapshots = 0;
  const failure = new Error('original stop failure');
  const operations = [];
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async () => {
      snapshots++;
      return [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }];
    },
    isProcessAlive: () => true,
    killProcessTree: async () => {
      throw failure;
    },
    observeOperation: (stage, details) => {
      operations.push({ stage, ...details });
      throw new Error('observer failure');
    },
  });
  const stopping = owner.stop();
  await assert.rejects(stopping, (error) => error === failure);
  assert.equal(owner.stop(), stopping);
  assert.equal(snapshots, 3);
  assert.deepEqual(
    operations
      .filter(({ stage }) => stage === 'signal')
      .map(({ outcome, error }) => [outcome, error?.message]),
    [
      ['entered', undefined],
      ['rejected', 'original stop failure'],
    ],
  );
  assert.equal(
    operations.some(({ stage }) => stage === 'final-verification'),
    false,
  );
});

test('Windows final verification drains an older refresh and retires a reused PID', async () => {
  let snapshots = 0;
  let alive = true;
  let finishOlderRefresh;
  const signals = [];
  const root = { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' };
  const child = mockChild();
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      snapshots++;
      if (snapshots === 4)
        return new Promise((resolve) => {
          finishOlderRefresh = resolve;
        });
      if (snapshots === 5) {
        alive = true;
        return [{ ...root, creationDate: 'foreign-reused-pid' }];
      }
      return [root];
    },
    isProcessAlive: () => alive,
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      void owner.refresh();
      alive = false;
      exitMockChild(child);
    },
  });
  const stopping = owner.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshots, 4);
  finishOlderRefresh([root]);
  await stopping;
  assert.equal(snapshots, 5);
  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
});

test('ownership polling reports refresh failures instead of silently retrying', async () => {
  const scheduled = [];
  const errors = [];
  const failure = new Error('sidecar rewrite failed');
  const loop = startProcessTreeOwnerRefresh({
    owner: {
      refresh: async () => {
        throw failure;
      },
      isAlive: () => true,
    },
    onError: async (error) => errors.push(error),
    setTimeoutFn: (callback) => {
      scheduled.push(callback);
      return { unref() {} };
    },
    clearTimeoutFn: () => undefined,
  });

  await scheduled.shift()();

  assert.deepEqual(errors, [failure]);
  assert.deepEqual(scheduled, []);
  loop.stop();
});

test('POSIX owner surfaces a sidecar rewrite failure', async () => {
  let snapshots = 0;
  let writes = 0;
  let alive = true;
  const signals = [];
  const owner = createPosixProcessTreeOwner(mockChild(), {
    trackedGroupsFile: '/injected/groups.ndjson',
    runNonce: 'current-run',
    listProcesses: async () => {
      snapshots += 1;
      return snapshots === 1 ? initialPosixTree.slice(0, 2) : initialPosixTree;
    },
    writeFileAtomically: () => {
      writes += 1;
      if (writes > 1) throw new Error('disk full');
    },
    processGroupExists: () => alive,
    killProcessTree: async (pgid, signal) => {
      signals.push([pgid, signal]);
      alive = false;
    },
  });

  assert.equal(await owner.ready, true);
  await owner.initializeSidecar();
  await assert.rejects(
    owner.refresh(),
    /failed to rewrite supervised groups sidecar/,
  );
  await owner.stop();
  assert.deepEqual(signals, [
    [5000, 'SIGTERM'],
    [4321, 'SIGTERM'],
  ]);
});

test('Windows owner terminates a surviving helper after the root exits', async () => {
  const alive = new Set([4322]);
  const signals = [];
  let listCalls = 0;
  const child = mockChild();
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ filterPid }) => {
      listCalls += 1;
      if (listCalls === 2) exitMockChild(child);
      return filterWindowsSnapshot(
        listCalls === 1
          ? [
              {
                pid: 4321,
                parentPid: 1,
                creationDate: WINDOWS_TEST_CREATION.wrapper,
              },
              {
                pid: 4322,
                parentPid: 4321,
                creationDate: WINDOWS_TEST_CREATION.helper,
              },
            ]
          : [
              {
                pid: 4322,
                parentPid: 1,
                creationDate: WINDOWS_TEST_CREATION.helper,
              },
              {
                pid: 4323,
                parentPid: 9999,
                creationDate: WINDOWS_TEST_CREATION.foreign,
              },
            ],
        filterPid,
      );
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    delay: async () => undefined,
  });

  await owner.stop();

  assert.deepEqual(signals, [[4322, 'SIGTERM']]);
});

test('Windows owner rejects the observed stale-parent chain while preserving a later descendant', async () => {
  const wrapper = {
    pid: 9200,
    parentPid: 1,
    creationDate: '2026-09-15T21:35:25.7621080Z',
  };
  const target = {
    pid: 6444,
    parentPid: wrapper.pid,
    creationDate: '2026-09-15T21:35:28.3971620Z',
  };
  const staleParent = {
    pid: 7300,
    parentPid: target.pid,
    creationDate: '2026-09-15T21:26:12.8317110Z',
  };
  const staleDescendant = {
    pid: 7344,
    parentPid: staleParent.pid,
    creationDate: '2026-09-15T21:26:12.8441860Z',
  };
  const laterDescendant = {
    pid: 7500,
    parentPid: target.pid,
    creationDate: '2026-09-15T21:35:28.3971621Z',
  };
  const alive = new Map(
    [wrapper, target, staleParent, staleDescendant, laterDescendant].map(
      (row) => [row.pid, row],
    ),
  );
  const signals = [];
  const child = mockChild(wrapper.pid);
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ filterPid }) =>
      filterWindowsSnapshot([...alive.values()], filterPid),
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      if (pid === child.pid) exitMockChild(child);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  await owner.stop();

  assert.deepEqual(
    signals.map(([pid]) => pid).sort((left, right) => left - right),
    [target.pid, laterDescendant.pid, wrapper.pid],
  );
  assert.deepEqual(
    [...alive.keys()].sort((left, right) => left - right),
    [staleParent.pid, staleDescendant.pid],
  );
});

test('Windows owner validates every lineage edge with full creation precision', async () => {
  const wrapper = {
    pid: 9200,
    parentPid: 1,
    creationDate: '2026-09-15T21:35:28.3971600Z',
  };
  const parent = {
    pid: 7300,
    parentPid: wrapper.pid,
    creationDate: '2026-09-15T21:35:28.3971620Z',
  };
  const impossibleChild = {
    pid: 7344,
    parentPid: parent.pid,
    creationDate: '2026-09-15T21:35:28.3971619Z',
  };
  const laterChild = {
    pid: 7500,
    parentPid: parent.pid,
    creationDate: '2026-09-15T21:35:28.3971621Z',
  };
  const alive = new Map(
    [wrapper, parent, impossibleChild, laterChild].map((row) => [row.pid, row]),
  );
  const signals = [];
  const child = mockChild(wrapper.pid);
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ filterPid }) =>
      filterWindowsSnapshot([...alive.values()], filterPid),
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      if (pid === child.pid) exitMockChild(child);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  await owner.stop();

  assert.deepEqual(
    signals.map(([pid]) => pid).sort((left, right) => left - right),
    [parent.pid, laterChild.pid, wrapper.pid],
  );
  assert.deepEqual([...alive.keys()], [impossibleChild.pid]);
});

test('Windows owner finds a helper after its short-lived target has exited', async () => {
  const wrapper = {
    pid: 4321,
    parentPid: 1,
    creationDate: '2026-09-15T21:35:25.7621080Z',
  };
  const target = {
    pid: 5000,
    parentPid: wrapper.pid,
    creationDate: '2026-09-15T21:35:28.3971620Z',
  };
  const helper = {
    pid: 5001,
    parentPid: target.pid,
    creationDate: '2026-09-15T21:35:29.0000000Z',
  };
  const alive = new Map([[wrapper.pid, wrapper]]);
  const signals = [];
  const child = mockChild(wrapper.pid);
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async ({ filterPid }) =>
      filterWindowsSnapshot([...alive.values()], filterPid),
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      if (pid === child.pid) exitMockChild(child);
    },
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  owner.trackOwnedPid(target.pid);
  alive.set(target.pid, target);
  assert.equal(await owner.refresh(), true);
  alive.delete(target.pid);
  alive.set(helper.pid, helper);
  await owner.stop();

  assert.deepEqual(signals, [
    [wrapper.pid, 'SIGTERM'],
    [helper.pid, 'SIGTERM'],
  ]);
});

test('Windows owner leaves cleanup unverified when a vanished lineage anchor has no creation identity', async () => {
  const wrapper = {
    pid: 4321,
    parentPid: 1,
    creationDate: '2026-09-15T21:35:25.7621080Z',
  };
  const helper = {
    pid: 5001,
    parentPid: 5000,
    creationDate: '2026-09-15T21:35:29.0000000Z',
  };
  const alive = new Map([[wrapper.pid, wrapper]]);
  const signals = [];
  const owner = createWindowsProcessTreeOwner(mockChild(wrapper.pid), {
    listProcesses: async ({ filterPid }) =>
      filterWindowsSnapshot([...alive.values()], filterPid),
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    graceMs: 0,
    delay: async () => undefined,
  });

  assert.equal(await owner.ready, true);
  owner.trackOwnedPid(5000);
  alive.set(helper.pid, helper);

  await assert.rejects(
    owner.stop(),
    /Windows process cleanup verification unavailable/,
  );
  assert.equal(
    signals.some(([pid]) => pid === helper.pid),
    false,
    'an unknown vanished-parent identity cannot authorize a child signal',
  );
});

for (const { label, wrapperCreationDate, helperCreationDate } of [
  {
    label: 'missing child identity',
    wrapperCreationDate: '2026-09-15T21:35:25.7621080Z',
    helperCreationDate: '',
  },
  {
    label: 'noncanonical child identity',
    wrapperCreationDate: '2026-09-15T21:35:25.7621080Z',
    helperCreationDate: '2026-09-15T21:35:28.397Z',
  },
  {
    label: 'malformed parent identity',
    wrapperCreationDate: 'not-a-creation-time',
    helperCreationDate: '2026-09-15T21:35:28.3971620Z',
  },
])
  test(`Windows owner leaves cleanup unverified for ${label} on a potential lineage edge`, async () => {
    const wrapper = {
      pid: 4321,
      parentPid: 1,
      creationDate: wrapperCreationDate,
    };
    const helper = {
      pid: 4322,
      parentPid: wrapper.pid,
      creationDate: helperCreationDate,
    };
    const alive = new Map([wrapper, helper].map((row) => [row.pid, row]));
    const signals = [];
    const owner = createWindowsProcessTreeOwner(mockChild(wrapper.pid), {
      listProcesses: async ({ filterPid }) =>
        filterWindowsSnapshot([...alive.values()], filterPid),
      isProcessAlive: (pid) => alive.has(pid),
      killProcessTree: async (pid, signal) => {
        signals.push([pid, signal]);
        alive.delete(pid);
      },
      graceMs: 0,
      delay: async () => undefined,
    });

    await assert.rejects(
      owner.stop(),
      /Windows process cleanup verification unavailable/,
    );
    assert.equal(
      signals.some(([pid]) => pid === helper.pid),
      false,
      'uncomparable creation evidence cannot authorize a child signal',
    );
  });

test('Windows owner rejects a reused target PID and its unrelated descendants', async () => {
  const alive = new Set([4321, 5000, 5002]);
  const signals = [];
  let listCalls = 0;
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async ({ filterPid }) => {
      listCalls += 1;
      if (listCalls === 1) {
        return filterWindowsSnapshot(
          [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }],
          filterPid,
        );
      }
      if (listCalls === 2) {
        return filterWindowsSnapshot(
          [
            { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
            { pid: 5000, parentPid: 4321, creationDate: 'target-created' },
          ],
          filterPid,
        );
      }
      return filterWindowsSnapshot(
        [
          { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
          { pid: 5000, parentPid: 9999, creationDate: 'reused-created' },
          { pid: 5002, parentPid: 5000, creationDate: 'unrelated-created' },
        ],
        filterPid,
      );
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    delay: async () => undefined,
  });

  await owner.ready;
  owner.trackOwnedPid(5000);
  await owner.refresh();
  await owner.stop();

  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
});

test('Windows owner does not terminate an unrelated process that reuses a descendant PID', async () => {
  const alive = new Set([4321, 4322]);
  const signals = [];
  let listCalls = 0;
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async ({ filterPid }) => {
      listCalls += 1;
      return filterWindowsSnapshot(
        listCalls === 1
          ? [
              {
                pid: 4321,
                parentPid: 1,
                creationDate: WINDOWS_TEST_CREATION.wrapper,
              },
              {
                pid: 4322,
                parentPid: 4321,
                creationDate: WINDOWS_TEST_CREATION.helper,
              },
            ]
          : [
              {
                pid: 4321,
                parentPid: 1,
                creationDate: WINDOWS_TEST_CREATION.wrapper,
              },
              {
                pid: 4322,
                parentPid: 9999,
                creationDate: WINDOWS_TEST_CREATION.reusedHelper,
              },
            ],
        filterPid,
      );
    },
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    delay: async () => undefined,
  });

  await owner.stop();

  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
});

test('supervisor cleans up on child exit and waits for stdio close before completing', () => {
  const child = mockChild();
  const cleanups = [];
  const completions = [];
  attachChildLifecycle(child, {
    onExit: (code, signal) => cleanups.push([code, signal]),
    onClose: (code, signal) => completions.push([code, signal]),
  });

  child.emit('exit', 7, null);
  assert.deepEqual(cleanups, [[7, null]]);
  assert.deepEqual(completions, []);

  child.emit('close', 7, null);
  assert.deepEqual(completions, [[7, null]]);
});

function createInheritedStdioDiagnosticSetup({
  platform = process.platform,
  directory = process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim(),
  fixturePid = process.pid,
  uuid = randomUUID,
  makeDirectory = mkdirSync,
  createRecorder = createBoundaryRecorder,
} = {}) {
  if (platform !== 'win32' || !directory) return {};
  try {
    const caseId = 'inherited-stdio';
    const launchId = `${caseId}-${fixturePid}-${uuid()}`;
    makeDirectory(directory, { recursive: true });
    const config = {
      mode: 'close',
      file: path.resolve(directory, `${launchId}-main.jsonl`),
      caseId,
      launchId,
      fixturePid,
    };
    return {
      config,
      env: {
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify(config),
        CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE: '1',
      },
      stderr: 'pipe',
      record: createRecorder(
        config.file.replace('-main.jsonl', '-inherited-stdio-fixture.jsonl'),
      ),
    };
  } catch {
    return {};
  }
}

function observeInheritedStdioFixtureChild(record, child) {
  record?.('inherited-stdio-supervisor-returned', { childPid: child.pid });
  child.once('spawn', () =>
    record?.('inherited-stdio-supervisor-spawned', { childPid: child.pid }),
  );
  child.once('error', (error) =>
    record?.('inherited-stdio-supervisor-error', {
      message: String(error?.message ?? error).slice(0, 512),
    }),
  );
  child.once('exit', (code, signal) =>
    record?.('inherited-stdio-supervisor-exit', { code, signal }),
  );
  child.once('close', (code, signal) =>
    record?.('inherited-stdio-supervisor-close', { code, signal }),
  );
}

function captureInheritedStdioStderr(record, state, chunk) {
  const available = Math.max(0, 8192 - state.bytes);
  const captured = chunk.subarray(0, available);
  state.bytes += captured.length;
  if (captured.length)
    record?.('inherited-stdio-stderr', {
      bytes: captured.length,
      text: captured.toString('utf8'),
    });
  if (chunk.length > available && !state.truncated) {
    state.truncated = true;
    record?.('inherited-stdio-stderr-truncated', {
      retainedBytes: state.bytes,
    });
  }
}

test('inherited-stdio diagnostic setup is Windows-only, bounded, and optional', () => {
  const rows = [];
  const selected = createInheritedStdioDiagnosticSetup({
    platform: 'win32',
    directory: '/diagnostics',
    fixturePid: 4000,
    uuid: () => 'fixture',
    makeDirectory: () => {},
    createRecorder: () => (stage, details) => rows.push({ stage, details }),
  });
  assert.equal(selected.config.mode, 'close');
  assert.equal(selected.config.fixturePid, 4000);
  assert.equal(selected.stderr, 'pipe');
  assert.equal(selected.env.CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE, '1');
  const stderr = { bytes: 0, truncated: false };
  captureInheritedStdioStderr(selected.record, stderr, Buffer.alloc(9000, 'x'));
  const child = new EventEmitter();
  child.pid = 4123;
  observeInheritedStdioFixtureChild(selected.record, child);
  child.emit('spawn');
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(stderr.bytes, 8192);
  assert.equal(stderr.truncated, true);
  assert.deepEqual(
    rows.map(({ stage, details }) => [stage, details?.retainedBytes]),
    [
      ['inherited-stdio-stderr', undefined],
      ['inherited-stdio-stderr-truncated', 8192],
      ['inherited-stdio-supervisor-returned', undefined],
      ['inherited-stdio-supervisor-spawned', undefined],
      ['inherited-stdio-supervisor-exit', undefined],
      ['inherited-stdio-supervisor-close', undefined],
    ],
  );
  assert.deepEqual(
    createInheritedStdioDiagnosticSetup({
      platform: 'darwin',
      directory: '/x',
    }),
    {},
  );
  assert.deepEqual(
    createInheritedStdioDiagnosticSetup({
      platform: 'win32',
      directory: '/x',
      makeDirectory: () => {
        throw new Error('unavailable');
      },
    }),
    {},
  );
});

// Execute the registered native fixture with injected process handles and clocks.
// This tests its real spawn/listener wiring without claiming a Windows run.
async function inheritedStdioRegisteredFixture({
  enabled = true,
  unavailable = false,
} = {}) {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const helpers = source.slice(
    source.indexOf('function createInheritedStdioDiagnosticSetup('),
    source.indexOf("test('inherited-stdio diagnostic setup"),
  );
  const start = source.indexOf(
    "\ntest('supervisor reaps a descendant that keeps inherited stdio open'",
  );
  const body = source.slice(
    start,
    source.indexOf("\ntest('detached watchdog stays alive", start),
  );
  const rows = [],
    timers = [],
    kills = [];
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 4123,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  child.kill = (signal) => {
    kills.push(signal);
    child.signalCode = signal;
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
  };
  let callback, launch;
  runInNewContext(
    (helpers + body).replaceAll(
      'import.meta.url',
      JSON.stringify(import.meta.url),
    ),
    {
      assert,
      Buffer,
      URL,
      path,
      fileURLToPath,
      process: {
        platform: 'win32',
        pid: 4000,
        execPath: '/fixture/node',
        env: enabled
          ? { CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '/diagnostics' }
          : {},
      },
      randomUUID: () => 'registered-fixture',
      mkdirSync: () => {
        if (unavailable) throw new Error('directory unavailable');
      },
      createBoundaryRecorder: () => (stage, details) =>
        rows.push({ stage, ...details }),
      spawn: (...args) => {
        launch = args;
        return child;
      },
      setTimeout: (fn, milliseconds) => {
        const timer = {
          fn,
          milliseconds,
          cleared: false,
          unref() {
            return this;
          },
        };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timer.cleared = true;
      },
      test: (_name, fn) => {
        callback = fn;
      },
    },
  );
  assert.equal(typeof callback, 'function');
  const completion = callback().then(
    () => null,
    (error) => error,
  );
  return {
    rows,
    timers,
    kills,
    child,
    launch,
    completion,
    fireTimers() {
      for (const timer of timers) if (!timer.cleared) timer.fn();
    },
    finish() {
      child.emit('spawn');
      child.stdout.emit(
        'data',
        Buffer.from(
          'owned-descendant-stdout-complete\nowned-target-stdout-complete\n',
        ),
      );
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    },
  };
}

test('registered inherited-stdio fixture retains bounded observations without a late false timeout', async () => {
  const f = await inheritedStdioRegisteredFixture();
  assert.equal(f.launch[2].stdio[2], 'pipe');
  const config = JSON.parse(
    f.launch[2].env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
  );
  assert.equal(config.fixturePid, 4000);
  assert.equal(config.mode, 'close');
  assert.equal(
    f.launch[2].env.CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE,
    '1',
  );
  assert.equal(f.rows[0].launchId, config.launchId);
  f.child.stderr.emit('data', Buffer.alloc(9000, 'x'));
  f.child.stderr.emit('data', Buffer.alloc(20, 'y'));
  f.finish();
  assert.equal(await f.completion, null);
  assert.equal(f.timers[0].milliseconds, 8000);
  f.fireTimers();
  assert.equal(
    f.rows.some((row) => row.stage === 'inherited-stdio-timeout-rejected'),
    false,
  );
  assert.equal(
    f.rows
      .filter((row) => row.stage === 'inherited-stdio-stderr')
      .reduce((sum, row) => sum + row.bytes, 0),
    8192,
  );
  assert.equal(
    f.rows.filter((row) => row.stage === 'inherited-stdio-stderr-truncated')
      .length,
    1,
  );
  assert.equal(
    f.rows.find((row) => row.stage === 'inherited-stdio-supervisor-close').code,
    0,
  );
  assert.deepEqual(f.kills, []);
});

for (const options of [{ enabled: false }, { unavailable: true }]) {
  test(`registered inherited-stdio fixture preserves ordinary behavior ${JSON.stringify(options)}`, async () => {
    const f = await inheritedStdioRegisteredFixture(options);
    assert.equal(f.launch[2].stdio[2], 'ignore');
    assert.equal(
      f.launch[2].env.CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE,
      undefined,
    );
    f.finish();
    assert.equal(await f.completion, null);
    f.fireTimers();
    assert.deepEqual(f.rows, []);
    assert.deepEqual(f.kills, []);
  });
}

test('registered inherited-stdio fixture preserves the eight-second rejection and owned cleanup', async () => {
  const f = await inheritedStdioRegisteredFixture();
  assert.equal(f.timers[0].milliseconds, 8000);
  f.fireTimers();
  assert.match(
    (await f.completion).message,
    /supervisor did not reap inherited-stdio descendant/,
  );
  assert.deepEqual(f.kills, ['SIGTERM']);
  assert.equal(
    f.rows.filter((row) => row.stage === 'inherited-stdio-timeout-rejected')
      .length,
    1,
  );
  assert.equal(
    f.rows.find((row) => row.stage === 'inherited-stdio-supervisor-close')
      .signal,
    'SIGTERM',
  );
});

test('supervisor reaps a descendant that keeps inherited stdio open', async () => {
  const descendantSentinel = 'owned-descendant-stdout-complete\n';
  const targetSentinel = 'owned-target-stdout-complete\n';
  const descendantScript = [
    `process.stdout.write(${JSON.stringify(descendantSentinel)}, () => process.send('ready'));`,
    'setInterval(() => undefined, 10_000);',
  ].join('\n');
  const rootScript = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });`,
    `child.once('message', () => process.stdout.write(${JSON.stringify(targetSentinel)}, () => { child.disconnect(); child.unref(); }));`,
  ].join('\n');
  const inheritedDiagnostics = createInheritedStdioDiagnosticSetup();
  const diagnosticConfig = inheritedDiagnostics.config;
  const fixtureRecord = inheritedDiagnostics.record;
  fixtureRecord?.('inherited-stdio-fixture-entered', {
    caseId: diagnosticConfig?.caseId,
    launchId: diagnosticConfig?.launchId,
    fixturePid: process.pid,
  });
  const supervisor = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./process-tree-supervisor.mjs', import.meta.url)),
      '-e',
      rootScript,
    ],
    {
      env: {
        ...process.env,
        CANOPY_E2E_OWNER_PID: String(process.pid),
        ...inheritedDiagnostics.env,
        CANOPY_E2E_TREE_REFRESH_MS: '20',
      },
      stdio: ['ignore', 'pipe', inheritedDiagnostics.stderr ?? 'ignore'],
    },
  );
  let stdout = Buffer.alloc(0);
  let stdoutBytes = 0;
  const stderr = { bytes: 0, truncated: false };
  observeInheritedStdioFixtureChild(fixtureRecord, supervisor);
  supervisor.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 1024) stdout = Buffer.concat([stdout, chunk]);
  });
  supervisor.stderr?.on('data', (chunk) =>
    captureInheritedStdioStderr(fixtureRecord, stderr, chunk),
  );
  const closed = new Promise((resolve, reject) => {
    supervisor.once('error', reject);
    supervisor.once('close', (code, signal) => resolve({ code, signal }));
  });
  let timeoutHandle;
  let timeoutFired = false;
  const timeout = new Promise((_, reject) => {
    fixtureRecord?.('inherited-stdio-timeout-entered', { deadlineMs: 8000 });
    timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      fixtureRecord?.('inherited-stdio-timeout-rejected', {
        deadlineMs: 8000,
      });
      reject(new Error('supervisor did not reap inherited-stdio descendant'));
    }, 8_000).unref();
  });

  try {
    assert.deepEqual(await Promise.race([closed, timeout]), {
      code: 0,
      signal: null,
    });
    assert.equal(
      stdoutBytes,
      Buffer.byteLength(descendantSentinel + targetSentinel),
    );
    assert.equal(stdout.toString(), descendantSentinel + targetSentinel);
  } finally {
    clearTimeout(timeoutHandle);
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill('SIGTERM');
      await closed;
    }
    fixtureRecord?.('inherited-stdio-fixture-settled', {
      timeoutFired,
      stderrBytes: stderr.bytes,
      stderrTruncated: stderr.truncated,
    });
  }
});

test('detached watchdog stays alive while its supervisor is alive', async () => {
  const caseId = 'watchdog-test';
  const launchId = `${caseId}-${process.pid}-${randomUUID()}`;
  const diagnosticDirectory = path.resolve(
    '.playwright',
    'browser-profiles',
    'phase-3',
    `windows-boundary-${launchId}`,
  );
  const { diagnosticDirectoryReady, supervisor, target } =
    launchWatchdogTestProcesses(diagnosticDirectory);
  const watchdogArgs = [
    '--canopy-process-tree-watchdog',
    String(supervisor.pid),
    String(target.pid),
  ];
  const diagnosticConfig = diagnosticDirectoryReady
    ? {
        file: path.join(diagnosticDirectory, `${launchId}-main.jsonl`),
        mode: 'watchdog-test',
        caseId,
        launchId,
        fixturePid: process.pid,
        supervisorPid: supervisor.pid,
        targetPid: target.pid,
      }
    : undefined;
  const diagnosticEnv = diagnosticConfig
    ? {
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS:
          JSON.stringify(diagnosticConfig),
      }
    : undefined;
  const record = diagnosticEnv
    ? supervisorModule.createWindowsBoundaryRecorder(
        watchdogArgs,
        'watchdog-fixture',
        { env: diagnosticEnv },
      )
    : undefined;
  const observeEmergencyCleanup = (action, operation) => {
    const note = (details) => {
      try {
        record?.('emergency-cleanup', { action, ...details });
      } catch {
        // This fixture observer cannot change emergency cleanup.
      }
    };
    note({ outcome: 'entered' });
    try {
      const result = operation();
      if (result instanceof Promise)
        void result.then(
          () => note({ outcome: 'fulfilled' }),
          (error) =>
            note({
              outcome: 'rejected',
              message: String(error?.message ?? error).slice(0, 512),
            }),
        );
      else note({ outcome: 'fulfilled', returned: result });
      return result;
    } catch (error) {
      note({
        outcome: 'rejected',
        message: String(error?.message ?? error).slice(0, 512),
      });
      throw error;
    }
  };
  const observeChild = (role, child) => {
    record?.('child-returned', { role, childPid: child.pid });
    child.once('spawn', () =>
      record?.('child-spawn', { role, childPid: child.pid }),
    );
    child.once('error', (error) =>
      record?.('child-error', {
        role,
        childPid: child.pid,
        message: String(error?.message ?? error).slice(0, 512),
        code: String(error?.code ?? '').slice(0, 128),
      }),
    );
    child.once('exit', (code, signal) =>
      record?.('child-exit', { role, childPid: child.pid, code, signal }),
    );
    child.once('close', (code, signal) =>
      record?.('child-close', { role, childPid: child.pid, code, signal }),
    );
  };
  observeChild('supervisor', supervisor);
  observeChild('target', target);
  const watchdog = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./process-tree-supervisor.mjs', import.meta.url)),
      ...watchdogArgs,
    ],
    {
      detached: true,
      env: diagnosticEnv ? { ...process.env, ...diagnosticEnv } : process.env,
      stdio: record ? ['ignore', 'ignore', 'pipe'] : 'ignore',
    },
  );
  observeChild('watchdog', watchdog);
  let stderrBytes = 0;
  let stderrTruncated = false;
  watchdog.stderr?.on('data', (chunk) => {
    const remaining = Math.max(0, 8 * 1024 - stderrBytes);
    if (remaining > 0) {
      const captured = chunk.subarray(0, remaining);
      stderrBytes += captured.length;
      record?.('watchdog-stderr', {
        bytes: captured.length,
        text: captured.toString('utf8'),
      });
    }
    if (chunk.length > remaining && !stderrTruncated) {
      stderrTruncated = true;
      record?.('watchdog-stderr-truncated', { retainedBytes: stderrBytes });
    }
  });
  const watchdogClosed = new Promise((resolve) =>
    watchdog.once('close', resolve),
  );
  const targetClosed = new Promise((resolve) => target.once('close', resolve));

  try {
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal(watchdog.exitCode, null);
    assert.equal(watchdog.signalCode, null);

    record?.('supervisor-stop', { outcome: 'entered' });
    const supervisorStopReturned = supervisor.kill('SIGTERM');
    record?.('supervisor-stop', {
      outcome: 'returned',
      returned: supervisorStopReturned,
    });
    const timeout = createWatchdogDeadline({
      platform: process.platform,
      error: new Error('watchdog did not exit after its supervisor'),
      record,
      supervisor,
      target,
      watchdog,
    });
    assert.equal(await Promise.race([watchdogClosed, timeout]), 0);
    await targetClosed;
  } finally {
    await runWatchdogEmergencyCleanup({
      supervisor,
      target,
      watchdog,
      watchdogClosed,
      observe: observeEmergencyCleanup,
    });
  }
});

// Evaluate the real supervisor with only host I/O substituted. This regression
// also runs against the original buffered execFile implementation, so its RED
// result proves the observed deadline failure without relying on a new export.
async function supervisorWithQueryIo(io, sourceLineEnding = '\n') {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(
    new URL('./process-tree-supervisor.mjs', import.meta.url),
    'utf8',
  )
    .replace(/\r?\n/g, sourceLineEnding)
    .replace(/^#!.*\r?\n/, '')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '')
    .split('if (process.argv[1] === fileURLToPath(import.meta.url))')[0]
    .replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  return runInNewContext(
    source +
      '\n({ createSupervisorProcessTreeOwner, createWindowsProcessTreeOwner, releaseWindowsSupervisedChild });',
    {
      ...io,
      Buffer,
      process,
      TextDecoder,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      performance: { now: io.now },
      promisify: () => io.execFileAsync,
      execFile: () => {
        throw new Error('unexpected execFile');
      },
    },
  );
}

function initialQueryFixture() {
  let time = 0;
  const timers = new Set();
  const query = mockChild(6789);
  query.stdout = new EventEmitter();
  query.stderr = new EventEmitter();
  query.stdout.destroy = () => {
    query.stdout.destroyed = true;
  };
  query.stderr.destroy = () => {
    query.stderr.destroyed = true;
  };
  query.kill = () => {
    query.kills += 1;
    return true;
  };
  query.kills = 0;
  const requests = [];
  const messages = [];
  const wrapper = { pid: 4321, send: (message) => messages.push(message) };
  const io = {
    now: () => time,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, at: time + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => timers.delete(timer),
    spawn: (...args) => {
      requests.push(args);
      return query;
    },
    execFileAsync: (_file, args, options) => {
      requests.push([_file, args, options]);
      return new Promise((resolve, reject) => {
        let stdout = '';
        const timer = io.setTimeoutFn(
          () =>
            reject(
              Object.assign(new Error('whole-query timeout'), {
                killed: true,
                stdout,
              }),
            ),
          options.timeout,
        );
        query.stdout.on('data', (data) => {
          stdout += data;
        });
        query.once('close', () => {
          io.clearTimeoutFn(timer);
          resolve({ stdout });
        });
      });
    },
  };
  return {
    io,
    query,
    requests,
    messages,
    wrapper,
    timers,
    at(value, deliverTimers = true) {
      time = value;
      if (deliverTimers) {
        for (const timer of [...timers]) {
          if (timer.at <= time) {
            timers.delete(timer);
            timer.callback();
          }
        }
      }
    },
    stdout(value) {
      query.stdout.emit('data', Buffer.from(value));
    },
    stderr(value) {
      query.stderr.emit('data', Buffer.from(value));
    },
    complete() {
      this.stdout(
        'phase=cim-first-row\n4321\t1\troot-created\nphase=cim-complete\n',
      );
    },
    close(code = 0, signal = null) {
      query.emit('exit', code, signal);
      query.emit('close', code, signal);
    },
  };
}

for (const [label, sourceLineEnding] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]) {
  test(`query I/O fixture evaluates the actual supervisor source with ${label}`, async () => {
    const f = initialQueryFixture();
    const implementation = await supervisorWithQueryIo(f.io, sourceLineEnding);
    const owner = implementation.createSupervisorProcessTreeOwner(f.wrapper, {
      useWindowsLaunchGate: true,
      ...f.io,
    });
    const released = implementation.releaseWindowsSupervisedChild(
      f.wrapper,
      owner,
    );
    f.stdout('phase=ps-ready\n');
    f.complete();
    f.close();
    assert.equal(
      await released,
      true,
      `${label} source must admit the wrapper`,
    );
    assert.deepEqual(f.messages, ['start']);
    assert.equal(f.requests.length, 1);
  });
}

test('initial streamed admission accepts observed ready 2786.074 and close 5117.1719', async () => {
  const f = initialQueryFixture();
  const implementation = await supervisorWithQueryIo(f.io);
  const owner = implementation.createSupervisorProcessTreeOwner(f.wrapper, {
    useWindowsLaunchGate: true,
    ...f.io,
  });
  const released = implementation.releaseWindowsSupervisedChild(
    f.wrapper,
    owner,
  );
  f.at(2786.074);
  f.stdout('phase=ps-ready\n');
  await Promise.resolve();
  assert.deepEqual(f.messages, []);
  f.at(5000);
  await Promise.resolve();
  f.at(5009.2962);
  f.complete();
  await Promise.resolve();
  assert.deepEqual(f.messages, []);
  f.at(5117.1719);
  f.close();
  assert.equal(
    await released,
    true,
    'observed valid query must survive the old whole-query 5000 ms cutoff',
  );
  assert.deepEqual(f.messages, ['start']);
  assert.equal(f.requests.length, 1);
});

test('enabled admission emission instruments the one registered initial query and records host chronology', async () => {
  const f = initialQueryFixture();
  const implementation = await supervisorWithQueryIo(f.io);
  const emissionFile = 'C:\\owned\\launch-admission-emission.jsonl';
  const owner = implementation.createSupervisorProcessTreeOwner(f.wrapper, {
    useWindowsLaunchGate: true,
    ...f.io,
    admissionEmission: { status: 'ready', file: emissionFile },
  });
  const released = implementation.releaseWindowsSupervisedChild(
    f.wrapper,
    owner,
  );

  f.at(10, false);
  f.query.emit('spawn');
  f.at(20, false);
  f.stdout('phase=ps-ready\n');
  f.at(30, false);
  f.stdout('phase=cim-first-row\n');
  f.at(40, false);
  f.stdout('4321\t1\troot-created\n');
  f.at(50, false);
  f.stdout('phase=cim-complete\n');
  f.at(60, false);
  f.close();

  assert.equal(await released, true);
  assert.deepEqual(f.messages, ['start']);
  assert.equal(f.requests.length, 1);
  const [file, args, options] = f.requests[0];
  assert.equal(file, 'powershell.exe');
  assert.equal(
    JSON.stringify(options),
    JSON.stringify({
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  assert.match(args.at(-1), /launch-admission-emission\.jsonl/);
  assert.equal(args.at(-1).split('AppendAllText').length - 1, 4);
  const enumeration = owner.getInitialDiagnosticSnapshot().enumeration;
  assert.equal(enumeration.queryPid, 6789);
  assert.equal(
    JSON.stringify(enumeration.timings),
    JSON.stringify({
      spawnReturnMs: 0,
      spawnEventMs: 10,
      firstStdoutByteMs: 20,
      firstStderrByteMs: null,
      readyMs: 20,
      firstRowMs: 30,
      identityMs: 40,
      completeMs: 50,
      exitMs: 60,
      closeMs: 60,
      timeoutDeadlineMs: null,
      timeoutObservedMs: null,
      deadlineTimerLatenessMs: null,
    }),
  );
  assert.equal(enumeration.timeoutObservationSource, null);
  assert.equal(enumeration.postDecisionStdoutBytes, 0);
  assert.equal(enumeration.postDecisionStderrBytes, 0);
});

test('unavailable admission emission remains passive and preserves the disabled query and release', async () => {
  const f = initialQueryFixture();
  let unavailableClockReads = 0;
  const unavailableNow = f.io.now;
  f.io.now = () => {
    unavailableClockReads += 1;
    return unavailableNow();
  };
  const disabledScript = buildWindowsProcessTreeListScript(4321);
  const implementation = await supervisorWithQueryIo(f.io);
  const owner = implementation.createSupervisorProcessTreeOwner(f.wrapper, {
    useWindowsLaunchGate: true,
    ...f.io,
    admissionEmission: {
      status: 'unavailable',
      reason: 'exclusive-create-failed',
    },
  });
  const released = implementation.releaseWindowsSupervisedChild(
    f.wrapper,
    owner,
  );
  assert.equal(f.query.listenerCount('spawn'), 0);
  f.stdout('phase=ps-ready\n');
  f.complete();
  f.close();
  assert.equal(await released, true);
  assert.deepEqual(f.messages, ['start']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][1].at(-1), disabledScript);
  assert.equal(
    JSON.stringify(f.requests[0][2]),
    JSON.stringify({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  const unavailableSnapshot = owner.getInitialDiagnosticSnapshot();
  assert.deepEqual(Object.keys(unavailableSnapshot.enumeration.timings), [
    'readyMs',
    'completeMs',
    'exitMs',
    'closeMs',
  ]);
  assert.equal('queryPid' in unavailableSnapshot.enumeration, false);

  const baseline = initialQueryFixture();
  let baselineClockReads = 0;
  const baselineNow = baseline.io.now;
  baseline.io.now = () => {
    baselineClockReads += 1;
    return baselineNow();
  };
  startInitialQuery(baseline, {}, await supervisorWithQueryIo(baseline.io));
  assert.equal(baseline.query.listenerCount('spawn'), 0);
  baseline.stdout('phase=ps-ready\n');
  baseline.complete();
  baseline.close();
  assert.equal(await baseline.released, true);
  const baselineSnapshot = baseline.owner.getInitialDiagnosticSnapshot();
  baselineSnapshot.observedAt = unavailableSnapshot.observedAt;
  assert.equal(
    JSON.stringify(baselineSnapshot),
    JSON.stringify(unavailableSnapshot),
  );
  assert.equal(baselineClockReads, unavailableClockReads);
  assert.equal(JSON.stringify(baseline.requests), JSON.stringify(f.requests));
  assert.deepEqual(baseline.messages, f.messages);
});

test('producer first-row evidence cannot authorize a host query that remains awaiting its first row', async () => {
  const f = startInitialQuery(initialQueryFixture(), {
    admissionEmission: {
      status: 'ready',
      file: 'C:\\owned\\launch-admission-emission.jsonl',
    },
  });
  f.at(100);
  f.stdout('phase=ps-ready\n');
  f.at(15100);
  const diagnostic = await assertInitialFailure(f, 'timeout');
  assert.equal(diagnostic.validatedPhase, 'awaiting-first-row');
  const row = (sequence, stage, utcTicks) =>
    JSON.stringify({
      schemaVersion: 1,
      sequence,
      stage,
      utcTicks,
      powershellPid: 6789,
    });
  const producer = supervisorModule.parseWindowsAdmissionEmissionRecords(
    [
      row(1, 'script-enter', '638936064000000000'),
      row(2, 'pre-cim', '638936064000000001'),
      row(3, 'first-row-callback', '638936064000000002'),
    ].join('\n'),
    diagnostic.queryPid,
  );
  assert.equal(producer.status, 'partial');
  assert.equal(producer.records.at(-1).stage, 'first-row-callback');
  assert.deepEqual(f.messages, ['abort']);
});

test('initial admission freezes timeout while retaining bounded late bytes and existing-timer lateness', async () => {
  const f = startInitialQuery(initialQueryFixture(), {
    admissionEmission: {
      status: 'ready',
      file: 'C:\\owned\\launch-admission-emission.jsonl',
    },
  });
  f.at(100);
  f.stdout('phase=ps-ready\n');
  f.at(15125);
  assert.deepEqual(f.messages, ['abort']);
  f.at(15200, false);
  f.stdout('phase=cim-first-row\n4321\t1\tlate\nphase=cim-complete\n');
  f.stderr('x'.repeat(9000));
  f.close(null, 'SIGTERM');
  assert.equal(await f.released, false);
  const diagnostic = f.owner.getInitialDiagnosticSnapshot().enumeration;
  assert.equal(diagnostic.failureCategory, 'timeout');
  assert.equal(diagnostic.timeoutPhase, 'completion');
  assert.equal(diagnostic.validatedPhase, 'awaiting-first-row');
  assert.equal(diagnostic.timings.timeoutDeadlineMs, 15100);
  assert.equal(diagnostic.timings.timeoutObservedMs, 15125);
  assert.equal(diagnostic.timeoutObservationSource, 'timer');
  assert.equal(diagnostic.timings.deadlineTimerLatenessMs, 25);
  assert.ok(diagnostic.postDecisionStdoutBytes > 0);
  assert.equal(diagnostic.postDecisionStdoutTruncated, false);
  assert.equal(diagnostic.postDecisionStderrBytes, 8192);
  assert.equal(diagnostic.postDecisionStderrTruncated, true);
  assert.equal(diagnostic.timings.firstStderrByteMs, 15200);
  assert.deepEqual(f.messages, ['abort']);
  assert.equal(f.requests.length, 1);
});

test('enabled admission observer attributes callback expiry without inventing timer lateness', async () => {
  const f = initialQueryFixture();
  const implementation = await supervisorWithQueryIo(f.io);
  startInitialQuery(
    f,
    {
      admissionEmission: {
        status: 'ready',
        file: 'C:\\owned\\launch-admission-emission.jsonl',
      },
    },
    implementation,
  );
  f.at(15000, false);
  f.stdout('phase=ps-ready\n');
  const diagnostic = await assertInitialFailure(f, 'timeout');
  assert.equal(diagnostic.timeoutPhase, 'startup');
  assert.equal(diagnostic.timeoutObservationSource, 'stdout');
  assert.equal(diagnostic.timings.timeoutDeadlineMs, 15000);
  assert.equal(diagnostic.timings.timeoutObservedMs, 15000);
  assert.equal(diagnostic.timings.deadlineTimerLatenessMs, null);
  assert.equal(diagnostic.timings.firstStdoutByteMs, 15000);
});

test('enabled admission observation preserves cancellation with controlled final verification', async () => {
  const admissionEmission = {
    status: 'ready',
    file: 'C:\\owned\\launch-admission-emission.jsonl',
  };
  const cancelled = initialQueryFixture();
  let cleanupQueries = 0;
  cancelled.io.execFileAsync = async () => {
    cleanupQueries += 1;
    throw new Error('final scan unavailable');
  };
  const implementation = await supervisorWithQueryIo(cancelled.io);
  startInitialQuery(cancelled, { admissionEmission }, implementation);
  const stopping = cancelled.owner.stop();
  const cancelledDiagnostic = await assertInitialFailure(
    cancelled,
    'cancelled',
  );
  await assert.rejects(stopping, /cleanup verification unavailable/);
  assert.equal(cleanupQueries, 1);
  assert.equal(cancelledDiagnostic.queryPid, 6789);
  assert.deepEqual(cancelled.messages, ['abort']);
});

test('enabled admission observation preserves spawn failure decision', async () => {
  const admissionEmission = {
    status: 'ready',
    file: 'C:\\owned\\launch-admission-emission.jsonl',
  };
  const spawnFailure = initialQueryFixture();
  spawnFailure.io.spawn = () => {
    throw new Error('spawn unavailable');
  };
  const implementation = await supervisorWithQueryIo(spawnFailure.io);
  startInitialQuery(spawnFailure, { admissionEmission }, implementation);
  assert.equal(await spawnFailure.released, false);
  const spawnDiagnostic =
    spawnFailure.owner.getInitialDiagnosticSnapshot().enumeration;
  assert.equal(spawnDiagnostic.failureCategory, 'spawn');
  assert.equal(spawnDiagnostic.queryPid, null);
  assert.equal(spawnDiagnostic.timings.spawnReturnMs, null);
  assert.deepEqual(spawnFailure.messages, ['abort']);
});

function startInitialQuery(
  f = initialQueryFixture(),
  options = {},
  implementation = supervisorModule,
) {
  const owner = implementation.createSupervisorProcessTreeOwner(f.wrapper, {
    useWindowsLaunchGate: true,
    ...f.io,
    ...options,
  });
  const released = implementation.releaseWindowsSupervisedChild(
    f.wrapper,
    owner,
  );
  return Object.assign(f, { owner, released });
}

async function assertInitialFailure(f, category, expectedKills = 1) {
  assert.deepEqual(f.messages, ['abort']);
  f.at(f.io.now() + 1000);
  assert.equal(await f.released, false);
  const snapshot = f.owner.getInitialDiagnosticSnapshot();
  assert.equal(snapshot.enumeration.failureCategory, category);
  assert.equal(f.query.kills, expectedKills);
  assert.equal(f.timers.size, 0);
  assert.equal(f.query.stdout.destroyed, true);
  assert.equal(f.query.stderr.destroyed, true);
  assert.equal(f.query.stdout.listenerCount('data'), 0);
  assert.equal(f.query.listenerCount('close'), 0);
  f.stdout('phase=ps-ready\n');
  f.complete();
  f.close();
  assert.deepEqual(f.messages, ['abort']);
  assert.ok(
    Buffer.byteLength(
      supervisorModule.formatWindowsLaunchFailureDiagnostic({
        ownerSnapshot: snapshot,
      }),
    ) <= 8192,
  );
  return snapshot.enumeration;
}

test('initial streamed admission accepts bounded cold Windows startup and closes before start', async () => {
  const f = startInitialQuery();
  const staleStartupTimer = [...f.timers][0];
  f.at(12000);
  f.stdout('phase=ps-ready\n');
  f.complete();
  await Promise.resolve();
  assert.deepEqual(f.messages, []);
  f.at(25000);
  staleStartupTimer.callback();
  f.query.emit('exit', 0, null);
  await Promise.resolve();
  assert.deepEqual(f.messages, []);
  f.query.emit('close', 0, null);
  assert.equal(await f.released, true);
  assert.deepEqual(f.messages, ['start']);
  assert.equal(f.query.kills, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.owner.getInitialDiagnosticSnapshot().enumeration.budgets, {
    startupMs: 15000,
    completionMs: 15000,
    lifetimeMs: 30000,
    terminationMs: 1000,
  });
});

test('initial streamed startup expiry uses absolute time including late timers and incomplete or stderr markers', async () => {
  for (const input of ['none', 'stderr', 'partial', 'exact', 'late']) {
    const f = startInitialQuery();
    if (input === 'stderr') f.stderr('phase=ps-ready\n');
    if (input === 'partial') f.stdout('phase=ps-ready');
    f.at(
      input === 'late' ? 15100 : 15000,
      input !== 'exact' && input !== 'late',
    );
    if (input === 'exact' || input === 'late') f.stdout('phase=ps-ready\n');
    const diagnostic = await assertInitialFailure(f, 'timeout');
    assert.equal(diagnostic.timeoutPhase, 'startup');
    assert.equal(diagnostic.terminationConfirmed, false);
  }
});

test('initial streamed completion never banks unused startup and checks late callbacks', async () => {
  for (const event of [
    'no-row',
    'no-complete',
    'no-exit',
    'no-close',
    'exact-close',
    'late-data',
    'late-stderr',
    'late-close',
  ]) {
    const f = startInitialQuery();
    f.at(2000);
    f.stdout('phase=ps-ready\n');
    if (event === 'no-complete')
      f.stdout('phase=cim-first-row\n4321\t1\troot-created\n');
    else if (event !== 'no-row') f.complete();
    if (event === 'no-close') f.query.emit('exit', 0, null);
    const late = event.startsWith('late') || event === 'exact-close';
    f.at(event.startsWith('late') ? 17100 : 17000, !late);
    if (event === 'late-data') f.stdout('\n');
    if (event === 'late-stderr') f.stderr('diagnostic');
    if (event.endsWith('close') && late) f.close();
    const diagnostic = await assertInitialFailure(f, 'timeout');
    assert.equal(diagnostic.timeoutPhase, 'completion');
  }
  const f = startInitialQuery();
  const staleTimer = [...f.timers][0];
  f.at(2000);
  f.stdout('phase=ps-ready\n');
  f.complete();
  f.at(16999);
  staleTimer.callback();
  f.close();
  assert.equal(await f.released, true);
});

test('initial streamed protocol rejects malformed, duplicate, reordered and unfinished output', async (t) => {
  const ready = 'phase=ps-ready\n',
    first = 'phase=cim-first-row\n',
    row = '4321\t1\troot-created\n',
    complete = 'phase=cim-complete\n';
  for (const output of [
    'error phase=ps-ready\n',
    ' phase=ps-ready\n',
    'phase=ps-ready \n',
    ready + ready,
    first,
    row,
    ready + complete,
    ready + first + first,
    ready + first + row + row,
    ready + first + row + '4321\t1\tother-created\n',
    ready + first + '9999\t1\tcreated\n',
    ready + first + '4321\tx\tcreated\n',
    ready + first + '4321\t1\t\n',
    ready + first + '4321\t1\tcreated\textra\n',
    ready + first + complete,
    ready + first + row + complete + complete,
    ready + first + row + complete + 'unfinished',
  ]) {
    const f = startInitialQuery();
    f.stdout(output);
    if (output.endsWith('unfinished')) f.close();
    await assertInitialFailure(
      f,
      'parse',
      output.endsWith('unfinished') ? 0 : 1,
    );
  }
  for (const [index, position] of [
    'ready',
    'first-row',
    'identity',
    'complete',
  ].entries()) {
    await t.test(`rejects BOM-prefixed ${position}`, async () => {
      const f = startInitialQuery();
      const lines = [ready, first, row, complete];
      lines[index] = '\uFEFF' + lines[index];
      f.stdout(lines.join(''));
      f.close();
      assert.equal(
        await f.released,
        false,
        `BOM-prefixed ${position} must not release start`,
      );
      await assertInitialFailure(f, 'parse');
    });
  }
});

test('initial streamed protocol bounds stdout, stderr and pending bytes', async () => {
  for (const type of ['stdout', 'stderr', 'pending']) {
    const f = startInitialQuery();
    if (type === 'stdout') f.stdout('\n'.repeat(16385));
    if (type === 'stderr') f.stderr('x'.repeat(8193));
    if (type === 'pending') f.stdout('😀'.repeat(1025));
    const diagnostic = await assertInitialFailure(f, 'overflow');
    assert.equal(diagnostic.outputTruncated, true);
  }
});

test('initial streamed protocol accepts split UTF-8, split markers, CRLF and multiple lines', async () => {
  const f = startInitialQuery();
  const bytes = Buffer.from(
    'phase=ps-ready\r\nphase=cim-first-row\r\n4321\t1\tidentity-😀\r\nphase=cim-complete\r\n',
  );
  for (const byte of bytes) f.query.stdout.emit('data', Buffer.from([byte]));
  f.close();
  assert.equal(await f.released, true);
  assert.equal(
    f.owner.getInitialDiagnosticSnapshot().root.creationIdentity,
    'identity-😀',
  );
});

test('initial streamed admission fails closed on process and stream errors or unsuccessful exit', async () => {
  for (const failure of ['spawn', 'stdout', 'stderr', 'exit', 'signal']) {
    const f = startInitialQuery();
    if (failure === 'spawn') f.query.emit('error', new Error('spawn failed'));
    if (failure === 'stdout' || failure === 'stderr')
      f.query[failure].emit('error', new Error('pipe failed'));
    if (failure === 'exit') f.query.emit('exit', 1, null);
    if (failure === 'signal') f.query.emit('exit', null, 'SIGTERM');
    await assertInitialFailure(
      f,
      failure === 'stdout' || failure === 'stderr'
        ? 'stream'
        : failure === 'spawn'
          ? 'spawn'
          : 'exit',
    );
  }
});

test('initial streamed failed termination is bounded and never reported as confirmed', async () => {
  for (const kill of [
    'false',
    'throw',
    'error',
    'exit-only',
    'no-close',
    'close',
  ]) {
    const f = startInitialQuery();
    f.query.kill = () => {
      f.query.kills += 1;
      if (kill === 'throw') throw new Error('kill failed');
      if (kill === 'error') f.query.emit('error', new Error('kill error'));
      if (kill === 'exit-only') f.query.emit('exit', null, 'SIGTERM');
      if (kill === 'close') f.close(null, 'SIGTERM');
      return kill !== 'false';
    };
    f.at(15000);
    const diagnostic = await assertInitialFailure(f, 'timeout');
    assert.equal(diagnostic.terminationConfirmed, kill === 'close');
    assert.equal(
      diagnostic.cleanupOutcome,
      kill === 'close' ? 'closed' : 'termination-unconfirmed',
    );
  }
});

test('initial streamed stop and parent death cancel admission promptly even if abort send throws', async () => {
  for (const cause of ['stop', 'parent', 'send-throws']) {
    const f = initialQueryFixture();
    if (cause === 'send-throws')
      f.wrapper.send = (message) => {
        f.messages.push(message);
        throw new Error('disconnected');
      };
    startInitialQuery(
      f,
      {},
      await supervisorWithQueryIo({
        ...f.io,
        execFileAsync: async () => ({ stdout: rawWindowsProcessOutput([]) }),
      }),
    );
    let stopping;
    if (cause === 'parent') {
      let check;
      startParentLivenessWatch({
        parentPid: 9999,
        isProcessAlive: () => false,
        onParentExit: () => {
          stopping = f.owner.stop();
        },
        setIntervalFn: (callback) => {
          check = callback;
          return { unref() {} };
        },
        clearIntervalFn() {},
      });
      await check();
    } else stopping = f.owner.stop();
    await assertInitialFailure(f, 'cancelled');
    await stopping;
  }
});

test('initial streaming stays separate from bounded candidate queries and full ownership scans', async () => {
  const f = initialQueryFixture();
  const laterQueries = [];
  f.io.execFileAsync = async (file, args, options) => {
    laterQueries.push({ file, args, options });
    return { stdout: rawWindowsProcessOutput(['4321\t1\troot-created']) };
  };
  const implementation = await supervisorWithQueryIo(f.io);
  let alive = true;
  const owner = implementation.createSupervisorProcessTreeOwner(f.wrapper, {
    useWindowsLaunchGate: true,
    ...f.io,
    admissionEmission: {
      status: 'ready',
      file: 'C:\\owned\\launch-admission-emission.jsonl',
    },
    isProcessAlive: () => alive,
    killProcessTree: async () => {
      alive = false;
    },
  });
  const released = implementation.releaseWindowsSupervisedChild(
    f.wrapper,
    owner,
  );
  f.stdout('phase=ps-ready\n');
  f.complete();
  f.close();
  assert.equal(await released, true);
  assert.equal(f.requests[0][0], 'powershell.exe');
  assert.ok(f.requests[0][1].at(-1).includes('-Filter "ProcessId=4321"'));
  assert.equal(
    JSON.stringify(f.requests[0][2]),
    JSON.stringify({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  await owner.refresh();
  const loop = startProcessTreeOwnerRefresh({ owner, ...f.io });
  const refreshTimer = [...f.timers][0];
  await refreshTimer.callback();
  loop.stop();
  await owner.stop();
  const generic = implementation.createWindowsProcessTreeOwner(f.wrapper);
  assert.equal(await generic.ready, true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    laterQueries.map((query) => query.args.at(-1).includes('-Filter')),
    [false, false, false, true, false, false],
  );
  for (const query of laterQueries) {
    assert.equal(query.file, 'powershell.exe');
  }
  assert.deepEqual(
    laterQueries.map((query) => query.options.timeout),
    [5_000, 5_000, 15_000, 15_000, 15_000, 5_000],
  );
});

test('initial streamed final release rechecks elapsed time after a timely clean close', async () => {
  const f = startInitialQuery();
  f.at(2000);
  f.stdout('phase=ps-ready\n');
  f.complete();
  f.at(16999);
  f.close();
  f.at(17000, false);
  assert.equal(await f.released, false);
  assert.deepEqual(f.messages, ['abort']);
  const enumeration = f.owner.getInitialDiagnosticSnapshot().enumeration;
  assert.equal(enumeration.failureCategory, 'timeout');
  assert.equal(enumeration.failureElapsedMs, 17000);
  assert.equal(enumeration.terminationConfirmed, true);
});

test('initial streamed stop after close but before release cannot start the wrapper', async () => {
  const f = initialQueryFixture();
  startInitialQuery(
    f,
    {},
    await supervisorWithQueryIo({
      ...f.io,
      execFileAsync: async () => ({ stdout: rawWindowsProcessOutput([]) }),
    }),
  );
  f.stdout('phase=ps-ready\n');
  f.complete();
  f.close();
  const stopping = f.owner.stop();
  assert.equal(await f.released, false);
  await stopping;
  assert.deepEqual(f.messages, ['abort']);
  assert.equal(
    f.owner.getInitialDiagnosticSnapshot().enumeration.failureCategory,
    'cancelled',
  );
});

test('initial streamed spawn throw and a late close retain honest bounded failure evidence', async () => {
  const f = initialQueryFixture();
  f.io.spawn = () => {
    throw new Error('spawn unavailable');
  };
  startInitialQuery(f);
  assert.equal(await f.released, false);
  assert.deepEqual(f.messages, ['abort']);
  assert.equal(
    f.owner.getInitialDiagnosticSnapshot().enumeration.failureCategory,
    'spawn',
  );
  assert.equal(f.timers.size, 0);
  const late = startInitialQuery();
  late.at(15000);
  late.at(16000, false);
  late.close();
  assert.equal(await late.released, false);
  assert.equal(
    late.owner.getInitialDiagnosticSnapshot().enumeration.terminationConfirmed,
    false,
  );
});

async function registeredBoundaryProducer(kind, options = {}) {
  const vm = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('./process-tree-supervisor.mjs', import.meta.url),
    'utf8',
  );
  const name =
    kind === 'target'
      ? 'runWindowsSupervisedChild'
      : kind === 'watchdog'
        ? 'runWatchdog'
        : 'runSupervisor';
  const start = source.indexOf(`async function ${name}(`);
  const end =
    kind === 'target'
      ? source.indexOf('\nfunction createPlatformProcessTreeOwner', start)
      : kind === 'watchdog'
        ? source.indexOf('\nfunction spawnWatchdog', start)
        : source.indexOf('\nif (process.argv[1]', start);
  const child = mockChild(),
    host = new EventEmitter(),
    records = [],
    order = [],
    sends = [],
    spawnCalls = [],
    timers = new Set(),
    deadlines = new Set(),
    errors = [];
  let parentExit;
  let time = 0;
  let ownerOptions;
  child.pid = 4321;
  for (const stream of ['stdout', 'stderr', 'stdin'])
    child[stream] = { pipe() {} };
  Object.assign(host, {
    env: options.env ?? {},
    execPath: '/node',
    pid: 1234,
    ppid: 1000,
    cwd: () => '/owned',
    platform: 'win32',
    connected: true,
    send: (message, callback) => {
      order.push(message.type);
      sends.push({ message, callback });
    },
    disconnect: () => {
      order.push('disconnect');
      host.connected = false;
    },
    channel: { unref: () => order.push('channel-unref') },
    exit: (code) => order.push(`process-exit-${code}`),
    stderr: { write: (message) => errors.push(message) },
    stdin: { pipe() {}, unpipe() {}, pause() {} },
  });
  let owner = options.owner ?? {
    ready: Promise.resolve(true),
    stop:
      options.stop ??
      (async () => {
        order.push('cleanup');
        ownerOptions.onCleanupSnapshot?.(true);
      }),
    trackOwnedPid: () => {},
    refresh: async () => true,
  };
  const record = (stage, details) => {
    records.push({ stage, ...details });
    order.push(stage);
  };
  const fn = vm.runInNewContext(
    `(${source.slice(start, end).replaceAll('import.meta.url', "'file:///supervisor.mjs'")})`,
    {
      process: host,
      spawn: (...args) => {
        spawnCalls.push(args);
        return child;
      },
      setInterval: () => {
        const timer = {};
        timers.add(timer);
        return timer;
      },
      clearInterval: (timer) => {
        assert.ok(timers.delete(timer), 'release the owned interval once');
        order.push('clear-interval');
      },
      setTimeout: (callback, delay) => {
        const timer = { callback, at: time + delay };
        deadlines.add(timer);
        return timer;
      },
      clearTimeout: (timer) => deadlines.delete(timer),
      performance: { now: () => time },
      PROCESS_LIST_TIMEOUT_MS: 5_000,
      WINDOWS_RELEASE_ACK_TIMEOUT_MS: 45_000,
      WINDOWS_RELEASE_ACK_MESSAGE: 'release-after-cleanup-snapshot',
      WINDOWS_RELEASE_FAILURE_EXIT_CODE: 125,
      SUPERVISED_EXECUTABLE_ENV: 'executable',
      SUPERVISED_PID_FILE_ENV: 'pidfile',
      SUPERVISED_GROUPS_FILE_ENV: 'CANOPY_E2E_SUPERVISED_GROUPS_FILE',
      SUPERVISED_RUN_NONCE_ENV: 'CANOPY_E2E_SUPERVISED_RUN_NONCE',
      PROCESS_TREE_REFRESH_MS_ENV: 'CANOPY_E2E_TREE_REFRESH_MS',
      resolveProcessTreeRefreshInterval,
      SUPERVISOR_OWNER_PID_ENV: 'owner',
      WINDOWS_ADMISSION_EMISSION_ENV:
        'CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS',
      WINDOWS_CHILD_ARG: 'child',
      WINDOWS_TARGET_STARTED_MESSAGE: 'target-started',
      WINDOWS_TARGET_EXIT_MESSAGE: 'target-exit',
      WATCHDOG_TRACK_PID_MESSAGE: 'track-owned-pid',
      resolveSupervisorOwnerPid: () => 1000,
      fileURLToPath: () => '/supervisor.mjs',
      createWindowsBoundaryRecorder: () =>
        options.diagnostics === false ? undefined : (options.record ?? record),
      boundedError: (error) => ({
        error: { message: String(error?.message ?? error).slice(0, 512) },
      }),
      createSupervisorProcessTreeOwner: (wrapper, config) => {
        ownerOptions = config;
        if (options.createOwner) owner = options.createOwner(wrapper, config);
        return owner;
      },
      createPlatformProcessTreeOwner: (target, config) => {
        ownerOptions = config;
        if (options.createOwner) owner = options.createOwner(target, config);
        return owner;
      },
      parsePositivePid: (value) => Number(value),
      startParentLivenessWatch: ({ onParentExit }) => {
        parentExit = onParentExit;
        return { stop() {} };
      },
      startProcessTreeOwnerRefresh:
        options.startRefresh ?? (() => ({ stop() {} })),
      attachChildLifecycle,
      spawnWatchdog: () => undefined,
      releaseWindowsSupervisedChild:
        options.releaseLaunch ?? (async () => true),
      writeWindowsLaunchFailureEvidence() {},
    },
  );
  await fn(
    kind === 'watchdog'
      ? ['watchdog', '1000', '4321']
      : ['/owned/out-e2e/main/index.js'],
  );
  if (options.manual)
    return {
      child,
      host,
      records,
      order,
      sends,
      timers,
      deadlines,
      errors,
      parentExit,
      owner,
      ownerOptions,
      spawnCalls,
      at(value, deliver = true) {
        time = value;
        if (deliver)
          for (const timer of [...deadlines]) {
            if (timer.at <= time) {
              deadlines.delete(timer);
              timer.callback();
            }
          }
      },
    };
  if (kind === 'target') {
    host.emit('message', 'start');
    child.emit('spawn');
    child.emit('exit', 7, null);
    child.emit('close', 7, null);
  } else {
    child.emit('spawn');
    child.emit('message', { type: 'target-started', pid: 7654 });
    child.emit('message', { type: 'target-exit', code: 7, signal: null });
    await Promise.resolve();
    child.emit('exit', 7, null);
    assert.ok(!records.some((row) => row.stage === 'wrapper-stdio-close'));
    child.emit('close', 7, null);
    await Promise.resolve();
    host.emit('exit', 7);
  }
  return { records, order };
}

test('registered supervisor and target strip the inherited-stdio fixture flag from their children', async () => {
  const flag = 'CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE';
  for (const kind of ['supervisor', 'target']) {
    const f = await registeredBoundaryProducer(kind, {
      manual: true,
      env: { [flag]: '1' },
    });
    if (kind === 'target') f.host.emit('message', 'start');
    assert.equal(f.spawnCalls.length, 1);
    assert.equal(f.spawnCalls[0][2].env[flag], undefined);
    assert.equal(f.host.env[flag], '1');
  }
});

test('registered supervisor forwards an outer opt-in but consumes every selected close-boundary result', async () => {
  const flag = 'CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS';
  const outerRecord = () => undefined;
  const outer = await registeredBoundaryProducer('supervisor', {
    manual: true,
    record: outerRecord,
    env: { [flag]: '1' },
  });
  assert.equal(outer.spawnCalls[0][2].env[flag], '1');
  assert.equal(outer.ownerOptions.admissionEmission, undefined);

  for (const admissionEmission of [
    Object.freeze({
      status: 'ready',
      file: 'C:\\owned\\launch-admission-emission.jsonl',
    }),
    Object.freeze({
      status: 'unavailable',
      reason: 'exclusive-create-failed',
    }),
  ]) {
    const record = () => undefined;
    Object.defineProperty(record, 'admissionEmission', {
      value: admissionEmission,
    });
    const selected = await registeredBoundaryProducer('supervisor', {
      manual: true,
      record,
      env: { [flag]: '1' },
    });
    assert.equal(selected.spawnCalls[0][2].env[flag], undefined);
    assert.equal(
      selected.ownerOptions.admissionEmission,
      admissionEmission.status === 'ready' ? admissionEmission : undefined,
    );
  }
});

for (const state of ['owned-target', 'reused-root', 'reused-target'])
  test(`registered target tracking after wrapper loss fails closed: ${state}`, async () => {
    let snapshots = 0;
    const signals = [];
    const alive = new Set([5000, 5001]);
    const root = {
      pid: 4321,
      parentPid: 1,
      creationDate: WINDOWS_TEST_CREATION.wrapper,
    };
    const ownerChild = mockChild();
    const owner = createWindowsProcessTreeOwner(ownerChild, {
      listProcesses: async () => {
        snapshots++;
        if (snapshots === 1) return [root];
        if (snapshots === 2) exitMockChild(ownerChild);
        return [
          ...(state === 'reused-root'
            ? [
                {
                  ...root,
                  creationDate: WINDOWS_TEST_CREATION.reusedWrapper,
                },
              ]
            : []),
          {
            pid: 5000,
            parentPid: state === 'reused-target' ? 9999 : 4321,
            creationDate:
              state === 'reused-target'
                ? WINDOWS_TEST_CREATION.reusedTarget
                : WINDOWS_TEST_CREATION.target,
          },
          {
            pid: 5001,
            parentPid: 5000,
            creationDate: WINDOWS_TEST_CREATION.helper,
          },
        ];
      },
      isProcessAlive: (pid) => alive.has(pid),
      killProcessTree: async (pid, signal) => {
        signals.push([pid, signal]);
        alive.delete(pid);
      },
      graceMs: 0,
    });
    await owner.ready;
    const { child, host } = await registeredBoundaryProducer('parent', {
      manual: true,
      owner,
    });
    // Use the real supervisor's target-started handler. Its async refresh first
    // sees the target/helper only after the admitted wrapper has disappeared.
    child.emit('message', { type: 'target-started', pid: 5000 });
    await owner.refresh();
    child.emit('message', { type: 'target-exit', code: 0, signal: null });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(signals, [], 'late ambiguous PIDs must not be adopted');
    assert.equal(alive.size, 2);
    assert.equal(
      host.exitCode,
      125,
      'missing ownership checkpoint cannot be success',
    );
  });

test('connected Windows handlers retain wrapper through a fresh cleanup snapshot and reap its helper', async () => {
  const root = {
    pid: 4321,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const target = {
    pid: 5000,
    parentPid: 4321,
    creationDate: WINDOWS_TEST_CREATION.target,
  };
  const helper = {
    pid: 5001,
    parentPid: 5000,
    creationDate: WINDOWS_TEST_CREATION.helper,
  };
  const alive = new Map([[root.pid, root]]);
  const signals = [];
  let queries = 0,
    finishOld,
    finishFresh;
  const wrapper = await registeredBoundaryProducer('target', { manual: true });
  wrapper.host.pid = root.pid;
  wrapper.child.pid = target.pid;
  let refreshStopped = false;
  const polling = new Set();
  const parent = await registeredBoundaryProducer('parent', {
    manual: true,
    startRefresh: (options) => {
      const loop = startProcessTreeOwnerRefresh({
        ...options,
        setTimeoutFn: (callback) => {
          const timer = { callback };
          polling.add(timer);
          return timer;
        },
        clearTimeoutFn: (timer) => polling.delete(timer),
      });
      return {
        stop() {
          refreshStopped = true;
          loop.stop();
        },
      };
    },
    createOwner: (child, config) =>
      createWindowsProcessTreeOwner(child, {
        ...config,
        listProcesses: async () => {
          queries++;
          if (queries === 2)
            return new Promise((resolve) => {
              finishOld = resolve;
            });
          if (queries === 3)
            return new Promise((resolve) => {
              finishFresh = resolve;
            });
          return [...alive.values()];
        },
        isProcessAlive: (pid) => alive.has(pid),
        killProcessTree: async (pid, signal) => {
          signals.push([pid, signal]);
          alive.delete(pid);
        },
        graceMs: 0,
      }),
  });
  await parent.owner.ready;
  parent.child.send = (message, callback) => {
    wrapper.host.emit('message', message);
    callback?.();
  };
  wrapper.host.send = (message, callback) => {
    parent.child.emit('message', message);
    callback?.();
  };
  wrapper.host.disconnect = () => {
    wrapper.host.connected = false;
    alive.delete(root.pid);
    parent.child.emit('exit', wrapper.host.exitCode, null);
    parent.child.emit('close', wrapper.host.exitCode, null);
  };
  parent.child.emit('spawn');
  await Promise.resolve();
  wrapper.host.emit('message', 'start');
  alive.set(target.pid, target);
  wrapper.child.emit('spawn');
  assert.equal(queries, 2);
  const poll = [...polling][0];
  polling.delete(poll);
  const runningPoll = poll.callback();
  alive.set(helper.pid, helper);
  alive.delete(target.pid);
  wrapper.child.emit('exit', 0, null);
  wrapper.child.emit('close', 0, null);
  assert.equal(
    refreshStopped,
    true,
    'cleanup stops the scheduler synchronously',
  );
  assert.equal(
    wrapper.timers.size,
    1,
    'flushed terminal IPC must retain the wrapper',
  );
  finishOld([root, target]);
  await runningPoll;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polling.size, 0, 'the pending periodic tick cannot reschedule');
  assert.equal(queries, 3, 'the old snapshot is drained, never acknowledged');
  assert.equal(wrapper.timers.size, 1);
  finishFresh([...alive.values()]);
  await new Promise((resolve) => setImmediate(resolve));
  await parent.owner.stop();
  assert.equal(wrapper.timers.size, 0);
  assert.equal(wrapper.host.exitCode, 0);
  assert.equal(parent.host.exitCode, 0);
  assert.equal(alive.size, 0);
  assert.deepEqual(signals, [[5001, 'SIGTERM']]);
  assert.equal(
    queries,
    6,
    'old + fresh TERM + candidate revalidations + final verification',
  );
});

test('registered Windows release acknowledgement is ordered, bounded and fail closed', async () => {
  for (const mode of [
    'ack-first',
    'flush-first',
    'callback-error',
    'negative',
    'disconnect',
    'deadline',
    'late-ack',
    'send-throw',
    'already-disconnected',
  ]) {
    for (const code of [0, 7]) {
      const f = await registeredBoundaryProducer('target', { manual: true });
      f.host.emit('message', 'start');
      f.child.emit('exit', code, null);
      f.host.emit('message', {
        type: 'release-after-cleanup-snapshot',
        ready: true,
      });
      assert.equal(f.timers.size, 1);
      if (mode === 'send-throw')
        f.host.send = () => {
          throw new Error('send failed');
        };
      if (mode === 'already-disconnected') f.host.connected = false;
      f.child.emit('close', 99, null);
      const sent = f.sends.find(
        ({ message }) => message.type === 'target-exit',
      );
      if (mode === 'ack-first') {
        f.host.emit('message', {
          type: 'release-after-cleanup-snapshot',
          ready: true,
        });
        assert.equal(f.timers.size, 1);
        sent.callback();
      } else if (sent) {
        sent.callback(
          mode === 'callback-error' ? new Error('flush failed') : undefined,
        );
        if (mode === 'flush-first') {
          assert.equal(f.timers.size, 1);
          f.at(44999);
          f.host.emit('message', { type: 'unrelated', ready: true });
          assert.equal(f.timers.size, 1);
          f.host.emit('message', {
            type: 'release-after-cleanup-snapshot',
            ready: true,
          });
        } else if (mode === 'negative')
          f.host.emit('message', {
            type: 'release-after-cleanup-snapshot',
            ready: false,
          });
        else if (mode === 'disconnect') {
          f.host.connected = false;
          f.host.emit('disconnect');
        } else if (mode === 'deadline') {
          f.at(44999);
          assert.equal(f.timers.size, 1);
          f.at(45000);
        } else if (mode === 'late-ack') {
          f.at(45000, false);
          f.host.emit('message', {
            type: 'release-after-cleanup-snapshot',
            ready: true,
          });
        }
      }
      assert.equal(f.timers.size, 0, mode);
      assert.equal(f.deadlines.size, 0, mode);
      assert.equal(
        f.host.exitCode,
        code || (mode.endsWith('first') ? 0 : 125),
        mode,
      );
      f.host.emit('message', {
        type: 'release-after-cleanup-snapshot',
        ready: true,
      });
      sent?.callback();
      assert.equal(
        f.order.filter((stage) => stage === 'clear-interval').length,
        1,
      );
    }
  }
});

test('registered supervisor cannot restart ownership refresh or track late targets after cleanup entry', async () => {
  let finishLaunch,
    starts = 0,
    stops = 0,
    tracks = 0;
  const f = await registeredBoundaryProducer('parent', {
    manual: true,
    releaseLaunch: () =>
      new Promise((resolve) => {
        finishLaunch = resolve;
      }),
    startRefresh: () => {
      starts++;
      return {
        stop() {
          stops++;
        },
      };
    },
    owner: {
      stop: async () => {},
      trackOwnedPid: () => {
        tracks++;
      },
      refresh: async () => true,
    },
  });
  f.child.emit('spawn');
  f.child.emit('message', { type: 'target-exit', code: 0, signal: null });
  f.child.emit('message', { type: 'target-started', pid: 5000 });
  finishLaunch(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 0);
  assert.equal(stops, 0);
  assert.equal(tracks, 0);
});

test('Windows cleanup checkpoint retries a transiently unavailable snapshot before deciding', async () => {
  for (const mode of ['unavailable', 'reused-root', 'survivor']) {
    const decisions = [],
      signals = [];
    let queries = 0,
      alive = true;
    const root = { pid: 4321, parentPid: 1, creationDate: 'original' };
    const child = mockChild();
    const owner = createWindowsProcessTreeOwner(child, {
      onCleanupSnapshot: (ready) => decisions.push(ready),
      listProcesses: async () => {
        queries++;
        if (mode === 'unavailable' && queries === 2)
          throw new Error('snapshot failure');
        if (mode === 'reused-root' && queries > 1)
          return [{ ...root, creationDate: 'foreign' }];
        return alive ? [root] : [];
      },
      isProcessAlive: () => alive,
      killProcessTree: async (pid, signal) => {
        signals.push([pid, signal]);
        if (mode !== 'survivor') {
          alive = false;
          exitMockChild(child);
        }
      },
      graceMs: 0,
    });
    await owner.ready;
    if (mode === 'reused-root') exitMockChild(child);
    const stopping = owner.stop();
    assert.equal(owner.stop(), stopping);
    if (mode === 'survivor')
      await assert.rejects(stopping, /owned processes alive: 4321/);
    else await stopping;
    assert.deepEqual(decisions, [mode !== 'reused-root']);
    assert.equal(
      queries,
      { unavailable: 5, 'reused-root': 3, survivor: 6 }[mode],
    );
    assert.deepEqual(
      signals,
      mode === 'reused-root'
        ? []
        : mode === 'survivor'
          ? [
              [4321, 'SIGTERM'],
              [4321, 'SIGKILL'],
            ]
          : [[4321, 'SIGKILL']],
    );
  }
});

test('registered wrapper waits for close after parent loss and preserves signal failure', async () => {
  const f = await registeredBoundaryProducer('target', { manual: true });
  f.host.emit('message', 'start');
  f.host.connected = false;
  f.host.emit('disconnect');
  assert.equal(f.timers.size, 1);
  f.child.emit('exit', null, 'SIGTERM');
  assert.equal(f.timers.size, 1);
  f.child.emit('close', 0, null);
  assert.equal(f.host.exitCode, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.deadlines.size, 0);
});

test('registered supervisor propagates wrapper control failure after a successful checkpoint', async (t) => {
  for (const code of [0, 7]) {
    await t.test(
      `preserves target code ${code || 'zero as control failure'}`,
      async () => {
        let checkpointCount = 0;
        let acknowledgementCount = 0;
        const f = await registeredBoundaryProducer('parent', {
          manual: true,
          createOwner: (_child, config) => ({
            stop: async () => {
              checkpointCount++;
              config.onCleanupSnapshot(true);
            },
            trackOwnedPid() {},
            refresh: async () => true,
          }),
        });
        f.child.send = (message, callback) => {
          assert.equal(message.type, 'release-after-cleanup-snapshot');
          assert.equal(message.ready, true);
          acknowledgementCount++;
          callback();
        };
        f.child.emit('message', { type: 'target-exit', code, signal: null });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(checkpointCount, 1);
        assert.equal(acknowledgementCount, 1);
        f.child.emit('exit', 125, null);
        f.child.emit('close', 125, null);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.host.exitCode, code || 125);
        assert.equal(checkpointCount, 1, 'cleanup remains memoized');
        assert.deepEqual(f.errors, []);
      },
    );
  }
});

test('registered supervisor preserves failed release control even after shutdown selected success', async () => {
  for (const code of [0, 7]) {
    let finishAck;
    const f = await registeredBoundaryProducer('parent', {
      manual: true,
      createOwner: (_child, config) => ({
        stop: async () => config.onCleanupSnapshot(true),
        trackOwnedPid() {},
        refresh: async () => true,
      }),
    });
    f.child.send = (_message, callback) => {
      finishAck = callback;
    };
    f.child.emit('message', { type: 'target-exit', code, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.host.exitCode, code);
    finishAck(new Error('late acknowledgement failure'));
    assert.equal(f.host.exitCode, code || 125);
  }
});

test('registered Windows child releases only after target close and IPC flush', async () => {
  for (const code of [0, 7]) {
    const { child, host, records, order, sends, timers } =
      await registeredBoundaryProducer('target', { manual: true });
    host.emit('message', 'start');
    child.emit('spawn');
    child.emit('exit', code, null);
    assert.deepEqual(
      order,
      ['direct-target-spawn', 'target-started', 'direct-target-exit'],
      'target exit must not report completion before stdio close',
    );
    assert.equal(timers.size, 1);
    assert.equal(host.connected, true);
    child.emit('close', 99, null);
    assert.deepEqual(order.slice(-2), [
      'direct-target-stdio-close',
      'target-exit',
    ]);
    assert.equal(timers.size, 1, 'retain keepalive while IPC is flushing');
    const terminal = sends.find(
      ({ message }) => message.type === 'target-exit',
    );
    assert.equal(terminal.message.code, code, 'retain the first target result');
    terminal.callback();
    assert.equal(timers.size, 1, 'IPC flush alone cannot release ownership');
    host.emit('message', {
      type: 'release-after-cleanup-snapshot',
      ready: true,
    });
    assert.equal(timers.size, 0);
    assert.equal(host.connected, false);
    assert.equal(host.exitCode, code);
    assert.equal(records[0].targetPid, 4321);
    assert.equal(records[1].code, code);
    assert.ok(!order.some((stage) => stage.startsWith('process-exit-')));
  }
});

test('registered supervisor separates parent receipt, cleanup, wrapper exit, stdio close and supervisor exit', async () => {
  const { records, order } = await registeredBoundaryProducer('parent');
  for (const stage of [
    'target-started-received',
    'target-exit-received',
    'supervisor-cleanup',
    'wrapper-exit',
    'wrapper-stdio-close',
    'supervisor-exit',
  ])
    assert.ok(
      records.some((row) => row.stage === stage),
      stage,
    );
  assert.ok(order.indexOf('target-exit-received') < order.indexOf('cleanup'));
  assert.equal(order.filter((stage) => stage === 'cleanup').length, 1);
});

test('registered Windows child preserves errors and releases across IPC failure paths', async () => {
  for (const mode of [
    'callback-error',
    'send-throw',
    'disconnected',
    'disconnect-throw',
    'no-disconnect',
    'no-send',
  ]) {
    const { child, host, sends, timers, order, errors } =
      await registeredBoundaryProducer('target', { manual: true });
    host.emit('message', 'start');
    child.emit('error', new Error('original spawn failure'));
    child.emit('exit', 0, null);
    assert.equal(sends.length, 0);
    assert.equal(timers.size, 1);
    if (mode === 'send-throw')
      host.send = () => {
        throw new Error('send failed');
      };
    if (mode === 'disconnected') host.connected = false;
    if (mode === 'disconnect-throw')
      host.disconnect = () => {
        throw new Error('disconnect failed');
      };
    if (mode === 'no-disconnect') delete host.disconnect;
    if (mode === 'no-send') delete host.send;
    child.emit('close', 0, null);
    if (sends.length) {
      assert.equal(timers.size, 1);
      assert.equal(sends[0].message.code, 1);
      sends[0].callback(new Error('callback failure'));
      sends[0].callback();
    }
    assert.equal(timers.size, 0, mode);
    assert.equal(host.exitCode, 1, mode);
    assert.equal(order.filter((stage) => stage === 'clear-interval').length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /original spawn failure/);
    assert.ok(!order.some((stage) => stage.startsWith('process-exit-')));
    if (['disconnected', 'disconnect-throw', 'no-disconnect'].includes(mode))
      assert.ok(order.includes('channel-unref'));
  }
});

test('registered Windows child keeps the once-only prelaunch abort and start gate', async () => {
  const aborted = await registeredBoundaryProducer('target', { manual: true });
  aborted.host.emit('message', 'abort');
  assert.equal(aborted.timers.size, 0);
  assert.deepEqual(aborted.order, ['clear-interval', 'process-exit-1']);
  const started = await registeredBoundaryProducer('target', { manual: true });
  started.host.emit('message', 'start');
  started.host.emit('message', 'abort');
  assert.equal(started.timers.size, 1);
  started.child.emit('close', 0, null);
  started.sends[0].callback();
  started.host.emit('message', {
    type: 'release-after-cleanup-snapshot',
    ready: true,
  });
  assert.equal(started.host.exitCode, 0);
});

test('registered supervisor handles cleanup rejection after wrapper close and preserves target failure', async () => {
  for (const code of [0, 7]) {
    let rejectCleanup;
    let cleanups = 0;
    const cleanup = new Promise((_, reject) => {
      rejectCleanup = reject;
    });
    const { child, host, errors } = await registeredBoundaryProducer('parent', {
      manual: true,
      diagnostics: false,
      stop: () => {
        cleanups++;
        return cleanup;
      },
    });
    child.emit('message', { type: 'target-exit', code, signal: null });
    rejectCleanup(new Error('original cleanup verification failure'));
    // Exercise the interval before shutdown attaches its await, without a
    // diagnostic rejection handler accidentally hiding an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('exit', 0, null);
    assert.equal(host.exitCode, undefined);
    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.exitCode, code || 1);
    assert.equal(cleanups, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /original cleanup verification failure/);
  }
});

test('registered watchdog handles cleanup rejection once with a nonzero exit', async () => {
  let cleanups = 0;
  const { parentExit, host, errors, order, records, timers } =
    await registeredBoundaryProducer('watchdog', {
      manual: true,
      stop: async () => {
        cleanups++;
        throw new Error('watchdog cleanup verification failure');
      },
    });
  const stopping = parentExit();
  assert.equal(parentExit(), stopping);
  await stopping;
  host.emit('disconnect');
  await Promise.resolve();
  assert.equal(cleanups, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /watchdog cleanup verification failure/);
  assert.equal(timers.size, 0);
  assert.deepEqual(
    records.map(({ stage, outcome, cause, exitCode }) => ({
      stage,
      outcome,
      cause,
      exitCode,
    })),
    [
      {
        stage: 'initial-admission',
        outcome: 'fulfilled',
        cause: undefined,
        exitCode: undefined,
      },
      {
        stage: 'shutdown-cause',
        outcome: undefined,
        cause: 'parent-loss',
        exitCode: undefined,
      },
      {
        stage: 'owner-stop',
        outcome: 'entered',
        cause: undefined,
        exitCode: undefined,
      },
      {
        stage: 'shutdown-cause',
        outcome: undefined,
        cause: 'parent-loss',
        exitCode: undefined,
      },
      {
        stage: 'owner-stop',
        outcome: 'rejected',
        cause: undefined,
        exitCode: undefined,
      },
      {
        stage: 'watchdog-exit-selected',
        outcome: undefined,
        cause: undefined,
        exitCode: 1,
      },
      {
        stage: 'shutdown-cause',
        outcome: undefined,
        cause: 'disconnect',
        exitCode: undefined,
      },
    ],
  );
  assert.deepEqual(
    order.filter((stage) =>
      ['clear-interval', 'process-exit-1'].includes(stage),
    ),
    ['clear-interval', 'process-exit-1'],
  );
});

test('registered watchdog retires its admitted external PID only after authoritative absence', async () => {
  const root = {
    pid: 4321,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const unrelated = {
    pid: 9000,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.foreign,
  };
  const signals = [];
  let alive = true,
    capturedTarget,
    capturedConfig,
    queries = 0;
  const run = await registeredBoundaryProducer('watchdog', {
    manual: true,
    createOwner: (target, config) => {
      capturedTarget = target;
      capturedConfig = config;
      return createWindowsProcessTreeOwner(target, {
        ...config,
        listProcesses: async ({ filterPid, observe }) => {
          queries++;
          const rows = alive
            ? [root]
            : filterPid === undefined
              ? [unrelated]
              : [];
          observe?.({
            outcome: 'completed',
            outputState: 'completed',
            phases: {
              psReady: true,
              cimFirstRow: rows.length > 0,
              cimComplete: true,
            },
            protocolValid: true,
            validatedPhase: 'complete',
            acceptedCount: rows.length,
            rejectedCount: 0,
            rootCandidateCount: rows.filter(({ pid }) => pid === target.pid)
              .length,
            outputBytes: rows.length,
            stderrBytes: 0,
            stderrPresent: false,
          });
          return rows;
        },
        isProcessAlive: (pid) => pid === target.pid && alive,
        killProcessTree: async (pid, signal) => {
          signals.push([pid, signal]);
          alive = false;
        },
        graceMs: 0,
        delay: async () => undefined,
      });
    },
  });
  assert.equal(capturedTarget.pid, 4321);
  assert.deepEqual(Object.keys(capturedTarget), ['pid']);
  assert.equal('exitCode' in capturedTarget, false);
  assert.equal('signalCode' in capturedTarget, false);
  assert.equal(await run.owner.ready, true);

  await run.parentExit();

  assert.deepEqual(signals, [[4321, 'SIGTERM']]);
  assert.equal(queries, 4);
  assert.deepEqual(
    run.records
      .filter(({ stage }) => stage === 'final-verification')
      .map(({ outcome }) => outcome),
    ['entered', 'fulfilled'],
  );
  assert.deepEqual(
    run.order.filter((stage) =>
      ['clear-interval', 'process-exit-0', 'process-exit-1'].includes(stage),
    ),
    ['clear-interval', 'process-exit-0'],
  );
  assert.equal(capturedConfig.rootLifecycle, 'external-pid');
});

test('Windows root lifecycle role is closed and defaults to direct-child', async () => {
  for (const rootLifecycle of [null, false, true, 1, {}, 'watchdog'])
    assert.throws(
      () => createWindowsProcessTreeOwner(mockChild(), { rootLifecycle }),
      /Invalid Windows process root lifecycle/,
    );
  const child = mockChild();
  let rows = [
    {
      pid: child.pid,
      parentPid: 1,
      creationDate: WINDOWS_TEST_CREATION.wrapper,
    },
  ];
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => rows,
    isProcessAlive: () => true,
  });
  assert.equal(await owner.ready, true);
  rows = [];
  assert.equal(await owner.refresh(), false);
});

test('external PID exact pre-signal absence or reuse retires without signaling or revival', async (t) => {
  for (const reason of ['missing', 'identity-mismatch'])
    await t.test(reason, async () => {
      const child = { pid: 4321 },
        signals = [];
      const root = {
        pid: child.pid,
        parentPid: 1,
        creationDate: WINDOWS_TEST_CREATION.wrapper,
      };
      let queries = 0;
      const owner = createWindowsProcessTreeOwner(child, {
        rootLifecycle: 'external-pid',
        listProcesses: async ({ filterPid }) => {
          queries++;
          if (queries <= 2) return [root];
          if (queries === 3)
            return reason === 'missing'
              ? []
              : [
                  {
                    ...root,
                    creationDate: WINDOWS_TEST_CREATION.reusedWrapper,
                  },
                ];
          // Reappearance of the original identity cannot revive retirement.
          return filterPid === undefined ? [root] : [];
        },
        isProcessAlive: () => true,
        killProcessTree: async (pid, signal) => signals.push([pid, signal]),
        graceMs: 0,
        delay: async () => undefined,
      });
      assert.equal(await owner.ready, true);
      await owner.stop();
      assert.equal(queries, 4);
      assert.deepEqual(signals, []);
    });
});

test('external PID final verification rejects a surviving admitted identity', async () => {
  const child = { pid: 4321 },
    root = {
      pid: child.pid,
      parentPid: 1,
      creationDate: WINDOWS_TEST_CREATION.wrapper,
    },
    signals = [];
  let queries = 0;
  const owner = createWindowsProcessTreeOwner(child, {
    rootLifecycle: 'external-pid',
    listProcesses: async () => {
      queries++;
      return [root];
    },
    isProcessAlive: () => true,
    killProcessTree: async (pid, signal) => signals.push([pid, signal]),
    graceMs: 0,
    delay: async () => undefined,
  });
  assert.equal(await owner.ready, true);
  await assert.rejects(owner.stop(), /left owned processes alive/);
  assert.equal(queries, 6);
  assert.deepEqual(signals, [
    [4321, 'SIGTERM'],
    [4321, 'SIGKILL'],
  ]);
});

test('external PID final verification rejects unavailable or invalid enumeration', async (t) => {
  const root = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
  for (const failure of ['unavailable', 'malformed', 'incomplete', 'stderr'])
    await t.test(failure, async () => {
      let stopped = false;
      const signals = [];
      const implementation = await supervisorWithQueryIo({
        now: () => performance.now(),
        execFileAsync: async (_file, args) => {
          const exact = args.at(-1).includes('-Filter');
          if (!stopped || exact)
            return { stdout: rawWindowsProcessOutput([root]) };
          if (failure === 'unavailable') throw new Error('query unavailable');
          if (failure === 'malformed')
            return { stdout: rawWindowsProcessOutput(['4321\t1\t']) };
          if (failure === 'incomplete') return { stdout: 'phase=ps-ready\r\n' };
          return {
            stdout: rawWindowsProcessOutput([]),
            stderr: 'private enumeration failure',
          };
        },
      });
      const owner = implementation.createWindowsProcessTreeOwner(
        { pid: 4321 },
        {
          rootLifecycle: 'external-pid',
          isProcessAlive: () => !stopped,
          killProcessTree: async (pid, signal) => {
            signals.push([pid, signal]);
            stopped = true;
          },
          graceMs: 0,
          delay: async () => undefined,
        },
      );
      assert.equal(await owner.ready, true);
      await assert.rejects(owner.stop(), /verification unavailable/);
      assert.deepEqual(signals, [[4321, 'SIGTERM']]);
    });
});

test('external PID retirement preserves an identity-admitted late descendant', async () => {
  const child = { pid: 4321 };
  const root = {
    pid: child.pid,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const target = {
    pid: 5000,
    parentPid: child.pid,
    creationDate: WINDOWS_TEST_CREATION.target,
  };
  const descendant = {
    pid: 5001,
    parentPid: target.pid,
    creationDate: WINDOWS_TEST_CREATION.helper,
  };
  const alive = new Set([root.pid, target.pid, descendant.pid]),
    signals = [];
  let rows = [root];
  const owner = createWindowsProcessTreeOwner(child, {
    rootLifecycle: 'external-pid',
    listProcesses: async ({ filterPid }) =>
      rows.filter(({ pid }) => filterPid === undefined || pid === filterPid),
    isProcessAlive: (pid) => alive.has(pid),
    killProcessTree: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
      rows = rows.filter((row) => row.pid !== pid);
    },
    graceMs: 0,
    delay: async () => undefined,
  });
  assert.equal(await owner.ready, true);
  owner.trackOwnedPid(target.pid);
  rows = [root, target, descendant];
  assert.equal(await owner.refresh(), true);
  alive.delete(root.pid);
  rows = [target, descendant];

  await owner.stop();

  assert.deepEqual(signals, [
    [target.pid, 'SIGTERM'],
    [descendant.pid, 'SIGTERM'],
  ]);
  assert.deepEqual([...alive], []);
});

test('Windows refresh observation reports captured identity changes and failure without another process query', async () => {
  const child = mockChild();
  child.pid = 4321;
  let queries = 0;
  const records = [];
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      queries++;
      if (queries === 3) throw new Error('query unavailable');
      return [
        {
          pid: 4321,
          parentPid: 1,
          creationDate: queries === 1 ? 'original' : 'reused',
        },
      ];
    },
    observeRefresh: (value) => records.push(value),
    isProcessAlive: () => true,
  });
  await owner.ready;
  exitMockChild(child);
  await owner.refresh();
  await owner.refresh();
  assert.equal(queries, 3);
  assert.equal(records.length, 3);
  assert.equal(records[0].identities[0].status, 'matching');
  assert.equal(records[0].identities[0].creationIdentity, 'original');
  assert.equal(records[1].identities[0].status, 'retired');
  assert.equal(records[2].status, 'unavailable');
});

test('Windows owner passively reports existing enumerations, signals and final verification without extra operations', async () => {
  const child = mockChild(4321);
  const rows = [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }];
  const operations = [];
  const signals = [];
  let queries = 0;
  let alive = true;
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      queries++;
      return alive ? rows : [];
    },
    isProcessAlive: () => alive,
    killProcessTree: async (pid, signal) => {
      signals.push({ pid, signal });
      alive = false;
      exitMockChild(child);
    },
    observeOperation: (stage, details) =>
      operations.push({ stage, ...details }),
  });

  assert.equal(await owner.ready, true);
  await owner.stop();

  assert.equal(queries, 4);
  assert.deepEqual(signals, [{ pid: 4321, signal: 'SIGTERM' }]);
  assert.deepEqual(
    operations
      .filter(({ stage }) => stage === 'enumeration')
      .map(({ outcome, phase, queryId }) => [outcome, phase, queryId]),
    [
      ['entered', 'initial', 1],
      ['fulfilled', 'initial', 1],
      ['entered', 'cleanup-refresh', 2],
      ['fulfilled', 'cleanup-refresh', 2],
      ['entered', 'cleanup-refresh', 3],
      ['fulfilled', 'cleanup-refresh', 3],
      ['entered', 'final-verification', 4],
      ['fulfilled', 'final-verification', 4],
    ],
  );
  assert.deepEqual(
    operations
      .filter(({ stage }) => stage === 'signal')
      .map(({ outcome, pid, creationIdentity, signal }) => [
        outcome,
        pid,
        creationIdentity,
        signal,
      ]),
    [
      ['entered', 4321, 'wrapper-created', 'SIGTERM'],
      ['fulfilled', 4321, 'wrapper-created', 'SIGTERM'],
    ],
  );
  assert.deepEqual(
    operations
      .filter(({ stage }) => stage === 'final-verification')
      .map(({ outcome }) => outcome),
    ['entered', 'fulfilled'],
  );
});

test('Windows owner keeps original conditional awaits and reports a drained query by its existing ID', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('./process-tree-supervisor.mjs', import.meta.url),
    'utf8',
  );
  const ownerSource = source.slice(
    source.indexOf('export function createWindowsProcessTreeOwner('),
    source.indexOf(
      'function sendWindowsRelease(',
      source.indexOf('export function createWindowsProcessTreeOwner('),
    ),
  );
  assert.doesNotMatch(
    ownerSource,
    /async \(\) => \{\s*if \(!inFlightRefresh\) return;/,
  );
  assert.match(
    ownerSource,
    /if \(options\.onCleanupSnapshot && inFlightRefresh\) \{[\s\S]*?await inFlightRefresh;/,
  );
  assert.match(
    ownerSource,
    /if \(inFlightRefresh\) \{[\s\S]*?await inFlightRefresh;/,
  );

  const child = mockChild(4321);
  const operations = [];
  let queries = 0;
  let releaseRefresh;
  let alive = true;
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      queries++;
      if (queries === 2)
        return new Promise((resolve) => {
          releaseRefresh = () =>
            resolve([
              { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
            ]);
        });
      return alive
        ? [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }]
        : [];
    },
    isProcessAlive: () => alive,
    killProcessTree: async () => {
      alive = false;
      exitMockChild(child);
    },
    onCleanupSnapshot() {},
    observeOperation: (stage, details) =>
      operations.push({ stage, ...details }),
  });
  await owner.ready;
  const periodic = owner.refresh();
  while (!releaseRefresh) await Promise.resolve();
  const stopping = owner.stop();
  try {
    assert.equal(queries, 2);
    assert.deepEqual(
      operations
        .filter(({ stage }) =>
          ['enumeration-joined', 'in-flight-refresh'].includes(stage),
        )
        .map(({ stage, outcome, phase, queryId }) => [
          stage,
          outcome,
          phase,
          queryId,
        ]),
      [['in-flight-refresh', 'entered', undefined, 2]],
    );
  } finally {
    releaseRefresh();
  }
  await periodic;
  await stopping;
  assert.equal(
    operations.some(
      ({ stage, outcome, queryId }) =>
        stage === 'in-flight-refresh' &&
        outcome === 'fulfilled' &&
        queryId === 2,
    ),
    true,
  );
  assert.equal(
    operations.filter(({ stage }) => stage === 'enumeration-joined').length,
    0,
  );
});

test('Windows cleanup joining a pending periodic refresh reuses its query ID without another query', async () => {
  const child = mockChild(4321);
  const operations = [];
  let queries = 0;
  let releaseRefresh;
  let alive = true;
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      queries++;
      if (queries === 2)
        return new Promise((resolve) => {
          releaseRefresh = () =>
            resolve([
              { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
            ]);
        });
      return alive
        ? [{ pid: 4321, parentPid: 1, creationDate: 'wrapper-created' }]
        : [];
    },
    isProcessAlive: () => alive,
    killProcessTree: async () => {
      alive = false;
      exitMockChild(child);
    },
    observeOperation: (stage, details) =>
      operations.push({ stage, ...details }),
  });
  await owner.ready;
  const periodic = owner.refresh();
  while (!releaseRefresh) await Promise.resolve();
  const stopping = owner.stop();
  try {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.equal(queries, 2);
    assert.deepEqual(
      operations
        .filter(({ stage }) => stage === 'enumeration-joined')
        .map(({ phase, queryId }) => [phase, queryId]),
      [['cleanup-refresh', 2]],
    );
  } finally {
    releaseRefresh();
  }
  await periodic;
  await stopping;
  assert.equal(queries, 4);
});

test('Windows watchdog deadline allows the real owner grace before recording and rejecting at its fixture ceiling', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createWindowsBoundaryRecorder } =
    await import('./process-tree-supervisor.mjs');
  const root = mkdtempSync(join(tmpdir(), 'watchdog-deadline-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configuredFile = join(root, 'watchdog-main.jsonl');
  const producerFile = join(root, 'watchdog-watchdog-fixture.jsonl');
  const args = ['--canopy-process-tree-watchdog', '4001', '4002'];
  const record = createWindowsBoundaryRecorder(args, 'watchdog-fixture', {
    platform: 'win32',
    currentPid: 4000,
    parentPid: 4000,
    env: {
      CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
        file: configuredFile,
        mode: 'watchdog-test',
        caseId: 'watchdog-case',
        launchId: 'watchdog-launch',
        fixturePid: 4000,
        supervisorPid: 4001,
        targetPid: 4002,
      }),
    },
  });
  assert.equal(typeof record, 'function');
  const failure = new Error('watchdog did not exit after its supervisor');
  let nowMs = 0;
  let scheduled = [];
  const rejected = [];
  const deadline = createWatchdogDeadline({
    platform: 'win32',
    error: failure,
    record,
    supervisor: { exitCode: 0, signalCode: 'SIGTERM' },
    target: { exitCode: null, signalCode: null },
    watchdog: { exitCode: null, signalCode: null },
    setTimeoutFn: (handler, timeout) => {
      scheduled.push({ handler, deadlineMs: nowMs + timeout });
      return { unref() {} };
    },
    createPromise: (executor) =>
      new Promise((resolve, reject) =>
        executor(resolve, (error) => {
          const rows = readFileSync(producerFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          assert.equal(rows.at(-1).stage, 'watchdog-deadline');
          assert.equal(rows.at(-1).outcome, 'rejected');
          rejected.push(error);
          reject(error);
        }),
      ),
  });
  const deadlineSettled = deadline.catch((error) => error);
  const advanceBy = async (durationMs) => {
    nowMs += durationMs;
    const ready = scheduled.filter(({ deadlineMs }) => deadlineMs <= nowMs);
    scheduled = scheduled.filter(({ deadlineMs }) => deadlineMs > nowMs);
    for (const { handler } of ready) handler();
    await Promise.resolve();
  };

  await advanceBy(3_000);
  assert.deepEqual(rejected, []);
  await advanceBy(supervisorModule.SUPERVISOR_GRACE_MS);
  assert.deepEqual(rejected, []);
  assert.equal(scheduled[0].deadlineMs, 40_000);

  await advanceBy(40_000 - nowMs);
  assert.equal(await deadlineSettled, failure);
  assert.deepEqual(rejected, [failure]);
  const row = JSON.parse(readFileSync(producerFile, 'utf8').trim());
  assert.deepEqual(
    {
      stage: row.stage,
      outcome: row.outcome,
      exitCode: row.exitCode,
      signalCode: row.signalCode,
      lifecycle: row.lifecycle,
    },
    {
      stage: 'watchdog-deadline',
      outcome: 'rejected',
      exitCode: null,
      signalCode: null,
      lifecycle: {
        supervisorExited: true,
        targetExited: false,
        watchdogExited: false,
      },
    },
  );
});

test('non-Windows watchdog deadline retains the 3000 ms fixture budget', () => {
  let delay;
  const deadline = createWatchdogDeadline({
    platform: 'darwin',
    error: new Error('unused'),
    supervisor: { exitCode: null, signalCode: null },
    target: { exitCode: null, signalCode: null },
    watchdog: { exitCode: null, signalCode: null },
    setTimeoutFn: (_handler, timeout) => {
      delay = timeout;
      return { unref() {} };
    },
    createPromise: (executor) => {
      executor(
        () => undefined,
        () => undefined,
      );
      return 'deadline';
    },
  });

  assert.equal(deadline, 'deadline');
  assert.equal(delay, 3_000);
});

test('exited watchdog with pending close cannot block the original target emergency cleanup', async () => {
  let releaseClose;
  const watchdogClosed = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const calls = [];
  const supervisor = { exitCode: 0, signalCode: null };
  const watchdog = {
    exitCode: 0,
    signalCode: null,
    kill: () => calls.push('watchdog'),
  };
  const target = {
    exitCode: null,
    signalCode: null,
    kill: (signal) => calls.push(`target-${signal}`),
  };
  const cleanup = runWatchdogEmergencyCleanup({
    supervisor,
    target,
    watchdog,
    watchdogClosed,
    observe: (_action, operation) => operation(),
  });
  try {
    assert.deepEqual(calls, ['target-SIGTERM']);
  } finally {
    releaseClose(0);
    await cleanup;
  }
});

test('watchdog diagnostic directory failure remains inside the actual two-launch fixture wiring', () => {
  const launches = [];
  const { diagnosticDirectoryReady, supervisor, target } =
    launchWatchdogTestProcesses('/blocked', {
      platform: 'win32',
      mkdir: () => {
        throw new Error('directory denied');
      },
      execPath: '/node',
      spawnProcess: (...args) => {
        launches.push(args);
        return { pid: 5000 + launches.length };
      },
    });
  assert.equal(diagnosticDirectoryReady, false);
  assert.equal(supervisor.pid, 5001);
  assert.equal(target.pid, 5002);
  assert.deepEqual(
    launches.map(([, args, options]) => [args, options]),
    [
      [['-e', 'setInterval(() => undefined, 10_000)'], { stdio: 'ignore' }],
      [
        ['-e', 'setInterval(() => undefined, 10_000)'],
        { detached: true, stdio: 'ignore' },
      ],
    ],
  );
});

test('selected Windows observer rejects release paths, bounds changed states and samples only completed refresh events', async () => {
  const { createWindowsBoundaryRecorder } =
    await import('./process-tree-supervisor.mjs');
  const config = {
    file: '/owned/case-main.jsonl',
    mode: 'close',
    caseId: 'case',
    launchId: 'case-initial',
    fixturePid: 4,
  };
  const env = {
    CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify(config),
  };
  let now = 0;
  const writes = [];
  const options = {
    platform: 'win32',
    env,
    now: () => now,
    write: (file, line) => writes.push({ file, ...JSON.parse(line) }),
  };
  assert.equal(
    createWindowsBoundaryRecorder(
      ['/owned/out/main/index.js'],
      'supervisor',
      options,
    ),
    undefined,
  );
  assert.equal(
    createWindowsBoundaryRecorder(
      ['/owned/out-e2e/main/index.js'],
      'supervisor',
      { ...options, env: { ...env, CANOPY_E2E_ISOLATED_LOGGING: '1' } },
    ),
    undefined,
  );
  const record = createWindowsBoundaryRecorder(
    ['/owned/out-e2e/main/index.js'],
    'supervisor',
    options,
  );
  const identity = {
    status: 'completed',
    identities: [
      { pid: 4321, creationIdentity: 'created', status: 'matching' },
    ],
  };
  for (let i = 0; i < 180; i++) {
    record('ownership-refresh', identity);
    now += 1000;
  }
  assert.ok(writes.length <= 13);
  assert.ok(writes.every((row) => row.file === '/owned/case-supervisor.jsonl'));
  now = 180001;
  record('ownership-refresh', identity);
  assert.equal(writes.at(-1).stage, 'observer-expired');
  record('direct-target-exit');
  assert.equal(writes.at(-1).stage, 'observer-expired');
  now = 0;
  const changed = createWindowsBoundaryRecorder(
    ['/owned/out-e2e/main/index.js'],
    'windows-child',
    options,
  );
  for (let i = 0; i < 1000; i++)
    changed('ownership-refresh', { status: String(i) });
  assert.equal(writes.at(-1).stage, 'observer-truncated');
  const unavailable = createWindowsBoundaryRecorder(
    ['/owned/out-e2e/main/index.js'],
    'supervisor',
    {
      ...options,
      write: () => {
        throw new Error('denied');
      },
    },
  );
  assert.doesNotThrow(() => unavailable('wrapper-exit'));
});

test('watchdog-test observer requires the exact fixture-owned watchdog identity and stays bounded and nonthrowing', async () => {
  const { createWindowsBoundaryRecorder } =
    await import('./process-tree-supervisor.mjs');
  const config = {
    file: '/owned/watchdog-main.jsonl',
    mode: 'watchdog-test',
    caseId: 'watchdog-case',
    launchId: 'watchdog-launch',
    fixturePid: 4000,
    supervisorPid: 4001,
    targetPid: 4002,
  };
  const env = {
    CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify(config),
  };
  const args = ['--canopy-process-tree-watchdog', '4001', '4002'];
  const writes = [];
  const options = {
    platform: 'win32',
    currentPid: 4000,
    parentPid: 4000,
    env,
    write: (file, line) => writes.push({ file, ...JSON.parse(line) }),
  };

  assert.equal(
    createWindowsBoundaryRecorder(args, 'watchdog', {
      ...options,
      env: {},
    }),
    undefined,
  );
  assert.equal(
    createWindowsBoundaryRecorder(args, 'watchdog', {
      ...options,
      env: {
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: '{',
      },
    }),
    undefined,
  );
  assert.equal(
    createWindowsBoundaryRecorder(args, 'watchdog', {
      ...options,
      parentPid: 4999,
    }),
    undefined,
  );
  assert.equal(
    createWindowsBoundaryRecorder(
      ['--canopy-process-tree-watchdog', '4001', '4999'],
      'watchdog',
      options,
    ),
    undefined,
  );
  const record = createWindowsBoundaryRecorder(args, 'watchdog', options);
  assert.equal(typeof record, 'function');
  const fixtureRecord = createWindowsBoundaryRecorder(
    args,
    'watchdog-fixture',
    options,
  );
  assert.equal(typeof fixtureRecord, 'function');
  fixtureRecord('fixture-ready');
  assert.equal(writes.at(-1).file, '/owned/watchdog-watchdog-fixture.jsonl');
  for (let i = 0; i < 1000; i++) record('operation', { i });
  assert.equal(writes.at(-1).stage, 'observer-truncated');
  assert.ok(
    writes.filter(({ file }) => file === '/owned/watchdog-watchdog.jsonl')
      .length <= 256,
  );
  assert.deepEqual(
    new Set(writes.map(({ file }) => file)),
    new Set([
      '/owned/watchdog-watchdog.jsonl',
      '/owned/watchdog-watchdog-fixture.jsonl',
    ]),
  );
  const unavailable = createWindowsBoundaryRecorder(args, 'watchdog', {
    ...options,
    write: () => {
      throw new Error('denied');
    },
  });
  assert.doesNotThrow(() => unavailable('operation'));
});

test('completed Windows refresh distinguishes a retired target from its surviving owned descendant', async () => {
  const child = mockChild();
  child.pid = 4321;
  let queries = 0;
  const records = [];
  const wrapper = {
    pid: 4321,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const target = {
    pid: 4322,
    parentPid: 4321,
    creationDate: WINDOWS_TEST_CREATION.target,
  };
  const descendant = {
    pid: 4323,
    parentPid: 4322,
    creationDate: WINDOWS_TEST_CREATION.helper,
  };
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => {
      queries++;
      return queries === 1
        ? [wrapper]
        : queries === 2
          ? [wrapper, target, descendant]
          : [wrapper, descendant];
    },
    observeRefresh: (value) => records.push(value),
    isProcessAlive: (pid) => pid === 4323,
  });
  await owner.ready;
  owner.trackOwnedPid(4322);
  await owner.refresh();
  await owner.refresh();
  assert.equal(queries, 3);
  assert.equal(await owner.isAlive(), true);
  assert.equal(queries, 3);
  const targetEvidence = records
    .at(-1)
    .identities.find((identity) => identity.role === 'target');
  assert.equal(targetEvidence.creationIdentity, WINDOWS_TEST_CREATION.target);
  assert.equal(targetEvidence.present, false);
  assert.equal(targetEvidence.status, 'retired');
  assert.equal(records.at(-1).identities.length, 2);
});

function acceptanceRecorderFixture(overrides = {}) {
  const config = {
    mode: 'acceptance-command',
    file: path.resolve(
      '.playwright/browser-profiles/phase-3/windows-boundary-unit/unit-main.jsonl',
    ),
    caseId: 'windows-shard-1-of-4',
    launchId: 'unit-launch',
    fixturePid: 4000,
  };
  const args = [
    path.resolve('scripts/run-guarded-dev-script.mjs'),
    '--suite',
    'e2e',
    '--',
    process.execPath,
    path.resolve('node_modules/@playwright/test/cli.js'),
    'test',
    'browser-profiles.spec.mjs',
    'browser-chrome.spec.mjs',
    '--project=electron',
    '--fully-parallel',
    '--workers=1',
    '--shard',
    '1/4',
    '--reporter=line,json',
    '--retries=0',
    '--output=.playwright/windows-full-shard-1-of-4-results',
  ];
  const env = {
    CANOPY_E2E_SUPERVISED_EXECUTABLE: process.execPath,
    CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify(config),
  };
  const rows = [];
  let time = 0;
  const options = {
    platform: 'win32',
    parentPid: 4000,
    currentPid: 4001,
    env,
    now: () => time,
    write: (file, line) => {
      if (!file.endsWith('-ownership.jsonl')) rows.push(JSON.parse(line));
    },
    ...overrides,
  };
  return {
    args,
    config,
    env,
    rows,
    options,
    at: (value) => {
      time = value;
    },
  };
}

test('Windows inherited-stdio fixture selector requires its dedicated close envelope', () => {
  const outputRoot = path.resolve(
    '.playwright/browser-profiles/phase-3/windows-boundary-inherited-stdio-unit',
  );
  const config = {
    mode: 'close',
    file: path.join(outputRoot, 'unit-main.jsonl'),
    caseId: 'inherited-stdio',
    launchId: 'unit-launch',
    fixturePid: 4000,
  };
  const options = {
    platform: 'win32',
    currentPid: 4001,
    parentPid: 4000,
    env: {
      CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify(config),
      CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE: '1',
    },
    write() {},
  };
  const record = supervisorModule.createWindowsBoundaryRecorder(
    ['-e', 'process.stdout.write("fixture")'],
    'supervisor',
    options,
  );
  assert.equal(typeof record, 'function');
  assert.equal(typeof record.ownership, 'function');
  for (const producer of ['target', 'watchdog', 'watchdog-fixture'])
    assert.equal(
      supervisorModule.createWindowsBoundaryRecorder(
        ['-e', 'fixture'],
        producer,
        options,
      ),
      undefined,
    );
  for (const variant of [
    {
      env: {
        ...options.env,
        CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE: undefined,
      },
    },
    { parentPid: 4999 },
    {
      env: {
        ...options.env,
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
          ...config,
          file: '/outside/unit-main.jsonl',
        }),
      },
    },
    { env: { ...options.env, CANOPY_E2E_ISOLATED_LOGGING: '1' } },
    {
      env: {
        ...options.env,
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
          ...config,
          mode: 'setup',
        }),
      },
    },
  ])
    assert.equal(
      supervisorModule.createWindowsBoundaryRecorder(
        ['-e', 'process.stdout.write("fixture")'],
        'supervisor',
        { ...options, ...variant },
      ),
      undefined,
    );
  for (const args of [
    [],
    ['-e'],
    ['-e', 'fixture', '--foreign'],
    ['--foreign', 'fixture'],
  ])
    assert.equal(
      supervisorModule.createWindowsBoundaryRecorder(
        args,
        'supervisor',
        options,
      ),
      undefined,
    );
});

function acceptanceTimeoutFixtureArgs(f) {
  return [
    ...f.args.slice(0, 8),
    '--project=electron',
    '--fully-parallel',
    '--workers=1',
    '--grep',
    'acceptance controller owns and terminates its timeout fixture',
    '--reporter=line,json',
    '--retries=0',
    '--output=.playwright/windows-acceptance-controller-fixture-results',
  ];
}

function coworkWorkerDiagnosticRecorderFixture() {
  const fixture = acceptanceRecorderFixture();
  fixture.config = {
    ...fixture.config,
    caseId: 'w1-legacy-review-cowork',
  };
  fixture.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS = JSON.stringify(
    fixture.config,
  );
  fixture.args = acceptanceCommandArgs(path.resolve('.'), {
    shard: null,
    shardSuffix: null,
    commandKind: 'cowork-worker-failfast',
  });
  return fixture;
}

test('acceptance-command recorder admits only exact parent-owned guarded command shapes', () => {
  const f = acceptanceRecorderFixture();
  assert.equal(
    typeof supervisorModule.createWindowsBoundaryRecorder(
      f.args,
      'supervisor',
      f.options,
    ),
    'function',
  );
  for (const producer of ['windows-child', 'watchdog', 'watchdog-fixture'])
    assert.equal(
      supervisorModule.createWindowsBoundaryRecorder(
        f.args,
        producer,
        f.options,
      ),
      undefined,
    );
  assert.equal(
    supervisorModule.createWindowsBoundaryRecorder(f.args, 'supervisor', {
      ...f.options,
      parentPid: 4999,
    }),
    undefined,
  );
  for (const index of [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]) {
    const changed = [...f.args];
    changed[index] += '-foreign';
    assert.equal(
      supervisorModule.createWindowsBoundaryRecorder(
        changed,
        'supervisor',
        f.options,
      ),
      undefined,
      `argument ${index}`,
    );
  }
  assert.equal(
    supervisorModule.createWindowsBoundaryRecorder(
      [...f.args, '--config=foreign'],
      'supervisor',
      f.options,
    ),
    undefined,
  );
  for (const change of [
    { file: '/foreign/unit-main.jsonl' },
    { fixturePid: 4999 },
    { launchId: '../escape' },
    { file: 'relative-main.jsonl' },
  ])
    assert.equal(
      supervisorModule.createWindowsBoundaryRecorder(f.args, 'supervisor', {
        ...f.options,
        env: {
          ...f.env,
          CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
            ...f.config,
            ...change,
          }),
        },
      }),
      undefined,
    );
  const fixture = acceptanceTimeoutFixtureArgs(f);
  assert.equal(
    supervisorModule.createWindowsBoundaryRecorder(
      fixture,
      'supervisor',
      f.options,
    ),
    undefined,
  );
  assert.equal(
    typeof supervisorModule.createWindowsBoundaryRecorder(
      fixture,
      'supervisor',
      {
        ...f.options,
        env: { ...f.env, CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE: '1' },
      },
    ),
    'function',
  );

  const cowork = coworkWorkerDiagnosticRecorderFixture();
  const coworkRecord = supervisorModule.createWindowsBoundaryRecorder(
    cowork.args,
    'supervisor',
    cowork.options,
  );
  assert.equal(typeof coworkRecord, 'function');
  for (const [stage, details] of [
    ['target-started-received', { targetPid: 7654, wrapperPid: 4321 }],
    ['target-exit-received', { code: 0, signal: null }],
    ['supervisor-cleanup', { outcome: 'entered' }],
    ['cleanup-release-checkpoint', { ready: true }],
    ['supervisor-cleanup', { outcome: 'fulfilled' }],
    ['wrapper-exit', { code: 0, signal: null }],
    ['wrapper-stdio-close', { code: 0, signal: null }],
    ['supervisor-exit', { code: 0, signal: null }],
  ])
    coworkRecord(stage, details);
  assert.equal(
    parseAcceptanceSupervisorProof(
      cowork.rows.map((row) => JSON.stringify(row) + '\n').join(''),
      { ...cowork.config, supervisorPid: cowork.options.currentPid },
      { supervisorExitCode: 0 },
    ).status,
    'verified',
  );
  for (const [index, replacement, label] of [
    [7, 'browser-profiles.spec.mjs', 'spec'],
    [11, 'foreign title', 'title'],
    [9, '--workers=2', 'workers'],
    [13, '--max-failures=2', 'max-failures'],
    [16, '--retries=1', 'retries'],
    [17, '--output=.playwright/foreign-results', 'output'],
  ]) {
    const changed = [...cowork.args];
    changed[index] = replacement;
    assert.equal(
      supervisorModule.createWindowsBoundaryRecorder(
        changed,
        'supervisor',
        cowork.options,
      ),
      undefined,
      label,
    );
  }
  assert.equal(
    supervisorModule.createWindowsBoundaryRecorder(
      [...cowork.args, '--config=foreign'],
      'supervisor',
      cowork.options,
    ),
    undefined,
    'extra argument',
  );
});

test('acceptance-command recorder retains terminal proof beyond 180 seconds and expires at fixed 29 minutes', () => {
  const f = acceptanceRecorderFixture();
  const record = supervisorModule.createWindowsBoundaryRecorder(
    f.args,
    'supervisor',
    f.options,
  );
  assert.equal(typeof record, 'function');
  for (let i = 0; i < 1000; i++)
    record('ownership-refresh', { inventory: 'excluded' });
  assert.equal(f.rows.length, 0);
  f.at(180001);
  record('supervisor-cleanup', { outcome: 'entered' });
  f.at(28 * 60000);
  record('supervisor-cleanup', { outcome: 'fulfilled' });
  assert.deepEqual(
    f.rows.map((row) => row.outcome),
    ['entered', 'fulfilled'],
  );
  f.at(29 * 60000);
  record('ownership-refresh');
  record('supervisor-exit', { code: 0 });
  assert.equal(f.rows.at(-1).stage, 'observer-expired');
  assert.equal(f.rows.length, 3);
  for (const mode of ['close', 'watchdog-test']) {
    const old = acceptanceRecorderFixture();
    old.options.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS = JSON.stringify({
      ...old.config,
      mode,
      supervisorPid: 4002,
      targetPid: 4003,
    });
    const oldRecord = supervisorModule.createWindowsBoundaryRecorder(
      mode === 'close'
        ? ['/owned/out-e2e/main/index.js']
        : ['--canopy-process-tree-watchdog', '4002', '4003'],
      mode === 'close' ? 'supervisor' : 'watchdog',
      old.options,
    );
    old.at(180001);
    oldRecord('supervisor-exit');
    assert.equal(old.rows.at(-1).stage, 'observer-expired');
  }
});

test('cooperative parent cleanup shares the registered supervisor final-verification promise', async () => {
  let release,
    stops = 0;
  const finalVerification = new Promise((resolve) => {
    release = resolve;
  });
  const f = await registeredBoundaryProducer('supervisor', {
    manual: true,
    stop: () => {
      stops++;
      return finalVerification;
    },
  });
  for (const message of [
    null,
    {},
    { type: 'request-owned-cleanup', reason: 'other' },
    { type: 'request-owned-cleanup', reason: 'timeout', extra: true },
  ])
    f.host.emit('message', message);
  assert.equal(stops, 0);
  f.host.emit('message', { type: 'request-owned-cleanup', reason: 'timeout' });
  f.host.emit('message', {
    type: 'request-owned-cleanup',
    reason: 'interruption',
  });
  assert.equal(stops, 1);
  assert.deepEqual(
    f.records
      .filter((r) => r.stage === 'supervisor-cleanup')
      .map((r) => r.outcome),
    ['entered'],
  );
  assert.equal(
    f.records.filter((r) => r.stage === 'controller-stop-requested').length,
    1,
  );
  release();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    f.records
      .filter((r) => r.stage === 'supervisor-cleanup')
      .map((r) => r.outcome),
    ['entered', 'fulfilled'],
  );
  const failed = await registeredBoundaryProducer('supervisor', {
    manual: true,
    stop: async () => {
      throw new Error('final-verification unavailable');
    },
  });
  failed.host.emit('message', {
    type: 'request-owned-cleanup',
    reason: 'timeout',
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    failed.records
      .filter((r) => r.stage === 'supervisor-cleanup')
      .map((r) => r.outcome),
    ['entered', 'rejected'],
  );
  assert.notEqual(failed.host.exitCode, 0);
});

function assertOwnershipWireStream(rows) {
  const first = rows[0];
  const ownershipStages = new Set([
    'armed',
    'target-started-received',
    'controller-stop-requested',
    'enumeration',
    'enumeration-joined',
    'in-flight-refresh',
    'ownership-refresh',
    'signal',
    'cleanup-release-checkpoint',
    'target-exit-received',
    'wrapper-exit',
    'wrapper-stdio-close',
    'supervisor-cleanup',
    'final-verification',
    'final-result',
    'supervisor-exit',
    'observer-expired',
    'observer-truncated',
    'summary',
  ]);
  assert.equal(
    rows.every(
      (row, index) =>
        row.schemaVersion === 1 &&
        row.producer === 'ownership' &&
        row.caseId === first.caseId &&
        row.launchId === first.launchId &&
        row.fixturePid === first.fixturePid &&
        row.pid === first.pid &&
        row.parentPid === first.parentPid &&
        row.sequence === index + 1 &&
        ownershipStages.has(row.stage),
    ),
    true,
    'the strict workflow consumer must accept a real signal-bearing stream',
  );
}

test('ownership sidecar receives actual registered supervisor cleanup and final survivor identities', async () => {
  const files = new Map();
  const fixture = acceptanceRecorderFixture({
    write: (file, line) => files.set(file, (files.get(file) ?? '') + line),
  });
  const record = supervisorModule.createWindowsBoundaryRecorder(
    fixture.args,
    'supervisor',
    fixture.options,
  );
  let queries = 0;
  const signals = [];
  const f = await registeredBoundaryProducer('supervisor', {
    manual: true,
    record,
    createOwner: (child, config) =>
      createWindowsProcessTreeOwner(child, {
        ...config,
        listProcesses: async ({ filterPid }) => {
          queries++;
          return filterWindowsSnapshot(
            [
              { pid: 4321, parentPid: 1, creationDate: 'wrapper-created' },
              { pid: 7654, parentPid: 4321, creationDate: 'target-created' },
            ],
            filterPid,
          );
        },
        isProcessAlive: () => true,
        killProcessTree: async (pid, signal) => signals.push([pid, signal]),
        graceMs: 0,
        delay: async () => {},
      }),
  });
  await f.owner.ready;
  f.child.emit('message', { type: 'target-started', pid: 7654 });
  await f.owner.refresh();
  f.host.emit('message', { type: 'request-owned-cleanup', reason: 'timeout' });
  await assert.rejects(f.owner.stop(), /7654, 4321/);
  await Promise.resolve();
  f.child.emit('exit', 1, null);
  f.child.emit('close', 1, null);
  await Promise.resolve();
  f.host.emit('exit', 1);
  assert.ok(queries > 0);
  assert.equal(signals.length, 4);
  const sidecar =
    files.get(fixture.config.file.replace('-main.jsonl', '-ownership.jsonl')) ??
    '';
  assert.ok(
    sidecar.length > 0,
    'selected supervisor must write separate ownership diagnostics',
  );
  const rows = sidecar.trim().split('\n').map(JSON.parse);
  const first = rows[0];
  assertOwnershipWireStream(rows);
  assert.deepEqual(
    rows
      .filter((row) => row.stage === 'signal')
      .map(({ pid, signaledPid, creationIdentity, signal, outcome }) => ({
        pid,
        signaledPid,
        creationIdentity,
        signal,
        outcome,
      })),
    [
      {
        pid: first.pid,
        signaledPid: 7654,
        creationIdentity: 'target-created',
        signal: 'SIGTERM',
        outcome: 'entered',
      },
      {
        pid: first.pid,
        signaledPid: 7654,
        creationIdentity: 'target-created',
        signal: 'SIGTERM',
        outcome: 'fulfilled',
      },
      {
        pid: first.pid,
        signaledPid: 4321,
        creationIdentity: 'wrapper-created',
        signal: 'SIGTERM',
        outcome: 'entered',
      },
      {
        pid: first.pid,
        signaledPid: 4321,
        creationIdentity: 'wrapper-created',
        signal: 'SIGTERM',
        outcome: 'fulfilled',
      },
      {
        pid: first.pid,
        signaledPid: 7654,
        creationIdentity: 'target-created',
        signal: 'SIGKILL',
        outcome: 'entered',
      },
      {
        pid: first.pid,
        signaledPid: 7654,
        creationIdentity: 'target-created',
        signal: 'SIGKILL',
        outcome: 'fulfilled',
      },
      {
        pid: first.pid,
        signaledPid: 4321,
        creationIdentity: 'wrapper-created',
        signal: 'SIGKILL',
        outcome: 'entered',
      },
      {
        pid: first.pid,
        signaledPid: 4321,
        creationIdentity: 'wrapper-created',
        signal: 'SIGKILL',
        outcome: 'fulfilled',
      },
    ],
  );
  assert.deepEqual(rows.find((r) => r.stage === 'final-result').survivors, [
    { pid: 7654, creationIdentity: 'target-created' },
    { pid: 4321, creationIdentity: 'wrapper-created' },
  ]);
  assert.equal(rows.at(-1).stage, 'summary');
  assert.equal(rows.at(-1).finalResult, 'survivors');
  assert.equal(rows.at(-1).completeObservation, false);
  assert.equal(rows.at(-1).terminalObserved, true);
});

test('ownership sidecar omits stale-parent signals and survivors while preserving later-descendant evidence', async () => {
  const files = new Map();
  const fixture = acceptanceRecorderFixture({
    write: (file, line) => files.set(file, (files.get(file) ?? '') + line),
  });
  const record = supervisorModule.createWindowsBoundaryRecorder(
    fixture.args,
    'supervisor',
    fixture.options,
  );
  const wrapper = {
    pid: 4321,
    parentPid: 1,
    creationDate: '2026-09-15T21:35:25.7621080Z',
  };
  const target = {
    pid: 6444,
    parentPid: wrapper.pid,
    creationDate: '2026-09-15T21:35:28.3971620Z',
  };
  const staleParent = {
    pid: 7300,
    parentPid: target.pid,
    creationDate: '2026-09-15T21:26:12.8317110Z',
  };
  const staleDescendant = {
    pid: 7344,
    parentPid: staleParent.pid,
    creationDate: '2026-09-15T21:26:12.8441860Z',
  };
  const laterDescendant = {
    pid: 7500,
    parentPid: target.pid,
    creationDate: '2026-09-15T21:35:29.0000000Z',
  };
  const processRows = [
    wrapper,
    target,
    staleParent,
    staleDescendant,
    laterDescendant,
  ];
  const run = await registeredBoundaryProducer('supervisor', {
    manual: true,
    record,
    createOwner: (child, config) =>
      createWindowsProcessTreeOwner(child, {
        ...config,
        listProcesses: async ({ filterPid }) =>
          filterWindowsSnapshot(processRows, filterPid),
        isProcessAlive: () => true,
        killProcessTree: async () => undefined,
        graceMs: 0,
        delay: async () => undefined,
      }),
  });

  assert.equal(await run.owner.ready, true);
  run.child.emit('message', { type: 'target-started', pid: target.pid });
  await run.owner.refresh();
  run.host.emit('message', {
    type: 'request-owned-cleanup',
    reason: 'timeout',
  });
  await assert.rejects(run.owner.stop(), /Windows process cleanup/);
  await Promise.resolve();

  const sidecar =
    files.get(fixture.config.file.replace('-main.jsonl', '-ownership.jsonl')) ??
    '';
  const rows = sidecar.trim().split('\n').map(JSON.parse);
  const signalRows = rows.filter((row) => row.stage === 'signal');
  assert.deepEqual(
    signalRows
      .filter((row) => row.signaledPid === laterDescendant.pid)
      .map(({ signal, outcome }) => [signal, outcome]),
    [
      ['SIGTERM', 'entered'],
      ['SIGTERM', 'fulfilled'],
      ['SIGKILL', 'entered'],
      ['SIGKILL', 'fulfilled'],
    ],
  );
  assert.equal(
    signalRows.some(
      (row) =>
        row.signaledPid === staleParent.pid ||
        row.signaledPid === staleDescendant.pid,
    ),
    false,
  );
  const finalResult = rows.find((row) => row.stage === 'final-result');
  assert.deepEqual(
    finalResult.survivors
      .map(({ pid }) => pid)
      .sort((left, right) => left - right),
    [wrapper.pid, target.pid, laterDescendant.pid].sort(
      (left, right) => left - right,
    ),
  );
  assert.equal(
    finalResult.survivors.some(
      ({ pid }) => pid === staleParent.pid || pid === staleDescendant.pid,
    ),
    false,
  );
});

function ownershipFixture({
  mode = 'acceptance-command',
  failAt = Infinity,
} = {}) {
  const lines = [],
    proof = [];
  let attempts = 0;
  const f = acceptanceRecorderFixture({
    write: (file, line) => {
      if (file.endsWith('-ownership.jsonl')) {
        if (++attempts === failAt) throw new Error('private write failure');
        lines.push(line);
      } else proof.push(line);
    },
  });
  f.options.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS = JSON.stringify({
    ...f.config,
    mode,
  });
  const record = supervisorModule.createWindowsBoundaryRecorder(
    mode === 'close' ? ['/owned/out-e2e/main/index.js'] : f.args,
    'supervisor',
    f.options,
  );
  return {
    ...f,
    record,
    observe: record.ownership,
    lines,
    proof,
    rows: () => lines.map(JSON.parse),
    attempts: () => attempts,
  };
}

function finishOwnership(f, resultKind = 'verified-empty', survivors = []) {
  f.observe('final-result', {
    resultKind,
    survivorCount: survivors.length,
    survivors,
  });
  f.observe('supervisor-cleanup', { outcome: 'fulfilled' });
  f.observe('supervisor-exit', { code: 0 });
}

test('ownership sidecar preserves proof bytes and the unchanged real proof parser', async (t) => {
  t.mock.method(
    Date.prototype,
    'toISOString',
    () => '2026-09-15T00:00:00.000Z',
  );
  t.mock.method(process.hrtime, 'bigint', () => 123n);
  const enabled = ownershipFixture(),
    disabled = ownershipFixture({ failAt: 1 });
  for (const f of [enabled, disabled]) {
    for (const [stage, details] of [
      ['target-started-received', { targetPid: 7654, wrapperPid: 4321 }],
      ['target-exit-received', { targetPid: 7654, code: 0, signal: null }],
      ['supervisor-cleanup', { outcome: 'entered' }],
      ['cleanup-release-checkpoint', { ready: true }],
      ['supervisor-cleanup', { outcome: 'fulfilled' }],
      ['wrapper-exit', { code: 0, signal: null }],
      ['wrapper-stdio-close', { code: 0, signal: null }],
      ['supervisor-exit', { code: 0 }],
    ]) {
      f.record(stage, details);
      f.observe(stage, details);
      f.observe('enumeration', {
        phase: 'cleanup-refresh',
        queryId: 1,
        outcome: 'entered',
      });
    }
  }
  assert.equal(enabled.proof.join(''), disabled.proof.join(''));
  assert.ok(enabled.lines.length > 0);
  const { parseAcceptanceSupervisorProof } =
    await import('./run-browser-profile-acceptance-command.mjs');
  const identity = { ...enabled.config, supervisorPid: 4001 };
  assert.equal(
    parseAcceptanceSupervisorProof(enabled.proof.join(''), identity, {
      supervisorExitCode: 0,
    }).status,
    'verified',
  );
  const bad = JSON.parse(enabled.proof[0]);
  bad.stage = 'enumeration';
  assert.match(
    parseAcceptanceSupervisorProof(
      JSON.stringify(bad) + '\n' + enabled.proof.join(''),
      identity,
    ).error,
    /Unexpected supervisor stage/,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(enabled.record, 'ownership').enumerable,
    false,
  );
});

test('ownership sidecar selection stays narrow while legacy close selection stays unchanged', () => {
  const f = acceptanceRecorderFixture();
  const create = (
    config = f.config,
    options = {},
    args = f.args,
    producer = 'supervisor',
  ) =>
    supervisorModule.createWindowsBoundaryRecorder(args, producer, {
      ...f.options,
      ...options,
      env: {
        ...f.env,
        ...options.env,
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS:
          typeof config === 'string' ? config : JSON.stringify(config),
      },
    });
  assert.equal(typeof create().ownership, 'function');
  for (const config of [
    '{',
    '',
    ' '.repeat(4097),
    { ...f.config, file: '/outside/unit-main.jsonl' },
    { ...f.config, fixturePid: 5000 },
    { ...f.config, launchId: 'bad/identity' },
    { ...f.config, file: f.config.file.replace('-main', '-other') },
  ])
    assert.equal(create(config), undefined);
  for (const options of [
    { platform: 'darwin' },
    { parentPid: 5000 },
    { env: { CANOPY_E2E_SUPERVISED_EXECUTABLE: '/wrong' } },
  ])
    assert.equal(create(f.config, options), undefined);
  assert.equal(create(f.config, {}, [...f.args, '--foreign']), undefined);
  assert.equal(create(f.config, {}, f.args, 'windows-child'), undefined);
  const close = { ...f.config, mode: 'close' };
  assert.equal(
    typeof create(close, {}, ['/owned/out-e2e/main/index.js']).ownership,
    'function',
  );
  for (const producer of ['windows-child', 'watchdog', 'watchdog-fixture'])
    assert.equal(
      create(close, {}, ['/owned/out-e2e/main/index.js'], producer).ownership,
      undefined,
    );
  assert.equal(create(close, {}, ['/owned/out/main/index.js']), undefined);
  assert.equal(
    create(close, { env: { CANOPY_E2E_ISOLATED_LOGGING: '1' } }, [
      '/owned/out-e2e/main/index.js',
    ]),
    undefined,
  );
  for (const file of [
    '/outside/unit-main.jsonl',
    path.resolve('.playwright/browser-profiles/phase-3/../escape-main.jsonl'),
    '/' + 'x'.repeat(1100) + '-main.jsonl',
  ]) {
    const record = create({ ...close, file }, {}, [
      '/owned/out-e2e/main/index.js',
    ]);
    assert.equal(typeof record, 'function');
    assert.equal(record.ownership, undefined);
  }
  const fixture = acceptanceTimeoutFixtureArgs(f);
  assert.equal(
    typeof create(
      f.config,
      { env: { CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE: '1' } },
      fixture,
    ).ownership,
    'function',
  );
});

test('admission emission activation belongs only to the selected close supervisor and consumes selection despite exclusive-create failure', () => {
  const outputRoot = path.resolve(
    '.playwright/browser-profiles/phase-3/windows-emission-unit',
  );
  const config = {
    mode: 'close',
    file: path.join(outputRoot, 'unit-main.jsonl'),
    caseId: 'large-inventory',
    launchId: 'large-inventory-initial',
    fixturePid: 4000,
  };
  const created = [];
  const make = ({
    producer = 'supervisor',
    platform = 'win32',
    mode = 'close',
    flag = '1',
    file = config.file,
    createEmissionFile = (emissionFile) => created.push(emissionFile),
  } = {}) =>
    supervisorModule.createWindowsBoundaryRecorder(
      ['/owned/out-e2e/main/index.js'],
      producer,
      {
        platform,
        currentPid: 4001,
        parentPid: 4000,
        env: {
          CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS: flag,
          CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
            ...config,
            mode,
            file,
          }),
        },
        write() {},
        createEmissionFile,
      },
    );

  const selected = make();
  assert.equal(created.length, 1);
  assert.equal(
    created[0],
    path.join(outputRoot, 'unit-admission-emission.jsonl'),
  );
  assert.deepEqual(selected.admissionEmission, {
    status: 'ready',
    file: created[0],
  });
  assert.equal(
    Object.getOwnPropertyDescriptor(selected, 'admissionEmission').enumerable,
    false,
  );
  assert.equal(Object.isFrozen(selected.admissionEmission), true);

  const refused = [
    make({ flag: 'true' }),
    make({ producer: 'windows-child' }),
    make({ platform: 'darwin' }),
    make({ mode: 'acceptance-command' }),
    make({ file: '/outside/unit-main.jsonl' }),
  ];
  assert.ok(refused.every((record) => record?.admissionEmission === undefined));
  assert.equal(created.length, 1);

  const exclusiveFailure = make({
    createEmissionFile: () => {
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    },
  });
  assert.deepEqual(exclusiveFailure.admissionEmission, {
    status: 'unavailable',
    reason: 'exclusive-create-failed',
  });
});

test('acceptance-command admission emission binds only exact production and timeout queries', async (t) => {
  for (const commandKind of ['production-shard', 'owned-timeout-fixture']) {
    await t.test(commandKind, async () => {
      const created = [];
      const f = acceptanceRecorderFixture({
        createEmissionFile: (file) => created.push(file),
      });
      f.options.env.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS = '1';
      const args =
        commandKind === 'production-shard'
          ? f.args
          : acceptanceTimeoutFixtureArgs(f);
      if (commandKind === 'owned-timeout-fixture')
        f.options.env.CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE = '1';

      const record = supervisorModule.createWindowsBoundaryRecorder(
        args,
        'supervisor',
        f.options,
      );
      const emissionFile = f.config.file.replace(
        /-main\.jsonl$/,
        '-admission-emission.jsonl',
      );
      assert.deepEqual(created, [emissionFile]);
      assert.deepEqual(record.admissionEmission, {
        status: 'ready',
        file: emissionFile,
      });
      assert.deepEqual(
        f.rows.map(({ stage, outcome }) => ({ stage, outcome })),
        [{ stage: 'admission-emission-setup', outcome: 'ready' }],
      );

      const query = initialQueryFixture();
      const implementation = await supervisorWithQueryIo(query.io);
      startInitialQuery(
        query,
        { admissionEmission: record.admissionEmission },
        implementation,
      );
      query.stdout('phase=ps-ready\n');
      query.complete();
      query.close();
      assert.equal(await query.released, true);
      assert.deepEqual(query.messages, ['start']);
      assert.equal(query.requests.length, 1);
      assert.match(query.requests[0][1].at(-1), /AppendAllText/);
      assert.match(
        query.requests[0][1].at(-1),
        /unit-admission-emission\.jsonl/,
      );
      assert.equal(
        JSON.stringify(
          query.owner.getInitialDiagnosticSnapshot().enumeration.budgets,
        ),
        JSON.stringify({
          startupMs: 15000,
          completionMs: 15000,
          lifetimeMs: 30000,
          terminationMs: 1000,
        }),
      );
    });
  }

  const defaultOff = acceptanceRecorderFixture({
    createEmissionFile: () => assert.fail('default acceptance must stay off'),
  });
  const defaultRecord = supervisorModule.createWindowsBoundaryRecorder(
    defaultOff.args,
    'supervisor',
    defaultOff.options,
  );
  assert.equal(defaultRecord.admissionEmission, undefined);
  assert.deepEqual(defaultOff.rows, []);

  const unavailable = acceptanceRecorderFixture({
    createEmissionFile: () => {
      throw new Error('observer unavailable');
    },
  });
  unavailable.options.env.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS =
    '1';
  const unavailableRecord = supervisorModule.createWindowsBoundaryRecorder(
    unavailable.args,
    'supervisor',
    unavailable.options,
  );
  assert.deepEqual(unavailableRecord.admissionEmission, {
    status: 'unavailable',
    reason: 'exclusive-create-failed',
  });
  assert.deepEqual(
    unavailable.rows.map(({ stage, outcome }) => ({ stage, outcome })),
    [{ stage: 'admission-emission-setup', outcome: 'unavailable' }],
  );
  const ordinary = initialQueryFixture();
  startInitialQuery(
    ordinary,
    { admissionEmission: unavailableRecord.admissionEmission },
    await supervisorWithQueryIo(ordinary.io),
  );
  ordinary.stdout('phase=ps-ready\n');
  ordinary.complete();
  ordinary.close();
  assert.equal(await ordinary.released, true);
  assert.deepEqual(ordinary.messages, ['start']);
  assert.equal(
    ordinary.requests[0][1].at(-1),
    buildWindowsProcessTreeListScript(4321),
  );
});

test('invalid derived emission paths stay selected but run the ordinary initial query', async (t) => {
  const outputRoot = path.resolve(
    '.playwright/browser-profiles/phase-3/windows-emission-round1-unit',
  );
  const suffix = '-main.jsonl';
  const longMainFile =
    outputRoot +
    path.sep +
    'x'.repeat(1024 - outputRoot.length - path.sep.length - suffix.length) +
    suffix;
  assert.equal(longMainFile.length, 1024);
  const cases = [
    ['derived path exceeds 1024 characters', longMainFile],
    [
      'derived path contains DEL',
      path.join(outputRoot, `unit-${String.fromCharCode(127)}${suffix}`),
    ],
  ];

  for (const [label, mainFile] of cases) {
    await t.test(label, async () => {
      const createAttempts = [];
      const record = supervisorModule.createWindowsBoundaryRecorder(
        ['/owned/out-e2e/main/index.js'],
        'supervisor',
        {
          platform: 'win32',
          currentPid: 4001,
          parentPid: 4000,
          env: {
            CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS: '1',
            CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
              mode: 'close',
              file: mainFile,
              caseId: 'large-inventory',
              launchId: 'large-inventory-initial',
              fixturePid: 4000,
            }),
          },
          write() {},
          createEmissionFile: (file) => createAttempts.push(file),
        },
      );
      assert.equal(typeof record, 'function');

      const f = initialQueryFixture();
      const implementation = await supervisorWithQueryIo(f.io);
      const owner = implementation.createSupervisorProcessTreeOwner(f.wrapper, {
        useWindowsLaunchGate: true,
        ...f.io,
        admissionEmission: record.admissionEmission,
      });
      const released = implementation.releaseWindowsSupervisedChild(
        f.wrapper,
        owner,
      );
      f.stdout('phase=ps-ready\n');
      f.complete();
      f.close();

      assert.equal(await released, true);
      assert.deepEqual(f.messages, ['start']);
      assert.deepEqual(record.admissionEmission, {
        status: 'unavailable',
        reason: 'invalid-derived-path',
      });
      assert.deepEqual(createAttempts, []);
      assert.equal(f.requests.length, 1);
      assert.equal(
        f.requests[0][1].at(-1),
        buildWindowsProcessTreeListScript(4321),
      );
      assert.equal(
        JSON.stringify(f.requests[0][2]),
        JSON.stringify({
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      assert.equal(
        'queryPid' in owner.getInitialDiagnosticSnapshot().enumeration,
        false,
      );
    });
  }
});

test('ownership sidecar suppresses long precleanup polling and reserves terminal evidence after saturation', () => {
  const f = ownershipFixture();
  for (let queryId = 1; queryId <= 1000; queryId++) {
    for (const outcome of ['entered', 'fulfilled'])
      f.observe('enumeration', {
        phase: queryId === 1 ? 'initial' : 'periodic',
        queryId,
        outcome,
      });
    f.observe('ownership-refresh', {
      status: 'completed',
      identities: [
        {
          pid: 4321,
          creationIdentity: 'root',
          present: true,
          status: 'matching',
        },
      ],
    });
  }
  assert.equal(f.rows().filter((r) => r.stage === 'enumeration').length, 2);
  assert.equal(
    f.rows().filter((r) => r.stage === 'ownership-refresh').length,
    1,
  );
  assert.ok(f.lines.length <= 24);
  f.observe('supervisor-cleanup', { outcome: 'entered' });
  for (let i = 0; i < 1000; i++)
    f.observe('signal', {
      pid: 4321,
      creationIdentity: 'root',
      signal: 'SIGTERM',
      outcome: 'fulfilled',
    });
  finishOwnership(f);
  const rows = f.rows(),
    summary = rows.at(-1);
  assert.equal(rows.filter((r) => r.stage === 'observer-truncated').length, 1);
  assert.equal(summary.stage, 'summary');
  assert.equal(summary.terminalObserved, true);
  assert.equal(summary.completeObservation, false);
  assert.ok(summary.counters.suppressed > 1000);
  assert.ok(summary.counters.dropped > 0);
  assert.ok(rows.length <= 240);
  assert.ok(Buffer.byteLength(f.lines.join('')) <= 128 * 1024);
  assert.equal(
    rows.find((r) => r.stage === 'signal').resultKind,
    undefined,
    'signal resolution is not disappearance',
  );
});

test('ownership sidecar enforces UTF8 row and byte budgets and survivor count without leaking arbitrary data', () => {
  const f = ownershipFixture();
  f.observe('supervisor-cleanup', { outcome: 'entered' });
  for (let i = 0; i < 100; i++)
    f.observe('ownership-refresh', {
      status: 'completed',
      identities: Array.from({ length: 16 }, (_, j) => ({
        pid: j + 1,
        creationIdentity: '界'.repeat(100) + i,
        present: true,
        status: i % 2 ? 'matching' : 'retired',
        command: 'PRIVATE',
      })),
    });
  const survivors = Array.from({ length: 20 }, (_, i) => ({
    pid: i + 1,
    creationIdentity: '界'.repeat(100),
    command: 'PRIVATE',
  }));
  finishOwnership(f, 'survivors', survivors);
  const rows = f.rows(),
    result = rows.find((r) => r.stage === 'final-result');
  assert.equal(result.survivorCount, 20);
  assert.ok(result.survivors.length <= 16);
  assert.equal(result.truncated, true);
  assert.ok(
    result.survivors.every(
      (row) => Buffer.byteLength(row.creationIdentity) <= 128,
    ),
  );
  assert.ok(f.lines.every((line) => Buffer.byteLength(line) <= 4096));
  assert.ok(Buffer.byteLength(f.lines.join('')) <= 128 * 1024);
  assert.ok(rows.length <= 240);
  assert.equal(f.lines.join('').includes('PRIVATE'), false);
  assert.equal(rows.at(-1).completeObservation, false);
  assert.ok(
    rows.at(-1).counters.dropped > 0,
    'byte saturation drops rows before row budget',
  );
});

test('ownership sidecar rejects accessors and object coercion, bounds pending queries, and keeps unknown failures unknown', () => {
  const f = ownershipFixture();
  let reads = 0;
  const hostile = {
    get pid() {
      reads++;
      throw new Error('PRIVATE');
    },
    creationIdentity: {
      toJSON() {
        reads++;
        return 'PRIVATE';
      },
      toString() {
        reads++;
        return 'PRIVATE';
      },
    },
    outcome: 'rejected',
    signal: 'SIGTERM',
    error: {
      get name() {
        reads++;
        return 'PRIVATE';
      },
      code: 'PRIVATE/code',
      message: 'PRIVATE',
      stack: 'PRIVATE',
    },
  };
  f.observe('supervisor-cleanup', { outcome: 'entered' });
  f.observe('signal', hostile);
  for (let queryId = 1; queryId < 12; queryId++)
    f.observe('enumeration', {
      queryId,
      phase: 'cleanup-refresh',
      outcome: 'entered',
    });
  f.observe('ownership-refresh', { status: 'unavailable', identities: [] });
  f.observe('enumeration', {
    queryId: 1,
    phase: 'final-verification',
    outcome: 'rejected',
    error: { name: 'Error', code: 'ETIMEDOUT', message: 'PRIVATE' },
  });
  f.observe('final-result', { resultKind: 'enumeration-unavailable' });
  f.observe('supervisor-cleanup', { outcome: 'rejected' });
  f.observe('supervisor-exit', { code: 1 });
  assert.equal(reads, 0);
  assert.equal(f.lines.join('').includes('PRIVATE'), false);
  const rows = f.rows();
  assert.equal(
    rows.find((r) => r.stage === 'signal').failureCategory,
    'unknown',
  );
  assert.equal(rows.find((r) => r.stage === 'ownership-refresh').queryId, null);
  assert.equal(
    rows.find((r) => r.stage === 'enumeration' && r.outcome === 'rejected')
      .failureCategory,
    'timeout',
  );
  assert.equal(
    rows.find((r) => r.stage === 'final-result').survivorCount,
    undefined,
  );
  assert.equal(rows.at(-1).finalResult, 'enumeration-unavailable');
  assert.equal(rows.at(-1).completeObservation, false);
  assert.ok(rows.at(-1).counters.invalidProjection > 0);
  assert.ok(rows.at(-1).counters.dropped > 0);
});

test('ownership sidecar retains valid rejected signal identity without creating terminal proof', () => {
  const f = ownershipFixture();
  f.observe('supervisor-cleanup', { outcome: 'entered' });
  f.observe('signal', {
    pid: 7654,
    creationIdentity: 'target-created',
    signal: 'SIGKILL',
    outcome: 'rejected',
    error: { name: 'Error', code: 'EPERM' },
  });
  f.observe('supervisor-exit', { code: 1 });
  const rows = f.rows();
  assert.deepEqual(
    rows.find((row) => row.stage === 'signal'),
    {
      schemaVersion: 1,
      producer: 'ownership',
      caseId: f.config.caseId,
      launchId: f.config.launchId,
      fixturePid: f.config.fixturePid,
      pid: 4001,
      parentPid: 4000,
      sequence: 3,
      monotonicMs: 0,
      wallTime: rows[2].wallTime,
      stage: 'signal',
      outcome: 'rejected',
      signaledPid: 7654,
      creationIdentity: 'target-created',
      identityTruncated: false,
      signal: 'SIGKILL',
      errorName: 'Error',
      errorCode: 'EPERM',
      failureCategory: 'unknown',
    },
  );
  const summary = rows.at(-1);
  assert.equal(summary.pid, 4001);
  assert.equal(summary.cleanupEntered, true);
  assert.equal(summary.cleanupSettled, false);
  assert.equal(summary.finalResult, 'unknown');
  assert.equal(summary.terminalObserved, false);
  assert.equal(summary.completeObservation, false);
});

test('ownership sidecar keeps optional error-code representations bounded and classification honest', () => {
  const cases = [
    {
      label: 'absent',
      error: { name: 'Error' },
      expected: {},
      invalidProjection: 0,
    },
    {
      label: 'null',
      error: { name: 'Error', code: null },
      expected: {},
      invalidProjection: 0,
    },
    {
      label: 'numeric',
      error: { name: 'Error', code: 17 },
      expected: { errorExitCode: 17 },
      invalidProjection: 0,
    },
    {
      label: 'bounded numeric string',
      error: { name: 'Error', code: '17' },
      expected: { errorExitCode: 17 },
      invalidProjection: 0,
    },
    {
      label: 'symbolic',
      error: { name: 'Error', code: 'ETIMEDOUT' },
      expected: { errorCode: 'ETIMEDOUT' },
      failureCategory: 'timeout',
      invalidProjection: 0,
    },
    {
      label: 'malformed',
      error: { name: 'Error', code: '17x' },
      expected: {},
      invalidProjection: 1,
    },
  ];
  for (const item of cases) {
    const f = ownershipFixture();
    f.observe('supervisor-cleanup', { outcome: 'entered' });
    f.observe('enumeration', {
      queryId: 1,
      phase: 'cleanup-refresh',
      outcome: 'rejected',
      error: item.error,
    });
    finishOwnership(f);
    const rows = f.rows();
    const rejected = rows.find(
      (row) => row.stage === 'enumeration' && row.outcome === 'rejected',
    );
    assert.equal(rejected.errorCode, item.expected.errorCode, item.label);
    assert.equal(
      rejected.errorExitCode,
      item.expected.errorExitCode,
      item.label,
    );
    assert.equal(
      rejected.failureCategory,
      item.failureCategory ?? 'unknown',
      item.label,
    );
    assert.equal(
      rows.at(-1).counters.invalidProjection,
      item.invalidProjection,
      item.label,
    );
    assert.equal(rows.at(-1).observationGap, true, item.label);
    assert.equal(rows.at(-1).finalResult, 'verified-empty', item.label);
    assert.equal(rows.at(-1).completeObservation, false, item.label);
  }
});

test('ownership sidecar lazily expires before or after cleanup and never resumes', () => {
  for (const mode of ['acceptance-command', 'close'])
    for (const cleanup of [false, true]) {
      const f = ownershipFixture({ mode });
      if (cleanup) f.observe('supervisor-cleanup', { outcome: 'entered' });
      f.at(mode === 'close' ? 180000 : 29 * 60000);
      f.observe('signal', {
        pid: 1,
        creationIdentity: 'root',
        outcome: 'entered',
        signal: 'SIGTERM',
      });
      const count = f.lines.length;
      f.at(0);
      finishOwnership(f);
      assert.equal(f.lines.length, count);
      assert.equal(f.rows().at(-2).stage, 'observer-expired');
      assert.equal(f.rows().at(-1).expired, true);
      assert.equal(f.rows().at(-1).completeObservation, false);
    }
});

test('ownership sidecar write failures at arm, operation and summary never retry or fabricate a completed trace', () => {
  for (const failAt of [1, 3, 6]) {
    const f = ownershipFixture({ failAt });
    f.observe('supervisor-cleanup', { outcome: 'entered' });
    finishOwnership(f);
    finishOwnership(f);
    assert.equal(f.attempts(), failAt);
    assert.equal(
      f.rows().some((row) => row.stage === 'summary'),
      false,
    );
    f.record('supervisor-exit', { code: 0 });
    assert.equal(JSON.parse(f.proof.at(-1)).stage, 'supervisor-exit');
  }
});

test('ownership sidecar leaves registered cleanup queries signals liveness releases promises and exits identical', async (t) => {
  t.mock.method(
    Date.prototype,
    'toISOString',
    () => '2026-09-15T00:00:00.000Z',
  );
  t.mock.method(process.hrtime, 'bigint', () => 123n);
  for (const scenario of [
    'gone',
    'survivors',
    'reused',
    'unavailable',
    'signal-error',
  ]) {
    const results = [];
    for (const enabled of [false, true, 'write-failed']) {
      const f = ownershipFixture({
        failAt: enabled === 'write-failed' ? 3 : Infinity,
      });
      let queries = 0,
        liveness = 0,
        stopped = false;
      const signals = [],
        failure = new Error('original signal failure');
      const run = await registeredBoundaryProducer('supervisor', {
        manual: true,
        record: enabled ? f.record : (...args) => f.record(...args),
        createOwner: (child, config) =>
          createWindowsProcessTreeOwner(child, {
            ...config,
            graceMs: 0,
            delay: async () => {},
            listProcesses: async () => {
              queries++;
              if (scenario === 'unavailable' && stopped)
                throw new Error('query unavailable');
              return stopped && scenario === 'gone'
                ? []
                : [
                    {
                      pid: 4321,
                      parentPid: 1,
                      creationDate:
                        stopped && scenario === 'reused'
                          ? 'new-unowned-root'
                          : 'original-root',
                    },
                  ];
            },
            isProcessAlive: () => {
              liveness++;
              return !stopped || scenario === 'survivors';
            },
            killProcessTree: async (pid, signal) => {
              signals.push([pid, signal]);
              stopped = true;
              if (scenario === 'signal-error') throw failure;
              if (scenario === 'gone' || scenario === 'reused')
                exitMockChild(child);
            },
          }),
      });
      const releases = [];
      run.child.send = (message, callback) => {
        releases.push({ type: message.type, ready: message.ready });
        callback?.();
      };
      await run.owner.ready;
      run.host.emit('message', {
        type: 'request-owned-cleanup',
        reason: 'timeout',
      });
      const promise = run.owner.stop();
      assert.equal(run.owner.stop(), promise);
      let error;
      try {
        await promise;
      } catch (value) {
        error = value;
      }
      if (scenario === 'signal-error') assert.equal(error, failure);
      run.child.emit('exit', 1, null);
      run.child.emit('close', 1, null);
      await new Promise((resolve) => setImmediate(resolve));
      const exitListenersBefore = run.host.listenerCount('exit');
      assert.equal(exitListenersBefore, 1);
      run.host.emit('exit', run.host.exitCode);
      results.push({
        queries,
        liveness,
        signals,
        error: error?.message,
        exitCode: run.host.exitCode,
        sends: releases,
        proof: f.proof.join(''),
        exitListeners: run.host.listenerCount('exit'),
        exitListenersBefore,
      });
      if (enabled === true && scenario === 'reused')
        assert.deepEqual(
          f.rows().find((row) => row.stage === 'final-result').survivors,
          [],
        );
      if (enabled === true && scenario === 'unavailable')
        assert.equal(
          f.rows().find((row) => row.stage === 'final-result').resultKind,
          'enumeration-unavailable',
        );
      if (!enabled) assert.equal(run.ownerOptions.observeOperation, undefined);
    }
    assert.deepEqual(results[1], results[0], scenario);
    assert.deepEqual(results[2], results[0], scenario + ' with failed sink');
  }
});

test('ownership sidecar final-result never enters the registered watchdog or an unchosen observer', async () => {
  const f = await registeredBoundaryProducer('watchdog', {
    manual: true,
    createOwner: (child, config) =>
      createWindowsProcessTreeOwner(child, {
        ...config,
        listProcesses: async () => [],
        isProcessAlive: () => false,
      }),
  });
  await f.owner.ready;
  f.parentExit();
  await f.owner.stop();
  await Promise.resolve();
  assert.equal(
    f.records.some((row) => row.stage === 'final-result'),
    false,
  );
  assert.deepEqual(
    f.records
      .filter((row) => row.stage === 'final-verification')
      .map((row) => row.outcome),
    ['entered', 'fulfilled'],
  );
  const stages = [];
  const observer = (stage) => stages.push(stage);
  Object.defineProperty(observer, 'ownershipDiagnostics', {
    get() {
      throw new Error('must not invoke marker getter');
    },
  });
  const owner = createWindowsProcessTreeOwner(mockChild(), {
    listProcesses: async () => [],
    isProcessAlive: () => false,
    observeOperation: observer,
  });
  await owner.stop();
  assert.deepEqual(stages, [
    'enumeration',
    'enumeration',
    'final-verification',
    'enumeration',
    'enumeration',
    'final-verification',
  ]);
});

test('ownership sidecar reserves precleanup rows and reports exceptional final verification without invented absence', () => {
  const f = ownershipFixture();
  for (let i = 0; i < 100; i++)
    f.observe('ownership-refresh', {
      status: 'completed',
      identities: [
        {
          pid: i + 1,
          creationIdentity: 'root',
          present: true,
          status: 'matching',
        },
      ],
    });
  assert.ok(f.lines.length <= 25);
  f.observe('supervisor-cleanup', { outcome: 'entered' });
  f.observe('final-verification', {
    outcome: 'rejected',
    error: { name: 'Error' },
  });
  f.observe('supervisor-cleanup', { outcome: 'rejected' });
  f.observe('supervisor-exit', { code: 1 });
  assert.equal(f.rows().at(-1).finalResult, 'other-error');
  assert.equal(
    f.rows().find((row) => row.stage === 'final-result').survivors,
    undefined,
  );
});

test('ownership sidecar complete observation is explanatory and counters saturate honestly', async () => {
  const f = ownershipFixture();
  f.observe('supervisor-cleanup', { outcome: 'entered' });
  finishOwnership(f);
  assert.equal(f.rows().at(-1).completeObservation, true);
  // Exercise the actual private factory with a reduced numeric saturation ceiling;
  // no production option or billions of callbacks are needed to reach overflow.
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(
    new URL('./process-tree-supervisor.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function createWindowsOwnershipObserver(');
  const end = source.indexOf('\nfunction serializePosixTrackedGroups(', start);
  const boundedNumber = Object.create(Number);
  Object.defineProperty(boundedNumber, 'MAX_SAFE_INTEGER', { value: 3 });
  const factory = runInNewContext(`(${source.slice(start, end)})`, {
    Buffer,
    Number: boundedNumber,
    ACCEPTANCE_COMMAND_OBSERVER_LIFETIME_MS: 29 * 60000,
  });
  const lines = [];
  const observe = factory(f.config, {
    currentPid: 4001,
    parentPid: 4000,
    now: () => 0,
    start: 0,
    write: (_file, line) => lines.push(JSON.parse(line)),
  });
  observe('supervisor-cleanup', { outcome: 'entered' });
  for (let i = 0; i < 10; i++)
    observe('enumeration', {
      queryId: 1,
      phase: 'cleanup-refresh',
      outcome: 'entered',
    });
  observe('final-result', {
    resultKind: 'verified-empty',
    survivorCount: 0,
    survivors: [],
  });
  observe('supervisor-cleanup', { outcome: 'fulfilled' });
  observe('supervisor-exit', { code: 0 });
  assert.equal(lines.at(-1).counterOverflow, true);
  assert.equal(lines.at(-1).counters.seen, 3);
  assert.equal(lines.at(-1).completeObservation, false);
});

for (const failureKind of ['query-rejection', 'identity-processing'])
  test(`ownership sidecar retains a recovered ${failureKind} gap after successful registered cleanup`, async (t) => {
    t.mock.method(
      Date.prototype,
      'toISOString',
      () => '2026-09-15T00:00:00.000Z',
    );
    t.mock.method(process.hrtime, 'bigint', () => 123n);
    const results = [];
    let observed;
    for (const enabled of [false, true]) {
      const f = ownershipFixture();
      let queries = 0,
        liveness = 0,
        alive = true;
      const signals = [],
        releases = [];
      const run = await registeredBoundaryProducer('supervisor', {
        manual: true,
        record: enabled ? f.record : (...args) => f.record(...args),
        createOwner: (child, config) =>
          createWindowsProcessTreeOwner(child, {
            ...config,
            listProcesses: async () => {
              queries++;
              if (queries === 2) {
                if (failureKind === 'query-rejection')
                  throw Object.assign(
                    new Error('recoverable enumeration failure'),
                    { code: 'EQUERY' },
                  );
                return [
                  {
                    pid: 4321,
                    parentPid: 1,
                    get creationDate() {
                      throw new Error(
                        'recoverable identity processing failure',
                      );
                    },
                  },
                ];
              }
              return alive
                ? [{ pid: 4321, parentPid: 1, creationDate: 'original-root' }]
                : [];
            },
            isProcessAlive: () => {
              liveness++;
              return alive;
            },
            killProcessTree: async (pid, signal) => {
              signals.push([pid, signal]);
              alive = false;
              exitMockChild(child);
            },
          }),
      });
      run.child.send = (message, callback) => {
        releases.push({ type: message.type, ready: message.ready });
        callback?.();
      };
      await run.owner.ready;
      assert.equal(
        await run.owner.refresh(),
        false,
        'the original periodic refresh reports its actual failure',
      );
      assert.equal(
        await run.owner.refresh(),
        true,
        'the next original periodic refresh recovers',
      );
      run.child.emit('message', { type: 'target-exit', code: 0, signal: null });
      const stopping = run.owner.stop();
      assert.equal(run.owner.stop(), stopping);
      await stopping;
      run.child.emit('exit', 0, null);
      run.child.emit('close', 0, null);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(run.host.exitCode, 0);
      run.host.emit('exit', 0);
      results.push({
        queries,
        liveness,
        signals,
        releases,
        proof: f.proof.join(''),
      });
      if (enabled) observed = f;
    }
    assert.deepEqual(
      results[1],
      results[0],
      'diagnostics preserve proof bytes, queries, liveness, signals and release',
    );
    const { parseAcceptanceSupervisorProof } =
      await import('./run-browser-profile-acceptance-command.mjs');
    assert.equal(
      parseAcceptanceSupervisorProof(
        results[1].proof,
        { ...observed.config, supervisorPid: 4001 },
        { supervisorExitCode: 0 },
      ).status,
      'verified',
    );
    const rows = observed.rows();
    assert.ok(
      rows.some(
        (row) =>
          row.stage === 'ownership-refresh' && row.status === 'unavailable',
      ),
    );
    assert.equal(
      rows.some(
        (row) => row.stage === 'enumeration' && row.outcome === 'rejected',
      ),
      failureKind === 'query-rejection',
      'fulfilled enumeration can still fail during identity processing',
    );
    assert.equal(rows.at(-1).finalResult, 'verified-empty');
    assert.equal(rows.at(-1).cleanupOutcome, 'fulfilled');
    assert.equal(rows.at(-1).terminalObserved, true);
    assert.equal(
      rows.at(-1).completeObservation,
      false,
      'recovery must not erase the earlier observation gap',
    );
  });

test('ownership sidecar keeps rejected unknown and unavailable states sticky even when later suppressed or recovered', () => {
  for (const [stage, details] of [
    ['enumeration', { outcome: 'rejected', phase: 'periodic', queryId: 1 }],
    ['enumeration', { phase: 'periodic', queryId: 1 }],
    ['ownership-refresh', { status: 'unavailable', identities: [] }],
    ['ownership-refresh', { identities: [] }],
    [
      'ownership-refresh',
      {
        status: 'completed',
        identities: [
          {
            pid: 4321,
            creationIdentity: null,
            present: true,
            status: 'unavailable',
          },
        ],
      },
    ],
    ['supervisor-cleanup', { outcome: 'rejected' }],
  ]) {
    const f = ownershipFixture();
    f.observe(stage, details);
    f.observe('ownership-refresh', { status: 'completed', identities: [] });
    f.observe('supervisor-cleanup', { outcome: 'entered' });
    finishOwnership(f);
    const summary = f.rows().at(-1);
    assert.equal(summary.observationGap, true, stage);
    assert.equal(summary.finalResult, 'verified-empty', stage);
    assert.equal(summary.terminalObserved, true, stage);
    assert.equal(summary.completeObservation, false, stage);
  }
});

// Exercise the ordinary buffered query and ownership state, not a test parser.
test('Windows enumeration integrity rejects incomplete and error-bearing buffered snapshots atomically', async (t) => {
  const row = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}\n`;
  const ready = 'phase=ps-ready\n',
    first = 'phase=cim-first-row\n',
    complete = 'phase=cim-complete\n';
  const valid = ready + first + row + complete;
  for (const [name, stdout, stderr = ''] of [
    ['empty', ''],
    ['missing-ready', first + row + complete],
    ['missing-complete', ready + first + row],
    ['duplicate-ready', ready + valid],
    ['duplicate-complete', valid + complete],
    ['reordered', first + ready + row + complete],
    ['missing-first', ready + row + complete],
    ['empty-first', ready + first + complete],
    ['trailing', valid + 'partial'],
    ['unknown-phase', ready + 'phase=unknown\n' + first + row + complete],
    ['padded-ready', ' ' + valid],
    ['BOM-ready', '\ufeff' + valid],
    ['stderr', valid, 'Get-CimInstance: failed'],
  ])
    await t.test(name, async () => {
      let output = { stdout: valid };
      const implementation = await supervisorWithQueryIo({
        now: () => performance.now(),
        execFileAsync: async (_file, _args, options) => {
          assert.equal(options.timeout, 5000);
          return output;
        },
      });
      const evidence = [];
      const owner = implementation.createWindowsProcessTreeOwner(mockChild(), {
        observeRefresh: (e) => evidence.push(e),
      });
      assert.equal(await owner.ready, true);
      output = { stdout, stderr };
      assert.equal(await owner.refresh(), false, name);
      output = { stdout: valid.replaceAll('\n', '\r\n') };
      assert.equal(await owner.refresh(), true);
      assert.equal(
        evidence.at(-1).identities[0].status,
        'matching',
        'rejected output leaves admitted identity intact',
      );
    });
});

test('Windows enumeration integrity rejects the same buffered protocol at exact presignal queries', async (t) => {
  const row = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}\n`,
    valid = `phase=ps-ready\nphase=cim-first-row\n${row}phase=cim-complete\n`;
  for (const output of [
    { stdout: row },
    { stdout: valid, stderr: 'CIM failed' },
    { stdout: valid + 'phase=cim-complete\n' },
    { stdout: 'phase=ps-ready\nphase=cim-first-row\nphase=cim-complete\n' },
  ])
    await t.test(JSON.stringify(output), async () => {
      const signals = [];
      const implementation = await supervisorWithQueryIo({
        now: () => performance.now(),
        execFileAsync: async (_file, args) =>
          args.at(-1).includes('-Filter') ? output : { stdout: valid },
      });
      const owner = implementation.createWindowsProcessTreeOwner(mockChild(), {
        isProcessAlive: () => true,
        killProcessTree: async (pid) => signals.push(pid),
        graceMs: 0,
        delay: async () => undefined,
      });
      assert.equal(await owner.ready, true);
      await assert.rejects(owner.stop());
      assert.deepEqual(signals, []);
    });
});

test('Windows enumeration integrity preserves a live admitted wrapper through missing and mismatched full snapshots', async (t) => {
  for (const mismatch of [false, true])
    await t.test(String(mismatch), async () => {
      const child = mockChild(),
        signals = [],
        finals = [];
      child.connected = true;
      const original = {
        pid: 4321,
        parentPid: 1,
        creationDate: WINDOWS_TEST_CREATION.wrapper,
      };
      let rows = [original];
      const observeOperation = (stage, details) => {
        if (stage === 'final-result') finals.push(details);
      };
      Object.defineProperty(observeOperation, 'ownershipDiagnostics', {
        value: true,
      });
      const owner = createWindowsProcessTreeOwner(child, {
        listProcesses: async () => rows,
        isProcessAlive: () => true,
        killProcessTree: async (pid) => signals.push(pid),
        observeOperation,
        graceMs: 0,
        delay: async () => undefined,
      });
      assert.equal(await owner.ready, true);
      rows = mismatch
        ? [{ ...original, creationDate: WINDOWS_TEST_CREATION.reusedWrapper }]
        : [];
      assert.equal(await owner.refresh(), false);
      rows = [original];
      assert.equal(await owner.refresh(), true);
      rows = [];
      await assert.rejects(owner.stop(), /verification unavailable/);
      assert.deepEqual(signals, []);
      assert.equal(finals.at(-1).resultKind, 'enumeration-unavailable');
    });
});

test('Windows enumeration integrity commits no lineage retirement on a later chronology rejection', async () => {
  const child = mockChild(),
    evidence = [];
  const root = {
    pid: 4321,
    parentPid: 1,
    creationDate: WINDOWS_TEST_CREATION.wrapper,
  };
  const target = {
    pid: 5000,
    parentPid: 4321,
    creationDate: WINDOWS_TEST_CREATION.target,
  };
  let rows = [root, target];
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => rows,
    observeRefresh: (e) => evidence.push(e),
  });
  assert.equal(await owner.ready, true);
  owner.trackOwnedPid(5000);
  await owner.refresh();
  rows = [
    root,
    { ...target, creationDate: WINDOWS_TEST_CREATION.reusedTarget },
    { pid: 6000, parentPid: 4321, creationDate: 'invalid-chronology' },
  ];
  assert.equal(await owner.refresh(), false);
  rows = [root, target];
  assert.equal(await owner.refresh(), true);
  assert.equal(
    evidence.at(-1).identities.find((r) => r.pid === 5000).status,
    'matching',
  );
});

test('Windows enumeration integrity streamed admission rejects successful stderr', async () => {
  const f = startInitialQuery();
  f.stdout('phase=ps-ready\n');
  f.complete();
  f.stderr('CIM processing error');
  f.close();
  await assertInitialFailure(f, 'stderr', 0);
});

test('Windows enumeration integrity reserves first contradiction after polling saturation with bounded observed identity', async () => {
  const f = ownershipFixture();
  for (let i = 0; i < 100; i++)
    f.observe('ownership-refresh', {
      status: 'completed',
      identities: [
        {
          pid: 4321,
          creationIdentity: String(i),
          present: true,
          status: 'matching',
        },
      ],
    });
  const child = mockChild();
  let rows = [
    { pid: 4321, parentPid: 1, creationDate: WINDOWS_TEST_CREATION.wrapper },
  ];
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => rows,
    observeOperation: f.observe,
    observeRefresh: (snapshot) => f.observe('ownership-refresh', snapshot),
  });
  assert.equal(await owner.ready, true);
  rows = [{ ...rows[0], creationDate: WINDOWS_TEST_CREATION.reusedWrapper }];
  await owner.refresh();
  await owner.refresh();
  const events = f.rows().filter((r) => r.subtype === 'ownership-integrity');
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'identity-mismatch');
  assert.equal(events[0].observedIdentity, WINDOWS_TEST_CREATION.reusedWrapper);
  assert.equal(events[0].wrapperExited, false);
  assert.equal(events[0].queryId, 2);
  assert.equal(events[0].stage, 'ownership-refresh');
  assert.equal(events[0].status, 'unavailable');
  f.observe('supervisor-cleanup', { outcome: 'entered' });
  exitMockChild(child);
  assert.equal(await owner.refresh(), true);
  // A later actual final identity/result remains independently available after saturation.
  await owner.stop();
  finishOwnership(f);
  assertOwnershipWireStream(f.rows());
  assert.equal(
    f
      .rows()
      .filter((r) => r.stage === 'ownership-refresh' && !r.subtype)
      .at(-1).identities[0].observedIdentity,
    WINDOWS_TEST_CREATION.reusedWrapper,
  );
  assert.equal(
    f.rows().find((r) => r.stage === 'final-result').resultKind,
    'verified-empty',
  );
  assert.equal(f.rows().at(-1).observationGap, true);

  assert.ok(f.rows().length <= 240);
  assert.ok(Buffer.byteLength(f.lines.join('')) <= 128 * 1024);
});

test('Windows enumeration integrity permits complete empty scans after actual exit or close and never revives reused identities', async (t) => {
  for (const event of ['exit', 'close', 'exitCode', 'signalCode'])
    await t.test(event, async () => {
      const child = mockChild(),
        f = ownershipFixture();
      let stdout = rawWindowsProcessOutput([
        `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`,
      ]);
      const implementation = await supervisorWithQueryIo({
        now: () => performance.now(),
        execFileAsync: async () => ({ stdout }),
      });
      const owner = implementation.createWindowsProcessTreeOwner(child, {
        isProcessAlive: () => false,
        observeOperation: f.observe,
        observeRefresh: (snapshot) => f.observe('ownership-refresh', snapshot),
      });
      assert.equal(await owner.ready, true);
      if (event === 'exitCode') child.exitCode = 0;
      else if (event === 'signalCode') child.signalCode = 'SIGTERM';
      else child.emit(event, 0, null);
      stdout = rawWindowsProcessOutput([]);
      assert.equal(
        await owner.refresh(),
        true,
        'zero-row ready/complete is authoritative after actual termination',
      );
      f.observe('supervisor-cleanup', { outcome: 'entered' });
      stdout = rawWindowsProcessOutput([
        `4321\t1\t${WINDOWS_TEST_CREATION.reusedWrapper}`,
      ]);
      await owner.stop();
      const observations = f
        .rows()
        .filter((r) => r.stage === 'ownership-refresh' && !r.subtype);
      const retired = observations.at(-1).identities[0];
      assert.equal(retired.status, 'retired');
      assert.equal(
        retired.observedIdentity,
        WINDOWS_TEST_CREATION.reusedWrapper,
      );
      assert.equal(
        f.rows().find((r) => r.stage === 'final-result').resultKind,
        'verified-empty',
      );
      stdout = rawWindowsProcessOutput([
        `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`,
      ]);
      await owner.refresh();
      assert.equal(
        f
          .rows()
          .filter((r) => r.stage === 'ownership-refresh' && !r.subtype)
          .at(-1).identities[0].status,
        'retired',
        'confirmed retirement is permanent',
      );
    });
});

test('Windows enumeration integrity requires exact filtered recovery before signaling a live contradictory wrapper', async (t) => {
  for (const mismatch of [false, true])
    await t.test(String(mismatch), async () => {
      const child = mockChild(),
        signals = [],
        filters = [];
      const root = `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`;
      let alive = true,
        filtered = 0;
      const implementation = await supervisorWithQueryIo({
        now: () => performance.now(),
        execFileAsync: async (_file, args) => {
          const exact = args.at(-1).includes('-Filter');
          filters.push(exact);
          if (exact && ++filtered === 1)
            return {
              stdout: rawWindowsProcessOutput(
                mismatch
                  ? [`4321\t1\t${WINDOWS_TEST_CREATION.reusedWrapper}`]
                  : [],
              ),
            };
          return { stdout: rawWindowsProcessOutput(alive ? [root] : []) };
        },
      });
      const owner = implementation.createWindowsProcessTreeOwner(child, {
        isProcessAlive: () => alive,
        graceMs: 0,
        killProcessTree: async (pid, signal) => {
          signals.push([pid, signal]);
          alive = false;
          exitMockChild(child);
        },
      });
      assert.equal(await owner.ready, true);
      await owner.stop();
      assert.equal(filtered, 2);
      assert.deepEqual(signals, [[4321, 'SIGKILL']]);
      assert.deepEqual(filters, [false, false, true, false, true, false]);
    });
});

test('Windows enumeration integrity reserves protocol error metadata without exposing stdout', async () => {
  const child = mockChild(),
    f = ownershipFixture();
  let stdout = rawWindowsProcessOutput([
      `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`,
    ]),
    stderr = '';
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async () => ({ stdout, stderr }),
  });
  const owner = implementation.createWindowsProcessTreeOwner(child, {
    observeOperation: f.observe,
  });
  await owner.ready;
  stderr = 'private-host-error';
  await owner.refresh();
  const record = f.rows().find((r) => r.subtype === 'ownership-integrity');
  assert.equal(record.protocolValid, true);
  assert.equal(record.stderrPresent, true);
  assert.equal(record.stderrBytes, Buffer.byteLength(stderr));
  assert.equal(record.acceptedCount, 1);
  assert.equal(record.outputBytes, Buffer.byteLength(stdout));
  assert.deepEqual(record.protocol, {
    psReady: true,
    cimFirstRow: true,
    cimComplete: true,
  });
  assert.equal(JSON.stringify(record).includes(stderr), false);
  assert.equal(JSON.stringify(record).includes('stdout'), false);
});

test('Windows enumeration integrity diagnostic accessors and failed writes cannot change ownership', async () => {
  const results = [];
  for (const mode of [
    'disabled',
    'enabled',
    'failed-write',
    'throwing-observer',
  ]) {
    const child = mockChild(),
      f = ownershipFixture({ failAt: mode === 'failed-write' ? 2 : Infinity });
    let rows = [
        {
          pid: 4321,
          parentPid: 1,
          creationDate: WINDOWS_TEST_CREATION.wrapper,
        },
      ],
      queries = 0;
    const observeOperation =
      mode === 'disabled'
        ? undefined
        : mode === 'throwing-observer'
          ? () => {
              throw new Error('observer');
            }
          : f.observe;
    const owner = createWindowsProcessTreeOwner(child, {
      listProcesses: async () => {
        queries++;
        return rows;
      },
      observeOperation,
    });
    await owner.ready;
    rows = [];
    const rejected = await owner.refresh();
    rows = [
      { pid: 4321, parentPid: 1, creationDate: WINDOWS_TEST_CREATION.wrapper },
    ];
    const recovered = await owner.refresh();
    results.push({ rejected, recovered, queries });
  }
  for (const result of results)
    assert.deepEqual(result, { rejected: false, recovered: true, queries: 3 });
  const f = ownershipFixture();
  let getterReads = 0;
  const data = {
    kind: 'contradiction',
    queryId: 1,
    pid: 4321,
    phase: 'periodic',
    role: 'wrapper',
    reason: 'missing',
    get admittedIdentity() {
      getterReads++;
      throw new Error('getter');
    },
    protocol: {
      get psReady() {
        getterReads++;
        throw new Error('getter');
      },
    },
  };
  f.observe('ownership-integrity', data);
  assert.equal(getterReads, 0);
  finishOwnership(f, 'enumeration-unavailable');
  assert.ok(f.rows().at(-1).counters.invalidProjection > 0);
});

test('Windows enumeration integrity retirement evidence cannot reject an otherwise validated snapshot', async () => {
  const child = mockChild();
  let rows = [
    { pid: 4321, parentPid: 1, creationDate: WINDOWS_TEST_CREATION.wrapper },
  ];
  const owner = createWindowsProcessTreeOwner(child, {
    listProcesses: async () => rows,
  });
  assert.equal(await owner.ready, true);
  exitMockChild(child);
  let reads = 0;
  rows = [
    {
      pid: 4321,
      parentPid: 1,
      get creationDate() {
        if (++reads > 3) throw new Error('diagnostic-only read failed');
        return WINDOWS_TEST_CREATION.reusedWrapper;
      },
    },
  ];
  assert.equal(
    await owner.refresh(),
    true,
    'a failed evidence read must not reject valid retirement',
  );
});

test('Windows enumeration integrity retains counts and protocol for a malformed exact-query rejection', async () => {
  const child = mockChild(),
    f = ownershipFixture();
  const malformed = rawWindowsProcessOutput(['4321\t1\t']);
  const implementation = await supervisorWithQueryIo({
    now: () => performance.now(),
    execFileAsync: async (_file, args) => ({
      stdout: args.at(-1).includes('-Filter')
        ? malformed
        : rawWindowsProcessOutput([
            `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`,
          ]),
    }),
  });
  const owner = implementation.createWindowsProcessTreeOwner(child, {
    observeOperation: f.observe,
    isProcessAlive: () => true,
    graceMs: 0,
    killProcessTree: async () =>
      assert.fail('malformed identity never authorizes signal'),
  });
  assert.equal(await owner.ready, true);
  await assert.rejects(owner.stop());
  const record = f.rows().find((r) => r.subtype === 'ownership-integrity');
  assert.equal(record.protocolValid, true);
  assert.equal(record.acceptedCount, 0);
  assert.equal(record.stderrPresent, false);
  assert.equal(record.outputBytes, Buffer.byteLength(malformed));
});

test('Windows terminal query evidence retains query-specific failures after earlier integrity evidence', async () => {
  const execute = async (observeOperation) => {
    const child = mockChild(),
      signals = [],
      timeouts = [];
    let queries = 0;
    const valid = rawWindowsProcessOutput([
      `4321\t1\t${WINDOWS_TEST_CREATION.wrapper}`,
    ]);
    const implementation = await supervisorWithQueryIo({
      now: () => performance.now(),
      execFileAsync: async (_file, _args, options) => {
        queries++;
        timeouts.push(options.timeout);
        if (queries === 1) return { stdout: valid };
        if (queries === 3)
          throw Object.assign(new Error('terminal execution private detail'), {
            code: 'EPIPE',
            signal: 'SIGTERM',
            killed: true,
          });
        return { stdout: valid, stderr: `private query ${queries} rejection` };
      },
    });
    const owner = implementation.createWindowsProcessTreeOwner(child, {
      observeOperation,
      isProcessAlive: () => true,
      killProcessTree: async (...signal) => signals.push(signal),
      graceMs: 0,
      delay: async () => undefined,
    });
    assert.equal(await owner.ready, true);
    assert.equal(await owner.refresh(), false);
    observeOperation?.('supervisor-cleanup', { outcome: 'entered' });
    await assert.rejects(owner.stop(), /verification unavailable/);
    return { queries, signals, timeouts };
  };

  const f = ownershipFixture();
  const enabled = await execute(f.observe);
  const disabled = await execute(undefined);
  assert.deepEqual(enabled, disabled);
  assert.deepEqual(enabled, {
    queries: 5,
    signals: [],
    timeouts: [5_000, 5_000, 15_000, 15_000, 15_000],
  });

  const rows = f.rows();
  const terminalFailures = rows.filter(
    (row) =>
      row.stage === 'enumeration' &&
      row.outcome === 'rejected' &&
      ['cleanup-refresh', 'final-verification'].includes(row.phase),
  );
  const execution = terminalFailures.find((row) => row.queryId === 3);
  const protocol = terminalFailures.find((row) => row.queryId === 5);
  assert.deepEqual(execution.queryFailure, {
    category: 'execution',
    errorCode: 'EPIPE',
    errorExitCode: null,
    signal: 'SIGTERM',
    killed: true,
    protocol: {
      psReady: false,
      cimFirstRow: false,
      cimComplete: false,
      validatedPhase: null,
      protocolValid: null,
      acceptedCount: null,
      rejectedCount: null,
    },
  });
  assert.deepEqual(protocol.queryFailure, {
    category: 'protocol',
    errorCode: null,
    errorExitCode: null,
    signal: null,
    killed: null,
    protocol: {
      psReady: true,
      cimFirstRow: true,
      cimComplete: true,
      validatedPhase: 'complete',
      protocolValid: true,
      acceptedCount: 1,
      rejectedCount: 5,
    },
  });
  assert.equal(
    rows.filter((row) => row.subtype === 'ownership-integrity').length,
    1,
  );
  assert.equal(
    rows.find((row) => row.subtype === 'ownership-integrity').queryId,
    2,
  );
  assert.equal(JSON.stringify(rows).includes('private'), false);
  assert.ok(rows.length <= 240);
  assert.ok(Buffer.byteLength(f.lines.join('')) <= 128 * 1024);
});
test(
  'watchdog persists and reaps a detached grandchild after supervisor death',
  { skip: process.platform === 'win32' },
  async () => {
    const fixtureDir = mkdtempSync(
      path.join(os.tmpdir(), 'watchdog-detached-'),
    );
    const groupsFile = path.join(fixtureDir, 'watchdog-groups.ndjson');
    const grandchildPidFile = path.join(fixtureDir, 'grandchild.pid');
    const runNonce = `watchdog-${process.pid}-${Date.now()}`;
    const supervisor = spawn(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 10_000)'],
      { stdio: 'ignore' },
    );
    const grandchildScript = 'setInterval(() => undefined, 10_000)';
    const targetScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));`,
      'child.unref();',
      'setInterval(() => undefined, 10_000);',
    ].join('\n');
    const target = spawn(process.execPath, ['-e', targetScript], {
      detached: true,
      stdio: 'ignore',
    });
    const watchdog = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL('./process-tree-supervisor.mjs', import.meta.url),
        ),
        '--canopy-process-tree-watchdog',
        String(supervisor.pid),
        String(target.pid),
        groupsFile,
        runNonce,
      ],
      {
        detached: true,
        env: { ...process.env, CANOPY_E2E_TREE_REFRESH_MS: '20' },
        stdio: 'ignore',
      },
    );
    const watchdogClosed = new Promise((resolve) =>
      watchdog.once('close', resolve),
    );
    let grandchildPid;
    let grandchildStart;

    try {
      await waitForCondition(
        () => existsSync(grandchildPidFile),
        'target did not publish its detached grandchild',
      );
      grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
      grandchildStart = processStartTime(grandchildPid);
      assert.ok(grandchildStart);
      await waitForCondition(
        () => sidecarTracksGroup(groupsFile, runNonce, grandchildPid),
        'watchdog never persisted the detached grandchild group',
      );
      assert.equal(watchdog.exitCode, null);
      assert.equal(watchdog.signalCode, null);
      assert.equal(processStartTime(grandchildPid), grandchildStart);

      supervisor.kill('SIGKILL');
      const timeout = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('watchdog did not exit after its supervisor')),
          3_000,
        ).unref(),
      );
      assert.equal(await Promise.race([watchdogClosed, timeout]), 0);
      await waitForCondition(
        () => processStartTime(grandchildPid) !== grandchildStart,
        'watchdog did not reap the detached grandchild',
      );
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill('SIGTERM');
      }
      if (watchdog.exitCode === null && watchdog.signalCode === null) {
        watchdog.kill('SIGTERM');
        await watchdogClosed;
      }
      if (target.exitCode === null && target.signalCode === null) {
        try {
          process.kill(-target.pid, 'SIGKILL');
        } catch {
          // The watchdog already reaped the target group.
        }
      }
      if (Number.isInteger(grandchildPid)) {
        try {
          process.kill(-grandchildPid, 'SIGKILL');
        } catch {
          // The watchdog already reaped the detached group.
        }
      }
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  'watchdog warns and exits when a sidecar rewrite keeps failing',
  { skip: process.platform === 'win32' },
  async () => {
    const fixtureDir = mkdtempSync(
      path.join(os.tmpdir(), 'watchdog-sidecar-failure-'),
    );
    const groupsFile = path.join(fixtureDir, 'watchdog-groups.ndjson');
    const spawnChildFile = path.join(fixtureDir, 'spawn-child');
    const grandchildPidFile = path.join(fixtureDir, 'grandchild.pid');
    const runNonce = `watchdog-failure-${process.pid}-${Date.now()}`;
    const supervisor = spawn(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 10_000)'],
      { stdio: 'ignore' },
    );
    const targetScript = [
      'const { spawn } = require("node:child_process");',
      'const { existsSync, writeFileSync } = require("node:fs");',
      `const timer = setInterval(() => { if (!existsSync(${JSON.stringify(spawnChildFile)})) return;`,
      'clearInterval(timer);',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 10000)"], { detached: true, stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));`,
      'child.unref();',
      '}, 20);',
      'setInterval(() => undefined, 10_000);',
    ].join('\n');
    const target = spawn(process.execPath, ['-e', targetScript], {
      detached: true,
      stdio: 'ignore',
    });
    const watchdog = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL('./process-tree-supervisor.mjs', import.meta.url),
        ),
        '--canopy-process-tree-watchdog',
        String(supervisor.pid),
        String(target.pid),
        groupsFile,
        runNonce,
      ],
      {
        detached: true,
        env: { ...process.env, CANOPY_E2E_TREE_REFRESH_MS: '20' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    watchdog.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const watchdogClosed = new Promise((resolve) =>
      watchdog.once('close', (code, signal) => resolve({ code, signal })),
    );
    let grandchildPid;
    const targetStart = processStartTime(target.pid);
    let grandchildStart;

    try {
      assert.ok(targetStart);
      await waitForCondition(
        () => existsSync(groupsFile),
        'watchdog did not initialize its sidecar',
      );
      mkdirSync(`${groupsFile}.${watchdog.pid}.tmp`);
      writeFileSync(spawnChildFile, 'spawn');
      await waitForCondition(
        () => existsSync(grandchildPidFile),
        'target did not spawn its detached child',
      );
      grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
      grandchildStart = processStartTime(grandchildPid);
      assert.ok(grandchildStart);

      const timeout = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error('watchdog did not exit after sidecar failure')),
          3_000,
        ).unref(),
      );
      assert.deepEqual(await Promise.race([watchdogClosed, timeout]), {
        code: 0,
        signal: null,
      });
      assert.match(
        stderr,
        /Failed to update supervised process ownership: failed to rewrite supervised groups sidecar/,
      );
      assert.notEqual(processStartTime(target.pid), targetStart);
      assert.notEqual(processStartTime(grandchildPid), grandchildStart);
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill('SIGTERM');
      }
      if (watchdog.exitCode === null && watchdog.signalCode === null) {
        watchdog.kill('SIGKILL');
        await watchdogClosed;
      }
      if (target.exitCode === null && target.signalCode === null) {
        try {
          process.kill(-target.pid, 'SIGKILL');
        } catch {
          // The watchdog already reaped the target group.
        }
      }
      if (Number.isInteger(grandchildPid)) {
        try {
          process.kill(-grandchildPid, 'SIGKILL');
        } catch {
          // The watchdog already reaped the detached group.
        }
      }
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);

for (const crossTimeZone of [false, true]) {
  test(
    crossTimeZone
      ? 'closeCanopy reaps a detached grandchild across supervisor time zones after its intermediate parent exits'
      : 'closeCanopy reaps a detached grandchild after its intermediate parent exits',
    { skip: process.platform === 'win32' },
    async () => {
      const utcEnv = { ...process.env, TZ: 'UTC' };
      const supervisorEnv = crossTimeZone
        ? {
            ...process.env,
            TZ:
              processStartTime(process.pid, utcEnv) ===
              processStartTime(process.pid)
                ? 'Etc/GMT+12'
                : 'UTC',
          }
        : process.env;
      const fixtureDir = mkdtempSync(
        path.join(os.tmpdir(), 'close-canopy-detached-grandchild-'),
      );
      const supervisedPidFile = path.join(fixtureDir, 'supervised.pid');
      const supervisedGroupsFile = path.join(fixtureDir, 'groups.ndjson');
      const supervisedRunNonce = `can-2798-${process.pid}-${Date.now()}`;
      const intermediatePidFile = path.join(fixtureDir, 'intermediate.pid');
      const grandchildPidFile = path.join(fixtureDir, 'grandchild.pid');
      const releaseIntermediateFile = path.join(
        fixtureDir,
        'release-intermediate',
      );
      const grandchildScript = 'setInterval(() => undefined, 10_000)';
      const intermediateScript = [
        'const { spawn } = require("node:child_process");',
        'const { existsSync, writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(intermediatePidFile)}, String(process.pid));`,
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
        'grandchild.unref();',
        `const release = setInterval(() => { if (existsSync(${JSON.stringify(releaseIntermediateFile)})) { clearInterval(release); process.exit(0); } }, 20);`,
      ].join('\n');
      const rootScript = [
        'const { spawn } = require("node:child_process");',
        `const intermediate = spawn(process.execPath, ["-e", ${JSON.stringify(intermediateScript)}], { stdio: "ignore" });`,
        'intermediate.unref();',
        'setInterval(() => undefined, 10_000);',
      ].join('\n');
      const supervisor = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./process-tree-supervisor.mjs', import.meta.url),
          ),
          '-e',
          rootScript,
        ],
        {
          env: {
            ...supervisorEnv,
            CANOPY_E2E_OWNER_PID: String(process.pid),
            CANOPY_E2E_SUPERVISED_PID_FILE: supervisedPidFile,
            CANOPY_E2E_SUPERVISED_GROUPS_FILE: supervisedGroupsFile,
            CANOPY_E2E_SUPERVISED_RUN_NONCE: supervisedRunNonce,
            CANOPY_E2E_TREE_REFRESH_MS: '20',
          },
          stdio: 'ignore',
        },
      );
      const supervisorClosed = new Promise((resolve) =>
        supervisor.once('close', resolve),
      );
      let supervisedPid;
      let intermediatePid;
      let grandchildPid;

      try {
        await waitForCondition(
          () =>
            existsSync(supervisedPidFile) &&
            existsSync(intermediatePidFile) &&
            existsSync(grandchildPidFile),
          'supervised process tree did not publish its process identities',
        );
        supervisedPid = Number(readFileSync(supervisedPidFile, 'utf8'));
        intermediatePid = Number(readFileSync(intermediatePidFile, 'utf8'));
        grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
        const intermediateStart = processStartTime(intermediatePid);
        const grandchildStart = processStartTime(grandchildPid);
        assert.ok(intermediateStart);
        assert.ok(grandchildStart);

        await waitForCondition(
          () =>
            sidecarTracksGroup(
              supervisedGroupsFile,
              supervisedRunNonce,
              grandchildPid,
            ),
          'supervisor never persisted the detached group',
        );

        writeFileSync(releaseIntermediateFile, 'release');
        await waitForCondition(
          () => processStartTime(intermediatePid) !== intermediateStart,
          'intermediate process did not exit',
        );
        if (crossTimeZone) {
          const supervisorStart = processStartTime(
            grandchildPid,
            supervisorEnv,
          );
          assert.ok(supervisorStart);
          assert.notEqual(
            supervisorStart,
            grandchildStart,
            'supervisor and closeCanopy caller must render different start times',
          );
        }
        assert.equal(processStartTime(grandchildPid), grandchildStart);
        assert.ok(processStartTime(supervisedPid));

        const electronApp = { close: async () => undefined };
        registerSupervisedProcessTree(electronApp, supervisedPid, {
          trackedGroupsFile: supervisedGroupsFile,
          runNonce: supervisedRunNonce,
        });
        await closeCanopy(electronApp, fixtureDir, { keepUserData: true });

        assert.notEqual(
          processStartTime(grandchildPid),
          grandchildStart,
          'detached grandchild remained alive after closeCanopy',
        );
      } finally {
        if (Number.isInteger(grandchildPid)) {
          try {
            process.kill(-grandchildPid, 'SIGKILL');
          } catch {
            // The assertion passed or the process exited independently.
          }
        }
        if (Number.isInteger(intermediatePid)) {
          try {
            process.kill(intermediatePid, 'SIGKILL');
          } catch {
            // The intermediate already exited as part of the test flow.
          }
        }
        if (Number.isInteger(supervisedPid)) {
          try {
            process.kill(-supervisedPid, 'SIGKILL');
          } catch {
            // closeCanopy already reaped the supervised root group.
          }
        }
        if (supervisor.exitCode === null && supervisor.signalCode === null) {
          supervisor.kill('SIGKILL');
        }
        await supervisorClosed;
        rmSync(fixtureDir, { recursive: true, force: true });
        rmSync(`${fixtureDir}-secure`, { recursive: true, force: true });
      }
    },
  );
}

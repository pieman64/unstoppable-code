import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import headlessBootstrap from './browser-profiles-production-headless-bootstrap.cjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  readdir,
  symlink,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseReleaseOptions,
  requireLocalPhysicalMac,
  withLocalReleaseLease,
  releaseDriverPrefix,
  releaseChildEnvironment,
  prepareReleasePaths,
  assertReleaseStageIdentity,
  BASELINE_SHA,
  compareMetric,
  finalizeReleaseAnalysis,
  persistReleaseFinalization,
  withReleaseInterruption,
  metricPermitsExploration,
  runtimeComparisonReasons,
  runCommandProcess,
  schedule,
  requireHostedMac,
} from './browser-profiles-release-ci.mjs';

import { applyDevScriptSafetyWithWait } from '../../../../scripts/lib/dev-script-safety.mjs';

async function executeActualCommonRunner({
  diagnostic,
  deadline = false,
  hangingMark = false,
  captureStartFailure = false,
}) {
  const runnerPath = fileURLToPath(
    new URL('./browser-profiles-release-run.mjs', import.meta.url),
  );
  const source = await readFile(runnerPath, 'utf8');
  const operations = [];
  const writes = [];
  const output = '/diagnostic/result.json';
  const fakeProcess = {
    argv: [
      process.execPath,
      runnerPath,
      '--output',
      output,
      '--samples',
      '1',
      '--warmups',
      '0',
      ...(diagnostic ? ['--frame-trace-diagnostic'] : []),
    ],
    arch: process.arch,
    env: {},
    exitCode: 0,
    platform: process.platform,
    stdout: { write: (value) => operations.push(`stdout:${value.trim()}`) },
    versions: process.versions,
  };
  const page = {
    waitForLoadState: async () => operations.push('domcontentloaded'),
    evaluate: async (operation, argument) => {
      if (typeof argument === 'string') operations.push(`mark:${argument}`);
      if (hangingMark && typeof argument === 'string')
        return new Promise(() => {});
      return operation(
        {
          api: {
            browser: {
              profiles: {
                list: async () => ({ profiles: [], nextOffset: undefined }),
              },
            },
          },
          __CANOPY_DESKTOP_PERF__: {},
          document: {},
          performance: { mark: () => {} },
          window: {},
        },
        argument,
      );
    },
    getByTestId: (id) => ({
      id,
      allTextContents: async () => [],
    }),
    screenshot: async () => {},
  };
  const electronApp = {
    evaluate: async (operation, argument) => {
      const electron = {
        app: {
          getPath: () => '/tmp/browser-profile-release-fixture',
        },
        process: { versions: process.versions },
        webContents: { getAllWebContents: () => [] },
      };
      return operation(electron, argument);
    },
  };
  const monitor = {
    async stop() {
      operations.push('monitor:stop');
      return { summary: {}, raw: {} };
    },
  };
  const context = vm.createContext({
    Buffer,
    console,
    process: fakeProcess,
    performance: globalThis.performance,
    setTimeout: (callback, milliseconds, ...args) =>
      setTimeout(
        callback,
        (deadline && milliseconds === 90_000) ||
          (hangingMark && milliseconds === 1_000)
          ? 0
          : milliseconds,
        ...args,
      ),
    clearTimeout,
    URL,
    window: {
      api: {
        browser: {
          profiles: {
            list: async () => ({
              profiles: Array.from({ length: 1000 }, () => ({})),
              nextOffset: undefined,
            }),
          },
        },
      },
      __CANOPY_DESKTOP_PERF__: {},
    },
  });
  const synthetic = (identifier, values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values))
          this.setExport(key, value);
      },
      { context, identifier },
    );
  const modules = new Map();
  const getModule = async (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    let values;
    if (specifier === 'node:assert/strict') values = { default: assert };
    else if (specifier === 'node:child_process')
      values = {
        execFileSync: (file) => {
          operations.push(`command:${file}`);
          return '';
        },
      };
    else if (specifier === 'node:crypto') values = await import(specifier);
    else if (specifier === 'node:http')
      values = {
        createServer: () => ({
          address: () => ({ port: 8123 }),
          close: (callback) => callback(),
          listen: (_port, _host, callback) => callback(),
        }),
      };
    else if (specifier === 'node:fs/promises')
      values = {
        mkdir: async () => {},
        mkdtemp: async () => '/tmp/browser-profile-release-fixture',
        readFile: async (file) => {
          const name = String(file);
          if (name.endsWith('/workspaces/index.json'))
            return JSON.stringify({
              workspaces: [{ id: 'profile-benchmark-cowork' }],
            });
          if (
            name === runnerPath ||
            name.includes('browser-profiles-release-run.mjs')
          )
            return source;
          return 'fixture';
        },
        readdir: async (directory) =>
          String(directory).endsWith('/Partitions') ? [] : [],
        realpath: async (value) =>
          String(value).includes(
            'browser-profiles-production-headless-bootstrap',
          )
            ? '/capsule/bootstrap.cjs'
            : String(value),
        writeFile: async (file, value) => {
          if (String(file) === output) writes.push(JSON.parse(value));
        },
      };
    else if (specifier === 'node:os')
      values = {
        default: {
          arch: () => process.arch,
          cpus: () => [{ model: 'fixture' }],
          loadavg: () => [0, 0, 0],
          release: () => 'fixture',
          tmpdir: () => '/tmp',
          totalmem: () => 1,
        },
      };
    else if (specifier === 'node:path') values = { default: path };
    else if (specifier === 'node:url') values = { fileURLToPath };
    else if (specifier === 'node:perf_hooks')
      values = { performance: globalThis.performance };
    else if (specifier === 'node:timers/promises')
      values = { setTimeout: async () => {} };
    else if (specifier === 'node:util')
      values = {
        parseArgs: (config) => {
          const parsed = { values: {} };
          for (const [name, option] of Object.entries(config.options))
            if (option.default !== undefined)
              parsed.values[name] = option.default;
          const args = fakeProcess.argv.slice(2);
          for (let index = 0; index < args.length; index++) {
            const argument = args[index];
            assert(
              argument.startsWith('--'),
              `Unexpected argument: ${argument}`,
            );
            const name = argument.slice(2);
            const option = config.options[name];
            if (!option) throw new TypeError(`Unknown option '${name}'`);
            parsed.values[name] =
              option.type === 'boolean' ? true : args[++index];
          }
          return parsed;
        },
      };
    else if (specifier === '@playwright/test')
      values = {
        expect: () => ({
          toBeVisible: async () => {
            operations.push('workspace:visible');
            if (!diagnostic) throw new Error('canonical passivity sentinel');
          },
        }),
      };
    else if (specifier.endsWith('/launchCanopy.mjs'))
      values = {
        launchCanopy: async (options) => {
          operations.push('launch');
          operations.push(`launch-options:${JSON.stringify(options)}`);
          return { electronApp, headlessAdapter: { status: 'ok' } };
        },
        closeCanopy: async () => operations.push('close'),
        getMainWindow: async () => page,
      };
    else if (specifier.endsWith('/canopyApp.mjs'))
      values = {
        CanopyAppDriver: class {
          async waitForShell() {
            operations.push('shell');
          }
          async openMainPage() {
            operations.push('workspace:open');
          }
          async selectWorktree() {
            operations.push('workspace:select');
            if (deadline)
              await new Promise((resolve) => setTimeout(resolve, 10));
          }
        },
      };
    else if (
      specifier.endsWith('/demoWorkspaces.mjs') ||
      specifier.endsWith('/seedWorktreeChat.mjs')
    )
      values = specifier.endsWith('/demoWorkspaces.mjs')
        ? { seedDemoWorkspaces: () => {} }
        : { seedWorktreeChat: () => {} };
    else if (specifier === './monitor.mjs')
      values = {
        startPerformanceMonitor: async () => {
          operations.push('monitor:start');
          return monitor;
        },
        assertValidMonitoring: () => {},
        markRendererTask: async (_page, label) => {
          operations.push(`renderer:${label}`);
          return { label };
        },
      };
    else if (specifier === './responsiveness.mjs')
      values = { assessResponsiveness: () => ({ passed: true }) };
    else if (specifier === './profiles.mjs')
      values = { RESPONSIVENESS_THRESHOLDS: {} };
    else if (specifier === './browser-profiles-evidence.mjs')
      values = {
        beginProductionHeadlessEvidence: async () =>
          operations.push('evidence:begin'),
        endProductionHeadlessEvidence: async () =>
          operations.push('evidence:end'),
        HEADLESS_STUDY_VIEWPORT: { width: 1400, height: 900 },
        HEADLESS_STUDY_MODE: 'headless',
      };
    else if (specifier === './statistics.mjs')
      values = { summarize: () => ({}) };
    else if (specifier === './browser-profile-data-workload.mjs')
      values = { runBrowserProfileDataWorkload: async () => ({}) };
    else if (specifier === './diagnostics.mjs')
      values = {
        prepareDiagnosticLaunch: async () => {
          operations.push('capture:prepare');
          return {
            inspectorPort: 9229,
            electronArgs: ['--inspect=9229'],
            outputDir: '/diagnostic/capture',
            utilityCpuProfileDir: '/diagnostic/capture/utility-cpu',
          };
        },
        startDiagnosticCapture: async () => {
          operations.push('capture:start');
          if (captureStartFailure) {
            const error = new Error('renderer profiler start failed');
            error.diagnosticCapture = {
              status: 'partial',
              artifacts: { trace: '/diagnostic/capture/electron-trace.json' },
              errors: [
                'Electron trace: rollback timed out; Chromium stop is unconfirmed',
                'renderer CDP detach: completion is unknown',
              ],
            };
            throw error;
          }
          return {
            stop: async () => {
              operations.push('capture:stop');
              return { status: 'ok', errors: [] };
            },
          };
        },
      };
    else throw new Error(`Unexpected common runner import: ${specifier}`);
    const module = synthetic(`stub:${specifier}`, values);
    modules.set(specifier, module);
    return module;
  };
  const sourceModule = new vm.SourceTextModule(source, {
    context,
    identifier: pathToFileURL(runnerPath).href,
    initializeImportMeta(meta) {
      meta.url = pathToFileURL(runnerPath).href;
    },
  });
  await sourceModule.link((specifier) => getModule(specifier));
  let evaluationError;
  try {
    await sourceModule.evaluate();
  } catch (error) {
    evaluationError = error;
  }
  return {
    operations,
    writes,
    exitCode: fakeProcess.exitCode,
    evaluationError,
  };
}

let commonRunnerVmChild;
const commonRunnerVmTestNames = [
  'actual common runner closes the diagnostic route at workspace_ready',
  'actual common runner deadline stops capture once while workspace task settles',
  'actual common runner starts capture stop when a renderer mark never settles',
  'actual common runner retains setup rollback uncertainty in its diagnostic envelope',
  'actual common runner keeps the canonical first write and diagnostic passivity',
];
function assertCommonRunnerVmChildResult(childResult) {
  const evidence = [
    `status=${childResult.status}`,
    `signal=${childResult.signal ?? 'none'}`,
    `error=${childResult.error?.stack ?? 'none'}`,
    `stdout:\n${childResult.stdout}`,
    `stderr:\n${childResult.stderr}`,
  ].join('\n');
  assert.equal(childResult.error, undefined, evidence);
  assert.equal(childResult.signal, null, evidence);
  assert.equal(childResult.status, 0, evidence);
  const summary = childResult.stdout.match(
    /\n1\.\.(?<plan>\d+)\n# tests (?<tests>\d+)\n# suites (?<suites>\d+)\n# pass (?<pass>\d+)\n# fail (?<fail>\d+)\n# cancelled (?<cancelled>\d+)\n# skipped (?<skipped>\d+)\n# todo (?<todo>\d+)\n# duration_ms [^\n]+\n?$/,
  );
  assert(summary, evidence);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(summary.groups).map(([key, value]) => [
        key,
        Number(value),
      ]),
    ),
    {
      plan: commonRunnerVmTestNames.length,
      tests: commonRunnerVmTestNames.length,
      suites: 0,
      pass: commonRunnerVmTestNames.length,
      fail: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    },
    evidence,
  );
  assert.deepEqual(
    [
      ...childResult.stdout.matchAll(/^ok \d+ - (actual common runner .+)$/gm),
    ].map((match) => match[1]),
    commonRunnerVmTestNames,
    evidence,
  );
}
function assertCommonRunnerVmChild() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  commonRunnerVmChild ??= spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern=actual common runner',
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      encoding: 'utf8',
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  assertCommonRunnerVmChildResult(commonRunnerVmChild);
}

test('common runner VM child rejects incomplete successful TAP evidence', () => {
  const childResult = (stdout) => ({
    error: undefined,
    signal: null,
    status: 0,
    stderr: '',
    stdout,
  });
  for (const [description, stdout] of [
    ['empty', ''],
    ['truncated', 'TAP version 13\n1..5\n# tests 5\n# pass 5\n# fail 0\n'],
    [
      'unexpected population',
      'TAP version 13\n1..4\n# tests 4\n# suites 0\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n',
    ],
  ])
    assert.throws(
      () => assertCommonRunnerVmChildResult(childResult(stdout)),
      { name: 'AssertionError' },
      description,
    );
});

test('actual common runner closes the diagnostic route at workspace_ready', async () => {
  if (typeof vm.SourceTextModule !== 'function') {
    assertCommonRunnerVmChild();
    return;
  }
  const result = await executeActualCommonRunner({ diagnostic: true });
  assert.equal(result.evaluationError, undefined);
  assert(result.writes.length >= 2);
  assert.equal(result.writes[0].schemaVersion, 1);
  assert.equal(
    result.writes[0].kind,
    'browser-profile-common-frame-trace-diagnostic-v1',
  );
  assert.equal(result.writes[0].diagnosticOnly, true);
  for (const key of [
    'benchmarkKind',
    'configuration',
    'warmup',
    'samples',
    'summary',
  ])
    assert(!Object.hasOwn(result.writes[0], key), key);
  assert(!result.operations.some((entry) => entry === 'command:git'));
  const position = (value) => result.operations.indexOf(value);
  assert(position('capture:prepare') < position('launch'));
  assert(position('evidence:begin') < position('capture:start'));
  assert(position('capture:start') < position('monitor:start'));
  assert(position('workspace:visible') < position('capture:stop'));
  assert(position('capture:stop') < position('monitor:stop'));
  assert(position('monitor:stop') < position('evidence:end'));
  assert(!result.operations.some((entry) => entry.includes('cold_task_ready')));
  for (const mark of [
    'capture-armed',
    'measurement-start',
    'monitor-start',
    'shell-ready',
    'task-start:workspace_ready',
    'task-end:workspace_ready:ok',
    'stop:workspace-ready-complete',
  ])
    assert(result.operations.includes(`mark:${mark}`), mark);
  const launch = JSON.parse(
    result.operations
      .find((entry) => entry.startsWith('launch-options:'))
      .slice('launch-options:'.length),
  );
  assert.deepEqual(launch.electronArgs.slice(-1), ['--inspect=9229']);
  assert.equal(launch.env.CANOPY_PERFORMANCE_PROFILE_PLAIN_JS, '1');
  assert.equal(
    launch.env.CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR,
    '/diagnostic/capture/utility-cpu',
  );
});

test('actual common runner deadline stops capture once while workspace task settles', async () => {
  if (typeof vm.SourceTextModule !== 'function') {
    assertCommonRunnerVmChild();
    return;
  }
  const result = await executeActualCommonRunner({
    diagnostic: true,
    deadline: true,
  });
  assert.equal(result.evaluationError, undefined);
  assert.equal(
    result.operations.filter((entry) => entry === 'capture:stop').length,
    1,
  );
  assert(result.operations.includes('mark:stop:deadline'));
  assert(result.operations.includes('workspace:visible'));
  assert.equal(result.writes.at(-1).observation.status, 'partial');
  assert.equal(result.exitCode, 1);
});

test('actual common runner starts capture stop when a renderer mark never settles', async () => {
  if (typeof vm.SourceTextModule !== 'function') {
    assertCommonRunnerVmChild();
    return;
  }
  const result = await Promise.race([
    executeActualCommonRunner({ diagnostic: true, hangingMark: true }),
    // Hang detector only: module compile/link alone takes ~60-90 ms on CI.
    delay(10_000, undefined, { ref: false }).then(() => {
      throw new Error('actual runner remained blocked on renderer mark');
    }),
  ]);
  assert.equal(
    result.operations.filter((entry) => entry === 'capture:stop').length,
    1,
  );
  assert.equal(result.writes.at(-1).observation.status, 'partial');
});

test('actual common runner retains setup rollback uncertainty in its diagnostic envelope', async () => {
  if (typeof vm.SourceTextModule !== 'function') {
    assertCommonRunnerVmChild();
    return;
  }
  const result = await executeActualCommonRunner({
    diagnostic: true,
    captureStartFailure: true,
  });
  assert.match(
    String(result.evaluationError),
    /renderer profiler start failed/,
  );
  const attempt = result.writes.at(-1).observation.attempts[0];
  assert.match(attempt.error, /renderer profiler start failed/);
  assert.equal(attempt.diagnostic.status, 'partial');
  assert.deepEqual(attempt.diagnostic.errors, [
    'Electron trace: rollback timed out; Chromium stop is unconfirmed',
    'renderer CDP detach: completion is unknown',
  ]);
});

test('actual common runner keeps the canonical first write and diagnostic passivity', async () => {
  if (typeof vm.SourceTextModule !== 'function') {
    assertCommonRunnerVmChild();
    return;
  }
  const result = await executeActualCommonRunner({ diagnostic: false });
  assert.match(String(result.evaluationError), /canonical passivity sentinel/);
  assert(result.writes.length >= 1);
  assert.equal(result.writes[0].schemaVersion, 2);
  assert.equal(result.writes[0].benchmarkKind, 'release-like');
  assert.equal(result.writes[0].warmup, null);
  assert.deepEqual(result.writes[0].samples, []);
  assert.equal(
    result.operations.filter((entry) => entry === 'command:git').length,
    3,
  );
  assert(!result.operations.some((entry) => entry.startsWith('capture:')));
  assert(!result.operations.some((entry) => entry.startsWith('mark:')));
});

const report = (root, version = '42.3.0') => ({
  samples: [
    {
      runtime: {
        electron: version,
        chromium: '144.0.0.0',
        node: '24.13.0',
        userData: root,
        sessionData: root,
      },
    },
  ],
});
test('startup compares versions while preserving distinct validated isolation paths', () => {
  const before = report('/tmp/isolated-a'),
    after = report('/tmp/isolated-b');
  const original = structuredClone(after);
  assert.deepEqual(runtimeComparisonReasons('startup', after, before), []);
  assert.deepEqual(
    after,
    original,
    'Raw per-launch native paths must remain in evidence',
  );
});
test('reporting drivers require all three actual runtime versions', () => {
  for (const mode of [
    'common',
    'maintenance',
    'startup',
    'cold',
    'veto',
    'inventory',
    'retirement',
  ])
    for (const field of ['electron', 'chromium', 'node']) {
      const missing = report('/tmp/isolated');
      delete missing.samples[0].runtime[field];
      assert(
        runtimeComparisonReasons(mode, missing, missing).length > 0,
        `${mode}: missing ${field} must fail even on both reports`,
      );
      const empty = report('/tmp/isolated');
      empty.samples[0].runtime[field] = ' ';
      assert(runtimeComparisonReasons(mode, empty, empty).length > 0);
    }
});
test('changed runtime versions fail; non-reporting supplemental drivers do not invent versions', () => {
  assert(
    runtimeComparisonReasons(
      'startup',
      report('/tmp/a', '43.0.0'),
      report('/tmp/b'),
    ).length > 0,
  );
  assert(
    runtimeComparisonReasons('cold', { samples: [{}] }, { samples: [{}] })
      .length > 0,
  );
});
const metric = (before, after) =>
  compareMetric('required', Array(5).fill(before), Array(5).fill(after));
test('positive baseline retains the exact 10% boundary', () => {
  assert(metricPermitsExploration(metric(100, 110)));
  assert(!metricPermitsExploration(metric(100, 110.000001)));
});
test('both-zero is explicitly unmeasurable, never a relative pass', () => {
  const result = metric(0, 0);
  assert(
    result.statistics.every(
      (value) =>
        value.status === 'unmeasurable-both-zero' && value.ratio === null,
    ),
  );
});
test('positive candidate against zero baseline blocks automatic exploratory readiness', () => {
  const result = metric(0, 100);
  assert(!metricPermitsExploration(result));
  assert(
    result.statistics.every(
      (value) => value.status === 'zero-baseline-review-required',
    ),
  );
});
test('negative, missing and nonfinite required values are invalid', () => {
  for (const [before, after] of [
    [-1, 0],
    [0, -1],
    [100, -1],
    [undefined, 1],
    [1, undefined],
    [NaN, 1],
    [1, Infinity],
  ])
    assert(
      !metricPermitsExploration(metric(before, after)),
      `${before}/${after}`,
    );
  assert(
    !metricPermitsExploration(
      compareMetric('missing', [1, 1, 1, 1], [1, 1, 1, 1, 1]),
    ),
  );
});
test('schedule and hosted guard remain constrained', () => {
  assert.equal(schedule().length, 66);
  assert.equal(schedule().filter((x) => x.phase === 'warmup').length, 11);
  assert.throws(() => schedule(20));
  assert.throws(() => requireHostedMac({}, 'darwin'));
});
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function waitGone(pid, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && alive(pid)) await delay(20);
  return !alive(pid);
}
async function fixture(kind) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'browser-profile-ci-process-test-'),
  );
  const pidFile = path.join(directory, 'grandchild.pid');
  // Reproduce observing the file between creation and the child's PID write.
  await writeFile(pidFile, '');
  let leaderPid, grandchildPid;
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  const controller = new AbortController();
  // The owned leader exits on TERM while its tiny child deliberately ignores it.
  // The pid file is written by that child after installing its handler.
  const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  const leader = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1]],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));${kind === 'leader-exit' ? 'setTimeout(()=>process.exit(0),200);' : 'setInterval(()=>{},1000);'}`;
  let abortTimer;
  try {
    const running = runCommandProcess({
      executable: process.execPath,
      args: ['-e', leader, pidFile],
      cwd: directory,
      env: process.env,
      stdio: 'ignore',
      timeoutMs: 1500,
      termGraceMs: 100,
      killGraceMs: 2000,
      signal: controller.signal,
      onSpawn: (child) => {
        leaderPid = child.pid;
      },
    });
    for (let i = 0; i < 100; i++) {
      try {
        const candidatePid = Number(await readFile(pidFile, 'utf8'));
        if (Number.isInteger(candidatePid) && candidatePid > 1) {
          grandchildPid = candidatePid;
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await delay(10);
    }
    assert(
      Number.isInteger(grandchildPid) && grandchildPid > 1,
      'Fixture grandchild must start before exercising teardown',
    );
    if (kind === 'interruption')
      abortTimer = setTimeout(() => controller.abort(), 20);
    const result = await running;
    assert.equal(result.timedOut, kind === 'timeout');
    assert.equal(result.descendantsAfterLeaderExit, kind === 'leader-exit');
    assert.equal(result.cleanup.processGroupId, leaderPid);
    assert.equal(result.cleanup.groupGone, true);
    assert.equal(
      result.cleanup.killSent,
      true,
      'TERM-ignoring owned grandchild requires group escalation',
    );
    assert.equal(
      alive(foreign.pid),
      true,
      'A process outside the owned group must survive',
    );
    assert.equal(
      alive(grandchildPid),
      false,
      'Owned grandchild survived after immediate leader exited; direct-PID cleanup is incomplete',
    );
  } finally {
    clearTimeout(abortTimer);
    // Only exact PIDs created by this fixture; never a process-name/path sweep.
    for (const pid of [grandchildPid, leaderPid, foreign.pid])
      if (pid && alive(pid)) {
        process.kill(pid, 'SIGKILL');
        assert(
          await waitGone(pid),
          `Owned fixture PID ${pid} did not terminate`,
        );
      }
    await rm(directory, { recursive: true, force: true });
  }
}
test(
  'timeout cleans owned grandchild even when TERM makes its leader exit first',
  { skip: process.platform === 'win32' },
  async () => fixture('timeout'),
);
test(
  'interruption cleans owned grandchild before returning evidence',
  { skip: process.platform === 'win32' },
  async () => fixture('interruption'),
);

test(
  'owned cleanup retains EPERM liveness uncertainty until a later absent observation',
  { skip: process.platform === 'win32' },
  async () => {
    const controller = new AbortController();
    let processGroupId,
      originalKill,
      livenessProbes = 0;
    try {
      const result = await runCommandProcess({
        executable: process.execPath,
        args: [
          '-e',
          "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
        ],
        stdio: 'ignore',
        timeoutMs: 1000,
        termGraceMs: 100,
        killGraceMs: 100,
        signal: controller.signal,
        onSpawn: (child) => {
          processGroupId = child.pid;
          originalKill = process.kill;
          process.kill = (pid, signal) => {
            if (pid === -processGroupId && signal === 0) {
              livenessProbes++;
              if (livenessProbes === 2) {
                const error = new Error('kill EPERM');
                error.code = 'EPERM';
                throw error;
              }
            }
            return originalKill(pid, signal);
          };
          controller.abort();
        },
      });
      assert.equal(result.interrupted, true);
      assert.equal(result.cleanup.termSent, true);
      assert.equal(result.cleanup.killSent, false);
      assert.equal(result.cleanup.groupGone, true);
      assert.deepEqual(result.cleanup.errors, []);
      assert.equal(livenessProbes >= 3, true);
    } finally {
      if (originalKill) process.kill = originalKill;
      if (processGroupId && alive(processGroupId)) {
        process.kill(processGroupId, 'SIGKILL');
        assert(await waitGone(processGroupId));
      }
    }
  },
);

test(
  'owned cleanup bounds persistent EPERM liveness uncertainty without declaring the group gone',
  { skip: process.platform === 'win32' },
  async () => {
    const controller = new AbortController();
    let processGroupId,
      originalKill,
      livenessProbes = 0;
    try {
      const result = await runCommandProcess({
        executable: process.execPath,
        args: [
          '-e',
          "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
        ],
        stdio: ['ignore', 'pipe', 'ignore'],
        timeoutMs: 1000,
        termGraceMs: 30,
        killGraceMs: 40,
        signal: controller.signal,
        onSpawn: (child) => {
          processGroupId = child.pid;
          originalKill = process.kill;
          process.kill = (pid, signal) => {
            if (pid === -processGroupId && signal === 0) {
              livenessProbes++;
              if (livenessProbes >= 2) {
                const error = new Error('kill EPERM');
                error.code = 'EPERM';
                throw error;
              }
            }
            return originalKill(pid, signal);
          };
          child.stdout.once('data', () => controller.abort());
        },
      });
      assert.equal(result.cleanup.termSent, true);
      assert.equal(result.cleanup.killSent, true);
      assert.equal(result.cleanup.groupGone, false);
      assert.deepEqual(result.cleanup.errors, []);
      assert.equal(result.error, 'Owned command group cleanup incomplete');
      assert(livenessProbes > 2);
    } finally {
      if (originalKill) process.kill = originalKill;
      if (processGroupId && alive(processGroupId)) {
        process.kill(processGroupId, 'SIGKILL');
        assert(await waitGone(processGroupId));
      }
    }
  },
);

for (const [name, injectedSignal, injectedCode] of [
  [
    'terminating signal permission failure remains an error',
    'SIGTERM',
    'EPERM',
  ],
  ['unknown liveness failure remains an error', 0, 'EACCES'],
]) {
  test(
    `owned cleanup ${name}`,
    { skip: process.platform === 'win32' },
    async () => {
      const controller = new AbortController();
      let processGroupId,
        originalKill,
        injected = false;
      try {
        const result = await runCommandProcess({
          executable: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          stdio: 'ignore',
          timeoutMs: 1000,
          termGraceMs: 30,
          killGraceMs: 40,
          signal: controller.signal,
          onSpawn: (child) => {
            processGroupId = child.pid;
            originalKill = process.kill;
            process.kill = (pid, signal) => {
              if (
                !injected &&
                pid === -processGroupId &&
                signal === injectedSignal
              ) {
                injected = true;
                const error = new Error(`kill ${injectedCode}`);
                error.code = injectedCode;
                throw error;
              }
              return originalKill(pid, signal);
            };
            controller.abort();
          },
        });
        assert.equal(injected, true);
        assert.equal(result.cleanup.groupGone, false);
        assert.equal(result.error, 'Owned command group cleanup incomplete');
        assert.deepEqual(result.cleanup.errors, [
          `Error: kill ${injectedCode}`,
        ]);
      } finally {
        if (originalKill) process.kill = originalKill;
        if (processGroupId && alive(processGroupId)) {
          process.kill(processGroupId, 'SIGKILL');
          assert(await waitGone(processGroupId));
        }
      }
    },
  );
}

test(
  'owned cleanup records confirmed ESRCH as absent',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await runCommandProcess({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stdio: 'ignore',
      timeoutMs: 1000,
      termGraceMs: 30,
      killGraceMs: 40,
    });
    assert.equal(result.code, 0);
    assert.equal(result.cleanup.groupGone, true);
    assert.deepEqual(result.cleanup.errors, []);
  },
);

test(
  'natural leader exit still drains its owned descendants and reports the anomaly',
  { skip: process.platform === 'win32' },
  async () => fixture('leader-exit'),
);
test(
  'already-aborted command starts no process',
  { skip: process.platform === 'win32' },
  async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    const result = await runCommandProcess({
      executable: process.execPath,
      args: ['-e', 'process.exit(99)'],
      stdio: 'ignore',
      timeoutMs: 100,
      signal: controller.signal,
      onSpawn: () => {
        started = true;
      },
    });
    assert.equal(started, false);
    assert.equal(result.interrupted, true);
    assert.equal(result.cleanup.groupGone, true);
  },
);
test(
  'spawn failure is retained without inventing a process group',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await runCommandProcess({
      executable: '/nonexistent/browser-profile-ci-fixture',
      args: [],
      stdio: 'ignore',
      timeoutMs: 100,
      termGraceMs: 10,
      killGraceMs: 100,
    });
    assert(result.error);
    assert.equal(result.cleanup.processGroupId, null);
    assert.equal(result.cleanup.groupGone, true);
  },
);

test('fixed release qualification has 33 entries with retained warmups and AB then BA', () => {
  const plan = schedule('qualification');
  assert.equal(plan.length, 33);
  assert.equal(plan.filter((x) => x.phase === 'warmup').length, 11);
  assert.deepEqual(
    plan.slice(0, 6).map((x) => [x.stage, x.pair]),
    [
      ['baseline', -1],
      ['candidate', -1],
      ['baseline', 0],
      ['candidate', 0],
      ['candidate', 1],
      ['baseline', 1],
    ],
  );
  assert.equal(plan.filter((x) => x.mode === 'retirement').length, 3);
  assert.throws(() => schedule('stable'));
  assert.throws(() => schedule(2));
});

test('release projection refuses missing/failed workload kinds before reducing any resources', async () => {
  const { validateReleaseSample, metrics } =
    await import('./browser-profiles-release-ci.mjs');
  assert.throws(
    () => validateReleaseSample('cold', { status: 'ok', tasks: [] }),
    /task/,
  );
  assert.deepEqual(
    metrics('cold', {
      status: 'error',
      tasks: [],
      monitoring: [{ summary: { totalWorkingSetMb: { max: 999 } } }],
    }),
    {},
  );
  const task = {
    kind: 'cold_cowork_add_browser_click_to_account_ready',
    status: 'ok',
    durationMs: 1,
  };
  assert.throws(
    () => validateReleaseSample('cold', { status: 'ok', tasks: [task, task] }),
    /task/,
  );
});

test('qualification capacity requires complete corrected costs and declares 20 percent headroom without acceptance', async () => {
  const { qualificationCapacity } =
    await import('./browser-profiles-release-ci.mjs');
  const plan = schedule('qualification');
  const batch = {
    schedule: plan,
    qualificationEvidenceComplete: true,
    preparationMs: 300000,
    attempts: plan.map((p, i) => ({
      ...p,
      status: 'ok',
      commandLabel: String(i),
    })),
    commands: plan.map((p, i) => ({ label: String(i), durationMs: 1000 })),
    checks: [
      { label: 'before-0', durationMs: 100 },
      { label: 'after-0', durationMs: 100 },
    ],
  };
  const result = qualificationCapacity(batch);
  assert.equal(result.acceptance, false);
  assert.equal(result.headroom, 1.2);
  assert.equal(result.status, 'planning-capacity-within-reserves');
  assert.equal(result.combinations.length, 11);
  batch.attempts[0].status = 'failed';
  assert.equal(
    qualificationCapacity(batch).status,
    'capacity-gap-incomplete-qualified-costs',
  );
});

test('explicit release overlays reject new arbitrary helper files or changed original bytes', async () => {
  const {
    assertReviewedReleaseOverlay,
    assertReviewedFrameTraceDiagnosticOverlay,
  } = await import('./browser-profiles-release-ci.mjs');
  const supervisorFile =
    'apps/desktop-app/tests/performance/process-tree-supervisor.mjs';
  const supervisor = await readFile(
    new URL('../../../../' + supervisorFile, import.meta.url),
  );
  const supervisorSha256 = createHash('sha256')
    .update(supervisor)
    .digest('hex');
  assert.equal(
    supervisorSha256,
    // CAN-2798 normalizes ps creation-time rendering across caller environments.
    // CAN-4863 reports why the Windows supervisor selected a nonzero exit.
    '7eecae599bc42a3fdbe4a8aa58f5b00ea21c61f5b24db7bf0f58123e43b54087',
  );
  assert.doesNotThrow(() =>
    assertReviewedReleaseOverlay(
      supervisorFile,
      '0cff1607b1d40332ef15c1e96135a4d53c73d3ca5e9aed45dc67eaf53851a04d',
      supervisorSha256,
    ),
  );
  for (const previousSha256 of [null, 'wrong-original'])
    assert.throws(
      () =>
        assertReviewedReleaseOverlay(
          supervisorFile,
          previousSha256,
          supervisorSha256,
        ),
      /Original/,
    );
  assert.doesNotThrow(() =>
    assertReviewedReleaseOverlay(
      'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs',
      null,
      'new-reviewed-content',
    ),
  );
  assert.throws(
    () =>
      assertReviewedReleaseOverlay(
        'apps/desktop-app/tests/performance/unreviewed.mjs',
        null,
        'new',
      ),
    /Unreviewed/,
  );
  assert.throws(
    () =>
      assertReviewedReleaseOverlay(
        'apps/desktop-app/tests/performance/monitor.mjs',
        'wrong-original',
        'new',
      ),
    /Original/,
  );
  const diagnostic = 'apps/desktop-app/tests/performance/diagnostics.mjs';
  assert.doesNotThrow(() =>
    assertReviewedFrameTraceDiagnosticOverlay(
      diagnostic,
      '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
      '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
    ),
  );
  assert.throws(() =>
    assertReviewedFrameTraceDiagnosticOverlay(
      diagnostic,
      'wrong',
      '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
    ),
  );
  assert.throws(() =>
    assertReviewedFrameTraceDiagnosticOverlay(
      `${diagnostic}.extra`,
      '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
      '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
    ),
  );
});

test('release consumers reject complete and partial frame-trace diagnostic envelopes', async () => {
  const { classifyReleaseReport, validateReleaseSample, metrics } =
    await import('./browser-profiles-release-ci.mjs');
  for (const [status, code] of [
    ['completed', 0],
    ['partial', 1],
  ]) {
    const envelope = {
      schemaVersion: 1,
      kind: 'browser-profile-common-frame-trace-diagnostic-v1',
      diagnosticOnly: true,
      acceptanceEligible: false,
      populationContribution: 0,
      thresholdsApplied: false,
      observation: { status },
    };
    assert.throws(
      () => classifyReleaseReport('common', envelope, code, {}),
      /schema/,
    );
    assert.throws(
      () => validateReleaseSample('common', envelope),
      /diagnostic/,
    );
    assert.deepEqual(metrics('common', envelope), {});
  }
});

const RELEASE_HELPER_IDENTITIES = Object.freeze({
  'apps/desktop-app/tests/performance/browser-profiles-release-evidence.mjs': [
    null,
    '9f6834b076e6a807d28fb7a225f89209608f36a914e6846563d082f299e08228',
  ],
  'apps/desktop-app/tests/electron/canopyApp.mjs': [
    '32901c00d59424d256ae6d84e307da3204240d454a9a2c3a86f05e9ce92dde7a',
    '2ce655e6a2782cb311f928f95ba62f854d17f4d4d1318e896ccf9eddac20dc8d',
  ],
  'apps/desktop-app/tests/electron/launchCanopy.mjs': [
    'fd591e8a4999aecea184e1201bc4167f2e954efcbab0e6fef1481f6254be7c4a',
    'f5ac00a1ab88f5df076ddfee3b5a8f51f0170686c765b239f66ad0005a31291b',
  ],
  'scripts/lib/e2e-harness-measurement.mjs': [
    null,
    'd9f0634bd0ec475ede901072aabb8b3196b5da14d3142786a18cdb4475241fff',
  ],
  'apps/desktop-app/tests/electron/seeders/browser-profile-state.mjs': [
    '4f4983f03a92f571f7c339e503a3b6a9151f773b523df9ef901e33ce465290fc',
    'fe307589f6210db468cc225a3b4ca7e718b8f6aaaf267b24d7548962797c779d',
  ],
  'apps/desktop-app/tests/electron/demoWorkspaces.mjs': [
    '3c3a8a1c3623d17bc3e37021f651c9293e1a698b6c5f47c9b4e7ca5ed26675e7',
    '3c3a8a1c3623d17bc3e37021f651c9293e1a698b6c5f47c9b4e7ca5ed26675e7',
  ],
  'apps/desktop-app/tests/electron/seeders/fsHelpers.mjs': [
    'd956424809278b0d65e4ec5b9f37dfde312a84641408a21a6a6b160971a690bd',
    'd956424809278b0d65e4ec5b9f37dfde312a84641408a21a6a6b160971a690bd',
  ],
  'apps/desktop-app/tests/electron/seeders/seedWorktreeChat.mjs': [
    'f43372c5fd3486929f3e426ebd665d07b815b744f62d8f81331a3c816c12ae1d',
    'e5f3141115896689a380646646a5fed7a3d132d5d909016a06d394fa8c36247f',
  ],
  'apps/desktop-app/tests/performance/responsiveness.mjs': [
    'c2529ae8fc04b3151dd1c6c783091a54615d899a3ce11a9d7e9b8b4274c1cf84',
    'c2529ae8fc04b3151dd1c6c783091a54615d899a3ce11a9d7e9b8b4274c1cf84',
  ],
  'apps/desktop-app/tests/performance/statistics.mjs': [
    '83235fd86f5852c6380ed3d3b7c4698949f9b92bd9271739dc5131ac28415168',
    '83235fd86f5852c6380ed3d3b7c4698949f9b92bd9271739dc5131ac28415168',
  ],
  'apps/desktop-app/tests/performance/browser-profile-data-workload.mjs': [
    null,
    'bcf49c489d4a6de229d1032c99e2bbc490de9bc66d915725feed3c81d9a4a955',
  ],
  'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs': [
    null,
    '5746d0a79c90fb6963b83b8d727388bfe30905a69c9a26dfb1a934c0d7c7fdf8',
  ],
  'apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs':
    [null, '024dd62703709dc18cb4ff1ec35aeeaccd42940f6f5e8f43bc638753d9abf9b4'],
  'apps/desktop-app/tests/performance/browser-profiles-production-headless-preflight.mjs':
    [null, 'c632026c2fdd8c8230e16ca9d631ebbf9ed2bb224821935da5cf8bca8cfa75f8'],
  'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs': [
    '1f8f99a193256929cc4d70e8731e193a6482bff9e2334889449ae3f9af37a5f8',
    'a4c8f61e7752fbfa0869b1483fe957cc6ce43e09b5f9d97a27ab2981bd070a21',
  ],
  'apps/desktop-app/tests/performance/diagnostics.mjs': [
    '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
    '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
  ],
  'apps/desktop-app/tests/performance/hotspots.mjs': [
    '69ca90c612620e7b54a5e85b58d82bedcdfff312240e147963c8d0ec967a3a13',
    '69ca90c612620e7b54a5e85b58d82bedcdfff312240e147963c8d0ec967a3a13',
  ],
  'apps/desktop-app/tests/performance/inspector-client.mjs': [
    'b8122da08eaf9c0835a0ac11378fbba2a98486cb9eec5f99f1dac40ad760010f',
    'b8122da08eaf9c0835a0ac11378fbba2a98486cb9eec5f99f1dac40ad760010f',
  ],
  'apps/desktop-app/tests/performance/browser-profiles-startup-run.mjs': [
    null,
    'a2052bc6fc79b375416b8c66a7556af90ab61b7abdde1479833906337ac7e17b',
  ],
  'apps/desktop-app/tests/performance/browser-profiles-startup-sampler.mjs': [
    null,
    '23d1f2b197fded916dc7dd7577c263c5077feaf4ec3e63cbeb8b732b69b27451',
  ],
  'apps/desktop-app/tests/performance/browser-profiles-supplemental-run.mjs': [
    null,
    '6f93e54f524332e1a65f72e176712006a8615e5907a103a630ba4c51fdf3ac0e',
  ],
  'apps/desktop-app/tests/performance/monitor.mjs': [
    '5d644bd000078fce4776cc0f8d09072cfc3ec719cf98da331dd1e27db53de02c',
    '909b52498c7a3ade1f4d6eb9e2fa5ee742e50dd85ad55e2833741b505de7eba3',
  ],
  'apps/desktop-app/tests/performance/process-tree-supervisor.mjs': [
    '0cff1607b1d40332ef15c1e96135a4d53c73d3ca5e9aed45dc67eaf53851a04d',
    'dbe4df44ed6d7b0e99936a7dc6dc4da30f68ee8f7b65de7023da4aae3f93a80e',
  ],
  'apps/desktop-app/tests/performance/profiles.mjs': [
    '63217c1d9d4714ec0602a0f4cca00f157322ea101a2a207e3ea4d3c9f9a10667',
    '99559a2c82b97167abc7ed6459c05fdbe3f36f7c876d9c28fad64f1716612ad9',
  ],
});
const MERGED_BASE_RELEASE_HELPER_IDENTITIES = Object.freeze({
  // The PR merge ref includes the base branch's PostHog E2E flag defaults,
  // without the manual sidebar-order seeding (manual is now the default),
  // and pins the space-notification switch on (CAN-3615).
  'apps/desktop-app/tests/electron/launchCanopy.mjs':
    'e85a95fe39748c34bb0209ba8d6ff47a6d2f433547710b04f531604b6ad77d0a',
  // The opt-in plan-open workload adds its profile keys; defaults unchanged.
  'apps/desktop-app/tests/performance/profiles.mjs':
    'cd6e17360673055c70c4c29c608a2cc594bee4d464360142bd25e008e414efa1',
});
const REVIEWED_PR_RELEASE_HELPER_IDENTITIES = Object.freeze({
  // CAN-4635 fixes normalized keychain argv and adds native timing diagnostics.
  // Keep the closed study original/installed identities unchanged.
  'apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs':
    '2eda7963b7b4f7c7e3fc10dad3b99ecf50dab74cfed54707685068fdd02b2206',
  // CAN-2798 normalizes ps creation-time rendering across caller environments.
  // Preserve the closed study's original and installed supervisor identities.
  // CAN-4863 reports why the Windows supervisor selected a nonzero exit.
  'apps/desktop-app/tests/performance/process-tree-supervisor.mjs':
    '7eecae599bc42a3fdbe4a8aa58f5b00ea21c61f5b24db7bf0f58123e43b54087',
  // PR #4973 adds scoped sizing for the opt-in Cost index workload;
  // foreground-first streaming phase 01 adds the opt-in background-streaming
  // and chat-switch-catch-up scenarios and their scoped sizing keys; phase 04
  // adds the opt-in --foreground-first-delivery switch; phase 06 adds the
  // opt-in --chat-switch-hover-ms switch; the graduation removes the
  // --foreground-first-delivery switch.
  // Preserve the closed study's original/installed pair.
  'apps/desktop-app/tests/performance/profiles.mjs':
    '8505542582d823d84ef7483af94111e9f6328c6ea88541259bb77feb7735da51',
  // CAN-3696 enables OpenCode while retaining the merged launcher defaults
  // and Linux isolation; CAN-4019 also pins the account proxy flag on. The
  // frozen study identities remain unchanged.
  // CAN-3755 also pins the device remote control flag on, and the chat
  // visuals stack pins canopy-desktop-chat-visuals on.
  // CAN-3662 pins Early access to offered; native window identity is rechecked on load.
  // CAN-3678 seeds the page experiment defaults.
  'apps/desktop-app/tests/electron/launchCanopy.mjs':
    // CAN-4386 pins the hosted settings flag on in the E2E defaults.
    '9c185c5345361d44a33d7f7064e1c5b4fab3d3cf1e9c9f7ff0d17e1c9d4e49fc',
});

// Later reviewed changes to study-owned helpers, keyed by the study's installed
// identity. The study's original/installed pairs above stay intact.
const REVIEWED_CURRENT_RELEASE_HELPER_IDENTITIES = Object.freeze({
  // The work-counter metric layer adds an opt-in renderer work-counter session
  // to the monitor and the counters profile to the profiles; the app-side
  // counters add the opt-in main-process and React samples to the monitor.
  // Phase 05 adds the opt-in frame-budget observers and retried
  // main-process counter reads to the monitor, and the opt-in scenarios and
  // their scoped sizing keys to the profiles. Phase 06 adds --repeat and
  // --e2e-root to the profiles; phase 09 adds --chat-delta-journal; phase 17
  // adds --renderer-code-cache-scheme and --warm-launches.
  // Regression follow-up: timed runs no longer estimate IPC bytes; only the
  // counters profile does. The opt-in managed-delegation-concurrency scenario
  // adds its scoped sizing keys to the profiles. CAN-4307 keeps the window's
  // routed-read counters as `summary.routeWork` evidence; they are never
  // bracketed or a metric.
  'apps/desktop-app/tests/performance/monitor.mjs': Object.freeze({
    '909b52498c7a3ade1f4d6eb9e2fa5ee742e50dd85ad55e2833741b505de7eba3':
      '078c8f8ab1627b82c22047d9cbc781944fbf194ac3b6437b7998b72143685d27',
  }),
  // Transcript reference previews add the opt-in linear-reference-transcripts
  // scenario and its scoped sizing keys to the profiles; the opt-in
  // managed-delegation-concurrency scenario and the opt-in Agent Ledger
  // workloads add their own. Defaults are unchanged.
  // Forced cutover removes the retired --chat-delta-journal switch.
  // CAN-1570 phase 03 adds --browser-actions-iterations and the opt-in browser-actions scenario.
  // Phase 04 adds --browser-agent-actions-iterations and the opt-in browser-agent-actions scenario.
  'apps/desktop-app/tests/performance/profiles.mjs': Object.freeze({
    '99559a2c82b97167abc7ed6459c05fdbe3f36f7c876d9c28fad64f1716612ad9':
      // CAN-3804 adds the worktree Git gate keys; other defaults are unchanged.
      // Compose CAN-385 backfill with foreground-first streaming scenarios and
      // the CAN-1570 opt-in browser-actions and browser-agent-actions scenarios.
      // CAN-3987 adds the opt-in claude-graph-orientation scenario's sizing keys.
      // Sidebar reorder is opt-in; every existing workload default is unchanged.
      // CAN-4495 adds the opt-in Code Review registry scenarios and their
      // scoped sizing keys; existing defaults are unchanged.
      '6c025906738df9b1e3e83afe25098a3077b6110e74f03d3eea511fe5e38b3778',
  }),
  // Phase 17 adds the local-only CANOPY_E2E_RENDERER_CODE_CACHE_SCHEME switch
  // that seeds the code-cache scheme experiment, expects its window URL and
  // gives that launch its own Electron --user-data-dir.
  // The develop sync brings 18cc0b87ad's per-space notification menu
  // coverage into launchCanopy.mjs on top of the stack's changes. The Cursor
  // inherited-capabilities fixture also isolates the simulated user's home.
  // CAN-3180 composes Linux isolation with these launcher changes and the
  // opt-in application's arguments while retaining the frozen study identity.
  // CAN-3122 autocapture and CAN-3755 remote control share the E2E defaults.
  'apps/desktop-app/tests/electron/launchCanopy.mjs': Object.freeze({
    ba654cacd0b7c2a841cdf6ffb57e1238a69609771f1f19481f5e924a09e667ec:
      '5a35415ce538aae879236d3ccdaf970f4edf00149a4741ce9f5ab8f9dbd5e76c',
    f5ac00a1ab88f5df076ddfee3b5a8f51f0170686c765b239f66ad0005a31291b:
      // PR #5286 sets only the E2E Claude usage freshness override to zero.
      // CAN-3662 pins Labs early access to offered in the E2E defaults.
      // Native window identity is also rechecked on load.
      // CAN-3678 seeds the page experiment defaults.
      // CAN-385 pins skill suggestions on in the shared E2E defaults.
      // Frozen study identities and original-source proof stay unchanged.
      // CAN-4386 pins the hosted settings flag on in the E2E defaults.
      // PR #5730 pins the external-agents menu on in shared E2E defaults.
      // CAN-4455 isolates the test renderer from an inherited Crashpad pipe.
      // CAN-4266 drops the retired Labs Agents page flag from the E2E defaults.
      // CAN-4863 waits for the Windows launcher to close before its terminal
      // check, retries a late Windows supervised PID file, passes only a
      // launch's own offscreen-window request, and reports Windows close steps
      // and launcher output with a nonzero terminal result. An expired
      // launcher wait keeps and names the fixture data roots and fails teardown.
      // CAN-4603 pins Files reads to offered so ordinary E2E stays direct.
      // CAN-4904 seeds every onboarding tip as dismissed unless a spec opts
      // out with freshOnboardingTips.
      // CAN-4010 removes retired checklist seeding and its launch env seam.
      // CAN-4633 permits an explicit LaunchDarkly startup fixture client only
      // with an HTTP loopback endpoint; inherited live clients stay unset.
      // PR #6905 relays main's best-effort render-process-gone reason to the
      // test's stderr; launch behavior is unchanged.
      // CAN-4551 pins the chat automation pipelines experiment to offered so
      // ordinary E2E saves chat automations natively.
      '7e309a3641f379a8eb6395d45fdafee72f43b445eddb4f6c33d5b7bc62ff7663',
  }),
  // CAN-3972 adds Home Getting Started checklist helpers to the app driver
  // while the sidebar card is hidden on Home. CAN-3980 adds Workflows tab and
  // Marketplace "Shared by me" navigation helpers.
  // CAN-3981 adds Workflows Library search, row and New workflow helpers.
  // PR #5101 adds the first-run import page's skip helper.
  // CAN-4072 adds the full-page Workflows edit shell helpers.
  // PR #5369 adds the edit shell's More menu and delete confirmation helpers.
  // PR #5404 opens Environments from Settings instead of the sidebar.
  // CAN-3678 moves page features behind Labs experiments: More menu and
  // Settings → Labs helpers.
  // CAN-3659 opens Remote Control from the account menu.
  // CAN-4421 adds consolidated Settings rail and hosted settings helpers.
  // CAN-4260 renames the plugins page heading from Marketplace to Customize.
  // CAN-4266 opens local agents from the Marketplace Agents tab.
  // CAN-4261 merges the shared Installed rows and breadcrumb navigation.
  // CAN-4267 preserves Customize navigation alongside the root-return helper.
  // Labs graduation opens Advisor in its native view before expanding it,
  // preserving a collapsed navigation pane in the full layout.
  // PR #6140 lands an agent created from Add custom on its own detail.
  // PR #6126 expects the Customize row to return to the root, so the
  // Marketplace Agents helper no longer closes an open detail itself.
  // The UI Automation triage of #6116 lands any item created from Add custom
  // on its own detail.
  // PR #6419 (search fields) adds the Library Filter helper: facets open from
  // the Filter button nested in the search field.
  // PR #6728 (page search rows) opens each Library filter from its row in the
  // Filter dropdown and adds the Audit trail filter helper.
  'apps/desktop-app/tests/electron/canopyApp.mjs': Object.freeze({
    '2ce655e6a2782cb311f928f95ba62f854d17f4d4d1318e896ccf9eddac20dc8d':
      // CAN-4010 removes only the retired Home checklist driver helpers.
      'cbac6b8d5a605d3c932d129d6eba0c222e2606b911e5c866edc7e5d9a20416f9',
  }),
  // Phase 16 gives App Advisor its own renderer page, so the evidence and the
  // preflight accept app-advisor.html?surface=app-advisor beside index.html.
  'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs':
    Object.freeze({
      '5746d0a79c90fb6963b83b8d727388bfe30905a69c9a26dfb1a934c0d7c7fdf8':
        '4af2354caaa78098dbc1de4fd0f6328f0ac93786f6df2fd91abffa9c2f89ce71',
    }),
  'apps/desktop-app/tests/performance/browser-profiles-production-headless-preflight.mjs':
    Object.freeze({
      c632026c2fdd8c8230e16ca9d631ebbf9ed2bb224821935da5cf8bca8cfa75f8:
        '0ac5511365f2728dd6a2f7ba0ec1d6a1752e98d44c3d59060ade27fc694d1fec',
    }),
});

function pinnedReleaseHelperIdentity(file, finalSha256) {
  const identity = RELEASE_HELPER_IDENTITIES[file];
  assert(identity, `Missing pinned release helper identity: ${file}`);
  assert(
    (file === 'apps/desktop-app/tests/electron/launchCanopy.mjs' &&
      finalSha256 ===
        '2eeb24b176f51704e709d3846b639cb8c46131e3ca934d73acd537585c059dd0') ||
      finalSha256 ===
        (REVIEWED_CURRENT_RELEASE_HELPER_IDENTITIES[file]?.[identity[1]] ??
          identity[1]) ||
      finalSha256 === MERGED_BASE_RELEASE_HELPER_IDENTITIES[file] ||
      finalSha256 === REVIEWED_PR_RELEASE_HELPER_IDENTITIES[file],
    `Current release helper bytes changed: ${file}`,
  );
  return identity;
}

async function actualReleaseHelperClosure(root) {
  const require = createRequire(path.join(root, 'package.json'));
  const ts = require('typescript');
  const files = new Set();
  async function visit(relative) {
    if (files.has(relative)) return;
    assert(
      relative.startsWith('apps/desktop-app/tests/') ||
        relative.startsWith('scripts/lib/') ||
        relative.startsWith('demo-apps/'),
      `Unexpected production/config test import: ${relative}`,
    );
    files.add(relative);
    const absolute = path.join(root, relative);
    const source = ts.createSourceFile(
      absolute,
      await readFile(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
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
      await visit(path.normalize(path.join(path.dirname(relative), specifier)));
  }
  const driverRoot = 'apps/desktop-app/tests/performance/';
  for (const file of [
    'browser-profiles-release-run.mjs',
    'browser-profiles-startup-run.mjs',
    'browser-profiles-supplemental-run.mjs',
    'browser-profiles-production-headless-bootstrap.cjs',
    'browser-profiles-production-headless-preflight.mjs',
  ])
    await visit(driverRoot + file);
  await visit('demo-apps/seed-canopy-data.mjs');
  return files;
}

test('actual release helper closure passes every immutable original/final pair through default admission', async () => {
  const { assertReviewedReleaseOverlay } =
    await import('./browser-profiles-release-ci.mjs');
  const root = new URL('../../../../', import.meta.url).pathname.replace(
    /\/$/,
    '',
  );
  const closure = await actualReleaseHelperClosure(root);
  assert.equal(closure.size, 30);
  const helpers = [...closure]
    .filter(
      (file) =>
        file.startsWith('apps/desktop-app/tests/') ||
        file.startsWith('scripts/lib/'),
    )
    .sort();
  assert.equal(helpers.length, 24);
  assert.equal(Object.keys(RELEASE_HELPER_IDENTITIES).length, 24);
  for (const file of Object.keys(RELEASE_HELPER_IDENTITIES))
    assert(helpers.includes(file), file);
  for (const file of helpers) {
    const finalSha256 = createHash('sha256')
      .update(await readFile(path.join(root, file)))
      .digest('hex');
    const identity = pinnedReleaseHelperIdentity(file, finalSha256);
    const originalSha256 = identity[0];
    assert.doesNotThrow(
      () => assertReviewedReleaseOverlay(file, originalSha256, finalSha256),
      file,
    );
  }
  const unchangedFile = 'apps/desktop-app/tests/performance/statistics.mjs';
  const unchangedSource = await readFile(path.join(root, unchangedFile));
  const mutatedSha256 = createHash('sha256')
    .update(Buffer.concat([unchangedSource, Buffer.from('\n')]))
    .digest('hex');
  assert.throws(
    () => pinnedReleaseHelperIdentity(unchangedFile, mutatedSha256),
    /Current release helper bytes changed/,
  );
});
test('valid cold resources project only completed tasks, with invalid individual durations retained outside distributions', async () => {
  const { validateReleaseSample, metrics } =
    await import('./browser-profiles-release-ci.mjs');
  const sample = {
    status: 'ok',
    tasks: [
      {
        kind: 'cold_cowork_add_browser_click_to_account_ready',
        status: 'ok',
        durationMs: 1,
      },
      {
        kind: 'cold_advisor_add_browser_click_to_account_ready',
        status: 'ok',
        durationMs: 2,
      },
    ],
    monitoring: [
      {
        scope: 'workload',
        summary: Object.fromEntries(
          [
            'ipcOuterMs',
            'rendererFrameDelayMs',
            'totalWorkingSetMb',
            'totalCpuPercent',
          ].map((field) => [field, { count: 1, max: 10 }]),
        ),
        raw: { renderer: { longTaskObserverAvailable: true, frames: [{}] } },
      },
    ],
  };
  assert.equal(validateReleaseSample('cold', sample), sample);
  assert.equal(
    metrics('cold', sample)[
      'cold_advisor_add_browser_click_to_account_ready.medianWithinRunMs'
    ],
    2,
  );
  sample.tasks[1].durationMs = -1;
  assert.throws(() => validateReleaseSample('cold', sample), /invalid/);
  assert.deepEqual(metrics('cold', sample), {});
  assert.equal(sample.tasks[1].durationMs, -1);
});

function qualificationFinalizationFixture() {
  const plan = schedule('qualification');
  return {
    batch: {
      schedule: plan,
      preparationMs: 300000,
      attempts: plan.map((entry, index) => ({
        ...entry,
        status: 'ok',
        commandLabel: String(index),
      })),
      commands: plan.map((entry, index) => ({
        label: String(index),
        durationMs: 1000,
      })),
      checks: [
        { label: 'before-0', durationMs: 100 },
        { label: 'after-0', durationMs: 100 },
      ],
    },
    analysis: {
      status: 'qualification-incomplete-or-failed',
      finalAcceptance: false,
      missingAttempts: 0,
      failures: [],
      modes: Object.fromEntries(
        [
          'common',
          'maintenance',
          'startup',
          'cold',
          'veto',
          'inventory',
          'retirement',
        ].map((mode) => [mode, { status: 'qualification-workload-complete' }]),
      ),
    },
  };
}
test('release finalization reaches complete qualification and qualified capacity from all successful mode rows', () => {
  const { batch, analysis } = qualificationFinalizationFixture();
  assert.equal(Object.hasOwn(batch, 'qualificationEvidenceComplete'), false);
  finalizeReleaseAnalysis(batch, analysis, true);
  assert.equal(analysis.status, 'qualification-complete-no-acceptance');
  assert.equal(analysis.capacity.status, 'planning-capacity-within-reserves');
  assert.equal(analysis.finalAcceptance, false);
});
test('release qualification finalization rejects a missing or failed mode and keeps capacity incomplete', () => {
  for (const mutate of [
    (analysis) => delete analysis.modes.inventory,
    (analysis) => (analysis.modes.retirement.status = 'failed-or-incomplete'),
  ]) {
    const { batch, analysis } = qualificationFinalizationFixture();
    mutate(analysis);
    finalizeReleaseAnalysis(batch, analysis, true);
    assert.equal(analysis.status, 'qualification-incomplete-or-failed');
    assert.equal(
      analysis.capacity.status,
      'capacity-gap-incomplete-qualified-costs',
    );
  }
});
test('release exploratory finalization keeps its separate complete status without qualification capacity', () => {
  const { batch, analysis } = qualificationFinalizationFixture();
  analysis.status = 'exploratory-incomplete-or-failed';
  for (const mode of Object.values(analysis.modes))
    mode.status = 'exploratory-protocol-passed';
  finalizeReleaseAnalysis(batch, analysis, false);
  assert.equal(
    analysis.status,
    'exploratory-protocol-passed-not-final-acceptance',
  );
  assert.equal(analysis.capacity, undefined);
});

test('local qualification rejects CI simulation before preparation with an explicit local diagnostic', () => {
  const result = spawnSync(
    process.execPath,
    [
      'apps/desktop-app/tests/performance/browser-profiles-release-ci.mjs',
      '--execution',
      'local-physical',
      '--protocol',
      'qualification',
      '--workspace',
      '/tmp/local-study',
      '--baseline',
      '/tmp/local-study/baseline',
      '--candidate',
      '/tmp/local-study/candidate',
      '--candidate-commit',
      'eb73c3182ce409477f86ee4a3e01ad9cca20ca50',
      '--output',
      '/tmp/local-study/fresh-output',
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true' },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Local physical qualification rejects environment marker: CI/,
  );
});

const localCommit = 'eb73c3182ce409477f86ee4a3e01ad9cca20ca50';
const localOptions = [
  '--execution',
  'local-physical',
  '--protocol',
  'qualification',
  '--workspace',
  '/tmp/study',
  '--baseline',
  '/tmp/study/baseline',
  '--candidate',
  '/tmp/study/candidate',
  '--candidate-commit',
  localCommit,
  '--output',
  '/tmp/study/evidence',
];
test('local options admit only the closed 33-attempt qualification and reject all sampling/bypass switches', () => {
  const values = parseReleaseOptions(localOptions);
  assert.equal(schedule(values.protocol).length, 33);
  const groups = Map.groupBy(
    schedule(values.protocol),
    (row) => `${row.mode}/${row.stage}`,
  );
  assert.equal(groups.size, 11);
  for (const rows of groups.values())
    assert.deepEqual(
      rows.map(({ phase, pair }) => ({ phase, pair })),
      [
        { phase: 'warmup', pair: -1 },
        { phase: 'measured', pair: 0 },
        { phase: 'measured', pair: 1 },
      ],
    );
  for (const protocol of ['stable', 'exploratory'])
    assert.throws(() =>
      parseReleaseOptions([...localOptions, '--protocol', protocol]),
    );
  for (const flag of [
    '--samples',
    '--warmups',
    '--mode',
    '--resume',
    '--reuse',
    '--retry',
    '--retries',
    '--danger-skip-concurrency-safety-lock',
    '--danger-skip-memory-pressure-safety-check',
    '--no-guard-wait',
  ])
    assert.throws(() => parseReleaseOptions([...localOptions, flag, '1']));
  for (const key of ['--workspace', '--candidate-commit']) {
    const args = [...localOptions];
    args.splice(args.indexOf(key), 2);
    assert.throws(() => parseReleaseOptions(args));
  }
  for (const sha of ['', 'eb73', 'a'.repeat(41), 'G'.repeat(40)])
    assert.throws(() =>
      parseReleaseOptions([...localOptions, '--candidate-commit', sha]),
    );
  assert.throws(() =>
    parseReleaseOptions([...localOptions, '--execution', 'hosted']),
  );
  const hosted = parseReleaseOptions([
    '--baseline',
    '/a',
    '--candidate',
    '/b',
    '--output',
    '/c',
  ]);
  assert.equal(hosted.execution, 'hosted');
  assert.equal(schedule(hosted.protocol).length, 66);
});
test('local host rejects every actual safety override and CI/runner marker, even false or empty values', () => {
  requireLocalPhysicalMac({}, 'darwin', 'v24.22.1');
  assert.throws(
    () => requireLocalPhysicalMac({}, 'linux', 'v24.22.1'),
    /Darwin/,
  );
  assert.throws(
    () => requireLocalPhysicalMac({}, 'darwin', 'v24.15.0'),
    /actual Node/,
  );
  for (const key of [
    'CI',
    'GITHUB_ACTIONS',
    'GITHUB_SHA',
    'GITHUB_WORKSPACE',
    'RUNNER_OS',
    'RUNNER_ENVIRONMENT',
    'RUNNER_TEMP',
    'ImageOS',
    'ImageVersion',
    'CANOPY_DEV_SCRIPT_MEMORY_PRESSURE_THRESHOLD_MB',
    'CANOPY_DEV_PERF_SUITE_MAX_RUN_CONCURRENCY',
    'CANOPY_DEV_E2E_SUITE_MAX_RUN_CONCURRENCY',
  ])
    for (const value of ['', 'false', '1'])
      assert.throws(
        () => requireLocalPhysicalMac({ [key]: value }, 'darwin', 'v24.22.1'),
        /rejects/,
      );
});
test('local child environment omits simulation and retains every production build flag', () => {
  const source = {
    PATH: '/example',
    HOME: '/home',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '23',
    RUNNER_TEMP: '/runner',
    NODE_OPTIONS: '--require evil',
    CANOPY_E2E_BUILD: '1',
  };
  const hosted = releaseChildEnvironment('hosted', source),
    local = releaseChildEnvironment('local-physical', source);
  assert.equal(hosted.CI, 'true');
  assert.equal(hosted.GITHUB_ACTIONS, 'true');
  assert.equal(hosted.GITHUB_RUN_ID, '23');
  for (const key of Object.keys(local))
    assert(!/^(CI$|GITHUB_|RUNNER_)/.test(key));
  assert.equal(local.NODE_OPTIONS, undefined);
  for (const [key, value] of Object.entries(hosted))
    if (!/^(CI$|GITHUB_|RUNNER_|PATH$)/.test(key))
      assert.equal(local[key], value, key);
  assert.equal(local.CANOPY_E2E_BUILD, '0');
  assert.equal(local.CANOPY_RENDERER_OBFUSCATION, 'false');
  assert.equal(local.CANOPY_RENDERER_OBFUSCATE_VENDOR, 'false');
  assert.deepEqual(releaseDriverPrefix('hosted'), [
    'scripts/run-guarded-dev-script.mjs',
    '--suite',
    'performance',
    '--',
    process.execPath,
    '--import',
    'tsx',
  ]);
  assert.throws(
    () => releaseDriverPrefix('local-physical', { lease: true }),
    /active lease/,
  );
});
test('local stage selection requires exact baseline commit/tree and explicitly selected candidate', () => {
  const baselineTree = '7e063f1552bea71e55690d57538ccbbb71bf730a';
  assertReleaseStageIdentity(
    'baseline',
    BASELINE_SHA,
    baselineTree,
    localCommit,
  );
  assertReleaseStageIdentity(
    'candidate',
    localCommit,
    '4662d651eb482046c360b82c4083032ec7a441e6',
    localCommit,
  );
  assert.throws(
    () =>
      assertReleaseStageIdentity(
        'baseline',
        localCommit,
        baselineTree,
        localCommit,
      ),
    /commit/,
  );
  assert.throws(
    () =>
      assertReleaseStageIdentity(
        'baseline',
        BASELINE_SHA,
        'f'.repeat(40),
        localCommit,
      ),
    /tree/,
  );
  assert.throws(
    () =>
      assertReleaseStageIdentity(
        'candidate',
        BASELINE_SHA,
        baselineTree,
        localCommit,
      ),
    /commit/,
  );
  assert.throws(
    () =>
      assertReleaseStageIdentity(
        'candidate',
        localCommit,
        baselineTree,
        undefined,
      ),
    /exact full SHA/,
  );
});
test('local canonical workspace refuses overlaps, escapes, reused outputs and prior dependencies/builds', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'release-local-paths-'));
  const workspace = await realpath(temporary);
  const baseline = path.join(workspace, 'baseline'),
    candidate = path.join(workspace, 'candidate');
  const values = {
    execution: 'local-physical',
    workspace,
    baseline,
    candidate,
    output: path.join(workspace, 'evidence'),
  };
  try {
    await mkdir(baseline);
    await mkdir(candidate);
    const prepared = await prepareReleasePaths(values);
    assert.deepEqual(prepared.roots, { baseline, candidate });
    await assert.rejects(prepareReleasePaths(values), /EEXIST/);
    await assert.rejects(
      prepareReleasePaths({ ...values, candidate: baseline }),
      /disjoint/,
    );
    await mkdir(path.join(baseline, 'nested'));
    await assert.rejects(
      prepareReleasePaths({
        ...values,
        candidate: path.join(baseline, 'nested'),
      }),
      /disjoint/,
    );
    await symlink(baseline, path.join(workspace, 'alias'));
    await assert.rejects(
      prepareReleasePaths({
        ...values,
        candidate: path.join(workspace, 'alias'),
      }),
      /disjoint/,
    );
    await assert.rejects(
      prepareReleasePaths({
        ...values,
        output: path.join(workspace, 'alias', 'evidence'),
      }),
      /outside stage/,
    );
    await symlink(tmpdir(), path.join(workspace, 'escape'));
    await assert.rejects(
      prepareReleasePaths({
        ...values,
        output: path.join(workspace, 'escape', 'evidence'),
      }),
      /canonical workspace/,
    );
    await assert.rejects(
      prepareReleasePaths({ ...values, candidate: tmpdir() }),
      /checkout children/,
    );
    for (const relative of ['node_modules', 'out', 'out-e2e', '.cache']) {
      await mkdir(path.join(candidate, relative));
      await assert.rejects(
        prepareReleasePaths({
          ...values,
          output: path.join(workspace, `fresh-${relative}`),
        }),
        /must be fresh/,
      );
      await rm(path.join(candidate, relative), { recursive: true });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const outcome of [
  'normal',
  'preparation-failure',
  'interruption',
  'timeout',
  'finalization-failure',
]) {
  test(`actual local safety lease encloses owned execution and releases after ${outcome}`, async () => {
    const lockRoot = await mkdtemp(path.join(tmpdir(), 'release-local-lease-'));
    const controller = new AbortController();
    let owner,
      acquisitions = 0,
      finalizationObserved = false;
    const slots = () => readdir(path.join(lockRoot, 'desktop-runtime'));
    const acquire = async (options) => {
      acquisitions++;
      assert.deepEqual(Object.keys(options).sort(), ['env', 'signal', 'suite']);
      assert.equal(options.suite, 'performance');
      assert.deepEqual(options.env, {});
      // Real safety implementation; isolate unit-test lock files and memory probe only.
      return applyDevScriptSafetyWithWait({
        ...options,
        lockRoot,
        availableMemoryMb: () => 8192,
      });
    };
    try {
      const running = withLocalReleaseLease(
        async (token) => {
          owner = token;
          assert.deepEqual(await slots(), ['slot-1']);
          await assert.rejects(
            applyDevScriptSafetyWithWait({
              suite: 'performance',
              env: {},
              lockRoot,
              availableMemoryMb: () => 8192,
              noGuardWait: true,
            }),
            /host-global maximum concurrency 1/,
          );
          assert.deepEqual(releaseDriverPrefix('local-physical', owner), [
            '--import',
            'tsx',
          ]);
          let finalizationFailure;
          try {
            if (outcome === 'preparation-failure')
              throw new Error('preparation failure');
            const result = await runCommandProcess({
              executable: process.execPath,
              args: [
                '-e',
                outcome === 'timeout' || outcome === 'interruption'
                  ? 'setInterval(()=>{}, 1000)'
                  : 'if (process.env.CI || process.env.GITHUB_ACTIONS) process.exit(2)',
              ],
              cwd: lockRoot,
              env: releaseChildEnvironment('local-physical', process.env),
              stdio: 'ignore',
              timeoutMs: outcome === 'timeout' ? 50 : 2000,
              termGraceMs: 100,
              killGraceMs: 500,
              signal: controller.signal,
              onSpawn: () => {
                if (outcome === 'interruption') controller.abort();
              },
            });
            assert.equal(result.cleanup.groupGone, true);
            assert.deepEqual(
              await slots(),
              ['slot-1'],
              'Lease stays held through owned group cleanup',
            );
            if (outcome === 'interruption')
              assert.equal(result.interrupted, true);
            else if (outcome === 'timeout') assert.equal(result.timedOut, true);
            else assert.equal(result.code, 0);
          } finally {
            assert.deepEqual(
              await slots(),
              ['slot-1'],
              'Lease remains held through finalization',
            );
            finalizationObserved = true;
            if (outcome === 'finalization-failure')
              finalizationFailure = new Error('finalization failure');
          }
          if (finalizationFailure) throw finalizationFailure;
        },
        { acquire, env: {}, signal: controller.signal },
      );
      if (outcome.endsWith('failure')) await assert.rejects(running, /failure/);
      else await running;
      assert.equal(acquisitions, 1);
      assert(finalizationObserved);
      assert.deepEqual(await slots(), []);
      assert.throws(
        () => releaseDriverPrefix('local-physical', owner),
        /active lease/,
      );
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });
}
test('local guard interruption before preparation releases an acquired lease; rejection never enters study', async () => {
  const controller = new AbortController();
  let released = false,
    entered = false;
  await assert.rejects(
    withLocalReleaseLease(
      () => {
        entered = true;
      },
      {
        signal: controller.signal,
        acquire: async () => {
          controller.abort();
          return {
            ciBypass: false,
            memory: { skipped: false },
            lease: {
              release: async () => {
                released = true;
              },
            },
          };
        },
      },
    ),
    /abort/i,
  );
  assert(released);
  assert(!entered);
  await assert.rejects(
    withLocalReleaseLease(
      () => {
        entered = true;
      },
      {
        acquire: async () => {
          throw new Error('guard blocked');
        },
      },
    ),
    /guard blocked/,
  );
  assert(!entered);
  await assert.rejects(
    withLocalReleaseLease(
      () => {
        entered = true;
      },
      {
        acquire: async () => ({
          ciBypass: true,
          memory: { skipped: true },
          lease: null,
        }),
      },
    ),
    /actual normal performance lease/,
  );
  assert(!entered);
});

test('interruption during actual safety admission retains the foreign lease and never prepares a study', async () => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), 'release-local-wait-'));
  const options = {
    suite: 'performance',
    env: {},
    lockRoot,
    availableMemoryMb: () => 8192,
  };
  const existing = await applyDevScriptSafetyWithWait(options);
  const controller = new AbortController();
  let entered = false;
  try {
    await assert.rejects(
      withLocalReleaseLease(
        () => {
          entered = true;
        },
        {
          env: {},
          signal: controller.signal,
          acquire: (requested) =>
            applyDevScriptSafetyWithWait({
              ...requested,
              lockRoot,
              availableMemoryMb: () => 8192,
              logGuardWait: () => controller.abort(),
            }),
        },
      ),
      /abort/i,
    );
    assert(!entered);
    const holder = JSON.parse(
      await readFile(path.join(existing.lease.slotPath, 'holder.json'), 'utf8'),
    );
    assert.equal(holder.token, existing.lease.metadata.token);
  } finally {
    await existing.lease.release();
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test('local qualification keeps capacity explicitly local and stable execution disabled', () => {
  const { batch, analysis } = qualificationFinalizationFixture();
  batch.execution = 'local-physical';
  finalizeReleaseAnalysis(batch, analysis, true);
  assert.equal(analysis.status, 'qualification-complete-no-acceptance');
  assert.equal(analysis.finalAcceptance, false);
  assert.equal(analysis.capacity.stableExecutionEnabled, false);
  assert.match(analysis.capacity.limitation, /Local measured costs/);
});

test('hosted admission retains its complete runner marker contract', () => {
  const env = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    RUNNER_OS: 'macOS',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKSPACE: '/Users/runner/work/project',
    RUNNER_TEMP: '/Users/runner/work/_temp',
    ImageOS: 'macos26',
  };
  requireHostedMac(env, 'darwin');
  for (const key of Object.keys(env)) {
    const missing = { ...env };
    delete missing[key];
    assert.throws(
      () => requireHostedMac(missing, 'darwin'),
      /real GitHub-hosted/,
    );
  }
  assert.throws(() => requireHostedMac(env, 'linux'), /real GitHub-hosted/);
});

for (const interruptAt of ['analysis.json', 'finalization.json']) {
  test(`signal during actual ${interruptAt} finalization persists failure and releases the owned lease`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'release-finalization-signal-'),
    );
    const output = path.join(directory, 'evidence');
    const lockRoot = path.join(directory, 'locks');
    const previousExitCode = process.exitCode;
    const { batch, analysis } = qualificationFinalizationFixture();
    batch.execution = 'local-physical';
    batch.limitations = [];
    batch.stages = {};
    let injected = false;
    const writes = new Map();
    const listenersBefore = ['SIGINT', 'SIGTERM'].map((name) =>
      process.listenerCount(name),
    );
    try {
      await mkdir(output);
      await withReleaseInterruption((signal) =>
        withLocalReleaseLease(
          async () => {
            await persistReleaseFinalization(
              {
                batch,
                analysis,
                qualification: true,
                output,
                execution: 'local-physical',
                finalizationStartedAt: Date.now(),
                signal,
              },
              {
                writeJson: async (name, value) => {
                  writes.set(name, (writes.get(name) ?? 0) + 1);
                  // Write the real finalization artifact before delivering SIGINT through
                  // the same handler main uses; no command-time abort or fake finalizer.
                  await writeFile(
                    path.join(output, name),
                    `${JSON.stringify(value, null, 2)}\n`,
                  );
                  if (name === interruptAt && !injected) {
                    injected = true;
                    assert.deepEqual(
                      await readdir(path.join(lockRoot, 'desktop-runtime')),
                      ['slot-1'],
                    );
                    process.emit('SIGINT');
                  } else if (injected) {
                    // Repeated terminal signals cannot extend finalization with more passes.
                    process.emit('SIGTERM');
                  }
                },
              },
            );
            assert.deepEqual(
              await readdir(path.join(lockRoot, 'desktop-runtime')),
              ['slot-1'],
            );
          },
          {
            signal,
            env: {},
            acquire: (options) =>
              applyDevScriptSafetyWithWait({
                ...options,
                lockRoot,
                availableMemoryMb: () => 8192,
              }),
          },
        ),
      );
      assert(injected);
      const persistedBatch = JSON.parse(
        await readFile(path.join(output, 'batch.json'), 'utf8'),
      );
      const persistedAnalysis = JSON.parse(
        await readFile(path.join(output, 'analysis.json'), 'utf8'),
      );
      const capacity = JSON.parse(
        await readFile(
          path.join(output, 'qualification-capacity.json'),
          'utf8',
        ),
      );
      const finalization = JSON.parse(
        await readFile(path.join(output, 'finalization.json'), 'utf8'),
      );
      assert.equal(
        persistedAnalysis.status,
        'qualification-incomplete-or-failed',
      );
      assert.equal(persistedBatch.interruption.phase, 'finalization');
      assert.match(persistedBatch.interruption.reason, /SIGINT/);
      assert.match(persistedBatch.fatalError, /interrupted/);
      assert.equal(capacity.status, 'capacity-gap-incomplete-qualified-costs');
      assert.equal(finalization.interrupted, true);
      assert.equal(persistedBatch.finalization.interrupted, true);
      assert.deepEqual(
        persistedAnalysis.interruption,
        persistedBatch.interruption,
      );
      assert([...writes.values()].every((count) => count === 2));
      assert.deepEqual(
        ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)),
        listenersBefore,
      );
      const artifacts = JSON.parse(
        await readFile(path.join(output, 'artifact-manifest.json'), 'utf8'),
      );
      assert.equal(artifacts['artifact-manifest.json'], undefined);
      assert.equal(artifacts['finalization.json'], undefined);
      for (const [name, hash] of Object.entries(artifacts)) {
        assert.equal(
          createHash('sha256')
            .update(await readFile(path.join(output, name)))
            .digest('hex'),
          hash,
          `${name}: interrupted evidence hash must match final bytes`,
        );
      }
      assert.equal(process.exitCode, 1);
      assert.match(
        await readFile(path.join(output, 'report.md'), 'utf8'),
        /qualification-incomplete-or-failed/,
      );
      assert.deepEqual(
        await readdir(path.join(lockRoot, 'desktop-runtime')),
        [],
      );
    } finally {
      process.exitCode = previousExitCode;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('actual uninterrupted finalization retains successful qualification with one persistence pass', async () => {
  const output = await mkdtemp(
    path.join(tmpdir(), 'release-finalization-complete-'),
  );
  const { batch, analysis } = qualificationFinalizationFixture();
  batch.execution = 'local-physical';
  batch.limitations = [];
  batch.stages = {};
  const previousExitCode = process.exitCode;
  const writes = new Map();
  try {
    await withReleaseInterruption((signal) =>
      persistReleaseFinalization(
        {
          batch,
          analysis,
          qualification: true,
          output,
          execution: 'local-physical',
          finalizationStartedAt: Date.now(),
          signal,
        },
        {
          writeJson: async (name, value) => {
            writes.set(name, (writes.get(name) ?? 0) + 1);
            await writeFile(
              path.join(output, name),
              `${JSON.stringify(value, null, 2)}\n`,
            );
          },
        },
      ),
    );
    const persisted = JSON.parse(
      await readFile(path.join(output, 'analysis.json'), 'utf8'),
    );
    assert.equal(persisted.status, 'qualification-complete-no-acceptance');
    assert.equal(persisted.capacity.stableExecutionEnabled, false);
    assert.equal(persisted.interruption, undefined);
    assert([...writes.values()].every((count) => count === 1));
    assert.equal(process.exitCode, previousExitCode);
  } finally {
    process.exitCode = previousExitCode;
    await rm(output, { recursive: true, force: true });
  }
});

test('release headless CLI is closed and defaults to hidden', () => {
  const args = [
    '--baseline',
    '/tmp/a',
    '--candidate',
    '/tmp/b',
    '--output',
    '/tmp/c',
  ];
  assert.equal(parseReleaseOptions(args)['window-mode'], 'headless');
  assert.equal(
    parseReleaseOptions([...args, '--window-mode', 'headless'])['window-mode'],
    'headless',
  );
  assert.throws(() =>
    parseReleaseOptions([...args, '--window-mode', 'headed']),
  );
  assert.throws(() =>
    parseReleaseOptions([
      ...args,
      '--window-mode',
      'headless',
      '--window-mode',
      'headless',
    ]),
  );
});

function terminalFixture(
  snapshot,
  terminalPath = '/artifact/sample.adapter.cjs.lifecycle.jsonl',
) {
  const ended = structuredClone(snapshot);
  ended.liveWindowIds = [];
  ended.windows = ended.windows.map((entry) => ({
    ...entry,
    current: {
      id: entry.initial.id,
      destroyed: true,
      visible: false,
      focused: false,
      webContentsId: null,
      rendererPid: null,
      url: null,
    },
  }));
  const key = {
    schemaVersion: 1,
    launchId: snapshot.launchId,
    launchContractSha256: snapshot.launchContractSha256,
    pid: snapshot.pid,
  };
  return {
    schemaVersion: 1,
    terminalPath,
    fileSha256: 'f'.repeat(64),
    size: 1000,
    pid: snapshot.pid,
    processGroupGone: true,
    records: [
      { ...key, phase: 'installed' },
      {
        ...key,
        phase: 'process-exit',
        dispatchCompleted: true,
        quitDispatchCompleted: true,
        quitObserved: true,
        observerInstalled: true,
        exitCode: 0,
        snapshot: ended,
      },
    ],
  };
}
function headlessReleaseFixture({ calls = [] } = {}) {
  const state = {
    ownerMatches: true,
    id: 1,
    webContentsId: 11,
    rendererPid: 101,
    url: 'file:///stage/out/renderer/index.html',
    nativeUrl: 'file:///stage/out/renderer/index.html',
    destroyed: false,
    minimized: false,
    visible: false,
    focused: false,
    documentVisible: true,
    documentFocused: false,
    viewport: { width: 1400, height: 900 },
    contentBounds: { width: 1400, height: 900 },
  };
  const identity = {
    appPath: '/stage/out/main',
    cwd: '/stage',
    argv: ['electron', '/stage/out/main/index.js'],
    resourcesPath: '/electron/Resources',
  };
  const adapter = {
    schemaVersion: 1,
    expectedArgv: [...identity.argv],
    launcherIdentity: {
      policy: 'playwright-explicit-executable-macos-v1',
      version: '1.58.2',
      sha256:
        'd230157151a460582734ae2ecac319b86f1b2b466864a083adfca71d4f80203c',
      sourcePath: '/reviewed/playwright/electron.js',
      executablePath: identity.argv[0],
    },
    launchId: '00000000-0000-4000-8000-000000000001',
    launchContractSha256: 'e'.repeat(64),
    adapterVersion: 'production-hidden-native-v1',
    adapterSha256: 'a'.repeat(64),
    productMainSha256: 'b'.repeat(64),
    productMainEntryPath: '/stage/out/main/index.js',
    launchEntryPath:
      '/stage/out/main/browser-profiles-production-headless-bootstrap.cjs',
    pid: 100,
    installed: true,
    lifetimeObservationIntact: true,
    valid: true,
    overflow: false,
    allWindowsObserved: true,
    productImported: true,
    calls,
    events: [],
    violations: [],
    liveWindowIds: [1],
    windows: [{ initial: state, current: state, readyToShow: 1 }],
    beforeImport: identity,
    currentIdentity: structuredClone(identity),
  };
  const environment = {
    studyWindowMode: 'hidden-native-1400x900-v1',
    studyViewportPreset: 'hidden-native-1400x900-v1',
    viewport: { width: 1400, height: 900 },
    windowVisible: false,
  };
  const evidence = {
    mode: environment.studyWindowMode,
    viewport: environment.viewport,
    windowVisible: false,
    setup: { status: 'ready', before: state, after: state },
    atStart: state,
    atEnd: state,
    adapterAtSetup: adapter,
    adapterAtStart: adapter,
    adapterAtEnd: adapter,
  };
  return structuredClone({
    schemaVersion: 2,
    environment,
    source: {
      headlessAdapter: {
        adapterVersion: adapter.adapterVersion,
        adapterSha256: adapter.adapterSha256,
        sourcePath:
          '/stage/apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs',
      },
    },
    samples: [
      {
        adapterLaunches: [
          {
            ...adapter,
            sourcePath:
              '/stage/apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs',
            archivePath: '/artifact/sample.adapter.cjs',
            terminalPath: '/artifact/sample.adapter.cjs.lifecycle.jsonl',
            terminalEvidence: terminalFixture(adapter),
          },
        ],
        windowEvidence: evidence,
      },
    ],
  });
}
test('release report rejects schema/mode/viewport/adapter/activation mixing and missing boundaries', async () => {
  const { validateReleaseHeadlessReport } =
    await import('./browser-profiles-release-ci.mjs');
  validateReleaseHeadlessReport(headlessReleaseFixture());
  for (const mutate of [
    (x) => {
      x.schemaVersion = 1;
    },
    (x) => {
      delete x.environment.studyWindowMode;
    },
    (x) => {
      x.environment.windowVisible = true;
    },
    (x) => {
      x.environment.viewport.width = 1000;
    },
    (x) => {
      delete x.samples[0].windowEvidence;
      x.samples[0].foreground = [];
    },
    (x) => {
      x.samples[0].windowEvidence.adapterAtEnd = {
        ...x.samples[0].windowEvidence.adapterAtEnd,
        adapterSha256: 'c'.repeat(64),
      };
    },
    (x) => {
      x.samples[0].windowEvidence.adapterAtEnd = {
        ...x.samples[0].windowEvidence.adapterAtEnd,
        pid: 200,
      };
    },
    (x) => {
      x.samples[0].windowEvidence.adapterAtEnd.events.push({
        event: 'show',
        id: 1,
      });
    },
  ]) {
    const raw = headlessReleaseFixture();
    mutate(raw);
    assert.throws(() => validateReleaseHeadlessReport(raw));
  }
});
test('release report must bind archived adapter source to every native snapshot', async () => {
  const { validateReleaseHeadlessReport } =
    await import('./browser-profiles-release-ci.mjs');
  for (const mutate of [
    (x) => {
      delete x.source.headlessAdapter;
    },
    (x) => {
      x.source.headlessAdapter.adapterSha256 = 'd'.repeat(64);
    },
  ]) {
    const raw = headlessReleaseFixture();
    mutate(raw);
    assert.throws(() => validateReleaseHeadlessReport(raw));
  }
});
test('native prerequisite fails closed on missing capability and incomplete main/Advisor evidence', async () => {
  const { validateReleaseNativePreflight } =
    await import('./browser-profiles-release-ci.mjs');
  for (const value of [
    null,
    {},
    {
      schemaVersion: 2,
      kind: 'native-production-headless-capability-v1',
      status: 'unavailable',
    },
  ])
    assert.throws(() => validateReleaseNativePreflight(value, {}));
  const raw = headlessReleaseFixture(),
    evidence = raw.samples[0].windowEvidence;
  const value = {
    schemaVersion: 2,
    kind: 'native-production-headless-capability-v1',
    status: 'available',
    environment: raw.environment,
    adapter: { sha256: 'a'.repeat(64) },
    adapterLaunches: raw.samples[0].adapterLaunches,
    bundlesBefore: {},
    bundlesAfter: {},
    windowEvidence: [evidence],
  };
  assert.throws(
    () => validateReleaseNativePreflight(value, evidence.adapterAtEnd),
    /Advisor/,
  );
});
test('bootstrap closure admits only the fixed literal production target as launch identity', async () => {
  const { createRequire } = await import('node:module');
  const ts = createRequire(import.meta.url)('typescript');
  const { assertProductionBootstrapImports } =
    await import('./browser-profiles-release-ci.mjs');
  const source = await readFile(
    new URL(
      './browser-profiles-production-headless-bootstrap.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  assertProductionBootstrapImports(source, ts);
  for (const changed of [
    source.replace("require('./index.js')", "require('./other.js')"),
    source.replace("require('./index.js')", 'require(process.argv[2])'),
    source.replace("require('./index.js')", "import('./index.js')"),
  ])
    assert.throws(() => assertProductionBootstrapImports(changed, ts));
});
// App Advisor loads its own page beside the main window's index.html.
function advisorPageUrl(mainPageUrl) {
  return `${new URL('app-advisor.html', mainPageUrl).href}?surface=app-advisor`;
}
function nativePreflightFixture(options) {
  const raw = headlessReleaseFixture(options),
    main = raw.samples[0].windowEvidence;
  const advisor = structuredClone(main);
  for (const field of ['atStart', 'atEnd'])
    advisor[field] = {
      ...main[field],
      id: 2,
      webContentsId: 12,
      rendererPid: 102,
      url: advisorPageUrl(main[field].url),
      nativeUrl: advisorPageUrl(main[field].nativeUrl),
    };
  advisor.setup = {
    status: 'ready',
    before: advisor.atStart,
    after: advisor.atStart,
  };
  const second = structuredClone(main.adapterAtEnd);
  second.windows.push({
    initial: advisor.atStart,
    current: advisor.atEnd,
    readyToShow: 1,
  });
  second.liveWindowIds.push(2);
  second.calls.push({
    method: 'show',
    target: 'window',
    id: 1,
    suppressed: true,
  });
  advisor.adapterAtSetup = second;
  advisor.adapterAtStart = second;
  advisor.adapterAtEnd = second;
  raw.samples[0].adapterLaunches[0].terminalEvidence = terminalFixture(second);
  const value = {
    schemaVersion: 2,
    kind: 'native-production-headless-capability-v1',
    status: 'available',
    environment: raw.environment,
    adapter: { sha256: 'a'.repeat(64) },
    adapterLaunches: raw.samples[0].adapterLaunches,
    bundlesBefore: { 'main/index.js': 'b'.repeat(64) },
    bundlesAfter: { 'main/index.js': 'b'.repeat(64) },
    windowEvidence: [main, advisor],
  };
  return { value, expected: main.adapterAtEnd };
}
test('native prerequisite accepts complete synthetic main/Advisor evidence and rejects native omissions', async () => {
  const { validateReleaseNativePreflight } =
    await import('./browser-profiles-release-ci.mjs');
  const { value, expected } = nativePreflightFixture();
  validateReleaseNativePreflight(value, expected);
  for (const mutate of [
    (x) => {
      x.windowEvidence[1].adapterAtEnd.calls = [];
    },
    (x) => {
      x.windowEvidence[1].adapterAtEnd.windows[1].readyToShow = 0;
    },
    (x) => {
      x.bundlesAfter['main/index.js'] = 'c'.repeat(64);
    },
    (x) => {
      x.status = 'unavailable';
    },
  ]) {
    const broken = structuredClone(value);
    mutate(broken);
    assert.throws(() => validateReleaseNativePreflight(broken, expected));
  }
});

test('release attempt rejects late activation terminal history even when measured boundaries passed', async () => {
  const { validateReleaseHeadlessReport } =
    await import('./browser-profiles-release-ci.mjs');
  const raw = headlessReleaseFixture();
  raw.samples[0].adapterLaunches[0].terminalEvidence = {
    status: 'invalid',
    events: [{ event: 'show', id: 1, phase: 'close-after-measurement' }],
  };
  assert.throws(() => validateReleaseHeadlessReport(raw));
});

// Exercise the real adapter observer between a successful measurement snapshot
// and the retained close snapshot. The Electron objects are nonnative fixtures.
function hiddenAdapterFixture() {
  const app = new EventEmitter();
  app.focus = () => {};
  class Window extends EventEmitter {
    id = 1;
    webContents = {
      id: 11,
      getOSProcessId: () => 101,
      getURL: () => 'file:///stage/out/renderer/index.html',
    };
    destroyed = false;
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return false;
    }
    isFocused() {
      return false;
    }
    show() {}
    showInactive() {}
    focus() {}
    moveTop() {}
  }
  let window;
  Window.getAllWindows = () => (window && !window.destroyed ? [window] : []);
  const read = headlessBootstrap.installAdapter(
    { app, BrowserWindow: Window },
    {},
  );
  window = new Window();
  app.emit('browser-window-created', {}, window);
  return { read, window };
}
function activationDuringClose(snapshot, observerLoss = false) {
  const { read, window } = hiddenAdapterFixture();
  assert.equal(read().valid, true, 'measurement snapshot is valid');
  const close = () => {
    if (observerLoss) {
      window.removeAllListeners('show');
      window.removeAllListeners('focus');
    }
    window.emit('show');
    if (observerLoss) window.destroyed = true;
  };
  close();
  const afterClose = read();
  if (!observerLoss)
    assert.equal(
      afterClose.valid,
      false,
      'native activation during close is observed',
    );
  const terminal = terminalFixture(snapshot);
  Object.assign(terminal.records[1].snapshot, {
    valid: afterClose.valid,
    lifetimeObservationIntact: afterClose.lifetimeObservationIntact,
    events: afterClose.events,
    violations: afterClose.violations,
  });
  return terminal;
}
for (const observerLoss of [false, true]) {
  for (const scenario of [
    'attempt',
    'prerequisite',
    'retirement-first-close',
  ]) {
    test(`actual adapter ${observerLoss ? 'observer loss and destruction' : 'late activation'} invalidates ${scenario} after passing measurement`, async () => {
      const { validateReleaseHeadlessReport, validateReleaseNativePreflight } =
        await import('./browser-profiles-release-ci.mjs');
      if (scenario === 'prerequisite') {
        const { value, expected } = nativePreflightFixture();
        validateReleaseNativePreflight(value, expected);
        value.adapterLaunches[0].terminalEvidence = activationDuringClose(
          value.windowEvidence.at(-1).adapterAtEnd,
          observerLoss,
        );
        assert.throws(() => validateReleaseNativePreflight(value, expected));
        return;
      }
      const raw = headlessReleaseFixture();
      if (scenario === 'retirement-first-close') {
        raw.mode = 'retirement';
        const second = structuredClone(raw.samples[0]);
        const snapshots = [
          second.adapterLaunches[0],
          second.windowEvidence.adapterAtSetup,
          second.windowEvidence.adapterAtStart,
          second.windowEvidence.adapterAtEnd,
        ];
        for (const snapshot of snapshots) {
          snapshot.pid = 200;
          snapshot.launchId = '00000000-0000-4000-8000-000000000002';
        }
        second.adapterLaunches[0].terminalEvidence = terminalFixture(
          second.windowEvidence.adapterAtEnd,
        );
        raw.samples[0].adapterLaunches.push(second.adapterLaunches[0]);
        raw.samples[0].monitoring = [
          { windowEvidence: raw.samples[0].windowEvidence },
          { windowEvidence: second.windowEvidence },
        ];
      }
      validateReleaseHeadlessReport(raw);
      raw.samples[0].adapterLaunches[0].terminalEvidence =
        activationDuringClose(
          raw.samples[0].windowEvidence.adapterAtEnd,
          observerLoss,
        );
      assert.throws(() => validateReleaseHeadlessReport(raw));
    });
  }
}

test('every release terminal envelope rejects missing, incomplete, mismatched and post-terminal evidence', async () => {
  const { validateReleaseHeadlessReport, validateReleaseNativePreflight } =
    await import('./browser-profiles-release-ci.mjs');
  for (const mutate of [
    (launch) => {
      delete launch.terminalEvidence;
    },
    (launch) => {
      launch.terminalEvidence.records.pop();
    },
    (launch) => {
      launch.terminalEvidence.records.push({
        phase: 'activity-after-exit-dispatch',
      });
    },
    (launch) => {
      launch.terminalEvidence.processGroupGone = false;
    },
    (launch) => {
      launch.terminalEvidence.records[1].launchId = 'foreign';
    },
    (launch) => {
      launch.terminalEvidence.records[1].launchContractSha256 = 'f'.repeat(64);
    },
    (launch) => {
      launch.terminalEvidence.records[1].dispatchCompleted = false;
    },
    (launch) => {
      launch.terminalEvidence.records[1].quitObserved = false;
    },
    (launch) => {
      launch.terminalEvidence.records[1].observerInstalled = false;
    },
    (launch) => {
      launch.terminalEvidence.records[1].exitCode = 1;
    },
    (launch) => {
      launch.terminalEvidence.records[1].snapshot.launchId =
        '00000000-0000-4000-8000-000000000002';
    },
    (launch) => {
      launch.terminalEvidence.records[1].snapshot.launchContractSha256 =
        'f'.repeat(64);
    },
    (launch) => {
      launch.terminalEvidence.records[1].snapshot.beforeImport.cwd = '/foreign';
      launch.terminalEvidence.records[1].snapshot.currentIdentity.cwd =
        '/foreign';
    },
    (launch) => {
      launch.terminalEvidence.records[1].snapshot.windows[0].current.destroyed = false;
    },
    (launch) => {
      launch.terminalEvidence.records[1].snapshot.windows[0].initial.id = 2;
    },
  ]) {
    const raw = headlessReleaseFixture();
    mutate(raw.samples[0].adapterLaunches[0]);
    assert.throws(() => validateReleaseHeadlessReport(raw));
    const { value, expected } = nativePreflightFixture();
    mutate(value.adapterLaunches[0]);
    assert.throws(() => validateReleaseNativePreflight(value, expected));
  }
});

test('release terminal consumers require completed outer quit dispatch', async () => {
  const { validateReleaseHeadlessReport, validateReleaseNativePreflight } =
    await import('./browser-profiles-release-ci.mjs');
  for (const completion of [undefined, false]) {
    const raw = headlessReleaseFixture();
    validateReleaseHeadlessReport(raw);
    const { value, expected } = nativePreflightFixture();
    validateReleaseNativePreflight(value, expected);
    for (const launch of [
      raw.samples[0].adapterLaunches[0],
      value.adapterLaunches[0],
    ]) {
      if (completion === undefined)
        delete launch.terminalEvidence.records[1].quitDispatchCompleted;
      else
        launch.terminalEvidence.records[1].quitDispatchCompleted = completion;
    }
    assert.throws(
      () => validateReleaseHeadlessReport(raw),
      /quit dispatch incomplete/i,
    );
    assert.throws(
      () => validateReleaseNativePreflight(value, expected),
      /quit dispatch incomplete/i,
    );
  }
});

for (const envelope of ['release report', 'native preflight']) {
  test(`actual adapter moveTop call history passes ${envelope} envelope`, async () => {
    const { validateReleaseHeadlessReport, validateReleaseNativePreflight } =
      await import('./browser-profiles-release-ci.mjs');
    const { read, window } = hiddenAdapterFixture();
    window.show();
    window.focus();
    window.moveTop();
    const snapshot = read();
    assert.equal(snapshot.valid, true);
    assert.deepEqual(
      snapshot.calls.map(({ method }) => method),
      ['show', 'focus', 'moveTop'],
    );
    if (envelope === 'release report')
      validateReleaseHeadlessReport(
        headlessReleaseFixture({ calls: snapshot.calls }),
      );
    else {
      const { value, expected } = nativePreflightFixture({
        calls: snapshot.calls,
      });
      validateReleaseNativePreflight(value, expected);
    }
  });
}

test('diagnostic launch helper retains exact release admission and rejects mutations or an extra helper', async () => {
  const { assertReviewedReleaseOverlay } =
    await import('./browser-profiles-release-ci.mjs');
  const file = 'apps/desktop-app/tests/electron/launchCanopy.mjs';
  const source = await readFile(
    new URL('../../../../' + file, import.meta.url),
  );
  const hash = createHash('sha256').update(source).digest('hex');
  const [before] = pinnedReleaseHelperIdentity(file, hash);
  assert.doesNotThrow(() => assertReviewedReleaseOverlay(file, before, hash));
  assert.throws(
    () =>
      pinnedReleaseHelperIdentity(
        file,
        createHash('sha256')
          .update(Buffer.concat([source, Buffer.from('\n')]))
          .digest('hex'),
      ),
    /Current release helper bytes changed/,
  );
  assert.throws(
    () => assertReviewedReleaseOverlay(file, 'mutated-original', hash),
    /Original release helper bytes changed/,
  );
  assert.throws(
    () =>
      assertReviewedReleaseOverlay(
        'apps/desktop-app/tests/electron/browser-profile-test-lifecycle.mjs',
        null,
        hash,
      ),
    /Unreviewed release helper delta/,
  );
});

test('Windows acceptance launch plan keeps workflow streams exclusively in the controller', async () => {
  const module = await import('./browser-profiles-release-ci.mjs');
  assert.equal(typeof module.commandLaunchPlan, 'function');
  const plan = module.commandLaunchPlan({
    platform: 'win32',
    executable: process.execPath,
    args: ['guard.mjs', '--suite', 'e2e'],
    cwd: process.cwd(),
    env: { SENTINEL: 'kept' },
    ownerPid: 42,
  });
  assert.equal(plan.executable, process.execPath);
  assert.equal(
    plan.args[0],
    path.resolve(
      'apps/desktop-app/tests/performance/process-tree-supervisor.mjs',
    ),
  );
  assert.deepEqual(plan.args.slice(1), ['guard.mjs', '--suite', 'e2e']);
  assert.equal(
    plan.options.env.CANOPY_E2E_SUPERVISED_EXECUTABLE,
    process.execPath,
  );
  assert.equal(plan.options.env.CANOPY_E2E_OWNER_PID, '42');
  assert.equal(plan.options.env.SENTINEL, 'kept');
  assert.deepEqual(plan.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(plan.options.windowsHide, true);
  assert.equal(plan.options.shell, false);
  assert.equal(plan.options.detached, true);
});

for (const outcome of ['normal', 'timeout', 'interruption', 'unreaped']) {
  test(`Windows acceptance ${outcome} uses cooperative cleanup and disposes only private reads`, async () => {
    const { PassThrough } = await import('node:stream');
    const child = new EventEmitter();
    const destinations = [new PassThrough(), new PassThrough()];
    const bytes = [];
    destinations[0].on('data', (chunk) => bytes.push(chunk.toString()));
    let sends = 0,
      disconnects = 0,
      unrefs = 0;
    Object.assign(child, {
      pid: 4321,
      connected: true,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => assert.fail('Windows direct child must never be killed'),
      disconnect: () => {
        disconnects++;
        child.connected = false;
      },
      unref: () => {
        unrefs++;
      },
      channel: { unref() {} },
    });
    const close = () => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 7, null);
    };
    child.send = (message, callback) => {
      sends++;
      assert.deepEqual(message, {
        type: 'request-owned-cleanup',
        reason: outcome === 'interruption' ? 'interruption' : 'timeout',
      });
      callback?.();
      if (outcome !== 'unreaped') setTimeout(close, 5);
    };
    const controller = new AbortController();
    const running = runCommandProcess({
      platform: 'win32',
      executable: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutMs: outcome === 'interruption' ? 100 : 15,
      cleanupAllowanceMs: 20,
      stdout: destinations[0],
      stderr: destinations[1],
      spawnProcess: (_exe, _args, options) => {
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
        return child;
      },
      signal: controller.signal,
    });
    child.stdout.write('forwarded');
    if (outcome === 'normal') close();
    if (outcome === 'interruption') controller.abort();
    const result = await running;
    assert.equal(result.timedOut, ['timeout', 'unreaped'].includes(outcome));
    assert.equal(result.interrupted, outcome === 'interruption');
    assert.equal(sends, outcome === 'normal' ? 0 : 1);
    assert.equal(result.cleanup.supervisorPid, 4321);
    assert.equal(Object.hasOwn(result.cleanup, 'groupGone'), false);
    assert.deepEqual(bytes, ['forwarded']);
    assert(
      destinations.every(
        (stream) => !stream.destroyed && !stream.writableEnded,
      ),
    );
    if (outcome === 'unreaped') {
      assert(result.error);
      assert.equal(result.code, null);
      assert.equal(
        result.cleanup.forwardingStreamsClosedAfterUnverifiedCleanup,
        true,
      );
      assert.equal(disconnects, 1);
      assert.equal(unrefs, 1);
      assert(child.stdout.destroyed && child.stderr.destroyed);
    } else assert.equal(result.code, 7);
    for (const stream of destinations) stream.destroy();
  });
}

test('Windows acceptance aborted launch and supervisor errors remain unverified without direct termination', async () => {
  const abort = new AbortController();
  abort.abort();
  const before = await runCommandProcess({
    platform: 'win32',
    executable: process.execPath,
    args: [],
    timeoutMs: 10,
    signal: abort.signal,
    spawnProcess: () => assert.fail('aborted launch spawned'),
  });
  assert.equal(before.interrupted, true);
  assert.equal(before.cleanup.status, 'unverified');
  const failed = await runCommandProcess({
    platform: 'win32',
    executable: process.execPath,
    args: [],
    timeoutMs: 10,
    spawnProcess: () => {
      throw new Error('spawn refused');
    },
  });
  assert(failed.error);
  assert.equal(failed.cleanup.supervisorPid, null);
  const { PassThrough } = await import('node:stream');
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    send() {
      throw new Error('IPC unavailable');
    },
    kill: () => assert.fail('No abrupt Windows kill'),
    disconnect() {},
    unref() {},
  });
  const result = await runCommandProcess({
    platform: 'win32',
    executable: process.execPath,
    args: [],
    timeoutMs: 5,
    cleanupAllowanceMs: 5,
    spawnProcess: () => child,
  });
  assert.equal(result.cleanup.cooperativeRequestSent, false);
  assert.equal(result.cleanup.status, 'unverified');
  assert(result.error);
});

// Execute the controller's authoritative population/catch/finally statements.
// Only external command/filesystem/host boundaries are adapted; no copied policy.
async function actualPopulationPolicy(bindings) {
  const ts = createRequire(import.meta.url)('typescript');
  const text = await readFile(
    new URL('./browser-profiles-release-ci.mjs', import.meta.url),
    'utf8',
  );
  const source = ts.createSourceFile(
    'controller.mjs',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const study = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'executeStudy',
  );
  const block = study.body.statements.find(
    (node) => ts.isTryStatement(node) && node.finallyBlock,
  );
  const start = block.tryBlock.statements.findIndex(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (decl) =>
          ts.isObjectBindingPattern(decl.name) &&
          decl.name.elements.some(
            (element) =>
              element.name.getText(source) === 'RESPONSIVENESS_THRESHOLDS',
          ),
      ),
  );
  assert(start >= 0, 'Authoritative profile import boundary must exist');
  const profileImport =
    block.tryBlock.statements[start].declarationList.declarations[0].initializer
      .expression;
  assert(
    ts.isCallExpression(profileImport) &&
      profileImport.expression.kind === ts.SyntaxKind.ImportKeyword,
  );
  const populationStart = block.tryBlock.statements[start].getStart(source);
  const populationText =
    text.slice(populationStart, profileImport.getStart(source)) +
    'loadCanonicalProfiles()' +
    text.slice(profileImport.end, block.tryBlock.end - 1);
  const helpers = source.statements
    .filter(
      (node) =>
        (ts.isFunctionDeclaration(node) &&
          ['equalFields', 'releaseModeCompleteStatus'].includes(
            node.name?.text,
          )) ||
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((decl) =>
            [
              'canonical',
              'equal',
              'MODES',
              'MATCHED',
              'DRIVER_ROOT',
              'traversalDeadline',
              'checkTraversal',
            ].includes(decl.name.getText(source)),
          )),
    )
    .map((node) => node.getText(source))
    .join('\n');
  const locals = study.body.statements
    .filter(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((decl) =>
          ['local', 'qualification', 'deadlineMs', 'workDeadlineMs'].includes(
            decl.name.getText(source),
          ),
        ),
    )
    .map((node) => node.getText(source))
    .join('\n');
  const body = `${helpers} ${locals}\ntry { ${populationText} } ${text.slice(block.catchClause.getStart(source), block.end)}`;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(bindings), body)(
    ...Object.values(bindings),
  );
}

async function completeReleaseRaw(
  mode,
  reportPath,
  stage,
  { slow = false } = {},
) {
  const { RELEASE_TASK_COUNTS } =
    await import('./browser-profiles-release-ci.mjs');
  const { assessResponsiveness } = await import('./responsiveness.mjs');
  const { RESPONSIVENESS_THRESHOLDS } = await import('./profiles.mjs');
  const { buildSummary } = await import('./monitor.mjs');
  const native = nativePreflightFixture();
  const raw = headlessReleaseFixture();
  const sample = raw.samples[0];
  const monitor = (
    typing = 0,
    windowEvidence = sample.windowEvidence,
    delayed = false,
  ) => {
    const frames = [10, delayed ? 400.133 : 20].map((delayMs, index) => ({
      atMs: 100 + index * 500,
      gapMs: delayMs + 1000 / 60,
    }));
    const evidence = {
      ipcSamples: [
        { outerMs: 10, handlerMs: 1 },
        { outerMs: 20, handlerMs: 1 },
      ],
      resourceSamples: [0, 1].map(() => ({
        processes: [{ cpuPercent: 1, workingSetSizeKb: 1024 }],
      })),
      renderer: {
        longTaskObserverAvailable: true,
        longTasks: [],
        frames,
        frameGapsMs: frames.map((frame) => frame.gapMs),
        keyToPaintConfirmationMs: Array(typing).fill(10),
      },
    };
    const summary = buildSummary(evidence);
    return {
      scope: 'workload',
      label: 'complete',
      startedAtMs: 0,
      completedAtMs: 1000,
      raw: evidence,
      summary,
      windowEvidence,
      responsiveness: assessResponsiveness(summary, RESPONSIVENESS_THRESHOLDS),
    };
  };
  const typing =
    { common: 40, maintenance: 27, startup: 48, inventory: 11 }[mode] ?? 0;
  sample.monitoring = monitor(typing, sample.windowEvidence, slow);
  if (!['common', 'maintenance', 'startup'].includes(mode))
    sample.monitoring = [sample.monitoring];
  if (mode === 'cold') {
    sample.monitoring = native.value.windowEvidence.map((window, index) =>
      monitor(0, window, slow && index === 0),
    );
    sample.cold = ['cowork_work_entry', 'app_advisor_work_entry'].map(
      (kind) => ({ record: { owner: { taskScope: { kind } } } }),
    );
    sample.adapterLaunches = native.value.adapterLaunches;
  }
  if (mode === 'retirement') {
    const second = headlessReleaseFixture();
    const oldPid = second.samples[0].adapterLaunches[0].pid;
    const replacePid = (value) => {
      if (!value || typeof value !== 'object') return;
      if (value.pid === oldPid) value.pid = 200;
      if (value.launchId)
        value.launchId = '00000000-0000-4000-8000-000000000002';
      for (const child of Object.values(value)) replacePid(child);
    };
    replacePid(second);
    sample.monitoring.push(monitor(0, second.samples[0].windowEvidence));
    sample.adapterLaunches.push(second.samples[0].adapterLaunches[0]);
    sample.retirement = {
      acknowledgements: Array(100).fill({ status: 'ok' }),
      paths: Array(50).fill('/owned/task'),
      passiveCleanupEvidence: {
        status: 'physical-purge-complete',
        remainingCount: 0,
      },
    };
  }
  if (['common', 'maintenance', 'startup'].includes(mode))
    sample.settled = monitor();
  sample.tasks = Object.entries(RELEASE_TASK_COUNTS[mode]).flatMap(
    ([kind, count]) =>
      Array.from({ length: count }, () => ({
        kind,
        status: 'ok',
        durationMs: 10,
      })),
  );
  sample.firstWindowMs = 10;
  sample.shellMs = 20;
  if (mode === 'startup') {
    sample.earlyCoverage = {
      preWindowSampleCount: 2,
      preWindowPeakRssKb: 10,
      preWindowObservedCumulativeCpuMs: 1,
    };
    sample.milestones = {
      firstWindowMs: 10,
      usableShellMs: 20,
      usableComposerMs: 30,
    };
    sample.startupResources = {
      samples: [
        { rssKb: 10, collectionCompletedMs: 1 },
        { rssKb: 11, collectionCompletedMs: 2 },
      ],
    };
  }
  if (mode === 'inventory')
    sample.inventory = {
      intermediateProgressStatus: 'observed',
      result: { coverage: 'partial' },
      workerResources: {
        observedWorkloadSamples: 2,
        cpuPercent: { count: 2, max: 2, mean: 1, p95: 2 },
        workingSetSizeKb: { count: 2, max: 10 },
      },
    };
  const workloads = Array.isArray(sample.monitoring)
    ? sample.monitoring
    : [sample.monitoring];
  if (!Array.isArray(sample.monitoring))
    sample.responsiveness = sample.monitoring.responsiveness;
  if (mode === 'startup')
    sample.settledResponsiveness = sample.settled.responsiveness;
  sample.status = slow ? 'unresponsive' : 'ok';
  sample.runtime = {
    electron: '42.3.0',
    chromium: '148.0.7778.180',
    node: '24.22.1',
  };
  raw.mode = mode;
  raw.configuration = { samples: 1, warmups: 0, windowMode: 'headless' };
  raw.warmup = null;
  raw.summary = { passed: !slow };
  raw.source.bundles = { 'main/index.js': 'b'.repeat(64) };
  raw.source.commit = stage;
  Object.assign(raw.environment, {
    platform: 'darwin',
    architecture: 'arm64',
    release: 'test-owned',
    cpu: 'test-owned',
    memoryBytes: 1024,
    node: 'v24.22.1',
    power: 'AC Power',
    settings: {},
    powerSettings: {},
    effectiveEnvironmentValueHashes: {},
  });
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const adapterBytes = 'test-owned adapter archive';
  const adapterSha = hash(adapterBytes);
  const replaceAdapter = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.adapterSha256) value.adapterSha256 = adapterSha;
    for (const child of Object.values(value)) replaceAdapter(child);
  };
  replaceAdapter(raw);
  for (const [index, launch] of sample.adapterLaunches.entries()) {
    launch.archivePath = `${reportPath}.sample-0-launch-${index}.adapter.cjs`;
    launch.terminalPath = `${launch.archivePath}.lifecycle.jsonl`;
    launch.terminalEvidence.terminalPath = launch.terminalPath;
    const journal =
      launch.terminalEvidence.records
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n';
    launch.terminalEvidence.fileSha256 = hash(journal);
    launch.terminalEvidence.size = Buffer.byteLength(journal);
    await writeFile(launch.archivePath, adapterBytes);
    await writeFile(launch.terminalPath, journal);
  }
  // Keep every recorded assessment equal to the real driver's scoring scope.
  assert(
    workloads.every(
      (entry) =>
        entry.responsiveness.passed === (!slow || entry !== workloads[0]),
    ),
  );
  return raw;
}

async function populationFixture({
  failure,
  mutate,
  protocol = 'qualification',
  verifyFailure,
  commandFailure,
  finalMutate,
} = {}) {
  const api = await import('./browser-profiles-release-ci.mjs');
  const { RESPONSIVENESS_THRESHOLDS } = await import('./profiles.mjs');
  const output = await mkdtemp(path.join(tmpdir(), 'release-population-'));
  const previousExitCode = process.exitCode;
  const isFailure = (index) =>
    Array.isArray(failure) ? failure.includes(index) : failure === index;
  const calls = [];
  const batch = {
    schemaVersion: 3,
    performanceFailed: false,
    schedule: schedule(protocol),
    nativePreflights: {},
    stages: Object.fromEntries(
      ['baseline', 'candidate'].map((stage) => [
        stage,
        { commit: stage, bundles: { 'main/index.js': 'b'.repeat(64) } },
      ]),
    ),
    attempts: [],
    commands: [],
    checks: [],
    limitations: [],
    finalAcceptance: false,
    viewport: { width: 1400, height: 900 },
    studyWindowMode: 'hidden-native-1400x900-v1',
    studyViewportPreset: 'hidden-native-1400x900-v1',
    windowVisible: false,
  };
  const hashFile = async (file) =>
    file.endsWith('browser-profiles-production-headless-bootstrap.cjs')
      ? createHash('sha256').update('test-owned adapter archive').digest('hex')
      : createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
  const save = async () =>
    writeFile(path.join(output, 'batch.json'), JSON.stringify(batch));
  try {
    await api.withLocalReleaseLease(
      (owner) =>
        actualPopulationPolicy({
          ...api,
          assert,
          path,
          readFile,
          hashFile,
          batch,
          output,
          values: {
            execution: 'local-physical',
            protocol,
            'window-mode': 'headless',
          },
          owner,
          roots: { baseline: '/stage', candidate: '/stage' },
          signal: new AbortController().signal,
          executionStartedAt: Date.now() - 1000,
          studyLaunched: false,
          loadCanonicalProfiles: async () => ({ RESPONSIVENESS_THRESHOLDS }),
          save,
          assertNoLeftoverStudyProcesses: () => {},
          process: {
            ...process,
            get exitCode() {
              return process.exitCode;
            },
            set exitCode(value) {
              process.exitCode = value;
            },
            stdout: { write: () => {} },
          },
          verify: async (label) => {
            if (label === verifyFailure)
              throw new Error('Injected immutable verification failure');
            batch.checks.push({ label, durationMs: 1, status: 'immutable' });
            if (label === 'after-32' && finalMutate) await finalMutate(batch);
          },
          command: async (label, cwd, executable, args) => {
            const index = calls.length;
            calls.push({ label, cwd, executable, args });
            if (commandFailure === index)
              throw new Error('Owned command cleanup incomplete');
            const preflight = label.startsWith('native-headless-preflight-');
            const plan = preflight
              ? {
                  mode: 'cold',
                  stage: label.endsWith('baseline') ? 'baseline' : 'candidate',
                }
              : batch.schedule[index - 2];
            const reportPath = args[args.indexOf('--output') + 1];
            const rawPath = preflight ? `${reportPath}.cold.json` : reportPath;
            const raw = await completeReleaseRaw(
              plan.mode,
              rawPath,
              plan.stage,
              {
                slow: isFailure(index),
              },
            );
            let derived;
            if (preflight)
              derived = {
                ...api.classifyReleaseReport(
                  'cold',
                  raw,
                  isFailure(index) ? 1 : 0,
                  RESPONSIVENESS_THRESHOLDS,
                ),
                schemaVersion: 3,
                kind: 'native-production-headless-capability-v2',
                structuralCapability: 'established',
                status: isFailure(index) ? 'performance-failed' : 'available',
                rawPath,
                environment: raw.environment,
                runtime: raw.samples[0].runtime,
                source: raw.source,
                adapter: { sha256: raw.source.headlessAdapter.adapterSha256 },
                adapterLaunches: raw.samples[0].adapterLaunches,
                windowEvidence: raw.samples[0].monitoring.map(
                  (entry) => entry.windowEvidence,
                ),
                bundlesBefore: raw.source.bundles,
                bundlesAfter: raw.source.bundles,
              };
            if (mutate) await mutate({ index, raw, derived, plan });
            await writeFile(rawPath, JSON.stringify(raw));
            if (derived) await writeFile(reportPath, JSON.stringify(derived));
            const record = {
              label,
              code: isFailure(index) ? 1 : 0,
              durationMs: isFailure(index) ? 3000 : 1000,
              cleanup: { groupGone: true },
            };
            batch.commands.push(record);
            return record;
          },
        }),
      {
        env: {},
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: {
            metadata: { kind: 'unit-fixture-only' },
            release: async () => {},
          },
        }),
      },
    );
    return {
      batch: JSON.parse(
        await readFile(path.join(output, 'batch.json'), 'utf8'),
      ),
      analysis: JSON.parse(
        await readFile(path.join(output, 'analysis.json'), 'utf8'),
      ),
      calls,
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExitCode;
    await rm(output, { recursive: true, force: true });
  }
}

test('actual population all-green control completes both prerequisites and exact 33 scheduled calls', async () => {
  const result = await populationFixture();
  assert.equal(result.batch.fatalError, undefined);
  assert.equal(result.calls.length, 35);
  assert.equal(result.analysis.status, 'qualification-complete-no-acceptance');
  assert.deepEqual(
    result.batch.attempts.map(({ ordinal }) => ordinal),
    Array.from({ length: 33 }, (_, index) => index),
  );
});

test('actual population retains finite slow prerequisite and continues the fixed qualification', async () => {
  const result = await populationFixture({ failure: 0 });
  assert.equal(result.calls.length, 35, result.batch.fatalError);
  assert.equal(
    result.batch.nativePreflights.baseline.performanceStatus,
    'failed',
  );
  assert.equal(
    result.analysis.status,
    'qualification-collected-performance-failed',
  );
  assert.equal(result.analysis.qualificationPassed, false);
  assert.equal(result.analysis.collectionComplete, true);
  assert.equal(result.exitCode, 1);
});

async function actualPreflightPolicy({ slow = false, mutate } = {}) {
  const ts = createRequire(import.meta.url)('typescript');
  const sourceText = await readFile(
    new URL(
      './browser-profiles-production-headless-preflight.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const source = ts.createSourceFile(
    'preflight.mjs',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const block = source.statements.find((node) => ts.isTryStatement(node));
  const resultNode = source.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (decl) => decl.name.getText(source) === 'result',
      ),
  );
  let body = block.getText(source);
  // Replace only the external Electron workload import, using its parsed range.
  const imports = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      imports.push(node);
    ts.forEachChild(node, visit);
  };
  visit(block);
  assert.equal(imports.length, 1);
  const external = imports[0];
  body =
    body.slice(0, external.getStart(source) - block.getStart(source)) +
    'runSupplemental()' +
    body.slice(external.end - block.getStart(source));
  // import.meta.url is source location, not a policy branch.
  body = body.replaceAll('import.meta.url', 'sourceUrl');
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'release-preflight-'));
  const output = path.join(outputRoot, 'preflight.json');
  const rawPath = `${output}.cold.json`;
  const raw = await completeReleaseRaw('cold', rawPath, 'baseline', { slow });
  const identity = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.appPath) value.mainDirectory = '/stage/out/main';
    for (const child of Object.values(value)) identity(child);
  };
  identity(raw);
  if (mutate) mutate(raw);
  const evidence = await import('./browser-profiles-evidence.mjs');
  const processDouble = {
    argv: ['node', 'preflight'],
    platform: 'darwin',
    exitCode: slow ? 1 : undefined,
  };
  const { classifyReleaseReport } =
    await import('./browser-profiles-release-ci.mjs');
  const { RESPONSIVENESS_THRESHOLDS } = await import('./profiles.mjs');
  const bindings = {
    assert,
    ...evidence,
    classifyReleaseReport,
    RESPONSIVENESS_THRESHOLDS,
    path,
    output,
    rawPath,
    root: '/stage',
    sourceUrl:
      'file:///stage/apps/desktop-app/tests/performance/browser-profiles-production-headless-preflight.mjs',
    process: processDouble,
    electronPath: '/electron/MacOS/Electron',
    writeFile,
    hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    realpath: async (file) => (file instanceof URL ? file.pathname : file),
    readFile: async (file, ...args) =>
      file instanceof URL
        ? Buffer.from('test-owned adapter archive')
        : readFile(file, ...args),
    manifest: async () => raw.source.bundles,
    runSupplemental: async () => writeFile(rawPath, JSON.stringify(raw)),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    await new AsyncFunction(
      ...Object.keys(bindings),
      `${resultNode.getText(source)}\n${body}`,
    )(...Object.values(bindings));
    return {
      value: JSON.parse(await readFile(output, 'utf8')),
      exitCode: processDouble.exitCode,
    };
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

test('actual native preflight all-green fixture establishes capability', async () => {
  const { value } = await actualPreflightPolicy();
  assert.equal(value.status, 'available', value.error);
});

test('actual native preflight retains finite failure with valid capability and nonzero exit', async () => {
  const { value, exitCode } = await actualPreflightPolicy({ slow: true });
  assert.equal(value.status, 'performance-failed', value.error);
  assert.equal(value.structuralStatus, 'valid');
  assert.equal(value.passed, false);
  assert.equal(exitCode, 1);
});

for (const failure of [1, 2, 4])
  test(`actual population latches finite failure at call ${failure} through all later passes`, async () => {
    const result = await populationFixture({ failure });
    assert.equal(result.calls.length, 35, result.batch.fatalError);
    assert.equal(result.batch.performanceFailed, true);
    assert.equal(result.analysis.collectionComplete, true);
    assert.equal(result.analysis.qualificationPassed, false);
    assert.equal(result.analysis.finalAcceptance, false);
    assert.equal(result.analysis.releaseAcceptance, false);
    assert.equal(result.analysis.capacity.qualified, false);
    assert.equal(result.analysis.capacity.observedCostsComplete, true);
    assert.equal(
      result.analysis.capacity.status,
      'capacity-gap-performance-failed',
    );
    assert.equal(result.exitCode, 1);
  });

test('actual population retains every failed measured observation and exact fixed invocation arguments', async () => {
  const result = await populationFixture({
    failure: Array.from({ length: 35 }, (_, index) => index),
  });
  assert.equal(result.calls.length, 35, result.batch.fatalError);
  const observations = Object.values(result.analysis.modes).flatMap(
    (mode) => mode.observations,
  );
  assert.equal(observations.length, 22);
  assert(
    observations.every(
      (row) =>
        row.performanceStatus === 'failed' &&
        row.metrics &&
        row.violations?.[0]?.value === 400.133,
    ),
  );
  assert.equal(result.analysis.collectionComplete, true);
  assert.equal(result.analysis.capacity.combinations.length, 11);
  assert(
    result.analysis.capacity.combinations.every(
      (entry) => entry.maximumCompleteMs === 3000,
    ),
  );
  assert.equal(result.analysis.capacity.stableExecutionEnabled, false);
  assert.deepEqual(
    result.calls.slice(0, 2).map((entry) => entry.label),
    [
      'native-headless-preflight-baseline',
      'native-headless-preflight-candidate',
    ],
  );
  const expectedModes = [
    ...Array(6).fill('common'),
    ...Array(3).fill('maintenance'),
    ...Array(6).fill('startup'),
    ...Array(6).fill('cold'),
    ...Array(6).fill('veto'),
    ...Array(3).fill('inventory'),
    ...Array(3).fill('retirement'),
  ];
  assert.deepEqual(
    result.batch.attempts.map((attempt) => attempt.mode),
    expectedModes,
  );
  for (const [index, call] of result.calls.slice(2).entries()) {
    assert.equal(call.args[call.args.indexOf('--samples') + 1], '1');
    assert.equal(call.args[call.args.indexOf('--warmups') + 1], '0');
    assert.equal(call.args[call.args.indexOf('--window-mode') + 1], 'headless');
    assert.equal(result.batch.attempts[index].ordinal, index);
    const attempt = result.batch.attempts[index];
    const driver = {
      common: 'release',
      maintenance: 'release',
      startup: 'startup',
      cold: 'supplemental',
      veto: 'supplemental',
      inventory: 'supplemental',
      retirement: 'supplemental',
    }[attempt.mode];
    const expected = [
      '--import',
      'tsx',
      `apps/desktop-app/tests/performance/browser-profiles-${driver}-run.mjs`,
      '--window-mode',
      'headless',
      '--samples',
      '1',
      '--warmups',
      '0',
      '--output',
      attempt.reportPath,
    ];
    if (attempt.mode === 'maintenance') expected.push('--maintenance');
    else if (attempt.mode === 'startup')
      expected.push(
        '--stage',
        attempt.stage === 'baseline' ? 'frozenPhase2' : 'finalPhase3',
      );
    else if (attempt.mode !== 'common') expected.push('--mode', attempt.mode);
    assert.deepEqual(call.args, expected);
    assert.equal(call.executable, process.execPath);
  }
});

const structuralMutations = [
  ['missing task', (raw) => raw.samples[0].tasks.pop()],
  [
    'duplicate task',
    (raw) => raw.samples[0].tasks.push(raw.samples[0].tasks[0]),
  ],
  [
    'task error',
    (raw) => {
      raw.samples[0].tasks[0].status = 'error';
    },
  ],
  [
    'task duration',
    (raw) => {
      raw.samples[0].tasks[0].durationMs = null;
    },
  ],
  [
    'unknown status',
    (raw) => {
      raw.samples[0].status = 'unknown';
    },
  ],
  [
    'summary contradiction',
    (raw) => {
      raw.summary.passed = true;
    },
  ],
  [
    'recorded contradiction',
    (raw) => {
      raw.samples[0].responsiveness.passed = true;
    },
  ],
  [
    'missing frame',
    (raw) => {
      raw.samples[0].monitoring.raw.renderer.frames = [];
    },
  ],
  [
    'observer unavailable',
    (raw) => {
      raw.samples[0].monitoring.raw.renderer.longTaskObserverAvailable = false;
    },
  ],
  [
    'nonfinite IPC',
    (raw) => {
      raw.samples[0].monitoring.summary.ipcOuterMs.max = null;
    },
  ],
  [
    'fractional IPC errors',
    (raw) => {
      raw.samples[0].monitoring.summary.ipcErrorCount = 0.5;
    },
  ],
  [
    'typing count',
    (raw) => {
      raw.samples[0].monitoring.summary.rendererKeyToPaintConfirmationMs.count = 1;
    },
  ],
  [
    'settled CPU',
    (raw) => {
      raw.samples[0].settled.summary.totalCpuPercent.p95 = null;
    },
  ],
  [
    'missing runtime',
    (raw) => {
      delete raw.samples[0].runtime.node;
    },
  ],
  [
    'different runtime',
    (raw) => {
      raw.samples[0].runtime.node = 'different';
    },
  ],
  [
    'different source',
    (raw) => {
      raw.source.commit = 'different';
    },
  ],
  [
    'different bundles',
    (raw) => {
      raw.source.bundles['main/index.js'] = 'c'.repeat(64);
    },
  ],
  [
    'different config',
    (raw) => {
      raw.configuration.samples = 2;
    },
  ],
  [
    'different adapter archive',
    async (raw) => {
      await writeFile(raw.samples[0].adapterLaunches[0].archivePath, 'changed');
    },
  ],
  [
    'missing terminal dispatch',
    (raw) => {
      raw.samples[0].adapterLaunches[0].terminalEvidence.records.at(
        -1,
      ).dispatchCompleted = false;
    },
  ],
];
for (const [name, change] of structuralMutations)
  test(`actual population aborts ${name} despite simultaneous finite failure`, async () => {
    const result = await populationFixture({
      failure: 2,
      mutate: async ({ index, raw }) => {
        if (index === 2) await change(raw);
      },
    });
    assert.equal(result.calls.length, 3, result.batch.fatalError);
    assert.equal(result.batch.attempts[0].failureClass, 'structural');
    assert.equal(result.analysis.collectionComplete, false);
    assert.equal(result.analysis.qualificationPassed, false);
    assert.equal(result.analysis.capacity.observedCostsComplete, false);
    assert.equal(result.exitCode, 1);
  });

for (const [mode, call, change] of [
  [
    'startup',
    11,
    (sample) => {
      sample.earlyCoverage.preWindowSampleCount = 0;
    },
  ],
  [
    'inventory',
    29,
    (sample) => {
      sample.inventory.workerResources.observedWorkloadSamples = 0;
    },
  ],
  [
    'retirement',
    32,
    (sample) => {
      sample.retirement.passiveCleanupEvidence.remainingCount = 1;
    },
  ],
])
  test(`actual population aborts incomplete ${mode} fixture before next launch`, async () => {
    const result = await populationFixture({
      failure: call,
      mutate: ({ index, raw }) => {
        if (index === call) change(raw.samples[0]);
      },
    });
    assert.equal(result.calls.length, call + 1, result.batch.fatalError);
    assert.equal(result.analysis.collectionComplete, false);
    assert.equal(result.exitCode, 1);
  });

test('actual population invalid baseline prerequisite stops before candidate', async () => {
  const result = await populationFixture({
    failure: 0,
    mutate: ({ index, raw }) => {
      if (index === 0) raw.samples[0].tasks.pop();
    },
  });
  assert.equal(result.calls.length, 1);
  assert.equal(
    result.batch.nativePreflights.baseline.failureClass,
    'structural',
  );
  assert.equal(result.analysis.collectionComplete, false);
});

test('actual population rejects historical unavailable admission records', async () => {
  const result = await populationFixture({
    mutate: ({ index, derived }) => {
      if (index === 0) {
        derived.schemaVersion = 2;
        derived.kind = 'native-production-headless-capability-v1';
        derived.status = 'unavailable';
      }
    },
  });
  assert.equal(result.calls.length, 1);
  assert.equal(result.analysis.collectionComplete, false);
});

for (const options of [{ verifyFailure: 'after-0' }, { commandFailure: 2 }])
  test(`actual population aborts unsafe completion ${JSON.stringify(options)}`, async () => {
    const result = await populationFixture(options);
    assert.equal(result.calls.length, 3);
    assert.equal(result.analysis.collectionComplete, false);
    assert.equal(result.exitCode, 1);
  });

test('actual population revalidates final retained evidence without losing earlier failure', async () => {
  const result = await populationFixture({
    failure: 0,
    finalMutate: async (batch) => {
      const file = batch.attempts[2].reportPath;
      const raw = JSON.parse(await readFile(file, 'utf8'));
      raw.samples[0].tasks.pop();
      await writeFile(file, JSON.stringify(raw));
    },
  });
  assert.equal(result.calls.length, 35);
  assert.equal(result.analysis.collectionComplete, false);
  assert.equal(result.analysis.performanceFailed, true);
  assert.equal(result.exitCode, 1);
  assert.match(
    result.batch.attempts[2].retainedValidationError,
    /Retained report changed/,
  );
});

test('actual exploratory retains strict prerequisites and exactly 66 all-green slots', async () => {
  const passed = await populationFixture({ protocol: 'exploratory' });
  assert.equal(passed.calls.length, 68, passed.batch.fatalError);
  assert.equal(
    passed.analysis.status,
    'exploratory-protocol-passed-not-final-acceptance',
  );
  const failed = await populationFixture({
    protocol: 'exploratory',
    failure: 0,
  });
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.exitCode, 1);
});

async function withClassifiableRaw(mode, operation) {
  const directory = await mkdtemp(path.join(tmpdir(), 'release-assessor-'));
  const api = await import('./browser-profiles-release-ci.mjs');
  const { RESPONSIVENESS_THRESHOLDS: thresholds } =
    await import('./profiles.mjs');
  const { assessResponsiveness } = await import('./responsiveness.mjs');
  const { buildSummary } = await import('./monitor.mjs');
  const recompute = (raw) => {
    const sample = raw.samples[0];
    const monitors = Array.isArray(sample.monitoring)
      ? sample.monitoring
      : [sample.monitoring];
    for (const monitor of [
      ...monitors,
      ...(sample.settled ? [sample.settled] : []),
    ]) {
      monitor.summary = buildSummary(monitor.raw);
      monitor.responsiveness = assessResponsiveness(
        monitor.summary,
        thresholds,
      );
    }
    if (!Array.isArray(sample.monitoring))
      sample.responsiveness = monitors[0].responsiveness;
    if (mode === 'startup')
      sample.settledResponsiveness = sample.settled.responsiveness;
    const passed =
      monitors
        .filter((monitor) => monitor.scope !== 'setup')
        .every((monitor) => monitor.responsiveness.passed) &&
      (mode !== 'startup' || sample.settledResponsiveness.passed);
    sample.status = passed ? 'ok' : 'unresponsive';
    raw.summary.passed = passed;
    return passed ? 0 : 1;
  };
  try {
    await operation(
      await completeReleaseRaw(
        mode,
        path.join(directory, 'raw.json'),
        'baseline',
      ),
      { ...api, thresholds, recompute },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const mode of [
  'cold',
  'veto',
  'common',
  'maintenance',
  'startup',
  'inventory',
  'retirement',
])
  test(`release classification preserves ${mode} scope and empty observed Long Tasks`, async () => {
    await withClassifiableRaw(
      mode,
      (
        raw,
        { classifyReleaseReport, validateReleaseSample, metrics, thresholds },
      ) => {
        const sample = raw.samples[0];
        assert.equal(
          classifyReleaseReport(mode, raw, 0, thresholds).performanceStatus,
          'passed',
        );
        assert.equal(validateReleaseSample(mode, sample), sample);
        assert(Object.keys(metrics(mode, sample)).length > 0);
        const monitoring = Array.isArray(sample.monitoring)
          ? sample.monitoring[0]
          : sample.monitoring;
        assert.equal(monitoring.summary.longTasks.count, 0);
        assert.equal(monitoring.summary.longTasks.max, null);
        if (sample.settled)
          assert.deepEqual(
            sample.settled.raw.renderer.keyToPaintConfirmationMs,
            [],
          );
        if (sample.settled)
          assert.equal(
            sample.settled.summary.rendererKeyToPaintConfirmationMs.max,
            null,
          );
        if (mode === 'cold' || mode === 'veto') {
          assert.equal(sample.settled, undefined);
          assert.equal(
            monitoring.summary.rendererKeyToPaintConfirmationMs.count,
            0,
          );
          assert.deepEqual(
            monitoring.raw.renderer.keyToPaintConfirmationMs,
            [],
          );
          assert.equal(
            monitoring.summary.rendererKeyToPaintConfirmationMs.max,
            null,
          );
        }
      },
    );
  });

test('fix1 preserves genuinely empty raw typing and finite cold performance failure controls', async () => {
  await withClassifiableRaw(
    'cold',
    (raw, { classifyReleaseReport, thresholds, recompute }) => {
      const monitoring = raw.samples[0].monitoring[0];
      assert.deepEqual(monitoring.raw.renderer.keyToPaintConfirmationMs, []);
      assert.equal(
        classifyReleaseReport('cold', raw, 0, thresholds).performanceStatus,
        'passed',
      );
      monitoring.raw.renderer.frameGapsMs[0] = 400.133 + 1000 / 60;
      const code = recompute(raw);
      const result = classifyReleaseReport('cold', raw, code, thresholds);
      assert.equal(result.structuralStatus, 'valid');
      assert.equal(result.performanceStatus, 'failed');
      assert.equal(result.violations[0].metric, 'renderer.frame_delay.max_ms');
    },
  );
});

for (const mode of ['cold', 'veto'])
  for (const invalid of [null, NaN, Infinity])
    test(`fix1 rejects ${String(invalid)} raw typing in zero-count ${mode} workload`, async () => {
      await withClassifiableRaw(
        mode,
        (raw, { classifyReleaseReport, thresholds, recompute }) => {
          const monitoring = raw.samples[0].monitoring[0];
          monitoring.raw.renderer.keyToPaintConfirmationMs = [invalid];
          const code = recompute(raw);
          assert.equal(
            monitoring.summary.rendererKeyToPaintConfirmationMs.count,
            0,
          );
          assert.throws(
            () => classifyReleaseReport(mode, raw, code, thresholds),
            /typing/,
          );
        },
      );
    });

for (const mode of ['common', 'maintenance', 'startup'])
  for (const invalid of [null, NaN, Infinity])
    test(`fix1 rejects ${String(invalid)} raw typing in zero-count ${mode} settled scope`, async () => {
      await withClassifiableRaw(
        mode,
        (raw, { classifyReleaseReport, thresholds, recompute }) => {
          raw.samples[0].settled.raw.renderer.keyToPaintConfirmationMs = [
            invalid,
          ];
          const code = recompute(raw);
          assert.equal(
            raw.samples[0].settled.summary.rendererKeyToPaintConfirmationMs
              .count,
            0,
          );
          assert.throws(
            () => classifyReleaseReport(mode, raw, code, thresholds),
            /typing/,
          );
        },
      );
    });

test('fix1 rejects zero-summary raw typing count mismatch', async () => {
  await withClassifiableRaw(
    'cold',
    (raw, { classifyReleaseReport, thresholds }) => {
      const monitoring = raw.samples[0].monitoring[0];
      assert.equal(
        monitoring.summary.rendererKeyToPaintConfirmationMs.count,
        0,
      );
      monitoring.raw.renderer.keyToPaintConfirmationMs = [10];
      assert.throws(
        () => classifyReleaseReport('cold', raw, 0, thresholds),
        /typing coverage mismatch/,
      );
    },
  );
});

for (const malformed of [null, {}, 'invalid'])
  test(`fix1 rejects malformed zero-count raw typing ${JSON.stringify(malformed)}`, async () => {
    await withClassifiableRaw(
      'veto',
      (raw, { classifyReleaseReport, thresholds }) => {
        raw.samples[0].monitoring[0].raw.renderer.keyToPaintConfirmationMs =
          malformed;
        assert.throws(
          () => classifyReleaseReport('veto', raw, 0, thresholds),
          /typing coverage mismatch/,
        );
      },
    );
  });

for (const mode of ['common', 'maintenance', 'startup'])
  test(`release classification attributes ${mode} settled failure without changing raw scope`, async () => {
    await withClassifiableRaw(
      mode,
      (raw, { classifyReleaseReport, thresholds, recompute }) => {
        raw.samples[0].settled.raw.renderer.frameGapsMs[0] =
          400.133 + 1000 / 60;
        const code = recompute(raw);
        assert.equal(code, mode === 'startup' ? 1 : 0);
        const result = classifyReleaseReport(mode, raw, code, thresholds);
        assert.equal(result.performanceStatus, 'failed');
        assert.equal(result.violations[0].scope, 'settled');
        assert.equal(result.violations[0].driverScored, mode === 'startup');
        assert.equal(
          raw.samples[0].status,
          mode === 'startup' ? 'unresponsive' : 'ok',
        );
      },
    );
  });

for (const [delay, passed] of [
  [100.033, true],
  [100.05, true],
  [100.1, false],
])
  test(`release classifier preserves canonical frame boundary ${delay}`, async () => {
    await withClassifiableRaw(
      'common',
      (raw, { classifyReleaseReport, thresholds, recompute }) => {
        raw.samples[0].monitoring.raw.renderer.frameGapsMs[0] =
          delay + 1000 / 60;
        const code = recompute(raw);
        assert.equal(
          classifyReleaseReport('common', raw, code, thresholds).passed,
          passed,
        );
      },
    );
  });

test('release classification explains positive IPC errors and rejects unexplained exits and invented task scoring', async () => {
  await withClassifiableRaw(
    'common',
    (
      raw,
      {
        classifyReleaseReport,
        validateReleaseSample,
        metrics,
        thresholds,
        recompute,
      },
    ) => {
      raw.samples[0].tasks[0].responsivenessBudgetMs = 1;
      raw.samples[0].tasks[0].durationMs = 5000;
      assert.equal(
        classifyReleaseReport('common', raw, 0, thresholds).passed,
        true,
      );
      assert.throws(
        () => classifyReleaseReport('common', raw, 1, thresholds),
        /exit/,
      );
      raw.samples[0].monitoring.raw.ipcSamples[0].error = 'heartbeat failed';
      const code = recompute(raw);
      const result = classifyReleaseReport('common', raw, code, thresholds);
      assert.equal(result.violations[0].metric, 'ipc.error_count');
      assert.equal(result.violations[0].value, 1);
      assert.equal(result.violations[0].budgetMs, 0);
      assert.equal(result.violations[0].unit, 'count');
      assert.throws(
        () => validateReleaseSample('common', raw.samples[0]),
        /diagnostic/,
      );
      assert.deepEqual(metrics('common', raw.samples[0]), {});
    },
  );
});

for (const name of [
  'longTasks',
  'rendererKeyToPaintConfirmationMs',
  'ipcOuterMs',
])
  test(`release classification rejects missing/nonfinite scorer data ${name}`, async () => {
    await withClassifiableRaw(
      'common',
      (raw, { classifyReleaseReport, thresholds }) => {
        for (const invalid of [undefined, NaN, Infinity, -1]) {
          const changed = structuredClone(raw);
          changed.samples[0].monitoring.summary[name].max = invalid;
          assert.throws(() =>
            classifyReleaseReport('common', changed, 0, thresholds),
          );
        }
      },
    );
  });

test('qualification observed-cost projection includes slow complete failures without qualifying them', async () => {
  const passed = await populationFixture();
  const failed = await populationFixture({ failure: 4 });
  assert.equal(passed.analysis.capacity.qualified, true);
  assert.equal(failed.analysis.capacity.qualified, false);
  const projectedDelta =
    failed.analysis.capacity.projectedStableMinutes -
    passed.analysis.capacity.projectedStableMinutes;
  assert(Math.abs(projectedDelta - (1.2 * 21 * 2000) / 60000) < 1e-10);
  for (const mutate of [
    (batch) => {
      batch.attempts.pop();
    },
    (batch) => {
      batch.attempts[1].ordinal = 0;
    },
    (batch) => {
      batch.commands.find(
        (entry) => entry.label === batch.attempts[0].commandLabel,
      ).timedOut = true;
    },
    (batch) => {
      batch.commands.find(
        (entry) => entry.label === batch.attempts[0].commandLabel,
      ).durationMs = null;
    },
    (batch) => {
      batch.checks = batch.checks.filter((entry) => entry.label !== 'after-0');
    },
  ]) {
    const batch = structuredClone(failed.batch);
    mutate(batch);
    const { qualificationCapacity } =
      await import('./browser-profiles-release-ci.mjs');
    assert.equal(qualificationCapacity(batch).observedCostsComplete, false);
  }
});

for (const failAt of [
  'analysis.json',
  'artifact-manifest.json',
  'finalization.json',
])
  test(`actual finalization latches ${failAt} write failure before bounded rewrite`, async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'release-final-write-'));
    const previousExitCode = process.exitCode;
    const { batch, analysis } = qualificationFinalizationFixture();
    batch.limitations = [];
    batch.stages = {};
    let failed = false;
    try {
      await assert.rejects(
        () =>
          persistReleaseFinalization(
            {
              batch,
              analysis,
              qualification: true,
              output,
              execution: 'local-physical',
              finalizationStartedAt: Date.now(),
              signal: new AbortController().signal,
            },
            {
              writeJson: async (name, value) => {
                if (name === failAt && !failed) {
                  failed = true;
                  throw new Error('Original final artifact write failure');
                }
                await writeFile(path.join(output, name), JSON.stringify(value));
              },
            },
          ),
        /Original final artifact write failure/,
      );
      assert.equal(failed, true);
      const retained = JSON.parse(
        await readFile(path.join(output, 'analysis.json'), 'utf8'),
      );
      assert.equal(retained.collectionComplete, false);
      assert.equal(retained.qualificationPassed, false);
      assert.equal(retained.capacity.qualified, false);
      assert.equal(retained.status, 'qualification-incomplete-or-failed');
      assert.match(batch.fatalError, /Original final artifact write failure/);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
      await rm(output, { recursive: true, force: true });
    }
  });

for (const [name, change] of [
  [
    'null raw IPC',
    (monitor) => {
      monitor.raw.ipcSamples[0].outerMs = null;
    },
  ],
  [
    'NaN raw IPC',
    (monitor) => {
      monitor.raw.ipcSamples[0].outerMs = NaN;
    },
  ],
  [
    'infinite raw IPC',
    (monitor) => {
      monitor.raw.ipcSamples[0].outerMs = Infinity;
    },
  ],
  [
    'negative raw IPC',
    (monitor) => {
      monitor.raw.ipcSamples[0].outerMs = -1;
    },
  ],
])
  test(`release classification rejects ${name} even after finite summary recomputation`, async () => {
    await withClassifiableRaw(
      'common',
      (raw, { classifyReleaseReport, thresholds, recompute }) => {
        change(raw.samples[0].monitoring);
        const code = recompute(raw);
        assert.throws(
          () => classifyReleaseReport('common', raw, code, thresholds),
          /IPC|ipc/,
        );
      },
    );
  });

for (const [field, values] of [
  ['ipcOuterMs', [1, 3]],
  ['ipcErrorCount', [undefined, null, NaN, Infinity, -1, 0.5, 1]],
  ['ipcTimeoutCount', [undefined, null, NaN, Infinity, -1, 0.5, 1]],
])
  test(`release classification rejects raw/summary ${field} disagreement`, async () => {
    await withClassifiableRaw(
      'common',
      (raw, { classifyReleaseReport, thresholds }) => {
        for (const value of values) {
          const changed = structuredClone(raw);
          if (field === 'ipcOuterMs')
            changed.samples[0].monitoring.summary.ipcOuterMs.count = value;
          else changed.samples[0].monitoring.summary[field] = value;
          assert.throws(
            () => classifyReleaseReport('common', changed, 0, thresholds),
            /IPC|ipc/,
          );
        }
      },
    );
  });

test('actual population aborts raw IPC invalidity despite finite failed workload summary', async () => {
  const { buildSummary } = await import('./monitor.mjs');
  const { assessResponsiveness } = await import('./responsiveness.mjs');
  const { RESPONSIVENESS_THRESHOLDS } = await import('./profiles.mjs');
  const result = await populationFixture({
    failure: 2,
    mutate: ({ index, raw }) => {
      if (index !== 2) return;
      const sample = raw.samples[0];
      sample.monitoring.raw.ipcSamples[0].outerMs = null;
      sample.monitoring.summary = buildSummary(sample.monitoring.raw);
      sample.responsiveness = assessResponsiveness(
        sample.monitoring.summary,
        RESPONSIVENESS_THRESHOLDS,
      );
    },
  });
  assert.equal(
    result.calls.length,
    3,
    'Invalid raw IPC must stop before the next scheduled launch',
  );
  assert.equal(result.batch.attempts[0].failureClass, 'structural');
  assert.match(result.batch.attempts[0].rawSha256, /^[0-9a-f]{64}$/);
  assert.match(
    result.batch.attempts[0].retainedValidationError,
    /Invalid raw IPC|IPC|ipc/,
  );
  assert.doesNotMatch(
    result.batch.attempts[0].retainedValidationError,
    /undefined|Retained report changed/,
  );
  assert.equal(result.analysis.collectionComplete, false);
  assert.equal(result.exitCode, 1);
});

test('fix1 actual population aborts zero-count raw typing invalidity despite finite failed workload summary', async () => {
  const { buildSummary } = await import('./monitor.mjs');
  const { assessResponsiveness } = await import('./responsiveness.mjs');
  const { RESPONSIVENESS_THRESHOLDS } = await import('./profiles.mjs');
  const coldCall = 17;
  const result = await populationFixture({
    failure: coldCall,
    mutate: ({ index, raw }) => {
      if (index !== coldCall) return;
      const monitoring = raw.samples[0].monitoring[0];
      monitoring.raw.renderer.keyToPaintConfirmationMs = [null, NaN, Infinity];
      monitoring.summary = buildSummary(monitoring.raw);
      monitoring.responsiveness = assessResponsiveness(
        monitoring.summary,
        RESPONSIVENESS_THRESHOLDS,
      );
      assert.equal(
        monitoring.summary.rendererKeyToPaintConfirmationMs.count,
        0,
      );
      assert.equal(monitoring.responsiveness.passed, false);
    },
  });
  assert.equal(
    result.calls.length,
    coldCall + 1,
    'Invalid raw typing must stop before the next scheduled launch',
  );
  assert.equal(result.batch.attempts.at(-1).failureClass, 'structural');
  assert.equal(result.analysis.collectionComplete, false);
  assert.equal(result.exitCode, 1);
});

test('release classification preserves explained finite IPC timeout/error failures', async () => {
  await withClassifiableRaw(
    'common',
    (raw, { classifyReleaseReport, thresholds, recompute }) => {
      Object.assign(raw.samples[0].monitoring.raw.ipcSamples[0], {
        timeout: true,
        error: 'heartbeat timeout',
      });
      const code = recompute(raw);
      const value = classifyReleaseReport('common', raw, code, thresholds);
      assert.equal(value.structuralStatus, 'valid');
      assert.equal(value.performanceStatus, 'failed');
      assert.equal(value.violations[0].metric, 'ipc.error_count');
      assert.equal(raw.samples[0].monitoring.summary.ipcTimeoutCount, 1);
      assert.equal(raw.samples[0].monitoring.summary.ipcErrorCount, 1);
    },
  );
});

test('release classification rejects an invented IPC error even when recorded failure agrees', async () => {
  await withClassifiableRaw(
    'common',
    async (raw, { classifyReleaseReport, thresholds }) => {
      const { assessResponsiveness } = await import('./responsiveness.mjs');
      const sample = raw.samples[0];
      sample.monitoring.summary.ipcErrorCount = 1;
      sample.responsiveness = assessResponsiveness(
        sample.monitoring.summary,
        thresholds,
      );
      sample.status = 'unresponsive';
      raw.summary.passed = false;
      assert.throws(
        () => classifyReleaseReport('common', raw, 1, thresholds),
        /IPC|ipc/,
      );
    },
  );
});

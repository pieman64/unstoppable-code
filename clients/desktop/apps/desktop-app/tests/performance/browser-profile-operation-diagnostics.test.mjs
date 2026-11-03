import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { ElectronTerminalResultError } from '../electron/launchCanopy.mjs';
const require = createRequire(import.meta.url);
const verify = require('../electron/fixtures/browser-profile-clear/verify-closed.cjs');
const partitioned = require('../electron/fixtures/browser-profile-clear/partitioned.cjs');

async function runPartitionProgressFixture({ pageFailure } = {}) {
  const evidence = {};
  const checks = [];
  const port = 4444;
  const embedded = `https://embedded.test:${port}`;
  const state = {
    indexed: null,
    cache: null,
    opfs: null,
    worker: false,
    local: null,
  };
  const frameFor = (url) => ({
    url,
    executeJavaScript: async (expression) => {
      if (expression.includes('typeof readState')) return true;
      if (expression.includes('readState()')) return { ...state };
      return undefined;
    },
  });
  const page = async (_session, origin) => {
    if (pageFailure && origin.startsWith('https://first.test'))
      throw pageFailure;
    if (origin === 'about:blank') {
      return {
        id: 99,
        debugger: { attach() {} },
        close() {},
      };
    }
    const child = frameFor(`${embedded}/frame`);
    let destroyed = false;
    return {
      id: origin,
      mainFrame: {
        framesInSubtree: origin === embedded ? [] : [child],
      },
      executeJavaScript: async (expression) =>
        expression.includes('readState()') ? { ...state } : undefined,
      close() {
        destroyed = true;
      },
      isDestroyed: () => destroyed,
    };
  };
  const native = {
    setCertificateVerifyProc() {},
    cookies: { get: async () => [] },
    clearCache: async () => {},
    clearData: async () => {},
    webRequest: { onBeforeRequest() {} },
  };
  const server = {
    listen(_port, _host, callback) {
      callback();
    },
    address: () => ({ port }),
  };
  const run = partitioned({
    session: { fromPartition: () => native },
    page,
    check: (...args) => checks.push(args),
    until: async (predicate) => {
      assert.equal(await predicate(), true);
    },
    storage: '',
    evidence,
    verifyClosed: async () => ({
      localStorageCount: 1,
      databaseCount: 1,
      cacheCount: 1,
      opfsEntries: 1,
    }),
    createHttpsServer: () => server,
    tls: { cert: Buffer.from('cert') },
    servers: [],
  });
  return { run, evidence, checks };
}

test('partition fixture progress survives setup rejection at the last entered asynchronous boundary', async () => {
  const pageFailure = new Error('controlled page rejection');
  const fixture = await runPartitionProgressFixture({ pageFailure });
  await assert.rejects(fixture.run, (error) => error === pageFailure);
  const progress = fixture.evidence.partitionSetupProgress;
  assert.equal(progress.version, 1);
  assert.equal(progress.truncated, false);
  assert.deepEqual(
    progress.records.map(({ stage, outcome, hostRole }) => ({
      stage,
      outcome,
      hostRole,
    })),
    [
      { stage: 'server-listen', outcome: 'entered', hostRole: 'server' },
      { stage: 'server-listen', outcome: 'fulfilled', hostRole: 'server' },
      { stage: 'top-level-page', outcome: 'entered', hostRole: 'first' },
    ],
  );
});

test('partition fixture completed progress preserves boundary ordering and bounded output', async () => {
  const fixture = await runPartitionProgressFixture();
  await fixture.run;
  assert.equal(fixture.checks.length, 12);
  const progress = fixture.evidence.partitionSetupProgress;
  assert.equal(progress.records.length <= progress.limits.maxRecords, true);
  assert.equal(progress.limits.maxStringLength <= 256, true);
  assert.equal(progress.truncated, false);
  assert.deepEqual(
    progress.records.map(({ stage, outcome }) => `${stage}:${outcome}`),
    [
      'server-listen:entered',
      'server-listen:fulfilled',
      'top-level-page:entered',
      'top-level-page:fulfilled',
      'child-frame-readiness:entered',
      'child-frame-readiness:fulfilled',
      'child-storage-script-readiness:entered',
      'child-storage-script-readiness:fulfilled',
      'top-level-page:entered',
      'top-level-page:fulfilled',
      'child-frame-readiness:entered',
      'child-frame-readiness:fulfilled',
      'child-storage-script-readiness:entered',
      'child-storage-script-readiness:fulfilled',
      'first-party-page:entered',
      'first-party-page:fulfilled',
      'seed:entered',
      'seed:fulfilled',
      'seed:entered',
      'seed:fulfilled',
      'seed:entered',
      'seed:fulfilled',
      'seed:entered',
      'seed:fulfilled',
      'seed:entered',
      'seed:fulfilled',
      'initial-state-read:entered',
      'initial-state-read:fulfilled',
    ],
  );
  assert.ok(progress.records.every((record) => Number.isFinite(record.utcMs)));
});

function integratedDiagnosticSource(relativePath, fallbackUrl) {
  const root = process.env.INTEGRATED_WINDOWS_DIAGNOSTIC_SOURCE_ROOT?.trim();
  return root ? require('node:path').resolve(root, relativePath) : fallbackUrl;
}

function controlFor(entries) {
  const origin = 'http://127.0.0.1:4000';
  const control = {
    debugger: { sendCommand: async () => ({}), on() {}, removeListener() {} },
    loadURL: async () => {},
    mainFrame: {
      framesInSubtree: [
        {
          url: `${origin}/__browser_profile_verify__`,
          executeJavaScript: async (expression) =>
            vm.runInNewContext(expression, {
              navigator: {
                storage: {
                  getDirectory: async () => ({
                    async *values() {
                      yield* entries;
                    },
                  }),
                },
                serviceWorker: { getRegistrations: async () => [{}] },
              },
              document: { title: 'Local storage verification' },
              location: { origin },
              localStorage: { length: 1 },
              indexedDB: { databases: async () => [{}] },
              caches: { keys: async () => ['writer'] },
            }),
        },
      ],
    },
  };
  return { control, origin };
}
test('trusted verifier retains unexpected OPFS identity separately from unchanged semantic counts', async () => {
  const entries = ['writer', 'writer.crswap'].map((name) => ({
    name,
    kind: 'file',
    getFile: async () => ({ size: 160 }),
  }));
  const { control, origin } = controlFor(entries);
  const progress = [];
  const result = await verify(control, origin, origin, progress);
  assert.equal(result.opfsEntries, 2);
  assert.equal(Object.hasOwn(result, 'entries'), false);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        progress.find((row) => row.stage === 'opfs-metadata').entries,
      ),
    ),
    [
      { name: 'writer', kind: 'file', size: 160 },
      { name: 'writer.crswap', kind: 'file', size: 160 },
    ],
  );
});
test('trusted OPFS metadata caps entries and names while retaining the full strict count', async () => {
  const { control, origin } = controlFor(
    Array.from({ length: 20 }, () => ({
      name: 'x'.repeat(1000),
      kind: 'file',
      getFile: async () => {
        throw new Error('read failure');
      },
    })),
  );
  const progress = [];
  const result = await verify(control, origin, origin, progress);
  const metadata = progress.find((row) => row.stage === 'opfs-metadata');
  assert.equal(result.opfsEntries, 20);
  assert.equal(metadata.entries.length, 16);
  assert.equal(metadata.truncated, true);
  assert.equal(metadata.entries[0].name.length, 128);
  assert.equal(metadata.entries[0].error.message, 'read failure');
});

test('native diagnostic deadline destroys and awaits only its inert control, removes listeners and never leaves evaluation running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, origin } = controlFor([]);
  let rejectEvaluation,
    destructionDone = false,
    removed = false,
    destroyListener;
  control.mainFrame.framesInSubtree[0].executeJavaScript = () =>
    new Promise((_resolve, reject) => {
      rejectEvaluation = reject;
    });
  control.isDestroyed = () => destructionDone;
  control.once = (event, listener) => {
    assert.equal(event, 'destroyed');
    destroyListener = listener;
  };
  control.close = () => {
    queueMicrotask(() => {
      destructionDone = true;
      rejectEvaluation(new Error('owned control destroyed'));
      destroyListener();
    });
  };
  control.debugger.removeListener = () => {
    removed = true;
  };
  const progress = [];
  const operation = verify(control, origin, origin, progress);
  while (!rejectEvaluation) await Promise.resolve();
  t.mock.timers.tick(5000);
  await assert.rejects(operation, /owned control destroyed/);
  assert.equal(destructionDone, true);
  assert.equal(removed, true);
  assert(progress.some((row) => row.stage === 'verification-deadline'));
});

test('native console observer filters synthetic worker identities and caps retained events/bytes, with listener release', async () => {
  const { readFile } = await import('node:fs/promises');
  const { EventEmitter } = await import('node:events');
  const source = await readFile(
    new URL(
      '../electron/fixtures/browser-profile-clear/runtime.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  const declaration = source.slice(
    source.indexOf('function observeWriterPhases('),
    source.indexOf('const delay ='),
  );
  const releases = [];
  const observe = vm.runInNewContext(`(${declaration.trim()})`, {
    Buffer,
    diagnosticReleases: releases,
  });
  const serviceWorkers = new EventEmitter();
  const snapshot = observe({ serviceWorkers }, ['http://127.0.0.1:4000']);
  const message = {
    versionId: 1,
    sourceUrl: 'http://127.0.0.1:4000/worker.js',
    message:
      '__PROFILE_CLEAR_OPFS_PHASE__' +
      JSON.stringify({
        phase: 'close',
        sequence: 4,
        completedSequence: 3,
        error: { name: 'x'.repeat(200), message: 'x'.repeat(1000) },
      }),
  };
  serviceWorkers.emit(
    'console-message',
    {},
    { ...message, sourceUrl: 'http://other/worker.js' },
  );
  assert.equal(snapshot().records.length, 0);
  for (let i = 0; i < 1000; i++)
    serviceWorkers.emit('console-message', {}, message);
  assert(snapshot().records.length <= 128);
  assert(Buffer.byteLength(JSON.stringify(snapshot())) <= 64 * 1024);
  assert(snapshot().dropped > 0);
  assert.equal(snapshot().fieldTruncations, 1000);
  assert.equal(snapshot().first.error.truncated, true);
  assert.equal(snapshot().latest[0].completedSequence, 3);
  releases[0]();
  assert.equal(serviceWorkers.listenerCount('console-message'), 0);
});

test('diagnostic worker keeps the original OPFS write sequence and creates only writer', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL(
      '../electron/fixtures/browser-profile-clear/runtime.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const storage = `'),
    source.indexOf('const html = `'),
  );
  const worker = vm.runInNewContext(`${declarations}; worker`);
  const phases = [],
    calls = [];
  const context = {
    self: { addEventListener() {} },
    console: {
      log: (value) =>
        phases.push(
          JSON.parse(value.slice('__PROFILE_CLEAR_OPFS_PHASE__'.length)),
        ),
    },
    Response,
    Promise,
    setTimeout,
    fetch: () => {
      throw new Error('unexpected fetch');
    },
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => request.onsuccess());
        request.result = {
          close() {},
          transaction() {
            const tx = {
              objectStore: () => ({
                put() {
                  queueMicrotask(() => tx.oncomplete());
                },
              }),
            };
            return tx;
          },
        };
        return request;
      },
    },
    caches: {
      open: async () => ({
        put: async () => {
          calls.push('cache');
        },
      }),
    },
    navigator: {
      storage: {
        getDirectory: async () => ({
          getFileHandle: async (name, options) => {
            calls.push(['getFileHandle', name, options]);
            return {
              createWritable: async () => {
                calls.push('createWritable');
                return {
                  write: async (value) => calls.push(['write', value]),
                  close: async () => calls.push('close'),
                };
              },
            };
          },
        }),
      },
    },
  };
  await vm.runInNewContext(`${worker}; write(4);`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    'cache',
    ['getFileHandle', 'writer', { create: true }],
    'createWritable',
    ['write', '4'],
    'close',
  ]);
  assert.deepEqual(
    phases.map((row) => row.phase),
    ['get-handle', 'create-writable', 'write', 'close', 'closed'],
  );
  assert.equal(phases.at(-1).completedSequence, 4);
});

test('existing production scanner rejects selected E2E markers and still verifies source hits', async (t) => {
  const { mkdtemp, mkdir, writeFile, rm, readFile } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const scanner = new URL(
    '../../../../scripts/check-no-e2e-seams.mjs',
    import.meta.url,
  );
  const source = await readFile(scanner, 'utf8');
  const markers = Array.from(
    source
      .match(/const FORBIDDEN_MARKERS = \[([\s\S]*?)\];/)[1]
      .matchAll(/'([^']+)'/g),
    (match) => match[1],
  );
  const root = await mkdtemp(join(tmpdir(), 'profile-diagnostic-scanner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'out'));
  await mkdir(join(root, 'apps/desktop-app/src'), { recursive: true });
  await writeFile(
    join(root, 'apps/desktop-app/src/seams.ts'),
    markers.join('\n'),
  );
  const run = () =>
    execFileSync(process.execPath, [scanner.pathname], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  assert.match(run(), /OK/);
  for (const marker of [
    '__CANOPY_E2E_PROFILE_REVIEW_FIXTURE__',
    '__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__',
    'CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS',
    'projects-load-main-entered',
    'canopy:e2e:first-projects-load',
    'canopy:e2e:first-projects-load-stop',
    'projects-load-renderer-entered',
    'e2eReportFirstProjectsLoad',
    'e2eIsFirstProjectsLoadActive',
    'observeLoadedTaskReset',
  ]) {
    assert(markers.includes(marker));
    await writeFile(join(root, 'out/index.js'), marker);
    assert.throws(
      run,
      (error) =>
        error.status === 1 &&
        error.stderr.includes(`out/index.js :: ${marker}`),
    );
  }
  await writeFile(join(root, 'out/index.js'), 'safe');
  await writeFile(join(root, 'apps/desktop-app/src/seams.ts'), '');
  assert.throws(
    run,
    (error) =>
      error.status === 1 &&
      error.stderr.includes('entries match no source file'),
  );
});

test('active and template workflows retain the full sharded Windows suite and independent macOS suite', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(
    new URL(
      '../../../../.github/workflows/browser-profile-acceptance.yml',
      import.meta.url,
    ),
    'utf8',
  );
  const template = await readFile(
    new URL(
      '../../../../docs/planning/2026-09-09-browser-profiles/spikes/phase-3-clear-workflow.yml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(workflow, template);
  assert.equal(
    workflow.split(
      'node apps/desktop-app/tests/performance/run-browser-profile-acceptance-command.mjs',
    ).length - 1,
    2,
  );
  assert(
    workflow.includes(
      "--receipt '.playwright/browser-profiles/phase-3/windows-full-${{ matrix.shard_suffix }}-controller.json'",
    ),
  );
  assert(
    workflow.includes(
      '--test-name-pattern="real Windows guarded timeout fixture"',
    ),
  );
  assert(
    workflow.includes(
      '.playwright/windows-acceptance-controller-fixture-results/',
    ),
  );

  assert(
    workflow.includes(
      '      - name: Exercise native partitioned clearing\n' +
        '        if: ${{ !cancelled() }}\n' +
        '        run: node apps/desktop-app/tests/electron/fixtures/browser-profile-clear/run.mjs .playwright/browser-profiles/phase-3/native-clear.json',
    ),
    'independent native clearing must still run after an earlier failure unless the job is cancelled',
  );
  assert.equal(
    workflow.split('CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR:').length - 1,
    5,
  );
  assert(workflow.includes("CANOPY_E2E_SHOW_WINDOW: '0'"));
  assert(
    workflow.includes(
      '.playwright/browser-profiles/phase-3/windows-boundary-*/',
    ),
  );
  assert(
    workflow.includes(
      'browser-profiles.spec.mjs browser-chrome.spec.mjs --reporter=line --retries=0',
    ),
  );
  const fullWindowsControl =
    '      - name: Verify full Windows product profile lifecycle and data management\n' +
    '        if: ${{ !cancelled() && matrix.windows }}\n' +
    '        timeout-minutes: 30\n' +
    '        env:\n' +
    "          CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '.playwright/browser-profiles/phase-3/windows-boundary-${{ matrix.shard_suffix }}'\n" +
    "          PLAYWRIGHT_JSON_OUTPUT_FILE: '.playwright/browser-profiles/phase-3/windows-full-${{ matrix.shard_suffix }}-results.json'\n" +
    '        run: |\n' +
    '          mkdir -p .playwright/browser-profiles/phase-3\n' +
    '          set -o pipefail\n' +
    '          node apps/desktop-app/tests/performance/run-browser-profile-acceptance-command.mjs \\\n' +
    "            --shard '${{ matrix.shard }}' \\\n" +
    "            --shard-suffix '${{ matrix.shard_suffix }}' \\\n" +
    "            --receipt '.playwright/browser-profiles/phase-3/windows-full-${{ matrix.shard_suffix }}-controller.json' \\\n" +
    '            2>&1 | tee .playwright/browser-profiles/phase-3/windows-full-${{ matrix.shard_suffix }}.log';
  assert(workflow.includes(fullWindowsControl));

  const viewportTitle =
    '(?:^| )two Browser panels: transactional add, live identity, side-by-side, close destruction$';
  const preparedTitle =
    '(?:^| )recovers the prepared switch decision before reopening its real account$';
  const diagnosticStep = (name, nextName) => {
    const start = workflow.indexOf(`      - name: ${name}`);
    const end = workflow.indexOf(`      - name: ${nextName}`, start);
    assert(start >= 0 && end > start, `${name} step must be present`);
    return workflow.slice(start, end);
  };
  const viewportDiagnostic = diagnosticStep(
    'Diagnose Windows native viewport for two Browser panels',
    'Diagnose Windows prepared restart boundary',
  );
  const preparedDiagnostic = diagnosticStep(
    'Diagnose Windows prepared restart boundary',
    'Diagnose intermittent macOS profile permission dispatch',
  );
  for (const [step, shard, spec, title, flag] of [
    [
      viewportDiagnostic,
      '1/4',
      'browser-chrome.spec.mjs',
      viewportTitle,
      "CANOPY_E2E_NATIVE_VIEWPORT_DIAGNOSTIC: '1'",
    ],
    [
      preparedDiagnostic,
      '3/4',
      'browser-profiles.spec.mjs',
      preparedTitle,
      "CANOPY_E2E_PREPARED_RESTART_DIAGNOSTIC: '1'",
    ],
  ]) {
    assert(
      step.includes(
        "if: ${{ !cancelled() && runner.os == 'Windows' && matrix.shard == '" +
          shard +
          "' }}",
      ),
    );
    assert(step.includes('timeout-minutes: 10'));
    assert(step.includes(flag));
    assert(
      step.includes(
        "CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '.playwright/browser-profiles/phase-3/windows-boundary-diagnostic-${{ matrix.shard_suffix }}'",
      ),
    );
    assert(
      step.includes(
        "PLAYWRIGHT_JSON_OUTPUT_FILE: '.playwright/browser-profiles/phase-3/windows-profile-diagnostic-${{ matrix.shard_suffix }}-results.json'",
      ),
    );
    assert(
      step.includes(
        `pnpm run test:electron:built ${spec} --grep '${title}' --workers=1 --retries=0 --reporter=line,json --output=` +
          '.playwright/windows-profile-diagnostics-${{ matrix.shard_suffix }}-results',
      ),
    );
    assert(step.includes('set -o pipefail'));
    assert(
      step.includes(
        '2>&1 | tee .playwright/browser-profiles/phase-3/windows-profile-diagnostic-${{ matrix.shard_suffix }}.log',
      ),
    );
    assert(!step.includes('--repeat-each'));
  }
  assert.equal(
    workflow.split('CANOPY_E2E_NATIVE_VIEWPORT_DIAGNOSTIC:').length - 1,
    1,
  );
  assert.equal(
    workflow.split('CANOPY_E2E_PREPARED_RESTART_DIAGNOSTIC:').length - 1,
    1,
  );
  for (const [mode, suffix] of [
    ['clean0', 'clean0'],
    ['target125', 'target125'],
  ]) {
    assert(
      viewportDiagnostic.includes(
        `CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION=${mode} PLAYWRIGHT_JSON_OUTPUT_FILE='.playwright/browser-profiles/phase-3/windows-profile-diagnostic-\${{ matrix.shard_suffix }}-${suffix}-results.json'`,
      ),
    );
    assert(
      viewportDiagnostic.includes(
        `--output=.playwright/windows-profile-diagnostics-\${{ matrix.shard_suffix }}-${suffix}-results`,
      ),
    );
    assert(
      viewportDiagnostic.includes(
        `windows-profile-diagnostic-\${{ matrix.shard_suffix }}-${suffix}.log`,
      ),
    );
    assert(
      workflow.includes(
        `.playwright/windows-profile-diagnostics-\${{ matrix.shard_suffix }}-${suffix}-results/`,
      ),
    );
  }
  assert(
    workflow.includes(
      '.playwright/windows-profile-diagnostics-${{ matrix.shard_suffix }}-results/',
    ),
  );
  assert(
    workflow.indexOf(fullWindowsControl) <
      workflow.indexOf(
        '      - name: Diagnose Windows native viewport for two Browser panels',
      ),
  );
  assert(workflow.includes('timeout-minutes: 30'));
  assert(workflow.includes('set -o pipefail'));
  const controller =
    await import('./run-browser-profile-acceptance-command.mjs');
  assert.equal(controller.ACCEPTANCE_WORK_DEADLINE_MS, 24 * 60_000);
  assert(controller.ACCEPTANCE_WORK_DEADLINE_MS < 30 * 60_000);
  assert(workflow.includes('timeout-minutes: 45'));
  assert(workflow.includes('PLAYWRIGHT_JSON_OUTPUT_FILE:'));
  assert(workflow.includes('.playwright/browser-profiles/phase-3/*.json'));
  assert(workflow.includes('.playwright/browser-profiles/phase-3/*.log'));
  assert(workflow.includes('if: always()'));
  const native = workflow.slice(
    workflow.indexOf('      - name: Verify native Windows process supervisor'),
    workflow.indexOf('      - name: Exercise native partitioned clearing'),
  );
  assert(
    native.includes(
      "if: ${{ runner.os == 'Windows' && matrix.shard == '1/4' }}",
    ),
  );
  assert(native.includes('timeout-minutes: 5'));
  assert(
    native.indexOf('process-tree-supervisor.test.mjs') <
      native.indexOf(
        '--test-name-pattern="real Windows guarded timeout fixture"',
      ),
  );
  const brandPreparation = 'pnpm run brand:prepare --all';
  assert.equal(native.split(brandPreparation).length - 1, 1);
  assert(
    native.indexOf(brandPreparation) <
      native.indexOf(
        '--test-name-pattern="real Windows guarded timeout fixture"',
      ),
    'generated brand files must be prepared before the guarded timeout fixture is collected',
  );
  assert.equal(native.split('run-guarded-dev-script.mjs').length - 1, 1);
  assert(
    native.includes(
      'apps/desktop-app/tests/performance/run-browser-profile-acceptance-command.test.mjs',
    ),
  );
  assert(
    native.includes(
      '2>&1 | tee .playwright/browser-profiles/phase-3/windows-acceptance-controller-timeout.log',
    ),
  );
  assert(
    workflow.indexOf(
      '--test-name-pattern="real Windows guarded timeout fixture"',
    ) < workflow.indexOf('      - name: Build product automation bundle'),
  );
  const spec = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  assert(
    spec.includes(
      "if (process.env.CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE === '1')",
    ),
  );
  assert.equal(
    spec.split(
      "test('acceptance controller owns and terminates its timeout fixture'",
    ).length - 1,
    1,
  );
  const fixture = spec.slice(
    spec.indexOf(
      "if (process.env.CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE === '1')",
    ),
  );
  assert(!fixture.includes('launchCanopy('));
  assert.match(fixture, /spawn\(\s*process\.execPath,/);
  const tail = controller.acceptanceCommandArgs(process.cwd(), {
    shard: '1/4',
    shardSuffix: 'shard-1-of-4',
  });
  assert(tail[0].endsWith('scripts/run-guarded-dev-script.mjs'));
  assert.deepEqual(tail.slice(1, 4), ['--suite', 'e2e', '--']);
  assert.deepEqual(tail.slice(7), [
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
  ]);
  assert(
    workflow.includes(
      '2>&1 | tee .playwright/browser-profiles/phase-3/windows-full-${{ matrix.shard_suffix }}.log',
    ),
  );
  for (const shard of ['1/4', '2/4', '3/4', '4/4']) {
    assert.equal(workflow.split(`shard: '${shard}'`).length - 1, 1);
  }
  for (const shard of [1, 2, 3, 4]) {
    assert.equal(
      workflow.split(
        `artifact_name: browser-profile-acceptance-windows-2025-shard-${shard}-of-4`,
      ).length - 1,
      1,
    );
  }

  const jobStart = workflow.indexOf('  windows-cowork-worker-diagnostic:');
  assert(jobStart > workflow.indexOf('  runtime:'));
  const diagnosticJob = workflow.slice(jobStart);
  assert(diagnosticJob.includes('runs-on: windows-2025'));
  assert(diagnosticJob.includes('timeout-minutes: 30'));
  assert(!diagnosticJob.includes('\n    needs:'));
  assert(diagnosticJob.includes("CANOPY_E2E_SHOW_WINDOW: '0'"));
  assert(diagnosticJob.includes('run: pnpm run build:e2e'));
  assert(diagnosticJob.includes('timeout-minutes: 12'));
  assert(diagnosticJob.includes('set -o pipefail'));
  assert(
    diagnosticJob.includes(
      'node apps/desktop-app/tests/performance/run-browser-profile-acceptance-command.mjs --diagnostic cowork-worker-failfast',
    ),
  );
  assert(
    diagnosticJob.includes(
      '2>&1 | tee .playwright/browser-profiles/phase-3/windows-cowork-worker-diagnostic.log',
    ),
  );
  assert(
    diagnosticJob.includes(
      "CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '.playwright/browser-profiles/phase-3/windows-boundary-cowork-worker-diagnostic'",
    ),
  );
  assert(
    diagnosticJob.includes(
      "PLAYWRIGHT_JSON_OUTPUT_FILE: '.playwright/browser-profiles/phase-3/windows-cowork-worker-diagnostic-results.json'",
    ),
  );
  assert(diagnosticJob.includes('if: always()'));
  assert(
    diagnosticJob.includes(
      'browser-profile-acceptance-windows-2025-cowork-worker-diagnostic',
    ),
  );
  for (const evidence of [
    '.playwright/browser-profiles/phase-3/windows-cowork-worker-diagnostic*.json',
    '.playwright/browser-profiles/phase-3/windows-cowork-worker-diagnostic*.log',
    '.playwright/browser-profiles/phase-3/windows-boundary-cowork-worker-diagnostic/',
    '.playwright/windows-cowork-worker-diagnostic-results/',
    '.playwright/test-results/',
  ])
    assert(diagnosticJob.includes(evidence));
  for (const forbidden of [
    '--repeat-each',
    '--shard',
    '--grep',
    'CANOPY_E2E_NATIVE_VIEWPORT_DIAGNOSTIC',
    'CANOPY_E2E_PREPARED_RESTART_DIAGNOSTIC',
    'native-clear.json',
    'native-shared-workers.json',
  ])
    assert(!diagnosticJob.includes(forbidden));

  const chromeSpec = await readFile(
    new URL('../electron/browser-chrome.spec.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(chromeSpec.split("?.('worker-invocation'").length - 1, 1);
  assert(
    chromeSpec.includes(
      'w1-legacy-review-cowork-worker-${process.pid}-${randomUUID()}-fixture.jsonl',
    ),
  );
});

for (const [label, character, messageLength] of [
  ['Unicode', '\u0800', 240],
  ['JSON escapes', '\u0000', 170],
])
  test(`native observer caps the complete snapshot under saturated ${label}`, async () => {
    const { readFile } = await import('node:fs/promises');
    const { EventEmitter } = await import('node:events');
    const source = await readFile(
      new URL(
        '../electron/fixtures/browser-profile-clear/runtime.cjs',
        import.meta.url,
      ),
      'utf8',
    );
    const declaration = source.slice(
      source.indexOf('function observeWriterPhases('),
      source.indexOf('const delay ='),
    );
    const releases = [];
    const observe = vm.runInNewContext(`(${declaration.trim()})`, {
      Buffer,
      diagnosticReleases: releases,
    });
    const serviceWorkers = new EventEmitter();
    const snapshot = observe({ serviceWorkers }, ['http://127.0.0.1:4000']);
    try {
      for (let i = 0; i < 1000; i++) {
        const message =
          '__PROFILE_CLEAR_OPFS_PHASE__' +
          JSON.stringify({
            phase: 'error',
            sequence: i,
            completedSequence: Math.max(0, i - 1),
            error: {
              name: character.repeat(128),
              message: character.repeat(messageLength),
            },
          });
        assert(
          message.length <= 2048,
          'stress input must pass the actual console-message admission bound',
        );
        serviceWorkers.emit(
          'console-message',
          {},
          {
            versionId: (i % 8) + 1,
            sourceUrl: 'http://127.0.0.1:4000/worker.js',
            message,
          },
        );
      }
      for (let i = 0; i < 1000; i++)
        serviceWorkers.emit(
          'console-message',
          {},
          {
            versionId: 1,
            sourceUrl: 'http://127.0.0.1:4000/worker.js',
            message: '__PROFILE_CLEAR_OPFS_PHASE__invalid-json',
          },
        );
      const value = snapshot();
      const bytes = Buffer.byteLength(JSON.stringify(value));
      assert(bytes <= 64 * 1024, `combined native snapshot is ${bytes} bytes`);
      assert(value.records.length <= 128);
      assert.equal(value.latest.length, 8);
      assert.equal(value.records.at(-1).sequence, 999);
      assert.equal(
        value.latest.find((row) => row.versionId === 8).sequence,
        999,
      );
      assert(value.dropped > 0);
      assert.equal(value.truncated, true);
      assert.equal(value.first.sequence, 0);
      assert.equal(value.first.phase, 'error');
    } finally {
      releases[0]();
    }
  });

async function runImmediateNativeBranch(opfsEntries, sampleError) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL(
      '../electron/fixtures/browser-profile-clear/runtime.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  const block = source.slice(
    source.indexOf('    let immediateFailure;'),
    source.indexOf('    evidence.closedOriginInspection.after ='),
  );
  const calls = { delays: [], samples: 0, clear: 0 };
  const evidence = {
    trustedDocumentInspection: {
      before: {
        title: 'Local storage verification',
        origin: 'http://127.0.0.1:4000',
        localStorageCount: 1,
        databaseCount: 1,
        cacheCount: 1,
        workerCount: 1,
        opfsEntries,
      },
    },
  };
  let primary,
    clock = 0;
  const run = vm.runInNewContext(`(async()=>{${block}})`, {
    evidence,
    first: { origin: 'http://127.0.0.1:4000' },
    control: {},
    writerSnapshot: () => ({}),
    Date: { now: () => clock },
    delay: async (ms) => {
      calls.delays.push(ms);
      clock += ms;
    },
    verifyClosed: async () => {
      calls.samples++;
      if (sampleError) throw sampleError;
      return { opfsEntries };
    },
    a: {
      serviceWorkers: { getAllRunning: () => ({}) },
      clearData: async () => {
        calls.clear++;
      },
    },
    check: (name, actual, expected) => {
      try {
        assert.deepEqual(
          JSON.parse(JSON.stringify(actual)),
          JSON.parse(JSON.stringify(expected)),
          name,
        );
      } catch (error) {
        primary = error;
        throw error;
      }
    },
  });
  try {
    await run();
    return { calls, evidence };
  } catch (error) {
    return { calls, evidence, error, primary };
  }
}

test('passing native immediate assertion proceeds to clear without diagnostic samples or delays', async () => {
  const result = await runImmediateNativeBranch(1);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls, { delays: [], samples: 0, clear: 1 });
});

test('failing native immediate assertion samples at 100/500ms and rethrows the identical primary before clear', async () => {
  const result = await runImmediateNativeBranch(2);
  assert.equal(result.error, result.primary);
  assert.deepEqual(result.calls, { delays: [100, 400], samples: 2, clear: 0 });
  assert.equal(result.evidence.postStopSamples.length, 2);
  assert.equal(result.evidence.trustedDocumentInspection.before.opfsEntries, 2);
  const failedSample = await runImmediateNativeBranch(
    2,
    new Error('diagnostic verifier failure'),
  );
  assert.equal(failedSample.error, failedSample.primary);
  assert.equal(failedSample.calls.clear, 0);
  assert.match(
    failedSample.evidence.postStopSamples[0].error,
    /diagnostic verifier failure/,
  );
});

async function captureProductIdentity(mainFiles, { gitError = false } = {}) {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const source = await readFile(
    integratedDiagnosticSource(
      'apps/desktop-app/tests/electron/browser-profiles.spec.mjs',
      new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    ),
    'utf8',
  );
  const declaration = source.slice(
    source.indexOf('function createOperationDiagnostic('),
    source.indexOf('// Real user configuration, separate'),
  );
  const outputs = new Map();
  const collect = vm.runInNewContext(`(${declaration.trim()})`, {
    createWindowsDiagnosticBasePath: () => '/diagnostic',
    createHash,
    process: { versions: { node: 'fixture' } },
    diagnosticErrorMessage: (error) => error.message,
    execFileSync: (_command, _args, options) => {
      if (gitError) throw new Error('git identity unavailable');
      return options.encoding ? 'fixture-head' : Buffer.from('fixture-diff');
    },
    readFileSync: (file, encoding) => {
      let value;
      if (file.startsWith('out-e2e/main/')) {
        if (!mainFiles.has(file))
          throw Object.assign(new Error(`missing ${file}`), { code: 'ENOENT' });
        value = mainFiles.get(file);
        if (value instanceof Error) throw value;
      } else
        value = file.endsWith('index.html')
          ? '<script src="./assets/entry.js"></script>'
          : 'other-owned-file';
      return encoding === 'utf8' ? String(value) : Buffer.from(value);
    },
    writeFileSync: (file, contents) => outputs.set(file, JSON.parse(contents)),
    console,
  });
  await collect({ evaluate: async () => ({ active: true }) }, {}).arm(
    { profileId: '11111111-1111-4111-8111-111111111111', storageGeneration: 1 },
    false,
  );
  return outputs.get('/diagnostic-identity.json');
}

const mainIdentityFiles = (payload) =>
  new Map([
    [
      'out-e2e/main/index.js',
      'require("./bytecode-loader.cjs"); require("./index.jsc"); require("./_index.js");',
    ],
    ['out-e2e/main/index.jsc', payload],
    ['out-e2e/main/_index.js', 'fallback implementation'],
    ['out-e2e/main/bytecode-loader.cjs', 'bytecode loader'],
  ]);

test('product identity distinguishes equal main entry loaders executing different bytecode payloads', async () => {
  const first = await captureProductIdentity(mainIdentityFiles('payload-one'));
  const second = await captureProductIdentity(mainIdentityFiles('payload-two'));
  assert.deepEqual(
    first.bundles['out-e2e/main/index.js'],
    second.bundles['out-e2e/main/index.js'],
  );
  assert.notDeepEqual(
    first.bundles['out-e2e/main/index.jsc'],
    second.bundles['out-e2e/main/index.jsc'],
  );
  assert.equal(first.mainLayout, 'bytecode');
  for (const file of [
    'index.js',
    'index.jsc',
    '_index.js',
    'bytecode-loader.cjs',
  ])
    assert.equal(first.bundles[`out-e2e/main/${file}`].status, 'present');
});

test('product identity explicitly supports JavaScript layout and retains independent absence and read errors', async () => {
  const javascript = await captureProductIdentity(
    new Map([['out-e2e/main/index.js', 'plain javascript main']]),
  );
  assert.equal(javascript.mainLayout, 'javascript');
  for (const file of ['index.jsc', '_index.js', 'bytecode-loader.cjs'])
    assert.equal(javascript.bundles[`out-e2e/main/${file}`].status, 'absent');
  const files = mainIdentityFiles('payload');
  files.set(
    'out-e2e/main/index.jsc',
    Object.assign(new Error('payload denied'), { code: 'EPERM' }),
  );
  files.delete('out-e2e/main/_index.js');
  const partial = await captureProductIdentity(files, { gitError: true });
  assert.match(partial.captureError.message, /git identity unavailable/);
  assert.equal(partial.bundles['out-e2e/main/index.jsc'].status, 'error');
  assert.equal(partial.bundles['out-e2e/main/index.jsc'].error.code, 'EPERM');
  assert.equal(partial.bundles['out-e2e/main/_index.js'].status, 'absent');
  assert.equal(
    partial.bundles['out-e2e/main/bytecode-loader.cjs'].status,
    'present',
  );
  assert.equal(
    partial.bundles['out-e2e/renderer/assets/entry.js'].status,
    'present',
  );
});

test('setup observation preserves the primary and cleans exactly its launched owner when capture fails', async () => {
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const primary = new Error('selection failed');
  const owner = { electronApp: {}, userDataDir: '/owned' };
  const calls = [];
  await assert.rejects(
    lifecycle.reportOwnedSetupFailure(owner, primary, {
      capture: async (context) => {
        assert.equal(context.error, primary);
        calls.push('capture');
        throw new Error('observer failure');
      },
      close: async (app, dir) => {
        assert.equal(app, owner.electronApp);
        assert.equal(dir, '/owned');
        calls.push('close');
        throw new Error('cleanup failed');
      },
    }),
    (error) => error === primary,
  );
  assert.deepEqual(calls, ['capture', 'close']);
});

test('fixture catalog projection retains only bounded identity and hashes from expected files', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'boundary-seed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'workspaces', 'demo'), { recursive: true });
  writeFileSync(
    join(root, 'workspaces', 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [{ id: 'demo', secret: 'must-not-copy' }],
    }),
  );
  writeFileSync(
    join(root, 'workspaces', 'demo', 'workspace.json'),
    JSON.stringify({ id: 'demo', kind: 'git', secret: 'must-not-copy' }),
  );
  writeFileSync(
    join(root, 'workspaces', 'demo', 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: Array.from({ length: 100 }, (_, i) => ({
        id: `tree-${i}`,
        kind: 'worktree',
        secret: 'must-not-copy',
      })),
    }),
  );
  const value = lifecycle.captureFixtureCatalog(root, ['demo', '../escape']);
  assert.equal(value.files.length, 3);
  assert.equal(value.files[0].sha256.length, 64);
  assert.equal(value.files[2].identities.length, 32);
  assert.equal(value.files[2].truncated, true);
  assert(!JSON.stringify(value).includes('must-not-copy'));
});

test('fixture catalog distinguishes invalid shape, absent, read, parse, oversize, and successful bounded reads', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'boundary-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const id of ['parse', 'null-root', 'invalid-shape', 'read', 'oversize'])
    mkdirSync(join(root, 'workspaces', id), { recursive: true });
  writeFileSync(
    join(root, 'workspaces', 'index.json'),
    JSON.stringify({ version: 1, workspaces: [{ id: 'parse' }] }),
  );
  const malformed = Buffer.from('{"version":1,"workspaces":[');
  writeFileSync(join(root, 'workspaces', 'parse', 'workspace.json'), malformed);
  const nullRoot = Buffer.from('null');
  writeFileSync(
    join(root, 'workspaces', 'null-root', 'workspace.json'),
    nullRoot,
  );
  const invalidShape = Buffer.from('{"workspaces":null}');
  writeFileSync(
    join(root, 'workspaces', 'invalid-shape', 'workspace.json'),
    invalidShape,
  );
  mkdirSync(join(root, 'workspaces', 'read', 'workspace.json'));
  writeFileSync(
    join(root, 'workspaces', 'oversize', 'workspace.json'),
    'x'.repeat(65_537),
  );

  const value = lifecycle.captureFixtureCatalog(root, [
    'parse',
    'null-root',
    'invalid-shape',
    'read',
    'oversize',
    'absent',
  ]);
  const bySuffix = (suffix) =>
    value.files.find((file) => file.path.endsWith(suffix));
  assert.equal(value.files[0].status, 'success');
  const parse = bySuffix('/parse/workspace.json');
  assert.equal(parse.status, 'parse-error');
  assert.equal(parse.sizeBytes, malformed.byteLength);
  assert.match(parse.sha256, /^[a-f0-9]{64}$/);
  for (const [id, body] of [
    ['null-root', nullRoot],
    ['invalid-shape', invalidShape],
  ]) {
    const invalid = bySuffix(`/${id}/workspace.json`);
    assert.equal(invalid.status, 'invalid-shape');
    assert.equal(invalid.sizeBytes, body.byteLength);
    assert.match(invalid.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(bySuffix('/read/workspace.json').status, 'read-error');
  assert.equal(bySuffix('/oversize/workspace.json').status, 'oversize');
  assert.equal(bySuffix('/absent/workspace.json').status, 'absent');
});

test('catalog availability counts retained entries once when both identities exist and budgets exhaust', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'boundary-entry-count-'));
  const fixture = join(root, 'fixture');
  const diagnostics = join(root, 'diagnostics');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'workspaces'), { recursive: true });
  const workspaceIds = ['one', 'two'];
  writeFileSync(
    join(fixture, 'workspaces', 'index.json'),
    JSON.stringify({ workspaces: workspaceIds.map((id) => ({ id })) }),
  );
  for (const workspaceId of workspaceIds) {
    mkdirSync(join(fixture, 'workspaces', workspaceId), { recursive: true });
    writeFileSync(
      join(fixture, 'workspaces', workspaceId, 'workspace.json'),
      JSON.stringify({ id: workspaceId }),
    );
    writeFileSync(
      join(fixture, 'workspaces', workspaceId, 'worktrees.json'),
      JSON.stringify({
        worktrees: Array.from({ length: 40 }, (_, index) => ({
          workspaceId: `${workspaceId}-workspace-${index}`,
          worktreeId: `${workspaceId}-worktree-${index}`,
        })),
      }),
    );
  }
  const boundary = lifecycle.createSelectedLaunchBoundary('case', 'entries', {
    directory: diagnostics,
    close: async () => {},
    firstProjectsLoad: true,
  });
  boundary.options.onBeforeLaunch({ userDataDir: fixture, workspaceIds });
  const rows = readFileSync(`${boundary.base}-fixture.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter(
      (row) =>
        row.stage === 'projects-load-catalog-file' &&
        row.role === 'workspace-worktrees',
    );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [
      row.identityTotalCount,
      row.identityAvailableCount,
      row.identityOmittedCount,
    ]),
    [
      [40, 32, 8],
      [40, 0, 40],
    ],
  );
  assert(
    rows.every(
      (row) =>
        row.identityAvailableCount + row.identityOmittedCount ===
        row.identityTotalCount,
    ),
  );
});

test('first-projects-load catalogs enforce complete independent phase budgets with honest totals', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'first-load-phase-budget-'));
  const fixture = join(root, 'fixture');
  const diagnostics = join(root, 'diagnostics');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceIds = Array.from(
    { length: 8 },
    (_, index) => `${'w'.repeat(126)}${String(index).padStart(2, '0')}`,
  );
  mkdirSync(join(fixture, 'workspaces'), { recursive: true });
  writeFileSync(
    join(fixture, 'workspaces', 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: workspaceIds.map((id) => ({ id })),
    }),
  );
  for (const [workspaceIndex, workspaceId] of workspaceIds.entries()) {
    mkdirSync(join(fixture, 'workspaces', workspaceId), { recursive: true });
    writeFileSync(
      join(fixture, 'workspaces', workspaceId, 'workspace.json'),
      JSON.stringify({ version: 1, id: workspaceId }),
    );
    writeFileSync(
      join(fixture, 'workspaces', workspaceId, 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: Array.from({ length: 32 }, (_, index) => ({
          id: `${'t'.repeat(123)}${workspaceIndex}${String(index).padStart(3, '0')}`,
        })),
      }),
    );
  }
  const boundary = lifecycle.createSelectedLaunchBoundary(
    'c'.repeat(100),
    'l'.repeat(10),
    {
      directory: diagnostics,
      close: async () => {},
      owners: workspaceIds.slice(0, 2).map((projectId, index) => ({
        projectId,
        worktreeId: `owner-${index}`,
      })),
      firstProjectsLoad: true,
    },
  );
  boundary.options.onBeforeLaunch({ userDataDir: fixture, workspaceIds });
  const primary = new Error('selected setup failure');
  await assert.rejects(
    boundary.options.onSetupFailure({
      electronApp: {},
      userDataDir: fixture,
      error: primary,
    }),
    (error) => error === primary,
  );
  const lines = readFileSync(`${boundary.base}-fixture.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ line: `${line}\n`, row: JSON.parse(line) }));
  for (const phase of ['prelaunch', 'failure']) {
    const phaseLines = lines.filter(({ row }) => row.phase === phase);
    const fileRows = phaseLines.filter(
      ({ row }) => row.stage === 'projects-load-catalog-file',
    );
    const summary = phaseLines.find(
      ({ row }) => row.stage === 'projects-load-catalog-summary',
    )?.row;
    assert(summary);
    assert(phaseLines.length <= 20);
    assert(
      phaseLines.reduce(
        (bytes, { line }) => bytes + Buffer.byteLength(line),
        0,
      ) <= 16_384,
    );
    assert.equal(summary.totalFileCount, 17);
    assert.equal(
      summary.recordedFileCount + summary.omittedFileCount,
      summary.totalFileCount,
    );
    assert.equal(
      summary.availableFileCount + summary.unavailableFileCount,
      summary.totalFileCount,
    );
    assert.equal(summary.truncated, summary.omittedFileCount > 0);
    assert(fileRows.every(({ row }) => row.status === 'success'));
    assert(
      fileRows.every(
        ({ row }) =>
          row.identityAvailableCount + row.identityOmittedCount ===
          row.identityTotalCount,
      ),
    );
  }
});

test('selected first-projects-load boundary records sanitized catalogs before launch and before exact-owner cleanup', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'first-projects-load-boundary-'));
  const fixture = join(root, 'fixture');
  const diagnostics = join(root, 'diagnostics');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'workspaces', 'demo'), { recursive: true });
  writeFileSync(
    join(fixture, 'workspaces', 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [{ id: 'demo', name: 'private' }],
    }),
  );
  writeFileSync(
    join(fixture, 'workspaces', 'demo', 'workspace.json'),
    JSON.stringify({ version: 1, id: 'demo', branchName: 'private-branch' }),
  );
  writeFileSync(
    join(fixture, 'workspaces', 'demo', 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [{ id: 'demo-main', branchName: 'private-branch' }],
    }),
  );
  const closes = [];
  const boundary = lifecycle.createSelectedLaunchBoundary('case', 'initial', {
    directory: diagnostics,
    close: async (...args) => closes.push(args),
    owners: [{ projectId: 'demo', worktreeId: 'demo-main' }],
    firstProjectsLoad: true,
  });
  boundary.options.onBeforeLaunch({
    userDataDir: fixture,
    workspaceIds: ['demo'],
  });
  const primary = new Error('selection failed');
  const electronApp = {};
  await assert.rejects(
    boundary.options.onSetupFailure({
      electronApp,
      userDataDir: fixture,
      error: primary,
    }),
    (error) => error === primary,
  );
  const config = JSON.parse(
    boundary.options.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
  );
  assert.equal(config.mode, 'close');
  assert.equal(config.firstProjectsLoad, true);
  assert.equal(config.firstProjectsLoadFile, boundary.firstProjectsLoadFile);
  assert.notEqual(config.firstProjectsLoadFile, config.file);
  assert.equal(closes.length, 1);
  assert.equal(closes[0][0], electronApp);
  assert.equal(closes[0][1], fixture);
  const body = readFileSync(`${boundary.base}-fixture.jsonl`, 'utf8');
  const rows = body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const phase of ['prelaunch', 'failure']) {
    assert.equal(
      rows.filter(
        (row) =>
          row.stage === 'projects-load-catalog-file' && row.phase === phase,
      ).length,
      3,
    );
    assert(
      rows.some(
        (row) =>
          row.stage === 'projects-load-catalog-summary' && row.phase === phase,
      ),
    );
  }
  const catalogRows = rows.filter((row) =>
    row.stage.startsWith('projects-load-catalog'),
  );
  assert(catalogRows.every((row) => !('path' in row)));
  assert(!JSON.stringify(catalogRows).includes(fixture));
  assert(!JSON.stringify(catalogRows).includes('private-branch'));
  assert(!JSON.stringify(catalogRows).includes('private'));
});

async function runRegisteredPendingDialogInitialSetup(
  sourceRoot,
  { diagnosticDirectory, exerciseEvidence = false } = {},
) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const ts = require('typescript');
  const specPath = nodePath.join(
    sourceRoot,
    'apps/desktop-app/tests/electron/browser-profiles.spec.mjs',
  );
  const lifecyclePath = nodePath.join(
    sourceRoot,
    'apps/desktop-app/tests/electron/browser-profile-test-lifecycle.mjs',
  );
  const source = fs.readFileSync(specPath, 'utf8');
  const parsed = ts.createSourceFile(
    'browser-profiles.spec.mjs',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const pendingName = source.includes(
    'async function runGraduatedPendingSourceDialogCase(',
  )
    ? 'runGraduatedPendingSourceDialogCase'
    : 'runPendingSourceDialogCase';
  let pendingFunction;
  let registeredCallback;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === pendingName)
      pendingFunction = node;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'test' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text ===
        'returns pending source dialogs to agents, honors veto, and rechecks enable on acceptance'
    )
      registeredCallback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert(pendingFunction && registeredCallback);
  const statements = pendingFunction.body.statements;
  const variableNames = new Set([
    'selectionOwner',
    'launchBoundary',
    'seeded',
    'electronApp',
    'userDataDir',
    'window',
  ]);
  const declarations = statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          variableNames.has(declaration.name.text),
      ),
  );
  const tryStatement = statements.find(ts.isTryStatement);
  assert(tryStatement);
  const setupStatements = tryStatement.tryBlock.statements.slice(
    0,
    exerciseEvidence ? 3 : 2,
  );
  const fixtureSource = `async function ${pendingName}({ controlledLaterHide = false } = {}) {
    ${[...declarations, ...setupStatements]
      .map((statement) => statement.getText(parsed))
      .join('\n')}
    globalThis.__selectedBoundary = launchBoundary;
  }
  globalThis.${pendingName} = ${pendingName};
  globalThis.__registeredCallback = ${registeredCallback.getText(parsed)};`;
  const compiled = ts.transpileModule(fixtureSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'registered-pending-first-load-'),
  );
  const fixture = nodePath.join(root, 'fixture');
  const diagnostics = nodePath.join(root, 'diagnostics');
  fs.mkdirSync(nodePath.join(fixture, 'workspaces', 'demo-ts-pnpm-vite'), {
    recursive: true,
  });
  fs.writeFileSync(
    nodePath.join(fixture, 'workspaces', 'index.json'),
    JSON.stringify({ version: 1, workspaces: [{ id: 'demo-ts-pnpm-vite' }] }),
  );
  for (const [name, value] of [
    ['workspace.json', { version: 1, id: 'demo-ts-pnpm-vite' }],
    ['worktrees.json', { version: 1, worktrees: [{ id: 'demo-main' }] }],
  ])
    fs.writeFileSync(
      nodePath.join(fixture, 'workspaces', 'demo-ts-pnpm-vite', name),
      JSON.stringify(value),
    );
  const lifecycle = await import(
    `${pathToFileURL(lifecyclePath).href}?registered=${Date.now()}`
  );
  let selectedBoundary;
  const context = {
    randomUUID: () => 'injection',
    closeCanopy: async () => {},
    createSelectedLaunchBoundary: (...args) => {
      selectedBoundary = lifecycle.createSelectedLaunchBoundary(
        args[0],
        args[1],
        {
          ...args[2],
          directory: diagnosticDirectory ?? diagnostics,
        },
      );
      return selectedBoundary;
    },
    retainSelectionFailureOwner: lifecycle.retainSelectionFailureOwner,
    seedPanelWorktree: async (options) => {
      options.onBeforeLaunch?.({
        userDataDir: fixture,
        workspaceIds: ['demo-ts-pnpm-vite'],
      });
      return {
        electronApp: {},
        userDataDir: fixture,
        window: {},
      };
    },
    test: { setTimeout() {} },
    expect: {
      poll: () => ({
        toEqual: () => {
          throw new Error('diagnostic poll must not run without output');
        },
      }),
      arrayContaining: (value) => value,
    },
    readFileSync: fs.readFileSync,
  };
  try {
    vm.runInNewContext(compiled, context);
    await context.__registeredCallback();
    return selectedBoundary;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('actual registered pending-dialog callback opts only its ordinary selected launch into first-load evidence', async () => {
  const boundary = await runRegisteredPendingDialogInitialSetup(process.cwd());
  const config = JSON.parse(
    boundary.options.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
  );
  assert.equal(config.mode, 'close');
  assert.equal(config.firstProjectsLoad, true);
  assert.equal(config.firstProjectsLoadFile, boundary.firstProjectsLoadFile);
});

test('actual registered pending-dialog callback preserves its ordinary flow when diagnostic output is unavailable', async () => {
  const boundary = await runRegisteredPendingDialogInitialSetup(process.cwd(), {
    diagnosticDirectory: '',
    exerciseEvidence: true,
  });
  assert.equal(boundary.firstProjectsLoadFile, undefined);
  assert.equal(boundary.options.env, undefined);
});

test(
  'source0 actual registered pending-dialog callback reaches selected launch then lacks first-load opt-in',
  { skip: !process.env.CANOPY_FIRST_PROJECTS_LOAD_SOURCE0_DIR },
  async () => {
    const boundary = await runRegisteredPendingDialogInitialSetup(
      process.env.CANOPY_FIRST_PROJECTS_LOAD_SOURCE0_DIR,
    );
    const config = JSON.parse(
      boundary.options.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
    );
    assert.equal(config.mode, 'close');
    assert.equal(
      config.firstProjectsLoad,
      true,
      'source0 selected callback is missing first-load opt-in',
    );
  },
);

test('append-only boundary recorder is bounded and observation cannot change operation identity', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'boundary-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'events.jsonl');
  const record = lifecycle.createBoundaryRecorder(file);
  for (let i = 0; i < 1000; i++)
    record('sample', { i, text: 'x'.repeat(1000) });
  const bytes = readFileSync(file);
  assert(bytes.length <= 128 * 1024);
  assert(bytes.toString().trim().split('\n').length <= 256);
  const promise = Promise.resolve(42);
  assert.equal(
    lifecycle.observeBoundary(
      'close',
      () => promise,
      () => {
        throw new Error('observer');
      },
    ),
    promise,
  );
  await promise;
  const primary = new Error('close');
  assert.throws(
    () =>
      lifecycle.observeBoundary(
        'close',
        () => {
          throw primary;
        },
        record,
      ),
    (error) => error === primary,
  );
  assert.equal(lifecycle.createBoundaryRecorder(undefined), undefined);
});

test('boundary recorder contains getters and unsupported serialization before becoming inert', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'boundary-recorder-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const cases = [
    () => ({
      get value() {
        throw new Error('getter failed');
      },
    }),
    () => {
      const details = {};
      details.value = details;
      return details;
    },
    () => ({ value: 1n }),
  ];
  for (const [index, makeDetails] of cases.entries()) {
    const record = lifecycle.createBoundaryRecorder(
      join(root, `failure-${index}.jsonl`),
    );
    assert.doesNotThrow(() => record('serialization-failure', makeDetails()));
    assert.equal(record.prepare('retired', { value: 'unused' }), undefined);
    assert.doesNotThrow(() => record.appendPrepared(undefined));
  }

  const originalBigint = process.hrtime.bigint;
  let clockCalls = 0;
  process.hrtime.bigint = () => BigInt(++clockCalls);
  try {
    const record = lifecycle.createBoundaryRecorder(root);
    record('write-failure');
    const callsAtStop = clockCalls;
    let getterCalls = 0;
    record('retired', {
      get value() {
        getterCalls++;
        return 'unused';
      },
    });
    assert.equal(clockCalls, callsAtStop);
    assert.equal(getterCalls, 0);
  } finally {
    process.hrtime.bigint = originalBigint;
  }
});

test('selected close owner reaches cleanup once when recorder cannot serialize its entry', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'boundary-close-recorder-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = new Error('cleanup failed');
  const calls = [];
  const boundary = lifecycle.createSelectedLaunchBoundary('case', 'close', {
    directory: join(root, 'diagnostics'),
    close: async (electronApp, userDataDir) => {
      calls.push([electronApp, userDataDir]);
      throw primary;
    },
  });
  const electronApp = {};
  const userDataDir = 1n;
  await assert.rejects(
    boundary.close({ electronApp, userDataDir }),
    (error) => error === primary,
  );
  assert.deepEqual(calls, [[electronApp, userDataDir]]);
});

test('shared-worker readiness timeout retains owned startup phases, counters and errors before shutdown', async () => {
  const { readFile } = await import('node:fs/promises');
  const { EventEmitter } = await import('node:events');
  const source = await readFile(
    new URL(
      '../electron/fixtures/browser-profile-clear/shared-workers.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  let evidence,
    finish,
    next = 0;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  class Contents extends EventEmitter {
    constructor() {
      super();
      this.id = ++next;
      this.debugger = {
        attach() {},
        sendCommand: async () => ({
          targetInfo: { browserContextId: `ctx-${this.id}` },
        }),
      };
    }
    async loadURL() {}
    async executeJavaScript() {
      const message = `__PROFILE_SHARED_WORKER_ERROR__owner-${this.id}${'x'.repeat(600)}`;
      // Electron 42 emits rich event details first, then legacy level/message.
      this.emit(
        'console-message',
        { message },
        3,
        message,
        1,
        'http://127.0.0.1:4000/',
      );
      this.emit(
        'console-message',
        { message: 'unrelated console message' },
        3,
        '__PROFILE_SHARED_WORKER_ERROR__legacy argument must not be used',
      );
    }
    isDestroyed() {
      return false;
    }
    close() {}
  }
  const app = new EventEmitter();
  Object.assign(app, {
    setPath() {},
    whenReady: async () => {},
    exit: () => finish(),
  });
  const server = {
    listen: (_port, _host, callback) => callback(),
    address: () => ({ port: 4000 }),
    closeAllConnections() {},
    close: (callback) => callback(),
  };
  const nodePath = await import('node:path');
  vm.runInNewContext(source, {
    require: (name) =>
      ({
        electron: {
          app,
          BrowserWindow: class {
            constructor() {
              this.contentView = { addChildView() {} };
            }
            isDestroyed() {
              return false;
            }
            destroy() {}
          },
          WebContentsView: class {
            constructor() {
              this.webContents = new Contents();
            }
          },
          session: { fromPartition: () => ({}) },
        },
        'node:http': { createServer: () => server },
        'node:fs/promises': {
          writeFile: async (_file, value) => {
            evidence = JSON.parse(value);
          },
        },
        'node:path': nodePath,
        'node:assert/strict': assert,
      })[name],
    process: {
      argv: ['/tmp/browser-profile-clear-owned', '/output'],
      versions: {},
      platform: 'win32',
      hrtime: process.hrtime,
    },
    URL,
    Buffer,
    setTimeout: (callback) => queueMicrotask(callback),
    console,
  });
  await done;
  assert.match(evidence.error, /Shared worker probe timed out/);
  assert.deepEqual(evidence.readiness.requests, { a: 0, b: 0 });
  assert.equal(evidence.readiness.iterations, 250);
  assert(
    evidence.readiness.phases.some(
      (row) => row.stage === 'writer-readiness-entered',
    ),
  );
  assert(
    !evidence.readiness.phases.some(
      (row) => row.stage === 'writer-readiness-fulfilled',
    ),
  );
  assert.equal(evidence.readiness.errors.length, 2);
  assert.deepEqual(
    evidence.readiness.errors.map((row) => row.owner),
    ['a', 'b'],
  );
  for (const [index, row] of evidence.readiness.errors.entries()) {
    assert.equal(row.message.length, 512);
    assert(
      row.message.startsWith(
        `__PROFILE_SHARED_WORKER_ERROR__owner-${index + 3}`,
      ),
    );
  }
  assert(
    !evidence.readiness.phases.some((row) => row.stage === 'shutdown-entered'),
  );
  assert(
    evidence.readiness.phases.every((row) => typeof row.elapsedMs === 'number'),
  );
});

async function runStartupBoundary({
  enabled = true,
  mode = 'close',
  writeFails = false,
  writeFailsAfter,
  config = {},
  destroyed = false,
  e2e = true,
  rawOverride,
  environment,
  clockBigint,
  captureBoundary,
  sourceFile,
  stopSendFails = false,
} = {}) {
  const { readFileSync } = await import('node:fs');
  const { EventEmitter } = await import('node:events');
  const source = readFileSync(
    sourceFile ?? new URL('../../src/main/index.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf(
    '  if (__CANOPY_E2E__) {\n    // Selected Windows acceptance fixtures only.',
  );
  const block = source.slice(
    start,
    source.indexOf('  const activeDesktopCanopyRuntime', start),
  );
  const js = require('typescript').transpileModule(block, {
    compilerOptions: { target: require('typescript').ScriptTarget.ES2022 },
  }).outputText;
  const app = new EventEmitter();
  app.getPath = () => '/owned';
  const ipcMain = new EventEmitter();
  const mainFrame = { routingId: 7, processId: 8 };
  const rendererSends = [];
  const mainWebContents = {
    id: 2,
    mainFrame,
    send: (...args) => {
      if (stopSendFails) throw new Error('renderer unavailable');
      rendererSends.push(args);
    },
  };
  const mainWindow = {
    id: 1,
    isDestroyed: () => destroyed,
    webContents: mainWebContents,
  };
  const output = [];
  const firstProjectsLoadOutput = [];
  const firstProjectsLoadLines = [];
  const rawLines = [];
  const timerCallbacks = [];
  let expire,
    active = true,
    timerCalls = 0,
    writeCalls = 0;
  const context = {
    __CANOPY_E2E__: e2e,
    isRecord: (value) => typeof value === 'object' && value !== null,
    app,
    ipcMain,
    Buffer,
    BrowserWindow: {
      getAllWindows: () => [
        {
          id: 1,
          isDestroyed: () => destroyed,
          get webContents() {
            if (destroyed) throw new Error('destroyed');
            return mainWebContents;
          },
        },
      ],
    },
    getBrowserService: () => ({}),
    getBrowserProfileService: () => ({}),
    getMainWindow: () => mainWindow,
    // The counting wrapper main uses for direct renderer sends.
    sendToWebContents: (target, channel, ...args) =>
      target.send(channel, ...args),
    observeLoadedTaskReset: (_browser, _profiles, owners) =>
      output.push({ stage: 'loaded-owners', owners }),
    captureBrowserBoundary:
      captureBoundary ?? ((_service, _windows, owner) => ({ owner })),
    webContents: {
      getAllWebContents: () => [{ id: 2, getType: () => 'window' }],
    },
    process: {
      env:
        environment ??
        (enabled
          ? {
              CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS:
                rawOverride ??
                JSON.stringify({
                  file: '/owned.jsonl',
                  mode,
                  ...config,
                }),
              CANOPY_DATA_DIR: '/owned',
            }
          : {}),
      pid: 9,
      hrtime: Object.assign(() => undefined, {
        bigint: clockBigint ?? process.hrtime.bigint,
      }),
      getBuiltinModule: (name) =>
        name === 'path'
          ? { isAbsolute: () => true }
          : {
              appendFileSync: (file, line) => {
                if (
                  writeFails ||
                  (writeFailsAfter !== undefined &&
                    writeCalls >= writeFailsAfter)
                )
                  throw new Error('denied');
                writeCalls++;
                rawLines.push(line);
                const parsed = JSON.parse(line);
                if (file === '/first-projects-load.jsonl') {
                  firstProjectsLoadLines.push(line);
                  firstProjectsLoadOutput.push(parsed);
                } else output.push(parsed);
              },
            },
    },
    setTimeout: (callback) => {
      timerCalls++;
      timerCallbacks.push(callback);
      expire = callback;
      return { unref() {} };
    },
    clearTimeout: () => {
      active = false;
    },
  };
  vm.runInNewContext(js, context);
  return {
    app,
    ipcMain,
    mainFrame,
    mainWebContents,
    output,
    firstProjectsLoadOutput,
    firstProjectsLoadLines,
    rendererSends,
    rawLines,
    context,
    expire: () => expire?.(),
    expireAt: (index) => timerCallbacks[index]?.(),
    timerActive: () => active,
    timerCalls: () => timerCalls,
  };
}

test(
  'source0 actual startup block reaches existing close setup then lacks first-projects-load observation',
  { skip: !process.env.CANOPY_FIRST_PROJECTS_LOAD_SOURCE0_DIR },
  async () => {
    const sourceRoot = process.env.CANOPY_FIRST_PROJECTS_LOAD_SOURCE0_DIR;
    const value = await runStartupBoundary({
      sourceFile: require('node:path').join(
        sourceRoot,
        'apps/desktop-app/src/main/index.ts',
      ),
      config: {
        launchId: 'source0-case',
        caseId: 'source0',
        fixturePid: 20,
        firstProjectsLoad: true,
        firstProjectsLoadFile: '/first-projects-load.jsonl',
      },
    });
    assert.equal(value.output[0].stage, 'app-identity');
    assert.equal(
      typeof value.context.__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__,
      'function',
    );
    assert.equal(
      typeof value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__,
      'function',
      'source0 is missing the admitted first-load observer',
    );
  },
);

test('startup generic recorder does no clock or serialization work after a stopped write', async () => {
  let clockCalls = 0;
  let serializationCalls = 0;
  const value = await runStartupBoundary({
    writeFailsAfter: 1,
    clockBigint: () => BigInt(++clockCalls),
    captureBoundary: () => ({
      toJSON: () => {
        serializationCalls++;
        throw new Error('stopped recorder must not serialize');
      },
    }),
  });

  assert.doesNotThrow(() =>
    value.context.__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__('close-entry'),
  );
  assert.equal(clockCalls, 2);
  assert.equal(serializationCalls, 0);
});

test('startup generic recorder contains throwing serialization and stays stopped', async () => {
  let clockCalls = 0;
  let serializationCalls = 0;
  const value = await runStartupBoundary({
    config: {
      owners: [{ projectId: 'project-one', worktreeId: 'worktree-one' }],
    },
    clockBigint: () => BigInt(++clockCalls),
    captureBoundary: () => ({
      toJSON: () => {
        serializationCalls++;
        throw new Error('serialization failure');
      },
    }),
  });

  assert.doesNotThrow(() =>
    value.context.__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__('close-entry'),
  );
  assert.equal(serializationCalls, 1);
  assert.equal(clockCalls, 3);
  value.app.emit('before-quit');
  assert.equal(serializationCalls, 1);
  assert.equal(clockCalls, 3);
});

test('startup close observer is absent by default and all opted-in listeners release on quit or expiry', async () => {
  const normal = await runStartupBoundary({ enabled: false });
  assert.deepEqual(normal.app.eventNames(), []);
  assert.equal(normal.output.length, 0);
  for (const expire of [false, true]) {
    const value = await runStartupBoundary();
    value.context.__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__('close-entry');
    assert.equal(
      value.output.find((row) => row.stage === 'pre-close-inventory')
        .webContentsCount,
      1,
    );
    value.app.emit('before-quit');
    value.app.emit('will-quit');
    if (expire) value.expire();
    else value.app.emit('quit');
    assert.deepEqual(value.app.eventNames(), []);
    assert.equal(value.timerActive(), false);
    assert.equal(
      value.context.__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__,
      undefined,
    );
    assert.equal(
      value.output.some((row) => row.stage === 'main.quit'),
      !expire,
    );
  }
  const denied = await runStartupBoundary({ writeFails: true });
  denied.context.__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__('close-entry');
  denied.app.emit('quit');
  assert.deepEqual(denied.app.eventNames(), []);
});

test('startup first-projects-load observer records actual main and renderer boundaries with stamped sender identity', async () => {
  const value = await runStartupBoundary({
    config: {
      launchId: 'case-initial',
      caseId: 'case',
      fixturePid: 17,
      firstProjectsLoad: true,
      firstProjectsLoadFile: '/first-projects-load.jsonl',
    },
  });
  const event = {
    sender: value.mainWebContents,
    senderFrame: value.mainFrame,
  };
  value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__(
    event,
    'projects-load-main-entered',
    { requestOrdinal: 1, reconciliationAlreadyAttempted: false },
  );
  value.ipcMain.emit(
    'canopy:e2e:first-projects-load',
    event,
    'projects-load-renderer-entered',
    {
      documentId: 'document-1',
      rendererSequence: 1,
      generation: 1,
      workspaceIds: ['workspace-1'],
      worktreeIds: ['worktree-1'],
    },
  );

  assert.deepEqual(
    value.firstProjectsLoadOutput.map(({ stage }) => stage),
    ['projects-load-main-entered', 'projects-load-renderer-entered'],
  );
  for (const row of value.firstProjectsLoadOutput) {
    assert.equal(row.senderWebContentsId, 2);
    assert.equal(row.senderFrameRoutingId, 7);
    assert.equal(row.senderFrameProcessId, 8);
    assert.equal(row.launchId, 'case-initial');
  }
  assert.equal(value.timerCalls(), 2);
  value.app.emit('quit');
  assert.equal(
    value.firstProjectsLoadOutput.at(-1).stage,
    'projects-load-observer-summary',
  );
  assert.equal(value.firstProjectsLoadOutput.at(-1).reason, 'teardown');
  assert.equal(
    value.ipcMain.listenerCount('canopy:e2e:first-projects-load'),
    0,
  );
  assert.deepEqual(value.rendererSends, [
    ['canopy:e2e:first-projects-load-stop'],
  ]);
  assert.equal(
    value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__,
    undefined,
  );
});

test('startup first-projects-load observer rejects invalid senders and enforces exact hard caps', async () => {
  const value = await runStartupBoundary({
    config: {
      launchId: 'case-caps',
      caseId: 'case',
      fixturePid: 18,
      firstProjectsLoad: true,
      firstProjectsLoadFile: '/first-projects-load.jsonl',
    },
  });
  value.ipcMain.emit(
    'canopy:e2e:first-projects-load',
    { sender: { id: 99 }, senderFrame: value.mainFrame },
    'projects-load-renderer-entered',
    { generation: 1 },
  );
  assert.equal(value.firstProjectsLoadOutput.length, 0);
  const event = {
    sender: value.mainWebContents,
    senderFrame: value.mainFrame,
  };
  value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__?.(
    event,
    'projects-load-main-entered',
    {
      requestOrdinal: 1,
      workspaceIds: Array.from({ length: 20 }, (_, id) => `workspace-${id}`),
      worktreeIds: Array.from({ length: 80 }, (_, id) => `worktree-${id}`),
    },
  );
  assert.equal(value.firstProjectsLoadOutput[0].workspaceIds.length, 8);
  assert.equal(value.firstProjectsLoadOutput[0].worktreeIds.length, 32);
  for (let index = 1; index < 97; index++)
    value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__?.(
      event,
      'projects-load-main-entered',
      { requestOrdinal: index + 1 },
    );
  assert.equal(
    value.firstProjectsLoadOutput.filter(
      ({ stage }) => stage === 'projects-load-main-entered',
    ).length,
    96,
  );
  assert.equal(value.firstProjectsLoadOutput.at(-1).reason, 'stream-overflow');
  assert(
    value.firstProjectsLoadLines.every(
      (line) => Buffer.byteLength(line) <= 8192,
    ),
  );
  assert(
    value.firstProjectsLoadLines.reduce(
      (bytes, line) => bytes + Buffer.byteLength(line),
      0,
    ) <= 65536,
  );
  assert.equal(
    value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__,
    undefined,
  );
  assert.equal(
    value.ipcMain.listenerCount('canopy:e2e:first-projects-load'),
    0,
  );
  assert.deepEqual(value.rendererSends, [
    ['canopy:e2e:first-projects-load-stop'],
  ]);
});

test('startup first-projects-load receiver bounds inspected hostile ids independently from accepted output', async () => {
  const value = await runStartupBoundary({
    config: {
      launchId: 'case-receiver-bounds',
      caseId: 'case',
      fixturePid: 18,
      firstProjectsLoad: true,
      firstProjectsLoadFile: '/first-projects-load.jsonl',
    },
  });
  const event = {
    sender: value.mainWebContents,
    senderFrame: value.mainFrame,
  };
  let inspected = 0;
  const invalidIds = new Proxy(
    Array.from({ length: 1_000 }, (_, index) =>
      index === 0 ? `${'x'.repeat(256)}!` : `invalid!${index}`,
    ),
    {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) inspected++;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.doesNotThrow(() =>
    value.ipcMain.emit(
      'canopy:e2e:first-projects-load',
      event,
      'projects-load-renderer-ipc-resolved',
      { generation: 1, workspaceIds: invalidIds },
    ),
  );
  assert(inspected <= 16);
  assert.deepEqual(value.firstProjectsLoadOutput[0].workspaceIds, []);
  assert.equal(
    value.firstProjectsLoadOutput[0].receiverWorkspaceInspectedCount,
    16,
  );
  assert.equal(
    value.firstProjectsLoadOutput[0].receiverWorkspaceOmittedCount,
    984,
  );
  assert.equal(value.firstProjectsLoadOutput[0].truncated, true);

  const hostile = Object.defineProperty({}, 'workspaceIds', {
    get() {
      throw new Error('hostile getter');
    },
  });
  assert.doesNotThrow(() =>
    value.ipcMain.emit(
      'canopy:e2e:first-projects-load',
      event,
      'projects-load-renderer-ipc-resolved',
      hostile,
    ),
  );
});

test('actual main first-load projection bounds inspected entries before accepted ids', async () => {
  const { readFileSync } = await import('node:fs');
  const ts = require('typescript');
  const source = readFileSync(
    new URL('../../src/main/ipc/projects.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'projects.ts',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let projection;
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'projectFirstProjectsLoadItems'
    )
      projection = node.getText(parsed);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(typeof projection, 'string');
  const context = { Buffer };
  vm.runInNewContext(
    ts.transpileModule(
      `${projection}; globalThis.projectFirstProjectsLoadItems = projectFirstProjectsLoadItems;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  let inspected = 0;
  const items = new Proxy(
    Array.from({ length: 1_000 }, (_, index) => ({
      id: index === 0 ? `${'a'.repeat(256)}!` : `invalid!${index}`,
      type: 'single-repo',
      worktrees: [],
    })),
    {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) inspected++;
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const details = context.projectFirstProjectsLoadItems(items, []);
  assert(inspected <= 16);
  assert.deepEqual(Array.from(details.workspaceIds), []);
  assert.equal(details.workspaceInspectedCount, 16);
  assert.equal(details.workspaceOmittedCount, 984);
  assert.equal(details.truncated, true);
});

test('actual first-load producers retain their counters through the real startup sink', async () => {
  const { readFileSync } = await import('node:fs');
  const ts = require('typescript');
  const loadFunctions = (url, names) => {
    const source = readFileSync(url, 'utf8');
    const parsed = ts.createSourceFile(
      'producer.ts',
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const declarations = new Map();
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
        declarations.set(node.name.text, node.getText(parsed));
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.deepEqual(Array.from(declarations.keys()).sort(), [...names].sort());
    const context = { Buffer };
    const exports = names
      .map((name) => `globalThis.${name} = ${name};`)
      .join('\n');
    vm.runInNewContext(
      ts.transpileModule(
        `${names.map((name) => declarations.get(name)).join('\n')}\n${exports}`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText,
      context,
    );
    return context;
  };
  const mainProducer = loadFunctions(
    new URL('../../src/main/ipc/projects.ts', import.meta.url),
    ['projectFirstProjectsLoadItems'],
  );
  const rendererProducer = loadFunctions(
    new URL('../../src/renderer/src/stores/projectsStore.ts', import.meta.url),
    ['projectFirstProjectsLoadLists', 'projectFirstProjectsLoadWarnings'],
  );
  const emitMain = async (caseId, details) => {
    const value = await runStartupBoundary({
      config: {
        launchId: caseId,
        caseId,
        fixturePid: 22,
        firstProjectsLoad: true,
        firstProjectsLoadFile: '/first-projects-load.jsonl',
      },
    });
    const event = {
      sender: value.mainWebContents,
      senderFrame: value.mainFrame,
    };
    value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__(
      event,
      'projects-load-main-resolved',
      { requestOrdinal: 1, ...details },
    );
    assert.equal(value.firstProjectsLoadLines.length, 1);
    return JSON.parse(value.firstProjectsLoadLines[0]);
  };
  const emitRenderer = async (caseId, stage, details) => {
    const value = await runStartupBoundary({
      config: {
        launchId: caseId,
        caseId,
        fixturePid: 23,
        firstProjectsLoad: true,
        firstProjectsLoadFile: '/first-projects-load.jsonl',
      },
    });
    value.ipcMain.emit(
      'canopy:e2e:first-projects-load',
      { sender: value.mainWebContents, senderFrame: value.mainFrame },
      stage,
      details,
    );
    assert.equal(value.firstProjectsLoadLines.length, 1);
    return JSON.parse(value.firstProjectsLoadLines[0]);
  };

  const valid = Array.from({ length: 100 }, (_, index) => ({
    id: `workspace-${index}`,
    type: 'single-repo',
    worktrees: [],
  }));
  const validDetails = mainProducer.projectFirstProjectsLoadItems(valid, []);
  const validRow = await emitMain('producer-valid', validDetails);
  assert.deepEqual(
    [validRow.workspaceInspectedCount, validRow.workspaceOmittedCount],
    [8, 92],
  );
  assert.deepEqual(
    [
      validRow.receiverWorkspaceInspectedCount,
      validRow.receiverWorkspaceOmittedCount,
    ],
    [8, 0],
  );

  const worktreeHeavy = Array.from({ length: 8 }, (_, workspaceIndex) => ({
    id: `workspace-${workspaceIndex}`,
    type: 'single-repo',
    worktrees: Array.from({ length: 5 }, (_, worktreeIndex) => ({
      id: `worktree-${workspaceIndex}-${worktreeIndex}`,
    })),
  }));
  const worktreeDetails = mainProducer.projectFirstProjectsLoadItems(
    worktreeHeavy,
    [],
  );
  const worktreeRow = await emitMain('producer-worktrees', worktreeDetails);
  assert.deepEqual(
    [worktreeRow.worktreeInspectedCount, worktreeRow.worktreeOmittedCount],
    [32, 8],
  );
  assert.deepEqual(
    [
      worktreeRow.receiverWorktreeInspectedCount,
      worktreeRow.receiverWorktreeOmittedCount,
    ],
    [32, 0],
  );

  const invalid = Array.from({ length: 100 }, (_, index) => ({
    id: `invalid!${index}`,
    type: 'single-repo',
    worktrees: [],
  }));
  const invalidDetails = mainProducer.projectFirstProjectsLoadItems(
    invalid,
    [],
  );
  const invalidRow = await emitMain('producer-invalid', invalidDetails);
  assert.deepEqual(invalidRow.workspaceIds, []);
  assert.deepEqual(
    [invalidRow.workspaceInspectedCount, invalidRow.workspaceOmittedCount],
    [16, 84],
  );
  assert.deepEqual(
    [
      invalidRow.receiverWorkspaceInspectedCount,
      invalidRow.receiverWorkspaceOmittedCount,
    ],
    [0, 0],
  );

  const warnings = Array.from({ length: 20 }, (_, index) => ({
    workspaceId: `warning-${index}`,
    code: index % 2 === 0 ? 'invalid-canopy-json' : 'workspace-load-failed',
  }));
  const warningDetails = rendererProducer.projectFirstProjectsLoadWarnings(
    warnings,
    8,
  );
  const warningRow = await emitRenderer(
    'producer-warnings',
    'projects-load-renderer-ipc-resolved',
    { generation: 1, ...warningDetails },
  );
  assert.deepEqual(
    [warningRow.warningInspectedCount, warningRow.warningOmittedCount],
    [8, 12],
  );
  assert.deepEqual(
    [
      warningRow.receiverWarningInspectedCount,
      warningRow.receiverWarningOmittedCount,
    ],
    [8, 0],
  );

  const projectedLists = rendererProducer.projectFirstProjectsLoadLists([
    [],
    [],
    [],
    Array.from({ length: 40 }, (_, index) => ({
      id: `invalid!${index}`,
      type: 'single-repo',
      worktrees: [],
    })),
  ]);
  const appliedRow = await emitRenderer(
    'producer-applied',
    'projects-load-renderer-applied',
    { generation: 1, applied: projectedLists[3] },
  );
  assert.deepEqual(
    [
      appliedRow.applied.workspaceInspectedCount,
      appliedRow.applied.workspaceOmittedCount,
    ],
    [16, 24],
  );
  assert.deepEqual(
    [
      appliedRow.applied.receiverWorkspaceInspectedCount,
      appliedRow.applied.receiverWorkspaceOmittedCount,
    ],
    [0, 0],
  );
});

test('startup first-projects-load observer contains hostile projections and releases on its own expiry', async () => {
  const value = await runStartupBoundary({
    config: {
      launchId: 'case-expiry',
      caseId: 'case',
      fixturePid: 19,
      firstProjectsLoad: true,
      firstProjectsLoadFile: '/first-projects-load.jsonl',
    },
  });
  const event = {
    sender: value.mainWebContents,
    senderFrame: value.mainFrame,
  };
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('hostile projection getter');
      },
    },
  );
  assert.doesNotThrow(() =>
    value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__(
      event,
      'projects-load-main-entered',
      hostile,
    ),
  );
  assert.equal(value.firstProjectsLoadOutput.length, 1);
  value.expireAt(0);
  assert.equal(value.firstProjectsLoadOutput.at(-1).reason, 'observer-expired');
  assert.deepEqual(value.rendererSends, [
    ['canopy:e2e:first-projects-load-stop'],
  ]);
  assert.equal(
    value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__,
    undefined,
  );
  assert.equal(
    value.ipcMain.listenerCount('canopy:e2e:first-projects-load'),
    0,
  );
});

test('startup first-projects-load release contains unavailable stop delivery and still retires persistence', async () => {
  const value = await runStartupBoundary({
    stopSendFails: true,
    config: {
      launchId: 'case-stop-failure',
      caseId: 'case',
      fixturePid: 21,
      firstProjectsLoad: true,
      firstProjectsLoadFile: '/first-projects-load.jsonl',
    },
  });
  assert.doesNotThrow(() => value.expireAt(0));
  assert.equal(value.firstProjectsLoadOutput.at(-1).reason, 'observer-expired');
  assert.equal(
    value.context.__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__,
    undefined,
  );
  assert.equal(
    value.ipcMain.listenerCount('canopy:e2e:first-projects-load'),
    0,
  );
});

test('startup first-projects-load observer rejects incomplete and aliased stream configuration without resources', async () => {
  for (const config of [
    { firstProjectsLoad: true },
    {
      firstProjectsLoad: true,
      firstProjectsLoadFile: '/owned.jsonl',
    },
    { firstProjectsLoad: false, firstProjectsLoadFile: '/first.jsonl' },
  ]) {
    const value = await runStartupBoundary({ config });
    assert.deepEqual(value.output, []);
    assert.deepEqual(value.firstProjectsLoadOutput, []);
    assert.equal(value.timerCalls(), 0);
    assert.equal(
      value.ipcMain.listenerCount('canopy:e2e:first-projects-load'),
      0,
    );
  }
});

test('actual preload first-projects-load bridge preserves loadProjects invoke and uses one-way send only when opted in', async () => {
  const { readFileSync } = await import('node:fs');
  const { EventEmitter } = await import('node:events');
  const source = readFileSync(
    new URL('../../src/preload/index.ts', import.meta.url),
    'utf8',
  );
  const ts = require('typescript');
  const sourceFile = ts.createSourceFile(
    'preload.ts',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let bridgeInitializer;
  let activityInitializer;
  let loadProjectsInitializer;
  let exposedBridgeSpread;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'e2eReportFirstProjectsLoad'
    )
      bridgeInitializer = node.initializer?.getText(sourceFile);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'e2eIsFirstProjectsLoadActive'
    )
      activityInitializer = node.initializer?.getText(sourceFile);
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'loadProjects') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'loadProjects'))
    )
      loadProjectsInitializer = node.initializer.getText(sourceFile);
    if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === 'e2eReportFirstProjectsLoad'
    ) {
      let current = node.parent;
      while (current && !ts.isSpreadAssignment(current))
        current = current.parent;
      if (current) exposedBridgeSpread = current.expression.getText(sourceFile);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.equal(typeof bridgeInitializer, 'string');
  assert.equal(typeof activityInitializer, 'string');
  assert.equal(typeof loadProjectsInitializer, 'string');
  assert.equal(typeof exposedBridgeSpread, 'string');
  const rendererSource = readFileSync(
    new URL('../../src/renderer/src/stores/projectsStore.ts', import.meta.url),
    'utf8',
  );
  const rendererFile = ts.createSourceFile(
    'projectsStore.ts',
    rendererSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let consumer;
  const visitRenderer = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'observeFirstProjectsLoadRenderer'
    )
      consumer = node.getText(rendererFile);
    ts.forEachChild(node, visitRenderer);
  };
  visitRenderer(rendererFile);
  assert.equal(typeof consumer, 'string');
  const sends = [];
  const invokes = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (...args) => {
    invokes.push(args);
    return Promise.resolve('unchanged-result');
  };
  ipcRenderer.send = (...args) => sends.push(args);
  const context = {
    __CANOPY_E2E__: true,
    isRecord: (value) => typeof value === 'object' && value !== null,
    process: {
      env: {
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
          file: '/main.jsonl',
          mode: 'close',
          firstProjectsLoad: true,
          firstProjectsLoadFile: '/first.jsonl',
        }),
      },
    },
    isAbsolute: (value) => value.startsWith('/'),
    crypto: { randomUUID: () => 'document-1' },
    performance: { now: () => 1 },
    IPC_CHANNELS: { projectsLoad: 'projects:load' },
    ipcRenderer,
  };
  const compiled = ts.transpileModule(
    `let firstProjectsLoadProducerActive = false;
     globalThis.bridge = ${bridgeInitializer};
     const e2eReportFirstProjectsLoad = globalThis.bridge;
     globalThis.isActive = ${activityInitializer};
     const e2eIsFirstProjectsLoadActive = globalThis.isActive;
     globalThis.exposed = { ...(${exposedBridgeSpread}) };
     globalThis.loadProjects = ${loadProjectsInitializer};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  vm.runInNewContext(compiled, context);
  context.window = { api: context.exposed };
  vm.runInNewContext(
    ts.transpileModule(
      `let firstProjectsLoadDocumentId;
       let firstProjectsLoadRendererSequence = 0;
       ${consumer}
       globalThis.consumeFirstProjectsLoad = observeFirstProjectsLoadRenderer;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  assert.equal(await context.loadProjects(), 'unchanged-result');
  context.consumeFirstProjectsLoad('projects-load-renderer-entered', () => ({
    generation: 1,
  }));
  assert.equal(context.exposed.e2eIsFirstProjectsLoadActive(), true);
  ipcRenderer.emit('canopy:e2e:first-projects-load-stop');
  assert.equal(context.exposed.e2eIsFirstProjectsLoadActive(), false);
  let inactiveProjectionCalls = 0;
  context.consumeFirstProjectsLoad('projects-load-renderer-completed', () => {
    inactiveProjectionCalls++;
    return { generation: 1 };
  });
  assert.equal(inactiveProjectionCalls, 0);
  assert.deepEqual(invokes, [['projects:load']]);
  assert.deepEqual(JSON.parse(JSON.stringify(sends)), [
    [
      'canopy:e2e:first-projects-load',
      'projects-load-renderer-entered',
      {
        documentId: 'document-1',
        rendererSequence: 1,
        rendererTimeMs: 1,
        generation: 1,
      },
    ],
  ]);
});

test(
  'source0 actual preload loadProjects invokes once then lacks the first-projects-load bridge',
  { skip: !process.env.CANOPY_FIRST_PROJECTS_LOAD_SOURCE0_DIR },
  async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      require('node:path').join(
        process.env.CANOPY_FIRST_PROJECTS_LOAD_SOURCE0_DIR,
        'apps/desktop-app/src/preload/index.ts',
      ),
      'utf8',
    );
    const ts = require('typescript');
    const sourceFile = ts.createSourceFile(
      'preload-source0.ts',
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    let bridgeInitializer;
    let loadProjectsInitializer;
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'e2eReportFirstProjectsLoad'
      )
        bridgeInitializer = node.initializer?.getText(sourceFile);
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'loadProjects'
      )
        loadProjectsInitializer = node.initializer.getText(sourceFile);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    assert.equal(typeof loadProjectsInitializer, 'string');
    const invokes = [];
    const context = {
      IPC_CHANNELS: { projectsLoad: 'projects:load' },
      ipcRenderer: {
        invoke: (...args) => {
          invokes.push(args);
          return Promise.resolve('source0-result');
        },
      },
    };
    const compiled = ts.transpileModule(
      `globalThis.loadProjects = ${loadProjectsInitializer};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    vm.runInNewContext(compiled, context);
    assert.equal(await context.loadProjects(), 'source0-result');
    assert.deepEqual(invokes, [['projects:load']]);
    assert.equal(
      typeof bridgeInitializer,
      'string',
      'source0 is missing the admitted one-way preload bridge',
    );
  },
);

test('startup close inventories retain launch identity and scoped owner evidence at every quit milestone', async () => {
  const owners = [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }];
  const value = await runStartupBoundary({
    destroyed: true,
    config: {
      launchId: 'case-initial',
      caseId: 'case',
      fixturePid: 17,
      owners,
    },
  });
  for (const event of ['before-quit', 'will-quit', 'quit'])
    value.app.emit(event);
  assert.equal(value.output[0].launchId, 'case-initial');
  assert.equal(value.output[0].caseId, 'case');
  assert.equal(value.output[0].fixturePid, 17);
  for (const stage of [
    'close-entry-inventory',
    'will-quit-inventory',
    'quit-inventory',
  ]) {
    const row = value.output.find((row) => row.stage === stage);
    assert.equal(row.windows[0].status, 'destroyed');
    assert.equal(row.webContents[0].id, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(row.owners)), [
      { owner: owners[0] },
    ]);
  }
  assert.deepEqual(value.app.eventNames(), []);
});

test('startup screenshot mode installs the actual bounded observation callback', async () => {
  const value = await runStartupBoundary({
    mode: 'screenshot',
    config: {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
  });
  const callback = value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  assert.equal(typeof callback, 'function');
  callback({
    phase: 'capture-entered',
    requestSequence: 1,
    requestedBrowserId: 'browser-1',
    requestedBrowserIdTruncated: false,
    resolvedBrowserId: 'browser-1',
    resolvedBrowserIdTruncated: false,
    attempt: 1,
  });
  assert.equal(value.output.at(-1).stage, 'browser-screenshot-observation');
  assert.equal(value.output.at(-1).phase, 'capture-entered');
});

function screenshotObservation(overrides = {}) {
  return {
    phase: 'capture-entered',
    requestSequence: 1,
    requestedBrowserId: 'browser-1',
    requestedBrowserIdTruncated: false,
    resolvedBrowserId: 'browser-1',
    resolvedBrowserIdTruncated: false,
    attempt: 1,
    ...overrides,
  };
}

function maximalNativeGeometry(overrides = {}) {
  const rectangle = {
    x: -2147483648,
    y: -2147483648,
    width: 2147483647,
    height: 2147483647,
  };
  return {
    viewBounds: rectangle,
    viewVisible: false,
    webContentsDestroyed: false,
    hostDestroyed: false,
    hostVisible: false,
    hostMinimized: false,
    hostBounds: rectangle,
    hostContentBounds: rectangle,
    contentViewBounds: rectangle,
    contentViewVisible: false,
    directChildCount: Number.MAX_SAFE_INTEGER,
    directChildInspectedCount: 32,
    directChildMembership: 'unknown-overflow',
    directChildOverflow: true,
    ...overrides,
  };
}

test('startup screenshot projection is closed, Unicode-byte-bounded, and nonthrowing', async () => {
  const value = await runStartupBoundary({
    mode: 'screenshot',
    config: {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
  });
  const callback = value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  const hostile = screenshotObservation({
    requestedBrowserId: '😀'.repeat(40),
    resolvedBrowserId: '界'.repeat(50),
    stateBounds: { x: 1, y: 2, width: 3, height: 4 },
    stateVisible: true,
    dataUrl: 'data:image/png;base64,secret',
  });
  Object.defineProperty(hostile, 'url', {
    enumerable: true,
    get: () => {
      throw new Error('unrelated getter must not be read');
    },
  });
  assert.doesNotThrow(() => callback(hostile));
  const row = value.output.at(-1);
  assert.equal(row.stage, 'browser-screenshot-observation');
  assert.equal(Buffer.byteLength(row.requestedBrowserId), 128);
  assert.equal(Buffer.byteLength(row.resolvedBrowserId), 126);
  assert.equal(row.requestedBrowserIdTruncated, true);
  assert.equal(row.resolvedBrowserIdTruncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(row.stateBounds)), {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
  assert.equal(row.stateVisible, true);
  assert.equal(Object.hasOwn(row, 'dataUrl'), false);
  assert.equal(Object.hasOwn(row, 'url'), false);
});

test('startup screenshot projection retains only validated geometry and invokes no input accessors', async () => {
  const value = await runStartupBoundary({
    mode: 'screenshot',
    config: {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
  });
  const callback = value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  callback(
    screenshotObservation({
      ...maximalNativeGeometry({
        directChildCount: 33,
        directChildMembership: 'present',
        directChildOverflow: false,
      }),
      nativeGeometryUnavailable: 'view-visible,host-visible',
      arbitraryNativeObject: { secret: true },
    }),
  );
  const row = value.output.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(row)).viewBounds, {
    x: -2147483648,
    y: -2147483648,
    width: 2147483647,
    height: 2147483647,
  });
  assert.equal(row.viewVisible, false);
  assert.equal(row.webContentsDestroyed, false);
  assert.equal(row.hostDestroyed, false);
  assert.equal(row.hostVisible, false);
  assert.equal(row.hostMinimized, false);
  assert.equal(row.contentViewVisible, false);
  assert.equal(row.directChildCount, 33);
  assert.equal(row.directChildInspectedCount, 32);
  assert.equal(row.directChildMembership, 'present');
  assert.equal(row.directChildOverflow, false);
  assert.equal(row.nativeGeometryUnavailable, 'view-visible,host-visible');
  assert.equal(Object.hasOwn(row, 'arbitraryNativeObject'), false);

  let rootAccessorCalls = 0;
  const rootAccessor = screenshotObservation();
  Object.defineProperty(rootAccessor, 'phase', {
    enumerable: true,
    get: () => {
      rootAccessorCalls++;
      throw new Error('projected root accessor must not run');
    },
  });
  const rowsBeforeRootAccessor = value.output.length;
  assert.doesNotThrow(() => callback(rootAccessor));
  assert.equal(rootAccessorCalls, 0);
  assert.equal(value.output.length, rowsBeforeRootAccessor);

  let idAccessorCalls = 0;
  const idAccessor = screenshotObservation();
  Object.defineProperty(idAccessor, 'requestedBrowserId', {
    enumerable: true,
    get: () => {
      idAccessorCalls++;
      throw new Error('projected ID accessor must not run');
    },
  });
  const rowsBeforeIdAccessor = value.output.length;
  assert.doesNotThrow(() => callback(idAccessor));
  assert.equal(idAccessorCalls, 0);
  assert.equal(value.output.length, rowsBeforeIdAccessor);

  let nestedAccessorCalls = 0;
  const hostileBounds = {};
  Object.defineProperty(hostileBounds, 'x', {
    enumerable: true,
    get: () => {
      nestedAccessorCalls++;
      throw new Error('projected nested accessor must not run');
    },
  });
  callback(screenshotObservation({ stateBounds: hostileBounds }));
  assert.equal(nestedAccessorCalls, 0);
  assert.equal(value.output.at(-1).projectionUnavailable, 'state-bounds');

  let geometryAccessorCalls = 0;
  const geometryAccessor = screenshotObservation();
  Object.defineProperty(geometryAccessor, 'viewBounds', {
    enumerable: true,
    get: () => {
      geometryAccessorCalls++;
      throw new Error('projected geometry accessor must not run');
    },
  });
  callback(geometryAccessor);
  assert.equal(geometryAccessorCalls, 0);
  assert.equal(Object.hasOwn(value.output.at(-1), 'viewBounds'), false);

  let geometryNestedAccessorCalls = 0;
  const hostileGeometryBounds = {};
  Object.defineProperty(hostileGeometryBounds, 'x', {
    enumerable: true,
    get: () => {
      geometryNestedAccessorCalls++;
      throw new Error('projected geometry member accessor must not run');
    },
  });
  callback(screenshotObservation({ viewBounds: hostileGeometryBounds }));
  assert.equal(geometryNestedAccessorCalls, 0);
  assert.equal(Object.hasOwn(value.output.at(-1), 'viewBounds'), false);
});

test('startup screenshot projection rejects oversized unavailable codes before splitting', async () => {
  const value = await runStartupBoundary({
    mode: 'screenshot',
    config: {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
  });
  const callback = value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  const completeVocabulary = [
    'view-bounds',
    'view-visible',
    'web-contents-destroyed',
    'host-destroyed',
    'host-visible',
    'host-minimized',
    'host-bounds',
    'host-content-bounds',
    'content-view-bounds',
    'content-view-visible',
    'direct-children',
  ].join(',');
  const oversized = `${completeVocabulary},x`;
  value.context.oversizedNativeGeometryUnavailable = oversized;
  vm.runInNewContext(
    `globalThis.originalSplit = String.prototype.split;
     globalThis.oversizedSplitCalls = 0;
     Object.defineProperty(String.prototype, 'split', {
       configurable: true,
       writable: true,
       value(separator, limit) {
         if (String(this) === globalThis.oversizedNativeGeometryUnavailable) {
           globalThis.oversizedSplitCalls++;
         }
         return globalThis.originalSplit.call(this, separator, limit);
       },
     });`,
    value.context,
  );
  try {
    assert.doesNotThrow(() =>
      callback(screenshotObservation({ nativeGeometryUnavailable: oversized })),
    );
  } finally {
    vm.runInNewContext(
      `Object.defineProperty(String.prototype, 'split', {
         configurable: true,
         writable: true,
         value: globalThis.originalSplit,
       });`,
      value.context,
    );
  }
  assert.equal(value.context.oversizedSplitCalls, 0);
  assert.equal(
    Object.hasOwn(value.output.at(-1), 'nativeGeometryUnavailable'),
    false,
  );
});

test('startup screenshot 80 KiB quota retains five complete three-attempt failures with maximal geometry', async () => {
  const value = await runStartupBoundary({
    mode: 'screenshot',
    config: {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
  });
  const callback = value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  const requestedBrowserId = 'x'.repeat(128);
  const resolvedBrowserId = 'y'.repeat(128);
  for (let requestSequence = 1; requestSequence <= 5; requestSequence++) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const phase of [
        'capture-entered',
        'capture-returned',
        'validation',
      ]) {
        callback(
          screenshotObservation({
            ...(phase === 'capture-entered' || phase === 'capture-returned'
              ? maximalNativeGeometry()
              : {}),
            phase,
            requestSequence,
            requestedBrowserId,
            resolvedBrowserId,
            attempt,
          }),
        );
      }
    }
    callback(
      screenshotObservation({
        phase: 'capture-exhausted',
        requestSequence,
        requestedBrowserId,
        resolvedBrowserId,
        attempt: 3,
      }),
    );
  }
  const lines = value.rawLines.filter((line) =>
    line.includes('"stage":"browser-screenshot-observation"'),
  );
  const rows = lines.map((line) => JSON.parse(line));
  assert.equal(rows.length, 50);
  assert.equal(
    rows.filter(({ phase }) => phase === 'observer-truncated').length,
    0,
  );
  assert.equal(
    rows.filter(
      ({ phase }) =>
        phase === 'capture-entered' || phase === 'capture-returned',
    ).length,
    30,
  );
  assert.equal(
    rows.filter(
      ({ directChildMembership }) =>
        directChildMembership === 'unknown-overflow',
    ).length,
    30,
  );
  for (let requestSequence = 1; requestSequence <= 5; requestSequence++) {
    const requestRows = rows.filter(
      (row) => row.requestSequence === requestSequence,
    );
    assert.equal(requestRows.length, 10);
    assert.equal(
      requestRows.filter(({ phase }) => phase === 'capture-exhausted').length,
      1,
    );
    assert.equal(requestRows.filter(({ attempt }) => attempt === 3).length, 4);
  }
  assert.ok(
    lines.reduce((total, line) => total + Buffer.byteLength(line), 0) <= 81920,
  );
});

test('startup screenshot local row cap reserves one in-cap marker and releases its callback', async () => {
  const value = await runStartupBoundary({
    mode: 'screenshot',
    config: {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
  });
  const callback = value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  for (let index = 0; index < 80; index++) {
    assert.doesNotThrow(() =>
      callback(
        screenshotObservation({
          requestSequence: index + 1,
          requestedBrowserId: `browser-${index}`,
          resolvedBrowserId: `browser-${index}`,
        }),
      ),
    );
  }
  const rows = value.output.filter(
    ({ stage }) => stage === 'browser-screenshot-observation',
  );
  assert.equal(rows.length, 64);
  assert.equal(
    rows.filter(({ phase }) => phase === 'observer-truncated').length,
    1,
  );
  assert.equal(
    rows.filter(({ phase }) => phase !== 'observer-truncated').length,
    63,
  );
  assert.ok(
    value.rawLines
      .filter((line) =>
        line.includes('"stage":"browser-screenshot-observation"'),
      )
      .reduce((total, line) => total + Buffer.byteLength(line), 0) <= 81920,
  );
  assert.equal(
    value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__,
    undefined,
  );
  assert.equal(value.timerCalls(), 0);
});

test('startup screenshot byte cap counts complete JSONL rows and retains its reserved marker', async () => {
  const value = await runStartupBoundary({
    mode: 'screenshot',
    config: {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
  });
  const callback = value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  const large = 'x'.repeat(128);
  for (let index = 0; index < 80; index++) {
    callback(
      screenshotObservation({
        ...maximalNativeGeometry(),
        phase: 'capture-entered',
        requestSequence: index + 1,
        requestedBrowserId: large,
        resolvedBrowserId: large,
        webContentsId: 10,
        hostWindowId: 11,
        stateBounds: { x: 1, y: 2, width: 800, height: 600 },
        stateVisible: true,
        captureEnteredNs: '1'.repeat(32),
        captureReturnedNs: '2'.repeat(32),
        validationNs: '3'.repeat(32),
        liveSessionAssertion: 'passed',
        imageEmpty: false,
        encodingPrefixValid: true,
        encodingNonempty: true,
        dataUrlLength: 123456,
        projectionUnavailable: large,
      }),
    );
  }
  const lines = value.rawLines.filter((line) =>
    line.includes('"stage":"browser-screenshot-observation"'),
  );
  const rows = lines.map((line) => JSON.parse(line));
  assert.ok(rows.length < 64);
  assert.equal(rows.at(-1).phase, 'observer-truncated');
  assert.equal(
    rows.filter(({ phase }) => phase === 'observer-truncated').length,
    1,
  );
  assert.ok(
    lines.reduce((total, line) => total + Buffer.byteLength(line), 0) <= 81920,
  );
});

test('startup screenshot callback releases on writer failure and preserves a replacement on quit', async () => {
  const config = {
    caseId: 'two-browser-panels-screenshot',
    launchId: 'two-browser-panels-screenshot-initial-fixture',
    fixturePid: 17,
  };
  const failed = await runStartupBoundary({
    mode: 'screenshot',
    config,
    writeFailsAfter: 1,
  });
  const failedCallback =
    failed.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__;
  assert.doesNotThrow(() => failedCallback(screenshotObservation()));
  assert.equal(
    failed.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__,
    undefined,
  );
  const unavailable = await runStartupBoundary({
    mode: 'screenshot',
    config,
    writeFails: true,
  });
  assert.equal(
    unavailable.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__,
    undefined,
  );
  assert.deepEqual(unavailable.app.eventNames(), []);

  const replaced = await runStartupBoundary({ mode: 'screenshot', config });
  const replacement = () => {};
  Object.defineProperty(
    replaced.context,
    '__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__',
    { configurable: true, value: replacement },
  );
  replaced.app.emit('quit');
  assert.equal(
    replaced.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__,
    replacement,
  );
  assert.deepEqual(replaced.app.eventNames(), []);
  assert.equal(replaced.timerCalls(), 0);
});

test('startup screenshot mode requires exact case plus launch and fixture identities', async () => {
  for (const config of [
    {
      caseId: 'wrong-case',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
      fixturePid: 17,
    },
    { caseId: 'two-browser-panels-screenshot', fixturePid: 17 },
    {
      caseId: 'two-browser-panels-screenshot',
      launchId: 'two-browser-panels-screenshot-initial-fixture',
    },
  ]) {
    const value = await runStartupBoundary({ mode: 'screenshot', config });
    assert.deepEqual(value.output, []);
    assert.equal(
      value.context.__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__,
      undefined,
    );
  }
  let envReads = 0;
  const environment = {};
  Object.defineProperty(
    environment,
    'CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS',
    {
      get: () => {
        envReads++;
        throw new Error('non-E2E must not read diagnostic env');
      },
    },
  );
  const disabled = await runStartupBoundary({ e2e: false, environment });
  assert.equal(envReads, 0);
  assert.deepEqual(disabled.output, []);
});

test('default panel setup closes only its fresh exact owner and records bounded passive evidence', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const { mkdtempSync, mkdirSync, readFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const nodePath = await import('node:path');
  const source = await readFile(
    new URL('../electron/panelHarness.mjs', import.meta.url),
    'utf8',
  );
  const declarations = source
    .slice(
      source.indexOf('function createDefaultPanelSetupBoundary('),
      source.indexOf('/**\n * The VISIBLE chat panel'),
    )
    .replace(
      'export async function seedPanelWorktree',
      'async function seedPanelWorktree',
    )
    .replace('export { expandDefaultActivityRail };', '');
  const makeSeed = ({
    diagnostics = false,
    launchError,
    seedError,
    selectionError,
    closeError,
    failureCatalogError,
    prelaunchCatalogError,
    recorderError,
    realRecorderFile,
    cachedUrl = 'canopy://cached-main',
    saturatedEvidence = false,
  } = {}) => {
    const primary =
      launchError ??
      seedError ??
      selectionError ??
      new Error('shell readiness failed');
    const electronApp = {
      evaluate: () => {
        throw new Error('main transport must not run');
      },
    };
    const owner = { electronApp, userDataDir: '/owned' };
    const calls = [],
      records = [],
      launches = [];
    let catalogCalls = 0;
    const page = {
      url: () => cachedUrl,
      isClosed: () => false,
      locator: () => {
        throw new Error('locator transport must not run');
      },
      evaluate: () => {
        throw new Error('renderer transport must not run');
      },
    };
    const context = {
      randomUUID: () => 'fixture',
      Buffer,
      process: {
        env: diagnostics
          ? { CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '/diagnostics' }
          : {},
        pid: 17,
      },
      mkdtempSync: () => '/owned',
      path: nodePath,
      os: { tmpdir: () => '/tmp' },
      seedDemoWorkspaces: () => {
        calls.push('seed-demo');
        if (seedError) throw seedError;
        return {};
      },
      seedWorktreeChat: () => calls.push('seed-chat'),
      mkdirSync: () => {},
      writeFileSync: () => {},
      SEEDED_CHAT_TAB_ID: 'seed-chat',
      captureFixtureCatalog: (userDataDir) => {
        catalogCalls++;
        calls.push(`catalog-${catalogCalls}`);
        if (prelaunchCatalogError && catalogCalls === 1)
          throw prelaunchCatalogError;
        if (failureCatalogError && catalogCalls === 2)
          throw failureCatalogError;
        const saturated = '\\\u0000😀'.repeat(10_000);
        return {
          userDataDir,
          indexPath: `${userDataDir}/workspaces/index.json`,
          files: Array.from({ length: 18 }, (_, index) => ({
            path: saturatedEvidence
              ? saturated
              : `${userDataDir}/${'p'.repeat(10_000)}-${index}.json`,
            status: 'present',
            sizeBytes: 100 + index,
            sha256: String(index).padStart(64, '0'),
            identities: Array.from({ length: 10 }, (__, identity) =>
              Object.fromEntries(
                [
                  'id',
                  'kind',
                  'type',
                  'workspaceId',
                  'worktreeId',
                  'branchName',
                ].map((key) => [
                  key,
                  saturatedEvidence ? saturated : `${key}-${identity}`,
                ]),
              ),
            ),
            truncated: false,
            rawContents: 'must-not-copy',
          })),
        };
      },
      createBoundaryRecorder: () => {
        if (recorderError) throw recorderError;
        calls.push('recorder');
        if (realRecorderFile)
          return lifecycle.createBoundaryRecorder(realRecorderFile);
        return (stage, details = {}) => {
          calls.push(`record-${stage}`);
          records.push({ stage, ...details });
        };
      },
      reportOwnedSetupFailure: lifecycle.reportOwnedSetupFailure,
      launchCanopy: async (options) => {
        calls.push('launch');
        launches.push(options);
        if (launchError) throw launchError;
        return owner;
      },
      closeCanopy: async (app, userDataDir, options) => {
        assert.equal(app, electronApp);
        assert.equal(userDataDir, '/owned');
        calls.push('close');
        assert.equal(
          options.boundaryRecord,
          diagnostics ? context.createBoundaryRecorderResult : undefined,
        );
        if (realRecorderFile) {
          for (const stage of [
            'electronApp.close',
            'owned-tree-reap',
            'user-data-remove',
          ])
            await options.boundaryRecord.observe(stage, async () => {});
          await options.boundaryRecord.observe(
            'secure-user-data-remove',
            async () => {
              throw new Error('realistic secure removal rejection');
            },
          );
        }
        if (closeError) throw closeError;
      },
      getMainWindow: async () => page,
      CanopyAppDriver: class {
        async waitForShell() {
          calls.push('shell');
          if (!selectionError) throw primary;
        }
        async openMainPage() {
          calls.push('main-page');
        }
        async selectWorktree() {
          calls.push('select');
          if (selectionError) throw selectionError;
        }
      },
      console,
    };
    const originalCreateRecorder = context.createBoundaryRecorder;
    context.createBoundaryRecorder = (file) => {
      const record = originalCreateRecorder(file);
      context.createBoundaryRecorderResult = record;
      return record;
    };
    const seed = vm.runInNewContext(
      `${declarations}\nseedPanelWorktree`,
      context,
    );
    return { calls, launches, owner, page, primary, records, seed };
  };

  const explicit = makeSeed();
  await assert.rejects(
    explicit.seed({
      onBeforeLaunch: () => explicit.calls.push('before-launch'),
      onSetupFailure: (context) => {
        assert.equal(context.electronApp, explicit.owner.electronApp);
        assert.equal(context.error, explicit.primary);
        explicit.calls.push('setup-failure');
        throw new Error('observer');
      },
    }),
    (error) => error === explicit.primary,
  );
  assert(explicit.calls.includes('before-launch'));
  assert(explicit.calls.includes('setup-failure'));
  assert(!explicit.calls.includes('close'));

  const selected = makeSeed({ selectionError: new Error('selection failed') });
  await assert.rejects(
    selected.seed({
      onSelectWorktreeFailure: (context) => {
        assert.equal(context.electronApp, selected.owner.electronApp);
        assert.equal(context.userDataDir, '/owned');
        selected.calls.push('selection-failure');
      },
    }),
    (error) => error === selected.primary,
  );
  assert(selected.calls.includes('selection-failure'));
  assert(!selected.calls.includes('close'));

  const callerOwned = makeSeed();
  await assert.rejects(
    callerOwned.seed({ userDataDir: '/caller-owned' }),
    (error) => error === callerOwned.primary,
  );
  assert.equal(callerOwned.launches[0].userDataDir, '/caller-owned');
  assert(!callerOwned.calls.includes('close'));

  const rejectedLaunch = makeSeed({ launchError: new Error('launch failed') });
  await assert.rejects(
    rejectedLaunch.seed(),
    (error) => error === rejectedLaunch.primary,
  );
  assert(!rejectedLaunch.calls.includes('close'));

  const rejectedSeed = makeSeed({ seedError: new Error('seed failed') });
  await assert.rejects(
    rejectedSeed.seed(),
    (error) => error === rejectedSeed.primary,
  );
  assert(!rejectedSeed.calls.includes('launch'));
  assert(!rejectedSeed.calls.includes('close'));

  const launchEnv = { RETAINED: 'yes' };
  const diagnostic = makeSeed({
    diagnostics: true,
    cachedUrl: '\\\u0000😀'.repeat(10_000),
    saturatedEvidence: true,
  });
  await assert.rejects(
    diagnostic.seed({
      env: launchEnv,
      onBeforeLaunch: () => {
        assert(diagnostic.calls.includes('catalog-1'));
        throw new Error('observer failed');
      },
    }),
    (error) => error === diagnostic.primary,
  );
  assert.deepEqual(launchEnv, { RETAINED: 'yes' });
  assert(
    diagnostic.calls.indexOf('record-default-panel-setup-failure') <
      diagnostic.calls.indexOf('close'),
  );
  assert.equal(
    JSON.parse(
      diagnostic.launches[0].env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
    ).mode,
    'setup',
  );
  const pageEvidence = diagnostic.records.find(
    (row) => row.stage === 'default-panel-setup-page',
  );
  assert(Buffer.byteLength(JSON.stringify(pageEvidence.url.value)) <= 2_048);
  assert.equal(pageEvidence.isClosed.value, false);
  assert.deepEqual(JSON.parse(JSON.stringify(pageEvidence.domRows)), {
    status: 'unavailable',
    reason: 'live-renderer-transport-omitted-to-preserve-bounded-cleanup',
  });
  const catalogRows = diagnostic.records.filter(
    (row) => row.stage === 'default-panel-setup-catalog-file',
  );
  assert(catalogRows.length > 0 && catalogRows.length < 34);
  for (const phase of ['prelaunch', 'failure']) {
    const rows = catalogRows.filter((row) => row.phase === phase);
    const summary = diagnostic.records.find(
      (row) =>
        row.stage === 'default-panel-setup-catalog-summary' &&
        row.phase === phase,
    );
    assert(rows.length > 0);
    assert.equal(rows[0].index, 0);
    assert.equal(rows[0].sha256, '0'.repeat(64));
    assert.equal(summary.recordedFileCount, rows.length);
    assert.equal(summary.omittedFileCount, 18 - rows.length);
    assert.equal(summary.truncated, true);
  }
  assert(
    catalogRows.every(
      (row) => Buffer.byteLength(JSON.stringify(row.path)) <= 1_024,
    ),
  );
  assert(catalogRows.every((row) => row.identities.length === 8));
  assert(
    catalogRows.every((row) =>
      row.identities.every((identity) =>
        Object.values(identity).every(
          (value) => Buffer.byteLength(JSON.stringify(value)) <= 128,
        ),
      ),
    ),
  );
  assert(catalogRows.every((row) => row.sha256.length === 64));
  assert(catalogRows.every((row) => row.status === 'present'));
  assert(catalogRows.every((row) => row.truncated));
  assert(
    catalogRows.every((row) => !JSON.stringify(row).includes('must-not-copy')),
  );
  assert(
    diagnostic.records.every(
      (row) => Buffer.byteLength(JSON.stringify(row)) < 16 * 1024,
    ),
  );

  const secondary = makeSeed({
    diagnostics: true,
    failureCatalogError: new Error('capture failed'),
    closeError: new Error('close failed'),
  });
  await assert.rejects(
    secondary.seed(),
    (error) => error === secondary.primary,
  );
  assert(secondary.calls.includes('close'));

  const failedPrelaunchCapture = makeSeed({
    diagnostics: true,
    prelaunchCatalogError: new Error('prelaunch capture failed'),
  });
  await assert.rejects(
    failedPrelaunchCapture.seed(),
    (error) => error === failedPrelaunchCapture.primary,
  );
  assert(failedPrelaunchCapture.calls.includes('launch'));
  assert(failedPrelaunchCapture.calls.includes('close'));
  assert(
    failedPrelaunchCapture.records.some(
      (row) =>
        row.stage === 'default-panel-setup-catalog' &&
        row.phase === 'prelaunch' &&
        row.status === 'unavailable',
    ),
  );
  assert(
    failedPrelaunchCapture.records.some(
      (row) =>
        row.stage === 'default-panel-setup-catalog' &&
        row.phase === 'failure' &&
        row.status === 'available',
    ),
  );

  const failedInitialization = makeSeed({
    diagnostics: true,
    recorderError: new Error('recorder unavailable'),
  });
  await assert.rejects(
    failedInitialization.seed(),
    (error) => error === failedInitialization.primary,
  );
  assert(failedInitialization.calls.includes('close'));

  const explicitDiagnostic = 'caller-observer';
  const collision = makeSeed({ diagnostics: true });
  await assert.rejects(
    collision.seed({
      env: {
        CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: explicitDiagnostic,
      },
    }),
    (error) => error === collision.primary,
  );
  assert.equal(
    collision.launches[0].env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
    explicitDiagnostic,
  );
  assert(collision.calls.includes('close'));
  assert(
    collision.records.some(
      (row) =>
        row.stage === 'default-panel-setup-diagnostic-env-collision' &&
        row.mainIdentityStream === 'unavailable-explicit-diagnostic-env',
    ),
  );

  const requestedRecorderFile =
    process.env.CANOPY_DEFAULT_PANEL_SETUP_FIX1_RECORDER_FILE;
  const recorderRoot = requestedRecorderFile
    ? undefined
    : mkdtempSync(nodePath.join(tmpdir(), 'default-panel-fix1-recorder-'));
  if (recorderRoot)
    t.after(() => rmSync(recorderRoot, { recursive: true, force: true }));
  const recorderFile = requestedRecorderFile
    ? nodePath.resolve(requestedRecorderFile)
    : nodePath.join(recorderRoot, 'events.jsonl');
  mkdirSync(nodePath.dirname(recorderFile), { recursive: true });
  const realRecorder = makeSeed({
    diagnostics: true,
    realRecorderFile: recorderFile,
    cachedUrl: '\\\u0000😀'.repeat(10_000),
    saturatedEvidence: true,
  });
  await assert.rejects(
    realRecorder.seed(),
    (error) => error === realRecorder.primary,
  );
  const persisted = readFileSync(recorderFile);
  const lines = persisted
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const outcomes = (stage) =>
    lines
      .filter((row) => row.stage === stage)
      .map((row) => row.outcome)
      .filter(Boolean);
  assert.deepEqual(
    {
      observerTruncated: lines.some(
        (row) => row.stage === 'observer-truncated',
      ),
      catalogSummaryPhases: lines
        .filter((row) => row.stage === 'default-panel-setup-catalog-summary')
        .map((row) => row.phase)
        .sort(),
      pagePresent: lines.some(
        (row) => row.stage === 'default-panel-setup-page',
      ),
      electronClose: outcomes('electronApp.close'),
      treeReap: outcomes('owned-tree-reap'),
      userDataRemove: outcomes('user-data-remove'),
      secureUserDataRemove: outcomes('secure-user-data-remove'),
      closeCalls: realRecorder.calls.filter((call) => call === 'close').length,
    },
    {
      observerTruncated: false,
      catalogSummaryPhases: ['failure', 'prelaunch'],
      pagePresent: true,
      electronClose: ['entered', 'fulfilled'],
      treeReap: ['entered', 'fulfilled'],
      userDataRemove: ['entered', 'fulfilled'],
      secureUserDataRemove: ['entered', 'rejected'],
      closeCalls: 1,
    },
  );
  const closeOffset = persisted.indexOf(Buffer.from('"electronApp.close"'));
  assert(closeOffset > 0);
  assert(closeOffset <= 48 * 1024);
  for (const phase of ['prelaunch', 'failure']) {
    const summary = lines.find(
      (row) =>
        row.stage === 'default-panel-setup-catalog-summary' &&
        row.phase === phase,
    );
    const rows = lines.filter(
      (row) =>
        row.stage === 'default-panel-setup-catalog-file' && row.phase === phase,
    );
    assert.equal(summary.recordedFileCount, rows.length);
    assert.equal(summary.omittedFileCount, 18 - rows.length);
    assert.equal(summary.truncated, true);
    assert.equal(rows[0].sha256, '0'.repeat(64));
    assert.equal(rows[0].status, 'present');
    assert.equal(rows[0].identities.length, 8);
    assert(
      persisted
        .toString('utf8')
        .split('\n')
        .filter((line) => line && JSON.parse(line).phase === phase)
        .reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0) <=
        16 * 1024,
    );
  }
});

test('shared-worker startup error forwarding preserves the original producer write/fetch/delay sequence', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL(
      '../electron/fixtures/browser-profile-clear/shared-workers.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  const start = source.indexOf('`const diagnosticPorts =');
  const script = source.slice(start + 1, source.indexOf('`,', start));
  assert(script.length > 100);
  const calls = [],
    events = new Map(),
    messages = [];
  const end = new Error('stop after original delay');
  const context = {
    self: { addEventListener: (name, listener) => events.set(name, listener) },
    caches: {
      open: async (name) => {
        calls.push(['open', name]);
        return {
          put: async (key, value) =>
            calls.push(['put', key, await value.text()]),
        };
      },
    },
    fetch: async (url) => calls.push(['fetch', url]),
    Response,
    setTimeout: (_callback, ms) => {
      calls.push(['delay', ms]);
      throw end;
    },
  };
  vm.runInNewContext(script, context);
  const port = { start() {}, postMessage: (message) => messages.push(message) };
  context.onconnect({ ports: [port] });
  await assert.rejects(port.onmessage({ data: 'a' }), (error) => error === end);
  assert.deepEqual(calls, [
    ['open', 'shared'],
    ['put', '/value', '1'],
    ['fetch', '/producer?id=a'],
    ['delay', 10],
  ]);
  events.get('unhandledrejection')({ reason: 'x'.repeat(10000) });
  assert.equal(messages[0].profileSharedWorkerError.length, 512);
});

test('selection failure DOM projection caps row identities and labels', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    integratedDiagnosticSource(
      'apps/desktop-app/tests/electron/browser-profiles.spec.mjs',
      new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    ),
    'utf8',
  );
  const declaration = source.slice(
    source.indexOf('function collectWorktreeSelectionSnapshot('),
    source.indexOf('async function captureWorktreeSelectionSnapshot('),
  );
  const row = {
    getAttribute: () => 'x'.repeat(10000),
    innerText: 'x'.repeat(10000),
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  };
  const collect = vm.runInNewContext(`(${declaration.trim()})`, {
    window: {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    },
    document: {
      querySelectorAll: () => Array.from({ length: 1000 }, () => row),
      querySelector: () => null,
      visibilityState: 'visible',
      hasFocus: () => true,
    },
  });
  const value = collect('demo-main');
  assert(value.rows.length <= 128);
  assert(value.rows[0].worktreeId.length <= 128);
  assert(value.rows[0].visibleLabel.length <= 512);
  assert.equal(value.truncated, true);
});

test('initial navigation observer records the exact dispatch and native lifecycle then restores ownership', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function installInitialNavigationObserver(');
  const end = source.indexOf(
    'async function captureInitialNavigationEvidence(',
    start,
  );
  assert.ok(
    start >= 0 && end > start,
    'initial navigation observer seam missing',
  );
  const declaration = source.slice(start, end);
  const app = new EventEmitter();
  const original = async (_event, request) => ({ url: request.url });
  const handlers = new Map([['browser:navigate', original]]);
  const targetUrl =
    'http://127.0.0.1:4011/browser-fixture/one?scenarioKey=exact';
  const contents = new EventEmitter();
  Object.assign(contents, {
    id: 41,
    getType: () => 'webview',
    getURL: () => targetUrl,
    isDestroyed: () => false,
    isLoading: () => false,
  });
  const context = {
    electron: {
      app,
      ipcMain: { _invokeHandlers: handlers },
      webContents: {
        getAllWebContents: () => [contents],
        fromId: (id) => (id === contents.id ? contents : null),
      },
    },
    input: { observerKey: '__INITIAL_NAV_TEST__', targetUrl },
  };
  vm.runInNewContext(
    `${declaration}\ninstallInitialNavigationObserver(electron, input)`,
    context,
  );
  const wrapped = handlers.get('browser:navigate');
  assert.notEqual(wrapped, original);
  await wrapped({}, { browserId: 'browser-1', url: targetUrl });
  contents.emit('did-start-navigation', {}, targetUrl, false, true);
  contents.emit('did-navigate', {}, targetUrl, 200, 'OK');
  contents.emit('did-finish-load');
  const snapshot = context.__INITIAL_NAV_TEST__.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.dispatch)), [
    {
      enteredSequence: 1,
      browserId: 'browser-1',
      url: targetUrl,
      outcome: 'resolved',
      settledSequence: 2,
    },
  ]);
  assert.equal(snapshot.initialNative.length, 1);
  assert.deepEqual(
    Array.from(snapshot.native, (entry) => entry.phase),
    ['did-start-navigation', 'did-navigate', 'did-finish-load'],
  );
  context.__INITIAL_NAV_TEST__.cleanup();
  assert.equal(handlers.get('browser:navigate'), original);
  assert.equal(app.listenerCount('web-contents-created'), 0);
  assert.equal(contents.eventNames().length, 0);
  assert.equal(context.__INITIAL_NAV_TEST__, undefined);
});

test('initial navigation observer rejects conflicting restoration without removing the replacement handler', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function installInitialNavigationObserver(');
  const end = source.indexOf(
    'async function captureInitialNavigationEvidence(',
    start,
  );
  assert.ok(
    start >= 0 && end > start,
    'initial navigation observer seam missing',
  );
  const declaration = source.slice(start, end);
  const app = new EventEmitter();
  const original = async () => undefined;
  const replacement = async () => undefined;
  const handlers = new Map([['browser:navigate', original]]);
  const context = {
    electron: {
      app,
      ipcMain: { _invokeHandlers: handlers },
      webContents: { getAllWebContents: () => [], fromId: () => null },
    },
    input: {
      observerKey: '__INITIAL_NAV_CONFLICT__',
      targetUrl: 'http://127.0.0.1:4011/browser-fixture/one',
    },
  };
  vm.runInNewContext(
    `${declaration}\ninstallInitialNavigationObserver(electron, input)`,
    context,
  );
  handlers.set('browser:navigate', replacement);
  assert.throws(
    () => context.__INITIAL_NAV_CONFLICT__.cleanup(),
    /restoration conflict/i,
  );
  assert.equal(handlers.get('browser:navigate'), replacement);
  assert.equal(app.listenerCount('web-contents-created'), 0);
});

test('browser fixture activity records only an optional scenario key without changing the response seam', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    integratedDiagnosticSource(
      'apps/desktop-app/tests/electron/mock-server/start.mjs',
      new URL('../electron/mock-server/start.mjs', import.meta.url),
    ),
    'utf8',
  );
  const start = source.indexOf('function recordBrowserFixtureActivity(');
  const end = source.indexOf('export function createMockServer()', start);
  assert.ok(start >= 0 && end > start, 'browser fixture activity seam missing');
  const declaration = source.slice(start, end);
  const calls = [];
  const recordScenarioActivity = (...args) => calls.push(args);
  const context = { URL, recordScenarioActivity };
  const record = vm.runInNewContext(
    `${declaration}\nrecordBrowserFixtureActivity`,
    context,
  );
  record(new URL('http://127.0.0.1/browser-fixture/one?scenarioKey=exact'));
  record(new URL('http://127.0.0.1/browser-fixture/two'));
  assert.deepEqual(calls, [['exact', 'browserFixtureGet']]);
});

test('browser fixture GET route records optional activity while returning the existing fixture response', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    integratedDiagnosticSource(
      'apps/desktop-app/tests/electron/mock-server/start.mjs',
      new URL('../electron/mock-server/start.mjs', import.meta.url),
    ),
    'utf8',
  );
  const helpersStart = source.indexOf('function jsonResponse(');
  const helpersEnd = source.indexOf('export function createMockServer()');
  const requestStart = source.indexOf('async function handleRequest(');
  const requestEnd = source.indexOf('function main()', requestStart);
  assert.ok(
    helpersStart >= 0 &&
      helpersEnd > helpersStart &&
      requestStart >= 0 &&
      requestEnd > requestStart,
    'browser fixture request seam missing',
  );
  const calls = [];
  const response = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
  const context = {
    HOST: '127.0.0.1',
    recordScenarioActivity: (...args) => calls.push(args),
    handleLlmRequest: async () => false,
    handleGithubRequest: async () => false,
    handleLinearRequest: async () => false,
    handleAuthUsageRequest: async () => false,
    handleSharedContainersRequest: async () => false,
    handleCloudRequest: async () => false,
    handleControlPlaneRequest: async () => false,
    request: {
      method: 'GET',
      url: '/browser-fixture/one?scenarioKey=route-exact',
      socket: { localPort: 4011 },
    },
    response,
    URL,
    encodeURIComponent,
  };
  await vm.runInNewContext(
    `(async () => {\n${source.slice(helpersStart, helpersEnd)}\n${source.slice(requestStart, requestEnd)}\nawait handleRequest(request, response);\n})()`,
    context,
  );
  assert.deepEqual(calls, [['route-exact', 'browserFixtureGet']]);
  assert.equal(response.status, 200);
  assert.match(response.body, /Performance Browser One/);
  assert.match(response.body, /data-browser-fixture="one"/);
});

function recoveryBoundaryExpect(value) {
  return {
    toBe(expected) {
      assert.equal(value, expected);
    },
    toBeTruthy() {
      assert.ok(value);
    },
    toBeVisible: async () => {},
    toEqual(expected) {
      assert.deepEqual(value, expected);
    },
    toMatchObject(expected) {
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (
          expectedValue &&
          typeof expectedValue === 'object' &&
          !Array.isArray(expectedValue)
        ) {
          recoveryBoundaryExpect(value[key]).toMatchObject(expectedValue);
        } else {
          assert.equal(value[key], expectedValue);
        }
      }
    },
  };
}

recoveryBoundaryExpect.poll = (callback) => ({
  async toBe(expected) {
    recoveryBoundaryExpect(await callback()).toBe(expected);
  },
  async toEqual(expected) {
    recoveryBoundaryExpect(await callback()).toEqual(expected);
  },
  async toMatchObject(expected) {
    recoveryBoundaryExpect(await callback()).toMatchObject(expected);
  },
});

async function readSelectedRecoverySource() {
  const { readFile } = await import('node:fs/promises');
  return readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
}

async function runRegisteredCacheRecoveryBoundary(enabled) {
  const source = await readSelectedRecoverySource();
  const boundaryStart = source.indexOf('function selectedWindowsBoundary(');
  const boundaryEnd = source.indexOf(
    'function selectedSetupDiagnostics(',
    boundaryStart,
  );
  const caseStart = source.indexOf(
    "terminalCleanupTest(\n  'a cache-clear intent recovers",
  );
  const caseEnd = source.indexOf(
    "\ntest('loaded Task reset survives one queued-to-running",
    caseStart,
  );
  assert.ok(
    boundaryStart >= 0 &&
      boundaryEnd > boundaryStart &&
      caseStart >= 0 &&
      caseEnd > caseStart,
    'selected cache recovery seams missing',
  );
  const callbacks = [],
    closes = [],
    launches = [],
    records = [];
  let releaseFirstClose;
  const firstCloseEntered = new Promise((resolve) => {
    releaseFirstClose = resolve;
  });
  let continueFirstClose;
  const firstCloseReleased = new Promise((resolve) => {
    continueFirstClose = resolve;
  });
  const terminalCleanupTest = (title, callback) =>
    callbacks.push({ title, callback });
  const profile = {
    profileId: 'profile',
    storageGeneration: 1,
    metadataRevision: 1,
  };
  const tab = { id: 'tab', profile: { runtimeGeneration: 1 } };
  const window = {
    getByTestId: () => ({
      fill: async () => {},
      click: async () => {},
    }),
    evaluate: async (fn) => {
      const text = fn.toString();
      if (text.includes('profiles.list')) return { profiles: [profile] };
      if (text.includes('browser.create')) return tab;
      if (text.includes('previewClear')) return { token: 'token' };
      if (text.includes('jobGet'))
        return { status: 'failed', retryable: true, cancellable: false };
      return {};
    },
  };
  const firstApp = { id: 'first', evaluate: async () => {} };
  const secondApp = { id: 'second', evaluate: async () => {} };
  const stopAfterRestart = new Error('stop after selected restart');
  const context = {
    terminalCleanupTest,
    test: { setTimeout: () => {} },
    process: {
      env: enabled
        ? { CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '/diagnostics' }
        : {},
    },
    path: require('node:path'),
    createWindowsDiagnosticBasePath: (slug, directory) =>
      `${directory}/${slug}`,
    createBoundaryRecorder:
      () =>
      (...args) =>
        records.push(args),
    seedPanelWorktree: async () => ({
      electronApp: firstApp,
      userDataDir: '/owned',
      window,
      app: {
        openSettings: async () => {},
        openSettingsSection: async () => {},
      },
    }),
    fixtureCookies: async () => [],
    expect: recoveryBoundaryExpect,
    dispatchProfileAction: async () => ({
      ok: false,
      error: { code: 'operation_conflict' },
    }),
    randomUUID: () => 'operation',
    crypto: { randomUUID: () => 'update' },
    closeCanopy: async (electronApp, userDataDir, options) => {
      closes.push({ electronApp, userDataDir, options });
      if (electronApp === firstApp) {
        releaseFirstClose();
        await firstCloseReleased;
      }
    },
    launchCanopy: async (options) => {
      launches.push(options);
      options.boundaryRecord?.('viewport-set', { outcome: 'entered' });
      return { electronApp: secondApp };
    },
    getMainWindow: async () => {
      throw stopAfterRestart;
    },
    CanopyAppDriver: class {},
  };
  vm.runInNewContext(
    `${source.slice(boundaryStart, boundaryEnd)}\n${source.slice(caseStart, caseEnd)}`,
    context,
  );
  assert.equal(callbacks.length, 1);
  const run = callbacks[0].callback({
    runTerminalCleanup: async (cleanup) => cleanup(),
  });
  await firstCloseEntered;
  assert.equal(launches.length, 0);
  continueFirstClose();
  await assert.rejects(run, (error) => error === stopAfterRestart);
  return { callbacks, closes, launches, records };
}

async function runLoadedTaskRecoveryBoundary(
  enabled,
  {
    slug = 'worktree',
    entryIndex = null,
    advisorSetupCloseDiagnostic = false,
    seedError,
    diagnosticError,
    setupCleanupError,
  } = {},
) {
  const source = await readSelectedRecoverySource();
  const boundaryStart = source.indexOf('function selectedWindowsBoundary(');
  const boundaryEnd = source.indexOf(
    'function selectedSetupDiagnostics(',
    boundaryStart,
  );
  const helperStart = source.indexOf(
    'async function runLoadedTaskResetOwnerCase(',
  );
  const helperEnd = source.indexOf('\nfor (const ownerCase of [', helperStart);
  assert.ok(
    boundaryStart >= 0 &&
      boundaryEnd > boundaryStart &&
      helperStart >= 0 &&
      helperEnd > helperStart,
    'selected loaded Task recovery seams missing',
  );
  const closes = [],
    launches = [],
    seedLaunches = [],
    creationBoundaries = [],
    records = [],
    events = [];
  const primary = new Error('exact URL predicate failed');
  const cleanup = new Error('final close failed');
  const profile = {
    profileId: 'profile',
    kind: 'task',
    storageGeneration: 1,
    metadataRevision: 1,
    owner: { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
  };
  const tab = {
    id: 'tab',
    profile: { resolvedProfileId: profile.profileId },
  };
  let profileReads = 0;
  const window = {
    evaluate: async (fn) => {
      const text = fn.toString();
      if (text.includes('browser.create')) return tab;
      if (text.includes('profiles.get')) {
        profileReads += 1;
        return profileReads === 1
          ? profile
          : {
              ...profile,
              storageGeneration: 2,
              agentPermissions: { allowEnable: true, allowClear: true },
            };
      }
      if (text.includes('profiles.update'))
        return { ...profile, agentPermissions: { allowClear: true } };
      if (text.includes('previewClear'))
        return { token: 'token', tabs: [{ browserId: tab.id }] };
      if (text.includes('jobGet')) return { status: 'complete' };
      return {};
    },
  };
  const firstApp = { id: 'first', evaluate: async () => {} };
  const secondApp = {
    id: 'second',
    evaluate: async (fn) => {
      if (fn.toString().includes('differentSession')) throw primary;
    },
  };
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const context = {
    reportOwnedSetupFailure: lifecycle.reportOwnedSetupFailure,
    createWorktreeSelectionFailureDiagnostic: (slug) => async (context) => {
      events.push({
        type: 'selection-diagnostic',
        slug,
        branch: context.branch,
      });
      if (diagnosticError) throw diagnosticError;
    },
    test: {
      info: () => ({
        attach: async () => {
          events.push({ type: 'cleanup-attachment' });
        },
      }),
    },
    Buffer,
    console,
    require: (name) => {
      if (name === './seeders/browser-profile-state.mjs')
        return {
          seedBrowserProfileEntryOwners: async () => [
            { projectId: 'cowork', worktreeId: 'entry' },
            { projectId: 'advisor', worktreeId: 'entry' },
          ],
        };
      throw new Error(`Unexpected import ${name}`);
    },
    process: {
      env: {
        ...(enabled
          ? { CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '/diagnostics' }
          : {}),
        ...(advisorSetupCloseDiagnostic
          ? { CANOPY_WINDOWS_ADVISOR_SETUP_CLOSE_DIAGNOSTIC: '1' }
          : {}),
      },
    },
    path: require('node:path'),
    createWindowsDiagnosticBasePath: (slug, directory) =>
      `${directory}/${slug}`,
    createBoundaryRecorder:
      () =>
      (...args) => {
        records.push(args);
        events.push({ type: 'record', stage: args[0] });
      },
    createSelectedLaunchBoundary: (caseId, label, options) => {
      const record = enabled
        ? (...args) => {
            records.push(args);
            events.push({ type: 'record', stage: args[0] });
          }
        : undefined;
      const boundary = {
        caseId,
        label,
        owners: options.owners,
        record,
        options: enabled
          ? {
              env: {
                CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
                  file: `/diagnostics/${caseId}-${label}-main.jsonl`,
                  mode: 'close',
                  caseId,
                  launchId: `${caseId}-${label}-fixture`,
                  fixturePid: 17,
                  owners: options.owners,
                }),
              },
            }
          : {},
        close: (owner, closeOptions) =>
          options.close(owner.electronApp, owner.userDataDir, {
            ...closeOptions,
            boundaryRecord: record,
          }),
      };
      creationBoundaries.push(boundary);
      return boundary;
    },
    boundedCleanupErrorMessage: (error) =>
      String(error?.message ?? error).slice(0, 4096),
    seedPanelWorktree: async (options) => {
      seedLaunches.push(options);
      events.push({ type: 'seed-launch' });
      if (seedError) {
        try {
          await options?.onSetupFailure?.({
            electronApp: firstApp,
            userDataDir: '/owned',
            window,
            branch: 'demo-main',
            error: seedError,
          });
        } catch {
          /* seeder preserves primary error */
        }
        throw seedError;
      }
      return {
        electronApp: firstApp,
        userDataDir: '/owned',
        window,
        app: {},
      };
    },
    closeCanopy: async (electronApp, userDataDir, options) => {
      closes.push({ electronApp, userDataDir, options });
      events.push({ type: 'close', applicationId: electronApp.id });
      if (electronApp === firstApp && options?.boundaryRecord) {
        events.push({ type: 'direct-target-exit', applicationId: 'first' });
        events.push({ type: 'direct-stdio-close', applicationId: 'first' });
        events.push({
          type: 'ownership-final-result',
          applicationId: 'first',
          status: 'verified-empty',
        });
      }
      if (electronApp === firstApp && setupCleanupError)
        throw setupCleanupError;
      if (electronApp === secondApp) throw cleanup;
    },
    launchCanopy: async (options) => {
      launches.push(options);
      events.push({ type: 'reused-data-launch' });
      options.boundaryRecord?.('viewport-set', { outcome: 'entered' });
      return { electronApp: secondApp };
    },
    getMainWindow: async () => window,
    CanopyAppDriver: class {
      async waitForShell() {}
      async openSettings() {}
      async openSettingsSection() {}
    },
    fixtureCookies: async () => [],
    expect: recoveryBoundaryExpect,
    randomUUID: () => 'operation',
    crypto: { randomUUID: () => 'update' },
  };
  const ts = require('typescript');
  const compiled = ts.transpileModule(
    `${source.slice(source.indexOf('async function closeProfileSetupFailure('), source.indexOf('async function sendCancelableDebuggerCommand('))}\n${source.slice(boundaryStart, boundaryEnd)}\n${source.slice(helperStart, helperEnd)}\nglobalThis.runLoadedTaskResetOwnerCase = runLoadedTaskResetOwnerCase;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  vm.runInNewContext(compiled, context);
  await assert.rejects(
    context.runLoadedTaskResetOwnerCase({ slug, entryIndex }),
    (error) => error === (seedError ?? cleanup),
  );
  return {
    closes,
    launches,
    seedLaunches,
    creationBoundaries,
    records,
    events,
    primary,
    cleanup,
  };
}

test('selected cache recovery routes one recorder through first close, restart, and final close', async () => {
  const value = await runRegisteredCacheRecoveryBoundary(true);
  assert.equal(value.closes.length, 2);
  assert.equal(value.launches.length, 1);
  const record = value.closes[0].options.boundaryRecord;
  assert.equal(typeof record, 'function');
  assert.equal(value.launches[0].boundaryRecord, record);
  assert.equal(value.closes[1].options.boundaryRecord, record);
  assert.ok(
    value.records.some(
      ([stage, metadata]) =>
        stage === 'viewport-set' && metadata.outcome === 'entered',
    ),
  );
});

test('selected loaded Task recovery preserves primary evidence while final cleanup keeps existing precedence', async () => {
  const value = await runLoadedTaskRecoveryBoundary(true);
  assert.equal(value.creationBoundaries.length, 1);
  assert.equal(value.creationBoundaries[0].label, 'setup');
  const setupConfig = JSON.parse(
    value.seedLaunches[0].env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
  );
  assert.equal(setupConfig.mode, 'close');
  assert.deepEqual(setupConfig.owners, [
    { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
  ]);
  assert.equal(value.closes.length, 2);
  assert.equal(value.launches.length, 1);
  const setupRecord = value.closes[0].options.boundaryRecord;
  const reusedDataRecord = value.launches[0].boundaryRecord;
  assert.equal(typeof setupRecord, 'function');
  assert.equal(typeof reusedDataRecord, 'function');
  assert.notEqual(setupRecord, reusedDataRecord);
  assert.equal(value.closes[1].options.boundaryRecord, reusedDataRecord);
  assert.ok(
    value.records.some(
      ([stage, metadata]) =>
        stage === 'case-body-rejected' &&
        metadata.owner.projectId === 'demo-ts-pnpm-vite' &&
        metadata.slug === 'worktree' &&
        metadata.message === value.primary.message,
    ),
    JSON.stringify(value.records),
  );
  assert.ok(value.records.some(([stage]) => stage === 'viewport-set'));
  const terminalIndex = value.events.findIndex(
    (event) =>
      event.type === 'ownership-final-result' &&
      event.status === 'verified-empty',
  );
  const relaunchIndex = value.events.findIndex(
    (event) => event.type === 'reused-data-launch',
  );
  assert.ok(terminalIndex >= 0 && terminalIndex < relaunchIndex);
  assert.ok(
    value.events.findIndex((event) => event.type === 'direct-target-exit') <
      terminalIndex,
  );
  assert.ok(
    value.events.findIndex((event) => event.type === 'direct-stdio-close') <
      terminalIndex,
  );
  assert.ok(
    value.events.findIndex(
      (event) =>
        event.type === 'record' && event.stage === 'case-body-rejected',
    ) <
      value.events.findIndex(
        (event) => event.type === 'close' && event.applicationId === 'second',
      ),
  );
});

test('advisor loaded Task recovery defaults to plain awaited setup close before relaunch', async () => {
  const value = await runLoadedTaskRecoveryBoundary(true, {
    slug: 'advisor',
    entryIndex: 1,
  });
  assert.equal(value.creationBoundaries.length, 0);
  assert.equal(value.seedLaunches[0], undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(value.closes[0].options)), {
    keepUserData: true,
  });
  assert.equal(
    value.events.some((event) => event.type === 'ownership-final-result'),
    false,
  );
  assert.ok(
    value.events.findIndex(
      (event) => event.type === 'close' && event.applicationId === 'first',
    ) < value.events.findIndex((event) => event.type === 'reused-data-launch'),
  );
  assert.equal(typeof value.closes[1].options.boundaryRecord, 'function');
});

test('advisor loaded Task recovery preserves creation-bound setup observer only with exact opt-in', async () => {
  const value = await runLoadedTaskRecoveryBoundary(true, {
    slug: 'advisor',
    entryIndex: 1,
    advisorSetupCloseDiagnostic: true,
  });
  assert.equal(value.creationBoundaries.length, 1);
  const setup = JSON.parse(
    value.seedLaunches[0].env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
  );
  assert.equal(setup.mode, 'close');
  assert.equal(typeof value.closes[0].options.boundaryRecord, 'function');
  assert.ok(
    value.events.findIndex((event) => event.type === 'ownership-final-result') <
      value.events.findIndex((event) => event.type === 'reused-data-launch'),
  );
});

test('cowork loaded Task recovery retains the existing creation-bound setup observer', async () => {
  const value = await runLoadedTaskRecoveryBoundary(true, {
    slug: 'cowork',
    entryIndex: 0,
  });
  assert.equal(value.creationBoundaries.length, 1);
  assert.equal(typeof value.closes[0].options.boundaryRecord, 'function');
});

test('selected recovery boundary diagnostics remain inert when unselected', async () => {
  const cache = await runRegisteredCacheRecoveryBoundary(false);
  const loaded = await runLoadedTaskRecoveryBoundary(false);
  assert.equal(cache.records.length, 0);
  assert.equal(loaded.records.length, 0);
  assert.equal(typeof loaded.seedLaunches[0].onSetupFailure, 'function');
  assert.deepEqual(Object.keys(loaded.seedLaunches[0]), ['onSetupFailure']);
  assert.equal(cache.closes[0].options?.boundaryRecord, undefined);
  assert.equal(cache.launches[0].boundaryRecord, undefined);
  assert.equal(cache.closes[1].options?.boundaryRecord, undefined);
  assert.equal(loaded.closes[0].options?.boundaryRecord, undefined);
  assert.equal(loaded.launches[0].boundaryRecord, undefined);
  assert.equal(loaded.closes[1].options?.boundaryRecord, undefined);
  assert.equal(Object.hasOwn(loaded.launches[0], 'env'), false);
  assert.equal(Object.hasOwn(cache.launches[0], 'boundaryRecord'), false);
  assert.equal(Object.hasOwn(loaded.launches[0], 'boundaryRecord'), false);
});

async function readSharedProfileWorkerSource() {
  const { readFile } = await import('node:fs/promises');
  return readFile(
    integratedDiagnosticSource(
      'apps/desktop-app/tests/electron/browser-profiles.spec.mjs',
      new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    ),
    'utf8',
  );
}

async function runRegisteredSharedProfileWorkerBoundary(
  enabled,
  { deferServerListen = false, onListenPending, serverListenFailure } = {},
) {
  const source = await readSharedProfileWorkerSource();
  const { readFile } = await import('node:fs/promises');
  const lifecycleSource = await readFile(
    new URL('../electron/browser-profile-test-lifecycle.mjs', import.meta.url),
    'utf8',
  );
  const observerStart = lifecycleSource.indexOf(
    'export function observeBoundary(',
  );
  const observerEnd = lifecycleSource.indexOf(
    '// This observer owns only fixture-local server/socket state',
    observerStart,
  );
  const helperStart = source.indexOf('function selectedWindowsBoundary(');
  const helperEnd = source.indexOf(
    'function selectedSetupDiagnostics(',
    helperStart,
  );
  const caseStart = source.indexOf(
    "test('shared-profile clearing enforces both agent routes",
  );
  const caseEnd = source.indexOf('\nterminalCleanupTest(', caseStart);
  assert.ok(
    helperStart >= 0 &&
      helperEnd > helperStart &&
      caseStart >= 0 &&
      caseEnd > caseStart &&
      observerStart >= 0 &&
      observerEnd > observerStart,
    'shared-profile worker seams missing',
  );
  const observerSource = lifecycleSource
    .slice(observerStart, observerEnd)
    .replace('export function observeBoundary(', 'function observeBoundary(');
  const callbacks = new Map(),
    closes = [],
    launches = [],
    records = [],
    events = [];
  const primary = new Error('settings browser readiness failed');
  const cleanup = new Error('final close failed');
  const processTarget = new EventEmitter();
  Object.assign(processTarget, {
    env: enabled
      ? { CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '/diagnostics' }
      : {},
    pid: 4312,
    ppid: 217,
  });
  let infoReads = 0;
  const test = (title, callback) => callbacks.set(title, callback);
  test.setTimeout = (timeout) => assert.equal(timeout, 120_000);
  test.info = () => {
    infoReads += 1;
    return { workerIndex: 3, parallelIndex: 2 };
  };
  let resolveListenEntered, finishServerListen;
  const listenEntered = new Promise((resolve) => {
    resolveListenEntered = resolve;
  });
  const server = {
    listen(_port, _host, callback) {
      events.push({ type: 'operation', stage: 'server-listen' });
      if (serverListenFailure) throw serverListenFailure;
      if (deferServerListen) {
        finishServerListen = callback;
        resolveListenEntered();
        return;
      }
      callback();
    },
    address: () => ({ port: 4011 }),
    closeAllConnections() {
      events.push({ type: 'operation', stage: 'server-close-all' });
    },
    close(callback) {
      events.push({ type: 'operation', stage: 'server-close' });
      callback();
    },
  };
  const firstApp = { id: 'first' };
  const secondApp = { id: 'second' };
  const window = {};
  const recorder = (...args) => {
    records.push(args);
    events.push({ type: 'record', stage: args[0] });
  };
  const ts = require('typescript');
  const js = ts.transpileModule(
    `${observerSource}\n${source.slice(helperStart, helperEnd)}\n${source.slice(caseStart, caseEnd)}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  vm.runInNewContext(js, {
    test,
    process: processTarget,
    require: (name) => {
      if (name === 'node:http') return { createServer: () => server };
      if (name === './seeders/browser-profile-state.mjs')
        return {
          seedBrowserProfileEntryOwners: async () => [
            { projectId: 'cowork', worktreeId: 'entry' },
          ],
        };
      throw new Error(`Unexpected import ${name}`);
    },
    path: require('node:path'),
    createWindowsDiagnosticBasePath: (slug, directory) =>
      `${directory}/${slug}`,
    createBoundaryRecorder: () => recorder,
    boundedCleanupErrorMessage: (error) =>
      String(error?.message ?? error).slice(0, 4096),
    createWorktreeSelectionFailureDiagnostic: () => ({}),
    retainSelectionFailureOwner: () => async () => {},
    seedPanelWorktree: async () => {
      events.push({ type: 'operation', stage: 'panel-seed' });
      return {
        electronApp: firstApp,
        userDataDir: '/owned',
        window,
        app: {},
      };
    },
    closeCanopy: async (electronApp, userDataDir, options) => {
      assert.equal(userDataDir, '/owned');
      closes.push({ electronApp, options });
      events.push({ type: 'operation', stage: `close-${electronApp.id}` });
      options?.boundaryRecord?.('electronApp.close', {
        outcome: 'entered',
      });
      if (electronApp === secondApp) throw cleanup;
    },
    launchCanopy: async (options) => {
      launches.push(options);
      events.push({ type: 'operation', stage: 'second-launch' });
      options.boundaryRecord?.('viewport-set', { outcome: 'entered' });
      return { electronApp: secondApp };
    },
    getMainWindow: async () => window,
    CanopyAppDriver: class {
      async waitForShell() {}
      async openSettings() {}
      async openSettingsSection() {
        throw primary;
      }
    },
    expect: () => {
      throw new Error('Shared-profile assertions must not run after failure');
    },
    randomUUID: () => 'operation',
    dispatchProfileAction: async () => {
      throw new Error('Profile actions must not run after failure');
    },
    console: { error: () => {} },
    setTimeout,
    clearTimeout,
  });
  const callback = callbacks.get(
    'shared-profile clearing enforces both agent routes, stops writers, and preserves another account',
  );
  assert.equal(typeof callback, 'function');
  const run = callback();
  if (deferServerListen) {
    await listenEntered;
    await onListenPending?.({ events, processTarget, records });
    finishServerListen();
  }
  await assert.rejects(
    run,
    (error) => error === (serverListenFailure ?? primary),
  );
  return {
    cleanup,
    closes,
    events,
    infoReads,
    launches,
    processTarget,
    recorder,
    records,
  };
}

test('selected shared-profile worker keeps deferred server listen pending until the actual promise settles', async () => {
  const value = await runRegisteredSharedProfileWorkerBoundary(true, {
    deferServerListen: true,
    onListenPending: ({ processTarget, records }) => {
      assert.equal(processTarget.listenerCount('exit'), 1);
      assert.deepEqual(
        records.map(([stage, details]) => [stage, details.outcome]),
        [
          ['worker-case-entered', undefined],
          ['server-listen', 'entered'],
        ],
      );
    },
  });
  assert.deepEqual(
    value.records
      .filter(([stage]) => stage === 'server-listen')
      .map(([, details]) => details.outcome),
    ['entered', 'fulfilled'],
  );
  assert.equal(value.processTarget.listenerCount('exit'), 0);
  assert.equal(value.records.at(-1)[0], 'worker-case-released');
});

test('selected shared-profile worker records existing milestones and releases after rejecting cleanup', async () => {
  const value = await runRegisteredSharedProfileWorkerBoundary(true);
  assert.equal(value.infoReads, 1);
  assert.equal(value.processTarget.listenerCount('exit'), 0);
  assert.equal(value.closes.length, 2);
  assert.equal(value.launches.length, 1);
  assert.equal(value.closes[0].options.boundaryRecord, value.recorder);
  assert.equal(value.launches[0].boundaryRecord, value.recorder);
  assert.equal(value.closes[1].options.boundaryRecord, value.recorder);
  assert.deepEqual(
    value.records.slice(0, 3).map(([stage]) => stage),
    ['worker-case-entered', 'server-listen', 'server-listen'],
  );
  const bodyRejected = value.events.findIndex(
    (event) =>
      event.type === 'record' && event.stage === 'worker-case-body-rejected',
  );
  const finalClose = value.events.findIndex(
    (event) => event.type === 'operation' && event.stage === 'close-second',
  );
  const released = value.events.findIndex(
    (event) =>
      event.type === 'record' && event.stage === 'worker-case-released',
  );
  assert.ok(bodyRejected >= 0 && bodyRejected < finalClose);
  assert.ok(released > finalClose);
  assert.equal(
    value.records.find(([stage]) => stage === 'worker-case-body-rejected')[1]
      .message,
    'settings browser readiness failed',
  );
});

test('selected shared-profile worker releases its exact listener when server setup rejects', async () => {
  const serverListenFailure = new Error('server listen failed');
  const value = await runRegisteredSharedProfileWorkerBoundary(true, {
    serverListenFailure,
  });
  assert.equal(value.processTarget.listenerCount('exit'), 0);
  assert.deepEqual(
    value.records
      .filter(([stage]) => stage === 'server-listen')
      .map(([, details]) => details.outcome),
    ['entered', 'rejected'],
  );
  const rejection = value.records.find(
    ([stage, details]) =>
      stage === 'server-listen' && details.outcome === 'rejected',
  );
  assert.equal(rejection[1].message, serverListenFailure.message);
  assert.equal(value.records.at(-1)[0], 'worker-case-released');
  assert.equal(value.closes.length, 0);
  assert.equal(value.launches.length, 0);
});

test('shared-profile worker boundary records normal exit and exact idempotent release without fabricating abrupt evidence', async () => {
  const source = await readSharedProfileWorkerSource();
  const start = source.indexOf('function boundedWorkerBoundaryIndex(');
  const end = source.indexOf('function selectedSetupDiagnostics(', start);
  assert.ok(start >= 0 && end > start, 'worker boundary helper missing');
  const evaluate = (rows, processTarget, testInfo) =>
    vm.runInNewContext(
      `${source.slice(start, end)}\ncreateSelectedWorkerBoundary({ record: (...args) => rows.push(args) }, 'shared-profile-clear', process, () => testInfo)`,
      { process: processTarget, rows, testInfo },
    );

  const normalRows = [];
  const normalProcess = new EventEmitter();
  Object.assign(normalProcess, { pid: 41, ppid: 7 });
  const normal = evaluate(normalRows, normalProcess, {
    workerIndex: 2,
    parallelIndex: 1,
  });
  assert.equal(normalProcess.listenerCount('exit'), 1);
  normalProcess.emit('exit', 9);
  assert.deepEqual(
    normalRows.map(([stage]) => stage),
    ['worker-case-entered', 'worker-process-exit'],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(normalRows[0][1])), {
    slug: 'shared-profile-clear',
    pid: 41,
    ppid: 7,
    workerIndex: 2,
    parallelIndex: 1,
  });
  normal.release();
  normal.release();
  assert.equal(normalProcess.listenerCount('exit'), 0);
  assert.equal(
    normalRows.filter(([stage]) => stage === 'worker-case-released').length,
    1,
  );

  const abruptRows = [];
  const abruptProcess = new EventEmitter();
  Object.assign(abruptProcess, { pid: 42, ppid: 8 });
  evaluate(abruptRows, abruptProcess, {
    workerIndex: Number.MAX_SAFE_INTEGER,
    parallelIndex: {},
  });
  assert.deepEqual(
    abruptRows.map(([stage]) => stage),
    ['worker-case-entered'],
  );
  assert.equal(abruptRows[0][1].workerIndex, null);
  assert.equal(abruptRows[0][1].parallelIndex, null);
  assert.equal(abruptProcess.listenerCount('exit'), 1);

  const disabledError = new Error('disabled operation failed');
  const disabledPromise = Promise.reject(disabledError);
  void disabledPromise.catch(() => {});
  const disabledState = { calls: 0 };
  const disabledResult = vm.runInNewContext(
    `${source.slice(start, end)}\nobserveSelectedWorkerBoundary(undefined, 'disabled', () => { state.calls += 1; return promise; })`,
    {
      process: new EventEmitter(),
      promise: disabledPromise,
      state: disabledState,
    },
  );
  assert.equal(disabledResult, disabledPromise);
  assert.equal(disabledState.calls, 1);
  await assert.rejects(disabledResult, (error) => error === disabledError);
});

test('shared-profile worker boundary remains inert when diagnostics are disabled', async () => {
  const value = await runRegisteredSharedProfileWorkerBoundary(false);
  assert.equal(value.infoReads, 0);
  assert.equal(value.records.length, 0);
  assert.equal(value.processTarget.listenerCount('exit'), 0);
  assert.equal(value.closes[0].options?.boundaryRecord, undefined);
  assert.equal(value.closes[1].options?.boundaryRecord, undefined);
  assert.equal(Object.hasOwn(value.launches[0], 'boundaryRecord'), false);
});

test('disabled shared-profile worker final storage keeps the original inline rejection path', async () => {
  const source = await readSharedProfileWorkerSource();
  const caseStart = source.indexOf(
    "test('shared-profile clearing enforces both agent routes",
  );
  const selectedStart = source.indexOf('    if (workerBoundary) {', caseStart);
  const wrappedStart = source.indexOf(
    "    await observeSelectedWorkerBoundary(\n      workerBoundary,\n      'final-storage-assertions',",
    caseStart,
  );
  const start = selectedStart >= 0 ? selectedStart : wrappedStart;
  const end = source.indexOf(
    '    const replay = await dispatchProfileAction(',
    start,
  );
  assert.ok(start >= 0 && end > start, 'final storage assertion seam missing');
  const rejection = new Error('disabled final storage failed');
  const state = { observations: 0 };
  const ts = require('typescript');
  const js = ts.transpileModule(
    `(async () => {\n${source.slice(start, end)}\n})()`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  await assert.rejects(
    vm.runInNewContext(js, {
      workerBoundary: undefined,
      observeSelectedWorkerBoundary: (_boundary, _stage, operation) => {
        state.observations += 1;
        return operation();
      },
      expect: {
        poll: () => ({
          toEqual: async () => {
            throw rejection;
          },
        }),
      },
      read: async () => ({}),
    }),
    (error) => error === rejection,
  );
  assert.equal(state.observations, 0);
});

async function runRegisteredW1CloseDiagnostic(
  ownerKind,
  enabled,
  {
    firstCloseCheckpoint,
    firstCloseExpectedError,
    panelSelectionError,
    attachmentError,
    advisorCatalogFactory,
    useRealBoundaryRecorder = false,
    prelaunchCatalogError,
    coworkPollError,
    coworkPasses = false,
    coworkCatalog,
    coworkRefreshError,
    coworkSerializationError,
    authDirectoryUnavailable = false,
  } = {},
) {
  const { readFile } = await import('node:fs/promises');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const nodePath = await import('node:path');
  const source = await readFile(
    new URL('../electron/browser-chrome.spec.mjs', import.meta.url),
    'utf8',
  );
  const diagnosticStart = source.indexOf('function boundedAdvisorCatalog(');
  const helper = source.slice(
    diagnosticStart >= 0
      ? diagnosticStart
      : source.indexOf('async function seedLegacyReviewOwner('),
    source.indexOf('async function selectLegacyReviewOwner('),
  );
  const marker = "for (const ownerKind of ['worktree', 'cowork', 'advisor']) {";
  const start = source.lastIndexOf(
    marker,
    source.indexOf('test(`W1 precommit'),
  );
  const callbacks = new Map(),
    launches = [],
    closes = [],
    events = [],
    selectedBoundaries = [],
    records = [],
    boundaryRecords = [],
    catalogCalls = [],
    attachments = [],
    mkdirs = [];
  let coworkCatalogReadCount = 0;
  const recorderDirectory = mkdtempSync(
    nodePath.join(tmpdir(), 'advisor-selection-recorder-'),
  );
  const realBoundaryFile = nodePath.join(recorderDirectory, 'boundary.jsonl');
  const primary = new Error('stop after real fixture setup');
  const recorder = (...args) => records.push(args);
  let applicationId = 0;
  const createElectronApp = () => ({
    applicationId: ++applicationId,
    evaluate: async (fn) => {
      const text = fn.toString();
      if (text.includes('const paths =')) return ['/owned/a', '/owned/b'];
      if (text.includes("kind: 'create'"))
        return {
          url: 'http://fixture',
          authToken: 'fixture',
          sessionKey: 'fixture',
        };
      if (text.includes('return fixture.count')) return 0;
      return undefined;
    },
  });
  const fs = {
    mkdirSync: (...args) => {
      if (authDirectoryUnavailable && args[0] === '/diagnostics')
        throw new Error('auth directory unavailable');
      mkdirs.push(args);
    },
    rmSync() {
      events.push({ type: 'conflict-removed' });
    },
  };
  const test = (title, callback) => callbacks.set(title, callback);
  test.setTimeout = (value) => assert.equal(value, 180000);
  const expectation = (value) => ({
    toBe: (expected) => assert.equal(value, expected),
    toBeUndefined: () => assert.equal(value, undefined),
    toContain: (expected) => assert.ok(value.includes(expected)),
  });
  expectation.poll = (read) => ({
    toContain: async (expected) => {
      const value = await read();
      if (coworkPollError) throw coworkPollError;
      if (coworkPasses) assert.ok(value.includes(expected));
    },
  });
  const ts = require('typescript');
  const js = ts.transpileModule(
    `const ADVISOR_INITIAL_SELECTION_METADATA_LIMIT = 12 * 1024;\n${helper}\n${source.slice(start)}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  vm.runInNewContext(js, {
    require: (name) => {
      if (name === 'node:fs') return fs;
      if (name === './launchCanopy.mjs')
        return {
          launchCanopy: async (options) => {
            const launched = {
              electronApp: createElectronApp(),
              userDataDir: '/owned',
            };
            launches.push({ kind: 'direct', options, launched });
            events.push({
              type: 'launch',
              applicationId: launched.electronApp.applicationId,
            });
            return launched;
          },
        };
      if (name === './seeders/browser-profile-state.mjs')
        return {
          seedBrowserProfileEntryOwners: async () => [
            { projectId: 'work', worktreeId: 'entry' },
            { projectId: 'app-advisor', worktreeId: 'entry' },
          ],
        };
      throw new Error(`Unexpected import ${name}`);
    },
    test,
    process: {
      env: enabled
        ? { CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: '/diagnostics' }
        : {},
      pid: 12,
    },
    path: nodePath,
    randomUUID: () => 'fixture',
    mkdirSync: fs.mkdirSync,
    createBoundaryRecorder: () => recorder,
    createSelectedLaunchBoundary: (caseId, label, options) => {
      const launchId = `${caseId}-${label}-12-fixture`;
      const record = enabled
        ? useRealBoundaryRecorder
          ? lifecycle.createBoundaryRecorder(realBoundaryFile)
          : (...args) => boundaryRecords.push({ caseId, args })
        : undefined;
      const mainFile = enabled
        ? nodePath.resolve('/diagnostics', `${launchId}-main.jsonl`)
        : undefined;
      const firstProjectsLoadFile =
        enabled && options.firstProjectsLoad
          ? nodePath.resolve(
              '/diagnostics',
              `${launchId}-first-projects-load.jsonl`,
            )
          : undefined;
      const boundary = {
        caseId,
        label,
        owners: options.owners,
        firstProjectsLoad: options.firstProjectsLoad,
        launchId,
        mainFile,
        firstProjectsLoadFile,
        record,
        options: {
          ...(mainFile
            ? {
                env: {
                  CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
                    file: mainFile,
                    mode: 'close',
                    caseId,
                    launchId,
                    fixturePid: 12,
                    owners: options.owners,
                    ...(firstProjectsLoadFile
                      ? {
                          firstProjectsLoad: true,
                          firstProjectsLoadFile,
                        }
                      : {}),
                  }),
                },
              }
            : {}),
          ...(firstProjectsLoadFile
            ? {
                onBeforeLaunch: () => {
                  events.push({ type: 'first-projects-load-prelaunch' });
                },
              }
            : {}),
          onSetupFailure: async (context) => {
            events.push({
              type: 'setup-failure',
              applicationId: context.electronApp.applicationId,
            });
            try {
              await boundary.close(context);
            } catch {
              /* Preserve the setup failure like reportOwnedSetupFailure. */
            }
            throw context.error;
          },
        },
        close: (owner, closeOptions) =>
          options.close(owner.electronApp, owner.userDataDir, {
            ...closeOptions,
            boundaryRecord: record,
          }),
      };
      selectedBoundaries.push(boundary);
      return boundary;
    },
    observeBoundary: lifecycle.observeBoundary,
    seedPanelWorktree: async (options) => {
      try {
        options.onBeforeLaunch?.({
          userDataDir: '/owned',
          workspaceIds: ['demo-ts-pnpm-vite'],
        });
      } catch {
        /* The real setup fixture treats prelaunch observation as best effort. */
      }
      const launched = {
        electronApp: createElectronApp(),
        userDataDir: '/owned',
      };
      launches.push({ kind: 'panel-seed', options, launched });
      events.push({
        type: 'launch',
        applicationId: launched.electronApp.applicationId,
      });
      if (panelSelectionError) {
        const window = {
          evaluate: async (fn) =>
            fn.toString().includes('appAdvisor.getState')
              ? {
                  version: 1,
                  revision: 7,
                  digest: 'digest',
                  snapshot: {
                    activePage: 'main',
                    selectedWorktree: null,
                  },
                }
              : {
                  rows: [],
                  expectedWorktreeId: 'demo-main',
                  matchingRowCount: 0,
                  matchingVisibleRowCount: 0,
                  pageMain: { present: true, visible: true },
                  activeSidebar: [],
                  href: 'canopy://app/main',
                  visibilityState: 'visible',
                  focused: true,
                },
          locator: () => ({
            screenshot: async () => Buffer.from('png'),
          }),
        };
        const context = {
          ...launched,
          window,
          app: {},
          branch: 'demo-main',
          error: panelSelectionError,
        };
        try {
          await options.onSelectWorktreeFailure?.(context);
        } catch {
          /* The real fixture treats observation as best effort. */
        }
        try {
          await options.onSetupFailure?.(context);
        } catch {
          /* The original selection error remains authoritative. */
        }
        throw panelSelectionError;
      }
      return launched;
    },
    closeCanopy: async (app, dir, options) => {
      assert.equal(dir, '/owned');
      const close = {
        applicationId: app.applicationId,
        app,
        dir,
        options,
      };
      closes.push(close);
      events.push({ type: 'close-entered', applicationId: app.applicationId });
      if (app.applicationId === 1 && firstCloseCheckpoint) {
        let resolveGate, rejectGate;
        const gate = new Promise((resolve, reject) => {
          resolveGate = resolve;
          rejectGate = reject;
        });
        void gate.catch(() => {});
        try {
          await firstCloseCheckpoint({
            launches,
            closes,
            events,
            boundaryRecords,
            resolve: resolveGate,
            reject: rejectGate,
          });
        } catch (error) {
          rejectGate(error);
        }
        try {
          await gate;
        } catch (error) {
          events.push({
            type: 'close-rejected',
            applicationId: app.applicationId,
          });
          throw error;
        }
      }
      events.push({
        type: 'close-fulfilled',
        applicationId: app.applicationId,
      });
    },
    readFileSync: (file) => {
      if (String(file).endsWith('/browser-profiles/catalog.json')) {
        coworkCatalogReadCount += 1;
        events.push({
          type: 'cowork-catalog-read',
          index: coworkCatalogReadCount,
        });
        if (coworkRefreshError && coworkCatalogReadCount > 1)
          throw coworkRefreshError;
        return JSON.stringify(coworkCatalog ?? { retirements: {} });
      }
      return JSON.stringify({ scripts: {} });
    },
    writeFileSync() {},
    startLocalPages: async () => ({ port: 4000, close: async () => {} }),
    getMainWindow: async () => ({
      evaluate: async () => ({ profileId: 'profile', storageGeneration: 1 }),
    }),
    CanopyAppDriver: class {
      async waitForShell() {}
    },
    expect: expectation,
    fetch: async () => ({
      status: 200,
      json: async () => ({
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      }),
    }),
    AbortSignal,
    selectLegacyReviewOwner: async () => {
      if (!coworkPollError && !coworkPasses) throw primary;
      const action = {
        hover: async () => {},
        click: async () => {},
        getByTestId: () => action,
      };
      return {
        getByTestId: () => action,
        keyboard: { press: async () => {} },
        evaluate: async () => ({
          text: 'canopy-browser-auth=release-128 local=durable-local-value',
        }),
      };
    },
    addLegacyReviewBrowser: async () => ({ browserId: 'legacy-browser' }),
    navigatePane: async () => {},
    captureWorktreeArchiveFailure: async () => {},
    captureFixtureCatalog: (userDataDir, workspaceIds) => {
      catalogCalls.push({ userDataDir, workspaceIds });
      if (prelaunchCatalogError && catalogCalls.length === 1)
        throw prelaunchCatalogError;
      return advisorCatalogFactory
        ? advisorCatalogFactory({ userDataDir, workspaceIds })
        : { userDataDir, workspaceIds, files: [] };
    },
    settleFailureEvidence: async (promise, _timeout, unavailable) => {
      try {
        return await promise;
      } catch (error) {
        return {
          unavailable,
          error: String(error?.message ?? error).slice(0, 512),
        };
      }
    },
    serializeArchiveFailureMetadata: (metadata) => {
      if (coworkSerializationError) throw coworkSerializationError;
      return Buffer.from(JSON.stringify(metadata));
    },
    boundedFailureValue: (value, limit = 512) =>
      typeof value === 'string' ? value.slice(0, limit) : value,
    ARCHIVE_FAILURE_METADATA_LIMIT: 32 * 1024,
    Buffer,
  });
  const callback = callbacks.get(
    `W1 precommit ${ownerKind} retirement abort retains legacy login for first browser open`,
  );
  assert.equal(typeof callback, 'function');
  const testInfo = {
    attach: async (...args) => {
      attachments.push(args);
      events.push({ type: 'cowork-attachment', name: args[0] });
      if (attachmentError) throw attachmentError;
    },
  };
  if (coworkPasses) await callback({}, testInfo);
  else
    await assert.rejects(
      callback({}, testInfo),
      (error) =>
        error ===
        (coworkPollError ??
          panelSelectionError ??
          firstCloseExpectedError ??
          primary),
    );
  let recordedBoundaryLines = [];
  try {
    recordedBoundaryLines = readFileSync(realBoundaryFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  } catch {
    /* The ordinary injected recorder does not create a file. */
  }
  const result = {
    launches,
    closes,
    events,
    selectedBoundaries,
    records,
    boundaryRecords,
    catalogCalls,
    attachments,
    recorder,
    mkdirs,
    coworkCatalogReadCount,
    recordedBoundaryLines,
  };
  rmSync(recorderDirectory, { recursive: true, force: true });
  return result;
}

test('registered W1 worktree callback records the first owner boundary before a distinct auth seed and selected final launch', async () => {
  let pendingObserved = false;
  const value = await runRegisteredW1CloseDiagnostic('worktree', true, {
    firstCloseCheckpoint: async ({ launches, closes, events, resolve }) => {
      await new Promise((checkpoint) => setImmediate(checkpoint));
      assert.equal(launches.length, 1);
      assert.equal(closes.length, 1);
      assert.equal(closes[0].app, launches[0].launched.electronApp);
      assert.deepEqual(events, [
        { type: 'launch', applicationId: 1 },
        { type: 'close-entered', applicationId: 1 },
      ]);
      pendingObserved = true;
      resolve();
    },
  });
  assert.equal(pendingObserved, true);
  assert.equal(value.launches.length, 3);
  assert.equal(value.launches[0].kind, 'panel-seed');
  const firstRaw =
    value.launches[0].options?.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
  assert.equal(typeof firstRaw, 'string');
  const first = JSON.parse(firstRaw);
  assert.equal(first.mode, 'close');
  assert.equal(first.caseId, 'w1-legacy-review-worktree');
  assert.match(first.launchId, /w1-legacy-review-worktree-panel-seed/);
  assert.deepEqual(first.owners, [
    { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
  ]);
  const authRaw =
    value.launches[1].options.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
  assert.equal(typeof authRaw, 'string');
  const auth = JSON.parse(authRaw);
  assert.equal(auth.mode, 'close');
  assert.equal(auth.caseId, 'w1-legacy-review-worktree');
  assert.match(auth.launchId, /w1-legacy-review-worktree-auth-seed/);
  assert.match(
    auth.file,
    /w1-legacy-review-worktree-auth-seed-12-fixture-main\.jsonl$/,
  );
  assert.equal(
    value.launches[1].options.userDataDir,
    value.launches[0].launched.userDataDir,
  );
  const raw =
    value.launches[2].options.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
  assert.equal(
    typeof raw,
    'string',
    'selected final launch must receive close-mode configuration',
  );
  const final = JSON.parse(raw);
  assert.equal(final.mode, 'close');
  assert.notEqual(first.file, auth.file);
  assert.notEqual(first.file, final.file);
  assert.notEqual(auth.file, final.file);
  assert.equal(value.closes.length, 3);
  assert.equal(value.closes[0].applicationId, 1);
  assert.equal(
    value.closes[0].app,
    value.launches[0].launched.electronApp,
    'the selected boundary must close the exact first owner',
  );
  assert.equal(value.closes[0].options.keepUserData, true);
  assert.equal(
    value.closes[0].options.boundaryRecord,
    value.selectedBoundaries[0].record,
  );
  assert.equal(value.closes[1].applicationId, 2);
  assert.equal(
    value.closes[1].options.boundaryRecord,
    value.selectedBoundaries[1].record,
  );
  assert.equal(value.closes[2].applicationId, 3);
  assert.equal(value.closes[2].options.boundaryRecord, value.recorder);
  assert.deepEqual(value.events.slice(0, 4), [
    { type: 'launch', applicationId: 1 },
    { type: 'close-entered', applicationId: 1 },
    { type: 'close-fulfilled', applicationId: 1 },
    { type: 'launch', applicationId: 2 },
  ]);
  assert.equal(value.records[0][0], 'route-removal');
});

test('registered W1 auth seed has its own selected close boundary and never reuses panel identity', async () => {
  const value = await runRegisteredW1CloseDiagnostic('worktree', true);
  assert.equal(value.selectedBoundaries.length, 2);
  const auth = JSON.parse(
    value.launches[1].options.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
  );
  assert.equal(auth.mode, 'close');
  assert.equal(auth.caseId, 'w1-legacy-review-worktree');
  assert.match(auth.launchId, /w1-legacy-review-worktree-auth-seed/);
  assert.notEqual(auth.launchId, value.selectedBoundaries[0].launchId);
  assert.equal(
    value.closes[1].options.boundaryRecord,
    value.selectedBoundaries[1].record,
  );
});

test('registered W1 auth directory failure preserves ordinary launch and close', async () => {
  const value = await runRegisteredW1CloseDiagnostic('worktree', true, {
    authDirectoryUnavailable: true,
  });
  assert.equal(value.launches.length, 3);
  assert.equal(value.selectedBoundaries.length, 1);
  assert.equal(value.launches[1].options.env, undefined);
  assert.equal(value.closes[1].options.keepUserData, true);
  assert.equal(value.closes[1].options.boundaryRecord, undefined);
  assert.equal(value.closes[1].app, value.launches[1].launched.electronApp);
});

test('registered W1 first-owner boundary preserves its close rejection and never starts the auth seed', async () => {
  const sentinel = new Error('first owner close failed');
  let pendingObserved = false;
  const value = await runRegisteredW1CloseDiagnostic('worktree', true, {
    firstCloseExpectedError: sentinel,
    firstCloseCheckpoint: async ({ launches, closes, events, reject }) => {
      await new Promise((checkpoint) => setImmediate(checkpoint));
      assert.equal(launches.length, 1);
      assert.equal(closes.length, 1);
      assert.equal(closes[0].app, launches[0].launched.electronApp);
      assert.deepEqual(events, [
        { type: 'launch', applicationId: 1 },
        { type: 'close-entered', applicationId: 1 },
      ]);
      pendingObserved = true;
      reject(sentinel);
    },
  });
  assert.equal(pendingObserved, true);
  assert.equal(value.launches.length, 1);
  assert.equal(value.closes.length, 1);
  assert.equal(value.closes[0].app, value.launches[0].launched.electronApp);
  assert.equal(value.closes[0].options.keepUserData, true);
  assert.equal(
    typeof value.closes[0].options.boundaryRecord,
    'function',
    'the first close must carry the selected owner boundary recorder',
  );
  assert.deepEqual(value.events, [
    { type: 'launch', applicationId: 1 },
    { type: 'close-entered', applicationId: 1 },
    { type: 'close-rejected', applicationId: 1 },
  ]);
});

for (const [ownerKind, enabled] of [
  ['worktree', false],
  ['cowork', true],
  ['advisor', true],
])
  test(`registered W1 ${ownerKind} callback with opt-in ${enabled} keeps final launch selection unchanged`, async () => {
    const value = await runRegisteredW1CloseDiagnostic(ownerKind, enabled);
    assert.equal(value.launches.length, 3);
    const [first, auth, final] = value.launches.map(
      ({ options }) => options?.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
    );
    assert.equal(typeof first, enabled ? 'string' : 'undefined');
    assert.equal(typeof auth, enabled ? 'string' : 'undefined');
    assert.equal(final, undefined);
    if (enabled) {
      assert.equal(JSON.parse(first).mode, 'close');
      assert.equal(JSON.parse(auth).mode, 'close');
      assert.notEqual(JSON.parse(first).file, JSON.parse(auth).file);
    }
    assert.equal(
      value.closes[0].options.boundaryRecord,
      enabled ? value.selectedBoundaries[0].record : undefined,
    );
    assert.equal(
      value.closes[1].options.boundaryRecord,
      enabled ? value.selectedBoundaries[1].record : undefined,
    );
    assert.equal(value.closes[2].options.boundaryRecord, undefined);
    assert.equal(
      value.boundaryRecords.some(
        ({ args }) => args[0] === 'advisor-initial-selection-failure',
      ),
      false,
      'normal setup must not collect failure-only selection evidence',
    );
    assert.equal(value.records.length, ownerKind === 'cowork' ? 1 : 0);
    if (ownerKind === 'cowork') {
      assert.deepEqual(JSON.parse(JSON.stringify(value.records[0])), [
        'worker-invocation',
        {
          caseId: 'w1-legacy-review-cowork',
          fixturePid: 12,
          wallTime: value.records[0][1].wallTime,
        },
      ]);
      assert.match(
        value.records[0][1].wallTime,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

test('registered advisor W1 selection failure captures before owned setup cleanup and preserves the primary error', async () => {
  const primary = new Error('advisor selection failed');
  const value = await runRegisteredW1CloseDiagnostic('advisor', true, {
    panelSelectionError: primary,
    attachmentError: new Error('attachment failed'),
  });
  assert.equal(value.launches.length, 1);
  assert.equal(value.selectedBoundaries[0].firstProjectsLoad, true);
  const launchConfig = JSON.parse(
    value.launches[0].options.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
  );
  assert.equal(launchConfig.firstProjectsLoad, true);
  assert.equal(
    launchConfig.firstProjectsLoadFile,
    value.selectedBoundaries[0].firstProjectsLoadFile,
  );
  assert.ok(
    value.events.some(({ type }) => type === 'first-projects-load-prelaunch'),
  );
  assert.equal(value.catalogCalls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(value.catalogCalls[0])), {
    userDataDir: '/owned',
    workspaceIds: ['demo-ts-pnpm-vite'],
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(value.catalogCalls[1])),
    JSON.parse(JSON.stringify(value.catalogCalls[0])),
  );
  const diagnosticIndex = value.boundaryRecords.findIndex(
    ({ args }) => args[0] === 'advisor-initial-selection-failure',
  );
  const setupIndex = value.events.findIndex(
    ({ type }) => type === 'setup-failure',
  );
  const closeIndex = value.events.findIndex(
    ({ type }) => type === 'close-entered',
  );
  assert.ok(diagnosticIndex >= 0);
  assert.ok(setupIndex >= 0);
  assert.ok(closeIndex > setupIndex);
  assert.equal(value.closes.length, 1);
  assert.equal(value.closes[0].app, value.launches[0].launched.electronApp);
  assert.equal(value.attachments.length, 2);
  const record = value.boundaryRecords[diagnosticIndex].args[1];
  assert.equal(record.primaryError, primary.message);
  assert.equal(record.prelaunchCatalog.userDataDir, '/owned');
  assert.equal(record.failureCatalog.userDataDir, '/owned');
  assert.equal(record.renderer.envelope.snapshot.activePage, 'main');
});

for (const ownerKind of ['worktree', 'cowork'])
  for (const observationError of [
    undefined,
    new Error(`${ownerKind} observation failed`),
  ])
    test(`registered W1 ${ownerKind} selection failure captures before owned setup cleanup and preserves the primary error (${Boolean(observationError)})`, async () => {
      const primary = new Error(`${ownerKind} selection failed`);
      const value = await runRegisteredW1CloseDiagnostic(ownerKind, true, {
        panelSelectionError: primary,
        attachmentError: observationError,
      });
      const diagnosticIndex = value.boundaryRecords.findIndex(
        ({ args }) => args[0] === 'advisor-initial-selection-failure',
      );
      const setupIndex = value.events.findIndex(
        ({ type }) => type === 'setup-failure',
      );
      const closeIndex = value.events.findIndex(
        ({ type }) => type === 'close-entered',
      );
      assert.ok(diagnosticIndex >= 0);
      assert.ok(setupIndex >= 0);
      assert.ok(closeIndex > setupIndex);
      assert.equal(value.closes.length, 1);
      assert.equal(value.closes[0].app, value.launches[0].launched.electronApp);
      assert.equal(
        value.boundaryRecords[diagnosticIndex].args[1].primaryError,
        primary.message,
      );
      if (ownerKind === 'cowork') {
        assert.equal(value.selectedBoundaries[0].firstProjectsLoad, false);
        assert.equal(
          value.events.some(
            ({ type }) => type === 'first-projects-load-prelaunch',
          ),
          false,
        );
      }
    });

for (const ownerKind of ['worktree', 'cowork'])
  test(`registered W1 ${ownerKind} selection failure retains its primary error when owned cleanup rejects`, async () => {
    const primary = new Error(`${ownerKind} selection failed`);
    const cleanupFailure = new Error('owned cleanup unavailable');
    const value = await runRegisteredW1CloseDiagnostic(ownerKind, true, {
      panelSelectionError: primary,
      firstCloseExpectedError: cleanupFailure,
      firstCloseCheckpoint: async ({ boundaryRecords, reject }) => {
        assert.ok(
          boundaryRecords.some(
            ({ args }) => args[0] === 'advisor-initial-selection-failure',
          ),
          'selection capture must complete before owned cleanup enters',
        );
        reject(cleanupFailure);
      },
    });
    assert.equal(value.closes.length, 1);
    assert.equal(value.closes[0].applicationId, 1);
    assert.deepEqual(value.events.slice(-2), [
      { type: 'close-entered', applicationId: 1 },
      { type: 'close-rejected', applicationId: 1 },
    ]);
  });

test('registered W1 cowork preconfirmation selection failure retains no retirement evidence and opt-out leaves selection unchanged', async () => {
  const normal = await runRegisteredW1CloseDiagnostic('cowork', true);
  assert.equal(normal.attachments.length, 0);
  assert.equal(
    normal.boundaryRecords.some(
      ({ args }) => args[0] === 'advisor-initial-selection-failure',
    ),
    false,
  );
  const optOut = await runRegisteredW1CloseDiagnostic('cowork', false, {
    panelSelectionError: new Error('cowork selection failed without opt-in'),
  });
  assert.equal(
    optOut.boundaryRecords.some(
      ({ args }) => args[0] === 'advisor-initial-selection-failure',
    ),
    false,
  );
  assert.equal(optOut.closes.length, 1);
});

test('registered W1 cowork completed flow retains no passive failure attachment or refresh read', async () => {
  const value = await runRegisteredW1CloseDiagnostic('cowork', true, {
    coworkPasses: true,
    coworkCatalog: {
      revision: 43,
      retirements: {
        owned: {
          scope: { projectId: 'work', worktreeId: 'entry' },
          state: 'aborted',
        },
      },
    },
  });
  assert.equal(value.attachments.length, 0);
  assert.equal(value.coworkCatalogReadCount, 1);
  assert.equal(
    value.events.filter(({ type }) => type === 'cowork-catalog-read').length,
    1,
  );
  assert.equal(
    value.events.some(({ type }) => type === 'cowork-attachment'),
    false,
  );
});

test('registered W1 cowork poll failure retains passive retirement evidence before cleanup', async () => {
  const primary = new Error('cowork aborted state was not observed');
  const matching = Array.from({ length: 18 }, (_, index) => [
    `owned-${index}`,
    {
      scope: { projectId: 'work', worktreeId: 'entry' },
      state: index === 0 ? 'prepared' : 'aborted',
    },
  ]);
  const value = await runRegisteredW1CloseDiagnostic('cowork', true, {
    coworkPollError: primary,
    coworkCatalog: {
      revision: 41,
      retirements: {
        ...Object.fromEntries(matching),
        unrelated: {
          scope: { projectId: 'other', worktreeId: 'unrelated' },
          state: 'prepared',
        },
      },
    },
  });
  const attachment = value.attachments.find(
    ([name]) => name === 'cowork-precommit-abort-failure-before-cleanup.json',
  );
  assert.ok(attachment, 'missing passive cowork failure attachment');
  const metadata = JSON.parse(attachment[1].body.toString('utf8'));
  assert.equal(metadata.stage, 'cowork-precommit-abort-failure-before-cleanup');
  assert.equal(metadata.lastPreCleanupCatalogObservation.refresh, 'fulfilled');
  assert.equal(metadata.lastPreCleanupCatalogObservation.available, true);
  assert.equal(metadata.lastPreCleanupCatalogObservation.revision, 41);
  assert.equal(
    metadata.lastPreCleanupCatalogObservation.matchingRetirements.length,
    16,
  );
  assert.equal(
    metadata.lastPreCleanupCatalogObservation.matchingRetirementsDroppedCount,
    2,
  );
  assert.equal(
    metadata.lastPollCatalogObservation.matchingRetirementsDroppedCount,
    2,
  );
  const attachmentIndex = value.events.findIndex(
    ({ type, name }) =>
      type === 'cowork-attachment' &&
      name === 'cowork-precommit-abort-failure-before-cleanup.json',
  );
  const refreshIndex = value.events.findIndex(
    ({ type, index }) => type === 'cowork-catalog-read' && index === 2,
  );
  const cleanupIndex = value.events.findIndex(
    ({ type }) => type === 'conflict-removed',
  );
  const finalCloseIndex = value.events.findLastIndex(
    ({ type }) => type === 'close-entered',
  );
  assert.ok(refreshIndex >= 0);
  assert.ok(attachmentIndex > refreshIndex);
  assert.ok(cleanupIndex > attachmentIndex);
  assert.ok(finalCloseIndex > cleanupIndex);
});

test('registered W1 cowork passive catalog capture preserves the primary poll error when observation fails', async () => {
  const primary = new Error('cowork aborted state was not observed');
  const catalog = {
    revision: 42,
    retirements: {
      owned: {
        scope: { projectId: 'work', worktreeId: 'entry' },
        state: 'prepared',
      },
    },
  };
  const refreshFailure = new Error('fresh catalog unavailable');
  const refresh = await runRegisteredW1CloseDiagnostic('cowork', true, {
    coworkPollError: primary,
    coworkCatalog: catalog,
    coworkRefreshError: refreshFailure,
  });
  const refreshAttachment = refresh.attachments.find(
    ([name]) => name === 'cowork-precommit-abort-failure-before-cleanup.json',
  );
  assert.ok(refreshAttachment);
  const refreshMetadata = JSON.parse(
    refreshAttachment[1].body.toString('utf8'),
  );
  assert.equal(
    refreshMetadata.lastPreCleanupCatalogObservation.refresh,
    'unavailable',
  );
  assert.equal(
    refreshMetadata.lastPreCleanupCatalogObservation.unavailable,
    'catalog refresh unavailable',
  );
  assert.equal(
    refreshMetadata.lastPollCatalogObservation.matchingRetirements[0].state,
    'prepared',
  );

  const serialization = await runRegisteredW1CloseDiagnostic('cowork', true, {
    coworkPollError: primary,
    coworkCatalog: catalog,
    coworkSerializationError: new Error('serialization unavailable'),
  });
  assert.equal(serialization.attachments.length, 0);

  const attachment = await runRegisteredW1CloseDiagnostic('cowork', true, {
    coworkPollError: primary,
    coworkCatalog: catalog,
    attachmentError: new Error('attachment unavailable'),
  });
  assert.equal(attachment.attachments.length, 1);
});

test('registered advisor W1 oversized catalogs retain one bounded named recorder event and identical attachment metadata', async () => {
  const primary = new Error('advisor selection failed with oversized catalogs');
  const identity = Object.fromEntries(
    ['id', 'kind', 'type', 'workspaceId', 'worktreeId', 'branchName'].map(
      (key) => [key, `${key}-`.padEnd(128, key[0])],
    ),
  );
  const value = await runRegisteredW1CloseDiagnostic('advisor', true, {
    panelSelectionError: primary,
    useRealBoundaryRecorder: true,
    advisorCatalogFactory: ({ userDataDir }) => ({
      userDataDir,
      indexPath: '/owned/workspaces/index.json',
      files: Array.from({ length: 17 }, (_, fileIndex) => ({
        path: `/owned/workspaces/catalog-${fileIndex}.json`,
        status: 'present',
        sizeBytes: 65536,
        sha256: String(fileIndex).padStart(64, 'a'),
        version: 1,
        identities: Array.from({ length: 32 }, () => ({ ...identity })),
        truncated: false,
      })),
    }),
  });
  assert.equal(value.recordedBoundaryLines.length, 1);
  const [record] = value.recordedBoundaryLines;
  assert.equal(record.stage, 'advisor-initial-selection-failure');
  assert.equal(record.primaryError, primary.message);
  assert.equal(record.truncated, true);
  assert.ok(record.prelaunchCatalog.droppedIdentityCount > 0);
  assert.ok(record.failureCatalog.droppedIdentityCount > 0);
  assert.ok(
    Buffer.byteLength(`${JSON.stringify(record)}\n`) <= 16 * 1024,
    'real recorder line must fit its per-record limit',
  );
  const attachment = value.attachments.find(
    ([name]) => name === 'advisor-initial-selection-failure.json',
  );
  assert.ok(attachment);
  const attachedMetadata = JSON.parse(attachment[1].body.toString('utf8'));
  const recordedMetadata = { ...record };
  for (const key of ['stage', 'monotonicNs', 'elapsedMs'])
    delete recordedMetadata[key];
  assert.deepEqual(attachedMetadata, recordedMetadata);
});

test('registered advisor W1 missing prelaunch catalog retains named unavailable evidence and cleanup ownership', async () => {
  const primary = new Error('advisor selection failed after prelaunch capture');
  const value = await runRegisteredW1CloseDiagnostic('advisor', true, {
    panelSelectionError: primary,
    prelaunchCatalogError: new Error('prelaunch catalog close failed'),
  });
  const diagnostic = value.boundaryRecords.find(
    ({ args }) => args[0] === 'advisor-initial-selection-failure',
  );
  assert.ok(diagnostic, 'named advisor failure record missing');
  const metadata = diagnostic.args[1];
  assert.equal(metadata.primaryError, primary.message);
  assert.equal(
    metadata.prelaunchCatalog.unavailable,
    'catalog projection unavailable',
  );
  assert.equal(metadata.prelaunchCatalog.files.length, 0);
  const attachment = value.attachments.find(
    ([name]) => name === 'advisor-initial-selection-failure.json',
  );
  assert.ok(attachment);
  assert.deepEqual(
    JSON.parse(attachment[1].body.toString('utf8')),
    JSON.parse(JSON.stringify(metadata)),
  );
  assert.equal(value.closes.length, 1);
  assert.equal(value.closes[0].app, value.launches[0].launched.electronApp);
  assert.ok(
    value.events.findIndex(({ type }) => type === 'close-entered') >
      value.events.findIndex(({ type }) => type === 'setup-failure'),
  );
});

test('fixture recorder carries its existing operation observer without adding a launch harness dependency', async () => {
  const { createBoundaryRecorder } =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  // Missing parent makes the real recorder fail safely; observation must still
  // preserve action results and failures without a second observer framework.
  const record = createBoundaryRecorder(
    '/nonexistent-boundary-fixture/events.jsonl',
  );
  const result = Promise.resolve({ owned: true });
  assert.equal(
    record.observe('close', () => result),
    result,
  );
  await result;
  const primary = new Error('owned close failed');
  assert.throws(
    () =>
      record.observe('close', () => {
        throw primary;
      }),
    (error) => error === primary,
  );
  const rejected = Promise.reject(primary);
  assert.equal(
    record.observe('close', () => rejected),
    rejected,
  );
  await assert.rejects(rejected, (error) => error === primary);
});

async function runRegisteredRecoveryClose(
  stage,
  {
    cookieError,
    restartCookieError,
    restartAssertionError,
    attachmentError,
    firstCleanupEvaluationError,
    diagnosticsConfigured = true,
    browserDiagnosticsConfigured = false,
    preparedDiagnostic = false,
    boundaryObserverSetupUnavailable = false,
    boundaryObserverCheckpointError,
    boundaryObserverCloseError,
    nativeSnapshotError,
    initialSeedError,
    selectionDiagnosticError,
    initialCleanupError,
    platform = 'win32',
  } = {},
) {
  const { readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const source = readFileSync(
    integratedDiagnosticSource(
      'apps/desktop-app/tests/electron/browser-profiles.spec.mjs',
      new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    ),
    'utf8',
  );
  const start = source.indexOf("for (const stage of [\n  'prepared',");
  const end = source.indexOf(
    "terminalCleanupTest(\n  'opens a separate profile tab",
    start,
  );
  const callbacks = new Map(),
    launches = [],
    closes = [],
    checkpointRecords = [],
    attachments = [],
    electronApps = [],
    cleanupEvaluations = [],
    cleanupRejectionStates = [],
    selectedBoundaries = [],
    recorderCreations = [],
    diagnosticLogs = [],
    operationOrder = [],
    selectionDiagnostics = [];
  const output = mkdtempSync(join(tmpdir(), 'selected-close-'));
  const test = (name, callback) => callbacks.set(name, callback);
  test.setTimeout = (budget) => assert.equal(budget, 120_000);
  let activeElectronApp;
  let inputValue = '';
  const locator = {
    click: async () => {},
    fill: async (value) => {
      inputValue = value;
    },
    press: async () => {
      await activeElectronApp.handlers.get('browser:navigate')(
        {},
        { browserId: 'browser', url: inputValue },
      );
    },
    screenshot: async () => Buffer.from('png'),
  };
  const window = {
    getByTestId: () => locator,
    evaluate: async (fn) =>
      fn.toString().includes('getBrowserLifecycle')
        ? { status: 'mock-renderer-lifecycle' }
        : { profileId: 'target' },
    locator: () => locator,
  };
  const driver = class {
    async waitForShell() {}
    async openMainPage() {}
    async selectWorktree() {
      operationOrder.push('select-worktree');
    }
  };
  const createElectronApp = (id) => {
    const app = new EventEmitter();
    let currentUrl = 'about:blank';
    const contents = new EventEmitter();
    Object.assign(contents, {
      id: id + 100,
      getType: () => 'webview',
      getURL: () => currentUrl,
      isDestroyed: () => false,
      isLoading: () => false,
    });
    const originalNavigate = async (_event, request) => {
      currentUrl = request.url;
      contents.emit('did-start-navigation', {}, request.url, false, true);
      contents.emit('did-navigate', {}, request.url, 200, 'OK');
      contents.emit('did-finish-load');
      return { ok: true };
    };
    const handlers = new Map([['browser:navigate', originalNavigate]]);
    const electron = {
      app,
      ipcMain: { _invokeHandlers: handlers },
      webContents: {
        getAllWebContents: () => [contents],
        fromId: (nativeId) => (nativeId === contents.id ? contents : null),
      },
    };
    return {
      id,
      handlers,
      originalNavigate,
      app,
      contents,
      evaluate: async (fn, value) => {
        if (
          nativeSnapshotError &&
          fn.toString().includes('const all = webContents.getAllWebContents()')
        )
          throw nativeSnapshotError;
        if (fn.toString().includes('globalThis[key]?.cleanup')) {
          cleanupEvaluations.push(id);
          if (firstCleanupEvaluationError && cleanupEvaluations.length === 1) {
            cleanupRejectionStates.push({
              id,
              handlerIsOriginal:
                handlers.get('browser:navigate') === originalNavigate,
              appListenerCount: app.listenerCount('web-contents-created'),
              contentsListenerCount: [
                'did-start-navigation',
                'did-fail-load',
                'did-navigate',
                'did-finish-load',
                'destroyed',
              ].reduce(
                (count, event) => count + contents.listenerCount(event),
                0,
              ),
            });
            throw firstCleanupEvaluationError;
          }
        }
        return fn(electron, value);
      },
    };
  };
  const launch = async (options) => {
    launches.push(options);
    const owner = {
      electronApp: createElectronApp(launches.length),
      userDataDir: '/owned',
      window,
      app: new driver(),
    };
    activeElectronApp = owner.electronApp;
    electronApps.push(owner.electronApp);
    options?.onBeforeLaunch?.({ userDataDir: '/owned', workspaceIds: [] });
    if (initialSeedError) {
      try {
        await options?.onSetupFailure?.({
          ...owner,
          branch: 'demo-main',
          error: initialSeedError,
        });
      } catch {
        /* The setup fixture must retain the original selection error. */
      }
      throw initialSeedError;
    }
    return owner;
  };
  const close = async (app, directory, options) => {
    operationOrder.push(`owner-close-${app.id}`);
    closes.push({ app, directory, options });
    if (app.id === 1 && initialCleanupError) throw initialCleanupError;
  };
  const expectation = () => ({
    toMatchObject() {},
    toContain() {},
    toBe() {},
    toEqual() {},
  });
  let pollCount = 0;
  expectation.poll = (operation) => ({
    toMatchObject() {},
    async toContain() {
      if (cookieError && pollCount++ === 0) throw cookieError;
      await operation();
    },
    async toBe() {
      await operation();
    },
    async toEqual() {
      await operation();
      if (restartAssertionError) throw restartAssertionError;
    },
  });
  const ts = require('typescript');
  const setupHelpers = source.slice(
    source.indexOf('function selectedWindowsBoundary('),
    source.indexOf('function createWindowsCheckpointRecorder('),
  );
  const observerStart = source.indexOf(
    'function createBrowserBoundaryDiagnostic(',
  );
  const observerEnd = source.indexOf(
    '// Explicit opt-in works locally on macOS',
    observerStart,
  );
  const code = ts.transpileModule(
    `${setupHelpers}\n${source.slice(observerStart, observerEnd)}\n${source.slice(start, end)}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const diagnosticEnv = {};
  if (diagnosticsConfigured)
    diagnosticEnv.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR = output;
  if (browserDiagnosticsConfigured)
    diagnosticEnv.CANOPY_WINDOWS_BROWSER_BOUNDARY_DIAGNOSTICS_DIR = output;
  if (preparedDiagnostic)
    diagnosticEnv.CANOPY_E2E_PREPARED_RESTART_DIAGNOSTIC = '1';
  vm.runInNewContext(code, {
    ...lifecycle,
    test,
    terminalCleanupTest: test,
    process: {
      platform,
      env: diagnosticEnv,
    },
    console: {
      error: (...args) => diagnosticLogs.push(args),
    },
    randomUUID: () => 'operation',
    path: require('node:path'),
    createWindowsDiagnosticBasePath: (slug, directory) => join(directory, slug),
    createWindowsCheckpointRecorder: (slug) => {
      recorderCreations.push(slug);
      if (boundaryObserverSetupUnavailable) return null;
      return (checkpoint, details = {}) => {
        checkpointRecords.push({ slug, checkpoint, details });
        operationOrder.push(`observer-checkpoint-${checkpoint}`);
      };
    },
    captureWorktreeSelectionSnapshot: async () => ({
      status: 'mock-dom-snapshot',
    }),
    collectBrowserBoundaryDom: () => ({}),
    __CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__: (input) => {
      operationOrder.push(`observer-control-${input.kind}`);
      if (boundaryObserverCheckpointError && input.kind === 'browser-snapshot')
        throw boundaryObserverCheckpointError;
      if (boundaryObserverCloseError && input.kind === 'release-create')
        throw boundaryObserverCloseError;
      return { status: 'observed', kind: input.kind };
    },
    createWorktreeSelectionFailureDiagnostic: (slug) => async (context) => {
      selectionDiagnostics.push({ slug, branch: context.branch });
      operationOrder.push(`selection-diagnostic-${slug}`);
      if (selectionDiagnosticError) throw selectionDiagnosticError;
    },
    createSelectedLaunchBoundary: (slug, label, options) => {
      const boundary = lifecycle.createSelectedLaunchBoundary(slug, label, {
        ...options,
        directory: diagnosticsConfigured ? output : '',
      });
      selectedBoundaries.push(boundary);
      return boundary;
    },
    seedPanelWorktree: launch,
    launchCanopy: launch,
    closeCanopy: close,
    getMainWindow: async () => window,
    CanopyAppDriver: driver,
    expect: expectation,
    fixtureCookies: async () => {
      if (restartCookieError && pollCount > 0) throw restartCookieError;
      pollCount++;
      return [];
    },
    getScenarioActivity: async (_base, key) => ({
      key,
      activity: { browserFixtureGet: 1 },
    }),
    boundedCleanupErrorMessage: (error) => String(error?.message ?? error),
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    dispatchProfileAction: async (_app, request) => {
      operationOrder.push(`dispatch-${request.type}`);
      return {
        result: {
          browsers: [
            {
              id: 'browser',
              profile: { runtimeGeneration: 1, resolvedProfileId: 'source' },
            },
          ],
        },
      };
    },
    require: (name) =>
      name === 'node:fs/promises'
        ? {
            readFile: async () =>
              JSON.stringify({
                source: { profile: {} },
                target: { profile: {} },
              }),
            writeFile: async () => {},
          }
        : require(name),
  });
  try {
    const [terminalFixture] = lifecycle.createTerminalCleanupFixture('win32');
    let escaped;
    try {
      await terminalFixture({}, async (runTerminalCleanup) => {
        await callbacks.get(
          `recovers the ${stage} switch decision before reopening its real account`,
        )(
          { runTerminalCleanup },
          {
            attach: async (...args) => {
              attachments.push(args);
              if (attachmentError) throw attachmentError;
            },
          },
        );
      });
    } catch (error) {
      escaped = error;
      const expectedEscaped =
        cookieError ??
        restartAssertionError ??
        initialSeedError ??
        firstCleanupEvaluationError;
      if (error !== expectedEscaped) throw error;
    }
    const seedRecords = launches.map((launch) => {
      const config = JSON.parse(
        launch?.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS ?? '{}',
      );
      try {
        return readFileSync(
          config.file.replace(/-main\.jsonl$/, '-fixture.jsonl'),
          'utf8',
        )
          .trim()
          .split('\n')
          .map(JSON.parse);
      } catch {
        return [];
      }
    });
    return {
      launches,
      closes,
      seedRecords,
      checkpointRecords,
      attachments,
      electronApps,
      cleanupEvaluations,
      cleanupRejectionStates,
      selectedBoundaries,
      recorderCreations,
      diagnosticLogs,
      operationOrder,
      selectionDiagnostics,
      escaped,
    };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

for (const stage of ['prepared', 'target_committed'])
  test(`registered ${stage} recovery retains distinct close streams across both launches`, async () => {
    const { launches, closes, seedRecords } =
      await runRegisteredRecoveryClose(stage);
    assert.equal(launches.length, 2);
    const configs = launches.map((launch) =>
      JSON.parse(launch?.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS ?? '{}'),
    );
    assert.deepEqual(
      configs.map((config) => config.mode),
      ['close', 'close'],
    );
    assert.notEqual(configs[0].launchId, configs[1].launchId);
    assert.notEqual(configs[0].file, configs[1].file);
    if (stage === 'prepared')
      assert.ok(
        seedRecords[0].some(
          (row) =>
            row.stage === 'seed-identity' &&
            row.launchId === configs[0].launchId,
        ),
      );
    assert.equal(closes.length, 2);
    assert.notEqual(
      closes[0].options.boundaryRecord,
      closes[1].options.boundaryRecord,
    );
    assert.equal(typeof closes[0].options.boundaryRecord, 'function');
    assert.deepEqual(
      closes.map((close) => close.app.id),
      [1, 2],
    );
  });

for (const selectionDiagnosticError of [
  undefined,
  new Error('selection capture unavailable'),
])
  test(`registered target_committed initial selection failure captures before owned cleanup and preserves the primary error (${Boolean(selectionDiagnosticError)})`, async () => {
    const primary = new Error('demo-main row selection failed');
    const value = await runRegisteredRecoveryClose('target_committed', {
      initialSeedError: primary,
      selectionDiagnosticError,
      initialCleanupError: new Error('owned cleanup unavailable'),
    });
    assert.equal(value.escaped, primary);
    assert.deepEqual(value.selectionDiagnostics, [
      { slug: 'target-committed-switch-setup', branch: 'demo-main' },
    ]);
    assert.equal(value.closes.length, 1);
    assert.equal(value.closes[0].app.id, 1);
    assert.ok(
      value.operationOrder.indexOf(
        'selection-diagnostic-target-committed-switch-setup',
      ) < value.operationOrder.indexOf('owner-close-1'),
    );
  });

test('registered target_committed normal setup does not capture selection diagnostics', async () => {
  const value = await runRegisteredRecoveryClose('target_committed');
  assert.deepEqual(value.selectionDiagnostics, []);
});

test('registered close_intent routes each selected launch recorder without enabling admission emission', async () => {
  const {
    launches,
    closes,
    selectedBoundaries,
    recorderCreations,
    checkpointRecords,
  } = await runRegisteredRecoveryClose('close_intent');
  assert.equal(launches.length, 2);
  assert.equal(closes.length, 2);
  assert.equal(selectedBoundaries.length, 2);
  for (let index = 0; index < launches.length; index++) {
    assert.equal(typeof launches[index].boundaryRecord, 'function');
    assert.equal(
      launches[index].boundaryRecord,
      selectedBoundaries[index].record,
    );
    assert.equal(
      launches[index].boundaryRecord,
      closes[index].options.boundaryRecord,
    );
    assert.equal(
      launches[index].env?.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS,
      undefined,
    );
  }
  assert.notEqual(launches[0].boundaryRecord, launches[1].boundaryRecord);
  assert.deepEqual(recorderCreations, [
    'close-intent-initial-navigation',
    'close-intent-restart-boundary',
  ]);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        checkpointRecords
          .filter(
            ({ slug, checkpoint }) =>
              slug === 'close-intent-restart-boundary' &&
              checkpoint === 'recovered-profile-selected',
          )
          .map(({ checkpoint, details }) => ({
            checkpoint,
            operations: details.operations,
          })),
      ),
    ),
    [{ checkpoint: 'recovered-profile-selected', operations: {} }],
  );
});

test('registered prepared recovery keeps the restart observer silent unless both gates select it', async () => {
  for (const options of [
    {},
    { preparedDiagnostic: true, diagnosticsConfigured: false },
  ]) {
    const value = await runRegisteredRecoveryClose('prepared', options);
    assert.deepEqual(value.recorderCreations, []);
    assert.deepEqual(value.checkpointRecords, []);
    assert.deepEqual(value.diagnosticLogs, []);
  }
});

for (const directory of ['primary', 'browser'])
  test(`registered prepared recovery selects its diagnostic through the ${directory} boundary directory`, async () => {
    const value = await runRegisteredRecoveryClose('prepared', {
      preparedDiagnostic: true,
      diagnosticsConfigured: directory === 'primary',
      browserDiagnosticsConfigured: directory === 'browser',
    });
    assert.deepEqual(value.recorderCreations, [
      'prepared-restart-diagnostic-only',
    ]);
    const records = value.checkpointRecords.filter(
      ({ slug }) => slug === 'prepared-restart-diagnostic-only',
    );
    assert.deepEqual(
      records.map(({ checkpoint }) => checkpoint),
      ['armed', 'recovered-profile-selected', 'observer-release'],
    );
    const selected = records.find(
      ({ checkpoint }) => checkpoint === 'recovered-profile-selected',
    );
    assert.equal(selected.checkpoint, 'recovered-profile-selected');
    assert.deepEqual(JSON.parse(JSON.stringify(selected.details.operations)), {
      diagnosticOnly: true,
      acceptanceEligible: false,
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(selected.details.rendererLifecycle)),
      {
        status: 'mock-renderer-lifecycle',
      },
    );
    assert(
      value.operationOrder.indexOf('observer-checkpoint-armed') <
        value.operationOrder.indexOf('select-worktree'),
    );
    assert(
      value.operationOrder.indexOf('observer-checkpoint-observer-release') <
        value.operationOrder.indexOf('owner-close-2'),
    );
  });

test('registered prepared diagnostic retains the latest bounded suppressed cookie error without replacing the assertion or cleanup order', async () => {
  const suppressed = new Error(`missing native fixture ${'x'.repeat(600)}`);
  const assertion = new Error('original prepared cookie assertion failed');
  const value = await runRegisteredRecoveryClose('prepared', {
    preparedDiagnostic: true,
    restartCookieError: suppressed,
    restartAssertionError: assertion,
    boundaryObserverCheckpointError: new Error('checkpoint unavailable'),
    boundaryObserverCloseError: new Error('release unavailable'),
  });
  assert.equal(value.escaped, assertion);
  const records = value.checkpointRecords.filter(
    ({ slug }) => slug === 'prepared-restart-diagnostic-only',
  );
  assert.deepEqual(
    records.map(({ checkpoint }) => checkpoint),
    [
      'armed',
      'recovered-profile-selected',
      'fixture-cookie-poll-failed',
      'original-step-failed',
      'observer-release',
    ],
  );
  const failure = records.find(
    ({ checkpoint }) => checkpoint === 'fixture-cookie-poll-failed',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(failure.details.operations)), {
    diagnosticOnly: true,
    acceptanceEligible: false,
    suppressedCookieError: suppressed.message.slice(0, 512),
  });
  assert.equal(failure.details.operations.suppressedCookieError.length, 512);
  assert.deepEqual(
    JSON.parse(JSON.stringify(failure.details.rendererLifecycle)),
    {
      status: 'mock-renderer-lifecycle',
    },
  );
  assert.equal(
    records.find(({ checkpoint }) => checkpoint === 'original-step-failed')
      .details.message,
    assertion.message,
  );
  assert(
    value.operationOrder.indexOf(
      'observer-checkpoint-fixture-cookie-poll-failed',
    ) <
      value.operationOrder.indexOf('observer-checkpoint-original-step-failed'),
  );
  assert(
    value.operationOrder.indexOf('observer-checkpoint-observer-release') <
      value.operationOrder.indexOf('owner-close-2'),
  );
});

test('registered prepared diagnostic reports unavailable setup without fabricating observer success', async () => {
  const value = await runRegisteredRecoveryClose('prepared', {
    preparedDiagnostic: true,
    boundaryObserverSetupUnavailable: true,
  });
  assert.deepEqual(value.recorderCreations, [
    'prepared-restart-diagnostic-only',
  ]);
  assert.deepEqual(value.checkpointRecords, []);
  assert.equal(value.diagnosticLogs.length, 1);
  assert.equal(
    value.diagnosticLogs[0][0],
    'Prepared restart diagnostic unavailable:',
  );
  assert.deepEqual(JSON.parse(value.diagnosticLogs[0][1]), {
    diagnosticOnly: true,
    acceptanceEligible: false,
    status: 'unavailable',
    reason: 'boundary-observer-setup-unavailable',
  });
  assert(value.diagnosticLogs[0][1].length <= 512);
});

for (const stage of ['prepared', 'target_committed', 'retired_incarnation'])
  test(`registered ${stage} recovery does not receive the close_intent launch recorder`, async () => {
    const { launches } = await runRegisteredRecoveryClose(stage);
    assert.equal(launches.length, 2);
    assert.ok(
      launches.every((options) => options?.boundaryRecord === undefined),
    );
    assert.ok(
      launches.every(
        (options) =>
          options?.env?.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS ===
          undefined,
      ),
    );
  });

test('registered close_intent keeps launch observation disabled without selected diagnostics', async () => {
  const { launches, closes, selectedBoundaries } =
    await runRegisteredRecoveryClose('close_intent', {
      diagnosticsConfigured: false,
    });
  assert.equal(launches.length, 2);
  assert.equal(closes.length, 2);
  assert.equal(selectedBoundaries.length, 2);
  assert.ok(launches.every((options) => options?.boundaryRecord === undefined));
  assert.ok(
    launches.every(
      (options) =>
        options?.env?.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS ===
        undefined,
    ),
  );
});

test('registered close_intent recovery records the initial navigation boundary before profile work', async () => {
  const { launches, checkpointRecords } =
    await runRegisteredRecoveryClose('close_intent');
  assert.equal(launches.length, 2);
  const initial = checkpointRecords.find(
    (entry) =>
      entry.slug === 'close-intent-initial-navigation' &&
      entry.checkpoint === 'initial-navigation-complete',
  );
  assert.ok(initial, 'initial navigation callback record missing');
  assert.equal(initial.details.mock.activity.browserFixtureGet, 1);
  assert.equal(initial.details.dispatch[0].browserId, 'browser');
});

test('registered close_intent initial navigation preserves the cookie failure through evidence and cleanup failures', async () => {
  const primary = new Error('initial cookie poll failed');
  const value = await runRegisteredRecoveryClose('close_intent', {
    cookieError: primary,
    attachmentError: new Error('attachment failed'),
  });
  assert.equal(value.escaped, primary);
  assert.equal(value.launches.length, 1);
  const failure = value.checkpointRecords.find(
    (entry) =>
      entry.slug === 'close-intent-initial-navigation' &&
      entry.checkpoint === 'initial-navigation-failure',
  );
  assert.ok(failure);
  assert.equal(failure.details.cookiePoll.error, primary.message);
  assert.equal(failure.details.mock.activity.browserFixtureGet, 1);
  assert.equal(failure.details.dispatch[0].outcome, 'resolved');
  assert.equal(value.attachments.length, 2);
  assert.equal(
    value.electronApps[0].handlers.get('browser:navigate'),
    value.electronApps[0].originalNavigate,
  );
});

for (const cookieFailure of [false, true])
  test(`registered close_intent ${cookieFailure ? 'cookie failure' : 'success'} retains initial-app cleanup ownership after the first evaluation rejects`, async () => {
    const cleanupError = new Error('cleanup transport unavailable');
    const cookieError = cookieFailure
      ? new Error('initial cookie poll failed')
      : undefined;
    const value = await runRegisteredRecoveryClose('close_intent', {
      cookieError,
      firstCleanupEvaluationError: cleanupError,
    });
    assert.equal(value.launches.length, 1);
    assert.deepEqual(value.cleanupEvaluations, [1, 1]);
    assert.deepEqual(value.cleanupRejectionStates, [
      {
        id: 1,
        handlerIsOriginal: false,
        appListenerCount: 1,
        contentsListenerCount: 5,
      },
    ]);
    assert.equal(value.escaped, cookieError ?? cleanupError);
    const [initialApp] = value.electronApps;
    assert.equal(
      initialApp.handlers.get('browser:navigate'),
      initialApp.originalNavigate,
    );
    assert.equal(initialApp.app.listenerCount('web-contents-created'), 0);
    for (const event of [
      'did-start-navigation',
      'did-fail-load',
      'did-navigate',
      'did-finish-load',
      'destroyed',
    ])
      assert.equal(initialApp.contents.listenerCount(event), 0, event);
  });

async function runRegisteredLargeInventoryLaunch({
  platform,
  diagnosticsConfigured,
}) {
  const { readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const source = readFileSync(
    integratedDiagnosticSource(
      'apps/desktop-app/tests/electron/browser-profiles.spec.mjs',
      new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    ),
    'utf8',
  );
  const title =
    'large native inventory cancels without publication and measures again without blocking Settings';
  const start = source.indexOf(`largeInventoryTest(\n  '${title}'`);
  const end = source.indexOf(
    "test('product site clear verifies partitioned contexts",
    start,
  );
  assert.ok(
    start >= 0 && end > start,
    'registered large inventory seam missing',
  );
  const output = mkdtempSync(join(tmpdir(), 'selected-large-inventory-'));
  const bodyError = new Error('stop after selected launch');
  const launches = [];
  const closes = [];
  const attachments = [];
  let callback;
  let timeout;
  let boundary;
  const owner = {
    electronApp: { id: 'large-inventory-app' },
    userDataDir: '/owned-large-inventory',
    window: {},
    app: {
      openSettings: async () => {
        throw bodyError;
      },
    },
  };
  const largeInventoryTest = (name, registered) => {
    assert.equal(name, title);
    callback = registered;
  };
  const testApi = {
    setTimeout(value) {
      timeout = value;
    },
  };
  const ts = require('typescript');
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  vm.runInNewContext(code, {
    largeInventoryTest,
    test: testApi,
    process: {
      platform,
      env: diagnosticsConfigured
        ? { CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR: output }
        : {},
    },
    createSelectedLaunchBoundary: (slug, label, options) => {
      boundary = lifecycle.createSelectedLaunchBoundary(slug, label, {
        ...options,
        directory: diagnosticsConfigured ? output : '',
      });
      return boundary;
    },
    observeBoundary: lifecycle.observeBoundary,
    seedPanelWorktree: async (options) => {
      launches.push(options);
      return owner;
    },
    closeCanopy: async (electronApp, userDataDir, options) => {
      closes.push({ electronApp, userDataDir, options });
    },
    expect: () => {
      throw new Error('large inventory body advanced beyond selected launch');
    },
    require,
  });
  const largeInventory = {
    attachRecord: (...args) => attachments.push(args),
  };
  try {
    await assert.rejects(
      callback({ largeInventory }),
      (error) => error === bodyError,
    );
    return {
      timeout,
      boundary,
      launches,
      closes,
      attachments,
      owner,
    };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

for (const scenario of [
  {
    name: 'selected Windows boundary',
    platform: 'win32',
    diagnosticsConfigured: true,
    expectedFlag: '1',
  },
  {
    name: 'unconfigured Windows boundary',
    platform: 'win32',
    diagnosticsConfigured: false,
    expectedFlag: undefined,
  },
  {
    name: 'configured non-Windows boundary',
    platform: 'darwin',
    diagnosticsConfigured: true,
    expectedFlag: undefined,
  },
])
  test(`registered large inventory launch scopes admission emission to the ${scenario.name}`, async () => {
    const value = await runRegisteredLargeInventoryLaunch(scenario);
    assert.equal(value.timeout, 120000);
    assert.equal(value.launches.length, 1);
    assert.equal(value.closes.length, 1);
    assert.equal(value.attachments.length, 1);
    const [launchOptions] = value.launches;
    assert.equal(
      launchOptions?.env?.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS,
      scenario.expectedFlag,
    );
    assert.equal(
      launchOptions.onSetupFailure,
      value.boundary.options.onSetupFailure,
    );
    assert.equal(
      launchOptions.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
      value.boundary.options.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
    );
    if (scenario.expectedFlag === undefined)
      assert.equal(launchOptions, value.boundary.options);
    assert.equal(value.attachments[0][0], value.boundary.record);
    assert.equal(
      value.attachments[0][1].launchBoundaryBase,
      value.boundary.base,
    );
    assert.equal(value.closes[0].electronApp, value.owner.electronApp);
    assert.equal(value.closes[0].userDataDir, value.owner.userDataDir);
    assert.equal(value.closes[0].options.boundaryRecord, value.boundary.record);
  });

async function exerciseLargeInventoryFixture({
  failStage,
  delayedSibling,
  truncateFailure,
  closeFailure,
  destinationPresent = false,
  destinationDevice = 17,
  bodyFailure,
  renameFailure,
  installTwice = false,
} = {}) {
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const events = [];
  const records = [];
  let openCount = 0,
    truncateCount = 0,
    closeCount = 0,
    outstanding = 0,
    maxOutstanding = 0;
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const primary = new Error('original fixture I/O failure');
  const record = (stage, details) => records.push({ stage, ...details });
  const [fixture, options] = lifecycle.createLargeInventoryFixture({
    record,
    temporaryDirectory: '/fixture-volume',
    mkdtemp: async (prefix) => {
      events.push(['mkdtemp', prefix]);
      return '/fixture-volume/owned-root';
    },
    mkdir: async (directory) => events.push(['mkdir', directory]),
    open: async (file, flags) => {
      assert.equal(flags, 'wx');
      const index = openCount;
      openCount++;
      if (index === 33 && failStage === 'open') throw primary;
      if (index === 34 && delayedSibling) {
        events.push(['sibling', 'entered']);
        await delayedSibling.wait;
        events.push(['sibling', 'settled']);
      }
      outstanding++;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      return {
        truncate: async (bytes) => {
          assert.equal(bytes, 107375);
          truncateCount++;
          if (index === 33 && truncateFailure) throw truncateFailure;
          if (index === 33 && failStage === 'truncate') throw primary;
        },
        close: async () => {
          closeCount++;
          outstanding--;
          if (index === 33 && closeFailure) throw closeFailure;
          if (index === 33 && failStage === 'close') throw primary;
        },
      };
    },
    lstat: async () => {
      if (destinationPresent) return { isDirectory: () => true };
      throw missing;
    },
    stat: async (target) => ({
      dev: target === '/owned/native' ? destinationDevice : 17,
    }),
    rename: async (source, destination) => {
      events.push(['rename', source, destination]);
      if (renameFailure) throw renameFailure;
    },
    rm: async (target, removeOptions) =>
      events.push(['rm', target, removeOptions]),
    now: (() => {
      let value = 0;
      return () => ++value;
    })(),
  });
  let inventory;
  let escaped;
  try {
    await fixture({}, async (value) => {
      inventory = value;
      value.attachRecord(record, {
        launchBoundaryBase: '/launch-boundary',
      });
      if (bodyFailure) throw bodyFailure;
      await value.install('/owned/native');
      if (installTwice)
        await assert.rejects(
          value.install('/owned/native'),
          /already attempted/,
        );
    });
  } catch (error) {
    escaped = error;
  }
  return {
    options,
    inventory,
    primary,
    escaped,
    events,
    records,
    openCount,
    truncateCount,
    closeCount,
    outstanding,
    maxOutstanding,
  };
}

test('large inventory fixture owns exact sparse preparation and transfers once by same-device rename', async () => {
  const value = await exerciseLargeInventoryFixture({ installTwice: true });
  assert.equal(value.escaped, undefined);
  assert.equal(value.options.timeout, 120000);
  assert.equal(value.inventory.files, 10000);
  assert.equal(value.inventory.bytes, 107375);
  assert.equal(value.inventory.logicalBytes, 1073750000);
  assert.equal(value.openCount, 10000);
  assert.equal(value.truncateCount, 10000);
  assert.equal(value.closeCount, 10000);
  assert.equal(value.maxOutstanding, 32);
  assert.equal(value.outstanding, 0);
  assert.deepEqual(
    value.events.filter(([kind]) => kind === 'rename'),
    [
      [
        'rename',
        '/fixture-volume/owned-root/inventory-fixture',
        '/owned/native/inventory-fixture',
      ],
    ],
  );
  assert.deepEqual(
    value.events.filter(([kind]) => kind === 'rm'),
    [['rm', '/fixture-volume/owned-root', { recursive: true, force: true }]],
  );
  assert.ok(
    value.records.some(
      (record) =>
        record.stage === 'inventory-transfer' &&
        record.outcome === 'fulfilled' &&
        record.sameDevice === true,
    ),
  );
  assert.ok(
    value.records.some(
      (record) =>
        record.stage === 'launch-boundary-link' &&
        record.launchBoundaryBase === '/launch-boundary',
    ),
  );
  assert.ok(
    value.records.some(
      (record) =>
        record.stage === 'large-inventory-fixture-link' &&
        record.launchBoundaryBase === '/launch-boundary',
    ),
  );
});

test('large inventory fixture retains pre-transfer ownership for body, destination, volume, and rename failures', async () => {
  const bodyFailure = new Error('body failed before transfer');
  const body = await exerciseLargeInventoryFixture({ bodyFailure });
  assert.equal(body.escaped, bodyFailure);
  assert.equal(body.events.filter(([kind]) => kind === 'rename').length, 0);
  assert.equal(body.events.filter(([kind]) => kind === 'rm').length, 1);

  const destination = await exerciseLargeInventoryFixture({
    destinationPresent: true,
  });
  assert.match(
    destination.escaped?.message ?? '',
    /destination already exists/i,
  );
  assert.equal(
    destination.events.filter(([kind]) => kind === 'rename').length,
    0,
  );
  assert.equal(destination.events.filter(([kind]) => kind === 'rm').length, 1);

  const volume = await exerciseLargeInventoryFixture({ destinationDevice: 23 });
  assert.match(volume.escaped?.message ?? '', /same device/i);
  assert.equal(volume.events.filter(([kind]) => kind === 'rename').length, 0);
  assert.equal(volume.events.filter(([kind]) => kind === 'rm').length, 1);

  const renameFailure = new Error('atomic rename failed');
  const rename = await exerciseLargeInventoryFixture({ renameFailure });
  assert.equal(rename.escaped, renameFailure);
  assert.equal(rename.events.filter(([kind]) => kind === 'rename').length, 1);
  assert.equal(rename.events.filter(([kind]) => kind === 'rm').length, 1);
});

test('large inventory waits for every started sibling before summary and staging cleanup', async () => {
  let release;
  const delayedSibling = {
    wait: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const running = exerciseLargeInventoryFixture({
    failStage: 'open',
    delayedSibling,
  });
  try {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    const interim = await Promise.race([
      running.then((value) => ({ settled: true, value })),
      new Promise((resolve) => setImmediate(() => resolve({ settled: false }))),
    ]);
    assert.equal(
      interim.settled,
      false,
      'fixture must await the delayed sibling',
    );
  } finally {
    release();
  }
  const value = await running;
  assert.equal(value.escaped, value.primary);
  const siblingSettled = value.events.findIndex(
    (event) => event[0] === 'sibling' && event[1] === 'settled',
  );
  const cleanupEntered = value.records.findIndex(
    (record) =>
      record.stage === 'fixture-cleanup' && record.outcome === 'entered',
  );
  assert.notEqual(siblingSettled, -1);
  assert.notEqual(cleanupEntered, -1);
  assert.ok(
    value.records.findIndex(
      (record) => record.stage === 'preparation-summary',
    ) < cleanupEntered,
  );
});

test('large inventory preserves truncate as primary when closing the same handle also fails', async () => {
  const truncateFailure = new Error('truncate primary');
  const closeFailure = new Error('close secondary');
  const value = await exerciseLargeInventoryFixture({
    truncateFailure,
    closeFailure,
  });
  assert.equal(value.escaped, truncateFailure);
  assert.ok(
    value.records.some(
      (record) =>
        record.stage === 'preparation-secondary-error' &&
        record.index === 33 &&
        record.primaryStage === 'truncate' &&
        record.secondaryStage === 'close',
    ),
  );
});

test('observed terminal cleanup preserves order and first error while attempting later settled steps', async () => {
  const { runObservedCleanupSteps } =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const first = new Error('response destroy failed');
  const later = new Error('server close failed');
  const calls = [];
  const records = [];
  await assert.rejects(
    runObservedCleanupSteps(
      [
        [
          'response',
          () => {
            calls.push('response');
            throw first;
          },
        ],
        ['connections', () => calls.push('connections')],
        [
          'server',
          async () => {
            calls.push('server');
            throw later;
          },
        ],
        ['owner', () => calls.push('owner')],
      ],
      (stage, details) => records.push({ stage, ...details }),
    ),
    (error) => error === first,
  );
  assert.deepEqual(calls, ['response', 'connections', 'server', 'owner']);
  assert.deepEqual(
    records.map(({ stage, outcome }) => [stage, outcome]),
    [
      ['response', 'entered'],
      ['response', 'rejected'],
      ['connections', 'entered'],
      ['connections', 'fulfilled'],
      ['server', 'entered'],
      ['server', 'rejected'],
      ['owner', 'entered'],
      ['owner', 'fulfilled'],
    ],
  );
});

test('observed terminal cleanup persists a pending entry before invocation and does not start later work', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createBoundaryRecorder, runObservedCleanupSteps } =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const root = mkdtempSync(join(tmpdir(), 'pending-cleanup-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'fixture.jsonl');
  const record = createBoundaryRecorder(file);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let laterCalls = 0;
  const running = runObservedCleanupSteps(
    [
      ['server-close', () => pending],
      ['owner-close', () => laterCalls++],
    ],
    record,
  );

  try {
    assert.deepEqual(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .map(({ stage, outcome }) => [stage, outcome]),
      [['server-close', 'entered']],
    );
    assert.equal(laterCalls, 0);
  } finally {
    release();
  }
  await running;
  assert.equal(laterCalls, 1);
});

test('queued local HTTP boundary installs only with opt-in and persists actual pending server close before owner close', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const disabled = new EventEmitter();
  disabled.listening = true;
  assert.equal(
    lifecycle.createLocalHttpBoundaryObserver(disabled, [], undefined),
    undefined,
  );
  assert.equal(disabled.listenerCount('connection'), 0);
  assert.equal(disabled.listenerCount('close'), 0);

  const root = mkdtempSync(join(tmpdir(), 'queued-http-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'fixture.jsonl');
  const record = lifecycle.createBoundaryRecorder(file);
  const server = new EventEmitter();
  server.listening = true;
  let closeCallback;
  server.close = (callback) => {
    closeCallback = callback;
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).stage, 'server-close');
    assert.equal(rows.at(-1).outcome, 'entered');
    assert.equal(ownerCalls, 0);
  };
  const held = [{ response: { destroyed: false, writableEnded: false } }];
  const serverBoundary = lifecycle.createLocalHttpBoundaryObserver(
    server,
    held,
    record,
  );
  const evidence = { cleanup: [] };
  const cleanupRecord = lifecycle.createObservedCleanupRecorder({
    evidence,
    record,
    serverBoundary,
    launchIdentity: { userDataDir: '/owned', electronPid: 42 },
  });
  let ownerCalls = 0;
  const running = lifecycle.runObservedCleanupSteps(
    [
      [
        'server-close',
        () => lifecycle.closeServerWithBoundary(server, serverBoundary),
      ],
      ['owner-close', () => ownerCalls++],
    ],
    cleanupRecord,
  );
  try {
    while (!closeCallback) await Promise.resolve();
    assert.equal(ownerCalls, 0);
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      rows.some(
        ({ stage, outcome }) =>
          stage === 'server-close' && outcome === 'entered',
      ),
      true,
    );
    assert.equal(
      rows.some(({ stage }) => stage === 'owner-close'),
      false,
    );
  } finally {
    server.listening = false;
    server.emit('close');
    closeCallback?.();
  }
  await running;
  assert.equal(ownerCalls, 1);
  assert.equal(
    evidence.cleanup.some(
      ({ stage, outcome }) =>
        stage === 'server-close' && outcome === 'fulfilled',
    ),
    true,
  );
});

async function runRegisteredPersistentClose() {
  const lifecycle =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const { tmpdir } = await import('node:os');
  const source = fs.readFileSync(
    new URL('../electron/browser-chrome.spec.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf("  test('persistent auth and local storage");
  const end = source.indexOf("  test('agent automation", start);
  const directory = fs.mkdtempSync(
    nodePath.join(tmpdir(), 'persistent-close-'),
  );
  const launches = [],
    closes = [];
  let callback,
    registry = { worktrees: [{ id: 'demo-main' }] };
  const test = (_title, value) => {
    callback = value;
  };
  test.setTimeout = (value) => assert.equal(value, 180000);
  const check = {
    toBe() {},
    toBeTruthy() {},
    toContain() {},
    toContainText() {},
    toMatchObject() {},
  };
  check.not = check;
  const expectation = () => check;
  expectation.poll = expectation;
  const window = {
    getByTestId: () => ({}),
    evaluate: async () => ({ id: 'browser', text: '' }),
  };
  const ts = require('typescript');
  vm.runInNewContext(
    ts.transpileModule(source.slice(start, end), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    {
      ...lifecycle,
      test,
      expect: expectation,
      path: nodePath,
      process,
      createSelectedLaunchBoundary: (slug, label, options) =>
        lifecycle.createSelectedLaunchBoundary(slug, label, {
          ...options,
          directory,
        }),
      startLocalPages: async () => ({ port: 4000, close: async () => {} }),
      seedPanelWorktree: async (options) => {
        launches.push(options);
        return {
          electronApp: { id: launches.length },
          window,
          userDataDir: '/owned',
        };
      },
      closeCanopy: async (app, _dir, options) => closes.push({ app, options }),
      readFileSync: (file) =>
        JSON.stringify(
          file.endsWith('workspace.json') ? { repoPath: '/repo' } : registry,
        ),
      writeFileSync: (_file, value) => {
        registry = JSON.parse(value);
      },
      addBrowserPanel: async () => ({ browserId: 'browser', panelId: 'panel' }),
      navigatePane: async () => {},
      require: (name) =>
        name === 'node:fs'
          ? {
              existsSync: () => true,
              realpathSync: { native: (value) => value },
            }
          : name === 'node:child_process'
            ? {
                execFileSync: () =>
                  'worktree /owned/workspaces/demo-ts-pnpm-vite/worktrees/demo-auth-isolated\0',
              }
            : require(name),
    },
  );
  try {
    await callback();
    return { launches, closes };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('registered persistent-auth flow binds both closes to distinct launch streams and both exact owners', async () => {
  const { launches, closes } = await runRegisteredPersistentClose();
  assert.equal(launches.length, 2);
  const configs = launches.map((launch) =>
    JSON.parse(launch?.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS ?? '{}'),
  );
  assert.deepEqual(
    configs.map((config) => config.mode),
    ['close', 'close'],
  );
  assert.notEqual(configs[0].launchId, configs[1].launchId);
  assert.equal(configs[0].owners.length, 2);
  assert.deepEqual(
    closes.map((close) => close.app.id),
    [1, 2],
  );
  assert.equal(typeof closes[0].options.boundaryRecord, 'function');
  assert.notEqual(
    closes[0].options.boundaryRecord,
    closes[1].options.boundaryRecord,
  );
});

for (const failStage of ['open', 'truncate', 'close'])
  test(`registered large inventory preserves original ${failStage} error and partial timing without extending the workload`, async () => {
    const value = await exerciseLargeInventoryFixture({ failStage });
    assert.equal(value.escaped, value.primary);
    assert.equal(value.openCount, 64);
    assert.equal(value.outstanding, 0);
    const summary = value.records.find(
      (row) => row.stage === 'preparation-summary',
    );
    assert.equal(summary.outcome, 'rejected');
    assert.equal(summary.error.stage, failStage);
    assert.equal(summary.error.index, 33);
    assert.ok(summary.completedFiles < 10000);
  });

test('per-launch cleanup retains primary close failure through retry and closes the setup owner with disabled output', async () => {
  const { createSelectedLaunchBoundary } =
    await import('../electron/browser-profile-test-lifecycle.mjs');
  const first = new Error('first close'),
    later = new Error('later close');
  const calls = [];
  const owner = { electronApp: {}, userDataDir: '/owned' };
  const boundary = createSelectedLaunchBoundary('case', 'initial', {
    directory: '',
    close: async (...args) => {
      calls.push(args);
      throw calls.length === 1 ? first : later;
    },
  });
  await assert.rejects(boundary.close(owner), (error) => error === first);
  await assert.rejects(boundary.close(owner), (error) => error === first);
  const setup = new Error('setup');
  await assert.rejects(
    boundary.options.onSetupFailure({ ...owner, error: setup }),
    (error) => error === setup,
  );
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      ([app, directory]) =>
        app === owner.electronApp && directory === owner.userDataDir,
    ),
  );
});

test('startup close validation preserves the existing loaded-task selection with three owners', async () => {
  const owners = ['demo-main', 'review', 'advisor'].map((worktreeId) => ({
    projectId: 'project',
    worktreeId,
  }));
  const value = await runStartupBoundary({
    mode: 'loaded-task',
    config: { owners },
  });
  assert.equal(
    value.output.find((row) => row.stage === 'loaded-owners')?.owners.length,
    3,
  );
  assert.ok(
    value.output.some((row) => row.stage === 'loaded-task-observer-armed'),
  );
});

test('startup selected observer is silent for non-E2E, invalid identities, and oversized config', async () => {
  for (const options of [
    { e2e: false },
    { rawOverride: 'x'.repeat(4097) },
    { config: { launchId: 'invalid identity' } },
    {
      config: {
        owners: Array.from({ length: 3 }, () => ({
          projectId: 'p',
          worktreeId: 'w',
        })),
      },
    },
  ]) {
    const value = await runStartupBoundary(options);
    assert.deepEqual(value.output, []);
    assert.deepEqual(value.app.eventNames(), []);
  }
});

async function runTwoPanelScreenshotLaunchWiring(
  enabled,
  { nativeViewportDiagnostic = false } = {},
) {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../electron/browser-chrome.spec.mjs', import.meta.url),
    'utf8',
  );
  const title =
    'two Browser panels: transactional add, live identity, side-by-side, close destruction';
  const start = source.indexOf(`  test('${title}'`);
  const end = source.indexOf('\n  });\n});', start) + '\n  });'.length;
  const helperStart = source.indexOf('function assertElectronTerminalTuple');
  const helperEnd = source.indexOf(
    '\nfunction serializeArchiveFailureMetadata',
    helperStart,
  );
  assert.ok(start >= 0 && end > start, 'actual two-panel case must be found');
  assert.ok(
    helperStart >= 0 && helperEnd > helperStart,
    'actual terminal qualification helpers must be found',
  );
  const callbacks = new Map();
  const launchOptions = [];
  const boundaryCalls = [];
  const stop = new Error('stop after actual seed launch options');
  const localTest = (name, callback) => callbacks.set(name, callback);
  localTest.setTimeout = (timeout) => assert.equal(timeout, 180000);
  const ts = require('typescript');
  const js = ts.transpileModule(
    `${source.slice(helperStart, helperEnd)}\n${source.slice(start, end)}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  vm.runInNewContext(js, {
    test: localTest,
    process: {
      env: nativeViewportDiagnostic
        ? { CANOPY_E2E_NATIVE_VIEWPORT_DIAGNOSTIC: '1' }
        : {},
    },
    startLocalPages: async () => ({ port: 4000, close: async () => {} }),
    createSelectedLaunchBoundary: (caseId, label, options) => {
      boundaryCalls.push({ caseId, label, options });
      return {
        options: enabled
          ? {
              env: {
                CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
                  file: '/diagnostics/two-panels-main.jsonl',
                  mode: 'close',
                  caseId,
                  launchId: `${caseId}-${label}-fixture`,
                  fixturePid: 17,
                  owners: [],
                }),
              },
            }
          : {},
        close: () => {
          throw new Error('selected boundary must not own case cleanup');
        },
      };
    },
    closeCanopy: async () => {},
    seedPanelWorktree: async (options) => {
      launchOptions.push(options);
      throw stop;
    },
  });
  const callback = callbacks.get(title);
  assert.equal(typeof callback, 'function');
  await assert.rejects(callback({}, {}), (error) => error === stop);
  return { boundaryCalls, launchOptions };
}

test('actual two-panel case supplies only the selected initial screenshot environment to its seed launch', async () => {
  const value = await runTwoPanelScreenshotLaunchWiring(true);
  assert.equal(value.boundaryCalls.length, 1);
  assert.equal(value.boundaryCalls[0].caseId, 'two-browser-panels-screenshot');
  assert.equal(value.boundaryCalls[0].label, 'initial');
  assert.equal(typeof value.boundaryCalls[0].options.close, 'function');
  assert.equal(value.launchOptions.length, 1);
  const raw =
    value.launchOptions[0]?.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
  assert.equal(typeof raw, 'string');
  const config = JSON.parse(raw);
  assert.equal(config.mode, 'screenshot');
  assert.equal(config.caseId, 'two-browser-panels-screenshot');
  assert.equal(config.fixturePid, 17);
  assert.match(config.launchId, /-initial-/);
  assert.deepEqual(Object.keys(value.launchOptions[0]).sort(), [
    'env',
    'viewportSize',
  ]);
  assert.equal(value.launchOptions[0].viewportSize, null);

  const disabled = await runTwoPanelScreenshotLaunchWiring(false);
  assert.equal(disabled.boundaryCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(disabled.launchOptions)), [
    { viewportSize: null },
  ]);

  const diagnostic = await runTwoPanelScreenshotLaunchWiring(true, {
    nativeViewportDiagnostic: true,
  });
  assert.equal(diagnostic.launchOptions.length, 1);
  assert.equal(
    Object.hasOwn(diagnostic.launchOptions[0], 'viewportSize'),
    false,
  );
});

async function runActualTwoPanelScreenshotBody(options = {}) {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../electron/browser-chrome.spec.mjs', import.meta.url),
    'utf8',
  );
  const title =
    'two Browser panels: transactional add, live identity, side-by-side, close destruction';
  const start = source.indexOf(`  test('${title}'`);
  const end = source.indexOf('\n  });\n});', start) + '\n  });'.length;
  const helperStart = source.indexOf('function assertElectronTerminalTuple');
  const helperEnd = source.indexOf(
    '\nfunction serializeArchiveFailureMetadata',
    helperStart,
  );
  assert.ok(start >= 0 && end > start, 'actual two-panel case must be found');
  assert.ok(
    helperStart >= 0 && helperEnd > helperStart,
    'actual terminal qualification helpers must be found',
  );
  const callbacks = new Map();
  const screenshotIds = [];
  let pendingScreenshots = [];
  const attachments = [];
  const viewportChanges = [];
  const boundaryRecords = [];
  let seedLaunchOptions;
  let timeout,
    activeScreenshots = 0,
    maximumConcurrentScreenshots = 0,
    captureMatches = 0,
    captureDifference = 0,
    originalCloseCalls = 0,
    selectedCloseCalls = 0,
    pagesCloseCalls = 0,
    panelCount = 0,
    nativeAssociationCalls = 0,
    nativeHandleDisposals = 0,
    resizeDispatches = 0,
    observedElectronApps = 0,
    injectedExitCalls = 0,
    recordAttempts = 0;
  const dryRunEvidenceCaptures = [];
  let closeBoundaryRecord;
  const localTest = (name, callback) => callbacks.set(name, callback);
  localTest.setTimeout = (value) => {
    timeout = value;
  };
  const locator = (name = '') => ({
    click: async () => {},
    hover: async () => {},
    focus: async () => {},
    blur: async () => {},
    locator: (child) => locator(`${name}/${child}`),
    getByTestId: (child) => locator(`${name}/${child}`),
    getAttribute: async (attribute) =>
      attribute === 'src'
        ? name.includes('panel-tab-panel-1')
          ? 'first-favicon'
          : 'second-favicon'
        : null,
    evaluate: async (fn) =>
      fn.toString().includes('whiteSpace') ? 'nowrap' : undefined,
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 200 }),
  });
  let rendererViewport = {
    width: options.initialRendererWidth ?? 1400,
    height: options.initialRendererHeight ?? 900,
  };
  let viewportAligned = false;
  let hostVisible = Boolean(options.hostVisible);
  let hostMinimized = Boolean(options.hostMinimized);
  let afterCaptureMutationApplied = false;
  let child17PropertyReads = 0;
  const capturePairs = options.capturePairs ?? [
    { first: 'success', second: 'success' },
  ];
  const page = {
    get innerWidth() {
      return rendererViewport.width;
    },
    get innerHeight() {
      return rendererViewport.height;
    },
    api: {
      browser: {
        screenshot: ({ browserId }) => {
          const pairIndex = Math.floor(screenshotIds.length / 2);
          const position = screenshotIds.length % 2 === 0 ? 'first' : 'second';
          screenshotIds.push(browserId);
          activeScreenshots++;
          maximumConcurrentScreenshots = Math.max(
            maximumConcurrentScreenshots,
            activeScreenshots,
          );
          return new Promise((resolve, reject) => {
            pendingScreenshots.push({
              browserId,
              outcome: capturePairs[pairIndex]?.[position] ?? 'success',
              reject,
              resolve,
            });
            if (pendingScreenshots.length === 2) {
              const pair = pendingScreenshots;
              pendingScreenshots = [];
              if (pairIndex === 1 && !afterCaptureMutationApplied) {
                afterCaptureMutationApplied = true;
                if (options.hostVisibleAfterCapture) hostVisible = true;
                if (options.hostMinimizedAfterCapture) hostMinimized = true;
              }
              for (const pending of pair) {
                if (pending.outcome === 'success')
                  pending.resolve({
                    dataUrl: `data:image/png;base64,${pending.browserId}-${pairIndex}`,
                  });
                else
                  pending.reject(
                    pending.outcome instanceof Error
                      ? pending.outcome
                      : new Error(String(pending.outcome)),
                  );
                activeScreenshots--;
              }
            }
          });
        },
      },
    },
    getByTestId: (name) => locator(name),
    locator: (name) => locator(name),
    evaluate: async (fn, argument) => {
      const text = fn.toString();
      if (text.includes('window.api.browser.screenshot')) return fn(argument);
      if (text.includes('getActiveGroupId')) return 'group-one';
      if (text.includes("dispatchEvent(new Event('resize'))")) {
        resizeDispatches++;
        return undefined;
      }
      if (text.includes('innerWidth') && text.includes('innerHeight'))
        return fn(argument);
      return undefined;
    },
    setViewportSize: async (size) => {
      const measured = { width: size.width, height: size.height };
      viewportChanges.push(measured);
      rendererViewport = measured;
      viewportAligned = true;
    },
    screenshot: async () => {},
  };
  const childViews = Array.from(
    { length: options.nativeChildCount ?? 2 },
    (_, index) => {
      if (index === 16 && options.throwOnChild17Read) {
        return Object.defineProperty({}, 'webContents', {
          get() {
            child17PropertyReads++;
            throw new Error('child 17 properties must not be read');
          },
        });
      }
      const id = 21 + index;
      const title =
        index === 0 ? 'Page One' : index === 1 ? 'Page Two' : `Other ${index}`;
      return {
        webContents: {
          id,
          getTitle: () => title,
          isDestroyed: () => false,
        },
        getBounds: () =>
          viewportAligned
            ? { x: 20 + index * 40, y: 120, width: 30, height: 400 }
            : { x: 220 + index * 40, y: 805, width: 30, height: 96 },
        getVisible: () => true,
      };
    },
  );
  const nativeHost = {
    id: options.hostId ?? 7,
    webContents: { id: 11 },
    contentView: {
      children: childViews,
      getBounds: () => ({ x: 0, y: 0, width: 1008, height: 681 }),
    },
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 720 }),
    getContentBounds: () => ({ x: 8, y: 31, width: 1008, height: 681 }),
    isDestroyed: () => Boolean(options.hostDestroyed),
    isMinimized: () => hostMinimized,
    isVisible: () => hostVisible,
  };
  const electronApp = {
    process: () => ({ pid: 1777, once: () => {} }),
    evaluate: async (fn) => {
      if (fn.toString().includes('app.exit')) {
        injectedExitCalls++;
        if (options.injectionError) throw options.injectionError;
      }
    },
    browserWindow: async (associatedPage) => {
      assert.equal(associatedPage, page);
      nativeAssociationCalls++;
      return {
        evaluate: async (fn, argument) => fn(nativeHost, argument),
        dispose: async () => {
          nativeHandleDisposals++;
        },
      };
    },
  };
  const selectedClose = async () => {
    selectedCloseCalls++;
  };
  const closeCanopy = async (_electronApp, _userDataDir, closeOptions) => {
    originalCloseCalls++;
    closeBoundaryRecord = closeOptions?.boundaryRecord;
    if (options.closeError) throw options.closeError;
    if (options.terminalCloseError)
      throw new ElectronTerminalResultError(options.terminalResult);
  };
  const selectedBoundaryRecord = (stage, details) => {
    recordAttempts++;
    if (options.recordError) throw options.recordError;
    boundaryRecords.push({ stage, details });
  };
  const expectValue = (actual) => {
    const chain = {
      toBe: async (expected) => assert.equal(actual, expected),
      toBeTruthy: async () => assert.ok(actual),
      toMatch: async (expected) => {
        assert.match(actual, expected);
        if (String(actual).startsWith('data:image/png;base64,')) {
          captureMatches++;
        }
      },
      toBeVisible: async () => {},
      toHaveCount: async () => {},
      toContainText: async () => {},
      toHaveText: async () => {},
      toHaveValue: async () => {},
    };
    chain.not = {
      toBe: async (expected) => {
        assert.notEqual(actual, expected);
        if (
          String(actual).startsWith('data:image/png;base64,') &&
          String(expected).startsWith('data:image/png;base64,')
        ) {
          captureDifference++;
        }
      },
      toEqual: async () => {},
    };
    return chain;
  };
  expectValue.poll = (probe, pollOptions) => ({
    toBe: async () => {},
    toBeLessThanOrEqual: async () => {},
    toEqual: async (expected) => {
      if (
        pollOptions?.message?.includes('native viewport') ||
        pollOptions?.message?.includes('Browser screenshot geometry')
      ) {
        const actual = await probe();
        try {
          assert.deepEqual(
            JSON.parse(JSON.stringify(actual)),
            JSON.parse(JSON.stringify(expected)),
          );
        } catch (error) {
          throw new Error(pollOptions.message, { cause: error });
        }
      }
    },
    not: { toEqual: async () => {} },
  });
  const ts = require('typescript');
  const js = ts.transpileModule(
    `${source.slice(helperStart, helperEnd)}\n${source.slice(start, end)}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  vm.runInNewContext(js, {
    test: localTest,
    expect: expectValue,
    startLocalPages: async () => ({
      port: 4000,
      close: async () => {
        pagesCloseCalls++;
        if (options.pagesCloseError) throw options.pagesCloseError;
      },
    }),
    createSelectedLaunchBoundary: (caseId, label, boundaryOptions) => ({
      options:
        options.selectedBoundary === false
          ? {}
          : {
              env: {
                CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
                  file: '/diagnostics/two-panels-main.jsonl',
                  mode: 'close',
                  caseId,
                  launchId: `${caseId}-${label}-fixture`,
                  fixturePid: 17,
                }),
              },
            },
      close: selectedClose,
      record: selectedBoundaryRecord,
      suppliedClose: boundaryOptions.close,
    }),
    closeCanopy,
    captureDaemonDryRunEvidence: async (app) => {
      assert.equal(app, electronApp);
      dryRunEvidenceCaptures.push({
        injectedExitCallsBefore: injectedExitCalls,
      });
      return null;
    },
    ElectronTerminalResultError,
    observeElectronTerminalResult: (app) => {
      assert.equal(app, electronApp);
      observedElectronApps++;
      return (
        options.terminalResult ?? {
          pid: 1777,
          exit: { code: 0, signal: null },
          close: { code: 0, signal: null },
          error: undefined,
        }
      );
    },
    isPlaywrightTargetClosedError: (error) =>
      options.classificationError
        ? (() => {
            throw options.classificationError;
          })()
        : error === options.targetClosedError,
    process: {
      env: {
        ...(options.diagnostic
          ? { CANOPY_E2E_NATIVE_VIEWPORT_DIAGNOSTIC: '1' }
          : {}),
        ...(options.environment ?? {}),
      },
      pid: 1234,
    },
    seedPanelWorktree: async (launchOptions) => {
      seedLaunchOptions = launchOptions;
      if (
        launchOptions?.viewportSize === null &&
        !options.forceRendererMismatch
      ) {
        rendererViewport = { width: 1008, height: 681 };
        viewportAligned = true;
      }
      return {
        electronApp,
        userDataDir: '/owned',
        window: page,
      };
    },
    addBrowserPanel: async () => {
      if (options.bodyError) throw options.bodyError;
      panelCount++;
      return {
        browserId: `browser-${panelCount}`,
        panelId: `panel-${panelCount}`,
        groupId: 'group-one',
      };
    },
    setUiScale: async () => {},
    navigatePane: async () => {},
    movePanelViaApi: async () => {},
    browserPanels: async () => [
      { browserId: 'browser-1', panelId: 'panel-1', groupId: 'group-one' },
      { browserId: 'browser-2', panelId: 'panel-2', groupId: 'group-two' },
    ],
    nativeBrowserViews: async () => [],
    browserVisibilityByTitle: async () => ({ first: true, second: true }),
    browserViewByTitle: async (title) => ({
      visible: true,
      bounds:
        title === 'Page One'
          ? { x: 0, y: 0, width: 300, height: 200 }
          : { x: 300, y: 0, width: 300, height: 200 },
    }),
    CanopyAppDriver: class {
      async openUsagePage() {}
      async expectMainPage() {}
      async openSettings() {}
      async closeSettings() {}
    },
    closePanelTab: async () => {},
    PAGE_ONE_TITLE: 'Page One',
    PAGE_TWO_TITLE: 'Page Two',
  });
  const callback = callbacks.get(title);
  assert.equal(typeof callback, 'function');
  let escaped = null;
  try {
    await callback(
      {},
      {
        attach: async (name, attachment) => {
          attachments.push({
            name,
            contentType: attachment.contentType,
            value: JSON.parse(String(attachment.body)),
          });
        },
        outputPath: () => '/tmp/not-written.png',
      },
    );
  } catch (error) {
    escaped = error;
  }
  return {
    attachments,
    timeout,
    screenshotIds,
    maximumConcurrentScreenshots,
    captureMatches,
    captureDifference,
    originalCloseCalls,
    selectedCloseCalls,
    pagesCloseCalls,
    nativeAssociationCalls,
    nativeHandleDisposals,
    observedElectronApps,
    injectedExitCalls,
    dryRunEvidenceCaptures,
    resizeDispatches,
    viewportChanges,
    child17PropertyReads,
    boundaryRecords,
    recordAttempts,
    closeUsesSelectedBoundary: closeBoundaryRecord === selectedBoundaryRecord,
    closeBoundaryRecord,
    launchBoundaryMode: seedLaunchOptions?.env
      ? JSON.parse(
          seedLaunchOptions.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
        ).mode
      : undefined,
    escaped,
  };
}

test('actual two-panel source selects opt-in native close qualification and observes its real Electron app before the body', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'clean0',
    },
  });
  assert.equal(value.launchBoundaryMode, 'close');
  assert.equal(value.observedElectronApps, 1);
  assert.equal(value.injectedExitCalls, 0);
  assert.deepEqual(value.dryRunEvidenceCaptures, []);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
  assert.equal(value.escaped, null);
  assert.equal(value.closeUsesSelectedBoundary, true);
  assert.equal(value.boundaryRecords.length, 1);
  const mirror = value.boundaryRecords[0];
  assert.equal(mirror.stage, 'native-close-handle-result');
  assert.equal(mirror.details.mode, 'clean0');
  assert.equal(mirror.details.child.pid, 1777);
  assert.deepEqual(JSON.parse(JSON.stringify(mirror.details.child.exit)), {
    code: 0,
    signal: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(mirror.details.child.close)), {
    code: 0,
    signal: null,
  });
  assert.equal(mirror.details.child.error, undefined);
});

test('actual two-panel source treats an optional native terminal mirror failure as passive evidence', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'clean0',
    },
    recordError: new Error('optional recorder unavailable'),
  });
  assert.equal(value.escaped, null);
  assert.equal(value.recordAttempts, 1);
  assert.deepEqual(value.boundaryRecords, []);
  assert.equal(value.closeUsesSelectedBoundary, true);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source uses its terminal helpers to reject invalid and pending clean0 results after cleanup', async () => {
  for (const [label, terminalResult, pattern] of [
    [
      'invalid PID',
      {
        pid: 0,
        exit: { code: 0, signal: null },
        close: { code: 0, signal: null },
        error: undefined,
      },
      /positive PID/,
    ],
    [
      'pending close',
      {
        pid: 1777,
        exit: { code: 0, signal: null },
        close: undefined,
        error: undefined,
      },
      /terminal close/,
    ],
  ]) {
    const value = await runActualTwoPanelScreenshotBody({
      diagnostic: true,
      environment: {
        CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'clean0',
      },
      terminalResult,
    });
    assert.match(value.escaped?.message ?? '', pattern, label);
    assert.equal(value.originalCloseCalls, 1, label);
    assert.equal(value.pagesCloseCalls, 1, label);
  }
});

test('actual two-panel source preserves a body failure before mandatory cleanup failure', async () => {
  const bodyError = new Error('Browser panel body failed');
  const cleanupError = new Error('mandatory cleanup failed');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    bodyError,
    closeError: cleanupError,
  });
  assert.equal(value.escaped?.name, 'AggregateError');
  assert.deepEqual([...value.escaped.errors], [bodyError, cleanupError]);
  assert.equal(value.injectedExitCalls, 0);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source treats target125 as transport-only and tolerates only the injected target-closed evaluation error', async () => {
  const targetClosedError = new Error('target closed');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    targetClosedError,
    injectionError: targetClosedError,
    terminalCloseError: true,
    terminalResult: {
      pid: 1777,
      exit: { code: 125, signal: null },
      close: { code: 125, signal: null },
      error: undefined,
    },
  });
  assert.equal(value.escaped, null);
  assert.equal(value.launchBoundaryMode, 'close');
  assert.equal(value.observedElectronApps, 1);
  assert.equal(value.injectedExitCalls, 1);
  assert.deepEqual(value.dryRunEvidenceCaptures, [
    { injectedExitCallsBefore: 0 },
  ]);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source rejects target125 when ordinary close unexpectedly fulfills', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    terminalResult: {
      pid: 1777,
      exit: { code: 125, signal: null },
      close: { code: 125, signal: null },
      error: undefined,
    },
  });
  assert.match(value.escaped?.message ?? '', /singleton terminal result/);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source preserves spoofed terminal-name and aggregate close errors', async () => {
  const matchingResult = {
    pid: 1777,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
    error: undefined,
  };
  const spoofed = Object.assign(new Error('spoofed terminal name'), {
    name: 'ElectronTerminalResultError',
    result: matchingResult,
  });
  const spoofedValue = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    closeError: spoofed,
    terminalResult: matchingResult,
  });
  assert.equal(spoofedValue.escaped, spoofed);
  const aggregate = new AggregateError(
    [new Error('close'), new Error('cleanup')],
    'close aggregate',
  );
  const aggregateValue = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    closeError: aggregate,
    terminalResult: matchingResult,
  });
  assert.equal(aggregateValue.escaped, aggregate);
  assert.equal(aggregateValue.originalCloseCalls, 1);
  assert.equal(aggregateValue.pagesCloseCalls, 1);
});

test('actual two-panel source retains an invalid dedicated target125 close error before tuple failure', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    terminalCloseError: true,
    terminalResult: {
      pid: 1777,
      exit: { code: 0, signal: null },
      close: undefined,
      error: undefined,
    },
  });
  assert.equal(value.escaped?.name, 'AggregateError');
  assert.equal(
    value.escaped.errors[0] instanceof ElectronTerminalResultError,
    true,
  );
  assert.equal(value.escaped.errors[0].result.exit.code, 0);
  assert.match(value.escaped.errors[1]?.message ?? '', /terminal exit/);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source retains close failure before pages-close failure', async () => {
  const closeError = new Error('ordinary close failed');
  const pagesCloseError = new Error('pages close failed');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'clean0',
    },
    closeError,
    pagesCloseError,
    terminalResult: {
      pid: 1777,
      exit: { code: 0, signal: null },
      close: { code: 0, signal: null },
      error: undefined,
    },
  });
  assert.equal(value.escaped?.name, 'AggregateError');
  assert.deepEqual([...value.escaped.errors], [closeError, pagesCloseError]);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source retains injection, terminal, and mandatory cleanup failures', async () => {
  const injectionError = new Error('injection failed');
  const cleanupError = new Error('mandatory cleanup failed');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    injectionError,
    closeError: cleanupError,
    terminalResult: {
      pid: 1777,
      exit: { code: 0, signal: null },
      close: undefined,
      error: undefined,
    },
  });
  assert.equal(value.escaped?.name, 'AggregateError');
  assert.deepEqual(
    [...value.escaped.errors],
    [injectionError, cleanupError, value.escaped.errors[2]],
  );
  assert.notEqual(value.escaped.errors[2], injectionError);
  assert.notEqual(value.escaped.errors[2], cleanupError);
  assert.equal(value.injectedExitCalls, 1);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source retains a target-closed injection when mandatory cleanup fails', async () => {
  const targetClosedError = new Error('target closed');
  const cleanupError = new Error('mandatory cleanup failed');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    targetClosedError,
    injectionError: targetClosedError,
    closeError: cleanupError,
    terminalResult: {
      pid: 1777,
      exit: { code: 125, signal: null },
      close: { code: 125, signal: null },
      error: undefined,
    },
  });
  assert.equal(value.escaped?.name, 'AggregateError');
  assert.deepEqual(
    [...value.escaped.errors],
    [cleanupError, targetClosedError],
  );
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel source retains classifier drift after mandatory cleanup', async () => {
  const targetClosedError = new Error('target closed');
  const classifierError = new Error('installed classifier unavailable');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    environment: {
      CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION: 'target125',
    },
    targetClosedError,
    injectionError: targetClosedError,
    classificationError: classifierError,
    terminalCloseError: true,
    terminalResult: {
      pid: 1777,
      exit: { code: 125, signal: null },
      close: { code: 125, signal: null },
      error: undefined,
    },
  });
  assert.equal(value.escaped?.name, 'AggregateError');
  assert.deepEqual(
    [...value.escaped.errors],
    [targetClosedError, classifierError],
  );
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel body retains concurrent explicit screenshots, assertions, deadline, and original cleanup', async () => {
  const value = await runActualTwoPanelScreenshotBody();
  assert.equal(value.timeout, 180000);
  assert.deepEqual(value.screenshotIds, ['browser-1', 'browser-2']);
  assert.equal(value.maximumConcurrentScreenshots, 2);
  assert.equal(value.captureMatches, 2);
  assert.equal(value.captureDifference, 1);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.selectedCloseCalls, 0);
  assert.equal(value.pagesCloseCalls, 1);
  assert.equal(value.nativeAssociationCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.equal(value.resizeDispatches, 0);
  assert.deepEqual(value.viewportChanges, []);
  assert.deepEqual(value.attachments, []);
  assert.equal(value.escaped, null);
  assert.equal(value.closeBoundaryRecord, undefined);
  assert.deepEqual(value.boundaryRecords, []);
});

test('actual ordinary two-panel body rejects mismatched host geometry before screenshot work', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    forceRendererMismatch: true,
  });
  assert.match(
    value.escaped?.message ?? '',
    /ordinary Browser screenshot geometry must settle/i,
  );
  assert.deepEqual(value.screenshotIds, []);
  assert.equal(value.nativeAssociationCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('actual two-panel body keeps the default path when the viewport flag has no selected outer destination', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    selectedBoundary: false,
  });
  assert.equal(value.escaped, null);
  assert.deepEqual(value.screenshotIds, ['browser-1', 'browser-2']);
  assert.equal(value.maximumConcurrentScreenshots, 2);
  assert.equal(value.captureMatches, 2);
  assert.equal(value.captureDifference, 1);
  assert.deepEqual(value.viewportChanges, []);
  assert.equal(value.resizeDispatches, 0);
  assert.equal(value.nativeAssociationCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.deepEqual(value.attachments, []);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('selected actual two-panel body records mismatch, aligns the renderer, and preserves the original successful pair', async () => {
  const initialError = new Error('Browser screenshot is unavailable');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    capturePairs: [
      { first: initialError, second: initialError },
      { first: 'success', second: 'success' },
    ],
  });
  assert.equal(value.escaped, null);
  assert.deepEqual(value.screenshotIds, [
    'browser-1',
    'browser-2',
    'browser-1',
    'browser-2',
  ]);
  assert.equal(value.maximumConcurrentScreenshots, 2);
  assert.deepEqual(value.viewportChanges, [{ width: 1008, height: 681 }]);
  assert.equal(value.resizeDispatches, 1);
  assert.equal(value.captureMatches, 2);
  assert.equal(value.captureDifference, 1);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
  assert.equal(value.nativeAssociationCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.equal(value.attachments.length, 1);
  const evidence = value.attachments[0];
  assert.equal(
    evidence.name,
    'two-browser-panels-native-viewport-discriminator.json',
  );
  assert.equal(evidence.contentType, 'application/json');
  assert.equal(evidence.value.diagnosticOnly, true);
  assert.equal(evidence.value.acceptanceEligible, false);
  assert.equal(
    evidence.value.outcome,
    'mismatch-caused-empty-to-nonempty-support',
  );
  assert.deepEqual(evidence.value.targetBrowserIds, ['browser-1', 'browser-2']);
  assert.deepEqual(evidence.value.before.renderer, {
    width: 1400,
    height: 900,
  });
  assert.equal(evidence.value.before.native.hostWindowId, 7);
  assert.equal(evidence.value.before.native.visible, false);
  assert.deepEqual(evidence.value.before.capture.outcomes, [
    {
      browserId: 'browser-1',
      ok: false,
      error: 'Browser screenshot is unavailable',
    },
    {
      browserId: 'browser-2',
      ok: false,
      error: 'Browser screenshot is unavailable',
    },
  ]);
  assert.deepEqual(evidence.value.alignment.renderer, {
    width: 1008,
    height: 681,
  });
  assert.equal(evidence.value.alignment.native.hostWindowId, 7);
  assert.equal(evidence.value.alignment.native.visible, false);
  assert.deepEqual(evidence.value.after.renderer, {
    width: 1008,
    height: 681,
  });
  assert.equal(evidence.value.after.native.hostWindowId, 7);
  assert.equal(evidence.value.after.native.visible, false);
  assert.deepEqual(
    [
      evidence.value.before.native.minimized,
      evidence.value.alignment.native.minimized,
      evidence.value.after.native.minimized,
    ],
    [false, false, false],
  );
  assert.deepEqual(
    [
      evidence.value.before.native.contentBounds.width,
      evidence.value.alignment.native.contentBounds.width,
      evidence.value.after.native.contentBounds.width,
    ],
    [1008, 1008, 1008],
  );
  assert.deepEqual(
    evidence.value.before.native.targets.map((target) => ({
      browserId: target.browserId,
      webContentsId: target.webContentsId,
    })),
    evidence.value.alignment.native.targets.map((target) => ({
      browserId: target.browserId,
      webContentsId: target.webContentsId,
    })),
  );
  assert.deepEqual(
    evidence.value.alignment.native.targets.map((target) => ({
      browserId: target.browserId,
      webContentsId: target.webContentsId,
    })),
    evidence.value.after.native.targets.map((target) => ({
      browserId: target.browserId,
      webContentsId: target.webContentsId,
    })),
  );
  assert.equal(
    evidence.value.after.native.targets.every(
      (target) => target.live && target.visible && target.intersectsContentView,
    ),
    true,
  );
  assert.equal(evidence.value.after.capture.ok, true);
  assert.deepEqual(
    evidence.value.after.capture.outcomes.map((outcome) => outcome.browserId),
    ['browser-1', 'browser-2'],
  );
  assert.deepEqual(
    evidence.value.after.capture.outcomes.map((outcome) => outcome.length),
    [
      'data:image/png;base64,browser-1-1'.length,
      'data:image/png;base64,browser-2-1'.length,
    ],
  );
  assert.equal(
    JSON.stringify(evidence.value).includes('base64,browser'),
    false,
  );
});

test('selected actual two-panel body classifies an initially successful capture as non-reproduction', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    capturePairs: [
      { first: 'success', second: 'success' },
      { first: 'success', second: 'success' },
    ],
  });
  assert.equal(value.escaped, null);
  assert.equal(value.attachments.length, 1);
  assert.equal(
    value.attachments[0].value.outcome,
    'initial-capture-succeeded-non-reproduction',
  );
  assert.equal(value.attachments[0].value.before.capture.ok, true);
  assert.deepEqual(value.viewportChanges, [{ width: 1008, height: 681 }]);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
});

test('selected actual two-panel body withholds support when the exact host becomes visible at the after-sample boundary', async () => {
  const initialError = new Error('Browser screenshot is unavailable');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    hostVisibleAfterCapture: true,
    capturePairs: [
      { first: initialError, second: initialError },
      { first: 'success', second: 'success' },
    ],
  });
  assert.match(value.escaped?.message, /native host is visible/i);
  assert.equal(value.captureMatches, 2);
  assert.equal(value.captureDifference, 1);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.equal(value.attachments.length, 1);
  const evidence = value.attachments[0].value;
  assert.notEqual(
    evidence.outcome,
    'mismatch-caused-empty-to-nonempty-support',
  );
  assert.equal(evidence.alignment.native.visible, false);
  assert.equal(evidence.after.native.visible, true);
  assert.match(evidence.diagnosticError, /native host is visible/i);
});

test('selected actual two-panel body preserves after-capture failure when the host changes after alignment', async () => {
  const afterError = new Error('after capture failed');
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    hostVisibleAfterCapture: true,
    capturePairs: [
      { first: 'success', second: 'success' },
      { first: afterError, second: afterError },
    ],
  });
  assert.equal(value.escaped, afterError);
  assert.deepEqual(value.screenshotIds, [
    'browser-1',
    'browser-2',
    'browser-1',
    'browser-2',
  ]);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.equal(value.attachments.length, 1);
  const evidence = value.attachments[0].value;
  assert.equal(evidence.diagnosticOnly, true);
  assert.equal(evidence.acceptanceEligible, false);
  assert.match(evidence.diagnosticError, /native host is visible/i);
  assert.equal(evidence.alignment.native.visible, false);
  assert.equal(evidence.after.native.visible, true);
  assert.equal(evidence.after.capture.ok, false);
  assert.equal(evidence.after.capture.error, 'after capture failed');
});

test('selected actual two-panel body caps native child reads and fails closed when discovery is truncated', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    nativeChildCount: 17,
    throwOnChild17Read: true,
    capturePairs: [
      { first: 'success', second: 'success' },
      { first: 'success', second: 'success' },
    ],
  });
  assert.equal(value.child17PropertyReads, 0);
  assert.match(value.escaped?.message, /truncated|incomplete/i);
  assert.deepEqual(value.viewportChanges, []);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.equal(value.attachments.length, 1);
  const evidence = value.attachments[0].value;
  assert.equal(evidence.before.native.childCount, 17);
  assert.equal(evidence.before.native.inspectedChildCount, 16);
  assert.equal(evidence.before.native.droppedChildCount, 1);
  assert.equal(evidence.before.native.truncated, true);
  assert.match(evidence.diagnosticError, /truncated|incomplete/i);
});

test('selected actual two-panel body fails clearly for a destroyed exact host while retaining artifact and cleanup', async () => {
  const value = await runActualTwoPanelScreenshotBody({
    diagnostic: true,
    hostDestroyed: true,
    capturePairs: [
      { first: 'success', second: 'success' },
      { first: 'success', second: 'success' },
    ],
  });
  assert.match(value.escaped?.message, /native host is destroyed/i);
  assert.deepEqual(value.screenshotIds, [
    'browser-1',
    'browser-2',
    'browser-1',
    'browser-2',
  ]);
  assert.deepEqual(value.viewportChanges, []);
  assert.equal(value.originalCloseCalls, 1);
  assert.equal(value.pagesCloseCalls, 1);
  assert.equal(value.nativeHandleDisposals, 1);
  assert.equal(value.attachments.length, 1);
  assert.match(
    value.attachments[0].value.diagnosticError,
    /native host is destroyed/i,
  );
  assert.equal(value.attachments[0].value.after.capture.ok, true);
});

// These tests exercise the same self-contained function serialized into Electron.
async function presentationObserverFixture(
  delegate = () => undefined,
  overrides = {},
) {
  const { installPresentationObserver } =
    await import('../electron/browser-profile-presentation-observer.mjs');
  const target = {
    userDataDir: '/synthetic-user-data',
    injectionId: 'injection-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    browserId: 'browser-1',
    profileId: 'profile-1',
    dialogId: 'dialog-1',
    runtimeGeneration: 2,
    storageGeneration: 3,
    ownerRendererWebContentsId: 10,
    bounds: { x: 20, y: 180, width: 640, height: 400 },
  };
  const bindings = new Map(
    ['bounds', 'visible'].map((name) => [`browser:set-${name}`, delegate]),
  );
  const ipcMain = {
    _invokeHandlers: bindings,
    removeHandler: (channel) => bindings.delete(channel),
    handle(channel, handler) {
      if (bindings.has(channel)) throw new Error('already registered');
      bindings.set(channel, handler);
    },
  };
  const diagnostic = () => ({
    receipt: { status: 'not-armed' },
    sessionsStatus: 'available',
    truncated: false,
    errors: [],
    sessions: [
      {
        browserId: 'browser-1',
        profileId: 'profile-1',
        runtimeGeneration: 2,
        storageGeneration: 3,
        webContentsId: 11,
        hostWindowId: 12,
        ownerRendererWebContentsId: 10,
        cachedVisible: false,
        dialogId: 'dialog-1',
      },
    ],
    native: [
      {
        windowId: 12,
        webContentsId: 11,
        ownerRendererWebContentsId: 10,
        destroyed: false,
        windowDestroyed: false,
        matchesBrowser: true,
        matchesUrl: false,
        visible: false,
        bounds: { x: 20, y: 180, width: 640, height: 400 },
      },
    ],
  });
  let tick = 0;
  // VM evaluation proves the helper has no imported closure dependencies.
  const realm = vm.createContext({ process, Buffer, console });
  const install = vm.runInContext(
    `(${installPresentationObserver.toString()})`,
    realm,
  );
  const observer = install(
    { ipcMain, app: { getPath: () => target.userDataDir } },
    target,
    {
      diagnosticGetter: diagnostic,
      clock: () => ++tick,
      ...overrides,
    },
  );
  const invoke = (
    request,
    channel = 'visible',
    event = { sender: { id: 10 } },
    receiver = ipcMain,
  ) => bindings.get(`browser:set-${channel}`).call(receiver, event, request);
  return {
    observer,
    invoke,
    target,
    bindings,
    ipcMain,
    delegate,
    diagnostic,
    install,
    realm,
  };
}

function presentationDeferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('presentation all-writer observer admits stale and missing generations without touching foreign requests or accessors', async () => {
  const calls = [];
  const fixture = await presentationObserverFixture(function (event, request) {
    calls.push({ receiver: this, event, request });
    return request;
  });
  const { observer, invoke, target } = fixture;
  let accessorReads = 0;
  const receiver = {},
    event = { sender: { id: 99 } };
  const requests = [
    {
      browserId: target.browserId,
      expectedRuntimeGeneration: 1,
      visible: false,
    },
    { browserId: target.browserId, visible: true },
    {
      browserId: target.browserId,
      expectedRuntimeGeneration: 2,
      get visible() {
        accessorReads++;
        throw new Error('private accessor');
      },
    },
    { browserId: 'foreign-browser', visible: false },
  ];
  try {
    for (const request of requests)
      assert.equal(invoke(request, 'visible', event, receiver), request);
    const report = observer.finalize();
    assert.equal(
      report.calls.length,
      3,
      'all target-browser generations must be observable',
    );
    assert.deepEqual(
      Array.from(report.calls, (call) => call.generationStatus),
      ['mismatch', 'missing', 'match'],
    );
    assert.equal(report.calls[2].visible, 'invalid');
    assert.equal(report.calls[0].senderId, 99);
    assert.equal(report.calls[0].ownerSender, false);
    assert.equal(accessorReads, 0);
    assert.equal(calls.length, 4);
    for (let i = 0; i < calls.length; i++) {
      assert.equal(calls[i].request, requests[i]);
      assert.equal(calls[i].event, event);
      assert.equal(calls[i].receiver, receiver);
    }
  } finally {
    observer.detach();
  }
});

test('presentation all-writer observer correlates independent async contexts, exact A/B and C with one terminal/cohort checkpoint', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const tagged = new AsyncLocalStorage();
  const pending = [
    presentationDeferred(),
    presentationDeferred(),
    presentationDeferred(),
  ];
  const entered = [],
    readContexts = [];
  let fixture;
  const delegate = function (event, request) {
    const index = entered.length;
    entered.push({ receiver: this, event, request });
    return tagged.run(
      index < 2 ? ['earlier', 'newer'][index] : undefined,
      async () => {
        fixture.observer.noteOwnerRead('index');
        await Promise.resolve();
        readContexts.push(tagged.getStore());
        fixture.observer.noteOwnerRead('owner');
        try {
          return await pending[index].promise;
        } catch (error) {
          if (index === 1) fixture.observer.noteTerminal('rejected', error);
          throw error;
        }
      },
    );
  };
  fixture = await presentationObserverFixture(delegate);
  const { observer, invoke, target } = fixture;
  try {
    const common = {
      browserId: target.browserId,
      expectedRuntimeGeneration: 2,
    };
    const a = invoke(
      {
        ...common,
        e2ePresentationInjectionId: 'injection-1',
        visible: true,
        bounds: target.bounds,
      },
      'bounds',
    );
    const b = invoke({
      ...common,
      e2ePresentationInjectionId: 'injection-1',
      visible: false,
    });
    const c = invoke({ ...common, visible: false });
    await Promise.resolve();
    const failure = Object.assign(
      new Error('A newer presentation request replaced this command.'),
      { code: 'operation_conflict' },
    );
    pending[1].reject(failure);
    await assert.rejects(b, (error) => error === failure);
    let report = observer.report();
    assert.deepEqual(
      Array.from(report.calls, (row) => row.class),
      ['A', 'B', 'untagged'],
    );
    assert.deepEqual(readContexts, ['earlier', 'newer', undefined]);
    assert.deepEqual(
      Array.from(report.calls, (row) => [row.reads.index, row.reads.owner]),
      [
        [1, 1],
        [1, 1],
        [1, 1],
      ],
    );
    assert.equal(report.snapshots.length, 1);
    assert.equal(report.snapshots[0].phase, 'B-rejection-observed');
    assert.equal(report.snapshots[0].state.session.dialogMatchesInitial, true);
    assert.equal(report.snapshots[0].state.native.visible, false);
    assert.equal(report.calls[1].error.supersession, true);
    pending[0].resolve('a');
    await a;
    assert.equal(observer.report().snapshots.length, 1);
    pending[2].resolve('c');
    await c;
    report = observer.report();
    assert.equal(
      report.snapshots.filter((row) => row.phase === 'cohort-settled').length,
      1,
    );
    assert.equal(report.snapshots.at(-1).completeAdmissionCoverage, true);
    assert.equal(entered.length, 3);
  } finally {
    observer.finalize();
  }
});

test('presentation all-writer observer preserves promise/value/throw/rejection identity despite diagnostic failure', async () => {
  const failure = Object.assign(new Error('private error'), {
    code: 'unknown-private-code',
  });
  const pending = presentationDeferred();
  const values = [{ value: true }, pending.promise, failure];
  const fixture = await presentationObserverFixture(
    () => {
      const result = values.shift();
      if (result === failure) throw failure;
      return result;
    },
    {
      diagnosticGetter: () => {
        throw new Error('secret getter failure');
      },
      clock: () => {
        throw new Error('clock failure');
      },
    },
  );
  const request = {
    browserId: 'browser-1',
    expectedRuntimeGeneration: 2,
    visible: false,
  };
  try {
    const value = values[0];
    assert.equal(fixture.invoke(request), value);
    assert.equal(fixture.invoke(request), pending.promise);
    assert.throws(
      () => fixture.invoke(request),
      (error) => error === failure,
    );
    pending.reject(failure);
    await assert.rejects(pending.promise, (error) => error === failure);
    fixture.observer.noteTerminal('rejected', failure);
    const report = fixture.observer.finalize();
    assert.deepEqual(
      Array.from(report.calls, (row) => row.state),
      ['fulfilled', 'rejected', 'threw'],
    );
    assert.equal(report.snapshots[0].state.status, 'unavailable');
    assert(report.diagnosticFailures > 0);
    assert(!JSON.stringify(report).includes('private'));
    assert(!JSON.stringify(report).includes('secret'));
  } finally {
    fixture.observer.detach();
  }
});

test('presentation all-writer observer records a finite cohort without waiting for later or final unresolved calls', async () => {
  const pending = [presentationDeferred(), presentationDeferred()];
  let index = 0;
  const fixture = await presentationObserverFixture(
    () => pending[index++].promise,
  );
  const { observer, invoke } = fixture;
  const request = {
    browserId: 'browser-1',
    expectedRuntimeGeneration: 2,
    visible: false,
  };
  const b = invoke({ ...request, e2ePresentationInjectionId: 'injection-1' });
  pending[0].resolve('b');
  await b;
  const c = invoke(request);
  observer.detach();
  const report = observer.finalize();
  assert.equal(report.calls[1].postCutoff, true);
  assert.equal(report.calls[1].state, 'pending-at-finalization');
  assert.equal(report.observationGap, true);
  assert.equal(report.incomplete, true);
  const frozen = JSON.stringify(report);
  pending[1].resolve('late');
  await c;
  assert.equal(JSON.stringify(observer.report()), frozen);
  assert.equal(observer.contextId(), undefined);
});

test('presentation all-writer observer bounds saturated records and preserves reserved checkpoints without private fields', async () => {
  const fixture = await presentationObserverFixture(() => undefined);
  const { observer, invoke, target, diagnostic } = fixture;
  // The seam is injected, bounded and filtered synchronously; no IPC or activation.
  const raw = diagnostic();
  raw.sessions.push({
    browserId: 'SIBLING-PRIVATE',
    profileId: 'SIBLING-PROFILE',
    dialogId: 'SIBLING-DIALOG',
  });
  raw.native.push({
    matchesBrowser: false,
    webContentsId: 999,
    url: 'https://secret.invalid',
  });
  raw.sessions[0].message = 'SECRET-DIALOG-TEXT';
  raw.sessions[0].url = 'https://secret.invalid';
  // A second fixture tests exact filtering with a malicious seam result.
  const filtering = await presentationObserverFixture(() => undefined, {
    diagnosticGetter: () => raw,
  });
  try {
    for (let i = 0; i < 400; i++) {
      invoke({
        browserId: target.browserId,
        expectedRuntimeGeneration: 2,
        visible: false,
        e2ePresentationInjectionId: '\u0800'.repeat(20000),
        bounds: { x: Infinity },
      });
      observer.noteGate('gate-enter');
    }
    observer.noteTerminal('rejected', {
      code: 'operation_conflict',
      message: 'secret',
    });
    observer.noteGate('gate-release-requested');
    const report = observer.finalize();
    assert.equal(report.incomplete, true);
    assert(report.calls.length <= 64);
    assert(report.events.length <= 256);
    assert(report.snapshots.length <= 4);
    assert(
      report.snapshots.some((row) => row.phase === 'B-rejection-observed'),
    );
    assert(report.truncationReason);
    assert(Buffer.byteLength(JSON.stringify(report)) <= 96 * 1024);
    assert(
      report.events.every(
        (row) => Buffer.byteLength(JSON.stringify(row)) <= 2048,
      ),
    );
    assert(
      report.snapshots.every(
        (row) => Buffer.byteLength(JSON.stringify(row)) <= 8192,
      ),
    );
    filtering.observer.noteTerminal('rejected', {});
    const filtered = JSON.stringify(filtering.observer.finalize());
    for (const privateText of ['SIBLING', 'SECRET', 'https://', 'secret'])
      assert(!filtered.includes(privateText));
  } finally {
    observer.finalize();
    filtering.observer.finalize();
  }
});

test('presentation all-writer observer restores only owned bindings independently and is inert after finalization', async () => {
  const fixture = await presentationObserverFixture(() => undefined);
  const replacement = () => 'replacement';
  fixture.bindings.set('browser:set-visible', replacement);
  const result = fixture.observer.detach();
  assert.equal(fixture.bindings.get('browser:set-visible'), replacement);
  assert.equal(fixture.bindings.get('browser:set-bounds'), fixture.delegate);
  assert.equal(result.restored.visible, false);
  assert.equal(result.restored.bounds, true);
  const report = fixture.observer.finalize();
  assert(report.cleanup.some((row) => row.reason === 'restoration-conflict'));
  const frozen = JSON.stringify(report);
  fixture.observer.noteOwnerRead('owner');
  fixture.observer.noteGate('gate-enter');
  fixture.observer.detach();
  assert.equal(JSON.stringify(fixture.observer.report()), frozen);
});

test('presentation all-writer observer rolls back partial installation and validates duplicate/root identity before mutation', async () => {
  const f = await presentationObserverFixture(() => 'delegate');
  const electron = {
    ipcMain: f.ipcMain,
    app: { getPath: () => f.target.userDataDir },
  };
  const before = Array.from(f.bindings);
  assert.throws(() => f.install(electron, f.target), /already installed/);
  assert.deepEqual(Array.from(f.bindings), before);
  f.observer.finalize();
  assert.equal(f.realm.__PROFILE_PRESENTATION_ALL_WRITERS__, undefined);
  assert.throws(
    () => f.install(electron, { ...f.target, userDataDir: '/foreign' }),
    /identity mismatch/,
  );
  assert.throws(
    () => f.install(electron, { ...f.target, browserId: 'private/url' }),
    /synthetic identities/,
  );
  const originalHandle = f.ipcMain.handle;
  let failed = false;
  f.ipcMain.handle = function (channel, handler) {
    if (channel === 'browser:set-visible' && !failed) {
      failed = true;
      throw new Error('installation failure');
    }
    return originalHandle.call(this, channel, handler);
  };
  assert.throws(() => f.install(electron, f.target), /installation failure/);
  assert.equal(f.bindings.get('browser:set-bounds'), f.delegate);
  assert.equal(
    f.bindings.get('browser:set-visible'),
    f.delegate,
    'observer must restore its removed slot after partial install failure',
  );
  assert.equal(f.realm.__PROFILE_PRESENTATION_ALL_WRITERS__, undefined);
});

test('presentation all-writer observer marks later pending writers at cohort settlement and retains final unresolved identities', async () => {
  const pending = [
    presentationDeferred(),
    presentationDeferred(),
    presentationDeferred(),
  ];
  let i = 0;
  const f = await presentationObserverFixture(() => pending[i++].promise);
  const request = {
    browserId: 'browser-1',
    expectedRuntimeGeneration: 2,
    visible: false,
  };
  const a = f.invoke(request);
  const b = f.invoke({ ...request, e2ePresentationInjectionId: 'injection-1' });
  pending[1].resolve('b');
  await b;
  const c = f.invoke(request);
  pending[0].resolve('a');
  await a;
  const checkpoint = f.observer
    .report()
    .snapshots.find((row) => row.phase === 'cohort-settled');
  assert.deepEqual(Array.from(checkpoint.postCutoffPendingIds), [3]);
  assert.equal(
    checkpoint.completeAdmissionCoverage,
    true,
    'all admissions remain observed; pending intent must be qualified by the ordering verifier',
  );
  const report = f.observer.finalize();
  assert.deepEqual(
    Array.from(report.pendingIds),
    [3],
    'final evidence must retain unresolved identities',
  );
  pending[2].resolve('c');
  await c;
});

test('presentation all-writer observer rejects ambiguous, mismatched and accessor-bearing native evidence without activation', async () => {
  const f = await presentationObserverFixture();
  const raw = f.diagnostic();
  f.observer.finalize();
  let getters = 0;
  const bad = [
    { ...raw, sessions: [raw.sessions[0], raw.sessions[0]] },
    { ...raw, native: [{ ...raw.native[0], webContentsId: 88 }] },
    {
      get sessions() {
        getters++;
        throw new Error('private');
      },
      native: [],
    },
  ];
  for (const value of bad) {
    let requests = 0;
    const fixture = await presentationObserverFixture(
      () => {
        throw new Error('activation is forbidden');
      },
      {
        diagnosticGetter: (input) => {
          requests++;
          assert.deepEqual(JSON.parse(JSON.stringify(input.scope)), {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId: 'browser-1',
          });
          assert.equal(input.kind, 'browser-snapshot');
          assert(input.deadline >= Date.now());
          return value;
        },
      },
    );
    fixture.observer.noteTerminal('rejected', {});
    const report = fixture.observer.finalize();
    assert.equal(report.snapshots[0].state.status, 'unavailable');
    assert.equal(report.incomplete, true);
    assert(requests <= 4);
  }
  assert.equal(getters, 0);
});

async function realTaggedPresentationFixture({
  newerError,
  result = 'unchanged-result',
  controlledLaterHide = false,
  diagnosticGetter,
  nativeVisible = false,
  presentationRevision = false,
  arbitraryBError = false,
  afterAuthority,
} = {}) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const caseStart = source.indexOf(
    'async function runPendingSourceDialogCase(',
  );
  const start = source.indexOf('({ app, ipcMain }, target) => {', caseStart);
  const end = source.indexOf(
    '\n      },\n      {\n        injectionId:',
    start,
  );
  assert(start > caseStart && end > start);
  const f = await presentationObserverFixture();
  f.observer.finalize();
  const fakeFs = { readFile: async () => '{}' };
  const originalRead = fakeFs.readFile;
  const nodeProcess = process;
  f.realm.process = {
    getBuiltinModule(name) {
      if (name === 'node:fs/promises') return fakeFs;
      if (name === 'node:module') return { syncBuiltinESMExports() {} };
      return nodeProcess.getBuiltinModule(name);
    },
    hrtime: process.hrtime,
  };
  const installFixture = vm.runInContext(
    `(${source.slice(start, end)}\n})`,
    f.realm,
  );
  let revision = 0;
  const handler = async (_event, request) => {
    const enteredRevision = ++revision;
    await fakeFs.readFile('/synthetic-user-data/workspaces/index.json');
    await fakeFs.readFile(
      '/synthetic-user-data/workspaces/project-1/worktrees.json',
    );
    await afterAuthority?.(request);
    if (presentationRevision && enteredRevision !== revision)
      throw Object.assign(
        new Error('A newer presentation request replaced this command.'),
        { code: 'operation_conflict' },
      );
    if (request.visible === false && newerError) throw newerError;
    return result;
  };
  for (const channel of ['browser:set-bounds', 'browser:set-visible'])
    f.bindings.set(channel, handler);
  const electron = {
    ipcMain: f.ipcMain,
    app: { getPath: () => f.target.userDataDir },
  };
  f.target.controlledLaterHide = controlledLaterHide;
  f.target.arbitraryBError = arbitraryBError;
  installFixture(electron, f.target);
  const taggedFixture = f.realm.__PROFILE_PRESENTATION_ORDERING_FIXTURE__;
  const observer = f.install(electron, f.target, {
    diagnosticGetter:
      diagnosticGetter ??
      (() => {
        const state = f.diagnostic();
        state.native[0].visible = nativeVisible;
        return state;
      }),
  });
  return { ...f, fakeFs, originalRead, handler, taggedFixture, observer };
}

async function presentationControlledSetupSourceFixture({
  resumeAt = 110,
  controlOverrides = {},
  controlledLaterHide = true,
  initialVisible = true,
  diagnosticOverride,
  retainRejection = false,
} = {}) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const caseStart = source.indexOf(
    'async function runPendingSourceDialogCase(',
  );
  const start = source.indexOf(
    '    const initialNative = await electronApp.evaluate(',
    caseStart,
  );
  const end = source.indexOf('\n\n    // Delay the older presentation', start);
  assert(start > caseStart && end > start);

  const readinessModule =
    await import('../electron/browser-profile-presentation-observer.mjs');
  const readinessHelper =
    readinessModule.waitForInitialNativeReadiness ?? (() => undefined);
  const waitEntered = presentationDeferred();
  const releaseWait = presentationDeferred();
  let now = 10;
  let visible = initialVisible;
  let installationStarted = false;
  const activation = { presentationCalls: 0 };
  const nativeView = {
    webContents: {
      id: 11,
      getURL: () => 'http://fixture/one',
      isDestroyed: () => false,
    },
    getVisible: () => visible,
    getBounds: () => ({ x: 20, y: 180, width: 640, height: 400 }),
  };
  const hostWindow = {
    id: 12,
    isDestroyed: () => false,
    contentView: { children: [nativeView] },
  };
  const electron = {
    BrowserWindow: { getAllWindows: () => [hostWindow] },
  };
  const target = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    browserId: 'browser-1',
    profileId: 'profile-1',
    runtimeGeneration: 2,
    storageGeneration: 3,
    dialogId: 'dialog-1',
    url: 'http://fixture/one',
  };
  const diagnosticSnapshot = () => ({
    sessionsStatus: 'available',
    truncated: false,
    errors: [],
    sessions: [
      {
        browserId: target.browserId,
        profileId: target.profileId,
        runtimeGeneration: target.runtimeGeneration,
        storageGeneration: target.storageGeneration,
        webContentsId: 11,
        hostWindowId: 12,
        ownerRendererWebContentsId: 10,
        cachedVisible: visible,
        dialogId: target.dialogId,
      },
    ],
    native: [
      {
        windowId: 12,
        webContentsId: 11,
        ownerRendererWebContentsId: 10,
        destroyed: false,
        windowDestroyed: false,
        matchesBrowser: true,
        visible,
        bounds: nativeView.getBounds(),
      },
    ],
  });
  const diagnosticGetter = () => {
    const snapshot = diagnosticSnapshot();
    return diagnosticOverride ? diagnosticOverride(snapshot) : snapshot;
  };
  const partial = (actual, expected, path = 'value') => {
    if (
      expected === null ||
      typeof expected !== 'object' ||
      Array.isArray(expected)
    ) {
      assert.deepEqual(actual, expected, path);
      return;
    }
    for (const [key, value] of Object.entries(expected))
      partial(actual?.[key], value, `${path}.${key}`);
  };
  const expectValue = (actual) => ({
    toHaveLength: (length) => assert.equal(actual.length, length),
    toMatchObject: (expected) => partial(actual, expected),
    toBeVisible: async () => assert.equal(actual.visible, true),
    toBeEnabled: async () => assert.equal(actual.enabled, true),
    toBeGreaterThan: (expected) => assert(actual > expected),
    toBe: (expected) => assert.equal(actual, expected),
  });
  const control = (name) => {
    const state = {
      visible: true,
      enabled: true,
      bounds: { x: 30, y: 40, width: 80, height: 28 },
      pointerTarget: true,
      ...controlOverrides[name],
    };
    const element = {
      getBoundingClientRect: () => state.bounds,
      ownerDocument: {
        elementFromPoint: () => (state.pointerTarget ? element : {}),
      },
      contains: (candidate) => candidate === element,
    };
    return {
      get visible() {
        return state.visible;
      },
      get enabled() {
        return state.enabled;
      },
      boundingBox: async () => state.bounds,
      evaluate: async (callback) => callback(element),
    };
  };
  const controls = { Stay: control('Stay'), Leave: control('Leave') };
  const modal = {
    visible: true,
    getByRole: (_role, options) => controls[options.name],
  };
  const window = {
    evaluate: async (callback, input) => callback(input),
    api: {
      browser: {
        setBounds: async () => activation.presentationCalls++,
        setVisible: async () => activation.presentationCalls++,
      },
    },
    getByTestId: () => ({
      boundingBox: async () => ({ x: 20, y: 180, width: 640, height: 400 }),
    }),
  };
  const ownerWindow = {
    evaluate: async () => 10,
    dispose: async () => {},
  };
  const electronApp = {
    browserWindow: async () => ownerWindow,
    evaluate: async (callback, input) => {
      if (callback === readinessHelper)
        return callback(electron, input, {
          clock: () => now,
          wait: async () => {
            waitEntered.resolve();
            await releaseWait.promise;
            now = resumeAt;
          },
          diagnosticGetter,
        });
      return callback(electron, input);
    },
  };
  const context = vm.createContext({
    assert,
    controlledLaterHide,
    controlledEvidence: controlledLaterHide
      ? { stage: 'conditional-presentation-ordering', rendererCheckpoints: [] }
      : undefined,
    electronApp,
    expect: expectValue,
    modal,
    window,
    original: {
      id: target.browserId,
      profile: {
        resolvedProfileId: target.profileId,
        runtimeGeneration: target.runtimeGeneration,
        storageGeneration: target.storageGeneration,
      },
    },
    boundaryIdentity: target,
    first: { result: { dialog: { id: target.dialogId } } },
    url: target.url,
    ownerRendererWebContentsId: undefined,
    waitForInitialNativeReadiness: readinessHelper,
    installationStarted,
    performance: { now: () => now },
    process,
  });
  const boundary = vm.runInContext(
    `(async () => {${source.slice(start, end)}\ninstallationStarted = true;\n})()`,
    context,
  );
  const firstOutcome = await Promise.race([
    waitEntered.promise.then(() => ({ kind: 'waiting' })),
    boundary.then(
      () => ({ kind: 'completed' }),
      (error) => ({ kind: 'rejected', error }),
    ),
  ]);
  if (firstOutcome.kind === 'rejected' && !retainRejection)
    throw firstOutcome.error;
  return {
    activation,
    boundary,
    context,
    firstOutcome,
    completeHidden: async () => {
      visible = false;
      releaseWait.resolve();
      return boundary;
    },
  };
}

test('presentation controlled current setup awaits same-native readiness before fixture installation', async () => {
  const fixture = await presentationControlledSetupSourceFixture();
  assert.equal(fixture.firstOutcome.kind, 'waiting');
  assert.equal(fixture.context.installationStarted, false);
  assert.equal(fixture.activation.presentationCalls, 0);
  try {
    assert.equal(
      fixture.context.controlledEvidence.initialNative?.[0]?.visible,
      true,
      'retain the initial native sample before readiness can settle or reject',
    );
  } finally {
    await fixture.completeHidden();
  }
  assert.equal(fixture.context.installationStarted, true);
  assert.equal(
    fixture.context.controlledEvidence.initialNative[0].visible,
    true,
  );
  assert.equal(
    fixture.context.controlledEvidence.initialNativeReadiness.status,
    'ready',
  );
  assert.equal(
    fixture.context.controlledEvidence.readyNative.native.visible,
    false,
  );
});

test('presentation ordinary setup waits for same-native readiness before fixture installation', async () => {
  const fixture = await presentationControlledSetupSourceFixture({
    controlledLaterHide: false,
  });
  assert.equal(
    fixture.firstOutcome.kind,
    'waiting',
    'ordinary setup must not install the ordering fixture while native readiness is pending',
  );
  assert.equal(fixture.context.installationStarted, false);
  assert.equal(fixture.activation.presentationCalls, 0);
  await fixture.completeHidden();
  assert.equal(fixture.context.installationStarted, true);
});

test('presentation ordinary setup retains an already-hidden initial native state', async () => {
  const fixture = await presentationControlledSetupSourceFixture({
    controlledLaterHide: false,
    initialVisible: false,
  });
  assert.equal(fixture.firstOutcome.kind, 'completed');
  assert.equal(fixture.context.installationStarted, true);
  assert.equal(fixture.activation.presentationCalls, 0);
});

test('presentation controlled current setup rejects overdue hidden readiness before fixture installation', async () => {
  const fixture = await presentationControlledSetupSourceFixture({
    resumeAt: 5011,
  });
  await fixture.completeHidden().catch(() => {});
  assert.equal(
    fixture.context.installationStarted,
    false,
    'an overdue hidden sample must not reach the installer boundary',
  );
  assert.equal(fixture.activation.presentationCalls, 0);
  assert.equal(
    fixture.context.controlledEvidence.initialNativeReadiness.status,
    'not-ready',
  );
  assert.equal(
    fixture.context.controlledEvidence.initialNativeReadiness.reason,
    'readiness-deadline',
  );
});

test('presentation ordinary setup rejects overdue hidden readiness before fixture installation', async () => {
  const fixture = await presentationControlledSetupSourceFixture({
    controlledLaterHide: false,
    resumeAt: 5011,
  });
  await fixture.completeHidden().catch(() => {});
  assert.equal(
    fixture.context.installationStarted,
    false,
    'an overdue ordinary hidden sample must not reach the installer boundary',
  );
  assert.equal(fixture.activation.presentationCalls, 0);
});

for (const [name, controlOverrides] of [
  ['hidden Stay', { Stay: { visible: false } }],
  ['hidden Leave', { Leave: { visible: false } }],
  [
    'zero-geometry Stay',
    { Stay: { bounds: { x: 30, y: 40, width: 0, height: 28 } } },
  ],
  ['covered Leave', { Leave: { pointerTarget: false } }],
])
  test(`presentation controlled current setup rejects ${name} before fixture installation`, async () => {
    const fixture = await presentationControlledSetupSourceFixture({
      controlOverrides,
    });
    await fixture.completeHidden().catch(() => {});
    assert.equal(
      fixture.context.installationStarted,
      false,
      `${name} must not reach the installer boundary`,
    );
    assert.equal(fixture.activation.presentationCalls, 0);
  });

for (const [name, controlOverrides] of [
  ['hidden Stay', { Stay: { visible: false } }],
  [
    'zero-geometry Leave',
    { Leave: { bounds: { x: 30, y: 40, width: 0, height: 28 } } },
  ],
  ['covered Leave', { Leave: { pointerTarget: false } }],
])
  test(`presentation ordinary setup rejects ${name} before fixture installation`, async () => {
    const fixture = await presentationControlledSetupSourceFixture({
      controlledLaterHide: false,
      controlOverrides,
    });
    await fixture.completeHidden().catch(() => {});
    assert.equal(
      fixture.context.installationStarted,
      false,
      `${name} must not reach the ordinary installer boundary`,
    );
    assert.equal(fixture.activation.presentationCalls, 0);
  });

for (const [name, diagnosticOverride] of [
  [
    'unavailable diagnostics',
    (snapshot) => ({ ...snapshot, sessionsStatus: 'unavailable' }),
  ],
  [
    'changed native identity',
    (snapshot) => ({
      ...snapshot,
      native: [{ ...snapshot.native[0], webContentsId: 99 }],
    }),
  ],
  [
    'changed dialog identity',
    (snapshot) => ({
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0], dialogId: 'another-dialog' }],
    }),
  ],
])
  test(`presentation ordinary setup rejects ${name} before fixture installation`, async () => {
    const fixture = await presentationControlledSetupSourceFixture({
      controlledLaterHide: false,
      initialVisible: false,
      resumeAt: 5011,
      diagnosticOverride,
      retainRejection: true,
    });
    await assert.rejects(fixture.completeHidden());
    assert.equal(fixture.context.installationStarted, false);
    assert.equal(fixture.activation.presentationCalls, 0);
  });

async function presentationInitialReadinessFixture({
  samples,
  diagnostic = {},
  observationAdvanceMs = 0,
  waitAdvanceMs,
} = {}) {
  const { waitForInitialNativeReadiness: declaration } =
    await import('../electron/browser-profile-presentation-observer.mjs');
  assert.equal(typeof declaration, 'function');
  const waitForInitialNativeReadiness = vm.runInNewContext(
    `(${declaration.toString()})`,
    { process, setTimeout, clearTimeout, Promise },
  );
  const target = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    browserId: 'browser-1',
    profileId: 'profile-1',
    runtimeGeneration: 2,
    storageGeneration: 3,
    dialogId: 'dialog-1',
    ownerRendererWebContentsId: 10,
    url: 'http://fixture/one',
    initialNative: {
      observedAtMs: 10,
      webContentsId: 11,
      hostWindowId: 12,
      destroyed: false,
      windowDestroyed: false,
      visible: true,
      bounds: { x: 20, y: 180, width: 640, height: 400 },
    },
  };
  let index = 0;
  let now = 10;
  const current = () => samples[Math.min(index, samples.length - 1)];
  const view = {
    webContents: {
      get id() {
        return current().webContentsId ?? 11;
      },
      getURL: () => target.url,
      isDestroyed: () => current().destroyed ?? false,
    },
    getVisible: () => current().visible,
    getBounds: () =>
      current().bounds ?? { x: 20, y: 180, width: 640, height: 400 },
  };
  const hostWindow = {
    get id() {
      return current().hostWindowId ?? 12;
    },
    isDestroyed: () => current().windowDestroyed ?? false,
    contentView: { children: [view] },
  };
  const diagnosticGetter = () => {
    const sample = current();
    if (sample.unavailable) return {};
    const result = {
      sessionsStatus: 'available',
      truncated: false,
      errors: [],
      sessions: [
        {
          browserId: sample.browserId ?? target.browserId,
          profileId: sample.profileId ?? target.profileId,
          runtimeGeneration:
            sample.runtimeGeneration ?? target.runtimeGeneration,
          storageGeneration:
            sample.storageGeneration ?? target.storageGeneration,
          webContentsId: sample.webContentsId ?? 11,
          hostWindowId: sample.hostWindowId ?? 12,
          ownerRendererWebContentsId:
            sample.ownerRendererWebContentsId ??
            target.ownerRendererWebContentsId,
          cachedVisible: sample.cachedVisible ?? sample.visible,
          dialogId: sample.dialogId ?? target.dialogId,
        },
      ],
      native: [
        {
          windowId: sample.hostWindowId ?? 12,
          webContentsId: sample.webContentsId ?? 11,
          ownerRendererWebContentsId:
            sample.ownerRendererWebContentsId ??
            target.ownerRendererWebContentsId,
          destroyed: sample.destroyed ?? false,
          windowDestroyed: sample.windowDestroyed ?? false,
          matchesBrowser: true,
          visible: sample.diagnosticVisible ?? sample.visible,
          bounds: sample.bounds ?? { x: 20, y: 180, width: 640, height: 400 },
        },
      ],
      ...diagnostic,
    };
    now += observationAdvanceMs;
    return result;
  };
  const result = await waitForInitialNativeReadiness(
    { BrowserWindow: { getAllWindows: () => [hostWindow] } },
    target,
    {
      clock: () => now,
      wait: async (delay) => {
        now += waitAdvanceMs ?? delay;
        if (index < samples.length - 1) index++;
      },
      diagnosticGetter,
    },
  );
  return { result, target };
}

test('presentation initial readiness retains visible initial and exact hidden ready observations', async () => {
  const { result } = await presentationInitialReadinessFixture({
    samples: [{ visible: true }, { visible: false }],
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.reason, null);
  assert.equal(result.initial.native.visible, true);
  assert.equal(result.ready.native.visible, false);
  assert.equal(result.final.native.visible, false);
  assert.equal(result.observations[0].phase, 'initial');
  assert.equal(result.observations.at(-1).phase, 'ready');
  assert.deepEqual(
    Array.from(result.observations, (row) => row.native.visible),
    [true, true, false],
  );
});

test('presentation initial readiness never treats a visible native view as timing success', async () => {
  const { result } = await presentationInitialReadinessFixture({
    samples: [{ visible: true }],
  });
  assert.equal(result.status, 'not-ready');
  assert.equal(result.reason, 'readiness-deadline');
  assert.equal(result.ready, null);
  assert.equal(result.final.classification, 'readiness-deadline');
  assert.equal(result.final.observedClassification, 'native-visible');
  assert(result.observations.length <= 64);
});

test('presentation initial readiness rejects a delayed timer resumption with hidden state', async () => {
  const { result } = await presentationInitialReadinessFixture({
    samples: [{ visible: true }, { visible: false }],
    waitAdvanceMs: 5001,
  });
  assert.equal(result.status, 'not-ready');
  assert.equal(result.reason, 'readiness-deadline');
  assert.equal(result.ready, null);
  assert.equal(result.final.native.visible, false);
  assert.equal(result.final.classification, 'readiness-deadline');
  assert.equal(result.endedAt, 5011);
});

for (const [name, observationAdvanceMs, status] of [
  ['before cutoff', 4999, 'ready'],
  ['at exact cutoff', 5000, 'not-ready'],
  ['after cutoff', 5001, 'not-ready'],
])
  test(`presentation initial readiness completes ${name} with strict deadline admission`, async () => {
    const { result } = await presentationInitialReadinessFixture({
      samples: [{ visible: false }],
      observationAdvanceMs,
    });
    assert.equal(result.status, status);
    assert.equal(result.endedAt, 10 + observationAdvanceMs);
    if (status === 'ready') {
      assert.equal(result.reason, null);
      assert.equal(result.ready.native.visible, false);
    } else {
      assert.equal(result.reason, 'readiness-deadline');
      assert.equal(result.ready, null);
      assert.equal(result.final.native.visible, false);
      assert.equal(result.final.classification, 'readiness-deadline');
    }
  });

for (const [name, sample, reason] of [
  [
    'unavailable evidence',
    { visible: false, unavailable: true },
    'readiness-deadline',
  ],
  [
    'changed native identity',
    { visible: false, webContentsId: 99 },
    'native-identity-changed',
  ],
  [
    'wrong pending dialog',
    { visible: false, dialogId: 'dialog-2' },
    'dialog-identity-changed',
  ],
])
  test(`presentation initial readiness rejects ${name} before activation`, async () => {
    const { result } = await presentationInitialReadinessFixture({
      samples: [sample],
    });
    assert.equal(result.status, 'not-ready');
    assert.equal(result.reason, reason);
    assert.equal(result.ready, null);
    assert.equal(result.final.ready, false);
  });

test('presentation all-writer observer integrates the real tagged fixture gate and restores without clobbering a later handler', async () => {
  const f = await realTaggedPresentationFixture();
  const { fakeFs, originalRead, handler, taggedFixture, observer } = f;
  try {
    const request = {
      browserId: 'browser-1',
      expectedRuntimeGeneration: 2,
      e2ePresentationInjectionId: 'injection-1',
    };
    const a = f.invoke(
      { ...request, bounds: f.target.bounds, visible: true },
      'bounds',
    );
    await taggedFixture.waitForGate();
    const b = f.invoke({ ...request, visible: false });
    assert.equal(await b, 'unchanged-result');
    const before = observer.report();
    assert.deepEqual(
      Array.from(before.calls, (row) => [
        row.class,
        row.reads.index,
        row.reads.owner,
      ]),
      [
        ['A', 1, 1],
        ['B', 1, 1],
      ],
    );
    assert.equal(before.snapshots[0].phase, 'B-fulfillment-observed');
    const replacement = () => 'foreign replacement';
    f.bindings.set('browser:set-visible', replacement);
    const restored = taggedFixture.restore();
    assert.equal(f.bindings.get('browser:set-visible'), replacement);
    assert.equal(f.bindings.get('browser:set-bounds'), handler);
    assert.equal(fakeFs.readFile, originalRead);
    assert(
      restored.errors.some((row) => row.phase === 'restore-visible-handler'),
    );
    assert.equal(await a, 'unchanged-result');
    const report = observer.finalize();
    assert.equal(report.calls[0].state, 'fulfilled');
    assert(
      report.events.some(
        (row) => row.phase === 'gate-enter' && row.callId === 1,
      ),
    );
    assert(report.events.some((row) => row.phase === 'gate-release-requested'));
    assert.equal(f.realm.__PROFILE_PRESENTATION_ALL_WRITERS__, undefined);
  } finally {
    taggedFixture.release();
    observer.finalize();
  }
});

test('presentation all-writer observer keeps replacement globals and restores the other channel when removal throws', async () => {
  const f = await presentationObserverFixture();
  const replacement = { unrelated: true };
  f.realm.__PROFILE_PRESENTATION_ALL_WRITERS__ = replacement;
  const remove = f.ipcMain.removeHandler;
  f.ipcMain.removeHandler = (channel) => {
    if (channel === 'browser:set-bounds') throw new Error('remove failed');
    return remove(channel);
  };
  const restored = f.observer.detach();
  assert.equal(restored.restored.bounds, false);
  assert.equal(restored.restored.visible, true);
  assert.equal(f.bindings.get('browser:set-visible'), f.delegate);
  const report = f.observer.finalize();
  assert.equal(f.realm.__PROFILE_PRESENTATION_ALL_WRITERS__, replacement);
  assert(
    report.cleanup.some(
      (row) =>
        row.channel === 'global' && row.reason === 'restoration-conflict',
    ),
  );
  assert(
    report.cleanup.some(
      (row) => row.channel === 'bounds' && row.reason === 'restoration-failed',
    ),
  );
});

test('presentation all-writer observer cannot certify a cohort whose admission overflowed before B', async () => {
  const f = await presentationObserverFixture();
  for (let i = 0; i < 70; i++) f.invoke({ browserId: 'browser-1' });
  f.observer.noteTerminal('rejected', { code: 'operation_conflict' });
  const report = f.observer.finalize();
  assert.equal(report.calls.length, 64);
  assert.equal(report.droppedCalls, 6);
  assert.equal(report.cohortAdmissionComplete, false);
  assert.equal(report.cohortStatus, 'cohort-unavailable-admission-gap');
  assert.equal(report.cohortCaptured, false);
  assert.equal(report.snapshots[0].phase, 'B-rejection-observed');
  assert.equal(report.snapshots[0].completeAdmissionCoverage, false);
});

for (const replacementKind of [
  'missing',
  'malformed',
  'throwing-methods',
  'method-accessors',
  'global-accessor',
])
  for (const outcome of ['fulfilled', 'rejected'])
    test(`presentation all-writer observer real fixture preserves gate and B ${outcome} with ${replacementKind} replacement`, async () => {
      const originalValue = { original: true };
      const originalError = Object.assign(new Error('original rejection'), {
        code: 'operation_conflict',
      });
      const f = await realTaggedPresentationFixture({
        result: originalValue,
        newerError: outcome === 'rejected' ? originalError : undefined,
      });
      const key = '__PROFILE_PRESENTATION_ALL_WRITERS__';
      const mainGlobal = vm.runInContext('globalThis', f.realm);
      let replacementInvocations = 0;
      const forbidden = () => {
        replacementInvocations++;
        throw new Error('replacement notification');
      };
      const replacement = {};
      for (const name of [
        'noteOwnerRead',
        'noteGate',
        'noteTerminal',
        'detach',
        'finalize',
      ]) {
        if (replacementKind === 'throwing-methods')
          replacement[name] = forbidden;
        if (replacementKind === 'method-accessors')
          Object.defineProperty(replacement, name, { get: forbidden });
      }
      const request = {
        browserId: 'browser-1',
        expectedRuntimeGeneration: 2,
        e2ePresentationInjectionId: 'injection-1',
      };
      const a = f
        .invoke(
          { ...request, bounds: f.target.bounds, visible: true },
          'bounds',
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      let released = false;
      try {
        await f.taggedFixture.waitForGate();
        if (replacementKind === 'missing') delete mainGlobal[key];
        else if (replacementKind === 'global-accessor')
          Object.defineProperty(mainGlobal, key, {
            configurable: true,
            get: forbidden,
          });
        else mainGlobal[key] = replacement;
        const b = await f.invoke({ ...request, visible: false }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let releaseError;
        try {
          f.taggedFixture.release();
          released = true;
        } catch (error) {
          releaseError = error;
        }
        assert.equal(
          releaseError,
          undefined,
          'diagnostic replacement must never strand the original release',
        );
        assert.equal(
          outcome === 'fulfilled' ? b.value : b.error,
          outcome === 'fulfilled' ? originalValue : originalError,
          'B must preserve its original exact value/error',
        );
        const restored = f.taggedFixture.restore();
        assert.equal(restored.restored.bounds, true);
        assert.equal(restored.restored.visible, true);
        assert.equal(f.fakeFs.readFile, f.originalRead);
        assert.equal((await a).value, originalValue);
        const report = f.observer.finalize();
        assert(
          report.notificationGaps > 0,
          'missing notifications must be explicit evidence gaps',
        );
        assert.equal(report.incomplete, true);
        assert.equal(
          replacementInvocations,
          0,
          'never invoke replacement functions or accessors',
        );
      } finally {
        // RED can leave only an inert fake promise stranded; never add a test timer
        // or mutate the fixture gate to conceal that failure. GREEN drains A above.
        if (!released) {
          Object.defineProperty(mainGlobal, key, {
            configurable: true,
            writable: true,
            value: f.observer,
          });
          try {
            f.taggedFixture.release();
          } catch {
            // Preserve the assertion that exposed a broken diagnostic release.
          }
        }
        f.observer.finalize();
      }
    });

async function presentationRendererRouteSourceFixture({
  elementHandleFailure = false,
  installFailure = false,
  methodFailure = false,
} = {}) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const caseStart = source.indexOf(
    'async function runPendingSourceDialogCase(',
  );
  const start = source.indexOf('      const composer = window', caseStart);
  const end = source.indexOf(
    '\n      await expect\n        .poll(\n          async () => {',
    start,
  );
  assert(start > caseStart && end > start);

  const order = [];
  let rootHeight = 104;
  const scroller = {
    isConnected: true,
    get clientHeight() {
      return rootHeight - 72;
    },
    get scrollHeight() {
      return rootHeight - 72;
    },
    getBoundingClientRect: () => ({
      x: 10,
      y: 20,
      width: 320,
      height: rootHeight - 72,
    }),
  };
  let textbox;
  const root = {
    isConnected: true,
    getBoundingClientRect: () => ({
      x: 10,
      y: 20,
      width: 320,
      height: rootHeight,
    }),
    getAttribute: (name) =>
      name === 'data-composer-density' ? 'comfortable' : null,
    querySelectorAll: (selector) =>
      selector === '[data-chat-textarea]' ? [textbox] : [],
    contains: (node) => node === scroller,
  };
  textbox = {
    kind: 'actual-textbox',
    isConnected: true,
    parentElement: scroller,
    closest: (selector) =>
      selector === '[data-chat-composer-root]' ? root : null,
    dispose: async () => {},
  };
  const rendererRoute = {
    noteTrigger() {
      order.push('renderer-trigger');
      if (methodFailure) throw new Error('trigger read failed');
      return { phase: 'trigger-boundary' };
    },
    noteAfterFill() {
      order.push('renderer-after-fill');
      if (methodFailure) throw new Error('after-fill read failed');
      return { phase: 'after-fill' };
    },
    report() {
      order.push('renderer-report');
      return {
        status: 'recording',
        incomplete: false,
        records: [{ phase: 'installation' }],
      };
    },
  };
  const rendererRouteHandle = {
    evaluate: async (callback) => callback(rendererRoute),
  };
  const composerRootHandle = {
    evaluate: async (callback) => callback(root),
    dispose: async () => {},
  };
  let height = 20;
  const composer = {
    evaluateHandle: async (callback) => {
      const value = callback(textbox);
      assert.equal(value, root);
      order.push('root-install');
      return composerRootHandle;
    },
    elementHandle: async () => {
      if (elementHandleFailure) throw new Error('element handle failed');
      return textbox;
    },
    boundingBox: async () => ({ x: 1, y: 2, width: 300, height }),
    fill: async (value) => {
      order.push('fill');
      height = 80;
      if (value.split('\n').length >= 6) rootHeight = 216;
      return 'original-fill-result';
    },
  };
  const expectValue = (actual) => ({
    toBeVisible: async () => {},
    toBeEditable: async () => {},
    toBeGreaterThan: (expected) => assert(actual > expected),
    toBe: (expected) => assert.equal(actual, expected),
  });
  expectValue.poll = (callback) => ({
    toBeGreaterThan: async (expected) => assert((await callback()) > expected),
    toBe: async (expected) => assert.equal(await callback(), expected),
  });
  const presentationObserver = {
    noteControlledTrigger() {
      order.push('main-trigger');
      return { phase: 'controlled-composer-trigger-armed' };
    },
  };
  const context = vm.createContext({
    controlledEvidence: { rendererCheckpoints: [] },
    boundedCleanupErrorMessage: (error) => String(error),
    composerRootElement: undefined,
    composer,
    expect: expectValue,
    getComputedStyle: () =>
      height === 20
        ? { overflowY: 'hidden', maxHeight: '32px' }
        : { overflowY: 'auto', maxHeight: '200px' },
    installPresentationRendererRouteRecorder: (element) => {
      assert.equal(element, textbox);
      order.push('renderer-install');
      if (installFailure) throw new Error('installation read failed');
      return rendererRoute;
    },
    modal: {
      getByRole: () => ({}),
    },
    original: { id: 'browser-1' },
    performance: { now: () => 10 },
    presentationObserverHandle: {
      evaluate: async (callback) => callback(presentationObserver),
    },
    rendererRouteHandle: undefined,
    rendererCheckpoint: async () => order.push('renderer-checkpoint'),
    window: {
      evaluate: async (callback) => callback(),
      evaluateHandle: async (callback, element) => {
        const value = callback(element);
        assert.notEqual(value, root);
        return rendererRouteHandle;
      },
      locator: () => ({
        getByRole: () => ({ first: () => composer }),
      }),
    },
  });
  await vm.runInContext(
    `(async () => {${source.slice(start, end)}\n})()`,
    context,
  );
  return { context, order };
}

// Catches omission or late installation of the passive renderer route record in
// the actual controlled composer flow. This runs the source block, not a schema.
test('presentation controlled composer flow records passive renderer boundaries without replacing the trigger', async () => {
  const { context, order } = await presentationRendererRouteSourceFixture();
  assert.deepEqual(Array.from(order), [
    'root-install',
    'renderer-install',
    'renderer-checkpoint',
    'main-trigger',
    'renderer-trigger',
    'fill',
    'renderer-after-fill',
    'renderer-report',
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.controlledEvidence.rendererRoute)),
    {
      status: 'recording',
      incomplete: false,
      records: [{ phase: 'installation' }],
    },
  );
  assert.equal(
    context.controlledEvidence.composerRootBefore.status,
    'available',
  );
  assert.equal(
    context.controlledEvidence.composerRootBefore.rootRect.height,
    104,
  );
  assert.equal(
    context.controlledEvidence.composerRootBefore.composerDensity,
    'comfortable',
  );
  assert.equal(
    context.controlledEvidence.composerRootBefore.slateScroller.maxHeightPx,
    32,
  );
  assert.equal(
    context.controlledEvidence.composerRootAfter.status,
    'available',
  );
  assert.equal(
    context.controlledEvidence.composerRootAfter.rootRect.height,
    216,
  );
  assert.equal(context.controlledEvidence.composerAfter.height, 80);
});

test('presentation controlled composer flow preserves the real trigger and fill when passive recording is unavailable', async () => {
  for (const options of [
    { elementHandleFailure: true },
    { installFailure: true },
    { methodFailure: true },
  ]) {
    const { context, order } =
      await presentationRendererRouteSourceFixture(options);
    assert(order.includes('renderer-checkpoint'));
    assert(order.includes('main-trigger'));
    assert(order.includes('fill'));
    assert.equal(order.indexOf('main-trigger') < order.indexOf('fill'), true);
    if (options.elementHandleFailure || options.installFailure) {
      assert.equal(
        context.controlledEvidence.rendererRoute.status,
        'unavailable',
      );
      assert.equal(
        context.controlledEvidence.rendererRoute.reason,
        'installation-failed',
      );
    } else {
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(context.controlledEvidence.rendererRouteFailures),
        ),
        [
          {
            phase: 'trigger-boundary',
            message: 'Error: trigger read failed',
          },
          {
            phase: 'after-fill-retrieval',
            message: 'Error: after-fill read failed',
          },
        ],
      );
    }
  }
});

async function presentationRendererRouteFixture({
  enabled = true,
  rootConnected = true,
  missingRoot = false,
  missingScroller = false,
  scrollerConnected = true,
  scrollerReadFailure = false,
  overflowY = 'auto',
  maxHeight = '200px',
  readFailure = false,
  apiUnavailable = false,
  observeFailure = false,
  listenerInstallFailure = false,
  resizeDisconnectFailures = 0,
  clock = (() => {
    let tick = 0;
    return () => ++tick;
  })(),
  byteLength = (value) => Buffer.byteLength(value),
  cleanupFailures = {},
} = {}) {
  const module =
    await import('../electron/browser-profile-presentation-observer.mjs');
  const declaration = module.installPresentationRendererRouteRecorder;
  assert.equal(
    typeof declaration,
    'function',
    'renderer route recorder implementation must be available',
  );
  let rootRect = { x: 10, y: 20, width: 320, height: 60 };
  let textboxRect = { x: 18, y: 28, width: 304, height: 20 };
  let scrollerRect = { x: 14, y: 24, width: 312, height: 104 };
  const styleReads = { overflowY: 0, maxHeight: 0 };
  const scroller = {
    get isConnected() {
      return scrollerConnected;
    },
    get clientHeight() {
      if (scrollerReadFailure) throw new Error('scroller client read failed');
      return 104;
    },
    get scrollHeight() {
      if (scrollerReadFailure) throw new Error('scroller scroll read failed');
      return 104;
    },
    getBoundingClientRect() {
      if (scrollerReadFailure) throw new Error('scroller rect read failed');
      return scrollerRect;
    },
  };
  let currentScroller = missingScroller ? null : scroller;
  const root = {
    get isConnected() {
      return rootConnected;
    },
    getBoundingClientRect() {
      if (readFailure) throw new Error('root read failed');
      return rootRect;
    },
    getAttribute: (name) =>
      name === 'data-composer-density' ? 'comfortable' : null,
    contains: (node) => node === currentScroller,
  };
  const textbox = {
    isConnected: true,
    get parentElement() {
      return currentScroller;
    },
    closest: () => (missingRoot ? null : root),
    getBoundingClientRect: () => textboxRect,
  };
  const listeners = new Map();
  const addEventListener = (name, listener) => {
    if (listenerInstallFailure) throw new Error('listener installation failed');
    const values = listeners.get(name) ?? new Set();
    values.add(listener);
    listeners.set(name, values);
  };
  const removeEventListener = (name, listener) => {
    if (cleanupFailures.listener) throw new Error('listener cleanup failed');
    listeners.get(name)?.delete(listener);
  };
  const dispatch = (name) => {
    for (const listener of [...(listeners.get(name) ?? [])])
      listener({ type: name });
  };
  const resizeObservers = [];
  class OwnedResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnectCount = 0;
      resizeObservers.push(this);
    }
    observe(node) {
      assert.equal(node, root);
      this.observed = node;
      if (observeFailure) throw new Error('observe failed');
    }
    disconnect() {
      this.disconnectAttempts = (this.disconnectAttempts ?? 0) + 1;
      if (
        cleanupFailures.resizeObserver ||
        this.disconnectAttempts <= resizeDisconnectFailures
      )
        throw new Error('resize cleanup failed');
      this.disconnectCount++;
    }
    emit() {
      this.callback([{ target: root }]);
    }
  }
  let nextFrameId = 0;
  const frames = new Map();
  const cancelledFrames = [];
  const requestAnimationFrame = (callback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id) => {
    if (cleanupFailures.animationFrame) throw new Error('frame cleanup failed');
    cancelledFrames.push(id);
    frames.delete(id);
  };
  const renderer = {
    document: { visibilityState: 'hidden' },
    getComputedStyle: () => {
      if (scrollerReadFailure) throw new Error('scroller style read failed');
      return {
        get overflowY() {
          styleReads.overflowY++;
          return overflowY;
        },
        get maxHeight() {
          styleReads.maxHeight++;
          return maxHeight;
        },
      };
    },
    addEventListener,
    removeEventListener,
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver: apiUnavailable ? undefined : OwnedResizeObserver,
  };
  const install = vm.runInNewContext(`(${declaration.toString()})`, {});
  const handle = install(
    textbox,
    { enabled },
    {
      renderer,
      clock,
      byteLength,
    },
  );
  return {
    handle,
    root,
    textbox,
    listeners,
    resizeObservers,
    dispatch,
    frames,
    cancelledFrames,
    requestAnimationFrame,
    styleReads,
    setRootRect: (value) => {
      rootRect = value;
    },
    setTextboxRect: (value) => {
      textboxRect = value;
    },
    setScrollerRect: (value) => {
      scrollerRect = value;
    },
    replaceScroller: () => {
      currentScroller = {
        ...scroller,
        isConnected: true,
      };
    },
    runFrame(id) {
      const callback = frames.get(id);
      assert.equal(typeof callback, 'function');
      frames.delete(id);
      callback(100);
    },
  };
}

test('presentation renderer route distinguishes root resize, bounds event, own frame and the unchanged C oracle', async () => {
  const f = await presentationRendererRouteFixture();
  assert.equal(f.resizeObservers.length, 1);
  f.resizeObservers[0].emit();
  f.handle.noteTrigger();
  f.resizeObservers[0].emit();
  let report = f.handle.report();
  assert.equal(report.counters.resizeObserverNotifications, 2);
  assert.equal(report.counters.initialResizeObserverNotifications, 1);
  assert.equal(report.counters.postTriggerSizeChanges, 0);
  assert.equal(report.evidence.rootResizeObservedAfterTrigger, false);

  f.setRootRect({ x: 10, y: 20, width: 320, height: 96 });
  f.setTextboxRect({ x: 18, y: 28, width: 304, height: 56 });
  f.resizeObservers[0].emit();
  f.handle.noteAfterFill();
  report = f.handle.report();
  assert.equal(report.counters.postTriggerSizeChanges, 1);
  assert.equal(report.evidence.rootResizeObservedAfterTrigger, true);
  assert.equal(report.evidence.boundsInvalidationObserved, false);
  assert.equal(report.evidence.ownAnimationFrameObserved, false);

  f.dispatch('canopy:browser-view-bounds-invalidated');
  f.dispatch('canopy:browser-view-bounds-invalidated');
  report = f.handle.report();
  assert.equal(report.counters.boundsInvalidationEvents, 2);
  assert.equal(report.counters.ownAnimationFramesScheduled, 1);
  assert.equal(report.counters.ownAnimationFrameCallbacks, 0);
  assert.equal(report.evidence.boundsInvalidationObserved, true);
  assert.equal(report.evidence.ownAnimationFrameObserved, false);
  const ownFrame = [...f.frames.keys()][0];
  f.runFrame(ownFrame);
  report = f.handle.report();
  assert.equal(report.evidence.ownAnimationFrameObserved, true);
  assert.equal(report.evidence.canSatisfyControlledWitness, false);
  assert.equal(
    report.serializedBytes,
    Buffer.byteLength(JSON.stringify(report)),
  );
  assert.equal(Object.hasOwn(report, 'controlledWitnessCaptured'), false);
  const phases = Array.from(report.records, (row) => row.phase);
  assert(phases.includes('installation'));
  assert(phases.includes('trigger-boundary'));
  assert(phases.includes('after-fill'));
  const trigger = report.records.find(
    (row) => row.phase === 'trigger-boundary',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(trigger.rootRect)), {
    x: 10,
    y: 20,
    width: 320,
    height: 60,
  });
  assert.equal(trigger.composerDensity, 'comfortable');
  assert.deepEqual(JSON.parse(JSON.stringify(trigger.slateScroller)), {
    same: true,
    connected: true,
    withinRoot: true,
    rect: { x: 14, y: 24, width: 312, height: 104 },
    clientHeight: 104,
    scrollHeight: 104,
    overflowY: 'auto',
    maxHeight: '200px',
  });
  const after = report.records.find((row) => row.phase === 'after-fill');
  assert.equal(after.rootSame, true);
  assert.equal(after.rootConnected, true);
  assert.equal(after.textboxConnected, true);
  assert.equal(after.documentVisibility, 'hidden');
  assert.equal(after.rootRect.height, 96);
  assert.equal(after.textboxRect.height, 56);
  assert.equal(after.slateScroller.same, true);
  assert.equal(after.slateScroller.connected, true);
  const final = f.handle.finalize();
  for (const phase of [
    'installation',
    'trigger-boundary',
    'after-fill',
    'final-retrieval',
  ]) {
    const row = final.records.find((record) => record.phase === phase);
    assert.equal(row.composerDensity, 'comfortable', phase);
    assert.equal(row.slateScroller.same, true, phase);
    assert.equal(row.slateScroller.connected, true, phase);
    assert.equal(row.slateScroller.withinRoot, true, phase);
    assert.deepEqual(JSON.parse(JSON.stringify(row.slateScroller.rect)), {
      x: 14,
      y: 24,
      width: 312,
      height: 104,
    });
    assert.equal(row.slateScroller.clientHeight, 104, phase);
    assert.equal(row.slateScroller.scrollHeight, 104, phase);
    assert.equal(row.slateScroller.overflowY, 'auto', phase);
    assert.equal(row.slateScroller.maxHeight, '200px', phase);
  }
});

test('presentation renderer route exposes disabled, missing, disconnected, read-failed, invalid-clock and overflow evidence', async () => {
  const cases = [
    ['disabled', { enabled: false }, 'disabled'],
    ['missing', { missingRoot: true }, 'composer-root-missing'],
    ['missing-scroller', { missingScroller: true }, 'slate-scroller-missing'],
    ['disconnected', { rootConnected: false }, 'composer-root-disconnected'],
    [
      'disconnected-scroller',
      { scrollerConnected: false },
      'slate-scroller-disconnected',
    ],
    ['read-failed', { readFailure: true }, 'geometry-read-failed'],
    [
      'scroller-read-failed',
      { scrollerReadFailure: true },
      'geometry-read-failed',
    ],
    [
      'api-unavailable',
      { apiUnavailable: true },
      'renderer-observation-api-unavailable',
    ],
    ['invalid-clock', { clock: () => Number.NaN }, 'invalid-clock'],
    ['overflow', { byteLength: () => 65_536 }, 'record-capacity'],
  ];
  for (const [name, options, reason] of cases) {
    const f = await presentationRendererRouteFixture(options);
    const report = f.handle.finalize();
    assert.equal(report.status, 'unavailable', name);
    assert.equal(report.incomplete, true, name);
    assert.equal(report.reason, reason, name);
    assert(report.records.length <= 64, name);
    assert(Buffer.byteLength(JSON.stringify(report)) <= 65_536, name);
    assert.equal(f.handle.finalize().reason, reason, name);
  }
});

test('presentation renderer route rejects replacement Slate scroller metadata as growth evidence', async () => {
  const f = await presentationRendererRouteFixture();
  f.resizeObservers[0].emit();
  f.handle.noteTrigger();
  f.replaceScroller();
  f.setRootRect({ x: 10, y: 20, width: 320, height: 96 });
  f.resizeObservers[0].emit();
  const report = f.handle.finalize();
  assert.equal(report.status, 'unavailable');
  assert.equal(report.reason, 'slate-scroller-identity-changed');
  assert.equal(report.counters.postTriggerSizeChanges, 0);
  assert.equal(report.evidence.rootResizeObservedAfterTrigger, false);
  const changed = report.records.find(
    (row) => row.phase === 'resize-observer' && row.afterTrigger,
  );
  assert.equal(changed.status, 'unavailable');
  assert.equal(changed.slateScroller.same, false);
  assert.equal(changed.slateScroller.withinRoot, false);
});

test('presentation renderer route rejects missing and oversized CSS metadata without qualifying growth', async () => {
  const cases = [
    [
      'missing-overflow-y',
      { overflowY: null },
      'slate-scroller-overflow-y-unavailable',
      'overflowY',
    ],
    [
      'oversized-overflow-y',
      { overflowY: 'x'.repeat(33) },
      'slate-scroller-overflow-y-unavailable',
      'overflowY',
    ],
    [
      'missing-max-height',
      { maxHeight: null },
      'slate-scroller-max-height-unavailable',
      'maxHeight',
    ],
    [
      'oversized-max-height',
      { maxHeight: 'x'.repeat(33) },
      'slate-scroller-max-height-unavailable',
      'maxHeight',
    ],
  ];
  for (const [name, options, reason, field] of cases) {
    const f = await presentationRendererRouteFixture(options);
    f.resizeObservers[0].emit();
    f.handle.noteTrigger();
    f.setRootRect({ x: 10, y: 20, width: 320, height: 96 });
    f.resizeObservers[0].emit();
    const report = f.handle.report();
    assert.equal(report.status, 'unavailable', name);
    assert.equal(report.reason, reason, name);
    assert.equal(report.counters.postTriggerSizeChanges, 0, name);
    assert.equal(report.evidence.rootResizeObservedAfterTrigger, false, name);
    assert.equal(f.styleReads.overflowY, 4, name);
    assert.equal(f.styleReads.maxHeight, 4, name);
    for (const row of report.records.filter((record) => record.slateScroller)) {
      const value = row.slateScroller[field];
      assert(value === null || value.length <= 32, name);
    }
    assert.equal(report.records.length <= 64, true, name);
    assert.equal(
      Buffer.byteLength(JSON.stringify(report)) <= 65_536,
      true,
      name,
    );
  }
});

async function presentationRendererUnavailableActualFlow({
  state,
  outcome,
  rootGrows = true,
  afterFillBoundingBoxFailure = false,
}) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const module =
    await import('../electron/browser-profile-presentation-observer.mjs');
  const installPresentationRendererRouteRecorder = vm.runInNewContext(
    `(${module.installPresentationRendererRouteRecorder.toString()})`,
    {},
  );
  const caseStart = source.indexOf(
    'async function runPendingSourceDialogCase(',
  );
  const actionStart = source.indexOf(
    '      const composer = window',
    caseStart,
  );
  const actionEnd = source.indexOf(
    '\n      await expect\n        .poll(\n          async () => {',
    actionStart,
  );
  const finalizationArea = source.indexOf(
    '    if (controlledEvidence) {',
    source.indexOf('  } finally {', caseStart),
  );
  const finalizationStart = source.indexOf(
    '      if (rendererRouteHandle) {',
    finalizationArea,
  );
  const finalizationEnd = source.indexOf(
    '\n      try {\n        await test',
    finalizationStart,
  );
  assert(
    actionStart > caseStart &&
      actionEnd > actionStart &&
      finalizationStart > finalizationArea &&
      finalizationEnd > finalizationStart,
  );

  const order = [];
  const actionResult = { state, outcome, identity: 'success-sentinel' };
  const actionError = new Error(`${state}-${outcome}-sentinel`);
  const rootGrowthError = new Error('composer-root-growth-sentinel');
  const afterFillBoundingBoxError = new Error(
    'after-fill-bounding-box-sentinel',
  );
  let rootHeight = 104;
  let recorderReadFailure = state === 'read-failed';
  const scroller = {
    isConnected: true,
    get clientHeight() {
      return rootHeight - 72;
    },
    get scrollHeight() {
      return rootHeight - 72;
    },
    getBoundingClientRect: () => ({
      x: 10,
      y: 20,
      width: 320,
      height: rootHeight - 72,
    }),
  };
  let textbox;
  const root = {
    isConnected: true,
    getBoundingClientRect() {
      if (recorderReadFailure) throw new Error('root read failed');
      return { x: 10, y: 20, width: 320, height: rootHeight };
    },
    getAttribute: (name) =>
      name === 'data-composer-density' ? 'comfortable' : null,
    querySelectorAll: (selector) =>
      selector === '[data-chat-textarea]' ? [textbox] : [],
    contains: (node) => node === scroller,
  };
  textbox = {
    isConnected: true,
    parentElement: scroller,
    closest: () => root,
    getBoundingClientRect: () => ({ x: 18, y: 28, width: 304, height }),
    dispose: async () => order.push('element-dispose'),
  };
  const listeners = new Map();
  const resizeObservers = [];
  class OwnedResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnectAttempts = 0;
      resizeObservers.push(this);
    }
    observe(node) {
      assert.equal(node, root);
    }
    disconnect() {
      this.disconnectAttempts++;
    }
  }
  let nextFrame = 0;
  const frames = new Map();
  const cancelledFrames = [];
  const renderer = {
    document: { visibilityState: 'hidden' },
    TextEncoder,
    getComputedStyle: () =>
      height === 20
        ? { overflowY: 'hidden', maxHeight: '32px' }
        : { overflowY: 'auto', maxHeight: '200px' },
    ResizeObserver: state === 'unavailable' ? undefined : OwnedResizeObserver,
    addEventListener(name, listener) {
      const values = listeners.get(name) ?? new Set();
      values.add(listener);
      listeners.set(name, values);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    },
  };
  let clock = 0;
  let height = 20;
  let disposedHandles = 0;
  let disposedRootHandles = 0;
  const composer = {
    evaluateHandle: async (callback) => {
      const value = callback(textbox);
      assert.equal(value, root);
      return {
        evaluate: async (operation) => operation(root),
        dispose: async () => {
          disposedRootHandles++;
        },
      };
    },
    elementHandle: async () => textbox,
    boundingBox: async () => {
      if (afterFillBoundingBoxFailure && height === 80)
        throw afterFillBoundingBoxError;
      return { x: 1, y: 2, width: 300, height };
    },
    fill: async (value) => {
      order.push('fill');
      if (outcome === 'error') throw actionError;
      height = 80;
      if (rootGrows && value.split('\n').length >= 6) rootHeight = 216;
      context.operationResult = actionResult;
      return actionResult;
    },
  };
  const expectValue = (actual) => ({
    toBeVisible: async () => {},
    toBeEditable: async () => {},
    toBeGreaterThan: (expected) => assert(actual > expected),
    toBe: (expected) => assert.equal(actual, expected),
  });
  expectValue.poll = (callback) => ({
    toBeGreaterThan: async (expected) => assert((await callback()) > expected),
    toBe: async (expected) => {
      if ((await callback()) !== expected) throw rootGrowthError;
    },
  });
  const controlledEvidence = { rendererCheckpoints: [] };
  const context = vm.createContext({
    boundedCleanupErrorMessage: (error) => String(error),
    composerRootElement: undefined,
    controlledEvidence,
    expect: expectValue,
    getComputedStyle: () =>
      height === 20
        ? { overflowY: 'hidden', maxHeight: '32px' }
        : { overflowY: 'auto', maxHeight: '200px' },
    installPresentationRendererRouteRecorder,
    modal: { getByRole: () => ({}) },
    original: { id: 'browser-1' },
    performance: { now: () => ++clock },
    presentationObserverHandle: {
      evaluate: async (callback) =>
        callback({
          noteControlledTrigger() {
            order.push('main-trigger');
            return { phase: 'controlled-composer-trigger-armed' };
          },
        }),
    },
    rendererCheckpoint: async () => order.push('renderer-checkpoint'),
    rendererRouteHandle: undefined,
    window: {
      evaluate: async (callback) => callback(),
      evaluateHandle: async (callback, element) => {
        order.push('renderer-install');
        const value = callback(
          element,
          { enabled: state !== 'disabled' },
          {
            renderer,
            clock: () => ++clock,
            byteLength:
              state === 'overflow'
                ? () => 65_536
                : (value) => Buffer.byteLength(value),
          },
        );
        assert.notEqual(value, root);
        const recorder = value;
        recorderReadFailure = false;
        return {
          evaluate: async (operation) => operation(recorder),
          dispose: async () => {
            disposedHandles++;
          },
        };
      },
      locator: () => ({
        getByRole: () => ({ first: () => composer }),
      }),
    },
  });
  let action;
  try {
    action = {
      status: 'fulfilled',
      value: await vm.runInContext(
        `(async () => {${source.slice(actionStart, actionEnd)}\nreturn operationResult;\n})()`,
        context,
      ),
    };
  } catch (error) {
    action = { status: 'rejected', error };
  }
  for (const listener of [
    ...(listeners.get('canopy:browser-view-bounds-invalidated') ?? []),
  ])
    listener({ type: 'canopy:browser-view-bounds-invalidated' });
  await vm.runInContext(
    `(async () => {${source.slice(finalizationStart, finalizationEnd)}\n})()`,
    context,
  );
  return {
    action,
    actionResult,
    actionError,
    afterFillBoundingBoxError,
    cancelledFrames,
    controlledEvidence,
    disposedHandles,
    disposedRootHandles,
    frames,
    listeners,
    order,
    resizeObservers,
    rootGrowthError,
  };
}

test('presentation actual controlled flow preserves success, error and owned cleanup for every unavailable recorder state', async () => {
  const reasons = {
    disabled: 'disabled',
    unavailable: 'renderer-observation-api-unavailable',
    overflow: 'record-capacity',
    'read-failed': 'geometry-read-failed',
  };
  for (const [state, reason] of Object.entries(reasons))
    for (const outcome of ['success', 'error']) {
      const f = await presentationRendererUnavailableActualFlow({
        state,
        outcome,
      });
      if (outcome === 'success') {
        assert.equal(f.action.status, 'fulfilled', state);
        assert.equal(f.action.value, f.actionResult, state);
      } else {
        assert.equal(f.action.status, 'rejected', state);
        assert.equal(f.action.error, f.actionError, state);
      }
      assert.equal(f.order.includes('main-trigger'), true, state);
      assert.equal(f.order.includes('fill'), true, state);
      assert.equal(
        f.order.indexOf('main-trigger') < f.order.indexOf('fill'),
        true,
        state,
      );
      assert.equal(f.controlledEvidence.rendererRoute.reason, reason, state);
      assert.equal(f.controlledEvidence.rendererRoute.incomplete, true, state);
      assert.equal(f.disposedHandles, 1, state);
      assert.equal(f.disposedRootHandles, 1, state);
      assert.equal(
        f.listeners.get('canopy:browser-view-bounds-invalidated')?.size ?? 0,
        0,
        state,
      );
      if (['overflow', 'read-failed'].includes(state)) {
        assert.equal(f.resizeObservers.length, 1, state);
        assert.equal(f.resizeObservers[0].disconnectAttempts, 1, state);
        assert.equal(f.cancelledFrames.length, 1, state);
        assert.equal(f.frames.size, 0, state);
      } else {
        assert.equal(f.resizeObservers.length, 0, state);
        assert.equal(f.cancelledFrames.length, 0, state);
      }
    }
});

test('presentation actual controlled flow rejects fixed root growth before C and preserves owned cleanup', async () => {
  const f = await presentationRendererUnavailableActualFlow({
    state: 'available',
    outcome: 'success',
    rootGrows: false,
  });
  assert.equal(f.action.status, 'rejected');
  assert.equal(f.order.includes('fill'), true);
  assert.equal(f.order.includes('main-trigger'), true);
  assert.equal(f.order.indexOf('main-trigger') < f.order.indexOf('fill'), true);
  assert.equal(f.controlledEvidence.composerBefore.height, 20);
  assert.equal(f.controlledEvidence.composerAfter.height, 80);
  assert.equal(f.controlledEvidence.composerRootBefore.rootRect.height, 104);
  assert.equal(f.controlledEvidence.composerRootAfter.rootRect.height, 104);
  const afterFill = f.controlledEvidence.rendererRoute.records.find(
    (row) => row.phase === 'after-fill',
  );
  assert.equal(afterFill.rootRect.height, 104);
  assert.equal(afterFill.textboxRect.height, 80);
  assert.equal(f.disposedHandles, 1);
  assert.equal(f.disposedRootHandles, 1);
  assert.equal(
    f.listeners.get('canopy:browser-view-bounds-invalidated')?.size ?? 0,
    0,
  );
  assert.equal(f.resizeObservers.length, 1);
  assert.equal(f.resizeObservers[0].disconnectAttempts, 1);
  assert.equal(f.cancelledFrames.length, 1);
  assert.equal(f.frames.size, 0);
});

test('presentation actual controlled flow preserves root-growth failure through after-fill textbox read failure and cleanup', async () => {
  const f = await presentationRendererUnavailableActualFlow({
    state: 'available',
    outcome: 'success',
    rootGrows: false,
    afterFillBoundingBoxFailure: true,
  });
  assert.equal(f.action.status, 'rejected');
  assert.equal(f.action.error, f.rootGrowthError);
  assert.notEqual(f.action.error, f.afterFillBoundingBoxError);
  assert.equal(f.controlledEvidence.composerRootAfter.rootRect.height, 104);
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.controlledEvidence.composerGeometryFailures)),
    [
      {
        phase: 'after-fill-textbox-geometry',
        message: 'Error: after-fill-bounding-box-sentinel',
      },
    ],
  );
  const phases = f.controlledEvidence.rendererRoute.records.map(
    (row) => row.phase,
  );
  assert.equal(phases.includes('after-fill'), true);
  assert.equal(phases.includes('final-retrieval'), true);
  assert.equal(f.disposedHandles, 1);
  assert.equal(f.disposedRootHandles, 1);
  assert.equal(f.resizeObservers[0].disconnectAttempts, 1);
  assert.equal(
    f.listeners.get('canopy:browser-view-bounds-invalidated')?.size ?? 0,
    0,
  );
  assert.equal(f.cancelledFrames.length, 1);
  assert.equal(f.frames.size, 0);
});

test('presentation renderer route bounds raw records and cleanup removes only its observer, listener and pending frame', async () => {
  const f = await presentationRendererRouteFixture();
  let unrelatedEvents = 0;
  const unrelatedListener = () => unrelatedEvents++;
  f.listeners
    .get('canopy:browser-view-bounds-invalidated')
    .add(unrelatedListener);
  const unrelatedFrame = f.requestAnimationFrame(() => {});
  for (let i = 0; i < 80; i++)
    f.dispatch('canopy:browser-view-bounds-invalidated');
  const ownFrame = [...f.frames.keys()].find((id) => id !== unrelatedFrame);
  const report = f.handle.finalize();
  assert.equal(report.status, 'unavailable');
  assert.equal(report.reason, 'record-capacity');
  assert.equal(report.incomplete, true);
  assert.equal(report.records.length, 64);
  assert.equal(report.counters.boundsInvalidationEvents, 80);
  assert.equal(report.counters.droppedRecords > 0, true);
  assert.equal(report.resources.cleaned, true);
  assert.equal(report.resources.pendingOwnAnimationFrame, false);
  assert.deepEqual(f.cancelledFrames, [ownFrame]);
  assert.equal(f.frames.has(unrelatedFrame), true);
  assert.equal(f.resizeObservers[0].disconnectCount, 1);
  f.dispatch('canopy:browser-view-bounds-invalidated');
  assert.equal(unrelatedEvents, 81);
  assert.equal(f.handle.finalize().records.length, 64);
  assert.equal(f.resizeObservers[0].disconnectCount, 1);
});

test('presentation renderer route reports owned cleanup failures without throwing or claiming release', async () => {
  const f = await presentationRendererRouteFixture({
    cleanupFailures: {
      resizeObserver: true,
      listener: true,
      animationFrame: true,
    },
  });
  f.dispatch('canopy:browser-view-bounds-invalidated');
  const report = f.handle.finalize();
  assert.equal(report.status, 'unavailable');
  assert.equal(report.reason, 'resize-observer-cleanup-failed');
  assert.equal(report.resources.resizeObserverDisconnected, false);
  assert.equal(report.resources.listenerRemoved, false);
  assert.equal(report.resources.ownAnimationFrameCancelled, false);
  assert.equal(report.resources.cleaned, true);
});

test('presentation renderer route retains a partially installed observer until bounded final cleanup succeeds', async () => {
  for (const [name, options, reason] of [
    [
      'observe',
      { observeFailure: true, resizeDisconnectFailures: 1 },
      'resize-observer-install-failed',
    ],
    [
      'listener',
      { listenerInstallFailure: true, resizeDisconnectFailures: 1 },
      'event-listener-install-failed',
    ],
  ]) {
    const f = await presentationRendererRouteFixture(options);
    assert.equal(f.resizeObservers.length, 1, name);
    assert.equal(f.resizeObservers[0].disconnectAttempts, 1, name);
    const setup = f.handle.report();
    assert.equal(setup.reason, reason, name);
    assert.equal(
      setup.resources.resizeObserverInstalled,
      name === 'listener',
      name,
    );
    assert.equal(setup.resources.resizeObserverOwned, true, name);
    assert.equal(setup.resources.resizeObserverDisconnectPending, true, name);
    assert(
      setup.records.some(
        (row) =>
          row.phase === 'setup-resize-observer-cleanup' &&
          row.outcome === 'failed',
      ),
      name,
    );
    const final = f.handle.finalize();
    assert.equal(f.resizeObservers[0].disconnectAttempts, 2, name);
    assert.equal(f.resizeObservers[0].disconnectCount, 1, name);
    assert.equal(final.reason, reason, name);
    assert.equal(final.resources.resizeObserverOwned, false, name);
    assert.equal(final.resources.resizeObserverDisconnectPending, false, name);
    assert.equal(final.resources.resizeObserverDisconnected, true, name);
  }
});

async function presentationRendererFinalizationSourceFixture(priorReason) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const caseStart = source.indexOf(
    'async function runPendingSourceDialogCase(',
  );
  const finalizationArea = source.indexOf(
    '    if (controlledEvidence) {',
    source.indexOf('  } finally {', caseStart),
  );
  const start = source.indexOf(
    '      if (rendererRouteHandle) {',
    finalizationArea,
  );
  const end = source.indexOf('\n      try {\n        await test', start);
  assert(
    caseStart >= 0 && finalizationArea > caseStart && start > 0 && end > start,
  );
  const controlledEvidence = {
    rendererRoute: {
      version: 1,
      status: 'unavailable',
      reason: priorReason,
      incomplete: true,
      records: [],
    },
  };
  const finalFailure = new Error('renderer destroyed before finalization');
  const context = vm.createContext({
    boundedCleanupErrorMessage: (error) => String(error),
    composerRootElement: undefined,
    controlledEvidence,
    rendererRouteHandle: {
      evaluate: async () => {
        throw finalFailure;
      },
      dispose: async () => {},
    },
  });
  await vm.runInContext(
    `(async () => {${source.slice(start, end)}\n})()`,
    context,
  );
  return controlledEvidence;
}

test('presentation renderer final retrieval preserves the first recorder reason and records transport failure separately', async () => {
  const prior =
    await presentationRendererFinalizationSourceFixture('record-capacity');
  assert.equal(prior.rendererRoute.reason, 'record-capacity');
  assert.equal(prior.rendererRoute.incomplete, true);
  assert.deepEqual(JSON.parse(JSON.stringify(prior.rendererRouteFailures)), [
    {
      phase: 'final-retrieval',
      message: 'Error: renderer destroyed before finalization',
    },
  ]);
  const noPrior = await presentationRendererFinalizationSourceFixture(null);
  assert.equal(noPrior.rendererRoute.reason, 'final-retrieval-failed');
});

// Catches a missing or over-broad B gate in the actual serialized installer.
test('presentation controlled later hide holds only tagged B at its first owner read and releases both gates safely', async () => {
  const f = await realTaggedPresentationFixture({ controlledLaterHide: true });
  const request = {
    browserId: 'browser-1',
    expectedRuntimeGeneration: 2,
    e2ePresentationInjectionId: 'injection-1',
  };
  const pending = [];
  try {
    pending.push(
      f.invoke(
        { ...request, bounds: f.target.bounds, visible: true },
        'bounds',
      ),
    );
    await f.taggedFixture.waitForGate();
    pending.push(f.invoke({ ...request, visible: false }));
    await new Promise(setImmediate);
    assert.equal(
      f.taggedFixture.snapshot().newerSettled,
      false,
      'controlled B must still await its first exact owner read',
    );
    assert.equal(f.taggedFixture.snapshot().newerGatedEntered, true);
    assert.equal(f.taggedFixture.snapshot().newerGatedHits, 1);
    assert.equal(
      await f.invoke({
        browserId: 'browser-1',
        expectedRuntimeGeneration: 2,
        visible: false,
      }),
      'unchanged-result',
    );
    assert.equal(
      await f.invoke({
        ...request,
        e2ePresentationInjectionId: 'foreign-tag',
        visible: false,
      }),
      'unchanged-result',
    );
    assert.equal(
      await f.invoke({
        ...request,
        expectedRuntimeGeneration: 1,
        visible: false,
      }),
      'unchanged-result',
    );
    assert.equal(f.taggedFixture.snapshot().newerSettled, false);
    f.taggedFixture.releaseNewer();
    assert.equal(await pending[1], 'unchanged-result');
    assert.equal(f.taggedFixture.snapshot().earlierSettled, false);
    assert.equal(f.taggedFixture.snapshot().newerCompletedBeforeRelease, true);
    f.taggedFixture.release();
    assert.equal(await pending[0], 'unchanged-result');
    assert.equal(f.taggedFixture.snapshot().newerGatedReleased, true);
  } finally {
    f.taggedFixture.restore();
    await Promise.allSettled(pending);
    f.observer.finalize();
  }
});

// Catches a missing native witness or an extra reserved snapshot in the controlled schedule.
test('presentation controlled witness records a real settled owner hide while A and B remain gated within four snapshots', async () => {
  const f = await realTaggedPresentationFixture({ controlledLaterHide: true });
  const request = {
    browserId: 'browser-1',
    expectedRuntimeGeneration: 2,
    e2ePresentationInjectionId: 'injection-1',
  };
  const pending = [];
  try {
    pending.push(
      f.invoke(
        { ...request, bounds: f.target.bounds, visible: true },
        'bounds',
      ),
    );
    await f.taggedFixture.waitForGate();
    pending.push(f.invoke({ ...request, visible: false }));
    await f.taggedFixture.waitForNewerGate();
    await f.invoke({
      browserId: 'browser-1',
      expectedRuntimeGeneration: 2,
      visible: false,
    });
    assert.equal(
      f.observer.report().snapshots.length,
      0,
      'a pre-trigger hide is not the controlled UI witness',
    );
    f.observer.noteControlledTrigger();
    await f.invoke({
      browserId: 'browser-1',
      expectedRuntimeGeneration: 2,
      visible: false,
    });
    await f.invoke({
      browserId: 'browser-1',
      expectedRuntimeGeneration: 2,
      visible: false,
    });
    const held = f.observer.report();
    assert.equal(
      held.snapshots.length,
      1,
      'retain the first positive later-hide checkpoint',
    );
    assert.equal(held.snapshots[0].phase, 'later-hide-fulfilled-while-gated');
    assert.equal(held.snapshots[0].witnessCallId, 4);
    assert.deepEqual(Array.from(held.snapshots[0].pendingIds), [1, 2]);
    assert.equal(held.snapshots[0].state.native.visible, false);
    assert.equal(held.snapshots[0].state.session.dialogMatchesInitial, true);
    assert.equal(held.calls[3].state, 'fulfilled');
    assert.equal(held.calls[3].reads.owner, 1);
    assert.equal(f.taggedFixture.snapshot().newerSettled, false);
    f.taggedFixture.releaseNewer();
    await pending[1];
    f.taggedFixture.release();
    await pending[0];
    const report = f.observer.finalize();
    assert.deepEqual(
      Array.from(report.snapshots, (row) => row.phase),
      [
        'later-hide-fulfilled-while-gated',
        'B-fulfillment-observed',
        'cohort-settled',
        'pre-detach',
      ],
    );
    assert.equal(report.incomplete, false);
    assert.equal(report.truncationReason, null);
    assert(report.events.some((row) => row.phase === 'gate-release-requested'));
    assert(
      report.events.some((row) => row.phase === 'newer-gate-release-requested'),
    );
  } finally {
    f.taggedFixture.restore();
    await Promise.allSettled(pending);
    f.observer.finalize();
  }
});

for (const reason of ['absent', 'unavailable', 'native-visible'])
  test(`presentation controlled witness with ${reason} C retains the original release-state slot`, async () => {
    const f = await realTaggedPresentationFixture({
      controlledLaterHide: true,
      nativeVisible: reason === 'native-visible',
      ...(reason === 'unavailable' ? { diagnosticGetter: () => ({}) } : {}),
    });
    const request = {
      browserId: 'browser-1',
      expectedRuntimeGeneration: 2,
      e2ePresentationInjectionId: 'injection-1',
    };
    const pending = [];
    try {
      pending.push(
        f.invoke(
          { ...request, bounds: f.target.bounds, visible: true },
          'bounds',
        ),
      );
      await f.taggedFixture.waitForGate();
      pending.push(f.invoke({ ...request, visible: false }));
      await f.taggedFixture.waitForNewerGate();
      f.observer.noteControlledTrigger();
      if (reason !== 'absent')
        await f.invoke({
          browserId: 'browser-1',
          expectedRuntimeGeneration: 2,
          visible: false,
        });
      assert.equal(
        f.observer
          .report()
          .snapshots.some(
            (row) => row.phase === 'later-hide-fulfilled-while-gated',
          ),
        false,
      );
      f.taggedFixture.releaseNewer();
      await pending[1];
      f.taggedFixture.release();
      await pending[0];
      const report = f.observer.finalize();
      assert(
        report.snapshots.some((row) => row.phase === 'gate-release-boundary'),
      );
      assert.equal(report.snapshots.length, 4);
      if (reason !== 'absent') {
        assert.equal(report.incomplete, true);
        assert.equal(report.controlledWitnessUnavailable, 1);
      }
      assert.equal(report.truncationReason, null);
    } finally {
      f.taggedFixture.restore();
      await Promise.allSettled(pending);
      f.observer.finalize();
    }
  });

async function runPresentationOrderingSource(input) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function assertPendingPresentationOrdering(');
  const end = source.indexOf(
    '\nasync function runPendingSourceDialogCase(',
    start,
  );
  assert(start >= 0 && end > start);
  const helper =
    await import('../electron/browser-profile-presentation-observer.mjs');
  const expect = (value, message) => ({
    toEqual: (wanted) =>
      assert.deepEqual(JSON.parse(JSON.stringify(value)), wanted, message),
    toBe: (wanted) => assert.equal(value, wanted, message),
  });
  const invocationStart = source.indexOf(
    '    orderingVerdict = verifyPresentationOrdering({',
  );
  const invocationEnd = source.indexOf(
    '\n    const clearWhileSwitching',
    invocationStart,
  );
  assert(invocationStart > end && invocationEnd > invocationStart);
  const context = {
    expect,
    verifyPresentationOrdering: helper.verifyPresentationOrdering,
    ...input,
    orderingRendererCheckpoints: input.rendererCheckpoints,
    presentationObserverHandle: {
      evaluate: (callback) =>
        callback({ freezeOrdering: () => input.observation }),
    },
  };
  return vm.runInNewContext(
    `(async () => { ${source.slice(start, end)}; let orderingVerdict; ${source.slice(invocationStart, invocationEnd)}; return orderingVerdict; })()`,
    context,
  );
}

async function presentationOrderingScenario({
  controlled = true,
  laterHide = true,
  preAHide = false,
  settlePreAHideBeforeB = false,
  arbitraryBError = false,
  duplicateHides = false,
  postCutoffPending = false,
  spontaneous = false,
  deferWitness = false,
  delayDeferredWitnessSettlement = false,
  hideChannel = 'visible',
  postBRejectedShow = false,
  beforeFreeze,
  afterFreeze,
} = {}) {
  const preAHideEntered = presentationDeferred();
  const preAHideGate = presentationDeferred();
  let holdPreAHide = preAHide;
  const postCutoffGate = presentationDeferred();
  let holdPostCutoff = false;
  const spontaneousGate = presentationDeferred();
  const witnessGate = presentationDeferred();
  const delayedWitnessGate = presentationDeferred();
  const postBShowEntered = presentationDeferred();
  const postBShowGate = presentationDeferred();
  let holdPostBShow = false;
  const f = await realTaggedPresentationFixture({
    controlledLaterHide: controlled,
    presentationRevision: true,
    arbitraryBError,
    afterAuthority: (request) => {
      if (!request.e2ePresentationInjectionId && holdPreAHide) {
        preAHideEntered.resolve();
        return preAHideGate.promise;
      }
      if (
        request.e2ePresentationInjectionId &&
        request.visible === false &&
        spontaneous
      )
        return spontaneousGate.promise;
      if (!request.e2ePresentationInjectionId && holdPostCutoff)
        return postCutoffGate.promise;
      if (
        !request.e2ePresentationInjectionId &&
        request.visible === true &&
        holdPostBShow
      ) {
        postBShowEntered.resolve();
        return postBShowGate.promise;
      }
      if (!request.e2ePresentationInjectionId && deferWitness)
        return (async () => {
          await witnessGate.promise;
          if (delayDeferredWitnessSettlement) await delayedWitnessGate.promise;
        })();
    },
  });
  const request = {
    browserId: 'browser-1',
    expectedRuntimeGeneration: 2,
    e2ePresentationInjectionId: 'injection-1',
  };
  const wrap = (promise) =>
    promise.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, message: String(error) }),
    );
  const pending = [];
  let deferredWitnessPromise = null;
  try {
    const preAHidePromise = preAHide
      ? wrap(
          f.invoke({
            browserId: 'browser-1',
            expectedRuntimeGeneration: 2,
            visible: false,
          }),
        )
      : null;
    if (preAHidePromise) {
      pending.push(preAHidePromise);
      await preAHideEntered.promise;
      holdPreAHide = false;
    }
    const earlierPromise = wrap(
      f.invoke(
        { ...request, bounds: f.target.bounds, visible: true },
        'bounds',
      ),
    );
    pending.push(earlierPromise);
    await f.taggedFixture.waitForGate();
    let preAHideSettlement = null;
    if (preAHidePromise && settlePreAHideBeforeB) {
      preAHideGate.resolve();
      preAHideSettlement = await preAHidePromise;
    }
    const newerPromise = wrap(f.invoke({ ...request, visible: false }));
    pending.push(newerPromise);
    if (controlled) {
      await f.taggedFixture.waitForNewerGate();
      f.observer.noteControlledTrigger();
      if (laterHide) {
        const hide = () =>
          f.invoke(
            {
              browserId: 'browser-1',
              expectedRuntimeGeneration: 2,
              visible: false,
              ...(hideChannel === 'bounds' ? { bounds: f.target.bounds } : {}),
            },
            hideChannel,
          );
        if (deferWitness) {
          deferredWitnessPromise = wrap(hide());
          pending.push(deferredWitnessPromise);
          await new Promise(setImmediate);
        } else if (duplicateHides)
          await Promise.allSettled([hide(), hide(), hide()]);
        else await hide();
      }
      f.taggedFixture.releaseNewer();
    }
    if (spontaneous) {
      await new Promise(setImmediate);
      await f.invoke({
        browserId: 'browser-1',
        expectedRuntimeGeneration: 2,
        visible: false,
      });
      spontaneousGate.resolve();
    }
    const newerSettlement = await newerPromise;
    let postBShowSettlement = null;
    let postBHideSettlement = null;
    if (postBRejectedShow) {
      holdPostBShow = true;
      const showPromise = wrap(
        f.invoke(
          {
            browserId: 'browser-1',
            expectedRuntimeGeneration: 2,
            bounds: f.target.bounds,
            visible: true,
          },
          'bounds',
        ),
      );
      pending.push(showPromise);
      await postBShowEntered.promise;
      holdPostBShow = false;
      const hidePromise = wrap(
        f.invoke({
          browserId: 'browser-1',
          expectedRuntimeGeneration: 2,
          visible: false,
        }),
      );
      pending.push(hidePromise);
      postBHideSettlement = await hidePromise;
      postBShowGate.resolve();
      postBShowSettlement = await showPromise;
    }
    preAHideGate.resolve();
    if (preAHidePromise && !preAHideSettlement)
      preAHideSettlement = await preAHidePromise;
    const beforeRelease = f.taggedFixture.snapshot();
    if (postCutoffPending) {
      holdPostCutoff = true;
      pending.push(
        wrap(
          f.invoke({
            browserId: 'browser-1',
            expectedRuntimeGeneration: 2,
            visible: false,
          }),
        ),
      );
      await new Promise(setImmediate);
    }
    f.taggedFixture.release();
    const earlierSettlement = await earlierPromise;
    witnessGate.resolve();
    if (deferWitness && delayDeferredWitnessSettlement)
      setImmediate(() => delayedWitnessGate.resolve());
    if (deferredWitnessPromise) await deferredWitnessPromise;
    const afterRelease = f.taggedFixture.snapshot();
    await beforeFreeze?.(f);
    const observation = f.observer.freezeOrdering();
    const input = {
      observation,
      beforeRelease,
      afterRelease,
      newerSettlement,
      earlierSettlement,
      preAHideSettlement,
      postBShowSettlement,
      postBHideSettlement,
      controlledLaterHide: controlled,
      rendererCheckpoints: [
        'B-terminal-before-A-release',
        'A-rejected-same-dialog-still-usable',
      ].map((phase, index) => ({
        phase,
        time: index + 1,
        modalVisible: true,
        stayEnabled: true,
        leaveEnabled: true,
        browserBounds: { width: 640, height: 400 },
      })),
    };
    await afterFreeze?.(f);
    return { input: JSON.parse(JSON.stringify(input)), f };
  } finally {
    preAHideGate.resolve();
    postCutoffGate.resolve();
    spontaneousGate.resolve();
    witnessGate.resolve();
    delayedWitnessGate.resolve();
    postBShowGate.resolve();
    f.taggedFixture.restore();
    await Promise.allSettled(pending);
    f.observer.finalize();
  }
}

test('presentation ordering admits an exact post-B show rejected before application only with its later fulfilled hide', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
    postBRejectedShow: true,
  });
  assert.equal(input.newerSettlement.ok, true);
  assert.deepEqual(input.postBShowSettlement, {
    ok: false,
    message: 'Error: A newer presentation request replaced this command.',
  });
  assert.deepEqual(input.postBHideSettlement, { ok: true });
  const postCutoff = input.observation.calls.filter(
    (row) => row.postCutoff === true,
  );
  assert.deepEqual(
    postCutoff.map((row) => [row.channel, row.visible, row.state]),
    [
      ['bounds', true, 'rejected'],
      ['visible', false, 'fulfilled'],
    ],
  );
  const verdict = await runPresentationOrderingSource(input);
  assert.equal(verdict.branch, 'latest-B');
  assert.deepEqual(Array.from(verdict.candidateCallIds), []);
  assert.deepEqual(Array.from(verdict.witnessCallIds), []);
});

for (const [name, mutate] of [
  [
    'fulfilled show',
    (input, show) => {
      show.state = 'fulfilled';
      delete show.error;
    },
  ],
  [
    'pending show',
    (input, show) => {
      show.state = 'pending';
      delete show.error;
      delete show.settleTime;
    },
  ],
  [
    'arbitrary show rejection',
    (input, show) => {
      show.error = { code: 'permission_denied', supersession: false };
    },
  ],
  [
    'stale show generation',
    (input, show) => {
      show.generationStatus = 'stale';
      show.suppliedGeneration++;
    },
  ],
  [
    'foreign show owner',
    (input, show) => {
      show.ownerSender = false;
      show.senderId++;
    },
  ],
  [
    'missing later hide',
    (input, show, hide) => {
      input.observation.calls.pop();
      input.observation.entryCount--;
      input.observation.events = input.observation.events.filter(
        (event) => event.callId !== hide.id,
      );
    },
  ],
  [
    'later hide entered after rejection',
    (input, show, hide) => {
      hide.enterTime = show.settleTime + 1;
    },
  ],
  [
    'later pending hide',
    (input, show, hide) => {
      hide.state = 'pending';
      delete hide.settleTime;
    },
  ],
  [
    'later failed hide',
    (input, show, hide) => {
      hide.state = 'rejected';
      hide.error = { code: 'permission_denied', supersession: false };
    },
  ],
  [
    'incomplete observation',
    (input) => {
      input.observation.observationGap = true;
      input.observation.notificationGaps = 1;
    },
  ],
  [
    'show entered before B fulfilled',
    (input, show) => {
      const b = input.observation.calls.find((row) => row.class === 'B');
      show.enterTime = b.settleTime - 1;
    },
  ],
  [
    'rejected B',
    (input) => {
      const b = input.observation.calls.find((row) => row.class === 'B');
      b.state = 'rejected';
      b.error = { code: 'operation_conflict', supersession: true };
      input.observation.snapshots[0].phase = 'B-rejection-observed';
      input.newerSettlement = {
        ok: false,
        message: 'A newer presentation request replaced this command.',
      };
      for (const state of [input.beforeRelease, input.afterRelease]) {
        state.newerCompleted = false;
        state.newerErrorCode = 'operation_conflict';
      }
    },
  ],
])
  test(`presentation ordering rejects post-B rejected-before-application allowance with ${name}`, async () => {
    const { input } = await presentationOrderingScenario({
      controlled: false,
      laterHide: false,
      postBRejectedShow: true,
    });
    const [show, hide] = input.observation.calls.filter(
      (row) => row.postCutoff === true,
    );
    mutate(input, show, hide);
    await assert.rejects(runPresentationOrderingSource(input));
  });

test('presentation ordering shared source oracle accepts legitimate authorized later-hide supersession', async () => {
  const { input } = await presentationOrderingScenario();
  assert.equal(input.newerSettlement.ok, false);
  assert.equal(input.beforeRelease.newerCompleted, false);
  const b = input.observation.calls.find((row) => row.class === 'B');
  assert.deepEqual(b.error, { code: 'operation_conflict', supersession: true });
  assert.equal(
    input.observation.calls.find((row) => row.class === 'untagged').state,
    'fulfilled',
  );
  const verdict = await runPresentationOrderingSource(input);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.branch, 'superseded-by-valid-later-hide');
});

test('presentation ordering preserves latest-B success through the actual spec invocation', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
  });
  const verdict = await runPresentationOrderingSource(input);
  assert.equal(verdict.branch, 'latest-B');
  assert.equal(input.beforeRelease.newerCompletedBeforeRelease, true);
  assert.equal(input.beforeRelease.earlierSettled, false);
});

test('presentation ordering accepts a fulfilled tagged B as settlement for an earlier authorized superseded hide', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
    preAHide: true,
  });
  assert.deepEqual(input.preAHideSettlement, {
    ok: false,
    message: 'Error: A newer presentation request replaced this command.',
  });
  assert.equal(input.newerSettlement.ok, true);
  assert.equal(input.beforeRelease.newerCompletedBeforeRelease, true);
  assert.equal(input.beforeRelease.earlierSettled, false);
  assert.deepEqual(
    Array.from(input.observation.calls, (row) => row.class),
    ['untagged', 'A', 'B'],
  );
  assert.deepEqual(input.observation.calls[0].error, {
    code: 'operation_conflict',
    supersession: true,
  });
  assert.equal(input.observation.calls[0].state, 'rejected');
  assert.equal(input.observation.calls[2].state, 'fulfilled');

  const verdict = await runPresentationOrderingSource(input);
  assert.equal(verdict.branch, 'latest-B');
  assert.deepEqual(Array.from(verdict.candidateCallIds), []);
  assert.deepEqual(Array.from(verdict.witnessCallIds), []);
});

for (const [name, mutate, reason] of [
  [
    'pre-A show',
    (i) => {
      i.observation.calls[0].visible = true;
    },
    'only-authorized-current-runtime-hide-candidates',
  ],
  [
    'pre-A unknown tag',
    (i) => {
      i.observation.calls[0].class = 'other-tag';
    },
    'only-authorized-current-runtime-hide-candidates',
  ],
  [
    'pre-A wrong owner',
    (i) => {
      i.observation.calls[0].senderId++;
    },
    'only-authorized-current-runtime-hide-candidates',
  ],
  [
    'pre-A wrong generation',
    (i) => {
      i.observation.calls[0].suppliedGeneration++;
    },
    'only-authorized-current-runtime-hide-candidates',
  ],
  [
    'pre-A missing owner admission',
    (i) => {
      i.observation.events = i.observation.events.filter(
        (event) => !(event.callId === 1 && event.phase === 'owner-read-owner'),
      );
    },
    'only-authorized-current-runtime-hide-candidates',
  ],
  [
    'pre-A generic conflict',
    (i) => {
      i.observation.calls[0].error.supersession = false;
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
  [
    'pre-A arbitrary rejection',
    (i) => {
      i.observation.calls[0].error = {
        code: 'permission_denied',
        supersession: false,
      };
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
  [
    'B missing renderer fulfillment',
    (i) => {
      i.newerSettlement.ok = false;
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
  [
    'B missing completion',
    (i) => {
      i.beforeRelease.newerCompleted = false;
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
  [
    'B fulfillment after A release',
    (i) => {
      const release = i.observation.events.find(
        (event) => event.phase === 'gate-release-requested',
      );
      const final = i.observation.snapshots.find(
        (snapshot) => snapshot.phase === 'final-ordering',
      );
      i.observation.calls[2].settleTime = (release.time + final.time) / 2;
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
  [
    'B wrong owner',
    (i) => {
      i.observation.calls[2].senderId++;
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
  [
    'B wrong generation',
    (i) => {
      i.observation.calls[2].suppliedGeneration++;
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
  [
    'B missing owner admission',
    (i) => {
      i.observation.events = i.observation.events.filter(
        (event) => !(event.callId === 3 && event.phase === 'owner-read-owner'),
      );
    },
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  ],
])
  test(`presentation ordering pre-A settlement rejects ${name}`, async () => {
    const { input } = await presentationOrderingScenario({
      controlled: false,
      laterHide: false,
      preAHide: true,
    });
    mutate(input);
    await assert.rejects(
      runPresentationOrderingSource(input),
      new RegExp(reason),
    );
  });

test('presentation ordering rejects B as a pre-A terminator when B enters after the earlier hide rejects', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
    preAHide: true,
    settlePreAHideBeforeB: true,
  });
  assert(
    input.observation.calls[0].settleTime <
      input.observation.calls[2].enterTime,
  );
  await assert.rejects(
    runPresentationOrderingSource(input),
    /safe-hide-settlements-or-authorized-pending-post-cutoff/,
  );
});

test('presentation ordering rejects arbitrary B even when an earlier authorized hide was superseded', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
    preAHide: true,
    arbitraryBError: true,
  });
  assert.equal(input.observation.calls[2].error.code, 'e2e_arbitrary_B_error');
  await assert.rejects(
    runPresentationOrderingSource(input),
    /safe-hide-settlements-or-authorized-pending-post-cutoff/,
  );
});

test('presentation ordering rejects superseded B without an after-B witness even when a pre-A hide exists', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
    preAHide: true,
  });
  input.observation.calls[2].state = 'rejected';
  input.observation.calls[2].error = {
    code: 'operation_conflict',
    supersession: true,
  };
  input.observation.snapshots[0].phase = 'B-rejection-observed';
  input.newerSettlement = {
    ok: false,
    message: 'A newer presentation request replaced this command.',
  };
  for (const state of [input.beforeRelease, input.afterRelease]) {
    state.newerCompleted = false;
    state.newerErrorCode = 'operation_conflict';
  }
  await assert.rejects(
    runPresentationOrderingSource(input),
    /positive-authorized-pre-terminal-hide-witness/,
  );
});

test('presentation ordering keeps a pre-A hide outside the witness set for a valid after-B hide', async () => {
  const { input } = await presentationOrderingScenario({ preAHide: true });
  const verdict = await runPresentationOrderingSource(input);
  assert.equal(verdict.branch, 'superseded-by-valid-later-hide');
  assert.deepEqual(Array.from(verdict.candidateCallIds), [4]);
  assert.deepEqual(Array.from(verdict.witnessCallIds), [4]);
  assert.equal(verdict.evidence.observation.calls[0].class, 'untagged');
});

test('presentation ordering awaits a delayed deferred witness when a pre-A hide shifts pending order', async () => {
  const { input } = await presentationOrderingScenario({
    preAHide: true,
    deferWitness: true,
    delayDeferredWitnessSettlement: true,
  });
  input.controlledLaterHide = false;
  const verdict = await runPresentationOrderingSource(input);
  assert.equal(verdict.branch, 'superseded-by-valid-later-hide');
  assert.deepEqual(Array.from(verdict.candidateCallIds), [4]);
  assert.deepEqual(Array.from(verdict.witnessCallIds), [4]);
  assert.equal(verdict.evidence.observation.calls[3].state, 'fulfilled');
});

test('presentation ordering accepts equivalent authorized duplicate-hide supersession chains', async () => {
  const { input } = await presentationOrderingScenario({
    duplicateHides: true,
  });
  const verdict = await runPresentationOrderingSource(input);
  assert.deepEqual(Array.from(verdict.candidateCallIds), [3, 4, 5]);
  assert.deepEqual(Array.from(verdict.witnessCallIds), [5]);
  assert.equal(input.observation.calls[2].error.supersession, true);
  assert.equal(input.observation.calls[3].error.supersession, true);
});

test('presentation ordering pending post-cutoff safe hide is recorded but never a witness or settled claim', async () => {
  const { input } = await presentationOrderingScenario({
    postCutoffPending: true,
  });
  const verdict = await runPresentationOrderingSource(input);
  assert.deepEqual(Array.from(verdict.witnessCallIds), [3]);
  assert.deepEqual(Array.from(verdict.postCutoffCallIds), [4]);
  assert.equal(verdict.evidence.observation.calls[3].state, 'pending');
});

test('presentation ordering arbitrary-B calibration applies only after the real delegate fulfills exactly once and fails the shared oracle', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
    arbitraryBError: true,
  });
  assert.deepEqual(input.afterRelease.arbitraryBError, {
    enabled: true,
    originalDelegateInvocations: 1,
    originalDelegateFulfilled: true,
    applied: true,
    notAppliedReason: null,
  });
  assert.equal(input.observation.calls[1].error.code, 'e2e_arbitrary_B_error');
  await assert.rejects(
    runPresentationOrderingSource(input),
    /B-exact-structured-supersession/,
  );
});

test('presentation ordering arbitrary-B calibration preserves an earlier original rejection and records fault not applied', async () => {
  const { input } = await presentationOrderingScenario({
    arbitraryBError: true,
  });
  assert.deepEqual(input.afterRelease.arbitraryBError, {
    enabled: true,
    originalDelegateInvocations: 1,
    originalDelegateFulfilled: false,
    applied: false,
    notAppliedReason: 'delegate-not-fulfilled',
  });
  assert.equal(
    (await runPresentationOrderingSource(input)).branch,
    'superseded-by-valid-later-hide',
  );
});

const presentationOrderingMutations = [
  [
    'generic operation conflict',
    (i) => {
      i.observation.calls[1].error.supersession = false;
    },
    'B-exact-structured-supersession',
  ],
  [
    'wrong error code',
    (i) => {
      i.observation.calls[1].error.code = 'permission_denied';
    },
    'B-exact-structured-supersession',
  ],
  [
    'missing structured error despite renderer text',
    (i) => {
      delete i.observation.calls[1].error;
    },
    'B-exact-structured-supersession',
  ],
  [
    'arbitrary applied fault even with safe C',
    (i) => {
      i.observation.calls[1].error = {
        code: 'e2e_arbitrary_B_error',
        supersession: false,
      };
    },
    'B-exact-structured-supersession',
  ],
  [
    'duplicate tagged B',
    (i) => {
      i.observation.calls[2].class = 'B';
    },
    'exact-single-tagged-A-B',
  ],
  [
    'B wrong runtime',
    (i) => {
      i.observation.calls[1].suppliedGeneration++;
    },
    'tagged-request-identity',
  ],
  [
    'wrong owner',
    (i) => {
      i.observation.calls[2].senderId++;
    },
    'only-authorized',
  ],
  [
    'wrong generation',
    (i) => {
      i.observation.calls[2].suppliedGeneration++;
    },
    'only-authorized',
  ],
  [
    'unknown candidate',
    (i) => {
      i.observation.calls[2].class = 'other-tag';
    },
    'only-authorized',
  ],
  [
    'mixed show',
    (i) => {
      i.observation.calls[2].visible = true;
    },
    'only-authorized',
  ],
  [
    'unobserved owner admission',
    (i) => {
      i.observation.events = i.observation.events.filter(
        (e) => !(e.callId === 3 && e.phase === 'owner-read-owner'),
      );
    },
    'only-authorized',
  ],
  [
    'owner admission after B terminal',
    (i) => {
      i.observation.events.find(
        (e) => e.callId === 3 && e.phase === 'owner-read-owner',
      ).ordinal = i.observation.snapshots.at(-1).ordinal;
    },
    'positive-authorized',
  ],
  [
    'C other rejection',
    (i) => {
      Object.assign(i.observation.calls[2], {
        state: 'rejected',
        error: { code: 'other', supersession: false },
      });
    },
    'positive-authorized',
  ],
  [
    'C pending finite cohort',
    (i) => {
      i.observation.calls[2].state = 'pending';
    },
    'finite-cohort-settled',
  ],
  [
    'no fulfilled witness',
    (i) => {
      Object.assign(i.observation.calls[2], {
        state: 'rejected',
        error: { code: 'operation_conflict', supersession: true },
      });
    },
    'positive-authorized',
  ],
  [
    'native visible',
    (i) => {
      i.observation.snapshots.at(-1).state.native.visible = true;
    },
    'safe-native-dialog',
  ],
  [
    'cached native visible',
    (i) => {
      i.observation.snapshots.at(-1).state.session.cachedVisible = true;
    },
    'safe-native-dialog',
  ],
  [
    'unavailable final snapshot',
    (i) => {
      i.observation.snapshots.at(-1).state = { status: 'unavailable' };
    },
    'safe-native-dialog',
  ],
  [
    'different final dialog',
    (i) => {
      i.observation.snapshots.at(-1).state.session.dialogId = 'other-dialog';
    },
    'safe-native-dialog',
  ],
  [
    'different native view even if session agrees',
    (i) => {
      i.observation.snapshots.at(-1).state.session.webContentsId++;
      i.observation.snapshots.at(-1).state.native.webContentsId++;
    },
    'safe-native-dialog',
  ],
  [
    'runtime changed inside critical interval',
    (i) => {
      i.observation.snapshots.at(-1).state.session.runtimeGeneration++;
    },
    'safe-native-dialog',
  ],
  [
    'critical notification gap',
    (i) => {
      i.observation.notificationGaps++;
    },
    'complete-critical',
  ],
  [
    'critical detach',
    (i) => {
      i.observation.observationGap = true;
    },
    'complete-critical',
  ],
  [
    'truncated admission',
    (i) => {
      i.observation.droppedCalls++;
    },
    'complete-critical',
  ],
  [
    'missing snapshot admission',
    (i) => {
      i.observation.snapshots[1].completeAdmissionCoverage = false;
    },
    'safe-native-dialog',
  ],
  [
    'A succeeded',
    (i) => {
      i.observation.calls[0].state = 'fulfilled';
    },
    'A-exact-stale',
  ],
  [
    'A generic conflict',
    (i) => {
      i.observation.calls[0].error.supersession = false;
    },
    'A-exact-stale',
  ],
  [
    'A released before B',
    (i) => {
      i.beforeRelease.released = true;
    },
    'A-exact-stale',
  ],
  [
    'unusable Stay',
    (i) => {
      i.rendererCheckpoints[1].stayEnabled = false;
    },
    'usable-renderer-controls',
  ],
  [
    'unusable Leave',
    (i) => {
      i.rendererCheckpoints[1].leaveEnabled = false;
    },
    'usable-renderer-controls',
  ],
  [
    'missing final checkpoint',
    (i) => {
      i.observation.snapshots.pop();
    },
    'terminal-release-final',
  ],
];
for (const [name, mutate, reason] of presentationOrderingMutations)
  test(`presentation ordering rejects ${name}`, async () => {
    const { input } = await presentationOrderingScenario();
    mutate(input);
    await assert.rejects(
      runPresentationOrderingSource(input),
      new RegExp(reason),
    );
  });

for (const [name, mutate] of [
  [
    'completion flag lost',
    (i) => {
      i.beforeRelease.newerCompleted = false;
    },
  ],
  [
    'completion after release',
    (i) => {
      i.beforeRelease.newerCompletedBeforeRelease = false;
    },
  ],
  [
    'A was already settled',
    (i) => {
      i.beforeRelease.earlierSettled = true;
    },
  ],
  [
    'missing renderer success',
    (i) => {
      i.newerSettlement.ok = false;
    },
  ],
])
  test(`presentation ordering latest-B rejects ${name}`, async () => {
    const { input } = await presentationOrderingScenario({
      controlled: false,
      laterHide: false,
    });
    mutate(input);
    await assert.rejects(runPresentationOrderingSource(input));
  });

test('presentation ordering frozen critical evidence survives later runtime changes and deliberate detach', async () => {
  const { input, f } = await presentationOrderingScenario({
    afterFreeze: async (fixture) => {
      fixture.observer.noteGap();
      fixture.observer.detach();
    },
  });
  assert.equal(f.observer.report().observationGap, true);
  assert.equal(f.observer.report().notificationGaps, 1);
  const verdict = await runPresentationOrderingSource(input);
  assert.equal(verdict.ok, true);
  input.observation.snapshots.at(-1).state.session.runtimeGeneration++;
  assert.equal(
    verdict.evidence.observation.snapshots.at(-1).state.session
      .runtimeGeneration,
    2,
  );
  assert(Object.isFrozen(verdict.evidence.observation.calls));
});

test('presentation ordering actual critical ownership conflict fails and cleanup preserves foreign replacement', async () => {
  const replacement = () => 'foreign';
  const { input, f } = await presentationOrderingScenario({
    beforeFreeze: (fixture) =>
      fixture.bindings.set('browser:set-visible', replacement),
  });
  await assert.rejects(
    runPresentationOrderingSource(input),
    /complete-critical/,
  );
  assert.equal(f.bindings.get('browser:set-visible'), replacement);
  assert.equal(f.fakeFs.readFile, f.originalRead);
  assert.equal(f.taggedFixture.snapshot().released, true);
});

for (const mutate of [
  (row) => {
    row.visible = true;
  },
  (row) => {
    row.suppliedGeneration++;
  },
  (row) => {
    row.reads.owner = 0;
  },
])
  test('presentation ordering unresolved post-cutoff show or identity fails qualification', async () => {
    const { input } = await presentationOrderingScenario({
      postCutoffPending: true,
    });
    mutate(input.observation.calls.at(-1));
    await assert.rejects(
      runPresentationOrderingSource(input),
      /post-cutoff-intent-known/,
    );
  });

test('presentation ordering original flow also admits spontaneous later-hide supersession', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    spontaneous: true,
  });
  assert.equal(
    (await runPresentationOrderingSource(input)).branch,
    'superseded-by-valid-later-hide',
  );
});

test('presentation ordering finite pending witness can settle after B terminal and A release', async () => {
  const { input } = await presentationOrderingScenario({ deferWitness: true });
  // This models the original spontaneous branch, which does not require a C
  // fulfillment while B is held. Its finite cohort is fixed at B terminal.
  input.controlledLaterHide = false;
  assert(
    input.observation.calls[2].settleTime >
      input.observation.calls[1].settleTime,
  );
  assert.equal(
    (await runPresentationOrderingSource(input)).branch,
    'superseded-by-valid-later-hide',
  );
});

test('presentation ordering exact supersession without any later witness fails', async () => {
  const { input } = await presentationOrderingScenario({
    controlled: false,
    laterHide: false,
  });
  input.observation.calls[1].state = 'rejected';
  input.observation.calls[1].error = {
    code: 'operation_conflict',
    supersession: true,
  };
  input.observation.snapshots[0].phase = 'B-rejection-observed';
  input.newerSettlement = {
    ok: false,
    message: 'A newer presentation request replaced this command.',
  };
  for (const state of [input.beforeRelease, input.afterRelease]) {
    state.newerCompleted = false;
    state.newerErrorCode = 'operation_conflict';
  }
  await assert.rejects(
    runPresentationOrderingSource(input),
    /positive-authorized-pre-terminal-hide-witness/,
  );
});

test('presentation ordering accepts an authorized literal-hide bounds request through its original handler', async () => {
  const { input } = await presentationOrderingScenario({
    hideChannel: 'bounds',
  });
  assert.equal(
    (await runPresentationOrderingSource(input)).branch,
    'superseded-by-valid-later-hide',
  );
});

test('presentation ordering native calibration selector stays off for normal and controlled cases', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf(
    '  const arbitraryBError =',
    source.indexOf('async function runPendingSourceDialogCase('),
  );
  const end = source.indexOf(';', start);
  const evaluate = (env, controlledLaterHide) =>
    vm.runInNewContext(`${source.slice(start, end + 1)} arbitraryBError`, {
      process: { env },
      controlledLaterHide,
    });
  assert.equal(evaluate({}, false), false);
  assert.equal(
    evaluate({ CANOPY_E2E_PRESENTATION_ARBITRARY_B_ERROR: 'true' }, false),
    false,
  );
  assert.equal(
    evaluate(
      {
        CANOPY_E2E_PRESENTATION_ARBITRARY_B_ERROR: 'after-original-fulfillment',
      },
      true,
    ),
    false,
  );
  assert.equal(
    evaluate(
      {
        CANOPY_E2E_PRESENTATION_ARBITRARY_B_ERROR: 'after-original-fulfillment',
      },
      false,
    ),
    true,
  );
});

async function runRegisteredProductSiteClearSetupFailure({
  seedFailure,
  productFailure,
  ownerCleanupFailure,
  readinessScenario,
  attachmentFailure,
} = {}) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf(
    "test('product site clear verifies partitioned contexts and expanded cookies without clearing their top-level sites'",
  );
  const end = source.indexOf("\ntest('retirement stops Task workers", start);
  assert(start >= 0 && end > start);

  const callbacks = new Map();
  const events = [];
  const attachments = [];
  const test = (name, callback) => callbacks.set(name, callback);
  test.setTimeout = (timeout) => assert.equal(timeout, 120_000);
  test.info = () => ({
    attach: async (name, attachment) => {
      events.push('readiness-attachment');
      if (attachmentFailure) throw attachmentFailure;
      attachments.push({
        name,
        contentType: attachment.contentType,
        body: JSON.parse(attachment.body.toString()),
      });
    },
  });
  const server = {
    listening: false,
    listen(_port, _host, callback) {
      this.listening = true;
      events.push('server-listen');
      callback();
    },
    address() {
      return { port: 4444 };
    },
    closeAllConnections() {
      events.push('server-close-all-connections');
    },
    close(callback) {
      this.listening = false;
      events.push('server-close');
      callback();
    },
  };
  const expectedState = {
    local: null,
    databases: 0,
    caches: 0,
    files: 0,
  };
  let pollValue;
  let contextEvaluations = 0;
  const content = (url, id, frames = []) => ({
    id,
    getURL: () => url,
    isLoading: () => false,
    isDestroyed: () => false,
    mainFrame: {
      url,
      framesInSubtree: frames,
      executeJavaScript: async () => ({ ...expectedState }),
    },
    executeJavaScript: async () => ({ ...expectedState }),
  });
  const electronApp = {
    evaluate: async (fn, input) => {
      const text = fn.toString();
      if (text.includes('setCertificateVerifyProc')) return undefined;
      if (!text.includes('getAllWebContents')) return undefined;
      contextEvaluations += 1;
      if (contextEvaluations > 1) throw productFailure;
      const child = {
        url: `${input.embedded}/frame`,
        executeJavaScript: async () => ({ ...expectedState }),
      };
      const all = [
        content(
          `${input.tops[0]}/`,
          1,
          readinessScenario === 'missing-frame' ? [] : [child],
        ),
        content(`${input.tops[1]}/`, 2, [child]),
        content(`${input.embedded}/`, 3),
        content(`${input.sibling}/`, 4),
      ];
      if (readinessScenario === 'missing-top-level') all.splice(1, 1);
      if (readinessScenario === 'missing-top-level')
        all.unshift(
          ...Array.from({ length: 24 }, (_, index) =>
            content(
              `${input.tops[0]}/${'x'.repeat(800)}?candidate=${index}`,
              100 + index,
            ),
          ),
        );
      if (readinessScenario === 'unrelated-before-wrong-url') {
        all.splice(1, 1);
        all.unshift(
          ...Array.from({ length: 20 }, (_, index) =>
            content(`devtools://unrelated-${index}/`, 200 + index),
          ),
          content(`${input.tops[1]}/still-loading`, 777),
        );
      }
      return fn({ webContents: { getAllWebContents: () => all } }, input);
    },
  };
  let tab = 0;
  const owner = {
    electronApp,
    userDataDir: '/owned',
    window: {
      evaluate: async (fn) => {
        if (!readinessScenario) throw productFailure;
        const text = fn.toString();
        if (text.includes('profiles.create')) return { profileId: 'profile' };
        if (text.includes('browser.create')) return { id: `tab-${++tab}` };
        if (text.includes('browser.navigate')) return undefined;
        throw new Error(`Unexpected window evaluation: ${text}`);
      },
    },
  };
  const readinessError = new Error('controlled readiness poll failure');
  const expect = () => {
    throw new Error('Unexpected product assertion');
  };
  expect.poll = (callback) => ({
    async toEqual(expected) {
      pollValue = await callback();
      if (JSON.stringify(pollValue) !== JSON.stringify(expected))
        throw readinessError;
    },
  });
  const ts = require('typescript');
  const js = ts.transpileModule(
    source
      .slice(start, end)
      .replaceAll(
        'import.meta.url',
        "'file:///fixture/browser-profiles.spec.mjs'",
      ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  vm.runInNewContext(js, {
    test,
    require: (name) => {
      if (name === 'node:https') return { createServer: () => server };
      if (name === 'node:fs/promises')
        return { readFile: async () => Buffer.from('fixture certificate') };
      throw new Error(`Unexpected import ${name}`);
    },
    seedPanelWorktree: async () => {
      events.push('seed-panel-worktree');
      if (seedFailure) throw seedFailure;
      return owner;
    },
    closeCanopy: async (app, userDataDir) => {
      assert.equal(app, owner.electronApp);
      assert.equal(userDataDir, owner.userDataDir);
      events.push('owner-close');
      if (ownerCleanupFailure) throw ownerCleanupFailure;
    },
    expect,
    boundedCleanupErrorMessage: (error) =>
      String(error?.message ?? error).slice(0, 4096),
    URL,
    Buffer,
    console: {
      error: (...args) => {
        if (args[0] === 'Product site-clear readiness attachment failed:')
          events.push(['console-error', ...args]);
      },
    },
  });
  const callback = callbacks.get(
    'product site clear verifies partitioned contexts and expanded cookies without clearing their top-level sites',
  );
  assert.equal(typeof callback, 'function');
  const primary =
    seedFailure ??
    (readinessScenario && readinessScenario !== 'ready'
      ? readinessError
      : productFailure);
  await assert.rejects(callback(), (error) => error === primary);
  return { attachments, events, pollValue, server, primary };
}

test('registered product site-clear callback closes its listening HTTPS server when panel setup rejects', async () => {
  const primary = new Error('panel setup failed');
  const { events, server } = await runRegisteredProductSiteClearSetupFailure({
    seedFailure: primary,
  });
  assert.equal(server.listening, false);
  assert.deepEqual(events, [
    'server-listen',
    'seed-panel-worktree',
    'server-close-all-connections',
    'server-close',
  ]);
});

test('registered product site-clear callback preserves its product failure and closes the server after owner cleanup rejects', async () => {
  const productFailure = new Error('product setup failed');
  const ownerCleanupFailure = new Error('owner cleanup failed');
  const { events, server } = await runRegisteredProductSiteClearSetupFailure({
    productFailure,
    ownerCleanupFailure,
  });
  assert.equal(server.listening, false);
  assert.deepEqual(events, [
    'server-listen',
    'seed-panel-worktree',
    'owner-close',
    'server-close-all-connections',
    'server-close',
  ]);
});

test('registered product site-clear callback attaches distinct bounded top-level readiness failure before cleanup', async () => {
  const value = await runRegisteredProductSiteClearSetupFailure({
    productFailure: new Error('stop after readiness'),
    readinessScenario: 'missing-top-level',
  });
  assert.equal(value.attachments.length, 1);
  const snapshot = value.attachments[0].body.lastReadinessSnapshot;
  assert.equal(snapshot.expectedUrlRoles[1].role, 'second-top-level');
  assert.equal(snapshot.expectedUrlRoles[1].exactContentsExists, false);
  assert.equal(snapshot.expectedUrlRoles[0].exactContentsExists, true);
  assert.equal(snapshot.expectedUrlRoles[0].expectedFrameExists, true);
  assert.equal(snapshot.observedContents.length, snapshot.limits.maxContents);
  assert.equal(snapshot.droppedRelevantContents, 11);
  assert.equal(snapshot.contentsTruncated, true);
  assert.ok(
    snapshot.observedContents.every(
      (contents) =>
        contents.actualUrl.length <= snapshot.limits.maxStringLength,
    ),
  );
  assert.ok(snapshot.truncatedStrings > 0);
  assert.ok(
    value.events.indexOf('readiness-attachment') <
      value.events.indexOf('owner-close'),
  );
});

test('registered product site-clear callback distinguishes a missing child frame while the same poll fails', async () => {
  const value = await runRegisteredProductSiteClearSetupFailure({
    productFailure: new Error('stop after readiness'),
    readinessScenario: 'missing-frame',
  });
  assert.equal(value.attachments.length, 1);
  const snapshot = value.attachments[0].body.lastReadinessSnapshot;
  assert.equal(snapshot.expectedUrlRoles[0].exactContentsExists, true);
  assert.equal(snapshot.expectedUrlRoles[0].expectedFrameExists, false);
  assert.equal(snapshot.expectedUrlRoles[1].expectedFrameExists, true);
});

test('registered product site-clear callback retains a late relevant wrong URL after unrelated contents', async () => {
  const value = await runRegisteredProductSiteClearSetupFailure({
    productFailure: new Error('stop after readiness'),
    readinessScenario: 'unrelated-before-wrong-url',
  });
  assert.equal(value.attachments.length, 1);
  const snapshot = value.attachments[0].body.lastReadinessSnapshot;
  assert.equal(snapshot.expectedUrlRoles[1].exactContentsExists, false);
  assert.deepEqual(
    snapshot.observedContents.find((contents) => contents.id === 777),
    {
      id: 777,
      actualUrl: 'https://second.localhost:4444/still-loading',
      loading: false,
      destroyed: false,
    },
  );
  assert.equal(snapshot.droppedRelevantContents, 0);
  assert.equal(snapshot.contentsTruncated, false);
  assert.ok(
    value.events.indexOf('readiness-attachment') <
      value.events.indexOf('owner-close'),
  );
});

test('registered product site-clear callback keeps successful readiness arrays and does not attach', async () => {
  const value = await runRegisteredProductSiteClearSetupFailure({
    productFailure: new Error('controlled stop after readiness'),
    readinessScenario: 'ready',
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(value.pollValue)),
    Array.from({ length: 6 }, () => ({
      local: null,
      databases: 0,
      caches: 0,
      files: 0,
    })),
  );
  assert.equal(value.attachments.length, 0);
});

test('registered product site-clear callback preserves readiness error and cleanup ordering when attachment fails', async () => {
  const attachmentFailure = new Error('x'.repeat(5000));
  const value = await runRegisteredProductSiteClearSetupFailure({
    productFailure: new Error('stop after readiness'),
    readinessScenario: 'missing-frame',
    attachmentFailure,
  });
  assert.equal(value.attachments.length, 0);
  const diagnostic = value.events.find(
    (event) => Array.isArray(event) && event[0] === 'console-error',
  );
  assert.ok(diagnostic);
  assert.ok(diagnostic.join(' ').length < 4300);
  assert.ok(
    value.events.indexOf(diagnostic) < value.events.indexOf('owner-close'),
  );
});

for (const diagnosticError of [undefined, new Error('capture failed')])
  test(`c192 loaded worktree seed failure retains diagnostic and owned cleanup (${Boolean(diagnosticError)})`, async () => {
    const value = await runLoadedTaskRecoveryBoundary(true, {
      seedError: new Error('demo-main row selection failed'),
      diagnosticError,
      setupCleanupError: new Error('owned cleanup failed'),
    });
    assert.equal(value.launches.length, 0);
    assert.equal(value.closes.length, 1);
    assert.equal(value.closes[0].electronApp.id, 'first');
    assert.equal(value.closes[0].userDataDir, '/owned');
    assert.deepEqual(
      value.events.filter((event) => event.type === 'selection-diagnostic'),
      [
        {
          type: 'selection-diagnostic',
          slug: 'loaded-task-reset-worktree-selection',
          branch: 'demo-main',
        },
      ],
    );
    assert(
      value.events.findIndex((event) => event.type === 'selection-diagnostic') <
        value.events.findIndex((event) => event.type === 'close'),
    );
  });

for (const observerError of [undefined, new Error('snapshot failed')])
  test(`c192 prepared product cookie precondition failure records boundary before cleanup (${Boolean(observerError)})`, async () => {
    const primary = new Error('prepared cookie assertion');
    const value = await runRegisteredRecoveryClose('prepared', {
      restartCookieError: new Error(
        'Expected one profile fixture view; found 0',
      ),
      restartAssertionError: primary,
      boundaryObserverCheckpointError: observerError,
    });
    assert.equal(value.escaped, primary);
    assert.deepEqual(value.recorderCreations, [
      'prepared-restart-precondition',
    ]);
    const failure = value.checkpointRecords.find(
      (row) => row.checkpoint === 'fixture-cookie-poll-failed',
    );
    assert.ok(failure);
    assert.equal(failure.details.operations.expectedProfileId, 'source');
    assert.equal(failure.details.identity.profileId, 'source');
    assert.equal(failure.details.identity.runtimeGeneration, 1);
    assert.equal(failure.details.operations.native.fixtureViewCount, 0);
    assert.equal(
      failure.details.operations.native.contents[0].urlCategory,
      'about-blank',
    );
    assert.equal(
      value.operationOrder.filter(
        (event) => event === 'dispatch-browser.profile.switch',
      ).length,
      1,
    );
    assert(
      value.operationOrder.indexOf(
        'observer-checkpoint-fixture-cookie-poll-failed',
      ) < value.operationOrder.indexOf('owner-close-2'),
    );
    assert(!value.operationOrder.includes('observer-control-arm-create'));
  });

async function runQueuedFillSource({
  contenderError,
  transportError,
  inputValue = '',
  broadGate = false,
} = {}) {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const source = await readSelectedRecoverySource();
  const start = source.indexOf("test('a queued agent fill cannot edit");
  const end = source.indexOf(
    '\nfunction assertPendingPresentationOrdering(',
    start,
  );
  assert(start >= 0 && end > start);
  let callback,
    switched = false,
    finalInputReads = 0,
    closes = 0;
  const attachments = [];
  const runtime = new AsyncLocalStorage();
  const originalRun = AsyncLocalStorage.prototype.run;
  const original = {
    id: 'browser',
    profile: { resolvedProfileId: 'source', runtimeGeneration: 1 },
  };
  const test = (_name, fn) => {
    callback = fn;
  };
  test.setTimeout = (value) => assert.equal(value, 120_000);
  test.info = () => ({
    attach: async (_name, value) =>
      attachments.push(JSON.parse(value.body.toString())),
  });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const partial = (actual, expected) => {
    for (const [key, value] of Object.entries(expected)) {
      if (value && typeof value === 'object') partial(actual[key], value);
      else assert.equal(actual[key], value, key);
    }
  };
  const expect = (actual) => ({
    toBe: (expected) => assert.equal(actual, expected),
    toEqual: (expected) => assert.deepEqual(plain(actual), plain(expected)),
    toMatchObject: (expected) => partial(actual, expected),
    toBeGreaterThan: (expected) => assert(actual > expected),
    toHaveCount() {},
    toBeHidden() {},
    toContainText() {},
  });
  expect.poll = (operation) => ({
    toBe: async (expected) => {
      let actual;
      for (let attempt = 0; attempt < 10; attempt++) {
        actual = await operation();
        if (actual === expected) return;
      }
      expect(actual).toBe(expected);
    },
  });
  let context;
  const main = {
    webContents: {
      getAllWebContents: () => [
        {
          getURL: () =>
            'http://127.0.0.1:4011/browser-fixture/one?profiles=queued-fill',
          executeJavaScript: async () => {
            finalInputReads++;
            return inputValue;
          },
        },
      ],
    },
  };
  const electronApp = { evaluate: async (fn, value) => fn(main, value) };
  const window = {
    keyboard: { press: async () => {} },
    getByTestId: (id) => ({
      click: async () => {
        if (id === 'browser-profile-option-replacement') switched = true;
      },
      fill: async () => {},
      press: async () => {},
      selectOption: async () => {},
      hover: async () => {},
    }),
    api: {
      browser: {
        profiles: { create: async () => ({ profileId: 'replacement' }) },
        setBounds: async () => {
          await runtime.run(
            {
              browserId: 'browser',
              generation: 1,
              dialog: true,
              rehydrate: false,
            },
            async () => {},
          );
          if (contenderError) throw contenderError;
        },
      },
    },
    evaluate: async (fn, value) => {
      if (transportError && fn.toString().includes('setBounds')) {
        await fn(value);
        throw transportError;
      }
      return fn(value);
    },
  };
  context = vm.createContext({
    test,
    expect,
    window,
    Buffer,
    crypto: { randomUUID: () => 'operation' },
    process: { env: {}, getBuiltinModule: () => ({ AsyncLocalStorage }) },
    seedPanelWorktree: async () => ({
      electronApp,
      window,
      userDataDir: '/owned',
    }),
    fixtureCookies: async () => [],
    closeCanopy: async () => {
      closes++;
    },
    dispatchProfileAction: async () => ({
      result: {
        browsers: [
          {
            ...original,
            profile: switched
              ? { resolvedProfileId: 'replacement', runtimeGeneration: 2 }
              : original.profile,
          },
        ],
      },
    }),
    __CANOPY_E2E_DISPATCH_BROWSER_ACTION__: async (request) => {
      assert.equal(request.action.type, 'browser.fill');
      return runtime.run(
        { browserId: 'browser', generation: 1, dialog: false, rehydrate: true },
        async () => ({ ok: false, error: { code: 'stale_runtime' } }),
      );
    },
  });
  const body = source.slice(start, end);
  const fixtureSource = broadGate
    ? body.replace(
        /store\.dialog === false &&\s*store\.rehydrate === true &&\s*exactFill/,
        'true',
      )
    : body;
  if (broadGate) assert.notEqual(fixtureSource, body);
  for (const name of ['chooseBrowserProfile', 'expectBrowserProfile']) {
    const helperStart = source.indexOf(`async function ${name}(`);
    const helperEnd = source.indexOf('\n}', helperStart) + 2;
    assert(helperStart >= 0 && helperEnd > helperStart);
    vm.runInContext(source.slice(helperStart, helperEnd), context);
  }
  vm.runInContext(fixtureSource, context);
  let error;
  try {
    await callback();
  } catch (failure) {
    error = failure;
  } finally {
    AsyncLocalStorage.prototype.run = originalRun;
    runtime.disable();
  }
  return { error, attachments, finalInputReads, closes };
}

const queuedFillSupersessionMessage =
  "Error invoking remote method 'browser:set-bounds': BrowserProfileError: A newer presentation request replaced this command.";
for (const contenderError of [
  undefined,
  new Error(queuedFillSupersessionMessage),
])
  test(`c192 queued fill admits only qualified contender and reaches final input (${Boolean(contenderError)})`, async () => {
    const value = await runQueuedFillSource({ contenderError });
    assert.equal(value.error, undefined);
    assert.equal(value.finalInputReads, 1);
    assert.equal(value.closes, 1);
    const phases = value.attachments[0];
    assert.equal(
      phases.find((row) => row.phase === 'before-switch').captured.exactFill,
      true,
    );
    assert.equal(
      phases.find((row) => row.phase === 'after-switch').captured.exactFill,
      true,
    );
    assert.equal(
      phases.find((row) => row.phase === 'settled').settledBeforeRelease,
      false,
    );
    assert.equal(
      phases.find((row) => row.phase === 'contender').outcome.status,
      contenderError ? 'superseded' : 'fulfilled',
    );
  });

for (const message of [
  'authorization failed',
  'operation_conflict',
  'A newer presentation request replaced this command.',
  queuedFillSupersessionMessage + ' unrelated',
  queuedFillSupersessionMessage.replace(
    'browser:set-bounds',
    'browser:set-visible',
  ),
])
  test(`c192 queued fill rejects unrelated contender ${message}`, async () => {
    const value = await runQueuedFillSource({
      contenderError: new Error(message),
    });
    assert.ok(value.error);
    assert.equal(value.finalInputReads, 0);
    assert.equal(
      value.attachments[0].find((row) => row.phase === 'contender').outcome
        .status,
      'rejected',
    );
    assert.equal(value.closes, 1);
  });

test('c192 queued fill rejects outer transport failures even with the allowed message', async () => {
  const value = await runQueuedFillSource({
    transportError: new Error(queuedFillSupersessionMessage),
  });
  assert.ok(value.error);
});

for (const contenderError of [
  undefined,
  new Error(queuedFillSupersessionMessage),
])
  test(`c192 queued fill still rejects replacement input mutation (${Boolean(contenderError)})`, async () => {
    const value = await runQueuedFillSource({
      contenderError,
      inputValue: 'stale account write',
    });
    assert.equal(value.finalInputReads, 1);
    assert.ok(value.error);
  });

test('c192 queued fill rejects a presentation scope consuming the exact fill hold', async () => {
  const value = await runQueuedFillSource({ broadGate: true });
  assert.ok(value.error);
  assert.equal(value.finalInputReads, 0);
  assert.equal(value.closes, 1);
  const held = value.attachments[0].find(
    (row) => row.phase === 'before-switch',
  );
  assert.equal(held.captured.dialog, true);
  assert.equal(held.captured.exactFill, false);
});

test('c192 prepared native observation failure preserves precondition and cleanup', async () => {
  const primary = new Error('prepared precondition failed');
  const value = await runRegisteredRecoveryClose('prepared', {
    restartAssertionError: primary,
    nativeSnapshotError: new Error('native unavailable'),
  });
  assert.equal(value.escaped, primary);
  const failure = value.checkpointRecords.find(
    (row) => row.checkpoint === 'fixture-cookie-poll-failed',
  );
  assert.equal(failure.details.operations.native.status, 'unavailable');
  assert.equal(value.closes.length, 2);
});

for (const options of [
  { diagnosticsConfigured: false },
  { boundaryObserverSetupUnavailable: true },
])
  test(`c192 prepared unavailable diagnostic preserves assertion ${JSON.stringify(options)}`, async () => {
    const primary = new Error('prepared precondition failed');
    const value = await runRegisteredRecoveryClose('prepared', {
      ...options,
      restartAssertionError: primary,
    });
    assert.equal(value.escaped, primary);
    assert.equal(value.checkpointRecords.length, 0);
    assert.equal(value.closes.length, 2);
  });

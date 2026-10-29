import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAcceptanceCommand } from './run-browser-profile-acceptance-command.mjs';

test('never-settling acceptance command returns a terminal timed-out receipt within its bounded allowance', async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'acceptance-command-'),
  );
  const receipt =
    '.playwright/browser-profiles/phase-3/windows-full-shard-1-of-4-controller.json';
  let timer;
  try {
    const result = await Promise.race([
      runAcceptanceCommand(
        {
          workspace,
          shard: '1/4',
          shardSuffix: 'shard-1-of-4',
          receipt,
          workDeadlineMs: 10,
          cleanupAllowanceMs: 10,
        },
        { runCommand: async () => new Promise(() => {}) },
      ),
      new Promise((resolve) => {
        // Allow CI scheduling and receipt I/O; this only guards against a hang.
        timer = setTimeout(() => resolve('controller remained pending'), 2_000);
      }),
    ]);
    assert.notEqual(
      result,
      'controller remained pending',
      'application timeout must return and preserve evidence without external cancellation',
    );
    assert.notEqual(result.exitCode, 0);
    const terminal = JSON.parse(
      await readFile(path.join(workspace, receipt), 'utf8'),
    );
    assert.equal(terminal.status, 'timed-out');
    assert.equal(terminal.timedOut, true);
    assert.equal(terminal.cleanup.status, 'unverified');
  } finally {
    clearTimeout(timer);
    await rm(workspace, { recursive: true, force: true });
  }
});

function proofRows(identity, code = 0) {
  const base = {
    producer: 'supervisor',
    fixturePid: identity.fixturePid,
    parentPid: identity.fixturePid,
    pid: identity.supervisorPid,
    caseId: identity.caseId,
    launchId: identity.launchId,
  };
  return [
    { stage: 'target-exit-received', code, signal: null },
    { stage: 'supervisor-cleanup', outcome: 'entered' },
    { stage: 'cleanup-release-checkpoint', ready: true },
    { stage: 'wrapper-exit', code, signal: null },
    { stage: 'wrapper-stdio-close', code, signal: null },
    { stage: 'supervisor-cleanup', outcome: 'fulfilled' },
    { stage: 'supervisor-exit', code },
  ].map((row) => ({ ...base, ...row }));
}
function setupRow(identity, outcome = 'ready') {
  return {
    producer: 'supervisor',
    fixturePid: identity.fixturePid,
    parentPid: identity.fixturePid,
    pid: identity.supervisorPid,
    caseId: identity.caseId,
    launchId: identity.launchId,
    stage: 'admission-emission-setup',
    outcome,
  };
}
const jsonl = (rows) =>
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const identity = {
  fixturePid: 4000,
  supervisorPid: 4001,
  caseId: 'unit',
  launchId: 'unit-launch',
};

test('supervisor proof requires unique ordered final cleanup and the exact identity stream', async () => {
  const { parseAcceptanceSupervisorProof: parse } =
    await import('./run-browser-profile-acceptance-command.mjs');
  assert.equal(
    parse(jsonl(proofRows(identity)), identity, { supervisorExitCode: 0 })
      .status,
    'verified',
  );
  for (const outcome of ['ready', 'unavailable']) {
    const rows = [setupRow(identity, outcome), ...proofRows(identity)];
    const proof = parse(jsonl(rows), identity, { supervisorExitCode: 0 });
    assert.equal(proof.status, 'verified');
    assert.deepEqual(
      proof.terminalStages.map(({ stage }) => stage),
      proofRows(identity).map(({ stage }) => stage),
    );
    assert.equal(
      proof.terminalStages.some(
        ({ stage }) => stage === 'admission-emission-setup',
      ),
      false,
    );
  }
  const invalid = [
    [],
    proofRows(identity).slice(0, -1),
    proofRows(identity).filter((r) => r.stage !== 'supervisor-cleanup'),
    [...proofRows(identity), { stage: 'observer-truncated' }],
    [{ stage: 'observer-expired' }, ...proofRows(identity)],
    [setupRow(identity, 'failed'), ...proofRows(identity)],
    [setupRow(identity), setupRow(identity), ...proofRows(identity)],
    [
      proofRows(identity)[0],
      setupRow(identity),
      ...proofRows(identity).slice(1),
    ],
    [
      { ...setupRow(identity), parentPid: identity.fixturePid + 1 },
      ...proofRows(identity),
    ],
  ];
  for (const field of [
    'fixturePid',
    'parentPid',
    'pid',
    'caseId',
    'launchId',
    'producer',
  ])
    invalid.push(
      proofRows(identity).map((row, index) =>
        index ? row : { ...row, [field]: 'foreign' },
      ),
    );
  const swapped = proofRows(identity);
  [swapped[1], swapped[5]] = [swapped[5], swapped[1]];
  invalid.push(swapped);
  invalid.push([
    ...proofRows(identity).slice(0, -1),
    proofRows(identity)[1],
    proofRows(identity).at(-1),
  ]);
  invalid.push(
    proofRows(identity).map((row) =>
      row.outcome === 'fulfilled' ? { ...row, outcome: 'rejected' } : row,
    ),
  );
  invalid.push(
    proofRows(identity).map((row) =>
      row.stage === 'cleanup-release-checkpoint'
        ? { ...row, ready: false }
        : row,
    ),
  );
  invalid.push(
    proofRows(identity).filter((row) => row.stage !== 'wrapper-stdio-close'),
  );
  invalid.push(
    proofRows(identity).filter((row) => row.stage !== 'target-exit-received'),
  );
  for (const signal of [{ secret: 'excluded' }, 'SIGTERM'])
    invalid.push(
      proofRows(identity).map((row) =>
        row.stage === 'target-exit-received' ? { ...row, signal } : row,
      ),
    );
  for (const rows of invalid)
    assert.equal(
      parse(jsonl(rows), identity, { supervisorExitCode: 0 }).status,
      'unverified',
    );
  for (const text of [
    '',
    '{\n',
    jsonl(proofRows(identity)).trimEnd(),
    'x'.repeat(129 * 1024),
  ])
    assert.equal(
      parse(text, identity, { supervisorExitCode: 0 }).status,
      'unverified',
    );
  assert.equal(
    parse(jsonl(proofRows(identity)), identity, { supervisorExitCode: 7 })
      .status,
    'unverified',
  );
  const timeout = proofRows(identity).filter(
    (row) => row.stage === 'supervisor-cleanup',
  );
  assert.equal(
    parse(jsonl(timeout), identity, { timedOut: true }).status,
    'verified',
  );
  const failed = parse(jsonl(proofRows(identity, 7)), identity, {
    supervisorExitCode: 7,
  });
  assert.equal(failed.status, 'verified');
  assert.equal(failed.targetCode, 7);
  assert(!JSON.stringify(failed).includes('cleanupSucceeded'));
});

test('production CLI accepts only paired shards and contained receipts with no execution overrides', async () => {
  const { parseAcceptanceOptions } =
    await import('./run-browser-profile-acceptance-command.mjs');
  for (let shard = 1; shard <= 4; shard++)
    assert.equal(
      parseAcceptanceOptions([
        '--shard',
        `${shard}/4`,
        '--shard-suffix',
        `shard-${shard}-of-4`,
        '--receipt',
        `.playwright/browser-profiles/phase-3/windows-full-shard-${shard}-of-4-controller.json`,
      ]).shard,
      `${shard}/4`,
    );
  const good = [
    '--shard',
    '1/4',
    '--shard-suffix',
    'shard-1-of-4',
    '--receipt',
    '.playwright/browser-profiles/phase-3/receipt.json',
  ];
  for (const option of [
    '--timeout',
    '--work-deadline-ms',
    '--command-kind',
    '--env',
    '--grep',
    '--config',
    'browser-profiles.spec.mjs',
    '--fixture',
  ])
    assert.throws(() => parseAcceptanceOptions([...good, option, '1']));
  for (const receipt of [
    '../outside.json',
    '.playwright/browser-profiles/phase-3/../outside.json',
    '/absolute.json',
    '.playwright/browser-profiles/phase-3/dir\\escape.json',
  ])
    assert.throws(() =>
      parseAcceptanceOptions([...good.slice(0, -1), receipt]),
    );
  assert.throws(() =>
    parseAcceptanceOptions(['--shard', '5/4', ...good.slice(2)]),
  );
  assert.throws(() =>
    parseAcceptanceOptions(['--shard', '2/4', ...good.slice(2)]),
  );
  assert.throws(() => parseAcceptanceOptions(good.slice(0, -1)));
});

test('public invocation parser admits only the exact fixed cowork worker diagnostic', async () => {
  const {
    parseAcceptanceInvocation,
    COWORK_WORKER_DIAGNOSTIC,
    COWORK_WORKER_DIAGNOSTIC_WORK_DEADLINE_MS,
  } = await import('./run-browser-profile-acceptance-command.mjs');
  const diagnostic = parseAcceptanceInvocation([
    '--diagnostic',
    'cowork-worker-failfast',
  ]);
  assert.deepEqual(diagnostic, {
    commandKind: 'cowork-worker-failfast',
    shard: null,
    shardSuffix: null,
    receipt: COWORK_WORKER_DIAGNOSTIC.receipt,
  });
  assert.equal(COWORK_WORKER_DIAGNOSTIC_WORK_DEADLINE_MS, 6 * 60_000);
  for (const argv of [
    [],
    ['--diagnostic'],
    ['--diagnostic', 'other'],
    ['--diagnostic', 'cowork-worker-failfast', '--grep', 'x'],
    ['--diagnostic', 'cowork-worker-failfast', '--receipt', 'x'],
    ['--grep', 'cowork-worker-failfast'],
    [
      '--diagnostic',
      'cowork-worker-failfast',
      '--diagnostic',
      'cowork-worker-failfast',
    ],
  ])
    assert.throws(() => parseAcceptanceInvocation(argv));
});

test('cowork diagnostic uses the exact closed Playwright command and fixed controller environment', async () => {
  const { writeFile } = await import('node:fs/promises');
  const {
    acceptanceCommandArgs,
    COWORK_WORKER_DIAGNOSTIC,
    COWORK_WORKER_DIAGNOSTIC_TITLE,
    COWORK_WORKER_DIAGNOSTIC_WORK_DEADLINE_MS,
  } = await import('./run-browser-profile-acceptance-command.mjs');
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'cowork-worker-diagnostic-')),
  );
  try {
    assert.deepEqual(
      acceptanceCommandArgs(workspace, {
        commandKind: 'cowork-worker-failfast',
      }).slice(7),
      [
        'browser-chrome.spec.mjs',
        '--project=electron',
        '--workers=1',
        '--grep',
        COWORK_WORKER_DIAGNOSTIC_TITLE,
        '--max-failures=1',
        '--reporter=line,json',
        '--retries=0',
        '--output=.playwright/windows-cowork-worker-diagnostic-results',
      ],
    );
    let collected = 0;
    const result = await runAcceptanceCommand(
      {
        workspace,
        commandKind: 'cowork-worker-failfast',
        shard: null,
        shardSuffix: null,
        receipt: COWORK_WORKER_DIAGNOSTIC.receipt,
      },
      {
        runCommand: async (command) => {
          assert.equal(
            command.timeoutMs,
            COWORK_WORKER_DIAGNOSTIC_WORK_DEADLINE_MS,
          );
          assert.equal(command.cleanupAllowanceMs, 4 * 60_000);
          assert.equal(command.env.CANOPY_E2E_SHOW_WINDOW, '0');
          assert.equal(
            command.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR,
            COWORK_WORKER_DIAGNOSTIC.boundaryDirectory,
          );
          assert.equal(
            command.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
            COWORK_WORKER_DIAGNOSTIC.playwrightJson,
          );
          assert(
            !Object.hasOwn(
              command.env,
              'CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE',
            ),
          );
          const config = JSON.parse(
            command.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
          );
          await writeFile(
            config.file.replace(/-main\.jsonl$/, '-supervisor.jsonl'),
            jsonl(proofRows({ ...config, supervisorPid: 4001 })),
          );
          return {
            code: 0,
            signal: null,
            cleanup: { supervisorPid: 4001, supervisorExitCode: 0, errors: [] },
          };
        },
        collectCrashMetadata: async (input) => {
          collected++;
          assert.equal(
            input.boundaryDirectory,
            path.join(workspace, COWORK_WORKER_DIAGNOSTIC.boundaryDirectory),
          );
          assert.equal(
            input.metadataFile,
            path.join(workspace, COWORK_WORKER_DIAGNOSTIC.crashMetadata),
          );
          return {
            status: 'no-matching-event',
            workerPid: 7840,
            matchCount: 0,
            errorCategory: 'no-events',
          };
        },
      },
    );
    assert.equal(collected, 1);
    assert.equal(result.status, 'passed');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.workerCrashDiagnostic, {
      status: 'no-matching-event',
      file: COWORK_WORKER_DIAGNOSTIC.crashMetadata,
      workerPid: 7840,
      matchCount: 0,
      errorCategory: 'no-events',
    });
    assert.equal(result.shard, null);
    assert.equal(result.command.title, COWORK_WORKER_DIAGNOSTIC_TITLE);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('auxiliary diagnostic failures never replace primary controller outcomes or terminal receipt', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { COWORK_WORKER_DIAGNOSTIC } =
    await import('./run-browser-profile-acceptance-command.mjs');
  for (const [label, code, metadataError] of [
    ['worker-exit', 3221226505, null],
    ['collector-throw', 7, new Error('raw collector secret')],
  ]) {
    const workspace = await realpath(
      await mkdtemp(path.join(os.tmpdir(), `cowork-${label}-`)),
    );
    try {
      const result = await runAcceptanceCommand(
        {
          workspace,
          commandKind: 'cowork-worker-failfast',
          shard: null,
          shardSuffix: null,
          receipt: COWORK_WORKER_DIAGNOSTIC.receipt,
          workDeadlineMs: 100,
          cleanupAllowanceMs: 100,
        },
        {
          runCommand: async (command) => {
            const config = JSON.parse(
              command.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
            );
            await writeFile(
              config.file.replace(/-main\.jsonl$/, '-supervisor.jsonl'),
              jsonl(proofRows({ ...config, supervisorPid: 4001 }, code)),
            );
            return {
              code,
              signal: null,
              cleanup: {
                supervisorPid: 4001,
                supervisorExitCode: code,
                errors: [],
              },
            };
          },
          collectCrashMetadata: async () => {
            if (metadataError) throw metadataError;
            return {
              status: 'matched',
              workerPid: 7840,
              matchCount: 1,
              errorCategory: null,
            };
          },
        },
      );
      assert.equal(result.status, 'failed-tests');
      assert.equal(result.code, code);
      assert.equal(result.exitCode, 1);
      assert.equal(result.cleanup.status, 'verified');
      assert.equal(
        result.workerCrashDiagnostic.status,
        metadataError ? 'query-unavailable' : 'matched',
      );
      const receipt = JSON.parse(
        await readFile(
          path.join(workspace, COWORK_WORKER_DIAGNOSTIC.receipt),
          'utf8',
        ),
      );
      assert.deepEqual(receipt, result);
      assert(!JSON.stringify(receipt).includes('raw collector secret'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test('diagnostic preserves pass, test failure, timeout, interruption and cleanup proof outcomes', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { COWORK_WORKER_DIAGNOSTIC } =
    await import('./run-browser-profile-acceptance-command.mjs');
  const scenarios = [
    ['pass', 0, {}, true, 'passed', 0],
    ['test-failure', 7, {}, true, 'failed-tests', 1],
    ['timeout', 0, { timedOut: true }, true, 'timed-out', 124],
    ['interruption', 0, { interrupted: true }, true, 'interrupted', 130],
    ['missing-proof', 0, {}, false, 'controller-failed', 1],
    ['rejected-cleanup', 0, {}, true, 'controller-failed', 1],
  ];
  for (const [
    label,
    code,
    flags,
    writeProof,
    expectedStatus,
    exitCode,
  ] of scenarios) {
    const workspace = await realpath(
      await mkdtemp(path.join(os.tmpdir(), `cowork-primary-${label}-`)),
    );
    try {
      const result = await runAcceptanceCommand(
        {
          workspace,
          commandKind: 'cowork-worker-failfast',
          shard: null,
          shardSuffix: null,
          receipt: COWORK_WORKER_DIAGNOSTIC.receipt,
          workDeadlineMs: 100,
          cleanupAllowanceMs: 100,
        },
        {
          runCommand: async (command) => {
            const config = JSON.parse(
              command.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
            );
            const rows = proofRows({ ...config, supervisorPid: 4001 }, code);
            if (label === 'rejected-cleanup')
              rows.find((row) => row.outcome === 'fulfilled').outcome =
                'rejected';
            if (writeProof)
              await writeFile(
                config.file.replace(/-main\.jsonl$/, '-supervisor.jsonl'),
                jsonl(rows),
              );
            return {
              code,
              signal: null,
              ...flags,
              cleanup: {
                supervisorPid: 4001,
                supervisorExitCode: code,
                errors: [],
              },
            };
          },
          collectCrashMetadata: async () => ({
            status: 'no-matching-event',
            workerPid: 7840,
            matchCount: 0,
            errorCategory: 'no-events',
          }),
        },
      );
      assert.equal(result.status, expectedStatus, label);
      assert.equal(result.exitCode, exitCode, label);
      assert.equal(result.timedOut, flags.timedOut === true, label);
      assert.equal(result.interrupted, flags.interrupted === true, label);
      assert.equal(
        result.cleanup.status,
        ['missing-proof', 'rejected-cleanup'].includes(label)
          ? 'unverified'
          : 'verified',
        label,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test('every closed crash-metadata status leaves the primary diagnostic result unchanged', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { COWORK_WORKER_DIAGNOSTIC } =
    await import('./run-browser-profile-acceptance-command.mjs');
  let expectedPrimary;
  for (const [status, errorCategory] of [
    ['matched', null],
    ['no-matching-event', 'no-events'],
    ['identity-unavailable', 'identity-unavailable'],
    ['identity-ambiguous', 'identity-ambiguous'],
    ['query-unavailable', 'query-failed'],
  ]) {
    const workspace = await realpath(
      await mkdtemp(path.join(os.tmpdir(), `cowork-metadata-${status}-`)),
    );
    try {
      const result = await runAcceptanceCommand(
        {
          workspace,
          commandKind: 'cowork-worker-failfast',
          shard: null,
          shardSuffix: null,
          receipt: COWORK_WORKER_DIAGNOSTIC.receipt,
          workDeadlineMs: 100,
          cleanupAllowanceMs: 100,
        },
        {
          runCommand: async (command) => {
            const config = JSON.parse(
              command.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
            );
            await writeFile(
              config.file.replace(/-main\.jsonl$/, '-supervisor.jsonl'),
              jsonl(proofRows({ ...config, supervisorPid: 4001 }, 7)),
            );
            return {
              code: 7,
              signal: null,
              cleanup: {
                supervisorPid: 4001,
                supervisorExitCode: 7,
                errors: [],
              },
            };
          },
          collectCrashMetadata: async () => ({
            status,
            workerPid: status.startsWith('identity-') ? null : 7840,
            matchCount: status === 'matched' ? 1 : 0,
            errorCategory,
          }),
        },
      );
      const primary = {
        status: result.status,
        timedOut: result.timedOut,
        interrupted: result.interrupted,
        code: result.code,
        signal: result.signal,
        cleanupStatus: result.cleanup.status,
        normalCompletion: result.cleanup.normalCompletion,
        exitCode: result.exitCode,
      };
      expectedPrimary ??= primary;
      assert.deepEqual(primary, expectedPrimary);
      assert.equal(result.workerCrashDiagnostic.status, status);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test('diagnostic rejects raised fixed bounds and all fixture environment injection', async () => {
  const { COWORK_WORKER_DIAGNOSTIC } =
    await import('./run-browser-profile-acceptance-command.mjs');
  const base = {
    workspace: process.cwd(),
    commandKind: 'cowork-worker-failfast',
    shard: null,
    shardSuffix: null,
    receipt: COWORK_WORKER_DIAGNOSTIC.receipt,
  };
  await assert.rejects(
    runAcceptanceCommand({ ...base, workDeadlineMs: 6 * 60_000 + 1 }),
  );
  await assert.rejects(
    runAcceptanceCommand({ ...base, cleanupAllowanceMs: 4 * 60_000 + 1 }),
  );
  await assert.rejects(
    runAcceptanceCommand({
      ...base,
      fixtureEnv: {
        CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE: '1',
        CANOPY_E2E_ACCEPTANCE_CONTROLLER_OWNED_PID_FILE: '/tmp/owned.pid',
      },
    }),
  );
});

for (const scenario of [
  'success',
  'test-failure',
  'timeout',
  'interruption',
  'no-proof',
  'rejected-cleanup',
  'stream-disposal',
  'spawn-error',
]) {
  test(`acceptance ${scenario} atomically replaces starting receipt and preserves independent cleanup outcome`, async () => {
    const { writeFile, readdir } = await import('node:fs/promises');
    const { ACCEPTANCE_WORK_DEADLINE_MS } =
      await import('./run-browser-profile-acceptance-command.mjs');
    const workspace = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'acceptance-result-')),
    );
    const receipt =
      '.playwright/browser-profiles/phase-3/windows-full-shard-1-of-4-controller.json';
    try {
      const result = await runAcceptanceCommand(
        { workspace, shard: '1/4', shardSuffix: 'shard-1-of-4', receipt },
        {
          runCommand: async (command) => {
            const starting = JSON.parse(
              await readFile(path.join(workspace, receipt), 'utf8'),
            );
            assert.equal(starting.status, 'starting');
            assert.equal(starting.workDeadlineMs, 1_440_000);
            assert.equal(command.timeoutMs, ACCEPTANCE_WORK_DEADLINE_MS);
            assert.equal(command.cleanupAllowanceMs, 240_000);
            assert.equal(command.executable, process.execPath);
            assert.deepEqual(command.args, [
              path.join(workspace, 'scripts/run-guarded-dev-script.mjs'),
              '--suite',
              'e2e',
              '--',
              process.execPath,
              path.join(workspace, 'node_modules/@playwright/test/cli.js'),
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
            ]);
            assert(
              !Object.hasOwn(
                command.env,
                'CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE',
              ),
            );
            const config = JSON.parse(
              command.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
            );
            assert.equal(config.mode, 'acceptance-command');
            assert.equal(
              command.env.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS,
              '1',
            );
            const code = scenario === 'test-failure' ? 7 : 0;
            const rows = proofRows({ ...config, supervisorPid: 4001 }, code);
            if (scenario === 'rejected-cleanup')
              rows.find((row) => row.outcome === 'fulfilled').outcome =
                'rejected';
            if (scenario !== 'no-proof')
              await writeFile(
                config.file.replace(/-main\.jsonl$/, '-supervisor.jsonl'),
                jsonl(rows),
              );
            if (scenario === 'spawn-error') throw new Error('spawn denied');
            return {
              code,
              signal: null,
              timedOut: scenario === 'timeout',
              interrupted: scenario === 'interruption',
              cleanup: {
                supervisorPid: 4001,
                supervisorExitCode: code,
                forwardingStreamsClosedAfterUnverifiedCleanup:
                  scenario === 'stream-disposal',
                cooperativeRequestSent: scenario === 'timeout',
                errors: [],
              },
            };
          },
        },
      );
      assert.equal(result.exitCode === 0, scenario === 'success');
      assert.equal(
        result.cleanup.status,
        [
          'no-proof',
          'rejected-cleanup',
          'stream-disposal',
          'spawn-error',
        ].includes(scenario)
          ? 'unverified'
          : 'verified',
      );
      assert.deepEqual(
        JSON.parse(await readFile(path.join(workspace, receipt), 'utf8')),
        result,
      );
      assert(
        (await readdir(path.dirname(path.join(workspace, receipt)))).every(
          (entry) => !entry.endsWith('.tmp'),
        ),
      );
      assert(Buffer.byteLength(JSON.stringify(result)) < 32768);
      assert(
        !JSON.stringify(result).includes(
          'CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS',
        ),
      );
      assert.equal(Object.hasOwn(result, 'env'), false);
      if (scenario === 'timeout') assert.equal(result.status, 'timed-out');
      if (scenario === 'test-failure') {
        assert.equal(result.status, 'failed-tests');
        assert.equal(result.code, 7);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

test('function-only fixture composition stays closed and rejects raised deadlines or arbitrary environment', async () => {
  const { acceptanceCommandArgs, ACCEPTANCE_FIXTURE_TITLE } =
    await import('./run-browser-profile-acceptance-command.mjs');
  const options = {
    workspace: process.cwd(),
    shard: '1/4',
    shardSuffix: 'shard-1-of-4',
    receipt: '.playwright/browser-profiles/phase-3/unit-controller.json',
  };
  const args = acceptanceCommandArgs(process.cwd(), {
    ...options,
    commandKind: 'owned-timeout-fixture',
  });
  assert.deepEqual(args.slice(7), [
    'browser-profiles.spec.mjs',
    '--project=electron',
    '--fully-parallel',
    '--workers=1',
    '--grep',
    ACCEPTANCE_FIXTURE_TITLE,
    '--reporter=line,json',
    '--retries=0',
    '--output=.playwright/windows-acceptance-controller-fixture-results',
  ]);
  for (const change of [
    { commandKind: 'arbitrary' },
    { workDeadlineMs: 1_440_001 },
    { cleanupAllowanceMs: 240_001 },
    { fixtureEnv: { SECRET: 'never serialize' } },
    { commandKind: 'owned-timeout-fixture', fixtureEnv: {} },
  ])
    await assert.rejects(runAcceptanceCommand({ ...options, ...change }));
});

test('owned timeout fixture explicitly opts its exact outer gate into admission emission', async () => {
  const { writeFile } = await import('node:fs/promises');
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'acceptance-emission-fixture-')),
  );
  const receipt =
    '.playwright/browser-profiles/phase-3/windows-acceptance-emission-fixture-controller.json';
  try {
    const result = await runAcceptanceCommand(
      {
        workspace,
        shard: '1/4',
        shardSuffix: 'shard-1-of-4',
        receipt,
        commandKind: 'owned-timeout-fixture',
        fixtureEnv: {
          CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE: '1',
          CANOPY_E2E_ACCEPTANCE_CONTROLLER_OWNED_PID_FILE: path.join(
            workspace,
            'owned.pid',
          ),
        },
      },
      {
        runCommand: async (command) => {
          assert.equal(
            command.env.CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS,
            '1',
          );
          const config = JSON.parse(
            command.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
          );
          const proofIdentity = { ...config, supervisorPid: 4001 };
          await writeFile(
            config.file.replace(/-main\.jsonl$/, '-supervisor.jsonl'),
            jsonl([
              setupRow(proofIdentity, 'ready'),
              ...proofRows(proofIdentity),
            ]),
          );
          return {
            code: 0,
            signal: null,
            timedOut: false,
            interrupted: false,
            cleanup: {
              supervisorPid: 4001,
              supervisorExitCode: 0,
              forwardingStreamsClosedAfterUnverifiedCleanup: false,
              errors: [],
            },
          };
        },
      },
    );
    assert.equal(result.status, 'passed');
    assert.equal(result.cleanup.status, 'verified');
    assert.equal(
      result.cleanup.terminalStages.some(
        ({ stage }) => stage === 'admission-emission-setup',
      ),
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test(
  'real Windows guarded timeout fixture',
  { skip: process.platform !== 'win32', timeout: 290_000 },
  async () => {
    const { spawn } = await import('node:child_process');
    const { writeFile } = await import('node:fs/promises');
    const { processGroupExists } =
      await import('./process-tree-supervisor.mjs');
    const workspace = path.resolve('.');
    const directory = await mkdtemp(
      path.join(
        process.env.RUNNER_TEMP ?? os.tmpdir(),
        'acceptance-controller-',
      ),
    );
    const ownedPidFile = path.join(directory, 'owned.pid');
    const receipt =
      '.playwright/browser-profiles/phase-3/windows-acceptance-controller-timeout-controller.json';
    const foreign = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', windowsHide: true },
    );
    const foreignClosed = new Promise((resolve) =>
      foreign.once('close', resolve),
    );
    try {
      const result = await runAcceptanceCommand({
        workspace,
        shard: '1/4',
        shardSuffix: 'shard-1-of-4',
        receipt,
        commandKind: 'owned-timeout-fixture',
        workDeadlineMs: 45_000,
        fixtureEnv: {
          CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE: '1',
          CANOPY_E2E_ACCEPTANCE_CONTROLLER_OWNED_PID_FILE: ownedPidFile,
        },
      });
      assert.equal(result.status, 'timed-out');
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.cleanup.status, 'verified');
      assert.deepEqual(
        result.cleanup.terminalStages
          .filter((row) => row.stage === 'supervisor-cleanup')
          .map((row) => row.outcome),
        ['entered', 'fulfilled'],
      );
      const ownedPid = Number(await readFile(ownedPidFile, 'utf8'));
      assert(Number.isSafeInteger(ownedPid) && ownedPid > 0);
      assert.equal(
        processGroupExists(ownedPid),
        false,
        'Owned TERM-resistant descendant must be absent',
      );
      assert.equal(
        processGroupExists(foreign.pid),
        true,
        'Unrelated sibling must survive',
      );
      assert.equal(
        result.cleanup.forwardingStreamsClosedAfterUnverifiedCleanup,
        false,
      );
      assert.deepEqual(
        JSON.parse(await readFile(path.join(workspace, receipt), 'utf8')),
        result,
      );
      // Reopening for append on Windows confirms the atomic writer released its handle.
      await writeFile(path.join(workspace, receipt), '', { flag: 'a' });
    } finally {
      foreign.kill();
      await foreignClosed;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('normal supervisor control failure cannot be reported as a clean target result', async () => {
  const { parseAcceptanceSupervisorProof } =
    await import('./run-browser-profile-acceptance-command.mjs');
  const rows = proofRows(identity);
  rows.at(-1).code = 125;
  const proof = parseAcceptanceSupervisorProof(jsonl(rows), identity, {
    supervisorExitCode: 125,
  });
  assert.equal(proof.status, 'unverified');
});

test('CLI rejects inherited option names and proof rejects missing identity fields', async () => {
  const { parseAcceptanceOptions, parseAcceptanceSupervisorProof } =
    await import('./run-browser-profile-acceptance-command.mjs');
  const args = [
    '--shard',
    '1/4',
    '--shard-suffix',
    'shard-1-of-4',
    '--receipt',
    '.playwright/browser-profiles/phase-3/receipt.json',
  ];
  for (const name of ['toString', 'constructor', '__proto__'])
    assert.throws(() => parseAcceptanceOptions([...args, name, 'unexpected']));
  const missing = {
    supervisorPid: 4001,
    launchId: 'unit-launch',
    caseId: 'unit',
  };
  assert.equal(
    parseAcceptanceSupervisorProof(jsonl(proofRows(missing)), missing, {
      supervisorExitCode: 0,
    }).status,
    'unverified',
  );
});

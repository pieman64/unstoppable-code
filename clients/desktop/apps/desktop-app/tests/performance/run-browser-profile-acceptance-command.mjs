#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runCommandProcess,
  WINDOWS_COMMAND_CLEANUP_ALLOWANCE_MS,
} from './browser-profiles-release-ci.mjs';
import { collectWindowsWorkerCrashEventMetadata } from '../../../../scripts/lib/windows-worker-crash-event-metadata.mjs';

export const ACCEPTANCE_WORK_DEADLINE_MS = 24 * 60_000;
export const COWORK_WORKER_DIAGNOSTIC_WORK_DEADLINE_MS = 6 * 60_000;
export const ACCEPTANCE_FIXTURE_TITLE =
  'acceptance controller owns and terminates its timeout fixture';
export const COWORK_WORKER_DIAGNOSTIC_TITLE =
  '(?:^| )W1 precommit cowork retirement abort retains legacy login for first browser open$';
export const COWORK_WORKER_DIAGNOSTIC = Object.freeze({
  receipt:
    '.playwright/browser-profiles/phase-3/windows-cowork-worker-diagnostic-controller.json',
  playwrightJson:
    '.playwright/browser-profiles/phase-3/windows-cowork-worker-diagnostic-results.json',
  boundaryDirectory:
    '.playwright/browser-profiles/phase-3/windows-boundary-cowork-worker-diagnostic',
  playwrightOutput: '.playwright/windows-cowork-worker-diagnostic-results',
  crashMetadata:
    '.playwright/browser-profiles/phase-3/windows-cowork-worker-diagnostic-crash-metadata.json',
});
const PHASE_ROOT = '.playwright/browser-profiles/phase-3/';
const MAX_PROOF_BYTES = 128 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const WINDOWS_ADMISSION_EMISSION_ENV =
  'CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS';

export function parseAcceptanceOptions(argv) {
  const result = {};
  const names = {
    '--shard': 'shard',
    '--shard-suffix': 'shardSuffix',
    '--receipt': 'receipt',
  };
  for (let index = 0; index < argv.length; index += 2) {
    assert(Object.hasOwn(names, argv[index]), 'Unknown acceptance option');
    const key = names[argv[index]];
    assert(
      key && !Object.hasOwn(result, key),
      'Unknown or duplicate acceptance option',
    );
    assert(
      typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--'),
      'Missing acceptance option value',
    );
    result[key] = argv[index + 1];
  }
  validateOptions(result);
  return result;
}

export function parseAcceptanceInvocation(argv) {
  if (
    argv.length === 2 &&
    argv[0] === '--diagnostic' &&
    argv[1] === 'cowork-worker-failfast'
  )
    return {
      commandKind: 'cowork-worker-failfast',
      shard: null,
      shardSuffix: null,
      receipt: COWORK_WORKER_DIAGNOSTIC.receipt,
    };
  return parseAcceptanceOptions(argv);
}

function validateOptions({
  shard,
  shardSuffix,
  receipt,
  commandKind = 'production-shard',
}) {
  if (commandKind === 'cowork-worker-failfast') {
    assert.equal(shard, null, 'Diagnostic cannot select a shard');
    assert.equal(shardSuffix, null, 'Diagnostic cannot select a shard suffix');
    assert.equal(
      receipt,
      COWORK_WORKER_DIAGNOSTIC.receipt,
      'Diagnostic receipt is fixed',
    );
    return;
  }
  assert(/^[1-4]\/4$/.test(shard ?? ''), 'Expected one of four Windows shards');
  assert.equal(shardSuffix, `shard-${shard[0]}-of-4`, 'Shard suffix mismatch');
  assert(
    typeof receipt === 'string' &&
      receipt.length <= 512 &&
      receipt.startsWith(PHASE_ROOT) &&
      receipt.endsWith('.json') &&
      !receipt.includes('\\') &&
      !receipt
        .split('/')
        .some((part) => !part || part === '.' || part === '..') &&
      !path.isAbsolute(receipt),
    'Receipt must remain inside the workspace phase-3 tree',
  );
}

export function acceptanceCommandArgs(
  workspace,
  { shard, shardSuffix, commandKind = 'production-shard' },
) {
  assert(
    [
      'production-shard',
      'owned-timeout-fixture',
      'cowork-worker-failfast',
    ].includes(commandKind),
    'Unknown acceptance command kind',
  );
  let tail;
  if (commandKind === 'production-shard')
    tail = [
      'browser-profiles.spec.mjs',
      'browser-chrome.spec.mjs',
      '--project=electron',
      '--fully-parallel',
      '--workers=1',
      '--shard',
      shard,
      '--reporter=line,json',
      '--retries=0',
      `--output=.playwright/windows-full-${shardSuffix}-results`,
    ];
  else if (commandKind === 'owned-timeout-fixture')
    tail = [
      'browser-profiles.spec.mjs',
      '--project=electron',
      '--fully-parallel',
      '--workers=1',
      '--grep',
      ACCEPTANCE_FIXTURE_TITLE,
      '--reporter=line,json',
      '--retries=0',
      '--output=.playwright/windows-acceptance-controller-fixture-results',
    ];
  else
    tail = [
      'browser-chrome.spec.mjs',
      '--project=electron',
      '--workers=1',
      '--grep',
      COWORK_WORKER_DIAGNOSTIC_TITLE,
      '--max-failures=1',
      '--reporter=line,json',
      '--retries=0',
      `--output=${COWORK_WORKER_DIAGNOSTIC.playwrightOutput}`,
    ];
  return [
    path.join(workspace, 'scripts/run-guarded-dev-script.mjs'),
    '--suite',
    'e2e',
    '--',
    process.execPath,
    path.join(workspace, 'node_modules/@playwright/test/cli.js'),
    'test',
    ...tail,
  ];
}

/** Only the exact identity stream can attest owner.stop's final absence check. */
export function parseAcceptanceSupervisorProof(
  text,
  identity,
  { timedOut = false, interrupted = false, supervisorExitCode = null } = {},
) {
  const result = { status: 'unverified', terminalStages: [], error: null };
  try {
    assert(
      Number.isSafeInteger(identity.fixturePid) &&
        identity.fixturePid > 0 &&
        Number.isSafeInteger(identity.supervisorPid) &&
        identity.supervisorPid > 0 &&
        [identity.caseId, identity.launchId].every(
          (id) => typeof id === 'string' && /^[a-z0-9_-]{1,160}$/i.test(id),
        ),
      'Invalid supervisor proof identity',
    );
    assert(
      typeof text === 'string' &&
        text.endsWith('\n') &&
        Buffer.byteLength(text) <= MAX_PROOF_BYTES,
      'Missing, partial or oversized supervisor stream',
    );
    const lines = text.trimEnd().split('\n');
    assert(
      lines.length > 0 && lines.length <= 256,
      'Invalid supervisor record count',
    );
    const rows = lines.map((line) => {
      assert(Buffer.byteLength(line) <= 16384, 'Oversized supervisor record');
      return JSON.parse(line);
    });
    for (const row of rows) {
      assert(
        row && !['observer-expired', 'observer-truncated'].includes(row.stage),
        'Supervisor observer expired or truncated',
      );
      assert(
        row.producer === 'supervisor' &&
          row.fixturePid === identity.fixturePid &&
          row.parentPid === identity.fixturePid &&
          row.launchId === identity.launchId &&
          row.caseId === identity.caseId &&
          row.pid === identity.supervisorPid &&
          Number.isSafeInteger(row.pid) &&
          row.pid > 0,
        'Supervisor stream identity mismatch',
      );
    }
    const setupRows = rows.filter(
      (row) => row.stage === 'admission-emission-setup',
    );
    assert(setupRows.length <= 1, 'Duplicate admission emission setup record');
    if (setupRows.length === 1) {
      assert(
        rows[0] === setupRows[0],
        'Admission emission setup record must be the prelude',
      );
      assert(
        ['ready', 'unavailable'].includes(setupRows[0].outcome),
        'Malformed admission emission setup outcome',
      );
    }
    const terminalRows = setupRows.length === 1 ? rows.slice(1) : rows;
    const selected = new Set([
      'target-started-received',
      'controller-stop-requested',
      'target-exit-received',
      'cleanup-release-checkpoint',
      'supervisor-cleanup',
      'wrapper-exit',
      'wrapper-stdio-close',
      'supervisor-exit',
    ]);
    assert(
      terminalRows.every((row) => selected.has(row.stage)),
      'Unexpected supervisor stage',
    );
    result.terminalStages = terminalRows.map((row) => {
      const projected = { stage: row.stage };
      if (row.stage === 'supervisor-cleanup')
        projected.outcome = ['entered', 'fulfilled', 'rejected'].includes(
          row.outcome,
        )
          ? row.outcome
          : null;
      if (row.stage === 'cleanup-release-checkpoint')
        projected.ready = row.ready === true;
      if (row.stage === 'controller-stop-requested')
        projected.reason = ['timeout', 'interruption'].includes(row.reason)
          ? row.reason
          : null;
      if (
        [
          'target-exit-received',
          'wrapper-exit',
          'wrapper-stdio-close',
          'supervisor-exit',
        ].includes(row.stage)
      ) {
        assert(
          row.code === null || Number.isSafeInteger(row.code),
          'Malformed terminal exit code',
        );
        assert(
          row.signal === null ||
            row.signal === undefined ||
            (typeof row.signal === 'string' &&
              /^SIG[A-Z0-9]{1,16}$/.test(row.signal)),
          'Malformed terminal signal',
        );
        assert(
          !(Number.isInteger(row.code) && row.signal),
          'Conflicting terminal code and signal',
        );
        projected.code = Number.isInteger(row.code) ? row.code : null;
        projected.signal =
          row.signal === null || row.signal === undefined
            ? null
            : typeof row.signal === 'string' &&
                /^SIG[A-Z0-9]{1,16}$/.test(row.signal)
              ? row.signal
              : 'invalid';
      }
      return projected;
    });
    const cleanup = terminalRows.filter(
      (row) => row.stage === 'supervisor-cleanup',
    );
    assert(
      cleanup.length === 2 &&
        cleanup[0].outcome === 'entered' &&
        cleanup[1].outcome === 'fulfilled',
      'Missing, duplicate, rejected or unordered supervisor cleanup',
    );
    for (const stage of selected)
      if (stage !== 'supervisor-cleanup')
        assert(
          terminalRows.filter((row) => row.stage === stage).length <= 1,
          'Duplicate supervisor terminal stage',
        );
    const exit = terminalRows.find((row) => row.stage === 'supervisor-exit');
    if (exit)
      assert(
        terminalRows.at(-1) === exit && exit.code === supervisorExitCode,
        'Supervisor exit mismatch or ordering failure',
      );
    result.status = 'verified';
    const target = terminalRows.find(
      (row) => row.stage === 'target-exit-received',
    );
    result.targetCode = Number.isInteger(target?.code) ? target.code : null;
    result.targetSignal = target?.signal ?? null;
    result.normalCompletion =
      terminalRows.some(
        (row) =>
          row.stage === 'cleanup-release-checkpoint' && row.ready === true,
      ) &&
      terminalRows.some((row) => row.stage === 'wrapper-stdio-close') &&
      !!exit &&
      !!target;
    if (!timedOut && !interrupted) {
      assert(
        exit?.code === (result.targetCode ?? (result.targetSignal ? 1 : null)),
        'Supervisor result did not preserve target result',
      );
      assert(
        result.normalCompletion,
        'Normal command lacks release checkpoint, closed stdio or terminal result',
      );
    }
  } catch (error) {
    result.status = 'unverified';
    result.error = String(error.message).slice(0, 512);
  }
  return result;
}

async function atomicReceipt(file, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  assert(
    Buffer.byteLength(body) <= MAX_RECEIPT_BYTES,
    'Controller receipt exceeded bound',
  );
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(body, 'utf8');
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function readProof(file) {
  const handle = await open(file, 'r');
  try {
    assert(
      (await handle.stat()).size <= MAX_PROOF_BYTES,
      'Oversized supervisor proof file',
    );
    const buffer = Buffer.alloc(MAX_PROOF_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    assert(
      bytesRead <= MAX_PROOF_BYTES,
      'Growing supervisor proof exceeded bound',
    );
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function runAcceptanceCommand(
  options,
  {
    runCommand = runCommandProcess,
    collectCrashMetadata = collectWindowsWorkerCrashEventMetadata,
  } = {},
) {
  validateOptions(options);
  const workspace = await realpath(
    options.workspace ??
      fileURLToPath(new URL('../../../../', import.meta.url)),
  );
  const commandKind = options.commandKind ?? 'production-shard';
  const args = acceptanceCommandArgs(workspace, { ...options, commandKind });
  const maximumWorkDeadlineMs =
    commandKind === 'cowork-worker-failfast'
      ? COWORK_WORKER_DIAGNOSTIC_WORK_DEADLINE_MS
      : ACCEPTANCE_WORK_DEADLINE_MS;
  const workDeadlineMs = options.workDeadlineMs ?? maximumWorkDeadlineMs;
  const cleanupAllowanceMs =
    options.cleanupAllowanceMs ?? WINDOWS_COMMAND_CLEANUP_ALLOWANCE_MS;
  assert(
    Number.isFinite(workDeadlineMs) &&
      workDeadlineMs > 0 &&
      workDeadlineMs <= maximumWorkDeadlineMs,
    'Cannot raise acceptance work deadline',
  );
  assert(
    Number.isFinite(cleanupAllowanceMs) &&
      cleanupAllowanceMs > 0 &&
      cleanupAllowanceMs <= WINDOWS_COMMAND_CLEANUP_ALLOWANCE_MS,
    'Cannot raise cleanup allowance',
  );
  const fixtureEnv = options.fixtureEnv ?? {};
  assert(
    Object.keys(fixtureEnv).every((key) =>
      [
        'CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE',
        'CANOPY_E2E_ACCEPTANCE_CONTROLLER_OWNED_PID_FILE',
      ].includes(key),
    ),
    'Unknown fixture environment field',
  );
  if (
    commandKind === 'production-shard' ||
    commandKind === 'cowork-worker-failfast'
  )
    assert.equal(
      Object.keys(fixtureEnv).length,
      0,
      'Production command cannot inject fixture environment',
    );
  else
    assert(
      fixtureEnv.CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE === '1' &&
        path.isAbsolute(
          fixtureEnv.CANOPY_E2E_ACCEPTANCE_CONTROLLER_OWNED_PID_FILE ?? '',
        ),
      'Missing fixed timeout fixture environment',
    );
  const file = path.join(workspace, options.receipt);
  await mkdir(path.dirname(file), { recursive: true });
  assert.equal(
    await realpath(path.dirname(file)),
    path.dirname(file),
    'Receipt directory must not escape through symlinks',
  );
  const launchId = randomUUID();
  const caseId =
    commandKind === 'production-shard'
      ? `windows-${options.shardSuffix}`
      : commandKind === 'cowork-worker-failfast'
        ? 'w1-legacy-review-cowork'
        : 'acceptance-controller-timeout';
  const boundaryDirectory = path.join(
    workspace,
    PHASE_ROOT,
    commandKind === 'production-shard'
      ? `windows-boundary-${options.shardSuffix}`
      : commandKind === 'cowork-worker-failfast'
        ? 'windows-boundary-cowork-worker-diagnostic'
        : 'windows-boundary-acceptance-controller-timeout',
  );
  await mkdir(boundaryDirectory, { recursive: true });
  assert.equal(
    await realpath(boundaryDirectory),
    boundaryDirectory,
    'Boundary directory must not escape through symlinks',
  );
  const boundary = {
    mode: 'acceptance-command',
    fixturePid: process.pid,
    caseId,
    launchId,
    file: path.join(boundaryDirectory, `${launchId}-main.jsonl`),
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const initial = {
    version: 1,
    status: 'starting',
    shard: options.shard,
    shardSuffix: options.shardSuffix,
    startedAt,
    workDeadlineMs,
    cleanupAllowanceMs,
    command: {
      kind: commandKind,
      runner: 'scripts/run-guarded-dev-script.mjs',
      suite: 'e2e',
      tests:
        commandKind === 'production-shard'
          ? ['browser-profiles.spec.mjs', 'browser-chrome.spec.mjs']
          : commandKind === 'cowork-worker-failfast'
            ? ['browser-chrome.spec.mjs']
            : ['browser-profiles.spec.mjs'],
      ...(commandKind === 'cowork-worker-failfast'
        ? { title: COWORK_WORKER_DIAGNOSTIC_TITLE }
        : {}),
    },
  };
  await atomicReceipt(file, initial);
  const controller = new AbortController();
  let timedOut = false,
    interrupted = false,
    timer,
    graceTimer,
    outcome,
    stopResolve;
  const stopped = new Promise((resolve) => {
    stopResolve = resolve;
  });
  const interrupt = () => {
    interrupted = true;
    controller.abort();
    stopResolve();
  };
  options.signal?.addEventListener('abort', interrupt, { once: true });
  let terminal;
  try {
    if (options.signal?.aborted) interrupt();
    // The real runner arms its own work/cleanup bounds before this outer fallback.
    const commandEnv = { ...process.env };
    delete commandEnv.CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE;
    delete commandEnv.CANOPY_E2E_ACCEPTANCE_CONTROLLER_OWNED_PID_FILE;
    delete commandEnv[WINDOWS_ADMISSION_EMISSION_ENV];
    if (commandKind === 'cowork-worker-failfast') {
      delete commandEnv.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR;
      delete commandEnv.PLAYWRIGHT_JSON_OUTPUT_FILE;
      delete commandEnv.CANOPY_E2E_SHOW_WINDOW;
    }
    const command = Promise.resolve(
      runCommand({
        executable: process.execPath,
        args,
        cwd: workspace,
        env: {
          ...commandEnv,
          ...fixtureEnv,
          CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify(boundary),
          [WINDOWS_ADMISSION_EMISSION_ENV]: '1',
          ...(commandKind === 'cowork-worker-failfast'
            ? {
                CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR:
                  COWORK_WORKER_DIAGNOSTIC.boundaryDirectory,
                PLAYWRIGHT_JSON_OUTPUT_FILE:
                  COWORK_WORKER_DIAGNOSTIC.playwrightJson,
                CANOPY_E2E_SHOW_WINDOW: '0',
              }
            : {}),
        },
        stdio: 'inherit',
        timeoutMs: workDeadlineMs,
        cleanupAllowanceMs,
        signal: controller.signal,
      }),
    );
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      stopResolve();
    }, workDeadlineMs);
    outcome = await Promise.race([command, stopped.then(() => null)]);
    if (!outcome)
      outcome = await Promise.race([
        command,
        new Promise((resolve) => {
          graceTimer = setTimeout(
            () =>
              resolve({
                code: null,
                signal: null,
                error: 'Command did not settle within cleanup allowance',
                cleanup: { status: 'unverified' },
              }),
            cleanupAllowanceMs,
          );
        }),
      ]);
  } catch (error) {
    outcome = {
      code: null,
      signal: null,
      error: String(error.message).slice(0, 512),
      cleanup: { status: 'unverified' },
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    options.signal?.removeEventListener('abort', interrupt);
    timedOut ||= outcome?.timedOut === true;
    interrupted ||= !timedOut && outcome?.interrupted === true;
    let proof;
    try {
      proof = parseAcceptanceSupervisorProof(
        await readProof(
          boundary.file.replace(/-main\.jsonl$/, '-supervisor.jsonl'),
        ),
        { ...boundary, supervisorPid: outcome?.cleanup?.supervisorPid },
        {
          timedOut,
          interrupted,
          supervisorExitCode: outcome?.cleanup?.supervisorExitCode,
        },
      );
    } catch {
      proof = {
        status: 'unverified',
        terminalStages: [],
        error: 'Supervisor proof unavailable',
      };
    }
    const actions = outcome?.cleanup ?? {};
    if (
      actions.forwardingStreamsClosedAfterUnverifiedCleanup ||
      actions.errors?.length
    )
      proof.status = 'unverified';
    const passed =
      !timedOut &&
      !interrupted &&
      !outcome?.error &&
      proof.status === 'verified' &&
      proof.normalCompletion &&
      proof.targetCode === 0 &&
      proof.targetSignal === null &&
      actions.supervisorExitCode === 0;
    const status = timedOut
      ? 'timed-out'
      : interrupted
        ? 'interrupted'
        : proof.status !== 'verified' || outcome?.error
          ? 'controller-failed'
          : passed
            ? 'passed'
            : 'failed-tests';
    let workerCrashDiagnostic;
    if (commandKind === 'cowork-worker-failfast') {
      try {
        const metadata = await collectCrashMetadata({
          boundaryDirectory,
          metadataFile: path.join(
            workspace,
            COWORK_WORKER_DIAGNOSTIC.crashMetadata,
          ),
          controllerStartedAt: startedAt,
          collectionStartedAt: new Date().toISOString(),
        });
        workerCrashDiagnostic = {
          status: [
            'matched',
            'no-matching-event',
            'identity-unavailable',
            'identity-ambiguous',
            'query-unavailable',
          ].includes(metadata?.status)
            ? metadata.status
            : 'query-unavailable',
          file: COWORK_WORKER_DIAGNOSTIC.crashMetadata,
          workerPid:
            Number.isSafeInteger(metadata?.workerPid) && metadata.workerPid > 0
              ? metadata.workerPid
              : null,
          matchCount:
            Number.isSafeInteger(metadata?.matchCount) &&
            metadata.matchCount >= 0 &&
            metadata.matchCount <= 4
              ? metadata.matchCount
              : 0,
          errorCategory:
            typeof metadata?.errorCategory === 'string' &&
            /^(?:no-events|access-denied|query-timeout|query-failed|malformed-output|identity-unavailable|identity-ambiguous)$/.test(
              metadata.errorCategory,
            )
              ? metadata.errorCategory
              : null,
        };
      } catch {
        workerCrashDiagnostic = {
          status: 'query-unavailable',
          file: COWORK_WORKER_DIAGNOSTIC.crashMetadata,
          workerPid: null,
          matchCount: 0,
          errorCategory: 'query-failed',
        };
      }
    }
    terminal = {
      ...initial,
      status,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      timedOut,
      interrupted,
      code: proof.targetCode ?? outcome?.code ?? null,
      signal: proof.targetSignal ?? outcome?.signal ?? null,
      error: outcome?.error ? String(outcome.error).slice(0, 512) : null,
      cleanup: {
        ...proof,
        supervisorPid: Number.isSafeInteger(actions.supervisorPid)
          ? actions.supervisorPid
          : null,
        cooperativeRequestSent: actions.cooperativeRequestSent === true,
        forwardingStreamsClosedAfterUnverifiedCleanup:
          actions.forwardingStreamsClosedAfterUnverifiedCleanup === true,
        supervisorExitCode: Number.isInteger(actions.supervisorExitCode)
          ? actions.supervisorExitCode
          : null,
        errors: (actions.errors ?? [])
          .slice(0, 8)
          .map((error) => String(error).slice(0, 512)),
      },
      ...(workerCrashDiagnostic ? { workerCrashDiagnostic } : {}),
      exitCode: passed ? 0 : timedOut ? 124 : interrupted ? 130 : 1,
    };
    await atomicReceipt(file, terminal);
  }
  return terminal;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    assert.equal(process.platform, 'win32', 'Acceptance CLI requires Windows');
    process.exitCode = (
      await runAcceptanceCommand({
        ...parseAcceptanceInvocation(process.argv.slice(2)),
        signal: controller.signal,
      })
    ).exitCode;
  } catch (error) {
    process.stderr.write(
      `Acceptance controller failed: ${String(error.message).slice(0, 512)}\n`,
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

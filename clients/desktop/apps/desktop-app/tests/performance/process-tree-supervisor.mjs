#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SUPERVISED_EXECUTABLE_ENV = 'CANOPY_E2E_SUPERVISED_EXECUTABLE';
const SUPERVISED_PID_FILE_ENV = 'CANOPY_E2E_SUPERVISED_PID_FILE';
const SUPERVISED_GROUPS_FILE_ENV = 'CANOPY_E2E_SUPERVISED_GROUPS_FILE';
const SUPERVISED_RUN_NONCE_ENV = 'CANOPY_E2E_SUPERVISED_RUN_NONCE';
export const SUPERVISED_RETAIN_FILE_ENV = 'CANOPY_E2E_SUPERVISED_RETAIN_FILE';
const SUPERVISOR_OWNER_PID_ENV = 'CANOPY_E2E_OWNER_PID';
const PROCESS_TREE_REFRESH_MS_ENV = 'CANOPY_E2E_TREE_REFRESH_MS';
const WATCHDOG_ARG = '--canopy-process-tree-watchdog';
const WINDOWS_CHILD_ARG = '--canopy-windows-supervised-child';
const WINDOWS_TARGET_STARTED_MESSAGE = 'target-started';
const WINDOWS_TARGET_EXIT_MESSAGE = 'target-exit';
const WINDOWS_RELEASE_ACK_MESSAGE = 'release-after-cleanup-snapshot';
const WINDOWS_RELEASE_FAILURE_EXIT_CODE = 125;
const WATCHDOG_TRACK_PID_MESSAGE = 'track-owned-pid';
export const SUPERVISOR_GRACE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const PROCESS_TREE_REFRESH_INTERVAL_MS = 1_000;
const PROCESS_LIST_TIMEOUT_MS = 5_000;
const WINDOWS_CLEANUP_PROCESS_LIST_TIMEOUT_MS = 15_000;
const WINDOWS_RELEASE_ACK_TIMEOUT_MS = 45_000;
const WINDOWS_ENUMERATION_PHASE_MARKERS = {
  psReady: 'phase=ps-ready',
  cimFirstRow: 'phase=cim-first-row',
  cimComplete: 'phase=cim-complete',
};
const FILTER_INITIAL_WINDOWS_IDENTITY = Symbol(
  'filter-initial-windows-identity',
);
const WINDOWS_REJECTED_PROCESS_ROWS = Symbol('windows-rejected-process-rows');
const WINDOWS_LAUNCH_FAILURE_MARKER =
  '[e2e-supervisor:windows-launch-failure] ';
const WINDOWS_LAUNCH_FAILURE_MAX_BYTES = 8_192;
const WINDOWS_ADMISSION_EMISSION_ENV =
  'CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS';
const WINDOWS_ADMISSION_EMISSION_MAX_BYTES = 4 * 1024;
const WINDOWS_ADMISSION_EMISSION_STAGES = Object.freeze([
  'script-enter',
  'pre-cim',
  'first-row-callback',
  'post-pipeline',
]);
const POST_DECISION_STDOUT_MAX_BYTES = 16 * 1024;
const POST_DECISION_STDERR_MAX_BYTES = 8 * 1024;

function safeProperty(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function boundedJsonString(value, maxBytes) {
  if (value === null || value === undefined) {
    return { value: null, truncated: false };
  }
  let text;
  try {
    text = String(value);
  } catch {
    return { value: null, truncated: true };
  }
  if (Buffer.byteLength(JSON.stringify(text)) - 2 <= maxBytes) {
    return { value: text, truncated: false };
  }
  let bounded = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + characterBytes > maxBytes) break;
    bounded += character;
    bytes += characterBytes;
  }
  return { value: bounded, truncated: true };
}

function boundedError(error, caps = {}) {
  const smallBytes = caps.smallBytes ?? 128;
  const messageBytes = caps.messageBytes ?? 512;
  const stderrBytes = caps.stderrBytes ?? 1_024;
  let fieldTruncationCount = 0;
  const take = (key, maxBytes) => {
    const bounded = boundedJsonString(safeProperty(error, key), maxBytes);
    if (bounded.truncated) fieldTruncationCount += 1;
    return bounded.value;
  };
  return {
    error: {
      name: take('name', smallBytes),
      code: take('code', smallBytes),
      signal: take('signal', smallBytes),
      killed:
        typeof safeProperty(error, 'killed') === 'boolean'
          ? safeProperty(error, 'killed')
          : null,
      message: take('message', messageBytes),
      stderr: take('stderr', stderrBytes),
    },
    fieldTruncationCount,
  };
}

function safeObserve(observer, value) {
  try {
    observer?.(value);
  } catch {
    // Diagnostic observation must not change ownership behavior.
  }
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function positivePid(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function parseWindowsProcessList(stdout, rootPid) {
  const rows = [];
  const rejectedRows = [];
  const rootCandidates = [];
  let rootCandidateCount = 0;
  let acceptedCount = 0;
  let rejectedCount = 0;
  let fieldTruncationCount = 0;
  const lines = stdout.split('\n');
  for (const line of lines) {
    const fields = line.replace(/\r$/, '').split('\t');
    const [pidField, parentPidField, creationDate] = fields;
    const pidAccepted = /^\d+$/.test(pidField);
    const parentPidAccepted = /^\d+$/.test(parentPidField);
    const creationDatePresent = Boolean(creationDate?.trim());
    const pid = pidAccepted ? Number(pidField) : null;
    const parentPid = parentPidAccepted ? Number(parentPidField) : null;
    const accepted =
      fields.length === 3 &&
      pidAccepted &&
      parentPidAccepted &&
      creationDatePresent;
    if (accepted) {
      acceptedCount += 1;
      rows.push({ pid, parentPid, creationDate });
    } else {
      rejectedCount += 1;
      if (pidAccepted && parentPidAccepted)
        rejectedRows.push({ pid, parentPid, creationDate, rejected: true });
    }
    if (pid !== rootPid) continue;
    rootCandidateCount += 1;
    if (rootCandidates.length >= 2) continue;
    const boundedCreation = boundedJsonString(creationDate, 128);
    if (boundedCreation.truncated) fieldTruncationCount += 1;
    rootCandidates.push({
      pid,
      parentPid,
      creationDatePresent,
      accepted,
      creationIdentity: creationDatePresent ? boundedCreation.value : null,
    });
  }
  return {
    rows,
    rejectedRows,
    metadata: {
      lineCount: lines.length,
      acceptedCount,
      rejectedCount,
      rootCandidateCount,
      rootCandidates,
      fieldTruncationCount,
    },
  };
}

function parseWindowsEnumerationPhases(stdout) {
  const lines = new Set(stdout.split(/\r?\n/));
  return {
    psReady: lines.has(WINDOWS_ENUMERATION_PHASE_MARKERS.psReady),
    cimFirstRow: lines.has(WINDOWS_ENUMERATION_PHASE_MARKERS.cimFirstRow),
    cimComplete: lines.has(WINDOWS_ENUMERATION_PHASE_MARKERS.cimComplete),
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function processGroupExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') return processExists(pid);
  if (pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

export async function killProcessTree(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    try {
      await execFileAsync('taskkill', args, { windowsHide: true });
      return;
    } catch {
      // The process may have exited between the liveness check and taskkill.
    }
    return;
  } else {
    if (pid <= 1) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Detached children always lead their own process group. If the group is
      // gone, do not signal the positive PID because it may already be reused.
    }
    return;
  }
}

// Buffered scans use the same ordered markers as initial streamed admission.
// Full scans may contain rejected unrelated rows, but never incomplete protocol.
function validateWindowsEnumeration(stdout, stderr, rootPid) {
  const parsed = parseWindowsProcessList(stdout, rootPid);
  let phase = 'awaiting-ready';
  let dataCount = 0;
  let invalid = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (
      phase === 'awaiting-ready' &&
      line === WINDOWS_ENUMERATION_PHASE_MARKERS.psReady
    )
      phase = 'awaiting-first-row';
    else if (
      phase === 'awaiting-first-row' &&
      line === WINDOWS_ENUMERATION_PHASE_MARKERS.cimFirstRow
    )
      phase = 'rows';
    else if (
      (phase === 'awaiting-first-row' || (phase === 'rows' && dataCount > 0)) &&
      line === WINDOWS_ENUMERATION_PHASE_MARKERS.cimComplete
    )
      phase = 'complete';
    else if (phase === 'rows' && !line.trim().startsWith('phase=')) dataCount++;
    else invalid = true;
  }
  const metadata = {
    ...parsed.metadata,
    outcome: 'completed',
    phases: parseWindowsEnumerationPhases(stdout),
    validatedPhase: phase,
    protocolValid: !invalid && phase === 'complete',
    dataCount,
    outputBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stderrPresent: stderr.length > 0,
  };
  if (!metadata.protocolValid || metadata.stderrPresent) {
    metadata.outcome = 'error';
    metadata.failureCategory = metadata.stderrPresent ? 'stderr' : 'protocol';
    const error = new Error(
      metadata.stderrPresent
        ? 'Windows process enumeration reported stderr'
        : 'Incomplete or invalid Windows enumeration protocol',
    );
    Object.assign(error, { stdout, stderr, enumerationMetadata: metadata });
    throw error;
  }
  return { ...parsed, metadata };
}

export function parsePosixProcessList(stdout) {
  return String(stdout)
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
      if (!match) return [];
      const [, pid, parentPid, pgid, startTime] = match;
      return /^\d+$/.test(pid) &&
        /^\d+$/.test(parentPid) &&
        /^\d+$/.test(pgid) &&
        startTime
        ? [
            {
              pid: Number(pid),
              parentPid: Number(parentPid),
              pgid: Number(pgid),
              startTime,
            },
          ]
        : [];
    });
}

export async function listPosixProcesses() {
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,pgid=,lstart='],
    {
      encoding: 'utf8',
      // Keep creation-time identities stable across supervisor and reaper environments.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
      timeout: PROCESS_LIST_TIMEOUT_MS,
    },
  );
  return parsePosixProcessList(stdout);
}

async function listWindowsProcesses({
  rootPid,
  filterPid,
  observe,
  timeoutMs = PROCESS_LIST_TIMEOUT_MS,
} = {}) {
  const startedAt = performance.now();
  try {
    const { stdout, stderr = '' } = await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        buildWindowsProcessTreeListScript(filterPid),
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: timeoutMs,
      },
    );
    const parsed = validateWindowsEnumeration(stdout, stderr, rootPid);
    if (filterPid !== undefined) {
      const dataLines = stdout.split('\n').filter((line) => {
        const value = line.trim();
        return (
          value &&
          !Object.values(WINDOWS_ENUMERATION_PHASE_MARKERS).includes(value)
        );
      });
      if (
        dataLines.length !== parsed.rows.length ||
        dataLines.some(
          (line) => line.replace(/\r$/, '').split('\t').length !== 3,
        )
      )
        throw Object.assign(
          new Error('Malformed filtered Windows process identity'),
          {
            stdout,
            stderr,
            enumerationMetadata: {
              ...parsed.metadata,
              outcome: 'error',
              failureCategory: 'identity',
            },
          },
        );
    }
    safeObserve(observe, {
      outcome: 'completed',
      durationMs: performance.now() - startedAt,
      timeoutMs,
      outputState: 'completed',
      outputBytes: Buffer.byteLength(stdout),
      ...parsed.metadata,
      error: null,
    });
    Object.defineProperty(parsed.rows, WINDOWS_REJECTED_PROCESS_ROWS, {
      value: parsed.rejectedRows,
    });
    return parsed.rows;
  } catch (error) {
    safeObserve(
      observe,
      failedEnumeration(
        error,
        rootPid,
        performance.now() - startedAt,
        timeoutMs,
      ),
    );
    throw error;
  }
}

// Only the initial gated exact-PID query spends a separate startup allowance.
// Later ownership scans retain listWindowsProcesses' whole-query timeout.
function listInitialWindowsIdentity(
  { rootPid, observe, signal, onFailure, setAdmissionDeadline },
  options,
) {
  const now = options.now ?? (() => performance.now());
  const spawnQuery = options.spawn ?? spawn;
  const schedule = options.setTimeoutFn ?? setTimeout;
  const cancelTimer = options.clearTimeoutFn ?? clearTimeout;
  const emissionActive = options.admissionEmission?.status === 'ready';
  const budgets = {
    startupMs: 15_000,
    completionMs: 15_000,
    lifetimeMs: 30_000,
    terminationMs: 1_000,
  };
  const origin = now();
  const startupDeadline = origin + budgets.startupMs;
  const lifetimeDeadline = origin + budgets.lifetimeMs;
  let completionDeadline;
  let query;
  let timer;
  let cleanupTimer;
  let pending = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stderrEvidenceTruncated = false;
  let outputBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  let postDecisionStdoutBytes = 0;
  let postDecisionStderrBytes = 0;
  let postDecisionStdoutTruncated = false;
  let postDecisionStderrTruncated = false;
  let phase = 0;
  let candidate;
  let failure;
  let failureAt;
  let timeoutPhase;
  let closed = false;
  let exited = false;
  let settled = false;
  let signalling = false;
  let killAttempted = false;
  let killReturned = null;
  let killError = null;
  let queryPid = null;
  let timeoutObservationSource = null;
  const timings = emissionActive
    ? {
        spawnReturnMs: null,
        spawnEventMs: null,
        firstStdoutByteMs: null,
        firstStderrByteMs: null,
        readyMs: null,
        firstRowMs: null,
        identityMs: null,
        completeMs: null,
        exitMs: null,
        closeMs: null,
        timeoutDeadlineMs: null,
        timeoutObservedMs: null,
        deadlineTimerLatenessMs: null,
      }
    : {
        readyMs: null,
        completeMs: null,
        exitMs: null,
        closeMs: null,
      };

  return new Promise((resolve, reject) => {
    const ignoreLateError = () => undefined;
    const dispose = () => {
      cancelTimer(timer);
      cancelTimer(cleanupTimer);
      signal?.removeEventListener('abort', onAbort);
      if (query) {
        if (emissionActive) query.removeListener('spawn', onSpawn);
        query.removeListener('error', onError);
        query.removeListener('exit', onExit);
        query.removeListener('close', onClose);
        // A queued OS error after the bounded decision must not crash the host.
        query.on('error', ignoreLateError);
        for (const pipe of [query.stdout, query.stderr]) {
          pipe.removeListener(
            'data',
            pipe === query.stdout ? onStdout : onStderr,
          );
          pipe.removeListener('error', onStreamError);
          pipe.on('error', ignoreLateError);
          pipe.destroy();
        }
        if (!closed) query.unref?.();
      }
      pending = Buffer.alloc(0);
      stderr = Buffer.alloc(0);
    };
    const finish = () => {
      if (settled || signalling) return;
      settled = true;
      const metadata = candidate
        ? completedEnumerationFromRows([candidate], rootPid, now() - origin)
        : completedEnumerationWithoutRowReads(now() - origin);
      const snapshot = {
        ...metadata,
        outcome: failure ? 'error' : 'completed',
        outputState: failure ? 'partial' : 'completed',
        outputBytes,
        stderrBytes,
        outputTruncated,
        stderrEvidenceTruncated,
        ...(emissionActive
          ? {
              queryPid,
              postDecisionStdoutBytes,
              postDecisionStderrBytes,
              postDecisionStdoutTruncated,
              postDecisionStderrTruncated,
            }
          : {}),
        budgets,
        phases: {
          psReady: phase >= 1,
          cimFirstRow: phase >= 2,
          cimComplete: phase >= 4,
        },
        validatedPhase: [
          'awaiting-ready',
          'awaiting-first-row',
          'awaiting-identity',
          'awaiting-complete',
          'awaiting-close',
        ][phase],
        timings: { ...timings },
        failureCategory: failure?.category ?? null,
        timeoutPhase: timeoutPhase ?? null,
        ...(emissionActive ? { timeoutObservationSource } : {}),
        failureElapsedMs: failureAt === undefined ? null : failureAt - origin,
        killAttempted,
        killReturned,
        killError,
        terminationConfirmed: closed,
        cleanupOutcome: closed ? 'closed' : 'termination-unconfirmed',
        error: failure
          ? boundedError(
              Object.assign(new Error(failure.message), {
                stderr: stderr.toString('utf8'),
              }),
            ).error
          : null,
      };
      safeObserve(observe, snapshot);
      dispose();
      if (failure) reject(new Error(failure.message));
      else resolve([candidate]);
    };
    const cleanupTick = () => {
      if (settled) return;
      const remaining = failureAt + budgets.terminationMs - now();
      if (remaining <= 0 || closed) finish();
      else cleanupTimer = schedule(cleanupTick, remaining);
    };
    const fail = (category, message) => {
      if (settled || failure) return;
      failure = { category, message };
      failureAt = now();
      cancelTimer(timer);
      safeObserve(onFailure, failure);
      cleanupTimer = schedule(cleanupTick, budgets.terminationMs);
      if (query && !closed) {
        killAttempted = true;
        signalling = true;
        try {
          killReturned = query.kill('SIGTERM');
        } catch (error) {
          killError = boundedError(error).error;
        } finally {
          signalling = false;
        }
      }
      if (!query || closed) finish();
    };
    const timely = (source = 'callback') => {
      if (settled) return false;
      if (failure) {
        if (now() >= failureAt + budgets.terminationMs) finish();
        return false;
      }
      const deadline = completionDeadline ?? startupDeadline;
      if (!emissionActive) {
        if (now() >= deadline || now() >= lifetimeDeadline) {
          timeoutPhase =
            completionDeadline === undefined ? 'startup' : 'completion';
          fail(
            'timeout',
            `Initial Windows ownership ${timeoutPhase} deadline expired`,
          );
          return false;
        }
        return true;
      }
      const deadlineObserved = now();
      const lifetimeObserved =
        deadlineObserved >= deadline ? deadlineObserved : now();
      if (
        deadlineObserved >= deadline ||
        lifetimeObserved >= lifetimeDeadline
      ) {
        const effectiveDeadline = Math.min(deadline, lifetimeDeadline);
        const observed =
          deadlineObserved >= deadline ? deadlineObserved : lifetimeObserved;
        timeoutPhase =
          completionDeadline === undefined ? 'startup' : 'completion';
        timings.timeoutDeadlineMs = effectiveDeadline - origin;
        timings.timeoutObservedMs = observed - origin;
        timeoutObservationSource = source;
        if (source === 'timer')
          timings.deadlineTimerLatenessMs = Math.max(
            0,
            observed - effectiveDeadline,
          );
        fail(
          'timeout',
          `Initial Windows ownership ${timeoutPhase} deadline expired`,
        );
        return false;
      }
      return true;
    };
    const tick = () => {
      if (!(emissionActive ? timely('timer') : timely())) return;
      cancelTimer(timer);
      timer = schedule(tick, (completionDeadline ?? startupDeadline) - now());
    };
    const acceptLine = (line) => {
      if (!(emissionActive ? timely('stdout') : timely())) return;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') return;
      if (phase === 0 && line === WINDOWS_ENUMERATION_PHASE_MARKERS.psReady) {
        timings.readyMs = now() - origin;
        completionDeadline = Math.min(
          now() + budgets.completionMs,
          lifetimeDeadline,
        );
        setAdmissionDeadline?.(completionDeadline, origin);
        phase = 1;
        tick();
      } else if (
        phase === 1 &&
        line === WINDOWS_ENUMERATION_PHASE_MARKERS.cimFirstRow
      ) {
        if (emissionActive) timings.firstRowMs = now() - origin;
        phase = 2;
      } else if (phase === 2) {
        const fields = line.split('\t');
        if (
          fields.length !== 3 ||
          !/^\d+$/.test(fields[0]) ||
          Number(fields[0]) !== rootPid ||
          !/^\d+$/.test(fields[1]) ||
          !Number.isSafeInteger(Number(fields[1])) ||
          !fields[2].trim()
        ) {
          fail('parse', 'Invalid initial Windows ownership identity row');
          return;
        }
        candidate = {
          pid: rootPid,
          parentPid: Number(fields[1]),
          creationDate: fields[2],
        };
        if (emissionActive) timings.identityMs = now() - origin;
        phase = 3;
      } else if (
        phase === 3 &&
        line === WINDOWS_ENUMERATION_PHASE_MARKERS.cimComplete
      ) {
        timings.completeMs = now() - origin;
        phase = 4;
      } else
        fail('parse', 'Unexpected initial Windows ownership output or phase');
    };
    const onStdout = (chunk) => {
      if (!emissionActive && !timely()) return;
      if (emissionActive && failure) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        timings.firstStdoutByteMs ??= now() - origin;
        const retained = Math.min(
          bytes.length,
          Math.max(0, POST_DECISION_STDOUT_MAX_BYTES - postDecisionStdoutBytes),
        );
        postDecisionStdoutBytes += retained;
        postDecisionStdoutTruncated ||= retained < bytes.length;
        timely('stdout');
        return;
      }
      if (emissionActive && !timely('stdout')) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        timings.firstStdoutByteMs ??=
          timings.timeoutObservedMs ?? now() - origin;
        const retained = Math.min(
          bytes.length,
          Math.max(0, POST_DECISION_STDOUT_MAX_BYTES - postDecisionStdoutBytes),
        );
        postDecisionStdoutBytes += retained;
        postDecisionStdoutTruncated ||= retained < bytes.length;
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (emissionActive) timings.firstStdoutByteMs ??= now() - origin;
      outputBytes += bytes.length;
      if (outputBytes > 16 * 1024) {
        outputTruncated = true;
        fail('overflow', 'Initial Windows ownership stdout exceeds 16 KiB');
        return;
      }
      let offset = 0;
      while (offset < bytes.length && !failure && !settled) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        if (pending.length + end - offset > 4 * 1024) {
          outputTruncated = true;
          fail('overflow', 'Initial Windows ownership line exceeds 4 KiB');
          return;
        }
        pending = Buffer.concat([pending, bytes.subarray(offset, end)]);
        if (newline === -1) return;
        let line;
        try {
          line = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(pending);
        } catch {
          fail('parse', 'Invalid UTF-8 in initial Windows ownership output');
          return;
        }
        pending = Buffer.alloc(0);
        acceptLine(line);
        offset = newline + 1;
      }
    };
    const onStderr = (chunk) => {
      if (!emissionActive && !timely()) return;
      if (emissionActive && failure) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        timings.firstStderrByteMs ??= now() - origin;
        const retained = Math.min(
          bytes.length,
          Math.max(0, POST_DECISION_STDERR_MAX_BYTES - postDecisionStderrBytes),
        );
        postDecisionStderrBytes += retained;
        postDecisionStderrTruncated ||= retained < bytes.length;
        timely('stderr');
        return;
      }
      if (emissionActive && !timely('stderr')) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        timings.firstStderrByteMs ??=
          timings.timeoutObservedMs ?? now() - origin;
        const retained = Math.min(
          bytes.length,
          Math.max(0, POST_DECISION_STDERR_MAX_BYTES - postDecisionStderrBytes),
        );
        postDecisionStderrBytes += retained;
        postDecisionStderrTruncated ||= retained < bytes.length;
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (emissionActive) timings.firstStderrByteMs ??= now() - origin;
      stderrBytes += bytes.length;
      if (stderrBytes > 8 * 1024) {
        outputTruncated = true;
        fail('overflow', 'Initial Windows ownership stderr exceeds 8 KiB');
        return;
      }
      // Stderr never advances the protocol; retain only bounded evidence.
      const retained = bytes.subarray(0, Math.max(0, 1024 - stderr.length));
      stderrEvidenceTruncated ||= retained.length < bytes.length;
      stderr = Buffer.concat([stderr, retained]);
    };
    const onError = (error) => {
      if (!(emissionActive ? timely('error') : timely())) {
        if (failure && !settled) killError ??= boundedError(error).error;
        return;
      }
      fail('spawn', boundedError(error).error.message);
    };
    const onStreamError = (error) => {
      if (emissionActive ? timely('stream-error') : timely())
        fail('stream', boundedError(error).error.message);
    };
    const onSpawn = () => {
      timings.spawnEventMs ??= now() - origin;
    };
    const onExit = (code, exitSignal) => {
      if (settled) return;
      timings.exitMs = now() - origin;
      exited = true;
      if (!(emissionActive ? timely('exit') : timely())) return;
      if (code !== 0 || exitSignal)
        fail('exit', 'Initial Windows ownership query exited unsuccessfully');
    };
    const onClose = (code, exitSignal) => {
      if (settled) return;
      // Check the cleanup deadline before observing a late close as confirmed.
      if (failure && now() >= failureAt + budgets.terminationMs) {
        finish();
        return;
      }
      closed = true;
      timings.closeMs = now() - origin;
      if (!(emissionActive ? timely('close') : timely())) {
        finish();
        return;
      }
      if (code !== 0 || exitSignal || !exited)
        fail('exit', 'Initial Windows ownership query did not exit cleanly');
      else if (stderrBytes > 0)
        fail('stderr', 'Initial Windows ownership query reported stderr');
      else if (phase !== 4 || pending.length !== 0)
        fail(
          'parse',
          'Initial Windows ownership output was incomplete at close',
        );
      if ((emissionActive ? timely('close') : timely()) || failure) finish();
    };
    const onAbort = () => {
      if (emissionActive ? timely('abort') : timely())
        fail('cancelled', 'Initial Windows ownership admission cancelled');
    };
    try {
      query = spawnQuery(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          buildWindowsProcessTreeListScript(
            rootPid,
            options.admissionEmission?.status === 'ready'
              ? options.admissionEmission
              : undefined,
          ),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (emissionActive) {
        queryPid = positivePid(query?.pid);
        timings.spawnReturnMs = now() - origin;
        query.once('spawn', onSpawn);
      }
      query.on('error', onError);
      query.on('exit', onExit);
      query.on('close', onClose);
      query.stdout.on('data', onStdout);
      query.stderr.on('data', onStderr);
      query.stdout.on('error', onStreamError);
      query.stderr.on('error', onStreamError);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else tick();
    } catch (error) {
      fail('spawn', boundedError(error).error.message);
    }
  });
}

function windowsAdmissionEmissionAppend(file, stage, initialize = false) {
  const escapedFile = file.replaceAll("'", "''");
  const sequence = initialize
    ? '$_canopyEmissionSequence = 1'
    : '$_canopyEmissionSequence += 1';
  return `try { ${sequence}; $_canopyEmissionTicks = ([DateTime]::UtcNow.Ticks).ToString([Globalization.CultureInfo]::InvariantCulture); [IO.File]::AppendAllText('${escapedFile}', ('{"schemaVersion":1,"sequence":' + $_canopyEmissionSequence.ToString([Globalization.CultureInfo]::InvariantCulture) + ',"stage":"${stage}","utcTicks":"' + $_canopyEmissionTicks + '","powershellPid":' + $PID.ToString([Globalization.CultureInfo]::InvariantCulture) + '}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) } catch {}`;
}

function validWindowsAdmissionEmissionPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

export function buildWindowsProcessTreeListScript(
  filterPid,
  emissionDescriptor,
) {
  let filterClause = '';
  if (filterPid !== undefined) {
    if (!Number.isSafeInteger(filterPid) || filterPid <= 0) {
      throw new TypeError(
        'Windows process filter PID must be a positive safe integer',
      );
    }
    filterClause = ` -Filter "ProcessId=${filterPid}"`;
  }
  let emissionFile;
  if (emissionDescriptor !== undefined) {
    emissionFile = emissionDescriptor?.file;
    if (!validWindowsAdmissionEmissionPath(emissionFile))
      throw new TypeError('Invalid Windows admission emission path');
  }
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `[Console]::Out.WriteLine("${WINDOWS_ENUMERATION_PHASE_MARKERS.psReady}")`,
    '[Console]::Out.Flush()',
    '$_canopyFirstCimRow = $true',
    `Get-CimInstance Win32_Process${filterClause} -ErrorAction Stop | ForEach-Object {`,
    '  if ($_canopyFirstCimRow) {',
    `    [Console]::Out.WriteLine("${WINDOWS_ENUMERATION_PHASE_MARKERS.cimFirstRow}")`,
    '    [Console]::Out.Flush()',
    '    $_canopyFirstCimRow = $false',
    '  }',
    '  $created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("O") } else { "" }',
    '  Write-Output ("{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $created)',
    '}',
    `[Console]::Out.WriteLine("${WINDOWS_ENUMERATION_PHASE_MARKERS.cimComplete}")`,
    '[Console]::Out.Flush()',
  ];
  if (emissionFile) {
    lines.unshift(
      windowsAdmissionEmissionAppend(emissionFile, 'script-enter', true),
    );
    lines.splice(
      lines.indexOf(
        `Get-CimInstance Win32_Process${filterClause} -ErrorAction Stop | ForEach-Object {`,
      ),
      0,
      windowsAdmissionEmissionAppend(emissionFile, 'pre-cim'),
    );
    lines.splice(
      lines.indexOf(
        `    [Console]::Out.WriteLine("${WINDOWS_ENUMERATION_PHASE_MARKERS.cimFirstRow}")`,
      ),
      0,
      `    ${windowsAdmissionEmissionAppend(
        emissionFile,
        'first-row-callback',
      )}`,
    );
    lines.splice(
      lines.indexOf(
        `[Console]::Out.WriteLine("${WINDOWS_ENUMERATION_PHASE_MARKERS.cimComplete}")`,
      ),
      0,
      windowsAdmissionEmissionAppend(emissionFile, 'post-pipeline'),
    );
  }
  return lines.join('\n');
}

export function parseWindowsAdmissionEmissionRecords(text, expectedQueryPid) {
  const invalid = (error, truncated = false) => ({
    status: 'invalid',
    recordCount: 0,
    records: [],
    completedEmpty: false,
    error,
    truncated,
  });
  if (typeof text !== 'string') return invalid('evidence-not-text');
  if (Buffer.byteLength(text) > WINDOWS_ADMISSION_EMISSION_MAX_BYTES)
    return invalid('evidence-exceeds-4-kib', true);
  if (positivePid(expectedQueryPid) === null)
    return invalid('invalid-expected-query-pid');
  if (text === '')
    return {
      status: 'partial',
      recordCount: 0,
      records: [],
      completedEmpty: false,
      error: null,
      truncated: false,
    };
  const lines = text.endsWith('\n')
    ? text.slice(0, -1).split('\n')
    : text.split('\n');
  if (lines.length > 4) return invalid('too-many-records', true);
  if (lines.some((line) => line.length === 0)) return invalid('empty-record');
  const records = [];
  let previousTicks;
  for (let index = 0; index < lines.length; index++) {
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      return invalid('malformed-json');
    }
    if (!record || Array.isArray(record) || typeof record !== 'object')
      return invalid('record-not-object');
    const keys = Object.keys(record).sort();
    if (
      keys.join(',') !== 'powershellPid,schemaVersion,sequence,stage,utcTicks'
    )
      return invalid('invalid-record-keys');
    if (
      record.schemaVersion !== 1 ||
      record.sequence !== index + 1 ||
      !WINDOWS_ADMISSION_EMISSION_STAGES.includes(record.stage) ||
      record.powershellPid !== expectedQueryPid ||
      typeof record.utcTicks !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(record.utcTicks)
    )
      return invalid('invalid-record-value');
    const ticks = BigInt(record.utcTicks);
    if (previousTicks !== undefined && ticks < previousTicks)
      return invalid('ticks-out-of-order');
    previousTicks = ticks;
    records.push({ ...record });
  }
  const stages = records.map(({ stage }) => stage);
  const full = WINDOWS_ADMISSION_EMISSION_STAGES;
  const completedEmpty =
    stages.length === 3 &&
    stages[0] === 'script-enter' &&
    stages[1] === 'pre-cim' &&
    stages[2] === 'post-pipeline';
  const complete =
    stages.length === full.length &&
    stages.every((stage, index) => stage === full[index]);
  const prefix = stages.every((stage, index) => stage === full[index]);
  if (!completedEmpty && !complete && !prefix)
    return invalid('stages-out-of-order');
  return {
    status: completedEmpty || complete ? 'valid' : 'partial',
    recordCount: records.length,
    records,
    completedEmpty,
    error: null,
    truncated: false,
  };
}

const WINDOWS_CREATION_IDENTITY_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/;

function canonicalWindowsCreationIdentity(value) {
  if (typeof value !== 'string') return undefined;
  const match = WINDOWS_CREATION_IDENTITY_PATTERN.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return undefined;
  return value;
}

function processTreePids(rows, rootLineages) {
  if (Number.isInteger(rootLineages)) {
    const selected = new Set([rootLineages]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!selected.has(row.parentPid) || selected.has(row.pid)) continue;
        selected.add(row.pid);
        changed = true;
      }
    }
    return Array.from(selected).reverse();
  }
  const selected = new Map(rootLineages);
  let unverified = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parentSelected = selected.has(row.parentPid);
      if (row.rejected) {
        if (parentSelected || selected.has(row.pid)) unverified = true;
        continue;
      }
      if (!parentSelected || selected.has(row.pid)) continue;
      const parentCreationIdentity = canonicalWindowsCreationIdentity(
        selected.get(row.parentPid),
      );
      const childCreationIdentity = canonicalWindowsCreationIdentity(
        row.creationDate,
      );
      if (!parentCreationIdentity || !childCreationIdentity) {
        unverified = true;
        continue;
      }
      if (childCreationIdentity < parentCreationIdentity) continue;
      selected.set(row.pid, childCreationIdentity);
      changed = true;
    }
  }
  return { pids: Array.from(selected.keys()).reverse(), unverified };
}

/**
 * Revalidate a remembered POSIX process group without trusting its bare pgid.
 * `kill(-pgid, 0)` is deliberately insufficient: it proves that some group
 * exists, not that the group is still the one this harness observed.
 *
 * When the leader is gone, ownership is intentionally leak-biased and needs a
 * recorded member identity. Signaling an unproven, potentially recycled group
 * is worse than leaving behind a process spawned between refreshes.
 */
export function posixProcessGroupIsOwned(group, rows) {
  const leader = rows.find((row) => row.pid === group.pgid);
  if (leader) {
    return leader.pgid === group.pgid && leader.startTime === group.leaderStart;
  }
  const members =
    group.members instanceof Map ? group.members : new Map(group.members ?? []);
  return rows.some(
    (row) => row.pgid === group.pgid && members.get(row.pid) === row.startTime,
  );
}

/**
 * The daemon a spec keeps across an app quit (CAN-5862), from the retain
 * record `closeCanopy` writes before it quits the app. `null` when there is
 * no record or it is not this launch's: a record that can't be trusted
 * retains nothing.
 */
export function readRetainedRoot(retainFile, runNonce, readFile) {
  if (!retainFile || !runNonce) return null;
  const identity = (value) =>
    Number.isInteger(value?.pid) &&
    value.pid > 1 &&
    typeof value.startTime === 'string' &&
    value.startTime
      ? { pid: value.pid, startTime: value.startTime }
      : null;
  try {
    const record = JSON.parse(String(readFile(retainFile, 'utf8')));
    const root = identity(record);
    if (record?.v !== 1 || record.nonce !== runNonce || !root) return null;
    // The test worker that retained it; without one the tree has no owner.
    return { ...root, controller: identity(record.controller) };
  } catch {
    return null;
  }
}

/**
 * After the app exits, keep a retained daemon's tree only for as long as the
 * test worker that retained it lives, then reap it (CAN-5862): a worker that
 * is killed or crashes before its cleanup can't leak the daemon into later
 * tests. The watchdog runs this once it has ended the rest of the tree.
 * Resolves once the retained tree is gone: `none` with no record, `gone`
 * when the worker's cleanup ended it, `reaped` when this did.
 */
export async function holdRetainedTree({
  retainFile,
  runNonce,
  readFile = readFileSync,
  listProcesses = listPosixProcesses,
  killTree = killProcessTree,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 1_000,
  maxListFailures = 30,
  // Retained processes the tree owner already identified (PID to start
  // time), so one the daemon left behind before the first snapshot counts.
  known: seed = new Map(),
} = {}) {
  const root = readRetainedRoot(retainFile, runNonce, readFile);
  if (!root) return 'none';
  const known = new Map(seed);
  let failures = 0;
  for (;;) {
    let rows;
    try {
      rows = await listProcesses();
      failures = 0;
    } catch {
      // Without snapshots nothing can be revalidated; leave the tree alone.
      if ((failures += 1) >= maxListFailures) return 'unverified';
      await delay(pollIntervalMs);
      continue;
    }
    const tree = retainedTreeRows(rows, root, known);
    if (tree.length === 0) return 'gone';
    const controller = root.controller
      ? rows.find((row) => row.pid === root.controller.pid)
      : undefined;
    if (!controller || controller.startTime !== root.controller.startTime) {
      const groups = new Set(tree.map((row) => row.pgid));
      for (const pgid of groups) if (pgid > 1) await killTree(pgid, 'SIGKILL');
      return 'reaped';
    }
    await delay(pollIntervalMs);
  }
}

/**
 * The retained root and every process below it, when the root is still the
 * process the record names. The daemon, its pipeline host and each step run
 * in their own process groups, all below the daemon.
 */
export function retainedProcessPids(rows, root) {
  if (!root) return new Set();
  const row = rows.find((candidate) => candidate.pid === root.pid);
  if (!row || row.startTime !== root.startTime) return new Set();
  return new Set(processTreePids(rows, root.pid));
}

/**
 * Every process of a retained tree: the processes below the root while it
 * lives, every process the tree held before (by PID and start time), and
 * their descendants. A pipeline host or step that outlives the daemon is
 * reparented away from it, so `known`, which this updates in place, keeps
 * it in the tree.
 */
export function retainedTreeRows(rows, root, known = new Map()) {
  const selected = retainedProcessPids(rows, root);
  for (const row of rows)
    if (known.get(row.pid) === row.startTime) selected.add(row.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (selected.has(row.parentPid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
  }
  const tree = rows.filter((row) => selected.has(row.pid));
  for (const row of tree) known.set(row.pid, row.startTime);
  return tree;
}

/** Whether a tracked group has a current member in the retained tree. */
export function groupIsRetained(group, rows, retained) {
  return (
    retained.size > 0 &&
    rows.some((row) => row.pgid === group.pgid && retained.has(row.pid))
  );
}

export function createProcessTreeOwner(child, options = {}) {
  const isAlive = options.isAlive ?? (() => processGroupExists(child.pid));
  const killTree = options.killProcessTree ?? killProcessTree;
  const wait =
    options.delay ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const graceMs = options.graceMs ?? SUPERVISOR_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => performance.now());
  let stopping;

  return {
    async isAlive() {
      return Boolean(await isAlive());
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (!(await isAlive())) return;
        await killTree(child.pid, 'SIGTERM');
        const deadline = now() + graceMs;
        let alive = await isAlive();
        while (alive && now() < deadline) {
          const waitMs = Math.min(pollIntervalMs, deadline - now());
          await wait(waitMs);
          alive = await isAlive();
        }
        if (alive) {
          await killTree(child.pid, 'SIGKILL');
        }
      })();
      return stopping;
    },
  };
}

function completedEnumerationFromRows(
  rows,
  rootPid,
  durationMs,
  timeoutMs = PROCESS_LIST_TIMEOUT_MS,
) {
  const rootRows = rows.filter((row) => row.pid === rootPid).slice(0, 2);
  return {
    outcome: 'completed',
    durationMs,
    timeoutMs,
    outputState: 'completed',
    outputBytes: null,
    lineCount: rows.length,
    acceptedCount: rows.length,
    rejectedCount: 0,
    rootCandidateCount: rows.filter((row) => row.pid === rootPid).length,
    rootCandidates: rootRows.map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      creationDatePresent: Boolean(row.creationDate),
      accepted: true,
      creationIdentity: boundedJsonString(row.creationDate, 128).value,
    })),
    fieldTruncationCount: rootRows.filter(
      (row) => boundedJsonString(row.creationDate, 128).truncated,
    ).length,
    error: null,
  };
}

function completedEnumerationWithoutRowReads(
  durationMs,
  timeoutMs = PROCESS_LIST_TIMEOUT_MS,
) {
  return {
    outcome: 'completed',
    durationMs,
    timeoutMs,
    outputState: 'completed',
    outputBytes: null,
    lineCount: null,
    acceptedCount: null,
    rejectedCount: null,
    rootCandidateCount: null,
    rootCandidates: [],
    fieldTruncationCount: 0,
    error: null,
  };
}

function failedEnumeration(
  error,
  rootPid,
  durationMs,
  timeoutMs = PROCESS_LIST_TIMEOUT_MS,
) {
  const stdout = safeProperty(error, 'stdout');
  const metadata = safeProperty(error, 'enumerationMetadata');
  const partialOutput =
    typeof stdout === 'string'
      ? parseWindowsProcessList(stdout, rootPid)
      : null;
  const captured = boundedError(error);
  const metadataFailure = safeProperty(metadata, 'failureCategory');
  const failureCategory =
    metadataFailure === 'identity'
      ? 'identity'
      : metadataFailure === 'protocol' || metadataFailure === 'stderr'
        ? 'protocol'
        : captured.error.code !== null ||
            captured.error.signal !== null ||
            captured.error.killed !== null
          ? 'execution'
          : null;
  return {
    outcome: 'error',
    durationMs,
    timeoutMs,
    outputState: partialOutput ? 'partial' : 'unavailable',
    outputBytes: partialOutput ? Buffer.byteLength(stdout) : null,
    lineCount: partialOutput?.metadata.lineCount ?? null,
    acceptedCount: partialOutput?.metadata.acceptedCount ?? null,
    rejectedCount: partialOutput?.metadata.rejectedCount ?? null,
    rootCandidateCount: partialOutput?.metadata.rootCandidateCount ?? null,
    rootCandidates: partialOutput?.metadata.rootCandidates ?? [],
    phases:
      typeof stdout === 'string'
        ? parseWindowsEnumerationPhases(stdout)
        : {
            psReady: false,
            cimFirstRow: false,
            cimComplete: false,
          },
    fieldTruncationCount:
      captured.fieldTruncationCount +
      (partialOutput?.metadata.fieldTruncationCount ?? 0),
    failureCategory,
    error: captured.error,
  };
}

const WINDOWS_ROOT_LIFECYCLES = new Set(['direct-child', 'external-pid']);

function resolveWindowsRootLifecycle(value) {
  const lifecycle = value === undefined ? 'direct-child' : value;
  if (!WINDOWS_ROOT_LIFECYCLES.has(lifecycle))
    throw new TypeError('Invalid Windows process root lifecycle');
  return lifecycle;
}

export function createWindowsProcessTreeOwner(child, options = {}) {
  const rootLifecycle = resolveWindowsRootLifecycle(options.rootLifecycle);
  const listProcesses = options.listProcesses ?? listWindowsProcesses;
  const filterInitialIdentity =
    options[FILTER_INITIAL_WINDOWS_IDENTITY] === true;
  const isProcessAlive = options.isProcessAlive ?? processExists;
  const killTree = options.killProcessTree ?? killProcessTree;
  let trackedProcesses = new Map();
  let ownedLineages = new Map([[child.pid, undefined]]);
  let retiredPids = new Set();
  let rootCreationDate;
  let inFlightRefresh;
  let inFlightRefreshId;
  let refreshCount = 0;
  let enumerationSequence = 0;
  let initialDiagnosticSnapshot;
  const observeOperation = (stage, details = {}) => {
    try {
      options.observeOperation?.(stage, details);
    } catch {
      /* A rejected observer cannot alter ownership or trigger operations. */
    }
  };
  const observeFinalResult = (project) => {
    try {
      if (
        Object.getOwnPropertyDescriptor(
          options.observeOperation ?? {},
          'ownershipDiagnostics',
        )?.value === true
      )
        observeOperation('final-result', project());
    } catch {
      /* Final diagnostics cannot replace ownership outcomes. */
    }
  };
  let wrapperExitObserved = false;
  let wrapperCloseObserved = false;
  child.once?.('exit', () => {
    wrapperExitObserved = true;
  });
  child.once?.('close', () => {
    wrapperCloseObserved = true;
  });
  const wrapperExited = () =>
    wrapperExitObserved ||
    wrapperCloseObserved ||
    child.exitCode != null ||
    child.signalCode != null;
  let integrityObserved = false;
  const observeIntegrity = (
    phase,
    queryId,
    pid,
    reason,
    observedRow,
    enumeration,
    kind = 'contradiction',
  ) => {
    if (integrityObserved) return;
    integrityObserved = true;
    try {
      observeOperation('ownership-integrity', {
        phase,
        queryId,
        pid,
        kind,
        role:
          pid === child.pid
            ? 'wrapper'
            : ownedLineages.has(pid)
              ? 'target'
              : 'descendant',
        reason,
        admittedIdentity: boundedJsonString(
          trackedProcesses.get(pid) ?? ownedLineages.get(pid),
          128,
        ).value,
        observedIdentity: boundedJsonString(
          safeProperty(observedRow, 'creationDate'),
          128,
        ).value,
        wrapperExited: wrapperExited(),
        wrapperExitObserved,
        wrapperCloseObserved,
        wrapperExitCode: child.exitCode ?? null,
        wrapperSignalCode: child.signalCode ?? null,
        protocol: enumeration?.phases ?? null,
        protocolValid: enumeration?.protocolValid ?? null,
        validatedPhase: enumeration?.validatedPhase ?? null,
        acceptedCount: enumeration?.acceptedCount ?? null,
        rejectedCount: enumeration?.rejectedCount ?? null,
        outputBytes: enumeration?.outputBytes ?? null,
        stderrBytes: enumeration?.stderrBytes ?? null,
        stderrPresent:
          enumeration?.stderrPresent ??
          (typeof enumeration?.stderrBytes === 'number'
            ? enumeration.stderrBytes > 0
            : null),
        enumerationOutcome: enumeration?.outcome ?? null,
        failureCategory: enumeration?.failureCategory ?? null,
      });
    } catch {
      /* Evidence never authorizes or changes ownership. */
    }
  };
  const observedIdentities = options.observeRefresh
    ? new Map([[child.pid, undefined]])
    : undefined;
  const observeRefresh = (rows, status) => {
    if (!observedIdentities) return;
    try {
      const identities = [...observedIdentities].map(([pid, captured]) => {
        const row = rows?.find((row) => row.pid === pid);
        const admitted = trackedProcesses.get(pid);
        if (captured === undefined && admitted !== undefined) {
          captured = admitted;
          observedIdentities.set(pid, captured);
        }
        return {
          pid,
          role: pid === child.pid ? 'wrapper' : 'target',
          creationIdentity:
            captured === undefined ? null : String(captured).slice(0, 128),
          observedIdentity: row
            ? boundedJsonString(row.creationDate, 128).value
            : null,
          present: rows ? !!row : null,
          status: !rows
            ? 'unavailable'
            : captured === undefined
              ? 'unavailable'
              : retiredPids.has(pid) || (row && row.creationDate !== captured)
                ? 'retired'
                : row?.creationDate === captured
                  ? 'matching'
                  : 'not-present',
        };
      });
      options.observeRefresh({
        status,
        observedAt: new Date().toISOString(),
        identities,
      });
    } catch {
      /* A rejected observer cannot alter ownership or trigger queries. */
    }
  };
  const initialAbortController = new AbortController();
  let initialAdmissionPending = filterInitialIdentity;
  let initialAdmissionCancelled = false;
  let initialAdmissionDeadline;
  let initialAdmissionOrigin;
  let initialAbortRelease;
  let initialAbortSent = false;
  const abortInitialAdmission = () => {
    initialAdmissionCancelled = true;
    if (!initialAbortSent) {
      initialAbortSent = true;
      initialAbortRelease = sendWindowsRelease(child, false);
    }
  };
  const cancelInitialAdmission = () => {
    if (!initialAdmissionPending) return;
    abortInitialAdmission();
    initialAbortController.abort();
  };
  const retainInitialDiagnostic = (buildSnapshot) => {
    try {
      initialDiagnosticSnapshot = buildSnapshot();
    } catch {
      initialDiagnosticSnapshot = undefined;
    }
  };

  const performRefresh = async (phase, queryId) => {
    const initialRefresh = refreshCount === 0;
    refreshCount += 1;
    const startedAt = performance.now();
    let enumeration;
    let enumerationObserved = false;
    let enumerationSettled = false;
    let failureStage = 'enumeration';
    const timeoutMs =
      phase === 'cleanup-refresh' || phase === 'final-verification'
        ? WINDOWS_CLEANUP_PROCESS_LIST_TIMEOUT_MS
        : PROCESS_LIST_TIMEOUT_MS;
    try {
      const initialQuery = initialRefresh && filterInitialIdentity;
      const enumerate =
        initialQuery && !options.listProcesses
          ? (queryOptions) => listInitialWindowsIdentity(queryOptions, options)
          : listProcesses;
      observeOperation('enumeration', {
        outcome: 'entered',
        phase,
        queryId,
      });
      const rows = await enumerate({
        rootPid: child.pid,
        timeoutMs,
        ...(initialQuery
          ? {
              signal: initialAbortController.signal,
              onFailure: abortInitialAdmission,
              setAdmissionDeadline: (deadline, origin) => {
                initialAdmissionDeadline = deadline;
                initialAdmissionOrigin = origin;
              },
            }
          : {}),
        filterPid:
          initialRefresh && filterInitialIdentity ? child.pid : undefined,
        observe: (snapshot) => {
          if (enumeration === undefined) {
            enumeration = snapshot;
            enumerationObserved = true;
          }
        },
      });
      enumerationSettled = true;
      observeOperation('enumeration', {
        outcome: 'fulfilled',
        phase,
        queryId,
      });
      if (initialQuery && initialAdmissionCancelled) {
        if (enumeration)
          Object.assign(enumeration, {
            outcome: 'error',
            failureCategory: 'cancelled',
          });
        throw new Error('Initial Windows ownership admission cancelled');
      }
      failureStage = 'identity-processing';
      if (initialRefresh && enumeration === undefined) {
        enumeration = completedEnumerationWithoutRowReads(
          performance.now() - startedAt,
          timeoutMs,
        );
      }
      const nextTrackedProcesses = new Map(trackedProcesses);
      const nextOwnedLineages = new Map(ownedLineages);
      const nextRetiredPids = new Set(retiredPids);
      let nextRootCreationDate = rootCreationDate;
      const rejectedRows = rows[WINDOWS_REJECTED_PROCESS_ROWS] ?? [];
      const knownLineagePids = new Set([
        ...nextOwnedLineages.keys(),
        ...nextTrackedProcesses.keys(),
      ]);
      if (
        rejectedRows.some(
          (row) =>
            knownLineagePids.has(row.pid) ||
            knownLineagePids.has(row.parentPid),
        )
      )
        throw new Error('Unverifiable Windows process creation chronology');
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const root = byPid.get(child.pid);
      if (
        trackedProcesses.has(child.pid) &&
        root?.creationDate !== rootCreationDate &&
        rootLifecycle === 'direct-child' &&
        !wrapperExited()
      ) {
        observeIntegrity(
          phase,
          queryId,
          child.pid,
          root ? 'identity-mismatch' : 'missing',
          root,
          enumeration,
        );
        throw new Error(
          'Live Windows wrapper identity contradicts enumeration',
        );
      }
      if (!nextRootCreationDate && root?.creationDate) {
        nextRootCreationDate = root.creationDate;
      }
      if (nextRootCreationDate && root?.creationDate === nextRootCreationDate) {
        const validLineages = new Map();
        for (const [pid, creationDate] of nextOwnedLineages) {
          const row = byPid.get(pid);
          if (!row) {
            validLineages.set(pid, creationDate);
          } else if (creationDate === undefined) {
            nextOwnedLineages.set(pid, row.creationDate);
            validLineages.set(pid, row.creationDate);
          } else if (row.creationDate === creationDate) {
            validLineages.set(pid, creationDate);
          } else {
            nextOwnedLineages.delete(pid);
            nextTrackedProcesses.delete(pid);
            nextRetiredPids.add(pid);
          }
        }
        const lineage = processTreePids(
          [...rows, ...rejectedRows],
          validLineages,
        );
        if (lineage.unverified)
          throw new Error('Unverifiable Windows process creation chronology');
        for (const pid of lineage.pids) {
          const row = byPid.get(pid);
          if (!row?.creationDate || nextRetiredPids.has(pid)) continue;
          const creationDate = nextTrackedProcesses.get(pid);
          if (creationDate === undefined) {
            nextTrackedProcesses.set(pid, row.creationDate);
          } else if (creationDate !== row.creationDate) {
            nextTrackedProcesses.delete(pid);
            nextRetiredPids.add(pid);
          }
        }
      } else if (
        root &&
        rows.some(
          (row) => row.parentPid === child.pid && row.pid !== child.pid,
        ) &&
        (!canonicalWindowsCreationIdentity(nextRootCreationDate) ||
          !canonicalWindowsCreationIdentity(root.creationDate))
      ) {
        throw new Error('Unverifiable Windows process creation chronology');
      }
      for (const [pid, creationDate] of nextTrackedProcesses) {
        if (byPid.get(pid)?.creationDate !== creationDate) {
          nextTrackedProcesses.delete(pid);
          nextRetiredPids.add(pid);
        }
      }
      // Commit only after every reachable row and chronology check succeeds.
      for (const pid of nextRetiredPids) {
        if (!retiredPids.has(pid)) {
          const row = byPid.get(pid);
          observeIntegrity(
            phase,
            queryId,
            pid,
            row ? 'identity-mismatch' : 'missing',
            row,
            enumeration,
            'retirement',
          );
          break;
        }
      }
      rootCreationDate = nextRootCreationDate;
      ownedLineages = nextOwnedLineages;
      trackedProcesses = nextTrackedProcesses;
      retiredPids = nextRetiredPids;
      if (initialRefresh && !enumerationObserved) {
        try {
          enumeration = completedEnumerationFromRows(
            rows,
            child.pid,
            enumeration.durationMs,
            timeoutMs,
          );
        } catch {
          // Fallback metadata is collected only after the ownership decision.
        }
      }
      if (initialRefresh) {
        retainInitialDiagnostic(() => {
          const tracked = trackedProcesses.has(child.pid);
          const creationIdentity = boundedJsonString(rootCreationDate, 128);
          return {
            observedAt: new Date().toISOString(),
            ownershipOutcome: tracked ? 'ready' : 'completed-root-missing',
            enumeration,
            identityError: null,
            root: {
              tracked,
              ready: tracked,
              creationIdentity: creationIdentity.value,
            },
            fieldTruncationCount:
              (enumeration?.fieldTruncationCount ?? 0) +
              (creationIdentity.truncated ? 1 : 0),
          };
        });
      }
      observeRefresh(rows, 'completed');
      return true;
    } catch (error) {
      observeIntegrity(
        phase,
        queryId,
        child.pid,
        failureStage === 'identity-processing'
          ? 'rejected-row'
          : 'protocol-incomplete',
        undefined,
        safeProperty(error, 'enumerationMetadata') ?? enumeration,
      );
      if (!enumerationSettled)
        observeOperation('enumeration', {
          outcome: 'rejected',
          phase,
          queryId,
          enumeration:
            safeProperty(error, 'enumerationMetadata') ?? enumeration,
          error: boundedError(error, { messageBytes: 512 }).error,
        });
      if (initialRefresh) {
        retainInitialDiagnostic(() => {
          enumeration ??= failedEnumeration(
            error,
            child.pid,
            performance.now() - startedAt,
            timeoutMs,
          );
          const identityError =
            failureStage === 'identity-processing' ? boundedError(error) : null;
          const creationIdentity = boundedJsonString(rootCreationDate, 128);
          return {
            observedAt: new Date().toISOString(),
            ownershipOutcome:
              failureStage === 'enumeration'
                ? 'enumeration-error'
                : 'identity-processing-error',
            enumeration,
            identityError: identityError?.error ?? null,
            root: {
              tracked: trackedProcesses.has(child.pid),
              ready: false,
              creationIdentity: creationIdentity.value,
            },
            fieldTruncationCount:
              (enumeration.fieldTruncationCount ?? 0) +
              (identityError?.fieldTruncationCount ?? 0) +
              (creationIdentity.truncated ? 1 : 0),
          };
        });
      }
      observeRefresh(undefined, 'unavailable');
      // Do not use bare PIDs when stable identities cannot be revalidated.
      return false;
    }
  };
  const refresh = (phase = 'periodic') => {
    if (inFlightRefresh) {
      observeOperation('enumeration-joined', {
        phase,
        queryId: inFlightRefreshId,
      });
      return inFlightRefresh;
    }
    const queryId = ++enumerationSequence;
    inFlightRefreshId = queryId;
    inFlightRefresh = performRefresh(phase, queryId).finally(() => {
      inFlightRefresh = undefined;
      inFlightRefreshId = undefined;
    });
    return inFlightRefresh;
  };
  const initialized = refresh('initial').then(
    (refreshed) => refreshed && trackedProcesses.has(child.pid),
  );
  const isAlive = async () => {
    await initialized;
    return Array.from(trackedProcesses.keys()).some(isProcessAlive);
  };
  // A filtered query validates only this captured identity. It must never
  // flow through refresh(), whose rows are authoritative for the whole tree.
  const revalidateCandidate = async (pid, creationDate) => {
    const queryId = ++enumerationSequence;
    const phase = 'cleanup-refresh';
    observeOperation('enumeration', { outcome: 'entered', phase, queryId });
    let enumeration;
    try {
      const rows = await listProcesses({
        rootPid: pid,
        filterPid: pid,
        timeoutMs: WINDOWS_CLEANUP_PROCESS_LIST_TIMEOUT_MS,
        observe: (snapshot) => {
          enumeration = snapshot;
        },
      });
      if (!Array.isArray(rows) || rows.length > 1)
        throw new Error('Ambiguous filtered Windows process identity');
      const row = rows[0];
      if (
        row &&
        (row.pid !== pid ||
          !Number.isSafeInteger(row.parentPid) ||
          row.parentPid < 0 ||
          typeof row.creationDate !== 'string' ||
          !row.creationDate.trim())
      )
        throw new Error('Malformed filtered Windows process identity');
      if (
        enumeration &&
        (enumeration.outcome !== 'completed' ||
          enumeration.rootCandidateCount !== rows.length ||
          enumeration.acceptedCount !== rows.length)
      )
        throw new Error('Ambiguous filtered Windows process identity');
      observeOperation('enumeration', { outcome: 'fulfilled', phase, queryId });
      if (row?.creationDate !== creationDate) {
        observeIntegrity(
          phase,
          queryId,
          pid,
          row ? 'identity-mismatch' : 'missing',
          row,
          enumeration,
          pid === child.pid &&
            rootLifecycle === 'direct-child' &&
            !wrapperExited()
            ? 'contradiction'
            : 'retirement',
        );
        if (
          pid === child.pid &&
          rootLifecycle === 'direct-child' &&
          !wrapperExited()
        )
          return false;
        trackedProcesses.delete(pid);
        // Absence retires the candidate, but its admitted lineage can still
        // identify a late descendant in the next full refresh. PID reuse cannot.
        if (row) ownedLineages.delete(pid);
        retiredPids.add(pid);
        return false;
      }
      return (
        trackedProcesses.get(pid) === creationDate && !retiredPids.has(pid)
      );
    } catch (error) {
      observeIntegrity(
        phase,
        queryId,
        pid,
        'protocol-incomplete',
        undefined,
        safeProperty(error, 'enumerationMetadata') ?? enumeration,
      );
      observeOperation('enumeration', {
        outcome: 'rejected',
        phase,
        queryId,
        enumeration: safeProperty(error, 'enumerationMetadata') ?? enumeration,
        error: boundedError(error, { messageBytes: 512 }).error,
      });
      // An unavailable candidate is not permission to signal it, nor a reason
      // to starve another independently revalidated owned identity.
      return false;
    }
  };
  let cleanupSnapshotReported = false;
  const killTrackedTree = async (_rootPid, signal) => {
    await initialized;
    const refreshed = await refresh('cleanup-refresh');
    if (options.onCleanupSnapshot && !cleanupSnapshotReported && refreshed) {
      cleanupSnapshotReported = true;
      options.onCleanupSnapshot(trackedProcesses.has(child.pid));
    }
    if (!refreshed) return;
    const candidates = Array.from(trackedProcesses.entries()).reverse();
    const priority = ([pid, creationDate]) =>
      ownedLineages.get(pid) === creationDate ? (pid === child.pid ? 1 : 0) : 2;
    candidates.sort((left, right) => priority(left) - priority(right));
    for (const [pid, creationDate] of candidates) {
      if (retiredPids.has(pid) || trackedProcesses.get(pid) !== creationDate)
        continue;
      if (await revalidateCandidate(pid, creationDate)) {
        const identity = String(creationDate).slice(0, 128);
        observeOperation('signal', {
          outcome: 'entered',
          pid,
          creationIdentity: identity,
          signal,
        });
        try {
          await killTree(pid, signal);
          observeOperation('signal', {
            outcome: 'fulfilled',
            pid,
            creationIdentity: identity,
            signal,
          });
        } catch (error) {
          observeOperation('signal', {
            outcome: 'rejected',
            pid,
            creationIdentity: identity,
            signal,
            error: boundedError(error, { messageBytes: 512 }).error,
          });
          throw error;
        }
      }
    }
  };

  const treeOwner = createProcessTreeOwner(child, {
    ...options,
    isAlive,
    killProcessTree: killTrackedTree,
  });
  const stopTree = treeOwner.stop;
  let stopping;
  return Object.assign(treeOwner, {
    ready: initialized,
    refresh,
    stop() {
      cancelInitialAdmission();
      stopping ??= (async () => {
        // The supervisor stops its refresh producers at cleanup entry. Drain
        // their old snapshot so the first TERM query is fresh for release.
        if (options.onCleanupSnapshot && inFlightRefresh) {
          const queryId = inFlightRefreshId;
          observeOperation('in-flight-refresh', {
            outcome: 'entered',
            queryId,
          });
          try {
            await inFlightRefresh;
            observeOperation('in-flight-refresh', {
              outcome: 'fulfilled',
              queryId,
            });
          } catch (error) {
            observeOperation('in-flight-refresh', {
              outcome: 'rejected',
              queryId,
              error: boundedError(error, { messageBytes: 512 }).error,
            });
            throw error;
          }
        }
        await stopTree();
        // A polling snapshot started before the last signal is not proof of
        // cleanup. Drain it before requesting the final bounded enumeration.
        if (inFlightRefresh) {
          const queryId = inFlightRefreshId;
          observeOperation('in-flight-refresh', {
            outcome: 'entered',
            queryId,
          });
          try {
            await inFlightRefresh;
            observeOperation('in-flight-refresh', {
              outcome: 'fulfilled',
              queryId,
            });
          } catch (error) {
            observeOperation('in-flight-refresh', {
              outcome: 'rejected',
              queryId,
              error: boundedError(error, { messageBytes: 512 }).error,
            });
            throw error;
          }
        }
        observeOperation('final-verification', { outcome: 'entered' });
        try {
          if (!(await refresh('final-verification'))) {
            observeFinalResult(() => ({
              resultKind: 'enumeration-unavailable',
            }));
            throw new Error('Windows process cleanup verification unavailable');
          }
          const survivors = [...trackedProcesses.keys()].filter(isProcessAlive);
          observeFinalResult(() => ({
            resultKind: survivors.length ? 'survivors' : 'verified-empty',
            survivorCount: survivors.length,
            survivors: survivors.slice(0, 16).map((pid) => ({
              pid,
              creationIdentity: trackedProcesses.get(pid),
            })),
          }));
          if (survivors.length) {
            throw new Error(
              `Windows process cleanup left owned processes alive: ${survivors.join(', ')}`,
            );
          }
          observeOperation('final-verification', { outcome: 'fulfilled' });
        } catch (error) {
          observeOperation('final-verification', {
            outcome: 'rejected',
            error: boundedError(error, { messageBytes: 512 }).error,
          });
          throw error;
        }
      })();
      return stopping;
    },
    takeInitialRelease() {
      if (!filterInitialIdentity) return undefined;
      if (
        !initialAbortSent &&
        initialAdmissionDeadline !== undefined &&
        (options.now ?? (() => performance.now()))() >= initialAdmissionDeadline
      ) {
        abortInitialAdmission();
        if (initialDiagnosticSnapshot) {
          initialDiagnosticSnapshot.ownershipOutcome = 'enumeration-error';
          initialDiagnosticSnapshot.root.ready = false;
          Object.assign(initialDiagnosticSnapshot.enumeration, {
            outcome: 'error',
            failureCategory: 'timeout',
            timeoutPhase: 'completion',
            failureElapsedMs:
              (options.now ?? (() => performance.now()))() -
              initialAdmissionOrigin,
          });
        }
      }
      initialAdmissionPending = false;
      return initialAbortRelease;
    },
    getInitialDiagnosticSnapshot() {
      return initialDiagnosticSnapshot;
    },
    trackOwnedPid(pid) {
      if (
        Number.isInteger(pid) &&
        pid > 0 &&
        !retiredPids.has(pid) &&
        !ownedLineages.has(pid)
      ) {
        ownedLineages.set(pid, undefined);
        if (observedIdentities && observedIdentities.size < 2)
          observedIdentities.set(pid, undefined);
      }
    },
  });
}

function sendWindowsRelease(child, owned) {
  const attemptedMessage = owned ? 'start' : 'abort';
  try {
    child.send(attemptedMessage);
    return {
      owned,
      attemptedMessage,
      sendOutcome: 'returned',
      returned: owned,
      error: null,
    };
  } catch (error) {
    const captured = boundedError(error);
    return {
      owned,
      attemptedMessage,
      sendOutcome: 'threw',
      returned: false,
      error: captured.error,
      fieldTruncationCount: captured.fieldTruncationCount,
    };
  }
}

export async function releaseWindowsSupervisedChild(
  child,
  owner,
  { observeRelease } = {},
) {
  const owned = await owner.ready;
  const snapshot =
    owner.takeInitialRelease?.() ?? sendWindowsRelease(child, owned);
  safeObserve(observeRelease, snapshot);
  return snapshot.returned;
}

function diagnosticRecord(context) {
  const owner = context.ownerSnapshot ?? {};
  const enumeration = owner.enumeration ?? {
    outcome: 'not-observed',
    durationMs: null,
    timeoutMs: PROCESS_LIST_TIMEOUT_MS,
    outputState: 'unavailable',
    outputBytes: null,
    lineCount: null,
    acceptedCount: null,
    rejectedCount: null,
    rootCandidateCount: null,
    rootCandidates: [],
    error: null,
  };
  const root = owner.root ?? {
    tracked: false,
    ready: false,
    creationIdentity: null,
  };
  const release = context.releaseSnapshot ?? {
    owned: false,
    attemptedMessage: 'not-observed',
    sendOutcome: 'not-observed',
    returned: false,
    error: null,
  };
  const fieldTruncationCount =
    (owner.fieldTruncationCount ?? 0) + (release.fieldTruncationCount ?? 0);
  return {
    schemaVersion: 1,
    stage: 'initial-launch',
    timestamp: owner.observedAt ?? new Date().toISOString(),
    platform: 'win32',
    supervisorPid: positivePid(context.supervisorPid),
    ownerPid: positivePid(context.ownerPid),
    childPid: positivePid(context.childPid),
    elapsedMs: finiteNumber(enumeration.durationMs),
    timeoutMs: PROCESS_LIST_TIMEOUT_MS,
    enumeration: {
      ...enumeration,
      timeoutMs: PROCESS_LIST_TIMEOUT_MS,
      rootCandidates: enumeration.rootCandidates.slice(0, 2),
    },
    ownership: {
      outcome: owner.ownershipOutcome ?? 'not-observed',
      identityError: owner.identityError ?? null,
      root,
    },
    release,
    truncated: fieldTruncationCount > 0,
    fieldTruncationCount,
  };
}

export function formatWindowsLaunchFailureDiagnostic(context) {
  try {
    const line = `${WINDOWS_LAUNCH_FAILURE_MARKER}${JSON.stringify(
      diagnosticRecord(context),
    )}\n`;
    if (Buffer.byteLength(line) <= WINDOWS_LAUNCH_FAILURE_MAX_BYTES) {
      return line;
    }
  } catch {
    // Fall through to the fixed, classification-preserving record.
  }
  return `${WINDOWS_LAUNCH_FAILURE_MARKER}${JSON.stringify({
    schemaVersion: 1,
    stage: 'initial-launch',
    platform: 'win32',
    supervisorPid: null,
    ownerPid: null,
    childPid: null,
    elapsedMs: null,
    timeoutMs: PROCESS_LIST_TIMEOUT_MS,
    enumeration: {
      outcome: 'not-observed',
      outputState: 'unavailable',
    },
    ownership: {
      outcome: 'not-observed',
      root: { tracked: false, ready: false },
    },
    release: {
      owned: false,
      attemptedMessage: 'not-observed',
      sendOutcome: 'not-observed',
      returned: false,
    },
    truncated: true,
    fieldTruncationCount: 1,
  })}\n`;
}

export function writeWindowsLaunchFailureEvidence(context, write) {
  if (safeProperty(context, 'released')) return;
  const output = write ?? ((chunk) => process.stderr.write(chunk));
  try {
    output(
      '[e2e-supervisor] Failed to establish Windows process ownership before launch\n',
    );
  } catch {
    // Failure evidence must not change the already-failed release decision.
  }
  let ownerSnapshot;
  try {
    ownerSnapshot = safeProperty(
      context,
      'owner',
    )?.getInitialDiagnosticSnapshot?.();
  } catch {
    ownerSnapshot = undefined;
  }
  const line = formatWindowsLaunchFailureDiagnostic({
    supervisorPid: safeProperty(context, 'supervisorPid'),
    ownerPid: safeProperty(context, 'ownerPid'),
    childPid: safeProperty(safeProperty(context, 'child'), 'pid'),
    ownerSnapshot,
    releaseSnapshot: safeProperty(context, 'releaseSnapshot'),
  });
  try {
    output(line);
  } catch {
    // Failure evidence must not change cleanup or exit behavior.
  }
}

const ACCEPTANCE_COMMAND_OBSERVER_LIFETIME_MS = 29 * 60_000;
const ACCEPTANCE_COMMAND_STAGES = new Set([
  'admission-emission-setup',
  'target-started-received',
  'controller-stop-requested',
  'target-exit-received',
  'cleanup-release-checkpoint',
  'supervisor-cleanup',
  'wrapper-exit',
  'wrapper-stdio-close',
  'supervisor-exit',
]);

function isAcceptanceCommand(args, env) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const prefix = [
    path.join(root, 'scripts/run-guarded-dev-script.mjs'),
    '--suite',
    'e2e',
    '--',
    process.execPath,
    path.join(root, 'node_modules/@playwright/test/cli.js'),
    'test',
  ];
  if (
    env[SUPERVISED_EXECUTABLE_ENV] !== process.execPath ||
    !prefix.every((value, index) => args[index] === value)
  )
    return false;
  const tail = args.slice(prefix.length);
  const same = (expected) =>
    tail.length === expected.length &&
    expected.every((value, index) => tail[index] === value);
  for (let shard = 1; shard <= 4; shard++) {
    if (
      same([
        'browser-profiles.spec.mjs',
        'browser-chrome.spec.mjs',
        '--project=electron',
        '--fully-parallel',
        '--workers=1',
        '--shard',
        `${shard}/4`,
        '--reporter=line,json',
        '--retries=0',
        `--output=.playwright/windows-full-shard-${shard}-of-4-results`,
      ])
    )
      return true;
  }
  if (
    same([
      'browser-chrome.spec.mjs',
      '--project=electron',
      '--workers=1',
      '--grep',
      '(?:^| )W1 precommit cowork retirement abort retains legacy login for first browser open$',
      '--max-failures=1',
      '--reporter=line,json',
      '--retries=0',
      '--output=.playwright/windows-cowork-worker-diagnostic-results',
    ])
  )
    return true;
  return (
    env.CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE === '1' &&
    same([
      'browser-profiles.spec.mjs',
      '--project=electron',
      '--fully-parallel',
      '--workers=1',
      '--grep',
      'acceptance controller owns and terminates its timeout fixture',
      '--reporter=line,json',
      '--retries=0',
      '--output=.playwright/windows-acceptance-controller-fixture-results',
    ])
  );
}

// Explanatory fixture diagnostics only. Never used as terminal cleanup proof.
function createWindowsOwnershipObserver(
  config,
  { currentPid, parentPid, now, write, start },
) {
  const file = config.file.replace(/-main\.jsonl$/, '-ownership.jsonl');
  const lifetime =
    config.mode === 'acceptance-command'
      ? ACCEPTANCE_COMMAND_OBSERVER_LIFETIME_MS
      : 180000;
  const counters = {
    seen: 0,
    written: 0,
    suppressed: 0,
    dropped: 0,
    invalidProjection: 0,
  };
  const pending = new Map();
  const reserved = new Set();
  let normalRows = 0,
    normalBytes = 0,
    reservedRows = 0,
    reservedBytes = 0,
    normalStopped = false;
  let preRows = 0,
    preBytes = 0,
    sequence = 0,
    stopped = false,
    failed = false;
  let expired = false,
    truncated = false,
    counterOverflow = false,
    armed = false,
    observationGap = false;
  let cleanupEntered = false,
    cleanupSettled = false,
    cleanupOutcome = 'unknown',
    exited = false,
    exitCode = null;
  let finalResult = 'unknown',
    lastRefresh,
    latestQuery = null,
    lastTime = start;
  const increment = (key) => {
    if (counters[key] < Number.MAX_SAFE_INTEGER) counters[key]++;
    else counterOverflow = true;
  };
  const invalid = () => increment('invalidProjection');
  const own = (object, key) => {
    if (!object || typeof object !== 'object') {
      invalid();
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) {
      invalid();
      return undefined;
    }
    return descriptor.value;
  };
  const typed = (object, key, accepts) => {
    const value = own(object, key);
    if (value === undefined) return undefined;
    if (accepts(value)) return value;
    invalid();
    return undefined;
  };
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const enumValue = (object, key, values) =>
    typed(object, key, (value) => values.includes(value));
  const boundedText = (object, key) => {
    const raw = typed(
      object,
      key,
      (value) => typeof value === 'string' || value === null,
    );
    const bounded = boundedJsonString(raw, 128);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  };
  const identities = (details, key, refresh) => {
    const input = own(details, key);
    if (!Array.isArray(input)) {
      invalid();
      return {};
    }
    const length = own(input, 'length');
    const result = [];
    let cut = length > 16;
    for (let i = 0; i < Math.min(length, 16); i++) {
      const item = own(input, String(i));
      const pid = typed(item, 'pid', positive);
      const raw = typed(
        item,
        'creationIdentity',
        (value) => typeof value === 'string' || (refresh && value === null),
      );
      if (pid === undefined || raw === undefined) {
        invalid();
        continue;
      }
      let creationIdentity = raw;
      if (typeof raw === 'string' && Buffer.byteLength(raw) > 128) {
        creationIdentity = '';
        for (const char of raw.slice(0, 128)) {
          if (Buffer.byteLength(creationIdentity + char) > 128) break;
          creationIdentity += char;
        }
        cut = true;
      }
      const row = { pid, creationIdentity };
      if (creationIdentity === null) observationGap = true;
      if (refresh) {
        if (own(item, 'observedIdentity') !== undefined)
          row.observedIdentity = boundedText(item, 'observedIdentity');
        row.present = typed(
          item,
          'present',
          (value) => typeof value === 'boolean' || value === null,
        );
        row.status = enumValue(item, 'status', [
          'unavailable',
          'retired',
          'matching',
          'not-present',
        ]);
        if (
          row.status === undefined ||
          row.status === 'unavailable' ||
          row.present === null ||
          row.present === undefined
        )
          observationGap = true;
      }
      result.push(row);
    }
    if (cut) truncated = true;
    return { [key]: result, truncated: cut };
  };
  const emit = (stage, details, critical = false, limit = 4096) => {
    if (failed) return false;
    if (!critical && normalStopped) {
      increment('dropped');
      return false;
    }
    const envelope = {
      schemaVersion: 1,
      producer: 'ownership',
      caseId: config.caseId,
      launchId: config.launchId,
      fixturePid: config.fixturePid,
      pid: currentPid,
      parentPid,
      sequence: sequence + 1,
      monotonicMs: lastTime,
      wallTime: new Date().toISOString(),
      stage,
    };
    let line = JSON.stringify({ ...envelope, ...details }) + '\n';
    for (const key of ['survivors', 'identities']) {
      while (Buffer.byteLength(line) > limit && details[key]?.length) {
        details[key].pop();
        details.truncated = true;
        truncated = true;
        line = JSON.stringify({ ...envelope, ...details }) + '\n';
      }
    }
    const bytes = Buffer.byteLength(line);
    if (
      bytes > limit ||
      (critical
        ? reservedRows >= 16 || reservedBytes + bytes > 16384
        : normalRows >= 224 ||
          normalBytes + bytes > 112 * 1024 ||
          (!cleanupEntered && (preRows >= 24 || preBytes + bytes > 12 * 1024)))
    ) {
      if (!critical && (normalRows >= 224 || normalBytes + bytes > 112 * 1024))
        normalStopped = true;
      increment('dropped');
      return false;
    }
    try {
      write(file, line);
    } catch {
      failed = true;
      stopped = true;
      return false;
    }
    sequence++;
    increment('written');
    if (critical) {
      reservedRows++;
      reservedBytes += bytes;
    } else {
      normalRows++;
      normalBytes += bytes;
      if (!cleanupEntered) {
        preRows++;
        preBytes += bytes;
      }
    }
    return true;
  };
  const critical = (key, stage, details, limit = 1024) => {
    if (reserved.has(key)) {
      increment('suppressed');
      return;
    }
    reserved.add(key);
    emit(stage, details, true, limit);
  };
  const summary = () =>
    critical(
      'summary',
      'summary',
      {
        armed,
        expired,
        truncated,
        writeFailed: failed,
        counterOverflow,
        observationGap,
        counters: { ...counters },
        cleanupEntered,
        cleanupSettled,
        cleanupOutcome,
        exitCode,
        finalResult,
        terminalObserved: cleanupEntered && cleanupSettled && exited,
        completeObservation:
          armed &&
          cleanupEntered &&
          cleanupSettled &&
          exited &&
          finalResult === 'verified-empty' &&
          cleanupOutcome === 'fulfilled' &&
          !expired &&
          !truncated &&
          !failed &&
          !counterOverflow &&
          !observationGap &&
          counters.dropped === 0 &&
          counters.invalidProjection === 0,
      },
      4096,
    );
  const observe = (stage, details = {}) => {
    if (stopped) return;
    try {
      increment('seen');
      const time = now();
      if (!Number.isFinite(time) || time < 0 || time < lastTime) {
        invalid();
        return;
      }
      lastTime = time;
      if (time - start >= lifetime) {
        expired = true;
        critical('expiry', 'observer-expired', {});
        summary();
        stopped = true;
        return;
      }
      let projected = {};
      if (stage === 'supervisor-cleanup') {
        const outcome = enumValue(details, 'outcome', [
          'entered',
          'fulfilled',
          'rejected',
        ]);
        if (!outcome || outcome === 'rejected') observationGap = true;
        if (!outcome) return;
        if (outcome === 'entered') cleanupEntered = true;
        else {
          cleanupSettled = true;
          cleanupOutcome = outcome;
        }
        critical(
          outcome === 'entered' ? 'cleanup-entered' : 'cleanup-settled',
          stage,
          { outcome },
        );
        return;
      }
      if (stage === 'supervisor-exit') {
        exited = true;
        exitCode = typed(details, 'code', Number.isSafeInteger) ?? null;
        if (exitCode === null) invalid();
        critical('exit', stage, { code: exitCode });
        summary();
        stopped = true;
        return;
      }
      if (stage === 'final-result') {
        finalResult =
          enumValue(details, 'resultKind', [
            'verified-empty',
            'survivors',
            'enumeration-unavailable',
            'other-error',
          ]) ?? 'unknown';
        if (finalResult !== 'verified-empty') observationGap = true;
        projected.resultKind = finalResult;
        const count = typed(
          details,
          'survivorCount',
          (value) => Number.isSafeInteger(value) && value >= 0,
        );
        if (count !== undefined) {
          projected.survivorCount = count;
          Object.assign(projected, identities(details, 'survivors', false));
          if (count > (projected.survivors?.length ?? 0)) {
            projected.truncated = true;
            truncated = true;
          }
        }
        critical('final-result', stage, projected, 4096);
        return;
      }
      if (stage === 'ownership-integrity') {
        projected.queryId = typed(details, 'queryId', positive);
        projected.identityPid = typed(details, 'pid', positive);
        projected.integrityKind = enumValue(details, 'kind', [
          'contradiction',
          'retirement',
        ]);
        projected.subtype = 'ownership-integrity';
        projected.status =
          projected.integrityKind === 'retirement'
            ? 'completed'
            : 'unavailable';
        if (projected.status === 'unavailable') observationGap = true;
        projected.phase = enumValue(details, 'phase', [
          'initial',
          'periodic',
          'cleanup-refresh',
          'final-verification',
        ]);
        projected.role = enumValue(details, 'role', [
          'wrapper',
          'target',
          'descendant',
        ]);
        projected.reason = enumValue(details, 'reason', [
          'missing',
          'identity-mismatch',
          'rejected-row',
          'protocol-incomplete',
        ]);
        for (const key of [
          'admittedIdentity',
          'observedIdentity',
          'validatedPhase',
          'wrapperSignalCode',
          'enumerationOutcome',
          'failureCategory',
        ])
          projected[key] = boundedText(details, key);
        for (const key of [
          'wrapperExited',
          'wrapperExitObserved',
          'wrapperCloseObserved',
          'protocolValid',
          'stderrPresent',
        ])
          projected[key] = typed(
            details,
            key,
            (value) => typeof value === 'boolean' || value === null,
          );
        for (const key of [
          'acceptedCount',
          'rejectedCount',
          'outputBytes',
          'stderrBytes',
        ])
          projected[key] = typed(
            details,
            key,
            (value) =>
              value === null || (Number.isSafeInteger(value) && value >= 0),
          );
        projected.wrapperExitCode = typed(
          details,
          'wrapperExitCode',
          (value) => value === null || Number.isSafeInteger(value),
        );
        const protocol = own(details, 'protocol');
        projected.protocol =
          protocol === null
            ? null
            : Object.fromEntries(
                ['psReady', 'cimFirstRow', 'cimComplete'].map((key) => [
                  key,
                  typed(protocol, key, (value) => typeof value === 'boolean'),
                ]),
              );
        projected.identities = [
          {
            pid: projected.identityPid,
            creationIdentity: projected.admittedIdentity,
            observedIdentity: projected.observedIdentity,
            present:
              projected.reason === 'missing'
                ? false
                : projected.reason === 'identity-mismatch'
                  ? true
                  : null,
            status:
              projected.integrityKind === 'retirement'
                ? 'retired'
                : 'unavailable',
          },
        ];
        critical('ownership-integrity', 'ownership-refresh', projected, 2048);
        return;
      }
      if (stage === 'ownership-refresh') {
        projected.status = enumValue(details, 'status', [
          'completed',
          'unavailable',
        ]);
        if (projected.status !== 'completed') observationGap = true;
        Object.assign(projected, identities(details, 'identities', true));
        const state = JSON.stringify(projected);
        if (state === lastRefresh) {
          increment('suppressed');
          return;
        }
        lastRefresh = state;
        projected.queryId =
          pending.size === 1
            ? pending.keys().next().value
            : pending.size === 0
              ? latestQuery
              : null;
        projected.association =
          projected.queryId === null ? 'ambiguous' : 'single-observed-query';
        latestQuery = null;
      } else if (
        [
          'enumeration',
          'enumeration-joined',
          'in-flight-refresh',
          'signal',
          'final-verification',
        ].includes(stage)
      ) {
        projected.outcome =
          stage === 'enumeration-joined'
            ? 'joined'
            : enumValue(details, 'outcome', [
                'entered',
                'fulfilled',
                'rejected',
              ]);
        if (projected.outcome === undefined || projected.outcome === 'rejected')
          observationGap = true;
        if (stage === 'enumeration' || stage === 'enumeration-joined')
          projected.phase = enumValue(details, 'phase', [
            'initial',
            'periodic',
            'cleanup-refresh',
            'final-verification',
          ]);
        if (
          ['enumeration', 'enumeration-joined', 'in-flight-refresh'].includes(
            stage,
          )
        )
          projected.queryId = typed(details, 'queryId', positive);
        if (stage === 'enumeration' && projected.queryId !== undefined) {
          if (projected.outcome === 'entered') {
            if (pending.size < 8) pending.set(projected.queryId, time);
            else {
              increment('dropped');
              truncated = true;
            }
          } else {
            const entry = pending.get(projected.queryId);
            if (entry !== undefined) projected.durationMs = time - entry;
            pending.delete(projected.queryId);
            latestQuery = projected.queryId;
          }
        }
        if (
          stage === 'final-verification' &&
          projected.outcome === 'rejected' &&
          finalResult === 'unknown'
        ) {
          finalResult = 'other-error';
          critical(
            'final-result',
            'final-result',
            { resultKind: finalResult },
            4096,
          );
        }
        if (stage === 'signal') {
          const identity = identities(
            { identities: [details] },
            'identities',
            false,
          );
          const signalIdentity = identity.identities?.[0];
          projected.signaledPid = signalIdentity?.pid;
          projected.creationIdentity = signalIdentity?.creationIdentity;
          projected.identityTruncated = identity.truncated;
          projected.signal = enumValue(details, 'signal', [
            'SIGTERM',
            'SIGKILL',
          ]);
        }
        const error = own(details, 'error');
        if (error !== undefined) {
          observationGap = true;
          projected.errorName = typed(
            error,
            'name',
            (value) =>
              typeof value === 'string' &&
              /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value),
          );
          const errorCode = own(error, 'code');
          if (errorCode !== undefined && errorCode !== null) {
            if (
              typeof errorCode === 'string' &&
              /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)
            )
              projected.errorCode = errorCode;
            else {
              const numericErrorCode =
                typeof errorCode === 'number'
                  ? errorCode
                  : typeof errorCode === 'string' &&
                      /^-?(?:0|[1-9]\d{0,15})$/.test(errorCode)
                    ? Number(errorCode)
                    : undefined;
              if (Number.isSafeInteger(numericErrorCode))
                projected.errorExitCode = numericErrorCode;
              else invalid();
            }
          }
          projected.failureCategory =
            projected.errorCode === 'ETIMEDOUT' ? 'timeout' : 'unknown';
        }
        if (
          stage === 'enumeration' &&
          projected.outcome === 'rejected' &&
          ['cleanup-refresh', 'final-verification'].includes(projected.phase)
        ) {
          const enumeration = own(details, 'enumeration');
          const failureCategory =
            enumeration === undefined
              ? undefined
              : enumValue(enumeration, 'failureCategory', [
                  'execution',
                  'protocol',
                  'identity',
                  'stderr',
                ]);
          const phases =
            enumeration === undefined ? undefined : own(enumeration, 'phases');
          const protocolBoolean = (key) =>
            phases === undefined
              ? null
              : (typed(phases, key, (value) => typeof value === 'boolean') ??
                null);
          const protocolCount = (key) =>
            enumeration === undefined
              ? null
              : (typed(
                  enumeration,
                  key,
                  (value) => Number.isSafeInteger(value) && value >= 0,
                ) ?? null);
          projected.queryFailure = {
            category:
              failureCategory === 'stderr'
                ? 'protocol'
                : (failureCategory ?? 'unavailable'),
            errorCode: projected.errorCode ?? null,
            errorExitCode: projected.errorExitCode ?? null,
            signal:
              error === undefined
                ? null
                : (enumValue(error, 'signal', [
                    'SIGTERM',
                    'SIGKILL',
                    'SIGINT',
                    'SIGHUP',
                  ]) ?? null),
            killed:
              error === undefined
                ? null
                : (typed(
                    error,
                    'killed',
                    (value) => typeof value === 'boolean',
                  ) ?? null),
            protocol: {
              psReady: protocolBoolean('psReady'),
              cimFirstRow: protocolBoolean('cimFirstRow'),
              cimComplete: protocolBoolean('cimComplete'),
              validatedPhase:
                enumeration === undefined
                  ? null
                  : (enumValue(enumeration, 'validatedPhase', [
                      'awaiting-ready',
                      'awaiting-first-row',
                      'rows',
                      'complete',
                    ]) ?? null),
              protocolValid:
                enumeration === undefined
                  ? null
                  : (typed(
                      enumeration,
                      'protocolValid',
                      (value) => typeof value === 'boolean',
                    ) ?? null),
              acceptedCount: protocolCount('acceptedCount'),
              rejectedCount: protocolCount('rejectedCount'),
            },
          };
        }
        if (
          !cleanupEntered &&
          !(stage === 'enumeration' && projected.phase === 'initial') &&
          projected.outcome !== 'rejected'
        ) {
          increment('suppressed');
          return;
        }
      } else if (
        [
          'target-started-received',
          'controller-stop-requested',
          'target-exit-received',
          'cleanup-release-checkpoint',
          'wrapper-exit',
          'wrapper-stdio-close',
        ].includes(stage)
      ) {
        for (const key of ['targetPid', 'wrapperPid'])
          projected[key] = typed(details, key, positive);
        projected.code = typed(
          details,
          'code',
          (value) => value === null || Number.isSafeInteger(value),
        );
        projected.signal = enumValue(details, 'signal', [
          null,
          'SIGTERM',
          'SIGKILL',
          'SIGINT',
          'SIGHUP',
        ]);
        projected.reason = enumValue(details, 'reason', [
          'timeout',
          'interruption',
        ]);
        projected.ready = typed(
          details,
          'ready',
          (value) => typeof value === 'boolean',
        );
      } else {
        invalid();
        return;
      }
      if (!emit(stage, projected)) {
        truncated = true;
        critical('truncation', 'observer-truncated', {});
      }
    } catch {
      invalid();
    }
  };
  try {
    armed = emit('armed', { mode: config.mode, budgetVersion: 1 });
    if (!armed) stopped = true;
  } catch {
    stopped = true;
  }
  Object.defineProperty(observe, 'ownershipDiagnostics', { value: true });
  return observe;
}

function serializePosixTrackedGroups(rootPid, rootStart, runNonce, groups) {
  const rootMembers = Array.from(
    groups.get(rootPid)?.members.entries() ?? [[rootPid, rootStart]],
  );
  const lines = [
    JSON.stringify({
      v: 1,
      nonce: runNonce,
      rootPid,
      rootStart,
      rootMembers,
    }),
  ];
  const detachedGroups = Array.from(groups.values())
    .filter(
      (group) =>
        group.pgid !== rootPid && typeof group.leaderStart === 'string',
    )
    .reverse();
  for (const group of detachedGroups) {
    lines.push(
      JSON.stringify({
        pgid: group.pgid,
        leaderStart: group.leaderStart,
        members: Array.from(group.members.entries()),
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

function writeFileAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, 'utf8');
  renameSync(temporaryPath, filePath);
}

export function createPosixProcessTreeOwner(child, options = {}) {
  const listProcesses = options.listProcesses ?? listPosixProcesses;
  const groupExists = options.processGroupExists ?? processGroupExists;
  const killTree = options.killProcessTree ?? killProcessTree;
  const trackedGroupsFile = options.trackedGroupsFile;
  const runNonce = options.runNonce;
  const writeSidecar = options.writeFileAtomically ?? writeFileAtomically;
  const retainFile = options.retainFile;
  const readRetainFile = options.readFile ?? readFileSync;
  const retainedRoot = () =>
    readRetainedRoot(retainFile, runNonce, readRetainFile);
  const trackedGroups = new Map([
    [
      child.pid,
      {
        pgid: child.pid,
        leaderStart: undefined,
        members: new Map(),
      },
    ],
  ]);
  const retiredPgids = new Set();
  // Members of the groups spared as retained (CAN-5862), by start time.
  const retainedMembers = new Map();
  let rootStart;
  let inFlightRefresh;
  let sidecarInitialized = false;
  let sidecarWriteFailed = false;
  let lastSidecarContents;

  const persistSidecarIfChanged = () => {
    if (!sidecarInitialized || sidecarWriteFailed) return;
    const contents = serializePosixTrackedGroups(
      child.pid,
      rootStart,
      runNonce,
      trackedGroups,
    );
    if (contents === lastSidecarContents) return;
    try {
      writeSidecar(trackedGroupsFile, contents);
    } catch (cause) {
      // The caller immediately enters shutdown. Disable further persistence so
      // owner.stop() can still reap processes and complete that shutdown path.
      sidecarWriteFailed = true;
      const error = new Error('failed to rewrite supervised groups sidecar', {
        cause,
      });
      error.code = 'SUPERVISED_GROUPS_SIDECAR_WRITE_FAILED';
      throw error;
    }
    lastSidecarContents = contents;
  };
  const retireGroup = (pgid) => {
    trackedGroups.delete(pgid);
    retiredPgids.add(pgid);
  };
  const rememberCurrentMembers = (group, rows) => {
    for (const row of rows) {
      if (row.pgid === group.pgid) {
        group.members.set(row.pid, row.startTime);
      }
    }
  };
  const performRefresh = async () => {
    try {
      const rows = await listProcesses();
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const rootGroup = trackedGroups.get(child.pid);
      const root = byPid.get(child.pid);
      if (
        rootGroup &&
        !rootGroup.leaderStart &&
        root?.pgid === child.pid &&
        root.startTime
      ) {
        rootStart = root.startTime;
        rootGroup.leaderStart = root.startTime;
        rootGroup.members.set(root.pid, root.startTime);
      }

      const validatedGroups = new Set();
      for (const [pgid, group] of trackedGroups) {
        if (!group.leaderStart || !posixProcessGroupIsOwned(group, rows)) {
          if (group.leaderStart) retireGroup(pgid);
          continue;
        }
        validatedGroups.add(pgid);
        rememberCurrentMembers(group, rows);
      }

      const rootIsOwned =
        rootStart !== undefined &&
        root?.pgid === child.pid &&
        root.startTime === rootStart;
      if (rootIsOwned) {
        // processTreePids returns deepest-first. Reverse it while recording so
        // the tracked Map is parent-first and kill iteration can be leaves-first.
        const lineagePids = processTreePids(rows, child.pid).reverse();
        for (const pid of lineagePids) {
          const row = byPid.get(pid);
          if (
            !row ||
            row.pgid <= 1 ||
            row.pgid === child.pid ||
            retiredPgids.has(row.pgid)
          ) {
            continue;
          }
          let group = trackedGroups.get(row.pgid);
          if (!group) {
            group = {
              pgid: row.pgid,
              leaderStart: byPid.get(row.pgid)?.startTime,
              members: new Map(),
            };
            trackedGroups.set(row.pgid, group);
          }
          group.members.set(row.pid, row.startTime);
          validatedGroups.add(row.pgid);
        }
      }

      for (const pgid of validatedGroups) {
        const group = trackedGroups.get(pgid);
        if (group) rememberCurrentMembers(group, rows);
      }
      persistSidecarIfChanged();
      return true;
    } catch (error) {
      if (error?.code === 'SUPERVISED_GROUPS_SIDECAR_WRITE_FAILED') {
        throw error;
      }
      // Do not use bare pgids when stable identities cannot be revalidated.
      return false;
    }
  };
  const refresh = () => {
    inFlightRefresh ??= performRefresh().finally(() => {
      inFlightRefresh = undefined;
    });
    return inFlightRefresh;
  };
  const initialized = refresh().then(
    (refreshed) =>
      refreshed &&
      rootStart !== undefined &&
      trackedGroups.get(child.pid)?.leaderStart === rootStart,
  );
  const isAlive = async () => {
    await initialized;
    const root = retainedRoot();
    if (root) {
      try {
        const rows = await listProcesses();
        const retained = retainedProcessPids(rows, root);
        let alive = false;
        for (const group of trackedGroups.values()) {
          if (groupIsRetained(group, rows, retained)) {
            // Kept for the watchdog's hold, which may see the daemon gone.
            rememberCurrentMembers(group, rows);
            for (const [pid, startTime] of group.members)
              retainedMembers.set(pid, startTime);
          } else if (groupExists(group.pgid)) alive = true;
        }
        return alive;
      } catch {
        // Without a snapshot, count every group, the retained one included.
      }
    }
    return Array.from(trackedGroups.keys()).some(groupExists);
  };
  const killTrackedTree = async (_rootPid, signal) => {
    await initialized;
    const root = retainedRoot();
    const candidates = Array.from(trackedGroups.values()).reverse();
    for (const candidate of candidates) {
      let rows;
      try {
        rows = await listProcesses();
      } catch {
        return;
      }
      const current = trackedGroups.get(candidate.pgid);
      if (current !== candidate || !posixProcessGroupIsOwned(candidate, rows)) {
        if (current === candidate) retireGroup(candidate.pgid);
        continue;
      }
      // A daemon the spec keeps across the quit (CAN-5862) is the spec's to
      // kill, with killRetainedDaemons or the exit guard in launchCanopy.mjs.
      if (groupIsRetained(candidate, rows, retainedProcessPids(rows, root))) {
        rememberCurrentMembers(candidate, rows);
        for (const [pid, startTime] of candidate.members)
          retainedMembers.set(pid, startTime);
        retireGroup(candidate.pgid);
        continue;
      }
      await killTree(candidate.pgid, signal);
    }
  };

  return Object.assign(
    createProcessTreeOwner(child, {
      ...options,
      isAlive,
      killProcessTree: killTrackedTree,
    }),
    {
      ready: initialized,
      refresh,
      retainedMembers: () => new Map(retainedMembers),
      async initializeSidecar() {
        if (!trackedGroupsFile || !runNonce) return;
        if (!(await initialized)) {
          throw new Error('could not establish the supervised root identity');
        }
        const rootMembers = Array.from(
          trackedGroups.get(child.pid)?.members.entries() ?? [
            [child.pid, rootStart],
          ],
        );
        const header = `${JSON.stringify({
          v: 1,
          nonce: runNonce,
          rootPid: child.pid,
          rootStart,
          rootMembers,
        })}\n`;
        writeSidecar(trackedGroupsFile, header);
        sidecarInitialized = true;
        lastSidecarContents = header;
      },
      trackedGroups() {
        return Array.from(trackedGroups.values()).map((group) => ({
          pgid: group.pgid,
          leaderStart: group.leaderStart,
          members: new Map(group.members),
        }));
      },
    },
  );
}

// Selected E2E entry only. An inherited observer value cannot activate a
// release entry or production logging launch. Each producer owns its file/cap.
export function createWindowsBoundaryRecorder(
  args,
  producer,
  {
    env = process.env,
    platform = process.platform,
    currentPid = process.pid,
    parentPid = process.ppid,
    now = () => performance.now(),
    write = appendFileSync,
    createEmissionFile = (file) =>
      writeFileSync(file, '', { encoding: 'utf8', flag: 'wx' }),
  } = {},
) {
  const raw = env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
  if (platform !== 'win32' || !raw || raw.length > 4096) return undefined;
  try {
    const config = JSON.parse(raw);
    const outputRoot = path.resolve(
      fileURLToPath(new URL('../../../../', import.meta.url)),
      '.playwright/browser-profiles/phase-3',
    );
    const acceptanceSelected =
      config.mode === 'acceptance-command' &&
      producer === 'supervisor' &&
      config.fixturePid === parentPid &&
      typeof config.file === 'string' &&
      config.file.length <= 1024 &&
      path.resolve(config.file).startsWith(outputRoot + path.sep) &&
      isAcceptanceCommand(args, env);
    const e2eSelected =
      config.mode === 'close' &&
      env.CANOPY_E2E_ISOLATED_LOGGING !== '1' &&
      args.some((arg) =>
        /(?:^|[/\\])out-e2e[/\\]main[/\\]index\.js$/.test(arg),
      );
    const inheritedStdioSelected =
      config.mode === 'close' &&
      producer === 'supervisor' &&
      env.CANOPY_E2E_ISOLATED_LOGGING !== '1' &&
      env.CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE === '1' &&
      config.fixturePid === parentPid &&
      typeof config.file === 'string' &&
      config.file.length <= 1024 &&
      path.isAbsolute(config.file) &&
      config.file.endsWith('-main.jsonl') &&
      path.resolve(config.file).startsWith(outputRoot + path.sep) &&
      args.length === 2 &&
      args[0] === '-e' &&
      typeof args[1] === 'string' &&
      args[1].length > 0 &&
      args[1].length <= 8192;
    const watchdogSelected =
      config.mode === 'watchdog-test' &&
      ['watchdog', 'watchdog-fixture'].includes(producer) &&
      args.length === 3 &&
      args[0] === WATCHDOG_ARG &&
      parsePositivePid(args[1]) === config.supervisorPid &&
      parsePositivePid(args[2]) === config.targetPid &&
      (producer === 'watchdog'
        ? config.fixturePid === parentPid
        : config.fixturePid === currentPid);
    if (
      (!e2eSelected &&
        !inheritedStdioSelected &&
        !watchdogSelected &&
        !acceptanceSelected) ||
      !path.isAbsolute(config.file) ||
      !config.file.endsWith('-main.jsonl') ||
      ![config.caseId, config.launchId].every(
        (id) => typeof id === 'string' && /^[a-z0-9_-]{1,160}$/i.test(id),
      ) ||
      !Number.isInteger(config.fixturePid) ||
      config.fixturePid <= 0 ||
      (watchdogSelected &&
        (!Number.isInteger(config.supervisorPid) ||
          config.supervisorPid <= 0 ||
          !Number.isInteger(config.targetPid) ||
          config.targetPid <= 0))
    )
      return undefined;
    const file = config.file.replace(/-main\.jsonl$/, `-${producer}.jsonl`);
    const start = now();
    let count = 0,
      size = 0,
      stopped = false,
      lastState,
      samples = 0,
      sampledAt = start;
    const record = (stage, details = {}) => {
      if (stopped) return;
      try {
        if (
          acceptanceSelected
            ? now() - start >= ACCEPTANCE_COMMAND_OBSERVER_LIFETIME_MS
            : now() - start > 180000
        ) {
          stage = 'observer-expired';
          details = {};
          stopped = true;
        }
        if (
          acceptanceSelected &&
          !stopped &&
          !ACCEPTANCE_COMMAND_STAGES.has(stage)
        )
          return;
        if (stage === 'ownership-refresh') {
          const state = JSON.stringify({
            status: details.status,
            identities: details.identities,
          });
          if (state === lastState) {
            if (samples >= 12 || now() - sampledAt < 15000) return;
            samples++;
            sampledAt = now();
          } else lastState = state;
        }
        let line =
          JSON.stringify({
            stage,
            producer,
            pid: currentPid,
            parentPid,
            fixturePid: config.fixturePid,
            caseId: config.caseId,
            launchId: config.launchId,
            wallTime: new Date().toISOString(),
            monotonicNs: process.hrtime.bigint().toString(),
            ...details,
          }) + '\n';
        if (
          count >= 255 ||
          Buffer.byteLength(line) > 16384 ||
          size + Buffer.byteLength(line) > 127 * 1024
        ) {
          line =
            JSON.stringify({ stage: 'observer-truncated', producer }) + '\n';
          stopped = true;
        }
        write(file, line);
        count++;
        size += Buffer.byteLength(line);
      } catch {
        stopped = true;
      }
    };
    if (
      [currentPid, parentPid, config.fixturePid].every(
        (pid) => Number.isSafeInteger(pid) && pid > 0,
      ) &&
      producer === 'supervisor' &&
      (acceptanceSelected ||
        (e2eSelected &&
          config.file.length <= 1024 &&
          path.resolve(config.file).startsWith(outputRoot + path.sep)) ||
        (inheritedStdioSelected &&
          config.file.length <= 1024 &&
          path.resolve(config.file).startsWith(outputRoot + path.sep)))
    ) {
      try {
        Object.defineProperty(record, 'ownership', {
          value: createWindowsOwnershipObserver(config, {
            currentPid,
            parentPid,
            now,
            write,
            start,
          }),
        });
      } catch {
        /* Optional diagnostics must not disable the original recorder. */
      }
    }
    if (
      env[WINDOWS_ADMISSION_EMISSION_ENV] === '1' &&
      producer === 'supervisor' &&
      (e2eSelected || acceptanceSelected) &&
      config.file.length <= 1024 &&
      path.resolve(config.file).startsWith(outputRoot + path.sep)
    ) {
      let admissionEmission;
      const emissionFile = config.file.replace(
        /-main\.jsonl$/,
        '-admission-emission.jsonl',
      );
      if (!validWindowsAdmissionEmissionPath(emissionFile)) {
        admissionEmission = Object.freeze({
          status: 'unavailable',
          reason: 'invalid-derived-path',
        });
      } else {
        try {
          createEmissionFile(emissionFile);
          admissionEmission = Object.freeze({
            status: 'ready',
            file: emissionFile,
          });
        } catch {
          admissionEmission = Object.freeze({
            status: 'unavailable',
            reason: 'exclusive-create-failed',
          });
        }
      }
      Object.defineProperty(record, 'admissionEmission', {
        value: admissionEmission,
      });
      record('admission-emission-setup', {
        outcome: admissionEmission.status,
      });
    }
    return record;
  } catch {
    return undefined;
  }
}

async function runWindowsSupervisedChild(args) {
  const record = createWindowsBoundaryRecorder(args, 'windows-child');
  const executable = process.env[SUPERVISED_EXECUTABLE_ENV] ?? process.execPath;
  const childEnv = { ...process.env };
  delete childEnv[SUPERVISED_EXECUTABLE_ENV];
  delete childEnv[SUPERVISOR_OWNER_PID_ENV];
  delete childEnv.CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE;
  const holdOpen = setInterval(() => undefined, 60_000);
  let started = false;
  let reported = false;
  let terminalResult;
  let released = false;
  let flushed = false;
  let acknowledged;
  let controlFailed = false;
  let acknowledgementTimer;
  let acknowledgementDeadline;

  const release = () => {
    if (released || !reported) return;
    if (performance.now() >= acknowledgementDeadline) controlFailed = true;
    if (!controlFailed && (!flushed || acknowledged !== true)) return;
    released = true;
    const targetCode = Number.isInteger(terminalResult.code)
      ? terminalResult.code
      : terminalResult.signal
        ? 1
        : 0;
    process.exitCode =
      targetCode || (controlFailed ? WINDOWS_RELEASE_FAILURE_EXIT_CODE : 0);
    clearTimeout(acknowledgementTimer);
    clearInterval(holdOpen);
    record?.('wrapper-release', {
      outcome: controlFailed ? 'failed' : 'acknowledged',
      code: process.exitCode,
    });
    try {
      if (process.connected && process.disconnect) {
        process.disconnect();
        return;
      }
    } catch {
      // IPC can disconnect between the flush callback and this release.
    }
    process.channel?.unref();
  };
  const failControl = () => {
    controlFailed = true;
    release();
  };
  process.once('disconnect', failControl);
  process.on('message', (message) => {
    if (
      !reported ||
      released ||
      acknowledged !== undefined ||
      message?.type !== WINDOWS_RELEASE_ACK_MESSAGE
    )
      return;
    acknowledged = message.ready === true;
    if (!acknowledged) controlFailed = true;
    release();
  });

  const reportExit = (code, signal) => {
    if (reported) return;
    reported = true;
    terminalResult ??= { code, signal };
    // One old bounded query may drain before the fresh TERM snapshot. This is
    // a protocol deadline, not additional TERM grace or an enumeration retry.
    acknowledgementDeadline =
      performance.now() + WINDOWS_RELEASE_ACK_TIMEOUT_MS;
    acknowledgementTimer = setTimeout(
      failControl,
      WINDOWS_RELEASE_ACK_TIMEOUT_MS,
    );
    if (controlFailed) {
      release();
      return;
    }
    try {
      if (process.connected && process.send) {
        process.send(
          { type: WINDOWS_TARGET_EXIT_MESSAGE, ...terminalResult },
          (error) => {
            flushed = true;
            if (error) controlFailed = true;
            release();
          },
        );
        return;
      }
    } catch {
      // A closed IPC channel must not retain an otherwise completed wrapper.
    }
    failControl();
  };

  process.once('message', (message) => {
    if (message === 'abort') {
      clearInterval(holdOpen);
      process.exit(1);
    }
    if (message !== 'start' || started) return;
    started = true;
    const target = spawn(executable, args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'inherit',
      windowsHide: true,
    });
    target.once('spawn', () => {
      record?.('direct-target-spawn', {
        targetPid: target.pid,
        wrapperPid: process.pid,
      });
      if (process.connected && Number.isInteger(target.pid)) {
        try {
          process.send?.(
            { type: WINDOWS_TARGET_STARTED_MESSAGE, pid: target.pid },
            (error) => {
              if (error) failControl();
            },
          );
        } catch {
          failControl();
        }
      }
    });
    target.once('error', (error) => {
      process.stderr.write(
        `[e2e-supervisor] Failed to launch child: ${error.message}\n`,
      );
      terminalResult ??= { code: 1, signal: null };
    });
    target.once('exit', (code, signal) => {
      record?.('direct-target-exit', {
        targetPid: target.pid,
        wrapperPid: process.pid,
        code,
        signal,
      });
      terminalResult ??= { code, signal };
    });
    target.once('close', (code, signal) => {
      record?.('direct-target-stdio-close', {
        targetPid: target.pid,
        wrapperPid: process.pid,
        code,
        signal,
      });
      reportExit(code, signal);
    });
  });
}

function createPlatformProcessTreeOwner(child, options) {
  return process.platform === 'win32'
    ? createWindowsProcessTreeOwner(child, options)
    : createPosixProcessTreeOwner(child, options);
}

export function createSupervisorProcessTreeOwner(
  child,
  { useWindowsLaunchGate = false, ...options } = {},
) {
  if (useWindowsLaunchGate !== true) {
    return createPlatformProcessTreeOwner(child, options);
  }
  return createWindowsProcessTreeOwner(child, {
    ...options,
    [FILTER_INITIAL_WINDOWS_IDENTITY]: true,
  });
}

export function startParentLivenessWatch({
  parentPid,
  isProcessAlive = processExists,
  onParentExit,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 500,
}) {
  let handled = false;
  const timer = setIntervalFn(async () => {
    if (handled || isProcessAlive(parentPid)) return;
    handled = true;
    clearIntervalFn(timer);
    await onParentExit();
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      handled = true;
      clearIntervalFn(timer);
    },
  };
}

export function startProcessTreeOwnerRefresh({
  owner,
  onDead = () => undefined,
  onError = () => undefined,
  intervalMs = PROCESS_TREE_REFRESH_INTERVAL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let stopped = false;
  let timer;
  const tick = async () => {
    try {
      if (owner.refresh && !(await owner.refresh())) {
        schedule();
        return;
      }
      const alive = await owner.isAlive();
      if (stopped) return;
      if (!alive) {
        await onDead();
        return;
      }
      schedule();
    } catch (error) {
      stopped = true;
      await onError(error);
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeoutFn(tick, intervalMs);
    timer.unref?.();
  };
  schedule();
  return {
    stop() {
      stopped = true;
      clearTimeoutFn(timer);
    },
  };
}

function parsePositivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function resolveProcessTreeRefreshInterval(value) {
  return parsePositivePid(value) ?? PROCESS_TREE_REFRESH_INTERVAL_MS;
}

export function resolveSupervisorOwnerPid(
  configuredPid,
  fallbackPid = process.ppid,
) {
  return parsePositivePid(configuredPid) ?? fallbackPid;
}

export function attachChildLifecycle(child, { onExit, onClose }) {
  child.once('exit', onExit);
  child.once('close', onClose);
}

async function runWatchdog(args) {
  const supervisorPid = parsePositivePid(args[1]);
  const targetPid = parsePositivePid(args[2]);
  const trackedGroupsFile = args[3];
  const runNonce = args[4];
  if (supervisorPid === null || targetPid === null) process.exit(2);
  const target = { pid: targetPid };
  const record = createWindowsBoundaryRecorder(args, 'watchdog');
  const owner = createPlatformProcessTreeOwner(target, {
    rootLifecycle: 'external-pid',
    trackedGroupsFile,
    runNonce,
    // Inherited from the supervisor that spawned this watchdog.
    retainFile: process.env[SUPERVISED_RETAIN_FILE_ENV],
    ...(record
      ? {
          observeRefresh: (snapshot) => record('ownership-refresh', snapshot),
          observeOperation: (stage, details) => record(stage, details),
        }
      : {}),
  });
  if (record)
    void Promise.resolve(owner.ready).then(
      (ready) => record('initial-admission', { outcome: 'fulfilled', ready }),
      (error) =>
        record('initial-admission', {
          outcome: 'rejected',
          error: boundedError(error, { messageBytes: 512 }).error,
        }),
    );
  const holdOpen = setInterval(() => undefined, 60_000);
  let parentWatch;
  let ownershipRefresh;
  let stopping;
  const shutdown = (cause = 'unknown') => {
    record?.('shutdown-cause', { cause });
    stopping ??= (async () => {
      parentWatch?.stop();
      ownershipRefresh?.stop();
      let exitCode = 0;
      try {
        record?.('owner-stop', { outcome: 'entered' });
        await owner.stop();
        record?.('owner-stop', { outcome: 'fulfilled' });
        if (process.platform !== 'win32')
          await holdRetainedTree({
            retainFile: process.env[SUPERVISED_RETAIN_FILE_ENV],
            runNonce,
            ...(owner.retainedMembers && { known: owner.retainedMembers() }),
          });
      } catch (error) {
        exitCode = 1;
        record?.('owner-stop', {
          outcome: 'rejected',
          error: boundedError(error, { messageBytes: 512 }).error,
        });
        try {
          process.stderr.write(
            `[e2e-supervisor] Watchdog process cleanup failed: ${error.message}\n`,
          );
        } catch {
          // Reporting failure must not prevent the nonzero shutdown result.
        }
      }
      clearInterval(holdOpen);
      record?.('watchdog-exit-selected', { exitCode });
      process.exit(exitCode);
    })();
    return stopping;
  };
  if (trackedGroupsFile || runNonce) {
    try {
      if (!trackedGroupsFile || !runNonce) {
        throw new Error('incomplete watchdog tracking metadata');
      }
      await owner.initializeSidecar?.();
    } catch (error) {
      process.stderr.write(
        `[e2e-watchdog] Failed to record supervised process ownership: ${error.message}\n`,
      );
      await shutdown();
      return;
    }
  }
  parentWatch = startParentLivenessWatch({
    parentPid: supervisorPid,
    onParentExit: () => shutdown('parent-loss'),
  });
  ownershipRefresh = startProcessTreeOwnerRefresh({
    owner,
    onDead: () => shutdown('owner-dead'),
    onError: (error) => {
      process.stderr.write(
        `[e2e-watchdog] Failed to update supervised process ownership: ${error.message}\n`,
      );
      return shutdown();
    },
    intervalMs: resolveProcessTreeRefreshInterval(
      process.env[PROCESS_TREE_REFRESH_MS_ENV],
    ),
  });
  process.on('message', (message) => {
    if (
      message?.type !== WATCHDOG_TRACK_PID_MESSAGE ||
      !Number.isInteger(message.pid)
    ) {
      return;
    }
    owner.trackOwnedPid?.(message.pid);
    void (owner.refresh?.() ?? owner.isAlive());
  });
  if (process.connected)
    process.once('disconnect', () => void shutdown('disconnect'));
}

function spawnWatchdog(targetPid, trackedGroupsFile, runNonce) {
  const trackingArgs =
    trackedGroupsFile && runNonce ? [trackedGroupsFile, runNonce] : [];
  const watchdog = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      WATCHDOG_ARG,
      String(process.pid),
      String(targetPid),
      ...trackingArgs,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  watchdog.unref();
  watchdog.channel?.unref();
  return watchdog;
}

/**
 * The wrapper's close as a supervisor exit cause: whether the target reported
 * its own exit first, or the wrapper ended (for example force-killed) without
 * reporting one.
 */
export function describeWrapperClose({ code, signal, targetExit }) {
  const target = targetExit
    ? `target exited (code=${targetExit.code ?? null}, signal=${targetExit.signal ?? null})`
    : 'target exit not reported';
  return `wrapper closed (code=${code ?? null}, signal=${signal ?? null}); ${target}`;
}

export function describeSupervisorExit({
  exitCode,
  cause,
  cleanupFailed = false,
  releaseUnconfirmed = false,
}) {
  return (
    `[e2e-supervisor] Exiting with code ${exitCode}: ${cause ?? 'unspecified cause'}` +
    (cleanupFailed ? '; process cleanup failed' : '') +
    (releaseUnconfirmed ? '; wrapper release unconfirmed' : '')
  );
}

async function runSupervisor(args) {
  const record = createWindowsBoundaryRecorder(args, 'supervisor');
  const ownership = record?.ownership;
  const admissionEmission = record?.admissionEmission;
  if (record)
    process.once('exit', (code) => {
      record('supervisor-exit', { code });
      ownership?.('supervisor-exit', { code });
    });
  const executable = process.env[SUPERVISED_EXECUTABLE_ENV] ?? process.execPath;
  const supervisedPidFile = process.env[SUPERVISED_PID_FILE_ENV];
  const supervisedGroupsFile = process.env[SUPERVISED_GROUPS_FILE_ENV];
  const supervisedRunNonce = process.env[SUPERVISED_RUN_NONCE_ENV];
  const supervisedRetainFile = process.env[SUPERVISED_RETAIN_FILE_ENV];
  const useWindowsLaunchGate = process.platform === 'win32';
  const ownerPid = resolveSupervisorOwnerPid(
    process.env[SUPERVISOR_OWNER_PID_ENV],
  );
  const childEnv = { ...process.env };
  delete childEnv[SUPERVISED_EXECUTABLE_ENV];
  delete childEnv[SUPERVISED_PID_FILE_ENV];
  delete childEnv[SUPERVISED_GROUPS_FILE_ENV];
  delete childEnv[SUPERVISED_RUN_NONCE_ENV];
  delete childEnv[SUPERVISED_RETAIN_FILE_ENV];
  delete childEnv[SUPERVISOR_OWNER_PID_ENV];
  delete childEnv.CANOPY_E2E_SUPERVISOR_INHERITED_STDIO_FIXTURE;
  if (admissionEmission) delete childEnv[WINDOWS_ADMISSION_EMISSION_ENV];
  delete childEnv[PROCESS_TREE_REFRESH_MS_ENV];
  if (useWindowsLaunchGate) {
    childEnv[SUPERVISED_EXECUTABLE_ENV] = executable;
  }
  const child = spawn(
    useWindowsLaunchGate ? process.execPath : executable,
    useWindowsLaunchGate
      ? [fileURLToPath(import.meta.url), WINDOWS_CHILD_ARG, ...args]
      : args,
    {
      cwd: process.cwd(),
      env: childEnv,
      detached: true,
      stdio: useWindowsLaunchGate
        ? ['pipe', 'pipe', 'pipe', 'ipc']
        : ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);

  let cleanupStarted = false;
  let releaseDecisionSent = false;
  let releaseCheckpoint = false;
  let releaseControlFailed = false;
  let shutdownCause;
  const acknowledgeRelease = (ready) => {
    if (releaseDecisionSent) return;
    releaseDecisionSent = true;
    releaseCheckpoint = ready;
    record?.('cleanup-release-checkpoint', { ready, wrapperPid: child.pid });
    ownership?.('cleanup-release-checkpoint', { ready, wrapperPid: child.pid });
    try {
      child.send({ type: WINDOWS_RELEASE_ACK_MESSAGE, ready }, (error) => {
        if (error) {
          releaseControlFailed = true;
          // The IPC callback can run after shutdown has selected its result.
          if (process.exitCode === 0) {
            process.exitCode = WINDOWS_RELEASE_FAILURE_EXIT_CODE;
            try {
              process.stderr.write(
                `${describeSupervisorExit({ exitCode: WINDOWS_RELEASE_FAILURE_EXIT_CODE, cause: shutdownCause, releaseUnconfirmed: true })}\n`,
              );
            } catch {
              // Reporting failure must not change the selected exit code.
            }
          }
        }
      });
    } catch {
      releaseControlFailed = true;
    }
  };
  const owner = createSupervisorProcessTreeOwner(child, {
    useWindowsLaunchGate,
    trackedGroupsFile: supervisedGroupsFile,
    runNonce: supervisedRunNonce,
    retainFile: supervisedRetainFile,
    ...(admissionEmission?.status === 'ready' ? { admissionEmission } : {}),
    ...(useWindowsLaunchGate ? { onCleanupSnapshot: acknowledgeRelease } : {}),
    ...(record
      ? {
          observeRefresh: (snapshot) => {
            record('ownership-refresh', snapshot);
            ownership?.('ownership-refresh', snapshot);
          },
        }
      : {}),
    ...(ownership ? { observeOperation: ownership } : {}),
  });
  let targetExit;
  let targetPid;
  let watchdog;
  let ownershipRefresh;
  let cleanup;
  const beginCleanup = () => {
    if (!cleanup) {
      cleanupStarted = true;
      ownershipRefresh?.stop();
      record?.('supervisor-cleanup', {
        outcome: 'entered',
        wrapperPid: child.pid,
      });
      ownership?.('supervisor-cleanup', {
        outcome: 'entered',
        wrapperPid: child.pid,
      });
      cleanup = owner.stop();
      // Observe rejection immediately, even without diagnostics: cleanup may
      // settle before wrapper stdio closes and shutdown awaits this promise.
      void cleanup.then(
        () => {
          if (useWindowsLaunchGate && !releaseDecisionSent)
            acknowledgeRelease(false);
          record?.('supervisor-cleanup', {
            outcome: 'fulfilled',
            wrapperPid: child.pid,
          });
          ownership?.('supervisor-cleanup', {
            outcome: 'fulfilled',
            wrapperPid: child.pid,
          });
        },
        () => {
          if (useWindowsLaunchGate && !releaseDecisionSent)
            acknowledgeRelease(false);
          record?.('supervisor-cleanup', {
            outcome: 'rejected',
            wrapperPid: child.pid,
          });
          ownership?.('supervisor-cleanup', {
            outcome: 'rejected',
            wrapperPid: child.pid,
          });
        },
      );
    }
    return cleanup;
  };
  let shuttingDown = false;
  const shutdown = async (exitCode, cause) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownCause = cause;
    parentWatch.stop();
    ownershipRefresh?.stop();
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    let cleanupFailed = false;
    try {
      await beginCleanup();
    } catch (error) {
      exitCode ||= 1;
      cleanupFailed = true;
      try {
        process.stderr.write(
          `[e2e-supervisor] Process cleanup failed: ${error.message}\n`,
        );
      } catch {
        // Reporting failure must not prevent the nonzero shutdown result.
      }
    }
    const releaseUnconfirmed =
      useWindowsLaunchGate && (!releaseCheckpoint || releaseControlFailed);
    if (releaseUnconfirmed) {
      exitCode ||= WINDOWS_RELEASE_FAILURE_EXIT_CODE;
    }
    process.exitCode = exitCode;
    // Windows harness failures report only the launcher's exit code; name the
    // path that selected it.
    if (useWindowsLaunchGate && exitCode !== 0) {
      try {
        process.stderr.write(
          `${describeSupervisorExit({ exitCode, cause, cleanupFailed, releaseUnconfirmed })}\n`,
        );
      } catch {
        // Reporting failure must not change the selected exit code.
      }
    }
  };
  const parentWatch = startParentLivenessWatch({
    parentPid: ownerPid,
    onParentExit: () => shutdown(1, `owner process ${ownerPid} exited`),
  });
  const handleOwnershipRefreshError = (error) => {
    process.stderr.write(
      `[e2e-supervisor] Failed to update supervised process ownership: ${error.message}\n`,
    );
    return shutdown(1, 'ownership refresh failed');
  };

  if (useWindowsLaunchGate && process.connected) {
    process.on('message', (message) => {
      if (
        shuttingDown ||
        !message ||
        typeof message !== 'object' ||
        Object.keys(message).length !== 2 ||
        message.type !== 'request-owned-cleanup' ||
        !['timeout', 'interruption'].includes(message.reason)
      )
        return;
      record?.('controller-stop-requested', { reason: message.reason });
      ownership?.('controller-stop-requested', { reason: message.reason });
      void shutdown(1, `controller requested cleanup (${message.reason})`);
    });
    process.once(
      'disconnect',
      () => void shutdown(1, 'controller channel disconnected'),
    );
    // The parent channel must not hold normal completion open after cleanup.
    process.channel?.unref();
  }

  child.once('spawn', async () => {
    try {
      if (!useWindowsLaunchGate && supervisedGroupsFile) {
        if (!supervisedRunNonce) {
          throw new Error('missing supervised run nonce');
        }
        await owner.initializeSidecar();
      }
      if (supervisedPidFile) {
        writeFileSync(supervisedPidFile, `${String(child.pid)}\n`, 'utf8');
      }
    } catch (error) {
      process.stderr.write(
        `[e2e-supervisor] Failed to record supervised process ownership: ${error.message}\n`,
      );
      void shutdown(1, 'ownership record failed');
      return;
    }
    watchdog = spawnWatchdog(
      child.pid,
      supervisedGroupsFile ? `${supervisedGroupsFile}.watchdog` : undefined,
      supervisedRunNonce,
    );
    if (useWindowsLaunchGate) {
      let releaseSnapshot;
      void releaseWindowsSupervisedChild(child, owner, {
        observeRelease: (snapshot) => {
          releaseSnapshot = snapshot;
        },
      }).then((released) => {
        if (!released) {
          process.exitCode = 1;
          writeWindowsLaunchFailureEvidence({
            released,
            supervisorPid: process.pid,
            ownerPid,
            child,
            owner,
            releaseSnapshot,
          });
          return;
        }
        if (!cleanupStarted) {
          ownershipRefresh = startProcessTreeOwnerRefresh({
            owner,
            onError: handleOwnershipRefreshError,
            intervalMs: resolveProcessTreeRefreshInterval(
              process.env[PROCESS_TREE_REFRESH_MS_ENV],
            ),
          });
        }
      });
    } else {
      ownershipRefresh = startProcessTreeOwnerRefresh({
        owner,
        onError: handleOwnershipRefreshError,
        intervalMs: resolveProcessTreeRefreshInterval(
          process.env[PROCESS_TREE_REFRESH_MS_ENV],
        ),
      });
    }
  });
  if (useWindowsLaunchGate) {
    child.on('message', (message) => {
      if (message?.type === WINDOWS_TARGET_STARTED_MESSAGE) {
        if (cleanupStarted || targetPid !== undefined) return;
        targetPid = message.pid;
        record?.('target-started-received', {
          targetPid,
          wrapperPid: child.pid,
        });
        ownership?.('target-started-received', {
          targetPid,
          wrapperPid: child.pid,
        });
        owner.trackOwnedPid(message.pid);
        void owner.refresh();
        try {
          watchdog?.send(
            { type: WATCHDOG_TRACK_PID_MESSAGE, pid: message.pid },
            () => undefined,
          );
        } catch {
          // Parent liveness cleanup still covers a watchdog IPC race.
        }
        return;
      }
      if (message?.type !== WINDOWS_TARGET_EXIT_MESSAGE || targetExit) return;
      record?.('target-exit-received', {
        targetPid,
        code: message.code,
        signal: message.signal,
        wrapperPid: child.pid,
      });
      ownership?.('target-exit-received', {
        targetPid,
        code: message.code,
        signal: message.signal,
        wrapperPid: child.pid,
      });
      targetExit = message;
      void beginCleanup();
    });
  }
  child.once('error', (error) => {
    process.stderr.write(
      `[e2e-supervisor] Failed to launch child: ${error.message}\n`,
    );
    void shutdown(1, 'child launch failed');
  });
  attachChildLifecycle(child, {
    onExit: (code, signal) => {
      record?.('wrapper-exit', { wrapperPid: child.pid, code, signal });
      ownership?.('wrapper-exit', { wrapperPid: child.pid, code, signal });
      void beginCleanup();
    },
    onClose: (code, signal) => {
      record?.('wrapper-stdio-close', { wrapperPid: child.pid, code, signal });
      ownership?.('wrapper-stdio-close', {
        wrapperPid: child.pid,
        code,
        signal,
      });
      const reportedCode = targetExit?.code;
      const reportedSignal = targetExit?.signal;
      let exitCode = Number.isInteger(reportedCode)
        ? reportedCode
        : reportedSignal
          ? 1
          : Number.isInteger(code)
            ? code
            : signal
              ? 1
              : 0;
      if (useWindowsLaunchGate && code === WINDOWS_RELEASE_FAILURE_EXIT_CODE) {
        exitCode ||= WINDOWS_RELEASE_FAILURE_EXIT_CODE;
      }
      void shutdown(
        exitCode,
        describeWrapperClose({ code, signal, targetExit }),
      );
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(
      signal,
      () => void shutdown(signal === 'SIGINT' ? 130 : 1, `received ${signal}`),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === WATCHDOG_ARG) {
    await runWatchdog(args);
  } else if (args[0] === WINDOWS_CHILD_ARG) {
    await runWindowsSupervisedChild(args.slice(1));
  } else {
    await runSupervisor(args);
  }
}

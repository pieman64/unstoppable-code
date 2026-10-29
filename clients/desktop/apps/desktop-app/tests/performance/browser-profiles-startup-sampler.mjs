/** External, read-only macOS sampler; never runs inside Electron's event loops. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const DIAGNOSTIC_TEXT_LIMIT = 128;
const DIAGNOSTIC_COMMAND_LIMIT = 1024;

/** Reject missing samples before the shared monitor can normalize them to zero. */
export function validateAppResourceMetrics(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0)
    throw new Error('App resource sample is missing process metrics');
  for (const metric of metrics) {
    if (
      !Number.isSafeInteger(metric?.pid) ||
      metric.pid <= 0 ||
      !Number.isFinite(metric.cpu?.percentCPUUsage) ||
      metric.cpu.percentCPUUsage < 0 ||
      !Number.isFinite(metric.memory?.workingSetSize) ||
      metric.memory.workingSetSize < 0
    )
      throw new Error(
        `App resource sample has missing/invalid CPU or working set for PID ${metric?.pid ?? 'unknown'}`,
      );
  }
  return metrics;
}

/**
 * Limited adapter passed only to startPerformanceMonitor. Its only Electron
 * evaluate call reads app.getAppMetrics; validating the returned batch here
 * covers every observation, including processes first appearing after startup.
 * Rejection becomes a fatal resource sample in the ordinary monitor, which
 * assertValidMonitoring rejects while preserving the failed raw observation.
 */
export function createValidatedAppMetricSource(electronApp) {
  return {
    async evaluate(...args) {
      return validateAppResourceMetrics(await electronApp.evaluate(...args));
    },
  };
}

export function parsePsCpuTime(value) {
  // Darwin TIME uses minutes:seconds.hundredths; long-lived processes can
  // have hours:minutes:seconds. Accept arbitrary minutes in the short form.
  const match = /^(?:(\d+):)?(\d+):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match || Number(match[3]) >= 60 || (match[1] && Number(match[2]) >= 60))
    throw new Error(`Invalid ps CPU time: ${value}`);
  return (
    Number(match[1] ?? 0) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1000 +
    Number(`0.${match[4] ?? '0'}`) * 1000
  );
}

export function parsePsSnapshot(text) {
  const rows = [];
  const pids = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // lstart is a PID-reuse identity guard, with LC_ALL=C enforced by caller.
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
        line,
      );
    if (!match)
      throw new Error(
        'Malformed ps process row (raw foreign process data omitted)',
      );
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[4]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(rssKb) ||
      pids.has(pid)
    )
      throw new Error('Invalid or duplicate ps process identity/resource data');
    pids.add(pid);
    rows.push({
      pid,
      ppid,
      cpuTimeText: match[3],
      cpuTimeMs: parsePsCpuTime(match[3]),
      rssKb,
      state: match[5],
      started: match[6].replace(/\s+/g, ' '),
      command: match[7],
    });
  }
  if (!rows.length) throw new Error('Empty ps process snapshot');
  return rows;
}

export function createOwnedCpuLedger(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0)
    throw new Error('Invalid owned root PID');
  const ledger = new Map();
  const terminalObservations = new Map();
  let rootIdentity;
  let previousTotal = null;
  let previousAt = null;
  const identity = (row) => `${row.pid}:${row.started}`;
  const boundedText = (value, limit) => {
    const text = String(value ?? '');
    return {
      value: text.length <= limit ? text : text.slice(0, limit),
      truncated: text.length > limit,
    };
  };
  const snapshotObservation = (row, collection) => ({
    row,
    collection: {
      collectionStartedMs: collection?.collectionStartedMs,
      collectionCompletedMs: collection?.collectionCompletedMs,
    },
  });
  const isConfirmedZombie = (row) =>
    row.state.startsWith('Z') && row.command === '<defunct>';
  // Darwin ps emits E for P_WEXIT before zombie state. Its Mach task data
  // may already be unavailable, leaving raw CPU zero and run state '?'.
  // Match the ps modifier order; '?' or unavailable command text alone is
  // not exit evidence. Parsed state tokens contain no whitespace.
  const isConfirmedExiting = (row) =>
    /^[RUSITH?](?:<|N)?X?EV?L?s?\+?$/.test(row.state);
  const diagnosticRow = (observation) => {
    const { row, collection } = observation;
    const cpuTimeText = boundedText(row.cpuTimeText, DIAGNOSTIC_TEXT_LIMIT);
    const state = boundedText(row.state, DIAGNOSTIC_TEXT_LIMIT);
    const command = boundedText(row.command, DIAGNOSTIC_COMMAND_LIMIT);
    return {
      cpuTimeText: cpuTimeText.value,
      cpuTimeMs: row.cpuTimeMs,
      ppid: row.ppid,
      state: state.value,
      command: command.value,
      commandTruncated: command.truncated,
      collectionStartedMs: collection.collectionStartedMs,
      collectionCompletedMs: collection.collectionCompletedMs,
    };
  };
  const diagnosticIdentity = (row) => ({
    pid: row.pid,
    started: boundedText(row.started, DIAGNOSTIC_TEXT_LIMIT).value,
  });
  const createDiagnostic = ({
    kind,
    message,
    root,
    prior,
    current,
    rows,
    owned,
  }) => {
    const error = new Error(message);
    error.failureDiagnostic = {
      schemaVersion: 1,
      kind,
      rootIdentity: diagnosticIdentity(root),
      identity: diagnosticIdentity(current.row),
      prior: diagnosticRow(prior),
      current: diagnosticRow(current),
      deltaMs: current.row.cpuTimeMs - prior.row.cpuTimeMs,
      collection: {
        startedMs: current.collection.collectionStartedMs,
        completedMs: current.collection.collectionCompletedMs,
        costMs:
          current.collection.collectionStartedMs === undefined ||
          current.collection.collectionCompletedMs === undefined
            ? undefined
            : current.collection.collectionCompletedMs -
              current.collection.collectionStartedMs,
        parsedRowCount: rows.length,
        ownedRowCount: owned.size,
        ledgerIdentityCount: ledger.size,
      },
    };
    return error;
  };
  return {
    observe(rows, atMs, collection) {
      if (!Number.isFinite(atMs) || (previousAt !== null && atMs <= previousAt))
        throw new Error('Non-monotonic sample timestamp');
      const root = rows.find((row) => row.pid === rootPid);
      if (!root || (rootIdentity && rootIdentity !== identity(root)))
        throw new Error('Owned Electron root missing or PID reused');
      const nextRootIdentity = rootIdentity ?? identity(root);
      // Retain previously observed descendants across reparenting, provided
      // their PID+start identity matches. Unrelated trees are never included.
      const owned = new Set(
        rows
          .filter((row) => row.pid === rootPid || ledger.has(identity(row)))
          .map((row) => row.pid),
      );
      let changed;
      do {
        changed = false;
        for (const row of rows) {
          if (!owned.has(row.pid) && owned.has(row.ppid)) {
            owned.add(row.pid);
            changed = true;
          }
        }
      } while (changed);
      const processes = rows.filter((row) => owned.has(row.pid));
      const nextLedger = new Map(ledger);
      const nextTerminalObservations = new Map(terminalObservations);
      for (const row of processes) {
        if (
          !Number.isFinite(row.cpuTimeMs) ||
          row.cpuTimeMs < 0 ||
          !Number.isFinite(row.rssKb) ||
          row.rssKb < 0
        )
          throw new Error('Missing or invalid owned process resource data');
        const key = identity(row);
        const current = snapshotObservation(row, collection);
        const prior = ledger.get(key);
        const terminalPrior = terminalObservations.get(key);
        const zombie = isConfirmedZombie(row);
        const terminal = zombie || isConfirmedExiting(row);
        // Exiting may progress to zombie, but zombie cannot become exiting
        // or live again under the same PID/start identity.
        const terminalRegression =
          terminalPrior &&
          (!terminal || (isConfirmedZombie(terminalPrior.row) && !zombie));
        if (terminalRegression)
          throw createDiagnostic({
            kind: 'owned-terminal-identity-became-nonterminal',
            message: 'Owned terminal process identity became nonterminal',
            root,
            prior: terminalPrior,
            current,
            rows,
            owned,
          });
        if (prior && row.cpuTimeMs < prior.row.cpuTimeMs) {
          if (row.pid !== rootPid && terminal) {
            nextTerminalObservations.set(key, current);
            continue;
          }
          throw createDiagnostic({
            kind: 'owned-process-cumulative-cpu-decreased',
            message: 'Owned process cumulative CPU decreased',
            root,
            prior,
            current,
            rows,
            owned,
          });
        }
        nextLedger.set(key, current);
        if (row.pid !== rootPid && terminal)
          nextTerminalObservations.set(key, current);
      }
      // Keep each exited child's last cumulative CPU: summing only live
      // processes would produce negative deltas on exit. The cumulative ledger
      // is a lower bound because CPU after its last observation is unavailable.
      // Its DELTA RATE is not exact interval CPU or an interval lower bound:
      // newly discovered children can add CPU from before the previous sample.
      const observedCumulativeCpuMs = [...nextLedger.values()].reduce(
        (sum, observation) => sum + observation.row.cpuTimeMs,
        0,
      );
      const observedCpuDeltaMs =
        previousTotal === null ? null : observedCumulativeCpuMs - previousTotal;
      const intervalMs = previousAt === null ? null : atMs - previousAt;
      const observedCpuLedgerDeltaRatePercent =
        intervalMs === null ? null : (observedCpuDeltaMs / intervalMs) * 100;
      ledger.clear();
      for (const [key, observation] of nextLedger) ledger.set(key, observation);
      terminalObservations.clear();
      for (const [key, observation] of nextTerminalObservations)
        terminalObservations.set(key, observation);
      rootIdentity = nextRootIdentity;
      previousTotal = observedCumulativeCpuMs;
      previousAt = atMs;
      return {
        atMs,
        processes,
        observedCumulativeCpuMs,
        observedCpuDeltaMs,
        intervalMs,
        observedCpuLedgerDeltaRatePercent,
        // Compatibility alias; same ledger-delta-rate semantics, not interval CPU.
        observedCpuPercent: observedCpuLedgerDeltaRatePercent,
        rssKb: processes.reduce((sum, row) => sum + row.rssKb, 0),
        observedProcessIdentities: nextLedger.size,
      };
    },
  };
}

export function assertEarlyStartupCoverage(raw, firstWindowMs) {
  const early = raw.samples.filter(
    (sample) => sample.collectionCompletedMs < firstWindowMs,
  );
  if (
    raw.error ||
    !Number.isFinite(raw.pidObservedMs) ||
    !Number.isFinite(firstWindowMs) ||
    early.length < 2
  )
    throw new Error(
      `Earliest startup resource coverage invalid: ${early.length} pre-window samples; ${raw.error ?? 'two required'}`,
    );
  return {
    preWindowSampleCount: early.length,
    firstSampleMs: early[0].atMs,
    lastPreWindowSampleMs: early.at(-1).atMs,
    preWindowObservedCumulativeCpuMs: early.at(-1).observedCumulativeCpuMs,
    preWindowPeakRssKb: Math.max(...early.map((sample) => sample.rssKb)),
  };
}

export function startStartupSampler({
  pidFile,
  parsePid,
  launchStartedAt,
  intervalMs = 100,
  pidTimeoutMs = 30_000,
  platform = process.platform,
  readPidFile = readFile,
  executePs = exec,
  wait = delay,
  monotonicNow = () => performance.now(),
}) {
  if (platform !== 'darwin')
    throw new Error(
      'Startup resource sampling supports macOS only; do not compare across OSes',
    );
  const raw = {
    cpuRateSemantics:
      'Observed cumulative-ledger delta divided by sample interval; includes pre-interval CPU of newly discovered children. observedCpuPercent is a compatibility alias for observedCpuLedgerDeltaRatePercent, not exact interval CPU or an interval lower bound.',
    intervalMs,
    pidPollIntervalMs: 10,
    pidTimeoutMs,
    pidObservedMs: null,
    rootPid: null,
    samples: [],
    error: null,
    failureDiagnostic: null,
  };
  let stopped = false;
  const elapsed = () => monotonicNow() - launchStartedAt;
  const loop = (async () => {
    try {
      while (!stopped && raw.rootPid === null) {
        try {
          const contents = await readPidFile(pidFile, 'utf8');
          // writeFile may have opened but not completed its tiny write yet.
          if (contents.trim()) raw.rootPid = parsePid(contents);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (raw.rootPid !== null) raw.pidObservedMs = elapsed();
        else {
          if (elapsed() >= pidTimeoutMs)
            throw new Error('Timed out waiting for supervised Electron PID');
          await wait(10);
        }
      }
      if (stopped) return;
      const ledger = createOwnedCpuLedger(raw.rootPid);
      while (!stopped) {
        const collectionStartedMs = elapsed();
        const { stdout } = await executePs(
          '/bin/ps',
          ['-axo', 'pid=,ppid=,time=,rss=,state=,lstart=,comm='],
          {
            env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
            timeout: 5000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        const collectionCompletedMs = elapsed();
        raw.samples.push({
          ...ledger.observe(parsePsSnapshot(stdout), collectionCompletedMs, {
            collectionStartedMs,
            collectionCompletedMs,
          }),
          collectionStartedMs,
          collectionCompletedMs,
          collectionCostMs: collectionCompletedMs - collectionStartedMs,
        });
        await wait(Math.max(0, intervalMs - (elapsed() - collectionStartedMs)));
      }
    } catch (error) {
      raw.error = error.stack ?? String(error);
      raw.failureDiagnostic = error.failureDiagnostic ?? null;
    }
  })();
  return {
    raw,
    async stop() {
      stopped = true;
      await loop;
      return raw;
    },
  };
}

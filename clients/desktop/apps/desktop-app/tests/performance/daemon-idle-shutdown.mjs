import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import {
  arch,
  cpus,
  loadavg,
  constants as osConstants,
  release,
} from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  killProcessTree,
  posixProcessGroupIsOwned,
} from './process-tree-supervisor.mjs';
import { summarize } from './statistics.mjs';

const POLL_MS = 25;

/** Daemon defaults (daemon.ts, leases.ts); 90 s censors a stop, it is no budget. */
export const LIFECYCLE_DEFAULTS = Object.freeze({
  idleGraceMs: 30_000,
  reconnectGraceMs: 10_000,
  censorMs: 90_000,
});
export const POPULATION_DEFAULTS = Object.freeze({
  cycles: 20,
  idleWindowMs: 60_000,
  warmUpMs: 15_000,
  warmUpTrials: 1,
  reapSettleMs: 1_000,
  readyTimeoutMs: 20_000,
});
export const STOP_MODES = ['signal', 'idle-grace'];
export const POPULATION_ARMS = ['standalone', 'product-on', 'flag-off'];

/** Document 05 performance bullets under their performance-baseline.mjs keys. */
export const REQUIREMENTS = Object.freeze({
  idle_resources: 'idle CPU, wakeups, network, and open handles',
  process_memory: 'main, daemon, renderer, and child-process private memory',
  shutdown_drain: 'shutdown/drain duration and orphan count',
});

const IDLE_UNITS = {
  idleCpuNs: 'ns',
  idlePackageIdleWakeups: 'count',
  idleInterruptWakeups: 'count',
  idleNettopTcpUdpReceivedBytes: 'bytes',
  idleNettopTcpUdpSentBytes: 'bytes',
  openFileDescriptors: 'count',
  machIpcInUseNameEntries: 'count',
};
const DIAGNOSTIC_UNITS = {
  residentBytes: 'bytes',
  physicalFootprintBytes: 'bytes',
};
const drainMetric = (stop) =>
  stop === 'signal' ? 'shutdownDrainMs' : 'idleGraceExitMs';

/** Only standalone daemons are collected; product arms need authoritative provenance. */
export function resolvePopulation(arm) {
  if (arm === 'standalone') return { arm, status: 'collected' };
  if (!POPULATION_ARMS.includes(arm))
    throw new Error(`Unknown population arm: ${arm}`);
  const reason =
    'Labs availability, choice, enabled, readiness, generation and source provenance (CAN-4603) is not merged; this population is never inferred from counters or substituted.';
  return { arm, status: 'unavailable', reason };
}

/**
 * `ps -A -o pid=,pgid=,ppid=,stat=,lstart=` under TZ=UTC. macOS `proc_pidinfo`
 * answers ESRCH for a zombie, exactly as for a reaped process, so this table is
 * the source of post-exit state. `startSec` is lstart's whole second.
 */
export function parseProcessTable(stdout) {
  const rows = new Map();
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    const [, ...fields] =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line) ?? [];
    const [pid, pgid, ppid] = fields.slice(0, 3).map(Number);
    const startMs = Date.parse(`${fields[4]} GMT`);
    if (!Number.isFinite(startMs) || rows.has(pid))
      throw new Error('Invalid ps process row');
    const zombie = fields[3].includes('Z');
    rows.set(pid, { pid, pgid, ppid, zombie, startSec: startMs / 1000 });
  }
  return rows;
}

export async function listProcessTable() {
  const { stdout } = await promisify(execFile)(
    'ps',
    ['-A', '-o', 'pid=,pgid=,ppid=,stat=,lstart='],
    { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 1 << 24 },
  );
  return parseProcessTable(stdout);
}

/** `rootPid` and its descendants by parent PID, zombies included. */
export function treeDescendants(table, rootPid) {
  const tree = new Set([rootPid]);
  for (let size = 0; size !== tree.size; ) {
    size = tree.size;
    for (const row of table.values()) if (tree.has(row.ppid)) tree.add(row.pid);
  }
  return [...table.values()].filter((row) => tree.has(row.pid));
}

/** Zombie descendants of `rootPid`, which native tree discovery cannot see. */
export function zombieDescendants(table, rootPid) {
  return treeDescendants(table, rootPid)
    .filter((row) => row.zombie)
    .map(({ pid, startSec }) => ({ pid, startId: null, startSec }));
}

/** Post-exit state of a retained identity; a reused PID has another start second. */
export function classifyIdentity({ pid, startSec }, table) {
  if (!table) return 'unknown';
  const listed = table.get(pid);
  if (listed?.startSec !== startSec) return 'exited';
  return listed.zombie ? 'zombie' : 'live';
}

/** Counts only: no names, paths or token contents leave the runtime directory. */
export async function observePublication(runtimeDirectory, endpointPath) {
  const failed = (missing) => (error) =>
    error.code === 'ENOENT' ? missing : `error:${error.code}`;
  const entries = await readdir(runtimeDirectory).catch(failed([]));
  const endpoint =
    endpointPath && (await lstat(endpointPath).then(() => true, failed(false)));
  const error = [entries, endpoint].find((value) => typeof value === 'string');
  if (error) return { residue: null, error };
  const descriptor = entries.includes('core.json');
  const tokenFiles = entries.filter((name) => name.endsWith('.token')).length;
  const otherEntries = entries.length - tokenFiles - Number(descriptor);
  const residue = entries.length > 0 || endpoint === true;
  return { descriptor, tokenFiles, otherEntries, endpoint, residue };
}

// A known value is a number; an unknown one is the string naming its first cause.
const known = (value) => typeof value === 'number';
const counter = (raw) => (raw == null ? 'counter_missing' : Number(raw));
const quantity = (q) =>
  q.status === 'ok'
    ? Number(q.value)
    : `${q.status}:${q.reason ?? `${q.stage}:${q.code}`}`;
const delta = (a, b) =>
  !known(a) ? a : !known(b) ? b : b < a ? 'negative_delta' : b - a;
const total = (values) =>
  values.find((value) => !known(value)) ?? values.reduce((a, b) => a + b, 0);

function windowMembership(rootPid, { start, end }, zombies) {
  const live = ({ processes }) =>
    processes.some((row) => row.pid === rootPid) &&
    processes.every((row) => row.state === 'live');
  const members = ({ processes }) =>
    processes
      .map((row) => `${row.pid}:${row.startId}`)
      .sort()
      .join();
  // A tree member whose sample failed has an error row but no process row.
  const unreadable = ({ processes, errors }) =>
    errors.some(
      (error) =>
        error.startId !== null &&
        !processes.some((row) => row.pid === error.pid),
    );
  if (start.truncated || end.truncated) return 'truncated';
  if (unreadable(start) || unreadable(end)) return 'member_unreadable';
  if (!zombies) return 'process_table_unavailable';
  if (zombies.length || !live(start) || !live(end))
    return 'root_missing_or_zombie';
  return members(start) === members(end) ? 'stable' : 'changed';
}

/**
 * Deltas and end levels over the window's processes. Truncated discovery, a
 * missing or zombie process, changed membership or an unreadable table makes
 * every total unknown, never zero. Diagnostics stay out of the metrics.
 */
export function measureIdleWindow(rootPid, raw, zombies, nominalMs) {
  const membership = windowMembership(rootPid, raw, zombies);
  const find = (sample, row) =>
    sample.processes.find(
      (o) => o.pid === row.pid && o.startId === row.startId,
    );
  const over = (value) =>
    membership === 'stable'
      ? total(raw.start.processes.map((row) => value(row, find(raw.end, row))))
      : `membership:${membership}`;
  const counters = (...fields) =>
    over((a, b) =>
      total(fields.map((f) => delta(counter(a[f]), counter(b[f])))),
    );
  const level = (name) => over((_, b) => quantity(b.quantities[name]));
  const network = (name) =>
    over((row) =>
      raw.netStart && raw.netEnd
        ? delta(
            ...[raw.netStart, raw.netEnd].map((sample) =>
              quantity(find(sample, row).quantities[name]),
            ),
          )
        : 'network_unavailable',
    );
  const measuredMs = raw.end.monotonicStartMs - raw.start.monotonicStartMs;
  return {
    membership,
    metrics: {
      idleCpuNs: counters('userCpuNs', 'systemCpuNs'),
      idlePackageIdleWakeups: counters('packageIdleWakeups'),
      idleInterruptWakeups: counters('interruptWakeups'),
      idleNettopTcpUdpReceivedBytes: network('nettopTcpUdpReceivedBytes'),
      idleNettopTcpUdpSentBytes: network('nettopTcpUdpSentBytes'),
      openFileDescriptors: level('openFileDescriptors'),
      machIpcInUseNameEntries: level('machIpcInUseNameEntries'),
    },
    diagnostics: Object.fromEntries(
      Object.keys(DIAGNOSTIC_UNITS).map((f) => [
        f,
        over((_, b) => counter(b[f])),
      ]),
    ),
    timing: {
      nominalMs,
      measuredMs,
      cadenceErrorMs: measuredMs - nominalMs,
      skewBoundMs: Math.max(
        ...[raw.start, raw.end].map(
          (s) => s.monotonicEndMs - s.monotonicStartMs,
        ),
      ),
    },
  };
}

/**
 * Members of the daemon's process group, or why they are not attributable.
 * Once the daemon is reaped, a listed leader means its PID was recycled.
 */
export function daemonGroup(table, daemonPid, reaped) {
  if (!table) return 'process_table_unavailable';
  if (reaped && table.has(daemonPid)) return 'process_group_recycled';
  return [...table.values()]
    .filter((row) => row.pgid === daemonPid)
    .map(({ pid, zombie, startSec }) => ({ pid, zombie, startSec }));
}

/**
 * Survivors after exit; unobserved identities or group members leave both
 * unknown. A group member that reuses a retained identity's PID is late.
 */
export function countSurvivors(descendants, groupMembers) {
  const unknown = [descendants, groupMembers].find((v) => !Array.isArray(v));
  if (unknown)
    return {
      orphanCount: unknown,
      unreapedCount: unknown,
      lateGroupMembers: [],
    };
  const key = ({ pid, startSec }) => `${pid}:${startSec}`;
  const retained = new Set(descendants.map(key));
  const late = groupMembers.filter((member) => !retained.has(key(member)));
  const count = (status, zombie) =>
    descendants.filter((entry) => entry.status === status).length +
    late.filter((entry) => entry.zombie === zombie).length;
  return {
    orphanCount: count('live', false),
    unreapedCount: count('zombie', true),
    lateGroupMembers: late,
  };
}

/** One value per launch, so samples are clustered by launch, never inflated. */
export function summarizeLaunches(values) {
  const unknownReasons = {};
  for (const value of values.filter((v) => !known(v)))
    unknownReasons[value] = (unknownReasons[value] ?? 0) + 1;
  const { count, p50, p95, max } = summarize(values);
  const unknown = values.length - count;
  return {
    launches: values.length,
    observed: count,
    unknown,
    unknownReasons,
    p50,
    p95,
    max,
  };
}

/**
 * The observed phases each shutdown metric needs. A metric is a number only
 * when every input phase is `true`; otherwise it is the first other state.
 * `stop`, `exit` and `clean` are content checks, the rest are reads.
 */
export const SHUTDOWN_INPUTS = Object.freeze({
  drain: ['stop', 'exit', 'clean'],
  publicationWithdrawnMs: [
    'stop',
    'exit',
    'clean',
    'before-stop',
    'withdrawal',
  ],
  survivors: ['exit', 'window-start', 'window-end', 'pre-stop', 'settled'],
});
/** Read phases retained as evidence only; no shutdown metric depends on them. */
export const EVIDENCE_PHASES = Object.freeze([
  'preparation',
  'network-start',
  'network-end',
  'at-exit',
  'publication-at-exit',
  'publication-settled',
]);

const isFailure = (state) =>
  typeof state === 'string' && !state.startsWith('not_observed:');

/** Every phase starts unobserved; a recorded failure is never overwritten. */
function mark(observed, phase, state) {
  if (!isFailure(observed[phase])) observed[phase] = state;
}

function gated(observed, inputs, value) {
  const unmet = inputs.map((phase) => observed[phase]).find((s) => s !== true);
  return unmet ?? value;
}

/**
 * Wraps reads so their duration and harness CPU are retained as overhead, and
 * each outcome is recorded against its phase. A publication read reports its
 * failure in-band as an `error` string. `onRead` is a test seam that may throw
 * to fault the read.
 */
function createObserverLedger(observed, onRead) {
  const calls = [];
  async function observe(kind, phase, read) {
    const [cpu, startMs] = [process.cpuUsage(), performance.now()];
    let error = null;
    try {
      onRead?.(kind, phase);
      const value = await read();
      if (typeof value?.error === 'string') error = value.error;
      return value;
    } catch (thrown) {
      error = thrown.message;
      throw thrown;
    } finally {
      const { user, system } = process.cpuUsage(cpu);
      const durationMs = performance.now() - startMs;
      const reason = error === null ? null : `unreadable:${kind}:${phase}`;
      const last = calls.at(-1);
      // One entry per run of successful reads, so a 30 s withdrawal poll stays small.
      if (!reason && last?.ok && last.kind === kind && last.phase === phase) {
        last.count += 1;
        last.durationMs += durationMs;
        last.harnessCpuUs += user + system;
      } else
        calls.push({
          kind,
          phase,
          ok: !reason,
          ...(reason && { reason, error }),
          count: 1,
          durationMs,
          harnessCpuUs: user + system,
        });
      mark(observed, phase, reason ?? true);
    }
  }
  return { calls, observe };
}

const PHASES = [
  ...new Set([...Object.values(SHUTDOWN_INPUTS).flat(), ...EVIDENCE_PHASES]),
];
const unobserved = () =>
  Object.fromEntries(PHASES.map((phase) => [phase, `not_observed:${phase}`]));

const exitOf = ({ exitCode: code, signalCode: signal }) =>
  code === null && signal === null ? null : { code, signal };

function waitForExit(child) {
  return new Promise((resolve) => {
    if (exitOf(child)) return resolve(exitOf(child));
    child.once('exit', (code, signal) => resolve({ code, signal }));
    // A failed spawn emits only 'error'.
    child.once('error', () => resolve({ code: null, signal: null }));
  });
}

/** `promise`, or null once `ms` elapse; the timer never outlives the race. */
async function within(promise, ms) {
  const controller = new AbortController();
  const timer = delay(ms, null, { signal: controller.signal });
  return Promise.race([promise, timer]).finally(() => controller.abort());
}

/** Polls until `probe` returns a value, the deadline passes or `signal` aborts. */
async function poll(probe, timeoutMs, signal) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined || performance.now() > deadline || signal?.aborted)
      return value;
    await delay(POLL_MS);
  }
}

const interrupted = (signal) => `interrupted:${signal.reason}`;

/**
 * SIGINT/SIGTERM abort `signal` instead of terminating, so the active launch
 * still stops, is observed and is cleaned up; no further launch starts.
 */
export function interruptOnSignals(names = ['SIGINT', 'SIGTERM']) {
  const controller = new AbortController();
  const onSignal = (name) => {
    if (controller.signal.aborted) return;
    console.error(
      `${name}: stopping, observing and cleaning up the active launch.`,
    );
    controller.abort(name);
  };
  for (const name of names) process.on(name, onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      for (const name of names) process.removeListener(name, onSignal);
    },
  };
}

/**
 * 128 + signal for an interrupted population, 1 for a failed one, otherwise 0;
 * read from the artifact, so the status and the exit code never disagree.
 */
export function runnerExitCode({ population }) {
  if (population.status === 'interrupted')
    return 128 + osConstants.signals[population.interrupted];
  return population.status === 'failed' ? 1 : 0;
}

/**
 * Adds identities to the trial's; none is dropped. A table-only identity
 * (no `startId`) never replaces a native one with the same start second.
 */
function retain(trial, identities) {
  const held = new Map((trial.identities ?? []).map((i) => [i.pid, i]));
  for (const identity of identities) {
    const known = held.get(identity.pid);
    const weaker =
      identity.startId === null && known?.startSec === identity.startSec;
    if (!weaker) held.set(identity.pid, identity);
  }
  trial.identities = [...held.values()];
}

/** Process rows and failed samples that still name their start identity. */
const nativeIdentities = ({ processes, errors }) =>
  [...processes, ...errors.filter(({ startId }) => startId !== null)].map(
    ({ pid, startId }) => ({
      pid,
      startId,
      startSec: Math.floor(Number(startId)),
    }),
  );

/** Each read of the daemon's tree, retained as soon as it succeeds. */
function treeReaders(trial, rootPid, deps, observe) {
  return {
    async native(phase) {
      const sample = await observe('native', phase, () =>
        deps.native.readTree(rootPid),
      );
      retain(trial, nativeIdentities(sample));
      return sample;
    },
    /** Live and zombie descendants alike; null when the read failed. */
    async table(phase) {
      const table = await observe('process-table', phase, deps.listTable).catch(
        () => null,
      );
      if (table)
        retain(
          trial,
          treeDescendants(table, rootPid).map(({ pid, startSec }) => ({
            pid,
            startId: null,
            startSec,
          })),
        );
      return table;
    },
  };
}

/**
 * The warmed daemon's idle window, bracketed by native, table and nettop reads.
 * Every read's identities are retained on `trial` at once, so cleanup can
 * still revalidate its descendants if a later read fails.
 */
async function observeIdleWindow(trial, rootPid, options, deps, observe) {
  const { idleWindowMs, signal } = options;
  const read = treeReaders(trial, rootPid, deps, observe);
  const start = await read.native('window-start');
  const daemon = start.processes.find((row) => row.pid === rootPid);
  const raw = { start };
  trial.daemon.startId = daemon?.startId ?? null;
  trial.raw = raw;
  const tables = [await read.table('window-start')];
  const ids = start.processes.map(({ pid, startId }) => ({ pid, startId }));
  const net = (phase) =>
    deps.network && observe('network', phase, () => deps.network.read(ids));
  raw.netStart = await net('network-start');
  const elapsedMs = performance.now() - start.monotonicStartMs;
  await delay(Math.max(0, idleWindowMs - elapsedMs), null, { signal });
  raw.end = await read.native('window-end');
  tables.push(await read.table('window-end'));
  const zombies = tables.every(Boolean)
    ? tables.flatMap((rows) => zombieDescendants(rows, rootPid))
    : null;
  raw.netEnd = await net('network-end');
  return measureIdleWindow(rootPid, raw, zombies, idleWindowMs);
}

/**
 * Attach, warm-up and idle window. A failure is returned, not thrown, so the
 * attributable daemon is still stopped and observed before cleanup.
 */
async function observeIdlePhase(trial, descriptor, options, deps, observe) {
  const { signal } = options;
  let session = null;
  try {
    session = await deps.attach(descriptor, options.dataRoot);
    await delay(options.warmUpMs, null, { signal });
    const renewals = session.renewals();
    trial.idle = await observeIdleWindow(
      trial,
      descriptor.pid,
      options,
      deps,
      observe,
    );
    trial.loadavg.end = loadavg();
    trial.harnessLoad = { leaseRenewals: session.renewals() - renewals };
    return { session, failure: null };
  } catch (error) {
    const aborted = error.name === 'AbortError' && signal?.aborted;
    const failure = aborted ? interrupted(signal) : error.message;
    return { session, failure };
  }
}

/**
 * Before every stop, re-reads the daemon's tree and table into the retained
 * identities; once the daemon exits, a detached descendant is findable only
 * through them. Each read is recorded on its own, never filled in.
 */
async function retainPreStopIdentities(trial, rootPid, deps, observe) {
  const read = treeReaders(trial, rootPid, deps, observe);
  const sample = await read.native('pre-stop').catch(() => null);
  const root = sample?.processes.find((row) => row.pid === rootPid);
  trial.daemon.startId ??= root?.startId ?? null;
  await read.table('pre-stop');
}

/** Publication, descendant and reaping state after exit, read before cleanup. */
async function observeAfterStop(trial, options, observe, phase) {
  const table = await observe('process-table', phase, options.listTable).catch(
    () => null,
  );
  return {
    publication: await options.readPublication(`publication-${phase}`),
    descendants:
      trial.identities?.map((identity) => ({
        ...identity,
        status: classifyIdentity(identity, table),
      })) ?? 'identities_unavailable',
    groupMembers: daemonGroup(table, trial.daemon.pid, !trial.exit.censored),
  };
}

/**
 * Sends the stop (or waits for the idle-grace one) while polling until the
 * descriptor is withdrawn or the daemon exits; `exit` is null when censored.
 * A failed poll read is recorded by the ledger and polling continues.
 */
async function stopDaemon(child, signal, options) {
  const stopAt = performance.now();
  let cut = false;
  // An interrupt cuts an idle-grace wait short with SIGTERM; never admitted.
  const cutShort = () => {
    cut = true;
    child.kill('SIGTERM');
  };
  if (signal) child.kill('SIGTERM');
  else if (options.signal?.aborted) cutShort();
  else options.signal?.addEventListener('abort', cutShort, { once: true });
  let withdrawnMs = null;
  let exitedAt = null;
  const withdrawn = poll(async () => {
    const seen = await options.readPublication('withdrawal');
    if (seen.descriptor === false) withdrawnMs = performance.now() - stopAt;
    return withdrawnMs !== null || exitedAt !== null || undefined;
  }, options.censorMs);
  const exit = await within(waitForExit(child), options.censorMs);
  exitedAt = performance.now();
  options.signal?.removeEventListener('abort', cutShort);
  await withdrawn;
  return { exit, drainMs: exitedAt - stopAt, withdrawnMs, cut };
}

/**
 * Releases the lease, stops the daemon and retains exit, publication,
 * descendant and reaping evidence; returns the launch's failure, if any.
 */
async function stopAndObserve(trial, session, child, options, observe) {
  const { observed } = trial;
  const beforeStop = await options.readPublication('before-stop');
  if (beforeStop.descriptor === false)
    mark(observed, 'before-stop', 'descriptor_absent_before_stop');
  trial.publication = { pollMs: POLL_MS, beforeStop };
  // A dropped connection fails release; the shutdown evidence is still retained.
  // A launch whose attach failed has no lease to release.
  const released =
    session &&
    ((await within(
      session.release().then(
        () => 'released',
        (error) => `release_failed: ${error.message}`,
      ),
      options.censorMs,
    )) ??
      'release_timed_out');
  // A daemon that died before the stop has no drain, but its residue still counts.
  const crashed = exitOf(child) && 'exited_before_stop';
  const signal = !crashed && options.stop === 'signal';
  const { exit, drainMs, withdrawnMs, cut } = await stopDaemon(
    child,
    signal,
    options,
  );
  const clean = exit?.code === 0 && !exit.signal;
  trial.exit = { ...exit, clean, censored: !exit };
  const stopCause = crashed || (cut && interrupted(options.signal));
  mark(observed, 'stop', stopCause || true);
  // A censored daemon is still running, so survivors cannot be counted yet.
  mark(observed, 'exit', exit ? true : 'censored');
  if (exit)
    mark(
      observed,
      'clean',
      clean || `unclean_exit:${exit.signal ?? exit.code}`,
    );
  trial.publication.atExit = await observeAfterStop(
    trial,
    options,
    observe,
    'at-exit',
  );
  await delay(options.reapSettleMs);
  const settled = await observeAfterStop(trial, options, observe, 'settled');
  trial.publication.settled = settled;
  if (typeof settled.groupMembers === 'string')
    mark(observed, 'settled', settled.groupMembers);
  const survivors = countSurvivors(settled.descendants, settled.groupMembers);
  const { drain, publicationWithdrawnMs, survivors: counted } = SHUTDOWN_INPUTS;
  trial.shutdown = {
    stop: options.stop,
    metrics: {
      [drainMetric(options.stop)]: gated(observed, drain, drainMs),
      publicationWithdrawnMs: gated(
        observed,
        publicationWithdrawnMs,
        withdrawnMs ?? 'descriptor_not_withdrawn',
      ),
      orphanCount: gated(observed, counted, survivors.orphanCount),
      unreapedCount: gated(observed, counted, survivors.unreapedCount),
    },
    publicationResidue: settled.publication.residue,
    lateGroupMembers: exit ? survivors.lateGroupMembers : [],
  };
  return stopCause || (released !== 'released' && released) || null;
}

/**
 * One launch: fresh profile, idle window, stop, then every exit, publication,
 * descendant and reaping observation is retained before cleanup runs. `deps`
 * supplies the daemon spawn, an authenticated leased attach, the native and
 * network readers, the process table and cleanup, so a fake daemon can drive it;
 * an optional `observePublication` replaces every publication read.
 */
async function runIdleShutdownTrial(options, deps) {
  const trial = {
    startedAt: new Date().toISOString(),
    loadavg: { start: loadavg() },
    observed: unobserved(),
  };
  const { observe, calls } = createObserverLedger(trial.observed, deps.onRead);
  const finish = (outcome, reason) => Object.assign(trial, { outcome, reason });
  let child = null;
  let session = null;
  const { signal } = options;
  const publicationOf = deps.observePublication ?? observePublication;
  const readPublication = (phase, endpointPath) =>
    observe('publication', phase, () =>
      publicationOf(options.runtimeDirectory, endpointPath),
    ).catch((error) => ({ residue: null, error: error.message }));
  try {
    trial.preparation = await readPublication('preparation');
    if (trial.preparation.residue === null)
      return finish('excluded', 'preparation_unreadable');
    if (trial.preparation.residue !== false)
      return finish('excluded', 'preparation_residue');
    // A signal during profile setup or the preflight starts no daemon.
    if (signal?.aborted) return finish('failed', interrupted(signal));
    child = deps.spawnDaemon(options.dataRoot);
    waitForExit(child); // Handles a failed spawn's 'error' event.
    const descriptorPath = join(options.runtimeDirectory, 'core.json');
    const readDescriptor = () =>
      readFile(descriptorPath, 'utf8').then(JSON.parse, () => undefined);
    // An exit ends the wait with an exit record, which has no PID.
    const descriptor = await poll(
      () => exitOf(child) ?? readDescriptor(),
      options.readyTimeoutMs,
      signal,
    );
    trial.exit = exitOf(child);
    if (!descriptor?.pid)
      return finish(
        'failed',
        signal?.aborted ? interrupted(signal) : 'not_published',
      );
    if (descriptor.pid !== child.pid)
      return finish('excluded', 'ambiguous_attribution');
    // Attributable from here on, so every outcome is stopped and observed.
    trial.daemon = { pid: child.pid, startId: null };
    let failure;
    ({ session, failure } = await observeIdlePhase(
      trial,
      descriptor,
      options,
      deps,
      observe,
    ));
    // Waiting out an idle grace after an interrupt is not worth the delay.
    if (!failure && signal?.aborted && options.stop !== 'signal')
      failure = interrupted(signal);
    await retainPreStopIdentities(trial, child.pid, deps, observe);
    const leased = session;
    session = null;
    const stopOptions = {
      ...options,
      // SIGTERM bounds a failed or interrupted launch's stop; neither is admitted.
      stop: failure ? 'signal' : options.stop,
      listTable: deps.listTable,
      readPublication: (phase) =>
        readPublication(phase, descriptor.endpoint?.path),
    };
    const stopFailure = await stopAndObserve(
      trial,
      leased,
      child,
      stopOptions,
      observe,
    );
    if (failure || stopFailure) return finish('failed', failure ?? stopFailure);
    if (trial.idle.membership === 'truncated')
      return finish('excluded', 'discovery_truncated');
    return finish('measured');
  } catch (error) {
    return finish('failed', error.message);
  } finally {
    trial.observer = calls;
    // A launch that failed before its stop still records whether it had exited.
    if (child) trial.exit ??= exitOf(child);
    await session?.release().catch(() => undefined);
    trial.cleanup = await deps.cleanup(child, trial);
  }
}

/**
 * Runs only after the trial's observations are retained: kills the daemon,
 * its group and revalidated live descendants, then removes the profile.
 */
export async function cleanupTrial(
  child,
  trial,
  { native, dataRoot, listTable },
) {
  const record = { killed: [], groupKilled: false, errors: [] };
  const attempt = (label, action) =>
    action().catch((error) => record.errors.push(`${label}: ${error.message}`));
  const kill = (pid) => {
    process.kill(pid, 'SIGKILL');
    record.killed.push(pid);
  };
  const rootPid = child?.pid;
  const settled = trial.publication?.settled?.groupMembers;
  const retained = [
    ...(trial.identities ?? []),
    ...(Array.isArray(settled) ? settled : []),
  ];
  await attempt('daemon', async () => {
    if (!rootPid || exitOf(child)) return;
    // Unreaped, so its PID and process group cannot have been recycled.
    kill(rootPid);
    record.groupKilled = true;
    await killProcessTree(rootPid, 'SIGKILL');
    await within(waitForExit(child), 5_000);
  });
  await attempt('group', async () => {
    if (!rootPid || record.groupKilled) return;
    const rows = [...(await listTable()).values()].map(
      ({ pid, pgid, startSec }) => ({ pid, pgid, startTime: startSec }),
    );
    // The leader is reaped: a listed leader is recycled (no leaderStart), and
    // a leaderless group is signalled only through a retained member identity.
    const members = new Map(
      retained.map(({ pid, startSec }) => [pid, startSec]),
    );
    const group = { pgid: rootPid, leaderStart: null, members };
    record.groupKilled = posixProcessGroupIsOwned(group, rows);
    if (record.groupKilled) await killProcessTree(rootPid, 'SIGKILL');
  });
  // Only exact start identities, revalidated by a native read, are killed.
  const descendants = (trial.identities ?? []).filter(
    ({ pid, startId }) => pid !== rootPid && startId !== null,
  );
  if (descendants.length)
    await attempt('descendants', async () => {
      for (const row of (await native.read(descendants)).processes) {
        if (row.state !== 'live') continue;
        try {
          kill(row.pid);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    });
  await attempt('data root', () =>
    rm(dataRoot, { recursive: true, force: true }),
  );
  record.dataRootRemoved = !record.errors.some((e) =>
    e.startsWith('data root'),
  );
  return record;
}

/** A launch whose profile cannot be created fails alone; earlier ones stand. */
async function runLaunch(config, deps) {
  let dataRoot;
  try {
    dataRoot = await deps.createDataRoot();
  } catch (error) {
    const reason = `data_root_failed: ${error.message}`;
    return { outcome: 'failed', reason, observer: [] };
  }
  const cleanup = (child, trial) =>
    cleanupTrial(child, trial, { ...deps, dataRoot });
  const runtimeDirectory = join(dataRoot, 'runtime');
  const options = {
    ...config,
    dataRoot,
    runtimeDirectory,
    signal: deps.signal,
  };
  return runIdleShutdownTrial(options, { ...deps, cleanup });
}

/** Declared warm-up launches run first and stay in the raw trials only. */
export async function runIdleShutdownPopulation(config, deps) {
  const trials = [];
  const collected = resolvePopulation(config.arm).status === 'collected';
  const launches = collected ? config.cycles + config.warmUpTrials : 0;
  const { signal } = deps;
  for (let index = 0; index < launches && !signal?.aborted; index++) {
    trials.push(await runLaunch(config, deps));
    deps.onTrial?.(trials.at(-1), index);
  }
  const { arm, stop, ...settings } = config;
  const context = { ...deps.context, ...settings };
  const interruptedBy = signal?.aborted ? signal.reason : null;
  return publishIdleShutdown({ arm, stop, trials, context, interruptedBy });
}

const sumOf = (field) => (trial) =>
  trial.observer.reduce((sum, call) => sum + call[field], 0);
const OBSERVATION_UNITS = {
  overheadMs: ['ms', sumOf('durationMs')],
  harnessCpuUs: ['us', sumOf('harnessCpuUs')],
  leaseRenewals: ['count', (trial) => trial.harnessLoad.leaseRenewals],
  cadenceErrorMs: ['ms', (trial) => trial.idle.timing.cadenceErrorMs],
  skewBoundMs: ['ms', (trial) => trial.idle.timing.skewBoundMs],
};
const HASHES = [
  'sourceSha256',
  'helperSha256',
  'nettopSha256',
  'collectorSha256',
];
const LIMITATIONS = [
  'No numeric budgets; 90 s is censoring, not acceptance.',
  'No historical H1/H2 comparison is claimed.',
  'Split-worker composition and the planned first workspace snapshot are absent.',
  'Window totals cover processes alive at both snapshots; tree discovery misses short-lived children.',
  "Survivor counts cover identities retained from the window and pre-stop reads plus the daemon's process group at the settle read; a descendant outside that group that no such read linked to the daemon by parent PID (for example, one spawned detached while draining) is not counted.",
  'Daemon cold start and warm attach belong to the start/attach population (CAN-4607).',
  'No writer, Files route or Labs choice is activated.',
];

/** Raw attempts, outcomes and shutdown tallies, warm-ups included. */
function tallyTrials(trials, admitted, warmUpTrials) {
  const reasons = (outcome) =>
    trials.filter((trial) => trial.outcome === outcome).map((t) => t.reason);
  const count = (predicate) => trials.filter(predicate).length;
  return {
    attempts: trials.length,
    measured: reasons('measured').length,
    warmUpExcluded: Math.min(warmUpTrials, trials.length),
    admitted: admitted.length,
    failures: reasons('failed'),
    exclusions: reasons('excluded'),
    censored: count(({ exit }) => exit?.censored),
    // Only stopped launches; one that exited before publishing was never stopped.
    uncleanExits: count(({ exit, shutdown }) => shutdown && !exit.clean),
    publicationResidueOrUnknown: count(
      ({ shutdown }) => shutdown && shutdown.publicationResidue !== false,
    ),
    cleanupErrors: trials.flatMap(({ cleanup }) => cleanup?.errors ?? []),
  };
}

/**
 * A collected arm is `interrupted` when a signal cut it short and `failed`
 * when no launch was admitted; either way the reason names what happened.
 */
function populationShortfall(trials, admitted, context, interruptedBy) {
  const planned = context.cycles + context.warmUpTrials;
  if (interruptedBy)
    return {
      status: 'interrupted',
      interrupted: interruptedBy,
      reason: `${interruptedBy} after ${trials.length} of ${planned} launches; ${admitted.length} admitted.`,
    };
  if (admitted.length) return null;
  const causes = trials.map((t, i) =>
    i < context.warmUpTrials
      ? `warm-up ${t.outcome}`
      : `${t.outcome}${t.reason ? `: ${t.reason}` : ''}`,
  );
  return {
    status: 'failed',
    reason: `No launch was admitted from ${trials.length} attempts (${causes.join('; ') || 'none'}).`,
  };
}

/** Each metric is published under its document 05 requirement and population. */
export function publishIdleShutdown({
  arm,
  stop,
  trials,
  context,
  interruptedBy = null,
}) {
  const population = resolvePopulation(arm);
  const collected = population.status === 'collected';
  const unavailable = { status: 'unavailable', reason: population.reason };
  const admitted = trials.filter(
    (trial, i) => trial.outcome === 'measured' && i >= context.warmUpTrials,
  );
  const shortfall =
    collected && populationShortfall(trials, admitted, context, interruptedBy);
  // Each name maps to [unit, pick(trial)]; one value per admitted launch.
  const summaries = (table) =>
    Object.fromEntries(
      Object.entries(table).map(([name, [unit, pick]]) => {
        const values = admitted.map((trial) => pick(trial) ?? 'not_observed');
        return [name, { unit, values, ...summarizeLaunches(values) }];
      }),
    );
  const section = (units, pick) =>
    summaries(
      Object.fromEntries(
        Object.entries(units).map(([name, unit]) => [
          name,
          [unit, (trial) => pick(trial)[name]],
        ]),
      ),
    );
  // An interrupted population keeps its admitted values under its own status.
  const requirement = (key, metrics, reason = population.reason) => ({
    requirement: key,
    text: REQUIREMENTS[key],
    population: arm,
    ...(!collected || !metrics
      ? { status: 'unavailable', reason }
      : !shortfall
        ? { status: 'collected', metrics }
        : {
            status: shortfall.status,
            reason: shortfall.reason,
            ...(admitted.length && { metrics }),
          }),
  });
  const shutdownUnits = {
    [drainMetric(stop)]: 'ms',
    publicationWithdrawnMs: 'ms',
    orphanCount: 'count',
    unreapedCount: 'count',
  };
  const distinct = (field) =>
    [
      ...new Set(
        trials.flatMap(({ raw }) => [
          raw?.start[field],
          raw?.netStart?.[field],
        ]),
      ),
    ].filter(Boolean);
  return {
    schemaVersion: 1,
    benchmarkKind: 'daemon-idle-shutdown',
    generatedAt: new Date().toISOString(),
    population: {
      ...population,
      ...shortfall,
      stop,
      ...(collected && tallyTrials(trials, admitted, context.warmUpTrials)),
    },
    context,
    requirements: [
      requirement(
        'idle_resources',
        section(IDLE_UNITS, (t) => t.idle.metrics),
      ),
      requirement(
        'shutdown_drain',
        section(shutdownUnits, (t) => t.shutdown.metrics),
      ),
      requirement(
        'process_memory',
        null,
        'Private-memory semantics are not qualified; resident and footprint bytes are diagnostics only.',
      ),
    ],
    observation: collected
      ? {
          artifacts: Object.fromEntries(HASHES.map((f) => [f, distinct(f)])),
          ...summaries(OBSERVATION_UNITS),
        }
      : unavailable,
    diagnostics: collected
      ? {
          approvedPrivateBytes: false,
          metrics: section(DIAGNOSTIC_UNITS, (t) => t.idle.diagnostics),
        }
      : unavailable,
    limitations: LIMITATIONS,
    trials,
  };
}

const sha256File = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

/** Host, artifact and helper identity retained alongside every population. */
export async function collectContext({ executable, collectors, options }) {
  const collectorSha256 = {};
  for (const path of collectors)
    collectorSha256[path.split('/').at(-1)] = await sha256File(path);
  return {
    platform: process.platform,
    arch: arch(),
    osRelease: release(),
    node: process.version,
    cpuCount: cpus().length,
    executableSha256: await sha256File(executable),
    collectorSha256,
    lifecycleDefaults: LIFECYCLE_DEFAULTS,
    ...options,
  };
}

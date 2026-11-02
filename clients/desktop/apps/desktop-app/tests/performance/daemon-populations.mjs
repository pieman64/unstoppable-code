// Population plans, trial classification, arm preparation checks and raw
// statistical output for daemon start/attach and Files treatment measurements.
// No numeric budget lives here: these are measurement rules only.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessHostMeasurement } from './host-measurement.mjs';
import { summarize } from './statistics.mjs';

export const STANDALONE_POPULATIONS = Object.freeze([
  'fresh-root-cold',
  'reused-root-cold',
  'retained-warm-attach',
]);

export const POPULATION_PLAN = Object.freeze({
  standalone: Object.freeze({
    repetitions: 20,
    warmups: 1,
    // Product lifecycle defaults: 10 s reconnect grace, 30 s idle grace.
    // 90 s is a censoring bound for exit observation, not a budget.
    exitCensorMs: 90_000,
  }),
  files: Object.freeze({
    workloads: Object.freeze(['query', 'visible']),
    launchesPerArm: 20,
    warmupLaunchesPerArm: 1,
    directories: 80,
    filesPerDirectory: 120,
    targetsPerLaunch: 10,
  }),
});

/**
 * Launch order for one Files workload: one declared warm-up per arm, then
 * ABBA blocks so linear drift cancels between arms.
 */
export function abbaSchedule({
  launchesPerArm = POPULATION_PLAN.files.launchesPerArm,
  warmupsPerArm = POPULATION_PLAN.files.warmupLaunchesPerArm,
  arms = ['off', 'on'],
} = {}) {
  if (launchesPerArm % 2 !== 0) throw new Error('ABBA needs an even count');
  const [a, b] = arms;
  const schedule = [];
  for (let index = 0; index < warmupsPerArm; index += 1)
    schedule.push(
      { arm: index % 2 ? b : a, warmup: true },
      {
        arm: index % 2 ? a : b,
        warmup: true,
      },
    );
  for (let block = 0; block < launchesPerArm / 2; block += 1)
    for (const arm of [a, b, b, a]) schedule.push({ arm, warmup: false });
  return schedule.map((entry, launch) => ({ launch, ...entry }));
}

/** Fixture directory names, `dir-00` … `dir-79`, each holding 120 files. */
export function fixtureDirectories({
  directories = POPULATION_PLAN.files.directories,
} = {}) {
  return Array.from(
    { length: directories },
    (_, index) => `dir-${String(index).padStart(2, '0')}`,
  );
}

/** Writes the Files fixture; keep `root` outside the profile so a refresh never touches choices. */
export async function writeFilesFixture(root, plan = POPULATION_PLAN.files) {
  for (const name of fixtureDirectories(plan)) {
    await mkdir(join(root, name), { recursive: true });
    await Promise.all(
      Array.from({ length: plan.filesPerDirectory }, (_, index) =>
        writeFile(
          join(root, name, `file-${String(index).padStart(3, '0')}.txt`),
          '',
        ),
      ),
    );
  }
}

/** Ten distinct targets, never read earlier in this launch. */
export function directoryTargets(launch, plan = POPULATION_PLAN.files) {
  const names = fixtureDirectories(plan);
  const offset = (launch * plan.targetsPerLaunch) % names.length;
  return Array.from(
    { length: plan.targetsPerLaunch },
    (_, index) => names[(offset + index) % names.length],
  );
}

/** The daemon socket lives under the data root and must fit `sun_path`. */
export function shortTemporaryBase(platform, fallback) {
  return platform === 'win32' ? fallback : '/tmp';
}

export function standaloneDataRoot(work, population, index) {
  return population === 'fresh-root-cold'
    ? join(work, `fresh-${index}`)
    : join(work, population);
}

/** Every data root a standalone run will use, checked before any trial. */
export function standaloneDataRoots(
  work,
  { populations, warmups, repetitions },
) {
  const roots = new Set();
  for (const population of populations) {
    // A shared root also hosts the warm-attach holder, even without trials.
    const count = population === 'fresh-root-cold' ? warmups + repetitions : 1;
    for (let index = 0; index < count; index += 1)
      roots.add(standaloneDataRoot(work, population, index));
  }
  return [...roots];
}

/**
 * Cold-trial preflight from observed root state. A root is fresh only if it
 * does not exist yet; a reused root also needs a previous owner identity.
 * Without root evidence freshness is unknown (`null`), which rejects.
 */
export function coldPreflight({ population, state, prior }) {
  return {
    freshRoot:
      typeof state?.rootPresent !== 'boolean'
        ? null
        : !state.rootPresent || (population === 'reused-root-cold' && !prior),
    descriptorPresent: state?.descriptorPresent,
    priorOwnerState: state?.ownerState,
  };
}

function sameIdentity(left, right) {
  return (
    !!left &&
    !!right &&
    ['pid', 'startIdentity', 'daemonEpoch'].every(
      (key) => left[key] !== undefined && left[key] === right[key],
    )
  );
}

/**
 * Cold: no published daemon or live owner before, the launcher spawned
 * exactly once and health reached `ready`. Warm: a new connection from
 * another process, an unchanged daemon identity and zero spawns. Anything
 * else is rejected, never relabelled. A declared warm-up is excluded only
 * when it would pass these checks; a failed or rejected one is counted so.
 */
export function classifyStandaloneTrial(trial) {
  if (trial.error) return { class: 'failed', reasons: [String(trial.error)] };
  const reasons = standaloneReasons(trial);
  if (reasons.length) return { class: 'rejected', reasons };
  if (trial.warmup) return { class: 'excluded', reasons: ['declared warm-up'] };
  return {
    class: trial.population === 'retained-warm-attach' ? 'warm' : 'cold',
    reasons,
  };
}

function standaloneReasons(trial) {
  const reasons = [];
  if (trial.healthState !== 'ready') reasons.push('health not ready');
  if (!Number.isFinite(trial.readyMs) || trial.readyMs < 0)
    reasons.push('ready time missing');
  if (trial.population === 'retained-warm-attach') {
    if (trial.started !== false || trial.spawns !== 0) reasons.push('spawned');
    if (!sameIdentity(trial.holderIdentity, trial.identity))
      reasons.push('daemon identity changed');
    if (!(trial.attacherPid > 0) || trial.attacherPid === trial.holderPid)
      reasons.push('not a new connection');
    return reasons;
  }
  // A warm-up claims no coldness: the reused root's first launch creates it.
  if (!trial.warmup) reasons.push(...coldnessReasons(trial));
  if (trial.started !== true || trial.spawns !== 1)
    reasons.push('not one spawn');
  return reasons;
}

function coldnessReasons({ population, preflight }) {
  if (!preflight) return ['coldness not proven'];
  const reasons = [];
  if (preflight.descriptorPresent !== false)
    reasons.push('daemon publication present');
  // A reused root must prove its previous owner exited; a fresh one has none.
  const allowed =
    population === 'fresh-root-cold' ? [null, 'absent'] : ['absent'];
  if (!allowed.includes(preflight.priorOwnerState))
    reasons.push(`prior daemon ${preflight.priorOwnerState}`);
  if (typeof preflight.freshRoot !== 'boolean')
    reasons.push('root state unverifiable');
  else if (population === 'fresh-root-cold' && !preflight.freshRoot)
    reasons.push('root reused');
  else if (population === 'reused-root-cold' && preflight.freshRoot)
    reasons.push('root not reused');
  return reasons;
}

/**
 * Arm preparation outside timing: a disposable profile, an ordinary durable
 * `setChoice`, preparation processes gone, no daemon or publication left, the
 * choice surviving fixture refresh, and no pre-measurement daemon read.
 * A leftover daemon makes the launch warm; it is never cold.
 */
export function verifyArmPreparation(record, arm) {
  const reasons = [];
  const choice = arm === 'on';
  if (record?.disposableProfile !== true)
    reasons.push('profile not disposable');
  if (record?.persistedChoice !== choice) reasons.push('choice not durable');
  if (record?.choiceAfterFixtureRefresh !== choice)
    reasons.push('fixture refresh changed the choice');
  if (record?.preparationProcessesExited !== true)
    reasons.push('preparation processes remain');
  const daemon = record?.daemon;
  if (
    !['absent', 'running'].includes(daemon?.ownerState) ||
    typeof daemon?.descriptorPresent !== 'boolean'
  )
    reasons.push('daemon state unverifiable');
  else if (daemon.ownerState === 'absent' && daemon.descriptorPresent)
    reasons.push('stale daemon publication');
  if (!Number.isSafeInteger(record?.preMeasurementDaemonReads))
    reasons.push('pre-measurement read evidence missing');
  if (reasons.length) return { status: 'rejected', reasons };
  const warm = [];
  if (daemon.ownerState === 'running') warm.push('daemon retained');
  if (record.preMeasurementDaemonReads !== 0)
    warm.push('pre-measurement read reached the daemon');
  return warm.length
    ? { status: 'warm', reasons: warm }
    : { status: 'cold', reasons: [] };
}

function distribution(values) {
  const { count, p50, p95, max } = summarize(values);
  return { count, p50, p95, max };
}

/** Raw attempts, failures, rejections and exclusions beside the distribution. */
export function summarizeStandalone(trials) {
  return Object.fromEntries(
    STANDALONE_POPULATIONS.map((population) => {
      const own = trials.filter((trial) => trial.population === population);
      const tally = (name) => own.filter((trial) => trial.class === name);
      const admitted = own.filter((trial) =>
        ['cold', 'warm'].includes(trial.class),
      );
      return [
        population,
        {
          attempts: own.length,
          failures: tally('failed').length,
          rejected: tally('rejected').length,
          excluded: tally('excluded').length,
          // Daemons stopped at the censoring bound instead of idle-exiting.
          censoredExits: own.filter((trial) => trial.exit?.censored).length,
          readyMs: distribution(admitted.map((trial) => trial.readyMs)),
        },
      ];
    }),
  );
}

/**
 * A requested population without one admitted measured sample fails the run;
 * its failures, rejections and exclusions stay in the raw output.
 */
export function assessStandaloneRun({ plan, summary }) {
  const reasons = (plan?.populations ?? [])
    .filter((population) => !(summary?.[population]?.readyMs?.count > 0))
    .map((population) => `${population}: no admitted measured sample`);
  if (!plan?.populations?.length) reasons.push('no population requested');
  return { valid: reasons.length === 0, reasons };
}

function median(values) {
  return summarize(values).p50;
}

/**
 * Files launches per workload and arm. First use (lazy route/daemon start) is
 * one value per launch, split by the launch's arm preparation so a retained
 * daemon never counts as cold. Warm reads are summarized by per-launch
 * medians, so a launch, not each of its reads, is the independent unit.
 */
export function summarizeFilesLaunches(launches) {
  const summary = {};
  for (const launch of launches) {
    if (!POPULATION_PLAN.files.workloads.includes(launch.workload))
      throw new Error(`Unknown Files workload ${launch.workload}`);
    ((summary[launch.workload] ??= {})[launch.arm] ??= []).push(launch);
  }
  for (const arms of Object.values(summary))
    for (const [arm, own] of Object.entries(arms))
      arms[arm] = summarizeFilesArm(own);
  return summary;
}

const FILES_LAUNCH_STATUSES = ['admitted', 'rejected', 'failed'];

/** Failures and rejections count every launch; only admitted warm-ups are exclusions. */
function summarizeFilesArm(own) {
  const unknown = own.find(
    (launch) => !FILES_LAUNCH_STATUSES.includes(launch.status),
  );
  if (unknown) throw new Error(`Unknown Files launch status ${unknown.status}`);
  const tally = (status) => own.filter((launch) => launch.status === status);
  const admitted = tally('admitted').filter((launch) => !launch.warmup);
  // Admission guarantees these; a gap would silently shrink a count.
  if (
    admitted.some(
      (launch) =>
        !['cold', 'warm'].includes(launch.preparation) ||
        !Number.isFinite(launch.firstUseMs) ||
        !launch.warmReadMs?.length ||
        !launch.warmReadMs.every(Number.isFinite),
    )
  )
    throw new Error('Admitted Files launch is missing preparation or timings');
  const firstUse = (preparation) =>
    distribution(
      admitted
        .filter((launch) => launch.preparation === preparation)
        .map((launch) => launch.firstUseMs),
    );
  return {
    attempts: own.length,
    excluded: tally('admitted').length - admitted.length,
    failures: tally('failed').length,
    rejected: tally('rejected').length,
    launches: admitted.length,
    firstUseMs: { cold: firstUse('cold'), warm: firstUse('warm') },
    warmReads: {
      observations: admitted.reduce(
        (sum, launch) => sum + launch.warmReadMs.length,
        0,
      ),
      launchMedianMs: distribution(
        admitted.map((launch) => median(launch.warmReadMs)),
      ),
    },
  };
}

const SHA256 = /^[a-f0-9]{64}$/;

/** Retained run facts; a missing one makes the run unusable, not partial. */
export function validateRunManifest(manifest) {
  const reasons = [];
  for (const [name, hash] of Object.entries({
    ...manifest?.artifacts,
    ...manifest?.helpers,
  }))
    if (!SHA256.test(hash ?? '')) reasons.push(`hash missing: ${name}`);
  for (const group of ['artifacts', 'helpers'])
    if (Object.keys(manifest?.[group] ?? {}).length === 0)
      reasons.push(`${group} hashes missing`);
  if (!/^[a-f0-9]{40}$/.test(manifest?.sourceSha ?? ''))
    reasons.push('source commit missing');
  if (typeof manifest?.brand !== 'string' || !manifest.brand)
    reasons.push('brand missing');
  const host = assessHostMeasurement(manifest?.host);
  if (host.status === 'unknown') reasons.push(...host.reasons);
  if (!Number.isFinite(manifest?.observerOverheadMs?.p95))
    reasons.push('observer overhead missing');
  const cadence = Object.values(manifest?.cadence ?? {});
  if (!cadence.length || !cadence.every(Number.isFinite))
    reasons.push('cadence missing');
  return { valid: reasons.length === 0, reasons, hostLoad: host.status };
}

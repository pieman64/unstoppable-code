// Standalone daemon start/attach populations: fresh-root cold, reused-root
// cold and retained-daemon warm attach, against the staged optimized daemon
// and CLI host artifacts. Each measurement runs in a newly forked host
// process, so every attach is a new connection; host startup is untimed.
import { build } from 'esbuild';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  E2E_DAEMON_DIRECTORY,
  verifyE2eDaemonHosts,
} from '../../../../scripts/lib/e2e-core-daemon-artifact.mjs';
import {
  POPULATION_PLAN,
  STANDALONE_POPULATIONS,
  assessStandaloneRun,
  classifyStandaloneTrial,
  coldPreflight,
  shortTemporaryBase,
  standaloneDataRoot,
  standaloneDataRoots,
  summarizeStandalone,
  validateRunManifest,
} from './daemon-populations.mjs';
import { startHostMeasurement } from './host-measurement.mjs';
import { summarize } from './statistics.mjs';

const HOST_ENV = 'CANOPY_DAEMON_POPULATION_HOST';
const EXIT_POLL_MS = 500;
// After a censoring stop, how long the stopped owner may take to disappear.
const STOP_WAIT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 120_000;
const driverPath = fileURLToPath(import.meta.url);
const hostPath = resolve(dirname(driverPath), 'daemon-start-attach-host.mjs');

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function buildHost(outfile) {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  await build({
    entryPoints: [hostPath],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    define: {
      __CANOPY_CURSOR_CLI__: JSON.stringify(packageJson['cursor-cli']),
      __CANOPY_E2E__: 'false',
      __CANOPY_RELEASE_FLAVOR__: JSON.stringify('stable'),
      __CANOPY_CLOUD_BASE_URL__: JSON.stringify(''),
      __CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__: 'false',
    },
  });
}

function startHost(bundle, env) {
  const child = fork(bundle, [], {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8192)));
  let next = 0;
  const request = (command, args = {}) =>
    new Promise((settle, reject) => {
      const id = (next += 1);
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (error) reject(error);
        else settle(value);
      };
      const onMessage = (message) =>
        message.id === id &&
        finish(message.error ? new Error(message.error) : null, message.value);
      const onExit = (code) =>
        finish(new Error(`host exited ${code}: ${stderr}`));
      const timer = setTimeout(
        () => finish(new Error(`host ${command} timed out`)),
        COMMAND_TIMEOUT_MS,
      );
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.send({ id, command, args });
    });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    await exited;
  };
  return { pid: child.pid, request, stop };
}

export async function runStandalonePopulations({
  repetitions = POPULATION_PLAN.standalone.repetitions,
  warmups = POPULATION_PLAN.standalone.warmups,
  populations = STANDALONE_POPULATIONS,
  output,
}) {
  // A repeated population would reuse its fresh roots.
  if (new Set(populations).size !== populations.length)
    throw new Error(`Duplicate population in ${populations.join(', ')}`);
  // An aborted run must not leave an earlier run's result at this path.
  await rm(output, { force: true });
  const root = process.cwd();
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const hosts = verifyE2eDaemonHosts({
    root,
    sourceSha,
    platform: process.platform,
    arch: process.arch,
  });
  const artifact = JSON.parse(
    await readFile(join(E2E_DAEMON_DIRECTORY, 'manifest.json'), 'utf8'),
  );
  const work = await realpath(
    await mkdtemp(
      join(
        shortTemporaryBase(process.platform, tmpdir()),
        'daemon-populations-',
      ),
    ),
  );
  const bundle = join(work, 'host.cjs');
  const env = {
    ...process.env,
    [HOST_ENV]: JSON.stringify({
      runtimeMode: 'prod',
      executable: hosts.executable,
      ownedChildNativePath: hosts.ownedChildNativePath,
    }),
  };
  const live = new Set();
  const spawnHost = () => {
    const host = startHost(bundle, env);
    live.add(host);
    return host;
  };
  let hostBundleSha256;
  let observer;
  let brand;
  try {
    await buildHost(bundle);
    hostBundleSha256 = await sha256(bundle);
    observer = spawnHost();
    brand = await observer.request('brand');
  } catch (error) {
    await Promise.allSettled([...live].map((host) => host.stop()));
    await rm(work, { recursive: true, force: true });
    throw error;
  }
  const overheadMs = [];
  const inspect = async (dataRoot, pid) => {
    const begin = performance.now();
    const state = await observer.request('inspect', { dataRoot, pid });
    overheadMs.push(performance.now() - begin);
    return state;
  };
  const pause = () => new Promise((done) => setTimeout(done, EXIT_POLL_MS));
  const exited = async (dataRoot, pid, withinMs) => {
    const begin = performance.now();
    while (performance.now() - begin < withinMs) {
      const state = await inspect(dataRoot, pid);
      if (!state.descriptorPresent && state.ownerState === 'absent')
        return performance.now() - begin;
      await pause();
    }
    return null;
  };
  // Stops only the owner whose start identity is still the observed one.
  const stopOwner = async (dataRoot, identity) => {
    const state = await inspect(dataRoot, identity.pid);
    if (
      state.ownerState !== 'running' ||
      state.ownerStartIdentity !== identity.startIdentity
    )
      return;
    process.kill(identity.pid, 'SIGTERM');
    await exited(dataRoot, identity.pid, STOP_WAIT_MS);
  };
  // Waits for the product's own idle exit; past the censoring bound the
  // verified owner is stopped and the observation stays censored.
  const awaitExit = async (dataRoot, identity) => {
    const exitObservedMs = await exited(
      dataRoot,
      identity.pid,
      POPULATION_PLAN.standalone.exitCensorMs,
    );
    if (exitObservedMs !== null) return { censored: false, exitObservedMs };
    await stopOwner(dataRoot, identity);
    return { censored: true, exitObservedMs: null };
  };
  // The daemon a failed attach may have left, by its publication.
  const publishedOwner = async (dataRoot) => {
    const state = await inspect(dataRoot);
    return state.ownerState === 'running'
      ? { pid: state.pid, startIdentity: state.ownerStartIdentity }
      : null;
  };
  const roots = new Set();
  const measure = async (dataRoot, hold = false) => {
    const host = spawnHost();
    let held = false;
    try {
      const value = await host.request('attach', { dataRoot, hold });
      held = hold;
      return { host, value };
    } finally {
      if (!held) await host.stop();
    }
  };

  const startedAt = new Date().toISOString();
  const hostMeasurement = startHostMeasurement();
  const trials = [];
  const holderExits = [];
  const record = (trial) => {
    const classified = classifyStandaloneTrial(trial);
    trials.push({
      ...trial,
      class: classified.class,
      reasons: classified.reasons,
    });
  };
  // Coldness is proven before each cold trial: the root's observed state, no
  // publication in it and, on a reused root, the previous owner gone.
  const preflightFor = async (population, dataRoot, prior) => {
    if (population === 'retained-warm-attach') return null;
    const fresh = population === 'fresh-root-cold';
    const state = await inspect(dataRoot, fresh ? undefined : prior?.pid);
    return coldPreflight({ population, state, prior });
  };
  try {
    // An unusable root fails every trial alike; stop before the first one.
    for (const dataRoot of standaloneDataRoots(work, {
      populations,
      warmups,
      repetitions,
    }))
      await observer.request('endpoint', { dataRoot }).catch((error) => {
        throw new Error(`Data root ${dataRoot} is unusable: ${error.message}`);
      });
    for (const population of populations) {
      const warmAttach = population === 'retained-warm-attach';
      const shared = standaloneDataRoot(work, population, 0);
      if (warmAttach) roots.add(shared);
      const holder = warmAttach
        ? await measure(shared, true).catch((error) => ({ error }))
        : null;
      let prior = null;
      for (let index = 0; index < warmups + repetitions; index += 1) {
        const dataRoot = standaloneDataRoot(work, population, index);
        roots.add(dataRoot);
        const base = { population, index, warmup: index < warmups };
        try {
          if (holder?.error) throw holder.error;
          const preflight = await preflightFor(population, dataRoot, prior);
          const { value } = await measure(dataRoot);
          const exit = holder
            ? null
            : await awaitExit(dataRoot, value.identity);
          prior = value.identity;
          record({
            ...base,
            ...value,
            preflight,
            exit,
            ...(holder && {
              holderIdentity: holder.value.identity,
              holderPid: holder.value.attacherPid,
            }),
          });
        } catch (error) {
          record({ ...base, error: String(error?.message ?? error) });
          // Never reuse a root while a failed attach's daemon may still run.
          const leftover = holder ? null : await publishedOwner(dataRoot);
          if (leftover) {
            await awaitExit(dataRoot, leftover);
            prior = leftover;
          }
        }
      }
      if (holder?.host) {
        await holder.host.request('release').catch(() => undefined);
        await holder.host.stop();
        holderExits.push(await awaitExit(shared, holder.value.identity));
      }
    }
  } finally {
    // Stop verified leftovers before their roots are deleted.
    for (const dataRoot of roots) {
      const leftover = await publishedOwner(dataRoot).catch(() => null);
      if (leftover) await stopOwner(dataRoot, leftover).catch(() => undefined);
    }
    await Promise.allSettled([...live].map((host) => host.stop()));
    await rm(work, { recursive: true, force: true });
  }
  const host = hostMeasurement.stop();
  const manifest = {
    sourceSha,
    brand,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    // The timed client is the bundled source host below, not the staged CLI.
    artifacts: {
      daemon: artifact.sha256,
      ownedChild: artifact.ownedChildSha256,
    },
    helpers: {
      hostBundle: hostBundleSha256,
      host: await sha256(hostPath),
      driver: await sha256(driverPath),
      populations: await sha256(
        resolve(dirname(driverPath), 'daemon-populations.mjs'),
      ),
    },
    host,
    cadence: {
      exitPollMs: EXIT_POLL_MS,
      exitCensorMs: POPULATION_PLAN.standalone.exitCensorMs,
    },
    observerOverheadMs: summarize(overheadMs),
  };
  const plan = { repetitions, warmups, populations };
  const summary = summarizeStandalone(trials);
  const result = {
    schema: 'canopy-daemon-start-attach-v1',
    startedAt,
    completedAt: new Date().toISOString(),
    plan,
    manifest,
    manifestCheck: validateRunManifest(manifest),
    runCheck: assessStandaloneRun({ plan, summary }),
    summary,
    trials,
    holderExits,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === driverPath) {
  const { values } = parseArgs({
    options: {
      repetitions: { type: 'string' },
      warmups: { type: 'string' },
      populations: { type: 'string' },
      output: { type: 'string' },
    },
  });
  const count = (value, fallback) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error(`Invalid count ${value}`);
    return parsed;
  };
  const populations = values.populations?.split(',') ?? STANDALONE_POPULATIONS;
  if (populations.some((name) => !STANDALONE_POPULATIONS.includes(name)))
    throw new Error(`Populations: ${STANDALONE_POPULATIONS.join(', ')}`);
  const result = await runStandalonePopulations({
    repetitions: count(
      values.repetitions,
      POPULATION_PLAN.standalone.repetitions,
    ),
    warmups: count(values.warmups, POPULATION_PLAN.standalone.warmups),
    populations,
    output: resolve(
      values.output ?? '.performance/desktop/daemon-start-attach.json',
    ),
  });
  console.log(
    JSON.stringify(
      {
        summary: result.summary,
        manifestCheck: result.manifestCheck,
        runCheck: result.runCheck,
      },
      null,
      2,
    ),
  );
  if (!result.manifestCheck.valid || !result.runCheck.valid)
    process.exitCode = 1;
}

/**
 * Standalone matched production-bundle startup resource driver (macOS only).
 * Run via the normal host performance guard; see startup-preparation.md.
 * No browser panel, native profile Session, agent turn, or local HTTP server
 * is intentionally created. Every sample starts from identical fresh metadata.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { expect } from '@playwright/test';
import {
  launchCanopy,
  closeCanopy,
  getMainWindow,
  parseSupervisedTreePid,
  buildElectronEnv,
} from '../electron/launchCanopy.mjs';
import { CanopyAppDriver } from '../electron/canopyApp.mjs';
import { seedDemoWorkspaces } from '../electron/demoWorkspaces.mjs';
import {
  startPerformanceMonitor,
  markRendererTask,
  assertValidMonitoring,
  assertValidTypingSampling,
} from './monitor.mjs';
import { assessResponsiveness } from './responsiveness.mjs';
import { RESPONSIVENESS_THRESHOLDS } from './profiles.mjs';
import {
  beginProductionHeadlessEvidence,
  endProductionHeadlessEvidence,
  HEADLESS_STUDY_VIEWPORT as STUDY_VIEWPORT,
  HEADLESS_STUDY_MODE as STUDY_VIEWPORT_PRESET,
} from './browser-profiles-evidence.mjs';
import { summarize } from './statistics.mjs';
import {
  startStartupSampler,
  assertEarlyStartupCoverage,
  createValidatedAppMetricSource,
} from './browser-profiles-startup-sampler.mjs';

const exec = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'window-mode': { type: 'string', default: 'headless' },
    samples: { type: 'string', default: '5' },
    warmups: { type: 'string', default: '1' },
    stage: { type: 'string' },
  },
});
assert.equal(
  process.platform,
  'darwin',
  'Only matched same-machine macOS startup sampling is supported',
);
assert(values.output, '--output is required');
assert.equal(
  values['window-mode'],
  'headless',
  'Only headless window mode is supported',
);
assert(
  process.argv.filter(
    (arg) => arg === '--window-mode' || arg.startsWith('--window-mode='),
  ).length <= 1,
  'Repeated window mode',
);
assert(
  ['frozenPhase2', 'finalPhase3'].includes(values.stage),
  '--stage must be frozenPhase2 or finalPhase3',
);
const samples = Number(values.samples);
const warmups = Number(values.warmups);
assert(
  Number.isInteger(samples) && samples >= 1 && samples <= 100,
  'Samples must be 1–100',
);
assert(warmups === 0 || warmups === 1, 'Warm-ups must be zero or one');
const output = path.resolve(repoRoot, values.output);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function command(file, args) {
  try {
    return (
      await exec(file, args, { cwd: repoRoot, timeout: 10_000 })
    ).stdout.trim();
  } catch (error) {
    return { unavailable: error.message };
  }
}
async function bundleManifest(directory, prefix = '') {
  const entries = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      Object.assign(
        entries,
        await bundleManifest(path.join(directory, entry.name), relative),
      );
    else if (entry.isFile())
      entries[relative] = sha256(
        await readFile(path.join(directory, entry.name)),
      );
  }
  return entries;
}
async function seed(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const timestamp = Date.UTC(2026, 8, 9);
  const profiles = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => {
      const profileId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      return [
        profileId,
        {
          record: {
            schemaVersion: 1,
            profileId,
            kind: 'named',
            owner: { kind: 'user', localPrincipalId: 'local-user' },
            displayName: `Account ${String(index).padStart(4, '0')}`,
            metadataRevision: 1,
            storageGeneration: 1,
            lifecycle: 'active',
            agentPermissions: { allowEnable: false, allowClear: false },
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          partition: `persist:canopy-browser-profile-${profileId}-g1`,
        },
      ];
    }),
  );
  const catalog = `${JSON.stringify({ schemaVersion: 1, revision: 1, profiles, taskKeys: [], retirements: {}, jobs: {} })}\n`;
  await mkdir(path.join(userDataDir, 'browser-profiles'), { recursive: true });
  await writeFile(
    path.join(userDataDir, 'browser-profiles', 'catalog.json'),
    catalog,
  );
  return sha256(catalog);
}
const driverDependencies = [
  'browser-profiles-startup-run.mjs',
  'browser-profiles-startup-sampler.mjs',
  'monitor.mjs',
  'browser-profiles-evidence.mjs',
  'responsiveness.mjs',
  'profiles.mjs',
  'statistics.mjs',
  'process-tree-supervisor.mjs',
  '../electron/launchCanopy.mjs',
  '../electron/canopyApp.mjs',
  '../electron/demoWorkspaces.mjs',
];
const effectiveEnv = buildElectronEnv('<isolated-user-data>', {
  CANOPY_E2E_ISOLATED_LOGGING: '1',
});
const report = {
  schemaVersion: 2,
  benchmarkKind: 'release-like-startup',
  stage: values.stage,
  startedAt: new Date().toISOString(),
  source: {
    headlessAdapter: {
      adapterVersion: 'production-hidden-native-v1',
      sourcePath: await realpath(
        new URL(
          './browser-profiles-production-headless-bootstrap.cjs',
          import.meta.url,
        ),
      ),
      adapterSha256: createHash('sha256')
        .update(
          await readFile(
            new URL(
              './browser-profiles-production-headless-bootstrap.cjs',
              import.meta.url,
            ),
          ),
        )
        .digest('hex'),
    },
    commit: await command('git', ['rev-parse', 'HEAD']),
    dirty: await command('git', ['status', '--porcelain']),
    bundles: await bundleManifest(path.join(repoRoot, 'out')),
    driverDependencies: Object.fromEntries(
      await Promise.all(
        driverDependencies.map(async (relative) => [
          relative,
          sha256(await readFile(new URL(relative, import.meta.url))),
        ]),
      ),
    ),
    packageJsonSha256: sha256(
      await readFile(path.join(repoRoot, 'package.json')),
    ),
    buildConfigSha256: sha256(
      await readFile(
        path.join(repoRoot, 'apps/desktop-app/electron.vite.config.ts'),
      ),
    ),
  },
  environment: {
    platform: process.platform,
    architecture: process.arch,
    release: os.release(),
    machine: sha256(os.hostname()),
    cpu: os.cpus()[0]?.model,
    logicalCpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    node: process.version,
    power: await command('pmset', ['-g', 'batt']),
    powerSettings: await command('pmset', ['-g', 'custom']),
    displays: await command('system_profiler', ['SPDisplaysDataType', '-json']),
    windowVisible: false,
    studyWindowMode: STUDY_VIEWPORT_PRESET,
    viewport: STUDY_VIEWPORT,
    studyViewportPreset: STUDY_VIEWPORT_PRESET,
    effectiveEnvironmentSha256: sha256(
      JSON.stringify(
        Object.entries(effectiveEnv).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
    // Hash values rather than expose inherited credentials. These entries let
    // reviewers distinguish config drift from irrelevant shell-variable drift.
    effectiveEnvironmentValueHashes: Object.fromEntries(
      Object.entries(effectiveEnv)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, sha256(String(value))]),
    ),
    launchConfiguration: {
      buildKind: 'production',
      productionWindowMode: values['window-mode'],
      mockOsKeychain: true,
      isolatedNativeAndProviderData: true,
      locale: effectiveEnv.LC_ALL,
      timezone: effectiveEnv.TZ,
      runtimeEnvironment: effectiveEnv.CANOPY_ENV,
    },
  },
  configuration: {
    windowMode: values['window-mode'],
    samples,
    warmups,
    catalogProfiles: 1000,
    osSampleIntervalMs: 100,
    appSampleIntervalMs: 200,
    startupTypingCharacters: 48,
    postTypingSettleMs: 10_000,
    settledObservationMs: 10_000,
  },
  caveats: [
    'Optimized unpackaged production bundle; excludes signing, installer and ASAR behavior. Same build configuration required in both stages.',
    'Launch-request time precedes real process spawn. PID-file observation is an upper bound on spawn, not an exact OS spawn timestamp. Both time origins are reported.',
    'firstWindow is identity-attested application BrowserWindow availability, not first paint. DOM and usable shell are separate milestones. Early resources require two completed samples before firstWindow.',
    'OS observedCpuLedgerDeltaRatePercent (legacy alias observedCpuPercent) is a cumulative-ledger delta rate, not exact interval CPU or an interval lower bound; newly discovered children may contribute pre-interval CPU.',
    'Every app.getAppMetrics batch is validated before normalization; missing CPU/working-set fields, including newly appearing processes during settled monitoring, fail resource sampling instead of becoming zero.',
    'ps CPU is quantized cumulative user+system process CPU. Observed cumulative totals retain exited children but miss unobserved processes and CPU after their last sample; newborn first samples include their earlier CPU.',
    'PID+second-resolution lstart guards PID reuse; subsecond PID reuse with identical start text cannot be distinguished. Only owned descendants are retained; foreign process rows are discarded.',
    'ps summed RSS is resident memory, not private/working memory; shared pages can be counted repeatedly and compression affects interpretation. App working set is separately monitored after DOM.',
    'The first RSS snapshot begins after PID discovery; shorter pre-snapshot peaks cannot be recovered. Raw cadence and collection cost disclose observer overhead.',
    'No Browser panels are opened. Absence of native profile directories and profile WebContents is checked; production exposes no side-effect-free enumeration of all Session instances, so zero instantiated Sessions remains a proxy check.',
    'Settled window follows a fixed ten-second dwell; it is short startup-settling evidence, not a multi-minute idle/plateau acceptance run.',
    'No IPC, renderer or typing measurement is possible before their surface is available; missing values remain null, never fabricated zeroes.',
  ],
  warmup: null,
  samples: [],
};
async function save() {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
async function runSample(ordinal) {
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), 'browser-profile-startup-'),
  );
  const sample = {
    ordinal,
    status: 'running',
    startedAt: new Date().toISOString(),
    userDataDir,
    hostLoad: os.loadavg(),
    tasks: [],
    milestones: {},
  };
  let electronApp;
  let page;
  let monitor;
  let sampler;
  try {
    sample.catalogSha256 = await seed(userDataDir);
    const start = performance.now();
    const elapsed = () => performance.now() - start;
    sampler = startStartupSampler({
      pidFile: path.join(userDataDir, '.e2e-supervised-electron.pid'),
      parsePid: parseSupervisedTreePid,
      launchStartedAt: start,
    });
    let headlessAdapter;
    ({ electronApp, headlessAdapter } = await launchCanopy({
      buildKind: 'production',
      productionWindowMode: values['window-mode'],
      productionAdapterArchivePath: `${output}.sample-${ordinal}-launch-${sample.adapterLaunches?.length ?? 0}.adapter.cjs`,
      userDataDir,
      electronArgs: [`--user-data-dir=${userDataDir}`],
      viewportSize: null,
    }));
    sample.adapterLaunches ??= [];
    sample.adapterLaunches.push(headlessAdapter);
    sample.milestones.launchConnectedMs = elapsed();
    page = await getMainWindow(electronApp);
    sample.milestones.firstWindowMs = elapsed();
    sample.earlyCoverage = assertEarlyStartupCoverage(
      sampler.raw,
      sample.milestones.firstWindowMs,
    );
    await page.waitForLoadState('domcontentloaded');
    sample.milestones.domContentAvailableMs = elapsed();
    const app = new CanopyAppDriver(page);
    const composer = page
      .getByTestId('page-home')
      .getByTestId('home-composer-editor');
    const shellObservation = app
      .waitForShell({ timeout: 45_000 })
      .then(() => {
        sample.milestones.usableShellMs = elapsed();
      })
      .then(
        () => null,
        (error) => error,
      );
    const composerObservation = expect(composer)
      .toBeVisible({ timeout: 30_000 })
      .then(() => {
        sample.milestones.usableComposerMs = elapsed();
      })
      .then(
        () => null,
        (error) => error,
      );
    sample.milestones.hiddenSetupStartMs = elapsed();
    try {
      sample.windowEvidence = {};
      await beginProductionHeadlessEvidence(
        electronApp,
        page,
        sample.windowEvidence,
      );
    } finally {
      sample.milestones.hiddenSetupEndMs = elapsed();
    }
    // Validate every app metric batch before the shared monitor's normalization,
    // including new child processes and every sample in the settled window.
    const appMetricSource = createValidatedAppMetricSource(electronApp);
    sample.metricValidation =
      'Every app.getAppMetrics batch: nonempty process list, valid PID, finite nonnegative CPU and working set; reject before normalization';
    sample.milestones.monitorStartMs = elapsed();
    monitor = await startPerformanceMonitor({
      page,
      electronApp: appMetricSource,
      sampleIntervalMs: 200,
    });
    const [shellError, composerError] = await Promise.all([
      shellObservation,
      composerObservation,
    ]);
    if (shellError) throw shellError;
    if (composerError) throw composerError;
    await composer.fill('');
    await composer.click();
    const draft = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv';
    const typingStarted = elapsed();
    const rendererStart = await markRendererTask(
      page,
      'task:start:type_startup',
    );
    await page.evaluate(() => {
      window.__CANOPY_DESKTOP_PERF__.typingProbeActive = true;
    });
    await composer.pressSequentially(draft, { delay: 100 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() => {
      window.__CANOPY_DESKTOP_PERF__.typingProbeActive = false;
    });
    await expect(composer).toContainText(draft);
    sample.tasks.push({
      rendererStart,
      rendererEnd: await markRendererTask(page, 'task:end:type_startup:ok'),
      kind: 'type_startup_composer',
      status: 'ok',
      characters: draft.length,
      startedMs: typingStarted,
      durationMs: elapsed() - typingStarted,
    });
    await composer.fill('');
    sample.runtime = await electronApp.evaluate(({ app }) => ({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    }));
    for (const dataPath of [
      sample.runtime.userData,
      sample.runtime.sessionData,
    ])
      assert.equal(await realpath(dataPath), await realpath(userDataDir));
    sample.catalogCount = await page.evaluate(async () => {
      let count = 0;
      let offset;
      do {
        const result = await window.api.browser.profiles.list(
          offset === undefined ? undefined : { offset },
        );
        count += result.profiles.length;
        offset = result.nextOffset;
      } while (offset !== undefined);
      return count;
    });
    assert.equal(sample.catalogCount, 1000);
    sample.milestones.postTypingSettleStartMs = elapsed();
    await delay(report.configuration.postTypingSettleMs);
    sample.monitoring = await monitor.stop();
    monitor = undefined;
    assertValidMonitoring(sample.monitoring.summary);
    assertValidTypingSampling(sample.monitoring.raw, sample.tasks);
    assert(
      sample.monitoring.summary.ipcOuterMs.count > 0,
      'IPC samples missing',
    );
    assert(
      sample.monitoring.summary.rendererFrameDelayMs.count > 0,
      'Frame samples missing',
    );
    sample.milestones.settledObservationStartMs = elapsed();
    monitor = await startPerformanceMonitor({
      page,
      electronApp: appMetricSource,
      sampleIntervalMs: 200,
    });
    await delay(report.configuration.settledObservationMs);
    sample.settled = await monitor.stop();
    monitor = undefined;
    assertValidMonitoring(sample.settled.summary);
    sample.milestones.settledObservationEndMs = elapsed();
    const partitions = await readdir(
      path.join(userDataDir, 'Partitions'),
    ).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    sample.nativeProfileDirectories = partitions.filter((name) =>
      name.startsWith('canopy-browser-profile-'),
    );
    assert.equal(sample.nativeProfileDirectories.length, 0);
    sample.profileWebContents = await electronApp.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((contents) =>
          /canopy-browser-profile-/.test(contents.session.storagePath ?? ''),
        )
        .map((contents) => ({ id: contents.id, url: contents.getURL() })),
    );
    assert.equal(sample.profileWebContents.length, 0);
    await endProductionHeadlessEvidence(
      electronApp,
      page,
      sample.windowEvidence,
    );
    sample.responsiveness = assessResponsiveness(
      sample.monitoring.summary,
      RESPONSIVENESS_THRESHOLDS,
    );
    sample.settledResponsiveness = assessResponsiveness(
      sample.settled.summary,
      RESPONSIVENESS_THRESHOLDS,
    );
    sample.status =
      sample.responsiveness.passed && sample.settledResponsiveness.passed
        ? 'ok'
        : 'unresponsive';
  } catch (error) {
    sample.status = 'error';
    sample.error = error.stack ?? String(error);
  } finally {
    if (monitor)
      sample.partialMonitoring = await monitor
        .stop()
        .catch((error) => ({ error: String(error) }));
    if (sampler) {
      sample.startupResources = await sampler.stop();
      if (sample.startupResources.error) {
        sample.status = 'error';
        sample.samplerError = sample.startupResources.error;
      }
      const pidMs = sample.startupResources.pidObservedMs;
      sample.milestones.firstWindowFromPidObservedMs =
        Number.isFinite(pidMs) &&
        Number.isFinite(sample.milestones.firstWindowMs)
          ? sample.milestones.firstWindowMs - pidMs
          : null;
      sample.milestones.usableShellFromPidObservedMs =
        Number.isFinite(pidMs) &&
        Number.isFinite(sample.milestones.usableShellMs)
          ? sample.milestones.usableShellMs - pidMs
          : null;
    }
    if (sample.status !== 'ok') {
      sample.failureUserDataDir = userDataDir;
      if (page) {
        const screenshot = `${output}.sample-${ordinal}-failure.png`;
        try {
          await page.screenshot({ path: screenshot });
          sample.failureScreenshot = screenshot;
        } catch (error) {
          sample.screenshotError = String(error);
        }
      }
    }
    if (electronApp) {
      try {
        await closeCanopy(electronApp, userDataDir, {
          keepUserData: sample.status !== 'ok',
        });
      } catch (error) {
        sample.status = 'error';
        sample.cleanupError = String(error);
      }
    }
    sample.hostLoadAfter = os.loadavg();
  }
  return sample;
}
await save();
for (let ordinal = -warmups; ordinal < samples; ordinal++) {
  process.stdout.write(
    `[browser-profile-startup] ${values.stage} ${ordinal < 0 ? 'warm-up' : `sample ${ordinal + 1}/${samples}`}\n`,
  );
  const sample = await runSample(ordinal);
  if (ordinal < 0) report.warmup = sample;
  else report.samples.push(sample);
  await save();
  process.stdout.write(
    `[browser-profile-startup] ${sample.status}: shell=${sample.milestones.usableShellMs ?? 'unmeasured'}ms\n`,
  );
  if (sample.status === 'error') {
    process.exitCode = 1;
    break;
  }
}
report.completedAt = new Date().toISOString();
report.summary = {
  firstWindowMs: summarize(
    report.samples.map((sample) => sample.milestones.firstWindowMs),
  ),
  usableShellMs: summarize(
    report.samples.map((sample) => sample.milestones.usableShellMs),
  ),
  preWindowObservedCumulativeCpuMs: summarize(
    report.samples.map(
      (sample) => sample.earlyCoverage?.preWindowObservedCumulativeCpuMs,
    ),
  ),
  preWindowPeakRssKb: summarize(
    report.samples.map((sample) => sample.earlyCoverage?.preWindowPeakRssKb),
  ),
  startupPeakRssKb: summarize(
    report.samples.map((sample) => {
      const resources =
        sample.startupResources?.samples.filter(
          (entry) => entry.atMs <= sample.milestones.usableShellMs,
        ) ?? [];
      return resources.length
        ? Math.max(...resources.map((entry) => entry.rssKb))
        : null;
    }),
  ),
  startupObservedCumulativeCpuMs: summarize(
    report.samples.map(
      (sample) =>
        sample.startupResources?.samples
          .filter((entry) => entry.atMs <= sample.milestones.usableShellMs)
          .at(-1)?.observedCumulativeCpuMs,
    ),
  ),
  settledCpuPercent: summarize(
    report.samples.map(
      (sample) => sample.settled?.summary.totalCpuPercent.mean,
    ),
  ),
  settledWorkingSetMb: summarize(
    report.samples.map(
      (sample) => sample.settled?.summary.totalWorkingSetMb.max,
    ),
  ),
  psCollectionCostMs: summarize(
    report.samples.flatMap(
      (sample) =>
        sample.startupResources?.samples.map(
          (entry) => entry.collectionCostMs,
        ) ?? [],
    ),
  ),
  psActualCadenceMs: summarize(
    report.samples.flatMap(
      (sample) =>
        sample.startupResources?.samples.map((entry) => entry.intervalMs) ?? [],
    ),
  ),
  passed:
    report.samples.length === samples &&
    report.samples.every((sample) => sample.status === 'ok') &&
    (!report.warmup || report.warmup.status === 'ok'),
};
await save();
if (!report.summary.passed) process.exitCode = 1;

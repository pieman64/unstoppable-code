/**
 * Browser-profile release-like baseline/candidate driver. No E2E runtime hooks.
 * Build both stages with the same configuration using npm run build, then run:
 * node scripts/run-guarded-dev-script.mjs --suite performance -- node --import tsx
 *   apps/desktop-app/tests/performance/browser-profiles-release-run.mjs
 *   --output .playwright/browser-profiles/phase-3/release-before.json --samples 5
 * Uses isolated synthetic data and a local HTTP fixture. Never starts agents.
 * A warm-up is excluded. Preserve raw samples; do not select a best run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { expect } from '@playwright/test';
import {
  launchCanopy,
  closeCanopy,
  getMainWindow,
} from '../electron/launchCanopy.mjs';
import { CanopyAppDriver } from '../electron/canopyApp.mjs';
import { seedDemoWorkspaces } from '../electron/demoWorkspaces.mjs';
import { seedWorktreeChat } from '../electron/seeders/seedWorktreeChat.mjs';
import {
  startPerformanceMonitor,
  assertValidMonitoring,
  markRendererTask,
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
import { runBrowserProfileDataWorkload } from './browser-profile-data-workload.mjs';
import {
  prepareDiagnosticLaunch,
  startDiagnosticCapture,
} from './diagnostics.mjs';

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
    maintenance: { type: 'boolean', default: false },
    'frame-trace-diagnostic': { type: 'boolean', default: false },
  },
});
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
const samples = Number(values.samples);
const warmups = Number(values.warmups);
const frameTraceDiagnostic = values['frame-trace-diagnostic'];
const DIAGNOSTIC_TRACE_MARK_TIMEOUT_MS = 1_000;
assert(warmups === 0 || warmups === 1, 'Warm-ups must be zero or one');
assert(
  Number.isInteger(samples) && samples >= 1 && samples <= 100,
  'Invalid sample count',
);
if (frameTraceDiagnostic) {
  assert.equal(samples, 1, 'Frame-trace diagnostic requires one sample');
  assert.equal(warmups, 0, 'Frame-trace diagnostic forbids warm-ups');
  assert.equal(
    values.maintenance,
    false,
    'Frame-trace diagnostic forbids maintenance mode',
  );
}
const output = path.resolve(repoRoot, values.output);
const owner = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
const extraOwners = [
  { projectId: 'profile-benchmark-cowork', worktreeId: 'cowork-first' },
  { projectId: 'profile-benchmark-cowork', worktreeId: 'cowork-second' },
  { projectId: 'app-advisor', worktreeId: 'advisor-first' },
  { projectId: 'app-advisor', worktreeId: 'advisor-second' },
];
const profileIds = Array.from({ length: 1000 }, () => randomUUID());

function command(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8' }).trim();
  } catch (error) {
    return `unavailable: ${error.code ?? error.message}`;
  }
}
async function bundleManifest(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(result, await bundleManifest(absolute, relative));
    else if (entry.isFile())
      result[relative] = createHash('sha256')
        .update(await readFile(absolute))
        .digest('hex');
  }
  return result;
}
async function seed(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const createdAt = new Date().toISOString();
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.workspaces.push({
    id: extraOwners[0].projectId,
    name: 'Profile benchmark',
    type: 'cowork',
    color: '#7C3AED',
    order: 99,
    collapsed: true,
    cowork: { createdAt, archiveRetentionDays: 7 },
  });
  await writeFile(indexPath, JSON.stringify(index));
  for (const [directory, entries] of [
    [
      path.join(userDataDir, 'workspaces', extraOwners[0].projectId),
      extraOwners.slice(0, 2),
    ],
    [
      path.join(userDataDir, 'app-workspaces', 'app-advisor'),
      extraOwners.slice(2),
    ],
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'work-entries.json'),
      JSON.stringify({
        version: 1,
        entries: entries.map((entry) => ({
          id: entry.worktreeId,
          title: entry.worktreeId,
          createdAt,
        })),
      }),
    );
    if (entries[0].projectId !== 'app-advisor')
      await writeFile(
        path.join(directory, 'workspace.json'),
        JSON.stringify({
          version: 1,
          type: 'cowork',
          repos: [],
          cowork: { createdAt, archiveRetentionDays: 7 },
        }),
      );
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: owner.projectId,
    worktreeId: owner.worktreeId,
    providerType: 'claude',
    tabs: [{ id: 'seed-chat', title: 'Chat' }],
  });
  const taskDir = path.join(
    userDataDir,
    'workspaces',
    owner.projectId,
    'worktree-data',
    owner.worktreeId,
  );
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
  );
  const now = Date.now();
  const profiles = Object.fromEntries(
    profileIds.map((profileId, index) => [
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
          createdAt: now,
          updatedAt: now,
        },
        partition: `persist:canopy-browser-profile-${profileId}-g1`,
      },
    ]),
  );
  await mkdir(path.join(userDataDir, 'browser-profiles'), { recursive: true });
  await writeFile(
    path.join(userDataDir, 'browser-profiles', 'catalog.json'),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      profiles,
      taskKeys: [],
      retirements: {},
      jobs: {},
    }),
  );
}
const server = createServer((_request, response) => {
  if (_request.url === '/profile-worker.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end(
      "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>e.waitUntil((async()=>{while(true){await(await caches.open('writer')).put('/value',new Response(String(Date.now())));await new Promise(r=>setTimeout(r,10));}})()));",
    );
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-store',
  });
  response.end(
    '<!doctype html><title>Profile benchmark ready</title><input aria-label="Fixture input"><script>document.body.dataset.ready="true"</script>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`;
const source = {
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
  driverSha256: createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  ...(frameTraceDiagnostic
    ? {
        git: {
          available: false,
          reason: 'gitless-capsule',
        },
      }
    : {
        commit: command('git', ['rev-parse', 'HEAD']),
        branch: command('git', ['branch', '--show-current']),
        dirty: command('git', ['status', '--porcelain']),
      }),
  bundles: await bundleManifest(path.join(repoRoot, 'out')),
};
const environment = {
  platform: process.platform,
  architecture: process.arch,
  release: os.release(),
  cpu: os.cpus()[0]?.model,
  memoryBytes: os.totalmem(),
  node: process.version,
  power: command('pmset', ['-g', 'batt']),
  settings: command('pmset', ['-g', 'custom']),
  windowVisible: false,
  studyWindowMode: STUDY_VIEWPORT_PRESET,
  viewport: STUDY_VIEWPORT,
  studyViewportPreset: STUDY_VIEWPORT_PRESET,
  providerData: 'isolated; no agent turns',
  nativeSessionData:
    'isolated via Electron --user-data-dir; asserted before tabs',
  cloudConfiguration: 'same production build configuration required',
};
const caveats = [
  'Unpackaged optimized production bundle with mock OS keychain; does not measure signing/installer/ASAR.',
  'Real production initialization remains enabled. Isolated unauthenticated data; no remote account workload.',
  'Resource/renderer monitoring starts after first-window DOM availability; startup before that point is elapsed time only.',
  'Background host contention must be reviewed with the raw conditions; no best-sample selection.',
];
const configuration = {
  windowMode: values['window-mode'],
  samples,
  maintenance: values.maintenance,
  warmups,
  lazyProfiles: 1000,
  switchesPerSample: 20,
  sharedTabs: 20,
  sharedTasks: 5,
  coldOwners: ['worktree', 'cowork_work_entry', 'app_advisor_work_entry'],
  settledIdleMs: 10_000,
};
const report = frameTraceDiagnostic
  ? {
      schemaVersion: 1,
      kind: 'browser-profile-common-frame-trace-diagnostic-v1',
      diagnosticOnly: true,
      acceptanceEligible: false,
      populationContribution: 0,
      thresholdsApplied: false,
      startedAt: new Date().toISOString(),
      source,
      environment,
      caveats,
      observation: {
        status: 'running',
        configuration,
        attempts: [],
      },
    }
  : {
      schemaVersion: 2,
      benchmarkKind: 'release-like',
      startedAt: new Date().toISOString(),
      source,
      environment,
      caveats,
      configuration,
      warmup: null,
      samples: [],
    };
async function save() {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
async function runSample(ordinal) {
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), 'browser-profile-release-'),
  );
  await seed(userDataDir);
  let electronApp;
  let monitor;
  let diagnosticCapture;
  let diagnosticStopPromise;
  let diagnosticDeadline;
  const diagnosticMarkerErrors = [];
  const sample = {
    ordinal,
    startedAt: new Date().toISOString(),
    status: 'running',
    hostLoad: os.loadavg(),
    hostTestsBefore: command('ps', ['-axo', 'pid,ppid,command'])
      .split('\n')
      .filter((line) => /run-guarded-dev-script|playwright test/.test(line)),
    tasks: [],
    counters: {},
  };
  let page;
  const traceMark = async (label) => {
    if (!frameTraceDiagnostic || !page) return;
    let timer;
    const marking = page.evaluate((mark) => {
      performance.mark(`canopy-frame-trace:${mark}`);
    }, label);
    marking.catch(() => undefined);
    try {
      await Promise.race([
        marking,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `renderer trace mark timed out after ${DIAGNOSTIC_TRACE_MARK_TIMEOUT_MS} ms`,
                ),
              ),
            DIAGNOSTIC_TRACE_MARK_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      diagnosticMarkerErrors.push(`trace mark ${label}: ${error}`);
    } finally {
      clearTimeout(timer);
    }
  };
  const stopDiagnostic = (reason) => {
    if (!diagnosticCapture) return Promise.resolve(undefined);
    if (!diagnosticStopPromise) {
      clearTimeout(diagnosticDeadline);
      diagnosticStopPromise = (async () => {
        const errors = [];
        const stopping = diagnosticCapture.stop().catch((error) => {
          errors.push(`capture stop: ${error}`);
          return { status: 'partial', errors: [] };
        });
        const marking = traceMark(`stop:${reason}`);
        const [result] = await Promise.all([stopping, marking]);
        if (reason === 'deadline')
          errors.push('capture deadline expired after 90000 ms');
        const combined = [
          ...(result.errors ?? []),
          ...diagnosticMarkerErrors,
          ...errors,
        ];
        return {
          ...result,
          stopReason: reason,
          timedOut: reason === 'deadline',
          status:
            result.status === 'ok' && combined.length === 0 ? 'ok' : 'partial',
          errors: combined,
        };
      })();
    }
    return diagnosticStopPromise;
  };
  const task = async (kind, action) => {
    if (frameTraceDiagnostic && kind === 'workspace_ready')
      await traceMark('task-start:workspace_ready');
    const entry = {
      kind,
      startedAtMs: performance.now(),
      status: 'running',
      rendererStart: await markRendererTask(page, `task:start:${kind}`),
    };
    sample.tasks.push(entry);
    let value;
    try {
      value = await action();
      entry.status = 'ok';
    } catch (error) {
      entry.status = 'error';
      entry.error = String(error);
      throw error;
    } finally {
      entry.durationMs = performance.now() - entry.startedAtMs;
      entry.rendererEnd = await markRendererTask(
        page,
        `task:end:${kind}:${entry.status}`,
      );
      if (frameTraceDiagnostic && kind === 'workspace_ready')
        await traceMark(`task-end:workspace_ready:${entry.status}`);
    }
    if (values.maintenance)
      process.stdout.write(
        `[browser-profile-data] ${kind}: ${sample.tasks.at(-1).durationMs.toFixed(1)}ms\n`,
      );
    return value;
  };
  try {
    const start = performance.now();
    let headlessAdapter;
    const diagnosticLaunch = frameTraceDiagnostic
      ? await prepareDiagnosticLaunch(`${output}.sample-${ordinal}-frame-trace`)
      : undefined;
    ({ electronApp, headlessAdapter } = await launchCanopy({
      buildKind: 'production',
      productionWindowMode: values['window-mode'],
      productionAdapterArchivePath: `${output}.sample-${ordinal}-launch-${sample.adapterLaunches?.length ?? 0}.adapter.cjs`,
      userDataDir,
      // CANOPY_DATA_DIR isolates application metadata, but only E2E builds
      // redirect Electron's userData themselves. Isolate the production runtime
      // before startup, including Chromium's default session and partitions.
      electronArgs: [
        `--user-data-dir=${userDataDir}`,
        ...(diagnosticLaunch?.electronArgs ?? []),
      ],
      env: diagnosticLaunch
        ? {
            CANOPY_PERFORMANCE_PROFILE_PLAIN_JS: '1',
            CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR:
              diagnosticLaunch.utilityCpuProfileDir,
          }
        : undefined,
      viewportSize: null,
    }));
    sample.adapterLaunches ??= [];
    sample.adapterLaunches.push(headlessAdapter);
    page = await getMainWindow(electronApp);
    sample.firstWindowMs = performance.now() - start;
    await page.waitForLoadState('domcontentloaded');
    sample.windowEvidence = {};
    await beginProductionHeadlessEvidence(
      electronApp,
      page,
      sample.windowEvidence,
    );
    if (diagnosticLaunch) {
      diagnosticCapture = await startDiagnosticCapture({
        electronApp,
        page,
        launch: diagnosticLaunch,
        scenarioName: 'browser-profile-common-frame-trace',
        benchmarkContext: {
          diagnosticOnly: true,
          ordinal,
          workload: 'common',
        },
      });
      diagnosticDeadline = setTimeout(() => {
        void stopDiagnostic('deadline');
      }, 90_000);
      diagnosticDeadline.unref?.();
      await traceMark('capture-armed');
      await traceMark('measurement-start');
    }
    monitor = await startPerformanceMonitor({
      page,
      electronApp,
      sampleIntervalMs: 200,
    });
    await traceMark('monitor-start');
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 45_000 });
    sample.shellMs = performance.now() - start;
    await traceMark('shell-ready');
    // Check owner fixture survival before the longer switch workload. Startup
    // normalizes the workspace index, including required display metadata.
    const workspaceIndex = JSON.parse(
      await readFile(
        path.join(userDataDir, 'workspaces', 'index.json'),
        'utf8',
      ),
    );
    assert(
      workspaceIndex.workspaces.some(
        (entry) => entry.id === extraOwners[0].projectId,
      ),
      'The benchmark Cowork workspace must survive startup normalization',
    );
    sample.runtime = await electronApp.evaluate(() => ({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    }));
    sample.nativeDataPaths = await electronApp.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    }));
    const isolatedRoot = await realpath(userDataDir);
    for (const nativePath of Object.values(sample.nativeDataPaths)) {
      assert.equal(await realpath(nativePath), isolatedRoot);
    }
    // Reading only metadata must leave every named native directory absent.
    const listed = await page.evaluate(async () => {
      let offset;
      let count = 0;
      do {
        const result = await window.api.browser.profiles.list(
          offset === undefined ? undefined : { offset },
        );
        count += result.profiles.length;
        offset = result.nextOffset;
      } while (offset !== undefined);
      return count;
    });
    assert.equal(listed, 1000);
    const partitions = await readdir(
      path.join(userDataDir, 'Partitions'),
    ).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.equal(
      partitions.filter((name) => name.startsWith('canopy-browser-profile-'))
        .length,
      0,
    );
    sample.counters.lazyProfiles = listed;
    sample.counters.nativeProfileDirectoriesBeforeUse = 0;
    await task('workspace_ready', async () => {
      await app.openMainPage();
      await app.selectWorktree(owner.worktreeId);
      await expect(page.getByTestId('panel-grid-root')).toBeVisible();
    });
    if (frameTraceDiagnostic) {
      sample.diagnostic = await stopDiagnostic('workspace-ready-complete');
      sample.monitoring = await monitor.stop();
      monitor = undefined;
      await endProductionHeadlessEvidence(
        electronApp,
        page,
        sample.windowEvidence,
      );
      sample.status = sample.diagnostic.status === 'ok' ? 'ok' : 'partial';
      return sample;
    }
    await task('cold_task_ready', async () => {
      await page.getByTestId('panel-add-panel-group-terminal').click();
      await page.getByTestId('panel-add-menu-item-browser').click();
      await expect(page.getByTestId('browser-bar')).toBeVisible();
      const address = page.getByTestId('browser-url-input');
      await address.fill(fixtureUrl);
      await address.press('Enter');
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents
                .getAllWebContents()
                .some(
                  (contents) =>
                    contents.getURL() === url &&
                    contents.getTitle() === 'Profile benchmark ready',
                ),
            fixtureUrl,
          ),
        )
        .toBe(true);
    });
    if (values.maintenance) {
      sample.counters.maintenance = await runBrowserProfileDataWorkload({
        page,
        electronApp,
        userDataDir,
        owner,
        coworkProjectId: extraOwners[0].projectId,
        fixtureUrl,
        task,
      });
      sample.monitoring = await monitor.stop();
      monitor = await startPerformanceMonitor({
        page,
        electronApp,
        sampleIntervalMs: 200,
      });
      await delay(report.configuration.settledIdleMs);
      sample.settled = await monitor.stop();
      monitor = undefined;
      assertValidMonitoring(sample.monitoring.summary);
      sample.responsiveness = assessResponsiveness(
        sample.monitoring.summary,
        RESPONSIVENESS_THRESHOLDS,
      );
      sample.status = sample.responsiveness.passed ? 'ok' : 'unresponsive';
      await endProductionHeadlessEvidence(
        electronApp,
        page,
        sample.windowEvidence,
      );
      return sample;
    }
    for (let index = 0; index < 20; index++) {
      const destination = index % 2;
      await task('named_switch_ready', async () => {
        await page.getByTestId('browser-profile-picker').click();
        // The profile dropdown is Canopy's menu (SettingsSelect), not a native
        // select: open it, then press the option with the profile's value.
        await page.getByTestId('browser-profile-selection').click();
        await page
          .getByRole('listbox')
          .locator(`[role="option"][data-value="${profileIds[destination]}"]`)
          .click();
        await page.getByTestId('browser-profile-replace').click();
        await expect(page.getByTestId('browser-profile-menu')).toHaveCount(0);
        await expect(page.getByTestId('browser-profile-picker')).toContainText(
          `Account ${String(destination).padStart(4, '0')}`,
        );
        await expect
          .poll(() =>
            electronApp.evaluate(
              ({ webContents }, url) =>
                webContents
                  .getAllWebContents()
                  .some(
                    (contents) =>
                      contents.getURL() === url &&
                      contents.getTitle() === 'Profile benchmark ready',
                  ),
              fixtureUrl,
            ),
          )
          .toBe(true);
      });
    }
    sample.counters.switches = 20;
    // Measure real keyboard input in an existing product input, without submitting a chat.
    const address = page.getByTestId('browser-url-input');
    await address.fill('');
    await page.evaluate(() => {
      window.__CANOPY_DESKTOP_PERF__.typingProbeActive = true;
    });
    await address.pressSequentially(
      'https://example.test/profile-input-check',
      { delay: 50 },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() => {
      window.__CANOPY_DESKTOP_PERF__.typingProbeActive = false;
    });
    await address.press('Escape');
    // Entry owners exercise the same public IPC used by their Browser panels;
    // report these allocation timings separately from the code-tab click flow.
    const entryTabs = [];
    for (const [kind, entryOwner] of [
      ['cowork', extraOwners[0]],
      ['advisor', extraOwners[2]],
    ]) {
      entryTabs.push(
        await task(`cold_${kind}_command_ready`, async () => {
          const url = `${fixtureUrl}?cold=${kind}`;
          const snapshot = await page.evaluate(
            (input) => window.api.browser.create(input),
            { ...entryOwner, url },
          );
          await expect
            .poll(() =>
              electronApp.evaluate(
                ({ webContents }, url) =>
                  webContents
                    .getAllWebContents()
                    .some(
                      (contents) =>
                        contents.getURL() === url &&
                        contents.getTitle() === 'Profile benchmark ready',
                    ),
                url,
              ),
            )
            .toBe(true);
          return snapshot;
        }),
      );
    }
    assert.notEqual(
      entryTabs[0].profile.resolvedProfileId,
      entryTabs[1].profile.resolvedProfileId,
    );
    const sharedTabs = await task('shared_20_tabs_ready', async () => {
      const requests = Array.from({ length: 20 }, (_, index) => ({
        ...[owner, ...extraOwners][index % 5],
        selection: { kind: 'named', profileId: profileIds[0] },
        url: `${fixtureUrl}?shared=${index}`,
      }));
      const snapshots = await page.evaluate(
        (requests) =>
          Promise.all(
            requests.map((input) => window.api.browser.create(input)),
          ),
        requests,
      );
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents
                .getAllWebContents()
                .filter(
                  (contents) =>
                    contents.getURL().startsWith(`${url}?shared=`) &&
                    contents.getTitle() === 'Profile benchmark ready',
                ).length,
            fixtureUrl,
          ),
        )
        .toBe(20);
      return snapshots;
    });
    sample.counters.shared = await electronApp.evaluate(
      ({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL().startsWith(`${url}?shared=`));
        const sessions = [
          ...new Set(contents.map((contents) => contents.session)),
        ];
        return {
          views: contents.length,
          sessions: sessions.length,
          downloadListeners: sessions.map((session) =>
            session.listenerCount('will-download'),
          ),
        };
      },
      fixtureUrl,
    );
    assert.deepEqual(sample.counters.shared, {
      views: 20,
      sessions: 1,
      downloadListeners: [1],
    });
    await task('shared_20_tabs_closed', async () => {
      await page.evaluate(
        (tabs) =>
          Promise.all(
            tabs.map((tab) =>
              window.api.browser.destroy({ browserId: tab.id }),
            ),
          ),
        sharedTabs,
      );
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents
                .getAllWebContents()
                .filter((contents) =>
                  contents.getURL().startsWith(`${url}?shared=`),
                ).length,
            fixtureUrl,
          ),
        )
        .toBe(0);
    });
    await page.evaluate(
      (tabs) =>
        Promise.all(
          tabs.map((tab) => window.api.browser.destroy({ browserId: tab.id })),
        ),
      entryTabs,
    );
    // Stop the active collector before starting a separate settled-idle window.
    sample.monitoring = await monitor.stop();
    monitor = await startPerformanceMonitor({
      page,
      electronApp,
      sampleIntervalMs: 200,
    });
    await delay(report.configuration.settledIdleMs);
    sample.settled = await monitor.stop();
    monitor = undefined;
    assertValidMonitoring(sample.monitoring.summary);
    sample.responsiveness = assessResponsiveness(
      sample.monitoring.summary,
      RESPONSIVENESS_THRESHOLDS,
    );
    sample.status = sample.responsiveness.passed ? 'ok' : 'unresponsive';
    await endProductionHeadlessEvidence(
      electronApp,
      page,
      sample.windowEvidence,
    );
    return sample;
  } catch (error) {
    sample.status = 'error';
    sample.error = error.stack ?? String(error);
    if (frameTraceDiagnostic && error?.diagnosticCapture)
      sample.diagnostic = error.diagnosticCapture;
    sample.failureUserDataDir = userDataDir;
    if (diagnosticCapture)
      sample.diagnostic = await stopDiagnostic('workload-error');
    if (electronApp) {
      const page = await getMainWindow(electronApp).catch(() => undefined);
      if (page) {
        sample.failureUi = await page
          .getByTestId('browser-profile-menu')
          .allTextContents()
          .catch(() => []);
        const screenshot = `${output}.sample-${ordinal}-failure.png`;
        await page.screenshot({ path: screenshot }).catch(() => undefined);
        sample.failureScreenshot = screenshot;
      }
      sample.failureViews = await electronApp
        .evaluate(({ webContents }) =>
          webContents.getAllWebContents().map((contents) => ({
            id: contents.id,
            url: contents.getURL(),
            title: contents.getTitle(),
          })),
        )
        .catch(() => []);
    }
    if (monitor)
      sample.monitoring = await monitor
        .stop()
        .catch((failure) => ({ error: String(failure) }));
    if (frameTraceDiagnostic && electronApp && page && sample.windowEvidence)
      await endProductionHeadlessEvidence(
        electronApp,
        page,
        sample.windowEvidence,
      ).catch(() => undefined);
    return sample;
  } finally {
    clearTimeout(diagnosticDeadline);
    sample.hostLoadAfter = os.loadavg();
    sample.hostTestsAfter = command('ps', ['-axo', 'pid,ppid,command'])
      .split('\n')
      .filter((line) => /run-guarded-dev-script|playwright test/.test(line));
    if (electronApp) {
      try {
        await closeCanopy(electronApp, userDataDir, {
          keepUserData: sample.status === 'error',
        });
      } catch (error) {
        sample.primaryStatus = sample.status;
        sample.status = 'error';
        sample.cleanupError = error.stack ?? String(error);
        sample.error ??= sample.cleanupError;
      }
    }
  }
}
try {
  await save();
  for (let ordinal = -warmups; ordinal < samples; ordinal++) {
    process.stdout.write(
      `[browser-profiles-release] ${ordinal < 0 ? 'warm-up' : `sample ${ordinal + 1}/${samples}`}\n`,
    );
    const sample = await runSample(ordinal);
    if (frameTraceDiagnostic) report.observation.attempts.push(sample);
    else if (ordinal < 0) report.warmup = sample;
    else report.samples.push(sample);
    await save();
    process.stdout.write(
      `[browser-profiles-release] ${sample.status}: shell=${sample.shellMs?.toFixed(1)}ms\n`,
    );
    if (sample.status === 'error') throw new Error(sample.error);
  }
  report.completedAt = new Date().toISOString();
  if (frameTraceDiagnostic) {
    report.observation.status = report.observation.attempts[0]?.status;
  } else {
    report.summary = {
      shellMs: summarize(report.samples.map((sample) => sample.shellMs)),
      firstWindowMs: summarize(
        report.samples.map((sample) => sample.firstWindowMs),
      ),
      tasks: Object.fromEntries(
        Array.from(
          new Set(
            report.samples.flatMap((sample) =>
              sample.tasks.map((task) => task.kind),
            ),
          ),
        ).map((kind) => [
          kind,
          summarize(
            report.samples.flatMap((sample) =>
              sample.tasks
                .filter((task) => task.kind === kind)
                .map((task) => task.durationMs),
            ),
          ),
        ]),
      ),
      passed: report.samples.every((sample) => sample.status === 'ok'),
    };
  }
  await save();
  if (
    frameTraceDiagnostic
      ? report.observation.status !== 'ok'
      : !report.summary.passed
  )
    process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
}

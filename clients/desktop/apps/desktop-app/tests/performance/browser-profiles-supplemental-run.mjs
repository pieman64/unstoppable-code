/**
 * Supplemental release-like browser-profile evidence; never launches agents.
 * Run AFTER the primary guarded benchmark, against the same production bundle:
 * node scripts/run-guarded-dev-script.mjs --suite performance -- node --import tsx
 *   apps/desktop-app/tests/performance/browser-profiles-supplemental-run.mjs
 *   --mode inventory|cold|veto|retirement --samples 20 --warmups 1 --output FILE
 * Each mode is independent. No retries, omitted failures, mocked workers, or E2E APIs.
 * Inventory intentionally fails if real navigation AND typing do not overlap a scan.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
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
import { seedBrowserProfileEntryOwners } from '../electron/seeders/browser-profile-state.mjs';
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
  waitForInventoryAdmission,
} from './browser-profiles-evidence.mjs';
import { summarize } from './statistics.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const { values } = parseArgs({
  options: {
    mode: { type: 'string' },
    output: { type: 'string' },
    'window-mode': { type: 'string', default: 'headless' },
    samples: { type: 'string', default: '5' },
    warmups: { type: 'string', default: '1' },
  },
});
assert(
  ['inventory', 'cold', 'veto', 'retirement'].includes(values.mode),
  'Select --mode inventory|cold|veto|retirement',
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
const samples = Number(values.samples),
  warmups = Number(values.warmups);
assert(Number.isInteger(samples) && samples >= 1 && samples <= 100);
assert(warmups === 0 || warmups === 1);
const output = path.resolve(root, values.output);
const codeOwner = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
function command(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8' }).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
async function manifest(directory, prefix = '') {
  const entries = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name),
      absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(entries, await manifest(absolute, relative));
    else if (entry.isFile()) entries[relative] = await hash(absolute);
  }
  return entries;
}
const server = createServer((request, response) => {
  const account =
    new URL(request.url, 'http://localhost').searchParams.get('account') ??
    'code';
  response.writeHead(200, {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-store',
  });
  response.end(`<!doctype html><title>Supplemental fixture ready</title><input aria-label="Fixture input"><script>
    const expected = ${JSON.stringify(account)};
    const previous = localStorage.getItem('account');
    localStorage.setItem('account', previous || expected);
    document.body.dataset.previousAccount = previous || '';
    document.body.dataset.account = localStorage.getItem('account');
    document.body.dataset.ready = 'true';
  </script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${server.address().port}/fixture`;
const report = {
  schemaVersion: 2,
  benchmarkKind: 'release-like-supplemental',
  mode: values.mode,
  startedAt: new Date().toISOString(),
  configuration: { samples, warmups, windowMode: values['window-mode'] },
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
    commit: command('git', ['rev-parse', 'HEAD']),
    branch: command('git', ['branch', '--show-current']),
    dirty: command('git', ['status', '--porcelain']),
    driverSha256: await hash(fileURLToPath(import.meta.url)),
    helperSha256: Object.fromEntries(
      await Promise.all(
        [
          'monitor.mjs',
          'browser-profiles-evidence.mjs',
          'responsiveness.mjs',
          'statistics.mjs',
          '../electron/launchCanopy.mjs',
          '../electron/canopyApp.mjs',
          '../electron/seeders/browser-profile-state.mjs',
        ].map(async (file) => [
          file,
          await hash(new URL(file, import.meta.url)),
        ]),
      ),
    ),
    bundles: await manifest(path.join(root, 'out')),
  },
  environment: {
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
    nativeSessionData: 'Electron --user-data-dir checked before profile writes',
  },
  caveats: [
    'Optimized unpackaged production bundle with mock OS keychain; no signing/installer/ASAR measurement.',
    'No remote account or agent workload. Host conditions and all raw samples retained.',
    'Resource collector begins after DOM availability, not process launch.',
    'Typing is unmeasured in cold/veto/retirement modes; inventory requires every key sample.',
    'Inventory workload monitoring excludes fixture setup and requires at least two native inventory-worker CPU/RSS observations. The single canonical app.getAppMetrics call is inspected before normalization; no second CPU reader perturbs its cadence.',
    'Hidden native boundaries and pre-import all-window activation records are required; native foreground responsiveness is not measured.',
    'Retirement acknowledgement uses public workEntries.delete IPC; restart purge is separately observed from the filesystem.',
  ],
  warmup: null,
  samples: [],
};
async function save() {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
async function seed(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: codeOwner.projectId,
    worktreeId: codeOwner.worktreeId,
    providerType: 'claude',
    tabs: [{ id: 'seed-chat', title: 'Chat' }],
  });
  const owners = await seedBrowserProfileEntryOwners(userDataDir);
  if (values.mode === 'cold') {
    // Sidebar entry rows require actual chat activity. An empty work-entry
    // record alone is intentionally hidden even when its workspace is expanded.
    const createdAt = '2026-09-01T00:00:00.000Z';
    const { file: entryChat } = seedWorktreeChat({
      userDataDir,
      workspaceId: owners[0].projectId,
      worktreeId: owners[0].worktreeId,
      providerType: 'claude',
      tabs: [
        {
          id: 'profile-cold-chat',
          title: 'Browser data task',
          createdAt,
          messages: [
            {
              id: 'profile-cold-message',
              role: 'assistant',
              timestamp: Date.parse(createdAt),
              blocks: [
                { type: 'text', text: 'Seeded browser benchmark task.' },
              ],
            },
          ],
        },
      ],
    });
    for (const owner of owners) {
      const directory = path.join(
        userDataDir,
        owner.projectId === 'app-advisor' ? 'app-workspaces' : 'workspaces',
        owner.projectId,
      );
      if (owner.projectId === 'app-advisor') {
        await mkdir(path.join(directory, 'chats'), { recursive: true });
        await writeFile(
          path.join(directory, 'chats', `${owner.worktreeId}.json`),
          JSON.stringify({
            ...entryChat,
            tabs: entryChat.tabs.map((tab) => ({
              ...tab,
              providerType: 'codex',
            })),
          }),
        );
      }
      const entriesPath = path.join(directory, 'work-entries.json');
      const entries = JSON.parse(await readFile(entriesPath, 'utf8'));
      const entry = entries.entries.find(
        (entry) => entry.id === owner.worktreeId,
      );
      assert(
        entry,
        'Cold browser owner must be present in its seeded entry list',
      );
      entry.lastMessageAt = createdAt;
      await writeFile(entriesPath, JSON.stringify(entries));
    }
  }
  // Persist the ordinary advanced-layout preference; no runtime fixture API.
  for (const owner of [codeOwner]) {
    const directory = path.join(
      userDataDir,
      'workspaces',
      owner.projectId,
      'worktree-data',
      owner.worktreeId,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'panel-layout-mode.json'),
      JSON.stringify({ version: 1, mode: 'advanced' }),
    );
  }
  return owners;
}
async function ownedPath(userDataDir, directory) {
  const actual = await realpath(directory),
    base = await realpath(userDataDir);
  assert(
    actual.startsWith(`${base}${path.sep}`),
    `Native Session outside fixture: ${actual}`,
  );
  return actual;
}
async function fixtureState(electronApp, url) {
  return electronApp.evaluate(async ({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === url);
    if (!contents || contents.getTitle() !== 'Supplemental fixture ready')
      return null;
    return {
      id: contents.id,
      storagePath: contents.session.storagePath,
      state: await contents.executeJavaScript('({ ...document.body.dataset })'),
    };
  }, url);
}
async function ready(electronApp, url, account) {
  let state;
  await expect
    .poll(
      async () => {
        state = await fixtureState(electronApp, url).catch(() => null);
        return (
          state?.state?.ready === 'true' && state.state.account === account
        );
      },
      { timeout: 30_000, intervals: [20, 50, 100] },
    )
    .toBe(true);
  return state;
}
async function tabsFor(page, owner) {
  const result = await page.evaluate(
    (owner) => window.api.browser.loadWorktreeState(owner),
    owner,
  );
  assert.equal(result.status, 'loaded');
  return result.state.browsers;
}
async function createNamed(page, name) {
  return page.evaluate(
    (displayName) =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName },
      }),
    name,
  );
}
async function addBrowser(page, group = 'group-terminal') {
  await page.getByTestId(`panel-add-panel-${group}`).click();
  await expect(page.getByTestId('panel-add-menu-item-browser')).toBeVisible();
}
async function navigate(page, url) {
  const address = page.getByTestId('browser-url-input');
  await address.fill(url);
  await address.press('Enter');
}
async function runSample(ordinal) {
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), 'browser-profile-supplemental-'),
  );
  const sample = {
    ordinal,
    startedAt: new Date().toISOString(),
    status: 'running',
    tasks: [],
    monitoring: [],
    hostLoad: os.loadavg(),
    userDataDir,
    typing: values.mode === 'inventory' ? 'required' : 'unmeasured',
  };
  let electronApp, page, monitor, monitorContext, owners;
  const task = async (kind, action) => {
    const entry = {
      kind,
      startedAtMs: performance.now(),
      status: 'running',
      rendererStart: await markRendererTask(
        monitorContext.target,
        `task:start:${kind}`,
      ),
    };
    sample.tasks.push(entry);
    try {
      const result = await action();
      entry.status = 'ok';
      return result;
    } catch (error) {
      entry.status = 'error';
      entry.error = String(error);
      throw error;
    } finally {
      entry.durationMs = performance.now() - entry.startedAtMs;
      entry.rendererEnd = await markRendererTask(
        monitorContext.target,
        `task:end:${kind}:${entry.status}`,
      );
    }
  };
  const stopMonitor = async (label) => {
    if (!monitor) return;
    const result = await monitor.stop();
    monitor = undefined;
    const entry = {
      label,
      scope: monitorContext.scope,
      startedAtMs: monitorContext.startedAtMs,
      completedAtMs: performance.now(),
      windowEvidence: monitorContext.windowEvidence,
      ...result,
      responsiveness: assessResponsiveness(
        result.summary,
        RESPONSIVENESS_THRESHOLDS,
      ),
    };
    sample.monitoring.push(entry);
    await endProductionHeadlessEvidence(
      electronApp,
      monitorContext.target,
      entry.windowEvidence,
    );
    if (entry.scope === 'setup') return result;
    assertValidMonitoring(result.summary);
    assert(
      result.summary.ipcOuterMs.count > 0,
      `${label}: IPC samples missing`,
    );
    assert(
      result.summary.rendererFrameDelayMs.count > 0,
      `${label}: frame samples missing`,
    );
    return result;
  };
  const startMonitor = async (target = page, scope = 'workload') => {
    const windowEvidence = {};
    sample.windowSetups ??= [];
    sample.windowSetups.push(windowEvidence);
    await beginProductionHeadlessEvidence(electronApp, target, windowEvidence);
    monitorContext = {
      target,
      scope,
      startedAtMs: performance.now(),
      windowEvidence,
    };
    // Observe the canonical collector's existing native read, before its missing-field
    // normalization. This adapter passes the original result through unchanged and
    // does not make a second getAppMetrics call (which would perturb CPU sampling).
    const nativeMetricsObserver = {
      evaluate: async (...args) => {
        const metrics = await electronApp.evaluate(...args);
        const observedAtMs = performance.now();
        assert(
          Array.isArray(metrics) && metrics.length > 0,
          'Native app metrics missing',
        );
        const invalid = metrics.filter(
          (metric) =>
            !Number.isFinite(metric.cpu?.percentCPUUsage) ||
            !Number.isFinite(metric.memory?.workingSetSize),
        );
        if (scope === 'inventory_workload') {
          const workers = metrics.filter(
            (metric) =>
              metric.serviceName === 'browser-profile-inventory' ||
              metric.name === 'browser-profile-inventory',
          );
          sample.inventory.workerResources.samples.push({
            observedAtMs,
            jobId: sample.inventory.jobId ?? null,
            workers,
            invalidMetricPids: invalid.map((metric) => metric.pid),
          });
          for (const worker of workers) {
            assert(
              Number.isInteger(worker.pid) &&
                worker.pid > 0 &&
                Number.isFinite(worker.creationTime),
              'Inventory worker process identity is missing',
            );
          }
        }
        assert.equal(
          invalid.length,
          0,
          'Native CPU or working-set fields missing before monitor normalization',
        );
        return metrics;
      },
    };
    monitor = await startPerformanceMonitor({
      page: target,
      electronApp: nativeMetricsObserver,
      sampleIntervalMs: 100,
    });
  };
  const launch = async () => {
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
    page = await getMainWindow(electronApp);
    await page.waitForLoadState('domcontentloaded');
    sample.nativePaths ??= [];
    const native = await electronApp.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    }));
    for (const value of Object.values(native))
      assert.equal(await realpath(value), await realpath(userDataDir));
    sample.nativePaths.push(native);
    const runtime = await electronApp.evaluate(() => ({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    }));
    sample.runtimes ??= [];
    sample.runtimes.push(runtime);
    if (sample.runtime)
      assert.deepEqual(
        runtime,
        sample.runtime,
        'Restart runtime versions changed',
      );
    sample.runtime ??= runtime;
    await startMonitor(
      page,
      values.mode === 'inventory' ? 'setup' : 'workload',
    );
    await new CanopyAppDriver(page).waitForShell({ timeout: 45_000 });
  };
  const codeBrowser = async () => {
    const app = new CanopyAppDriver(page);
    await app.openMainPage();
    await app.selectWorktree(codeOwner.worktreeId);
    await addBrowser(page);
    await page.getByTestId('panel-add-menu-item-browser').click();
    await expect(page.getByTestId('browser-bar')).toBeVisible();
    await navigate(page, `${fixture}?account=code`);
    await ready(electronApp, `${fixture}?account=code`, 'code');
    return (await tabsFor(page, codeOwner))[0];
  };
  try {
    owners = await seed(userDataDir);
    await launch();
    if (values.mode === 'cold') {
      sample.cold = [];
      for (const [index, owner] of owners.entries()) {
        let target = page;
        if (index === 0) {
          const toggle = page.getByTestId(
            `sidebar-cowork-project-${owner.projectId}-toggle`,
          );
          // The stopped-app fixture persists this workspace expanded. Wait for
          // that state and its visible activity row before navigating to it.
          await expect(toggle).toHaveAttribute('aria-expanded', 'true');
          const entry = page.getByTestId(
            `sidebar-work-entry-${owner.worktreeId}`,
          );
          await expect(entry).toBeVisible();
          await entry.click();
          await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
        } else {
          await stopMonitor('cowork');
          target = await new CanopyAppDriver(page).openAppAdvisorWindow(
            electronApp,
          );
          await startMonitor(target);
          await target
            .getByTestId(`app-advisor-nav-entry-${owner.worktreeId}`)
            .click();
        }
        const before = await target.evaluate(() =>
          window.api.browser.profiles.list(),
        );
        const account = index === 0 ? 'cowork' : 'advisor';
        await addBrowser(target, 'group-chat');
        const details = await task(
          `cold_${account}_add_browser_click_to_account_ready`,
          async () => {
            await target.getByTestId('panel-add-menu-item-browser').click();
            await expect(target.getByTestId('browser-bar')).toBeVisible();
            await navigate(target, `${fixture}?account=${account}`);
            return ready(electronApp, `${fixture}?account=${account}`, account);
          },
        );
        assert.equal(
          details.state.previousAccount,
          '',
          'Cold Task starts with no existing account state',
        );
        const tabs = await tabsFor(target, owner);
        assert.equal(tabs.length, 1);
        const binding = tabs[0].profile;
        assert(binding?.resolvedProfileId);
        assert(
          !before.profiles.some(
            (profile) => profile.profileId === binding.resolvedProfileId,
          ),
        );
        const record = await target.evaluate(
          (profileId) => window.api.browser.profiles.get({ profileId }),
          binding.resolvedProfileId,
        );
        assert.equal(record.kind, 'task');
        assert.deepEqual(
          record.owner.taskScope,
          index === 0
            ? {
                kind: 'cowork_work_entry',
                workspaceId: owner.projectId,
                workEntryId: owner.worktreeId,
              }
            : { kind: 'app_advisor_work_entry', workEntryId: owner.worktreeId },
        );
        assert.equal(record.owner.taskIncarnationId, binding.taskIncarnationId);
        const nativePath = await ownedPath(userDataDir, details.storagePath);
        assert(
          nativePath.includes(binding.resolvedProfileId),
          'Ready fixture belongs to the newly bound Task Session',
        );
        sample.cold.push({ owner, binding, record, details });
      }
      assert.notEqual(
        sample.cold[0].binding.resolvedProfileId,
        sample.cold[1].binding.resolvedProfileId,
      );
    } else if (values.mode === 'inventory') {
      const tab = await codeBrowser();
      const profileId = tab.profile.resolvedProfileId;
      const directory = await ownedPath(
        userDataDir,
        (await fixtureState(electronApp, `${fixture}?account=code`))
          .storagePath,
      );
      const filesDirectory = path.join(
        directory,
        'supplemental-inventory-fixture',
      );
      await mkdir(filesDirectory, { recursive: true });
      const totalBytes = 1024 ** 3,
        count = 10000;
      let logicalBytes = 0,
        allocatedBytes = 0;
      // Ten files per directory models a native tree and keeps the real scan observable.
      // Scanner measures stat sizes, not contents: use the primary workload's sparse
      // fixture, and report logical and allocated bytes separately without conflating them.
      for (let first = 0; first < count; first += 10) {
        const bucket = path.join(filesDirectory, String(first / 10));
        await mkdir(bucket);
        await Promise.all(
          Array.from({ length: 10 }, async (_, offset) => {
            const index = first + offset;
            const size =
              Math.floor(totalBytes / count) +
              (index < totalBytes % count ? 1 : 0);
            const file = path.join(bucket, String(index));
            const handle = await open(file, 'wx');
            try {
              await handle.truncate(size);
            } finally {
              await handle.close();
            }
            const details = await stat(file);
            logicalBytes += details.size;
            allocatedBytes += details.blocks * 512;
          }),
        );
      }
      assert.equal(logicalBytes, totalBytes);
      sample.inventory = {
        logicalBytes,
        allocatedBytes,
        sparse: true,
        files: count,
        directories: count / 10,
        observations: [],
        workerResources: {
          serviceName: 'browser-profile-inventory',
          nativeFieldsValidated: true,
          samples: [],
        },
      };
      const url = `${fixture}?account=code&navigation=during-inventory`;
      const address = page.getByTestId('browser-url-input');
      await address.fill(url);
      await stopMonitor('inventory_setup');
      await startMonitor(page, 'inventory_workload');
      const inventoryRendererStart = await markRendererTask(
        page,
        'task:start:inventory_request_to_complete',
      );
      const operationStarted = performance.now();
      const operationStartedEpochMs = Date.now();
      sample.inventory.operationStartedAtMs = operationStarted;
      const job = await page.evaluate(
        (profileId) =>
          window.api.browser.profiles.inventoryStart({
            operationId: crypto.randomUUID(),
            profileId,
            storageGeneration: 1,
          }),
        profileId,
      );
      sample.inventory.jobId = job.jobId;
      const observe = async (label) => {
        const value = await page.evaluate(
          (jobId) => window.api.browser.profiles.jobGet({ jobId }),
          job.jobId,
        );
        sample.inventory.observations.push({
          label,
          atMs: performance.now() - operationStarted,
          job: value,
        });
        return value;
      };
      await waitForInventoryAdmission({ observe });
      assert.equal((await observe('before_navigation')).status, 'running');
      await task('inventory_navigation_ready_while_running', async () => {
        await address.press('Enter');
        await ready(electronApp, url, 'code');
        assert.equal(
          (await observe('navigation_ready')).status,
          'running',
          'Navigation must complete while scan runs',
        );
      });
      await address.fill('');
      assert.equal((await observe('before_typing')).status, 'running');
      await page.evaluate(() => {
        window.__CANOPY_DESKTOP_PERF__.typingProbeActive = true;
      });
      const text = 'scan-active';
      await task('type_inventory_while_running', async () => {
        await address.pressSequentially(text, { delay: 5 });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        assert.equal(
          (await observe('typing_painted')).status,
          'running',
          'All typed characters must paint while scan runs',
        );
      });
      sample.tasks.at(-1).characters = text.length;
      await page.evaluate(() => {
        window.__CANOPY_DESKTOP_PERF__.typingProbeActive = false;
      });
      await expect(address).toHaveValue(text);
      await expect
        .poll(
          async () => {
            const result = await observe('progress');
            assert(
              !['failed', 'cancelled'].includes(result.status),
              JSON.stringify(result),
            );
            return result.status;
          },
          { timeout: 60_000, intervals: [50, 100, 200] },
        )
        .toBe('complete');
      sample.inventory.operationCompletedAtMs = performance.now();
      sample.tasks.push({
        kind: 'inventory_request_to_complete',
        startedAtMs: operationStarted,
        rendererStart: inventoryRendererStart,
        rendererEnd: await markRendererTask(
          page,
          'task:end:inventory_request_to_complete:ok',
        ),
        durationMs: performance.now() - operationStarted,
        status: 'ok',
      });
      sample.inventory.result = await page.evaluate(
        (profileId) =>
          window.api.browser.profiles.inventoryGet({
            profileId,
            storageGeneration: 1,
          }),
        profileId,
      );
      assert(sample.inventory.result.approximateBytes >= totalBytes);
      assert.equal(sample.inventory.result.profileId, profileId);
      assert.equal(sample.inventory.result.storageGeneration, 1);
      assert.equal(sample.inventory.result.jobId, job.jobId);
      assert(Number.isFinite(sample.inventory.result.measuredAt));
      assert(
        sample.inventory.result.measuredAt >= operationStartedEpochMs &&
          sample.inventory.result.measuredAt <= Date.now(),
      );
      assert.equal(sample.inventory.result.coverage, 'partial');
      assert.deepEqual(sample.inventory.result.classBytes, {
        cache: null,
        indexedDB: null,
        opfs: null,
      });
      sample.inventory.intermediateProgress =
        sample.inventory.observations.filter(
          ({ job }) =>
            job.status === 'running' &&
            ((Number.isFinite(job.completedEntries) &&
              job.completedEntries > 0) ||
              (Number.isFinite(job.approximateBytes) &&
                job.approximateBytes > 0)),
        );
      sample.inventory.intermediateProgressStatus = sample.inventory
        .intermediateProgress.length
        ? 'observed'
        : 'unmeasured';
      assert(
        sample.inventory.intermediateProgress.length > 0,
        'Inventory must expose positive intermediate progress while running before completion',
      );
      const collected = await stopMonitor('inventory');
      assertValidTypingSampling(collected.raw, sample.tasks);
      const workerSamples = sample.inventory.workerResources.samples.filter(
        (entry) =>
          entry.observedAtMs >= sample.inventory.operationStartedAtMs &&
          entry.observedAtMs <= sample.inventory.operationCompletedAtMs &&
          entry.workers.length > 0,
      );
      sample.inventory.workerResources.observedWorkloadSamples =
        workerSamples.length;
      assert(
        workerSamples.length >= 2,
        'Inventory worker CPU/RSS requires two identifiable native samples during the workload',
      );
      assert(
        workerSamples.every((entry) => entry.workers.length === 1),
        'Exactly one inventory worker must own this isolated scan',
      );
      const workers = workerSamples.flatMap((entry) => entry.workers);
      sample.inventory.workerResources.identities = [
        ...new Set(
          workers.map((worker) => `${worker.pid}:${worker.creationTime}`),
        ),
      ];
      assert.equal(
        sample.inventory.workerResources.identities.length,
        1,
        'The measured inventory must use one worker process identity',
      );
      sample.inventory.workerResources.cpuPercent = summarize(
        workers.map((worker) => worker.cpu.percentCPUUsage),
      );
      sample.inventory.workerResources.workingSetSizeKb = summarize(
        workers.map((worker) => worker.memory.workingSetSize),
      );
    } else if (values.mode === 'veto') {
      electronApp.context().on('dialog', () => {});
      const tab = await codeBrowser(),
        url = `${fixture}?account=code`;
      const named = await createNamed(page, 'Veto destination');
      const original = await fixtureState(electronApp, url);
      await electronApp.evaluate(async ({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === url);
        await contents.session.cookies.set({
          url,
          name: 'source-account',
          value: 'retained',
          expirationDate: Date.now() / 1000 + 3600,
        });
        await contents.executeJavaScript(
          "window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; document.querySelector('input').value = 'unsaved source text';",
          true,
        );
        for (const type of ['mouseDown', 'mouseUp'])
          contents.sendInputEvent({
            type,
            x: 30,
            y: 30,
            button: 'left',
            clickCount: 1,
          });
      }, url);
      await page.getByTestId('browser-profile-picker').click();
      // The profile dropdown is Canopy's menu (SettingsSelect), not a native
      // select: open it, then press the option with the profile's value.
      await page.getByTestId('browser-profile-selection').click();
      await page
        .getByRole('listbox')
        .locator(`[role="option"][data-value="${named.profileId}"]`)
        .click();
      const modal = page.getByTestId('browser-javascript-dialog');
      await task('switch_click_to_beforeunload_prompt', async () => {
        await page.getByTestId('browser-profile-replace').click();
        await expect(modal).toBeVisible();
      });
      await task('source_veto_click_to_original_account_ready', async () => {
        await modal.getByRole('button', { name: 'Stay', exact: true }).click();
        await expect(modal).toHaveCount(0);
        await expect(page.getByTestId('browser-profile-picker')).toContainText(
          'Task',
        );
        const current = await ready(electronApp, url, 'code');
        assert.equal(
          current.id,
          original.id,
          'Veto retains the exact source webContents',
        );
        assert.equal(current.storagePath, original.storagePath);
      });
      const current = (await tabsFor(page, codeOwner))[0];
      assert.deepEqual(current.profile, tab.profile);
      sample.veto = await electronApp.evaluate(async ({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === url);
        return {
          cookies: await contents.session.cookies.get({ url }),
          input: await contents.executeJavaScript(
            "document.querySelector('input').value",
          ),
          account: await contents.executeJavaScript(
            "localStorage.getItem('account')",
          ),
        };
      }, url);
      assert(
        sample.veto.cookies.some(
          (cookie) =>
            cookie.name === 'source-account' && cookie.value === 'retained',
        ),
      );
      assert.equal(sample.veto.input, 'unsaved source text');
      assert.equal(sample.veto.account, 'code');
    } else {
      const named = await createNamed(page, 'Retained retirement account');
      sample.retirement = {
        owners: [],
        paths: [],
        namedPaths: [],
        acknowledgements: [],
        purgeObservations: [],
      };
      for (let index = 0; index < 100; index++) {
        const created = await page.evaluate(
          (projectId) =>
            window.api.workEntries.create({
              projectId,
              title: 'Supplemental retirement',
            }),
          owners[0].projectId,
        );
        const entry = created.entry ?? created;
        assert.equal(typeof entry.id, 'string');
        assert(
          !sample.retirement.owners.some(
            (owner) => owner.worktreeId === entry.id,
          ),
          'Every retirement fixture owner must be distinct',
        );
        const owner = { projectId: owners[0].projectId, worktreeId: entry.id };
        const url = `${fixture}?account=${index % 2 ? 'named' : `task-${index}`}&owner=${index}`;
        const tab = await page.evaluate(
          (request) => window.api.browser.create(request),
          {
            ...owner,
            url,
            ...(index % 2
              ? { selection: { kind: 'named', profileId: named.profileId } }
              : {}),
          },
        );
        const state = await ready(
          electronApp,
          url,
          index % 2 ? 'named' : `task-${index}`,
        );
        const directory = await ownedPath(userDataDir, state.storagePath);
        await writeFile(
          path.join(directory, 'supplemental-retained-marker'),
          'synthetic owner store\n',
        );
        (index % 2
          ? sample.retirement.namedPaths
          : sample.retirement.paths
        ).push(directory);
        sample.retirement.owners.push({
          ...owner,
          browserId: tab.id,
          profileId: tab.profile.resolvedProfileId,
          kind: index % 2 ? 'named' : 'task',
        });
        await page.evaluate(
          (browserId) => window.api.browser.disposeLiveView({ browserId }),
          tab.id,
        );
      }
      const beforeOwnerBytes = await readFile(
        path.join(
          userDataDir,
          'workspaces',
          owners[0].projectId,
          'work-entries.json',
        ),
      );
      const beforeOwners = JSON.parse(beforeOwnerBytes.toString('utf8'));
      assert(Array.isArray(beforeOwners.entries));
      sample.retirement.ownerStateBefore = {
        persistedStateSha256: createHash('sha256')
          .update(beforeOwnerBytes)
          .digest('hex'),
        fixtureOwnerIds: beforeOwners.entries
          .filter((entry) =>
            sample.retirement.owners.some(
              (owner) => owner.worktreeId === entry.id,
            ),
          )
          .map((entry) => entry.id),
      };
      assert.equal(
        sample.retirement.ownerStateBefore.fixtureOwnerIds.length,
        100,
      );
      for (const owner of sample.retirement.owners) {
        const previouslyActive =
          sample.retirement.acknowledgements.at(-1)?.ownerRemoval
            .remainingFixtureOwners ??
          sample.retirement.ownerStateBefore.fixtureOwnerIds;
        assert(
          previouslyActive.includes(owner.worktreeId),
          'Each retirement must begin with its owner still active',
        );
        const result = await task(
          'owner_retirement_durable_acknowledgement',
          () =>
            page.evaluate((request) => window.api.workEntries.delete(request), {
              projectId: owner.projectId,
              entryId: owner.worktreeId,
            }),
        );
        const acknowledgement = {
          owner,
          result: result ?? null,
          returnKind: result === undefined ? 'void' : 'value',
        };
        sample.retirement.acknowledgements.push(acknowledgement);
        const persistedBytes = await readFile(
          path.join(
            userDataDir,
            'workspaces',
            owner.projectId,
            'work-entries.json',
          ),
        );
        const persisted = JSON.parse(persistedBytes.toString('utf8'));
        assert(
          Array.isArray(persisted.entries),
          'Retirement owner-state fixture must expose its active entries',
        );
        acknowledgement.ownerRemoval = {
          removed: !persisted.entries.some(
            (entry) => entry.id === owner.worktreeId,
          ),
          persistedStateSha256: createHash('sha256')
            .update(persistedBytes)
            .digest('hex'),
          observedAtMs: performance.now(),
          remainingFixtureOwners: sample.retirement.owners
            .filter((candidate) =>
              persisted.entries.some(
                (entry) => entry.id === candidate.worktreeId,
              ),
            )
            .map((candidate) => candidate.worktreeId),
        };
        assert(
          acknowledgement.ownerRemoval.removed,
          'Every acknowledged owner, including named-only owners, must be absent from persisted active state',
        );
      }
      assert.equal(
        sample.retirement.acknowledgements.filter(
          (entry) => entry.ownerRemoval.removed,
        ).length,
        100,
      );
      assert.equal(new Set(sample.retirement.paths).size, 50);
      assert.equal(new Set(sample.retirement.namedPaths).size, 1);
      await expect
        .poll(
          async () => {
            sample.retirement.cleanupBeforeRestart = await page.evaluate(() =>
              window.api.browser.profiles.cleanupStatus(),
            );
            return sample.retirement.owners
              .filter((owner) => owner.kind === 'task')
              .every((owner) =>
                sample.retirement.cleanupBeforeRestart.jobs.some(
                  (job) =>
                    job.profileId === owner.profileId &&
                    job.status === 'pending_restart',
                ),
              );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      for (const owner of sample.retirement.owners.filter(
        (item) => item.kind === 'task',
      )) {
        assert(
          sample.retirement.cleanupBeforeRestart.jobs.some(
            (job) =>
              job.profileId === owner.profileId &&
              job.status === 'pending_restart',
          ),
        );
      }
      for (const directory of sample.retirement.paths)
        assert((await stat(directory)).isDirectory());
      await stopMonitor('retirement_acknowledgements');
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;
      for (const directory of sample.retirement.paths)
        assert(
          (await stat(directory)).isDirectory(),
          'Task native directory remains pending restart',
        );
      const restartedAt = performance.now();
      sample.retirement.restartInvokedAtMs = restartedAt;
      sample.retirement.passiveCatalogSnapshots = [];
      let lastCatalogHash;
      let cancelled = false,
        lastObservation;
      const purge = (async () => {
        while (!cancelled && performance.now() - restartedAt < 90_000) {
          const remaining = (
            await Promise.all(
              sample.retirement.paths.map(async (directory) => {
                try {
                  await stat(directory);
                  return directory;
                } catch (error) {
                  if (error.code === 'ENOENT') return null;
                  throw error;
                }
              }),
            )
          ).filter(Boolean);
          const catalogEvidence = { atMs: performance.now() - restartedAt };
          try {
            const bytes = await readFile(
              path.join(userDataDir, 'browser-profiles', 'catalog.json'),
              'utf8',
            );
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const catalog = JSON.parse(bytes);
            if (sha256 !== lastCatalogHash) {
              sample.retirement.passiveCatalogSnapshots.push({
                ...catalogEvidence,
                sha256,
                revision: catalog.revision,
                jobs: catalog.jobs,
                retirements: catalog.retirements,
              });
              lastCatalogHash = sha256;
            }
            catalogEvidence.sha256 = sha256;
          } catch (error) {
            catalogEvidence.error = String(error);
            sample.retirement.passiveCatalogSnapshots.push(catalogEvidence);
          }
          lastObservation = {
            catalogEvidence,
            atMs: performance.now() - restartedAt,
            remaining,
          };
          sample.retirement.purgeObservations.push(lastObservation);
          sample.retirement.passiveCleanupEvidence = {
            kind: 'filesystem-only; no profile API during timed wait',
            status:
              remaining.length === 0
                ? 'physical-purge-complete'
                : remaining.length < 50
                  ? 'physical-purge-progress'
                  : 'no-physical-purge-observed',
            remainingCount: remaining.length,
            atMs: lastObservation.atMs,
          };
          if (remaining.length === 0) return lastObservation;
          await delay(25);
        }
        throw new Error(
          'Restart did not physically purge all owned Task directories within 90 seconds',
        );
      })();
      // Observe filesystem from launch invocation, including work completed before first window.
      // Attach rejection immediately so launch failure cannot create an unhandled rejection.
      const purgeOutcome = purge.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await launch();
      } catch (error) {
        cancelled = true;
        await purgeOutcome;
        throw error;
      }
      const purged = await purgeOutcome;
      if (purged.error) throw purged.error;
      sample.tasks.push({
        kind: 'restart_invocation_to_physical_task_purge',
        startedAtMs: restartedAt,
        completedAtMs: restartedAt + purged.value.atMs,
        clockScope:
          'Node launch origin; new renderer clock unavailable at restart invocation; boundary mapping observed after passive completion',
        rendererBoundaryAfterCompletion: await markRendererTask(
          page,
          'task:observed-after:restart_invocation_to_physical_task_purge',
        ),
        durationMs: purged.value.atMs,
        status: 'ok',
        observationResolutionMs: 25,
      });
      const retiredIds = new Set(
        sample.retirement.owners
          .filter((item) => item.kind === 'task')
          .map((item) => item.profileId),
      );
      await expect
        .poll(
          async () => {
            sample.retirement.cleanupAfterRestart = await page.evaluate(() =>
              window.api.browser.profiles.cleanupStatus(),
            );
            return sample.retirement.cleanupAfterRestart.jobs.some((job) =>
              retiredIds.has(job.profileId),
            );
          },
          { timeout: 30_000 },
        )
        .toBe(false);
      for (const directory of new Set(sample.retirement.namedPaths)) {
        assert.equal(
          await readFile(
            path.join(directory, 'supplemental-retained-marker'),
            'utf8',
          ),
          'synthetic owner store\n',
        );
      }
      const url = `${fixture}?account=named&restored=true`;
      await page.evaluate((request) => window.api.browser.create(request), {
        ...codeOwner,
        url,
        selection: { kind: 'named', profileId: named.profileId },
      });
      sample.retirement.retainedNamed = await ready(electronApp, url, 'named');
      assert.equal(
        sample.retirement.retainedNamed.state.previousAccount,
        'named',
      );
    }
    await stopMonitor(values.mode);
    const workloadMonitoring = sample.monitoring.filter(
      (entry) => entry.scope !== 'setup',
    );
    assert(workloadMonitoring.length > 0, 'No workload monitoring collected');
    sample.status = workloadMonitoring.every(
      (value) => value.responsiveness.passed,
    )
      ? 'ok'
      : 'unresponsive';
  } catch (error) {
    sample.status = 'error';
    sample.error = error.stack ?? String(error);
    sample.failureUserDataDir = userDataDir;
    if (monitor) {
      const result = await monitor
        .stop()
        .catch((failure) => ({ error: String(failure) }));
      sample.monitoring.push({ label: 'failure', ...result });
      monitor = undefined;
    }
    if (electronApp) {
      sample.failureViews = await electronApp
        .evaluate(({ webContents }) =>
          webContents.getAllWebContents().map((item) => ({
            id: item.id,
            url: item.getURL(),
            title: item.getTitle(),
          })),
        )
        .catch(() => []);
      sample.failureScreenshots = [];
      for (const [index, window] of electronApp.windows().entries()) {
        const screenshot = `${output}.sample-${ordinal}-window-${index}-failure.png`;
        await window.screenshot({ path: screenshot }).then(
          () => sample.failureScreenshots.push(screenshot),
          () => {},
        );
      }
    }
  } finally {
    sample.hostLoadAfter = os.loadavg();
    if (electronApp) {
      try {
        await closeCanopy(electronApp, userDataDir, {
          keepUserData: sample.status !== 'ok',
        });
      } catch (error) {
        sample.status = 'error';
        sample.teardownError = error.stack ?? String(error);
      }
    }
  }
  return sample;
}
try {
  await save();
  for (let ordinal = -warmups; ordinal < samples; ordinal++) {
    process.stdout.write(
      `[browser-profiles-supplemental] ${values.mode} ${ordinal < 0 ? 'warm-up' : `sample ${ordinal + 1}/${samples}`}\n`,
    );
    const sample = await runSample(ordinal).catch((error) => ({
      ordinal,
      status: 'error',
      error: error.stack ?? String(error),
    }));
    if (ordinal < 0) report.warmup = sample;
    else report.samples.push(sample);
    await save();
    process.stdout.write(`[browser-profiles-supplemental] ${sample.status}\n`);
    // An invalid fixture stops further expensive work; the failed attempt remains in the report.
    if (sample.status === 'error') throw new Error(sample.error);
  }
  report.completedAt = new Date().toISOString();
  report.summary = {
    passed: report.samples.every((sample) => sample.status === 'ok'),
    tasks: Object.fromEntries(
      [
        ...new Set(
          report.samples.flatMap((sample) =>
            sample.tasks.map((task) => task.kind),
          ),
        ),
      ].map((kind) => [
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
  };
  await save();
  if (!report.summary.passed) process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

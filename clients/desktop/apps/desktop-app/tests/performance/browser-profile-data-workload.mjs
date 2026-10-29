/** Release-like Phase 3 workload, invoked by browser-profiles-release-run.mjs.
 * All owners, files, pages, cookies, and downloads are synthetic and isolated.
 * Filesystem fixture preparation runs in the driver, never Electron main.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../electron/canopyApp.mjs';

export async function runBrowserProfileDataWorkload({
  page,
  electronApp,
  userDataDir,
  owner,
  coworkProjectId,
  fixtureUrl,
  task,
}) {
  const app = new CanopyAppDriver(page);
  const profile = await page.evaluate(() =>
    window.api.browser.profiles.create({
      operationId: crypto.randomUUID(),
      input: { displayName: 'Data workload account' },
    }),
  );
  const tabs = await page.evaluate(
    (requests) =>
      Promise.all(
        requests.map((request) => window.api.browser.create(request)),
      ),
    Array.from({ length: 20 }, (_, i) => ({
      ...owner,
      selection: { kind: 'named', profileId: profile.profileId },
      url: `${fixtureUrl}?data=${i}`,
    })),
  );
  await expect
    .poll(() =>
      electronApp.evaluate(
        ({ webContents }, fixtureUrl) =>
          webContents
            .getAllWebContents()
            .filter(
              (c) =>
                c.getURL().startsWith(`${fixtureUrl}?data=`) &&
                c.getTitle() === 'Profile benchmark ready',
            ).length,
        fixtureUrl,
      ),
    )
    .toBe(20);
  const nativeDirectory = await electronApp.evaluate(
    ({ webContents }, fixtureUrl) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === `${fixtureUrl}?data=0`).session.storagePath,
    fixtureUrl,
  );
  const realNativeDirectory = await realpath(nativeDirectory);
  const realUserDataDirectory = await realpath(userDataDir);
  assert(
    realNativeDirectory.startsWith(`${realUserDataDirectory}${path.sep}`),
    `Only an isolated fixture Session may receive synthetic files: ${realNativeDirectory} is outside ${realUserDataDirectory}`,
  );
  const files = path.join(realNativeDirectory, 'profile-performance-fixture');
  await mkdir(files, { recursive: true });
  const logicalBytes = 1024 ** 3;
  for (let start = 0; start < 10000; start += 16)
    await Promise.all(
      Array.from({ length: Math.min(16, 10000 - start) }, async (_, offset) => {
        const index = start + offset;
        const file = await open(path.join(files, String(index)), 'wx');
        try {
          await file.truncate(
            Math.floor(logicalBytes / 10000) +
              (index < logicalBytes % 10000 ? 1 : 0),
          );
        } finally {
          await file.close();
        }
      }),
    );
  await app.openSettings();
  await app.openSettingsSection('browser');
  const profileRow = page.getByTestId(
    `browser-profile-row-${profile.profileId}`,
  );
  // The release fixture includes 1,000 lazy profiles. Reach the new profile
  // through the ordinary paginated Settings list before measuring its data.
  for (
    let nextPage = 0;
    nextPage < 11 && (await profileRow.count()) === 0;
    nextPage++
  ) {
    const rows = page.locator('[data-testid^="browser-profile-row-"]');
    const previousCount = await rows.count();
    await page
      .getByRole('button', { name: 'Load more profiles', exact: true })
      .click();
    await expect.poll(() => rows.count()).toBeGreaterThan(previousCount);
  }
  await profileRow.click();
  await task('inventory_cancel_acknowledged', async () => {
    const job = await page.evaluate(
      (profile) =>
        window.api.browser.profiles.inventoryStart({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          storageGeneration: 1,
        }),
      profile,
    );
    await page.evaluate(
      (jobId) => window.api.browser.profiles.jobCancel({ jobId }),
      job.jobId,
    );
    const result = await page.evaluate(
      (profile) =>
        window.api.browser.profiles.inventoryGet({
          profileId: profile.profileId,
          storageGeneration: 1,
        }),
      profile,
    );
    assert.equal(result.measuredAt, null);
  });
  await task('inventory_1gib_10000_files', async () => {
    await page.getByTestId('browser-profile-measure').click();
    await page.evaluate(() => {
      window.__CANOPY_DESKTOP_PERF__.typingProbeActive = true;
    });
    await page
      .getByTestId('browser-profile-new-name')
      .pressSequentially('Inventory stays interactive', { delay: 35 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() => {
      window.__CANOPY_DESKTOP_PERF__.typingProbeActive = false;
    });
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (profile) =>
                window.api.browser.profiles.inventoryGet({
                  profileId: profile.profileId,
                  storageGeneration: 1,
                }),
              profile,
            )
          ).approximateBytes,
        { timeout: 60000 },
      )
      .toBeGreaterThanOrEqual(logicalBytes);
  });
  const readJob = (jobId) =>
    page.evaluate(
      (jobId) => window.api.browser.profiles.jobGet({ jobId }),
      jobId,
    );
  const clear = async (kind) => {
    const current = await page.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      profile.profileId,
    );
    const preview = await page.evaluate(
      ({ profile, operation }) =>
        window.api.browser.profiles.previewClear({
          profileId: profile.profileId,
          storageGeneration: profile.storageGeneration,
          metadataRevision: profile.metadataRevision,
          operation,
        }),
      {
        profile: current,
        operation:
          kind === 'site'
            ? { kind, origin: new URL(fixtureUrl).origin }
            : { kind },
      },
    );
    assert.equal(preview.tabs.length, 20);
    const job = await page.evaluate(
      (token) =>
        window.api.browser.profiles.clear({
          operationId: crypto.randomUUID(),
          token,
        }),
      preview.token,
    );
    await expect
      .poll(
        async () => {
          const result = await readJob(job.jobId);
          if (result.status === 'failed')
            throw new Error(JSON.stringify(result));
          return result.status;
        },
        { timeout: 60000 },
      )
      .toBe('complete');
    await expect
      .poll(
        () =>
          electronApp.evaluate(
            ({ webContents }, fixtureUrl) =>
              webContents
                .getAllWebContents()
                .filter(
                  (c) =>
                    c.getURL().startsWith(`${fixtureUrl}?data=`) &&
                    c.getTitle() === 'Profile benchmark ready',
                ).length,
            fixtureUrl,
          ),
        { timeout: 90000 },
      )
      .toBe(20);
    // Join in-flight restoration through the ordinary existing-tab admission
    // path; a title alone can become ready before create() has fully settled.
    await page.evaluate(async (tabs) => {
      const response = await window.api.browser.loadWorktreeState({
        projectId: tabs[0].projectId,
        worktreeId: tabs[0].worktreeId,
      });
      if (response.status !== 'loaded')
        throw new Error('Restored tab bindings are unavailable');
      return Promise.all(
        tabs.map((tab) => {
          const current = response.state.browsers.find(
            (value) => value.id === tab.id,
          );
          if (!current?.profile)
            throw new Error('Restored tab generation is unavailable');
          return window.api.browser.create({
            browserId: tab.id,
            projectId: tab.projectId,
            worktreeId: tab.worktreeId,
            expectedRuntimeGeneration: current.profile.runtimeGeneration,
          });
        }),
      );
    }, tabs);
    return readJob(job.jobId);
  };
  await app.closeSettings();
  // The local service worker writes independently of page JavaScript. Clearing
  // must quiesce it and every shared view before validating empty storage.
  const seedWriters = async () =>
    electronApp.evaluate(async ({ webContents }, fixtureUrl) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === `${fixtureUrl}?data=0`);
      await contents.executeJavaScript(
        `(async()=>{localStorage.setItem('writer','1');setInterval(()=>localStorage.setItem('writer',String(Date.now())),10);await navigator.serviceWorker.register('/profile-worker.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));navigator.serviceWorker.controller.postMessage('write');})()`,
      );
    }, fixtureUrl);
  await seedWriters();
  let pendingRequests = 0;
  let closedRequests = 0;
  const requests = createServer((request, response) => {
    pendingRequests++;
    response.on('close', () => closedRequests++);
    response.writeHead(
      200,
      request.url === '/download'
        ? {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition':
              'attachment; filename="benchmark-download.txt"',
            'Content-Length': '65536',
          }
        : { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' },
    );
    response.write('synthetic'.repeat(2048));
  });
  await new Promise((resolve) => requests.listen(0, '127.0.0.1', resolve));
  try {
    const pendingOrigin = `http://127.0.0.1:${requests.address().port}`;
    await electronApp.evaluate(
      ({ webContents }, { fixtureUrl, pendingOrigin, userDataDir }) => {
        const contents = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === `${fixtureUrl}?data=0`);
        contents.session.once('will-download', (_event, item) =>
          item.setSavePath(`${userDataDir}/benchmark-user-download.txt`),
        );
        contents.downloadURL(`${pendingOrigin}/download`);
        void contents.executeJavaScript(
          `void fetch(${JSON.stringify(pendingOrigin + '/pending')}).catch(()=>{})`,
        );
      },
      { fixtureUrl, pendingOrigin, userDataDir },
    );
    await expect.poll(() => pendingRequests).toBe(2);
    await expect
      .poll(async () =>
        (
          await page.evaluate(
            (profileId) => window.api.browser.profiles.jobList({ profileId }),
            profile.profileId,
          )
        ).jobs.some(
          (job) => job.kind === 'download' && job.status === 'running',
        ),
      )
      .toBe(true);
    await task('shared_20_cache_clear', () => clear('cache'));
    await expect.poll(() => closedRequests).toBe(2);
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (profileId) => window.api.browser.profiles.jobList({ profileId }),
              profile.profileId,
            )
          ).jobs.find((job) => job.kind === 'download')?.status,
      )
      .toBe('cancelled');
  } finally {
    requests.closeAllConnections();
    await new Promise((resolve) => requests.close(resolve));
  }
  await seedWriters();
  await task('shared_20_site_clear', () => clear('site'));
  await seedWriters();
  const reset = await task('shared_20_reset', () => clear('reset'));
  assert.equal(reset.newStorageGeneration, 2);
  const snapshotResources = () =>
    electronApp.evaluate(({ app, webContents }, fixtureUrl) => {
      const metrics = app.getAppMetrics();
      return {
        fixtureViews: webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL().startsWith(fixtureUrl))
          .length,
        processCount: metrics.length,
        workingSetMiB: metrics.reduce(
          (sum, metric) => sum + metric.memory.workingSetSize / 1024,
          0,
        ),
      };
    }, fixtureUrl);
  const resourcesBeforeOwners = await snapshotResources();
  const retiredProfiles = [];
  const owners = [];
  for (let batch = 0; batch < 100; batch += 4)
    await Promise.all(
      Array.from({ length: 4 }, async (_, offset) => {
        const index = batch + offset;
        const created = await page.evaluate(
          (projectId) =>
            window.api.workEntries.create({
              projectId,
              title: 'Retirement benchmark',
            }),
          coworkProjectId,
        );
        const entry = created.entry ?? created;
        assert.equal(typeof entry.id, 'string');
        const tab = await page.evaluate(
          (request) => window.api.browser.create(request),
          {
            projectId: coworkProjectId,
            worktreeId: entry.id,
            ...(index % 2
              ? { selection: { kind: 'named', profileId: profile.profileId } }
              : {}),
            url: `${fixtureUrl}?retirement=${index}`,
          },
        );
        owners.push(entry.id);
        if (index % 2 === 0)
          retiredProfiles.push(tab.profile.resolvedProfileId);
        // Keep every saved binding, with four live views spread through the batch.
        if (index % 25 !== 0)
          await page.evaluate(
            (browserId) => window.api.browser.disposeLiveView({ browserId }),
            tab.id,
          );
        if (index === 0) {
          await expect
            .poll(() =>
              electronApp.evaluate(
                ({ webContents }, url) =>
                  webContents
                    .getAllWebContents()
                    .some(
                      (c) =>
                        c.getURL() === url &&
                        c.getTitle() === 'Profile benchmark ready',
                    ),
                `${fixtureUrl}?retirement=0`,
              ),
            )
            .toBe(true);
          await electronApp.evaluate(async ({ webContents }, url) => {
            const contents = webContents
              .getAllWebContents()
              .find((c) => c.getURL() === url);
            await contents.executeJavaScript(
              "(async()=>{await navigator.serviceWorker.register('/profile-worker.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));navigator.serviceWorker.controller.postMessage('write');})()",
            );
          }, `${fixtureUrl}?retirement=0`);
        }
      }),
    );
  const resourcesWithOwners = await snapshotResources();
  assert.equal(
    resourcesWithOwners.fixtureViews,
    resourcesBeforeOwners.fixtureViews + 4,
  );
  const retirements = [];
  for (const entryId of owners)
    retirements.push(
      await task('owner_retirement_acknowledged', () =>
        page.evaluate((request) => window.api.workEntries.delete(request), {
          projectId: coworkProjectId,
          entryId,
        }),
      ),
    );
  const cleanup = await page.evaluate(() =>
    window.api.browser.profiles.cleanupStatus(),
  );
  const retained = await page.evaluate(
    (profileId) => window.api.browser.profiles.get({ profileId }),
    profile.profileId,
  );
  assert.equal(retained.storageGeneration, 2);
  for (const profileId of retiredProfiles)
    await expect(
      page.evaluate(
        (profileId) => window.api.browser.profiles.get({ profileId }),
        profileId,
      ),
    ).rejects.toThrow();
  await task('retirement_cleanup_retry_acknowledged', () =>
    page.evaluate(() => window.api.browser.profiles.retryCleanup()),
  );
  const resourcesAfterRetirement = await snapshotResources();
  assert.equal(
    resourcesAfterRetirement.fixtureViews,
    resourcesBeforeOwners.fixtureViews,
  );
  return {
    workloadSha256: createHash('sha256')
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest('hex'),
    pendingRequests,
    closedRequests,
    logicalBytes,
    inventoryFiles: 10000,
    sharedTabs: 20,
    retirementOwners: owners.length,
    savedRetirementBindings: 100,
    liveRetirementViews: 4,
    retiredTaskProfiles: retiredProfiles.length,
    namedProfileRetained: true,
    pendingCleanup: cleanup.jobs,
    retirementResults: retirements,
    retirementResources: {
      before: resourcesBeforeOwners,
      withOwners: resourcesWithOwners,
      after: resourcesAfterRetirement,
    },
  };
}

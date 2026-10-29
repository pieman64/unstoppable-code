import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setEarlyAccess } from './helpers/earlyAccess.mjs';
import {
  writeJson,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
  getScenarioActivity,
} from './seeders/index.mjs';

/**
 * Labs experiments (Settings → Labs, CAN-3662).
 *
 * An E2E-only fixture experiment owns the Plugins page and its sidebar
 * entry (seeded into More; the registry owns Audit Trail since
 * CAN-3678). Early access gates it: while Early access is off the fixture is not
 * listed and its page is refused. Under the `offered` rollout, opting in
 * exposes the page; opting out removes it and moves an open page to New task.
 * A `hidden` rollout hides it without deleting the stored choice.
 */

const FIXTURE_ID = 'plugins-fixture';

function fixtureEnv(availability) {
  return {
    CANOPY_E2E_LABS_EXPERIMENTS: JSON.stringify([
      {
        id: FIXTURE_ID,
        name: 'Plugins preview',
        description: 'Review what agents did in one place.',
        pages: ['plugins'],
        sidebarKeys: ['plugins'],
        flagKey: 'canopy-e2e-labs-plugins-fixture',
        fixtureAvailability: availability,
      },
    ]),
  };
}

function choicesPath(userDataDir) {
  return path.join(userDataDir, 'labs-experiments', 'choices.json');
}

function readLocalChoices(userDataDir) {
  const filePath = choicesPath(userDataDir);
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, 'utf8')).accounts?.local ?? {};
}

function readFixtureState(window) {
  return window.evaluate(async (id) => {
    const snapshot = await window.api.experiments.getSnapshot();
    const entry = snapshot.experiments.find((item) => item.id === id);
    return entry
      ? { listed: entry.listed, enabled: entry.enabled, choice: entry.choice }
      : null;
  }, FIXTURE_ID);
}

async function expectFixtureInMore(window, present) {
  await window.getByTestId('sidebar-more').click();
  await expect(window.getByTestId('sidebar-more-item-plugins')).toHaveCount(
    present ? 1 : 0,
  );
  await window.keyboard.press('Escape');
}

async function expectFixturePage(window) {
  await expect(window.getByTestId('page-plugins')).toBeVisible();
}

async function launch(userDataDir, availability) {
  const freshLayout =
    !userDataDir || !existsSync(path.join(userDataDir, 'preferences.json'));
  const launched = await launchCanopy({
    ...(userDataDir ? { userDataDir } : {}),
    env: fixtureEnv(availability),
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  if (freshLayout) {
    // Customize after startup migrations. Keep the fixture in More until the
    // order-retention test moves it, and preserve the saved layout on restart.
    await window.evaluate(async () => {
      const preferences = await window.api.loadPreferences();
      const order = preferences.sidebarNavLayout.order.filter(
        (key) => key !== 'plugins',
      );
      await window.api.savePreferences({
        sidebarNavLayout: {
          order: [...order, 'plugins'],
          moreStartIndex: order.length,
        },
      });
    });
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
  }
  return { ...launched, window, app };
}

test('Early access gates an offered experiment that owns a page', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await launch(
    null,
    'offered',
  );
  try {
    // Early access off: the fixture is neither listed nor reachable.
    await expectFixtureInMore(window, false);
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(
      window.getByTestId('experimental-features-toggle'),
    ).toHaveCount(0);
    const fixtureRow = window.getByTestId(`labs-experiment-row-${FIXTURE_ID}`);
    await expect(fixtureRow).toHaveCount(0);

    // Early access on lists the offered fixture, still off.
    expect(await setEarlyAccess(window, true)).toBe(true);
    await expect(fixtureRow).toBeVisible();
    const fixtureToggle = window.getByTestId(
      `labs-experiment-toggle-${FIXTURE_ID}`,
    );
    await expect(fixtureToggle).toHaveAttribute('aria-checked', 'false');
    await expect(fixtureToggle).toHaveAccessibleName('Plugins preview');

    // Opting in stores the choice and exposes the page.
    await fixtureToggle.click();
    await expect(fixtureToggle).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() => readLocalChoices(userDataDir)[FIXTURE_ID])
      .toBe(true);
    await app.closeSettings();
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-plugins').click();
    await expectFixturePage(window);

    // Opting out while the page is open moves to New task.
    expect(await readFixtureState(window)).toMatchObject({ enabled: true });
    await window.evaluate(
      (id) =>
        window.api.experiments.setChoice({ experimentId: id, enabled: false }),
      FIXTURE_ID,
    );
    await expect(window.getByTestId('page-plugins')).toHaveCount(0);
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expectFixtureInMore(window, false);

    // Early access off withdraws an opted-in experiment too.
    await window.evaluate(
      (id) =>
        window.api.experiments.setChoice({ experimentId: id, enabled: true }),
      FIXTURE_ID,
    );
    await expectFixtureInMore(window, true);
    expect(await setEarlyAccess(window, false)).toBe(false);
    expect(await readFixtureState(window)).toEqual({
      listed: false,
      enabled: false,
      choice: true,
    });
    await expectFixtureInMore(window, false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a hidden rollout keeps the stored choice for a later offered rollout', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-labs-'));
  writeJson(choicesPath(userDataDir), {
    version: 1,
    accounts: { local: { 'early-access': true, [FIXTURE_ID]: true } },
  });

  const hidden = await launch(userDataDir, 'hidden');
  try {
    expect(await readFixtureState(hidden.window)).toEqual({
      listed: false,
      enabled: false,
      choice: true,
    });
    await expectFixtureInMore(hidden.window, false);
    await hidden.app.openSettings();
    await hidden.app.openSettingsSection('experiments');
    await expect(
      hidden.window.getByTestId(`labs-experiment-row-${FIXTURE_ID}`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(hidden.electronApp, userDataDir, { keepUserData: true });
  }
  expect(readLocalChoices(userDataDir)[FIXTURE_ID]).toBe(true);

  const offered = await launch(userDataDir, 'offered');
  try {
    expect(await readFixtureState(offered.window)).toEqual({
      listed: true,
      enabled: true,
      choice: true,
    });
    await expectFixtureInMore(offered.window, true);
  } finally {
    await closeCanopy(offered.electronApp, userDataDir);
  }
});

test('an on rollout respects explicit opt-out and sidebar order survives prerequisite off/on', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await launch(null, 'on');
  try {
    await setEarlyAccess(window, true);
    expect(await readFixtureState(window)).toMatchObject({
      enabled: true,
      choice: null,
    });
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-customize').click();
    const modal = window.getByTestId('customize-sidebar-modal');
    const source = await modal
      .getByTestId('customize-sidebar-row-plugins')
      .boundingBox();
    const target = await modal
      .getByTestId('customize-sidebar-more-divider')
      .boundingBox();
    if (!source || !target)
      throw new Error('Expected Plugins and More divider geometry.');
    await window.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(source.x + source.width / 2, source.y - 15, {
      steps: 10,
    });
    await window.mouse.move(target.x + target.width / 2, target.y - 5, {
      steps: 20,
    });
    await window.mouse.up();
    await window.waitForTimeout(300);
    await modal.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();
    await expect(window.getByTestId('sidebar-nav-plugins')).toBeVisible();
    // The sidebar updates before its asynchronous preferences save finishes.
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const layout = (await window.api.loadPreferences()).sidebarNavLayout;
          return layout.order
            .slice(0, layout.moreStartIndex)
            .includes('plugins');
        }),
      )
      .toBe(true);
    const savedLayout = await window.evaluate(
      async () => (await window.api.loadPreferences()).sidebarNavLayout,
    );
    await window.evaluate(
      (id) =>
        window.api.experiments.setChoice({ experimentId: id, enabled: false }),
      FIXTURE_ID,
    );
    expect(await readFixtureState(window)).toMatchObject({
      enabled: false,
      choice: false,
    });
    await expect(window.getByTestId('sidebar-nav-plugins')).toHaveCount(0);
    await setEarlyAccess(window, false);
    await setEarlyAccess(window, true);
    expect(await readFixtureState(window)).toMatchObject({
      enabled: false,
      choice: false,
    });
    await window.evaluate(
      (id) =>
        window.api.experiments.setChoice({ experimentId: id, enabled: true }),
      FIXTURE_ID,
    );
    await expect(window.getByTestId('sidebar-nav-plugins')).toBeVisible();
    await window.getByTestId('sidebar-nav-plugins').click();
    await expectFixturePage(window);
    await setEarlyAccess(window, false);
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(window.getByTestId('sidebar-nav-plugins')).toHaveCount(0);
    await setEarlyAccess(window, true);
    await expect(window.getByTestId('sidebar-nav-plugins')).toBeVisible();
    expect(
      await window.evaluate(
        async () => (await window.api.loadPreferences()).sidebarNavLayout,
      ),
    ).toEqual(savedLayout);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the main window and embedded Advisor receive the same ordered Labs pushes', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch(null, 'offered');
  try {
    await setEarlyAccess(window, true);
    await window.getByTestId('sidebar-nav-app-advisor').click();
    let advisor;
    await expect
      .poll(async () => {
        advisor = electronApp
          .windows()
          .find((page) => page.url().includes('surface=app-advisor'));
        return !!advisor;
      })
      .toBe(true);
    await expect(
      advisor.getByTestId('app-advisor-workspace-surface'),
    ).toBeVisible();
    for (const page of [window, advisor])
      await page.evaluate(() => {
        window.__labsAuditPushes = [];
        window.api.experiments.onSnapshotChanged((snapshot) =>
          window.__labsAuditPushes.push(snapshot),
        );
      });
    await setEarlyAccess(window, false);
    for (const page of [window, advisor])
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__labsAuditPushes.at(-1)?.earlyAccessEnabled,
          ),
        )
        .toBe(false);
    await setEarlyAccess(advisor, true);
    await expect
      .poll(() =>
        window.evaluate(
          () => window.__labsAuditPushes.at(-1)?.earlyAccessEnabled,
        ),
      )
      .toBe(true);
    const pushes = await Promise.all(
      [window, advisor].map((page) =>
        page.evaluate(() => window.__labsAuditPushes),
      ),
    );
    expect(pushes[0]).toEqual(pushes[1]);
    expect(
      pushes[0].every(
        (snapshot, index, list) =>
          index === 0 || snapshot.revision > list[index - 1].revision,
      ),
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('signed-in PUT choices stay account-isolated and survive a failed GET on restart', async () => {
  test.setTimeout(180_000);
  const accountA = 'csk_can3662-labs-account-a';
  const accountB = 'csk_can3662-labs-account-b';
  await registerScenario(DEFAULT_MOCK_BASE_URL, accountA, {
    cloud: {
      account: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      experiments: { choices: { 'early-access': true } },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, accountB, {
    cloud: {
      account: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      experiments: { choices: {} },
    },
  });
  const first = await launch(null, 'offered');
  const { userDataDir } = first;
  try {
    await connectMockCloudAccount(first.window, accountA);
    await expect
      .poll(() =>
        first.window.evaluate(
          async () =>
            (await window.api.experiments.getSnapshot()).earlyAccessEnabled,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        first.window.evaluate(async () =>
          (await window.api.experiments.getSnapshot()).experiments.find(
            (entry) => entry.id === 'sidebar',
          ),
        ),
      )
      .toMatchObject({ choice: true, enabled: true });
    await first.app.openSettings();
    await first.app.openSettingsSection('experiments');
    await first.window
      .getByTestId(`labs-experiment-toggle-${FIXTURE_ID}`)
      .click();
    await expect(
      first.window.getByTestId(`labs-experiment-toggle-${FIXTURE_ID}`),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, accountA)).activity
        .experimentChoicesPut,
    ).toBe(1);
    await first.app.closeSettings();
    await first.window.getByTestId('sidebar-more').click();
    await first.window.getByTestId('sidebar-more-item-plugins').click();
    await expectFixturePage(first.window);
    await connectMockCloudAccount(first.window, accountB);
    await expect
      .poll(() =>
        first.window.evaluate(async () =>
          (await window.api.experiments.getSnapshot()).experiments.find(
            (entry) => entry.id === 'sidebar',
          ),
        ),
      )
      .toMatchObject({ choice: false, enabled: false });
    await expect(first.window.getByTestId('page-home')).toBeVisible();
    await expect
      .poll(() => readFixtureState(first.window))
      .toMatchObject({ listed: false, enabled: false, choice: null });
    await connectMockCloudAccount(first.window, accountA);
    await expect
      .poll(() => readFixtureState(first.window))
      .toMatchObject({ enabled: true, choice: true });
    expect(readLocalChoices(userDataDir)[FIXTURE_ID]).toBeUndefined();
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }
  await registerScenario(DEFAULT_MOCK_BASE_URL, accountA, {
    cloud: {
      account: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      experiments: { getStatus: 503, choices: {} },
    },
  });
  const restarted = await launch(userDataDir, 'offered');
  try {
    await expect
      .poll(() =>
        restarted.window.evaluate(
          async () => (await window.api.experiments.getSnapshot()).choicesReady,
        ),
      )
      .toBe(true);
    expect(await readFixtureState(restarted.window)).toMatchObject({
      enabled: true,
      choice: true,
    });
    await expectFixtureInMore(restarted.window, true);
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, accountA)).activity
        .experimentChoicesPut ?? 0,
    ).toBe(0);
  } finally {
    await closeCanopy(restarted.electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, accountA);
    await clearScenario(DEFAULT_MOCK_BASE_URL, accountB);
  }
});

// Exercise the real SDK and IPC path after a reconnect failure. The fixture
// controls only LaunchDarkly HTTP/stream responses; effective state stays main-owned.
test('a failed same-context refresh retains navigation and a recovered live kill switch removes it', async () => {
  test.setTimeout(120_000);
  const accountKey = 'csk_can3662-same-account-refresh';
  await registerScenario(DEFAULT_MOCK_BASE_URL, accountKey, {
    cloud: {
      account: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      experiments: { choices: { 'early-access': true } },
    },
  });
  const streams = new Set();
  let healthy = true;
  let earlyAccess = 'on';
  let version = 1;
  const flags = () =>
    Object.fromEntries(
      Object.entries({
        'canopy-desktop-labs-early-access': earlyAccess,
        'canopy-cloud-sign-in-required': false,
        'canopy-guest-mode-enabled': false,
        'canopy-ledger-enabled': true,
        'canopy-portal-enabled': true,
      }).map(([key, value]) => [key, { value, version, variation: 0 }]),
    );
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/sdk/evalx/')) {
      response.writeHead(healthy ? 200 : 503, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(healthy ? flags() : {}));
    } else if (request.url?.startsWith('/eval/')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(':\n\n');
      streams.add(response);
      response.on('close', () => streams.delete(response));
    } else {
      request.resume();
      response.writeHead(202);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { electronApp, userDataDir, window, app } = await launch(null, 'on');
  try {
    await connectMockCloudAccount(window, accountKey);
    await electronApp.evaluate((_electron, url) => {
      process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'e2e-client-side-id';
      process.env.CANOPY_E2E_LAUNCHDARKLY_BASE_URL = url;
    }, baseUrl);
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    await expect
      .poll(() => readFixtureState(window))
      .toMatchObject({ enabled: true });
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-plugins').click();
    await expectFixturePage(window);
    await window.evaluate(() => {
      window.__refreshFlagSnapshots = [];
      window.api.featureFlags.onSnapshotChanged((snapshot) =>
        window.__refreshFlagSnapshots.push(snapshot),
      );
    });
    await app.openSettings();
    await app.openSettingsSection('privacy');
    await window.evaluate(() =>
      window.api.refreshCanopyCloudEnforcedSettings(),
    );
    await app.closeSettings();
    await expectFixturePage(window);
    expect(
      await window.evaluate(() =>
        window.__refreshFlagSnapshots.every(
          (snapshot) =>
            snapshot.values['canopy-desktop-labs-early-access'] === 'on',
        ),
      ),
    ).toBe(true);
    healthy = false;
    const failed = await window.evaluate(() =>
      window.api.featureFlags.refreshContext(),
    );
    expect(failed.status).toBe('error');
    const snapshots = await window.evaluate(
      () => window.__refreshFlagSnapshots,
    );
    expect(snapshots.length).toBeGreaterThan(0);
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.values['canopy-desktop-labs-early-access'] === 'on',
      ),
    ).toBe(true);
    await expectFixturePage(window);
    healthy = true;
    earlyAccess = 'hidden';
    version++;
    await expect.poll(() => streams.size).toBeGreaterThan(0);
    for (const stream of streams)
      stream.write(`event: put\ndata: ${JSON.stringify(flags())}\n\n`);
    await expect
      .poll(() => readFixtureState(window))
      .toMatchObject({ listed: false, enabled: false });
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expectFixtureInMore(window, false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await clearScenario(DEFAULT_MOCK_BASE_URL, accountKey);
  }
});

test('a cold account save returns its extracted choice before the initial GET finishes', async () => {
  const key = 'csk_labs-cold-extraction';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      account: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      experiments: { choices: { 'early-access': true }, getDelayMs: 3000 },
    },
  });
  const launched = await launch(null, 'offered');
  try {
    await connectMockCloudAccount(launched.window, key);
    await expect
      .poll(() =>
        launched.window.evaluate(
          async () => (await window.api.experiments.getSnapshot()).ready,
        ),
      )
      .toBe(true);
    await launched.window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    const snapshot = await launched.window.evaluate(() =>
      window.api.experiments.getSnapshot(),
    );
    expect(snapshot.earlyAccessEnabled).toBe(false);
    expect(
      snapshot.experiments.find((entry) => entry.id === 'sidebar'),
    ).toMatchObject({ choice: true, enabled: true });
    await expect
      .poll(() =>
        launched.window.evaluate(
          async () =>
            (await window.api.experiments.getSnapshot()).experiments.find(
              (entry) => entry.id === 'sidebar',
            )?.choice,
        ),
      )
      .toBe(true);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});

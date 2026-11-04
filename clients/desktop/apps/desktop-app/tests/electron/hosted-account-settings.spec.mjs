import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  readHostedSettingsRequests,
  registerHostedSettingsScenario,
} from './seeders/index.mjs';
import {
  HOSTED_SETTINGS_FACT_ID,
  HOSTED_SETTINGS_ORG_IDS,
  HOSTED_SETTINGS_VIEWER,
} from './seeders/hostedSettingsCloud.mjs';
import { defaultHostedSettingsOrganizations } from './mock-server/routes/hosted-settings-fixtures.mjs';
import {
  chooseSettingsScope,
  openOrganizationsList,
} from './hostedSettingsLocators.mjs';

/**
 * Hosted account and organization settings in the desktop Settings overlay
 * (CAN-4386), driven through the real settings bridge against the mock
 * cloud's `hosted-settings` scenarios.
 *
 * Covers the rail contract (CAN-4421: the local app group, then the hosted
 * Account group, then Organizations, then the remaining local groups; one
 * selected row; the organization group only once an organization is picked) and the host states a hosted page shows before its content
 * (unsupported server, signed out). Page bodies are the shared web pages and
 * are covered by their own suites. Payment CTAs hand off to the browser: the
 * E2E build posts each opened URL to a local receiver instead of calling
 * `shell.openExternal`.
 */

/** The local groups without hosted settings; ids and order must not change. */
const LOCAL_GROUP_IDS = [
  'settings-nav-group-personal',
  'settings-nav-group-agents',
  'settings-nav-group-integrations',
  'settings-nav-group-workflow',
  'settings-nav-group-advanced',
];
/** Local rows in the hosted layout: ids stay, Accounts reads "Providers". */
const HOSTED_LAYOUT_LOCAL_ROWS = [
  ['settings-nav-canopy', 'General'],
  ['settings-nav-account', 'Providers'],
  ['settings-nav-privacy', 'Privacy'],
  ['settings-nav-git', 'Git'],
  ['settings-nav-legal', 'Legal'],
];

async function launchSignedIn(
  apiKey,
  scenarioName,
  env = undefined,
  scenarioOptions = undefined,
) {
  await registerHostedSettingsScenario(apiKey, scenarioName, scenarioOptions);
  const { electronApp, userDataDir } = await launchCanopy(
    env === undefined ? undefined : { env },
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await connectMockCloudAccount(window, apiKey);
  return { app, electronApp, userDataDir, window };
}

/** Local receiver standing in for the host browser. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

/** Return paths the payment handoff minted magic links for, under `prefix`. */
async function mintedBillingPaths(apiKey, prefix) {
  const log = await readHostedSettingsRequests(apiKey);
  return log.requests
    .filter(
      (request) =>
        request.operation === 'auth-link.mint' &&
        typeof request.body?.redirectPath === 'string' &&
        request.body.redirectPath.startsWith(prefix),
    )
    .map((request) => new URL(request.body.redirectPath, 'https://web.test'));
}

const CONSUME_URL = /\/api\/v1\/[^/]+\/auth-link\/consume\?code=hs-/;

/** Rail group test ids in DOM order. */
async function railGroupIds(window) {
  return window
    .getByTestId('settings-sidebar')
    .locator('[data-testid^="settings-nav-group-"]')
    .evaluateAll((groups) => groups.map((group) => group.dataset.testid));
}

/** Rail rows marked current: hosted rows by `aria-current`, local by class. */
async function selectedRailRows(window) {
  return window
    .getByTestId('settings-sidebar')
    .locator('[data-sidebar-nav-row]')
    .evaluateAll((rows) =>
      rows
        .filter(
          (row) =>
            row.getAttribute('aria-current') === 'page' ||
            row.className.split(/\s+/).includes('bg-muted'),
        )
        .map((row) => row.dataset.testid),
    );
}

test('the scope picker and the hosted Account rows lead the rail, and picking an organization switches the scope', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_rail';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
  );
  try {
    await app.openSettings();

    // Opening Settings normally still opens General, and only General is
    // selected.
    await app.expectSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-nav-group-account'),
    ).toBeVisible();
    expect(await railGroupIds(window)).toEqual([
      'settings-nav-group-account',
      'settings-nav-group-personal',
      'settings-nav-group-agents',
      'settings-nav-group-integrations',
      'settings-nav-group-workflow',
      'settings-nav-group-advanced',
    ]);
    for (const [testId, label] of HOSTED_LAYOUT_LOCAL_ROWS) {
      await expect(window.getByTestId(testId)).toHaveText(label);
    }
    // Hosted Notifications replaces the local row.
    await expect(window.getByTestId('settings-nav-notifications')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('settings-nav-account-account')).toHaveText(
      'Account',
    );
    // Account Labs is web's; desktop keeps Labs in its own section.
    await expect(window.getByTestId('settings-nav-account-labs')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('settings-nav-experiments')).toBeVisible();
    expect(await selectedRailRows(window)).toEqual(['settings-nav-canopy']);
    // No organization is preselected from the workspace context: the rail
    // opens on the account scope.
    await expect(
      window.getByTestId('settings-nav-group-organization'),
    ).toHaveCount(0);
    await expect(window.getByTestId('settings-nav-scope-picker')).toContainText(
      'Personal account',
    );

    // The Organizations list opens from the scope menu; no rail row stands
    // for it, and the rail keeps the account scope.
    await chooseSettingsScope(window, 'all-organizations');
    const content = window.getByTestId('hosted-settings-content');
    await expect(content).toHaveAttribute(
      'data-hosted-settings-page',
      'organizations/list',
    );
    expect(await selectedRailRows(window)).toEqual([]);
    await expect(
      window.getByTestId('settings-nav-group-organization'),
    ).toHaveCount(0);

    // CAN-4558 B: one "Organizations" heading (the shared page header, with
    // "New organization" in its actions), and the Personal organization is
    // not listed, as production's `organization.list` never returns it.
    await expect(
      content.getByRole('heading', { name: 'Organizations', exact: true }),
    ).toHaveCount(1);
    await expect(content.getByTestId('page-header-title')).toHaveText(
      'Organizations',
    );
    await expect(
      content
        .getByTestId('page-header-actions')
        .getByTestId('team-panel-create'),
    ).toHaveText('New organization');
    const organizationRows = content.getByTestId('team-panel-org');
    await expect(organizationRows).toHaveCount(3);
    await expect(
      organizationRows.filter({ hasText: HOSTED_SETTINGS_VIEWER.name }),
    ).toHaveCount(0);

    // Picking an organization opens its Timeline and switches the rail to
    // its scope.
    await content
      .getByTestId('team-panel-org')
      .filter({ hasText: 'Northwind Labs' })
      .first()
      .click();
    await expect(window.getByTestId('settings-nav-scope-title')).toHaveText(
      'Northwind Labs',
    );
    await expect(
      window.getByTestId('settings-nav-group-organization'),
    ).toBeVisible();
    await expect(window.getByTestId('settings-nav-group-account')).toHaveCount(
      0,
    );
    await expect(content).toHaveAttribute(
      'data-hosted-settings-page',
      'organization/feed',
    );
    await expect(
      window.getByTestId('settings-nav-organization-feed'),
    ).toHaveAttribute('aria-current', 'page');
    expect(await selectedRailRows(window)).toEqual([
      'settings-nav-organization-feed',
    ]);
    // CAN-4519: the organization page is Timeline, in the rail and header.
    await expect(
      window.getByTestId('settings-nav-organization-feed'),
    ).toContainText('Timeline');
    await expect(
      content.getByRole('heading', { name: 'Timeline', exact: true, level: 1 }),
    ).toBeVisible();
    // The page draws no switcher of its own: the rail's scope picker is it.
    await expect(content.getByTestId('team-org-switcher')).toHaveCount(0);

    // The organization's Settings pages are rail rows of their own.
    await window
      .getByTestId('settings-nav-organization-settings-policies')
      .click();
    await expect(content.getByTestId('page-header-title')).toHaveText(
      'Policies',
    );
    expect(await selectedRailRows(window)).toEqual([
      'settings-nav-organization-settings-policies',
    ]);
    await expect(content.getByTestId('team-settings-tabs')).toHaveCount(0);

    // App-wide pages belong to Personal, outside the organization's scope.
    await chooseSettingsScope(window, 'account');
    await app.openSettingsSection('git');
    await expect(content).toHaveCount(0);
    expect(await selectedRailRows(window)).toEqual(['settings-nav-git']);

    // Hosted reads went through the bridge for the organization the user
    // picked, never through a financial route.
    const log = await readHostedSettingsRequests(apiKey);
    const operations = log.requests.map((request) => request.operation);
    expect(operations).toContain('settings.bootstrap');
    expect(
      log.requests.some(
        (request) =>
          request.operation === 'settings.bootstrap' &&
          request.path.includes(HOSTED_SETTINGS_ORG_IDS.owner),
      ),
    ).toBe(true);
    expect(log.requests.filter((request) => request.financial)).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the scope picker switches between the account and an organization, keeping Billing', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_scope_picker';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
  );
  try {
    await app.openSettings();
    const content = window.getByTestId('hosted-settings-content');
    await app.openAccountSettingsPage('billing');

    // The menu lists your account and each organization with your role; the
    // Personal organization is the account itself.
    await window.getByTestId('settings-nav-scope-picker').click();
    const menu = window.getByTestId('settings-nav-scope-menu');
    await expect(menu).toBeVisible();
    await expect(
      menu.getByTestId('settings-nav-scope-option-account'),
    ).toHaveAttribute('aria-checked', 'true');
    // Your account, the three organizations and All organizations.
    await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
    await expect(
      menu.getByTestId(
        `settings-nav-scope-option-${HOSTED_SETTINGS_ORG_IDS.owner}`,
      ),
    ).toContainText('Owner');

    // Billing stays on Billing: the organization's Billing page.
    await menu
      .getByTestId(`settings-nav-scope-option-${HOSTED_SETTINGS_ORG_IDS.owner}`)
      .click();
    await expect(content).toHaveAttribute(
      'data-hosted-settings-page',
      'organization/settings',
    );
    await expect(content.getByTestId('page-header-title')).toHaveText(
      'Billing',
    );
    await expect(window.getByTestId('settings-nav-scope-title')).toHaveText(
      'Northwind Labs',
    );
    expect(await selectedRailRows(window)).toEqual([
      'settings-nav-organization-settings-billing',
    ]);
    await expect(window.getByTestId('settings-nav-display')).toHaveCount(0);
    await expect(window.getByTestId('settings-nav-account')).toHaveCount(0);
    // Back to the account, still on Billing.
    await chooseSettingsScope(window, 'account');
    await expect(window.getByTestId('settings-nav-display')).toBeVisible();
    await expect(content).toHaveAttribute(
      'data-hosted-settings-page',
      'account/billing',
    );
    expect(await selectedRailRows(window)).toEqual([
      'settings-nav-account-billing',
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('billing history lists card charges in the shared table', async () => {
  const apiKey = 'csk_hosted_account_settings_billing_history';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
  );
  try {
    await app.openSettings();
    await app.openAccountSettingsPage('billing');
    const history = window.getByTestId('billing-history');
    const table = history.getByRole('table', { name: 'Billing history' });
    await expect(table).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: 'Amount' }),
    ).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(
      table.getByTestId('billing-history-row-chg_mock_topup'),
    ).toContainText('AI credits top-up');
    await expect(
      table.getByTestId('billing-history-row-chg_mock_topup'),
    ).toContainText('$25.00');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the Timeline sharing hint saves in place instead of handing off to the desktop app', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_timeline_opt_in';
  // An organization policy read (with nothing enforced) makes the account
  // authoritative, so the desktop opt-in can offer the share.
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    undefined,
    { scenario: { cloud: { enforcedSettings: [] } } },
  );
  try {
    await app.openSettings();
    await openOrganizationsList(window);
    const content = window.getByTestId('hosted-settings-content');
    await content
      .getByTestId('team-panel-org')
      .filter({ hasText: 'Northwind Labs' })
      .first()
      .click();
    await expect(content).toHaveAttribute(
      'data-hosted-settings-page',
      'organization/feed',
    );

    // The desktop's inline hint: the full disclosure and a Share button that
    // saves here, never the web's "review this in the desktop app" handoff.
    const hint = content.getByTestId('data-sharing-opt-in-feed-activity');
    await expect(hint).toHaveAttribute('data-opt-in-state', 'offer');
    await expect(
      content.getByTestId('data-sharing-opt-in-feed-activity-summary'),
    ).toContainText(
      'Shares your work stats, plans, and work recaps with Northwind Labs',
    );
    await expect(hint).not.toContainText('desktop app');
    const enable = content.getByTestId(
      'data-sharing-opt-in-feed-activity-enable',
    );
    await expect(enable).toHaveText('Share with Northwind Labs');
    await expect(enable).not.toHaveAttribute('href', /.*/);

    await enable.click();
    await expect(hint).toHaveAttribute('data-opt-in-state', 'enabled');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('switching organization pages keeps a page header and loads under it', async () => {
  test.setTimeout(120_000);
  // Long enough that the next tab's placeholder shows (after 200 ms).
  const pageDataDelayMs = 900;
  const apiKey = 'csk_hosted_account_settings_org_tab_switch';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    undefined,
    {
      overrides: {
        operationDelaysMs: { 'settings.pageData': pageDataDelayMs },
      },
    },
  );
  try {
    await app.openSettings();
    await openOrganizationsList(window);
    await window
      .getByTestId('hosted-settings-content')
      .getByTestId('team-panel-org')
      .filter({ hasText: 'Northwind Labs' })
      .first()
      .click();
    const settingsContent = window.getByTestId('settings-content');
    await expect(
      window.locator(
        '[data-testid="hosted-settings-content"][data-hosted-settings-page="organization/feed"]',
      ),
    ).toBeVisible();
    await expect(window.getByTestId('settings-nav-scope-title')).toHaveText(
      'Northwind Labs',
    );

    // Record, on every DOM change, whether a page header is on screen and
    // whether the page-level loading state shows any copy.
    await window.evaluate(() => {
      const content = document.querySelector(
        '[data-testid="settings-content"]',
      );
      if (content === null) throw new Error('Settings content is not open');
      const state = { blockMissing: 0, loadingCopy: [], records: 0 };
      const record = () => {
        state.records += 1;
        if (content.querySelector('[data-testid="page-header"]') === null)
          state.blockMissing += 1;
        // Page-level loading only: panels inside a loaded page keep their
        // own loading states.
        const visibleText = Array.from(
          content.querySelectorAll(
            [
              '[data-testid="organization-settings-loading"] *:not(.sr-only)',
              '[data-testid="hosted-settings-route-loading"] *:not(.sr-only)',
            ].join(', '),
          ),
        )
          .flatMap((element) =>
            Array.from(element.childNodes).filter(
              (node) => node.nodeType === Node.TEXT_NODE,
            ),
          )
          .map((node) => node.textContent ?? '')
          .join(' ');
        const match = /Loading[^.]*…/.exec(visibleText);
        if (match !== null) state.loadingCopy.push(match[0]);
      };
      const observer = new MutationObserver(record);
      observer.observe(content, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      globalThis.__orgTabSwitchProbe = {
        state,
        stop: () => observer.disconnect(),
      };
      record();
    });

    await window.getByTestId('settings-nav-organization-members').click();

    // Past the delay the tab's placeholder shows: the Members page header
    // and the Members list skeleton, never loading copy. The rail keeps
    // naming the organization.
    const placeholder = settingsContent.getByTestId(
      'organization-settings-loading',
    );
    await expect(
      placeholder.locator(
        '[data-testid="delayed-loading-placeholder"][data-visible="true"] [data-testid="settings-skeleton-list"]',
      ),
    ).toBeVisible();
    await expect(
      placeholder.getByTestId('centered-loading-spinner'),
    ).toHaveCount(0);
    await expect(window.getByTestId('settings-nav-scope-title')).toHaveText(
      'Northwind Labs',
    );
    await expect(placeholder.getByTestId('page-header-title')).toHaveText(
      'Members',
    );

    // Then the page replaces it.
    const members = window.locator(
      '[data-testid="hosted-settings-content"][data-hosted-settings-page="organization/members"]',
    );
    await expect(placeholder).toHaveCount(0);
    await expect(members.getByTestId('page-header-title')).toHaveText(
      'Members',
    );
    await expect(members.getByTestId('team-overview-section')).toHaveCount(0);

    const probe = await window.evaluate(() => {
      const { state, stop } = globalThis.__orgTabSwitchProbe;
      stop();
      return state;
    });
    expect(probe.records).toBeGreaterThan(1);
    expect(probe.blockMissing).toBe(0);
    expect(probe.loadingCopy).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an account page loads under its header with the page’s skeleton', async () => {
  test.setTimeout(120_000);
  // Long enough that the skeleton shows (after 200 ms).
  const pageDataDelayMs = 900;
  const apiKey = 'csk_hosted_account_settings_account_skeleton';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    undefined,
    {
      overrides: {
        operationDelaysMs: { 'settings.pageData': pageDataDelayMs },
      },
    },
  );
  try {
    await app.openSettings();
    await window.getByTestId('settings-nav-account-digests').click();

    // While the page data loads: the account frame with the Digests header,
    // and the Digests cards skeleton as its body. No loading copy.
    const page = window.locator(
      '[data-hosted-settings-page="account/digests"]',
    );
    await expect(page.getByTestId('page-header-title')).toHaveText('Digests');
    await expect(
      page.locator(
        '[data-testid="account-settings-body"] [data-testid="delayed-loading-placeholder"][data-visible="true"] [data-testid="settings-skeleton-cards"]',
      ),
    ).toBeVisible();
    await expect(page).not.toContainText('Loading account settings');
    await expect(page.getByText(/Loading[^.]*…/)).toHaveCount(0);

    // Then the page replaces the skeleton under the same header.
    await expect(
      window.locator(
        '[data-testid="hosted-settings-content"][data-hosted-settings-page="account/digests"]',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('settings-skeleton-cards')).toHaveCount(0);
    await expect(page.getByTestId('page-header-title')).toHaveText('Digests');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a hosted page that could not load keeps its failure while Try again reads it again', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_try_again';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    undefined,
    {
      overrides: {
        // Every page read fails, slowly enough to see Try again spin.
        operationErrors: { 'settings.pageData': { status: 500 } },
        operationDelaysMs: { 'settings.pageData': 1_500 },
      },
    },
  );
  const pageReads = async () =>
    (await readHostedSettingsRequests(apiKey)).requests.filter(
      (request) => request.operation === 'settings.pageData',
    ).length;
  try {
    await app.openSettings();
    await window.getByTestId('settings-nav-account-digests').click();

    const failed = window.getByTestId('hosted-settings-failed');
    await expect(failed).toContainText(
      "Couldn't load these settings. Check your connection.",
    );
    await expect(failed).not.toContainText('Scripted failure');
    const retry = failed.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeEnabled();

    // The failure stays while the read runs; its capsule spins in place
    // instead of the page blanking to its skeleton.
    const readsBeforeRetry = await pageReads();
    await retry.click();
    const busy = failed.getByRole('button', { name: 'Trying again…' });
    await expect(busy).toBeVisible();
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(window.getByTestId('settings-skeleton-cards')).toHaveCount(0);
    await expect.poll(pageReads).toBeGreaterThan(readsBeforeRetry);

    // The read failed again: the same failure, ready for another try.
    await expect(
      failed.getByRole('button', { name: 'Try again' }),
    ).toBeEnabled();
    await expect(failed).toContainText("Couldn't load these settings.");
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** Opens Northwind Labs (the team the viewer owns) from the Organizations list. */
async function openOwnedOrganization(window) {
  await openOrganizationsList(window);
  await window
    .getByTestId('hosted-settings-content')
    .getByTestId('team-panel-org')
    .filter({ hasText: 'Northwind Labs' })
    .first()
    .click();
  await expect(
    window.locator(
      '[data-testid="hosted-settings-content"][data-hosted-settings-page="organization/feed"]',
    ),
  ).toBeVisible();
}

const MEMORY_PAGE =
  '[data-testid="hosted-settings-content"][data-hosted-settings-page="organization/memory"]';

/** Asserts which Memory view is selected. */
async function expectMemoryView(memory, view) {
  for (const key of ['facts', 'graph', 'ops']) {
    await expect(memory.getByTestId(`memory-views-tab-${key}`)).toHaveAttribute(
      'aria-selected',
      key === view ? 'true' : 'false',
    );
  }
}

test('organization memory renders under its page header, with its views below it', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_org_memory';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
  );
  try {
    await app.openSettings();
    await openOwnedOrganization(window);
    const memoryRow = window.getByTestId('settings-nav-organization-memory');
    const label = (await memoryRow.innerText()).trim();
    expect(label).toBe('Memory');
    await memoryRow.click();

    const memory = window.locator(MEMORY_PAGE);
    await expect(memory).toBeVisible();
    // The page header the other pages draw, with the rail naming the
    // organization; no way "back" to the organization the viewer is in.
    await expect(memory.getByTestId('team-overview-section')).toHaveCount(0);
    await expect(window.getByTestId('settings-nav-scope-title')).toHaveText(
      'Northwind Labs',
    );
    await expect(memory.getByTestId('page-header-title')).toHaveText(label);
    await expect(memory.getByText('← Organization')).toHaveCount(0);
    await expect(memory.getByTestId('memory-fact-back')).toHaveCount(0);
    await expectMemoryView(memory, 'facts');
    await expect(
      memory.getByTestId(`memory-fact-${HOSTED_SETTINGS_FACT_ID}`),
    ).toContainText('The build service deploys from main.');

    // The views switch under the same header.
    await memory.getByTestId('memory-views-tab-graph').click();
    await expectMemoryView(memory, 'graph');
    await expect(memory.getByTestId('page-header-title')).toHaveText(label);
    await expect(memory.getByTestId('memory-fact-back')).toHaveCount(0);

    await memory.getByTestId('memory-views-tab-ops').click();
    await expectMemoryView(memory, 'ops');
    await expect(memory).toContainText('fixture-embedder');
    await expect(memory.getByTestId('memory-fact-back')).toHaveCount(0);

    // A fact opened from Facts keeps Facts selected and leads with the way
    // back to the list.
    await memory.getByTestId('memory-views-tab-facts').click();
    await expectMemoryView(memory, 'facts');
    await memory.getByTestId(`memory-fact-${HOSTED_SETTINGS_FACT_ID}`).click();
    await window
      .getByRole('dialog', { name: 'Memory fact detail' })
      .getByRole('link', { name: 'View source' })
      .click();
    const back = memory.getByTestId('memory-fact-back');
    await expect(back).toHaveText('← Facts');
    await expectMemoryView(memory, 'facts');
    await expect(window.getByTestId('settings-nav-scope-title')).toHaveText(
      'Northwind Labs',
    );
    await back.click();
    await expect(
      memory.getByTestId(`memory-fact-${HOSTED_SETTINGS_FACT_ID}`),
    ).toBeVisible();
    await expect(memory.getByTestId('memory-fact-back')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an organization with no memory yet explains where facts come from and links to Policies', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_org_memory_empty';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    undefined,
    {
      overrides: {
        organizations: defaultHostedSettingsOrganizations().map((org) =>
          org.id === HOSTED_SETTINGS_ORG_IDS.owner
            ? { ...org, facts: [] }
            : org,
        ),
      },
    },
  );
  try {
    await app.openSettings();
    await openOwnedOrganization(window);
    await window.getByTestId('settings-nav-organization-memory').click();

    const memory = window.locator(MEMORY_PAGE);
    const empty = memory.getByTestId('memory-facts-empty');
    await expect(empty).toContainText('No organization memory yet');
    await expect(empty).toContainText(
      "Facts appear here as agents learn from chats in this organization's projects. Choose who contributes in Policies.",
    );
    // Nothing to search or filter yet.
    await expect(
      memory.getByRole('searchbox', { name: 'Search organization memory' }),
    ).toHaveCount(0);
    await expect(memory.getByText('No matching memory facts.')).toHaveCount(0);

    // The owner can edit Policies: the action opens that page in Settings.
    await empty.getByTestId('memory-facts-empty-policies').click();
    const settingsPage = window.locator(
      '[data-testid="hosted-settings-content"][data-hosted-settings-page="organization/settings"]',
    );
    await expect(settingsPage.getByTestId('page-header-title')).toHaveText(
      'Policies',
    );
    await expect(
      window.getByTestId('settings-nav-organization-settings-policies'),
    ).toHaveAttribute('aria-current', 'page');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('with the hosted settings rollout flag off, Settings shows only the legacy local groups', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_flag_off';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-hosted-settings': false,
      }),
    },
  );
  try {
    await app.openSettings();
    await app.expectSettingsSection('canopy');
    expect(await railGroupIds(window)).toEqual(LOCAL_GROUP_IDS);
    await expect(window.getByTestId('settings-nav-account')).toHaveText(
      'Accounts',
    );
    await expect(window.getByTestId('settings-nav-notifications')).toHaveText(
      'Notifications',
    );
    await expect(window.getByTestId('hosted-settings-content')).toHaveCount(0);

    // Nothing reached the hosted settings bridge.
    const log = await readHostedSettingsRequests(apiKey);
    expect(
      log.requests.filter((request) => request.operation === 'auth-link.mint'),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a server without hosted settings shows the newer-server state and local panels keep working', async () => {
  const apiKey = 'csk_hosted_account_settings_unsupported';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-unsupported-server',
  );
  try {
    await app.openSettings();
    await window.getByTestId('settings-nav-account-account').click();
    await expect(
      window.getByTestId('hosted-settings-unsupported'),
    ).toBeVisible();
    await expect(
      window.getByTestId('hosted-settings-unsupported'),
    ).toContainText('These settings need a newer server.');
    await expect(
      window
        .getByTestId('hosted-settings-unsupported')
        .getByRole('button', { name: 'Open on web' }),
    ).toBeVisible();

    await app.openSettingsSection('canopy');
    await expect(window.getByTestId('hosted-settings-unsupported')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('signed out, the Account rows render without a scope picker and the content asks to sign in', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await expect(
      window.getByTestId('settings-nav-group-account'),
    ).toBeVisible();
    // No account or organization to switch between yet.
    await expect(window.getByTestId('settings-nav-scope-picker')).toHaveCount(
      0,
    );

    await window.getByTestId('settings-nav-account-security').click();
    const signedOut = window.getByTestId('hosted-settings-signed-out');
    await expect(signedOut).toContainText(
      'Sign in to manage your account and organizations.',
    );
    await expect(
      signedOut.getByRole('button', { name: 'Sign in' }),
    ).toBeVisible();
    expect(await selectedRailRows(window)).toEqual([
      'settings-nav-account-security',
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('payment CTAs open the authenticated billing page of the right wallet with the modal requested', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_hosted_account_settings_payment_handoff';
  const externalOpen = await startExternalOpenCapture();
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url },
  );
  try {
    await app.openSettings();

    // Personal wallet: Buy credits opens the consume URL of a magic link
    // whose return path is the personal billing page with the top-up intent.
    await window.getByTestId('settings-nav-account-billing').click();
    const notice = window.getByTestId('billing-payment-handoff-message');
    // No status line until a handoff starts.
    await expect(notice).toHaveCount(0);
    const buy = window.getByTestId('billing-buy-credits-handoff');
    await expect(buy).toBeEnabled({ timeout: 30_000 });
    await buy.click();
    await expect.poll(() => externalOpen.opened.length).toBe(1);
    expect(externalOpen.opened[0]).toMatch(CONSUME_URL);
    await expect(notice).toHaveText('Continue in your browser.');
    const personal = await mintedBillingPaths(apiKey, '/account/billing');
    expect(personal).toHaveLength(1);
    expect(personal[0].pathname).toBe('/account/billing');
    expect(personal[0].searchParams.get('topUp')).toBe('1');
    expect(personal[0].searchParams.get('paymentModal')).toBeNull();

    // Organization wallet: the owner's saved-card CTA targets that
    // organization's Settings billing subtab with the card modal requested.
    await openOrganizationsList(window);
    const content = window.getByTestId('hosted-settings-content');
    await content
      .getByTestId('team-panel-org')
      .filter({ hasText: 'Northwind Labs' })
      .first()
      .click();
    await window
      .getByTestId('settings-nav-organization-settings-billing')
      .click();
    const manageCard = content.getByTestId(
      'team-billing-manage-payment-method',
    );
    await expect(manageCard).toHaveText('Manage payment method');
    await expect(manageCard).toBeEnabled({ timeout: 30_000 });
    await manageCard.click();
    await expect.poll(() => externalOpen.opened.length).toBe(2);
    expect(externalOpen.opened[1]).toMatch(CONSUME_URL);
    await expect(
      content.getByTestId('team-billing-payment-handoff-message'),
    ).toHaveText('Continue in your browser.');
    const organization = await mintedBillingPaths(
      apiKey,
      `/organization/${HOSTED_SETTINGS_ORG_IDS.owner}/`,
    );
    expect(organization).toHaveLength(1);
    expect(organization[0].pathname).toBe(
      `/organization/${HOSTED_SETTINGS_ORG_IDS.owner}/settings`,
    );
    expect(organization[0].searchParams.get('tab')).toBe('billing');
    expect(organization[0].searchParams.get('paymentModal')).toBe(
      'payment-method',
    );
    expect(organization[0].searchParams.get('paymentRequestId')).toMatch(/\S/);
    expect(organization[0].searchParams.get('topUp')).toBeNull();

    // Desktop never rendered a financial form or called a financial route.
    await expect(window.locator('iframe[src*="stripe"]')).toHaveCount(0);
    const log = await readHostedSettingsRequests(apiKey);
    expect(log.requests.filter((request) => request.financial)).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await externalOpen.close();
  }
});

test('rail labels name the organization pages, Security draws its icon, and dialogs close without Cancel', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_hosted_account_settings_labels_dialogs';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    undefined,
    {
      overrides: {
        // No billing for this organization, so inviting runs inline and
        // Add member opens its dialog instead of handing off to the web.
        operationErrors: {
          'organization.billing.summary': { status: 404 },
        },
      },
    },
  );
  try {
    await app.openSettings();

    // CAN-4558 F: Security uses the lock, drawn at the rail's 14px.
    const securityIcon = window
      .getByTestId('settings-nav-account-security')
      .locator('svg')
      .first();
    await expect(securityIcon).toBeVisible();
    const iconBox = await securityIcon.boundingBox();
    expect(iconBox?.width).toBeCloseTo(14, 0);
    expect(iconBox?.height).toBeCloseTo(14, 0);

    // CAN-4558 G: Create organization has no Cancel; Escape closes it.
    await openOrganizationsList(window);
    const content = window.getByTestId('hosted-settings-content');
    await content
      .getByTestId('page-header-actions')
      .getByTestId('team-panel-create')
      .click();
    const createDialog = window.getByRole('dialog', {
      name: 'Create an organization',
    });
    await expect(
      createDialog.getByTestId('create-team-name-input'),
    ).toBeVisible();
    await expect(
      createDialog.getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0);
    await expect(
      createDialog.getByRole('button', { name: 'Close', exact: true }),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(createDialog).toHaveCount(0);

    // The scope picker names the organization, so its rows need not.
    await openOwnedOrganization(window);
    await expect(
      window.getByTestId('settings-nav-organization-digests'),
    ).toHaveText('Digests');
    await expect(
      window.getByTestId('settings-nav-organization-memory'),
    ).toHaveText('Memory');

    // CAN-4558 G: Add member has no Cancel either; Escape closes it.
    await window.getByTestId('settings-nav-organization-members').click();
    const addMember = content.getByTestId('team-add-member');
    await expect(addMember).toBeEnabled();
    await addMember.click();
    const email = window.getByTestId('add-member-email');
    await expect(email).toBeVisible();
    const addMemberDialog = window.getByRole('dialog').filter({ has: email });
    await expect(
      addMemberDialog.getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(addMemberDialog).toHaveCount(0);
    await expect(email).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('settings errors show friendly copy, never the server text, and a failed load retries', async () => {
  test.setTimeout(120_000);
  // CAN-4558 E: a scripted 500 whose body would be recognizable anywhere on
  // screen. Settings must render local copy instead.
  const sentinel = 'SENTINEL-SERVER-BODY-CAN-4558';
  const apiKey = 'csk_hosted_account_settings_friendly_errors';
  const { app, electronApp, userDataDir, window } = await launchSignedIn(
    apiKey,
    'hosted-settings-signed-in',
    undefined,
    {
      overrides: {
        operationErrors: {
          // A load on the organization's Timeline tab.
          'organization.feed.page': {
            status: 500,
            body: { error: sentinel },
          },
          // An action: renaming the organization.
          'organization.rename': { status: 500, body: { error: sentinel } },
        },
      },
    },
  );
  const feedReads = async () =>
    (await readHostedSettingsRequests(apiKey)).requests.filter(
      (request) => request.operation === 'organization.feed.page',
    ).length;
  try {
    await app.openSettings();
    await openOwnedOrganization(window);
    const content = window.getByTestId('hosted-settings-content');

    // The Timeline read failed: load copy with Try again, never the body.
    await expect(content).toContainText("Couldn't load this.");
    await expect(content).not.toContainText(sentinel);
    const retry = content.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();

    // Try again runs the read again. The script still fails it, so the same
    // friendly copy comes back, still without the body.
    const readsBeforeRetry = await feedReads();
    await retry.click();
    await expect.poll(feedReads).toBeGreaterThan(readsBeforeRetry);
    await expect(content).toContainText("Couldn't load this.");
    await expect(
      content.getByRole('button', { name: 'Try again' }),
    ).toBeVisible();
    await expect(content).not.toContainText(sentinel);

    // Renaming is an action on General: its own copy, no Try again, no body.
    await window
      .getByTestId('settings-nav-organization-settings-general')
      .click();
    await content.getByTestId('team-name-input').fill('Northwind Renamed');
    await content.getByTestId('team-name-input').press('Enter');
    await expect(content).toContainText(
      "Couldn't rename the organization. Try again.",
    );
    await expect(content).not.toContainText(sentinel);
    await expect(
      content.getByRole('button', { name: 'Try again', exact: true }),
    ).toHaveCount(0);
    // The field keeps the typed name, so the owner can try again.
    await expect(content.getByTestId('team-name-input')).toHaveValue(
      'Northwind Renamed',
    );

    const log = await readHostedSettingsRequests(apiKey);
    expect(
      log.requests.some(
        (request) => request.operation === 'organization.rename',
      ),
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

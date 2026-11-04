import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  FAKE_PROXY_MANAGEMENT_KEY,
  startFakeAccountProxy,
} from './fixtures/fake-account-proxy.mjs';
import {
  PROXY_USAGE_CLAUDE,
  PROXY_USAGE_CODEX,
  proxyAccountUsageState,
} from './fixtures/proxy-account-usage.mjs';

test('opening a cold composer usage popover fetches scoped proxy quotas', async () => {
  test.setTimeout(180_000);
  const state = proxyAccountUsageState();
  state.config['api-keys'].claude = [];
  const proxy = await startFakeAccountProxy({ state });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-cold-usage-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 'proxy-usage', title: 'Proxy usage', model: 'sonnet' }],
  });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );
    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);
    await app.selectWorktree('demo-main');
    expect(
      proxy.requests.filter((request) =>
        request.path.endsWith('/requests/api-call'),
      ),
    ).toHaveLength(0);
    await window
      .getByTestId('panel-content-chat')
      .getByTestId('usage-indicator')
      .click();
    const accounts = window
      .getByTestId('usage-indicator-popover')
      .getByTestId('usage-indicator-proxy-accounts');
    await expect(accounts).toContainText(/Sonnet/i);
    await expect(accounts).toContainText('Claude Max 20x');
    expect(
      proxy.requests.some((request) =>
        request.path.endsWith('/requests/api-call'),
      ),
    ).toBe(true);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await proxy.close();
  }
});

test('Proxy account cards group the popover accounts under one foldable row', async () => {
  test.setTimeout(180_000);
  const proxy = await startFakeAccountProxy({
    state: proxyAccountUsageState(),
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-account-cards-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 'proxy-cards', title: 'Proxy cards', model: 'sonnet' }],
  });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );

    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);
    await app.selectWorktree('demo-main');
    await window
      .getByTestId('panel-content-chat')
      .getByTestId('usage-indicator')
      .click();
    const popover = window.getByTestId('usage-indicator-popover');
    const section = popover.getByTestId('usage-indicator-proxy-accounts');
    const toggle = section.getByTestId('usage-indicator-proxy-section-toggle');
    await expect(toggle).toHaveText('Proxy accounts');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      section.getByRole('button', { name: 'Manage proxy accounts' }),
    ).toBeVisible();
    const card = section.getByTestId('usage-indicator-account').first();
    await expect(card).toContainText('Claude Max 20x');
    await expect(section).not.toContainText('Via account proxy');
    await expect(
      popover.getByTestId('usage-indicator-see-details'),
    ).toBeVisible();

    // Manage and its chevron sit as Cost's value and chevron do: the text
    // ends at the same x and the chevrons share a column.
    const edges = await popover.evaluate((root) => {
      const textRight = (element) => {
        const range = document.createRange();
        const texts = [...element.childNodes].filter(
          (node) => node.nodeType === 3,
        );
        range.setStartBefore(texts[0]);
        range.setEndAfter(texts.at(-1));
        return Math.max(
          ...[...range.getClientRects()].map((rect) => rect.right),
        );
      };
      const cost = root.querySelector('[data-testid="usage-indicator-cost"]');
      const costValue = cost.querySelector('span:last-child');
      const manage = root.querySelector(
        'button[aria-label="Manage proxy accounts"]',
      );
      const header = root.querySelector(
        '[data-testid="usage-indicator-proxy-section-toggle"]',
      ).parentElement;
      return {
        costText: textRight(costValue),
        manageText: textRight(manage),
        costChevron: cost.querySelector('svg').getBoundingClientRect().right,
        headerChevron: header.querySelector('svg').getBoundingClientRect()
          .right,
      };
    });
    expect(Math.abs(edges.manageText - edges.costText)).toBeLessThanOrEqual(
      0.5,
    );
    expect(
      Math.abs(edges.headerChevron - edges.costChevron),
    ).toBeLessThanOrEqual(0.5);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(section.getByTestId('usage-indicator-account')).toHaveCount(0);
    await toggle.click();
    await expect(
      section.getByTestId('usage-indicator-account').first(),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await proxy.close();
  }
});

test('proxy account settings show scoped limits and preserve fresh cached values', async () => {
  test.setTimeout(180_000);
  const proxy = await startFakeAccountProxy({
    state: proxyAccountUsageState(),
  });
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await window.getByTestId('account-proxy-opt-in-toggle').click();
    await app.openSettingsSection('account-proxy');
    await window.getByTestId('account-proxy-url-input').fill(proxy.url);
    await window
      .getByTestId('account-proxy-key-input')
      .fill(FAKE_PROXY_MANAGEMENT_KEY);
    await window.getByTestId('account-proxy-connect').click();
    const claude = window.getByTestId(
      `account-proxy-account-${PROXY_USAGE_CLAUDE}`,
    );
    await expect(claude).toContainText('sam@example.com');
    await expect(claude).toContainText('Claude Max 20x');
    await expect(claude.getByRole('progressbar').first()).not.toBeVisible();
    await claude.getByTestId('provider-account-usage-toggle').click();
    await expect(claude.getByRole('progressbar').first()).toBeVisible();
    await expect(claude).toContainText(/Sonnet/i);
    await expect(claude).toContainText(/Extra usage/i);
    await claude.getByTestId('provider-account-usage-toggle').focus();
    await window.keyboard.press('Enter');
    await expect(claude.getByRole('progressbar').first()).not.toBeVisible();
    await window.keyboard.press('Enter');
    await expect(claude.getByRole('progressbar').first()).toBeVisible();
    const codex = window.getByTestId(
      `account-proxy-account-${PROXY_USAGE_CODEX}`,
    );
    await codex.getByTestId('provider-account-usage-toggle').click();
    await expect(codex).toContainText(/review/i);
    await expect(codex).toContainText('123');
    expect(
      proxy.requests.some(
        (request) =>
          request.path === '/v8/management/requests/api-call' &&
          (request.body?.auth_index ?? request.body?.authIndex) ===
            PROXY_USAGE_CODEX,
      ),
    ).toBe(true);
    // An upstream failure is a nested status in a successful management read.
    proxy.state.usageByAuthIndex[PROXY_USAGE_CLAUDE] = {
      status: 429,
      headers: { 'Retry-After': ['120'] },
      body: { error: 'Provider usage read throttled' },
    };
    // The live cache's freshness window is intentionally retained here; a
    // request while fresh must not discard the last successful values.
    await window.evaluate(() =>
      window.api.accountProxy.status({ refresh: true, refreshUsage: true }),
    );
    await expect(claude).toContainText(/Sonnet/i);
    await expect(claude.getByRole('progressbar').first()).toBeVisible();
    await expect(
      window.getByTestId('settings-tab-account-proxy'),
    ).not.toContainText('sk-must-never-appear');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await proxy.close();
  }
});

test('passive Codex quotas show each window duration once', async () => {
  test.setTimeout(180_000);
  const state = proxyAccountUsageState();
  state.usageByAuthIndex[PROXY_USAGE_CODEX] = { status: 429, body: {} };
  const proxy = await startFakeAccountProxy({ state });
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );
    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);
    await app.openSettings();
    await app.openSettingsSection('account-proxy');
    const account = window.getByTestId(
      `account-proxy-account-${PROXY_USAGE_CODEX}`,
    );
    await account.getByTestId('provider-account-usage-toggle').click();
    await expect(
      account.getByText('5-hour window', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await proxy.close();
  }
});

test('Settings refreshes untimestamped passive quotas after live reads fail', async () => {
  test.setTimeout(180_000);
  const state = proxyAccountUsageState();
  const credential = state.files.find(
    (file) => file.auth_index === PROXY_USAGE_CLAUDE,
  );
  expect(credential).toBeDefined();
  credential.quota = {
    signals: { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.20' },
  };
  state.usageByAuthIndex[PROXY_USAGE_CLAUDE] = { status: 503, body: {} };
  const proxy = await startFakeAccountProxy({ state });
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );
    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);
    await app.openSettings();
    await app.openSettingsSection('account-proxy');
    const account = window.getByTestId(
      `account-proxy-account-${PROXY_USAGE_CLAUDE}`,
    );
    await account.getByTestId('provider-account-usage-toggle').click();
    const meter = account.getByRole('progressbar').first();
    await expect(meter).toHaveAttribute('aria-valuenow', '20');
    await expect(account.getByRole('status')).toBeVisible();

    credential.quota.signals['Anthropic-Ratelimit-Unified-5h-Utilization'] =
      '0.80';
    await window.evaluate(() =>
      window.api.accountProxy.status({ refresh: true, refreshUsage: true }),
    );
    await expect(meter).toHaveAttribute('aria-valuenow', '80');
    await expect(account.getByRole('status')).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await proxy.close();
  }
});

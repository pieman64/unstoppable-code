import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  FAKE_PROXY_MANAGEMENT_KEY,
  defaultFakeProxyState,
  startFakeAccountProxy,
} from './fixtures/fake-account-proxy.mjs';

/**
 * Account proxy routing (CAN-4020).
 *
 * With the proxy connected, a live Claude turn goes from the bundled `claude`
 * binary to the loopback broker, which sends this device's own client key and
 * the chat's opaque session id to the proxy. The fake proxy keeps the session
 * on one account, forwards to the shared mock model server, and names the
 * account in `X-CPA-TRACE-ID`, which Canopy records for the chat.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 't1';
const MARKER = 'Canopy-CPROXYROUTE';
const FIRST_REPLY = 'Served through the account proxy';
const SECOND_REPLY = 'Still on the same proxy account';

async function sendTurn(window, panel, text, reply) {
  const composer = window.getByRole('textbox').first();
  await composer.click();
  await composer.fill(text);
  await window.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(reply).first()).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    window.getByRole('button', { name: 'Stop generation', exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });
}

test('a Claude chat runs through the proxy and records the account that served it', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-proxy-routing-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Proxy chat', model: 'sonnet' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        { text: FIRST_REPLY, stopReason: 'end_turn' },
        { text: SECOND_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  const proxy = await startFakeAccountProxy({
    upstreamUrl: DEFAULT_MOCK_BASE_URL,
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Opt in and connect, as Settings does.
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );
    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);
    // This device added its own client key next to the existing one.
    const clientKeys = proxy.state.config.access['api-keys'];
    expect(clientKeys).toHaveLength(2);
    expect(clientKeys[0]).toBe('ck-e2e-client');
    const deviceKey = clientKeys[1];
    expect(deviceKey).toMatch(/^canopy-[a-f0-9]{48}$/);

    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();

    await sendTurn(window, panel, `[${MARKER}] First turn.`, FIRST_REPLY);
    await sendTurn(window, panel, `[${MARKER}] Second turn.`, SECOND_REPLY);

    const messages = proxy.modelRequests.filter(
      (entry) => entry.path.split('?')[0] === '/v1/messages',
    );
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const entry of messages) {
      // The broker sends the device key; the harness never had it.
      expect(entry.authorization).toBe(`Bearer ${deviceKey}`);
      // The session id is stable and does not reveal the chat's location.
      expect(entry.sessionId).toMatch(/^canopy-[a-f0-9]{32}$/);
      expect(entry.sessionId).toBe(messages[0].sessionId);
      expect(entry.sessionId).not.toContain(WORKTREE_ID);
      expect(entry.canopyHeaders).toEqual([]);
    }
    // Session affinity: every turn of the chat stayed on one account.
    const served = new Set(messages.map((entry) => entry.authIndex));
    expect(served.size).toBe(1);
    const [authIndex] = [...served];

    const sessionAccounts = await window.evaluate(
      (chat) => window.api.accountProxy.sessionAccounts(chat),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
    );
    expect(sessionAccounts).toEqual([
      expect.objectContaining({
        authIndex,
        label: 'sam@example.com',
        provider: 'claude',
        current: true,
      }),
    ]);
    expect(sessionAccounts[0].requests).toBeGreaterThanOrEqual(2);

    // The chat's turns recorded the account, and the usage popover names it
    // with its share of the turns and an estimate (CAN-4021).
    await panel.getByTestId('usage-indicator').click();
    const accounts = window
      .getByTestId('usage-indicator-popover')
      .getByTestId('usage-indicator-proxy-accounts');
    await expect(accounts).toContainText('sam@example.com', {
      timeout: 30_000,
    });
    await expect(accounts).toContainText('100% of turns');
    await window.keyboard.press('Escape');

    // The route main reported for the chat's session outranks the route new
    // work on this device would now take, so disconnecting the proxy does not
    // move the open session to the user's own plan (CAN-4022).
    await window.evaluate(() => window.api.accountProxy.disconnect());
    await panel.getByTestId('usage-indicator').click();
    await expect(window.getByTestId('usage-indicator-popover')).toBeVisible();
    await expect(accounts).toContainText('100% of turns');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await proxy.close();
  }
});

// CAN-4302: with no Claude account in the proxy, the turn used to wait for
// capacity forever. It now ends at once with a message that says how to fix it.
test('a Claude chat ends with a clear error when the proxy has no Claude accounts', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-proxy-no-claude-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Proxy chat', model: 'sonnet' }],
  });
  const state = defaultFakeProxyState();
  state.files = state.files.filter((file) => file.provider !== 'claude');
  delete state.config['api-keys'].claude;
  const proxy = await startFakeAccountProxy({
    state,
    upstreamUrl: DEFAULT_MOCK_BASE_URL,
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );
    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);

    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    const composer = window.getByRole('textbox').first();
    await composer.click();
    await composer.fill(`[${MARKER}] No Claude account.`);
    await window.getByRole('button', { name: 'Send message' }).click();

    await expect(
      panel.getByText(
        'The account proxy has no Claude accounts. Add one in Settings > Multi-account proxy, or turn off Use for Claude there.',
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      window.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    expect(
      proxy.modelRequests.filter(
        (entry) => entry.path.split('?')[0] === '/v1/messages',
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await proxy.close();
  }
});

// The usage surfaces show the route main takes (CAN-4022): an OpenCode chat
// never runs through the proxy, and AI Credits set to route every session
// outrank it, so neither shows the proxy's accounts.
test('usage surfaces leave the proxy out of OpenCode chats and AI Credits on', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-proxy-usage-route-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'opencode',
    tabs: [
      {
        id: CHAT_ID,
        title: 'OpenCode chat',
        model: 'opencode:anthropic%2Fclaude-sonnet-4-5',
      },
    ],
  });
  const proxy = await startFakeAccountProxy({
    upstreamUrl: DEFAULT_MOCK_BASE_URL,
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );
    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);

    // An Anthropic model through OpenCode: main's OpenCode session has no
    // proxy route, so the popover does not show the Claude pool.
    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    await panel.getByTestId('usage-indicator').click();
    const popover = window.getByTestId('usage-indicator-popover');
    await expect(popover).toBeVisible();
    await expect(
      popover.getByTestId('usage-indicator-proxy-accounts'),
    ).toHaveCount(0);
    await expect(popover).not.toContainText('Via account proxy');
    await window.keyboard.press('Escape');

    // AI Credits for every session: Claude keeps the user's own card.
    await window.evaluate(() =>
      window.api.savePreferences({ aiCreditsRoutingMode: 'on' }),
    );
    await app.openUsagePage();
    const claudeCard = window.getByTestId('usage-provider-card-claude');
    // A proxied group's heading reads `Claude · Account proxy`.
    const claudeHeading = claudeCard.locator('h2').first();
    await expect(claudeCard).toBeVisible({ timeout: 30_000 });
    await expect(claudeHeading).not.toContainText('Account proxy');
    await expect(
      window.getByTestId('usage-provider-claude-account-proxy'),
    ).toHaveCount(0);

    // `on-quota` never outranks the proxy, so the card follows it again.
    await window.evaluate(() =>
      window.api.savePreferences({ aiCreditsRoutingMode: 'on-quota' }),
    );
    await app.openStatisticsPage();
    await app.openUsagePage();
    await expect(
      window.getByTestId('usage-provider-claude-account-proxy'),
    ).toContainText('sam@example.com', { timeout: 30_000 });
    await expect(claudeHeading).toHaveText('Claude · Account proxy');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await proxy.close();
  }
});

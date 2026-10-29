// Observed costs in the Cost scope panel and per-chat Session breakdown.
// The cost index is seeded from normal audit day files plus persisted chats,
// archives, and pipeline executions before the app launches.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import { seedCostInsights } from './seeders/index.mjs';
// Imported directly: the performance harness pins the seeders index's closure.
import { markAccountProxyCost } from './seeders/seedAccountProxyCost.mjs';
import {
  FAKE_PROXY_MANAGEMENT_KEY,
  startFakeAccountProxy,
} from './fixtures/fake-account-proxy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
// The E2E build and this spec read the same `CANOPY_BRAND`.
const BRAND_SHORT_NAME = loadBrand(
  process.env.CANOPY_BRAND || 'canopy',
).shortName;

/** Rewrites one chat's audit entries as the account proxy records them. */
function markAccountProxyServed(auditFiles, chatId) {
  let marked = 0;
  for (const file of auditFiles) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const next = lines.map((line) => {
      if (!line.trim()) return line;
      const entry = JSON.parse(line);
      if (entry.chatId !== chatId) return line;
      marked += 1;
      return JSON.stringify({ ...entry, billingBasis: 'account_proxy' });
    });
    writeFileSync(file, next.join('\n'));
  }
  if (marked === 0) throw new Error(`No audit entries for chat ${chatId}`);
}

/** Reproduces a completed subscription turn overwritten after continuation. */
function appendUnknownContinuation(auditFiles, chatId) {
  let continued = false;
  for (const file of auditFiles) {
    const next = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.chatId !== chatId || entry.eventType !== 'worktree_chat') {
        next.push(line);
        continue;
      }
      const original = {
        ...entry,
        sdkSessionId: 'cost-subscription-continuation-session',
        providerAccountKey: 'claude:subscriber@example.invalid',
        providerAccountEmail: 'subscriber@example.invalid',
        providerPlanType: 'default_claude_max_20x',
      };
      next.push(JSON.stringify(original));
      next.push(
        JSON.stringify({
          ...original,
          billingBasis: 'unknown',
          completedAt: new Date(
            Date.parse(original.completedAt) + 60_000,
          ).toISOString(),
          totalCostUsd: original.totalCostUsd + 1,
          tokens: { ...original.tokens, output: original.tokens.output + 100 },
        }),
      );
      continued = true;
    }
    writeFileSync(file, `${next.join('\n')}\n`);
  }
  if (!continued) throw new Error(`No completed turn for chat ${chatId}`);
}

function seed({
  earlyAccess = true,
  accountProxyChat = false,
  accountProxyAccounts = false,
  unknownContinuation = false,
} = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-cost-panel-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const cost = seedCostInsights({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    earlyAccess,
  });
  if (accountProxyChat) {
    markAccountProxyServed(cost.auditFiles, cost.ids.twoModelChat);
  }
  if (unknownContinuation) {
    appendUnknownContinuation(cost.auditFiles, cost.ids.rootChat);
  }
  if (accountProxyAccounts) {
    // No proxy is connected, so the views name each account by provider.
    markAccountProxyCost(cost.auditFiles, {
      connectionId: 'conn-e2e',
      served: {
        [cost.ids.twoModelChat]: { sam: 3, ops: 1 },
        [cost.ids.rootChat]: { sam: 2 },
        [`${cost.ids.rootExecution}/review/0`]: { ops: 2 },
        [`${cost.ids.rootExecution}/review/1`]: { sam: 2 },
      },
    });
  }
  return { userDataDir, cost };
}

async function openCostFromMenu(window) {
  await window.getByTestId('panel-add-tab-group-chat').click();
  const menu = window.getByTestId('panel-add-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('panel-add-menu-item-cost').click();
  const panel = window.getByTestId('panel-content-cost');
  await expect(panel).toBeVisible();
  return panel;
}

async function openApp({
  earlyAccess = true,
  accountProxyChat = false,
  accountProxyAccounts = false,
  unknownContinuation = false,
} = {}) {
  const seeded = seed({
    earlyAccess,
    accountProxyChat,
    accountProxyAccounts,
    unknownContinuation,
  });
  const launched = await launchCanopy({ userDataDir: seeded.userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  return { ...seeded, launched, window };
}

function accel() {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

/** Focuses the open Cost panel through the palette, which never adds a second. */
async function focusCostPanel(window) {
  await window.keyboard.press(`${accel()}+k`);
  const palette = window.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('command-palette-input').fill('Open Cost panel');
  await palette.getByTestId('command-palette-command-open-cost-panel').click();
  await expect(window.getByTestId('panel-content-cost')).toBeVisible();
}

test('Cost panel filters, sorts, refreshes, and opens chat and pipeline details', async () => {
  test.setTimeout(150_000);
  const { launched, userDataDir, window, cost } = await openApp();
  try {
    await test.step('open the Cost panel from the add-tab menu and command palette', async () => {
      const panel = await openCostFromMenu(window);
      await expect(panel.getByTestId('cost-total')).toContainText(
        cost.expected.scopeTotal,
      );
      await window.keyboard.press(`${accel()}+k`);
      const palette = window.getByTestId('command-palette');
      await expect(palette).toBeVisible();
      await palette
        .getByTestId('command-palette-input')
        .fill('Open Cost panel');
      await palette
        .getByTestId('command-palette-command-open-cost-panel')
        .click();
      await expect(panel).toBeVisible();
      await expect(window.getByTestId('panel-content-cost')).toHaveCount(1);
    });

    const panel = window.getByTestId('panel-content-cost');
    await expect(
      panel.getByTestId(`cost-chat-row-${cost.ids.rootChat}`),
    ).toContainText(cost.expected.chats[cost.ids.rootChat]);
    await expect(
      panel.getByTestId(`cost-chat-row-${cost.ids.twoModelChat}`),
    ).toContainText(cost.expected.chats[cost.ids.twoModelChat]);
    await expect(
      panel.getByTestId(`cost-chat-row-${cost.ids.archivedChat}`),
    ).toContainText(cost.expected.chats[cost.ids.archivedChat]);
    await expect(
      panel.getByTestId(`cost-run-row-${cost.ids.rootExecution}`),
    ).toContainText(cost.expected.pipelineTotal);
    await expect(panel.getByTestId('cost-unattached-row')).toContainText(
      cost.expected.unattachedTotal,
    );

    const costRows = panel.getByTestId(/^cost-(chat|run)-row-/);
    await expect(costRows.first()).toHaveAttribute(
      'data-testid',
      `cost-chat-row-${cost.ids.rootChat}`,
    );
    await expect(
      panel.getByTestId(`cost-chat-row-${cost.ids.archivedChat}`),
    ).toContainText('Archived');

    await test.step('switch both split dimensions and sort/archive options', async () => {
      const legend = panel.getByTestId('cost-entry-legend');
      await expect(legend).toContainText('Chat turns');
      const bars = [
        [
          panel.getByTestId(`cost-chat-row-${cost.ids.rootChat}`),
          /Chat.*Subagents.*Delegations.*Background/,
        ],
        [panel.getByTestId(`cost-chat-row-${cost.ids.twoModelChat}`), /Chat/],
        [panel.getByTestId(`cost-chat-row-${cost.ids.archivedChat}`), /Chat/],
        [
          panel.getByTestId(`cost-run-row-${cost.ids.rootExecution}`),
          /Pipeline/,
        ],
        [panel.getByTestId('cost-unattached-row'), /Background/],
      ];
      for (const [row, expectedLabel] of bars) {
        await expect(row.getByRole('img')).toHaveAttribute(
          'aria-label',
          expectedLabel,
        );
      }
      await panel.getByTestId('cost-split-billing').click();
      await expect(legend).toContainText('Subscription');
      await expect(legend).toContainText('API key');
      for (const [index, [row]] of bars.entries()) {
        await expect(row.getByRole('img')).toHaveAttribute(
          'aria-label',
          index === 2 ? /API key/ : /Subscription/,
        );
      }
      await panel.getByTestId('cost-split-source').click();
      await expect(legend).toContainText('Pipeline');

      await panel.getByTestId('cost-sort').click();
      const sortMenu = window.getByTestId('cost-sort-menu');
      await sortMenu.getByTestId('cost-sort-option-recent').click();
      await expect(costRows.first()).toHaveAttribute(
        'data-testid',
        `cost-chat-row-${cost.ids.archivedChat}`,
      );
      await panel.getByTestId('cost-sort').click();
      await window
        .getByTestId('cost-sort-menu')
        .getByTestId('cost-sort-show-archived')
        .click();
      await expect(
        panel.getByTestId(`cost-chat-row-${cost.ids.archivedChat}`),
      ).toHaveCount(0);
      // The checkbox keeps its menu open, so the next choices need no reopen.
      await window
        .getByTestId('cost-sort-menu')
        .getByTestId('cost-sort-show-archived')
        .click();
      await expect(
        panel.getByTestId(`cost-chat-row-${cost.ids.archivedChat}`),
      ).toBeVisible();
      await window
        .getByTestId('cost-sort-menu')
        .getByTestId('cost-sort-option-cost')
        .click();
    });

    await test.step('refresh observed cost and verify freshness is reported', async () => {
      await panel.getByTestId('cost-refresh').click();
      // The Codex notice is a status region too; match the refresh announcement.
      await expect(
        panel.getByRole('status').filter({ hasText: 'Cost updated' }),
      ).toHaveCount(1, { timeout: 20_000 });
      await expect(panel.getByTestId('cost-freshness-label')).toBeVisible();
      await expect(panel.getByTestId('cost-total')).toContainText(
        cost.expected.scopeTotal,
      );
    });

    await test.step('open one Session breakdown and inspect its three tabs', async () => {
      await panel.getByTestId(`cost-chat-row-${cost.ids.rootChat}`).click();
      const breakdown = window.getByTestId('session-breakdown-view');
      const costTab = breakdown.getByTestId('session-breakdown-panel-cost');
      await expect(breakdown).toBeVisible();
      await expect(
        breakdown.getByTestId('session-breakdown-meta'),
      ).toContainText(cost.expected.chats[cost.ids.rootChat]);
      await expect(
        costTab.getByTestId('session-breakdown-source-chat'),
      ).not.toHaveAttribute('aria-expanded', 'true');
      await costTab.getByTestId('session-breakdown-source-subagents').click();
      await expect(
        costTab.getByTestId(
          `session-breakdown-item-${cost.ids.nativeSubagent}`,
        ),
      ).toContainText('1.0k tokens');
      await costTab.getByTestId('session-breakdown-source-delegations').click();
      const delegation = costTab.getByTestId(
        `session-breakdown-item-${cost.ids.managedDelegation}`,
      );
      await expect(delegation).toBeVisible();

      await breakdown.getByTestId('session-breakdown-tab-context').click();
      const context = breakdown.getByTestId('session-breakdown-panel-context');
      await expect(
        context.getByTestId('session-breakdown-context'),
      ).toContainText('Compaction');
      await expect(
        context.getByTestId('session-breakdown-context'),
      ).toContainText('Peak');
      await expect(
        context.getByTestId('session-breakdown-context'),
      ).toContainText('Compactions');

      await breakdown.getByTestId('session-breakdown-tab-activity').click();
      const activity = breakdown.getByTestId(
        'session-breakdown-panel-activity',
      );
      await expect(
        activity.getByTestId('session-breakdown-activity'),
      ).toContainText('Turns');
      // Tool groups read as names, and the app's own tools as the brand.
      for (const tool of ['Bash', 'Read', BRAND_SHORT_NAME]) {
        await expect(
          activity.getByTestId('session-breakdown-top-tools'),
        ).toContainText(tool);
      }

      await breakdown.getByTestId('session-breakdown-tab-cost').click();
      await costTab.getByTestId('session-breakdown-source-delegations').click();
      await delegation.click();
      const subagentChat = window.getByTestId('subagent-chat-panel');
      await expect(subagentChat).toBeVisible();
      await subagentChat.getByTestId('subagent-chat-details-toggle').click();
      await expect(
        subagentChat.getByTestId('subagent-chat-details-cost'),
      ).toBeVisible();
    });

    await test.step('the two-model chat expands by model and duplicate selection focuses its existing tab', async () => {
      // The earlier breakdown now covers the Cost panel in its group.
      await focusCostPanel(window);
      await panel.getByTestId(`cost-chat-row-${cost.ids.twoModelChat}`).click();
      const breakdowns = window.getByTestId('panel-content-session-breakdown');
      const openBreakdowns = await breakdowns.count();
      const breakdown = window
        .getByTestId('session-breakdown-view')
        .filter({ hasText: 'Two model review' });
      const chatSource = breakdown
        .getByTestId('session-breakdown-panel-cost')
        .getByTestId('session-breakdown-source-chat');
      await expect(chatSource).toHaveAttribute('aria-expanded', 'false');
      await chatSource.click();
      await expect(chatSource).toHaveAttribute('aria-expanded', 'true');
      await expect(
        breakdown.getByTestId('session-breakdown-panel-cost'),
      ).toContainText('claude-sonnet-4-5');
      await expect(
        breakdown.getByTestId('session-breakdown-panel-cost'),
      ).toContainText('claude-haiku-4-5');
      await focusCostPanel(window);
      await panel.getByTestId(`cost-chat-row-${cost.ids.twoModelChat}`).click();
      // Selecting it again focuses the open breakdown instead of adding one.
      await expect(breakdowns).toHaveCount(openBreakdowns);
      await expect(breakdown).toBeVisible();
    });

    await test.step('selecting a pipeline cost row opens its details at Cost', async () => {
      await focusCostPanel(window);
      await panel.getByTestId(`cost-run-row-${cost.ids.rootExecution}`).click();
      // A narrow panel collapses the job list, so check the breakdown it opened.
      const runCost = window.getByTestId('pipeline-cost-view');
      await expect(runCost).toBeVisible();
      await expect(runCost).toContainText(cost.expected.pipelineTotal);
    });
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('Cost panel opens from the add-tab menu and the palette with Early access off', async () => {
  const { launched, userDataDir, window, cost } = await openApp({
    earlyAccess: false,
  });
  try {
    // Without Early access the add-tab menu opens from the group's add-panel
    // control; the plus button starts a chat directly.
    await window.getByTestId('panel-add-panel-group-chat').click();
    const menu = window.getByTestId('panel-add-menu');
    await expect(menu).toBeVisible();
    await menu.getByTestId('panel-add-menu-item-cost').click();
    const panel = window.getByTestId('panel-content-cost');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('cost-total')).toContainText(
      cost.expected.scopeTotal,
    );
    await expect(
      panel.getByTestId(`cost-chat-row-${cost.ids.rootChat}`),
    ).toContainText(cost.expected.chats[cost.ids.rootChat]);

    // The palette command finds the open panel instead of adding another.
    await focusCostPanel(window);
    await expect(window.getByTestId('panel-content-cost')).toHaveCount(1);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('Cost panel bills account proxy work as Account proxy', async () => {
  const { launched, userDataDir, window, cost } = await openApp({
    accountProxyChat: true,
  });
  try {
    const panel = await openCostFromMenu(window);
    await expect(panel.getByTestId('cost-total')).toContainText(
      cost.expected.scopeTotal,
    );
    await focusCostPanel(window);
    await panel.getByTestId('cost-split-billing').click();
    const legend = panel.getByTestId('cost-entry-legend');
    await expect(legend).toContainText('Account proxy');
    await expect(legend).not.toContainText('Unknown');
    await expect(
      panel
        .getByTestId(`cost-chat-row-${cost.ids.twoModelChat}`)
        .getByRole('img'),
    ).toHaveAttribute('aria-label', /Account proxy/);
    await expect(
      panel.getByTestId(`cost-chat-row-${cost.ids.rootChat}`).getByRole('img'),
    ).toHaveAttribute('aria-label', /Subscription/);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('cost views name the proxy accounts of a chat, a subagent and a pipeline run', async () => {
  test.setTimeout(150_000);
  const { launched, userDataDir, window, cost } = await openApp({
    accountProxyAccounts: true,
  });
  const proxy = await startFakeAccountProxy();
  try {
    await test.step('the usage popover lists the accounts instead of the plan', async () => {
      const chat = window
        .getByTestId('panel-content-chat')
        .filter({ visible: true })
        .first();
      const popover = window.getByTestId('usage-indicator-popover');
      const accounts = popover.getByTestId('usage-indicator-proxy-accounts');
      // Without a proxy, the chat's next work runs on the user's own plan.
      await chat.getByTestId('usage-indicator').click();
      await expect(popover).toBeVisible();
      await expect(accounts).toHaveCount(0);
      await window.keyboard.press('Escape');

      await window.evaluate(() =>
        window.api.savePreferences({ accountProxyEnabled: true }),
      );
      const connected = await window.evaluate(
        ({ url, key }) =>
          window.api.accountProxy.connect({ url, managementKey: key }),
        { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
      );
      expect(connected.ok).toBe(true);
      await chat.getByTestId('usage-indicator').click();
      await expect(accounts).toContainText('Via account proxy · 75% of turns');
      await expect(accounts).toContainText('Via account proxy · 25% of turns');
      await expect(accounts).toContainText('Claude account');
      await window.keyboard.press('Escape');
      // The views below name each account by provider, as with no proxy.
      await window.evaluate(() => window.api.accountProxy.disconnect());
    });

    const panel = await openCostFromMenu(window);
    await test.step('a subagent of a proxy turn names its account', async () => {
      await panel.getByTestId(`cost-chat-row-${cost.ids.rootChat}`).click();
      const breakdown = window.getByTestId('session-breakdown-view');
      const costTab = breakdown.getByTestId('session-breakdown-panel-cost');
      await costTab.getByTestId('session-breakdown-source-subagents').click();
      await costTab
        .getByTestId(`session-breakdown-item-${cost.ids.nativeSubagent}`)
        .click();
      const subagentChat = window.getByTestId('subagent-chat-panel');
      await expect(subagentChat).toBeVisible();
      await subagentChat.getByTestId('subagent-chat-details-toggle').click();
      const details = subagentChat.getByTestId('subagent-chat-details-cost');
      await expect(details).toContainText('Claude account via account proxy');
      await expect(details).toContainText(
        'Account proxy, estimated at API prices',
      );
    });

    await test.step('a pipeline run names each step account and totals them', async () => {
      await focusCostPanel(window);
      await panel.getByTestId(`cost-run-row-${cost.ids.rootExecution}`).click();
      const runCost = window.getByTestId('pipeline-cost-view');
      await expect(runCost).toBeVisible();
      await expect(
        runCost.getByTestId('pipeline-run-cost-step-review-account'),
      ).toContainText('2 accounts via account proxy · switched accounts');
      const byAccount = runCost.getByTestId('pipeline-run-cost-by-account');
      await expect(byAccount).toContainText('50% of attempts');
      await expect(
        byAccount.getByTestId('pipeline-run-cost-account-row'),
      ).toHaveCount(2);
    });
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
    await proxy.close();
  }
});

test('Cost panel preserves subscription billing after a completed turn continues', async () => {
  const { launched, userDataDir, window, cost } = await openApp({
    unknownContinuation: true,
  });
  try {
    const panel = await openCostFromMenu(window);
    await expect(panel.getByTestId('cost-total')).toContainText('$11.50');
    const row = panel.getByTestId(`cost-chat-row-${cost.ids.rootChat}`);
    await expect(row).toContainText('$6.00');
    await focusCostPanel(window);
    await panel.getByTestId('cost-split-billing').click();
    const legend = panel.getByTestId('cost-entry-legend');
    await expect(legend).toContainText('Subscription');
    await expect(legend).not.toContainText('Unknown');
    await expect(row.getByRole('img')).toHaveAttribute(
      'aria-label',
      /Subscription/,
    );
    await expect(row.getByRole('img')).not.toHaveAttribute(
      'aria-label',
      /Unknown/,
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

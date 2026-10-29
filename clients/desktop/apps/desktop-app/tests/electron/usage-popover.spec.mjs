// The composer's usage popover. Before the first reply it draws the Context
// row with an empty bar rather than a line of text; after a live Claude turn
// the Context row expands into Context and Session tabs, the shared underline
// tabs, each showing its own list.
//
// The live turn runs the bundled `claude` binary against the shared mock
// provider (see chat-live-turn.spec.mjs for the seam), so the category split
// comes from the session's own context report, not from seeded data.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  registerScenario,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CUSAGE-TABS';
const ASSISTANT_REPLY = 'Usage tabs reply from the deterministic mock provider';
const USAGE_KEY = 'mock';

async function launchClaudeChat() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-usage-popover-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // A model with a configured window, so the meter is sized before any reply.
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat', model: 'sonnet' }],
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  return { electronApp, userDataDir };
}

async function openChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  return { window, panel };
}

test.describe('usage popover', () => {
  test('a Claude 429 keeps plan limits in the popover and withholds retry during Retry-After', async () => {
    test.setTimeout(120_000);

    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: {
        claude: {
          auth: {
            loggedIn: true,
            email: 'tester@example.com',
            authMethod: 'oauth',
            subscriptionType: 'max',
          },
          usage: {
            five_hour: { utilization: 42, resets_at: '+2h' },
            seven_day: { utilization: 61, resets_at: '+5d' },
          },
        },
      },
    });
    const { electronApp, userDataDir } = await launchClaudeChat();
    try {
      const { window, panel } = await openChat(electronApp);
      const trigger = panel.getByTestId('usage-indicator');
      await trigger.click();

      const popover = window.getByTestId('usage-indicator-popover');
      const account = popover.getByTestId('usage-indicator-account');
      await expect(popover).toBeVisible();
      await expect(account).toContainText('5-hour window');
      await expect(account).toContainText('7-day window');
      await expect(account).toContainText('42%');
      await expect(account).toContainText('61%');

      await trigger.click();
      await expect(popover).toBeHidden();
      await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
        authUsage: {
          claude: {
            auth: {
              loggedIn: true,
              email: 'tester@example.com',
              authMethod: 'oauth',
              subscriptionType: 'max',
            },
            usage: {
              five_hour: { utilization: 42, resets_at: '+2h' },
              seven_day: { utilization: 61, resets_at: '+5d' },
            },
            usageHttpStatus: 429,
            usageRetryAfterSeconds: 600,
          },
        },
      });
      await window.evaluate(() =>
        window.api.observability.refreshUsage('claude'),
      );

      await trigger.click();
      await expect(popover).toBeVisible();
      await expect(account).toContainText('5-hour window');
      await expect(account).toContainText('7-day window');
      await expect(account).toContainText('42%');
      await expect(account).toContainText('61%');
      const status = account.getByRole('status');
      await expect(status).toBeVisible();
      await expect(status).toContainText(/limiting usage checks/i);
      await expect(popover.getByTestId('usage-indicator-retry')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });

  test('a chat with no reply yet draws the context row with an empty bar', async () => {
    const { electronApp, userDataDir } = await launchClaudeChat();
    try {
      const { window, panel } = await openChat(electronApp);
      await panel.getByTestId('usage-indicator').click();
      const popover = window.getByTestId('usage-indicator-popover');
      await expect(popover).toBeVisible();

      const empty = popover.getByTestId('usage-indicator-context-empty');
      await expect(empty).toHaveText('Context0');
      await expect(
        empty.getByRole('progressbar', { name: 'Context window used' }),
      ).toHaveAttribute('aria-valuenow', '0');
      // The bar replaces the line of text, and there is nothing to expand.
      await expect(
        popover.getByTestId('usage-indicator-empty-hint'),
      ).toHaveCount(0);
      await expect(popover.getByTestId('usage-indicator-context')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('after a reply the context row opens into Context and Session tabs', async () => {
    // The live turn spawns the bundled binary and streams from the mock.
    test.setTimeout(180_000);
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }],
      },
    });
    const { electronApp, userDataDir } = await launchClaudeChat();
    try {
      const { window, panel } = await openChat(electronApp);
      const composer = window.getByRole('textbox').first();
      await composer.click();
      await composer.fill(`[${CONVERSATION_MARKER}] Say hello.`);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(
        window.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);

      await panel.getByTestId('usage-indicator').click();
      const popover = window.getByTestId('usage-indicator-popover');
      // The live session reports what fills its window, so the bar splits.
      await expect(
        popover.getByRole('img', { name: 'Context window by category' }),
      ).toBeVisible();
      await popover.getByTestId('usage-indicator-context').click();

      const tabs = popover.getByRole('tablist', { name: 'Usage details' });
      await expect(tabs).toBeVisible();
      const contextTab = tabs.getByRole('tab', { name: 'Context' });
      const sessionTab = tabs.getByRole('tab', { name: 'Session' });
      await expect(contextTab).toHaveAttribute('aria-selected', 'true');
      await expect(sessionTab).toHaveAttribute('aria-selected', 'false');
      await expect(
        popover.getByRole('tabpanel', { name: 'Context' }),
      ).toContainText('System prompt');

      // One raised surface sits under the picked tab and slides to the
      // other when it is picked.
      const indicator = popover.getByTestId(
        'usage-indicator-details-switch-indicator',
      );
      const expectIndicatorUnder = async (tab) => {
        await expect
          .poll(async () => {
            const [surface, target] = await Promise.all([
              indicator.boundingBox(),
              tab.boundingBox(),
            ]);
            return (
              Math.abs(surface.x - target.x) +
              Math.abs(surface.width - target.width)
            );
          })
          .toBeLessThan(1);
      };
      await expectIndicatorUnder(contextTab);

      await sessionTab.click();
      await expect(sessionTab).toHaveAttribute('aria-selected', 'true');
      await expect(contextTab).toHaveAttribute('aria-selected', 'false');
      await expectIndicatorUnder(sessionTab);
      await expect(
        popover.getByRole('tabpanel', { name: 'Session' }),
      ).toContainText('Turns');
      await expect(
        popover.getByRole('tabpanel', { name: 'Context' }),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

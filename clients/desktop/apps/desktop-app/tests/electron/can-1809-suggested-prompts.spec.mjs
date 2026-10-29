import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedMcpServers, seedWorktreeChat } from './seeders/index.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

// CAN-1809 — MCP-aware suggested prompt chips on the blank chat empty state
// and the Home / New Task surface.
//
// The curated HTTP servers are seeded with `httpAuthHandler: 'provider'` so
// the inventory resolves them deterministically offline (no OAuth probe
// network call): provider-handled servers report `authStatus:
// 'not_configured'`, which is an eligible status for suggestions. Curated
// metadata is only valid on HTTP server definitions.
//
// Two curated servers are seeded: `github` (a hand-written prompt-index
// entry) and `acme-crm` (deliberately absent from the index) so the suite
// covers both indexed prompts and the synthesized name-based fallback that
// makes every curated catalog connector discoverable.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'can-1809-chat';
const NOW = '2026-08-05T12:00:00.000Z';

function seedState(userDataDir, { withCuratedServer }) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });

  if (withCuratedServer) {
    seedMcpServers({
      userDataDir,
      servers: [
        {
          definition: {
            id: 'curated-github',
            name: 'GitHub',
            description: 'Curated GitHub MCP server',
            type: 'http',
            url: 'https://github.example.test/mcp',
            httpAuthHandler: 'provider',
            curated: { key: 'github' },
            createdAt: NOW,
            updatedAt: NOW,
          },
          configs: [
            {
              id: 'default',
              name: 'Default',
              description: 'Default configuration',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
        {
          // No `acme-crm` entry exists in the hand-written prompt index, so
          // this server exercises the synthesized name-based fallback.
          definition: {
            id: 'curated-acme',
            name: 'Acme CRM',
            description: 'Curated MCP server without an index entry',
            type: 'http',
            url: 'https://acme.example.test/mcp',
            httpAuthHandler: 'provider',
            curated: { key: 'acme-crm' },
            createdAt: NOW,
            updatedAt: NOW,
          },
          configs: [
            {
              id: 'default',
              name: 'Default',
              description: 'Default configuration',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
      ],
    });
  }

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Suggested Prompts',
        messages: [],
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: withCuratedServer
            ? [
                { serverId: 'curated-github', configId: 'default' },
                { serverId: 'curated-acme', configId: 'default' },
              ]
            : [],
        },
      },
    ],
  });
}

async function launchWithState(options) {
  const userDataDir = options.withOnboarding
    ? seedWelcomeChecklist({ fresh: true })
    : mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-can1809-'));
  try {
    seedState(userDataDir, options);
    const { electronApp } = await launchCanopy({ userDataDir });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    return { electronApp, window, app, userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
}

test.describe('CAN-1809 suggested prompt chips', () => {
  test('blank code chat shows the shared onboarding checklist instead of prompt chips', async () => {
    test.setTimeout(120_000);
    const { electronApp, window, app, userDataDir } = await launchWithState({
      withCuratedServer: true,
      withOnboarding: true,
    });
    try {
      await window.setViewportSize({ width: 1600, height: 1000 });
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      const homeSuggestions = home.getByTestId('home-onboarding-suggestions');
      await expect(homeSuggestions).toBeVisible();
      const homeEditorBox = await home
        .getByTestId('home-composer-shell')
        .boundingBox();
      const homeSuggestionsBox = await homeSuggestions.boundingBox();
      expect(homeSuggestionsBox.y).toBeGreaterThan(
        homeEditorBox.y + homeEditorBox.height,
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      const host = window.getByTestId('chat-onboarding-checklist-host');
      await expect(host).toBeVisible();
      await expect(
        host.getByTestId('home-onboarding-suggestion-agent-connections'),
      ).toBeVisible();
      await expect(window.getByTestId('suggested-prompt-chips')).toHaveCount(0);
      const composer = window.locator('[data-chat-composer-root]:visible');
      const assertWidth = async () => {
        const hostBox = await host.boundingBox();
        const composerBox = await composer.boundingBox();
        const gap = composerBox.y - hostBox.y - hostBox.height;
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(24);
        // The transcript reserves a scrollbar gutter; allow that small inset.
        expect(
          Math.abs(hostBox.width - (composerBox.width - 32)),
        ).toBeLessThanOrEqual(16);
        expect(Math.abs(hostBox.x - composerBox.x - 16)).toBeLessThanOrEqual(
          16,
        );
      };
      await expect(assertWidth).toPass({ timeout: 5_000 });
      await window.getByTestId('worktree-top-save-layout-default').click();
      await window.getByTestId('workspace-chat-width-full').click();
      await window.keyboard.press('Escape');
      await expect(assertWidth).toPass({ timeout: 5_000 });
      await window.setViewportSize({ width: 1100, height: 900 });
      await expect(assertWidth).toPass({ timeout: 5_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('blank code chat never falls back to generic prompt chips', async () => {
    test.setTimeout(120_000);
    const { electronApp, window, app, userDataDir } = await launchWithState({
      withCuratedServer: false,
    });
    try {
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await expect(window.getByTestId('suggested-prompt-chips')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Home surface shows chips and a click fills the Home composer', async () => {
    test.setTimeout(120_000);
    const { electronApp, window, userDataDir } = await launchWithState({
      withCuratedServer: false,
    });
    try {
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      const chips = homePage.getByTestId('suggested-prompt-chips');
      await expect(chips).toBeVisible({ timeout: 45_000 });
      const chip = chips.getByTestId('suggested-prompt-chip').first();
      const chipText = (await chip.textContent()) ?? '';
      expect(chipText.length).toBeGreaterThan(0);

      await chip.click();
      await expect(homePage.getByTestId('home-composer-editor')).toContainText(
        chipText,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('App Advisor blank chat shows no suggested prompts', async () => {
    test.setTimeout(120_000);
    const { electronApp, app, userDataDir } = await launchWithState({
      withCuratedServer: false,
    });
    try {
      await app.showSidebar();
      const advisor = await app.openAppAdvisorWindow(electronApp);
      // Give a mistakenly rendered chip row time to appear before asserting
      // the App Advisor exclusion.
      await advisor.waitForTimeout(2_000);
      await expect(advisor.getByTestId('suggested-prompt-chips')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

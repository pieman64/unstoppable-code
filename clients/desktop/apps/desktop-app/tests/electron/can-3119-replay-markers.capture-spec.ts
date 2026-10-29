// @capture-keep: CAN-3119 visual-neutrality evidence, re-run on the integrated branch after the recorder lands
// @capture-reference: docs/planning/2026-10-01-can-3119-replay-dom-privacy/frontend-handoff.md
// Color modes: run each stage normally for light, then append `--dark-mode` for dark.
/**
 * CAN-3119: session-replay DOM privacy markers, no visual change.
 *
 * What changed: the renderer and the UI packages gained session-replay
 * privacy classes on existing elements: `ph-no-capture` blocks on panels,
 * pages, Settings sections, `DialogModal` cards, and content surfaces
 * (editors, terminals, diffs, secrets, logs). None of these classes has a
 * style rule and no wrapper element was added, so every capture below must be
 * pixel-identical between the two stages.
 *
 * Run both stages and both color modes headlessly:
 *
 *   CAN3119_STAGE=before pnpm run test:electron:captures:built can-3119-replay-markers.capture-spec.ts --reporter=line
 *   CAN3119_STAGE=before pnpm run test:electron:captures:built can-3119-replay-markers.capture-spec.ts --reporter=line --dark-mode
 *   # apply the change, then rebuild with `pnpm run build:e2e`
 *   CAN3119_STAGE=after pnpm run test:electron:captures:built can-3119-replay-markers.capture-spec.ts --reporter=line
 *   CAN3119_STAGE=after pnpm run test:electron:captures:built can-3119-replay-markers.capture-spec.ts --reporter=line --dark-mode
 *
 * Captures land in `.playwright/can-3119/` as `<surface>-<stage>-<mode>.png`;
 * the spec writes the mode suffix itself.
 * They cover the sidebar, the chat composer, a terminal panel, a reviewed
 * Settings section (Display), a blocked Settings section (Git), a
 * `DialogModal` (Edit MCP Server), and the environment variable editor.
 *
 * Determinism: one seeded demo workspace, one seeded chat, one seeded MCP
 * server, and a seeded environment draft; no live agents and no network.
 * The terminal capture shows a freshly spawned shell after `clear`, so it
 * holds only the shell prompt.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { spawnPanelTerminal } from './panelHarness.mjs';
import {
  seedMcpServers,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const STAGE = process.env.CAN3119_STAGE === 'before' ? 'before' : 'after';
// The capture runner seeds the color mode. The spec names its own files with
// the mode, because the runner keeps only artifacts whose bytes changed, and
// the terminal looks the same in both modes.
const MODE =
  process.env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : 'light';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'can-3119-capture-chat';
const MCP_SERVER_NAME = 'Docs search server';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-3119');

function seedFixture(userDataDir: string): void {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Release notes',
        messages: [
          {
            id: 'can-3119-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Draft the release notes.' }],
            timestamp: Date.UTC(2026, 8, 1),
          },
          {
            id: 'can-3119-assistant',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: 'Here is a first draft of the release notes.',
              },
            ],
            timestamp: Date.UTC(2026, 8, 1, 0, 0, 10),
          },
        ],
      },
    ],
  });
  const at = '2026-09-01T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'c3119b01',
          name: MCP_SERVER_NAME,
          description: 'Searches the product docs',
          type: 'http',
          url: 'https://mcp.example.test/docs/mcp',
          headers: {},
          createdAt: at,
          updatedAt: at,
        },
        configs: [
          {
            id: 'c3119c02',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: at,
            updatedAt: at,
          },
        ],
      },
    ],
  });
}

/**
 * Clicking a nav row can leave the Settings nav scrolled by a timing-dependent
 * amount, so each Settings capture starts with the nav at its top.
 */
async function resetSettingsNavScroll(window: Page): Promise<void> {
  await window
    .getByTestId('settings-nav-scroll-container')
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  await window.mouse.move(0, 0);
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.screenshot({
    path: path.join(captureDir, `${name}-${STAGE}-${MODE}.png`),
    animations: 'disabled',
    caret: 'hide',
  });
}

test(`CAN-3119 replay markers leave the UI unchanged (${STAGE})`, async () => {
  test.setTimeout(300_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-can-3119-'),
  );
  seedFixture(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await app.selectWorktree(WORKTREE_ID, { expandDefaultActivityRail: false });
    await expect(
      window
        .getByTestId('chat-message-list-content')
        .getByText('first draft of the release notes', { exact: false }),
    ).toBeVisible();
    // Move the pointer off every hover target so no hover state is captured.
    await window.mouse.move(0, 0);
    await capture(window.getByTestId('app-sidebar'), 'sidebar');
    await capture(
      window.locator('[data-chat-composer-root]:visible').first(),
      'chat-composer',
    );

    const pane = await spawnPanelTerminal(window);
    await pane.click();
    await window.keyboard.type('clear');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(750);
    await window.mouse.move(0, 0);
    await capture(window.getByTestId('terminal-panel-surface'), 'terminal');

    await app.openSettings();
    await app.openSettingsSection('display');
    await resetSettingsNavScroll(window);
    await capture(window.getByTestId('settings-overlay'), 'settings-display');
    await app.openSettingsSection('git');
    await resetSettingsNavScroll(window);
    await capture(window.getByTestId('settings-overlay'), 'settings-git');
    await app.closeSettings();

    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    await window
      .getByTestId('plugins-management-section-mcp')
      .locator('tr', { hasText: MCP_SERVER_NAME })
      .getByTestId('mcp-server-edit-button')
      .click();
    const dialog = window.getByRole('dialog', { name: 'Edit MCP server' });
    await expect(dialog.getByPlaceholder('My MCP server')).toHaveValue(
      MCP_SERVER_NAME,
    );
    await window.mouse.move(0, 0);
    await capture(dialog, 'dialog-edit-mcp-server');
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await window.getByTestId('plugins-management-back').click();
    await expect(window.getByTestId('plugins-management-view')).toBeHidden();

    await app.openEnvironmentsSettings();
    const environments = window.getByTestId('settings-tab-environment');
    await environments.getByTestId('environments-new-environment').click();
    await environments
      .getByTestId('environments-name-input')
      .fill('Staging defaults');
    await environments.getByTestId('environment-editor-add-row').click();
    await environments
      .locator('input[data-testid^="environment-editor-key-"]')
      .last()
      .fill('API_BASE_URL');
    await environments
      .locator('[data-testid^="environment-editor-value-"]')
      .last()
      .fill('https://staging.example.test');
    await window.mouse.move(0, 0);
    await window.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await capture(environments, 'environments-editor');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

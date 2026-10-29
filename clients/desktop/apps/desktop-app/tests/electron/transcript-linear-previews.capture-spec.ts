// @capture-keep: transcript Linear inline titles and preview card states for PR visual evidence
// @capture-reference: apps/desktop-app/tests/electron/transcript-linear-previews.spec.mjs
// Run with: pnpm run test:electron:captures:built transcript-linear-previews.capture-spec.ts
// Color modes: run normally for light, then append `--dark-mode` for dark.
// Stages: LINEAR_PREVIEWS_STAGE=before against the unchanged base build
// captures the plain transcript only; the default `after` stage captures every
// preview state on this branch's build. Early access stays off throughout.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

// Transcript Linear previews, enabled by default. Visual evidence with Early
// access off: Linear not connected (ordinary transcript), connected with a
// known team catalog (icon + ID + clipped title inline), a narrow transcript,
// the card on pointer hover and keyboard focus, and an inaccessible issue.
// Deterministic: seeded chat, the shared GraphQL mock, no agents or network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'linear-previews-capture';
const TOKEN = 'lin_api_capture_reference_previews';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(
  repoRoot,
  '.playwright',
  'linear-transcript-previews',
);

const ASSISTANT_TEXT = [
  'CAN-42 still needs visual evidence, and ECW-7 ships after it. FOO-9 is not one of your teams.',
  '',
  'Raw link: https://linear.app/acme/issue/CAN-42 — or [the design ticket](https://linear.app/acme/issue/ECW-7).',
  '',
  'CAN-404 belongs to a team you cannot read, and `CAN-43` in code stays literal.',
].join('\n');

function seed(userDataDir: string): void {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Linear previews',
        messages: [
          {
            id: 'capture-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'What is left on CAN-42?' }],
            timestamp: Date.parse('2026-10-01T10:00:00.000Z'),
          },
          {
            id: 'capture-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: ASSISTANT_TEXT }],
            timestamp: Date.parse('2026-10-01T10:00:05.000Z'),
          },
        ],
      },
    ],
  });
}

// The capture runner seeds the app's color preference from `--dark-mode`.
const COLOR_MODE =
  process.env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : 'light';
const STAGE =
  process.env.LINEAR_PREVIEWS_STAGE === 'before' ? 'before' : 'after';

async function capture(window: Page, name: string): Promise<void> {
  await window.screenshot({
    path: path.join(captureDir, `${name}-desktop-${STAGE}-${COLOR_MODE}.png`),
  });
}

async function hoverCard(reference: Locator, window: Page): Promise<void> {
  await window.mouse.move(0, 0);
  await reference.hover();
  await expect(window.getByRole('tooltip')).toBeVisible();
  await expect(window.getByRole('tooltip')).not.toContainText('Loading');
}

test('capture Linear transcript preview states', async () => {
  test.setTimeout(120_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-linear-previews-capture-'),
  );
  seed(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, TOKEN, {
    linear: {
      previewTeams: [
        { id: 'team_can', key: 'CAN', name: 'Canopy' },
        { id: 'team_ecw', key: 'ECW', name: 'Ecommerce' },
      ],
      issues: [
        {
          id: 'iss_can_42',
          identifier: 'CAN-42',
          title:
            'Preview Linear tickets in chat transcripts with the identifier, an inline icon and a clipped title',
          description:
            'Show a compact card with the title, a short description, and the status, assignee, and project when someone hovers or focuses an issue reference.',
          url: 'https://linear.app/acme/issue/CAN-42/preview-linear-tickets',
          updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          state: { name: 'In Review' },
          assignee: { name: 'Rowan Doe', displayName: 'Rowan' },
          project: { name: 'Canopy desktop' },
        },
        {
          id: 'iss_ecw_7',
          identifier: 'ECW-7',
          title: 'Checkout copy',
          url: 'https://linear.app/acme/issue/ECW-7/checkout-copy',
          state: { name: 'Todo' },
        },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
    const chat = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(chat).toContainText('still needs visual evidence');
    await capture(window, '00-transcript');
    if (STAGE === 'before') return;
    const references = chat.getByTestId('linear-reference');
    // Not connected: the transcript is ordinary, with no icons.
    await expect(references).toHaveCount(0);
    await capture(window, '01-not-connected');

    await window.evaluate(
      (token: string) => window.api.saveLinearToken(token),
      TOKEN,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:linear-connection-changed')),
    );
    await expect(references).toHaveText([
      /^CAN-42: Preview Linear tickets/,
      /^CAN-42: Preview Linear tickets/,
      'ECW-7: Checkout copy',
      /^CAN-42: Preview Linear tickets/,
      'the design ticket',
      'CAN-404',
    ]);
    await capture(window, '02-inline-titles');

    await hoverCard(references.nth(1), window);
    await expect(window.getByTestId('linear-issue-preview-card')).toContainText(
      'Preview Linear tickets',
    );
    await capture(window, '03-loaded-hover');

    await window.mouse.move(0, 0);
    await window.keyboard.press('Shift');
    await references.nth(2).focus();
    await expect(window.getByTestId('linear-issue-preview-card')).toBeVisible();
    await capture(window, '04-loaded-keyboard-focus');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await references.nth(2).blur();

    await hoverCard(references.nth(5), window);
    await expect(window.getByRole('tooltip')).toContainText(
      'Preview unavailable',
    );
    await capture(window, '05-unavailable');
    await window.mouse.move(0, 0);

    await window.setViewportSize({ width: 760, height: 820 });
    await expect(references.nth(1)).toBeVisible();
    await capture(window, '06-narrow');
  } finally {
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

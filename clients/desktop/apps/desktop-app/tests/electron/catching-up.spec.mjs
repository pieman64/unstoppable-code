// Catching up: while a Codex chat's durable transcript write is held, main is
// behind the provider. The already open composer says so and how far behind it
// is, keeps the running turn's Stop, and offers no action; releasing the write
// drains the burst in order and clears the notice. See phase 15c of
// docs/planning/2026-10-08-turn-state-remediation.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { holdProviderTranscriptWrite } from './seeders/holdProviderTranscriptWrite.mjs';
import {
  closeFixture,
  createFixture,
  seedPreferences,
} from './codexPipelineRuntime.mjs';

const HELD_MARKER = 'CANOPY-EVENT-PRESSURE-00';
const LAST_MARKER = 'CANOPY-EVENT-PRESSURE-47';
const WORKTREE_ID = 'demo-main';
const PROJECT_ID = 'demo-ts-pnpm-vite';
const CHAT_ID = 'catching-up-chat';

test('a held Codex backlog shows Catching up and clears when the write is released', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-catching-up-'),
  );
  // Only the pressure prompt triggers the 48-item burst.
  const fixture = createFixture('event-pressure', 'CANOPY-CATCHING-UP-REPLY');
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Catching up chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: fixture.env,
  });
  let barrier;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const row = window
      .locator(
        `[data-testid="worktree-row"][data-project-id="${PROJECT_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
      )
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    const composerRoot = panel.locator('[data-chat-composer-root]');
    await expect(composerRoot).toBeVisible();

    // Hold the burst's first durable transcript write with the composer open.
    barrier = await holdProviderTranscriptWrite(electronApp, {
      userDataDir,
      workspaceId: PROJECT_ID,
      scopeId: WORKTREE_ID,
      marker: HELD_MARKER,
    });
    await composerRoot.getByRole('textbox').fill('Report pressure status.');
    await composerRoot.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(async () => (await barrier.read())?.reached, { timeout: 45_000 })
      .toBe(true);

    // Past the five-second threshold main reports that it is behind, while the
    // write is still held. The notice has no action and Stop stays.
    const notice = panel.getByTestId('catching-up-notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('Catching up');
    await expect(notice).toContainText('behind the agent');
    await expect(notice.getByRole('button')).toHaveCount(0);
    await expect(
      composerRoot.getByTestId('chat-stop-generation'),
    ).toBeVisible();
    await expect(window.getByTestId('stuck-agent-warning')).toHaveCount(0);
    expect((await barrier.read())?.reached).toBe(true);

    // Releasing the write drains the burst and clears the notice.
    await barrier.release();
    await expect(
      panel.getByText(LAST_MARKER, { exact: false }).first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
  } finally {
    try {
      await barrier?.stop();
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  }
});

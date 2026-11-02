// A delegated task's child transcript renders the same from its parent
// chat's delegate log (`transcriptStore: 'chat-log-v1'`) as from legacy
// child rows, including after the renderer reloads and has no live snapshot
// to fall back on. Deterministic: seeded history, no live agent.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DELEGATION_LOG_FIXTURE,
  seedDelegationTranscriptChat,
  writeDelegationLog,
} from './seeders/seedDelegationTranscriptLog.mjs';

/** Expands the completed turn's steps and the delegate card. */
async function openDelegateCard(window) {
  const panel = window.getByTestId('panel-content-chat');
  await expect(
    panel.getByText('The delegate found one actionable issue'),
  ).toBeVisible({ timeout: 30_000 });
  const card = panel.getByTestId('chat-delegated-agent');
  await expect(async () => {
    const collapsedSteps = panel.getByRole('button', {
      name: /^Agent steps:/,
      expanded: false,
    });
    if (await collapsedSteps.count())
      await collapsedSteps.first().click({ timeout: 2_000 });
    await expect(card).toBeVisible({ timeout: 2_000 });
    const expand = card.getByRole('button', { name: 'Expand delegated task' });
    if (await expand.count()) await expand.first().click({ timeout: 2_000 });
    const thought = card.getByRole('button', { name: /^Thought/ });
    if ((await thought.getAttribute('aria-expanded')) !== 'true')
      await thought.click();
    await expect(
      card.getByText(DELEGATION_LOG_FIXTURE.reasoning).first(),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return card;
}

/** The child steps show in the card; the final answer is its result. */
async function expectChildren(card) {
  await expect(
    card.getByText(DELEGATION_LOG_FIXTURE.reasoning).first(),
  ).toBeVisible();
  await expect(card.getByText('Read', { exact: true }).first()).toBeVisible();
  await card.getByRole('button', { name: 'Show result' }).click();
  await expect(
    card.getByText(DELEGATION_LOG_FIXTURE.finding).first(),
  ).toBeVisible();
}

for (const logged of [false, true]) {
  test(`renders a delegate's children from ${logged ? 'the delegate log' : 'legacy child rows'}`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-delegation-transcript-log-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedDelegationTranscriptChat({ userDataDir, logged });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Inspect individual steps while retaining the Clean chat look.
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'detailed' }),
      );
      await app.openMainPage();
      await app.selectWorktree(DELEGATION_LOG_FIXTURE.worktreeId);
      if (logged) {
        // Chat storage is rebuilt from the seeded chat on its first load, so
        // the delegate log is written after it, and the renderer reloaded so
        // the card reads it.
        writeDelegationLog(userDataDir);
        await window.reload();
        await app.waitForShell({ timeout: 30_000 });
        // Inspect individual steps while retaining the Clean chat look.
        await window.evaluate(() =>
          window.api.savePreferences({ chatDetail: 'detailed' }),
        );
        await app.openMainPage();
        await app.selectWorktree(DELEGATION_LOG_FIXTURE.worktreeId);
      }

      await expectChildren(await openDelegateCard(window));

      // A reloaded renderer has no live snapshot: a logged card reads its
      // children from the delegate log again.
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      // Inspect individual steps while retaining the Clean chat look.
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'detailed' }),
      );
      await app.openMainPage();
      await app.selectWorktree(DELEGATION_LOG_FIXTURE.worktreeId);
      await expectChildren(await openDelegateCard(window));
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

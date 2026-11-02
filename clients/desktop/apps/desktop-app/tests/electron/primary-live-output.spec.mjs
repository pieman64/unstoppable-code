// Desktop control for phase 16e: primary tool results that arrive live, from
// a real (fake-provider) Claude turn, open their full output while the turn
// is still running. The Portal flow asserts the same results.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { createDelegationInference } from './delegationRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { baseManagedDelegationPreferences } from './fixtures/delegation-capabilities/helpers.mjs';
import { createPrimaryLiveOutputScript } from './fixtures/delegation-stream-script.mjs';
import { writeJson } from './seeders/index.mjs';
import {
  PRIMARY_LIVE_SENTINELS,
  preparePrimaryLiveOutput,
} from './seeders/primaryLiveOutputFixture.mjs';
import { expectPrimaryLiveResults } from './primaryLiveOutput.mjs';

const PROJECT = 'demo-ts-pnpm-vite';
const WORKTREE = 'demo-main';
const SCOPE = { projectId: PROJECT, worktreeId: WORKTREE };

// The n-th primary Read card, outside every delegation card.
async function expandRead(panel, index) {
  const tool = panel
    .locator(
      '[data-tool-name="Read"]:not([data-testid="chat-delegated-agent"] *)',
    )
    .nth(index);
  await expect(async () => {
    const collapsed = panel.getByRole('button', {
      name: /^Agent steps:/,
      expanded: false,
    });
    if (await collapsed.count())
      await collapsed.first().click({ timeout: 2000 });
    await expect(tool).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });
  await tool.getByRole('button').first().click();
  return tool;
}

test('live primary results open their full output during the turn', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-primary-'));
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  writeJson(
    path.join(userDataDir, 'preferences.json'),
    baseManagedDelegationPreferences(),
  );
  const fixture = preparePrimaryLiveOutput({
    userDataDir,
    worktreePath: demo.workspaces[0].worktreePath,
    workspaceId: PROJECT,
    worktreeId: WORKTREE,
  });
  const turn = createPrimaryLiveOutputScript(fixture);
  const inference = await createDelegationInference({
    parent: 'claude',
    child: 'claude',
    mode: 'foreground',
    caseId: 'primary-live',
    script: turn.script,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CHAT_FORMAT4: '1',
      CANOPY_MOCK_LLM_BASE_URL: inference.url,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Inspect individual steps while retaining the Clean chat look.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE);
    const tab = window.locator(`[data-chat-id="${fixture.chatId}"]`).first();
    if (await tab.count()) await tab.click();
    const panel = window.getByTestId('panel-content-chat');
    await window
      .getByRole('textbox')
      .first()
      .fill(`[${inference.parentMarker}] Read the two evidence files.`);
    await window.getByRole('button', { name: 'Send message' }).click();

    await turn.waitForHeld('stored');
    turn.release('stored');
    await turn.waitForHeld('inline');
    await expectPrimaryLiveResults(window, SCOPE, fixture.chatId, ['stored']);
    const stored = await expandRead(panel, 0);
    await stored.getByTestId('chat-tool-output-open').click();
    await window.getByTestId('chat-tool-output-next').click();
    await expect(
      window.getByText(PRIMARY_LIVE_SENTINELS.stored, { exact: false }).last(),
    ).toBeVisible();

    turn.release('inline');
    await turn.waitForHeld('final');
    await expectPrimaryLiveResults(window, SCOPE, fixture.chatId, [
      'stored',
      'inline',
    ]);
    const inline = await expandRead(panel, 1);
    await expect(
      inline.getByText(PRIMARY_LIVE_SENTINELS.inline, { exact: false }),
    ).toBeVisible();
    turn.release('final');
    await expect(panel.getByText(inference.integrated)).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    turn.releaseAll();
    await closeCanopy(electronApp, userDataDir);
    await inference.close();
  }
});

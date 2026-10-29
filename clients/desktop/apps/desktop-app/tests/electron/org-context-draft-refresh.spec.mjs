import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  ORG_CONTEXT_WORKSPACE,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

test('an organization rollout refresh keeps the open worktree and its unsent draft', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_org_context_draft_refresh';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-context-draft-refresh-'),
  );
  const worktreeId = 'context-draft';
  seedOrgContextScoping(userDataDir, { organizationWorktreeIds: [worktreeId] });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const row = window
      .getByTestId('worktree-row')
      .and(
        window.locator(
          `[data-project-id="${ORG_CONTEXT_WORKSPACE}"][data-worktree-id="${worktreeId}"]`,
        ),
      );
    await row.click();
    const main = window.getByTestId('page-main');
    const topBar = main.getByTestId('worktree-top-bar');
    const editor = main.locator(
      '[contenteditable="true"][data-slate-editor="true"]:visible',
    );
    await expect(topBar).toBeVisible();
    await expect(editor).toHaveCount(1);
    await editor.fill('Keep this draft while my account refreshes');
    const [flags, context] = await window.evaluate(() =>
      Promise.all([
        window.api.featureFlags.getSnapshot(),
        window.api.workspaceContext.get(),
      ]),
    );
    for (const step of ['disable', 'personal', 'enable', 'organization']) {
      // The two main-owned subscriptions deliver independently. Reproduce the
      // Personal projection at the same revision before the org broadcast returns.
      await electronApp.evaluate(
        ({ BrowserWindow }, { step, flags, context }) => {
          const target = BrowserWindow.getAllWindows().find(
            (candidate) => !candidate.isDestroyed(),
          );
          if (!target) throw new Error('fixture main window is missing');
          if (step === 'disable' || step === 'enable') {
            target.webContents.send('feature-flags:snapshot-changed', {
              ...flags,
              values: {
                ...flags.values,
                'canopy-shared-org-projects-enabled': step === 'enable',
              },
            });
          } else {
            target.webContents.send('workspace-context:changed', {
              ...context,
              context:
                step === 'personal' ? { kind: 'personal' } : context.context,
              reason: 'organizations',
            });
          }
        },
        { step, flags, context },
      );
      // Reading after the IPC round trip lets the renderer process the push.
      await window.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      await expect(topBar).toBeVisible();
      await expect(editor).toHaveText(
        'Keep this draft while my account refreshes',
      );
      await expect(editor).toBeFocused();
      await expect(main.getByTestId('home-surface')).toHaveCount(0);
    }
    await editor.press('End');
    await editor.pressSequentially(' and keep typing');
    await expect(editor).toHaveText(
      'Keep this draft while my account refreshes and keep typing',
    );
    // Intentional switches still clear the panel; returning restores the draft.
    await selectWorkspaceContext(window, 'personal');
    await expect(topBar).toHaveCount(0);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(topBar).toBeVisible();
    await expect(editor).toHaveText(
      'Keep this draft while my account refreshes and keep typing',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

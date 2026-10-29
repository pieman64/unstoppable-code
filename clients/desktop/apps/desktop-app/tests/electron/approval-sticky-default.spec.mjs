import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// CAN-3055 — the in-chat approval-mode choice becomes the surface default.
//
// Changing the mode from the composer picker writes back to the per-surface
// `PreferencesData.approvalDefaults` entry, silently, so every chat created
// afterwards on that surface opens in the chosen mode. Chats that already
// carry an explicit `approvalMode` are never rewritten — tab creation stamps
// the resolved default at birth (`applyResolvedApprovalModeForNewTab`), so a
// later default change cannot reach back into them.
//
// This spec drives the whole loop through the real UI:
//   Full default -> switch chat 1 to Ask -> chat 2 opens in Ask ->
//   chat 1 is still Ask (the user's own choice, not re-resolved) and the
//   pre-existing seeded chat is untouched -> Settings reflects the new default
//   -> a sticky App Advisor change updates the already-mounted Settings view.
//
// The second test covers the disclosure half of CAN-3055: Full Access is the
// product default, so a FRESH profile is exactly the population that has never
// been told agents act without asking. `approvalsUpgradeNoticeDismissed`
// therefore defaults to `false` and the one-time explainer must actually
// appear, then stay dismissed once dismissed.
//
// Determinism: no live agents, no network. A seeded demo workspace, a seeded
// worktree chat, and renderer-driven preference writes only.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SEEDED_TAB_ID = 'sticky-default-seeded-chat';

function readApprovalDefaults(userDataDir) {
  try {
    return JSON.parse(
      readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
    ).preferences?.approvalDefaults;
  } catch {
    return undefined;
  }
}

const chatTabsLocator = (window) =>
  window.locator(
    '[data-testid^="panel-tab-panel-chat-"]:not([data-testid*="panel-tab-close"])',
  );

async function dismissApprovalsUpgradeNoticeIfPresent(window) {
  const dismiss = window.getByTestId('approvals-upgrade-notice-dismiss');
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
    await expect(window.getByTestId('approvals-upgrade-notice')).toHaveCount(0);
  }
}

test.describe('Sticky approval default', () => {
  test('an in-chat switch to Ask becomes the default for new chats without rewriting existing ones', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-sticky-default-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: SEEDED_TAB_ID,
      tabs: [
        {
          id: SEEDED_TAB_ID,
          title: 'Sticky Default Coverage',
          providerType: 'claude',
          // Explicitly stamped, exactly as tab creation stamps every chat
          // since `applyResolvedApprovalModeForNewTab` shipped. This is what
          // makes the later default change unable to reach back into it; an
          // unstamped legacy tab would resolve lazily and follow the default.
          approvalMode: 'full-access',
        },
      ],
    });

    let launched;
    try {
      launched = await launchCanopy({ userDataDir });
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await dismissApprovalsUpgradeNoticeIfPresent(window);

      const picker = window.getByTestId('approval-mode-picker');
      const chatTabs = chatTabsLocator(window);
      await expect(chatTabs).toHaveCount(1);
      const seededTabTestId = await chatTabs
        .first()
        .getAttribute('data-testid');
      if (!seededTabTestId) throw new Error('Seeded chat tab is missing');

      // A fresh profile starts at Full Access on every surface.
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );

      // Chat 1: created while the default is still Full, so it is stamped Full.
      await window.getByTestId('panel-add-tab-group-chat').click();
      await expect(chatTabs).toHaveCount(2);
      const firstTabTestId = await chatTabs.last().getAttribute('data-testid');
      if (!firstTabTestId) throw new Error('First added chat tab is missing');
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );

      // The user de-escalates chat 1 to Ask.
      await picker.click();
      await window.getByTestId('approval-mode-option-ask').click();
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );

      // The write-back lands on the worktree surface only, leaving the other
      // two surfaces at the product default.
      await expect
        .poll(() => readApprovalDefaults(userDataDir)?.worktree, {
          timeout: 15_000,
        })
        .toBe('ask');
      expect(readApprovalDefaults(userDataDir)?.cowork).toBe('full-access');
      expect(readApprovalDefaults(userDataDir)?.appAdvisor).toBe('full-access');
      await expect(
        window.evaluate(
          ([projectId, worktreeId]) =>
            window.api.approvals.getResolvedDefault({ projectId, worktreeId }),
          [WORKSPACE_ID, WORKTREE_ID],
        ),
      ).resolves.toBe('ask');

      // Chat 2 is created after the write-back, so it opens in Ask.
      await window.getByTestId('panel-add-tab-group-chat').click();
      await expect(chatTabs).toHaveCount(3);
      const secondTabTestId = await chatTabs.last().getAttribute('data-testid');
      if (!secondTabTestId) throw new Error('Second added chat tab is missing');
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );

      // The chat the user changed keeps the mode they chose...
      await window.getByTestId(firstTabTestId).click();
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );

      // ...and the chat that predates the change is not retroactively lowered.
      await window.getByTestId(seededTabTestId).click();
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );

      // Open the second-window App Advisor before Settings so its composer can
      // change the App Advisor surface while the Settings view stays mounted.
      const advisor = await app.openAppAdvisorWindow(launched.electronApp);
      await dismissApprovalsUpgradeNoticeIfPresent(advisor);
      const advisorPicker = advisor.getByTestId('approval-mode-picker');
      await expect(advisorPicker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );

      // The silent worktree write-back is visible where the user can change it
      // back, while the other surface defaults remain at Full Access.
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();
      await expect(
        window.getByTestId('settings-approvals-section'),
      ).toBeVisible();
      await expect(window.getByTestId('approval-default-worktree')).toHaveValue(
        'ask',
      );
      await expect(window.getByTestId('approval-default-cowork')).toHaveValue(
        'full-access',
      );
      await expect(
        window.getByTestId('approval-default-app-advisor'),
      ).toHaveValue('full-access');

      // A sticky change from the App Advisor BrowserWindow broadcasts the new
      // canonical preferences to every window. The already-mounted Settings
      // tab must update instead of retaining its mount-time Full Access value.
      await advisorPicker.click();
      await advisor.getByTestId('approval-mode-option-ask').click();
      await expect
        .poll(() => readApprovalDefaults(userDataDir)?.appAdvisor, {
          timeout: 15_000,
        })
        .toBe('ask');
      await expect(
        window.getByTestId('approval-default-app-advisor'),
      ).toHaveValue('ask');
    } finally {
      if (launched) {
        await closeCanopy(launched.electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('a fresh profile is told once that agents act without asking, and the dismissal sticks', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-disclosure-'),
    );
    // No preferences.json is seeded, so this is a genuinely fresh profile.
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: SEEDED_TAB_ID,
      tabs: [
        {
          id: SEEDED_TAB_ID,
          title: 'Approvals Disclosure Coverage',
          providerType: 'claude',
          approvalMode: 'full-access',
        },
      ],
    });

    let launched;
    try {
      launched = await launchCanopy({
        userDataDir,
        freshApprovalsUpgradeNotice: true,
      });
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // The whole point of the fix: a new install actually sees the explainer.
      const notice = window.getByTestId('approvals-upgrade-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Agents can act without asking');

      // And dismissing it is durable, not per-session.
      await window.getByTestId('approvals-upgrade-notice-dismiss').click();
      await expect(notice).toHaveCount(0);
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              window.api
                .loadPreferences()
                .then((prefs) => prefs.approvalsUpgradeNoticeDismissed),
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      if (launched) {
        await closeCanopy(launched.electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });
});

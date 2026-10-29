import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat, writeJson } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Chat watcher (eye) button — the new "watch this chat" surface added on this
// branch: ChatWatcherButton (turn-timer + terminal floating bar) → the
// app-level WatcherModalHost → WatcherRecipientPicker + the WatcherManagementModal
// add / edit-followup / delete flow.
//
// Determinism: the eye button only renders while the chat's turn timer is
// "active" — `isActiveTimer` in TurnGroupRenderer is `timerBlock.completedAt ==
// null`. A live turn is one way to get that, but a PAUSED turn timer (`pausedAt`
// set, `completedAt: null`) also satisfies it and, unlike a live/open timer, is
// preserved verbatim on load (`completePersistedTurnTimers` only force-completes
// timers with `completedAt === null && pausedAt == null` — see
// turn-timer-render.spec.mjs). So we seed a worktree chat whose single turn
// group ends in a paused timer; the eye button renders without any live turn.
//
// Recipient: the WatcherModalHost add picker offers only App Advisor chats
// (`useWatcherRecipientGroups()` with no worktree option), so we seed one App
// Advisor chat tab at `app-workspaces/app-advisor/chats/global.json` — the
// canonical persisted location the main window lazily hydrates from.
//
// The app build is E2E-gated so the watcher scheduler never fires, but the
// create/update/delete/list IPC handlers operate on the persisted file + the
// renderer store, so the full modal flow works end to end without delivery. The
// modal's `holdChatFiring` on open relaxes the "must await a future event"
// creation guard, so a watcher can be added against the (paused) chat.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 't1';
const ADVISOR_CHAT_ID = 'advisor-1';
const ADVISOR_CHAT_TITLE = 'Advisor recipient';

const T = Date.parse('2026-04-10T12:00:00.000Z');

// One turn group: user → assistant → system(turn_timer). A paused timer keeps
// `isActiveTimer` true so the eye button renders next to the (session-less, so
// hidden) fork action.
const PAUSED_TIMER_MESSAGES = [
  {
    id: 'turn-1-user',
    role: 'user',
    blocks: [{ type: 'text', text: 'Kick off a long task.' }],
    timestamp: T,
  },
  {
    id: 'turn-1-assistant',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Working on it…' }],
    timestamp: T + 5_000,
  },
  {
    id: 'turn-1-timer',
    role: 'system',
    blocks: [
      {
        type: 'turn_timer',
        startedAt: T,
        pausedAt: T + 30_000,
        completedAt: null,
      },
    ],
    timestamp: T + 6_000,
  },
];

function seedAppAdvisorChat(userDataDir) {
  writeJson(
    path.join(
      userDataDir,
      'app-workspaces',
      'app-advisor',
      'chats',
      'global.json',
    ),
    {
      version: 1,
      activeTabId: ADVISOR_CHAT_ID,
      tabs: [
        {
          id: ADVISOR_CHAT_ID,
          title: ADVISOR_CHAT_TITLE,
          createdAt: '2026-04-10T12:00:00.000Z',
          messages: [],
        },
      ],
    },
  );
}

test('chat watcher button opens the modal and configures a chat watcher', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-watcher-button-'),
  );

  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Chat', messages: PAUSED_TIMER_MESSAGES }],
  });
  seedAppAdvisorChat(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();

    // The seeded paused timer renders as an active turn timer, so the eye button
    // is shown. It has no watchers yet → the count sub-element is absent.
    const eyeButton = window.getByTestId(`chat-watcher-button-${CHAT_ID}`);
    await expect(eyeButton).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId(`chat-watcher-button-${CHAT_ID}-count`),
    ).toHaveCount(0);
    // CAN-4278: in the footer row the idle eye takes the muted footer tone,
    // read from a probe element carrying the same token.
    const [idleColor, mutedColor] = await eyeButton.evaluate((el) => {
      const probe = document.createElement('span');
      probe.className = 'fg-quaternary';
      el.parentElement?.appendChild(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).color, muted];
    });
    expect(idleColor).toBe(mutedColor);
    await expect(eyeButton).not.toHaveAttribute('data-attention', /.*/);

    // Open the app-level WatcherModalHost modal.
    await eyeButton.click();
    const modal = window.getByTestId('watcher-management-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Chat watchers');
    await expect(window.getByTestId('watcher-management-empty')).toBeVisible();
    await expect(
      window.getByTestId('watcher-management-add-section'),
    ).toBeVisible();

    // Pick the seeded App Advisor recipient from the grouped dropdown.
    await window
      .getByTestId('watcher-management-add-recipient-trigger')
      .click();
    await expect(
      window.getByTestId('watcher-management-add-recipient-menu'),
    ).toBeVisible();
    await window
      .getByTestId(`watcher-management-add-recipient-option-${ADVISOR_CHAT_ID}`)
      .click();
    await expect(
      window.getByTestId('watcher-management-add-recipient-trigger'),
    ).toContainText(ADVISOR_CHAT_TITLE);

    // Optional follow-up, then submit the add.
    await window
      .getByTestId('watcher-management-add-followup')
      .fill('Summarize the result for me.');
    await window.getByTestId('watcher-management-add-submit').click();

    // The new watcher row hydrates from the create IPC + store broadcast.
    const row = window
      .locator('[data-testid^="watcher-management-row-"]')
      .first();
    await expect(row).toBeVisible();
    await expect(
      window.locator('[data-testid^="watcher-management-row-"]'),
    ).toHaveCount(1);
    await expect(row).toContainText(ADVISOR_CHAT_TITLE);

    // The eye button now reflects one watcher (the count sub-element renders even
    // while the modal overlays the button).
    await expect(
      window.getByTestId(`chat-watcher-button-${CHAT_ID}-count`),
    ).toHaveText('1');
    // CAN-4278: an armed watcher keeps its info colour in the footer row
    // instead of the muted icon look.
    await expect(eyeButton).toHaveAttribute('data-attention', '');
    const armedColor = await eyeButton.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(armedColor).not.toBe(idleColor);
    // The armed pill keeps its own width, so the eye and count stay inside it.
    expect(
      await eyeButton.evaluate((el) => el.scrollWidth <= el.clientWidth),
      'armed watcher content fits its pill',
    ).toBe(true);

    // Derive the backend-generated id for the row-scoped controls.
    const rowTestId = await row.getAttribute('data-testid');
    const watcherId = rowTestId.replace('watcher-management-row-', '');

    await window.screenshot({
      path: testInfo.outputPath('chat-watcher-added.png'),
    });

    // --- Edit the follow-up instruction inline (allowEditFollowUp path) ------
    await window
      .getByTestId(`watcher-management-edit-followup-button-${watcherId}`)
      .click();
    const editTextarea = window.getByTestId(
      `watcher-management-edit-followup-${watcherId}`,
    );
    await expect(editTextarea).toBeVisible();
    await editTextarea.fill('Updated: post a one-line summary.');
    await window
      .getByTestId(`watcher-management-edit-save-${watcherId}`)
      .click();
    await expect(row).toContainText('Updated: post a one-line summary.');

    // --- Delete the watcher (two-click confirm) -----------------------------
    await window.getByTestId(`watcher-management-delete-${watcherId}`).click();
    await window
      .getByTestId(`watcher-management-confirm-delete-${watcherId}`)
      .click();
    await expect(
      window.locator('[data-testid^="watcher-management-row-"]'),
    ).toHaveCount(0);
    await expect(window.getByTestId('watcher-management-empty')).toBeVisible();

    // The eye button count sub-element is gone once no watchers remain.
    await expect(
      window.getByTestId(`chat-watcher-button-${CHAT_ID}-count`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

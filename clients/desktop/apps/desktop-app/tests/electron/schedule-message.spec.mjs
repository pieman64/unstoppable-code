import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedAutomations,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Doc 2 — Spec 8 / Doc 14: `schedule-message.spec.mjs`.
//
// Targets PR 832: scheduling a chat message to send later instead of sending it
// now. The flow spans two components:
//   - ChatInput.tsx
//       * `chat-input-plus-button` opens the composer action menu, whose
//         `chat-input-schedule-button` row opens the modal (only on a live
//         native worktree composer outside terminal mode — `worktreeChatTarget`
//         must resolve, which a seeded worktree chat tab provides).
//       * `chat-input-scheduled-send-chip`    the chip beside + once a future
//         schedule is staged (`tab.scheduledSendDraft`). Its
//         `data-scheduled-send-state` turns `failed` ONLY when the automation
//         create call FAILS at actual send time (`handleScheduledSend`), NOT
//         on past-time validation, which the modal owns (see below).
//       * `chat-input-scheduled-send-pill`    the chip's body: when it sends
//         ("Tomorrow 9:00 AM"); clicking it re-opens the modal to edit.
//       * `chat-input-scheduled-send-clear`   the chip's X — clears the staged
//         schedule.
//   - ScheduleMessageModal.tsx
//       * `schedule-message-modal` (root, role="dialog"), `schedule-message-date`,
//         `schedule-message-time`, `schedule-message-save` ("Set schedule"),
//         `schedule-message-cancel`.
//       * Save validation (`handleSave`): if date/time are missing OR the chosen
//         `${date}T${time}:00` parses to NaN or `<= Date.now()`, it sets the
//         modal's internal error and renders it as the shared FieldError
//         under the field it is about ("Choose a future time."), with that
//         field marked aria-invalid, WITHOUT calling `onSave`. So a past time
//         keeps the modal open, shows the field error, and stages nothing.
//
// TWO-PHASE SEEDING: a real git worktree (`demo-ts-pnpm-vite` / `demo-main`,
// plain `ts-pnpm-vite` fixture) plus a seeded Claude chat tab so the chat panel
// mounts and `worktreeChatTarget` resolves, which is what gates the schedule
// button/pill onto the live composer.
//
// DETERMINISM: the harness runs `TZ=UTC`. The app clock is the host clock, so we
// derive future/past instants from `Date.now()` at runtime and format them into
// the native date/time inputs in UTC. We never wait for a scheduled send to
// actually fire (it is wall-clock/time-based and out of scope); we assert the
// staged-schedule state, the clear action, and the past-time validation.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const TAB_ID = 'schedule-tab-1';
const SEEDED_TEXT = 'Seeded assistant reply for the schedule-message spec.';
const ADVISOR_CHAT_ID = 'advisor-schedule-chat';
const ADVISOR_ACTIVITY_ID = 'advisor-scheduled-message';
const ADVISOR_SCHEDULED_TEXT = 'Seeded advisor scheduled message.';

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

// Format a Date into the `<input type="date">` (YYYY-MM-DD) and
// `<input type="time">` (HH:MM) values, in UTC. The harness forces TZ=UTC and
// the modal builds its candidate from local time, so UTC field values line up
// with the UTC host clock the modal validates against.
function toDateTimeFields(date) {
  return {
    date: `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(
      date.getUTCDate(),
    )}`,
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
  };
}

async function seedAndLaunch({ beforeLaunch } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-schedule-msg-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: TAB_ID,
        title: 'Schedule Message Chat',
        blocks: [{ type: 'text', text: SEEDED_TEXT }],
      },
    ],
  });
  beforeLaunch?.(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);

  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();

  return { electronApp, userDataDir, window };
}

const RECURRING_ACTIVITY_ID = 'code-recurring-session-prompt';
const RECURRING_ACTIVITY_NAME = 'Weekly runner savings report';
const RECURRING_PROMPT = 'Seeded recurring prompt for the code chat.';
const ONE_TIME_ACTIVITY_ID = 'code-one-time-session-prompt';
const ONE_TIME_PROMPT = 'Seeded one-time prompt for the code chat.';

// The next Monday 09:00 local that is at least an hour away, matching the
// seeded `0 9 * * 1` cron so the notice shows a cadence and a next run that
// agree, and the run never lands inside the test window.
function nextMondayAtNine() {
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  next.setDate(next.getDate() + ((1 - next.getDay() + 7) % 7));
  if (next.getTime() < Date.now() + 60 * 60 * 1000) {
    next.setDate(next.getDate() + 7);
  }
  return next.toISOString();
}

// One recurring (cron) and one one-time `worktree_session_prompt` automation
// on the seeded Code worktree chat.
function seedCodeChatAutomations(userDataDir) {
  const nextMonday = nextMondayAtNine();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const action = (prompt) => ({
    type: 'worktree_session_prompt',
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: TAB_ID,
    prompt,
    chatTitle: 'Schedule Message Chat',
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: RECURRING_ACTIVITY_ID,
        name: RECURRING_ACTIVITY_NAME,
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * 1', timezone: 'local' },
        action: action(RECURRING_PROMPT),
        nextRunAt: nextMonday,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        failureCount: 0,
      },
      {
        version: 1,
        id: ONE_TIME_ACTIVITY_ID,
        name: 'One-time code chat message',
        enabled: true,
        schedule: { kind: 'one_time', runAt: tomorrow, timezone: 'local' },
        action: { ...action(ONE_TIME_PROMPT), purpose: 'scheduled_send' },
        nextRunAt: tomorrow,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
}

function seedAppAdvisorScheduling(userDataDir) {
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
          title: 'Scheduled App Advisor chat',
          createdAt: '2026-07-20T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-5.5',
          messages: [],
        },
      ],
    },
  );

  const runAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: ADVISOR_ACTIVITY_ID,
        name: 'App Advisor scheduled message',
        enabled: true,
        schedule: { kind: 'one_time', runAt, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'app-advisor',
          worktreeId: 'global',
          chatId: ADVISOR_CHAT_ID,
          prompt: ADVISOR_SCHEDULED_TEXT,
          purpose: 'scheduled_send',
          chatTitle: 'Scheduled App Advisor chat',
        },
        nextRunAt: runAt,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
}

// Type a message into the Slate composer so the schedule flow has draft content
// to stage. The composer is the first role="textbox" inside the chat panel.
async function typeComposerMessage(window, text) {
  const composer = window.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill(text);
  await expect(window.getByText(text)).toBeVisible();
}

async function openScheduleMessage(window, composerScope = window) {
  await composerScope.getByTestId('chat-input-plus-button').click();
  await window.getByTestId('chat-input-schedule-button').click();
}

test.describe('schedule message to send later (832)', () => {
  test('schedule button opens the modal with date/time inputs and Set Schedule', async () => {
    const { electronApp, userDataDir, window } = await seedAndLaunch();
    try {
      await typeComposerMessage(window, 'Draft to schedule later.');

      // Schedule is offered from the live native worktree composer's + menu.
      await openScheduleMessage(window);

      const modal = window.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();
      await expect(window.getByTestId('schedule-message-date')).toBeVisible();
      await expect(window.getByTestId('schedule-message-time')).toBeVisible();
      await expect(window.getByTestId('schedule-message-save')).toBeVisible();

      // Cancel closes the modal and stages nothing.
      await window.getByTestId('schedule-message-cancel').click();
      await expect(modal).toBeHidden();
      await expect(
        window.getByTestId('chat-input-scheduled-send-pill'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('saving a future time stages the scheduled-send pill; clear removes it', async () => {
    const { electronApp, userDataDir, window } = await seedAndLaunch();
    try {
      await typeComposerMessage(window, 'Please run the build tomorrow.');

      await openScheduleMessage(window);
      const modal = window.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();

      // Tomorrow at the current minute — comfortably in the future regardless of
      // when the test runs. Derived from the host clock (the app's clock).
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const fields = toDateTimeFields(future);
      await window.getByTestId('schedule-message-date').fill(fields.date);
      await window.getByTestId('schedule-message-time').fill(fields.time);

      await window.getByTestId('schedule-message-save').click();

      // A future time is accepted: the modal closes, the message is staged (not
      // sent), and the scheduled-send pill appears. No error is surfaced.
      await expect(modal).toBeHidden();
      const pill = window.getByTestId('chat-input-scheduled-send-pill');
      await expect(pill).toBeVisible();
      // A day out reads as tomorrow, in a few words; the full moment is in
      // its accessible name.
      await expect(pill).toHaveText(/^Tomorrow \d{1,2}:\d{2}/);
      await expect(pill).toHaveAttribute('aria-label', /^Scheduled send, /);
      // The chip sits beside +.
      const chip = window.getByTestId('chat-input-scheduled-send-chip');
      await expect(chip).toHaveAttribute(
        'data-scheduled-send-state',
        'scheduled',
      );
      const box = window
        .locator('[data-chat-composer-root]:visible [data-composer-layout]')
        .first();
      const [plusRect, chipRect] = await Promise.all([
        box.getByTestId('chat-input-plus-button').boundingBox(),
        chip.boundingBox(),
      ]);
      expect(chipRect.x).toBeGreaterThan(plusRect.x + plusRect.width);
      expect(Math.abs(chipRect.y - plusRect.y)).toBeLessThan(1);

      // The X on the pill clears the staged schedule.
      await window.getByTestId('chat-input-scheduled-send-clear').click();
      await expect(
        window.getByTestId('chat-input-scheduled-send-pill'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a past time is rejected by the modal and stages nothing', async () => {
    const { electronApp, userDataDir, window } = await seedAndLaunch();
    try {
      await typeComposerMessage(window, 'This should not get scheduled.');

      await openScheduleMessage(window);
      const modal = window.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();

      // Yesterday — strictly in the past. `handleSave` rejects any candidate
      // `<= Date.now()` by setting the modal's internal error.
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const fields = toDateTimeFields(past);
      await window.getByTestId('schedule-message-date').fill(fields.date);
      await window.getByTestId('schedule-message-time').fill(fields.time);

      await window.getByTestId('schedule-message-save').click();

      // Past-time validation is owned by the modal: it stays open and shows
      // "Choose a future time." as the field error under the field it is
      // about, which is marked invalid (docs/design/forms.md). `onSave` is
      // never called, so nothing is staged, and no chip appears (a failed
      // chip is a different surface: automation create failure at real send
      // time).
      await expect(modal).toBeVisible();
      await expect(modal.getByText('Choose a future time.')).toBeVisible();
      await expect(modal.locator('input[aria-invalid="true"]')).toHaveCount(1);
      await expect(
        window.getByTestId('chat-input-scheduled-send-chip'),
      ).toHaveCount(0);

      // Correcting to a valid future time clears the modal error and stages the
      // schedule, confirming the same modal recovers without a reopen.
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const futureFields = toDateTimeFields(future);
      await window.getByTestId('schedule-message-date').fill(futureFields.date);
      await window.getByTestId('schedule-message-time').fill(futureFields.time);
      await window.getByTestId('schedule-message-save').click();

      await expect(modal).toBeHidden();
      await expect(
        window.getByTestId('chat-input-scheduled-send-pill'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('recurring automations surface as a composer notice; one-time sends keep the bubble', async () => {
    const { electronApp, userDataDir, window } = await seedAndLaunch({
      beforeLaunch: seedCodeChatAutomations,
    });
    try {
      const chat = window.getByTestId('panel-content-chat');
      const notice = chat
        .getByTestId('chat-input-notices')
        .getByTestId('chat-input-scheduled-automations-notice');
      await expect(notice).toBeVisible({ timeout: 20_000 });
      await expect(notice).toContainText('Every Monday at 09:00');
      await expect(notice).toContainText(RECURRING_ACTIVITY_NAME);
      await expect(notice).toContainText('next ');

      // The recurring prompt never renders as a transcript bubble.
      const bubbles = chat.getByTestId('queued-message-bubble');
      await expect(bubbles.filter({ hasText: RECURRING_PROMPT })).toHaveCount(
        0,
      );

      // The one-time send keeps its bubble with the single "Sends …" row.
      const oneTimeBubble = bubbles.filter({ hasText: ONE_TIME_PROMPT });
      await expect(oneTimeBubble).toBeVisible();
      await expect(
        oneTimeBubble.getByTestId('scheduled-message-send-label'),
      ).toContainText('Sends ');

      // Pause asks first; confirming disables the automation and drops the
      // notice, leaving the one-time bubble untouched.
      await notice.getByTestId('scheduled-automation-more').click();
      await window.getByTestId('scheduled-automation-pause').click();
      const dialog = window.getByTestId('scheduled-automation-pause-dialog');
      await expect(dialog).toContainText('Pause this automation?');
      await window.getByTestId('scheduled-automation-pause-confirm').click();
      await expect(dialog).toBeHidden();
      await expect(notice).toHaveCount(0);
      await expect(oneTimeBubble).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('App Advisor exposes scheduling and scheduled-message history controls', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-app-advisor-schedule-msg-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedAppAdvisorScheduling(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const mainWindow = await electronApp.firstWindow();
      const app = new CanopyAppDriver(mainWindow);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const advisor = await app.openAppAdvisorWindow(electronApp);
      const transcript = advisor.getByTestId('app-advisor-workspace-surface');
      const scheduledBubble = transcript
        .getByTestId('queued-message-bubble')
        .filter({ hasText: ADVISOR_SCHEDULED_TEXT });
      await expect(scheduledBubble).toBeVisible();
      await expect(
        scheduledBubble.getByTestId('scheduled-message-send-label'),
      ).toContainText('Sends ');
      await scheduledBubble.hover();
      await expect(
        scheduledBubble.getByRole('button', {
          name: 'Edit scheduled message',
        }),
      ).toBeVisible();
      await expect(
        scheduledBubble.getByRole('button', {
          name: 'Clear scheduled message',
        }),
      ).toBeVisible();
      await expect(
        scheduledBubble.getByRole('button', { name: 'Interrupt' }),
      ).toBeVisible();

      await scheduledBubble
        .getByRole('button', { name: 'Edit scheduled message' })
        .click();
      await expect(transcript.getByRole('textbox').first()).toContainText(
        ADVISOR_SCHEDULED_TEXT,
      );
      await expect(
        transcript.getByRole('button', { name: 'Save' }),
      ).toBeVisible();
      await transcript.getByRole('button', { name: 'Cancel' }).click();
      await expect(scheduledBubble).toBeVisible();

      const composer = transcript.getByRole('textbox').first();
      await composer.fill('Schedule from App Advisor.');
      await openScheduleMessage(advisor, transcript);
      const modal = advisor.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();
      const future = toDateTimeFields(
        new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      );
      await advisor.getByTestId('schedule-message-date').fill(future.date);
      await advisor.getByTestId('schedule-message-time').fill(future.time);
      await advisor.getByTestId('schedule-message-save').click();
      await expect(modal).toBeHidden();
      await expect(
        transcript.getByTestId('chat-input-scheduled-send-pill'),
      ).toBeVisible();

      await scheduledBubble.hover();
      await scheduledBubble
        .getByRole('button', { name: 'Clear scheduled message' })
        .click();
      await expect(scheduledBubble).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

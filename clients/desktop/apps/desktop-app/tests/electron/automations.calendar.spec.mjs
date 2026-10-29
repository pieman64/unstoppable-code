import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  openWorkflowEditSection,
  workflowEditTarget,
} from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedAutomations } from './seeders/index.mjs';

// The automations calendar, which is the whole Workflows › Schedule tab
// (CAN-3981). There is no List/Calendar view-mode picker any more.
//
// The app build is E2E-gated, so the automations scheduler never starts
// (`AutomationsService.start()` early-returns under `isE2eBuild()`). Seeded
// activities therefore list without firing, and seeded `recentRuns` render the
// past-run overlay deterministically without the scheduler.
//
// Calendar occurrence expansion is a pure renderer-side computation
// (`enumerateAutomationOccurrences` in `@canopy/desktop-shared`), so a daily
// cron renders on every visible day with no live turn required.

const EN_DASH = '–';

const ACTIVITY_A_ID = 'cal-daily-a';
const ACTIVITY_B_ID = 'cal-runs-b';
const ACTIVITY_C_ID = 'cal-onetime-c';
const ACTIVITY_D_ID = 'cal-disabled-d';
const ACTIVITY_E_ID = 'cal-frequent-e';
const ORPHAN_ACTIVITY_ID = 'cal-deleted-orphan';

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
}

function makeActivity({ id, name, schedule, enabled = true }) {
  return {
    version: 1,
    id,
    name,
    enabled,
    schedule,
    action: { type: 'app_advisor_prompt', prompt: 'Run automation' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function makeRun({ id, activityId, activityName, scheduledFor, status }) {
  return {
    id,
    activityId,
    activityName,
    scheduledFor,
    manual: false,
    status,
    startedAt: scheduledFor,
    completedAt: scheduledFor,
  };
}

// Build seed data anchored on the start of the Electron app's UTC week
// (Sunday), so the runs / one-time occurrence land inside the default Week
// window regardless of the Playwright runner process timezone.
function buildSeed() {
  const weekStart = new Date();
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());

  const atWeek = (dayOffset, hour, minute = 0) => {
    const date = new Date(weekStart);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    date.setUTCHours(hour, minute, 0, 0);
    return date.toISOString();
  };

  const activities = [
    // A — daily 9am cron; the ≥7 occurrence-count assertion. NO runs seeded so
    // de-dupe can never shrink its count.
    makeActivity({
      id: ACTIVITY_A_ID,
      name: 'Daily cron A',
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    }),
    // B — one-time far in the future (no occurrence inside the week), so its
    // only in-window chips are the seeded runs below.
    makeActivity({
      id: ACTIVITY_B_ID,
      name: 'Run history B',
      schedule: {
        kind: 'one_time',
        runAt: '2099-01-01T09:00:00.000Z',
        timezone: 'local',
      },
    }),
    // C — a future one-time inside the current week → one occurrence chip.
    makeActivity({
      id: ACTIVITY_C_ID,
      name: 'One-time C',
      schedule: { kind: 'one_time', runAt: atWeek(4, 14), timezone: 'local' },
    }),
    // D — disabled daily cron; hidden until "Show disabled" is toggled.
    makeActivity({
      id: ACTIVITY_D_ID,
      name: 'Disabled cron D',
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      enabled: false,
    }),
    // E — frequent cron: every 5 minutes within the 9am hour → 12 fires/day,
    // all in one hour bucket. Drives the condensing assertion: each day shows a
    // single chip carrying a "(12 times)" indicator, not 12 separate chips.
    makeActivity({
      id: ACTIVITY_E_ID,
      name: 'Frequent cron E',
      schedule: { kind: 'cron', expression: '*/5 9 * * *', timezone: 'local' },
    }),
  ];

  const recentRuns = [
    makeRun({
      id: 'run-b-success',
      activityId: ACTIVITY_B_ID,
      activityName: 'Run history B',
      scheduledFor: atWeek(1, 10),
      status: 'success',
    }),
    makeRun({
      id: 'run-b-failure',
      activityId: ACTIVITY_B_ID,
      activityName: 'Run history B',
      scheduledFor: atWeek(2, 11),
      status: 'failure',
    }),
    // Historical runs for disabled live activities must remain visible even
    // while disabled predicted occurrences are hidden.
    makeRun({
      id: 'run-d-skipped',
      activityId: ACTIVITY_D_ID,
      activityName: 'Disabled cron D',
      scheduledFor: atWeek(5, 15),
      status: 'skipped',
    }),
    // Orphan run — activityId is NOT among the seeded activities (the
    // deleted-activity case). Renders as a non-clickable chip.
    makeRun({
      id: 'run-orphan',
      activityId: ORPHAN_ACTIVITY_ID,
      activityName: 'Deleted activity',
      scheduledFor: atWeek(3, 12),
      status: 'success',
    }),
  ];

  return { activities, recentRuns };
}

// The calendar sub-view preference is sticky in `localStorage` (persisted
// under Electron's `userData`). Since PR #1503 redirects `userData` to the
// per-test `CANOPY_DATA_DIR` in E2E builds, this localStorage is now isolated
// per test, so the reset below is defensive / redundant-but-harmless. It still
// pins the Week default before asserting and clears the legacy view-mode key,
// which would otherwise redirect a legacy `automations` navigation to Schedule.
async function resetCalendarPreferences(window) {
  await window.evaluate(() => {
    localStorage.removeItem('canopy.automations.viewMode');
    localStorage.removeItem('canopy.automations.calendarView');
    // Legacy key: show-disabled is session-only, but clear stale data so this
    // spec leaves the shared Electron localStorage tidy.
    localStorage.removeItem('canopy.automations.showDisabled');
  });
}

function eventLocator(window, { activityId, kind, runStatus, deleted } = {}) {
  let selector = '[data-testid="automations-calendar-event"]';
  if (activityId) {
    selector += `[data-activity-id="${activityId}"]`;
  }
  if (kind) {
    selector += `[data-event-kind="${kind}"]`;
  }
  if (runStatus) {
    selector += `[data-run-status="${runStatus}"]`;
  }
  if (deleted) {
    selector += '[data-activity-deleted="true"]';
  }
  return window.locator(selector);
}

test('automations calendar: view toggle, occurrence expansion, past-run overlay, navigation', async ({}, testInfo) => {
  const userDataDir = makeUserDataDir();
  const { activities, recentRuns } = buildSeed();
  seedAutomations({ userDataDir, activities, recentRuns });

  const { electronApp } = await launchCanopy({ userDataDir });

  let window;
  try {
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // Clear any leaked sticky prefs before the tab mounts so Week is the default.
    await resetCalendarPreferences(window);
    await window.evaluate(() => {
      localStorage.setItem('canopy.automations.showDisabled', 'true');
    });

    // --- The Library lists the automation; Schedule is the calendar -------
    await app.openAutomationsPage();
    await expect(
      app.workflowsLibraryAutomationRow(ACTIVITY_A_ID),
    ).toBeVisible();
    await expect(window.getByTestId('automations-calendar')).toBeHidden();

    await app.openWorkflowsTab('schedule');
    await expect(window.getByTestId('automations-calendar')).toBeVisible();

    // Default sub-view is Week (sticky default) → range title with an en-dash
    // and the now-line, since the window includes today.
    await expect(
      window.getByTestId('automations-calendar-title'),
    ).toContainText(EN_DASH);
    await expect(
      window.getByTestId('automations-calendar-now-indicator'),
    ).toBeVisible();

    // --- Daily cron A appears on every visible day (≥7 in Week) ----------
    await expect
      .poll(() =>
        eventLocator(window, {
          activityId: ACTIVITY_A_ID,
          kind: 'occurrence',
        }).count(),
      )
      .toBeGreaterThanOrEqual(7);

    // --- Frequent cron E condenses to one "(12 times)" chip per day ------
    // E fires every 5 minutes within the 9am hour (12/day). Under the Week
    // view's hour bucketing those collapse into a single chip per day, so the
    // chip count tracks visible days — NOT 12 × days — and each chip carries
    // the "(12 times)" indicator.
    const frequentChips = eventLocator(window, {
      activityId: ACTIVITY_E_ID,
      kind: 'occurrence',
    });
    await expect.poll(() => frequentChips.count()).toBeGreaterThanOrEqual(7);
    expect(await frequentChips.count()).toBeLessThanOrEqual(8);
    const firstFrequent = frequentChips.first();
    await expect(firstFrequent).toHaveAttribute('data-event-count', '12');
    await expect(firstFrequent).toContainText('12 times');

    // --- Past-run overlay: B's seeded runs render with status styling -----
    await expect(
      eventLocator(window, {
        activityId: ACTIVITY_B_ID,
        kind: 'run',
        runStatus: 'success',
      }),
    ).toHaveCount(1);
    await expect(
      eventLocator(window, {
        activityId: ACTIVITY_B_ID,
        kind: 'run',
        runStatus: 'failure',
      }),
    ).toHaveCount(1);

    // --- Orphan run (deleted activity) renders and is non-clickable -------
    const orphanChip = eventLocator(window, {
      activityId: ORPHAN_ACTIVITY_ID,
      kind: 'run',
      deleted: true,
    });
    await expect(orphanChip).toHaveCount(1);
    await expect(orphanChip).toBeDisabled();

    // --- Disabled cron D hidden until "Show disabled" --------------------
    await expect(
      eventLocator(window, { activityId: ACTIVITY_D_ID, kind: 'occurrence' }),
    ).toHaveCount(0);
    await expect(
      eventLocator(window, {
        activityId: ACTIVITY_D_ID,
        kind: 'run',
        runStatus: 'skipped',
      }),
    ).toHaveCount(1);
    await window.getByTestId('automations-calendar-show-disabled').click();
    await expect
      .poll(() =>
        eventLocator(window, {
          activityId: ACTIVITY_D_ID,
          kind: 'occurrence',
        }).count(),
      )
      .toBeGreaterThanOrEqual(7);

    // --- Clicking an upcoming occurrence opens its Definition -------------
    // The edit shell replaces the calendar while it is open (CAN-4072), and
    // its Back returns to the Library.
    await eventLocator(window, {
      activityId: ACTIVITY_A_ID,
      kind: 'occurrence',
    })
      .first()
      .click();
    const definition = window.getByTestId('workflow-edit-section-definition');
    await expect(definition).toBeVisible();
    expect(await workflowEditTarget(window)).toMatchObject({
      kind: 'automation',
      activityId: ACTIVITY_A_ID,
    });
    await expect(definition.getByTestId('automations-form-name')).toHaveValue(
      'Daily cron A',
    );
    await backFromWorkflowEdit(window);
    await expect(
      window.getByTestId('workflows-tab-workflows-library'),
    ).toHaveAttribute('aria-selected', 'true');
    await app.openWorkflowsTab('schedule');
    await expect(window.getByTestId('automations-calendar')).toBeVisible();

    // --- Clicking B's run opens its Runs, then Definition its form ---------
    // B's runs record nothing to open, so the chip opens the run history.
    await eventLocator(window, {
      activityId: ACTIVITY_B_ID,
      kind: 'run',
      runStatus: 'success',
    }).click();
    const runDetails = window.getByTestId('workflow-edit-section-runs');
    await expect(runDetails).toBeVisible();
    expect(await workflowEditTarget(window)).toMatchObject({
      kind: 'automation',
      activityId: ACTIVITY_B_ID,
      section: 'runs',
    });
    const runDefinition = await openWorkflowEditSection(window, 'definition');
    await expect(
      runDefinition.getByTestId('automations-form-name'),
    ).toHaveValue('Run history B');
    await backFromWorkflowEdit(window);
    await app.openWorkflowsTab('schedule');
    await expect(window.getByTestId('automations-calendar')).toBeVisible();

    // --- Sub-view switching updates the title format ---------------------
    const title = window.getByTestId('automations-calendar-title');

    await window.getByTestId('automations-calendar-view-picker').click();
    await window.getByTestId('automations-calendar-view-day').click();
    // "June 25, 2026" — single day, no range dash.
    await expect(title).toHaveText(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
    await expect(
      window.getByTestId('automations-calendar-now-indicator'),
    ).toBeVisible();

    await window.getByTestId('automations-calendar-view-picker').click();
    await window.getByTestId('automations-calendar-view-month').click();
    // "June 2026" — month + year, no day, no dash.
    await expect(title).toHaveText(/^[A-Z][a-z]+ \d{4}$/);

    await window.getByTestId('automations-calendar-view-picker').click();
    await window.getByTestId('automations-calendar-view-schedule').click();
    // 30-day range title, e.g. "Jun 25 – Jul 24, 2026".
    await expect(title).toContainText(EN_DASH);

    // Back to Week for the navigation checks.
    await window.getByTestId('automations-calendar-view-picker').click();
    await window.getByTestId('automations-calendar-view-week').click();
    await expect(title).toContainText(EN_DASH);

    // --- Prev/next page the window; now-line only while today is in view --
    const weekTitle = await title.textContent();
    await expect(
      window.getByTestId('automations-calendar-now-indicator'),
    ).toBeVisible();

    expect(weekTitle).toBeTruthy();

    await window.getByTestId('automations-calendar-next').click();
    await expect(title).not.toHaveText(weekTitle ?? '');
    await expect(
      window.getByTestId('automations-calendar-now-indicator'),
    ).toHaveCount(0);

    const nextWeekTitle = await title.textContent();
    await window.getByTestId('automations-calendar-prev').click();
    await expect(title).toHaveText(weekTitle ?? '');
    await expect(title).not.toHaveText(nextWeekTitle ?? '');
    await expect(
      window.getByTestId('automations-calendar-now-indicator'),
    ).toBeVisible();

    await window.getByTestId('automations-calendar-next').click();
    await expect(title).not.toHaveText(weekTitle ?? '');
    await expect(
      window.getByTestId('automations-calendar-now-indicator'),
    ).toHaveCount(0);

    await window.getByTestId('automations-calendar-today').click();
    await expect(title).toHaveText(weekTitle ?? '');
    await expect(
      window.getByTestId('automations-calendar-now-indicator'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('automations-calendar.png'),
    });
  } finally {
    // Clear this spec's sticky-preference writes so sibling specs are not
    // affected by them.
    if (window) {
      await resetCalendarPreferences(window).catch(() => undefined);
    }
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedUsageLimitedChats,
  seedPipelineExecution,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Home resume readiness (CAN-4967). Home and its resume dialog use the Usage
// card's blocking-window rule: a session whose provider is still at its limit
// is never preselected or counted for an immediate resume. It shows its window
// and reset, and can be scheduled to resume at the reset through the existing
// one-time automation. Provider usage comes from the build-gated auth/usage
// mock, keyed by each test's own bearer so a capped Codex window never leaks
// into concurrent specs on the shared `mock` key; the registry is seeded JSON.
//
// A chat scheduled from the dialog stays listed for the rest of that opening
// with its confirmation and an Undo for exactly that schedule (CAN-5015).
// Home and later openings omit it, as for any scheduled chat (CAN-4970).

let usageKey = '';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';
const CHATS = [
  { id: 'ready-claude-1', title: 'Claude chat one', provider: 'claude' },
  { id: 'ready-claude-2', title: 'Claude chat two', provider: 'claude' },
  { id: 'waiting-codex', title: 'Codex weekly chat', provider: 'codex' },
];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Claude well under its limits; Codex's weekly window at 100%. */
function usageScenario(codexWeeklyResetsAt) {
  return {
    authUsage: {
      claude: {
        auth: {
          loggedIn: true,
          email: 'tester@example.com',
          authMethod: 'oauth',
          subscriptionType: 'max',
        },
        usage: {
          five_hour: { utilization: 8, resets_at: '+2h' },
          seven_day: { utilization: 12, resets_at: '+5d' },
        },
      },
      codex: {
        account: {
          type: 'chatgpt',
          email: 'tester@example.com',
          planType: 'plus',
        },
        rateLimits: [
          {
            limitId: 'codex',
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: '+2h',
            },
            secondary: {
              usedPercent: 100,
              windowDurationMins: 10080,
              resetsAt: codexWeeklyResetsAt,
            },
          },
        ],
      },
    },
  };
}

function seed(chats, recordedResetMs) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-resume-readiness-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: chats.map((chat) => ({ id: chat.id, title: chat.title })),
  });
  seedUsageLimitedChats({
    userDataDir,
    entries: chats.map((chat) => ({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: chat.id,
      provider: chat.provider,
      detectedAt: Date.parse('2026-10-20T12:00:00.000Z'),
      workspaceName: WORKSPACE_NAME,
      chatTitle: chat.title,
      resumeReason: 'usage_limit',
      ...(recordedResetMs ? { resetsAt: recordedResetMs } : {}),
    })),
  });
  return userDataDir;
}

function registryChatIds(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'usage-limited-chats.json'), 'utf8'),
  )
    .entries.map((entry) => entry.chatId)
    .sort();
}

function launch(userDataDir) {
  return launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: usageKey },
  });
}

async function openHome(window) {
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await window.getByTestId('sidebar-create-task').click();
  await expect(window.getByTestId('page-home')).toBeVisible();
  return window.getByTestId('page-home');
}

async function openResumeDialog(window, home) {
  await home.getByTestId('home-interrupted-sessions-resume').click();
  const modal = window.getByTestId('usage-limit-resume-modal');
  await expect(modal).toBeVisible({ timeout: 30_000 });
  return modal;
}

/** The text an input's `aria-describedby` points at. */
async function description(window, input) {
  const id = await input.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  return window.locator(`[id="${id}"]`);
}

async function activityIds(window) {
  const snapshot = await window.evaluate(() => window.api.automations.list());
  return snapshot.activities.map((activity) => activity.id);
}

async function scheduledResumes(window, chatId) {
  const snapshot = await window.evaluate(() => window.api.automations.list());
  return snapshot.activities.filter(
    (activity) =>
      activity.enabled &&
      activity.action.type === 'worktree_session_prompt' &&
      activity.action.purpose === 'usage_limit_resume' &&
      activity.action.workspaceId === WORKSPACE_ID &&
      activity.action.worktreeId === WORKTREE_ID &&
      activity.action.chatId === chatId,
  );
}

test.describe('home interrupted sessions readiness', () => {
  test.beforeEach(async ({}, testInfo) => {
    usageKey = `home-resume-readiness-${testInfo.workerIndex}-${testInfo.testId}`;
  });
  test.afterEach(async () => {
    await clearScenario(DEFAULT_MOCK_BASE_URL, usageKey);
  });

  for (const codexBlocked of [true, false]) {
    test(`handles a mixed-provider pipeline (Codex blocked: ${codexBlocked})`, async () => {
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        usageKey,
        usageScenario(codexBlocked ? '+2d' : '2020-01-01T00:00:00.000Z'),
      );
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-mixed-pipeline-resume-'),
      );
      const seeded = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
      });
      const executionId = 'mixed-provider-resume';
      const providers = ['claude', 'codex'];
      const reasonIds = [
        '123e4567-e89b-42d3-a456-426614174000',
        '123e4567-e89b-42d3-a456-426614174001',
        '123e4567-e89b-42d3-a456-426614174002',
      ];
      const detectedAt = '2026-10-20T12:00:00.000Z';
      seedPipelineExecution({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: {
          id: executionId,
          pipelineName: 'Mixed provider run',
          status: 'paused',
          cwd: seeded.workspaces[0].worktreePath,
          jobs: [
            {
              id: 'build',
              name: 'Build',
              steps: providers.map((provider) => ({
                id: provider,
                name: provider,
                run: 'true',
              })),
            },
          ],
          stepResults: Object.fromEntries(
            providers.map((provider, index) => [
              `build.${provider}`,
              {
                status: 'paused',
                recovery_count: 0,
                agent_recovery: {
                  version: 1,
                  reason_id: reasonIds[index],
                  action: 'agent-prompt',
                  provider,
                  had_agent_activity: false,
                  strategy: 'restart_step',
                  recovery_count: 0,
                  paused_at: detectedAt,
                  failure_message: 'usage exhausted',
                },
              },
            ]),
          ),
          stateOverrides: {
            version: 6,
            status_reasons: [
              ...providers.map((provider, index) => ({
                id: reasonIds[index],
                provider,
                kind: 'provider_usage_limit',
                code: 'rate_limit',
                account_scope: 'native',
                detected_at: detectedAt,
                source: {
                  job_id: 'build',
                  step_id: provider,
                  attempt: 0,
                  iteration: 1,
                },
              })),
              {
                id: reasonIds[2],
                kind: 'provider_authentication_required',
                code: 'authentication_failed',
                provider: 'codex',
                account_scope: 'native',
                detected_at: detectedAt,
                source: {
                  job_id: 'build',
                  step_id: 'codex',
                  attempt: 0,
                  iteration: 1,
                },
              },
            ],
          },
        },
      });
      const { electronApp } = await launch(userDataDir);
      try {
        const window = await electronApp.firstWindow();
        const home = await openHome(window);
        await expect(
          home.getByTestId('home-interrupted-sessions-details'),
        ).toHaveText(
          codexBlocked
            ? /^Resume 1 workflow · 1 waiting for Codex reset/
            : 'Resume 2 interrupted workflows',
          {
            timeout: 30_000,
          },
        );
        const modal = await openResumeDialog(window, home);
        const rows = modal.getByTestId(
          `usage-limit-resume-pipeline-${executionId}`,
        );
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toBeChecked();
        await expect(await description(window, rows.nth(0))).toHaveText(
          'Claude · Usage limit · Ready now',
        );
        if (!codexBlocked) {
          await expect(rows.nth(1)).toBeChecked();
          await expect(
            modal.getByTestId('usage-limit-resume-confirm'),
          ).toHaveText('Resume 2 workflows');
          await modal.getByTestId('usage-limit-resume-confirm').click();
          await expect
            .poll(async () => {
              const queue = await window.evaluate(() =>
                window.api.getResumeQueue(),
              );
              return queue.entries
                .filter(
                  (entry) =>
                    entry.target.kind === 'pipeline' &&
                    entry.target.executionId === executionId,
                )
                .map((entry) => entry.target.statusReasonIds);
            })
            .toEqual([reasonIds]);
          return;
        }
        await expect(rows.nth(1)).not.toBeChecked();
        await expect(rows.nth(1)).toBeDisabled();
        await expect(await description(window, rows.nth(1))).toContainText(
          'Codex · Weekly limit',
        );
        await expect(await description(window, rows.nth(1))).toContainText(
          'Authentication issue',
        );
        await expect(
          modal.getByTestId('usage-limit-resume-confirm'),
        ).toHaveText('Resume workflow');
        const scheduleStatus = modal.getByTestId(
          `usage-limit-resume-schedule-status-pipeline-${executionId}`,
        );
        await expect(scheduleStatus).toHaveAttribute('role', 'status');
        await expect(scheduleStatus).toHaveAttribute('aria-live', 'polite');
        await modal
          .getByTestId(`usage-limit-resume-schedule-pipeline-${executionId}`)
          .click();
        await expect(scheduleStatus).toContainText('Scheduled for');
        await expect
          .poll(async () => {
            const snapshot = await window.evaluate(() =>
              window.api.automations.list(),
            );
            return snapshot.activities
              .filter(
                (activity) =>
                  activity.enabled &&
                  activity.action.type === 'pipeline_execution_resume' &&
                  activity.action.executionId === executionId,
              )
              .map((activity) => ({
                provider: activity.action.provider,
                statusReasonIds: activity.action.statusReasonIds,
              }));
          })
          .toEqual([
            {
              provider: 'codex',
              statusReasonIds: [reasonIds[1], reasonIds[2]],
            },
          ]);
        await expect(
          modal.getByTestId(
            `usage-limit-resume-scheduled-pipeline-${executionId}`,
          ),
        ).toContainText('Scheduled for');
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('keeps a Codex chat at its weekly limit out of the resume, schedules it for the reset, and undoes it', async () => {
    test.setTimeout(180_000);
    // Codex's mock wire response reports reset instants in epoch seconds.
    const resetAtMs = Math.floor(Date.now() / 1000) * 1000 + 2 * DAY_MS;
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      usageKey,
      usageScenario(new Date(resetAtMs).toISOString()),
    );
    const userDataDir = seed(CHATS);
    const { electronApp } = await launch(userDataDir);
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window);
      const banner = home.getByTestId('home-interrupted-sessions-details');
      await expect(banner).toHaveText(
        /^Resume 2 chats · 1 waiting for Codex reset \(.+\)$/,
        { timeout: 30_000 },
      );

      const modal = await openResumeDialog(window, home);
      const codex = modal.getByTestId('usage-limit-resume-chat-waiting-codex');
      await expect(codex).toBeDisabled();
      await expect(codex).not.toBeChecked();
      await expect(await description(window, codex)).toHaveText(
        /^Codex · Weekly limit · Resets .+$/,
      );
      const readyChats = ['ready-claude-1', 'ready-claude-2'].map((id) =>
        modal.getByTestId(`usage-limit-resume-chat-${id}`),
      );
      for (const claude of readyChats) {
        await expect(claude).toBeChecked();
        await expect(await description(window, claude)).toHaveText(
          'Claude · Usage limit · Ready now',
        );
      }
      const summary = modal.getByTestId('usage-limit-resume-readiness-summary');
      const confirm = modal.getByTestId('usage-limit-resume-confirm');
      await expect(summary).toHaveText(
        '2 ready now · 1 waiting for Codex reset',
      );
      await expect(confirm).toHaveText('Resume 2 chats');

      // Scheduling keeps the row, its live confirmation, and the selection.
      const schedule = modal.getByTestId(
        'usage-limit-resume-schedule-chat-waiting-codex',
      );
      const status = modal.getByTestId(
        'usage-limit-resume-schedule-status-chat-waiting-codex',
      );
      const scheduled = modal.getByTestId(
        'usage-limit-resume-scheduled-chat-waiting-codex',
      );
      const undo = modal.getByTestId(
        'usage-limit-resume-undo-schedule-chat-waiting-codex',
      );
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      // Follow the actual node through the automation snapshot refresh, not
      // only a locator that could silently find a newly mounted live region.
      await status.evaluate((node) => {
        node.setAttribute('data-can5015-original-status', 'true');
      });
      await expect(schedule).toHaveText('Resume at reset');
      await schedule.click();
      await expect(scheduled).toHaveText(/^Scheduled for .+/, {
        timeout: 30_000,
      });
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(status).toHaveAttribute(
        'data-can5015-original-status',
        'true',
      );
      await expect(undo).toHaveText('Undo');
      await expect(codex).toBeDisabled();
      await expect(codex).not.toBeChecked();
      for (const claude of readyChats) await expect(claude).toBeChecked();
      await expect(summary).toHaveText(
        '2 ready now · 1 waiting for Codex reset',
      );
      await expect(confirm).toHaveText('Resume 2 chats');
      await expect
        .poll(
          async () => (await scheduledResumes(window, 'waiting-codex')).length,
        )
        .toBe(1);
      const [first] = await scheduledResumes(window, 'waiting-codex');
      expect(first.schedule.kind).toBe('one_time');
      // The run time comes from the provider snapshot's weekly reset.
      expect(Date.parse(first.schedule.runAt)).toBe(resetAtMs);
      expect(first.nextRunAt).toBe(first.schedule.runAt);

      // Undo deletes exactly that automation and offers the schedule again.
      await undo.click();
      await expect
        .poll(async () => (await activityIds(window)).includes(first.id))
        .toBe(false);
      await expect(schedule).toHaveText('Resume at reset');
      await expect(schedule).toBeEnabled();
      await expect(undo).toHaveCount(0);
      expect(await scheduledResumes(window, 'waiting-codex')).toHaveLength(0);

      // Scheduling from the keyboard hands focus to the Undo that replaces it.
      await schedule.focus();
      await window.keyboard.press('Enter');
      await expect(scheduled).toHaveText(/^Scheduled for .+/, {
        timeout: 30_000,
      });
      await expect(undo).toBeFocused();
      await expect
        .poll(
          async () => (await scheduledResumes(window, 'waiting-codex')).length,
        )
        .toBe(1);

      // Home and the next opening omit the scheduled chat.
      await modal.getByTestId('usage-limit-resume-cancel').click();
      await expect(modal).toBeHidden();
      await expect(banner).toHaveText('Resume 2 interrupted chats', {
        timeout: 30_000,
      });
      const reopened = await openResumeDialog(window, home);
      await expect(
        reopened.getByTestId('usage-limit-resume-chat-waiting-codex'),
      ).toHaveCount(0);
      await expect(
        reopened.getByTestId('usage-limit-resume-readiness-summary'),
      ).toHaveText('All 2 ready now');
      expect(await scheduledResumes(window, 'waiting-codex')).toHaveLength(1);

      await reopened.getByTestId('usage-limit-resume-confirm').click();
      await expect(reopened).toBeHidden();
      await expect
        .poll(() => registryChatIds(userDataDir), { timeout: 60_000 })
        .toEqual(['waiting-codex']);
      const queue = window.getByTestId('resume-queue-modal');
      await expect(queue.getByRole('button', { name: 'Done' })).toBeVisible({
        timeout: 60_000,
      });
      await queue.getByRole('button', { name: 'Done' }).click();
      await expect(queue).toBeHidden();
      // The scheduled chat resumes on its own, so Home has nothing to offer.
      await expect(
        home.getByTestId('home-interrupted-sessions-resume'),
      ).toBeHidden({ timeout: 30_000 });
      expect(await scheduledResumes(window, 'waiting-codex')).toHaveLength(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('does not advertise a recorded fallback as the provider reset time', async () => {
    test.setTimeout(120_000);
    const scenario = usageScenario('+2d');
    delete scenario.authUsage.codex.rateLimits[0].secondary.resetsAt;
    scenario.authUsage.codex.rateLimits[0].primary.usedPercent = 100;
    delete scenario.authUsage.codex.rateLimits[0].primary.resetsAt;
    await registerScenario(DEFAULT_MOCK_BASE_URL, usageKey, scenario);
    const userDataDir = seed([CHATS[2]], Date.now() + 2 * DAY_MS);
    const { electronApp } = await launch(userDataDir);
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window);
      await expect(
        home.getByTestId('home-interrupted-sessions-details'),
      ).toContainText('Codex weekly chat waiting for Codex reset', {
        timeout: 30_000,
      });
      const modal = await openResumeDialog(window, home);
      await expect(
        modal.getByTestId('usage-limit-resume-chat-waiting-codex'),
      ).toBeDisabled();
      await expect(
        modal.getByTestId('usage-limit-resume-chat-waiting-codex-metadata'),
      ).toContainText('Waiting for another reset');
      await modal
        .getByTestId('usage-limit-resume-schedule-chat-waiting-codex')
        .click();
      await expect(modal.getByRole('alert')).toContainText(
        'reset time isn’t available',
      );
      expect(await scheduledResumes(window, 'waiting-codex')).toHaveLength(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('treats a weekly window whose reset already passed as stale', async () => {
    test.setTimeout(120_000);
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      usageKey,
      usageScenario('2026-01-01T00:00:00.000Z'),
    );
    const userDataDir = seed([CHATS[0], CHATS[2]]);
    const { electronApp } = await launch(userDataDir);
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window);
      await expect(
        home.getByTestId('home-interrupted-sessions-details'),
      ).toHaveText('Resume 2 interrupted chats', { timeout: 30_000 });
      const modal = await openResumeDialog(window, home);
      const codex = modal.getByTestId('usage-limit-resume-chat-waiting-codex');
      await expect(codex).toBeEnabled();
      await expect(codex).toBeChecked();
      await expect(await description(window, codex)).toHaveText(
        'Codex · Usage limit · Ready now',
      );
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume 2 chats',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

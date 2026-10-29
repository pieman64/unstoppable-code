import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/registerScenario.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

// Real composer → bundled Claude → HTTP model fixture → real injected tool
// handlers → persisted state → Automations UI. This is a deterministic provider
// contract, not a claim about live model inference. The fixture refuses to emit
// tools unless the production scheduling policy reaches the model request.
const requiredSystemText = [
  'default to a Canopy automation through',
  'mcp__canopy_app_advisor__DispatchAction / canopy_app_advisor_dispatch_action with automation.create',
  'mcp__canopy_app_advisor__ScheduleWakeup / canopy_app_advisor_schedule_wakeup for a bounded',
  'Honor an explicit request for a provider/harness-native scheduler',
  'Preserve event-specific watchers',
  'for a bounded same-chat continuation after 60–3600 seconds',
];
const scenarios = [
  {
    id: 'recurring',
    prompt:
      'Create a scheduled task in App Advisor named Morning email to check my email every morning at 9 local time.',
    name: 'Morning email',
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
  },
  {
    id: 'one-time',
    prompt:
      'Create a reminder in App Advisor named Email reminder to check my email on January 1, 2099 at 09:00 UTC, just once.',
    name: 'Email reminder',
    schedule: {
      kind: 'one_time',
      runAt: '2099-01-01T09:00:00.000Z',
      timezone: 'local',
    },
  },
  {
    id: 'wakeup',
    prompt: 'Wait 10 minutes, then check the build in this same chat.',
    tool: 'mcp__canopy_app_advisor__ScheduleWakeup',
    input: { delaySeconds: 600, followUpInstruction: 'Check the build.' },
  },
  {
    id: 'watcher',
    prompt:
      'Tell me when the next build pipeline finishes in project demo-ts-pnpm-vite, worktree demo-main.',
    tool: 'mcp__canopy_app_advisor__SetupWatchers',
    input: {
      watchers: [
        {
          trigger: 'worktree_pipeline_completion',
          label: 'Build completion',
          target: {
            kind: 'worktree_pipeline',
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          },
        },
      ],
    },
  },
  {
    id: 'native',
    prompt:
      "Use Claude's built-in schedule feature to check my email every morning at 9, not an app automation.",
    tool: 'CronCreate',
    input: { cron: '0 9 * * *', prompt: 'Check my email.', recurring: true },
  },
];

function readActivities(userDataDir) {
  const file = path.join(userDataDir, 'automations.json');
  return existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).activities
    : [];
}

for (const scenario of scenarios) {
  test(`CAN-3138 App Advisor scheduling: ${scenario.id}`, async () => {
    test.setTimeout(90_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-scheduling-'),
    );
    const demo =
      scenario.id === 'watcher'
        ? seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] })
        : undefined;
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        appAdvisorModel: 'claude-sonnet-4-6',
        appAdvisorThinkingLevel: 'off',
        defaultAppAdvisorInterfaceMode: 'canopy',
        appAdvisorPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    });
    const marker = `Canopy-CSCHEDULING${scenario.id.replaceAll('-', '').toUpperCase()}`;
    const reply = `Scheduling request completed: ${scenario.id}.`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        requiredSystemText,
        steps: [
          ...(scenario.schedule
            ? [
                {
                  toolCalls: [
                    {
                      name: 'mcp__canopy_app_advisor__SearchActions',
                      input: {
                        query:
                          scenario.id === 'one-time'
                            ? 'remind me tomorrow'
                            : 'scheduled task',
                      },
                    },
                  ],
                  stopReason: 'tool_use',
                },
              ]
            : []),
          {
            toolCalls: [
              {
                name:
                  scenario.tool ?? 'mcp__canopy_app_advisor__DispatchAction',
                input: scenario.input ?? {
                  action: {
                    type: 'automation.create',
                    input: {
                      name: scenario.name,
                      schedule: scenario.schedule,
                      action: {
                        type: 'app_advisor_prompt',
                        prompt: 'Check my email.',
                      },
                    },
                  },
                },
              },
            ],
            stopReason: 'tool_use',
          },
          ...(scenario.id === 'native'
            ? [
                {
                  toolCalls: [{ name: 'CronList', input: {} }],
                  stopReason: 'tool_use',
                },
              ]
            : []),
          { text: reply, stopReason: 'end_turn' },
        ],
      },
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const advisor = await app.openAppAdvisorWindow(electronApp);
      const panel = advisor.getByTestId('app-advisor-workspace-surface');
      await panel
        .getByRole('textbox')
        .first()
        .fill(`[${marker}] ${scenario.prompt}`);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(reply, { exact: true }).first()).toBeVisible(
        { timeout: 45_000 },
      );
      await expect(composerIdleAction(panel)).toBeVisible();
      const chatFiles = readdirSync(
        path.join(
          userDataDir,
          'app-workspaces',
          'app-advisor',
          'chat-storage-v2',
        ),
        { recursive: true },
      ).filter(
        (file) =>
          file.includes(`transcripts${path.sep}`) && file.endsWith('.jsonl'),
      );
      expect(chatFiles).toHaveLength(1);
      const chatId = path.basename(chatFiles[0], '.jsonl');
      const blocks = readFileSync(
        path.join(
          userDataDir,
          'app-workspaces',
          'app-advisor',
          'chat-storage-v2',
          chatFiles[0],
        ),
        'utf8',
      )
        .trim()
        .split('\n')
        .flatMap((line) => JSON.parse(line).blocks ?? []);
      const results = blocks.filter((block) => block.type === 'tool_result');
      expect(results.length).toBe(
        scenario.id === 'native' || scenario.schedule ? 2 : 1,
      );
      if (scenario.schedule)
        expect(
          JSON.parse(results[0].output).actions.map((action) => action.type),
        ).toContain('automation.create');
      for (const result of results)
        expect(result.isError, result.output).not.toBe(true);
      if (scenario.id === 'native') {
        const nativeId = results[0].output.match(
          /Scheduled recurring job ([a-z0-9]+)/,
        )?.[1];
        expect(nativeId).toBeTruthy();
        expect(results[1].output).toContain(nativeId);
        expect(results[1].output).toContain('Check my email.');
        expect(results[1].output).toContain('Every day at 9:00 AM (recurring)');
      }
      await app.openAutomationsPage();
      // The Library lists pipelines in the same table.
      const rows = window.locator(
        '[data-testid="workflows-library-row"][data-row-kind="automation"]',
      );
      if (scenario.schedule) {
        await expect(rows).toHaveCount(1);
        await expect(rows).toContainText(scenario.name);
        const [activity] = readActivities(userDataDir);
        expect(activity.schedule).toEqual(scenario.schedule);
        expect(activity.action).toMatchObject({
          type: 'app_advisor_prompt',
          prompt: 'Check my email.',
        });
      } else {
        await expect(rows).toHaveCount(0);
        expect(readActivities(userDataDir)).toEqual([]);
        if (scenario.id === 'wakeup' || scenario.id === 'watcher') {
          await app.openWatchersPage();
          const watchers = window.locator(
            '[data-testid="workflows-run-row"][data-run-kind="watcher"]',
          );
          await expect(watchers).toHaveCount(1);
          const [watcher] = JSON.parse(
            readFileSync(
              path.join(userDataDir, 'app-advisor-watchers.json'),
              'utf8',
            ),
          ).watchers;
          expect(watcher.status).toBe('active');
          expect(watcher.destination.chatId).toBe(chatId);
          if (scenario.id === 'wakeup') {
            expect(watcher.trigger).toBe('scheduled_wakeup');
            expect(watcher.target).toMatchObject({
              kind: 'scheduled_wakeup',
              delaySeconds: 600,
            });
            expect(watcher.followUpInstruction).toBe('Check the build.');
          } else {
            await expect(watchers).toContainText('Build completion');
            expect(watcher.trigger).toBe('worktree_pipeline_completion');
            expect(watcher.target).toMatchObject(
              scenario.input.watchers[0].target,
            );
          }
        }
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      if (demo) cleanupDemoWorkspaces(demo);
    }
  });
}

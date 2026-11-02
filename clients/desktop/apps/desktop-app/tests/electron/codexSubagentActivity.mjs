import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

export const ACTIVITY_CHAT_ID = 'subagent-activity-chat';
export const activityEvents = JSON.parse(
  readFileSync(
    new URL('./fixtures/codex-subagent-activity.json', import.meta.url),
    'utf8',
  ),
);

export function seedActivityChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    activeTabId: ACTIVITY_CHAT_ID,
    tabs: [
      {
        id: ACTIVITY_CHAT_ID,
        title: 'Coordinated research',
        messages: [
          {
            id: 'request',
            role: 'user',
            timestamp: 1789067985816,
            blocks: [
              { type: 'text', text: 'Prepare a coordinated catalog plan.' },
            ],
          },
        ],
      },
    ],
  });
}

export function seedCompletedMetadataChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    activeTabId: ACTIVITY_CHAT_ID,
    tabs: [
      {
        id: ACTIVITY_CHAT_ID,
        title: 'Completed metadata',
        messages: [
          {
            id: 'request',
            role: 'user',
            timestamp: 1789067985816,
            blocks: [{ type: 'text', text: 'Inspect the completed task.' }],
          },
          {
            id: 'timer',
            role: 'system',
            timestamp: 1789067985817,
            blocks: [{ type: 'turn_timer', startedAt: 100, completedAt: 200 }],
          },
          {
            id: 'agent-call',
            role: 'assistant',
            timestamp: 1789067985818,
            codexThreadId: 'root',
            blocks: [
              {
                type: 'codex_agent_call',
                agentBlockId: 'codex-agent-metadata',
                callId: 'metadata-1',
                tool: 'spawnAgent',
                status: 'completed',
                senderThreadId: 'root',
                receiverThreadIds: ['research'],
                prompt: 'Inspect the completed task.',
                agentsStates: {
                  research: { status: 'completed', message: null },
                },
                receiverAgents: {
                  research: {
                    nickname: 'Tesla',
                    agentPath: '/root/readme_review',
                    model: 'gpt-6-astra',
                    reasoningEffort: 'high',
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

export async function openActivityChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'detailed' }),
  );
  await app.openMainPage();
  await app.selectWorktree('demo-main');
  await window.getByTestId(`panel-tab-panel-chat-${ACTIVITY_CHAT_ID}`).click();
  const panel = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${ACTIVITY_CHAT_ID}"]`,
  );
  await expect(panel).toBeVisible();
  return { window, panel };
}

export async function injectActivityEvents(electronApp, legacy = false) {
  const events = [...activityEvents];
  // Older providers announce the receiver metadata after the spawn call.
  if (legacy) [events[1], events[2]] = [events[2], events[1]];
  for (const original of events) {
    let event = original;
    if (legacy && original.item?.type === 'sub_agent_activity') {
      const item = original.item;
      if (item.kind === 'interacted') continue;
      event = {
        ...original,
        item: {
          id: item.id,
          type: 'collab_agent_tool_call',
          tool: item.kind === 'started' ? 'spawnAgent' : 'wait',
          status: 'completed',
          sender_thread_id: original.thread_id,
          receiver_thread_ids: [item.agent_thread_id],
          prompt: '',
          agents_states: {
            [item.agent_thread_id]: {
              status: item.kind === 'started' ? 'running' : 'completed',
            },
          },
        },
      };
    }
    await injectChatEvent(electronApp, {
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      chatId: ACTIVITY_CHAT_ID,
      data: { type: 'codex', event },
    });
  }
}

export async function injectLateActivityMetadata(electronApp) {
  await injectChatEvent(electronApp, {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: ACTIVITY_CHAT_ID,
    data: {
      type: 'codex',
      event: {
        type: 'thread.started',
        thread_id: 'research',
        agent_nickname: 'Tesla',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'root',
              agent_path: '/root/final_review',
            },
          },
        },
        model: 'gpt-5.6-sol',
        reasoning_effort: 'xhigh',
      },
    },
  });
}

export async function assertLateActivityMetadata(panel) {
  const research = panel.getByRole('button', { name: /Tesla agent/ });
  await expect(research).toContainText('Final Review');
  await research.click();
  const configuration = panel.getByTestId('agent-block-configuration').first();
  await expect(configuration).toContainText('gpt-5.6-sol');
  await expect(configuration).toContainText('Extra High');
  await research.click();
}

export async function assertActivityCards(panel, nested = true) {
  const research = panel.getByRole('button', { name: /Tesla agent/ });
  await expect(research).toBeVisible();
  await expect(research).toContainText('Readme Review');
  await expect(
    panel.getByText('Catalog research is ready.', { exact: true }),
  ).not.toBeVisible();
  await expect(
    panel.getByText('The coordinated plan is ready.', { exact: true }),
  ).toBeVisible();
  await research.click();
  await expect(research).toContainText('Readme Review');
  const configuration = panel.getByTestId('agent-block-configuration').first();
  await expect(configuration).toContainText('gpt-6-astra');
  await expect(configuration).toContainText('High');
  await expect(
    panel.getByRole('button', { name: 'Show prompt', exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByText('Catalog research is ready.', { exact: true }),
  ).toBeVisible();
  const desktop = panel.getByRole('button', { name: /Raman agent/ });
  await expect(desktop).toBeVisible();
  await expect(desktop).toContainText('Desktop Install');
  if (nested) {
    await expect(
      panel.getByText('Desktop installation should use an editable copy.', {
        exact: true,
      }),
    ).not.toBeVisible();
    await desktop.click();
    await expect(
      panel.getByText('Desktop installation should use an editable copy.', {
        exact: true,
      }),
    ).toBeVisible();
  }
  await expect(
    panel.getByText(/^Agent \/root.*: (started|interacted|completed)$/),
  ).toHaveCount(0);
  await research.click();
  await expect(desktop).not.toBeVisible();
  await expect(
    panel.getByText('The coordinated plan is ready.', { exact: true }),
  ).toBeVisible();
}

export async function assertActivityFollowup(electronApp, panel) {
  const injectTurn = async (threadId, type) =>
    injectChatEvent(electronApp, {
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      chatId: ACTIVITY_CHAT_ID,
      data: {
        type: 'codex',
        event: { type, thread_id: threadId, turn_id: `${threadId}-follow-up` },
      },
    });
  await injectTurn('root', 'turn.started');
  await injectTurn('research', 'turn.started');
  const card = panel.getByTestId('agent-block').first();
  await expect(
    card.locator('[data-step-row-words].canopy-text-shimmer-strong'),
  ).toBeVisible();
  await injectTurn('research', 'turn.completed');
  await expect(
    card.locator('[data-step-row-words].canopy-text-shimmer-strong'),
  ).toHaveCount(0);
  await injectTurn('root', 'turn.completed');
  await expect(panel.getByTestId('agent-block')).toHaveCount(1);
}

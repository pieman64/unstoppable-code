import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';

export const CREATED_FILES_CHAT = 'created-files-chat';
export const CREATED_FILES_TURN = 'created-files-user';

/** Files the seeded turn writes inside the workspace's `outputs/` folder. */
export const CREATED_FILE_NAMES = [
  'Quarterly report.md',
  'budget.csv',
  'summary.txt',
  'analysis.py',
  'page.html',
];
/**
 * Code chats also carry a captured turn diff listing two of those files, so
 * the summary folds the rest in beside the diff cards instead of repeating
 * them.
 */
export const DIFFED_FILE_NAMES = ['budget.csv', 'summary.txt'];
/** Recorded as created but never written: hidden rather than a dead tile. */
export const MISSING_FILE_NAME = 'deleted.md';
/** Written for real, but outside every workspace root: also hidden. */
export const OUTSIDE_FILE_NAME = 'outside-note.md';

export function seedCreatedFiles(userDataDir, cowork = false) {
  const workspaceId = cowork ? 'cowork-default' : 'demo-ts-pnpm-vite';
  const worktreeId = cowork ? 'created-files-entry' : 'demo-main';
  let root;
  if (cowork) {
    seedCoworkWorkspace({
      userDataDir,
      workspaceId,
      name: 'Deliverables',
      seedMessage: false,
    });
    root = path.join(userDataDir, 'workspaces', workspaceId, 'home');
    writeFileSync(
      path.join(userDataDir, 'workspaces', workspaceId, 'work-entries.json'),
      JSON.stringify({
        version: 1,
        entries: [{ id: worktreeId, createdAt: '2026-09-01T12:00:00.000Z' }],
      }),
    );
  } else {
    root = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] })
      .workspaces[0].worktreePath;
  }
  mkdirSync(path.join(root, 'outputs'), { recursive: true });
  const outsidePath = path.join(userDataDir, OUTSIDE_FILE_NAME);
  writeFileSync(outsidePath, '# Outside note\n');
  const entries = [
    ...CREATED_FILE_NAMES.map((name) => ({
      name,
      absolutePath: path.join(root, 'outputs', name),
      write: true,
    })),
    {
      name: MISSING_FILE_NAME,
      absolutePath: path.join(root, 'outputs', MISSING_FILE_NAME),
      write: false,
    },
    { name: OUTSIDE_FILE_NAME, absolutePath: outsidePath, write: false },
  ];
  const messages = [
    {
      id: CREATED_FILES_TURN,
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Prepare the quarterly report and supporting files.',
        },
      ],
      timestamp: 1,
    },
  ];
  entries.forEach(({ name, absolutePath, write }, index) => {
    if (write)
      writeFileSync(
        absolutePath,
        name.endsWith('.html')
          ? '<!doctype html><title>Quarterly page</title><h1>Quarterly report</h1>'
          : name.endsWith('.csv')
            ? 'Quarter,Revenue\nQ1,120\n'
            : '# Quarterly report\n\nRevenue grew 12%.\n',
      );
    const toolName = index === 0 ? 'app_advisor_show_files' : 'Write';
    const parentToolUseId = index === 1 ? 'report-writer' : undefined;
    if (parentToolUseId)
      messages.push({
        id: 'report-writer',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: parentToolUseId,
            toolName: 'Agent',
            input: JSON.stringify({
              description: 'Prepare supporting files',
              subagent_type: 'general',
              prompt: 'Create the budget',
            }),
          },
        ],
        timestamp: 3.5,
      });
    messages.push({
      id: `write-${index}`,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: `write-${index}`,
          toolName,
          input: JSON.stringify(
            index === 0
              ? { files: [{ path: absolutePath }] }
              : {
                  file_path: absolutePath,
                  content: '# Quarterly report',
                },
          ),
        },
      ],
      timestamp: 2 + index * 2,
    });
    messages.push({
      id: `result-${index}`,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      role: 'system',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: `write-${index}`,
          toolName,
          output:
            index === 0
              ? JSON.stringify({
                  files: [{ path: absolutePath, absolutePath, ok: true }],
                })
              : `File created successfully at: ${absolutePath}`,
          isError: false,
        },
      ],
      timestamp: 3 + index * 2,
    });
    if (parentToolUseId)
      messages.push({
        id: 'report-writer-result',
        role: 'system',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: parentToolUseId,
            toolName: 'Agent',
            output: 'Created the budget',
            isError: false,
          },
        ],
        timestamp: 5.5,
      });
  });
  // Put creation outside the retained tail of this historical turn.
  for (let index = 0; index < 24; index++)
    messages.push({
      id: `progress-${index}`,
      role: 'assistant',
      blocks: [{ type: 'thinking', text: 'Checking the supporting figures.' }],
      timestamp: 20 + index,
    });
  messages.push({
    id: 'created-files-final',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: 'The quarterly report and supporting files are ready.',
      },
    ],
    timestamp: 50,
  });
  messages.push({
    id: 'created-files-timer',
    role: 'system',
    blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 51 }],
    timestamp: 51,
  });
  messages.push({
    id: 'no-files-user',
    role: 'user',
    blocks: [{ type: 'text', text: 'What changed?' }],
    timestamp: 60,
  });
  messages.push({
    id: 'no-files-final',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: 'Revenue grew 12%. See outputs/Quarterly report.md.',
      },
    ],
    timestamp: 61,
  });
  messages.push({
    id: 'no-files-timer',
    role: 'system',
    blocks: [{ type: 'turn_timer', startedAt: 60, completedAt: 62 }],
    timestamp: 62,
  });
  const turnDiffs = cowork
    ? undefined
    : {
        [CREATED_FILES_TURN]: {
          files: DIFFED_FILE_NAMES.map((name, index) => ({
            path: `outputs/${name}`,
            status: 'added',
            insertions: index + 1,
            deletions: 0,
          })),
          totalInsertions: 3,
          totalDeletions: 0,
          capturedAt: 52,
        },
      };
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    providerType: 'claude',
    activeTabId: CREATED_FILES_CHAT,
    tabs: [
      {
        id: CREATED_FILES_CHAT,
        title: 'Quarterly report',
        messages,
        ...(turnDiffs ? { turnDiffs } : {}),
      },
    ],
  });
  return { workspaceId, worktreeId, root, cowork, outsidePath };
}

export async function openCreatedFiles(window, fixture) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  if (fixture.cowork)
    await window
      .getByTestId(`sidebar-work-entry-${fixture.worktreeId}`)
      .click();
  else
    await app.selectWorktree(fixture.worktreeId, {
      expandDefaultActivityRail: false,
    });
  const chat = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CREATED_FILES_CHAT}"]`,
  );
  await expect(chat).toBeVisible();
  await expect(
    chat.getByText('The quarterly report and supporting files are ready.', {
      exact: true,
    }),
  ).toBeVisible();
  return chat;
}

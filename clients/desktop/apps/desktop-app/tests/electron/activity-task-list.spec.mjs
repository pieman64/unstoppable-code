import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'task-list-chat';
const T = Date.parse('2026-04-10T12:00:00.000Z');

function buildMessages() {
  return [
    {
      id: 'task-list-assistant',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'todo-1',
          toolName: 'TodoWrite',
          input: JSON.stringify({
            todos: [
              {
                id: 'todo-a',
                content: 'Review existing todo projection',
                status: 'pending',
              },
            ],
          }),
        },
        {
          type: 'tool_use',
          toolUseId: 'task-create-1',
          toolName: 'TaskCreate',
          input: JSON.stringify({
            taskId: 'renderer-task',
            subject: 'Inspect renderer task state',
            status: 'pending',
          }),
        },
        {
          type: 'tool_use',
          toolUseId: 'task-update-1',
          toolName: 'TaskUpdate',
          input: JSON.stringify({
            taskId: 'renderer-task',
            status: 'in_progress',
          }),
        },
      ],
      timestamp: T,
    },
  ];
}

async function launchTaskListCanopy() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-tasks-'));
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: TAB_ID,
      tabs: [
        {
          id: TAB_ID,
          title: 'Task List',
          messages: buildMessages(),
        },
      ],
    });
    const launched = await launchCanopy({ userDataDir });
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
}

test('renders TaskCreate and TaskUpdate items in the Agent Tasks section', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } = await launchTaskListCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const taskSection = window.getByTestId('activity-section-todo');
    await expect(taskSection).toBeVisible();
    const todoBody = window.getByTestId('activity-todo-body');
    await expect(todoBody).toBeVisible();
    await expect(
      todoBody.getByText('Review existing todo projection', { exact: true }),
    ).toBeVisible();
    await expect(
      todoBody.getByText('Inspect renderer task state', { exact: true }),
    ).toBeVisible();
    await expect(taskSection.getByText('0/2', { exact: true })).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('activity-task-list.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

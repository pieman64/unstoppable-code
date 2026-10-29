import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const T = Date.parse('2026-04-10T12:00:00.000Z');
const TOOL_USE_ID = 'toolu_readlines_last_1';

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function buildMessages() {
  return [
    {
      id: 'turn-1-user',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Show the end of the tool display file.' },
      ],
      timestamp: T,
    },
    {
      id: 'turn-1-assistant',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: TOOL_USE_ID,
          toolName: 'ReadLines',
          input: JSON.stringify({
            file_path:
              'packages/ui-shared/src/components/chat/tool-display.tsx',
            last: '40',
          }),
        },
        {
          type: 'tool_result',
          toolUseId: TOOL_USE_ID,
          toolName: 'ReadLines',
          output: 'tail output',
          isError: false,
        },
      ],
      timestamp: T + 5_000,
    },
    {
      id: 'turn-1-timer',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: T, completedAt: T + 6_000 }],
      timestamp: T + 6_000,
    },
  ];
}

function seedStandaloneReadLinesChat(userDataDir) {
  const rootDir = path.join(userDataDir, 'standalone-chat');
  const projectDir = path.join(rootDir, 'default');
  const createdAt = '2026-04-10T12:00:00.000Z';

  writeJson(path.join(rootDir, 'projects.json'), {
    version: 1,
    projects: [
      {
        id: 'default',
        name: 'Default',
        createdAt,
        color: '#7C9B6D',
        defaultModel: 'gpt-6-luna',
      },
    ],
  });

  writeJson(path.join(projectDir, 'project.json'), {
    version: 1,
    id: 'default',
    name: 'Default',
    createdAt,
    color: '#7C9B6D',
    description: 'ReadLines tool rendering fixture',
    defaultModel: 'gpt-6-luna',
  });

  writeText(
    path.join(projectDir, 'CLAUDE.md'),
    'ReadLines tool rendering fixture instructions.\n',
  );

  writeJson(path.join(projectDir, 'chat-tabs.json'), {
    version: 1,
    activeTabId: 'chat-readlines',
    tabs: [
      {
        id: 'chat-readlines',
        title: 'ReadLines Chat',
        description: 'ReadLines last-label render coverage',
        createdAt,
        providerType: 'claude',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: buildMessages(),
      },
    ],
  });
}

async function launchSeededReadLinesCanopy() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-readlines-tool-'),
  );
  seedStandaloneReadLinesChat(userDataDir);

  try {
    const launched = await launchCanopy({ userDataDir });
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

test('renders ReadLines last-line labels in the desktop chat transcript', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } =
    await launchSeededReadLinesCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openChatPage();

    const page = window.getByTestId('page-chat');
    await expect(page).toBeVisible();

    await page
      .getByRole('button', { name: /Agent steps: 1 read lines/ })
      .click();
    await expect(page).toContainText('tool-display.tsx');
    await expect(page).toContainText('last 40 lines');

    await window.screenshot({
      path: testInfo.outputPath('readlines-tool-render.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

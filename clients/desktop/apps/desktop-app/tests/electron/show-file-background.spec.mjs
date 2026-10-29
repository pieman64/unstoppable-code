// Show File background-target regression coverage.
//
// The agent tool targets a background entry while the user views another one.
// The paired flows cover both the main workspace and App Advisor surfaces: the
// flow proves the tool did not navigate away, then opens the target and proves
// the requested file panel was prepared there.
//
// Deterministic: the git worktrees, App Advisor entries, chats, and target
// Markdown files are seeded before launch. Requests travel through each real
// renderer surface's App Advisor runtime bridge; no live agent or network is
// involved. That bridge exists in both the before and after production builds.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { seedWorktreeChat, writeJson } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const MAIN_WORKTREE = { id: 'demo-main', chatId: 'main-chat' };
const TARGET_WORKTREE = { id: 'demo-feature', chatId: 'feature-chat' };
const TARGET_FILENAME = 'agent-note.md';
const ADVISOR_MAIN = { id: 'advisor-main', chatId: 'advisor-main-chat' };
const ADVISOR_TARGET = {
  id: 'advisor-background',
  chatId: 'advisor-background-chat',
};
const ADVISOR_TARGET_FILENAME = 'advisor-note.md';

function seedTargetWorktree(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const mainPath = path.join(workspaceDir, 'worktrees', MAIN_WORKTREE.id);
  const targetPath = path.join(workspaceDir, 'worktrees', TARGET_WORKTREE.id);
  execFileSync(
    'git',
    [
      '-C',
      mainPath,
      'worktree',
      'add',
      '-b',
      TARGET_WORKTREE.id,
      targetPath,
      'HEAD',
    ],
    { stdio: 'pipe' },
  );

  const worktreesPath = path.join(workspaceDir, 'worktrees.json');
  const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  worktrees.worktrees.push({
    id: TARGET_WORKTREE.id,
    branchName: TARGET_WORKTREE.id,
    createdAt: '2026-08-18T12:00:00.000Z',
    trackedBaseBranch: 'main',
  });
  writeFileSync(worktreesPath, JSON.stringify(worktrees, null, 2), 'utf8');

  const targetFilePath = path.join(targetPath, TARGET_FILENAME);
  writeFileSync(
    targetFilePath,
    '# Prepared in the background\n\nThe Show File tool opened this panel.\n',
    'utf8',
  );

  for (const worktree of [MAIN_WORKTREE, TARGET_WORKTREE]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: worktree.id,
      providerType: 'claude',
      tabs: [{ id: worktree.chatId, title: `${worktree.id} chat` }],
    });
  }
  return targetFilePath;
}

function seedAppAdvisorEntries(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  const createdAt = '2026-08-18T12:00:00.000Z';
  // This fixture is already in the current app-workspaces/home layout. Mark
  // that one-time migration complete so startup does not interpret the seeded
  // home as legacy content and nest it under home/home.
  writeJson(path.join(userDataDir, 'migrations.json'), {
    version: 1,
    app_advisor_home: true,
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      { id: ADVISOR_MAIN.id, createdAt },
      { id: ADVISOR_TARGET.id, createdAt: '2026-08-18T12:01:00.000Z' },
    ],
  });
  for (const entry of [ADVISOR_MAIN, ADVISOR_TARGET]) {
    writeJson(path.join(workspaceDir, 'chats', `${entry.id}.json`), {
      version: 1,
      activeTabId: entry.chatId,
      tabs: [
        {
          id: entry.chatId,
          title: `${entry.id} chat`,
          createdAt,
          kind: 'chat',
          messages: [
            {
              id: `${entry.chatId}-message`,
              role: 'user',
              blocks: [{ type: 'text', text: `Seed ${entry.id}.` }],
              timestamp: Date.parse(createdAt),
            },
          ],
        },
      ],
    });
  }
  const targetFilePath = path.join(
    workspaceDir,
    'home',
    ADVISOR_TARGET_FILENAME,
  );
  mkdirSync(path.dirname(targetFilePath), { recursive: true });
  writeFileSync(
    targetFilePath,
    '# Prepared for App Advisor\n\nThe background entry owns this panel.\n',
    'utf8',
  );
  return targetFilePath;
}

async function dispatchShowFiles(electronApp, surface, request) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { targetSurface, payload }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        const isAdvisor = candidate.webContents
          .getURL()
          .includes('surface=app-advisor');
        return targetSurface === 'app-advisor' ? isAdvisor : !isAdvisor;
      });
      if (!window) {
        throw new Error(`Expected the ${targetSurface} renderer window.`);
      }
      window.webContents.send('app-advisor:tool-request', payload);
    },
    { targetSurface: surface, payload: request },
  );
}

async function visibleChatId(page) {
  try {
    const layout = await getLayout(page);
    if (!layout) return null;
    return (
      collectLeaves(layout.root)
        .flatMap((leaf) => leaf.panels)
        .find((panel) => panel.kind === 'chat')?.instance?.chatTabId ?? null
    );
  } catch {
    // Selection can briefly mount the target grid before its persisted layout
    // is hydrated. Treat that transition as not ready and let polling retry.
    return null;
  }
}

async function expectFilePanel(page, filePath) {
  await expect
    .poll(
      async () => {
        const layout = await getLayout(page).catch(() => null);
        if (!layout) return false;
        return collectLeaves(layout.root).some((leaf) =>
          leaf.panels.some(
            (panel) =>
              panel.kind === 'file-diff' &&
              panel.instance?.filePath === filePath,
          ),
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(
    page.locator('[data-testid="panel-content-file-diff"]:visible'),
  ).toBeVisible();
}

test('Show File prepares background panels without navigating either renderer surface', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-show-file-background-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const targetFilePath = seedTargetWorktree(userDataDir);
  const advisorTargetFilePath = seedAppAdvisorEntries(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(MAIN_WORKTREE.id);
    await expect
      .poll(() => visibleChatId(window), { timeout: 15_000 })
      .toBe(MAIN_WORKTREE.chatId);
    const mainRequestId = 'show-file-main';
    await dispatchShowFiles(electronApp, 'main', {
      kind: 'show_files',
      requestId: mainRequestId,
      payload: {
        target: {
          projectId: WORKSPACE_ID,
          worktreeId: TARGET_WORKTREE.id,
        },
        origin: {
          projectId: WORKSPACE_ID,
          worktreeId: TARGET_WORKTREE.id,
          chatTabId: TARGET_WORKTREE.chatId,
        },
        files: [{ path: targetFilePath, view: 'rich' }],
      },
    });

    await expect
      .poll(() => visibleChatId(window), { timeout: 15_000 })
      .toBe(MAIN_WORKTREE.chatId);

    await app.selectWorktree(TARGET_WORKTREE.id);
    await expect
      .poll(() => visibleChatId(window), { timeout: 15_000 })
      .toBe(TARGET_WORKTREE.chatId);
    await expectFilePanel(window, targetFilePath);

    const advisor = await app.openAppAdvisorWindow(electronApp);
    await advisor
      .getByTestId(`app-advisor-nav-entry-${ADVISOR_MAIN.id}`)
      .click();
    await expect
      .poll(() => visibleChatId(advisor), { timeout: 15_000 })
      .toBe(ADVISOR_MAIN.chatId);
    const advisorRequestId = 'show-file-advisor';
    await dispatchShowFiles(electronApp, 'app-advisor', {
      kind: 'show_files',
      requestId: advisorRequestId,
      payload: {
        target: {
          projectId: 'app-advisor',
          worktreeId: ADVISOR_TARGET.id,
        },
        origin: {
          projectId: 'app-advisor',
          worktreeId: ADVISOR_TARGET.id,
          chatTabId: ADVISOR_TARGET.chatId,
        },
        cwd: path.dirname(advisorTargetFilePath),
        files: [{ path: advisorTargetFilePath, view: 'rich' }],
      },
    });

    await expect
      .poll(() => visibleChatId(advisor), { timeout: 15_000 })
      .toBe(ADVISOR_MAIN.chatId);

    await advisor
      .getByTestId(`app-advisor-nav-entry-${ADVISOR_TARGET.id}`)
      .click();
    await expect
      .poll(() => visibleChatId(advisor), { timeout: 15_000 })
      .toBe(ADVISOR_TARGET.chatId);
    await expectFilePanel(advisor, advisorTargetFilePath);
  } finally {
    try {
      await closeCanopy(electronApp, userDataDir);
    } finally {
      cleanupDemoWorkspaces(seed);
    }
  }
});

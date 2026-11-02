// Idle release of open Claude chats (CAN-4834). An open Claude chat that has
// been idle for its timeout ends its claude CLI without writing anything into
// the chat, and its next message resumes the same provider session. A live
// background task, or a session cron the CLI would fire, keeps the CLI.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { mergeSeedPreferences } from './seeders/mergePreferences.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
// The fake CLI answers only this chat id; the chat is never archived here.
const CHAT_ID = 'claude-auto-archive';
const SESSION_ID = '6f1c2a3e-1b2c-4d5e-8f90-0a1b2c3d4e5f';
const IDLE_TIMEOUT_MS = 60_000;
const FAKE_CLAUDE_CLI = fileURLToPath(
  new URL('./fixtures/fake-claude-auto-archive-cli.mjs', import.meta.url),
);

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function chatStarts(logPath) {
  return readLog(logPath).filter((entry) => entry.type === 'chat_start');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function launch() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-idle-release-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-idle-release.mjs');
  const logPath = path.join(userDataDir, 'fake-claude-idle-release.log');
  copyFileSync(FAKE_CLAUDE_CLI, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Claude idle chat', providerType: 'claude' }],
  });
  mergeSeedPreferences(userDataDir, {
    claudeSessionIdleTimeoutMinutes: IDLE_TIMEOUT_MS / 60_000,
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_AUTO_ARCHIVE_LOG: logPath,
      },
    }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  return { electronApp, userDataDir, logPath, window };
}

function chatPanel(window) {
  return window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
  );
}

async function sendMessage(window, text) {
  const panel = chatPanel(window);
  const composer = panel.getByRole('textbox').first();
  await composer.click();
  await composer.fill(text);
  await panel.getByRole('button', { name: 'Send message' }).click();
}

async function readChat(window) {
  const { snapshot, transcript } = await window.evaluate(
    async ({ projectId, worktreeId, chatId }) => {
      const [state, page] = await Promise.all([
        window.api.chat.getState({ projectId, worktreeId }),
        window.api.chat.getTranscriptPage({ projectId, worktreeId, chatId }),
      ]);
      return { snapshot: state, transcript: page };
    },
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
  );
  const tab = snapshot.tabsFile.tabs.find((entry) => entry.id === CHAT_ID);
  return {
    open: tab !== undefined,
    sdkSessionId: tab?.sdkSessionId ?? null,
    status: snapshot.runtimeByChatId[CHAT_ID]?.status ?? null,
    messages: transcript.messages,
  };
}

test('an idle open Claude chat releases its CLI silently and resumes the same session', async () => {
  test.setTimeout(240_000);
  const { electronApp, userDataDir, logPath, window } = await launch();
  try {
    await sendMessage(window, 'Answer once.');
    await expect(
      chatPanel(window).getByText('Auto archive turn 1 complete'),
    ).toBeVisible({ timeout: 30_000 });
    const [firstStart] = chatStarts(logPath);
    expect(firstStart?.pid).toEqual(expect.any(Number));
    expect(firstStart.resume).toBeNull();
    await expect
      .poll(async () => (await readChat(window)).status, { timeout: 15_000 })
      .toBe('completed');
    const before = await readChat(window);
    expect(before).toMatchObject({
      open: true,
      sdkSessionId: SESSION_ID,
      status: 'completed',
    });
    expect(before.messages.length).toBeGreaterThan(0);

    // Well inside the idle timeout the CLI is still running.
    await new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_MS / 2));
    expect(processIsAlive(firstStart.pid)).toBe(true);

    await expect
      .poll(() => processIsAlive(firstStart.pid), {
        timeout: IDLE_TIMEOUT_MS + 45_000,
      })
      .toBe(false);
    // Nothing was written into the chat: same status, same transcript.
    expect(await readChat(window)).toEqual(before);
    await expect(chatPanel(window).getByText('Interrupted')).toHaveCount(0);

    await sendMessage(window, 'Continue with the earlier context.');
    await expect
      .poll(
        () =>
          chatStarts(logPath)
            .filter((entry) => entry.pid !== firstStart.pid)
            .map((entry) => entry.resume),
        { timeout: 45_000 },
      )
      .toEqual([SESSION_ID]);
    await expect(
      chatPanel(window).getByText(`Resumed ${SESSION_ID} turn 1`),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an idle open Claude chat keeps its CLI while a background Bash task runs', async () => {
  test.setTimeout(300_000);
  const { electronApp, userDataDir, logPath, window } = await launch();
  try {
    await sendMessage(window, 'Start the dev server [background-task]');
    await expect
      .poll(
        () => readLog(logPath).some((entry) => entry.type === 'task_started'),
        { timeout: 30_000 },
      )
      .toBe(true);
    const [start] = chatStarts(logPath);
    expect(start?.pid).toEqual(expect.any(Number));

    // Past the idle timeout: the live task holds the CLI.
    await new Promise((resolve) =>
      setTimeout(resolve, IDLE_TIMEOUT_MS + 15_000),
    );
    expect(processIsAlive(start.pid)).toBe(true);

    writeFileSync(`${logPath}.finish-task`, '');
    await expect
      .poll(
        () => readLog(logPath).some((entry) => entry.type === 'task_finished'),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect
      .poll(() => processIsAlive(start.pid), {
        timeout: IDLE_TIMEOUT_MS * 2 + 45_000,
      })
      .toBe(false);
    expect((await readChat(window)).open).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an idle open Claude chat keeps its CLI while the CLI holds a session cron', async () => {
  test.setTimeout(330_000);
  const { electronApp, userDataDir, logPath, window } = await launch();
  const stopHooks = () =>
    readLog(logPath).filter((entry) => entry.type === 'stop_hook');
  try {
    await sendMessage(window, 'Check CI every five minutes [session-cron]');
    await expect
      .poll(() => stopHooks().map(({ crons, answered }) => [crons, answered]), {
        timeout: 30_000,
      })
      .toEqual([[1, true]]);
    const [start] = chatStarts(logPath);
    expect(start?.pid).toEqual(expect.any(Number));

    // Past the idle timeout: the scheduled prompt holds the CLI.
    await new Promise((resolve) =>
      setTimeout(resolve, IDLE_TIMEOUT_MS + 15_000),
    );
    expect(processIsAlive(start.pid)).toBe(true);

    // A later turn ends with no session crons left.
    await sendMessage(window, 'Stop checking CI.');
    await expect
      .poll(() => stopHooks().map(({ crons }) => crons), { timeout: 30_000 })
      .toEqual([1, 0]);
    await expect
      .poll(() => processIsAlive(start.pid), {
        timeout: IDLE_TIMEOUT_MS * 2 + 45_000,
      })
      .toBe(false);
    expect((await readChat(window)).open).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the Claude idle timeout saves from Settings and leaves the Codex timeout alone', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-idle-settings-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openSettings();
    await app.openSettingsSection('claude');
    const claudeInput = window.getByTestId(
      'settings-claude-idle-timeout-minutes',
    );
    await expect(claudeInput).toHaveValue('10');
    await claudeInput.fill('500');
    await claudeInput.press('Enter');
    await expect(claudeInput).toHaveValue('120');
    await expect
      .poll(() =>
        window.evaluate(() =>
          window.api
            .loadPreferences()
            .then((prefs) => [
              prefs.claudeSessionIdleTimeoutMinutes,
              prefs.codexAppServerIdleTimeoutMinutes,
            ]),
        ),
      )
      .toEqual([120, 10]);

    await app.openSettingsSection('codex');
    await expect(
      window.getByTestId('settings-codex-idle-timeout-minutes'),
    ).toHaveValue('10');
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('claude');
    await expect(
      window.getByTestId('settings-claude-idle-timeout-minutes'),
    ).toHaveValue('120');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

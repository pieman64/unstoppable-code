// Worker-mode Claude transcript import through a real chat send and summary
// helper. A local fake CLI invokes the generated hook commands, so the worker
// service and transcript cursor run without a model or network dependency.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'worker-cursor-chat';
const SUMMARY = 'Worker transcript summary';

function seedWorkerPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
        legalConsentTosVersion: '2026-07-06',
        canopyBackgroundProcessesMode: 'terminal',
        workerConcurrencyLimit: 5,
        summaryModel: 'claude-haiku-4-5-20251001',
        summaryModelSetByUser: true,
        summaryThinkingLevel: 'off',
        defaultWorktreeProvider: 'codex',
      },
    }),
    'utf8',
  );
  writeFileSync(
    path.join(userDataDir, 'migrations.json'),
    JSON.stringify({ version: 1, claude_worker_modes_canopy: true }),
    'utf8',
  );
}

function writeFakeWorkerCli(userDataDir) {
  const scriptPath = path.join(userDataDir, 'fake-worker-claude.cjs');
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const settingsIndex = args.indexOf('--settings');
if (settingsIndex < 0 || !args[settingsIndex + 1]) process.exit(17);
const settingsPath = args[settingsIndex + 1];
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const transcriptPath = path.join(path.dirname(settingsPath), 'fake-worker.jsonl');
writeFileSync(transcriptPath, [
  { type: 'user', uuid: 'worker-e2e-user', message: { role: 'user', content: 'Summarize the request' } },
  { type: 'assistant', uuid: 'worker-e2e-answer', message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(SUMMARY)} }] } },
].map((event) => JSON.stringify(event)).join('\\n') + '\\n');
for (const eventName of ['SessionStart', 'PostToolUse', 'Stop']) {
  const command = settings.hooks[eventName]?.[0]?.hooks?.[0]?.command;
  if (!command) process.exit(18);
  const result = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ transcript_path: transcriptPath }),
    encoding: 'utf8',
    env: process.env,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error || result.status));
    process.exit(19);
  }
}
`,
    'utf8',
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test('terminal summary worker imports each provider event once across hooks', async () => {
  test.skip(
    process.platform === 'win32',
    'The local fixture CLI invokes POSIX hook commands; Windows worker sync remains unit-covered.',
  );
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-worker-cursor-'),
  );
  seedWorkerPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    // A placeholder title keeps the chat eligible for its initial title.
    tabs: [{ id: CHAT_ID, title: 'New Chat' }],
  });
  const fakeClaudePath = writeFakeWorkerCli(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CLAUDE_CODE_EXECUTABLE: fakeClaudePath },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const tab = window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`);
    await expect(tab).toBeVisible();
    const composerRoot = window.locator('[data-chat-composer-root]');
    await expect(composerRoot).toBeVisible();
    const composer = composerRoot.getByRole('textbox');
    await composer.fill('Explain the status of the seeded project.');
    await composerRoot.getByRole('button', { name: 'Send message' }).click();

    // Sending the first chat turn starts the background summary helper. Its
    // terminal-mode worker ingests the same JSONL through three real hooks.
    await expect
      .poll(
        () =>
          window.evaluate(async (chatId) => {
            const snapshot = await window.api.observability.loadSnapshot();
            const entry = snapshot.recentEntries.find(
              (entry) =>
                entry.eventType === 'chat_summary' && entry.chatId === chatId,
            );
            return entry ? { status: entry.status, error: entry.error } : null;
          }, CHAT_ID),
        { timeout: 30_000 },
      )
      .toEqual({ status: 'success', error: undefined });
    await expect(tab).toContainText(SUMMARY, { timeout: 90_000 });
    await expect
      .poll(
        () =>
          window.evaluate(async (expectedSummary) => {
            const snapshot = await window.api.observability.loadSnapshot();
            const summary = snapshot.recentEntries.find(
              (entry) => entry.eventType === 'chat_summary',
            );
            if (!summary || summary.status !== 'success') return null;
            const transcript =
              await window.api.observability.loadTranscript(summary);
            if (transcript.type !== 'success') return null;
            return transcript.lines
              .map((line) => JSON.parse(line))
              .filter(
                (event) =>
                  event.type === 'assistant' &&
                  JSON.stringify(event.message).includes(expectedSummary),
              ).length;
          }, SUMMARY),
        { timeout: 30_000 },
      )
      .toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

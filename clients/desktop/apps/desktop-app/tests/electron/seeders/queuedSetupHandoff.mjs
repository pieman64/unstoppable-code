// CAN-5031: shared by the durable regression and retained before/after capture.
// Hold the existing IPC handler BEFORE invoking it. Unlike a slow provider,
// this leaves a real renderer send awaiting acknowledgement, with no runtime
// start receipt that could hide the pre-dispatch regression.
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { selectModelOption } from '../model-selection-fixture.mjs';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from '../launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './registerScenario.mjs';
import { withBundledBinaryOverridesScrubbed } from './bundledBinaryOverrides.mjs';

export async function launchQueuedSetupHandoff({ colorMode = 'light' } = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-5031-handoff-'));
  const releasePath = path.join(userDataDir, 'release-git');
  const shimPath = path.join(userDataDir, 'git-handoff.sh');
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: false,
  });
  writeFileSync(
    shimPath,
    `#!/bin/sh
case "$*" in *"worktree add"*)
  count=0
  while [ ! -f '${releasePath}' ] && [ "$count" -lt 1800 ]; do
    sleep 0.1
    count=$((count + 1))
  done;;
esac
exec /usr/bin/git "$@"
`,
  );
  chmodSync(shimPath, 0o755);
  const marker = `Canopy-C5031${colorMode}`;
  const first = `[${marker}] First setup prompt`;
  const second = 'Second setup prompt';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        { text: 'First prompt completed.', streamMs: 6_000, chunkChars: 2 },
        { text: 'Second prompt completed.', stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      rootPath: process.env.CAN5031_BASE_ROOT
        ? realpathSync(process.env.CAN5031_BASE_ROOT)
        : undefined,
      env: {
        CANOPY_GIT_EXECUTABLE: shimPath,
        CANOPY_E2E_CAPTURE_COLOR_MODE: colorMode,
      },
    }),
  );
  const close = async () => {
    writeFileSync(releasePath, 'ready');
    await electronApp
      .evaluate(() => globalThis.__can5031Release?.())
      .catch(() => {});
    await closeCanopy(electronApp, userDataDir);
  };
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('chat:send-message');
      if (!original) throw new Error('Missing real chat send handler');
      globalThis.__can5031Requests = [];
      ipcMain.removeHandler('chat:send-message');
      ipcMain.handle('chat:send-message', async (event, request) => {
        globalThis.__can5031Requests.push(request);
        if (globalThis.__can5031Requests.length === 1) {
          await new Promise((resolve) => {
            globalThis.__can5031Release = resolve;
          });
        }
        return original(event, request);
      });
    });
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'TypeScript pnpm Vite',
    );
    await home.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'claude-haiku-4-5-20251001');
    await home.getByTestId('home-composer-editor').fill(first);
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(
      panel.getByTestId('queued-message-setup-reason').first(),
    ).toBeVisible();
    // Home first renders a provisional setup echo. Its admission guard still
    // owns the composer until sendMessage hands it to the real local queue.
    // The Edit action becomes enabled after renderer-local admission.
    await expect(async () => {
      const more = panel.getByTestId('queued-message-more').first();
      if ((await more.getAttribute('aria-expanded')) !== 'true') {
        await more.click();
      }
      await expect(window.getByTestId('queued-message-edit')).toBeEnabled({
        timeout: 1_000,
      });
    }).toPass({ timeout: 30_000 });
    await window.keyboard.press('Escape');
    const composer = panel.getByRole('textbox').first();
    await composer.fill(second);
    await composer.press('Enter');
    await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(2);
    const followUp = () =>
      panel.getByTestId('queued-message-bubble').filter({ hasText: second });
    await expect(followUp()).toBeVisible();
    // Observe before setup release. This supplements direct held-state checks;
    // MutationObserver alone cannot prove every transient rendered frame.
    await window.evaluate((text) => {
      const actions = [];
      const observer = new MutationObserver(() => {
        for (const row of document.querySelectorAll(
          '[data-testid="queued-message-bubble"]',
        )) {
          if (!row.textContent?.includes(text)) continue;
          for (const button of row.querySelectorAll('button')) {
            if (/Retry|Interrupt/.test(button.textContent ?? ''))
              actions.push(button.textContent);
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      window.__can5031Observed = { actions, stop: () => observer.disconnect() };
    }, second);
    writeFileSync(releasePath, 'ready');
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__can5031Requests.length),
      )
      .toBe(1);
    await expect(
      panel.getByText('Starting…', { exact: true }).first(),
    ).toBeVisible();
    await expect(followUp()).toBeVisible();
    const requests = () =>
      electronApp.evaluate(() => globalThis.__can5031Requests);
    const providerRequests = async () =>
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker)).activity
        .llmRequests ?? 0;
    const release = async () => {
      await window.evaluate(() => window.__can5031Observed?.stop());
      await electronApp.evaluate(() => globalThis.__can5031Release());
    };
    return {
      window,
      panel,
      followUp,
      requests,
      providerRequests,
      release,
      close,
      first,
      second,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function assertHeldLocalQueue(harness) {
  const { window, followUp, requests } = harness;
  const row = followUp();
  await expect(
    window.getByRole('list', { name: 'Queued messages' }),
  ).toBeVisible();
  await expect(row.getByTestId('queued-message-retry')).toHaveCount(0);
  await expect(row.getByTestId('queued-message-interrupt')).toHaveCount(0);
  expect(await row.ariaSnapshot()).not.toMatch(
    /button.*(?:Retry|Interrupt|Send now)/,
  );
  expect((await requests()).map((request) => request.text)).toEqual([
    harness.first,
  ]);
  expect(await window.evaluate(() => window.__can5031Observed.actions)).toEqual(
    [],
  );
}

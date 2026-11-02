import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { openPipelineAssistant } from '../pipelineAssistant.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from '../demoWorkspaces.mjs';
import { launchCanopy, closeCanopy } from '../launchCanopy.mjs';
import { writeJson } from './fsHelpers.mjs';
import {
  getScenarioActivity,
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
} from './registerScenario.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';
import { composerIdleAction } from '../composerIdleAction.mjs';

// Real bundled provider sessions against the harness mock server. Each send
// goes through the visible composer; no replacement session/callback mock.
export async function runSessionReuseFlow({
  surface,
  providerType,
  firstOnly = false,
  captureDir,
  stage = 'after',
  queueAction,
}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2835-reuse-'));
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const model = providerType === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5';
  const marker = `Canopy-C2835${surface.toUpperCase()}${providerType.toUpperCase()}${queueAction ?? ''}`;
  const replies = [1, 2, 3].map(
    (n) => `Confirmed ${surface} ${providerType} response ${n}.`,
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: model,
      appAdvisorThinkingLevel: 'off',
      defaultChatProvider: providerType,
      defaultWorktreeProvider: providerType,
      defaultChatModelByProvider: {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'off' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'off' },
      },
      defaultWorktreeModelByProvider: {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'off' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'off' },
      },
      defaultAppAdvisorInterfaceMode: 'canopy',
      defaultStandaloneChatInterfaceMode: 'canopy',
      defaultChatInterfaceMode: 'canopy',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    },
  });
  const workspaceId = 'reuse-cowork',
    entryId = 'reuse-entry',
    chatId = 'reuse-chat';
  if (surface === 'cowork') {
    const indexPath = path.join(userDataDir, 'workspaces/index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const entries = index.items ?? index.workspaces;
    entries.push({
      id: workspaceId,
      name: 'Session Reuse Cowork',
      type: 'cowork',
      color: '#7C9B6D',
      collapsed: false,
      order: entries.length,
    });
    writeJson(indexPath, index);
    const dir = path.join(userDataDir, 'workspaces', workspaceId);
    writeJson(path.join(dir, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: {
        createdAt: '2026-09-01T12:00:00.000Z',
        defaultModel: model,
        searchIndexingEnabled: false,
      },
    });
    writeJson(path.join(dir, 'work-entries.json'), {
      version: 1,
      entries: [{ id: entryId, createdAt: '2026-09-01T12:00:00.000Z' }],
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: entryId,
      providerType,
      tabs: [
        {
          id: chatId,
          title: 'Session reuse',
          model,
          interfaceMode: 'canopy',
          messages: [
            {
              id: 'reuse-seed-user',
              role: 'user',
              blocks: [
                { type: 'text', text: 'Check consecutive chat replies.' },
              ],
              timestamp: Date.parse('2026-09-01T12:00:00.000Z'),
            },
            {
              id: 'reuse-seed-assistant',
              role: 'assistant',
              blocks: [
                { type: 'text', text: 'Ready for the session reuse check.' },
              ],
              timestamp: Date.parse('2026-09-01T12:00:01.000Z'),
            },
          ],
        },
      ],
    });
  } else if (surface === 'worktree') {
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType,
      tabs: [
        {
          id: chatId,
          title: 'Session reuse',
          model,
          // Saved as an app-created tab saves it. Without it, main reads the
          // tab as 'high' while the composer sends the 'off' default, and a
          // queued message cannot steer.
          thinkingLevel: 'off',
          interfaceMode: 'canopy',
        },
      ],
    });
  }
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: replies[0], stopReason: 'end_turn' }],
      stepsByRequestTag: Object.fromEntries(
        replies.map((text, i) => [
          `turn${i + 1}`,
          {
            text,
            stopReason: 'end_turn',
            ...(queueAction && i === 0
              ? {
                  streamMs: queueAction === 'steer-pickup' ? 12_000 : 60_000,
                  chunkChars: 1,
                }
              : {}),
          },
        ]),
      ),
    },
  });
  let electronApp;
  async function open() {
    ({ electronApp } = await launchCanopy({
      userDataDir,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    if (surface === 'advisor') {
      const advisor = await app.openAppAdvisorWindow(electronApp);
      return {
        page: advisor,
        panel: advisor.getByTestId('app-advisor-workspace-surface'),
      };
    }
    if (surface === 'pipeline') {
      return { page: window, panel: await openPipelineAssistant(app) };
    }
    await app.openMainPage();
    if (surface === 'cowork') {
      const toggle = window.getByTestId(
        `sidebar-cowork-project-${workspaceId}-toggle`,
      );
      if ((await toggle.getAttribute('aria-expanded')) !== 'true')
        await toggle.click();
      await window.getByTestId(`sidebar-work-entry-${entryId}`).click();
    } else await app.selectWorktree('demo-main');
    return {
      page: window,
      panel: window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
      ),
    };
  }
  try {
    let { page, panel } = await open();
    await expect(panel).toBeVisible();
    if (queueAction) {
      const composer = panel.getByRole('textbox').first();
      const submittedMessages = [];
      for (let i = 0; i < 3; i++) {
        const message = `[${marker}] [Canopy-Mock-Request:turn${i + 1}] Test queued message ${i + 1}.`;
        submittedMessages.push(message);
        await composer.fill(message);
        await expect(composer).toContainText(message);
        // A polling callback must not resubmit while the async send clears
        // Slate: several Enter presses can create overlapping turns.
        await composer.press('Enter');
        await expect(composer).not.toContainText(message);
        await expect(panel.getByTestId('chat-stop-generation')).toBeVisible();
        await expect(
          panel.getByText(message, { exact: true }).first(),
        ).toBeVisible();
        await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(i);
      }
      const queued = panel.getByTestId('queued-message-bubble');
      await expect(queued).toHaveCount(2);
      const expectEachSubmittedOnce = async () => {
        for (const message of submittedMessages) {
          await expect(panel.getByText(message, { exact: true })).toHaveCount(
            1,
          );
        }
      };
      await expectEachSubmittedOnce();
      if (queueAction === 'steer' || queueAction === 'steer-pickup') {
        await queued
          .first()
          .getByRole('button', { name: 'Steer', exact: true })
          .click({ timeout: 5000 });
        const pending = panel.getByTestId('input-delivery-row');
        await expect(queued).toHaveCount(1);
        if (queueAction === 'steer-pickup') {
          if (providerType === 'codex') {
            await expect(
              pending.getByRole('button', {
                name: 'Cancel pending message',
                exact: true,
              }),
            ).toHaveCount(0);
          }
          await expect(
            panel.getByText(replies[1], { exact: true }).first(),
          ).toBeVisible({ timeout: 60_000 });
          await expect(
            panel.getByText(replies[2], { exact: true }).first(),
          ).toBeVisible({ timeout: 45_000 });
          await expect(queued).toHaveCount(0);
          await expect(pending).toHaveCount(0);
          await expect(composerIdleAction(panel)).toBeVisible();
          await expect(
            panel.locator('[data-testid="turn-timer"][data-state="live"]'),
          ).toHaveCount(0);
          await expectEachSubmittedOnce();
          return;
        }
        await expect(pending).toContainText('Sending…');
        await pending
          .getByRole('button', {
            name: 'Cancel pending message',
            exact: true,
          })
          .click();
        await expect(pending).toContainText('Cancelled');
      }
      const stop = panel.getByTestId('chat-stop-generation');
      await stop.click();
      await expect(
        panel.getByText(replies[2], { exact: true }).first(),
      ).toBeVisible({ timeout: 45_000 });
      await expect(panel.getByText(replies[1], { exact: true })).toHaveCount(
        queueAction === 'steer' ? 0 : 1,
      );
      await expect(queued).toHaveCount(0);
      await expect(composerIdleAction(panel)).toBeVisible();
      await expectEachSubmittedOnce();
      return;
    }
    for (let i = 0; i < (firstOnly ? 1 : 2); i++) {
      const composer = panel.getByRole('textbox').first();
      await composer.fill(
        `[${marker}] [Canopy-Mock-Request:turn${i + 1}] Reply to test turn ${i + 1}.`,
      );
      await panel.getByRole('button', { name: 'Send message' }).click();
      if (captureDir && stage === 'before' && i === 1) {
        await expect(panel.getByText(replies[i], { exact: true })).toHaveCount(
          0,
        );
        await page.waitForTimeout(5_000);
      } else {
        try {
          await expect(
            panel.getByText(replies[i], { exact: true }).first(),
          ).toBeVisible({ timeout: 45_000 });
        } catch (error) {
          if (surface === 'pipeline' && providerType === 'codex' && i === 0) {
            const mainLogPath = path.join(userDataDir, 'logs', 'main.log');
            const diagnostics = await Promise.allSettled([
              (async () => {
                const activity = await getScenarioActivity(
                  DEFAULT_MOCK_BASE_URL,
                  marker,
                  { signal: AbortSignal.timeout(5_000) },
                );
                await test.info().attach('pipeline-codex-mock-activity', {
                  body: Buffer.from(JSON.stringify(activity)),
                  contentType: 'application/json',
                });
              })(),
              (async () => {
                if (!existsSync(mainLogPath)) return;
                await test.info().attach('pipeline-codex-main-log', {
                  path: mainLogPath,
                  contentType: 'text/plain',
                });
              })(),
            ]);
            process.stdout.write(
              `PIPELINE_CODEX_DIAGNOSTIC ${JSON.stringify({
                marker,
                mainLogPresent: existsSync(mainLogPath),
                attachments: diagnostics.map((result) => result.status),
              })}\n`,
            );
          }
          throw error;
        }
        await expect(composerIdleAction(panel)).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          panel.locator('[data-testid="turn-timer"][data-state="live"]'),
        ).toHaveCount(0);
      }
    }
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      await panel.screenshot({
        path: path.join(captureDir, `${surface}-${providerType}-${stage}.png`),
        animations: 'disabled',
      });
    }
    if (!firstOnly && !(captureDir && stage === 'before')) {
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;
      // Inspect canonical chat files only; provider transcripts cannot satisfy
      // this assertion. Reopening below separately proves hydration/display.
      const canonicalRoots = [
        path.join(userDataDir, 'workspaces'),
        path.join(userDataDir, 'app-workspaces'),
      ];
      const saved = canonicalRoots.map(readCanonicalChats).join('\n');
      expect(saved).toContain(replies[0]);
      expect(saved).toContain(replies[1]);
      ({ page, panel } = await open());
      await expect(
        panel.getByText(replies[0], { exact: true }).first(),
      ).toBeVisible();
      await expect(
        panel.getByText(replies[1], { exact: true }).first(),
      ).toBeVisible();
      await panel
        .getByRole('textbox')
        .first()
        .fill(`[${marker}] [Canopy-Mock-Request:turn3] Reply after restart.`);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(
        panel.getByText(replies[2], { exact: true }).first(),
      ).toBeVisible({ timeout: 45_000 });
    }
  } finally {
    if (electronApp)
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: Boolean(queueAction),
      });
    cleanupDemoWorkspaces(demo);
  }
}

function readCanonicalChats(root) {
  if (!existsSync(root)) return '';
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) return readCanonicalChats(file);
      const isCanonicalChat =
        file.includes(`${path.sep}chats${path.sep}`) ||
        (file.includes(`${path.sep}chat-storage-v2${path.sep}`) &&
          file.includes(`${path.sep}transcripts${path.sep}`));
      return isCanonicalChat && /\.(json|jsonl)$/.test(file)
        ? readFileSync(file, 'utf8')
        : '';
    })
    .join('\n');
}

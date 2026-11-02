import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

// Real provider tool dispatch -> shared family -> desktop port -> main
// evaluator -> renderer mirror. The provider is the deterministic local mock.
test('an agent stores Early access and independent Files preferences through the shared action and reports refusals', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-labs-action-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspaceId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  const chatId = 'labs-action-chat';
  const marker = 'Canopy-CLABSCHOICES';
  const filesId = 'daemon-files-reads';
  const action = (experimentId, enabled) => ({
    name: 'mcp__canopy__DispatchAction',
    input: {
      action: { type: 'experiments.set_enabled', experimentId, enabled },
    },
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    providerType: 'claude',
    tabs: [
      { id: chatId, title: 'Labs preferences', approvalMode: 'full-access' },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        { toolCalls: [action('early-access', true)], stopReason: 'tool_use' },
        {
          toolCalls: [action('unknown-experiment', true)],
          stopReason: 'tool_use',
        },
        { toolCalls: [action('early-access', false)], stopReason: 'tool_use' },
        {
          toolCalls: [action(filesId, true)],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [action(filesId, false)],
          stopReason: 'tool_use',
        },
        { text: 'Experiment preferences recorded.', stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Store the experiment preferences.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    const read = () =>
      window.evaluate((request) => window.api.chat.getTranscriptPage(request), {
        projectId: workspaceId,
        worktreeId,
        chatId,
      });
    await expect
      .poll(
        async () => {
          const transcript = await read();
          return transcript.messages.some((message) =>
            message.blocks.some(
              (block) =>
                block.type === 'text' &&
                block.text.includes('Experiment preferences recorded.'),
            ),
          );
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    const results = (await read()).messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'tool_result')
      .map((block) => JSON.parse(block.output));
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      ok: true,
      result: {
        experimentId: 'early-access',
        storedChoice: true,
        effectiveEnabledAtCommit: true,
        listedAtCommit: true,
      },
    });
    expect(results[1]).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(results[2]).toMatchObject({
      ok: true,
      result: { storedChoice: false, effectiveEnabledAtCommit: false },
    });
    for (const [index, enabled] of [
      [3, true],
      [4, false],
    ]) {
      expect(results[index]).toMatchObject({
        ok: true,
        result: {
          experimentId: filesId,
          storedChoice: enabled,
          effectiveEnabledAtCommit: enabled,
          listedAtCommit: true,
        },
      });
      expect(results[index].result.revisionAtCommit).toBeGreaterThan(
        results[index - 1].result.revisionAtCommit,
      );
    }
    const { experiments } = await window.evaluate(() =>
      window.api.experiments.getSnapshot(),
    );
    for (const id of ['early-access', filesId])
      expect(experiments.find((entry) => entry.id === id)).toMatchObject({
        choice: false,
        enabled: false,
      });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo.createdDirs);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
  }
});

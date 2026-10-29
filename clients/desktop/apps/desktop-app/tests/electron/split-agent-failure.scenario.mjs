import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

export async function runSplitAgentFailure(options = {}) {
  const branched = options.branched === true;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-failed-split-'),
  );
  const scope = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
  const sourceId = 'failed-split-source';
  const marker = branched ? 'Canopy-CBRANCHFAILURE' : 'Canopy-CSPLITFAILURE';
  const childMarker = `${marker}CHILD`;
  const childReply = 'The retried independent task completed.';
  const retryReply = 'The retry started successfully.';
  const toolStep = {
    toolCalls: [
      {
        name: branched
          ? 'mcp__canopy__StartBranchedAgent'
          : 'mcp__canopy__StartForkedAgent',
        input: {
          followUpInstruction: `[${childMarker}] [Canopy-Mock-Request:split-child] Complete the independent task`,
        },
      },
    ],
    stopReason: 'tool_use',
  };
  const sourceReply =
    'Fork startup failed; the original conversation can continue.';
  const failure = 'Injected fork prompt persistence failure';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: scope.projectId,
    worktreeId: scope.worktreeId,
    providerType: 'claude',
    tabs: [
      {
        id: sourceId,
        title: 'Original task',
        approvalMode: 'full-access',
        hasStartedSession: true,
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      stepsByRequestTag: {
        'split-child': { text: childReply, stopReason: 'end_turn' },
      },
      steps: [
        toolStep,
        { text: sourceReply, stopReason: 'end_turn' },
        toolStep,
        { text: retryReply, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, childMarker, {
    llm: { steps: [{ text: childReply, stopReason: 'end_turn' }] },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(scope.worktreeId);
    // Fail the initial prompt commit only after the canonical fork is durable.
    // This exercises the real tool/dispatch/state/renderer path without adding
    // a production test seam or depending on Claude's startup timing.
    await electronApp.evaluate(
      (_electron, { sourceId, failure, branched }) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const syncFs = process.getBuiltinModule('node:fs');
        const originalRename = fs.rename;
        globalThis.__splitFailureCount = 0;
        fs.rename = async (...args) => {
          const target = String(args[1]).replaceAll('\\', '/');
          if (
            !globalThis.__splitFailureCount &&
            target.includes('/transcripts/') &&
            target.endsWith(branched ? '.jsonl' : '.active.json') &&
            !target.includes(sourceId) &&
            syncFs
              .readFileSync(args[0], 'utf8')
              .includes(branched ? 'Continue' : '"text":"Continue"')
          ) {
            globalThis.__splitFailureCount++;
            throw new Error(failure);
          }
          return originalRename(...args);
        };
        process.getBuiltinModule('node:module').syncBuiltinESMExports();
      },
      { sourceId, failure, branched },
    );
    const panel = window.getByTestId('panel-content-chat');
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        `[${marker}] Start an independent forked agent, then continue this task`,
      );
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(
        async () => {
          const page = await window.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...scope, chatId: sourceId },
          );
          return page.messages
            .flatMap((message) => message.blocks)
            .some(
              (block) => block.type === 'text' && block.text === sourceReply,
            );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__splitFailureCount), {
        timeout: 15_000,
      })
      .toBe(1);
    const page = await window.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...scope, chatId: sourceId },
    );
    const firstReceiptBlock = page.messages
      .flatMap((message) => message.blocks)
      .find(
        (block) =>
          block.type === 'tool_result' &&
          !block.isError &&
          block.output?.includes('"independent":true'),
      );
    const failedScope = branched
      ? {
          ...scope,
          worktreeId: JSON.parse(firstReceiptBlock.output).worktreeId,
        }
      : scope;
    if (options.captureDir) {
      mkdirSync(options.captureDir, { recursive: true });
      if (options.stage !== 'before') {
        await expect
          .poll(
            async () => {
              const state = await window.evaluate(
                (target) => window.api.chat.getState(target),
                failedScope,
              );
              return state.tabsFile.tabs.some(
                (tab) => tab.id === JSON.parse(firstReceiptBlock.output).chatId,
              );
            },
            { timeout: 15_000 },
          )
          .toBe(false);
      }
      await app.selectWorktree(failedScope.worktreeId);
      if (options.stage !== 'before')
        await expect(
          window
            .getByTestId('panel-content-chat')
            .getByText('Send a message to start working'),
        ).toBeVisible();
      await window
        .locator('[data-testid="panel-content-chat"]')
        .first()
        .screenshot({
          path: path.join(
            options.captureDir,
            `queued-branch-${options.stage ?? 'after'}.png`,
          ),
          animations: 'disabled',
        });
      return;
    }
    if (!branched)
      expect(page.messages.flatMap((message) => message.blocks)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_result', isError: true }),
        ]),
      );
    await app.selectWorktree(scope.worktreeId);
    await window.getByTestId(`panel-tab-panel-chat-${sourceId}`).click();
    // Selecting an empty branch can publish a new blank chat. Assert removal
    // of the failed startup identity without depending on that UI timing.
    await expect
      .poll(
        async () => {
          const state = await window.evaluate(
            (target) => window.api.chat.getState(target),
            failedScope,
          );
          return branched
            ? state.tabsFile.tabs.some(
                (tab) => tab.id === JSON.parse(firstReceiptBlock.output).chatId,
              )
            : state.tabsFile.tabs.map((tab) => tab.id);
        },
        { timeout: 15_000 },
      )
      .toEqual(branched ? false : [sourceId]);
    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toHaveCount(1);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.selectWorktree(scope.worktreeId);
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${sourceId}`),
    ).toBeVisible();
    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toHaveCount(1);
    await window.getByTestId(`panel-tab-panel-chat-${sourceId}`).click();
    await expect(panel.first().getByText(sourceReply).first()).toBeVisible();
    await panel
      .first()
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Retry the independent fork now`);
    await panel.first().getByRole('button', { name: 'Send message' }).click();
    let receipt;
    await expect
      .poll(
        async () => {
          const transcript = await window.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...scope, chatId: sourceId },
          );
          const successful = transcript.messages
            .flatMap((message) => message.blocks)
            .find(
              (block) =>
                block.type === 'tool_result' &&
                !block.isError &&
                block.output !== firstReceiptBlock?.output &&
                block.output?.includes('"independent":true'),
            );
          if (successful) receipt = JSON.parse(successful.output);
          return Boolean(receipt);
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const transcript = await window.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            {
              ...scope,
              worktreeId: receipt.worktreeId,
              chatId: receipt.chatId,
            },
          );
          return transcript.messages
            .flatMap((message) => message.blocks)
            .some(
              (block) => block.type === 'text' && block.text === childReply,
            );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const state = await window.evaluate(
      (target) => window.api.chat.getState(target),
      scope,
    );
    expect(state.tabsFile.tabs.map((tab) => tab.id).sort()).toEqual(
      (branched ? [sourceId] : [sourceId, receipt.chatId]).sort(),
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}

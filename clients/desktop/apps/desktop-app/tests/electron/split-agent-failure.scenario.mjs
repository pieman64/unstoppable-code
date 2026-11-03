import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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

/**
 * The worktree a branched agent created beside the seeded source one. A
 * failed startup closes only its chat, so that worktree stays listed.
 */
async function createdWorktreeId(userDataDir, scope) {
  const created = () =>
    JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', scope.projectId, 'worktrees.json'),
        'utf8',
      ),
    )
      .worktrees.filter((worktree) => worktree.id !== scope.worktreeId)
      .map((worktree) => worktree.id);
  await expect.poll(() => created().length, { timeout: 15_000 }).toBe(1);
  return created()[0];
}

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
    // a production test seam or depending on Claude's startup timing. In both
    // the same-worktree and branched cases the child's initial prompt commits
    // by publishing its `.active.json` sidecar, then appending to `.jsonl`.
    await electronApp.evaluate(
      (_electron, { sourceId, failure }) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const syncFs = process.getBuiltinModule('node:fs');
        const originalRename = fs.rename;
        globalThis.__splitFailureCount = 0;
        fs.rename = async (...args) => {
          const target = String(args[1]).replaceAll('\\', '/');
          if (
            !globalThis.__splitFailureCount &&
            target.includes('/transcripts/') &&
            target.endsWith('.active.json') &&
            !target.includes(sourceId) &&
            syncFs.readFileSync(args[0], 'utf8').includes('"text":"Continue"')
          ) {
            globalThis.__splitFailureCount++;
            throw new Error(failure);
          }
          return originalRename(...args);
        };
        process.getBuiltinModule('node:module').syncBuiltinESMExports();
      },
      { sourceId, failure },
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
    // The child's prompt commits as part of its send in both cases: a
    // branched child's send is held in main for the new worktree's Git setup,
    // which commits the prompt before it waits (CAN-5483). So the failure
    // reaches the source's tool call as an error, never a success receipt.
    const sourceBlocks = page.messages.flatMap((message) => message.blocks);
    expect(sourceBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_result',
          isError: true,
          output: expect.stringContaining(failure),
        }),
      ]),
    );
    expect(
      sourceBlocks.some(
        (block) =>
          block.type === 'tool_result' &&
          block.output?.includes('"independent":true'),
      ),
    ).toBe(false);
    const failedScope = branched
      ? { ...scope, worktreeId: await createdWorktreeId(userDataDir, scope) }
      : scope;
    // The failed child, if it was ever published, was forked from the source.
    const hasFailedChild = (tabs) =>
      tabs.some((tab) => tab.forkedFrom?.chatId === sourceId);
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
              return hasFailedChild(state.tabsFile.tabs);
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
            ? hasFailedChild(state.tabsFile.tabs)
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

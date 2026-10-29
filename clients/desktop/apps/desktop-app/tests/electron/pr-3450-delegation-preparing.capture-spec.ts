// @capture-keep: reusable PR evidence for route-pending delegated task cards
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/17-phase-4-review-polish.md
// PR #3450: delegated cards omit unavailable route ids while preparation is pending.
// PR3450_STAGE=before pnpm run test:electron:captures:built pr-3450-delegation-preparing.capture-spec.ts --reporter=line
// PR3450_STAGE=before pnpm run test:electron:captures:built pr-3450-delegation-preparing.capture-spec.ts --reporter=line --dark-mode
// PR3450_STAGE=after pnpm run test:electron:captures:built pr-3450-delegation-preparing.capture-spec.ts --reporter=line
// PR3450_STAGE=after pnpm run test:electron:captures:built pr-3450-delegation-preparing.capture-spec.ts --reporter=line --dark-mode
// The transcript is seeded locally with a route-less pending delegation; no live agent or network is used.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const STAGE = process.env.PR3450_STAGE === 'before' ? 'before' : 'after';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(root, '.playwright/pr-3450');

test('captures route preparation metadata without empty identifiers', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'delegation-preparing-capture-'),
  );
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  mkdirSync(captureDir, { recursive: true });
  const delegationId = '11111111-1111-4111-8111-111111111111';
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'history',
        title: 'Preparing delegated review',
        providerType: 'codex',
        executionHarness: 'codex',
        model: 'gpt-6-sol',
        messages: [
          {
            id: 'request',
            role: 'user',
            timestamp: 1788825600000,
            blocks: [
              {
                type: 'text',
                text: 'Ask another model to review the error handling.',
              },
            ],
          },
          {
            id: 'parent-answer',
            role: 'assistant',
            timestamp: 1788825601005,
            blocks: [{ type: 'text', text: 'Parent answer remains separate.' }],
          },
        ],
      },
    ],
  });
  const runsDir = path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktree-data',
    'demo-main',
    'delegation',
    'runs',
  );
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(runsDir, `${delegationId}.json`),
    JSON.stringify({
      version: 1,
      parent: {
        harnessId: 'codex',
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        chatId: 'history',
        sessionKey: 'demo-ts-pnpm-vite/demo-main/history',
        turnId: 'native-provider-turn',
        userMessageId: 'request',
        toolCallId: 'delegation-call',
        runtimeGeneration: 1,
        depth: 0,
      },
      task: {
        modelId: 'retired-reviewer',
        description: 'Review error handling',
        prompt: 'Inspect src/index.ts for error-handling gaps.',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
        executionMode: 'background',
      },
      callKey: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      createdAt: 1788825601000,
      deadlineAt: 1788825611000,
      state: {
        delegationId,
        runGeneration: 1,
        sequence: 0,
        status: 'pending',
        outputTruncated: false,
        transcript: [],
      },
      launch: {
        version: 1,
        delegationId,
        runGeneration: 1,
        launchKey: 'a'.repeat(64),
        phase: 'reserved',
      },
      delivery: { status: 'unclaimed' },
    }),
    { mode: 0o600 },
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const card = window.getByTestId('chat-delegated-agent');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Expand delegated task' }).click();
    await card.screenshot({
      path: path.join(captureDir, `delegation-preparing-${STAGE}.png`),
      animations: 'disabled',
    });
    await expect(card.locator('dd').nth(1)).toHaveText(
      STAGE === 'before' ? '()' : 'Preparing',
    );
    if (STAGE === 'after') {
      await expect(card).not.toContainText('()');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

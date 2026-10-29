// @capture-keep: reusable visual evidence for managed delegation in the parent transcript
// @capture-reference: apps/desktop-app/tests/electron/managed-delegation.spec.mjs
// Cross-provider subagents Phase 1: verify the existing parent transcript renders
// the new managed tools and bounded completion data without a nested UI change.
// Run on the unchanged and changed builds, in both appearances:
//   DELEGATION_STAGE=before pnpm run test:electron:captures:built managed-delegation-parent.capture-spec.ts --reporter=line
//   DELEGATION_STAGE=before pnpm run test:electron:captures:built managed-delegation-parent.capture-spec.ts --reporter=line --dark-mode
//   DELEGATION_STAGE=after pnpm run test:electron:captures:built managed-delegation-parent.capture-spec.ts --reporter=line
//   DELEGATION_STAGE=after pnpm run test:electron:captures:built managed-delegation-parent.capture-spec.ts --reporter=line --dark-mode
// Identical seeded protocol data is used in both stages. No live agent or network
// inference participates. Durable native behavior belongs to managed-delegation.spec.mjs.
import { mkdirSync, mkdtempSync } from 'node:fs';
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

const STAGE = process.env.DELEGATION_STAGE === 'before' ? 'before' : 'after';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(
  root,
  '.playwright/cross-provider-subagents/phase-1',
);

test('captures retained managed task and completion in the parent transcript', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'delegation-capture-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  mkdirSync(captureDir, { recursive: true });
  const finding =
    'The error handler should retain the original cause when the source file cannot be read.';
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'managed-parent',
        title: 'Independent error handling review',
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
                text: 'Ask a Claude model for an independent review of the error handling, then assess its finding.',
              },
            ],
          },
          {
            id: 'parent',
            role: 'system',
            timestamp: 1788825601000,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'delegation-call',
                toolName: 'canopy_spawn_delegate',
                input: JSON.stringify({
                  model: 'sonnet',
                  task_name: 'error_review',
                  message:
                    'Read src/index.ts and review its error handling. Return one concrete finding.',
                  execution_mode: 'foreground',
                  reasoning_effort: 'high',
                }),
              },
              {
                type: 'tool_result',
                toolUseId: 'delegation-call',
                toolName: 'canopy_spawn_delegate',
                output: JSON.stringify({
                  ok: true,
                  value: {
                    delegationId: 'retained-child',
                    status: 'completed',
                    routeSnapshot: {
                      selectedModelId: 'sonnet',
                      runtimeModelId: 'claude-sonnet-4-6',
                      harnessId: 'claude',
                      effectiveThinkingLevel: 'high',
                    },
                    workspaceObservation: {
                      consistency: 'live_shared_worktree',
                      headRevision: 'a'.repeat(40),
                      dirty: true,
                      observedAt: 1788825601000,
                    },
                    outputTruncated: false,
                    finalText: finding,
                  },
                }),
                isError: false,
              },
              {
                type: 'text',
                text: `The independent review found one actionable issue: ${finding} I agree with the finding after checking the caller.`,
              },
            ],
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    const card = panel.locator(
      '[data-testid="chat-tool-call"][data-tool-name="canopy_spawn_delegate"]',
    );
    await expect(card).toBeVisible();
    await panel.screenshot({
      path: path.join(captureDir, `parent-collapsed-${STAGE}.png`),
      animations: 'disabled',
    });
    const toggle = card.locator('button[aria-expanded]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toContainText('sonnet');
    await card.screenshot({
      path: path.join(captureDir, `parent-result-${STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

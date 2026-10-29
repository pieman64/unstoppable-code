// @capture-keep: reusable paired evidence for persisted nested delegation transcript rendering
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/11-phase-2-nested-transcripts.md
// Cross-provider subagents Phase 2: verify the existing parent transcript renders
// nested child activity, route metadata and terminal state on the shared card.
// Run on the unchanged and changed builds, in both appearances:
//   DELEGATION_STAGE=before pnpm run test:electron:captures:built managed-delegation-transcript.capture-spec.ts --reporter=line
//   DELEGATION_STAGE=before pnpm run test:electron:captures:built managed-delegation-transcript.capture-spec.ts --reporter=line --dark-mode
//   DELEGATION_STAGE=after pnpm run test:electron:captures:built managed-delegation-transcript.capture-spec.ts --reporter=line
//   DELEGATION_STAGE=after pnpm run test:electron:captures:built managed-delegation-transcript.capture-spec.ts --reporter=line --dark-mode
// The after stage adds the canonical block to the same task/result fixture. No live agent or network
// inference participates. Durable native behavior belongs to managed-delegation.spec.mjs.
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { PersistedChatBlock } from '@canopy/agent-transcript';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const STAGE = process.env.DELEGATION_STAGE === 'before' ? 'before' : 'after';
const REVIEW_STAGE =
  process.env.DELEGATION_REVIEW_STAGE === 'before'
    ? 'review-before'
    : process.env.DELEGATION_REVIEW_STAGE === 'after'
      ? 'review-after'
      : STAGE;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(
  root,
  process.env.DELEGATION_REVIEW_STAGE
    ? '.playwright/phase-2-delegation-review/captures'
    : '.playwright/phase-2-delegation/captures',
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
  const delegationBlock = {
    type: 'delegated_agent_call',
    agentBlockId: 'delegated-agent-retained-child',
    delegationId: 'retained-child',
    runGeneration: 1,
    outputTruncated: false,
    parentHarnessId: 'codex',
    parentTurnId: 'request',
    parentToolCallId: 'delegation-call',
    selectedModelId: 'sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    targetHarnessId: 'claude',
    requestedThinkingLevel: 'high',
    effectiveThinkingLevel: 'high',
    routeSnapshot: {
      selectedModelId: 'sonnet',
      runtimeModelId: 'claude-sonnet-4-6',
      selectedModelLabel: 'Claude Sonnet',
      runtimeModelLabel: 'Claude Sonnet 4.6',
      requestedThinkingLevel: 'high',
      effectiveThinkingLevel: 'high',
      harnessId: 'claude',
      runtimeKind: 'bundled',
      runnerRegistrationId: 'capture-runner',
      runtimeVersion: 'capture-runtime-v1',
      adapterVersion: 'capture-adapter-v1',
      modelSource: 'bundled',
      providerType: 'claude',
      assignmentRevision: 'capture-assignment-v1',
      billingAuthority: 'subscription',
      aiCreditsRouted: false,
      capabilities: [],
      supportedThinkingLevels: ['high'],
      capabilitySnapshotHash: 'capture-capabilities',
      capabilityGeneration: 1,
      policyRevision: 'capture-policy-v1',
    },
    status: 'completed',
    description: 'Review error handling',
    prompt: 'Read src/index.ts and review error handling.',
    executionMode: 'foreground',
    nativeSessionId: 'retained-native-child',
    sequence: 4,
    createdAt: 1788825601000,
    usage: { inputTokens: 420, outputTokens: 120 },
    finalText: finding,
  } satisfies PersistedChatBlock;
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
            id: 'child-thinking',
            role: 'assistant',
            timestamp: 1788825601100,
            parentBlockId: 'delegated-agent-retained-child',
            blocks: [
              {
                type: 'thinking',
                text: 'Checking whether the original cause survives the error boundary.',
              },
            ],
          },
          {
            id: 'child-read',
            role: 'assistant',
            timestamp: 1788825601200,
            parentBlockId: 'delegated-agent-retained-child',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'child-read',
                toolName: 'Read',
                input: '{"path":"src/index.ts"}',
              },
              {
                type: 'tool_result',
                toolUseId: 'child-read',
                toolName: 'Read',
                output: 'throw new Error("Unable to read source");',
                isError: false,
              },
            ],
          },
          {
            id: 'child-finding',
            role: 'assistant',
            timestamp: 1788825601300,
            parentBlockId: 'delegated-agent-retained-child',
            blocks: [{ type: 'text', text: finding }],
          },
          {
            id: 'parent',
            role: 'system',
            timestamp: 1788825601000,
            blocks: [
              ...(STAGE === 'after' ? [delegationBlock] : []),
              {
                type: 'tool_use' as const,
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
                type: 'tool_result' as const,
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
                type: 'text' as const,
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
    const card =
      STAGE === 'before'
        ? panel.locator(
            '[data-testid="chat-tool-call"][data-tool-name="canopy_spawn_delegate"]',
          )
        : panel.getByTestId('chat-delegated-agent');
    await expect(card).toBeVisible();
    // Pin the transcript viewport so late hydration cannot crop the task bubble.
    await panel
      .getByTestId('chat-message-list-scroll')
      .evaluate(async (element: HTMLElement) => {
        element.scrollTop = 0;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            element.scrollTop = 0;
            resolve();
          }),
        );
      });
    await panel.screenshot({
      path: path.join(captureDir, `transcript-collapsed-${REVIEW_STAGE}.png`),
      animations: 'disabled',
    });
    const toggle =
      STAGE === 'before'
        ? card.locator('button[aria-expanded]')
        : card.getByRole('button', { name: 'Expand delegated task' });
    await toggle.click();
    await expect(card).toContainText(
      STAGE === 'before' ? 'sonnet' : 'Completed',
    );
    await card.screenshot({
      path: path.join(captureDir, `transcript-expanded-${REVIEW_STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

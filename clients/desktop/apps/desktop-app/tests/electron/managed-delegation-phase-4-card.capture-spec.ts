// @capture-keep: reusable card-state evidence for Phase 4 write grants and worktree isolation
// @capture-reference: docs/planning/2026-07-14-cross-provider-subagents/17-phase-4-review-polish.md
// Phase 4 card evidence: explicit grants, shared workspace and approval state.
// DELEGATION_STAGE=before pnpm run test:electron:captures:built managed-delegation-phase-4-card.capture-spec.ts --reporter=line
// DELEGATION_STAGE=before pnpm run test:electron:captures:built managed-delegation-phase-4-card.capture-spec.ts --reporter=line --dark-mode
// DELEGATION_STAGE=after pnpm run test:electron:captures:built managed-delegation-phase-4-card.capture-spec.ts --reporter=line
// DELEGATION_STAGE=after pnpm run test:electron:captures:built managed-delegation-phase-4-card.capture-spec.ts --reporter=line --dark-mode
// Static seeded retained messages; no live agent or inference. Behavior coverage lives in
// managed-delegation.spec.mjs and managed-delegation-history.spec.mjs.
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
const REVIEW_STAGE = STAGE;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(root, '.playwright/phase-4-delegation');

for (const pendingApproval of [false, true]) {
  test(`captures delegated write ${pendingApproval ? 'awaiting approval' : 'completed'}`, async () => {
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
                ...(STAGE === 'after'
                  ? [
                      {
                        type: 'delegated_agent_call' as const,
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
                        status: pendingApproval ? 'running' : 'completed',
                        approvalPending: pendingApproval,
                        description: 'Preserve the original error cause',
                        prompt: 'Read src/index.ts and review error handling.',
                        executionMode: 'background',
                        permissions: { writePaths: ['src/index.ts'] },
                        workspaceObservation: {
                          consistency: 'live_shared_worktree',
                          headRevision: 'a'.repeat(40),
                          dirty: true,
                          observedAt: 1788825601000,
                        },
                        sequence: 4,
                        createdAt: 1788825601000,
                        usage: { inputTokens: 420, outputTokens: 120 },
                        finalText: pendingApproval ? undefined : finding,
                      } as const,
                    ]
                  : []),
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
                      status: pendingApproval ? 'running' : 'completed',
                      approvalPending: pendingApproval,
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
                      finalText: pendingApproval ? undefined : finding,
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
        path: path.join(
          captureDir,
          `write-card-collapsed-${pendingApproval ? 'approval' : 'completed'}-${REVIEW_STAGE}.png`,
        ),
        animations: 'disabled',
      });
      const toggle =
        STAGE === 'before'
          ? card.locator('button[aria-expanded]')
          : card.getByRole('button', { name: 'Expand delegated task' });
      await toggle.click();
      await expect(card).toContainText(
        pendingApproval ? 'Awaiting approval' : 'Completed',
      );
      await card.screenshot({
        path: path.join(
          captureDir,
          `write-card-expanded-${pendingApproval ? 'approval' : 'completed'}-${REVIEW_STAGE}.png`,
        ),
        animations: 'disabled',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });
}

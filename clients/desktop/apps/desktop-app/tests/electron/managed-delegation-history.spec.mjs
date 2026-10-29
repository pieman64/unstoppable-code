// Phase 2 cold recovery: real registry files, no native runner or network.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, test } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

for (const parent of ['claude', 'codex'])
  for (const child of ['claude', 'codex'])
    for (const status of [
      'completed',
      'failed',
      'cancelled',
      'running',
      'deadline_exceeded',
      'resumed',
      'preparing',
      'queued',
    ]) {
      test(`${parent} to ${child}: cold ${status} history retains child attribution and leaves delivery untouched`, async ({}, testInfo) => {
        const userDataDir = mkdtempSync(
          path.join(os.tmpdir(), 'delegation-history-'),
        );
        const demo = seedDemoWorkspaces({
          userDataDir,
          apps: ['ts-pnpm-vite'],
        });
        const workspaceId = 'demo-ts-pnpm-vite',
          worktreeId = 'demo-main',
          chatId = 'history';
        const id = randomUUID(),
          timestamp = 1788825600000;
        const route = {
          selectedModelId: 'retired-reviewer',
          selectedModelLabel: 'Retired reviewer',
          runtimeModelId: 'historical-runtime',
          runtimeModelLabel: 'Historical runtime',
          harnessId: child,
          runtimeKind: 'local',
          runnerRegistrationId: 'historical-runner',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'agent',
          providerType: child,
          assignmentRevision: '1',
          billingAuthority: 'native',
          aiCreditsRouted: false,
          requestedThinkingLevel: 'high',
          effectiveThinkingLevel: 'medium',
          capabilities: ['read'],
          supportedThinkingLevels: ['medium'],
          capabilitySnapshotHash: 'retained-capabilities',
          capabilityGeneration: 1,
          policyRevision: '1',
          authAccountKey: 'private-history-account',
        };
        const retained = {
          version: 1,
          parent: {
            harnessId: parent,
            projectId: workspaceId,
            worktreeId,
            chatId,
            sessionKey: `${workspaceId}/${worktreeId}/${chatId}`,
            turnId: 'native-provider-turn',
            userMessageId: 'request',
            toolCallId: 'call',
            runtimeGeneration: 1,
            depth: 0,
          },
          task: {
            modelId: route.selectedModelId,
            description: 'Historical review',
            prompt: 'Inspect the source',
            contextPolicy: 'task_only',
            isolation: 'shared_worktree',
            executionMode: 'background',
          },
          route,
          callKey: 'a'.repeat(64),
          requestHash: 'b'.repeat(64),
          createdAt: timestamp + 1,
          deadlineAt: timestamp + 10000,
          state: {
            delegationId: id,
            runGeneration: 1,
            sequence: 3,
            status:
              status === 'resumed'
                ? 'completed'
                : status === 'preparing' || status === 'queued'
                  ? 'pending'
                  : status,
            nativeSessionId: 'native-child',
            outputTruncated: false,
            ...(status === 'completed' || status === 'resumed'
              ? { finalText: 'Retained child finding.' }
              : {}),
            usage: { inputTokens: 40, outputTokens: 12 },
            transcript: [
              {
                id: 'thinking',
                sequence: 1,
                occurredAt: timestamp + 2,
                type: 'thinking',
                text: 'Reviewing the original cause.',
              },
              {
                id: 'read',
                sequence: 2,
                occurredAt: timestamp + 3,
                type: 'tool',
                toolName: 'Read',
                input: '{"path":"src/index.ts"}',
                output: 'original source',
                isError: false,
              },
              {
                id: 'answer',
                sequence: 3,
                occurredAt: timestamp + 4,
                type: 'text',
                text: 'Retained child finding.',
              },
            ],
          },
          launch: {
            version: 1,
            delegationId: id,
            runGeneration: 1,
            launchKey: 'a'.repeat(64),
            phase:
              status === 'running' || status === 'preparing'
                ? 'identified'
                : status === 'queued'
                  ? 'reserved'
                  : 'settled',
            nativeSessionId: 'native-child',
            ...(status === 'running' ||
            status === 'preparing' ||
            status === 'queued'
              ? {}
              : {
                  terminalStatus: status === 'resumed' ? 'completed' : status,
                }),
          },
          delivery: { status: 'unclaimed' },
        };
        if (status === 'preparing') {
          delete retained.route;
          delete retained.state.nativeSessionId;
          retained.state.transcript = [];
          retained.state.approvalPending = true;
          retained.launch.phase = 'reserved';
          delete retained.launch.terminalStatus;
          delete retained.launch.nativeSessionId;
        }
        if (status === 'queued') {
          // Mirrors exactly what AgentDelegationBroker.admit() writes in
          // broker.ts for a spawn that waited for a slot: version 2,
          // notificationOnly, no route (route capture happens at grant, not
          // admission), a fresh run state, admission.state 'waiting', launch
          // still 'reserved' (never dispatched), and delivery suppressed.
          retained.version = 2;
          retained.notificationOnly = true;
          delete retained.deadlineAt;
          delete retained.route;
          delete retained.state.nativeSessionId;
          retained.state.sequence = 0;
          retained.state.transcript = [];
          delete retained.state.usage;
          retained.admission = {
            runGeneration: 1,
            state: 'waiting',
            queuedAt: timestamp,
          };
          delete retained.launch.terminalStatus;
          delete retained.launch.nativeSessionId;
          retained.delivery = {
            status: 'suppressed',
            reason: 'automatic_delivery_removed',
          };
        }
        if (status === 'resumed') {
          const publicRoute = { ...route };
          delete publicRoute.authAccountKey;
          retained.notificationOnly = true;
          retained.task.permissions = { writePaths: ['src/index.ts'] };
          retained.history = [
            {
              delegationId: id,
              runGeneration: 1,
              sequence: 3,
              parentHarnessId: parent,
              parentTurnId: 'request',
              parentToolCallId: 'first-call',
              createdAt: timestamp,
              task: {
                description: 'First delegated review',
                prompt: 'Inspect the source',
                executionMode: 'background',
              },
              snapshot: {
                delegationId: id,
                runGeneration: 1,
                status: 'completed',
                outputTruncated: false,
                routeSnapshot: publicRoute,
                finalText: 'First generation result.',
              },
              transcript: [],
            },
          ];
          retained.state.runGeneration = 2;
          retained.launch.runGeneration = 2;
          // Earlier versions retained each edit's full text with the run.
          retained.state.fileChanges = [
            {
              id: randomUUID(),
              path: 'src/index.ts',
              before: 'original source',
              after: 'child changes',
              status: 'applied',
            },
          ];
        }
        seedWorktreeChat({
          userDataDir,
          workspaceId,
          worktreeId,
          tabs: [
            {
              id: chatId,
              title: 'Historical delegation',
              providerType: parent,
              executionHarness: parent,
              sdkSessionId: 'native-parent',
              model: parent === 'claude' ? 'sonnet' : 'gpt-6-sol',
              messages: [
                {
                  id: 'request',
                  role: 'user',
                  timestamp,
                  blocks: [{ type: 'text', text: 'Review the source.' }],
                },
                {
                  id: 'hidden-delivery',
                  role: 'user',
                  hidden: true,
                  timestamp: timestamp + 4,
                  blocks: [
                    {
                      type: 'text',
                      text: 'A delegated task has finished. Hidden delivery evidence.',
                    },
                  ],
                },
                {
                  id: 'parent-answer',
                  role: 'assistant',
                  timestamp: timestamp + 5,
                  blocks: [
                    { type: 'text', text: 'Parent answer remains separate.' },
                  ],
                },
              ],
            },
          ],
        });
        const directory = path.join(
          userDataDir,
          'workspaces',
          workspaceId,
          'worktree-data',
          worktreeId,
          'delegation',
          'runs',
        );
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${id}.json`),
          original = JSON.stringify(retained);
        writeFileSync(file, original, { mode: 0o600 });
        const { electronApp } = await launchCanopy({ userDataDir });
        let assertionsCompleted = false;
        try {
          const window = await electronApp.firstWindow(),
            app = new CanopyAppDriver(window);
          await app.waitForShell();
          await app.openMainPage();
          await app.selectWorktree(worktreeId);
          const verify = async () => {
            await expect(
              window.getByText('Parent answer remains separate.', {
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              window.getByText(
                'A delegated task has finished. Hidden delivery evidence.',
                { exact: true },
              ),
            ).toHaveCount(0);
            for (const summary of await window
              .getByRole('button', { name: /^Agent steps:/, expanded: false })
              .all())
              await summary.click();
            const debugState = await window.evaluate(
              ({ projectId, worktreeId }) =>
                window.api.chat.getState({ projectId, worktreeId }),
              { projectId: workspaceId, worktreeId },
            );
            writeFileSync(
              testInfo.outputPath('recovered-state.json'),
              JSON.stringify(debugState),
            );
            writeFileSync(
              testInfo.outputPath('retained-record.json'),
              original,
            );
            const cards = window.getByTestId('chat-delegated-agent');
            await expect(cards).toHaveCount(status === 'resumed' ? 2 : 1);
            const card = cards.last();
            if (status === 'completed' || status === 'resumed') {
              await expect(
                card.getByText('Completed', { exact: true }),
              ).toHaveCount(0);
              await expect(
                card.getByLabel('Thinking', { exact: true }),
              ).toHaveCount(0);
            } else {
              await expect(card).toContainText(
                status === 'running'
                  ? 'Interrupted'
                  : status === 'preparing' || status === 'queued'
                    ? 'Cancelled'
                    : status === 'deadline_exceeded'
                      ? 'Deadline exceeded'
                      : status[0].toUpperCase() + status.slice(1),
              );
              if (status === 'queued') {
                // The never-dispatched record settles cancelled, never the
                // uncertain-interruption label a dispatched record gets, and
                // never the live queued-card label (recovery forces the
                // phase to idle).
                await expect(card).not.toContainText('Interrupted');
                await expect(card).not.toContainText('Queued');
              }
            }
            await card
              .getByRole('button', { name: 'Expand delegated task' })
              .click();
            await expect(
              card.locator('[data-testid="agent-block-shared"]'),
            ).toHaveCount(1);
            if (status === 'completed' || status === 'resumed') {
              await expect(
                card.getByRole('button', { name: 'Show result', exact: true }),
              ).toBeVisible();
              await card
                .getByRole('button', { name: 'Show result', exact: true })
                .click();
              await expect(
                card.getByText('Retained child finding.', { exact: true }),
              ).toHaveCount(1);
            }
            if (status === 'preparing' || status === 'queued') {
              await expect(card).not.toContainText('Awaiting approval');
              await expect(card.locator('dd').nth(0)).toHaveText(
                'retired-reviewer',
              );
              await expect(card.locator('dd').nth(1)).toHaveText('Preparing');
              await expect(card).toContainText(`${parent} → Preparing`);
              await expect(card).not.toContainText('(undefined)');
              await expect(card).not.toContainText('()');
            } else {
              await expect(card).toContainText('Retired reviewer');
              await expect(card).toContainText('Historical runtime');
              await expect(card).toContainText(`${parent} → ${child}`);
              await expect(card).toContainText('medium');
              await expect(card).toContainText('Retained child finding.');
              await expect(card).toContainText('Read');
            }
            if (status === 'resumed') {
              await expect(card).toContainText(
                'Read/search and edits within: src/index.ts',
              );
              // A record that retained file text still loads; the text is
              // no longer kept or shown.
              await expect(
                card.getByTestId('delegated-file-change'),
              ).toHaveCount(0);
              await expect(card).not.toContainText('child changes');
              await expect(cards.first()).toContainText(
                'First delegated review',
              );
              await expect(
                card.getByRole('button', { name: 'Copy native session ID' }),
              ).toHaveCount(0);
            } else if (status !== 'preparing' && status !== 'queued')
              await expect(
                card.getByRole('button', { name: 'Copy native session ID' }),
              ).toBeVisible();
            else
              await expect(
                card.getByRole('button', { name: 'Copy native session ID' }),
              ).toHaveCount(0);
            if (
              parent === 'codex' &&
              child === 'claude' &&
              status === 'completed'
            ) {
              await expect(card.getByTestId('agent-block-shared')).toHaveClass(
                /border-l-2/,
              );
              await window.evaluate(() => {
                window.__delegationClipboardUnhandledRejections = 0;
                window.addEventListener('unhandledrejection', (event) => {
                  event.preventDefault();
                  window.__delegationClipboardUnhandledRejections += 1;
                });
                Object.defineProperty(navigator, 'clipboard', {
                  configurable: true,
                  value: {
                    writeText: () =>
                      Promise.reject(new Error('Clipboard permission denied')),
                  },
                });
              });
              await card
                .getByRole('button', { name: 'Copy native session ID' })
                .click();
              await window.waitForTimeout(50);
              expect(
                await window.evaluate(
                  () => window.__delegationClipboardUnhandledRejections,
                ),
              ).toBe(0);
            }
            await expect(
              card.getByRole('button', { name: /Open in/ }),
            ).toHaveCount(0);
            const state = await window.evaluate(
              ({ projectId, worktreeId }) =>
                window.api.chat.getState({ projectId, worktreeId }),
              { projectId: workspaceId, worktreeId },
            );
            const tab = state.tabsFile.tabs.find((tab) => tab.id === chatId);
            expect(tab.sdkSessionId).toBe('native-parent');
            expect(tab.executionHarness).toBe(parent);
            expect(
              tab.messages.filter(
                (message) =>
                  message.parentBlockId ===
                  `delegated-agent-${id}${status === 'resumed' ? '-run-2' : ''}`,
              ),
            ).toHaveLength(
              status === 'preparing' || status === 'queued' ? 0 : 3,
            );
            expect(JSON.stringify(tab)).not.toContain(
              'private-history-account',
            );
            expect(readFileSync(file, 'utf8')).toBe(original);
          };
          await verify();
          await window.reload();
          await app.waitForShell();
          await app.openMainPage();
          await app.selectWorktree(worktreeId);
          await verify();
          assertionsCompleted = true;
        } finally {
          const keepFailureData = !assertionsCompleted;
          if (keepFailureData) {
            await testInfo.attach('failure-fixture-directories', {
              body: JSON.stringify({
                userDataDir,
                fixturesDir: demo.fixturesDir,
              }),
              contentType: 'application/json',
            });
          }
          await closeCanopy(electronApp, userDataDir, {
            keepUserData: keepFailureData,
          });
          if (!keepFailureData) cleanupDemoWorkspaces(demo);
        }
      });
    }

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import {
  ATTENTION_AWAY,
  seedAttentionAwayWorktree,
  seedAttentionPanelLayout,
} from './seeders/seedWorktreeAttention.mjs';

const WORKSPACE = 'demo-ts-pnpm-vite';
const QUESTION = 'Ship the change now?';

function chat(id, timestamp, unread = false) {
  return {
    id,
    title: id,
    unread,
    messages: [
      {
        id: `${id}-message`,
        role: 'assistant',
        timestamp,
        blocks: [{ type: 'text', text: `Visible ${id} transcript` }],
      },
    ],
  };
}

for (const scenario of [
  'newest unread',
  'quiet restoration',
  'question before active unread',
  'compact question marker',
]) {
  test(`implicit entry: ${scenario}`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-attention-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedAttentionAwayWorktree(userDataDir);
    const asks = scenario.includes('question');
    const compact = scenario === 'compact question marker';
    const quiet = scenario === 'quiet restoration';
    const destination = asks ? 'question' : 'newest';
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE,
      worktreeId: 'demo-main',
      activeTabId: quiet ? 'newest' : 'old',
      tabs: [
        chat('old', 100, asks),
        chat('older-unread', 200, !quiet),
        chat('newest', 900, !quiet),
        ...(compact
          ? Array.from({ length: 24 }, (_, i) => chat(`extra-${i}`, 100, false))
          : []),
        ...(asks
          ? [
              {
                id: 'question',
                title: 'Question chat',
                messages: [
                  {
                    id: 'question-message',
                    role: 'assistant',
                    timestamp: 1000,
                    blocks: [
                      {
                        type: 'tool_use',
                        toolUseId: 'ask-tool',
                        toolName: 'mcp__canopy__AskUserQuestion',
                        input: JSON.stringify({
                          questions: [
                            { question: QUESTION, options: ['Yes', 'No'] },
                          ],
                        }),
                      },
                    ],
                  },
                ],
              },
            ]
          : []),
      ],
      ...(asks
        ? {
            pendingQuestions: [
              {
                requestId: 'ask-request',
                chatId: 'question',
                toolUseId: 'ask-tool',
                questions: [
                  { id: 'ship', question: QUESTION, options: ['Yes', 'No'] },
                ],
              },
            ],
          }
        : {}),
    });
    if (asks && !compact)
      seedAttentionPanelLayout(userDataDir, 'question', [
        'old',
        'older-unread',
        'newest',
      ]);
    const launched = await launchCanopy({ userDataDir });
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(ATTENTION_AWAY);
      await expect(
        window.getByTestId('panel-tab-panel-chat-away-chat'),
      ).toBeVisible();
      await app.selectWorktree('demo-main');
      const panel = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${destination}"]`,
      );
      await expect(panel).toBeVisible();
      if (asks) {
        await expect(panel.getByTestId('chat-question-prompt')).toContainText(
          QUESTION,
        );
        if (!compact)
          await expect(
            window.getByTestId('panel-group-attention-chat-group'),
          ).toHaveAttribute('data-active', 'true');
      } else {
        await expect(panel).toContainText(`Visible ${destination} transcript`);
      }
      // Check the main-owned snapshot as well as the visible panel: activation
      // must commit through the real command boundary, not stay renderer-local.
      await expect
        .poll(async () =>
          window.evaluate(async () => {
            const snapshot = await window.api.chat.getState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            });
            return snapshot.tabsFile.activeTabId;
          }),
        )
        .toBe(destination);
      // A tab choice made after entry remains authoritative.
      await window.getByTestId('panel-tab-panel-chat-old').click();
      await expect(
        window.locator(
          '[data-testid="panel-content-chat"][data-panel-id="panel-chat-old"]',
        ),
      ).toBeVisible();
      if (compact) {
        const questionTab = window.getByTestId('panel-tab-panel-chat-question');
        await questionTab.scrollIntoViewIfNeeded();
        const tabBox = await questionTab.boundingBox();
        const markerBox = await window
          .getByTestId('panel-tab-question-question')
          .boundingBox();
        expect(tabBox?.width).toBeCloseTo(96, 0);
        expect(markerBox?.y).toBeGreaterThanOrEqual(tabBox?.y ?? 0);
        expect(
          (markerBox?.y ?? 0) + (markerBox?.height ?? 0),
        ).toBeLessThanOrEqual((tabBox?.y ?? 0) + (tabBox?.height ?? 0));
      }
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}

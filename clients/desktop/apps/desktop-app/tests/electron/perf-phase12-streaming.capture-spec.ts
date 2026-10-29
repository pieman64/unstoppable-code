// @capture-keep: P2 phases 13 to 15 change the same streaming path and need matched before/after streaming evidence
// @capture-reference: docs/ui-automation.md
/**
 * Performance plan phase 12 (P2 renderer quick wins): streamed-reply capture.
 *
 * Phase 12 renders streamed chat content once per animation frame, keeps
 * completed turns and unchanged tool blocks referentially stable (so memoized
 * rows skip), uses main's TODOs, and gates an unused shared-store projection.
 * Nothing should look different except smoother streaming: this capture
 * records a paced burst of a streamed reply with tool calls in a chat with a
 * long seeded history, before and after the change, to show that no content
 * is dropped, duplicated or reordered and that the transcript stays pinned.
 *
 * Build each tree with `pnpm run build:e2e`, then run (light and dark):
 * PERF12_STAGE=before pnpm run test:electron:captures:built perf-phase12-streaming.capture-spec.ts --reporter=line
 * PERF12_STAGE=before pnpm run test:electron:captures:built perf-phase12-streaming.capture-spec.ts --reporter=line --dark-mode
 * PERF12_STAGE=after pnpm run test:electron:captures:built perf-phase12-streaming.capture-spec.ts --reporter=line
 * PERF12_STAGE=after pnpm run test:electron:captures:built perf-phase12-streaming.capture-spec.ts --reporter=line --dark-mode
 * Run the before stage in a checkout of the phase 11 tree with this spec
 * copied in, setting PERF12_CAPTURE_DIR to this checkout's absolute
 * .playwright/perf-phase12 directory. The stage defaults to after.
 *
 * Determinism: the disk seeders write a fixed 120-turn history (ids, text,
 * tool calls and results, timestamps) into isolated test data; the loopback
 * mock LLM scripts every step of the reply (six `Bash` calls running `echo`
 * in the seeded worktree, then a final text reply) with fixed pacing. No live
 * provider or external network is used. Desktop Claude shows assistant text
 * when each message completes, so the burst is the tool cards arriving one
 * step at a time followed by the final reply.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type {
  ElectronApplication,
  Locator,
  Page,
  TestInfo,
  Video,
} from '@playwright/test';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const STAGE = process.env.PERF12_STAGE === 'before' ? 'before' : 'after';
const COLOR_MODE =
  process.env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : 'light';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir =
  process.env.PERF12_CAPTURE_DIR ??
  path.join(repoRoot, '.playwright', 'perf-phase12');
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'perf-phase12-streaming';
const MARKER = 'Canopy-CPERF12';
const TURN_COUNT = 120;
const TOOL_STEPS = 6;
const STARTED_AT = Date.parse('2026-04-10T12:00:00.000Z');
const PAUSE_MS = 1_200;

function history(): PersistedChatMessage[] {
  return Array.from(
    { length: TURN_COUNT },
    (_, index): PersistedChatMessage[] => {
      const timestamp = STARTED_AT + index * 60_000;
      const toolUseId = `history-tool-${index}`;
      return [
        {
          id: `history-user-${index}`,
          role: 'user',
          blocks: [{ type: 'text', text: `Historical request ${index}` }],
          timestamp,
        },
        {
          id: `history-call-${index}`,
          role: 'assistant',
          blocks: [
            { type: 'text', text: `Checking item ${index}.` },
            {
              type: 'tool_use',
              toolUseId,
              toolName: 'Bash',
              input: JSON.stringify({ command: `echo history-${index}` }),
            },
          ],
          timestamp: timestamp + 500,
        },
        {
          id: `history-result-${index}`,
          role: 'assistant',
          blocks: [
            {
              type: 'tool_result',
              toolUseId,
              toolName: 'Bash',
              output: `history-${index}`,
              isError: false,
            },
          ],
          timestamp: timestamp + 900,
        },
        {
          id: `history-reply-${index}`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `Historical response ${index}` }],
          timestamp: timestamp + 1_000,
        },
        {
          id: `history-timer-${index}`,
          role: 'system',
          blocks: [
            {
              type: 'turn_timer',
              startedAt: timestamp,
              completedAt: timestamp + 2_000,
            },
          ],
          timestamp: timestamp + 2_000,
        },
      ];
    },
  ).flat();
}

function finalReply(): string {
  return Array.from(
    { length: 24 },
    (_, index) => `Burst reply line ${index}: every step landed in order.\n\n`,
  ).join('');
}

async function bottomGap(viewport: Locator): Promise<number> {
  return viewport.evaluate(
    (element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

async function capture(
  viewport: Locator,
  name: string,
  testInfo: TestInfo,
): Promise<void> {
  const filePath = path.join(captureDir, `${name}-${STAGE}-${COLOR_MODE}.png`);
  await viewport.screenshot({ path: filePath, animations: 'disabled' });
  await testInfo.attach(`${name}-${STAGE}-${COLOR_MODE}`, {
    path: filePath,
    contentType: 'image/png',
  });
}

function toolCard(panel: Locator, step: number): Locator {
  return panel
    .locator('[data-testid="chat-tool-call"][data-tool-name="Bash"]')
    .filter({ hasText: `phase12-step-${step}` });
}

async function pause(window: Page): Promise<void> {
  await window.waitForTimeout(PAUSE_MS);
}

test('streamed reply with tool calls over a long history', async ({}, testInfo) => {
  test.setTimeout(240_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-perf12-'));
  let electronApp: ElectronApplication | undefined;
  let video: Video | null = null;
  let completed = false;
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: CHAT_ID,
      tabs: [{ id: CHAT_ID, title: 'Streaming burst', messages: history() }],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
      llm: {
        steps: [
          ...Array.from({ length: TOOL_STEPS }, (_, index) => ({
            text: `Step ${index + 1}: running the next check.`,
            toolCalls: [
              {
                name: 'Bash',
                input: { command: `echo phase12-step-${index + 1}` },
              },
            ],
            stopReason: 'tool_use',
            streamMs: 900,
          })),
          { text: finalReply(), stopReason: 'end_turn', streamMs: 1_500 },
        ],
      },
    });
    const launched = await launchCanopy({
      userDataDir,
      recordVideoDir: path.join(captureDir, 'videos'),
    });
    electronApp = launched.electronApp;
    const window = await launched.electronApp.firstWindow();
    video = window.video();
    expect(video).not.toBeNull();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    // Bash runs without an approval prompt so the burst is uninterrupted.
    await window.getByTestId('approval-mode-picker').click();
    await window.getByTestId('approval-mode-option-full-access').click();

    const panel = window.getByTestId('panel-content-chat');
    const viewport = panel.getByTestId('chat-message-list-scroll');
    await expect(viewport).toBeVisible();
    await expect(
      panel.getByText(`Historical response ${TURN_COUNT - 1}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect.poll(() => bottomGap(viewport)).toBeLessThan(64);
    await pause(window);
    await capture(viewport, 'history-open', testInfo);

    const composer = window.getByRole('textbox').last();
    await composer.fill(`[${MARKER}] Run the six checks, then summarize.`);
    await pause(window);
    await composer.press('Enter');

    // Pace the recording: hold on each tool card as it lands.
    for (let step = 1; step <= TOOL_STEPS; step += 1) {
      await expect(toolCard(panel, step)).toHaveCount(1, { timeout: 90_000 });
      if (step === Math.ceil(TOOL_STEPS / 2)) {
        await capture(viewport, 'burst-mid-stream', testInfo);
      }
      await window.waitForTimeout(400);
    }

    const stop = window.getByTestId('chat-stop-generation');
    await expect(stop).toHaveCount(0, { timeout: 90_000 });
    await expect(
      panel.getByText('Burst reply line 23:', { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
    // Stabilizing checks for the capture (not durable coverage): the reply is
    // complete, in order and pinned, and the completed turn's collapsed
    // "Agent steps" summary counts all six commands.
    const replyTurn = panel
      .locator('[data-chat-turn-group]')
      .filter({ hasText: 'Burst reply line 0:' });
    await expect(replyTurn).toHaveCount(1);
    const replyText = await replyTurn.innerText();
    const positions = Array.from({ length: 24 }, (_, index) =>
      replyText.indexOf(`Burst reply line ${index}:`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const steps = replyTurn.getByRole('button', { name: /^Agent steps:/ });
    await expect(steps).toHaveAttribute('aria-expanded', 'false');
    await expect(steps).toHaveAccessibleName(
      new RegExp(`\\b${TOOL_STEPS} bash\\b`, 'i'),
    );
    await expect.poll(() => bottomGap(viewport)).toBeLessThan(64);
    await pause(window);
    await capture(viewport, 'burst-completed', testInfo);

    // Expanded, the turn shows every step once and in order.
    await steps.click();
    await expect(steps).toHaveAttribute('aria-expanded', 'true');
    for (let step = 1; step <= TOOL_STEPS; step += 1) {
      await expect(toolCard(replyTurn, step)).toHaveCount(1);
    }
    const cardSteps = (
      await replyTurn
        .locator('[data-testid="chat-tool-call"][data-tool-name="Bash"]')
        .allInnerTexts()
    ).map((text: string) => /phase12-step-(\d+)/.exec(text)?.[1] ?? '');
    expect(cardSteps).toEqual(
      Array.from({ length: TOOL_STEPS }, (_, index) => String(index + 1)),
    );
    await pause(window);
    await capture(viewport, 'burst-completed-expanded', testInfo);
    await pause(window);
    completed = true;
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
    if (video) {
      if (completed) {
        const videoPath = path.join(
          captureDir,
          'videos',
          `streaming-burst-${STAGE}-${COLOR_MODE}.webm`,
        );
        await video.saveAs(videoPath);
        await testInfo.attach(`streaming-burst-${STAGE}-${COLOR_MODE}`, {
          path: videoPath,
          contentType: 'video/webm',
        });
      }
      await video.delete();
    }
  }
});

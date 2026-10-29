// @capture-keep: reusable before/after visual evidence for transcript virtualization and scroll pinning
// @capture-reference: docs/ui-automation.md
/**
 * CAN-3023: Cloud latency transcript virtualization visual verification.
 * Large transcripts now window turn groups above 50; the portal also loads
 * older history on scroll. This desktop flow captures a 160-turn chat pinned
 * on open, after one completed reply, and after scrolling upward 1000px.
 * Portal history pagination is outside this desktop capture's scope.
 *
 * Build each tree with `pnpm run build:e2e`, then run:
 * CLOUD_LATENCY_STAGE=before pnpm run test:electron:captures:built cloud-latency-transcript-virtualization.capture-spec.ts --reporter=line
 * CLOUD_LATENCY_STAGE=before pnpm run test:electron:captures:built cloud-latency-transcript-virtualization.capture-spec.ts --reporter=line --dark-mode
 * CLOUD_LATENCY_STAGE=after pnpm run test:electron:captures:built cloud-latency-transcript-virtualization.capture-spec.ts --reporter=line
 * CLOUD_LATENCY_STAGE=after pnpm run test:electron:captures:built cloud-latency-transcript-virtualization.capture-spec.ts --reporter=line --dark-mode
 * Run before in an origin/develop temporary worktree with this spec copied in.
 * Set CLOUD_LATENCY_CAPTURE_DIR to the original checkout's absolute
 * .playwright/cloud-latency-transcript directory when capturing from that tree.
 * Stage defaults to after; filenames include the runner-selected color mode
 * so an external capture directory also preserves both modes.
 *
 * Determinism: the same disk seeders as chat-streaming-scroll.spec.mjs create
 * fixed history IDs, text, and timestamps in isolated test data. A scripted
 * loopback mock LLM supplies one fixed reply; no live provider or external
 * network is used. Desktop Claude displays assistant text on completion,
 * so captures wait for completion and settled bottom pinning. Runtime reply
 * timing may vary. Paced wheel input makes the short video watchable.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type {
  ElectronApplication,
  Locator,
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

const STAGE = process.env.CLOUD_LATENCY_STAGE === 'before' ? 'before' : 'after';
const COLOR_MODE =
  process.env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : 'light';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir =
  process.env.CLOUD_LATENCY_CAPTURE_DIR ??
  path.join(repoRoot, '.playwright', 'cloud-latency-transcript');
const CHAT_ID = 'cloud-latency-transcript';
const MARKER = 'Canopy-CLOUD-LATENCY-CAPTURE';
const TURN_COUNT = 160;
const STARTED_AT = Date.parse('2026-04-10T12:00:00.000Z');

function history(): PersistedChatMessage[] {
  return Array.from(
    { length: TURN_COUNT },
    (_, index): PersistedChatMessage[] => {
      const timestamp = STARTED_AT + index * 60_000;
      return [
        {
          id: `scroll-user-${index}`,
          role: 'user',
          blocks: [{ type: 'text', text: `Historical request ${index}` }],
          timestamp,
        },
        {
          id: `scroll-assistant-${index}`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `Historical response ${index}` }],
          timestamp: timestamp + 1000,
        },
        {
          id: `scroll-timer-${index}`,
          role: 'system',
          blocks: [
            {
              type: 'turn_timer',
              startedAt: timestamp,
              completedAt: timestamp + 2000,
            },
          ],
          timestamp: timestamp + 2000,
        },
      ];
    },
  ).flat();
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

test('large transcript open, completed reply, and scroll-up captures', async ({}, testInfo) => {
  test.setTimeout(120_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cloud-latency-'),
  );
  let electronApp: ElectronApplication | undefined;
  let video: Video | null = null;
  let completed = false;
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'claude',
      activeTabId: CHAT_ID,
      tabs: [
        { id: CHAT_ID, title: 'Transcript scrolling', messages: history() },
      ],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
      llm: {
        steps: [
          {
            text: Array.from(
              { length: 40 },
              (_, index) =>
                `First reply line ${index}: the response keeps growing.\n\n`,
            ).join(''),
            stopReason: 'end_turn',
            streamMs: 1_500,
          },
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
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    const viewport = panel.getByTestId('chat-message-list-scroll');
    await expect(viewport).toBeVisible();
    if (STAGE === 'after') {
      await expect(
        panel.getByTestId('chat-transcript-virtual-window'),
      ).toBeVisible();
    }
    await expect(
      panel.getByText('Historical response 159', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => bottomGap(viewport)).toBeLessThan(64);
    await window.waitForTimeout(700);
    await capture(viewport, 'transcript-open-bottom', testInfo);

    const composer = window.getByRole('textbox').last();
    const stop = window.getByTestId('chat-stop-generation');
    await composer.fill(`[${MARKER}] Send the first long reply`);
    await composer.press('Enter');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    await expect(
      panel.getByText('First reply line 39:', { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => bottomGap(viewport)).toBeLessThan(64);
    await window.waitForTimeout(700);
    await capture(viewport, 'transcript-completed-reply', testInfo);

    await viewport.hover();
    for (let step = 0; step < 4; step += 1) {
      await window.mouse.wheel(0, -250);
      await window.waitForTimeout(400);
    }
    await expect.poll(() => bottomGap(viewport)).toBeGreaterThan(400);
    await window.waitForTimeout(700);
    await capture(viewport, 'transcript-scroll-up-1000px', testInfo);
    await window.waitForTimeout(1000);
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
          `scroll-up-flow-${STAGE}-${COLOR_MODE}.webm`,
        );
        await video.saveAs(videoPath);
        await testInfo.attach(`scroll-up-flow-${STAGE}-${COLOR_MODE}`, {
          path: videoPath,
          contentType: 'video/webm',
        });
      }
      await video.delete();
    }
  }
});

/**
 * Release-like production-build evidence for oversized chat-search worker
 * failure recovery. The fixture creates a ranked page above the 16 MiB worker
 * threshold, waits for exact index freshness, makes the built worker entry
 * temporarily unavailable, and records 20 query samples plus renderer/main
 * responsiveness, CPU, memory, and process count.
 *
 * Run with a production build:
 *
 *   pnpm run build
 *   CANOPY_CHAT_SEARCH_RELEASE_LIKE_EVIDENCE_PATH=.performance/desktop/chat-search-fallback-verification.json \
 *     pnpm exec playwright test chat-search-worker-fallback-release-like.spec.mjs --config=playwright.release-like.config.mjs --reporter=line
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  assertValidMonitoring,
  startPerformanceMonitor,
} from '../performance/monitor.mjs';
import { roundSummary, summarize } from '../performance/statistics.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const workerPath = path.join(
  repoRoot,
  'out',
  'main',
  'chat-search-query-worker.js',
);
const unavailableWorkerPath = `${workerPath}.release-like-unavailable`;
const evidencePath = path.resolve(
  repoRoot,
  process.env.CANOPY_CHAT_SEARCH_RELEASE_LIKE_EVIDENCE_PATH ??
    '.performance/desktop/chat-search-fallback-verification.json',
);
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const QUERY_REPETITIONS = 20;
const BODY_BYTES_PER_CHAT = 22 * 1024 * 1024;

function makeMessages(id, phrase) {
  // Exercise an oversized aggregate search projection with supported message
  // rows. One 22 MiB row exceeds the transcript reader's 16 MiB row limit and
  // fails migration before the worker-fallback scenario can run.
  const charactersPerMessage = 256 * 1024;
  return Array.from(
    { length: Math.ceil(phrase.length / charactersPerMessage) },
    (_, index) => ({
      id: `${id}-user-${index}`,
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: phrase.slice(
            index * charactersPerMessage,
            (index + 1) * charactersPerMessage,
          ),
        },
      ],
      timestamp: Date.parse('2026-07-14T12:00:00.000Z') + index,
    }),
  );
}

function makeSizedBody(totalBytes, needle) {
  const prefix = 'release-like aggregate worker projection body. ';
  const suffix = ` ${needle}`;
  return `${prefix
    .repeat(Math.ceil((totalBytes - suffix.length) / prefix.length))
    .slice(0, totalBytes - suffix.length)}${suffix}`;
}

function restoreWorkerEntry() {
  if (!existsSync(unavailableWorkerPath)) return;
  if (existsSync(workerPath)) {
    throw new Error(
      `Refusing to overwrite an existing worker entry while restoring ${unavailableWorkerPath}`,
    );
  }
  renameSync(unavailableWorkerPath, workerPath);
}

test('release-like oversized worker failure stays off Electron main', async () => {
  test.setTimeout(240_000);
  restoreWorkerEntry();
  expect(existsSync(workerPath)).toBe(true);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-search-release-like-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const needle = 'releaselikeworkerfailure';
  const body = makeSizedBody(BODY_BYTES_PER_CHAT, needle);
  const chatIds = Array.from(
    { length: 3 },
    (_, index) => `release-like-worker-chat-${index + 1}`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: chatIds[0],
    tabs: chatIds.map((id, index) => ({
      id,
      title: `Release-like worker chat ${index + 1}`,
      providerType: 'codex',
      messages: makeMessages(id, body),
    })),
  });

  let launched;
  let workerUnavailable = false;
  try {
    launched = await launchCanopy({
      userDataDir,
      buildKind: 'production',
      env: { CANOPY_ENV: 'production' },
    });
    const window = await launched.electronApp.firstWindow();
    const mainWindowVisible = await launched.electronApp.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((candidate) =>
          candidate.isVisible(),
        ),
    );
    expect(mainWindowVisible).toBe(false);
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const shortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
    await window.keyboard.press(shortcut);
    await expect(window.getByTestId('command-palette')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('command-palette')).toBeHidden();
    await window.evaluate(async (expectedChatIds) => {
      const expectedIds = new Set(expectedChatIds);
      const startedAt = performance.now();
      while (performance.now() - startedAt < 90_000) {
        const response = await window.api.chatSearch.catalog();
        const indexedCount = response.entries.filter((entry) =>
          expectedIds.has(entry.chatId),
        ).length;
        if (indexedCount === expectedIds.size) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for release-like search fixtures');
    }, chatIds);

    renameSync(workerPath, unavailableWorkerPath);
    workerUnavailable = true;
    const monitor = await startPerformanceMonitor({
      page: window,
      electronApp: launched.electronApp,
      sampleIntervalMs: 25,
      probeTimeoutMs: 5_000,
    });
    const samples = [];
    try {
      for (let index = 0; index < QUERY_REPETITIONS; index += 1) {
        samples.push(
          await window.evaluate(
            async ({ query, limit }) => {
              const startedAt = performance.now();
              const response = await window.api.chatSearch.query({
                query,
                limit,
              });
              return {
                durationMs: performance.now() - startedAt,
                resultCount: response.results.length,
              };
            },
            { query: needle, limit: 20 },
          ),
        );
        await window.waitForTimeout(25);
      }
    } finally {
      const monitoring = await monitor.stop();
      assertValidMonitoring(monitoring.summary);
      const expectedResultCount = 0;
      expect(samples).toHaveLength(QUERY_REPETITIONS);
      expect(
        samples.every((sample) => sample.resultCount === expectedResultCount),
      ).toBe(true);
      expect(monitoring.summary.ipcOuterMs.max).toBeLessThan(250);
      expect(monitoring.summary.rendererFrameDelayMs.max).toBeLessThan(250);

      const evidence = {
        stage: 'verification',
        buildKind: 'production',
        completionPoint: 'preload chatSearch.query response after worker exit',
        fixture: {
          chatCount: chatIds.length,
          bodyBytesPerChat: BODY_BYTES_PER_CHAT,
          aggregateBodyBytes: BODY_BYTES_PER_CHAT * chatIds.length,
          queryRepetitions: QUERY_REPETITIONS,
          workerEntryUnavailable: true,
        },
        resultCount: expectedResultCount,
        queryDurationMs: roundSummary(
          summarize(samples.map((sample) => sample.durationMs)),
        ),
        responsiveness: {
          ipcOuterMs: roundSummary(monitoring.summary.ipcOuterMs),
          rendererIntervalDelayMs: roundSummary(
            monitoring.summary.rendererIntervalDelayMs,
          ),
          rendererFrameDelayMs: roundSummary(
            monitoring.summary.rendererFrameDelayMs,
          ),
          longTasks: roundSummary(monitoring.summary.longTasks),
        },
        resources: {
          totalCpuPercent: roundSummary(monitoring.summary.totalCpuPercent),
          totalWorkingSetMb: roundSummary(monitoring.summary.totalWorkingSetMb),
          totalWorkingSetDeltaMb: monitoring.summary.totalWorkingSetDeltaMb,
          processCount: roundSummary(monitoring.summary.processCount),
        },
      };
      mkdirSync(path.dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
  } finally {
    if (workerUnavailable) restoreWorkerEntry();
    if (launched) {
      await closeCanopy(launched.electronApp, userDataDir);
    } else {
      for (const target of [userDataDir, `${userDataDir}-secure`]) {
        rmSync(target, { recursive: true, force: true });
      }
    }
  }
});

test('release-like indexing keeps the app responsive while large transcripts become searchable', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-search-index-responsive-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const needle = 'resumequeueindexresponsiveness';
  const body = makeSizedBody(BODY_BYTES_PER_CHAT, needle);
  const chatIds = [
    'index-responsive-1',
    'index-responsive-2',
    'index-responsive-3',
  ];
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: chatIds[0],
    tabs: chatIds.map((id) => ({
      id,
      title: id,
      providerType: 'codex',
      messages: makeMessages(id, body),
    })),
  });
  let launched;
  let monitor;
  try {
    launched = await launchCanopy({
      userDataDir,
      buildKind: 'production',
      env: { CANOPY_ENV: 'production' },
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    monitor = await startPerformanceMonitor({
      page: window,
      electronApp: launched.electronApp,
      sampleIntervalMs: 25,
      probeTimeoutMs: 10_000,
    });
    await app.openMainPage();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
    );
    const palette = window.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    await palette.locator('input').first().fill(needle);
    await expect
      .poll(
        async () => {
          const entries = await window.evaluate(
            async () => (await window.api.chatSearch.catalog()).entries,
          );
          return entries.filter((entry) => chatIds.includes(entry.chatId))
            .length;
        },
        { timeout: 90_000 },
      )
      .toBe(3);
    await expect(palette.locator('input').first()).toHaveValue(needle);
    await window.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    const monitoring = await monitor.stop();
    monitor = undefined;
    assertValidMonitoring(monitoring.summary);
    const indexingEvidencePath = path.join(
      repoRoot,
      '.performance/desktop/chat-search-indexing-verification.json',
    );
    mkdirSync(path.dirname(indexingEvidencePath), {
      recursive: true,
    });
    writeFileSync(
      indexingEvidencePath,
      `${JSON.stringify(monitoring, null, 2)}\n`,
    );
    expect(monitoring.summary.ipcOuterMs.max).toBeLessThan(250);
    expect(monitoring.summary.rendererFrameDelayMs.max).toBeLessThan(250);
  } finally {
    await monitor?.stop();
    if (launched) await closeCanopy(launched.electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
  }
});

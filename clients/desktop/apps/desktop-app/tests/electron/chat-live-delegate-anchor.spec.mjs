/**
 * Real-browser regression coverage for delegate-log progress during paging:
 * A: a run above the loaded 100-turn window survives a page reload without blanking/error,
 *    then its original turn reveals the newest child progress in place.
 * B: an expanded live card grows above a reader under a pinned prompt; every
 *    rendered frame retains the first non-sticky visible row within 3 px.
 * D4 commits the card to parent JSONL and its children to a per-run delegate
 * log; progress no longer resets the parent transcript.
 * Run headlessly (do not rebuild the shared bundle):
 *   pnpm run test:electron:built chat-live-delegate-anchor.spec.mjs --reporter=line
 *   CANOPY_E2E_OUT_DIR=out-e2e-base pnpm run test:electron:built chat-live-delegate-anchor.spec.mjs --reporter=line
 * Deterministic: isolated storage, local scripted inference, one gated child,
 * canonical main ingress for lightweight imported history, stable geometry
 * before sampling, and no input while log updates are sampled. B uses
 * production CSS/native anchoring and measures reader flow displacement
 * against card growth to prove above-reader layout actually changes. No live
 * providers. Diagnostics (page/reset counts, geometry, fixture requests) go
 * to the line reporter, including on failure. Never accept a panel-only card.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect as baseExpect, test } from '@playwright/test';
import { cleanupDemoWorkspaces } from './demoWorkspaces.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { createDelegationInference } from './delegationRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  WORKLOAD,
  createWorkloadInference,
  expandDelegatedCard,
  installTranscriptPageGate,
  installTranscriptResetCollector,
  openParentChat,
  parentMessage,
  progressMarker,
  readCommittedDelegationRows,
  readDurableDelegationState,
  readTranscriptPageGate,
  readTranscriptResetEvents,
  releaseTranscriptPageGate,
  scaled,
  seedDelegationStorageWorkload,
  sendParentMessage,
  turnMarker,
  waitForStorageQuiet,
  withTimeout,
} from './delegationStorageWorkload.mjs';

const expect = baseExpect.configure({ timeout: scaled(30_000) });
const PROGRESS_STEPS = 3;
const READER_MARKER = 'ANCHOR-READER-';
const MARKER_PATTERN = /STORAGE-(?:PROGRESS-\d+-\d+|FINAL-\d+)/g;

async function readLoggedState(paths, seeded) {
  const state = await readDurableDelegationState(paths, {
    prefixBytes: seeded.committedBytes,
    lastMessageId: seeded.lastMessageId,
  });
  for (const [id, card] of Object.entries(state.cards)) {
    const name = createHash('sha256').update(id).digest('hex').slice(0, 32);
    const log = path.join(
      paths.transcriptsDirectory,
      'delegations',
      WORKLOAD.chatId,
      `${name}.${card.runGeneration}.jsonl`,
    );
    const items = new Map();
    if (existsSync(log)) {
      for (const line of readFileSync(log, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.v === 1 && parsed.item?.id)
            items.set(parsed.item.id, parsed.item);
        } catch {
          // Ignore a torn final line while the log is being appended.
        }
      }
    }
    const children = [...items.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => ({
        rowId: `${card.rowId}:${item.id}`,
        sequence: item.sequence,
        source: 'delegate-log',
        parentBlockId: card.rowId,
        markers: [item.text, item.input, item.output].flatMap((value) =>
          typeof value === 'string'
            ? [...value.matchAll(MARKER_PATTERN)].map((match) => match[0])
            : [],
        ),
      }));
    state.childRowsById[id] = children;
    state.childCountById[id] = children.length;
    state.markersById[id] = [
      ...new Set([
        ...(state.markersById[id] ?? []),
        ...children.flatMap((child) => child.markers),
      ]),
    ];
  }
  return state;
}
test.skip(
  !['darwin', 'win32'].includes(process.platform),
  'Managed delegation requires the macOS or Windows confined file boundary.',
);

// Match captureTranscriptAnchor, including its sticky ancestor exclusion.
async function captureViewportAnchor(scroller) {
  return scroller.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = Array.from(
      element.querySelectorAll('[data-chat-message-id]'),
    ).find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return (
        candidate.dataset.chatMessageId &&
        !candidate.closest('[data-sticky-user-message-id]') &&
        box.height > 0 &&
        box.bottom > viewport.top &&
        box.top < viewport.bottom
      );
    });
    if (!row) return null;
    return {
      messageId: row.dataset.chatMessageId,
      topPx: row.getBoundingClientRect().top - viewport.top,
    };
  });
}

async function stableAnchor(scroller) {
  let previous;
  let anchor;
  let stable = 0;
  await expect
    .poll(
      async () => {
        anchor = await captureViewportAnchor(scroller);
        stable =
          anchor &&
          anchor.messageId === previous?.messageId &&
          Math.abs(anchor.topPx - previous.topPx) < 0.1
            ? stable + 1
            : 0;
        previous = anchor;
        return stable;
      },
      { timeout: scaled(120_000), intervals: [100, 250, 500] },
    )
    .toBeGreaterThanOrEqual(3);
  return anchor;
}

async function installErrorLatch(panel) {
  await panel.evaluate((element) => {
    const collector = { seen: false };
    const inspect = (text) => {
      if (text?.includes("Couldn't load messages.")) collector.seen = true;
    };
    inspect(element.textContent);
    const observer = new MutationObserver((records) => {
      inspect(element.textContent);
      for (const record of records) {
        inspect(record.oldValue);
        inspect(record.target.textContent);
        for (const node of record.addedNodes) inspect(node.textContent);
      }
    });
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    globalThis.__CANOPY_E2E_ANCHOR_ERROR__ = collector;
  });
}

async function assertNoError(window, panel) {
  await expect(
    panel.getByText("Couldn't load messages.", { exact: true }),
  ).toHaveCount(0);
  expect(
    await window.evaluate(() => globalThis.__CANOPY_E2E_ANCHOR_ERROR__.seen),
    'no transient load error appeared',
  ).toBe(false);
}

async function startFrames(scroller, anchor, checkOffset) {
  await scroller.evaluate(
    (element, { anchor, checkOffset }) => {
      const collector = {
        samples: 0,
        missing: 0,
        blank: 0,
        deviations: [],
        running: true,
      };
      globalThis.__CANOPY_E2E_ANCHOR_FRAMES__ = collector;
      const inspectFrame = () => {
        if (!collector.running)
          throw new Error('Anchor sampler stopped before final check');
        collector.samples += 1;
        const viewport = element.getBoundingClientRect();
        const rows = Array.from(
          element.querySelectorAll('[data-chat-message-id]'),
        ).filter(
          (row) =>
            !row.closest('[data-sticky-user-message-id]') &&
            row.getBoundingClientRect().height > 0,
        );
        if (
          !rows.some((row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > viewport.top && box.top < viewport.bottom;
          })
        )
          collector.blank += 1;
        const firstVisible = rows.find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.bottom > viewport.top && box.top < viewport.bottom;
        });
        const row = rows.find(
          (candidate) => candidate.dataset.chatMessageId === anchor.messageId,
        );
        const offset = row
          ? row.getBoundingClientRect().top - viewport.top
          : null;
        const current = {
          messageId: row?.dataset.chatMessageId ?? null,
          firstVisibleMessageId: firstVisible?.dataset.chatMessageId ?? null,
          topPx: offset,
          deltaPx: offset === null ? null : offset - anchor.topPx,
        };
        collector.latest = current;
        if (!row) collector.missing += 1;
        else if (checkOffset && Math.abs(current.deltaPx) > 3)
          collector.deviations.push({
            offsetPx: offset,
            deltaPx: current.deltaPx,
          });
        return current;
      };
      collector.inspectFrame = inspectFrame;
      const sample = () => {
        if (!collector.running) return;
        inspectFrame();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    { anchor, checkOffset },
  );
}

// The per-step final assertion runs on a rendered frame using precisely the
// sampler's tracked-row lookup, sticky exclusion and viewport-relative offset.
// The continuous sampler stays active through this checkpoint and assertions.
async function captureSampledAnchor(scroller) {
  return scroller.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          resolve(globalThis.__CANOPY_E2E_ANCHOR_FRAMES__.inspectFrame()),
        );
      }),
  );
}

async function stopFrames(window) {
  return window.evaluate(() => {
    const collector = globalThis.__CANOPY_E2E_ANCHOR_FRAMES__;
    if (!collector) return null;
    collector.running = false;
    return {
      samples: collector.samples,
      missing: collector.missing,
      blank: collector.blank,
      deviations: collector.deviations,
      latest: collector.latest,
    };
  });
}

// Canonical fixture import, not a renderer-store mutation or direct disk edit.
// A settled background delegate can outlive arbitrarily many later turns.
async function appendLaterTurns(electronApp) {
  const messages = [];
  const startedAt = Date.parse('2026-10-11T12:00:00Z');
  for (let turn = 0; turn < 240; turn += 1) {
    const timestamp = startedAt + turn * 10_000;
    const id = `anchor-history-${turn}`;
    messages.push(
      {
        id: `${id}-prompt`,
        role: 'user',
        timestamp,
        blocks: [
          {
            type: 'text',
            text: `Later history ${turn}: review saved evidence.`,
          },
        ],
      },
      {
        id: `${id}-timer`,
        role: 'system',
        timestamp: timestamp + 1,
        blocks: [
          {
            type: 'turn_timer',
            startedAt: timestamp,
            completedAt: timestamp + 1000,
          },
        ],
      },
      {
        id: `${id}-final`,
        role: 'assistant',
        timestamp: timestamp + 1000,
        blocks: [
          {
            type: 'text',
            text:
              `Later history ${turn} completed. ` +
              'Preserve the saved evidence and review the stable transcript. '.repeat(
                5,
              ),
          },
        ],
      },
    );
  }
  await electronApp.evaluate(async (_electron, messages) => {
    const ingest = globalThis.__CANOPY_E2E_INGEST_CHAT_EVENT__;
    if (typeof ingest !== 'function')
      throw new Error('Canonical E2E ingress unavailable');
    await ingest({
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      chatId: 'delegating-parent',
      providerType: 'codex',
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: messages.length,
        messages,
      },
    });
  }, messages);
}

async function runCase(kind, work) {
  test.setTimeout(scaled(900_000));
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-delegate-anchor-${kind}-`),
  );
  const inference = createWorkloadInference({
    turns: { 1: { slots: [0], holdFinal: kind === 'B' } },
    progressSteps: PROGRESS_STEPS,
  });
  let parentReaderSteps = 0;
  const script = async (ctx) => {
    // Only the Codex parent: the Claude child retains the shared gated script.
    // Real parent tool turns produce reading material after its background spawn.
    if (
      kind === 'B' &&
      ctx.harness === 'codex' &&
      String(ctx.context ?? '').includes('STORAGE-SLOT-0') &&
      parentReaderSteps < 8
    ) {
      const step = parentReaderSteps++;
      return ctx.reply({
        text:
          `${READER_MARKER}${step}\n\n` +
          'Read this independent parent evidence while the background delegate reviews its files. '.repeat(
            18,
          ),
        toolCalls: [ctx.nativeRead('delegation-evidence.txt')],
        stopReason: 'tool_use',
      });
    }
    return inference.script(ctx);
  };
  let fixture;
  let demo;
  let electronApp;
  let window;
  let gateInstalled = false;
  const cleanupErrors = [];
  try {
    fixture = await createDelegationInference({
      parent: 'codex',
      child: 'claude',
      mode: 'background',
      caseId: `delegate-anchor-${kind}`,
      script,
    });
    const seededWorkload = await seedDelegationStorageWorkload({
      userDataDir,
      fixture,
      progressSteps: PROGRESS_STEPS,
      stressTurns: 1,
      stressBatches: 1,
      stressFinalBytes: 512,
    });
    demo = seededWorkload.demo;
    const { paths, seeded } = seededWorkload;
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
    }));
    let panel;
    ({ window, panel } = await openParentChat(electronApp));
    await sendParentMessage(window, parentMessage(fixture, 1, [0]));
    await expect
      .poll(
        () => inference.parentSpawned(1) && inference.childStepRequested(0, 0),
        { timeout: scaled(180_000) },
      )
      .toBe(true);
    if (kind === 'A')
      await expect(
        composerIdleAction(panel.locator('[data-chat-composer-root]')),
      ).toBeVisible({ timeout: scaled(180_000) });
    else
      await expect
        .poll(() => inference.parentFinalRequested(1), {
          timeout: scaled(180_000),
        })
        .toBe(true);
    const readDurable = () => readLoggedState(paths, seeded);
    let durable;
    await expect
      .poll(
        async () => {
          durable = await readDurable();
          return Boolean(durable.idsBySlot[0]);
        },
        { timeout: scaled(180_000) },
      )
      .toBe(true);
    const delegationId = durable.idsBySlot[0];
    if (kind === 'A') {
      inference.releaseChildStep(0, [0]);
      await expect
        .poll(() => inference.childStepRequested(0, 1), {
          timeout: scaled(180_000),
        })
        .toBe(true);
      await expect
        .poll(
          async () => {
            durable = await readDurable();
            return durable.markersById[delegationId]?.includes(
              progressMarker(0, 0),
            );
          },
          { timeout: scaled(180_000) },
        )
        .toBe(true);
    }
    await waitForStorageQuiet(electronApp);
    if (kind === 'A') await appendLaterTurns(electronApp);
    await installTranscriptPageGate(electronApp, { chatId: WORKLOAD.chatId });
    gateInstalled = true;
    // This case counts pages; it does not interrupt an older page (the paging
    // spec covers that race). Disable the shared helper's default older hold.
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__CANOPY_E2E_TRANSCRIPT_PAGE_GATE__.holdNextOlder = false;
      // Hydration already loads a newest turn page via get-state, without a
      // get-transcript-page IPC. Observe the actual delivered window rather
      // than issuing a test-only page request that would contaminate counts.
      const channel = 'chat:get-state';
      const original = ipcMain._invokeHandlers.get(channel);
      if (typeof original !== 'function') throw new Error(`Missing ${channel}`);
      globalThis.__CANOPY_E2E_ANCHOR_HYDRATIONS__ = [];
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const snapshot = await original(event, request);
        const tab = snapshot?.tabsFile?.tabs?.find(
          (candidate) => candidate.id === 'delegating-parent',
        );
        if (tab?.transcriptWindow) {
          globalThis.__CANOPY_E2E_ANCHOR_HYDRATIONS__.push({
            messageIds: tab.messages.map((message) => message.id),
            beforeCursor: tab.transcriptWindow.before,
            view: tab.transcriptWindow.view,
          });
        }
        return snapshot;
      });
    });
    if (kind === 'A') {
      await window.reload();
      ({ window, panel } = await openParentChat(electronApp));
    }
    await installTranscriptResetCollector(window, { chatId: WORKLOAD.chatId });
    await installErrorLatch(panel);
    const scroller = panel.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible();
    const card = scroller.locator(
      `[data-testid="chat-delegated-agent"][data-delegation-id="${delegationId}"]`,
    );
    const release = async (step) => {
      const before = (await readTranscriptResetEvents(window)).length;
      const previous = await readDurable();
      const previousIds = new Set(
        (previous.childRowsById[delegationId] ?? []).map((row) => row.rowId),
      );
      inference.releaseChildStep(step, [0]);
      await expect
        .poll(() => inference.childStepRequested(0, step + 1), {
          timeout: scaled(180_000),
        })
        .toBe(true);
      await expect
        .poll(
          async () => {
            durable = await readDurable();
            // partialText on the card can publish this marker before the
            // cadence-delayed full transcript publishes its new child rows.
            // Wait for a NEW durable child carrying this step, not that card.
            return (durable.childRowsById[delegationId] ?? []).some(
              (row) =>
                !previousIds.has(row.rowId) &&
                row.markers.includes(progressMarker(0, step)),
            );
          },
          { timeout: scaled(180_000) },
        )
        .toBe(true);
      expect(durable.cards[delegationId].source).toBe('jsonl');
      expect(durable.childCountById[delegationId]).toBeGreaterThan(
        previous.childCountById[delegationId] ?? 0,
      );
      // D4 appends progress to the delegate log without resetting parent rows.
      expect((await readTranscriptResetEvents(window)).length).toBe(before);
      await expect(
        panel.getByTestId('chat-transcript-loading-spinner'),
      ).toHaveCount(0, { timeout: scaled(180_000) });
      await waitForStorageQuiet(electronApp);
      await assertNoError(window, panel);
      const inserted = durable.childRowsById[delegationId].filter(
        (row) => !previousIds.has(row.rowId),
      );
      for (const row of inserted) {
        expect(row.source).toBe('delegate-log');
        expect(row.parentBlockId).toBe(durable.cards[delegationId].rowId);
      }
      console.log(
        `[delegate-anchor ${kind}] step=${step} inserted=${JSON.stringify(inserted)}`,
      );
      return inserted;
    };
    await work({
      electronApp,
      window,
      panel,
      scroller,
      card,
      delegationId,
      cardRowId: durable.cards[delegationId].rowId,
      paths,
      release,
    });
    expect(inference.snapshot().errors).toEqual([]);
  } finally {
    if (window && !window.isClosed()) {
      const diagnostics = await Promise.allSettled([
        readTranscriptResetEvents(window),
        readTranscriptPageGate(electronApp),
        stopFrames(window),
      ]);
      console.log(
        `[delegate-anchor ${kind}] ${JSON.stringify({
          diagnostics,
          inference: inference.snapshot(),
          parentReaderSteps,
        })}`,
      );
    }
    inference.releaseAll();
    fixture?.releaseChild();
    const cleanup = async (label, work) => {
      try {
        await withTimeout(label, scaled(60_000), work);
      } catch (error) {
        cleanupErrors.push(String(error));
        console.warn(`[anchor teardown] ${label}: ${error}`);
      }
    };
    if (electronApp && gateInstalled)
      await cleanup('page gate release', () =>
        releaseTranscriptPageGate(electronApp),
      );
    if (electronApp)
      await cleanup('close canopy', () =>
        closeCanopy(electronApp, userDataDir),
      );
    await cleanup('inference close', () => fixture?.close());
    await cleanup('demo cleanup', () => cleanupDemoWorkspaces(demo));
    await cleanup('temporary data', () => {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    });
  }
  expect(cleanupErrors, 'fixture teardown succeeded').toEqual([]);
}

// A's parent is settled so later ordinary turns can follow it. Expanding its
// own Agent steps on return is essential: the activity panel is not the oracle.
test('Case A: live delegate above the loaded window reloads without blanking', async () => {
  await runCase(
    'A',
    async ({
      electronApp,
      window,
      panel,
      scroller,
      card,
      cardRowId,
      delegationId,
      paths,
      release,
    }) => {
      let initialPage;
      await expect
        .poll(
          async () => {
            initialPage = await electronApp.evaluate(() =>
              globalThis.__CANOPY_E2E_ANCHOR_HYDRATIONS__.at(-1),
            );
            return Boolean(initialPage);
          },
          { timeout: scaled(180_000) },
        )
        .toBe(true);
      console.log(
        `[delegate-anchor A] hydratedWindow=${JSON.stringify(initialPage)}`,
      );
      expect(initialPage.view).toBe('turns');
      expect(
        initialPage.messageIds.filter((id) =>
          /^anchor-history-\d+-prompt$/.test(id),
        ),
      ).toHaveLength(100);
      expect(
        initialPage.messageIds,
        'live card really lies above the loaded page',
      ).not.toContain(cardRowId);
      expect(initialPage.beforeCursor).toBeGreaterThan(0);
      await expect(card).toHaveCount(0);
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight * 0.6;
      });
      const anchor = await stableAnchor(scroller);
      expect(anchor.messageId).toMatch(/^anchor-history-/);
      await startFrames(scroller, anchor, false);
      const pagesBefore = (await readTranscriptPageGate(electronApp)).requests;
      for (const step of [1, 2]) await release(step);
      const frames = await stopFrames(window);
      expect(frames.samples).toBeGreaterThan(0);
      expect(frames.blank, 'no rendered frame blanks the history').toBe(0);
      expect(
        frames.missing,
        'the on-screen history row stays mounted during reload',
      ).toBe(0);
      const resetCount = (await readTranscriptResetEvents(window)).length;
      const pagesAfter = await readTranscriptPageGate(electronApp);
      expect(resetCount).toBe(0);
      expect(
        pagesAfter.requests,
        'delegate-log progress does not reload the parent window',
      ).toBe(pagesBefore);
      console.log(
        `[delegate-anchor A] resets=${resetCount} resetPageRequests=${pagesAfter.requests - pagesBefore}`,
      );
      const committed = await readCommittedDelegationRows(paths.transcriptPath);
      const prompt = committed.parentRows.find((row) =>
        row.markers.includes(turnMarker(1)),
      );
      expect(prompt).toBeTruthy();
      const promptRow = scroller.locator(
        `[data-chat-message-id="${prompt.id}"]`,
      );
      await scroller.hover();
      await expect
        .poll(
          async () => {
            if (await promptRow.count()) return true;
            await window.mouse.wheel(0, -10_000);
            return false;
          },
          { timeout: scaled(180_000), intervals: [250, 500, 1000] },
        )
        .toBe(true);
      await promptRow.scrollIntoViewIfNeeded();
      const group = scroller.locator(`[data-chat-turn-group="${prompt.id}"]`);
      const expand = group.locator(
        'button[aria-label^="Agent steps"][aria-expanded="false"]',
      );
      if (await expand.count()) await expand.click();
      await expect(
        card,
        'card is in its original transcript turn, not just the activity panel',
      ).toHaveCount(1);
      await expandDelegatedCard(card);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeInViewport();
      await expect(card).toContainText(progressMarker(0, 2));
      expect(
        await card.evaluate(
          (element) =>
            element.closest('[data-chat-turn-group]')?.dataset.chatTurnGroup,
        ),
      ).toBe(prompt.id);
      await assertNoError(window, panel);
      console.log(
        `[delegate-anchor A] totalPageRequests=${(await readTranscriptPageGate(electronApp)).requests} delegation=${delegationId}`,
      );
    },
  );
});

test('Case B: expanded live delegate above a pinned-prompt reader preserves every frame', async () => {
  await runCase('B', async ({ window, panel, scroller, card, release }) => {
    await expect(
      card,
      'active parent exposes the live card inside the scroller',
    ).toHaveCount(1);
    await expandDelegatedCard(card);
    const reader = scroller
      .locator('[data-chat-message-id]')
      .filter({ hasText: `${READER_MARKER}0` })
      .first();
    await expect(reader).toBeVisible();
    await reader.evaluate((row) => {
      const scroll = row.closest('[data-testid="chat-message-list-scroll"]');
      scroll.scrollTop +=
        row.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top +
        20;
    });
    const anchor = await stableAnchor(scroller);
    const anchorRow = scroller.locator(
      `[data-chat-message-id="${anchor.messageId}"]`,
    );
    await expect(anchorRow).toContainText(READER_MARKER);
    const readGeometry = () =>
      card.evaluate((element, messageId) => {
        const scroll = element.closest(
          '[data-testid="chat-message-list-scroll"]',
        );
        const viewport = scroll.getBoundingClientRect();
        const section = element.closest('[data-chat-sticky-section]');
        const prompt = section?.querySelector('[data-sticky-user-message-id]');
        const row = Array.from(
          scroll.querySelectorAll('[data-chat-message-id]'),
        ).find(
          (candidate) =>
            candidate.dataset.chatMessageId === messageId &&
            !candidate.closest('[data-sticky-user-message-id]'),
        );
        const box = row?.getBoundingClientRect();
        const offset = box ? box.top - viewport.top : null;
        return {
          cardBottom: element.getBoundingClientRect().bottom - viewport.top,
          cardHeight: element.getBoundingClientRect().height,
          promptTop: prompt
            ? prompt.getBoundingClientRect().top - viewport.top
            : null,
          stuck: prompt?.getAttribute('data-stuck'),
          awayFromBottom:
            scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
          scrollTop: scroll.scrollTop,
          readerOffset: offset,
          readerHeight: box?.height,
          // Document-flow coordinate, independent of the applied scroll restore.
          readerFlowTop: offset === null ? null : offset + scroll.scrollTop,
          sameTurn:
            row?.closest('[data-chat-turn-group]') ===
            element.closest('[data-chat-turn-group]'),
          cardPrecedesReader: Boolean(
            row &&
            element.compareDocumentPosition(row) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          nativeAnchoring: getComputedStyle(scroll).overflowAnchor,
        };
      }, anchor.messageId);
    const geometry = await readGeometry();
    console.log(
      `[delegate-anchor B] anchor=${JSON.stringify(anchor)} geometry=${JSON.stringify(geometry)}`,
    );
    expect(
      geometry.cardBottom,
      'expanded card is above the row being read',
    ).toBeLessThanOrEqual(0);
    expect(
      geometry.promptTop,
      'the prompt is pinned at viewport top',
    ).not.toBeNull();
    expect(Math.abs(geometry.promptTop)).toBeLessThanOrEqual(12);
    expect(geometry.stuck).toBe('true');
    expect(geometry.awayFromBottom).toBeGreaterThan(300);
    expect(geometry.sameTurn).toBe(true);
    expect(geometry.cardPrecedesReader).toBe(true);
    expect(
      geometry.readerHeight + anchor.topPx,
      'partially clipped row still intersects the viewport',
    ).toBeGreaterThan(0);
    // A negative top is intentional: captureTranscriptAnchor selects a
    // partially visible row, including the portion behind the pinned header.
    expect(geometry.readerOffset).toBe(anchor.topPx);
    await startFrames(scroller, anchor, true);
    for (const step of [0, 1, 2]) {
      const beforeGeometry = await readGeometry();
      await release(step);
      await expect(card).toContainText(progressMarker(0, step));
      const afterGeometry = await readGeometry();
      console.log(
        `[delegate-anchor B] step=${step} growth=${afterGeometry.cardHeight - beforeGeometry.cardHeight} readerFlowDelta=${afterGeometry.readerFlowTop - beforeGeometry.readerFlowTop} scrollCompensation=${afterGeometry.scrollTop - beforeGeometry.scrollTop}`,
      );
      const current = await captureSampledAnchor(scroller);
      console.log(
        `[delegate-anchor B] step=${step} finalSample=${JSON.stringify(current)}`,
      );
      expect(current.messageId).toBe(anchor.messageId);
      expect(current.firstVisibleMessageId).toBe(anchor.messageId);
      expect(Math.abs(current.topPx - anchor.topPx)).toBeLessThanOrEqual(3);
    }
    const finalGeometry = await readGeometry();
    const insertedHeight = finalGeometry.cardHeight - geometry.cardHeight;
    const flowDisplacement =
      finalGeometry.readerFlowTop - geometry.readerFlowTop;
    const scrollCompensation = finalGeometry.scrollTop - geometry.scrollTop;
    // With its scrollTop held unchanged the reader would move by this flow
    // delta. Require a substantial measured displacement matching card growth,
    // even if the card is far above the viewport. Log scroll compensation:
    // production may combine render-time restore with native anchoring for
    // subsequent in-place growth that does not change transcript row order.
    // This rules out a capped inner scroller or out-of-flow/virtualized card
    // making the every-frame 3 px assertion vacuously pass.
    console.log(
      `[delegate-anchor B] counterfactual=${JSON.stringify({ insertedHeight, flowDisplacement, scrollCompensation })}`,
    );
    expect(
      insertedHeight,
      'child insertion grows the above-reader card',
    ).toBeGreaterThan(30);
    expect(
      flowDisplacement,
      'without scroll compensation the reader would move',
    ).toBeGreaterThan(30);
    expect(
      Math.abs(flowDisplacement - insertedHeight),
      'reader flow displacement matches inserted card height',
    ).toBeLessThanOrEqual(3);
    const frames = await stopFrames(window);
    expect(frames.samples).toBeGreaterThan(0);
    expect(frames.blank).toBe(0);
    expect(
      frames.missing,
      'reader never disappears in any rendered frame',
    ).toBe(0);
    expect(
      frames.deviations,
      'reader offset remains within 3 px on every frame',
    ).toEqual([]);
    await assertNoError(window, panel);
  });
});

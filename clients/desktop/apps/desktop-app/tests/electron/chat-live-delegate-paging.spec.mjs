// Deterministic headless harness: pnpm run test:electron:built chat-live-delegate-paging.spec.mjs --reporter=line
// Uses the local scripted delegation inference fixture; no live provider or network.
//
// A live delegate keeps streaming while the reader scrolls up through older
// transcript pages. Before D4 its progress rewrote the active sidecar, so each
// step reset the parent transcript in the middle of an older-page request.
// D4 commits the card to the parent JSONL once and appends its progress to the
// run's delegate log, so progress no longer resets the parent transcript. The
// race this spec covers is now the closest real one: delegate progress reaches
// the renderer while an older page is held in flight. The scrolled-up anchor
// must hold on every frame, no reset may occur, and the held page must still
// install without further input.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect as baseExpect, test } from '@playwright/test';
import { cleanupDemoWorkspaces } from './demoWorkspaces.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { createDelegationInference } from './delegationRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  WORKLOAD,
  assertSettledDelegationTranscript,
  createWorkloadInference,
  expandDelegatedCard,
  finalMarker,
  holdNextTranscriptPageGate,
  installDelegationEventCollector,
  installTranscriptPageGate,
  installTranscriptResetCollector,
  openParentChat,
  parentMessage,
  progressMarker,
  readCommittedDelegationRows,
  readDelegationEvents,
  readDurableDelegationState,
  readDelegationRuns,
  readTranscriptPageGate,
  readTranscriptResetEvents,
  releaseTranscriptPageGate,
  revealDelegatedCard,
  scaled,
  seedDelegationStorageWorkload,
  sendParentMessage,
  turnMarker,
  waitForStorageQuiet,
  withTimeout,
} from './delegationStorageWorkload.mjs';

const expect = baseExpect.configure({ timeout: scaled(15_000) });
const LIVE_TURNS = {
  1: { slots: [0], holdFinal: false },
  2: { slots: [1], holdFinal: true },
};
const LIVE_PROGRESS_STEPS = 3;

test.skip(
  !['darwin', 'win32'].includes(process.platform),
  'Managed delegation requires the macOS or Windows confined file boundary.',
);

async function captureViewportAnchor(scroller) {
  return scroller.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const message = Array.from(
      element.querySelectorAll('[data-chat-message-id]'),
    ).find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return (
        candidate.dataset.chatMessageId &&
        !candidate.closest('[data-testid="sticky-user-message"]') &&
        box.height > 0 &&
        box.bottom > viewport.top &&
        box.top < viewport.bottom
      );
    });
    if (!message) return null;
    const box = message.getBoundingClientRect();
    return {
      messageId: message.dataset.chatMessageId,
      topPx: Math.round((box.top - viewport.top) * 10) / 10,
    };
  });
}

// The saved anchor row's current offset, found by id like the frame sampler.
// Once the older page installs, its newest row can legitimately reach into
// the viewport above the anchor, so the first visible row is no oracle.
async function measureAnchorRow(scroller, messageId) {
  return scroller.evaluate((element, messageId) => {
    const row = Array.from(
      element.querySelectorAll('[data-chat-message-id]'),
    ).find(
      (candidate) =>
        candidate.dataset.chatMessageId === messageId &&
        !candidate.closest('[data-testid="sticky-user-message"]') &&
        candidate.getBoundingClientRect().height > 0,
    );
    if (!row) return null;
    const top =
      row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    return { messageId, topPx: Math.round(top * 10) / 10 };
  }, messageId);
}

test('live delegate continuation preserves a scrolled-up transcript anchor while older pages load', async () => {
  test.setTimeout(scaled(600_000));
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-live-delegate-paging-'),
  );
  const inference = createWorkloadInference({
    turns: LIVE_TURNS,
    progressSteps: LIVE_PROGRESS_STEPS,
  });
  let fixture;
  let demo;
  let electronApp;
  let pageGateInstalled = false;
  const cleanupErrors = [];

  const readDurable = (paths, seeded) =>
    readDurableDelegationState(paths, {
      prefixBytes: seeded.committedBytes,
      lastMessageId: seeded.lastMessageId,
    });

  try {
    fixture = await createDelegationInference({
      parent: 'codex',
      child: 'claude',
      mode: 'background',
      caseId: 'live-delegate-paging',
      script: inference.script,
    });
    const seededWorkload = await seedDelegationStorageWorkload({
      userDataDir,
      fixture,
      progressSteps: LIVE_PROGRESS_STEPS,
      // Main's turn-aware reader serves 100 turns per page. Leave at least
      // two older pages, without multiplying the 50 MB pressure fixture.
      stressTurns: 240,
      stressBatches: 1,
      stressFinalBytes: 512,
    });
    const { paths, seeded } = seededWorkload;
    demo = seededWorkload.demo;

    const launched = await launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
    });
    electronApp = launched.electronApp;
    const { window, panel } = await openParentChat(electronApp);
    await installDelegationEventCollector(window, { chatId: WORKLOAD.chatId });
    const scroller = panel.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible();
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight), {
        timeout: scaled(120_000),
      })
      .toBeGreaterThan(10_000);

    const composerRoot = panel.locator('[data-chat-composer-root]');
    await sendParentMessage(window, parentMessage(fixture, 1, [0]));
    await expect
      .poll(
        () => inference.parentSpawned(1) && inference.childStepRequested(0, 0),
        { timeout: scaled(120_000) },
      )
      .toBe(true);
    await expect(composerIdleAction(composerRoot)).toBeVisible({
      timeout: scaled(120_000),
    });

    await sendParentMessage(window, parentMessage(fixture, 2, [1]));
    await expect
      .poll(
        () =>
          inference.parentSpawned(2) &&
          inference.childStepRequested(1, 0) &&
          inference.parentFinalRequested(2),
        { timeout: scaled(120_000) },
      )
      .toBe(true);

    let durable;
    await expect
      .poll(
        async () => {
          durable = await readDurable(paths, seeded);
          return Boolean(durable.idsBySlot[0] && durable.idsBySlot[1]);
        },
        { timeout: scaled(120_000) },
      )
      .toBe(true);
    inference.releaseChildStep(0, [0]);
    await expect
      .poll(() => inference.childStepRequested(0, 1), {
        timeout: scaled(120_000),
      })
      .toBe(true);
    await expect
      .poll(
        async () => {
          durable = await readDurable(paths, seeded);
          const id = durable.idsBySlot[0];
          return Boolean(
            id &&
            durable.markersById[id]?.includes(progressMarker(0, 0)) &&
            durable.cards[id]?.source === 'jsonl' &&
            durable.cards[id]?.transcriptStore === 'chat-log-v1',
          );
        },
        { timeout: scaled(120_000) },
      )
      .toBe(true);
    await waitForStorageQuiet(electronApp);

    const delegationId = durable.idsBySlot[0];
    const liveCard = await revealDelegatedCard(panel, delegationId);
    await expandDelegatedCard(liveCard);
    await expect(
      liveCard.locator('[data-step-row-words].canopy-text-shimmer-strong'),
    ).toHaveCount(1);
    await expect(liveCard).toContainText(progressMarker(0, 0));
    // A finished turn collapses its interior, and a live card from it shows in
    // the agent activity panel, so prove the position from storage: the live
    // card is a committed row that later committed rows follow.
    const committedBeforePaging = await readCommittedDelegationRows(
      paths.transcriptPath,
    );
    const liveCardIndex = committedBeforePaging.rowIds.indexOf(
      durable.cards[delegationId]?.rowId,
    );
    expect(
      liveCardIndex,
      'the live card is a committed row',
    ).toBeGreaterThanOrEqual(0);
    expect(
      liveCardIndex,
      'later committed rows follow the live card, so its continuation lands in the transcript middle',
    ).toBeLessThan(committedBeforePaging.rowIds.length - 1);
    expect(
      committedBeforePaging.children.filter(
        (child) =>
          child.parentBlockId === durable.cards[delegationId].agentBlockId,
      ),
      'live child rows stay out of the parent transcript',
    ).toEqual([]);
    await expect(
      panel
        .locator('[data-chat-message-id]')
        .filter({ hasText: turnMarker(2) })
        .first(),
    ).toBeVisible();

    await installTranscriptResetCollector(window, { chatId: WORKLOAD.chatId });
    await installTranscriptPageGate(electronApp, { chatId: WORKLOAD.chatId });
    pageGateInstalled = true;
    const transcriptLoadError = panel.getByText("Couldn't load messages.", {
      exact: true,
    });
    // Keep an ever-seen error latch, not just snapshots that can miss a short
    // error flash between a stale response and its successful retry.
    await panel.evaluate((element) => {
      const errorText = "Couldn't load messages.";
      const collector = { seen: false };
      const inspect = (text) => {
        if (text?.includes(errorText)) collector.seen = true;
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
      globalThis.__CANOPY_E2E_PAGING_ERROR__ = collector;
    });
    const assertNoLoadError = async () => {
      await expect(transcriptLoadError).toHaveCount(0);
      expect(
        await window.evaluate(
          () => globalThis.__CANOPY_E2E_PAGING_ERROR__.seen,
        ),
        'no transient transcript-load error has appeared',
      ).toBe(false);
    };

    const resetStart = (await readTranscriptResetEvents(window)).length;
    const installedOlderPrompts = [];
    let previousBefore;
    for (const step of [1, 2]) {
      if (step > 1)
        expect(await holdNextTranscriptPageGate(electronApp)).toBe(true);
      const holdsBefore = (await readTranscriptPageGate(electronApp)).holds;
      // Scroll only until an older response is held. No further wheel input is
      // allowed until the progress/install anchor checks finish.
      await scroller.hover();
      await expect
        .poll(
          async () => {
            const gate = await readTranscriptPageGate(electronApp);
            if (gate.held && gate.holds > holdsBefore) return true;
            await window.mouse.wheel(0, -20_000);
            return false;
          },
          { timeout: scaled(120_000), intervals: [100, 250, 500, 1_000] },
        )
        .toBe(true);
      const heldGate = await readTranscriptPageGate(electronApp);
      const heldPage = heldGate.pages.find(
        (page) => page.requestNumber === heldGate.heldRequestNumber,
      );
      expect(heldGate.heldRequestKind).toBe('older');
      expect(heldPage.chatId).toBe(WORKLOAD.chatId);
      expect(heldPage.before).toEqual(expect.any(Number));
      if (previousBefore !== undefined)
        expect(heldPage.before).toBeLessThan(previousBefore);
      previousBefore = heldPage.before;
      // A turn prompt is rendered even when its 600+ interior tool rows are
      // collapsed. Picking a tool id here would not be a valid DOM oracle.
      const olderPromptId = heldPage.messageIds
        .filter((id) => /^stress-\d+-prompt$/.test(id))
        .at(-1);
      expect(
        olderPromptId,
        'the held older page contains a rendered history turn',
      ).toEqual(expect.any(String));
      expect(installedOlderPrompts).not.toContain(olderPromptId);
      const olderPrompt = panel.locator(
        `[data-chat-message-id="${olderPromptId}"]`,
      );
      await expect(olderPrompt).toHaveCount(0);
      let anchor;
      let previousAnchor;
      let stableSamples = 0;
      await expect
        .poll(
          async () => {
            anchor = await captureViewportAnchor(scroller);
            if (
              anchor &&
              JSON.stringify(anchor) === JSON.stringify(previousAnchor)
            )
              stableSamples += 1;
            else stableSamples = 0;
            previousAnchor = anchor;
            return stableSamples;
          },
          { timeout: scaled(60_000), intervals: [100, 250, 500] },
        )
        .toBeGreaterThanOrEqual(3);
      expect(anchor.messageId).toMatch(/^stress-/);
      // Check every rendered frame while wheel input is stopped, so progress
      // cannot blank the list or jump away and then quietly recover before an
      // eventual polling assertion. All evaluate payloads are one object.
      await scroller.evaluate(
        (element, { anchor }) => {
          const collector = {
            samples: 0,
            missing: 0,
            deviations: [],
            running: true,
          };
          globalThis.__CANOPY_E2E_PAGING_ANCHOR__ = collector;
          const sample = () => {
            if (!collector.running) return;
            collector.samples += 1;
            const row = Array.from(
              element.querySelectorAll('[data-chat-message-id]'),
            ).find(
              (candidate) =>
                candidate.dataset.chatMessageId === anchor.messageId &&
                !candidate.closest('[data-testid="sticky-user-message"]') &&
                candidate.getBoundingClientRect().height > 0,
            );
            if (!row) collector.missing += 1;
            else {
              const offset =
                row.getBoundingClientRect().top -
                element.getBoundingClientRect().top;
              if (Math.abs(offset - anchor.topPx) > 3)
                collector.deviations.push(offset);
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        },
        { anchor },
      );

      const resetsBefore = (await readTranscriptResetEvents(window)).length;
      const eventsBefore = (await readDelegationEvents(window)).entries.length;
      const previousIds = new Set(
        (durable.childRowsById[delegationId] ?? []).map((child) => child.rowId),
      );
      inference.releaseChildStep(step, [0]);
      await expect
        .poll(
          async () => {
            durable = await readDurable(paths, seeded);
            return (durable.childRowsById[delegationId] ?? []).some(
              (child) =>
                !previousIds.has(child.rowId) &&
                child.markers.includes(progressMarker(0, step)),
            );
          },
          { timeout: scaled(120_000) },
        )
        .toBe(true);
      // The progress reaches the renderer while the older page is still held.
      await expect
        .poll(
          async () =>
            (await readDelegationEvents(window)).entries
              .slice(eventsBefore)
              .some(
                (event) =>
                  event.delegationId === delegationId &&
                  event.markers.includes(progressMarker(0, step)),
              ),
          { timeout: scaled(120_000) },
        )
        .toBe(true);
      expect(
        (await readTranscriptPageGate(electronApp)).held,
        `progress ${step} arrived while the older page was in flight`,
      ).toBe(true);
      const children = durable.childRowsById[delegationId];
      const childIndex = children.findIndex(
        (child) =>
          !previousIds.has(child.rowId) &&
          child.markers.includes(progressMarker(0, step)),
      );
      expect(childIndex).toBeGreaterThan(0);
      expect(children[childIndex]).toMatchObject({
        source: 'delegate-log',
        parentBlockId: durable.cards[delegationId].agentBlockId,
      });
      expect(
        children[childIndex].sequence,
        'progress is appended after the previous logged item',
      ).toBeGreaterThan(children[childIndex - 1].sequence);
      expect(
        (await readTranscriptResetEvents(window)).length,
        `delegate-log progress ${step} does not reset the parent transcript`,
      ).toBe(resetsBefore);
      await assertNoLoadError();
      expect(await releaseTranscriptPageGate(electronApp)).toBe(true);
      await expect
        .poll(() => readTranscriptPageGate(electronApp), {
          timeout: scaled(120_000),
        })
        .toMatchObject({ held: false, holdNextOlder: false });
      // Should a reload interrupt the request, it must retry the older cursor.
      // Either way, the pending older page must INSTALL without another wheel/click:
      // its nearest older turn is in the two-section virtual overscan at the
      // old page boundary. An IPC response alone is not installation proof.
      await expect(
        olderPrompt,
        `older rows install automatically across progress ${step}`,
      ).toHaveCount(1, { timeout: scaled(120_000) });
      const pagesAfterReset = (
        await readTranscriptPageGate(electronApp)
      ).pages.filter((page) => page.requestNumber > heldPage.requestNumber);
      if (
        pagesAfterReset.some(
          (page) =>
            page.requestKind === 'newest' && page.chatId === WORKLOAD.chatId,
        )
      ) {
        expect(
          pagesAfterReset.some(
            (page) =>
              page.requestKind === 'older' &&
              page.chatId === WORKLOAD.chatId &&
              page.before === heldPage.before &&
              page.messageIds.includes(olderPromptId),
          ),
          'a window reload automatically retries the interrupted older cursor',
        ).toBe(true);
      }
      await expect(
        panel.getByTestId('chat-transcript-loading-spinner'),
      ).toHaveCount(0, { timeout: scaled(120_000) });
      // Wait for stable geometry after the page response has actually finished,
      // not a passing anchor check while the response is still held/in flight.
      // Track the saved row itself: the installed page's newest row may now
      // fill the space above it at the viewport top.
      let anchoredSamples = 0;
      let lastAnchor;
      try {
        await expect
          .poll(
            async () => {
              const current = await measureAnchorRow(
                scroller,
                anchor.messageId,
              );
              lastAnchor = current;
              if (
                current?.messageId === anchor.messageId &&
                Math.abs(current.topPx - anchor.topPx) <= 3
              )
                anchoredSamples += 1;
              else anchoredSamples = 0;
              return anchoredSamples;
            },
            { timeout: scaled(120_000), intervals: [100, 250, 500] },
          )
          .toBeGreaterThanOrEqual(3);
      } catch (error) {
        const diagnostics = await Promise.allSettled([
          window.evaluate(() => {
            const collector = globalThis.__CANOPY_E2E_PAGING_ANCHOR__;
            return {
              samples: collector.samples,
              missing: collector.missing,
              deviations: collector.deviations.slice(0, 20),
            };
          }),
          scroller.evaluate((element) => ({
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          })),
          readTranscriptPageGate(electronApp).then((gate) =>
            gate.pages.map(({ messageIds, ...page }) => ({
              ...page,
              messageCount: messageIds.length,
            })),
          ),
        ]);
        console.log(
          `[live-delegate-paging] step=${step} anchor=${JSON.stringify(anchor)} last=${JSON.stringify(lastAnchor)} diagnostics=${JSON.stringify(diagnostics)}`,
        );
        throw error;
      }
      const anchorFrames = await window.evaluate(() => {
        const collector = globalThis.__CANOPY_E2E_PAGING_ANCHOR__;
        collector.running = false;
        return {
          samples: collector.samples,
          missing: collector.missing,
          deviations: collector.deviations,
        };
      });
      expect(anchorFrames.samples).toBeGreaterThan(0);
      expect(
        anchorFrames.missing,
        `progress ${step} never removes the viewport message`,
      ).toBe(0);
      expect(
        anchorFrames.deviations,
        `progress ${step} keeps message id ${anchor.messageId} within 3px of its saved offset`,
      ).toEqual([]);
      await assertNoLoadError();
      // The older prompt has mounted in overscan without further input. Now
      // scroll it into the actual viewport as an additional user-visible proof.
      await scroller.hover();
      await expect
        .poll(
          async () => {
            const inViewport = await olderPrompt
              .evaluate((row) => {
                const viewport = row
                  .closest('[data-testid="chat-message-list-scroll"]')
                  ?.getBoundingClientRect();
                const box = row.getBoundingClientRect();
                return Boolean(
                  viewport &&
                  box.height > 0 &&
                  box.bottom > viewport.top &&
                  box.top < viewport.bottom,
                );
              })
              .catch(() => false);
            if (inViewport) return true;
            await window.mouse.wheel(0, -2_000);
            return false;
          },
          { timeout: scaled(120_000), intervals: [100, 250, 500, 1_000] },
        )
        .toBe(true);
      await expect(
        olderPrompt,
        `older page installs after progress ${step}`,
      ).toBeInViewport();
      installedOlderPrompts.push(olderPromptId);
      await assertNoLoadError();
    }
    expect(installedOlderPrompts).toHaveLength(2);
    expect(
      (await readTranscriptResetEvents(window)).length - resetStart,
      'delegate progress never reset the parent transcript while paging',
    ).toBe(0);
    const liveBeforeSettle = await readDurable(paths, seeded);

    // The shared mock server can swap concurrent Claude replies. Drain each
    // child serially and wait for consumption before releasing another run.
    for (const slot of [0, 1]) {
      for (
        let step = slot === 0 ? LIVE_PROGRESS_STEPS : 0;
        step <= LIVE_PROGRESS_STEPS;
        step += 1
      ) {
        inference.releaseChildStep(step, [slot]);
        await expect
          .poll(
            () =>
              step < LIVE_PROGRESS_STEPS
                ? inference.childStepRequested(slot, step + 1)
                : readDelegationRuns(userDataDir).some(
                    (run) =>
                      run.state.delegationId ===
                        liveBeforeSettle.idsBySlot[slot] &&
                      run.state.status === 'completed',
                  ),
            { timeout: scaled(120_000) },
          )
          .toBe(true);
      }
    }
    inference.releaseParentFinal(2);
    await expect(composerIdleAction(composerRoot)).toBeVisible({
      timeout: scaled(120_000),
    });
    let settled;
    await expect
      .poll(
        async () => {
          settled = await readDurable(paths, seeded);
          return [0, 1].every((slot) => {
            const id = liveBeforeSettle.idsBySlot[slot];
            return (
              settled.cards[id]?.status === 'completed' &&
              settled.cards[id]?.source === 'jsonl' &&
              settled.markersById[id]?.includes(finalMarker(slot)) &&
              (settled.childRowsById[id] ?? []).every(
                (child) => child.source === 'delegate-log',
              )
            );
          });
        },
        { timeout: scaled(120_000) },
      )
      .toBe(true);
    await waitForStorageQuiet(electronApp);
    const committed = await readCommittedDelegationRows(paths.transcriptPath);
    assertSettledDelegationTranscript({
      committed,
      durable: settled,
      live: liveBeforeSettle,
      runs: readDelegationRuns(userDataDir),
      seeded,
      slots: [0, 1],
      progressSteps: LIVE_PROGRESS_STEPS,
    });
    const parentPrompt = (turn) =>
      committed.parentRows.find((row) =>
        row.markers.includes(turnMarker(turn)),
      );
    const parentFinal = (turn) =>
      committed.parentRows.find((row) =>
        row.markers.includes(
          `STORAGE-PARENT-${turn === 1 ? 'DONE' : 'FINAL'}-${turn}`,
        ),
      );
    for (const turn of [1, 2]) {
      expect(
        parentPrompt(turn),
        `parent turn ${turn} prompt is committed`,
      ).toBeTruthy();
      expect(
        parentFinal(turn),
        `parent turn ${turn} final response is committed`,
      ).toBeTruthy();
      // The settled card stays inside its own turn. Its children are in the
      // delegate log (see assertSettledDelegationTranscript), not this JSONL.
      const card = committed.cards[liveBeforeSettle.idsBySlot[turn - 1]];
      expect(parentPrompt(turn).index).toBeLessThan(card.index);
      expect(card.index).toBeLessThan(parentFinal(turn).index);
    }
    expect(parentFinal(1).index).toBeLessThan(parentPrompt(2).index);
    await expect(
      panel.getByTestId('chat-transcript-loading-spinner'),
    ).toHaveCount(0, { timeout: scaled(120_000) });
    await assertNoLoadError();
  } finally {
    const cleanup = async (label, timeout, work) => {
      try {
        await withTimeout(label, timeout, work);
      } catch (error) {
        cleanupErrors.push(error);
        console.warn(`[live-delegate-paging teardown] ${String(error)}`);
      }
    };
    inference.releaseAll();
    fixture?.releaseChild();
    if (electronApp && pageGateInstalled)
      await cleanup('page gate release', 10_000, () =>
        releaseTranscriptPageGate(electronApp),
      );
    if (electronApp)
      await cleanup('close canopy', scaled(60_000), () =>
        closeCanopy(electronApp, userDataDir),
      );
    await cleanup('inference server close', 15_000, () => fixture?.close());
    await cleanup('demo cleanup', 10_000, () => cleanupDemoWorkspaces(demo));
    await cleanup('temporary data cleanup', 10_000, () => {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    });
  }
  expect(cleanupErrors, 'all paging fixture teardown steps succeeded').toEqual(
    [],
  );
});

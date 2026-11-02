// Phase 02e: six live delegates stream round-robin for a fixed nominal 60 s
// against a seeded ~50 MB canonical V2 transcript, with an active or settled
// parent. Setup and finalization are measured separately. The live window
// drains outstanding publication/storage once, after the paced release window.
// Read-only committed identities are sampled every 10 s without quiet waits.
// Structural checks are deferred until the report is saved.
// Measure-only mode records storage checks without enforcing them on older bundles.
// The Electron-main rename hook counts exact replacements of the target JSONL.
// Work counters are process-wide logical bytes by file class: `written.*` is
// summed once, `serialized.*` is never added, and copy-on-write prefix clones
// are not counted in `written.transcript`, so per-replacement full-file bytes
// are reported separately. Delegation events are `canopy_delegation`
// renderer-observed snapshots after the card publisher's cadence (2 s active /
// 10 s settled per run), i.e. published to canonical ingestion; `offered` names
// the pre-cadence main counter. Under D4 the card is committed to the parent
// JSONL only when its persisted projection changes, and child progress is
// appended to the run's delegate log; those logs are the persistence proof,
// and the 50 MB committed history must not change while delegates stream.
// The inode poller is a
// lower bound. The rate-limited `chat_transcript_full_rewrite` diagnostic is
// intentionally not used. This is code-only: Cowork parents are ineligible
// for managed delegation, so unlike provider-event-pressure.spec.mjs this
// cannot cover Cowork.
//
// Headless commands (strict mode requires zero committed JSONL replacements
// and enforces the write ceiling during the live window):
//   pnpm run test:electron:built provider-event-pressure-delegation.spec.mjs --reporter=line
//   CANOPY_E2E_ASSERT_ZERO_LIVE_REWRITES=1 pnpm run test:electron:built provider-event-pressure-delegation.spec.mjs --reporter=line
//   CANOPY_E2E_DELEGATION_MEASURE_ONLY=1 CANOPY_E2E_OUT_DIR=out-e2e-base pnpm run test:electron:built provider-event-pressure-delegation.spec.mjs --reporter=line

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect as baseExpect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { cleanupDemoWorkspaces } from './demoWorkspaces.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { createDelegationInference } from './delegationRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  TIMEOUT_SCALE,
  WORKLOAD,
  assertSettledDelegationTranscript,
  createWorkloadInference,
  foreignSlotMarkers,
  killIfAlive,
  expandDelegatedCard,
  finalMarker,
  installDelegationEventCollector,
  installTranscriptRewriteObserver,
  installTranscriptResetCollector,
  markDelegationEvents,
  openParentChat,
  parentMessage,
  progressMarker,
  readCommittedDelegationRows,
  readDelegatedCardDiagnostics,
  readDelegationEvents,
  readDelegationRuns,
  readDurableDelegationState,
  readTranscriptRewriteObserver,
  readTranscriptResetEvents,
  readTranscriptByteIdentity,
  resetWorkCounters,
  revealDelegatedCard,
  scaled,
  seedDelegationStorageWorkload,
  sendParentMessage,
  snapshotWorkCounters,
  startTranscriptIdentityPoller,
  stopTranscriptRewriteObserver,
  withTimeout,
  summarizeDelegationEvents,
  summarizeWorkCounterDelta,
  turnMarker,
  waitForStorageQuiet,
} from './delegationStorageWorkload.mjs';

const expect = baseExpect.configure({ timeout: scaled(15_000) });

test.skip(
  !['darwin', 'win32'].includes(process.platform),
  'Managed delegation requires the macOS or Windows confined file boundary.',
);

const STRICT_ZERO_LIVE_REWRITES =
  process.env.CANOPY_E2E_ASSERT_ZERO_LIVE_REWRITES === '1';
const MEASURE_ONLY = process.env.CANOPY_E2E_DELEGATION_MEASURE_ONLY === '1';
const WINDOW_MS = 60_000;
const SLOT_MS = 500;
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const VARIANTS = [
  {
    variant: 'active',
    turns: {
      1: { slots: [0, 1, 2], holdFinal: false },
      2: { slots: [3, 4, 5], holdFinal: true },
    },
    progressSteps: 20,
    // DELEGATION_CARD_ACTIVE_INTERVAL_MS: the parent turn stays active.
    cardIntervalMs: 2_000,
  },
  {
    variant: 'settled',
    turns: {
      1: { slots: [0, 1, 2, 3, 4, 5], holdFinal: false },
    },
    progressSteps: 20,
    // DELEGATION_CARD_SETTLED_INTERVAL_MS: the parent turn has settled.
    cardIntervalMs: 10_000,
  },
];

// The line reporter keeps body attachments in memory only, so the report is
// also written to the test's output directory for later comparison.
async function attachReport(testInfo, name, report) {
  const reportPath = testInfo.outputPath(name);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach(name, {
    path: reportPath,
    contentType: 'application/json',
  });
}

function renameDelta(from, to) {
  const fromSequence = from.events.at(-1)?.seq ?? 0;
  const toSequence = to.events.at(-1)?.seq ?? fromSequence;
  const rewriteEvents = to.events.filter(
    (event) => event.seq > fromSequence && event.seq <= toSequence,
  );
  const rewriteKinds = Object.fromEntries(
    rewriteEvents.reduce((counts, event) => {
      counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
      return counts;
    }, new Map()),
  );
  const otherRenames = {};
  for (const renameClass of new Set([
    ...Object.keys(from.otherRenames ?? {}),
    ...Object.keys(to.otherRenames ?? {}),
  ])) {
    const delta =
      (to.otherRenames?.[renameClass] ?? 0) -
      (from.otherRenames?.[renameClass] ?? 0);
    if (delta !== 0) otherRenames[renameClass] = delta;
  }
  return {
    targetRewrites: to.targetReplacements - from.targetReplacements,
    rewriteEvents,
    replacedBytes: rewriteEvents.reduce((sum, event) => sum + event.bytes, 0),
    rewriteKinds,
    otherRenames,
  };
}

function phaseReport({
  fromLabel,
  toLabel,
  fromCounters,
  toCounters,
  fromRewrites,
  toRewrites,
  fromPoller,
  toPoller,
  fromCommitted,
  toCommitted,
  events,
  durationMs,
}) {
  const renames = renameDelta(fromRewrites, toRewrites);
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...renames,
    inodeChanged: fromCommitted.ino !== toCommitted.ino,
    pollerTransitions: toPoller.transitions - fromPoller.transitions,
    workCounters: summarizeWorkCounterDelta(fromCounters, toCounters),
    delegationEvents: summarizeDelegationEvents(events, fromLabel, toLabel),
    committedStart: {
      sizeBytes: fromCommitted.sizeBytes,
      sha256: fromCommitted.sha256,
    },
    committedEnd: {
      sizeBytes: toCommitted.sizeBytes,
      sha256: toCommitted.sha256,
    },
  };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    samples: sorted.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? null,
  };
}

function measurement(phase, { finalization = false } = {}) {
  const { writtenBytes, commits, provider } = phase.workCounters;
  const snapshots = provider.delegationSnapshots;
  const admittedBytes = snapshots.admitted.bytes;
  const rendererEventBytes = phase.delegationEvents.bytes;
  const ceiling =
    finalization || admittedBytes === null
      ? null
      : 16 * admittedBytes + 65_536 * commits;
  const cardSnapshotBytes = Object.values(
    phase.delegationEvents.byDelegation,
  ).reduce((sum, run) => sum + run.snapshotBytes, 0);
  return {
    E: {
      admittedBytes,
      admittedCount: snapshots.admitted.count,
      publishedBytes: snapshots.published.bytes,
      publishedCount: snapshots.published.count,
      offeredBytes: snapshots.offered.bytes,
      offeredCount: snapshots.offered.count,
      rendererEventBytes,
      rendererEventCount: phase.delegationEvents.events,
    },
    W: {
      total: writtenBytes.total,
      byClass: writtenBytes,
      perAdmittedByte:
        !finalization && admittedBytes > 0
          ? writtenBytes.total / admittedBytes
          : null,
      perRendererByte:
        !finalization && rendererEventBytes > 0
          ? writtenBytes.total / rendererEventBytes
          : null,
      perMinute: (writtenBytes.total * 60_000) / phase.durationMs,
      committedBytesWritten: writtenBytes.transcript,
      commits,
      ceiling,
      withinCeiling: ceiling === null ? null : writtenBytes.total <= ceiling,
      ceilingAppliesTo: 'live window only',
    },
    sidecar: {
      aggregateWrittenBytes: writtenBytes.activeSidecar,
      cardSnapshotBytes,
      amplification:
        cardSnapshotBytes > 0
          ? writtenBytes.activeSidecar / cardSnapshotBytes
          : null,
      byDelegation: Object.fromEntries(
        Object.entries(phase.delegationEvents.byDelegation).map(([id, run]) => [
          id,
          run.snapshotBytes,
        ]),
      ),
    },
  };
}

function cadenceAndFreshness(eventRead, idsBySlot, releases) {
  const start = eventRead.marks.windowStart;
  const end = eventRead.marks.windowEnd;
  const windowEvents = eventRead.entries.slice(start, end);
  const byRun = {};
  for (const [slot, id] of Object.entries(idsBySlot)) {
    const all = eventRead.entries.filter((event) => event.delegationId === id);
    const firstAppearance = all[0] ?? null;
    const statusChanges = [];
    const intervals = [];
    const boundaryIntervals = [];
    for (let index = 1; index < all.length; index += 1) {
      const previous = all[index - 1];
      const current = all[index];
      if (current.index < start || current.index >= end) continue;
      const spacingMs = current.at - previous.at;
      if (previous.index < start)
        boundaryIntervals.push({ at: current.at, spacingMs });
      else if (current.status !== previous.status)
        statusChanges.push({
          at: current.at,
          from: previous.status,
          to: current.status,
          spacingMs,
        });
      else
        intervals.push({
          at: current.at,
          spacingMs,
          sequence: current.sequence,
        });
    }
    byRun[slot] = {
      delegationId: id,
      firstAppearance,
      statusChanges,
      boundaryIntervals,
      steadyPublishedSpacing: {
        ...distribution(intervals.map((entry) => entry.spacingMs)),
        intervals,
      },
    };
  }
  const observations = releases.map((release) => {
    const event = windowEvents.find(
      (event) =>
        event.delegationId === idsBySlot[release.slot] &&
        event.at >= release.actualAt &&
        event.markers.includes(progressMarker(release.slot, release.step)),
    );
    return {
      ...release,
      firstEventAt: event?.at ?? null,
      latencyMs: event ? event.at - release.actualAt : null,
    };
  });
  return {
    cadence: byRun,
    freshness: {
      ...distribution(
        observations
          .filter((entry) => entry.latencyMs !== null)
          .map((entry) => entry.latencyMs),
      ),
      missingMarkers: observations.filter((entry) => entry.latencyMs === null)
        .length,
      observations,
    },
  };
}

// The code under test is the bundle, which may be built from another checkout
// (`CANOPY_E2E_OUT_DIR=out-e2e-base`). Record the bundle and when it was built
// next to this checkout's commit; never fail a run for missing build metadata.
function buildIdentity() {
  const bundleDirectory = process.env.CANOPY_E2E_OUT_DIR ?? 'out-e2e';
  let bundleBuiltAt = null;
  try {
    bundleBuiltAt = statSync(
      path.resolve(bundleDirectory, 'main', 'index.js'),
    ).mtime.toISOString();
  } catch {
    // An unreadable bundle fails the launch itself, with a clearer error.
  }
  let checkoutCommit = null;
  try {
    checkoutCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    // No git on PATH: the bundle identity above still names the build.
  }
  return { bundleDirectory, bundleBuiltAt, checkoutCommit };
}

function committedProjection(rows) {
  return JSON.stringify({ cards: rows.cards, children: rows.children });
}

function slotIdsFromTurns(turns) {
  return Object.values(turns).flatMap(({ slots }) => slots);
}

function liveSnapshotSummary(slots, idsBySlot, durable) {
  return slots.map((slot) => {
    const delegationId = idsBySlot[slot];
    const card = durable.cards[delegationId];
    return {
      slot,
      delegationId,
      rowId: card?.rowId ?? null,
      sequence: card?.sequence ?? null,
      status: card?.status ?? null,
      source: card?.source ?? null,
      transcriptStore: card?.transcriptStore ?? null,
      loggedSequence: loggedSequence(durable, delegationId),
      children: (durable.childRowsById[delegationId] ?? []).map((child) => ({
        rowId: child.rowId,
        sequence: child.sequence,
        source: child.source,
      })),
    };
  });
}

// D4: a live card is committed to the parent JSONL once and names the
// delegate log (`chat-log-v1`); its children are appended only to that log.
function checkLiveRowsInDelegateLog({
  slots,
  idsBySlot,
  durable,
  committed,
  label,
}) {
  const committedIds = new Set([...committed.rowIds]);
  const proof = [];
  const failures = [];
  for (const slot of slots) {
    try {
      const delegationId = idsBySlot[slot];
      const card = durable.cards[delegationId];
      expect(
        card,
        `${label}: slot ${slot} has a durable live card`,
      ).toBeTruthy();
      expect(
        card.source,
        `${label}: slot ${slot} live card is committed to the parent JSONL`,
      ).toBe('jsonl');
      expect(
        card.transcriptStore,
        `${label}: slot ${slot} live card names its delegate log`,
      ).toBe('chat-log-v1');
      expect(
        committed.cards[delegationId]?.id,
        `${label}: slot ${slot} live card row is committed`,
      ).toBe(card.rowId);
      expect(
        committed.cardOccurrencesByDelegation[delegationId],
        `${label}: slot ${slot} live card is committed exactly once`,
      ).toBe(1);

      const childRows = durable.childRowsById[delegationId] ?? [];
      expect(
        committed.children.filter(
          (child) => child.parentBlockId === card.agentBlockId,
        ),
        `${label}: slot ${slot} has no committed live child rows`,
      ).toEqual([]);
      for (const [childIndex, child] of childRows.entries()) {
        expect(
          child.source,
          `${label}: child ${child.rowId} is in the delegate log`,
        ).toBe('delegate-log');
        expect(
          committedIds.has(child.rowId),
          `${label}: child ${child.rowId} is absent from committed JSONL`,
        ).toBe(false);
        expect(child.parentBlockId).toBe(card.agentBlockId);
        if (childIndex > 0)
          expect(
            child.sequence,
            `${label}: child ${child.rowId} follows the prior item in delegation-sequence order`,
          ).toBeGreaterThan(childRows[childIndex - 1].sequence);
      }
      proof.push({
        slot,
        delegationId,
        cardRowId: card.rowId,
        cardSequence: card.sequence,
        logPath: card.logPath ?? null,
        childRowIds: childRows.map((child) => child.rowId),
      });
    } catch (error) {
      failures.push({ slot, message: String(error) });
    }
  }
  return { proof, failures, passed: failures.length === 0 };
}

/** The newest logged item's sequence: a run's durable progress under D4. */
function loggedSequence(durable, delegationId) {
  return (durable.childRowsById[delegationId] ?? []).at(-1)?.sequence ?? null;
}

function buildProof({
  slots,
  idsBySlot,
  durableAtStart,
  progressSnapshots,
  durableAtEnd,
  committedAtStart,
  committedAtEnd,
}) {
  const committedBytesUnchangedInWindow =
    committedAtStart.sizeBytes === committedAtEnd.sizeBytes &&
    committedAtStart.sha256 === committedAtEnd.sha256;
  return {
    activeSnapshotsAtWindowStart: liveSnapshotSummary(
      slots,
      idsBySlot,
      durableAtStart,
    ),
    activeSnapshotsAtCheckpoints: progressSnapshots.map((snapshot) =>
      liveSnapshotSummary(slots, idsBySlot, snapshot),
    ),
    activeSnapshotsAtWindowEnd: liveSnapshotSummary(
      slots,
      idsBySlot,
      durableAtEnd,
    ),
    committedBytesUnchangedInWindow,
    committedProjectionUnchangedInWindow:
      committedProjection(committedAtStart) ===
      committedProjection(committedAtEnd),
  };
}

function assertNoInferenceErrors(fixture, inference, phase) {
  const errors = [
    ...(fixture?.errors ?? []),
    ...(inference.snapshot().errors ?? []),
  ];
  if (errors.length > 0) {
    throw new Error(
      `Delegation inference failed during ${phase}: ${JSON.stringify(errors)}`,
    );
  }
}

async function runWorkload(
  { variant, turns, progressSteps, cardIntervalMs },
  testInfo,
) {
  const slots = slotIdsFromTurns(turns).sort((left, right) => left - right);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `delegation-storage-${variant}-`),
  );
  const inference = createWorkloadInference({ turns, progressSteps });
  let fixture;
  let demo;
  let electronApp;
  let poller;
  let electronPid;
  let readDurable;
  let assertionsCompleted = false;
  let reportAttached = false;
  const report = {
    variant,
    platform: process.platform,
    slots,
    progressSteps,
    turns,
    seeded: null,
    transcriptBytes: {},
    window: null,
    setup: null,
    finalization: null,
    proof: null,
    timeoutScale: TIMEOUT_SCALE,
    measureOnly: MEASURE_ONLY,
    build: buildIdentity(),
  };
  const counters = {};
  const rewrites = {};
  const pollerReads = {};
  const committed = {};
  const phaseTimes = {};

  testInfo.annotations.push({
    type: 'strict-zero-live-rewrites',
    description: String(STRICT_ZERO_LIVE_REWRITES),
  });

  try {
    fixture = await createDelegationInference({
      parent: 'codex',
      child: 'claude',
      mode: 'background',
      caseId: `storage-${variant}`,
      script: inference.script,
    });
    const seededWorkload = await seedDelegationStorageWorkload({
      userDataDir,
      fixture,
      progressSteps,
    });
    const { paths, seeded } = seededWorkload;
    demo = seededWorkload.demo;
    report.seeded = seeded;
    const seededStatBytes = statSync(paths.transcriptPath).size;
    expect(
      seeded.committedBytes,
      'seeded committed JSONL bytes only (not sidecar or artifacts)',
    ).toBeGreaterThanOrEqual(WORKLOAD.minTranscriptBytes);
    expect(
      seeded.committedBytes,
      'seeded committed JSONL bytes only (not sidecar or artifacts)',
    ).toBeLessThanOrEqual(WORKLOAD.maxTranscriptBytes);
    expect(
      seededStatBytes,
      'the canonical committed transcript JSONL is in the expected range; sidecars and artifacts are excluded',
    ).toBeGreaterThanOrEqual(WORKLOAD.minTranscriptBytes);
    expect(
      seededStatBytes,
      'the canonical committed transcript JSONL is in the expected range; sidecars and artifacts are excluded',
    ).toBeLessThanOrEqual(WORKLOAD.maxTranscriptBytes);
    expect(seededStatBytes).toBe(seeded.committedBytes);
    report.transcriptBytes.seeded = seededStatBytes;
    // Durable delegate rows (cards in committed JSONL after the seeded prefix,
    // children in each run's delegate log): what chat state projects for the UI.
    readDurable = () =>
      readDurableDelegationState(paths, {
        prefixBytes: seeded.committedBytes,
        lastMessageId: seeded.lastMessageId,
      });

    const launched = await launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
    });
    electronApp = launched.electronApp;
    electronPid = electronApp.process()?.pid;

    const { window, panel } = await openParentChat(electronApp);
    await installDelegationEventCollector(window, { chatId: WORKLOAD.chatId });
    await installTranscriptResetCollector(window, { chatId: WORKLOAD.chatId });
    await installTranscriptRewriteObserver(electronApp, paths.transcriptPath);
    poller = startTranscriptIdentityPoller(paths.transcriptPath, {
      intervalMs: 100,
    });
    await waitForStorageQuiet(electronApp);

    // Setup starts after the initial chat load is quiescent. It contains the
    // parent turns needed to create the live runs before measurement.
    phaseTimes.setupStart = Date.now();
    counters.setupStart = await resetWorkCounters(electronApp);
    rewrites.setupStart = await readTranscriptRewriteObserver(electronApp);
    pollerReads.setupStart = poller.read();
    await markDelegationEvents(window, 'setupStart');
    committed.setupStart = await readCommittedDelegationRows(
      paths.transcriptPath,
    );

    const composerRoot = panel.locator('[data-chat-composer-root]');
    for (const turn of Object.keys(turns)
      .map(Number)
      .sort((left, right) => left - right)) {
      const turnPlan = turns[turn];
      const message = parentMessage(fixture, turn, turnPlan.slots);
      expect(message).toContain(turnMarker(turn));
      await sendParentMessage(window, message);
      await expect
        .poll(
          () => {
            assertNoInferenceErrors(fixture, inference, `turn ${turn} setup`);
            return (
              inference.parentSpawned(turn) &&
              turnPlan.slots.every((slot) =>
                inference.childStepRequested(slot, 0),
              )
            );
          },
          { timeout: scaled(120_000) },
        )
        .toBe(true);

      if (turnPlan.holdFinal) {
        await expect
          .poll(
            () => {
              assertNoInferenceErrors(
                fixture,
                inference,
                `turn ${turn} parent hold`,
              );
              return inference.parentFinalRequested(turn);
            },
            { timeout: scaled(120_000) },
          )
          .toBe(true);
      } else {
        await expect(composerIdleAction(composerRoot)).toBeVisible({
          timeout: scaled(120_000),
        });
      }

      await expect
        .poll(
          async () => {
            assertNoInferenceErrors(
              fixture,
              inference,
              `turn ${turn} snapshots`,
            );
            const { idsBySlot: ids } = await readDurable();
            return turnPlan.slots.every((slot) => Boolean(ids[slot]));
          },
          { timeout: scaled(120_000) },
        )
        .toBe(true);
    }

    // Live-UI precondition, checked before the window opens so that revealing
    // collapsed turns is not attributed to the measured window. Slot ids come
    // from the durable card rows (their prompts carry the slot marker).
    const { idsBySlot } = await readDurable();
    report.idsBySlot = idsBySlot;

    // The shared mock (delegationRuntime.mjs) registers each Claude reply
    // under the child marker every delegate shares, then reads the request
    // body before looking the reply up. Delegates answered concurrently can
    // therefore receive each other's replies (the first run showed every
    // delegate committing slot 3's text). Release one delegate's step, wait
    // until it has consumed that reply, then release the next.
    // A snapshot reaches storage at most once per run per card interval, so
    // allow three intervals plus provider and storage latency.
    const publishTimeoutMs = scaled(
      Math.max(120_000, cardIntervalMs * 3 + 30_000),
    );
    const waitForDurableMarkers = async (markerFor, label, options = {}) => {
      let last;
      await expect
        .poll(
          async () => {
            assertNoInferenceErrors(fixture, inference, label);
            last = await readDurable();
            const foreign = foreignSlotMarkers(last.markersById, idsBySlot);
            if (Object.keys(foreign).length)
              throw new Error(
                `Delegates received another slot's mock reply (${label}): ${JSON.stringify(foreign)}`,
              );
            return slots.every((slot) => {
              const id = idsBySlot[slot];
              return (
                last.markersById[id]?.includes(markerFor(slot)) &&
                (last.childRowsById[id] ?? []).some((child) =>
                  child.markers.includes(markerFor(slot)),
                ) &&
                (options.status === undefined ||
                  last.cards[id]?.status === options.status)
              );
            });
          },
          {
            timeout: publishTimeoutMs,
            message: `durable delegate rows reached ${label}`,
          },
        )
        .toBe(true);
      return last;
    };
    expect(
      slots.every((slot) => Boolean(idsBySlot[slot])),
      'each planned slot has a parent-chat delegation id before the live window',
    ).toBe(true);
    expect(new Set(slots.map((slot) => idsBySlot[slot])).size).toBe(
      slots.length,
    );
    for (const slot of slots) {
      const card = await revealDelegatedCard(panel, idsBySlot[slot]);
      await expect(card).toBeVisible();
      await expect
        .poll(() =>
          card
            .locator('[data-step-row-words].canopy-text-shimmer-strong')
            .count(),
        )
        .toBeGreaterThan(0);
    }

    await waitForStorageQuiet(electronApp);

    // The live window begins only after every setup turn has settled or reached
    // its explicit parent hold, and after all setup persistence is quiet.
    counters.windowStart = await snapshotWorkCounters(electronApp);
    rewrites.windowStart = await readTranscriptRewriteObserver(electronApp);
    pollerReads.windowStart = poller.read();
    await markDelegationEvents(window, 'windowStart');
    const committedAtStart = await readCommittedDelegationRows(
      paths.transcriptPath,
    );
    committed.windowStart = committedAtStart;
    const durableAtStart = await readDurable();
    const liveRowsAtWindowStart = checkLiveRowsInDelegateLog({
      slots,
      idsBySlot,
      durable: durableAtStart,
      committed: committedAtStart,
      label: 'window start',
    });
    const progressSnapshots = [];
    const committedProgressSnapshots = [];
    const durableSequences = {};
    report.transcriptBytes.windowStart = committedAtStart.sizeBytes;
    const t0 = Date.now();
    phaseTimes.windowStart = t0;

    const resetEventsAtStart = await readTranscriptResetEvents(window);
    const releases = [];
    const stepsBySlot = Object.fromEntries(slots.map((slot) => [slot, 0]));
    const plannedReleases = WINDOW_MS / SLOT_MS;
    let checkpointError;
    // Independent read-only samples don't shift the release schedule. Keep
    // reads serialized as well, so slow disks cannot build an unbounded queue.
    const checkpointsDone = (async () => {
      for (let offsetMs = 10_000; offsetMs < WINDOW_MS; offsetMs += 10_000) {
        const nominalAt = t0 + offsetMs;
        await sleep(nominalAt - Date.now());
        if (Date.now() >= t0 + WINDOW_MS) break;
        const sampledAt = Date.now();
        const identity = await readTranscriptByteIdentity(paths.transcriptPath);
        committedProgressSnapshots.push({
          nominalAt,
          at: sampledAt,
          readFinishedAt: Date.now(),
          ...identity,
        });
        const snapshot = await readDurable();
        progressSnapshots.push(snapshot);
        for (const slot of slots) {
          const id = idsBySlot[slot];
          (durableSequences[id] ??= []).push(loggedSequence(snapshot, id));
        }
      }
    })().catch((error) => {
      checkpointError = error;
    });
    // Slots are fixed wall-clock targets, never shifted by consumption. No
    // overlapping mock replies, and no quiet wait or publication wait per step.
    for (let index = 0; index < plannedReleases; index += 1) {
      const nominalAt = t0 + index * SLOT_MS;
      await sleep(nominalAt - Date.now());
      if (Date.now() >= t0 + WINDOW_MS) break;
      const slot = slots[index % slots.length];
      const step = stepsBySlot[slot];
      const actualAt = Date.now();
      releases.push({
        index,
        slot,
        step,
        nominalAt,
        actualAt,
        lateMs: actualAt - nominalAt,
      });
      inference.releaseChildStep(step, [slot]);
      await expect
        .poll(
          () => {
            assertNoInferenceErrors(
              fixture,
              inference,
              `paced slot ${slot} step ${step}`,
            );
            return inference.childStepRequested(slot, step + 1);
          },
          { timeout: scaled(120_000), intervals: [50, 100, 250] },
        )
        .toBe(true);
      releases.at(-1).consumedAt = Date.now();
      stepsBySlot[slot] += 1;
    }
    await sleep(t0 + WINDOW_MS - Date.now());
    const releaseWindowEnd = Date.now();
    await checkpointsDone;
    if (checkpointError) throw checkpointError;
    if (slots.some((slot) => stepsBySlot[slot] === 0))
      throw new Error(
        `The live window did not stream all six delegates: ${JSON.stringify(stepsBySlot)}`,
      );
    // Flush the final cadence-delayed progress once, then wait for storage once.
    await waitForDurableMarkers(
      (slot) => progressMarker(slot, stepsBySlot[slot] - 1),
      'paced window progress',
    );
    await waitForStorageQuiet(electronApp);

    // The window ends once every progress snapshot was delivered and storage
    // is quiet, before any final child step or held parent reply is released.
    counters.windowEnd = await snapshotWorkCounters(electronApp);
    rewrites.windowEnd = await readTranscriptRewriteObserver(electronApp);
    pollerReads.windowEnd = poller.read();
    await markDelegationEvents(window, 'windowEnd');
    const committedAtEnd = await readCommittedDelegationRows(
      paths.transcriptPath,
    );
    committed.windowEnd = committedAtEnd;
    const durableAtEnd = await readDurable();
    const liveRowsAtWindowEnd = checkLiveRowsInDelegateLog({
      slots,
      idsBySlot,
      durable: durableAtEnd,
      committed: committedAtEnd,
      label: 'window end',
    });
    report.transcriptBytes.windowEnd = committedAtEnd.sizeBytes;
    const t1 = Date.now();
    phaseTimes.windowEnd = t1;

    const resetEventsAtEnd = await readTranscriptResetEvents(window);
    const liveEventRead = await readDelegationEvents(window);
    const setupReport = phaseReport({
      fromLabel: 'setupStart',
      toLabel: 'windowStart',
      fromCounters: counters.setupStart,
      toCounters: counters.windowStart,
      fromRewrites: rewrites.setupStart,
      toRewrites: rewrites.windowStart,
      fromPoller: pollerReads.setupStart,
      toPoller: pollerReads.windowStart,
      fromCommitted: committed.setupStart,
      toCommitted: committed.windowStart,
      events: liveEventRead,
      durationMs: phaseTimes.windowStart - phaseTimes.setupStart,
    });
    const windowReport = phaseReport({
      fromLabel: 'windowStart',
      toLabel: 'windowEnd',
      fromCounters: counters.windowStart,
      toCounters: counters.windowEnd,
      fromRewrites: rewrites.windowStart,
      toRewrites: rewrites.windowEnd,
      fromPoller: pollerReads.windowStart,
      toPoller: pollerReads.windowEnd,
      fromCommitted: committed.windowStart,
      toCommitted: committed.windowEnd,
      events: liveEventRead,
      durationMs: t1 - t0,
    });
    const proof = buildProof({
      slots,
      idsBySlot,
      durableAtStart,
      progressSnapshots,
      durableAtEnd,
      committedAtStart,
      committedAtEnd,
    });
    report.durable = {
      windowStart: durableAtStart.cards,
      windowEnd: durableAtEnd.cards,
      sequencesAtCheckpoints: durableSequences,
      liveRowsAtWindowStart,
      committedProgressSnapshots,
    };
    for (const phase of [setupReport, windowReport])
      Object.assign(phase, measurement(phase));
    Object.assign(
      windowReport,
      cadenceAndFreshness(liveEventRead, idsBySlot, releases),
    );
    windowReport.rendererReloads = {
      transcriptResets: resetEventsAtEnd.slice(resetEventsAtStart.length),
      resetCount: resetEventsAtEnd.length - resetEventsAtStart.length,
      transcriptPageRequests:
        windowReport.workCounters.ipc.transcriptPageRequests,
    };
    windowReport.pacing = {
      slotMs: SLOT_MS,
      nominalWindowMs: WINDOW_MS,
      plannedReleases,
      actualReleases: releases.length,
      lateReleases: releases.filter((release) => release.lateMs > SLOT_MS)
        .length,
      missedSlotsDefinition:
        'nominal slots released at least one slot late, plus slots never released before the deadline',
      missedSlots:
        releases.filter((release) => release.lateMs >= SLOT_MS).length +
        plannedReleases -
        releases.length,
      unreleasedSlots: plannedReleases - releases.length,
      actualReleaseWindowMs: releaseWindowEnd - t0,
      actualWindowDurationMs: t1 - t0,
      stepsBySlot,
      releases,
    };
    windowReport.checks = {
      committedUnchanged:
        proof.committedBytesUnchangedInWindow &&
        committedProgressSnapshots.every(
          (checkpoint) =>
            checkpoint.sizeBytes === committedAtStart.sizeBytes &&
            checkpoint.sha256 === committedAtStart.sha256,
        ),
      liveRowsInDelegateLog:
        liveRowsAtWindowStart.passed && liveRowsAtWindowEnd.passed,
      // Progress never moves a committed card, and the delegate log only
      // grows: every logged item stays at its sequence in later snapshots.
      cardsFrozen: slots.every((slot) => {
        const id = idsBySlot[slot];
        const rowId = durableAtStart.cards[id]?.rowId;
        const snapshots = [durableAtStart, ...progressSnapshots, durableAtEnd];
        return (
          Boolean(rowId) &&
          snapshots.every(
            (snapshot, index) =>
              snapshot.cards[id]?.rowId === rowId &&
              (snapshots[index - 1]?.childRowsById[id] ?? []).every(
                (child) =>
                  snapshot.childRowsById[id]?.find(
                    (row) => row.rowId === child.rowId,
                  )?.sequence === child.sequence,
              ),
          )
        );
      }),
      zeroReplacements: windowReport.targetRewrites === 0,
      withinCeiling: windowReport.W.withinCeiling,
    };
    windowReport.structuralFailures = {
      start: liveRowsAtWindowStart.failures,
      end: liveRowsAtWindowEnd.failures,
    };
    report.setup = setupReport;
    report.window = windowReport;
    report.proof = proof;
    await attachReport(testInfo, `delegation-storage-${variant}.json`, report);
    reportAttached = true;

    // UI checks remain outside the measured window. Defer their failures too
    // so finalization numbers are saved before assertions are enforced.
    report.liveUiFailures = [];
    // Every running card, including the pinned Agent activity copy of a run
    // from an older finished turn, shows its newest progress (02f keeps live
    // runs' recent child rows in turn pages).
    for (const slot of slots) {
      try {
        const card = await revealDelegatedCard(panel, idsBySlot[slot]);
        await expandDelegatedCard(card);
        await expect(card).toContainText(
          progressMarker(slot, stepsBySlot[slot] - 1),
          { timeout: scaled(30_000) },
        );
        await expect
          .poll(() =>
            card
              .locator('[data-step-row-words].canopy-text-shimmer-strong')
              .count(),
          )
          .toBeGreaterThan(0);
        await expect(card.getByTestId('delegated-agent-status')).toHaveCount(0);
      } catch (error) {
        const diagnostics = await readDelegatedCardDiagnostics(
          panel,
          idsBySlot[slot],
          progressMarker(slot, stepsBySlot[slot] - 1),
        ).catch((diagnosticsError) => ({
          cardCount: null,
          cards: [],
          diagnosticsError: String(diagnosticsError),
        }));
        report.liveUiFailures.push({
          slot,
          delegationId: idsBySlot[slot],
          message: String(error),
          ...diagnostics,
        });
      }
    }
    const finalizationByRun = [];

    // Final materialization is deliberately outside the measured live window.
    // Final replies are serialized too; each waits for its run to complete.
    const runCompleted = (slot) =>
      readDelegationRuns(userDataDir).some(
        (run) =>
          run.state.delegationId === idsBySlot[slot] &&
          run.state.status === 'completed',
      );
    // Attribute each settlement where possible; storage can batch adjacent
    // updates, so these process-wide deltas are intervals, not exclusive costs.
    for (const slot of slots) {
      const before = await readTranscriptByteIdentity(paths.transcriptPath);
      const beforeCounters = await snapshotWorkCounters(electronApp);
      const beforeRewrites = await readTranscriptRewriteObserver(electronApp);
      inference.finishChild(slot);
      await expect
        .poll(() => runCompleted(slot), { timeout: scaled(120_000) })
        .toBe(true);
      await expect
        .poll(
          async () => (await readDurable()).cards[idsBySlot[slot]]?.status,
          { timeout: publishTimeoutMs },
        )
        .toBe('completed');
      await waitForStorageQuiet(electronApp);
      const prefix = await readTranscriptByteIdentity(
        paths.transcriptPath,
        before.sizeBytes,
      );
      const afterCounters = await snapshotWorkCounters(electronApp);
      const renames = renameDelta(
        beforeRewrites,
        await readTranscriptRewriteObserver(electronApp),
      );
      finalizationByRun.push({
        slot,
        delegationId: idsBySlot[slot],
        ...renames,
        oldSizeBytes: before.sizeBytes,
        newSizeBytes: prefix.sizeBytes,
        oldBytesArePrefix: prefix.sha256 === before.sha256,
        writeShape:
          renames.targetRewrites > 0
            ? 'positioned replacement'
            : prefix.sizeBytes > before.sizeBytes &&
                prefix.sha256 === before.sha256
              ? 'append'
              : 'deferred or unchanged',
        workCounters: summarizeWorkCounterDelta(beforeCounters, afterCounters),
      });
    }
    const beforeParentCounters = await snapshotWorkCounters(electronApp);
    const beforeParentRewrites =
      await readTranscriptRewriteObserver(electronApp);
    for (const [turn, turnPlan] of Object.entries(turns)) {
      if (turnPlan.holdFinal) inference.releaseParentFinal(Number(turn));
    }
    await waitForDurableMarkers((slot) => finalMarker(slot), 'final', {
      status: 'completed',
    });
    await expect(composerIdleAction(composerRoot)).toBeVisible({
      timeout: scaled(120_000),
    });
    await waitForStorageQuiet(electronApp);

    const committedAtFinalEnd = await readCommittedDelegationRows(
      paths.transcriptPath,
    );
    counters.finalEnd = await snapshotWorkCounters(electronApp);
    rewrites.finalEnd = await readTranscriptRewriteObserver(electronApp);
    pollerReads.finalEnd = poller.read();
    await markDelegationEvents(window, 'finalEnd');
    phaseTimes.finalEnd = Date.now();

    const eventRead = await readDelegationEvents(window);
    const finalizationReport = phaseReport({
      fromLabel: 'windowEnd',
      toLabel: 'finalEnd',
      fromCounters: counters.windowEnd,
      toCounters: counters.finalEnd,
      fromRewrites: rewrites.windowEnd,
      toRewrites: rewrites.finalEnd,
      fromPoller: pollerReads.windowEnd,
      toPoller: pollerReads.finalEnd,
      fromCommitted: committed.windowEnd,
      toCommitted: committedAtFinalEnd,
      events: eventRead,
      durationMs: phaseTimes.finalEnd - phaseTimes.windowEnd,
    });
    // Settlement materializes committed history; live-window W/E limits do
    // not describe that work. Keep raw counters but omit ratios and ceiling.
    Object.assign(
      finalizationReport,
      measurement(finalizationReport, { finalization: true }),
    );
    finalizationReport.byRun = finalizationByRun;
    finalizationReport.parentWrites = {
      settlementInterval: {
        ...renameDelta(beforeParentRewrites, rewrites.finalEnd),
        workCounters: summarizeWorkCounterDelta(
          beforeParentCounters,
          counters.finalEnd,
        ),
      },
      heldFinalTurns: Object.entries(turns)
        .filter(([, plan]) => plan.holdFinal)
        .map(([turn]) => Number(turn)),
      rows: committedAtFinalEnd.parentRows.filter(
        (row) => !committedAtEnd.rowIds.includes(row.id),
      ),
      note: 'Totals include parent writes; per-run intervals may batch parent/other-run writes. Held parent settlement may materialize placement-deferred runs.',
    };
    report.setup = setupReport;
    report.window = windowReport;
    report.finalization = finalizationReport;
    report.proof = proof;
    await attachReport(testInfo, `delegation-storage-${variant}.json`, report);
    reportAttached = true;
    console.log(
      JSON.stringify({
        variant,
        build: report.build,
        windowSummary: {
          E: windowReport.E,
          W: windowReport.W,
          targetRewrites: windowReport.targetRewrites,
          replacedBytes: windowReport.replacedBytes,
          cadence: Object.fromEntries(
            Object.entries(windowReport.cadence).map(([slot, run]) => [
              slot,
              run.steadyPublishedSpacing,
            ]),
          ),
          freshness: { ...windowReport.freshness, observations: undefined },
          rendererReloads: windowReport.rendererReloads,
          pacing: { ...windowReport.pacing, releases: undefined },
          checks: windowReport.checks,
        },
      }),
    );

    if (!MEASURE_ONLY) {
      for (const key of [
        'committedUnchanged',
        'liveRowsInDelegateLog',
        'cardsFrozen',
      ])
        expect(windowReport.checks[key], `live window ${key}`).toBe(true);
      if (STRICT_ZERO_LIVE_REWRITES) {
        expect(
          windowReport.E.admittedBytes,
          'admitted byte counter must exist',
        ).not.toBeNull();
        expect(
          windowReport.checks.withinCeiling,
          'W <= 16 * admittedBytes + 65_536 * commits',
        ).toBe(true);
        expect(
          windowReport.checks.zeroReplacements,
          'zero committed live replacements',
        ).toBe(true);
      }
    }
    expect(
      report.liveUiFailures,
      'live progress remained visible on running cards',
    ).toEqual([]);
    const finalRuns = readDelegationRuns(userDataDir);
    const durableFinal = await readDurable();
    for (const slot of slots) {
      const id = idsBySlot[slot];
      expect(id, `slot ${slot} was spawned`).toBeTruthy();
      const markers = durableFinal.markersById[id] ?? [];
      const expectedProgress = Array.from(
        { length: stepsBySlot[slot] },
        (_, step) => progressMarker(slot, step),
      );
      expect(
        new Set(
          markers.filter((marker) => marker.startsWith('STORAGE-PROGRESS-')),
        ).size,
      ).toBeGreaterThanOrEqual(stepsBySlot[slot]);
      for (const marker of expectedProgress) expect(markers).toContain(marker);
      expect(markers).toContain(finalMarker(slot));
      expect(
        finalRuns.find((run) => run.state.delegationId === id)?.state.status,
      ).toBe('completed');
      expect(durableFinal.cards[id]?.status).toBe('completed');

      // Several progress batches per delegate reached its delegate log during
      // the window: periodic read-only checkpoints and the closing read saw
      // the newest logged sequence advance.
      expect(
        new Set([
          ...(durableSequences[id] ?? []),
          loggedSequence(durableAtEnd, id),
        ]).size,
        `slot ${slot} stored several live snapshots in the window`,
      ).toBeGreaterThanOrEqual(2);
    }
    expect(
      foreignSlotMarkers(durableFinal.markersById, idsBySlot),
      'each delegate stored only its own scripted replies',
    ).toEqual({});

    for (const slot of slots) {
      const id = idsBySlot[slot];
      expect(
        loggedSequence(durableAtEnd, id),
        `slot ${slot} logged live progress advanced`,
      ).toBeGreaterThan(loggedSequence(durableAtStart, id) ?? -1);
      expect(
        liveEventRead.entries
          .slice(liveEventRead.marks.windowStart, liveEventRead.marks.windowEnd)
          .some(
            (event) =>
              event.delegationId === id &&
              event.markers.includes(
                progressMarker(slot, stepsBySlot[slot] - 1),
              ),
          ),
        `slot ${slot} renderer received live progress`,
      ).toBe(true);
    }

    // Observer health: a replaced committed log has a new inode, so the rename
    // hook must have seen it. `atomicReplacements` is reported only: the
    // shared-prefix (copy-on-write) replacement path does not record it, so
    // it undercounts target rewrites on today's code.
    if (committedAtStart.ino !== committedAtEnd.ino)
      expect(
        windowReport.targetRewrites,
        'the rename hook observed the committed transcript replacement',
      ).toBeGreaterThanOrEqual(1);

    if (committedAtEnd.ino !== committedAtFinalEnd.ino)
      expect(
        finalizationReport.targetRewrites,
        'the rename hook also observed final materialization replacements',
      ).toBeGreaterThanOrEqual(1);

    const committedAfterFinalization = await readCommittedDelegationRows(
      paths.transcriptPath,
    );
    if (!MEASURE_ONLY)
      assertSettledDelegationTranscript({
        committed: committedAfterFinalization,
        durable: durableFinal,
        live: durableAtEnd,
        runs: finalRuns,
        seeded,
        slots,
        progressSteps,
        progressStepsBySlot: stepsBySlot,
      });
    expect(committedAfterFinalization.sizeBytes).toBeGreaterThanOrEqual(
      WORKLOAD.minTranscriptBytes,
    );
    expect(committedAfterFinalization.sizeBytes).toBeLessThanOrEqual(
      WORKLOAD.maxTranscriptBytes + 5_000_000,
    );
    for (const slot of slots) {
      const id = idsBySlot[slot];
      const card = committedAfterFinalization.cards[id];
      expect(card, `slot ${slot} has a committed card row`).toBeTruthy();
      expect(
        committedAfterFinalization.cardOccurrencesByDelegation[id],
        `slot ${slot} materializes its card row exactly once`,
      ).toBe(1);
      expect(card.status).toBe('completed');
      expect(durableFinal.cards[id]?.source).toBe('jsonl');
      expect(durableFinal.cards[id]?.transcriptStore).toBe('chat-log-v1');
      // D4: settlement commits the card only; its children stay in the
      // run's delegate log and never enter the 50 MB parent transcript.
      expect(
        committedAfterFinalization.children.filter(
          (child) =>
            child.parentBlockId === durableFinal.cards[id]?.agentBlockId,
        ),
        `slot ${slot} commits no child rows to the parent transcript`,
      ).toEqual([]);
      const durableChildRows = durableFinal.childRowsById[id] ?? [];
      expect(durableChildRows.length).toBeGreaterThan(0);
      expect(
        durableChildRows.every((child) => child.source === 'delegate-log'),
        `slot ${slot} child rows are in its delegate log`,
      ).toBe(true);
      expect(
        new Set(durableChildRows.map((child) => child.rowId)).size,
        `slot ${slot} logs each child item once`,
      ).toBe(durableChildRows.length);
      for (let index = 1; index < durableChildRows.length; index += 1)
        expect(durableChildRows[index].sequence).toBeGreaterThan(
          durableChildRows[index - 1].sequence,
        );
      const flattenedMarkers = durableChildRows.flatMap(
        (child) => child.markers,
      );
      let priorMarkerIndex = -1;
      for (let step = 0; step < stepsBySlot[slot]; step += 1) {
        const markerIndex = flattenedMarkers.indexOf(
          progressMarker(slot, step),
        );
        expect(
          markerIndex,
          `logged child item contains progress step ${step}`,
        ).toBeGreaterThan(-1);
        expect(markerIndex).toBeGreaterThan(priorMarkerIndex);
        priorMarkerIndex = markerIndex;
      }
    }

    if (variant === 'active' && !MEASURE_ONLY) {
      const firstTurnCards = turns[1].slots.map(
        (slot) => committedAfterFinalization.cards[idsBySlot[slot]],
      );
      const secondTurnCards = turns[2].slots.map(
        (slot) => committedAfterFinalization.cards[idsBySlot[slot]],
      );
      for (const firstTurnCard of firstTurnCards) {
        for (const secondTurnCard of secondTurnCards)
          expect(firstTurnCard.index).toBeLessThan(secondTurnCard.index);
      }
    }

    for (const slot of slots) {
      const card = await revealDelegatedCard(panel, idsBySlot[slot]);
      await expect(
        card.locator('[data-step-row-words].canopy-text-shimmer-strong'),
      ).toHaveCount(0);
      // A completed run shows no header status (`delegatedAgentStatusLabel`).
      await expect(card.getByTestId('delegated-agent-status')).toHaveCount(0);
      await expect(async () => {
        await expandDelegatedCard(card);
        await card
          .getByRole('button', { name: 'Show result', exact: true })
          .click({ timeout: 2_000 });
      }).toPass({ timeout: scaled(30_000) });
      await expect(card).toContainText(finalMarker(slot));
    }

    await window.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = new CanopyAppDriver(window);
    await reloaded.waitForShell({ timeout: scaled(30_000) });
    await reloaded.openMainPage();
    await reloaded.selectWorktree(WORKLOAD.worktreeId);
    const reloadedPanel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(reloadedPanel).toBeVisible();
    for (const slot of slots) {
      const card = await revealDelegatedCard(reloadedPanel, idsBySlot[slot]);
      await expandDelegatedCard(card);
      const text = await card.innerText();
      const markerIndexes = Array.from(
        { length: stepsBySlot[slot] },
        (_, step) => text.indexOf(progressMarker(slot, step)),
      );
      expect(markerIndexes.every((index) => index >= 0)).toBe(true);
      for (let index = 1; index < markerIndexes.length; index += 1)
        expect(markerIndexes[index]).toBeGreaterThan(markerIndexes[index - 1]);
    }

    assertNoInferenceErrors(fixture, inference, 'finalization');
    assertionsCompleted = true;
  } finally {
    // Every step is bounded and isolated, so one stuck step cannot hang the
    // worker or skip the rest. After a failure, delegates may still be held
    // at a gate. Release them and let the tree settle (bounded) so the app
    // does not quit with half-finished turns, then make sure the Electron
    // process Playwright launched has exited: Playwright's worker teardown
    // waits for it, which is what timed out after the active variant failed.
    const settle = async (label, ms, work) => {
      try {
        await withTimeout(label, ms, work);
      } catch (error) {
        console.warn(`[delegation-storage teardown] ${String(error)}`);
      }
    };
    inference.releaseAll();
    fixture?.releaseChild();
    try {
      poller?.stop();
    } catch {
      // The poller is diagnostic only.
    }
    if (electronApp && !assertionsCompleted) {
      await settle('delegate drain', scaled(45_000), async () => {
        const ids = new Set(Object.values(report.idsBySlot ?? {}));
        const terminal = new Set([
          'completed',
          'failed',
          'cancelled',
          'deadline_exceeded',
        ]);
        await expect
          .poll(
            () =>
              readDelegationRuns(userDataDir)
                .filter(
                  (run) => ids.size === 0 || ids.has(run.state.delegationId),
                )
                .every((run) => terminal.has(run.state.status)),
            { timeout: scaled(40_000) },
          )
          .toBe(true);
      });
      await settle('storage drain', scaled(20_000), () =>
        waitForStorageQuiet(electronApp, { timeoutMs: scaled(15_000) }),
      );
    }
    if (electronApp)
      await settle('rewrite observer stop', 10_000, () =>
        stopTranscriptRewriteObserver(electronApp),
      );
    if (!reportAttached || !assertionsCompleted)
      await settle('partial report', 10_000, () =>
        attachReport(
          testInfo,
          `delegation-storage-${variant}-partial.json`,
          report,
        ),
      );
    if (!assertionsCompleted)
      await settle('failure directory', 10_000, () =>
        testInfo.attach('failure-user-data-directory', {
          body: userDataDir,
          contentType: 'text/plain',
        }),
      );
    if (electronApp)
      await settle('close canopy', scaled(60_000), () =>
        closeCanopy(electronApp, userDataDir),
      );
    if (killIfAlive(electronPid))
      console.warn(
        `[delegation-storage teardown] killed surviving Electron process ${electronPid}`,
      );
    await settle('inference server close', 15_000, () => fixture?.close());
    await settle('fixture cleanup', 10_000, () => cleanupDemoWorkspaces(demo));
    await settle('temporary data cleanup', 10_000, () => {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    });
  }
}

for (const workload of VARIANTS) {
  test(`${workload.variant} parent: live delegate progress against ~50 MB committed history`, async ({}, testInfo) => {
    test.setTimeout(scaled(600_000));
    await runWorkload(workload, testInfo);
  });
}

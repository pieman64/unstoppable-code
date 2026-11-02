import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ACTIVATION_CAMPAIGN_IDS,
  ACTIVATION_SIGNAL_NAMES,
  CAMPAIGN_SUPPRESSION_REASONS,
} from '@canopy/desktop-shared/types';
import type {
  ActivationCampaignId,
  ActivationCampaignRecord,
  ActivationJourneyMutationResult,
  ActivationJourneyPersistedState,
  ActivationSignalName,
  CampaignSuppressionReason,
  LegacyPromotionalSendHistory,
} from '@canopy/desktop-shared/types';
import { getActivationJourneyFilePath } from '../../lib/paths';

/**
 * Durable state for the activation notification journey (CAN-1967).
 *
 * Send latches exist so a campaign fires at most once per install: without
 * them every relaunch would re-evaluate a past-due campaign and notify again.
 * A latched send is terminal — a later suppression must not overwrite it, or
 * the funnel would report a delivered campaign as suppressed.
 *
 * This module is the only writer of the file; the in-memory cache is therefore
 * authoritative for the process lifetime and disk writes are best-effort. All
 * mutators take an explicit ISO `now` so the scheduler's injected clock (and
 * tests) fully control time.
 */
const ACTIVATION_JOURNEY_FILE_VERSION = 1;
const LEGACY_SEND_IDS = [
  'start-chat',
  'connect-accounts',
  'add-capability',
  'create-account',
] as const;

interface ActivationJourneyFile extends ActivationJourneyPersistedState {
  version: number;
  updatedAt: string;
}

let stateCache: ActivationJourneyPersistedState | null = null;
let stateLoad: Promise<ActivationJourneyPersistedState> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyState(): ActivationJourneyPersistedState {
  return {
    firstOpenAt: null,
    lastActiveAt: null,
    holdout: null,
    campaigns: {},
    signals: {},
    gettingStarted: { steps: {} },
  };
}

function cloneState(
  state: ActivationJourneyPersistedState,
): ActivationJourneyPersistedState {
  const campaigns: Partial<
    Record<ActivationCampaignId, ActivationCampaignRecord>
  > = {};
  for (const [id, record] of Object.entries(state.campaigns)) {
    if (isActivationCampaignId(id) && record !== undefined) {
      campaigns[id] = { ...record };
    }
  }
  return {
    firstOpenAt: state.firstOpenAt,
    lastActiveAt: state.lastActiveAt,
    holdout: state.holdout,
    campaigns,
    signals: { ...state.signals },
    gettingStarted: normalizeLegacySendHistory(state.gettingStarted),
    ...(state.legacyChecklistMigrationVersion === 1
      ? { legacyChecklistMigrationVersion: 1 }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActivationCampaignId(value: unknown): value is ActivationCampaignId {
  return (
    typeof value === 'string' &&
    (ACTIVATION_CAMPAIGN_IDS as readonly string[]).includes(value)
  );
}

function isActivationSignalName(value: unknown): value is ActivationSignalName {
  return (
    typeof value === 'string' &&
    (ACTIVATION_SIGNAL_NAMES as readonly string[]).includes(value)
  );
}

function isSuppressionReason(
  value: unknown,
): value is CampaignSuppressionReason {
  return (
    typeof value === 'string' &&
    (CAMPAIGN_SUPPRESSION_REASONS as readonly string[]).includes(value)
  );
}

function normalizeCampaignRecord(value: unknown): ActivationCampaignRecord {
  const record: ActivationCampaignRecord = {};
  if (!isRecord(value)) return record;
  if (typeof value.sentAt === 'string') record.sentAt = value.sentAt;
  if (typeof value.suppressedAt === 'string') {
    record.suppressedAt = value.suppressedAt;
  }
  // An unrecognized reason is dropped rather than preserved: a persisted
  // reason outside the union would flow straight into instrumentation.
  if (isSuppressionReason(value.suppressedReason)) {
    record.suppressedReason = value.suppressedReason;
  }
  if (typeof value.clickedAt === 'string') record.clickedAt = value.clickedAt;
  return record;
}

/** Drop all sequence machinery; only valid historic sends affect the daily cap. */
function normalizeLegacySendHistory(
  value: unknown,
): LegacyPromotionalSendHistory {
  const record: LegacyPromotionalSendHistory = { steps: {} };
  if (!isRecord(value) || !isRecord(value.steps)) return record;
  for (const id of LEGACY_SEND_IDS) {
    const step = value.steps[id];
    if (!isRecord(step) || typeof step.sentAt !== 'string') continue;
    const timestamp = Date.parse(step.sentAt);
    if (Number.isFinite(timestamp))
      record.steps[id] = { sentAt: new Date(timestamp).toISOString() };
  }
  return record;
}

function normalizeState(value: unknown): ActivationJourneyPersistedState {
  const state = emptyState();
  if (!isRecord(value) || value.version !== ACTIVATION_JOURNEY_FILE_VERSION) {
    return state;
  }
  if (typeof value.firstOpenAt === 'string') {
    state.firstOpenAt = value.firstOpenAt;
  }
  if (typeof value.lastActiveAt === 'string') {
    state.lastActiveAt = value.lastActiveAt;
  }
  if (typeof value.holdout === 'boolean') {
    state.holdout = value.holdout;
  }
  if (isRecord(value.campaigns)) {
    for (const [id, record] of Object.entries(value.campaigns)) {
      if (isActivationCampaignId(id)) {
        state.campaigns[id] = normalizeCampaignRecord(record);
      }
    }
  }
  if (isRecord(value.signals)) {
    for (const [name, observedAt] of Object.entries(value.signals)) {
      if (isActivationSignalName(name) && typeof observedAt === 'string') {
        state.signals[name] = observedAt;
      }
    }
  }
  state.gettingStarted = normalizeLegacySendHistory(value.gettingStarted);
  if (value.legacyChecklistMigrationVersion === 1)
    state.legacyChecklistMigrationVersion = 1;
  return state;
}

async function readStateFile(): Promise<ActivationJourneyPersistedState> {
  try {
    const raw = await readFile(getActivationJourneyFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    // Missing or corrupt state means "journey not started". Re-anchoring is
    // safe: a fresh anchor simply restarts the offsets from now.
    return emptyState();
  }
}

async function loadState(): Promise<ActivationJourneyPersistedState> {
  if (stateCache !== null) return stateCache;
  stateLoad ??= readStateFile();
  const value = await stateLoad;
  stateCache ??= value;
  return stateCache;
}

function enqueueWrite(state: ActivationJourneyPersistedState): void {
  const contents: ActivationJourneyFile = {
    version: ACTIVATION_JOURNEY_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    ...cloneState(state),
  };
  const attempt = async (): Promise<void> => {
    const filePath = getActivationJourneyFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    // Write-and-rename, not write-in-place. A torn write makes
    // `normalizeState` fall back to `emptyState()`, which would discard every
    // `sentAt` latch and re-anchor the journey -- turning a crash into "send
    // all four campaigns again". Re-anchoring alone is harmless; losing the
    // latches breaks the at-most-once contract this module exists to keep.
    const tempPath = `${filePath}.${process.pid}.tmp`;
    try {
      // fsync before rename: without it the rename can land while the temp
      // file's contents are still buffered, so power loss exposes a
      // zero-length file -- which reads back as empty state and discards
      // every send latch, the exact failure the rename is here to prevent.
      const handle = await open(tempPath, 'w');
      try {
        await handle.writeFile(
          `${JSON.stringify(contents, null, 2)}\n`,
          'utf8',
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  };
  // A failed write must not poison later writes; the in-memory state stays
  // authoritative and the next mutation retries persistence.
  writeChain = writeChain.then(attempt, attempt).catch(() => undefined);
}

/**
 * Mutations serialize on this chain: `mutateState` suspends at `await
 * loadState()`, so two concurrent callers would otherwise clone the same base
 * state and overwrite each other's `stateCache` assignment, silently dropping
 * all but the last latch.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function mutateState(
  mutate: (state: ActivationJourneyPersistedState) => boolean,
): Promise<ActivationJourneyMutationResult> {
  const run = async (): Promise<ActivationJourneyMutationResult> => {
    const current = await loadState();
    const next = cloneState(current);
    const changed = mutate(next);
    if (!changed) {
      return { state: cloneState(current), changed: false };
    }
    stateCache = next;
    enqueueWrite(next);
    return { state: cloneState(next), changed: true };
  };
  const step = mutationChain.then(run, run);
  mutationChain = step.catch(() => undefined);
  return step;
}

export async function readActivationJourneyState(): Promise<ActivationJourneyPersistedState> {
  return cloneState(await loadState());
}

/**
 * Anchor the journey. Idempotent: the first recorded open wins forever, so a
 * relaunch cannot slide every first-open-anchored campaign forward.
 */
export function recordFirstOpen(
  now: string,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    if (state.firstOpenAt !== null) return false;
    state.firstOpenAt = now;
    return true;
  });
}

/**
 * Minimum spacing between persisted activity samples.
 *
 * The anchor is read by campaigns whose shortest offset is ten minutes, so
 * minute-level resolution is ample. Without this every window focus would
 * clone state, serialize JSON, and write a file — alt-tabbing between apps
 * would hit the disk each time. The cost is that the anchor can lag true
 * activity by up to a minute, which at worst fires an abandonment campaign a
 * minute early.
 */
const ACTIVITY_RESOLUTION_MS = 60_000;

/**
 * Advance the abandonment anchor. Monotonic — a stale or clock-skewed sample
 * must never pull `lastActiveAt` backwards, which would make an
 * abandonment-anchored campaign appear due earlier than it is — and throttled
 * to {@link ACTIVITY_RESOLUTION_MS}.
 */
export function recordActivity(
  now: string,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    if (state.lastActiveAt !== null) {
      if (state.lastActiveAt >= now) return false;
      const previousMs = Date.parse(state.lastActiveAt);
      const nextMs = Date.parse(now);
      if (
        !Number.isNaN(previousMs) &&
        !Number.isNaN(nextMs) &&
        nextMs - previousMs < ACTIVITY_RESOLUTION_MS
      ) {
        return false;
      }
    }
    state.lastActiveAt = now;
    return true;
  });
}

/** Assign the holdout cohort once; re-rolling would corrupt the experiment. */
export function assignHoldout(
  holdout: boolean,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    if (state.holdout !== null) return false;
    state.holdout = holdout;
    return true;
  });
}

export function latchCampaignSent(
  id: ActivationCampaignId,
  now: string,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    const record = state.campaigns[id];
    if (record?.sentAt !== undefined) return false;
    state.campaigns[id] = { ...record, sentAt: now };
    return true;
  });
}

/**
 * Record why a campaign did not fire. A campaign that already sent is
 * terminal: suppressing it afterwards would misreport a delivered campaign.
 */
export function latchCampaignSuppressed(
  id: ActivationCampaignId,
  reason: CampaignSuppressionReason,
  now: string,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    const record = state.campaigns[id];
    if (record?.sentAt !== undefined) return false;
    if (record?.suppressedReason === reason) return false;
    state.campaigns[id] = {
      ...record,
      suppressedAt: now,
      suppressedReason: reason,
    };
    return true;
  });
}

export function latchCampaignClicked(
  id: ActivationCampaignId,
  now: string,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    const record = state.campaigns[id];
    if (record?.clickedAt !== undefined) return false;
    state.campaigns[id] = { ...record, clickedAt: now };
    return true;
  });
}

/**
 * Undo a send latch after the OS refused to present the notification, leaving
 * a suppression record in its place so the campaign is retried.
 *
 * No-ops when the campaign is not currently latched as sent: the failure
 * callback is async and a later evaluation may already have moved the record
 * on, and re-clearing then would resurrect a campaign that genuinely sent.
 */
export function unlatchCampaignDeliveryFailure(
  campaignId: ActivationCampaignId,
  now: string,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    const record = state.campaigns[campaignId];
    if (record?.sentAt === undefined) return false;
    state.campaigns[campaignId] = {
      ...record,
      sentAt: undefined,
      suppressedAt: now,
      suppressedReason: 'delivery-failed',
    };
    return true;
  });
}

/**
 * Release `delivery-failed` holds that are at least `minAgeMs` old so the
 * next evaluation retries them. Called only from the event-driven recompute
 * path: a denied OS does not change on a timer, so the scheduler's own
 * heartbeat must never call this, or a permanently refused banner would be
 * re-presented daily for the life of the window.
 *
 * The age bound exists because "event" includes the window-focus anchor
 * write, which fires as often as once a minute of active use. Without it a
 * refused banner would be re-asked every minute -- a notification, two
 * fsynced writes, and a delivered/failed telemetry pair per cycle -- for
 * exactly the users who denied authorization. A hold younger than the bound
 * is left alone; launch, resume, and preference changes still retry once a
 * day has passed, which is as often as any promotional send may happen.
 */
export function releaseDeliveryFailures(
  now: string,
  minAgeMs: number,
): Promise<ActivationJourneyMutationResult> {
  const nowMs = Date.parse(now);
  return mutateState((state) => {
    let changed = false;
    const release = (record: ActivationCampaignRecord | undefined): void => {
      if (record?.suppressedReason !== 'delivery-failed') return;
      const failedAtMs =
        record.suppressedAt === undefined
          ? NaN
          : Date.parse(record.suppressedAt);
      // An unparseable stamp releases: holding forever on corrupt data would
      // silently retire the banner, which is the failure mode latches exist
      // to prevent.
      if (!Number.isNaN(failedAtMs) && nowMs - failedAtMs < minAgeMs) return;
      delete record.suppressedAt;
      delete record.suppressedReason;
      changed = true;
    };
    for (const record of Object.values(state.campaigns)) release(record);
    return changed;
  });
}

/** Merge legacy signals and the processing marker in the existing atomic snapshot. */
export function mergeLegacyChecklistSignals(
  signals: Partial<Record<ActivationSignalName, string>>,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    if (state.legacyChecklistMigrationVersion === 1) return false;
    for (const name of ACTIVATION_SIGNAL_NAMES) {
      const timestamp = signals[name];
      if (state.signals[name] === undefined && timestamp !== undefined)
        state.signals[name] = timestamp;
    }
    state.legacyChecklistMigrationVersion = 1;
    return true;
  });
}

/**
 * Record the first observation of an activation signal. Idempotent: the
 * earliest observation wins, so a later re-observation cannot move the stamp
 * forward and make a long-active user look freshly activated.
 */
export function latchActivationSignal(
  name: ActivationSignalName,
  now: string,
): Promise<ActivationJourneyMutationResult> {
  return mutateState((state) => {
    if (state.signals[name] !== undefined) return false;
    state.signals[name] = now;
    return true;
  });
}

/**
 * Await every queued write. Called on quit so a latch recorded moments before
 * shutdown is not lost -- an un-drained `latchCampaignSent` would re-fire that
 * campaign on the next launch.
 */
export async function drainActivationJourneyWrites(): Promise<void> {
  // Drain mutations FIRST: a mutation still in flight has not reached
  // `enqueueWrite` yet, so awaiting only `writeChain` would resolve without
  // it. That is the "banner shown, send latch lost, campaign re-fires next
  // launch" case this whole module exists to prevent.
  await mutationChain.catch(() => undefined);
  await writeChain.catch(() => undefined);
}

export function resetActivationJourneyStateForTests(): void {
  stateCache = null;
  stateLoad = null;
  writeChain = Promise.resolve();
  mutationChain = Promise.resolve();
}

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { PortalEventEnvelope } from '@canopy/desktop-shared/types';
import {
  computePortalOutboxTrim,
  PORTAL_OUTBOX_MAX_BYTES,
} from './portal-outbox';

/**
 * Byte budget for persisted completedCommands, separate from the outbox
 * budget so the store-level total stays honest: outbox (20MiB) + completed
 * commands (8MiB) + scalar fields is comfortably under the parse ceiling.
 */
export const PORTAL_COMPLETED_COMMANDS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Hard ceiling on the store file size we are willing to JSON.parse. The parse
 * step materializes the whole file in memory BEFORE normalize() can bound
 * anything, so a pathologically bloated store (CAN-2319's was 289MB) must be
 * abandoned unread — the fresh-state recovery below costs a device re-pair,
 * which beats a main-process OOM crash loop. Kept well above the sum of the
 * per-list budgets so it only fires for stores written by pre-fix builds.
 */
export const PORTAL_STATE_FILE_MAX_BYTES = 64 * 1024 * 1024;

export interface PersistedPortalCommandCompletion {
  commandId: string;
  sequence: number;
  events: PortalEventEnvelope[];
  completedAt: string;
}

export type PersistedPortalViewMode = 'worktrees' | 'standalone-chats';
export type PersistedPortalStopReason =
  | 'local_disconnect'
  | 'replaced'
  | 'app_shutdown'
  | 'server_disconnect';

export interface PersistedStartedWorkspaceCreates {
  sessionId: string;
  /** Keep acknowledged progress when reconnecting to the same session. */
  acknowledgedCursor?: number;
  commands: Array<{ commandId: string; sequence: number }>;
}

export interface PersistedPortalState {
  version: 1;
  clientDeviceId: string;
  activeSession?: {
    serverId: string;
    sessionId: string;
    commandCursor: number;
    activatedAt: string;
    lastSeenAt: string | null;
  };
  eventOutbox?: PortalEventEnvelope[];
  routingSequenceCounters?: Record<string, number>;
  /**
   * `portal.state.request` commands with events still in the outbox, so a
   * trim after restore still fails only state requests as retryable.
   */
  stateRequestCommandIds?: string[];
  completedCommands?: PersistedPortalCommandCompletion[];
  /** Retained until the command cursor is durable, including across reconnects. */
  startedWorkspaceCreates?: PersistedStartedWorkspaceCreates;
  /**
   * Last-known portal view mode the user selected. Persisted server-side
   * per portal session so the browser shell can pick up the same mode on
   * reload. Optional because older state files predate this field.
   */
  viewMode?: PersistedPortalViewMode;
  lastStopReason?: PersistedPortalStopReason;
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'portal-state.json');
}

function freshState(): PersistedPortalState {
  return {
    version: 1,
    clientDeviceId: randomUUID(),
  };
}

function isPortalEventEnvelope(value: unknown): value is PortalEventEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { eventId?: unknown }).eventId === 'string' &&
    typeof (value as { occurredAt?: unknown }).occurredAt === 'string' &&
    'payload' in value
  );
}

/** Live visual pages may be sent once, but never checkpointed or replayed. */
function persistedEventWithoutVisualPage(
  event: PortalEventEnvelope,
  replay = false,
): PortalEventEnvelope {
  const payload = event.payload;
  if (
    event.type !== 'portal.command.completed' ||
    typeof payload !== 'object' ||
    payload === null ||
    !('result' in payload) ||
    typeof payload.result !== 'object' ||
    payload.result === null ||
    !('kind' in payload.result) ||
    payload.result.kind !== 'inline-page'
  ) {
    return event;
  }
  return {
    ...event,
    eventId: replay ? `${event.eventId}:replay` : event.eventId,
    type: 'portal.command.failed',
    payload: {
      commandId: event.commandId,
      sequenceNumber: 'sequenceNumber' in payload ? payload.sequenceNumber : 0,
      generatedAt:
        'generatedAt' in payload ? payload.generatedAt : event.occurredAt,
      error: {
        code: 'execution_failed',
        message: 'The visual page was interrupted. Try again.',
      },
      retryable: true,
    },
  };
}

/**
 * Keep the newest entries whose cumulative measured size fits the budget.
 * Applied at the read choke point so a store bloated by an older build is
 * bounded before ANY caller re-serializes it (CAN-2319's crash reproduces on
 * restore, not just on growth). Dropped entries are the oldest — the same
 * retention direction as the count cap. Deliberately all-or-nothing: a single
 * entry larger than the whole budget empties the list.
 */
function keepNewestWithinByteBudget<T>(
  entries: T[],
  measure: (entry: T) => number,
  maxBytes: number,
): T[] {
  let total = 0;
  let start = entries.length;
  while (start > 0) {
    const size = measure(entries[start - 1]);
    if (total + size > maxBytes) {
      break;
    }
    total += size;
    start -= 1;
  }
  return start === 0 ? entries : entries.slice(start);
}

function normalizeEventOutbox(value: unknown): PortalEventEnvelope[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPortalEventEnvelope).slice(-500);
}

/**
 * Outbox variant of the read-path bound: routes through the live trim
 * machinery so stamped events dropped by the byte budget leave
 * `portal.events.dropped` resync markers — the receiver's contract for lane
 * gaps — instead of a silent sequence hole.
 */
function normalizeEventOutboxWithMarkers(
  value: unknown,
  stateRequestCommandIds: ReadonlySet<string>,
): PortalEventEnvelope[] {
  return computePortalOutboxTrim(
    normalizeEventOutbox(value),
    500,
    null,
    undefined,
    undefined,
    { maxBytes: PORTAL_OUTBOX_MAX_BYTES, stateRequestCommandIds },
  ).kept;
}

function normalizeOutboxWithStateRequests(
  outbox: unknown,
  ids: unknown,
): { eventOutbox: PortalEventEnvelope[]; stateRequestCommandIds: string[] } {
  const stateRequestCommandIds = new Set(normalizeStateRequestCommandIds(ids));
  const eventOutbox = normalizeEventOutboxWithMarkers(
    outbox,
    stateRequestCommandIds,
  );
  return {
    eventOutbox,
    stateRequestCommandIds: queuedStateRequestCommandIds(
      eventOutbox,
      stateRequestCommandIds,
    ),
  };
}

function normalizeStateRequestCommandIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(-500);
}

/** Keeps only ids that still name a queued event, which bounds the list. */
function queuedStateRequestCommandIds(
  eventOutbox: PortalEventEnvelope[],
  stateRequestCommandIds: ReadonlySet<string>,
): string[] {
  const queued = new Set<string>();
  for (const event of eventOutbox) {
    if (event.commandId && stateRequestCommandIds.has(event.commandId)) {
      queued.add(event.commandId);
    }
  }
  return Array.from(queued);
}

function normalizeRoutingSequenceCounters(
  value: unknown,
): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' &&
        Number.isSafeInteger(entry[1]) &&
        entry[1] >= 0,
    ),
  );
}

function normalizeCompletedCommands(
  value: unknown,
): PersistedPortalCommandCompletion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const capped = value
    .filter((entry): entry is PersistedPortalCommandCompletion => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { commandId?: unknown }).commandId !== 'string' ||
        typeof (entry as { sequence?: unknown }).sequence !== 'number' ||
        typeof (entry as { completedAt?: unknown }).completedAt !== 'string'
      ) {
        return false;
      }
      return Array.isArray((entry as { events?: unknown }).events);
    })
    .slice(-500)
    .map((entry) => ({
      ...entry,
      events: normalizeEventOutbox(entry.events),
    }));
  // completedCommands is the same count-capped accumulator shape as the
  // outbox and can hold full snapshots per entry — bound it by bytes too.
  // Whole entries are dropped (never truncated) so a replay lookup misses
  // cleanly instead of returning a partial command result.
  return keepNewestWithinByteBudget(
    capped,
    (entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8'),
    PORTAL_COMPLETED_COMMANDS_MAX_BYTES,
  );
}

function normalizeStartedWorkspaceCreates(
  value: unknown,
): PersistedStartedWorkspaceCreates | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    value.sessionId.length > 128 ||
    !('commands' in value) ||
    !Array.isArray(value.commands)
  )
    return undefined;
  const commands: PersistedStartedWorkspaceCreates['commands'] = [];
  const ids = new Set<string>();
  const candidates: unknown[] = value.commands;
  for (const entry of candidates) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('commandId' in entry) ||
      typeof entry.commandId !== 'string' ||
      entry.commandId.length === 0 ||
      entry.commandId.length > 128 ||
      !('sequence' in entry) ||
      typeof entry.sequence !== 'number' ||
      !Number.isSafeInteger(entry.sequence) ||
      entry.sequence < 1 ||
      ids.has(entry.commandId)
    )
      continue;
    ids.add(entry.commandId);
    commands.push({ commandId: entry.commandId, sequence: entry.sequence });
  }
  return {
    sessionId: value.sessionId,
    acknowledgedCursor:
      'acknowledgedCursor' in value &&
      typeof value.acknowledgedCursor === 'number' &&
      Number.isSafeInteger(value.acknowledgedCursor) &&
      value.acknowledgedCursor >= 0
        ? value.acknowledgedCursor
        : 0,
    commands,
  };
}

function normalize(value: unknown): PersistedPortalState {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { clientDeviceId?: unknown }).clientDeviceId !== 'string'
  ) {
    return freshState();
  }

  const input = value as PersistedPortalState;
  return {
    version: 1,
    clientDeviceId: input.clientDeviceId,
    ...(input.activeSession &&
    typeof input.activeSession.serverId === 'string' &&
    typeof input.activeSession.sessionId === 'string' &&
    typeof input.activeSession.commandCursor === 'number'
      ? { activeSession: input.activeSession }
      : {}),
    ...normalizeOutboxWithStateRequests(
      input.eventOutbox,
      input.stateRequestCommandIds,
    ),
    routingSequenceCounters: normalizeRoutingSequenceCounters(
      input.routingSequenceCounters,
    ),
    completedCommands: normalizeCompletedCommands(input.completedCommands),
    startedWorkspaceCreates: normalizeStartedWorkspaceCreates(
      'startedWorkspaceCreates' in value
        ? value.startedWorkspaceCreates
        : undefined,
    ),
    ...(input.viewMode === 'worktrees' || input.viewMode === 'standalone-chats'
      ? { viewMode: input.viewMode }
      : {}),
    ...(input.lastStopReason === 'local_disconnect' ||
    input.lastStopReason === 'replaced' ||
    input.lastStopReason === 'app_shutdown' ||
    input.lastStopReason === 'server_disconnect'
      ? { lastStopReason: input.lastStopReason }
      : {}),
  };
}

export async function persistPortalViewMode(
  viewMode: PersistedPortalViewMode,
): Promise<void> {
  await updatePortalStateStore((state) => ({
    ...state,
    viewMode,
  }));
}

export async function persistPortalStopReason(
  reason: PersistedPortalStopReason,
): Promise<void> {
  await updatePortalStateStore((state) => ({
    ...state,
    lastStopReason: reason,
  }));
}

/**
 * In-memory source of truth after the first disk load. The store has a single
 * writer (this process), so re-reading and re-parsing the file on every
 * update is pure waste — with the outbox pinned at its 20MiB byte cap that
 * waste measured ~1.7s of main-thread work per update, requested every 250ms,
 * which starved the event loop and OOMed the main process (2026-09-05 crash
 * loop). Keyed by the path string (a plain join, not realpath) so tests that
 * repoint userData get a fresh load. Consumers must treat the returned state
 * as immutable — every mutation goes through updatePortalStateStore with a
 * pure updater.
 */
let cachedState: PersistedPortalState | null = null;
let cachedStatePath: string | null = null;
let loadInFlight: Promise<PersistedPortalState> | null = null;

function getCachedState(): PersistedPortalState | null {
  return cachedStatePath === statePath() ? cachedState : null;
}

function setCachedState(state: PersistedPortalState): void {
  cachedState = state;
  cachedStatePath = statePath();
}

async function loadPortalStateStore(): Promise<PersistedPortalState> {
  try {
    const stats = await fs.stat(statePath());
    if (stats.size > PORTAL_STATE_FILE_MAX_BYTES) {
      // Do not read or parse: recovery costs the clientDeviceId (it cannot be
      // extracted without parsing), which is the acceptable price for ending
      // a crash loop on a pre-fix bloated store.
      throw Object.assign(
        new Error('portal state store exceeds parse ceiling'),
        {
          code: 'PORTAL_STATE_OVERSIZED',
        },
      );
    }
    const raw = await fs.readFile(statePath(), 'utf8');
    const state = normalize(JSON.parse(raw) as unknown);
    setCachedState(state);
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      void error;
    }
    const state = freshState();
    setCachedState(state);
    await writePortalStateStore(state).catch(() => undefined);
    return state;
  }
}

export async function readPortalStateStore(): Promise<PersistedPortalState> {
  const cached = getCachedState();
  if (cached) {
    return cached;
  }
  // Single-flight the disk load: concurrent first readers (guest-auth, OAuth
  // login, publish flows call this directly) must not each mint a fresh
  // clientDeviceId on a missing file and race their direct fallback writes.
  if (!loadInFlight) {
    loadInFlight = loadPortalStateStore().finally(() => {
      loadInFlight = null;
    });
  }
  return loadInFlight;
}

export async function writePortalStateStore(
  state: PersistedPortalState,
): Promise<void> {
  const filePath = statePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  // Compact on purpose: the whole store is re-stringified on every save on
  // the main process, and pretty-printing inflates a snapshot-heavy outbox by
  // ~30% (CAN-2319).
  await fs.writeFile(tempPath, `${JSON.stringify(state)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

let pendingUpdate: Promise<unknown> = Promise.resolve();
let writeLoop: Promise<void> | null = null;
let writeRequested = false;
let lastQueuedVersion = 0;
type WriteOutcome = { ok: true } | { ok: false; error: unknown };
let lastDurableVersion = 0;
let lastSettledVersion = 0;
let lastFailureError: Error | null = null;
let writeWaiters: Array<{
  version: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}> = [];

/**
 * Record the outcome for every version up to `throughVersion` and settle both
 * queued waiters and — via the fast path in waitForDurableWrite — waiters that
 * subscribe after this settlement (the pump can settle synchronously before a
 * caller reaches its await, so a queue-only settle would strand them forever).
 * A later successful write supersedes an earlier failure for lower versions:
 * that write carried their data.
 */
function settleWriteWaiters(
  throughVersion: number,
  outcome: WriteOutcome,
): void {
  lastSettledVersion = Math.max(lastSettledVersion, throughVersion);
  if (outcome.ok) {
    lastDurableVersion = Math.max(lastDurableVersion, throughVersion);
  } else {
    lastFailureError =
      outcome.error instanceof Error
        ? outcome.error
        : new Error(String(outcome.error));
  }
  const settled = writeWaiters.filter(
    (waiter) => waiter.version <= throughVersion,
  );
  writeWaiters = writeWaiters.filter(
    (waiter) => waiter.version > throughVersion,
  );
  for (const waiter of settled) {
    if (outcome.ok) waiter.resolve();
    else waiter.reject(outcome.error);
  }
}

function waitForDurableWrite(version: number): Promise<void> {
  if (lastDurableVersion >= version) {
    return Promise.resolve();
  }
  if (lastSettledVersion >= version) {
    return Promise.reject(
      lastFailureError ?? new Error('portal state write failed'),
    );
  }
  return new Promise<void>((resolve, reject) => {
    writeWaiters.push({ version, resolve, reject });
  });
}

/**
 * Single-flight write pump. A burst of updates landing while a write is in
 * flight collapses into one trailing write carrying the latest state instead
 * of queueing one full-store write per update — with a byte-cap-sized store
 * an unbounded write backlog was a main-process OOM vector (2026-09-05).
 */
function requestStoreWrite(): void {
  writeRequested = true;
  if (writeLoop) {
    return;
  }
  writeLoop = (async (): Promise<void> => {
    while (writeRequested) {
      writeRequested = false;
      const version = lastQueuedVersion;
      const state = getCachedState();
      if (!state) {
        // Defensive-only: updatePortalStateStore sets the cache synchronously
        // before requesting a write, so this fires only if the path key
        // changed mid-update. Nothing was written — fail closed rather than
        // report durability that does not exist.
        settleWriteWaiters(version, {
          ok: false,
          error: new Error(
            'portal state cache was invalidated before the write',
          ),
        });
        continue;
      }
      try {
        await writePortalStateStore(state);
        settleWriteWaiters(version, { ok: true });
      } catch (error) {
        settleWriteWaiters(version, { ok: false, error });
      }
    }
  })().finally(() => {
    writeLoop = null;
    if (writeRequested) {
      requestStoreWrite();
    }
  });
}

export async function updatePortalStateStore(
  update: (state: PersistedPortalState) => PersistedPortalState,
): Promise<PersistedPortalState> {
  // The chain serializes only the cheap in-memory read-apply step so
  // concurrent updaters compose instead of clobbering each other; the
  // expensive full-store write is coalesced by the single-flight pump.
  const run = async (): Promise<{
    next: PersistedPortalState;
    version: number;
  }> => {
    const next = update(await readPortalStateStore());
    setCachedState(next);
    lastQueuedVersion += 1;
    requestStoreWrite();
    return { next, version: lastQueuedVersion };
  };
  const applied = pendingUpdate.then(run, run);
  pendingUpdate = applied.then(
    () => undefined,
    () => undefined,
  );
  const { next, version } = await applied;
  await waitForDurableWrite(version);
  return next;
}

export async function persistActivePortalSession(input: {
  serverId: string;
  sessionId: string;
  commandCursor: number;
  activatedAt: string;
  lastSeenAt: string | null;
}): Promise<void> {
  await updatePortalStateStore((state) => {
    const next: PersistedPortalState = {
      ...state,
      activeSession: {
        ...input,
        commandCursor: Math.max(
          input.commandCursor,
          state.activeSession?.sessionId === input.sessionId
            ? state.activeSession.commandCursor
            : 0,
          state.startedWorkspaceCreates?.sessionId === input.sessionId
            ? (state.startedWorkspaceCreates.acknowledgedCursor ?? 0)
            : 0,
        ),
      },
      startedWorkspaceCreates:
        state.startedWorkspaceCreates?.sessionId === input.sessionId
          ? state.startedWorkspaceCreates
          : { sessionId: input.sessionId, commands: [] },
    };
    // CAN-2235 defect 2: a fresh activation must not inherit the PREVIOUS
    // session's stop reason. The spread above carries it forward, so if the
    // app later dies without a clean `app_shutdown` write,
    // `resumeCanopyPortalIfPossible` refuses to resume a perfectly valid
    // session. `normalize()` already drops the field when it is absent.
    delete next.lastStopReason;
    return next;
  });
}

export async function persistPortalEventOutbox(
  eventOutbox: PortalEventEnvelope[],
  routingSequenceCounters: ReadonlyMap<string, number> = new Map(),
  stateRequestCommandIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  await updatePortalStateStore((state) => {
    // The session manager trims before every persist, but the byte budget
    // must also hold here: updates no longer round-trip through the
    // read-path normalize(), so this is the store's own bound between disk
    // loads (blowing PORTAL_STATE_FILE_MAX_BYTES costs a device re-pair).
    // Cheap in the steady state — the trim's per-event byte cache is warm
    // from the session manager's own trim on the same envelopes.
    const trimmedOutbox = computePortalOutboxTrim(
      eventOutbox
        .slice(-500)
        .map((event) => persistedEventWithoutVisualPage(event)),
      500,
      null,
      undefined,
      undefined,
      { maxBytes: PORTAL_OUTBOX_MAX_BYTES, stateRequestCommandIds },
    ).kept;
    return {
      ...state,
      eventOutbox: trimmedOutbox,
      routingSequenceCounters: Object.fromEntries(routingSequenceCounters),
      stateRequestCommandIds: queuedStateRequestCommandIds(
        trimmedOutbox,
        stateRequestCommandIds,
      ),
    };
  });
}

export async function persistPortalCommandCursor(input: {
  sessionId?: string;
  commandCursor: number;
  lastSeenAt?: string | null;
}): Promise<void> {
  await updatePortalStateStore((state) => {
    if (
      !state.activeSession ||
      (input.sessionId !== undefined &&
        state.activeSession.sessionId !== input.sessionId)
    ) {
      return state;
    }
    return {
      ...state,
      // Cursor and cleanup share an atomic file replacement. If it fails,
      // disk retains both the old cursor and its redelivery guard.
      startedWorkspaceCreates: cleanupStartedWorkspaceCreates(
        state.startedWorkspaceCreates,
        state.activeSession.sessionId,
        Math.max(state.activeSession.commandCursor, input.commandCursor),
      ),
      activeSession: {
        ...state.activeSession,
        commandCursor: Math.max(
          state.activeSession.commandCursor,
          input.commandCursor,
        ),
        lastSeenAt: input.lastSeenAt ?? state.activeSession.lastSeenAt,
      },
    };
  });
}

function cleanupStartedWorkspaceCreates(
  started: PersistedStartedWorkspaceCreates | undefined,
  sessionId: string,
  acknowledgedCursor: number,
): PersistedStartedWorkspaceCreates | undefined {
  if (!started || started.sessionId !== sessionId) return started;
  return {
    ...started,
    acknowledgedCursor: Math.max(
      started.acknowledgedCursor ?? 0,
      acknowledgedCursor,
    ),
    commands: started.commands.filter(
      (entry) => entry.sequence > acknowledgedCursor,
    ),
  };
}

export async function readStartedPortalWorkspaceCreates(
  sessionId: string,
): Promise<ReadonlyArray<{ commandId: string; sequence: number }>> {
  const state = await readPortalStateStore();
  return state.startedWorkspaceCreates?.sessionId === sessionId
    ? state.startedWorkspaceCreates.commands
    : [];
}

/** Atomically claim invocation, and await its durable write before cloning. */
export async function markPortalWorkspaceCreateStarted(input: {
  sessionId: string;
  commandId: string;
  sequence: number;
}): Promise<boolean> {
  if (
    !input.sessionId ||
    input.sessionId.length > 128 ||
    !input.commandId ||
    input.commandId.length > 128 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1
  )
    throw new Error('Invalid workspace-create command identity');
  let claimed = false;
  await updatePortalStateStore((state) => {
    if (state.activeSession?.sessionId !== input.sessionId) {
      throw new Error('Workspace-create session is no longer active');
    }
    const started =
      state.startedWorkspaceCreates?.sessionId === input.sessionId
        ? state.startedWorkspaceCreates.commands
        : [];
    if (
      input.sequence <= state.activeSession.commandCursor ||
      started.some((entry) => entry.commandId === input.commandId)
    )
      return state;
    claimed = true;
    return {
      ...state,
      startedWorkspaceCreates: {
        sessionId: input.sessionId,
        acknowledgedCursor: state.activeSession.commandCursor,
        commands: [
          ...started,
          { commandId: input.commandId, sequence: input.sequence },
        ],
      },
    };
  });
  if (
    (await readPortalStateStore()).activeSession?.sessionId !== input.sessionId
  ) {
    throw new Error('Workspace-create session is no longer active');
  }
  return claimed;
}

// Entries are immutable once created, so their measured size can be cached
// per object; without the cache the byte bound below re-stringifies up to
// 8MiB of retained completions on every command completion.
const completedCommandSizeCache = new WeakMap<
  PersistedPortalCommandCompletion,
  number
>();

function completedCommandByteLength(
  entry: PersistedPortalCommandCompletion,
): number {
  let size = completedCommandSizeCache.get(entry);
  if (size === undefined) {
    size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    completedCommandSizeCache.set(entry, size);
  }
  return size;
}

export async function persistCompletedPortalCommand(input: {
  commandId: string;
  sequence: number;
  events: PortalEventEnvelope[];
}): Promise<void> {
  await updatePortalStateStore((state) => {
    const existing = state.completedCommands ?? [];
    // The byte budget must be enforced here, on the in-memory path: updates
    // no longer round-trip through the read-path normalize() on every save,
    // so this updater is the only bound between disk loads.
    const next = keepNewestWithinByteBudget(
      [
        ...existing.filter((entry) => entry.commandId !== input.commandId),
        {
          commandId: input.commandId,
          sequence: input.sequence,
          // Completed entries are immutable after insertion. Clone the caller
          // array so a retained command observer cannot mutate an entry after
          // completedCommandByteLength() caches its measured size.
          events: input.events.map((event) =>
            persistedEventWithoutVisualPage(event, true),
          ),
          completedAt: new Date().toISOString(),
        },
      ].slice(-500),
      completedCommandByteLength,
      PORTAL_COMPLETED_COMMANDS_MAX_BYTES,
    );
    return {
      ...state,
      completedCommands: next,
    };
  });
}

export async function readCompletedPortalCommand(
  commandId: string,
): Promise<PersistedPortalCommandCompletion | null> {
  const state = await readPortalStateStore();
  return (
    state.completedCommands?.find((entry) => entry.commandId === commandId) ??
    null
  );
}

export async function clearActivePortalSession(
  reason?: PersistedPortalStopReason,
): Promise<void> {
  await updatePortalStateStore((state) => {
    const rest: PersistedPortalState = {
      version: state.version,
      clientDeviceId: state.clientDeviceId,
      ...(state.viewMode ? { viewMode: state.viewMode } : {}),
      ...(reason ? { lastStopReason: reason } : {}),
      eventOutbox: [],
      completedCommands: [],
      startedWorkspaceCreates: state.startedWorkspaceCreates,
    };
    return rest;
  });
}

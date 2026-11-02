import type {
  LedgerOutboxEventRecord,
  LedgerScopeSyncRecord,
  LedgerSyncRepairReason,
} from '@canopy/desktop-shared/node/ledger';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import {
  LEDGER_SYNC_GLOBAL_SCHEMA_VERSION,
  LEDGER_SYNC_LIMITS,
  LEDGER_SYNC_SCHEMA_VERSION,
  type LedgerRequestedAudience,
  type LedgerScopeAudience,
  type LedgerScopeRegisterRequest,
  type LedgerSyncEvent,
  type LedgerTaskScopeKind,
  type LedgerWriterSession,
} from '@canopy/protocol/ledger-sync';
import type { LedgerSyncStoreClient } from './ledger-store-client';
import { LedgerStorageHostError } from './storage-host';
import type { LedgerMirrorClient, LedgerSyncFailure } from './sync-client';
import {
  desiredLedgerAudience,
  isLedgerAudienceApplied,
  isLedgerScopeOfAccount,
  ledgerAccountHold,
  ledgerSyncPolicyKey,
  resolveLedgerSyncDisposition,
  type LedgerSyncAccount,
  type LedgerSyncDisposition,
  type LedgerSyncHold,
  type LedgerSyncScope,
  type LedgerWorkspaceOwner,
} from './sync-policy';

/*
 * Ledger sync (phase 13: LD01, LD02, E06). Sends each scope's outbox to the
 * mirror, one scope and one batch at a time, off every Ledger command's path:
 * a command commits locally and returns, and this runs afterwards.
 *
 * A scope is registered once per launch under this launch's writer session,
 * which gives it a writer epoch, and again whenever the audience its sharing
 * resolves to differs from the one the mirror holds or an organization lease
 * is due. Its outbox is then pushed in order, and each acknowledgment drops
 * what the mirror holds.
 *
 * What stops a scope:
 * - Its account is not the one signed in, or sharing is off: it waits. The
 *   mirror is still told that no organization may read it, when it can be.
 * - The mirror refuses it for good (another writer, a gap, an event it will
 *   not take): it is marked for repair and left alone until the next launch,
 *   which tries it once more. Nothing is ever skipped on the mirror's word.
 * - The network, the server or the ingest switch: everything waits and is
 *   tried again, with backoff.
 * - The account or its sharing changes during a pass: nothing more is sent
 *   under the old choice, and the next pass sends audience changes first.
 * - The account is refused: everything waits for the account or its policy
 *   to change, or for the next periodic check.
 * - A global (workflow) scope syncs only to a mirror that advertises
 *   `ledger-global-v1`, at schema version 2. Until then it waits, holding its
 *   events in order; task scopes keep syncing. A mirror that refuses one it
 *   advertised (a rollback) sends it back to waiting, never to repair.
 */

/** Bytes kept for a push's envelope, beside its events' payloads. */
const PUSH_ENVELOPE_BYTES = 64 * 1024;
const PUSH_PAYLOAD_BYTES =
  LEDGER_SYNC_LIMITS.pushRequestMaxBytes - PUSH_ENVELOPE_BYTES;

export const LEDGER_SYNC_RETRY_INITIAL_MS = 1_000;
export const LEDGER_SYNC_RETRY_MAX_MS = 60_000;
/** The longest a server may ask sync to stay away. */
const RETRY_AFTER_MAX_MS = 10 * 60_000;
/** After the app starts: no sync work competes with startup. */
export const LEDGER_SYNC_STARTUP_DELAY_MS = 15_000;
/** After a local commit, so a burst of changes travels together. */
export const LEDGER_SYNC_LOCAL_CHANGE_DELAY_MS = 2_000;
/** After the account or its policy changed. */
export const LEDGER_SYNC_POLICY_CHANGE_DELAY_MS = 250;
/**
 * How often an idle service checks every scope: leases to reconfirm, and
 * whether a refusal still stands.
 */
export const LEDGER_SYNC_PERIODIC_CHECK_MS = 30 * 60_000;
/** How long the purge of a deleted scope waits for its outbox. */
export const LEDGER_SYNC_DRAIN_TIMEOUT_MS = 10_000;

/** How long sync waits before each kind of work. */
export interface LedgerSyncTiming {
  readonly startupDelayMs: number;
  readonly localChangeDelayMs: number;
  readonly policyChangeDelayMs: number;
  readonly retryInitialMs: number;
  readonly retryMaxMs: number;
  readonly periodicCheckMs: number;
  readonly drainTimeoutMs: number;
}

export const LEDGER_SYNC_TIMING: LedgerSyncTiming = {
  startupDelayMs: LEDGER_SYNC_STARTUP_DELAY_MS,
  localChangeDelayMs: LEDGER_SYNC_LOCAL_CHANGE_DELAY_MS,
  policyChangeDelayMs: LEDGER_SYNC_POLICY_CHANGE_DELAY_MS,
  retryInitialMs: LEDGER_SYNC_RETRY_INITIAL_MS,
  retryMaxMs: LEDGER_SYNC_RETRY_MAX_MS,
  periodicCheckMs: LEDGER_SYNC_PERIODIC_CHECK_MS,
  drainTimeoutMs: LEDGER_SYNC_DRAIN_TIMEOUT_MS,
};
/** How long stopping waits for the work in flight, once it is cancelled. */
const STOP_WAIT_MS = 2_000;
/** Turns one scope takes in a row when the mirror asks it to start over. */
const SCOPE_TURNS_MAX = 3;

const SCOPE_KIND: {
  readonly [Kind in Exclude<
    LedgerContainer['kind'],
    'global'
  >]: LedgerTaskScopeKind;
} = {
  code_worktree: 'code_worktree',
  cowork_entry: 'cowork_entry',
  advisor_entry: 'advisor_entry',
};

const PRIVATE_AUDIENCE: LedgerScopeAudience = { kind: 'private' };

/** What asked for a pass. Only a local change leaves settled scopes alone. */
export type LedgerSyncTrigger = 'local_change' | 'policy' | 'account';

/** A content-free note for diagnostics: a code and a reason, never an ID. */
export interface LedgerSyncDiagnostic {
  readonly code:
    | 'repair'
    | 'paused'
    | 'drain_timeout'
    | 'drain_incomplete'
    | 'rebind_failed'
    | 'global_waiting'
    | 'unexpected';
  readonly detail: string;
}

/** How the wait before a purge ended. */
export type LedgerDrainOutcome =
  /** Nothing is left to send. */
  | 'drained'
  /** The scope may not sync, so nothing was sent. */
  | 'held'
  /** Something is left that could not be sent. */
  | 'incomplete'
  | 'timed_out';

/** A scheduled callback, as `setTimer` returns it. */
export interface LedgerSyncTimer {
  cancel(): void;
}

/** `setTimeout` that never keeps the process alive. */
function setUnrefTimer(run: () => void, delayMs: number): LedgerSyncTimer {
  const handle = setTimeout(run, delayMs);
  if (typeof handle === 'object' && 'unref' in handle) handle.unref();
  return {
    cancel: (): void => {
      clearTimeout(handle);
    },
  };
}

export interface LedgerSyncServiceOptions {
  readonly store: () => LedgerSyncStoreClient;
  readonly mirror: LedgerMirrorClient;
  /** `canopy-ledger-enabled`; nothing is read or sent while it is off. */
  readonly isEnabled: () => boolean;
  /** Whether the Ledger database exists; sync never creates it. */
  readonly databaseExists: () => Promise<boolean>;
  /** The signed-in account and what it shares; null when signed out. */
  readonly readAccount: () => Promise<LedgerSyncAccount | null>;
  /** This launch's writer session; null while the device has no identity. */
  readonly readSession: () => Promise<LedgerWriterSession | null>;
  readonly readWorkspaceOwner: (
    container: LedgerContainer,
  ) => Promise<LedgerWorkspaceOwner>;
  /**
   * Whether the mirror advertises `ledger-global-v1`, the sole gate for
   * global (workflow) scopes. `live` skips what the account last stored and
   * asks the mirror again. Fails closed. Without it, global scopes wait.
   */
  readonly supportsGlobalScopes?: (options: {
    readonly live: boolean;
  }) => Promise<boolean>;
  /** A scope's entries changed sync state without a new revision. */
  readonly onScopeSyncChanged: (
    container: LedgerContainer,
    ledgerId: string,
  ) => void;
  /** The mirror reported a prohibition this device had not heard of. */
  readonly onProhibited: () => void;
  readonly recordDiagnostic: (diagnostic: LedgerSyncDiagnostic) => void;
  readonly now?: () => number;
  /** In [0, 1); jitters a retry delay. */
  readonly random?: () => number;
  /** Defaults to an unreferenced `setTimeout`. */
  readonly setTimer?: (run: () => void, delayMs: number) => LedgerSyncTimer;
  /** Defaults to `LEDGER_SYNC_TIMING`. */
  readonly timing?: Partial<LedgerSyncTiming>;
}

/** How one scope's turn ended. */
type ScopeOutcome =
  /** Done, or nothing to do. */
  | { readonly kind: 'done' }
  /** The scope was marked for repair; the pass moves on. */
  | { readonly kind: 'repair' }
  /** Nothing more can be sent to anyone now. */
  | { readonly kind: 'stop'; readonly failure: LedgerSyncFailure }
  /** The scope's registration changed underneath: take its turn again. */
  | { readonly kind: 'again' }
  /**
   * The account, or what it shares, changed since the turn read it: nothing
   * more is sent under the old choice, and a new pass starts over.
   */
  | { readonly kind: 'superseded' };

const DONE: ScopeOutcome = { kind: 'done' };
const AGAIN: ScopeOutcome = { kind: 'again' };
const SUPERSEDED: ScopeOutcome = { kind: 'superseded' };

/** How a pass ended before every scope had its turn. */
type PassEnd = Extract<ScopeOutcome, { readonly kind: 'stop' | 'superseded' }>;

function stop(failure: LedgerSyncFailure): ScopeOutcome {
  return { kind: 'stop', failure };
}

/** What a pass reads once and every scope's turn uses. */
interface PassTurn {
  readonly account: LedgerSyncAccount;
  readonly session: LedgerWriterSession;
  /** Workspace owners read during the pass, by workspace. */
  readonly owners: Map<string, Promise<LedgerWorkspaceOwner>>;
  /**
   * Whether global (workflow) scopes may sync during the pass. Read once,
   * and turned off for the rest of it when the mirror refuses one.
   */
  globalSupported: boolean;
  /** The service's generation when the account was read. */
  readonly generation: number;
}

/** What the mirror last confirmed for a scope. */
interface MirrorAudience {
  readonly audience: LedgerScopeAudience | null;
  readonly confirmedAt: string | null;
}

const NO_MIRROR_AUDIENCE: MirrorAudience = {
  audience: null,
  confirmedAt: null,
};

function sequenceOf(text: string): bigint {
  return BigInt(text);
}

/** A scope purged or retired while a pass was looking at it. */
function isGoneScopeError(error: unknown): boolean {
  return (
    error instanceof LedgerStorageHostError &&
    (error.reason === 'NOT_FOUND' || error.reason === 'SCOPE_RETIRED')
  );
}

function hasUnsent(record: LedgerScopeSyncRecord): boolean {
  return (
    sequenceOf(record.scope.sequence) > sequenceOf(record.acknowledgedSequence)
  );
}

function toWireEvent(event: LedgerOutboxEventRecord): LedgerSyncEvent {
  const payload: unknown = JSON.parse(event.payloadJson);
  return {
    eventId: event.eventId,
    scopeSequence: event.scopeSequence,
    kind: event.kind,
    entryId: event.entryId,
    entryRevision: event.entryRevision,
    occurredAt: event.occurredAt,
    payloadHash: event.payloadHash,
    payload:
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? { ...payload }
        : {},
  };
}

/** The workspace a container's owner is read from. */
function ownerKey(
  container: Exclude<LedgerContainer, { kind: 'global' }>,
): string {
  return container.kind === 'advisor_entry'
    ? container.appWorkspaceId
    : container.workspaceId;
}

/** The task audience a task scope asks for; policy never names another. */
function taskAudience(
  audience: LedgerRequestedAudience,
): Extract<LedgerRequestedAudience, { kind: 'private' | 'organization' }> {
  return audience.kind === 'organization_global'
    ? { kind: 'private' }
    : audience;
}

/** The global audience a global scope asks for; policy never names another. */
function globalAudience(
  audience: LedgerRequestedAudience,
): Extract<
  LedgerRequestedAudience,
  { kind: 'private' | 'organization_global' }
> {
  return audience.kind === 'organization' ? { kind: 'private' } : audience;
}

/** An organization's lease, which the mirror enforces and sync reconfirms. */
function isOrganizationAudience(audience: {
  readonly kind: LedgerScopeAudience['kind'];
}): boolean {
  return (
    audience.kind === 'organization' || audience.kind === 'organization_global'
  );
}

function isGlobalRecord(record: LedgerScopeSyncRecord): boolean {
  return record.scope.scope.container.kind === 'global';
}

/**
 * A refusal of a global scope that may say the mirror does not take global
 * scopes after all: it refused the request as malformed, or answered as a
 * server without the routes would. Only a fresh capability check tells a
 * rollback from a refusal of this one scope.
 */
function isGlobalRefusal(failure: LedgerSyncFailure): boolean {
  return failure.kind === 'repair' && failure.reason === 'invalid_request';
}

export class LedgerSyncService {
  private readonly options: LedgerSyncServiceOptions;
  /** The writer epoch the mirror gave this launch's session, by ledger. */
  private readonly epochs = new Map<string, string>();
  /** What the mirror holds for each scope, as last read or set. */
  private readonly mirrored = new Map<string, MirrorAudience>();
  /** Ledgers whose project the mirror refused to share with, and until when. */
  private readonly refusedAudiences = new Map<string, number>();
  /** Ledgers the mirror refuses to register under this launch's session. */
  private readonly unregistrable = new Set<string>();
  /** Ledgers in repair that had their one fresh try this launch. */
  private readonly repairTried = new Set<string>();
  /** The account the mirror reported a prohibition for, and until when. */
  private prohibited: { readonly accountId: string; readonly until: number } = {
    accountId: '',
    until: 0,
  };
  private timer: LedgerSyncTimer | null = null;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private running: Promise<void> = Promise.resolve();
  private active = false;
  private rerun = false;
  private stopped = true;
  /** Every scope is due a look, not only those with something to send. */
  private fullPassDue = true;
  /** When the last pass that looked at every scope began. */
  private lastFullPassAt = Number.NEGATIVE_INFINITY;
  /** Cancels the requests in flight when the service stops. */
  private abort = new AbortController();
  /** Counts account and policy changes, so a pass can tell one happened. */
  private generation = 0;
  private pausedUntil = 0;
  private retryAttempts = 0;
  private retryNotBefore = 0;
  /** No pass runs before the startup delay, whatever asks for one. */
  private startupNotBefore = 0;
  /** Drains that timed out and still hold the queue. */
  private stalledDrains = 0;
  /**
   * The mirror's last answer about global scopes, kept until `until`: a
   * mirror without them is asked again only at the next periodic check, or
   * sooner when the account or its policy changes.
   */
  private globalSupport: {
    readonly supported: boolean;
    readonly until: number;
  } | null = null;
  /** The mirror refused a global scope: ask it afresh until it says yes. */
  private globalLiveCheckDue = false;

  private readonly timing: LedgerSyncTiming;

  constructor(options: LedgerSyncServiceOptions) {
    this.options = options;
    this.timing = { ...LEDGER_SYNC_TIMING, ...options.timing };
  }

  /** Begins scheduling. Nothing is read or sent until the first check. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.fullPassDue = true;
    this.startupNotBefore = this.now() + this.timing.startupDelayMs;
    this.schedule(this.timing.startupDelayMs);
  }

  /**
   * Cancels what is scheduled and the requests in flight, then waits a short
   * while for the work in flight to settle. Whatever was not acknowledged
   * stays in the outbox for the next launch.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer();
    this.abort.abort();
    const wait = this.after<'waited'>(STOP_WAIT_MS, 'waited');
    await Promise.race([this.whenIdle(), wait.settled]);
    wait.timer.cancel();
  }

  /** Something changed that sync should look at soon. */
  requestSync(trigger: LedgerSyncTrigger): void {
    if (trigger !== 'local_change') {
      // What the account may send, and where, may be different now, and so
      // may the mirror's answer to it.
      this.generation += 1;
      this.pausedUntil = 0;
      this.fullPassDue = true;
      this.prohibited = { accountId: '', until: 0 };
      this.refusedAudiences.clear();
      // A reconnect or an account refresh may bring global scopes.
      this.globalSupport = null;
    }
    if (this.stopped) return;
    this.schedule(
      trigger === 'local_change'
        ? this.timing.localChangeDelayMs
        : this.timing.policyChangeDelayMs,
    );
  }

  /**
   * Why an unsent revision of a scope bound to `scopeAccountId` is not on its
   * way, or null when it is: the label the host shows for it.
   */
  async holdFor(scopeAccountId: string | null): Promise<LedgerSyncHold | null> {
    const account = await this.readAccount();
    if (!isLedgerScopeOfAccount(scopeAccountId, account)) return 'local_only';
    return ledgerAccountHold(account);
  }

  /**
   * Whether the mirror still holds another audience than the one the scope's
   * sharing resolves to now. False for a scope the mirror never registered,
   * and for one only another account could change.
   */
  async isAudienceChangePending(
    scope: LedgerSyncScope & { readonly ledgerId: string },
  ): Promise<boolean> {
    const { audience } = await this.mirrorAudienceOf(scope.ledgerId);
    if (audience === null) return false;
    const account = await this.readAccount();
    const disposition = await this.dispositionOf(scope, account, new Map());
    if (disposition.kind === 'hold' && !disposition.canNarrow) return false;
    return !isLedgerAudienceApplied(
      this.requestedAudience(scope.ledgerId, disposition),
      this.liveAudience(audience),
    );
  }

  /**
   * Sends what a scope still has to send before it is purged, waiting at most
   * `timeoutMs`. A scope that may not sync is not sent, and that is not a
   * failure. Never rejects.
   */
  async drainScope(
    ledgerId: string,
    timeoutMs: number = this.timing.drainTimeoutMs,
  ): Promise<LedgerDrainOutcome> {
    // A request that hangs holds the queue: the scopes deleted meanwhile do
    // not each wait out their own timeout behind it.
    if (this.stalledDrains > 0) {
      this.options.recordDiagnostic({ code: 'drain_incomplete', detail: '1' });
      return 'incomplete';
    }
    const timeout = this.after<'timed_out'>(timeoutMs, 'timed_out');
    const drained = this.enqueue(
      (): Promise<LedgerDrainOutcome> => this.drain(ledgerId),
    ).catch((): LedgerDrainOutcome => 'incomplete');
    const outcome = await Promise.race([drained, timeout.settled]);
    timeout.timer.cancel();
    if (outcome === 'timed_out') {
      this.stalledDrains += 1;
      void drained.then((): void => {
        this.stalledDrains -= 1;
        this.forget(ledgerId);
      });
      this.options.recordDiagnostic({ code: 'drain_timeout', detail: '1' });
      return outcome;
    }
    this.forget(ledgerId);
    if (outcome === 'incomplete') {
      this.options.recordDiagnostic({ code: 'drain_incomplete', detail: '1' });
    }
    return outcome;
  }

  /**
   * Moves a merged guest account's scopes to the account it became, once the
   * server confirmed the merge, and resumes their sync. Returns how many
   * scopes moved.
   */
  async rebindMergedGuest(
    fromAccountId: string,
    toAccountId: string,
  ): Promise<number> {
    const { rebound } = await this.enqueue(() =>
      this.options.store().rebindAccount({ fromAccountId, toAccountId }),
    );
    this.requestSync('account');
    return rebound;
  }

  /** Resolves once nothing is running or queued. */
  async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.running;
      await observed;
    } while (observed !== this.running);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setTimer(run: () => void, delayMs: number): LedgerSyncTimer {
    return (this.options.setTimer ?? setUnrefTimer)(run, delayMs);
  }

  /** `value` after `delayMs`, and the timer to cancel when it is not needed. */
  private after<Value>(
    delayMs: number,
    value: Value,
  ): { readonly settled: Promise<Value>; readonly timer: LedgerSyncTimer } {
    let timer: LedgerSyncTimer = { cancel: (): void => undefined };
    const settled = new Promise<Value>((resolve) => {
      timer = this.setTimer((): void => resolve(value), delayMs);
    });
    return { settled, timer };
  }

  private cancelTimer(): void {
    this.timer?.cancel();
    this.timer = null;
    this.timerDueAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Runs a pass after `delayMs`, or once startup, a backoff or a pause is
   * over if that is later, unless one is already due sooner.
   */
  private schedule(delayMs: number): void {
    const dueAt = Math.max(
      this.now() + delayMs,
      this.startupNotBefore,
      this.retryNotBefore,
      this.pausedUntil,
    );
    if (this.timer !== null && this.timerDueAt <= dueAt) return;
    this.cancelTimer();
    this.timerDueAt = dueAt;
    this.timer = this.setTimer(
      (): void => {
        this.timer = null;
        this.timerDueAt = Number.POSITIVE_INFINITY;
        void this.runPass();
      },
      Math.max(0, dueAt - this.now()),
    );
  }

  /** Runs `task` after everything already queued: one thing at a time. */
  private enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const result = this.running.then(task);
    this.running = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private runPass(): Promise<void> {
    if (this.active) {
      this.rerun = true;
      return this.running;
    }
    this.active = true;
    return this.enqueue(async (): Promise<void> => {
      try {
        await this.pass();
      } catch {
        // A pass never throws into the event loop; it is tried again later.
        this.options.recordDiagnostic({ code: 'unexpected', detail: 'pass' });
        this.fullPassDue = true;
        this.backOff(undefined);
      } finally {
        this.active = false;
        if (!this.stopped) {
          const again = this.rerun;
          this.rerun = false;
          this.schedule(again ? 0 : this.timing.periodicCheckMs);
        }
      }
    });
  }

  /**
   * The signed-in account, read now, under any prohibition the mirror
   * reported for it. An account that cannot be read sends nothing.
   */
  private async readAccount(): Promise<LedgerSyncAccount | null> {
    let account: LedgerSyncAccount | null;
    try {
      account = await this.options.readAccount();
    } catch {
      return null;
    }
    return account !== null &&
      account.id === this.prohibited.accountId &&
      this.now() < this.prohibited.until
      ? { ...account, summariesProhibited: true }
      : account;
  }

  private async mirrorAudienceOf(ledgerId: string): Promise<MirrorAudience> {
    const known = this.mirrored.get(ledgerId);
    if (known !== undefined) return known;
    if (!(await this.options.databaseExists())) return NO_MIRROR_AUDIENCE;
    const record = await this.options.store().getScopeSync(ledgerId);
    if (record === null) return NO_MIRROR_AUDIENCE;
    return this.rememberMirror(record);
  }

  private rememberMirror(record: LedgerScopeSyncRecord): MirrorAudience {
    const mirror: MirrorAudience = {
      audience: record.mirrorAudience,
      confirmedAt: record.audienceConfirmedAt,
    };
    this.mirrored.set(record.scope.scope.ledgerId, mirror);
    return mirror;
  }

  /** Drops what this launch remembers of a ledger that is gone. */
  private forget(ledgerId: string): void {
    this.epochs.delete(ledgerId);
    this.mirrored.delete(ledgerId);
    this.refusedAudiences.delete(ledgerId);
    this.unregistrable.delete(ledgerId);
    this.repairTried.delete(ledgerId);
  }

  private async dispositionOf(
    scope: LedgerSyncScope,
    account: LedgerSyncAccount | null,
    owners: Map<string, Promise<LedgerWorkspaceOwner>>,
  ): Promise<LedgerSyncDisposition> {
    // Only a scope that may be shared needs its workspace's owner read. A
    // global one's owner is its container's.
    let owner: LedgerWorkspaceOwner = { kind: 'unknown' };
    const { container } = scope;
    if (
      isLedgerScopeOfAccount(scope.accountId, account) &&
      account.summaries === 'organization' &&
      container.kind !== 'advisor_entry' &&
      container.kind !== 'global'
    ) {
      const key = ownerKey(container);
      let reading = owners.get(key);
      if (reading === undefined) {
        reading = this.options
          .readWorkspaceOwner(container)
          .catch((): LedgerWorkspaceOwner => ({ kind: 'unknown' }));
        owners.set(key, reading);
      }
      owner = await reading;
    }
    return resolveLedgerSyncDisposition(scope, account, owner);
  }

  /** The audience to ask for: private once the mirror refused the project. */
  private requestedAudience(
    ledgerId: string,
    disposition: LedgerSyncDisposition,
  ): LedgerRequestedAudience {
    return (this.refusedAudiences.get(ledgerId) ?? 0) > this.now()
      ? PRIVATE_AUDIENCE
      : desiredLedgerAudience(disposition);
  }

  /** What the mirror enforces: a lapsed organization lease reads private. */
  private liveAudience(audience: LedgerScopeAudience): LedgerScopeAudience {
    return audience.kind !== 'private' &&
      Date.parse(audience.expiresAt) <= this.now()
      ? PRIVATE_AUDIENCE
      : audience;
  }

  /**
   * Whether global scopes may sync now: only once the mirror advertises
   * `ledger-global-v1` (Decision 11). A missing or failing answer waits.
   */
  private async isGlobalSupported(): Promise<boolean> {
    const now = this.now();
    if (this.globalSupport !== null && now < this.globalSupport.until) {
      return this.globalSupport.supported;
    }
    const check = this.options.supportsGlobalScopes;
    let supported = false;
    if (check !== undefined) {
      try {
        supported = await check({ live: this.globalLiveCheckDue });
      } catch {
        supported = false;
      }
    }
    // After a rollback the account's stored list may still name the
    // capability, so only a live yes ends the live checks.
    if (supported) this.globalLiveCheckDue = false;
    // A yes is asked again each pass for free (the account stores it); a no
    // is kept until the next periodic check.
    this.globalSupport = {
      supported,
      until: supported ? now : now + this.timing.periodicCheckMs,
    };
    return supported;
  }

  /**
   * Whether the mirror, asked afresh after refusing a global scope, no longer
   * advertises global scopes: a rollback, not a refusal of that scope alone.
   */
  private async globalRolledBack(): Promise<boolean> {
    this.globalSupport = null;
    this.globalLiveCheckDue = true;
    return !(await this.isGlobalSupported());
  }

  /**
   * The mirror refused a global scope and, asked afresh, no longer advertises
   * support, as when it rolled back: every global scope waits again, the
   * capability is asked afresh at the next periodic check, and nothing is
   * marked for repair.
   */
  private globalRefused(turn: PassTurn, detail: string): ScopeOutcome {
    turn.globalSupported = false;
    this.globalSupport = {
      supported: false,
      until: this.now() + this.timing.periodicCheckMs,
    };
    this.globalLiveCheckDue = true;
    this.options.recordDiagnostic({ code: 'global_waiting', detail });
    return DONE;
  }

  private async pass(): Promise<void> {
    if (this.stopped || !this.options.isEnabled()) return;
    const startedAt = this.now();
    // The check that follows a backoff or a pause is already scheduled.
    if (startedAt < this.retryNotBefore || startedAt < this.pausedUntil) {
      this.rerun = true;
      return;
    }
    if (!(await this.options.databaseExists())) return;
    // Every scope is looked at after a change of policy, and at least every
    // periodic check, so idle organization leases are reconfirmed.
    const full =
      this.fullPassDue ||
      startedAt - this.lastFullPassAt >= this.timing.periodicCheckMs;
    this.fullPassDue = false;
    const generation = this.generation;
    const account = await this.readAccount();
    const session = await this.options.readSession();
    const records = (await this.options.store().listSyncScopes()).filter(
      // A retiring scope is drained by its purge.
      (record) => record.scope.lifecycleState !== 'retirement_pending',
    );
    for (const record of records) this.rememberMirror(record);
    // Signed out, nothing is the account's to send or to narrow.
    if (account === null || session === null) return;
    const turn: PassTurn = {
      account,
      session,
      owners: new Map(),
      generation,
      // Only the account's own global scopes sync, so only they ask.
      globalSupported: records.some(
        (record) =>
          isGlobalRecord(record) &&
          isLedgerScopeOfAccount(record.scope.accountId, account),
      )
        ? await this.isGlobalSupported()
        : false,
    };
    const ended = await this.syncScopes(records, turn, full);
    if (ended === null) {
      this.retryAttempts = 0;
      if (full) this.lastFullPassAt = startedAt;
      return;
    }
    if (ended.kind === 'superseded') {
      this.startOver();
      return;
    }
    // What this pass left undone is looked at again by the next.
    this.fullPassDue = this.fullPassDue || full;
    this.stopFor(ended.failure, generation);
  }

  /**
   * After the account or its sharing changed under a pass: the next one reads
   * them again and sends every audience change before anything else (LD01).
   */
  private startOver(): void {
    this.fullPassDue = true;
    if (!this.stopped) this.schedule(this.timing.policyChangeDelayMs);
  }

  /**
   * Gives every scope its turn. Changes of who may read a scope travel first,
   * before anything queued is sent (LD01). Returns what ended the pass early,
   * or null.
   */
  private async syncScopes(
    records: readonly LedgerScopeSyncRecord[],
    turn: PassTurn,
    full: boolean,
  ): Promise<PassEnd | null> {
    if (full) {
      const ended = await this.eachScope(records, (record) =>
        this.changeAudience(record, turn),
      );
      if (ended !== null) return ended;
    }
    return this.eachScope(
      full ? records : records.filter(hasUnsent),
      (record) => this.syncScope(record, turn),
    );
  }

  /** Gives each scope a turn, until one ends the pass. */
  private async eachScope(
    records: readonly LedgerScopeSyncRecord[],
    take: (record: LedgerScopeSyncRecord) => Promise<ScopeOutcome>,
  ): Promise<PassEnd | null> {
    for (const record of records) {
      if (this.stopped) return null;
      const outcome = await this.guarded(() => take(record));
      if (outcome.kind === 'stop' || outcome.kind === 'superseded') {
        return outcome;
      }
    }
    return null;
  }

  /**
   * Whether the account, or what it shares, changed since the turn read it.
   * Asked before every request, so nothing planned under a wider choice is
   * sent once a narrower one is made (LD01).
   */
  private async isSuperseded(turn: PassTurn): Promise<boolean> {
    if (turn.generation !== this.generation) return true;
    const account = await this.readAccount();
    return (
      turn.generation !== this.generation ||
      ledgerSyncPolicyKey(account) !== ledgerSyncPolicyKey(turn.account)
    );
  }

  /** A scope purged or retired meanwhile ends its own turn, not the pass. */
  private async guarded(
    turn: () => Promise<ScopeOutcome>,
  ): Promise<ScopeOutcome> {
    try {
      return await turn();
    } catch (error) {
      if (isGoneScopeError(error)) return DONE;
      throw error;
    }
  }

  /** What a failure that ends the pass means for everything else. */
  private stopFor(failure: LedgerSyncFailure, generation: number): void {
    switch (failure.kind) {
      case 'retry':
        this.backOff(failure.retryAfterMs);
        return;
      case 'prohibited':
        // The mirror's word stands until the next periodic check; the next
        // pass holds, and narrows, every scope of the account under it.
        this.rerun = true;
        return;
      case 'paused':
      case 'stale_binding':
      case 'audience_forbidden':
      case 'not_registered':
      case 'repair':
        // The account or its policy changed while the request was out: what
        // was refused may not be what would be sent now.
        if (generation !== this.generation) {
          this.rerun = true;
          return;
        }
        this.pausedUntil = this.now() + this.timing.periodicCheckMs;
        this.options.recordDiagnostic({ code: 'paused', detail: failure.kind });
    }
  }

  private backOff(retryAfterMs: number | undefined): void {
    const exponential = Math.min(
      this.timing.retryMaxMs,
      this.timing.retryInitialMs * 2 ** this.retryAttempts,
    );
    // Half to all of the delay, so devices do not retry in step.
    const jittered =
      exponential * (0.5 + 0.5 * (this.options.random ?? Math.random)());
    const delay =
      retryAfterMs === undefined
        ? jittered
        : Math.min(RETRY_AFTER_MAX_MS, Math.max(retryAfterMs, jittered));
    this.retryAttempts += 1;
    this.retryNotBefore = this.now() + delay;
    this.rerun = true;
  }

  /** The audience a scope's sharing resolves to, beside what the mirror holds. */
  private async planFor(
    record: LedgerScopeSyncRecord,
    turn: PassTurn,
  ): Promise<{
    readonly disposition: LedgerSyncDisposition;
    readonly audience: LedgerRequestedAudience;
    readonly mirror: MirrorAudience;
    readonly applied: boolean;
  }> {
    const { ledgerId, container } = record.scope.scope;
    const disposition = await this.dispositionOf(
      { accountId: record.scope.accountId, container },
      turn.account,
      turn.owners,
    );
    const audience = this.requestedAudience(ledgerId, disposition);
    const mirror = this.mirrored.get(ledgerId) ?? this.rememberMirror(record);
    return {
      disposition,
      audience,
      mirror,
      applied: isLedgerAudienceApplied(audience, mirror.audience),
    };
  }

  /**
   * Tells the mirror of a change in who may read a scope it already holds. A
   * scope that waits is only ever narrowed, and only by its own account.
   */
  private async changeAudience(
    record: LedgerScopeSyncRecord,
    turn: PassTurn,
  ): Promise<ScopeOutcome> {
    const { ledgerId } = record.scope.scope;
    if (this.unregistrable.has(ledgerId)) return DONE;
    // A global scope waits for a mirror that holds global scopes.
    if (isGlobalRecord(record) && !turn.globalSupported) return DONE;
    const plan = await this.planFor(record, turn);
    if (plan.mirror.audience === null || plan.applied) return DONE;
    if (plan.disposition.kind === 'hold') {
      if (
        !plan.disposition.canNarrow ||
        !isOrganizationAudience(plan.mirror.audience)
      ) {
        return DONE;
      }
      return this.register(record, turn, plan.audience, { narrowing: true });
    }
    const outcome = await this.register(record, turn, plan.audience, {
      narrowing: false,
    });
    // A project the mirror refused is asked for again as private.
    return outcome.kind === 'again'
      ? this.register(record, turn, PRIVATE_AUDIENCE, { narrowing: false })
      : outcome;
  }

  /** One scope's turn, taken again when the mirror asks it to start over. */
  private async syncScope(
    record: LedgerScopeSyncRecord,
    turn: PassTurn,
  ): Promise<ScopeOutcome> {
    let current = record;
    for (let taken = 0; taken < SCOPE_TURNS_MAX; taken += 1) {
      const outcome = await this.syncScopeOnce(current, turn);
      if (outcome.kind !== 'again') return outcome;
      const fresh = await this.options
        .store()
        .getScopeSync(record.scope.scope.ledgerId);
      if (fresh === null) return DONE;
      current = fresh;
    }
    // Still asked to start over: everything waits before it is tried again.
    return stop({ kind: 'retry' });
  }

  private async syncScopeOnce(
    record: LedgerScopeSyncRecord,
    turn: PassTurn,
  ): Promise<ScopeOutcome> {
    const { ledgerId } = record.scope.scope;
    if (this.unregistrable.has(ledgerId)) return DONE;
    // A global scope waits, its events held in order, for a mirror that
    // holds global scopes; it is never marked for repair over it.
    if (isGlobalRecord(record) && !turn.globalSupported) return DONE;
    const plan = await this.planFor(record, turn);
    // A scope that waits uploads nothing; `changeAudience` narrows it.
    if (plan.disposition.kind === 'hold') return DONE;
    const sending = this.wantsToSend(record);
    if (
      this.isRegistrationDue(plan) ||
      (sending && !this.epochs.has(ledgerId))
    ) {
      const registered = await this.register(record, turn, plan.audience, {
        narrowing: false,
      });
      if (registered.kind !== 'done') return registered;
    }
    const writerEpoch = this.epochs.get(ledgerId);
    if (!sending || writerEpoch === undefined) return DONE;
    const pushed = await this.pushOutbox(record, turn, writerEpoch);
    // Everything it had was taken: the scope syncs again.
    if (pushed.kind === 'done' && record.repairReason !== null) {
      await this.repaired(record);
    }
    return pushed;
  }

  /**
   * Whether a scope's turn sends its outbox: what it has not sent yet, unless
   * it needs repair, which is tried once more each launch.
   */
  private wantsToSend(record: LedgerScopeSyncRecord): boolean {
    return record.repairReason === null
      ? hasUnsent(record)
      : !this.repairTried.has(record.scope.scope.ledgerId);
  }

  /** Whether the mirror must hear the scope's audience again first. */
  private isRegistrationDue(plan: {
    readonly audience: LedgerRequestedAudience;
    readonly mirror: MirrorAudience;
    readonly applied: boolean;
  }): boolean {
    return (
      !plan.applied ||
      (isOrganizationAudience(plan.audience) &&
        this.isLeaseDue(plan.mirror.confirmedAt))
    );
  }

  /** Whether an organization lease is old enough to reconfirm. */
  private isLeaseDue(confirmedAt: string | null): boolean {
    return (
      confirmedAt === null ||
      this.now() - Date.parse(confirmedAt) >=
        LEDGER_SYNC_LIMITS.audienceReconfirmMs
    );
  }

  private async register(
    record: LedgerScopeSyncRecord,
    turn: PassTurn,
    audience: LedgerRequestedAudience,
    options: { readonly narrowing: boolean },
  ): Promise<ScopeOutcome> {
    if (await this.isSuperseded(turn)) return SUPERSEDED;
    const { ledgerId, container } = record.scope.scope;
    const writerEpoch = this.epochs.get(ledgerId);
    const common = {
      ledgerId,
      accountId: turn.account.id,
      session: turn.session,
      ...(writerEpoch === undefined ? {} : { writerEpoch }),
    };
    // A global scope registers at version 2 and pins the owner its container
    // names, private or not; a task scope at version 1.
    const request: LedgerScopeRegisterRequest =
      container.kind === 'global'
        ? {
            schemaVersion: LEDGER_SYNC_GLOBAL_SCHEMA_VERSION,
            ...common,
            scopeKind: 'global',
            globalOwner: container.owner,
            audience: globalAudience(audience),
          }
        : {
            schemaVersion: LEDGER_SYNC_SCHEMA_VERSION,
            ...common,
            scopeKind: SCOPE_KIND[container.kind],
            audience: taskAudience(audience),
          };
    const result = await this.options.mirror.register(
      request,
      this.abort.signal,
    );
    if (!result.ok) {
      if (
        isGlobalRecord(record) &&
        isGlobalRefusal(result.failure) &&
        (await this.globalRolledBack())
      ) {
        return this.globalRefused(turn, 'register');
      }
      return this.registrationRefused(record, result.failure, {
        ...options,
        audience,
        accountId: turn.account.id,
      });
    }
    this.epochs.set(ledgerId, result.value.writerEpoch);
    await this.rememberAudience(record, result.value.audience);
    const mirrorHolds = sequenceOf(result.value.acknowledgedSequence);
    // The mirror holds events this device never wrote: another writer's.
    if (mirrorHolds > sequenceOf(record.scope.sequence)) {
      return this.needsRepair(record, 'mirror_ahead');
    }
    // It holds less than it acknowledged, and those events are gone here.
    if (mirrorHolds < sequenceOf(record.acknowledgedSequence)) {
      return this.needsRepair(record, 'sequence_gap');
    }
    return DONE;
  }

  private async registrationRefused(
    record: LedgerScopeSyncRecord,
    failure: LedgerSyncFailure,
    request: {
      readonly narrowing: boolean;
      readonly audience: LedgerRequestedAudience;
      readonly accountId: string;
    },
  ): Promise<ScopeOutcome> {
    const { ledgerId } = record.scope.scope;
    switch (failure.kind) {
      case 'audience_forbidden':
        // The mirror dropped the scope's audience as it refused.
        await this.rememberAudience(record, PRIVATE_AUDIENCE);
        if (request.audience.kind === 'private') return stop(failure);
        // The project cannot share this scope: it syncs privately instead.
        this.refusedAudiences.set(
          ledgerId,
          this.now() + this.timing.periodicCheckMs,
        );
        return AGAIN;
      case 'prohibited':
        // The mirror dropped the scope's audience as it refused.
        await this.rememberAudience(record, PRIVATE_AUDIENCE);
        if (request.narrowing) return DONE;
        this.holdProhibited(request.accountId);
        return stop(failure);
      case 'not_registered':
        // Another account holds this ledger in the mirror.
        this.unregistrable.add(ledgerId);
        return this.needsRepair(record, 'invalid_request');
      case 'repair':
        this.unregistrable.add(ledgerId);
        return this.needsRepair(record, failure.reason);
      case 'stale_binding':
      case 'retry':
      case 'paused':
        return stop(failure);
    }
  }

  /** The mirror reported a prohibition: the account's scopes wait under it. */
  private holdProhibited(accountId: string): void {
    const known =
      this.prohibited.accountId === accountId &&
      this.now() < this.prohibited.until;
    this.prohibited = {
      accountId,
      until: this.now() + this.timing.periodicCheckMs,
    };
    this.fullPassDue = true;
    if (!known) this.options.onProhibited();
  }

  /** Records what the mirror now holds, and tells views when it changed. */
  private async rememberAudience(
    record: LedgerScopeSyncRecord,
    audience: LedgerScopeAudience,
  ): Promise<void> {
    const { ledgerId, container } = record.scope.scope;
    const before = this.mirrored.get(ledgerId)?.audience ?? null;
    const updated = await this.options
      .store()
      .recordMirrorAudience({ ledgerId, audience });
    this.rememberMirror(updated);
    if (
      before === null ||
      before.kind !== audience.kind ||
      (before.kind === 'organization' &&
        audience.kind === 'organization' &&
        before.trackedWorkspaceId !== audience.trackedWorkspaceId) ||
      (before.kind === 'organization_global' &&
        audience.kind === 'organization_global' &&
        before.organizationId !== audience.organizationId)
    ) {
      this.options.onScopeSyncChanged(container, ledgerId);
    }
  }

  private async needsRepair(
    record: LedgerScopeSyncRecord,
    reason: LedgerSyncRepairReason,
  ): Promise<ScopeOutcome> {
    const { ledgerId, container } = record.scope.scope;
    this.repairTried.add(ledgerId);
    await this.options.store().setScopeRepair({ ledgerId, reason });
    this.options.recordDiagnostic({ code: 'repair', detail: reason });
    this.options.onScopeSyncChanged(container, ledgerId);
    return { kind: 'repair' };
  }

  private async repaired(record: LedgerScopeSyncRecord): Promise<void> {
    const { ledgerId, container } = record.scope.scope;
    await this.options.store().setScopeRepair({ ledgerId, reason: null });
    this.options.onScopeSyncChanged(container, ledgerId);
  }

  /** Pushes the scope's outbox, a batch at a time, until it is empty. */
  private async pushOutbox(
    record: LedgerScopeSyncRecord,
    turn: PassTurn,
    writerEpoch: string,
  ): Promise<ScopeOutcome> {
    const { ledgerId, container } = record.scope.scope;
    let acknowledged = record.acknowledgedSequence;
    for (;;) {
      if (this.stopped) return stop({ kind: 'retry' });
      const events = await this.options.store().readOutbox({
        ledgerId,
        afterSequence: acknowledged,
        limit: LEDGER_SYNC_LIMITS.pushEventsMax,
        maxPayloadBytes: PUSH_PAYLOAD_BYTES,
      });
      const last = events[events.length - 1];
      if (last === undefined) return DONE;
      if (await this.isSuperseded(turn)) return SUPERSEDED;
      const result = await this.options.mirror.push(
        {
          // One push carries one scope, so never mixes versions.
          schemaVersion:
            container.kind === 'global'
              ? LEDGER_SYNC_GLOBAL_SCHEMA_VERSION
              : LEDGER_SYNC_SCHEMA_VERSION,
          ledgerId,
          accountId: turn.account.id,
          writerEpoch,
          acknowledgedSequence: acknowledged,
          events: events.map(toWireEvent),
        },
        this.abort.signal,
      );
      if (!result.ok) {
        if (
          isGlobalRecord(record) &&
          isGlobalRefusal(result.failure) &&
          (await this.globalRolledBack())
        ) {
          return this.globalRefused(turn, 'push');
        }
        return this.pushRefused(record, result.failure, turn.account.id);
      }
      // Only what this batch carried is acknowledged, and no more than the
      // mirror says it holds: anything further it claims is replayed, and so
      // checked, by the next batch.
      const sent = sequenceOf(last.scopeSequence);
      const held = sequenceOf(result.value.acknowledgedSequence);
      const upTo = held < sent ? held : sent;
      // A batch taken without anything held is tried again later, not now.
      if (upTo <= sequenceOf(acknowledged)) return stop({ kind: 'retry' });
      acknowledged = upTo.toString();
      await this.options
        .store()
        .acknowledgeOutbox({ ledgerId, sequence: acknowledged });
      this.options.onScopeSyncChanged(container, ledgerId);
    }
  }

  private async pushRefused(
    record: LedgerScopeSyncRecord,
    failure: LedgerSyncFailure,
    accountId: string,
  ): Promise<ScopeOutcome> {
    const { ledgerId } = record.scope.scope;
    switch (failure.kind) {
      case 'not_registered':
        // The mirror lost the registration: register again, then push.
        this.epochs.delete(ledgerId);
        return AGAIN;
      case 'repair':
        // Another session holds the scope: this one cannot register it either.
        if (failure.reason === 'stale_writer') this.unregistrable.add(ledgerId);
        return this.needsRepair(record, failure.reason);
      case 'prohibited':
        // The mirror dropped the scope's audience as it refused.
        await this.rememberAudience(record, PRIVATE_AUDIENCE);
        this.holdProhibited(accountId);
        return stop(failure);
      case 'audience_forbidden':
      case 'stale_binding':
      case 'retry':
      case 'paused':
        return stop(failure);
    }
  }

  /**
   * One retiring scope's turn, outside the passes that skip it. When the
   * account or its sharing changes meanwhile, it is taken once more under
   * what they changed to.
   */
  private async drain(ledgerId: string): Promise<LedgerDrainOutcome> {
    const outcome = await this.drainOnce(ledgerId);
    if (outcome !== 'superseded') return outcome;
    this.startOver();
    const retried = await this.drainOnce(ledgerId);
    return retried === 'superseded' ? 'incomplete' : retried;
  }

  private async drainOnce(
    ledgerId: string,
  ): Promise<LedgerDrainOutcome | 'superseded'> {
    if (!this.options.isEnabled()) return 'held';
    const record = await this.options.store().getScopeSync(ledgerId);
    if (record === null || !hasUnsent(record)) return 'drained';
    const generation = this.generation;
    const account = await this.readAccount();
    const scope: LedgerSyncScope = {
      accountId: record.scope.accountId,
      container: record.scope.scope.container,
    };
    const owners = new Map<string, Promise<LedgerWorkspaceOwner>>();
    const disposition = await this.dispositionOf(scope, account, owners);
    if (account === null || disposition.kind === 'hold') return 'held';
    const session = await this.options.readSession();
    const now = this.now();
    if (
      session === null ||
      record.repairReason !== null ||
      now < this.retryNotBefore ||
      now < this.pausedUntil
    ) {
      return 'incomplete';
    }
    this.rememberMirror(record);
    const outcome = await this.syncScope(record, {
      account,
      session,
      owners,
      generation,
      // Only task scopes retire, so a drain never sends a global one.
      globalSupported: false,
    });
    if (outcome.kind === 'superseded') return 'superseded';
    if (outcome.kind === 'stop') this.drainStopped(outcome.failure, generation);
    const after = await this.options.store().getScopeSync(ledgerId);
    return after === null || !hasUnsent(after) ? 'drained' : 'incomplete';
  }

  /** What a failure that ended a drain means for everything else. */
  private drainStopped(failure: LedgerSyncFailure, generation: number): void {
    this.stopFor(failure, generation);
    // No pass is running to schedule what follows a backoff or a pause.
    if (this.active) return;
    this.rerun = false;
    if (!this.stopped) this.schedule(0);
  }
}

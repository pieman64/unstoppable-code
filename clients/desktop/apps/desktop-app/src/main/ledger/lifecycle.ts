import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isArchivedContainerManifest } from '@canopy/desktop-shared/lib/archived-container-contracts';
import type { LedgerScopeRecord } from '@canopy/desktop-shared/node/ledger';
// Only the pure time helper: the store itself runs in the storage worker.
import { canonicalizeLedgerInstant } from '@canopy/desktop-shared/node/ledger/time';
import type {
  ArchivedContainerKind,
  ArchivedContainerManifest,
  WorkspaceType,
} from '@canopy/desktop-shared/types';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import { parseWorkEntriesFile } from '../lib/cowork-work-entries-file';
import {
  getArchivedContainerDir,
  getArchivedContainerManifestPath,
  getLedgerDatabasePath,
  getLedgerLifecycleIntentsPath,
  getWorkspaceWorkEntriesFilePath,
} from '../lib/paths';
import { getWorkspaceIndexRepository } from '../lib/sidebar-items';
import { readWorkspaceWorktreesUnlocked } from '../lib/workspace-persistence';
import { getObservabilityService } from '../observability';
import {
  invalidateLedgerOwnerEligibility,
  withLedgerOwnerAdmission,
  type LedgerOwnerEligibilityTarget,
} from './actor-directory';
import {
  getLedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistry,
} from './caller-bindings';
import type { LedgerStoreClient } from './ledger-store-client';
import {
  archivedLedgerIncarnation,
  isSafeLedgerContainerId,
  workEntryLedgerIncarnation,
  worktreeLedgerIncarnation,
} from './lifecycle-containers';
import {
  createLedgerLifecycleIntentFile,
  DEFAULT_MAX_INTENTS,
  LedgerLifecycleIntentError,
  LedgerLifecycleIntentJournal,
  ledgerIncarnationKey,
  ledgerIntentGapCovers,
  ledgerIntentIdentity,
  type LedgerLifecycleIntent,
  type LedgerLifecycleIntentKey,
  type LedgerLifecycleIntentKind,
} from './lifecycle-intents';
import { ledgerContainerKey } from './scope-bindings';
import { getLedgerStoreClient } from './storage-client';
import { drainLedgerScopeBeforePurge, requestLedgerSync } from './sync-host';
import { LedgerStorageHostError } from './storage-host';

/*
 * Keeps every local Ledger scope in step with its container (LD10, E04).
 * Host code calls a participant once the container's own state change has
 * committed: archive makes the scope read-only, permanent deletion and
 * retention purge retire and purge it, restore reattaches it to the restored
 * container, and a move to another workspace takes it along. A participant
 * returns at once and never throws. Its work runs later, in order per
 * container, holds no host lock, and a failure only records a content-free
 * diagnostic. The startup pass settles whatever a participant missed,
 * including deletions made through the CLI while the app was closed and moves
 * interrupted before their participant ran.
 *
 * A restore or a move that would otherwise leave its old → new mapping only in
 * memory first records an intent in the durable intent journal
 * (`lifecycle-intents.ts`, `lifecycle-intents.json` beside the database). The
 * host awaits that write before its commit, for a bounded time; the write
 * never rejects. When the database exists and the write is not durable, the
 * mapping must not become memory-only: a restore keeps its archive, and a
 * move or the deletion of a partially restored archive refuses, so it can be
 * retried. The participant removes the intent once it has applied it.
 *
 * Intents chain when a container is restored and then moved, or moved twice,
 * before its participants ran: each hop's destination is the next hop's
 * source. The startup pass resolves what remains before anything else. It
 * follows each chain in recorded order, only to later hops, to the place its
 * container is now, moves the scope straight there, and then clears the whole
 * chain. A hop whose source is still live never committed and is dropped. A
 * chain that a read cannot settle stays, and no scope on it retires. Nor does
 * a scope that an intent the journal may have lost could name: one covered by
 * the journal's gap (`lifecycle-intents.ts`) is kept instead.
 *
 * Nothing here opens the Ledger database. Every step first checks that the
 * file exists, with `stat` alone, so a container that never used the Ledger
 * neither creates the database nor starts the storage worker.
 */

/** A container at one incarnation: its identifiers and its own creation time. */
export interface LedgerContainerIncarnation {
  readonly container: LedgerContainer;
  /** The container's creation time (RFC 3339), as persisted. */
  readonly containerCreatedAt: string;
}

export interface LedgerContainerArchivedOptions {
  /** True when the container was archived with retention, false when deleted. */
  readonly retained: boolean;
}

/**
 * The container was archived (`retained: true`) or permanently deleted
 * (`retained: false`). Call after the container's own state change commits.
 * Returns at once and never throws.
 */
export function notifyLedgerContainerArchived(
  incarnation: LedgerContainerIncarnation,
  options: LedgerContainerArchivedOptions,
): void {
  try {
    getDesktopLedgerLifecycle().containerArchived(incarnation, options);
  } catch {
    // Participants never throw; the startup pass settles the scope.
  }
}

/**
 * An archived container was restored into a new incarnation. Call after the
 * restore commits. Returns at once and never throws.
 */
export function notifyLedgerContainerRestored(
  archived: LedgerContainerIncarnation,
  restored: LedgerContainerIncarnation,
): void {
  try {
    getDesktopLedgerLifecycle().containerRestored(archived, restored);
  } catch {
    // Participants never throw; the startup pass settles the scope.
  }
}

/**
 * A live container moved to another parent, for example a worktree split out
 * of, or combined into, a temporary workspace, and now persists as `to`. Call
 * after the move commits. The scope follows the container and keeps its
 * ledger. Returns at once and never throws.
 */
export function notifyLedgerContainerMoved(
  from: LedgerContainerIncarnation,
  to: LedgerContainerIncarnation,
): void {
  try {
    getDesktopLedgerLifecycle().containerMoved(from, to);
  } catch {
    // Participants never throw; the startup pass settles the scope.
  }
}

/**
 * Whether a host's intent is safe to rely on: `recorded` durably in the
 * journal, or `not_needed` because no Ledger database exists. `not_durable`
 * otherwise: the write failed, timed out or was refused because the journal
 * is full, or the journal or database could not be read. Each of those is
 * recorded as a content-free diagnostic.
 */
export type LedgerIntentRecording = 'recorded' | 'not_needed' | 'not_durable';

/**
 * How long a host waits on the intent write when it refuses to go ahead
 * without it: a move, or deleting a partially restored archive. Refusing
 * means the operation fails and can be retried, so it waits longer than a
 * host that has a safe fallback.
 */
export const LEDGER_INTENT_REFUSING_WAIT_MS = 5_000;

export interface LedgerIntentRecordOptions {
  /** How long to wait for the write; defaults to a short bound. */
  readonly waitMs?: number;
}

/**
 * Durably records, before a restore purges the archive, that the archived
 * incarnation's scope belongs to the restored one, so an exit before the
 * participant runs cannot lose it. Awaits the write only when the Ledger
 * database exists, and at most `options.waitMs` (a short bound by default).
 * Never rejects. Unless the result is `recorded` or `not_needed`, the restore
 * must keep its archive: its `restoredTo` is then the only lasting record of
 * where the container went.
 */
export function recordLedgerRestoreIntent(
  archived: LedgerContainerIncarnation,
  restored: LedgerContainerIncarnation,
  options: LedgerIntentRecordOptions = {},
): Promise<LedgerIntentRecording> {
  return recordDesktopIntent('rebind', archived, restored, options.waitMs);
}

/**
 * Durably records, before a move commits, that the source incarnation's
 * scope belongs to the destination, whose ID may differ. Awaits the write
 * only when the Ledger database exists, and at most `options.waitMs` (a
 * short bound by default). Never rejects. When the result is `not_durable`,
 * nothing lasting would map the source to the destination after an exit, so
 * the move must not commit: it fails and can be retried. Call
 * `notifyLedgerContainerMoved` after the commit, or `discardLedgerMoveIntent`
 * when the move does not commit.
 */
export function recordLedgerMoveIntent(
  from: LedgerContainerIncarnation,
  to: LedgerContainerIncarnation,
  options: LedgerIntentRecordOptions = {},
): Promise<LedgerIntentRecording> {
  return recordDesktopIntent('move', from, to, options.waitMs);
}

/** Forgets a recorded move that did not commit. Returns at once, never throws. */
export function discardLedgerMoveIntent(
  from: LedgerContainerIncarnation,
  to: LedgerContainerIncarnation,
): void {
  try {
    getDesktopLedgerLifecycle().discardIntent({ kind: 'move', from, to });
  } catch {
    // The startup pass drops an intent whose move never committed.
  }
}

/** The incarnations a workspace held, captured before its deletion. */
export interface LedgerWorkspaceCapture {
  readonly incarnations: readonly LedgerContainerIncarnation[];
}

/**
 * Captures, before a workspace is deleted, every incarnation it holds: its
 * live worktrees or Work Entries and the containers its archive manifests
 * record. Null, reading nothing more than a `stat`, when the Ledger database
 * does not exist. Bounded by `HOST_WAIT_MS`; never rejects.
 */
export function captureLedgerWorkspaceIncarnations(
  workspaceId: string,
  archivedManifests: readonly ArchivedContainerManifest[],
): Promise<LedgerWorkspaceCapture | null> {
  try {
    return settleWithin(
      getDesktopLedgerLifecycle().captureWorkspace(
        workspaceId,
        archivedManifests,
      ),
      null,
      HOST_WAIT_MS,
    );
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Whether the Ledger database may exist: false only once a `stat` shows it
 * does not. For a host that cannot read a mapping it may have to keep, such
 * as an archive whose manifest read failed. Bounded by `HOST_WAIT_MS`;
 * never rejects, and resolves true when it cannot tell.
 */
export function ledgerDatabaseMayExist(): Promise<boolean> {
  try {
    return settleWithin(
      getDesktopLedgerLifecycle().databaseMayExist(),
      true,
      HOST_WAIT_MS,
    );
  } catch {
    return Promise.resolve(true);
  }
}

/**
 * The captured workspace was deleted: its scopes retire, except one whose
 * container a pending intent or its own worktree listed elsewhere shows had
 * moved. Call after the deletion commits. Returns at once, never throws.
 */
export function notifyLedgerWorkspaceDeleted(
  capture: LedgerWorkspaceCapture | null,
): void {
  if (capture === null) return;
  try {
    getDesktopLedgerLifecycle().workspaceDeleted(capture);
  } catch {
    // Participants never throw; the startup pass settles the scopes.
  }
}

/**
 * Archive retention purged an archived container. Returns at once and never
 * throws.
 */
export function notifyLedgerContainerPurged(
  incarnation: LedgerContainerIncarnation,
): void {
  try {
    getDesktopLedgerLifecycle().containerPurged(incarnation);
  } catch {
    // Participants never throw; the startup pass settles the scope.
  }
}

/**
 * A container disappeared outside the app, for example a worktree deleted
 * through the CLI. `containerCreatedAt` is null when the removed record's
 * creation time is unknown. Returns at once and never throws.
 */
export function notifyLedgerContainerRemovedExternally(
  container: LedgerContainer,
  containerCreatedAt: string | null,
): void {
  try {
    getDesktopLedgerLifecycle().containerRemovedExternally(
      container,
      containerCreatedAt,
    );
  } catch {
    // Participants never throw; the startup pass settles the scope.
  }
}

/**
 * How the startup pass ended: `settled` when it settled every scope and
 * pending intent (or there is no database), `incomplete` when a failure left
 * some for the next pass.
 */
export type LedgerStartupPassOutcome = 'settled' | 'incomplete';

/**
 * Settles every scope against its container's current state. Runs once, off
 * the startup critical path. Never rejects.
 */
export function reconcileLedgerScopesAtStartup(): Promise<LedgerStartupPassOutcome> {
  try {
    return getDesktopLedgerLifecycle().reconcileAtStartup();
  } catch {
    return Promise.resolve('incomplete');
  }
}

/**
 * Settles once the startup pass and every participant step queued so far have
 * finished, for example before Ledger storage shuts down. Never rejects.
 */
export function whenLedgerLifecycleIdle(): Promise<void> {
  return desktopLifecycle?.whenIdle() ?? Promise.resolve();
}

/** Evicts the Ledger service state a scope lifecycle change can make stale. */
export interface LedgerLifecycleCaches {
  /** Forgets every cached incarnation of a container. */
  forgetContainer(container: LedgerContainer): void;
  /** Forgets every cached actor of a ledger. */
  forgetLedger(ledgerId: string): void;
}

let desktopCaches: LedgerLifecycleCaches | undefined;

/**
 * Registers the eviction hooks of the app's Ledger service, so purges and
 * rebinds drop its cached scopes and actors. The adapter registers them when
 * it creates the service; before that nothing is cached.
 */
export function registerLedgerLifecycleCaches(
  caches: LedgerLifecycleCaches,
): void {
  desktopCaches = caches;
}

/** A participant, or the startup pass, as diagnostics name it. */
export type LedgerLifecycleOperation =
  | 'archive'
  | 'delete'
  | 'purge'
  | 'restore'
  | 'move'
  | 'external_removal'
  | 'workspace_deletion'
  | 'intent_journal'
  | 'reconcile';

/**
 * A lifecycle failure without content: no IDs, paths or entry text. The
 * reason is a store error reason, a filesystem error code, a lifecycle
 * reason such as `SCOPE_NOT_ARCHIVED` or `DESTINATION_HAS_SCOPE`, or
 * `UNEXPECTED`.
 */
export interface LedgerLifecycleFailure {
  readonly operation: LedgerLifecycleOperation;
  readonly reason: string;
}

/** Which registry lists a container: `worktrees.json` or `work-entries.json`. */
export type LedgerContainerRegistryKind = 'worktrees' | 'work_entries';

/** A registry read: each row's ID and creation time, as persisted. */
export type LedgerContainerRegistryRead =
  | {
      readonly status: 'ok';
      readonly createdAtById: ReadonlyMap<string, string>;
    }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' };

/** What an archived-container manifest records about its container. */
export interface LedgerArchivedContainerRecord {
  readonly kind: ArchivedContainerKind;
  /** The archived container's own ID. */
  readonly id: string;
  /** The workspace, or App Advisor, the container belonged to. */
  readonly projectId: string;
  /** The container's verified original creation time. */
  readonly createdAt: string;
  /** Where a restore put the container, while the manifest remains. */
  readonly restoredTo: {
    readonly kind: ArchivedContainerKind;
    readonly id: string;
    /** Null when the manifest predates restore identities. */
    readonly createdAt: string | null;
  } | null;
}

/**
 * The archive filed under one container ID: `absent` when no archive
 * directory exists, `unreadable` when one exists without a readable, valid
 * manifest (a capture or purge in progress, or damage).
 */
export type LedgerArchivedContainerRead =
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly record: LedgerArchivedContainerRecord }
  | { readonly status: 'unreadable' };

/**
 * Strict reads of the persistence that owns containers. Unlike the app's
 * lenient readers, damage is never reported as absence.
 */
export interface LedgerLifecyclePersistence {
  /**
   * Every indexed workspace and its type, or null when the index is absent,
   * unreadable or partial. None of those proves that a workspace is gone.
   */
  readWorkspaceIndex(): Promise<ReadonlyMap<string, WorkspaceType> | null>;
  readContainerRegistry(
    registry: LedgerContainerRegistryKind,
    parentId: string,
  ): Promise<LedgerContainerRegistryRead>;
  readArchivedContainer(
    parentId: string,
    containerId: string,
  ): Promise<LedgerArchivedContainerRead>;
}

export interface LedgerLifecycleOptions {
  /** The store client. Called only once the database file is known to exist. */
  readonly store: () => LedgerStoreClient;
  /**
   * `stat` of the Ledger database file. It must never open or read the file:
   * only the storage worker may.
   */
  readonly statDatabase: () => Promise<{ isFile(): boolean }>;
  readonly persistence: LedgerLifecyclePersistence;
  /** The Ledger service's caches, once the service exists. */
  readonly caches: () => LedgerLifecycleCaches | undefined;
  readonly callerBindings: () => Pick<
    LedgerCallerBindingRegistry,
    'revokeWhere'
  >;
  /** The ledger's owner admission fence; see `withLedgerOwnerAdmission`. */
  readonly withOwnerAdmission: <T>(
    ledgerId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
  readonly invalidateOwnerEligibility: (
    target: LedgerOwnerEligibilityTarget,
  ) => void;
  /** Records a content-free diagnostic. */
  readonly recordFailure: (failure: LedgerLifecycleFailure) => void;
  /**
   * Sends a retiring scope's outbox to the mirror, within a bounded wait,
   * just before its rows are purged (LD10). Its failure never stops the
   * purge. None by default.
   */
  readonly drainOutbox?: (ledgerId: string) => Promise<void>;
  /**
   * Asks sync to send soon: an archive, a restore or a move just added an
   * event to a scope's outbox. None by default.
   */
  readonly requestSync?: () => void;
  /** The durable intent journal beside the database. */
  readonly intents: LedgerLifecycleIntentJournal;
  /** Runs between the batches of the startup pass. */
  readonly yieldToEventLoop?: () => Promise<void>;
  /** Scopes the startup pass settles between two yields. */
  readonly batchSize?: number;
  /** The clock intents are stamped with. */
  readonly now?: () => Date;
}

const MISSING_PATH_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
/** After these, no later store call in the same pass can succeed. */
const PASS_ENDING_REASONS: ReadonlySet<string> = new Set([
  'STORAGE_UNAVAILABLE',
  'WRITER_UNAVAILABLE',
  'UNSUPPORTED_SCHEMA',
]);
const DEFAULT_BATCH_SIZE = 100;
/**
 * How long a host waits on a Ledger write before its own commit: the intent
 * journal, or the capture before a workspace deletion.
 */
const HOST_WAIT_MS = 500;
/**
 * Outcomes after which an intent has nothing left to apply. Anything else,
 * such as storage being unavailable, keeps it for the startup pass.
 */
const FINAL_INTENT_REASONS: ReadonlySet<string> = new Set([
  'FORBIDDEN',
  'INVALID_INPUT',
  'NOT_FOUND',
  'SCOPE_RETIRED',
]);
/**
 * The most intents one chain resolution takes on: the journal's own bound. A
 * larger set of connected intents stays, and so does every scope on it.
 */
const MAX_INTENT_CHAIN_HOPS = DEFAULT_MAX_INTENTS;
/** Rounds of one replay; each takes up at least one intent it had not. */
const MAX_REPLAY_ROUNDS = 4 * DEFAULT_MAX_INTENTS;
/** Workspace types whose `worktrees.json` lists code worktrees. */
const CODE_WORKSPACE_TYPES: readonly WorkspaceType[] = [
  'single-repo',
  'multi-repo',
];

/** A refused lifecycle input or state, named by a content-free reason. */
class LedgerLifecycleError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Ledger lifecycle step refused: ${reason}`);
    this.name = 'LedgerLifecycleError';
    this.reason = reason;
  }
}

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

/** A filesystem error code such as `EACCES`; never a message or a path. */
function fileSystemErrorCode(error: unknown): string | null {
  const code = systemErrorCode(error);
  return code !== undefined && /^E[A-Z0-9]+$/.test(code) ? code : null;
}

function isMissingPath(error: unknown): boolean {
  const code = fileSystemErrorCode(error);
  return code !== null && MISSING_PATH_CODES.has(code);
}

function failureReason(error: unknown): string {
  if (error instanceof LedgerStorageHostError) return error.reason;
  if (error instanceof LedgerLifecycleError) return error.reason;
  if (error instanceof LedgerLifecycleIntentError) return error.reason;
  return fileSystemErrorCode(error) ?? 'UNEXPECTED';
}

function noop(): void {
  // Settled; outcomes are observed where the task was created.
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
}

/**
 * `work`, or `fallback` once `milliseconds` pass or `work` rejects. Only the
 * wait is bounded: the work itself runs on.
 */
function settleWithin<T>(
  work: Promise<T>,
  fallback: T,
  milliseconds: number,
): Promise<T> {
  let cancel = (): void => undefined;
  const timeout = new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), milliseconds);
    cancel = (): void => clearTimeout(timer);
  });
  return Promise.race([work.catch((): T => fallback), timeout]).finally(() =>
    cancel(),
  );
}

/** A private copy, so a caller's later changes cannot reach queued work. */
function snapshotIncarnation(
  incarnation: LedgerContainerIncarnation,
): LedgerContainerIncarnation {
  return {
    container: { ...incarnation.container },
    containerCreatedAt: incarnation.containerCreatedAt,
  };
}

/** Where a container is persisted and what may hold it. */
interface LedgerContainerLocation {
  /** The workspace, or App Advisor, that persists the container. */
  readonly parentId: string;
  readonly itemId: string;
  readonly registry: LedgerContainerRegistryKind;
  /** The kind its archived-container manifest records. */
  readonly archiveKind: ArchivedContainerKind;
  /**
   * Workspace types that can hold it; null for App Advisor entries, which
   * live outside the workspace index.
   */
  readonly workspaceTypes: readonly WorkspaceType[] | null;
}

function locateContainer(container: LedgerContainer): LedgerContainerLocation {
  switch (container.kind) {
    case 'code_worktree':
      return {
        parentId: container.workspaceId,
        itemId: container.worktreeId,
        registry: 'worktrees',
        archiveKind: 'worktree',
        workspaceTypes: CODE_WORKSPACE_TYPES,
      };
    case 'cowork_entry':
      return {
        parentId: container.workspaceId,
        itemId: container.entryId,
        registry: 'work_entries',
        archiveKind: 'work-entry',
        workspaceTypes: ['cowork'],
      };
    case 'advisor_entry':
      return {
        parentId: container.appWorkspaceId,
        itemId: container.entryId,
        registry: 'work_entries',
        archiveKind: 'work-entry',
        workspaceTypes: null,
      };
    case 'global':
      // A global (workflow) Ledger has no container to persist; every pass
      // skips it before it gets here.
      throw new LedgerLifecycleError('GLOBAL_SCOPE');
  }
}

/** The same kind of container, in the same parent, under another ID. */
function withItemId(
  container: LedgerContainer,
  itemId: string,
): LedgerContainer {
  switch (container.kind) {
    case 'code_worktree':
      return { ...container, worktreeId: itemId };
    case 'cowork_entry':
      return { ...container, entryId: itemId };
    case 'advisor_entry':
      return { ...container, entryId: itemId };
    case 'global':
      throw new LedgerLifecycleError('GLOBAL_SCOPE');
  }
}

function isSameIncarnation(
  left: LedgerScopeRecord,
  right: LedgerScopeRecord,
): boolean {
  return (
    ledgerContainerKey(left.scope.container) ===
      ledgerContainerKey(right.scope.container) &&
    left.containerCreatedAt === right.containerCreatedAt
  );
}

/**
 * Whether a persisted creation time is the canonical instant: null when it
 * cannot be read as an instant, so it proves nothing either way.
 */
function isSameInstant(
  persisted: string | undefined,
  canonical: string,
): boolean | null {
  if (persisted === undefined) return false;
  const instant = canonicalizeLedgerInstant(persisted);
  return instant === null ? null : instant === canonical;
}

/**
 * What current persistence proves about a scope's container incarnation:
 * `live` in its registry, `archived` under a manifest that records exactly
 * that incarnation, `gone` when every read that could list it was definite
 * and none does, and `unknown` otherwise.
 */
type LedgerContainerPresence =
  | { readonly kind: 'live' }
  | {
      readonly kind: 'archived';
      /** A restore destination the manifest and registry both prove. */
      readonly restoredTo: LedgerContainerIncarnation | null;
    }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unknown' };

const LIVE: LedgerContainerPresence = { kind: 'live' };
const GONE: LedgerContainerPresence = { kind: 'gone' };
const UNKNOWN: LedgerContainerPresence = { kind: 'unknown' };
const UNREADABLE_REGISTRY: LedgerContainerRegistryRead = {
  status: 'unreadable',
};
const UNREADABLE_ARCHIVE: LedgerArchivedContainerRead = {
  status: 'unreadable',
};

/**
 * Persistence reads for one decision; a pass shares one index read to
 * classify its scopes. The search for a moved worktree reads it afresh.
 */
interface LedgerPresenceReads {
  readonly persistence: LedgerLifecyclePersistence;
  workspaceIndex(): Promise<ReadonlyMap<string, WorkspaceType> | null>;
}

async function readRegistrySafely(
  persistence: LedgerLifecyclePersistence,
  registry: LedgerContainerRegistryKind,
  parentId: string,
): Promise<LedgerContainerRegistryRead> {
  try {
    return await persistence.readContainerRegistry(registry, parentId);
  } catch {
    return UNREADABLE_REGISTRY;
  }
}

async function readArchiveSafely(
  persistence: LedgerLifecyclePersistence,
  location: LedgerContainerLocation,
): Promise<LedgerArchivedContainerRead> {
  try {
    return await persistence.readArchivedContainer(
      location.parentId,
      location.itemId,
    );
  } catch {
    return UNREADABLE_ARCHIVE;
  }
}

/**
 * The restored incarnation, when the manifest records its destination and
 * the registry lists that destination with the recorded creation time: the
 * same proof a resumed restore relies on.
 */
function provenRestoreDestination(
  container: LedgerContainer,
  record: LedgerArchivedContainerRecord,
  registry: LedgerContainerRegistryRead,
): LedgerContainerIncarnation | null {
  const destination = record.restoredTo;
  if (
    destination === null ||
    destination.createdAt === null ||
    destination.kind !== record.kind ||
    !isSafeLedgerContainerId(destination.id) ||
    registry.status !== 'ok'
  ) {
    return null;
  }
  const createdAt = canonicalizeLedgerInstant(destination.createdAt);
  if (
    createdAt === null ||
    isSameInstant(registry.createdAtById.get(destination.id), createdAt) !==
      true
  ) {
    return null;
  }
  return {
    container: withItemId(container, destination.id),
    containerCreatedAt: destination.createdAt,
  };
}

/**
 * Whether a container that is neither live nor archived was removed, rather
 * than hidden by a damaged or missing file.
 */
async function isRemovalProven(
  location: LedgerContainerLocation,
  registry: LedgerContainerRegistryRead,
  reads: LedgerPresenceReads,
): Promise<boolean> {
  // App Advisor always exists, so only its own registry can prove a removal.
  if (location.workspaceTypes === null) return registry.status === 'ok';
  const index = await reads.workspaceIndex();
  if (index === null) return false;
  const type = index.get(location.parentId);
  // The whole workspace is gone.
  if (type === undefined) return true;
  if (!location.workspaceTypes.includes(type)) return false;
  // A present workspace without its registry proves nothing.
  return registry.status === 'ok';
}

/** Whether the registry lists the incarnation; null when it cannot tell. */
function isListed(
  registry: LedgerContainerRegistryRead,
  location: LedgerContainerLocation,
  createdAt: string,
): boolean | null {
  if (registry.status === 'unreadable') return null;
  if (registry.status === 'absent') return false;
  return isSameInstant(registry.createdAtById.get(location.itemId), createdAt);
}

/**
 * The manifest filed under the container's ID when it records exactly this
 * incarnation, `absent` when it records none or another incarnation, or null
 * when it cannot tell.
 */
function archivedRecordOf(
  archive: LedgerArchivedContainerRead,
  location: LedgerContainerLocation,
  createdAt: string,
): LedgerArchivedContainerRecord | 'absent' | null {
  if (archive.status !== 'ok') {
    return archive.status === 'absent' ? 'absent' : null;
  }
  const record = archive.record;
  if (
    record.kind !== location.archiveKind ||
    record.id !== location.itemId ||
    record.projectId !== location.parentId
  ) {
    return null;
  }
  const same = isSameInstant(record.createdAt, createdAt);
  if (same === null) return null;
  return same ? record : 'absent';
}

function classifyLedgerScope(
  scope: LedgerScopeRecord,
  reads: LedgerPresenceReads,
): Promise<LedgerContainerPresence> {
  return classifyIncarnation(
    {
      container: scope.scope.container,
      containerCreatedAt: scope.containerCreatedAt,
    },
    reads,
  );
}

async function classifyIncarnation(
  incarnation: LedgerContainerIncarnation,
  reads: LedgerPresenceReads,
): Promise<LedgerContainerPresence> {
  const container = incarnation.container;
  const location = locateContainer(container);
  const createdAt = canonicalizeLedgerInstant(incarnation.containerCreatedAt);
  if (
    createdAt === null ||
    !isSafeLedgerContainerId(location.parentId) ||
    !isSafeLedgerContainerId(location.itemId)
  ) {
    return UNKNOWN;
  }
  // The registry is read before the archive: an archive commits its
  // manifest before it removes the registry row, so a row missing here has
  // its manifest visible below.
  const registry = await readRegistrySafely(
    reads.persistence,
    location.registry,
    location.parentId,
  );
  const live = isListed(registry, location, createdAt);
  if (live === null) return UNKNOWN;
  const archived = archivedRecordOf(
    await readArchiveSafely(reads.persistence, location),
    location,
    createdAt,
  );
  if (archived === null) return UNKNOWN;
  if (archived !== 'absent') {
    // Listed and archived at once: an archive is between its commit steps.
    if (live) return UNKNOWN;
    return {
      kind: 'archived',
      restoredTo: provenRestoreDestination(container, archived, registry),
    };
  }
  if (live) return LIVE;
  return (await isRemovalProven(location, registry, reads)) ? GONE : UNKNOWN;
}

/**
 * Where a container its own parent no longer lists lives now: nowhere
 * (`none`), in exactly one other parent (`moved`), or it cannot be told
 * (`unknown`).
 */
type LedgerRelocation =
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'moved';
      readonly destination: LedgerContainerIncarnation;
    };

const NOT_RELOCATED: LedgerRelocation = { kind: 'none' };
const RELOCATION_UNKNOWN: LedgerRelocation = { kind: 'unknown' };

/**
 * What settling a scope left to do: nothing, or settling it again once the
 * queue holds these containers too, such as the destination its worktree
 * moved to or every container a chain of pending intents names.
 */
type LedgerSettleOutcome =
  | { readonly kind: 'settled' }
  | {
      readonly kind: 'hold';
      readonly containers: readonly LedgerContainer[];
    };

const SETTLED: LedgerSettleOutcome = { kind: 'settled' };

/**
 * What a gone scope's chains of pending intents left: an outcome they
 * decided, or the scope to settle by the usual rules for a gone container.
 */
type LedgerChainedSettle =
  | { readonly kind: 'decided'; readonly outcome: LedgerSettleOutcome }
  | { readonly kind: 'unchained'; readonly scope: LedgerScopeRecord };

const DECIDED: LedgerChainedSettle = { kind: 'decided', outcome: SETTLED };

/** The queue keys of the containers a step holds. */
function heldKeys(containers: readonly LedgerContainer[]): ReadonlySet<string> {
  return new Set(containers.map((container) => ledgerContainerKey(container)));
}

type LedgerWorktreeContainer = Extract<
  LedgerContainer,
  { kind: 'code_worktree' }
>;

/**
 * The worktree's incarnation in one other workspace's registry: listed there
 * with the same creation time (the canonical `createdAt`), `none` when the
 * registry lists it under no or another creation time, or null when it
 * cannot tell.
 */
function listedElsewhere(
  registry: LedgerContainerRegistryRead,
  container: LedgerWorktreeContainer,
  workspaceId: string,
  createdAt: string,
): LedgerContainerIncarnation | 'none' | null {
  if (registry.status === 'unreadable') return null;
  if (registry.status === 'absent') return 'none';
  const same = isSameInstant(
    registry.createdAtById.get(container.worktreeId),
    createdAt,
  );
  if (same === null) return null;
  if (!same) return 'none';
  return worktreeLedgerIncarnation(workspaceId, {
    id: container.worktreeId,
    createdAt,
  });
}

/**
 * Every other code workspace whose registry lists the worktree with the same
 * creation time. The index is read afresh, so a workspace that a move created
 * after the pass began counts. Null, proving nothing, when the index or any
 * of those registries cannot be read.
 */
async function listRelocationCandidates(
  container: LedgerWorktreeContainer,
  containerCreatedAt: string,
  persistence: LedgerLifecyclePersistence,
): Promise<LedgerContainerIncarnation[] | null> {
  const createdAt = canonicalizeLedgerInstant(containerCreatedAt);
  if (createdAt === null) return null;
  const index = await persistence.readWorkspaceIndex().catch((): null => null);
  if (index === null) return null;
  const candidates: LedgerContainerIncarnation[] = [];
  for (const [workspaceId, type] of Array.from(index)) {
    if (
      workspaceId === container.workspaceId ||
      !CODE_WORKSPACE_TYPES.includes(type)
    ) {
      continue;
    }
    if (!isSafeLedgerContainerId(workspaceId)) return null;
    const listing = listedElsewhere(
      await readRegistrySafely(persistence, 'worktrees', workspaceId),
      container,
      workspaceId,
      createdAt,
    );
    if (listing === null) return null;
    if (listing !== 'none') candidates.push(listing);
  }
  return candidates;
}

/**
 * Runs lifecycle work one task at a time per container. A task names every
 * container it touches (a restore names two) and starts once the earlier
 * tasks for each have settled, so an archive followed by a restore applies in
 * order.
 */
class LedgerLifecycleQueue {
  private readonly tails = new Map<string, Promise<void>>();
  /** Tasks running or waiting, per container key. */
  private readonly holders = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();

  run<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
    const unique = Array.from(new Set(keys));
    const previous = unique.map(
      (key): Promise<void> => this.tails.get(key) ?? Promise.resolve(),
    );
    for (const key of unique) {
      this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
    }
    const result = Promise.all(previous).then(() => task());
    const tail = result.then(noop, noop);
    for (const key of unique) this.tails.set(key, tail);
    this.inFlight.add(tail);
    void tail.then((): void => {
      this.inFlight.delete(tail);
      for (const key of unique) {
        const remaining = (this.holders.get(key) ?? 1) - 1;
        if (remaining > 0) this.holders.set(key, remaining);
        else this.holders.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
    });
    return result;
  }

  /** True while another task waits for a container the running task holds. */
  isContended(key: string): boolean {
    return (this.holders.get(key) ?? 0) > 1;
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all(this.inFlight);
    }
  }
}

/** One queued step: what it is, for diagnostics, and the store it uses. */
interface LedgerLifecycleStep {
  readonly operation: LedgerLifecycleOperation;
  readonly store: LedgerStoreClient;
}

/** The participant, as diagnostics name it, that applies an intent. */
function intentOperation(
  kind: LedgerLifecycleIntentKind,
): LedgerLifecycleOperation {
  return kind === 'rebind' ? 'restore' : 'move';
}

/** A registry's rows, or none when it could not be read. */
function registryRows(
  registry: LedgerContainerRegistryRead,
): readonly (readonly [string, string])[] {
  return registry.status === 'ok' ? Array.from(registry.createdAtById) : [];
}

/** The incarnation a scope is bound to. */
function incarnationOf(scope: LedgerScopeRecord): LedgerContainerIncarnation {
  return {
    container: scope.scope.container,
    containerCreatedAt: scope.containerCreatedAt,
  };
}

/** A pending intent, as a hop from one incarnation to another. */
interface LedgerIntentHop {
  readonly intent: LedgerLifecycleIntent;
  readonly identity: string;
  readonly fromKey: string;
  readonly toKey: string;
}

/**
 * Pending intents that share incarnations, directly or through each other,
 * in recorded order, with every incarnation they name. Two hops chain when
 * the later one's source is the earlier one's destination: a restore and then
 * a move, or two moves, of one container.
 */
interface LedgerIntentChains {
  readonly hops: readonly LedgerIntentHop[];
  readonly incarnations: ReadonlyMap<string, LedgerContainerIncarnation>;
}

/**
 * Each intent's hop, computed once: the journal hands out the same intents on
 * every read, and a replay reads it once per round.
 */
const intentHops = new WeakMap<LedgerLifecycleIntent, LedgerIntentHop>();

function hopOf(intent: LedgerLifecycleIntent): LedgerIntentHop {
  const known = intentHops.get(intent);
  if (known !== undefined) return known;
  const hop: LedgerIntentHop = {
    intent,
    identity: ledgerIntentIdentity(intent),
    fromKey: ledgerIncarnationKey(intent.from),
    toKey: ledgerIncarnationKey(intent.to),
  };
  intentHops.set(intent, hop);
  return hop;
}

/**
 * The pending intents connected to any of `seeds`. Conflicted intents are
 * never applied, so they take no part in a chain.
 */
function connectedIntents(
  intents: readonly LedgerLifecycleIntent[],
  seeds: readonly LedgerContainerIncarnation[],
): LedgerIntentChains {
  const hops = intents
    .filter((intent) => intent.conflicted !== true)
    .map(hopOf);
  const reached = new Set(seeds.map((seed) => ledgerIncarnationKey(seed)));
  const connected = new Set<LedgerIntentHop>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const hop of hops) {
      if (
        connected.has(hop) ||
        (!reached.has(hop.fromKey) && !reached.has(hop.toKey))
      ) {
        continue;
      }
      connected.add(hop);
      reached.add(hop.fromKey);
      reached.add(hop.toKey);
      grew = true;
    }
  }
  const chained = hops.filter((hop) => connected.has(hop));
  const incarnations = new Map<string, LedgerContainerIncarnation>();
  for (const hop of chained) {
    if (!incarnations.has(hop.fromKey)) {
      incarnations.set(hop.fromKey, hop.intent.from);
    }
    if (!incarnations.has(hop.toKey)) {
      incarnations.set(hop.toKey, hop.intent.to);
    }
  }
  return { hops: chained, incarnations };
}

/** Every container the chains name, for the queue to hold. */
function chainContainers(chains: LedgerIntentChains): LedgerContainer[] {
  return Array.from(
    chains.incarnations.values(),
    (incarnation) => incarnation.container,
  );
}

function isHeld(
  chains: LedgerIntentChains,
  held: ReadonlySet<string>,
): boolean {
  return chainContainers(chains).every((container) =>
    held.has(ledgerContainerKey(container)),
  );
}

function isSameHops(
  left: readonly LedgerIntentHop[],
  right: readonly LedgerIntentHop[],
): boolean {
  const identities = new Set(right.map((hop) => hop.identity));
  return (
    left.length === right.length &&
    left.every((hop) => identities.has(hop.identity))
  );
}

/** The recorded position of the last hop that arrived at `key`, or -1. */
function arrivalPosition(
  hops: readonly LedgerIntentHop[],
  key: string,
): number {
  let position = -1;
  hops.forEach((hop, index) => {
    if (hop.toKey === key) position = index;
  });
  return position;
}

/** The recorded position of the first hop that left `key`. */
function departurePosition(
  hops: readonly LedgerIntentHop[],
  key: string,
): number {
  const position = hops.findIndex((hop) => hop.fromKey === key);
  return position < 0 ? hops.length : position;
}

/** A place a chain leads to: where its container is now. */
interface LedgerChainEnd {
  readonly incarnation: LedgerContainerIncarnation;
  /** Archived there, with no restore taking it onward. */
  readonly archived: boolean;
  /** The recorded position of the hop that arrived there; -1 at the start. */
  readonly arrival: number;
}

/** Every place a chain leads to, none when nowhere, or `unknown`. */
type LedgerChainOutcome =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'ends';
      readonly ends: ReadonlyMap<string, LedgerChainEnd>;
    };

const CHAIN_UNKNOWN: LedgerChainOutcome = { kind: 'unknown' };

function endingAt(key: string, end: LedgerChainEnd): LedgerChainOutcome {
  return { kind: 'ends', ends: new Map([[key, end]]) };
}

/**
 * Whether a hop can have left an incarnation in this state. A move takes a
 * live container and leaves nothing behind; a restore takes an archived one,
 * whose archive is purged afterwards. A hop whose source is still live where
 * it was never committed.
 */
function mayHaveLeft(
  kind: LedgerLifecycleIntentKind,
  presence: LedgerContainerPresence,
): boolean {
  if (presence.kind === 'gone') return true;
  return kind === 'rebind' && presence.kind === 'archived';
}

/**
 * Follows chains of pending intents in recorded order, from each hop only on
 * to a later one, so every walk ends, through cycles too, within as many
 * steps as there are hops. A walk stops where persistence shows the container
 * live, or archived with no restore onward, and leads nowhere from an
 * incarnation that is gone with no hop onward. A read that cannot tell on the
 * way makes the outcome `unknown`.
 */
class LedgerChainWalk {
  private readonly hops: readonly LedgerIntentHop[];
  private readonly presence: ReadonlyMap<string, LedgerContainerPresence>;
  /** Where each hop leads once taken, computed from the last hop back. */
  private readonly onward: LedgerChainOutcome[] = [];

  constructor(
    hops: readonly LedgerIntentHop[],
    presence: ReadonlyMap<string, LedgerContainerPresence>,
  ) {
    this.hops = hops;
    this.presence = presence;
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = hops[index];
      this.onward[index] = this.leadsFrom(hop.toKey, hop.intent.to, index);
    }
  }

  /** Where the container of a scope bound at `start` is now. */
  from(start: LedgerContainerIncarnation): LedgerChainOutcome {
    return this.leadsFrom(ledgerIncarnationKey(start), start, -1);
  }

  private leadsFrom(
    key: string,
    incarnation: LedgerContainerIncarnation,
    position: number,
  ): LedgerChainOutcome {
    const presence = this.presence.get(key) ?? UNKNOWN;
    if (presence.kind === 'unknown') return CHAIN_UNKNOWN;
    if (presence.kind === 'live') {
      return endingAt(key, { incarnation, archived: false, arrival: position });
    }
    const ends = new Map<string, LedgerChainEnd>();
    for (let next = position + 1; next < this.hops.length; next += 1) {
      const hop = this.hops[next];
      if (hop.fromKey !== key || !mayHaveLeft(hop.intent.kind, presence)) {
        continue;
      }
      const onward = this.onward[next];
      if (onward.kind === 'unknown') return CHAIN_UNKNOWN;
      onward.ends.forEach((end, endKey) => {
        const known = ends.get(endKey);
        if (known === undefined || end.arrival < known.arrival) {
          ends.set(endKey, end);
        }
      });
    }
    if (ends.size > 0 || presence.kind === 'gone') {
      return { kind: 'ends', ends };
    }
    // Archived, and no restore took it onward.
    return endingAt(key, { incarnation, archived: true, arrival: position });
  }
}

/** Where one scope on a chain goes. */
interface LedgerChainMove {
  readonly scope: LedgerScopeRecord;
  readonly end: LedgerChainEnd;
  /** Whether the scope's own container is verified gone. */
  readonly sourceGone: boolean;
  /** The recorded position of the hop that brought its container there. */
  readonly arrival: number;
  /** The recorded position of the first hop that took it onward. */
  readonly departure: number;
}

/**
 * The order the participants would have moved the scopes in, so a contested
 * place goes to the same ledger: first the scope whose container reached the
 * end first; of two on one chain, the one further along, as a destination
 * keeps its own ledger; of two joined into one, the one that moved first.
 */
function compareChainMoves(
  left: LedgerChainMove,
  right: LedgerChainMove,
): number {
  if (left.end.arrival !== right.end.arrival) {
    return left.end.arrival - right.end.arrival;
  }
  if (left.arrival !== right.arrival) return right.arrival - left.arrival;
  return left.departure - right.departure;
}

/**
 * The lifecycle participants and the startup pass over injected storage,
 * persistence and caches. The app uses one instance; tests make their own.
 */
export class LedgerLifecycle {
  private readonly options: LedgerLifecycleOptions;
  private readonly queue = new LedgerLifecycleQueue();
  /** The database file is never removed while the app runs, so a sighting holds. */
  private databaseFound = false;
  private startupPass: Promise<LedgerStartupPassOutcome> | undefined;
  /** Whether a scope kept for a gap in the journal was reported this run. */
  private journalGapReported = false;
  /** Intent writes and workspace captures a host may still be awaiting. */
  private readonly hostWork = new Set<Promise<unknown>>();
  /**
   * Per intent identity, the host's last write to it, so a record and the
   * discard of the same intent reach the journal in the order the host made
   * them, even when the host stopped waiting on the record.
   */
  private readonly intentWrites = new Map<string, Promise<void>>();

  constructor(options: LedgerLifecycleOptions) {
    this.options = options;
  }

  containerArchived(
    incarnation: LedgerContainerIncarnation,
    options: LedgerContainerArchivedOptions,
  ): void {
    try {
      const archived = snapshotIncarnation(incarnation);
      const retained = options.retained;
      this.dispatch(
        retained ? 'archive' : 'delete',
        [archived.container],
        (step) => this.onArchived(step, archived, retained),
      );
    } catch (error) {
      this.fail('archive', error);
    }
  }

  containerRestored(
    archived: LedgerContainerIncarnation,
    restored: LedgerContainerIncarnation,
  ): void {
    try {
      const from = snapshotIncarnation(archived);
      const to = snapshotIncarnation(restored);
      this.dispatch('restore', [from.container, to.container], (step) =>
        this.applyingIntent(step, { kind: 'rebind', from, to }, () =>
          this.onRestored(step, from, to),
        ),
      );
    } catch (error) {
      this.fail('restore', error);
    }
  }

  containerMoved(
    from: LedgerContainerIncarnation,
    to: LedgerContainerIncarnation,
  ): void {
    try {
      const source = snapshotIncarnation(from);
      const destination = snapshotIncarnation(to);
      this.dispatch('move', [source.container, destination.container], (step) =>
        this.applyingIntent(
          step,
          { kind: 'move', from: source, to: destination },
          () => this.onMoved(step, source, destination),
        ),
      );
    } catch (error) {
      this.fail('move', error);
    }
  }

  /**
   * Durably records an intent, only once the database exists, so a host can
   * await it before its commit, and tells the host whether it may rely on
   * it. Never rejects: whatever keeps the intent from being durable is
   * recorded as a diagnostic.
   */
  recordIntent(
    intent: LedgerLifecycleIntentKey,
  ): Promise<LedgerIntentRecording> {
    const operation = intentOperation(intent.kind);
    try {
      const recorded: LedgerLifecycleIntent = {
        kind: intent.kind,
        from: snapshotIncarnation(intent.from),
        to: snapshotIncarnation(intent.to),
        recordedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      return this.trackHostWork(
        this.orderIntentWrite(
          recorded,
          async (): Promise<LedgerIntentRecording> => {
            const database = await this.databaseState(operation);
            if (database === 'missing') return 'not_needed';
            // A database that cannot be seen may still exist.
            if (database === 'unknown') return 'not_durable';
            if ((await this.options.intents.add(recorded)) === 'full') {
              this.record('intent_journal', 'FULL');
              return 'not_durable';
            }
            return 'recorded';
          },
        ).catch((error: unknown): LedgerIntentRecording => {
          this.fail(operation, error);
          return 'not_durable';
        }),
      );
    } catch (error) {
      this.fail(operation, error);
      return Promise.resolve('not_durable');
    }
  }

  /**
   * Forgets an intent whose host operation did not commit, after any write
   * of it the host started earlier, so a record that outlived the host's wait
   * cannot land afterwards. Never throws.
   */
  discardIntent(intent: LedgerLifecycleIntentKey): void {
    const operation = intentOperation(intent.kind);
    try {
      const discarded: LedgerLifecycleIntentKey = {
        kind: intent.kind,
        from: snapshotIncarnation(intent.from),
        to: snapshotIncarnation(intent.to),
      };
      void this.trackHostWork(
        this.orderIntentWrite(discarded, async (): Promise<void> => {
          if (!(await this.databaseExists(operation))) return;
          await this.options.intents.remove(discarded);
        }).catch((error: unknown): void => this.fail(operation, error)),
      );
    } catch (error) {
      this.fail(operation, error);
    }
  }

  /**
   * Every incarnation a workspace holds, read before it is deleted; null
   * when the database does not exist. Never rejects.
   */
  captureWorkspace(
    workspaceId: string,
    archivedManifests: readonly ArchivedContainerManifest[],
  ): Promise<LedgerWorkspaceCapture | null> {
    return this.trackHostWork(
      this.readWorkspaceIncarnations(workspaceId, archivedManifests).catch(
        (error: unknown): null => {
          this.fail('workspace_deletion', error);
          return null;
        },
      ),
    );
  }

  /**
   * The captured workspace is gone: each of its scopes settles as a
   * container that no longer exists, so it retires unless it moved.
   */
  workspaceDeleted(capture: LedgerWorkspaceCapture): void {
    for (const incarnation of capture.incarnations) {
      try {
        const deleted = snapshotIncarnation(incarnation);
        this.dispatch('workspace_deletion', [deleted.container], (step) =>
          this.onContainerDeleted(step, deleted),
        );
      } catch (error) {
        this.fail('workspace_deletion', error);
      }
    }
  }

  containerPurged(incarnation: LedgerContainerIncarnation): void {
    try {
      const purged = snapshotIncarnation(incarnation);
      this.dispatch('purge', [purged.container], (step) =>
        this.onPurged(step, purged),
      );
    } catch (error) {
      this.fail('purge', error);
    }
  }

  containerRemovedExternally(
    container: LedgerContainer,
    containerCreatedAt: string | null,
  ): void {
    try {
      const removed: LedgerContainer = { ...container };
      this.dispatch('external_removal', [removed], (step) =>
        this.onRemovedExternally(step, removed, containerCreatedAt),
      );
    } catch (error) {
      this.fail('external_removal', error);
    }
  }

  /** The startup pass; later calls share the first one. Never rejects. */
  reconcileAtStartup(): Promise<LedgerStartupPassOutcome> {
    this.startupPass ??= this.runStartupPass().catch(
      (error: unknown): LedgerStartupPassOutcome => {
        this.fail('reconcile', error);
        return 'incomplete';
      },
    );
    return this.startupPass;
  }

  /**
   * False only when the database file is known not to exist. Never opens or
   * creates it, and never rejects.
   */
  databaseMayExist(): Promise<boolean> {
    return this.trackHostWork(
      this.databaseState('delete').then(
        (state): boolean => state !== 'missing',
        (): boolean => true,
      ),
    );
  }

  /**
   * Settles once the startup pass, every queued step and every intent write
   * or capture a host started have finished.
   */
  async whenIdle(): Promise<void> {
    if (this.startupPass !== undefined) await this.startupPass;
    while (this.hostWork.size > 0) {
      await Promise.all(this.hostWork);
    }
    await this.queue.whenIdle();
  }

  /**
   * Queues work behind the earlier steps for the same containers. The work
   * starts only when the database file exists, so nothing creates it.
   */
  private dispatch(
    operation: LedgerLifecycleOperation,
    containers: readonly LedgerContainer[],
    work: (step: LedgerLifecycleStep) => Promise<void>,
  ): void {
    const keys = containers.map((container) => ledgerContainerKey(container));
    const task = this.queue.run(keys, async (): Promise<void> => {
      if (!(await this.databaseExists(operation))) return;
      await work({ operation, store: this.options.store() });
    });
    void task.catch((error: unknown): void => this.fail(operation, error));
  }

  /**
   * Runs a host's write of an intent after its earlier writes of the same
   * intent have settled. The journal applies writes in the order they reach
   * it; this keeps the database check before each from reordering them.
   */
  private orderIntentWrite<T>(
    intent: LedgerLifecycleIntentKey,
    write: () => Promise<T>,
  ): Promise<T> {
    const identity = ledgerIntentIdentity(intent);
    const previous = this.intentWrites.get(identity) ?? Promise.resolve();
    const result = previous.then(write);
    const settled = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.intentWrites.set(identity, settled);
    void settled.then((): void => {
      if (this.intentWrites.get(identity) === settled) {
        this.intentWrites.delete(identity);
      }
    });
    return result;
  }

  /** Keeps work a host started visible to `whenIdle` until it settles. */
  private trackHostWork<T>(work: Promise<T>): Promise<T> {
    this.hostWork.add(work);
    const settled = (): void => {
      this.hostWork.delete(work);
    };
    void work.then(settled, settled);
    return work;
  }

  private async readWorkspaceIncarnations(
    workspaceId: string,
    archivedManifests: readonly ArchivedContainerManifest[],
  ): Promise<LedgerWorkspaceCapture | null> {
    if (!isSafeLedgerContainerId(workspaceId)) return null;
    if (!(await this.databaseExists('workspace_deletion'))) return null;
    const persistence = this.options.persistence;
    const [worktrees, entries] = await Promise.all([
      readRegistrySafely(persistence, 'worktrees', workspaceId),
      readRegistrySafely(persistence, 'work_entries', workspaceId),
    ]);
    const incarnations: LedgerContainerIncarnation[] = [];
    for (const [id, createdAt] of registryRows(worktrees)) {
      incarnations.push(
        worktreeLedgerIncarnation(workspaceId, { id, createdAt }),
      );
    }
    for (const [id, createdAt] of registryRows(entries)) {
      incarnations.push(
        workEntryLedgerIncarnation(workspaceId, { id, createdAt }),
      );
    }
    for (const manifest of archivedManifests) {
      incarnations.push(archivedLedgerIncarnation(manifest));
    }
    return { incarnations };
  }

  private async onArchived(
    step: LedgerLifecycleStep,
    incarnation: LedgerContainerIncarnation,
    retained: boolean,
  ): Promise<void> {
    const scope = await step.store.findScope(incarnation);
    if (scope === null) return;
    // A retiring scope never becomes live again, so finish its retirement.
    if (!retained || scope.lifecycleState === 'retirement_pending') {
      await this.retireScope(step, scope);
      return;
    }
    await this.archiveScope(step, scope);
  }

  private async onPurged(
    step: LedgerLifecycleStep,
    incarnation: LedgerContainerIncarnation,
  ): Promise<void> {
    const scope = await step.store.findScope(incarnation);
    if (scope !== null) await this.retireScope(step, scope);
  }

  /**
   * Reattaches the archived incarnation's scope to the restored container.
   * Only one archived scope with exactly that creation time qualifies. In
   * every other case the old scope stays as it is, and the restored container
   * mints a new ledger on first use, rather than guessing. When the restored
   * container already has a ledger of its own, the archived scope is kept,
   * read-only, under a conflicted intent (`kept`). True when it found the
   * scope to reattach.
   */
  private async onRestored(
    step: LedgerLifecycleStep,
    archived: LedgerContainerIncarnation,
    restored: LedgerContainerIncarnation,
  ): Promise<boolean | 'kept'> {
    const createdAt = canonicalizeLedgerInstant(archived.containerCreatedAt);
    if (createdAt === null) throw new LedgerLifecycleError('INVALID_INPUT');
    const matches = (
      await step.store.findContainerScopes(archived.container)
    ).filter(
      (scope) =>
        canonicalizeLedgerInstant(scope.containerCreatedAt) === createdAt,
    );
    if (matches.length !== 1) return false;
    const [scope] = matches;
    if (scope.lifecycleState !== 'archived') {
      // Its archive step was missed; the startup pass settles it.
      throw new LedgerLifecycleError('SCOPE_NOT_ARCHIVED');
    }
    if (await this.hasOtherLedger(step, scope, restored)) {
      await this.keepConflictedRestore(step, archived, restored);
      return 'kept';
    }
    try {
      await this.rebindScope(step, scope, restored);
    } catch (error) {
      // The restored container gained a ledger since the check above.
      if (
        failureReason(error) !== 'FORBIDDEN' ||
        !(await this.hasOtherLedger(step, scope, restored))
      ) {
        throw error;
      }
      await this.keepConflictedRestore(step, archived, restored);
      return 'kept';
    }
    return true;
  }

  /** Whether `target` already holds a ledger other than `scope`'s. */
  private async hasOtherLedger(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    target: LedgerContainerIncarnation,
  ): Promise<boolean> {
    const occupant = await step.store.findScope(target);
    return (
      occupant !== null && occupant.scope.ledgerId !== scope.scope.ledgerId
    );
  }

  /**
   * Keeps an archived scope whose restore can never be applied: the restored
   * container already has a ledger of its own, and ledgers cannot merge. The
   * restore's intent stays in the journal, conflicted, so the startup pass
   * keeps the archived scope, read-only, while the restored container exists.
   */
  private async keepConflictedRestore(
    step: LedgerLifecycleStep,
    archived: LedgerContainerIncarnation,
    restored: LedgerContainerIncarnation,
  ): Promise<void> {
    this.record(step.operation, 'DESTINATION_HAS_SCOPE');
    const kept = await this.options.intents.markConflicted(
      { kind: 'rebind', from: archived, to: restored },
      (this.options.now?.() ?? new Date()).toISOString(),
    );
    if (kept === 'full') this.record('intent_journal', 'FULL');
  }

  /**
   * Takes the source incarnation's scope along to the destination, keeping
   * its ledger. A source without a scope never used the Ledger, so there is
   * nothing to move. When the destination already has a scope of its own,
   * see `moveUnlessOccupied`. True when the source had a scope.
   */
  private async onMoved(
    step: LedgerLifecycleStep,
    from: LedgerContainerIncarnation,
    to: LedgerContainerIncarnation,
  ): Promise<boolean> {
    if (
      from.container.kind !== to.container.kind ||
      canonicalizeLedgerInstant(from.containerCreatedAt) === null ||
      canonicalizeLedgerInstant(to.containerCreatedAt) === null
    ) {
      throw new LedgerLifecycleError('INVALID_INPUT');
    }
    const scope = await step.store.findScope(from);
    if (scope === null) return false;
    await this.moveUnlessOccupied(step, scope, to, async () => {
      const source = await classifyIncarnation(from, this.presenceReads());
      return source.kind === 'gone';
    });
    return true;
  }

  /**
   * Moves a scope to `to`, keeping its ledger, unless `to` already has a
   * scope of its own. Only one ledger can stay: a two-into-one move retires
   * the moving source's scope, revoking its callers, once its container is
   * verified gone. Otherwise, as when a restored container already has a
   * ledger, the scope stays as it is and the refusal is recorded, rather
   * than guessing. Returns the moved scope, or null.
   */
  private async moveUnlessOccupied(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    to: LedgerContainerIncarnation,
    isSourceGone: () => Promise<boolean>,
  ): Promise<LedgerScopeRecord | null> {
    const occupant = await step.store.findScope(to);
    // An empty move: the scope already belongs to the destination.
    if (occupant?.scope.ledgerId === scope.scope.ledgerId) return occupant;
    if (occupant === null) return this.moveScope(step, scope, to);
    // Only a live container's scope loses a two-into-one move; an archived
    // scope is history and is never retired for want of a place.
    if (scope.lifecycleState !== 'archived' && (await isSourceGone())) {
      await this.retireScope(step, scope);
      return null;
    }
    this.record(step.operation, 'DESTINATION_HAS_SCOPE');
    return null;
  }

  /**
   * Runs the participant that applies a recorded intent, then removes the
   * intent once nothing is left to apply: done, nothing to do, or refused for
   * good. A transient failure keeps it for the startup pass. So does a hop
   * whose source's scope never arrived because an earlier hop into that
   * source is still pending: the startup pass resolves the chain as a whole.
   */
  private async applyingIntent(
    step: LedgerLifecycleStep,
    intent: LedgerLifecycleIntentKey,
    work: () => Promise<boolean | 'kept'>,
  ): Promise<void> {
    let carried: boolean | 'kept';
    try {
      carried = await work();
    } catch (error) {
      if (FINAL_INTENT_REASONS.has(failureReason(error))) {
        await this.forgetIntent(step, intent);
      }
      throw error;
    }
    // A conflicted intent stays, so it keeps its archived scope.
    if (carried === 'kept') return;
    if (!carried && (await this.continuesPendingChain(intent))) return;
    await this.forgetIntent(step, intent);
  }

  /**
   * Whether a pending intent leads into this intent's source, so its hop
   * belongs to a chain the startup pass must see whole. True, keeping the
   * intent, when the journal cannot be read.
   */
  private async continuesPendingChain(
    intent: LedgerLifecycleIntentKey,
  ): Promise<boolean> {
    const journal = await this.options.intents.read();
    if (journal.status !== 'ok') return true;
    const source = ledgerIncarnationKey(intent.from);
    return journal.intents.some(
      (pending) =>
        pending.conflicted !== true &&
        ledgerIncarnationKey(pending.to) === source,
    );
  }

  private async forgetIntent(
    step: LedgerLifecycleStep,
    intent: LedgerLifecycleIntentKey,
  ): Promise<void> {
    try {
      await this.options.intents.remove(intent);
    } catch (error) {
      // The startup pass drops an intent that has nothing left to apply.
      this.fail(step.operation, error);
    }
  }

  /**
   * Resolves connected chains of pending intents, while the queue holds every
   * container they name: each scope on them moves straight to the place its
   * container is now, in the order the participants would have moved them,
   * and the chains are cleared. A hop whose source is still live never
   * committed, so it only ends its chain there, and a chain that leads
   * nowhere leaves its scope to the rules for a container that is gone. Any
   * read that cannot tell changes nothing and keeps every intent. So does a
   * refusal: two places claiming one container, or more connected intents
   * than the journal holds. True once the chains are cleared.
   */
  private async resolveIntentChains(
    step: LedgerLifecycleStep,
    chains: LedgerIntentChains,
  ): Promise<boolean> {
    if (chains.hops.length > MAX_INTENT_CHAIN_HOPS) {
      throw new LedgerLifecycleError('INTENT_CHAIN_TOO_LONG');
    }
    const scopes = await this.scopesOnChains(step, chains);
    if (scopes.length > 0) {
      const moves = await this.planChainMoves(chains, scopes);
      if (moves === null) return false;
      for (const move of moves) await this.applyChainMove(step, move, chains);
    }
    // Read afresh, after every persistence read above: a host records its
    // intent before the commit it describes. Clear nothing if one was
    // recorded for these containers meanwhile.
    const journal = await this.options.intents.read();
    if (journal.status !== 'ok') return false;
    const current = connectedIntents(
      journal.intents,
      Array.from(chains.incarnations.values()),
    );
    if (!isSameHops(current.hops, chains.hops)) return false;
    await this.options.intents.removeAll(chains.hops.map((hop) => hop.intent));
    return true;
  }

  /** The scopes bound to the chains' incarnations, except retiring ones. */
  private async scopesOnChains(
    step: LedgerLifecycleStep,
    chains: LedgerIntentChains,
  ): Promise<LedgerScopeRecord[]> {
    const scopes: LedgerScopeRecord[] = [];
    for (const incarnation of Array.from(chains.incarnations.values())) {
      const scope = await step.store.findScope(incarnation);
      if (scope !== null && scope.lifecycleState !== 'retirement_pending') {
        scopes.push(scope);
      }
    }
    return scopes;
  }

  /**
   * Where each scope on the chains goes, in the order to move them; null while
   * a read cannot tell. Refuses when two places claim one container.
   */
  private async planChainMoves(
    chains: LedgerIntentChains,
    scopes: readonly LedgerScopeRecord[],
  ): Promise<LedgerChainMove[] | null> {
    const reads = this.presenceReads();
    const presence = new Map<string, LedgerContainerPresence>();
    for (const [key, incarnation] of Array.from(chains.incarnations)) {
      presence.set(key, await classifyIncarnation(incarnation, reads));
    }
    const walk = new LedgerChainWalk(chains.hops, presence);
    const moves: LedgerChainMove[] = [];
    for (const scope of scopes) {
      const start = incarnationOf(scope);
      const outcome = walk.from(start);
      if (outcome.kind === 'unknown') return null;
      const ends = Array.from(outcome.ends.values());
      if (ends.length > 1) {
        throw new LedgerLifecycleError('INTENT_CHAIN_AMBIGUOUS');
      }
      const startKey = ledgerIncarnationKey(start);
      // None when the chain leads nowhere, or back to where the scope is.
      const end = ends.find(
        (candidate) => ledgerIncarnationKey(candidate.incarnation) !== startKey,
      );
      if (end === undefined) continue;
      moves.push({
        scope,
        end,
        sourceGone: presence.get(startKey)?.kind === 'gone',
        arrival: arrivalPosition(chains.hops, startKey),
        departure: departurePosition(chains.hops, startKey),
      });
    }
    return moves.sort(compareChainMoves);
  }

  /**
   * Moves a scope straight to its chain's end. A completed move is found
   * there, so applying one twice changes nothing.
   */
  private async applyChainMove(
    step: LedgerLifecycleStep,
    move: LedgerChainMove,
    chains: LedgerIntentChains,
  ): Promise<void> {
    // An earlier move of these chains may have retired it.
    const scope = await step.store.getScope(move.scope.scope.ledgerId);
    if (
      scope === null ||
      scope.lifecycleState === 'retirement_pending' ||
      !isSameIncarnation(scope, move.scope)
    ) {
      return;
    }
    // An archived scope is a restore's history: when its destination already
    // has a ledger, it is kept under its conflicted intents, never retired.
    if (
      scope.lifecycleState === 'archived' &&
      (await this.hasOtherLedger(step, scope, move.end.incarnation))
    ) {
      await this.keepConflictedChain(step, scope, chains);
      return;
    }
    const moved = await this.moveUnlessOccupied(
      step,
      scope,
      move.end.incarnation,
      () => Promise.resolve(move.sourceGone),
    );
    // Its container was archived there since: the scope follows it.
    if (moved !== null && move.end.archived) {
      await this.archiveScope(step, moved);
    }
  }

  /**
   * Marks conflicted every hop that would take an archived scope from its
   * incarnation into a place that already has a ledger. The chain then stays
   * unresolved for the rest of its hops, which later rounds resolve alone.
   */
  private async keepConflictedChain(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    chains: LedgerIntentChains,
  ): Promise<void> {
    this.record(step.operation, 'DESTINATION_HAS_SCOPE');
    const origin = ledgerIncarnationKey(incarnationOf(scope));
    const recordedAt = (this.options.now?.() ?? new Date()).toISOString();
    for (const hop of chains.hops) {
      if (hop.fromKey !== origin) continue;
      const kept = await this.options.intents.markConflicted(
        hop.intent,
        recordedAt,
      );
      if (kept === 'full') this.record('intent_journal', 'FULL');
    }
  }

  /**
   * Settles the scope of a container deleted with its workspace, as a
   * container that no longer exists.
   */
  private async onContainerDeleted(
    step: LedgerLifecycleStep,
    incarnation: LedgerContainerIncarnation,
  ): Promise<void> {
    const scope = await step.store.findScope(incarnation);
    if (scope === null) return;
    const outcome = await this.settleScope(
      step,
      scope,
      this.presenceReads(),
      undefined,
    );
    if (outcome.kind === 'hold') {
      this.settleHolding(step.operation, scope, outcome.containers);
    }
  }

  /**
   * Settles the container's incarnations that are not archived: that one
   * incarnation when the creation time is known, else every one. Each is
   * retired only once persistence proves it gone. Archived incarnations
   * belong to archive retention.
   */
  private async onRemovedExternally(
    step: LedgerLifecycleStep,
    container: LedgerContainer,
    containerCreatedAt: string | null,
  ): Promise<void> {
    const wanted =
      containerCreatedAt === null
        ? null
        : canonicalizeLedgerInstant(containerCreatedAt);
    if (containerCreatedAt !== null && wanted === null) {
      throw new LedgerLifecycleError('INVALID_INPUT');
    }
    const scopes = (await step.store.findContainerScopes(container)).filter(
      (scope) =>
        scope.lifecycleState !== 'archived' &&
        (wanted === null ||
          canonicalizeLedgerInstant(scope.containerCreatedAt) === wanted),
    );
    if (scopes.length === 0) return;
    const reads = this.presenceReads();
    for (const scope of scopes) {
      const outcome = await this.settleScope(step, scope, reads, undefined);
      if (outcome.kind === 'hold') {
        this.settleHolding(step.operation, scope, outcome.containers);
      }
    }
  }

  /**
   * Settles a scope again once the queue holds `containers` too, such as the
   * destination its worktree moved to, or every container its chain of
   * pending intents names: after the current step, which holds the scope's.
   */
  private settleHolding(
    operation: LedgerLifecycleOperation,
    scope: LedgerScopeRecord,
    containers: readonly LedgerContainer[],
  ): void {
    const held = heldKeys([scope.scope.container, ...containers]);
    this.dispatch(
      operation,
      [scope.scope.container, ...containers],
      async (step): Promise<void> => {
        await this.settleListedScope(step, scope, this.presenceReads(), held);
      },
    );
  }

  /**
   * Resolves the intent journal first, so a restore or move that ended before
   * its participant ran is applied before anything could retire its scope.
   * Then settles every scope, in batches with a yield between them.
   */
  private async runStartupPass(): Promise<LedgerStartupPassOutcome> {
    const database = await this.databaseState('reconcile');
    // Without a database there is nothing to settle. One that cannot be
    // checked may still hold scopes and intents, so nothing is settled.
    if (database === 'missing') return 'settled';
    if (database === 'unknown') return 'incomplete';
    const step: LedgerLifecycleStep = {
      operation: 'reconcile',
      store: this.options.store(),
    };
    // Every failure the pass records, so its outcome can report them.
    const recorded = new Set<string>();
    if (!(await this.replayIntents(step, recorded))) return 'incomplete';
    // Global (workflow) Ledgers have no container: nothing retires them.
    const listed = (await step.store.listScopes()).filter(
      (scope) => scope.scope.container.kind !== 'global',
    );
    const reads = this.presenceReads();
    const batchSize = Math.max(1, this.options.batchSize ?? DEFAULT_BATCH_SIZE);
    const pause = this.options.yieldToEventLoop ?? yieldToEventLoop;
    for (let start = 0; start < listed.length; start += batchSize) {
      // Yield between batches, so a long pass never holds the event loop.
      if (start > 0) await pause();
      for (const scope of listed.slice(start, start + batchSize)) {
        const ended = await this.passStep(recorded, () =>
          this.reconcileListedScope(step, scope, reads),
        );
        if (ended) return 'incomplete';
      }
    }
    await this.passStep(recorded, () => this.dropSpentConflicts(step));
    return recorded.size === 0 ? 'settled' : 'incomplete';
  }

  /**
   * Resolves the pending intents, one set of connected chains at a time, each
   * in the queue of every container it names. Each round takes up an intent
   * no earlier round did, so the replay ends. False when a failure ends the
   * pass.
   */
  private async replayIntents(
    step: LedgerLifecycleStep,
    recorded: Set<string>,
  ): Promise<boolean> {
    const attempted = new Set<string>();
    for (let round = 0; round < MAX_REPLAY_ROUNDS; round += 1) {
      const journal = await this.options.intents.read();
      if (journal.status !== 'ok') {
        // Scopes that are gone stay put this pass: an intent may name them.
        this.record('reconcile', 'INTENT_JOURNAL_UNREADABLE');
        recorded.add('INTENT_JOURNAL_UNREADABLE');
        return true;
      }
      const next = journal.intents.find(
        (intent) =>
          intent.conflicted !== true && !attempted.has(hopOf(intent).identity),
      );
      if (next === undefined) return true;
      const chains = connectedIntents(journal.intents, [next.from]);
      for (const hop of chains.hops) attempted.add(hop.identity);
      const ended = await this.passStep(recorded, () =>
        this.resolveQueued(step, chains),
      );
      if (ended) return false;
    }
    return true;
  }

  /**
   * Resolves the chains once the queue holds every container they name, so
   * no participant for one of them interleaves. Chains that grew meanwhile
   * wait for a later round, or pass, that holds all of their containers.
   */
  private async resolveQueued(
    step: LedgerLifecycleStep,
    chains: LedgerIntentChains,
  ): Promise<void> {
    const held = heldKeys(chainContainers(chains));
    await this.queue.run(Array.from(held), async (): Promise<void> => {
      // Read afresh: a participant may have applied some of them since.
      const journal = await this.options.intents.read();
      if (journal.status !== 'ok') return;
      const current = connectedIntents(
        journal.intents,
        Array.from(chains.incarnations.values()),
      );
      if (current.hops.length === 0 || !isHeld(current, held)) return;
      await this.resolveIntentChains(step, current);
    });
  }

  /**
   * Runs one step of the startup pass, recording its failure. True when the
   * failure ends the pass: no later store call could succeed.
   */
  private async passStep(
    recorded: Set<string>,
    work: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await work();
      return false;
    } catch (error) {
      const reason = failureReason(error);
      if (PASS_ENDING_REASONS.has(reason)) {
        this.record('reconcile', reason);
        return true;
      }
      // One record per reason keeps a repeated failure bounded.
      if (!recorded.has(reason)) {
        recorded.add(reason);
        this.record('reconcile', reason);
      }
      return false;
    }
  }

  /**
   * Settles one listed scope in its container's queue. A scope that must
   * follow its worktree or its chain of pending intents is settled again,
   * from fresh reads, once the queue holds those containers too, so no
   * participant for any of them interleaves. Containers that changed in
   * between wait for the next pass.
   */
  private async reconcileListedScope(
    step: LedgerLifecycleStep,
    listed: LedgerScopeRecord,
    reads: LedgerPresenceReads,
  ): Promise<void> {
    const key = ledgerContainerKey(listed.scope.container);
    const outcome = await this.queue.run([key], () =>
      this.settleListedScope(step, listed, reads, undefined),
    );
    if (outcome.kind !== 'hold') return;
    const held = heldKeys([listed.scope.container, ...outcome.containers]);
    await this.queue.run(Array.from(held), () =>
      this.settleListedScope(step, listed, this.presenceReads(), held),
    );
  }

  private async settleListedScope(
    step: LedgerLifecycleStep,
    listed: LedgerScopeRecord,
    reads: LedgerPresenceReads,
    held: ReadonlySet<string> | undefined,
  ): Promise<LedgerSettleOutcome> {
    // A participant may have moved or removed the scope since the listing.
    const scope = await step.store.getScope(listed.scope.ledgerId);
    if (scope === null || !isSameIncarnation(scope, listed)) return SETTLED;
    return this.settleScope(step, scope, reads, held);
  }

  /**
   * Moves a scope to the state its container's persistence proves. A scope
   * that must follow its worktree to another workspace, or its chain of
   * pending intents, moves only while the queue holds those containers
   * (`held`: the keys of every container the current step holds); otherwise
   * the outcome names them for a step that holds them.
   */
  private async settleScope(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    reads: LedgerPresenceReads,
    held: ReadonlySet<string> | undefined,
  ): Promise<LedgerSettleOutcome> {
    // A global (workflow) Ledger is always active: no container, run,
    // account or sign-out ever archives or retires it.
    if (scope.scope.container.kind === 'global') return SETTLED;
    if (scope.lifecycleState === 'retirement_pending') {
      await this.retireScope(step, scope);
      return SETTLED;
    }
    const presence = await classifyLedgerScope(scope, reads);
    switch (presence.kind) {
      case 'live':
        // For example a scope an interrupted restore left archived.
        if (scope.lifecycleState === 'archived') {
          this.recorded(
            scope,
            await step.store.setScopeLifecycle({
              ledgerId: scope.scope.ledgerId,
              state: 'active',
            }),
          );
        }
        return SETTLED;
      case 'archived': {
        const archived = await this.archiveScope(step, scope);
        if (
          presence.restoredTo !== null &&
          archived.lifecycleState === 'archived'
        ) {
          if (await this.hasOtherLedger(step, archived, presence.restoredTo)) {
            await this.keepConflictedRestore(
              step,
              incarnationOf(archived),
              presence.restoredTo,
            );
          } else {
            await this.rebindScope(step, archived, presence.restoredTo);
          }
        }
        return SETTLED;
      }
      case 'gone':
        return this.settleGoneScope(step, scope, held);
      case 'unknown':
        return SETTLED;
    }
  }

  /**
   * A scope whose container its own parent no longer lists. It follows its
   * chain of pending intents, or a worktree that moved to another workspace
   * under the same ID, and retires only when neither shows where the
   * container went. While a chain that names its container cannot be
   * resolved, or the journal cannot be read, it stays as it is.
   */
  private async settleGoneScope(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    held: ReadonlySet<string> | undefined,
  ): Promise<LedgerSettleOutcome> {
    // A step queued behind this one knows more: a restore reattaches the
    // scope before its archive disappears, and a move participant moves it.
    // Leave the scope to it.
    if (this.queue.isContended(ledgerContainerKey(scope.scope.container))) {
      return SETTLED;
    }
    if (await this.isKeptByConflict(scope)) return SETTLED;
    const chained = await this.settleChainsOf(step, scope, held);
    if (chained.kind === 'decided') return chained.outcome;
    return this.settleUnchained(step, chained.scope, held);
  }

  /**
   * Whether a conflicted restore keeps this scope: its intent starts at the
   * scope's incarnation, and the container it was restored into still exists,
   * live or archived, or cannot be told apart from one that does. True, keeping
   * it, when the journal cannot be read.
   */
  private async isKeptByConflict(scope: LedgerScopeRecord): Promise<boolean> {
    const journal = await this.options.intents.read();
    if (journal.status !== 'ok') return true;
    const origin = ledgerIncarnationKey(incarnationOf(scope));
    const reads = this.presenceReads();
    for (const intent of journal.intents) {
      if (
        intent.conflicted !== true ||
        ledgerIncarnationKey(intent.from) !== origin
      ) {
        continue;
      }
      const destination = await classifyIncarnation(intent.to, reads);
      if (destination.kind !== 'gone') return true;
    }
    return false;
  }

  /**
   * Drops conflicted intents whose archived scope no longer exists: nothing is
   * left for them to keep. Runs at the end of the startup pass.
   */
  private async dropSpentConflicts(step: LedgerLifecycleStep): Promise<void> {
    const journal = await this.options.intents.read();
    if (journal.status !== 'ok') return;
    const spent: LedgerLifecycleIntent[] = [];
    for (const intent of journal.intents) {
      if (intent.conflicted !== true) continue;
      if ((await step.store.findScope(intent.from)) === null) {
        spent.push(intent);
      }
    }
    if (spent.length > 0) await this.options.intents.removeAll(spent);
  }

  /**
   * Follows the chains of pending intents that name a gone scope's container.
   * `decided` once they settle it, or while they cannot be resolved; else the
   * scope, for the usual rules: no chain names it, or its chain led nowhere.
   */
  private async settleChainsOf(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    held: ReadonlySet<string> | undefined,
  ): Promise<LedgerChainedSettle> {
    // The journal is read afresh: a host records its intent before the
    // commit that removed this container.
    const journal = await this.options.intents.read();
    if (journal.status !== 'ok') return DECIDED;
    const chains = connectedIntents(journal.intents, [incarnationOf(scope)]);
    if (chains.hops.length === 0) return { kind: 'unchained', scope };
    if (held === undefined) {
      return {
        kind: 'decided',
        outcome: { kind: 'hold', containers: chainContainers(chains) },
      };
    }
    if (
      !isHeld(chains, held) ||
      !(await this.resolveIntentChains(step, chains))
    ) {
      return DECIDED;
    }
    const current = await step.store.getScope(scope.scope.ledgerId);
    // It followed its chain, or lost the place it led to.
    if (current === null || !isSameIncarnation(current, scope)) return DECIDED;
    // Its chain led nowhere: settle it as any container that is gone.
    return { kind: 'unchained', scope: current };
  }

  /**
   * A gone scope that no pending intent accounts for follows its worktree to
   * another workspace, or retires once no workspace lists that incarnation.
   */
  private async settleUnchained(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    held: ReadonlySet<string> | undefined,
  ): Promise<LedgerSettleOutcome> {
    const relocation = await this.findRelocation(step, scope);
    switch (relocation.kind) {
      case 'none':
        // An intent the journal may have lost could say where it went.
        if (await this.mayBeNamedByLostIntent(step, scope)) return SETTLED;
        await this.retireScope(step, scope);
        return SETTLED;
      case 'unknown':
        return SETTLED;
      case 'moved': {
        const destination = relocation.destination;
        if (held === undefined) {
          return { kind: 'hold', containers: [destination.container] };
        }
        if (held.has(ledgerContainerKey(destination.container))) {
          await this.moveScope(step, scope, destination);
        }
        return SETTLED;
      }
    }
  }

  /**
   * Whether an intent the journal may have lost could name this scope, which
   * is then kept rather than retired: the journal cannot be read, or holds a
   * gap that covers the scope's creation. Reported once a run.
   */
  private async mayBeNamedByLostIntent(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
  ): Promise<boolean> {
    const journal = await this.options.intents.read();
    const covered =
      journal.status !== 'ok' ||
      ledgerIntentGapCovers(journal.gap, scope.createdAt);
    if (covered && !this.journalGapReported) {
      this.journalGapReported = true;
      this.record(step.operation, 'INTENT_JOURNAL_INCOMPLETE');
    }
    return covered;
  }

  /**
   * Where a code worktree its own workspace no longer lists lives now. A move
   * between workspaces keeps the worktree ID and creation time, so exactly one
   * other workspace listing both locates it. Several listings, a failed read,
   * or a listed incarnation with a scope of its own leave the scope where it
   * is. Work Entries never move between workspaces.
   */
  private async findRelocation(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
  ): Promise<LedgerRelocation> {
    const container = scope.scope.container;
    if (container.kind !== 'code_worktree') return NOT_RELOCATED;
    const candidates = await listRelocationCandidates(
      container,
      scope.containerCreatedAt,
      this.options.persistence,
    );
    if (candidates === null || candidates.length > 1) {
      return RELOCATION_UNKNOWN;
    }
    if (candidates.length === 0) return NOT_RELOCATED;
    const [destination] = candidates;
    // A worktree that already minted a ledger of its own keeps it.
    if ((await step.store.findScope(destination)) !== null) {
      return RELOCATION_UNKNOWN;
    }
    return { kind: 'moved', destination };
  }

  /**
   * Moves a scope to another incarnation of the same kind of container,
   * keeping its ledger ID, entries, revisions and actors. Only an archived
   * scope can be rebound, so an active one is archived first. A retiring
   * scope never moves.
   */
  private async moveScope(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    destination: LedgerContainerIncarnation,
  ): Promise<LedgerScopeRecord> {
    if (scope.lifecycleState === 'retirement_pending') {
      throw new LedgerLifecycleError('SCOPE_RETIRED');
    }
    const archived = await this.archiveScope(step, scope);
    return this.rebindScope(step, archived, destination);
  }

  /** `active` → `archived`: the scope stays readable but takes no writes. */
  private archiveScope(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
  ): Promise<LedgerScopeRecord> {
    if (scope.lifecycleState !== 'active') return Promise.resolve(scope);
    const ledgerId = scope.scope.ledgerId;
    return this.options.withOwnerAdmission(ledgerId, async () => {
      try {
        return this.recorded(
          scope,
          await step.store.setScopeLifecycle({ ledgerId, state: 'archived' }),
        );
      } finally {
        // The archived container's actors are no longer assignable owners.
        this.afterScopeChange(step, scope, [], { incarnationEnded: false });
      }
    });
  }

  /** Any state → `retirement_pending`, then purged with every row it owns. */
  private async retireScope(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
  ): Promise<void> {
    const ledgerId = scope.scope.ledgerId;
    await this.options.withOwnerAdmission(ledgerId, async () => {
      try {
        if (scope.lifecycleState !== 'retirement_pending') {
          await step.store.setScopeLifecycle({
            ledgerId,
            state: 'retirement_pending',
          });
        }
        await this.drainOutbox(ledgerId);
        await step.store.purgeScope(ledgerId);
      } finally {
        // The container is gone whether or not the purge completed; a
        // retiring scope never becomes live again.
        this.afterScopeChange(step, scope, [], { incarnationEnded: true });
      }
    });
  }

  /**
   * A scope moved between archived and active, so the store added an event
   * to its outbox: sync is asked to send it. Returns the scope as it now is.
   */
  private recorded(
    before: LedgerScopeRecord,
    after: LedgerScopeRecord,
  ): LedgerScopeRecord {
    if (after.lifecycleState !== before.lifecycleState) {
      try {
        this.options.requestSync?.();
      } catch {
        // Sync's next pass sends it.
      }
    }
    return after;
  }

  /** What is left to send, before the rows go; see `drainOutbox`. */
  private async drainOutbox(ledgerId: string): Promise<void> {
    try {
      await this.options.drainOutbox?.(ledgerId);
    } catch {
      // Sync records its own diagnostics, and the purge goes ahead (LD10).
    }
  }

  /**
   * Reattaches an archived scope to another incarnation, a restored or moved
   * container, and activates it.
   */
  private rebindScope(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    target: LedgerContainerIncarnation,
  ): Promise<LedgerScopeRecord> {
    const ledgerId = scope.scope.ledgerId;
    return this.options.withOwnerAdmission(ledgerId, async () => {
      let rebound = false;
      try {
        const record = await step.store.rebindScope({
          ledgerId,
          container: target.container,
          containerCreatedAt: target.containerCreatedAt,
        });
        rebound = true;
        return this.recorded(scope, record);
      } finally {
        this.afterScopeChange(step, scope, [target.container], {
          incarnationEnded: rebound,
        });
      }
    });
  }

  /**
   * Runs inside the ledger's owner admission fence, so no owner check can
   * pass against a token issued before the change: every owner token for the
   * affected containers stops verifying. A purge or rebind can also leave
   * the Ledger service's cached bindings and actors stale, so those are
   * evicted. Once the scope's incarnation no longer owns it, the caller
   * bindings registered for that incarnation are revoked as well.
   */
  private afterScopeChange(
    step: LedgerLifecycleStep,
    scope: LedgerScopeRecord,
    otherContainers: readonly LedgerContainer[],
    change: { readonly incarnationEnded: boolean },
  ): void {
    const containers = [scope.scope.container, ...otherContainers];
    try {
      for (const container of containers) {
        this.options.invalidateOwnerEligibility({ container });
      }
      if (otherContainers.length === 0 && !change.incarnationEnded) return;
      const caches = this.options.caches();
      if (caches !== undefined) {
        for (const container of containers) caches.forgetContainer(container);
        caches.forgetLedger(scope.scope.ledgerId);
      }
      if (!change.incarnationEnded) return;
      const containerKey = ledgerContainerKey(scope.scope.container);
      const createdAt = canonicalizeLedgerInstant(scope.containerCreatedAt);
      this.options
        .callerBindings()
        .revokeWhere(
          (binding) =>
            ledgerContainerKey(binding.container) === containerKey &&
            canonicalizeLedgerInstant(binding.containerCreatedAt) === createdAt,
        );
    } catch (error) {
      this.fail(step.operation, error);
    }
  }

  private presenceReads(): LedgerPresenceReads {
    const persistence = this.options.persistence;
    let index: Promise<ReadonlyMap<string, WorkspaceType> | null> | undefined;
    return {
      persistence,
      workspaceIndex: (): Promise<ReadonlyMap<
        string,
        WorkspaceType
      > | null> => {
        index ??= persistence.readWorkspaceIndex().catch((): null => null);
        return index;
      },
    };
  }

  /** True once the database file exists; see `databaseState`. */
  private async databaseExists(
    operation: LedgerLifecycleOperation,
  ): Promise<boolean> {
    return (await this.databaseState(operation)) === 'present';
  }

  /**
   * Whether the database file exists: `missing` is the common case (the
   * Ledger was never used) and is checked again next time, as is `unknown`,
   * any other failure, which is recorded. A path that is not a file is no
   * database.
   */
  private async databaseState(
    operation: LedgerLifecycleOperation,
  ): Promise<'present' | 'missing' | 'unknown'> {
    if (this.databaseFound) return 'present';
    try {
      const info = await this.options.statDatabase();
      if (!info.isFile()) return 'missing';
    } catch (error) {
      if (isMissingPath(error)) return 'missing';
      this.fail(operation, error);
      return 'unknown';
    }
    this.databaseFound = true;
    return 'present';
  }

  private fail(operation: LedgerLifecycleOperation, error: unknown): void {
    this.record(operation, failureReason(error));
  }

  private record(operation: LedgerLifecycleOperation, reason: string): void {
    try {
      this.options.recordFailure({ operation, reason });
    } catch {
      // A diagnostic sink failure must not escape a participant.
    }
  }
}

/**
 * The index through its W5 repository, without its lock (CAN-5478). Only an
 * `ok` read whose every entry has an id and one type is a proof.
 */
async function readDesktopWorkspaceIndex(): Promise<ReadonlyMap<
  string,
  WorkspaceType
> | null> {
  const { entries, authority } = await getWorkspaceIndexRepository().read();
  if (authority !== 'ok') return null;
  const workspaces = new Map<string, WorkspaceType>();
  for (const entry of entries) {
    const known = workspaces.get(entry.id);
    if (!entry.id || (known !== undefined && known !== entry.type)) {
      return null;
    }
    workspaces.set(entry.id, entry.type);
  }
  return workspaces;
}

function registryRead(
  rows: readonly { readonly id: string; readonly createdAt: string }[],
): LedgerContainerRegistryRead {
  const createdAtById = new Map<string, string>();
  for (const row of rows) {
    // Two rows with one ID leave the incarnation ambiguous.
    if (createdAtById.has(row.id)) return UNREADABLE_REGISTRY;
    createdAtById.set(row.id, row.createdAt);
  }
  return { status: 'ok', createdAtById };
}

/**
 * Every row of the list, tombstoned ones included, through its W5
 * repository and without its lock: a lifecycle task inherits its
 * participant's lock context. A row the list could not read leaves it
 * unproven.
 */
async function readDesktopWorktreeRegistry(
  workspaceId: string,
): Promise<LedgerContainerRegistryRead> {
  const { worktrees, authority } =
    await readWorkspaceWorktreesUnlocked(workspaceId);
  if (authority === 'absent') return { status: 'absent' };
  return authority === 'ok' ? registryRead(worktrees) : UNREADABLE_REGISTRY;
}

async function readDesktopContainerRegistry(
  registry: LedgerContainerRegistryKind,
  parentId: string,
): Promise<LedgerContainerRegistryRead> {
  if (registry === 'worktrees') return readDesktopWorktreeRegistry(parentId);
  let raw: string;
  try {
    raw = await readFile(getWorkspaceWorkEntriesFilePath(parentId), 'utf8');
  } catch (error) {
    return isMissingPath(error) ? { status: 'absent' } : UNREADABLE_REGISTRY;
  }
  let rows: readonly { readonly id: string; readonly createdAt: string }[];
  try {
    rows = parseWorkEntriesFile(raw).entries;
  } catch {
    return UNREADABLE_REGISTRY;
  }
  return registryRead(rows);
}

function toArchivedContainerRecord(
  manifest: ArchivedContainerManifest,
): LedgerArchivedContainerRecord {
  const restoredTo = manifest.restoredTo;
  return {
    kind: manifest.kind,
    id: manifest.id,
    projectId: manifest.projectId,
    createdAt: manifest.createdAt,
    restoredTo:
      restoredTo === undefined
        ? null
        : {
            kind: restoredTo.kind,
            id: restoredTo.id,
            createdAt: restoredTo.createdAt ?? null,
          },
  };
}

async function readDesktopArchivedContainer(
  parentId: string,
  containerId: string,
): Promise<LedgerArchivedContainerRead> {
  try {
    const info = await stat(getArchivedContainerDir(parentId, containerId));
    if (!info.isDirectory()) return UNREADABLE_ARCHIVE;
  } catch (error) {
    return isMissingPath(error) ? { status: 'absent' } : UNREADABLE_ARCHIVE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(
        getArchivedContainerManifestPath(parentId, containerId),
        'utf8',
      ),
    );
  } catch {
    // A directory without a readable manifest: a capture or purge in
    // progress, or damage. Either way it proves nothing.
    return UNREADABLE_ARCHIVE;
  }
  if (
    !isArchivedContainerManifest(parsed) ||
    parsed.id !== containerId ||
    parsed.projectId !== parentId
  ) {
    return UNREADABLE_ARCHIVE;
  }
  return { status: 'ok', record: toArchivedContainerRecord(parsed) };
}

/**
 * Strict readers of `workspaces/index.json`, `worktrees.json`,
 * `work-entries.json` (the App Advisor's under `app-workspaces/app-advisor/`)
 * and archived-container manifests.
 */
export const DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE: LedgerLifecyclePersistence =
  {
    readWorkspaceIndex: readDesktopWorkspaceIndex,
    readContainerRegistry: readDesktopContainerRegistry,
    readArchivedContainer: readDesktopArchivedContainer,
  };

/**
 * Records a lifecycle failure in the global app diagnostics: only the step
 * and a reason code, never container IDs, paths or entry text.
 */
function recordLedgerLifecycleFailure(failure: LedgerLifecycleFailure): void {
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'ledger_lifecycle_failed',
    reason: `${failure.operation}: ${failure.reason}`,
  });
}

let desktopLifecycle: LedgerLifecycle | undefined;

function getDesktopLedgerLifecycle(): LedgerLifecycle {
  desktopLifecycle ??= new LedgerLifecycle({
    store: getLedgerStoreClient,
    statDatabase: (): Promise<Stats> => stat(getLedgerDatabasePath()),
    persistence: DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE,
    caches: (): LedgerLifecycleCaches | undefined => desktopCaches,
    callerBindings: getLedgerCallerBindingRegistry,
    withOwnerAdmission: withLedgerOwnerAdmission,
    invalidateOwnerEligibility: invalidateLedgerOwnerEligibility,
    recordFailure: recordLedgerLifecycleFailure,
    drainOutbox: drainLedgerScopeBeforePurge,
    requestSync: requestLedgerSync,
    intents: new LedgerLifecycleIntentJournal({
      file: createLedgerLifecycleIntentFile(getLedgerLifecycleIntentsPath()),
      onQuarantine: (): void =>
        recordLedgerLifecycleFailure({
          operation: 'intent_journal',
          reason: 'QUARANTINED',
        }),
    }),
  });
  return desktopLifecycle;
}

/**
 * The desktop lifecycle's `recordIntent`, awaited at most `waitMs`. A write
 * still running by then is not durable as far as the host can tell, and is
 * recorded as such; it still completes, a later discard of the same intent
 * waits for it, and quit waits for it.
 */
async function recordDesktopIntent(
  kind: LedgerLifecycleIntentKind,
  from: LedgerContainerIncarnation,
  to: LedgerContainerIncarnation,
  waitMs: number = HOST_WAIT_MS,
): Promise<LedgerIntentRecording> {
  try {
    const recording = await settleWithin<LedgerIntentRecording | 'timed_out'>(
      getDesktopLedgerLifecycle().recordIntent({ kind, from, to }),
      'timed_out',
      waitMs,
    );
    if (recording !== 'timed_out') return recording;
    recordLedgerLifecycleFailure({
      operation: intentOperation(kind),
      reason: 'INTENT_WRITE_TIMEOUT',
    });
    return 'not_durable';
  } catch {
    return 'not_durable';
  }
}

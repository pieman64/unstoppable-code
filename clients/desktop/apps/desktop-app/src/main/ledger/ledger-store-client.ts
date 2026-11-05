import type {
  LedgerAcknowledgeOutboxInput,
  LedgerActorRecord,
  LedgerAddEntryInput,
  LedgerBindGlobalScopeInput,
  LedgerBindScopeInput,
  LedgerBindScopeResult,
  LedgerFindGlobalScopeInput,
  LedgerFindScopeInput,
  LedgerGetEntryInput,
  LedgerHandBackEntryInput,
  LedgerListChangesInput,
  LedgerListReceiptKeysInput,
  LedgerOutboxEventRecord,
  LedgerPendingTitleRecord,
  LedgerPublishSummaryInput,
  LedgerRecordPendingTitleAttemptInput,
  LedgerReadOutboxInput,
  LedgerRebindAccountInput,
  LedgerRebindAccountResult,
  LedgerRecordMirrorAudienceInput,
  LedgerRegisterActorInput,
  LedgerRegisterActorResult,
  LedgerResolvePendingTitleInput,
  LedgerResolvePendingTitleResult,
  LedgerScopeLifecycleState,
  LedgerScopeRecord,
  LedgerScopeSyncRecord,
  LedgerSearchEntriesInput,
  LedgerSearchEntriesResult,
  LedgerSetScopeRepairInput,
  LedgerStorageCounts,
  LedgerStoreCommandReceipt,
  LedgerUpdateEntryInput,
  LedgerRollupsInput,
  LedgerWorkSummaryInput,
} from '@canopy/desktop-shared/node/ledger';
import type {
  LedgerChangesListResult,
  LedgerContainer,
  LedgerEntryGetResult,
  LedgerRollupsListResult,
  LedgerWorkSummaryGetResult,
} from '@canopy/protocol/canopy-core';

/** An entry read as it crosses the thread boundary: data only. */
export type LedgerStoreGetEntryInput = Omit<
  LedgerGetEntryInput,
  'resolveSourceAvailability'
>;

/** A search as it crosses the thread boundary: data only. */
export type LedgerStoreSearchEntriesInput = Omit<
  LedgerSearchEntriesInput,
  'resolveSourceAvailability'
>;

/** Moves a scope along its lifecycle; see the store's `lifecycle.ts`. */
export interface LedgerStoreSetScopeLifecycleInput {
  ledgerId: string;
  state: LedgerScopeLifecycleState;
}

/** Points an archived scope at the restored incarnation of its container. */
export interface LedgerStoreRebindScopeInput {
  ledgerId: string;
  container: LedgerContainer;
  /** The restored container's own creation time (RFC 3339). */
  containerCreatedAt: string;
}

export interface LedgerStorePurgeScopeResult {
  /** False when no scope with that ID existed. */
  purged: boolean;
}

/**
 * Typed access to the Ledger store held by the storage worker. Each method
 * runs the `LedgerRepository` method of the same name on the worker's single
 * connection, one call at a time, in the order the calls were made.
 *
 * Inputs and results cross a thread boundary, so both are plain data. Source
 * availability is not resolved here: results report `'available'`, and the
 * caller overwrites it after the call returns.
 *
 * Every method rejects with `LedgerStorageHostError`. Its `reason` is the
 * store's `LedgerErrorReason`, or `INTERNAL`. For a store error, `details`
 * holds the protocol `LedgerErrorDetails` from `LedgerStoreError.toDetails()`.
 *
 * Command receipts may carry the store-internal `relatedChanges`; the service
 * announces them and strips the field before a receipt leaves the host.
 */
export interface LedgerStoreClient {
  /** The writer authority minted with the database. */
  getAuthorityId(): Promise<string>;
  bindScope(input: LedgerBindScopeInput): Promise<LedgerBindScopeResult>;
  findScope(input: LedgerFindScopeInput): Promise<LedgerScopeRecord | null>;
  /**
   * The global Ledger of one owner for one account (null: signed out),
   * minted on first use. Two accounts never share one. `bindScope` refuses
   * global containers, so this is the only way to mint one.
   */
  bindGlobalScope(
    input: LedgerBindGlobalScopeInput,
  ): Promise<LedgerBindScopeResult>;
  /** The global Ledger of one owner for one account, never minting one. */
  findGlobalScope(
    input: LedgerFindGlobalScopeInput,
  ): Promise<LedgerScopeRecord | null>;
  getScope(ledgerId: string): Promise<LedgerScopeRecord | null>;
  registerActor(
    input: LedgerRegisterActorInput,
  ): Promise<LedgerRegisterActorResult>;
  listActors(ledgerId: string): Promise<LedgerActorRecord[]>;
  addEntry(input: LedgerAddEntryInput): Promise<LedgerStoreCommandReceipt>;
  /** Pending title-generation markers, oldest first. */
  listPendingTitles(): Promise<LedgerPendingTitleRecord[]>;
  /** Records a persisted title-generation attempt, if the marker still exists. */
  recordPendingTitleAttempt(
    input: LedgerRecordPendingTitleAttemptInput,
  ): Promise<LedgerPendingTitleRecord | null>;
  /** Resolves a pending title marker and returns the entry's current version. */
  resolvePendingTitle(
    input: LedgerResolvePendingTitleInput,
  ): Promise<LedgerResolvePendingTitleResult>;
  updateEntry(
    input: LedgerUpdateEntryInput,
  ): Promise<LedgerStoreCommandReceipt>;
  /** Returns an open entry to its recipient after its current owner's session ends. */
  handBackEntry(
    input: LedgerHandBackEntryInput,
  ): Promise<LedgerStoreCommandReceipt>;
  publishSummary(
    input: LedgerPublishSummaryInput,
  ): Promise<LedgerStoreCommandReceipt>;
  /**
   * Which of the given idempotency keys already hold a receipt for the
   * operation in the ledger, in the order given.
   */
  listReceiptKeys(input: LedgerListReceiptKeysInput): Promise<string[]>;
  getEntry(input: LedgerStoreGetEntryInput): Promise<LedgerEntryGetResult>;
  searchEntries(
    input: LedgerStoreSearchEntriesInput,
  ): Promise<LedgerSearchEntriesResult>;
  listChanges(input: LedgerListChangesInput): Promise<LedgerChangesListResult>;
  /** Stable, cross-scope rollups for operations and top-level tasks. */
  listRollups(input: LedgerRollupsInput): Promise<LedgerRollupsListResult>;
  /** Bounded counts and open entries for a managed-delegation actor set. */
  getWorkSummary(
    input: LedgerWorkSummaryInput,
  ): Promise<LedgerWorkSummaryGetResult>;
  getStorageCounts(): Promise<LedgerStorageCounts>;
  /**
   * Every scope, oldest first, for lifecycle reconciliation. Global scopes
   * are included; they have no container lifecycle and every lifecycle
   * command refuses them (`hasLedgerContainerLifecycle`).
   */
  listScopes(): Promise<LedgerScopeRecord[]>;
  /** The scopes of every incarnation of one container, oldest first. */
  findContainerScopes(container: LedgerContainer): Promise<LedgerScopeRecord[]>;
  /**
   * Moves a scope to `archived`, back to `active`, or to
   * `retirement_pending`. Repeating the current state changes nothing.
   */
  setScopeLifecycle(
    input: LedgerStoreSetScopeLifecycleInput,
  ): Promise<LedgerScopeRecord>;
  /**
   * Reattaches an archived scope to the restored incarnation of its
   * container and reactivates it, keeping its ledger ID, entries, revisions
   * and actors.
   */
  rebindScope(input: LedgerStoreRebindScopeInput): Promise<LedgerScopeRecord>;
  /** Removes a `retirement_pending` scope and every row that belongs to it. */
  purgeScope(ledgerId: string): Promise<LedgerStorePurgeScopeResult>;
}

/**
 * The store's sync bookkeeping, as Ledger sync reads and writes it. Each
 * method runs the `LedgerRepository` method of the same name, like those of
 * `LedgerStoreClient`, and rejects the same way.
 */
export interface LedgerSyncStoreClient {
  /** Every scope with how far its sync has come, oldest first. */
  listSyncScopes(): Promise<LedgerScopeSyncRecord[]>;
  getScopeSync(ledgerId: string): Promise<LedgerScopeSyncRecord | null>;
  /** The scope's outbox events after a sequence, oldest first. */
  readOutbox(input: LedgerReadOutboxInput): Promise<LedgerOutboxEventRecord[]>;
  /** Records what the mirror acknowledged and drops those events. */
  acknowledgeOutbox(
    input: LedgerAcknowledgeOutboxInput,
  ): Promise<LedgerScopeSyncRecord>;
  recordMirrorAudience(
    input: LedgerRecordMirrorAudienceInput,
  ): Promise<LedgerScopeSyncRecord>;
  setScopeRepair(
    input: LedgerSetScopeRepairInput,
  ): Promise<LedgerScopeSyncRecord>;
  /**
   * Moves a merged guest account's scopes and global bindings to the account
   * it became; a global binding the destination already has wins.
   */
  rebindAccount(
    input: LedgerRebindAccountInput,
  ): Promise<LedgerRebindAccountResult>;
}

/** Everything the storage worker serves. */
export type LedgerStorageClient = LedgerStoreClient & LedgerSyncStoreClient;

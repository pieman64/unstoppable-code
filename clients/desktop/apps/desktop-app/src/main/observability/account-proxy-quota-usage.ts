import type { AccountProxyUsageSnapshot } from '@canopy/desktop-shared/types/account-proxy';

import type {
  AccountProxyUsageInventoryEntry,
  AccountProxyUsageReadResult,
} from '../account-proxy/usage';
import {
  ClaudeUsageFetchGate,
  type ClaudeUsageFetchGateResult,
} from './claude-usage-fetch-gate';

export interface AccountProxyQuotaUsagePorts {
  inventory: () => readonly AccountProxyUsageInventoryEntry[];
  read: (
    target: AccountProxyUsageInventoryEntry,
    signal: AbortSignal,
  ) => Promise<AccountProxyUsageReadResult>;
  changed: () => void;
  now?: () => number;
}

export interface AccountProxyQuotaUsageRefreshOptions {
  readonly interactive?: boolean;
  readonly provider?: 'claude' | 'codex';
}

interface AccountState {
  readonly key: string;
  readonly identity: string;
  readonly provider: 'claude' | 'codex';
  readonly fetchGate: ClaudeUsageFetchGate<AccountProxyUsageReadResult>;
  readonly controller: AbortController;
  entry: AccountProxyUsageInventoryEntry;
}

interface ReadSlotWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

const INTERACTIVE_FRESHNESS_MS = 30_000;
const BACKGROUND_FRESHNESS_MS = 180_000;
const MAX_CONCURRENT_READS = 2;

/**
 * Canonical per-account proxy quota snapshots for ObservabilityService.
 * Inventory reconciliation is synchronous and never performs provider I/O.
 */
export class AccountProxyQuotaUsage {
  private readonly inventory: AccountProxyQuotaUsagePorts['inventory'];
  private readonly read: AccountProxyQuotaUsagePorts['read'];
  private readonly changed: AccountProxyQuotaUsagePorts['changed'];
  private readonly now: () => number;
  private readonly accounts = new Map<string, AccountState>();
  private readonly snapshots = new Map<string, AccountProxyUsageSnapshot>();
  private readonly appliedGateResults = new WeakSet<object>();
  private readonly readSlotWaiters: ReadSlotWaiter[] = [];
  private activeReadSlots = 0;
  private disposed = false;

  public constructor(ports: AccountProxyQuotaUsagePorts) {
    this.inventory = ports.inventory;
    this.read = ports.read;
    this.changed = ports.changed;
    this.now = ports.now ?? Date.now;
  }

  /** Reconcile the current inventory and seed only eligible passive snapshots. */
  public reconcile(): void {
    if (this.disposed) return;

    const inventory = new Map<string, AccountProxyUsageInventoryEntry>();
    for (const entry of this.inventory()) {
      inventory.set(accountKey(entry.connectionId, entry.authIndex), entry);
    }

    let snapshotsChanged = false;
    for (const [key, current] of Array.from(this.accounts)) {
      if (inventory.has(key)) continue;
      current.controller.abort();
      this.accounts.delete(key);
      if (this.snapshots.delete(key)) snapshotsChanged = true;
    }

    for (const [key, entry] of Array.from(inventory)) {
      const current = this.accounts.get(key);
      if (
        current !== undefined &&
        current.identity === entry.identity &&
        current.provider === entry.provider
      ) {
        current.entry = entry;
      } else {
        if (current !== undefined) {
          current.controller.abort();
          this.accounts.delete(key);
          if (this.snapshots.delete(key)) snapshotsChanged = true;
        }

        const state: AccountState = {
          key,
          identity: entry.identity,
          provider: entry.provider,
          fetchGate: new ClaudeUsageFetchGate<AccountProxyUsageReadResult>({
            now: (): number => this.now(),
          }),
          controller: new AbortController(),
          entry,
        };
        this.accounts.set(key, state);
      }

      const state = this.accounts.get(key);
      if (state !== undefined && this.reconcilePassiveUsage(state, entry)) {
        snapshotsChanged = true;
      }
    }

    if (snapshotsChanged) this.changed();
  }

  public get(
    connectionId: string,
    authIndex: string,
  ): AccountProxyUsageSnapshot | undefined {
    return this.snapshots.get(accountKey(connectionId, authIndex));
  }

  public async refresh(
    options: AccountProxyQuotaUsageRefreshOptions = {},
  ): Promise<void> {
    if (this.disposed) return;
    this.reconcile();

    const freshnessMs =
      options.interactive === true
        ? INTERACTIVE_FRESHNESS_MS
        : BACKGROUND_FRESHNESS_MS;
    const selectedAccounts = Array.from(this.accounts.values()).filter(
      (account) =>
        options.provider === undefined || account.provider === options.provider,
    );

    await Promise.all(
      selectedAccounts.map((account) =>
        this.refreshAccount(account, freshnessMs),
      ),
    );
  }

  /** Abort reads and release the canonical cache when the owner is disposed. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const account of Array.from(this.accounts.values()))
      account.controller.abort();
    this.accounts.clear();
    this.snapshots.clear();
  }

  private async refreshAccount(
    account: AccountState,
    freshnessMs: number,
  ): Promise<void> {
    let result: ClaudeUsageFetchGateResult<AccountProxyUsageReadResult>;
    try {
      result = await account.fetchGate.run(
        null,
        freshnessMs,
        (): Promise<AccountProxyUsageReadResult> =>
          this.readWithSlot(account.entry, account.controller.signal),
        (readResult) =>
          readResult.status === 'success'
            ? { status: 'success' }
            : {
                status: 'failure',
                ...(readResult.errorInfo.kind === 'rate_limited'
                  ? { rateLimited: true }
                  : {}),
                ...(readResult.retryAfter === undefined
                  ? {}
                  : { retryAfter: readResult.retryAfter }),
              },
      );
    } catch (error: unknown) {
      if (
        !this.isCurrentAccount(account) ||
        account.controller.signal.aborted ||
        isAbortError(error)
      ) {
        return;
      }
      throw error;
    }

    if (
      result.kind !== 'completed' ||
      !this.isCurrentAccount(account) ||
      this.appliedGateResults.has(result)
    ) {
      return;
    }
    this.appliedGateResults.add(result);

    const completedAt = Math.max(this.now(), result.startedAt);
    if (result.value.status === 'success') {
      const previous = this.snapshots.get(account.key);
      const planType = result.value.planType ?? previous?.planType;
      this.snapshots.set(account.key, {
        rateLimits: result.value.rateLimits,
        source: 'live',
        lastUpdatedAt: new Date(completedAt).toISOString(),
        ...(planType === undefined ? {} : { planType }),
      });
      this.changed();
      return;
    }

    const retryAt = result.retryAt;
    const errorInfo =
      retryAt === undefined
        ? result.value.errorInfo
        : {
            ...result.value.errorInfo,
            retryAt: new Date(retryAt).toISOString(),
          };
    this.snapshots.set(
      account.key,
      this.snapshotAfterFailure(account.key, errorInfo, retryAt),
    );
    this.changed();
  }

  private async readWithSlot(
    entry: AccountProxyUsageInventoryEntry,
    signal: AbortSignal,
  ): Promise<AccountProxyUsageReadResult> {
    return this.withReadSlot(
      signal,
      async (): Promise<AccountProxyUsageReadResult> => {
        try {
          return await this.read(entry, signal);
        } catch (error: unknown) {
          if (signal.aborted || isAbortError(error)) throw error;
          return { status: 'failure', errorInfo: { kind: 'unknown' } };
        }
      },
    );
  }

  private async withReadSlot<T>(
    signal: AbortSignal,
    read: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireReadSlot(signal);
    if (signal.aborted) {
      release();
      throw createAbortError();
    }

    try {
      return await read();
    } finally {
      release();
    }
  }

  private acquireReadSlot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(createAbortError());
    if (this.activeReadSlots < MAX_CONCURRENT_READS) {
      this.activeReadSlots += 1;
      return Promise.resolve((): void => this.releaseReadSlot());
    }

    return new Promise<() => void>((resolve, reject): void => {
      const waiter: ReadSlotWaiter = {
        signal,
        resolve,
        reject,
        onAbort: (): void => {
          const index = this.readSlotWaiters.indexOf(waiter);
          if (index < 0) return;
          this.readSlotWaiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(createAbortError());
        },
      };
      this.readSlotWaiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  private releaseReadSlot(): void {
    while (this.readSlotWaiters.length > 0) {
      const waiter = this.readSlotWaiters.shift();
      if (waiter === undefined) continue;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(createAbortError());
        continue;
      }
      waiter.resolve((): void => this.releaseReadSlot());
      return;
    }
    this.activeReadSlots = Math.max(0, this.activeReadSlots - 1);
  }

  private reconcilePassiveUsage(
    account: AccountState,
    entry: AccountProxyUsageInventoryEntry,
  ): boolean {
    const passive = entry.passiveUsage;
    if (passive === undefined || passive.source !== 'passive') return false;

    const current = this.snapshots.get(account.key);
    if (current === undefined) {
      this.snapshots.set(account.key, passive);
      return true;
    }

    const passiveAt = timestamp(passive.lastUpdatedAt);
    const currentAt = timestamp(current.lastUpdatedAt);
    // A successful live read always records its actual completion timestamp;
    // never let later passive headers replace its richer provider snapshot.
    const hasLiveSuccess =
      current.source === 'live' && current.lastUpdatedAt !== undefined;
    if (hasLiveSuccess) return false;
    const isNewerObservation =
      passiveAt !== null && (currentAt === null || passiveAt > currentAt);
    const changedWithoutTimestamps =
      passiveAt === null &&
      currentAt === null &&
      JSON.stringify(passive.rateLimits) !== JSON.stringify(current.rateLimits);
    if (
      !isNewerObservation &&
      !changedWithoutTimestamps &&
      !(current.source === 'live' && currentAt === null)
    ) {
      return false;
    }

    this.snapshots.set(account.key, {
      rateLimits: passive.rateLimits,
      source: 'passive',
      ...(current.planType === undefined ? {} : { planType: current.planType }),
      ...(passive.lastUpdatedAt === undefined
        ? {}
        : { lastUpdatedAt: passive.lastUpdatedAt }),
      ...(current.errorInfo === undefined
        ? {}
        : { errorInfo: current.errorInfo }),
      ...(current.retryAt === undefined ? {} : { retryAt: current.retryAt }),
    });
    return true;
  }

  private snapshotAfterFailure(
    key: string,
    errorInfo: AccountProxyUsageSnapshot['errorInfo'],
    retryAt: number | undefined,
  ): AccountProxyUsageSnapshot {
    const previous = this.snapshots.get(key);
    if (previous !== undefined) {
      return {
        rateLimits: previous.rateLimits,
        source: previous.source,
        ...(previous.planType === undefined
          ? {}
          : { planType: previous.planType }),
        ...(previous.lastUpdatedAt === undefined
          ? {}
          : { lastUpdatedAt: previous.lastUpdatedAt }),
        errorInfo,
        ...(retryAt === undefined ? {} : { retryAt }),
      };
    }

    return {
      rateLimits: [],
      source: 'live',
      errorInfo,
      ...(retryAt === undefined ? {} : { retryAt }),
    };
  }

  private isCurrentAccount(account: AccountState): boolean {
    return (
      !this.disposed &&
      this.accounts.get(account.key) === account &&
      !account.controller.signal.aborted
    );
  }
}

function accountKey(connectionId: string, authIndex: string): string {
  return JSON.stringify([connectionId, authIndex]);
}

function timestamp(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function createAbortError(): Error {
  const error = new Error('Usage read was aborted');
  error.name = 'AbortError';
  return error;
}

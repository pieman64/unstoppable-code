import {
  isSameWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';

export interface ForeignActivityOperation {
  source: 'chat' | 'pipeline' | 'script';
  operationId: string;
  workspaceId: string;
  worktreeId: string;
  context: WorkspaceContext;
  chatId?: string;
  active: boolean;
  resultToken: string | null;
  unreadToken: string | null;
}
export interface ForeignActivitySourceEvent {
  sequence: number;
  operation: ForeignActivityOperation;
  removed?: boolean;
}
export interface ForeignActivityEntry {
  operation: ForeignActivityOperation;
  baselineToken: string | null;
  state:
    | 'FOREIGN_ACTIVE'
    | 'FOREIGN_COMPLETED_UNREAD'
    | 'FOREIGN_COMPLETED_LINGER';
  changedAt: number;
  interrupted?: boolean;
}
export interface ForeignActivityLedgerFile {
  version: 1;
  accountId: string;
  epoch: string;
  entries: ForeignActivityEntry[];
}
export interface ForeignActivitySource {
  subscribe(listener: (event: ForeignActivitySourceEvent) => void): () => void;
  snapshot(): { sequence: number; operations: ForeignActivityOperation[] };
}

function operationKey(operation: ForeignActivityOperation): string {
  return JSON.stringify([
    operation.source,
    operation.workspaceId,
    operation.worktreeId,
    operation.chatId,
    operation.operationId,
  ]);
}

/** Device-only attention bookkeeping; source state remains authoritative. */
export class ForeignActivityLedger {
  private readonly tracked = new Map<string, ForeignActivityEntry>();
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private sequence = -1;
  private context: WorkspaceContext = { kind: 'personal' };
  private accountId = '';
  private epoch = '';

  constructor(
    private readonly source: ForeignActivitySource,
    private readonly now: () => number,
    private readonly createId: () => string,
  ) {}

  switchContext(accountId: string, context: WorkspaceContext): void {
    this.accountId = accountId;
    this.context = context;
    this.epoch = this.createId();
    this.tracked.clear();
    this.observeSnapshot(true);
    this.changed();
  }

  /** Subscribe first; snapshot sequence determines which racing events replay. */
  private observeSnapshot(registerActive: boolean): void {
    this.unsubscribe?.();
    const buffered: ForeignActivitySourceEvent[] = [];
    let snapshotting = true;
    this.unsubscribe = this.source.subscribe((event): void => {
      if (snapshotting) buffered.push(event);
      else this.apply(event);
    });
    const snapshot = this.source.snapshot();
    this.sequence = snapshot.sequence;
    if (registerActive) {
      for (const operation of snapshot.operations) this.register(operation);
    }
    snapshotting = false;
    buffered.sort((left, right): number => left.sequence - right.sequence);
    for (const event of buffered) this.apply(event);
  }

  private register(operation: ForeignActivityOperation): void {
    if (
      this.tracked.has(operationKey(operation)) ||
      !operation.active ||
      !this.accountId ||
      isSameWorkspaceContext(operation.context, this.context)
    )
      return;
    this.tracked.set(operationKey(operation), {
      operation: structuredClone(operation),
      baselineToken: operation.resultToken,
      state: 'FOREIGN_ACTIVE',
      changedAt: this.now(),
    });
  }

  private update(
    entry: ForeignActivityEntry,
    operation: ForeignActivityOperation,
  ): boolean {
    if (
      entry.state === 'FOREIGN_COMPLETED_UNREAD' &&
      !operation.active &&
      operation.unreadToken === null
    )
      return false;
    entry.operation = structuredClone(operation);
    entry.interrupted = false;
    if (operation.active) {
      entry.state = 'FOREIGN_ACTIVE';
      return true;
    }
    if (entry.state === 'FOREIGN_ACTIVE') entry.changedAt = this.now();
    entry.state =
      operation.resultToken !== null &&
      operation.resultToken !== entry.baselineToken &&
      operation.unreadToken === operation.resultToken
        ? 'FOREIGN_COMPLETED_UNREAD'
        : 'FOREIGN_COMPLETED_LINGER';
    return true;
  }

  private apply(event: ForeignActivitySourceEvent): void {
    if (event.sequence <= this.sequence) return;
    this.sequence = event.sequence;
    this.expire();
    const key = operationKey(event.operation);
    const entry = this.tracked.get(key);
    if (event.removed) this.tracked.delete(key);
    else if (entry === undefined) this.register(event.operation);
    else if (!this.update(entry, event.operation)) this.tracked.delete(key);
    this.boundCompleted();
    this.changed();
  }

  private expire(): void {
    for (const [key, entry] of Array.from(this.tracked)) {
      if (
        entry.state === 'FOREIGN_COMPLETED_LINGER' &&
        this.now() - entry.changedAt >= 30_000
      )
        this.tracked.delete(key);
    }
  }

  private boundCompleted(): void {
    const completed = Array.from(this.tracked.entries())
      .filter(([, entry]): boolean => entry.state !== 'FOREIGN_ACTIVE')
      .sort(([, left], [, right]): number => right.changedAt - left.changedAt);
    for (const [key] of completed.slice(200)) this.tracked.delete(key);
  }

  restore(file: ForeignActivityLedgerFile, context: WorkspaceContext): void {
    this.accountId = file.accountId;
    this.context = context;
    this.epoch = file.epoch;
    this.tracked.clear();
    for (const entry of file.entries) {
      if (!isSameWorkspaceContext(entry.operation.context, context))
        this.tracked.set(operationKey(entry.operation), structuredClone(entry));
    }
    this.expire();
    this.boundCompleted();
    // Restored entries precede subscription: racing terminal events cannot be overwritten.
    // Register work started while account state was unavailable without resetting saved baselines.
    this.observeSnapshot(true);
    this.changed();
  }

  reconcile(
    source: ForeignActivityOperation['source'],
    hydrated: boolean,
  ): void {
    if (!hydrated) return;
    const snapshot = this.source.snapshot();
    const authoritative = new Map(
      snapshot.operations.map(
        (operation): [string, ForeignActivityOperation] => [
          operationKey(operation),
          operation,
        ],
      ),
    );
    for (const [key, entry] of Array.from(this.tracked)) {
      if (entry.operation.source !== source) continue;
      const operation = authoritative.get(key);
      if (operation !== undefined) {
        if (!this.update(entry, operation)) this.tracked.delete(key);
      } else if (entry.state === 'FOREIGN_ACTIVE') {
        entry.operation.active = false;
        entry.state = 'FOREIGN_COMPLETED_LINGER';
        entry.interrupted = true;
        entry.changedAt = this.now();
      }
    }
    this.expire();
    this.boundCompleted();
    this.changed();
  }

  entries(): ForeignActivityEntry[] {
    this.expire();
    return Array.from(this.tracked.values()).map(
      (entry): ForeignActivityEntry => structuredClone(entry),
    );
  }

  file(): ForeignActivityLedgerFile {
    return {
      version: 1,
      accountId: this.accountId,
      epoch: this.epoch,
      entries: this.entries(),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }

  retainContexts(predicate: (context: WorkspaceContext) => boolean): void {
    for (const [key, entry] of Array.from(this.tracked)) {
      if (!predicate(entry.operation.context)) this.tracked.delete(key);
    }
    this.changed();
  }

  purge(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.tracked.clear();
    this.accountId = '';
    this.epoch = this.createId();
    this.changed();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
  }
}

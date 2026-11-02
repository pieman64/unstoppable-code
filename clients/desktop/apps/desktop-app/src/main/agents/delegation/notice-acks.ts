import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically } from '../../lib/atomic-file';

export function noticeId(
  delegationId: string,
  runGeneration: number,
  resultIndex: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify([delegationId, runGeneration, resultIndex]))
    .digest('hex');
}

export function noticeBatchId(noticeIds: readonly string[]): string {
  return createHash('sha256')
    .update([...noticeIds].sort().join('\n'))
    .digest('hex');
}

export interface NoticeAck {
  readonly resultIndex: number;
  readonly suppressedReason?: string;
}

export interface OwedNotice {
  readonly noticeId: string;
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly resultIndex: number;
}

export interface PendingNoticeBatch {
  readonly batchId: string;
  readonly parentKey: string;
  readonly noticeIds: readonly string[];
  /** Exact hand-off bytes: child command receipts also bind the message hash. */
  readonly message?: {
    readonly text: string;
    readonly hiddenContextText: string;
    readonly watcherFired: { readonly kind: string };
  };
}

interface PersistedState {
  readonly version: 1;
  readonly baselined: boolean;
  /** The migration's historical baseline is acknowledged, even if unmarked. */
  readonly baselineCaptured?: true;
  readonly acks: Record<string, NoticeAck>;
  readonly pending: PendingNoticeBatch[];
  readonly owed: OwedNotice[];
}

interface FlushWaiter {
  readonly targetVersion: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  return (
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    Object.keys(value).every(
      (key) => requiredKeys.includes(key) || optionalKeys.includes(key),
    )
  );
}

function isNoticeAck(value: unknown): value is NoticeAck {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['resultIndex'], ['suppressedReason'])
  ) {
    return false;
  }
  return (
    isFiniteNumber(value.resultIndex) &&
    (!Object.prototype.hasOwnProperty.call(value, 'suppressedReason') ||
      typeof value.suppressedReason === 'string')
  );
}

function isOwedNotice(value: unknown): value is OwedNotice {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'noticeId',
      'delegationId',
      'runGeneration',
      'resultIndex',
    ]) &&
    typeof value.noticeId === 'string' &&
    typeof value.delegationId === 'string' &&
    isFiniteNumber(value.runGeneration) &&
    isFiniteNumber(value.resultIndex)
  );
}

function isPendingNoticeBatch(value: unknown): value is PendingNoticeBatch {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['batchId', 'parentKey', 'noticeIds'], ['message']) &&
    typeof value.batchId === 'string' &&
    typeof value.parentKey === 'string' &&
    Array.isArray(value.noticeIds) &&
    value.noticeIds.every((noticeId) => typeof noticeId === 'string') &&
    (value.message === undefined || isPendingMessage(value.message))
  );
}

function isPendingMessage(
  value: unknown,
): value is NonNullable<PendingNoticeBatch['message']> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['text', 'hiddenContextText', 'watcherFired']) &&
    typeof value.text === 'string' &&
    typeof value.hiddenContextText === 'string' &&
    isRecord(value.watcherFired) &&
    hasOnlyKeys(value.watcherFired, ['kind']) &&
    typeof value.watcherFired.kind === 'string'
  );
}

function isPersistedState(value: unknown): value is PersistedState {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      ['version', 'baselined', 'acks', 'pending', 'owed'],
      ['baselineCaptured'],
    ) &&
    value.version === 1 &&
    typeof value.baselined === 'boolean' &&
    (value.baselineCaptured === undefined || value.baselineCaptured === true) &&
    isRecord(value.acks) &&
    Object.values(value.acks).every(isNoticeAck) &&
    Array.isArray(value.pending) &&
    value.pending.every(isPendingNoticeBatch) &&
    Array.isArray(value.owed) &&
    value.owed.every(isOwedNotice)
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function copyAck(acknowledgement: NoticeAck): NoticeAck {
  return acknowledgement.suppressedReason === undefined
    ? { resultIndex: acknowledgement.resultIndex }
    : {
        resultIndex: acknowledgement.resultIndex,
        suppressedReason: acknowledgement.suppressedReason,
      };
}

function copyPendingBatch(batch: PendingNoticeBatch): PendingNoticeBatch {
  return {
    batchId: batch.batchId,
    parentKey: batch.parentKey,
    noticeIds: [...batch.noticeIds],
    ...(batch.message
      ? {
          message: {
            text: batch.message.text,
            hiddenContextText: batch.message.hiddenContextText,
            watcherFired: { kind: batch.message.watcherFired.kind },
          },
        }
      : {}),
  };
}

function copyOwedNotice(notice: OwedNotice): OwedNotice {
  return { ...notice };
}

export class DelegationNoticeAckStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly onError: (error: unknown) => void;
  private readonly writeFile: (path: string, data: string) => Promise<void>;
  private acknowledgements = new Map<string, NoticeAck>();
  private pendingBatches: PendingNoticeBatch[] = [];
  private owedNotices: OwedNotice[] = [];
  private baselined = false;
  private baselineCaptured = false;
  private stateVersion = 0;
  private persistedVersion = 0;
  private writeSnapshotVersion: number | undefined;
  private readonly flushWaiters: FlushWaiter[] = [];

  constructor(
    directory: string,
    options?: {
      onError?: (error: unknown) => void;
      writeFile?: (path: string, data: string) => Promise<void>;
    },
  ) {
    this.directory = directory;
    this.filePath = join(directory, 'notice-acks.json');
    this.onError = options?.onError ?? ((): void => undefined);
    this.writeFile =
      options?.writeFile ??
      ((path: string, data: string): Promise<void> =>
        writeFileAtomically(path, data, { durable: true }));
  }

  async load(): Promise<{ baselined: boolean }> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        this.resetToEmpty();
        return { baselined: false };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      this.resetToEmpty();
      this.reportError(
        new Error('Delegation notice acknowledgement state is not valid JSON.'),
      );
      return { baselined: false };
    }

    if (!isPersistedState(parsed)) {
      this.resetToEmpty();
      this.reportError(
        new Error(
          'Delegation notice acknowledgement state has an invalid shape.',
        ),
      );
      return { baselined: false };
    }

    this.acknowledgements = new Map<string, NoticeAck>();
    for (const [delegationId, acknowledgement] of Object.entries(parsed.acks)) {
      this.acknowledgements.set(delegationId, copyAck(acknowledgement));
    }
    this.pendingBatches = parsed.pending.map(copyPendingBatch);
    this.owedNotices = parsed.owed.map(copyOwedNotice);
    this.baselined = parsed.baselined;
    this.baselineCaptured = parsed.baselineCaptured === true;
    this.stateVersion = 0;
    this.persistedVersion = 0;
    return { baselined: this.baselined };
  }

  ack(delegationId: string): NoticeAck | undefined {
    const acknowledgement = this.acknowledgements.get(delegationId);
    return acknowledgement ? copyAck(acknowledgement) : undefined;
  }

  acknowledge(
    delegationId: string,
    resultIndex: number,
    suppressedReason?: string,
  ): void {
    const existing = this.acknowledgements.get(delegationId);
    if (existing && resultIndex < existing.resultIndex) return;
    this.acknowledgements.set(
      delegationId,
      suppressedReason === undefined
        ? { resultIndex }
        : { resultIndex, suppressedReason },
    );
    this.markChanged();
  }

  pending(): readonly PendingNoticeBatch[] {
    return this.pendingBatches.map(copyPendingBatch);
  }

  async recordPending(batch: PendingNoticeBatch): Promise<void> {
    const batchCopy = copyPendingBatch(batch);
    const existingIndex = this.pendingBatches.findIndex(
      (pendingBatch) => pendingBatch.batchId === batchCopy.batchId,
    );
    if (existingIndex < 0) {
      this.pendingBatches.push(batchCopy);
    } else {
      this.pendingBatches[existingIndex] = batchCopy;
    }
    this.markChanged();
    await this.flush();
  }

  clearPending(batchId: string): void {
    const remaining = this.pendingBatches.filter(
      (batch) => batch.batchId !== batchId,
    );
    if (remaining.length === this.pendingBatches.length) return;
    this.pendingBatches = remaining;
    this.markChanged();
  }

  owe(entries: readonly OwedNotice[]): void {
    const noticeIds = new Set(
      this.owedNotices.map((notice) => notice.noticeId),
    );
    const additions: OwedNotice[] = [];
    for (const entry of entries) {
      if (noticeIds.has(entry.noticeId)) continue;
      noticeIds.add(entry.noticeId);
      additions.push(copyOwedNotice(entry));
    }
    if (additions.length === 0) return;
    this.owedNotices.push(...additions);
    this.markChanged();
  }

  owed(): readonly OwedNotice[] {
    return this.owedNotices.map(copyOwedNotice);
  }

  settleOwed(noticeId: string): void {
    const remaining = this.owedNotices.filter(
      (notice) => notice.noticeId !== noticeId,
    );
    if (remaining.length === this.owedNotices.length) return;
    this.owedNotices = remaining;
    this.markChanged();
  }

  isBaselined(): boolean {
    return this.baselined;
  }

  markBaselined(): void {
    if (this.baselined) return;
    this.baselined = true;
    this.markChanged();
  }

  isBaselineCaptured(): boolean {
    return this.baselineCaptured;
  }

  markBaselineCaptured(): void {
    if (this.baselineCaptured) return;
    this.baselineCaptured = true;
    this.markChanged();
  }

  flush(): Promise<void> {
    const targetVersion = this.stateVersion;
    if (targetVersion <= this.persistedVersion) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ targetVersion, resolve, reject });
      this.startWriteIfNeeded();
    });
  }

  private resetToEmpty(): void {
    this.acknowledgements = new Map<string, NoticeAck>();
    this.pendingBatches = [];
    this.owedNotices = [];
    this.baselined = false;
    this.baselineCaptured = false;
    this.stateVersion = 0;
    this.persistedVersion = 0;
  }

  private markChanged(): void {
    this.stateVersion += 1;
  }

  private serializeState(): string {
    const state: PersistedState = {
      version: 1,
      baselined: this.baselined,
      ...(this.baselineCaptured ? { baselineCaptured: true as const } : {}),
      acks: Object.fromEntries(this.acknowledgements),
      pending: this.pendingBatches.map(copyPendingBatch),
      owed: this.owedNotices.map(copyOwedNotice),
    };
    return JSON.stringify(state, null, 2);
  }

  private async writeSnapshot(data: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.writeFile(this.filePath, data);
  }

  private startWriteIfNeeded(): void {
    if (this.writeSnapshotVersion !== undefined) return;
    if (this.flushWaiters.length === 0) return;
    const snapshotVersion = this.stateVersion;
    if (snapshotVersion <= this.persistedVersion) {
      this.resolvePersistedWaiters(this.persistedVersion);
      return;
    }

    const snapshot = this.serializeState();
    this.writeSnapshotVersion = snapshotVersion;
    void this.writeSnapshot(snapshot).then(
      () => this.finishSuccessfulWrite(snapshotVersion),
      (error: unknown) => this.finishFailedWrite(snapshotVersion, error),
    );
  }

  private finishSuccessfulWrite(snapshotVersion: number): void {
    this.persistedVersion = Math.max(this.persistedVersion, snapshotVersion);
    this.writeSnapshotVersion = undefined;
    this.resolvePersistedWaiters(this.persistedVersion);
    this.startWriteIfNeeded();
  }

  private finishFailedWrite(snapshotVersion: number, error: unknown): void {
    this.writeSnapshotVersion = undefined;
    this.reportError(error);
    const remaining: FlushWaiter[] = [];
    for (const waiter of this.flushWaiters) {
      if (waiter.targetVersion <= snapshotVersion) {
        waiter.reject(error);
      } else {
        remaining.push(waiter);
      }
    }
    this.replaceFlushWaiters(remaining);
    this.startWriteIfNeeded();
  }

  private resolvePersistedWaiters(version: number): void {
    const remaining: FlushWaiter[] = [];
    for (const waiter of this.flushWaiters) {
      if (waiter.targetVersion <= version) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.replaceFlushWaiters(remaining);
  }

  private replaceFlushWaiters(waiters: FlushWaiter[]): void {
    this.flushWaiters.splice(0, this.flushWaiters.length, ...waiters);
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Error reporting must never change load or write failure behavior.
    }
  }
}

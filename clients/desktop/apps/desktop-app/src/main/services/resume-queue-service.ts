import { randomUUID } from 'node:crypto';
import type {
  ResumeQueueEntry,
  ResumeQueueItem,
  ResumeQueueSnapshot,
  ResumeQueueControl,
} from '@canopy/desktop-shared/types';

export interface ResumeQueueDependencies {
  /** Canonical interrupted work bounds Stop tombstones by live intent, not age. */
  readLiveAutomaticResumeInterruptionKeys?: (
    entries: NonNullable<ResumeQueueSnapshot['suppressedAutomaticResumes']>,
  ) => Promise<ReadonlySet<string> | null>;
  load: () => Promise<ResumeQueueSnapshot | null>;
  save: (snapshot: ResumeQueueSnapshot) => Promise<void>;
  dispatch: (entry: ResumeQueueEntry) => Promise<'resumed' | 'skipped'>;
  reconcile: (entry: ResumeQueueEntry) => Promise<{
    status: 'waiting' | 'resumed' | 'skipped' | 'failed';
    error?: string;
  }>;
  now: () => number;
  changed: (snapshot: ResumeQueueSnapshot) => void;
}

export function resumeTargetKey(target: ResumeQueueItem['target']): string {
  return target.kind === 'chat'
    ? `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`
    : `pipeline:${target.executionId}`;
}

const pending = (entry: ResumeQueueEntry): boolean =>
  entry.status === 'waiting' || entry.status === 'resuming';

/** Core-owned admission policy. Dispatch never holds the command/persistence lock. */
export class ResumeQueueService {
  private state: ResumeQueueSnapshot = {
    version: 1,
    revision: 0,
    paused: false,
    entries: [],
  };
  private initialized: Promise<void> | undefined;
  private mutations: Promise<unknown> = Promise.resolve();
  private busy = false;
  private tickDone: Promise<void> = Promise.resolve();
  private dispatchingId: string | undefined;
  private handoffStartedId: string | undefined;
  private stopped = false;
  private admissionBlocked = false;
  private nextStartAt = 0;
  private storageError: Error | undefined;

  constructor(private readonly deps: ResumeQueueDependencies) {}

  snapshot(): ResumeQueueSnapshot {
    return structuredClone(this.state);
  }

  initialize(): Promise<void> {
    return (this.initialized ??= (async (): Promise<void> => {
      const stored = await this.deps.load();
      if (stored) this.state = stored;
      const recovered = structuredClone(this.state);
      let changed = false;
      for (const entry of recovered.entries) {
        if (entry.status !== 'resuming') continue;
        const result = await this.deps.reconcile(entry).catch(() => ({
          status: 'failed' as const,
          error:
            'Could not verify the interrupted resume. Check the session before trying again.',
        }));
        Object.assign(entry, result);
        changed = true;
      }
      if (changed) await this.commit(recovered);
      else this.deps.changed(this.snapshot());
    })().catch((error: unknown) => {
      this.failStorage(error);
      throw error;
    }));
  }

  private failStorage(error: unknown): void {
    this.storageError =
      error instanceof Error ? error : new Error(String(error));
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      paused: true,
      error:
        'The resume queue could not be saved or loaded. No more sessions will start. Restart the app to retry.',
    };
    this.deps.changed(this.snapshot());
  }

  private async commit(next: ResumeQueueSnapshot): Promise<void> {
    next.revision = this.state.revision + 1;
    try {
      await this.deps.save(next);
    } catch (error) {
      this.failStorage(error);
      throw error;
    }
    this.state = next;
    this.deps.changed(this.snapshot());
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    await this.initialize();
    const operation = this.mutations.then(async () => {
      if (this.storageError) throw this.storageError;
      return fn();
    });
    this.mutations = operation.catch(() => undefined);
    return operation;
  }

  async enqueue(
    items: ResumeQueueItem[],
    options: { automatic?: boolean } = {},
  ): Promise<ResumeQueueSnapshot> {
    return this.mutate(async () => {
      if (this.stopped) throw new Error('The application is shutting down.');
      const next = this.snapshot();
      if (options.automatic && (this.admissionBlocked || next.paused))
        return next;
      // Evaluate current Stop intent under the same lock as admission. A
      // collector can outlive Stop followed by Dismiss during inventory reads.
      const suppressed = options.automatic
        ? new Set([
            ...(next.suppressedAutomaticResumes ?? []).map(
              (entry) => `${entry.targetKey}:${entry.interruptionId}`,
            ),
            ...next.entries
              .filter((entry) => !pending(entry))
              .flatMap((entry) => {
                const key = resumeTargetKey(entry.target);
                return [
                  entry.interruptionId,
                  ...(entry.target.kind === 'pipeline'
                    ? entry.target.statusReasonIds
                    : []),
                ].map((id) => `${key}:${id}`);
              }),
          ])
        : undefined;
      const additions: ResumeQueueEntry[] = [];
      for (const item of items) {
        const key = resumeTargetKey(item.target);
        if (
          suppressed &&
          [
            item.interruptionId,
            ...(item.target.kind === 'pipeline'
              ? item.target.statusReasonIds
              : []),
          ].some((id) => suppressed.has(`${key}:${id}`))
        )
          continue;
        const matchingPending = [...next.entries, ...additions].filter(
          (entry) => resumeTargetKey(entry.target) === key && pending(entry),
        );
        if (
          matchingPending.some(
            (entry) => entry.interruptionId === item.interruptionId,
          )
        )
          continue;
        const queued = matchingPending.find(
          (entry) => entry.id !== this.dispatchingId,
        );
        if (queued) {
          next.entries = next.entries.filter((entry) => entry.id !== queued.id);
          const additionIndex = additions.findIndex(
            (entry) => entry.id === queued.id,
          );
          if (additionIndex >= 0) additions.splice(additionIndex, 1);
        }
        if (
          next.entries.some(
            (entry) =>
              resumeTargetKey(entry.target) === key &&
              entry.interruptionId === item.interruptionId &&
              entry.status === 'resumed',
          )
        )
          continue;
        additions.push({
          ...item,
          id: randomUUID(),
          status: 'waiting',
          createdAt: this.deps.now(),
        });
      }
      if (!additions.length) return this.snapshot();
      if (next.entries.length + additions.length > 2000)
        throw new Error(
          'The resume queue is full. Finish or stop the current queue first.',
        );
      next.entries.push(...additions);
      await this.commit(next);
      return this.snapshot();
    });
  }

  async control(action: ResumeQueueControl): Promise<ResumeQueueSnapshot> {
    if (action === 'pause' || action === 'stop') this.admissionBlocked = true;
    return this.mutate(async () => {
      if (this.stopped) throw new Error('The application is shutting down.');
      const next = this.snapshot();
      if (action === 'pause') next.paused = true;
      else if (action === 'resume') next.paused = false;
      else if (action === 'stop') {
        next.paused = true;
        next.entries = next.entries.map((entry) =>
          entry.status === 'waiting' ||
          (entry.status === 'resuming' && entry.id !== this.handoffStartedId)
            ? { ...entry, status: 'stopped' }
            : entry,
        );
      } else if (action === 'dismiss') {
        if (next.entries.some(pending))
          throw new Error('The queue is still active.');
        const suppressed = new Map(
          (next.suppressedAutomaticResumes ?? []).map((entry) => [
            `${entry.targetKey}:${entry.interruptionId}`,
            entry,
          ]),
        );
        for (const entry of next.entries) {
          if (
            !entry.accountProxyConnectionId ||
            (entry.status !== 'stopped' &&
              entry.status !== 'failed' &&
              entry.status !== 'skipped')
          )
            continue;
          const targetKey = resumeTargetKey(entry.target);
          const interruptions =
            entry.target.kind === 'pipeline'
              ? [entry.interruptionId, ...entry.target.statusReasonIds]
              : [entry.interruptionId];
          for (const interruptionId of interruptions) {
            suppressed.set(`${targetKey}:${interruptionId}`, {
              targetKey,
              interruptionId,
            });
          }
        }
        const liveKeys =
          await this.deps.readLiveAutomaticResumeInterruptionKeys?.(
            Array.from(suppressed.values()),
          );
        next.suppressedAutomaticResumes = Array.from(
          suppressed.values(),
        ).filter(
          (entry) =>
            !liveKeys ||
            liveKeys.has(`${entry.targetKey}:${entry.interruptionId}`),
        );
        next.entries = [];
        next.paused = false;
      } else throw new Error('Invalid resume queue action.');
      await this.commit(next);
      if (action === 'resume' || action === 'dismiss')
        this.admissionBlocked = false;
      return this.snapshot();
    });
  }

  /** Remove only interruptions the canonical owners no longer report. */
  async pruneAutomaticResumeSuppressions(): Promise<void> {
    await this.mutate(async () => {
      const next = this.snapshot();
      const previous = next.suppressedAutomaticResumes ?? [];
      if (!previous.length) return;
      const liveKeys =
        await this.deps.readLiveAutomaticResumeInterruptionKeys?.(previous);
      if (!liveKeys) return;
      const retained = previous.filter((entry) =>
        liveKeys.has(`${entry.targetKey}:${entry.interruptionId}`),
      );
      if (previous.length === retained.length) return;
      next.suppressedAutomaticResumes = retained;
      await this.commit(next);
    });
  }

  /** One admission per call, paced after the previous startup finishes. */
  async tick(
    canDispatch:
      | boolean
      | ((entry: ResumeQueueEntry) => Promise<boolean>) = true,
  ): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let settleTick: () => void = (): void => undefined;
    this.tickDone = new Promise<void>((resolve) => {
      settleTick = resolve;
    });
    try {
      await this.initialize();
      if (
        this.admissionBlocked ||
        this.state.paused ||
        this.deps.now() < this.nextStartAt
      )
        return;
      const entry = await this.mutate(async () => {
        if (this.stopped || this.admissionBlocked || this.state.paused)
          return undefined;
        let selectedId: string | undefined;
        for (const candidate of this.state.entries) {
          if (candidate.status !== 'waiting') continue;
          const ready =
            typeof canDispatch === 'function'
              ? await canDispatch(candidate)
              : canDispatch;
          if (this.stopped || this.admissionBlocked || this.state.paused)
            return undefined;
          if (ready) {
            selectedId = candidate.id;
            break;
          }
        }
        if (!selectedId) return undefined;
        const next = this.snapshot();
        const selected = next.entries.find(
          (candidate) => candidate.id === selectedId,
        );
        if (!selected) return undefined;
        selected.status = 'resuming';
        await this.commit(next);
        this.dispatchingId = selected.id;
        return selected;
      });
      if (!entry) return;
      // A pause/quit can arrive during the durable claim; do not start in that case.
      if (this.stopped || this.admissionBlocked || this.state.paused) {
        await this.finish(entry.id, 'waiting');
        return;
      }
      let status: ResumeQueueEntry['status'];
      let error: string | undefined;
      try {
        this.handoffStartedId = entry.id;
        status = await this.deps.dispatch(entry);
      } catch (failure) {
        // A quitting host may reject preparation after its durable claim.
        // Keep that claim for recovery rather than recording a terminal failure.
        if (this.stopped) return;
        status = 'failed';
        error = failure instanceof Error ? failure.message : String(failure);
      }
      await this.finish(entry.id, status, error);
      this.nextStartAt = this.deps.now() + 10000;
    } finally {
      this.busy = false;
      this.dispatchingId = undefined;
      this.handoffStartedId = undefined;
      settleTick();
    }
  }

  private async finish(
    id: string,
    status: ResumeQueueEntry['status'],
    error?: string,
  ): Promise<void> {
    await this.mutate(async () => {
      const next = this.snapshot();
      const entry = next.entries.find((candidate) => candidate.id === id);
      if (!entry || entry.status === 'stopped') return;
      entry.status = status;
      if (error) entry.error = error;
      await this.commit(next);
    });
  }

  /** Stops admission synchronously. The persisted in-flight claim survives abrupt exit. */
  isStopping(): boolean {
    return this.stopped;
  }

  stop(error?: string): void {
    this.stopped = true;
    this.admissionBlocked = true;
    if (error) {
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        paused: true,
        error: this.state.error ?? error,
      };
      this.deps.changed(this.snapshot());
    }
  }
  async flush(): Promise<void> {
    await this.tickDone;
    await this.mutations;
  }
}

import type { StoredDelegationV3, StoredCardPublication } from './record-v3';
import {
  classifyCardDescriptor,
  materializeCardDraft,
} from './card-publication';
import type {
  DelegationTranscriptCardStateRequest,
  DelegationTranscriptGeneration,
  DelegationTranscriptPort,
  DelegationTranscriptPortError,
  DelegationTranscriptTarget,
} from './transcript-port';

interface Publication {
  attempted?: boolean;
  readonly record: StoredDelegationV3;
  readonly request: DelegationTranscriptCardStateRequest | undefined;
}
interface Barrier {
  readonly revision: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}
interface Entry {
  readonly target: DelegationTranscriptTarget;
  pending?: Publication;
  latest?: StoredDelegationV3;
  running: boolean;
  watermark: number;
  failure?: Error;
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
  readonly barriers: Set<Barrier>;
}
export interface CardPublicationQueueDependencies {
  readonly port: () => DelegationTranscriptPort;
  readonly rebase: (
    record: StoredDelegationV3,
    publication: StoredCardPublication,
  ) => Promise<StoredDelegationV3>;
  readonly onError: (error: unknown) => void;
}

function key(target: DelegationTranscriptTarget): string {
  return JSON.stringify([
    target.chatId,
    target.delegationId,
    target.runGeneration,
  ]);
}
class PublicationFailure extends Error {
  constructor(readonly portError: DelegationTranscriptPortError) {
    super(`Card publication ${portError.code}: ${portError.message}`);
  }
}

/** One immutable in-flight request, one replaceable pending pair, per generation. */
export class CardPublicationQueue {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly dependencies: CardPublicationQueueDependencies,
  ) {}

  private entry(target: DelegationTranscriptTarget): Entry {
    const existing = this.entries.get(key(target));
    if (existing) return existing;
    const entry: Entry = {
      target,
      running: false,
      watermark: 0,
      barriers: new Set(),
    };
    this.entries.set(key(target), entry);
    return entry;
  }

  enqueue(record: StoredDelegationV3, reconcile = false): void {
    if (this.closed) return;
    const target = record.readMetadata.current.target;
    const entry = this.entry(target);
    if (entry.failure) return;
    entry.latest = record;
    const cardDraft = materializeCardDraft(record);
    const revision = record.cardPublication?.cardRevision ?? 0;
    if (!reconcile && revision <= entry.watermark) return;
    entry.pending = {
      record,
      request:
        cardDraft === undefined
          ? undefined
          : {
              target: { ...target },
              cardRevision: revision,
              cardDraft,
            },
    };
    if (!entry.running) {
      entry.running = true;
      // Start after enqueue returns; no caller awaits the drain in its write chain.
      void Promise.resolve().then(() => this.drain(entry));
    }
  }

  watermark(target: DelegationTranscriptTarget): number {
    return this.entries.get(key(target))?.watermark ?? 0;
  }

  flush(target: DelegationTranscriptTarget, revision: number): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error('Card publication queue closed'));
    const entry = this.entry(target);
    if (entry.failure) return Promise.reject(entry.failure);
    if (entry.watermark >= revision) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      entry.barriers.add({ revision, resolve, reject });
    });
  }

  close(): void {
    this.closed = true;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.wake?.();
      this.fail(entry, new Error('Card publication queue closed'));
    }
  }

  private fail(entry: Entry, error: Error): void {
    entry.failure ??= error;
    entry.pending = undefined;
    for (const barrier of Array.from(entry.barriers))
      barrier.reject(entry.failure);
    entry.barriers.clear();
  }

  private acknowledge(entry: Entry, revision: number): void {
    if (this.closed || entry.failure) return;
    entry.watermark = Math.max(entry.watermark, revision);
    for (const barrier of Array.from(entry.barriers)) {
      if (barrier.revision > entry.watermark) continue;
      entry.barriers.delete(barrier);
      barrier.resolve();
    }
  }

  private pause(entry: Entry, delay: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      entry.wake = resolve;
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        entry.wake = undefined;
        resolve();
      }, delay);
    });
  }

  private async descriptor(
    entry: Entry,
    work: Publication,
  ): Promise<DelegationTranscriptGeneration> {
    const port = this.dependencies.port();
    const registered = await port.registerGeneration({
      chatId: entry.target.chatId,
      delegationId: entry.target.delegationId,
      ...work.record.registration,
    });
    if (!registered.ok) throw new PublicationFailure(registered.error);
    const found = await port.generation(entry.target);
    if (!found.ok) throw new PublicationFailure(found.error);
    if (
      found.value.stream === null &&
      found.value.result === null &&
      work.record.latestResult?.runGeneration !== entry.target.runGeneration
    ) {
      const opened = await port.open({ target: entry.target });
      if (!opened.ok) throw new PublicationFailure(opened.error);
      return {
        ...found.value,
        stream: { ...opened.value, contentRevision: null },
      };
    }
    return found.value;
  }

  private async classify(
    entry: Entry,
    work: Publication,
    descriptor: DelegationTranscriptGeneration,
    stale: boolean,
  ): Promise<boolean> {
    // Pre-12a settled null/V1 descriptors are deliberately outside convergence.
    if (
      descriptor.result !== null &&
      descriptor.stream?.cardState?.version !== 2
    ) {
      if (work.record.cardPublication)
        throw new PublicationFailure({
          code: 'conflict',
          retryable: false,
          message: 'Excluded settled card has a publication pair',
        });
      return true;
    }
    const storedRevision =
      descriptor.stream?.cardState?.version === 2
        ? descriptor.stream.cardState.cardRevision
        : 0;
    const current =
      storedRevision > (work.record.cardPublication?.cardRevision ?? 0)
        ? (entry.latest ?? work.record)
        : work.record;
    const classification = classifyCardDescriptor(
      current,
      descriptor.stream?.cardState,
    );
    if (classification.kind === 'covered') {
      this.acknowledge(entry, classification.cardRevision);
      return true;
    }
    if (classification.kind === 'rebase') {
      const rebased = await this.dependencies.rebase(
        current,
        classification.cardPublication,
      );
      this.enqueue(rebased, true);
      return true;
    }
    if (classification.kind === 'publish' && current !== work.record) {
      // Settle may admit an intermediate committed pair while this older write
      // is in flight. It is not a frozen-rule refusal of the newer pending pair.
      // Do not infer a watermark for the intermediate identity: publish latest.
      this.enqueue(current, true);
      return true;
    }
    if (classification.kind === 'conflict' || stale)
      throw new PublicationFailure({
        code: 'conflict',
        retryable: false,
        message: 'Descriptor card identity or frozen fields conflict',
      });
    return false;
  }

  private async publish(entry: Entry, work: Publication): Promise<void> {
    const descriptor = await this.descriptor(entry, work);
    if (
      !work.attempted &&
      (await this.classify(entry, work, descriptor, false))
    )
      return;
    if (!work.request) return;
    work.attempted = true;
    const result = await this.dependencies.port().updateCardState(work.request);
    if (!result.ok) {
      if (result.error.code !== 'stale_identity')
        throw new PublicationFailure(result.error);
      const found = await this.dependencies.port().generation(entry.target);
      if (!found.ok) throw new PublicationFailure(found.error);
      await this.classify(entry, work, found.value, true);
      return;
    }
    // A receipt alone is not a watermark. Check the stored full identity.
    const found = await this.dependencies.port().generation(entry.target);
    if (!found.ok) throw new PublicationFailure(found.error);
    if (!(await this.classify(entry, work, found.value, false)))
      throw new Error('Card publication was not visible in the descriptor');
  }

  private async drain(entry: Entry): Promise<void> {
    try {
      while (!this.closed && !entry.failure && entry.pending) {
        const work = entry.pending;
        entry.pending = undefined;
        let delay = 250;
        while (!this.closed && !entry.failure) {
          try {
            await this.publish(entry, work);
            break;
          } catch (error) {
            if (this.closed) return;
            if (
              error instanceof PublicationFailure &&
              !error.portError.retryable
            ) {
              const failure = error;
              this.fail(entry, failure);
              this.dependencies.onError(failure);
              return;
            }
            await this.pause(entry, delay);
            delay = Math.min(delay * 2, 30_000);
          }
        }
      }
    } finally {
      entry.running = false;
    }
  }
}

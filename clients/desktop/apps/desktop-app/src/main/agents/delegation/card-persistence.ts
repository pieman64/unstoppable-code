import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  type AgentDelegationSnapshot,
  type AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import { persistedDelegationSnapshot } from '@canopy/agent-transcript';

export { persistedDelegationSnapshot } from '@canopy/agent-transcript';

const SETTLED_STATUSES: ReadonlySet<AgentDelegationSnapshot['status']> =
  new Set<AgentDelegationSnapshot['status']>([
    'completed',
    'failed',
    'cancelled',
    'deadline_exceeded',
    'interrupted',
  ]);

function runKey(transcript: AgentDelegationTranscript): string {
  return `${transcript.delegationId}:${String(transcript.runGeneration)}`;
}

export interface DelegationCardPersistenceOptions {
  /** Commits one card snapshot to the parent chat (attached or detached). */
  publish: (transcript: AgentDelegationTranscript) => void;
  onError?: (error: unknown) => void;
}

/**
 * Commits a delegate's card only when its persisted projection changes:
 * when it appears, when its status, result or workspace changes, and when it
 * settles. A settled card is committed once the run's items are in the
 * delegate log, so a reader that sees the settled card finds them all.
 *
 * Commits carry the full snapshot and transcript for the event's other
 * consumers; chat state keeps only the card
 * (`chat-state-service.ts`, `withCardOnlyDelegation`).
 */
export class DelegationCardPersistence {
  private readonly published = new Map<string, string>();
  private readonly latestSequence = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DelegationCardPersistenceOptions) {}

  /** `logged` resolves when the run's items up to this snapshot are logged. */
  offer(transcript: AgentDelegationTranscript, logged: Promise<void>): void {
    const key = runKey(transcript);
    const latest = this.latestSequence.get(key);
    if (latest !== undefined && transcript.sequence <= latest) return;
    this.latestSequence.set(key, transcript.sequence);
    const projection = JSON.stringify(
      persistedDelegationSnapshot(transcript.snapshot),
    );
    if (this.published.get(key) === projection) return;
    this.published.set(key, projection);
    const card: AgentDelegationTranscript = {
      ...transcript,
      transcriptStore: DELEGATION_TRANSCRIPT_CHAT_LOG,
    };
    const ready = SETTLED_STATUSES.has(transcript.snapshot.status)
      ? logged
      : Promise.resolve();
    this.tail = this.tail
      .then(() => ready)
      .catch((error: unknown) => {
        // The card still commits: the log is display evidence, the card is
        // the run's canonical record in its parent chat.
        this.options.onError?.(error);
      })
      .then(() => {
        this.options.publish(card);
      });
  }

  /** Resolves once every offered card is published. */
  flush(): Promise<void> {
    return this.tail;
  }
}

/**
 * The human prompts a transcript shows and holds queued, reduced to what a
 * consumer needs to tell that the person just sent one. Callers project their
 * own messages: only prompts the person wrote count, never watcher, hook or
 * hidden prompts.
 */
export interface SentPromptSummary {
  /** Latest eligible human prompt in transcript order. */
  latest: { id: string; timestamp: number } | null;
  promptCount: number;
  queuedCount: number;
  /** Stable queue identities, when the host supplies them. */
  queuedIds?: readonly string[];
  /** Queue identities observed during this chat visit, including removed rows. */
  seenQueuedIds?: ReadonlySet<string>;
  /** Queued send identities already followed, even if removal preceded delivery. */
  seenQueuedPromptIds?: ReadonlySet<string>;
}

/**
 * Whether `next` adds a prompt the person sent since `previous`, either into
 * the transcript or into the queue. Both summaries must come from the same
 * initialized chat; the caller owns chat identity, loading and suppression.
 *
 * A send adds a prompt in total. Neither a queued prompt moving into the
 * transcript (it counted when queued) nor an optimistic row trading its id for
 * the persisted one does. A latest prompt at least as new as the previous one
 * also rules out older history pages loading in above.
 */
export function detectSentPrompt(
  previous: SentPromptSummary,
  next: SentPromptSummary,
): boolean {
  const sentNewPrompt =
    next.latest !== null &&
    !previous.seenQueuedPromptIds?.has(next.latest.id) &&
    next.latest.id !== previous.latest?.id &&
    next.latest.timestamp >= (previous.latest?.timestamp ?? 0) &&
    next.promptCount + next.queuedCount >
      previous.promptCount + previous.queuedCount;
  const previousQueueIds = previous.queuedIds;
  const nextQueueIds = next.queuedIds;
  const queuedNewPrompt =
    previousQueueIds !== undefined && nextQueueIds !== undefined
      ? nextQueueIds.some(
          (id) =>
            !previous.seenQueuedIds?.has(id) && !previousQueueIds.includes(id),
        )
      : next.queuedCount > previous.queuedCount;
  return sentNewPrompt || queuedNewPrompt;
}

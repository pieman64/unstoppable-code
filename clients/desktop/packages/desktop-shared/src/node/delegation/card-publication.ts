import {
  cardStateDraftFromSnapshot,
  fitCardStateDraft,
} from '@canopy/agent-transcript/lib/delegation-card-state';
import {
  CardStateDraftSchema,
  type CardState,
  type CardStateDraft,
} from '@canopy/protocol/canopy-core';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import {
  admissibleCardDraft,
  cardIdentity,
  storedCardDraft,
} from './card-state-rules';
import type { StoredCardPublication, StoredDelegationV3 } from './record-v3';

/** Restore the separately admission-bounded prompt; never infer an amendment. */
export function materializeCardDraft(
  record: StoredDelegationV3,
): CardStateDraft | undefined {
  const pair = record.cardPublication;
  return pair === undefined
    ? undefined
    : CardStateDraftSchema.parse({
        ...pair.draft,
        ...(pair.promptAmended ? { prompt: record.task.prompt } : {}),
      });
}

function publication(
  record: StoredDelegationV3,
  cardRevision: number,
  fullDraft: CardStateDraft,
): StoredCardPublication {
  const { prompt, ...draft } = CardStateDraftSchema.parse(fullDraft);
  return {
    runGeneration: record.state.runGeneration,
    cardRevision,
    promptAmended: prompt !== undefined,
    draft,
  };
}

/**
 * Candidate-only queued amendment latch. Always run prepareCardPublication in
 * the same transaction before committing. A provisional first counter is not
 * an allocation: preparation allocates from the committed previous record.
 */
export function setCardPromptAmended(
  record: StoredDelegationV3,
  snapshot: AgentDelegationSnapshot,
): StoredDelegationV3 {
  return {
    ...record,
    cardPublication: {
      runGeneration: record.state.runGeneration,
      cardRevision: record.cardPublication?.cardRevision ?? 1,
      promptAmended: true,
      draft:
        record.cardPublication?.draft ?? cardStateDraftFromSnapshot(snapshot),
    },
  };
}

function canonicallySettled(record: StoredDelegationV3): boolean {
  return record.latestResult?.runGeneration === record.state.runGeneration;
}

function retainField<Key extends keyof CardStateDraft>(
  next: CardStateDraft,
  previous: CardStateDraft,
  key: Key,
): void {
  if (previous[key] === undefined) delete next[key];
  else next[key] = previous[key];
}

/**
 * Pure serialized-admission preparation, before record encoding or storage.
 * latestResult for this generation proves canonical settle; a settling intent
 * alone does not. The committed fitted pair, not a recomputed snapshot, owns
 * the baseline. Creation/rollover starts with no draft and counter zero.
 */
export function prepareCardPublication(
  previous: StoredDelegationV3 | undefined,
  candidate: StoredDelegationV3,
  previousSnapshot: AgentDelegationSnapshot | undefined,
  candidateSnapshot: AgentDelegationSnapshot,
): StoredCardPublication | undefined {
  if (
    previous === undefined ||
    previous.state.runGeneration !== candidate.state.runGeneration
  )
    return undefined;

  const prior = materializeCardDraft(previous);
  const baseline =
    prior ??
    (previousSnapshot === undefined
      ? undefined
      : cardStateDraftFromSnapshot(previousSnapshot, {
          settled: canonicallySettled(previous),
        }));
  // A candidate locator also proves the port has already committed canonical
  // state; preserve the exact pair supplied to that settle on locator commit.
  const settled = canonicallySettled(previous) || canonicallySettled(candidate);
  const fitSettled = settled;
  const next = cardStateDraftFromSnapshot(candidateSnapshot, {
    ...(candidate.cardPublication?.promptAmended
      ? { prompt: candidate.task.prompt }
      : {}),
    settled: fitSettled,
  });
  if (baseline !== undefined) {
    if (baseline.status === 'running') next.status = 'running';
    for (const key of [
      'prompt',
      'routeSnapshot',
      'requestedModelId',
    ] as const) {
      if (next[key] === undefined && baseline[key] !== undefined)
        retainField(next, baseline, key);
    }
    if (baseline.status !== 'pending') retainField(next, baseline, 'prompt');
    if (settled) {
      for (const key of [
        'status',
        'prompt',
        'routeSnapshot',
        'requestedModelId',
        'nativeSessionId',
        'cancelledByUser',
        'stoppedBy',
        'outputTruncated',
      ] as const)
        retainField(next, baseline, key);
      if (baseline.detailOmitted) next.detailOmitted = true;
    }
  }
  const fitted = fitCardStateDraft(next, { settled: fitSettled });
  if (!admissibleCardDraft(prior, fitted, settled))
    throw new Error('The card publication changes retained or frozen fields.');
  // The pair cannot encode an override other than this candidate's task.
  if (fitted.prompt !== undefined && fitted.prompt !== candidate.task.prompt)
    throw new Error('The card publication cannot change a locked prompt.');
  if (prior !== undefined && cardIdentity(prior) === cardIdentity(fitted))
    return previous.cardPublication;
  const revision = previous.cardPublication?.cardRevision ?? 0;
  if (revision === Number.MAX_SAFE_INTEGER)
    throw new Error('The card publication counter is exhausted.');
  return publication(candidate, revision + 1, fitted);
}

export type CardDescriptorClassification =
  | { kind: 'covered'; cardRevision: number; excluded?: true }
  | { kind: 'publish' }
  | { kind: 'rebase'; cardPublication: StoredCardPublication }
  | { kind: 'conflict' };

/** Compare full fitted draft identities, never canonical wrappers or receipts. */
export function classifyCardDescriptor(
  record: StoredDelegationV3,
  state: CardState | null | undefined,
): CardDescriptorClassification {
  if (state?.version !== 2 && canonicallySettled(record))
    return { kind: 'covered', cardRevision: 0, excluded: true };
  const revision = record.cardPublication?.cardRevision ?? 0;
  const storedRevision = state?.version === 2 ? state.cardRevision : 0;
  const draft = state?.version === 2 ? storedCardDraft(state) : undefined;
  if (storedRevision < revision) return { kind: 'publish' };
  if (storedRevision === revision)
    return cardIdentity(materializeCardDraft(record) ?? null) ===
      cardIdentity(draft ?? null)
      ? { kind: 'covered', cardRevision: revision }
      : { kind: 'conflict' };
  // The task prompt is execution input; a card override never rewrites it.
  if (
    record.cardPublication !== undefined ||
    draft === undefined ||
    (draft.prompt !== undefined && draft.prompt !== record.task.prompt)
  )
    return { kind: 'conflict' };
  return {
    kind: 'rebase',
    cardPublication: publication(record, storedRevision, draft),
  };
}

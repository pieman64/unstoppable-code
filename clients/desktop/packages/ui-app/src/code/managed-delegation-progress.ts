import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';

/** Stream fields that may change before the parent chat commits a new card. */
export interface ManagedDelegationProgress {
  readonly runGeneration: number;
  readonly status: AgentDelegationSnapshot['status'];
  readonly phase?: AgentDelegationSnapshot['phase'];
  readonly queue?: AgentDelegationSnapshot['queue'];
  readonly approvalPending?: AgentDelegationSnapshot['approvalPending'];
}

type ManagedDelegationProgressCard = Pick<AgentDelegationSnapshot, 'status'> & {
  readonly runGeneration?: number;
  readonly phase?: AgentDelegationSnapshot['phase'];
  readonly queue?: AgentDelegationSnapshot['queue'];
  readonly approvalPending?: AgentDelegationSnapshot['approvalPending'];
};

type LiveOnlyFields = Pick<
  AgentDelegationSnapshot,
  'phase' | 'queue' | 'approvalPending'
>;

/** Durable fields retain their card type; only optional live fields are overlaid. */
export type ManagedDelegationProgressOverlay<
  Card extends ManagedDelegationProgressCard,
> = Omit<Card, keyof LiveOnlyFields> & LiveOnlyFields;

function isActiveStatus(status: AgentDelegationSnapshot['status']): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * Applies current stream-only fields without allowing a live snapshot to
 * replace durable card data or revive a settled or different generation.
 */
export function overlayManagedDelegationProgress<
  Card extends ManagedDelegationProgressCard,
>(
  card: Card,
  progress: ManagedDelegationProgress | undefined,
): ManagedDelegationProgressOverlay<Card> {
  const applies =
    progress !== undefined &&
    isActiveStatus(card.status) &&
    isActiveStatus(progress.status) &&
    progress.runGeneration === (card.runGeneration ?? 1);
  const live = applies ? progress : undefined;
  const phase = live?.phase;
  const queue = live?.queue;
  const approvalPending = live?.approvalPending;
  const hasPhase = Object.prototype.hasOwnProperty.call(card, 'phase');
  const hasQueue = Object.prototype.hasOwnProperty.call(card, 'queue');
  const hasApprovalPending = Object.prototype.hasOwnProperty.call(
    card,
    'approvalPending',
  );

  if (
    hasPhase === (phase !== undefined) &&
    card.phase === phase &&
    hasQueue === (queue !== undefined) &&
    card.queue === queue &&
    hasApprovalPending === (approvalPending !== undefined) &&
    card.approvalPending === approvalPending
  )
    return card;

  const {
    phase: _phase,
    queue: _queue,
    approvalPending: _approvalPending,
    ...durableCard
  } = card;
  void _phase;
  void _queue;
  void _approvalPending;

  return {
    ...durableCard,
    ...(phase === undefined ? {} : { phase }),
    ...(queue === undefined ? {} : { queue }),
    ...(approvalPending === undefined ? {} : { approvalPending }),
  };
}

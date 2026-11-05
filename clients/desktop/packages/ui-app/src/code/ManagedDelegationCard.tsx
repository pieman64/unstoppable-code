'use client';

import type { AgentDelegationCardData } from '@canopy/protocol/delegation';
import { DelegatedAgentCard } from '@canopy/ui-shared/components';
import { type ComponentProps, type JSX, type ReactNode } from 'react';
import {
  DelegationChildPages,
  isStreamBackedDelegation,
  type DelegationChildPagesProps,
} from './DelegationChildPages';

type HostSlots = Pick<
  ComponentProps<typeof DelegatedAgentCard>,
  | 'onStop'
  | 'onLoadChanges'
  | 'onCopyNativeSessionId'
  | 'onOpenChat'
  | 'onExpandedChange'
  | 'hasLiveDescendants'
  | 'waitingOnParent'
>;

type ChildPageInputs = Pick<
  DelegationChildPagesProps,
  'source' | 'hint' | 'renderRows' | 'renderBlock' | 'v2Available'
>;

/** Host-composed managed delegation card shared by desktop and the Portal. */
export interface ManagedDelegationCardProps extends HostSlots, ChildPageInputs {
  readonly delegation: AgentDelegationCardData;
  readonly runGeneration: number;
  readonly children?: ReactNode;
}

/**
 * Shares the managed card composition while leaving transport, actions and
 * transcript rendering in each host.
 */
export function ManagedDelegationCard(
  props: ManagedDelegationCardProps,
): JSX.Element {
  const {
    delegation,
    runGeneration,
    source,
    hint,
    renderRows,
    renderBlock,
    v2Available,
    children,
  } = props;
  const childPageInputs = {
    ...(source !== undefined ? { source } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(renderRows !== undefined ? { renderRows } : {}),
    ...(renderBlock !== undefined ? { renderBlock } : {}),
    ...(v2Available !== undefined ? { v2Available } : {}),
  };

  return (
    <DelegatedAgentCard
      snapshot={delegation}
      parentHarnessId={delegation.parentHarnessId}
      description={delegation.description}
      prompt={delegation.prompt}
      executionMode={delegation.executionMode}
      {...('onCopyNativeSessionId' in props
        ? { onCopyNativeSessionId: props.onCopyNativeSessionId }
        : {})}
      {...('onOpenChat' in props ? { onOpenChat: props.onOpenChat } : {})}
      {...('onExpandedChange' in props
        ? { onExpandedChange: props.onExpandedChange }
        : {})}
      {...('onStop' in props ? { onStop: props.onStop } : {})}
      {...('onLoadChanges' in props
        ? { onLoadChanges: props.onLoadChanges }
        : {})}
      {...('hasLiveDescendants' in props
        ? { hasLiveDescendants: props.hasLiveDescendants }
        : {})}
      {...('waitingOnParent' in props
        ? { waitingOnParent: props.waitingOnParent }
        : {})}
    >
      {isStreamBackedDelegation(delegation.transcriptStore) ? (
        <DelegationChildPages
          {...childPageInputs}
          {...(delegation.finalText !== undefined
            ? { finalText: delegation.finalText }
            : {})}
          delegationId={delegation.delegationId}
          runGeneration={runGeneration}
        />
      ) : (
        children
      )}
    </DelegatedAgentCard>
  );
}

import type { JSX } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ForkChatButton as SharedForkChatButton } from '@canopy/ui-shared';
import { ActionTooltip } from '../shared/ActionTooltip';

export interface ForkChatButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function ForkChatButton({
  onClick,
  disabled = false,
}: ForkChatButtonProps): JSX.Element {
  return (
    <ActionTooltip
      title={`Fork ${CHAT_UNIT_LABEL}`}
      // Not "full model context": a fork taken at an earlier turn keeps the
      // agent's context only up to that point, and a legacy transcript with
      // no chain entry to resume at starts fresh (the new tab says so).
      description={`Duplicate this ${CHAT_UNIT_LABEL} into a new tab. The agent keeps its context from this point.`}
    >
      <SharedForkChatButton
        ariaLabel={`Fork ${CHAT_UNIT_LABEL}`}
        dataTestId="fork-chat-button"
        onClick={onClick}
        disabled={disabled}
      />
    </ActionTooltip>
  );
}

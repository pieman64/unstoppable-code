import type { JSX } from 'react';
import { ArrowUpRightIcon } from '../../icons/AppIcons';
import { HeaderActionButton } from '../HeaderActionButton';
import { SUBAGENT_OPEN_CHAT_LABEL } from './subagents/subagent-copy';

export interface AgentCardOpenChatActionProps {
  readonly onOpenChat: () => void;
}

/** Opens the subagent chat from an expanded agent card's details. */
export function AgentCardOpenChatAction({
  onOpenChat,
}: AgentCardOpenChatActionProps): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <HeaderActionButton
        tone="accent"
        data-testid="agent-card-open-chat"
        onClick={onOpenChat}
      >
        <ArrowUpRightIcon size={14} aria-hidden />
        {SUBAGENT_OPEN_CHAT_LABEL}
      </HeaderActionButton>
    </div>
  );
}

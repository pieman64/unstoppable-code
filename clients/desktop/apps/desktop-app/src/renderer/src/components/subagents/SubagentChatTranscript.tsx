import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { memo, useCallback, type JSX, type ReactNode } from 'react';
import {
  SubagentTranscriptRows,
  type SubagentTranscriptContentItem,
} from '@canopy/ui-app/subagents';
import type { AgentSentReceivingContext } from '@canopy/ui-shared';
import { ChatBlockRenderer } from '@/components/chat/ChatBlockRenderer';
import type { SubagentChatTranscriptItem } from '@canopy/agent-transcript';

interface SubagentChatTranscriptProps {
  readonly items: readonly SubagentChatTranscriptItem[];
  readonly originChatTabId: string;
  readonly streaming?: boolean;
  readonly receivingContext?: AgentSentReceivingContext;
}

/** Renders the host-built transcript with the shared subagent chat bubbles. */
export const SubagentChatTranscript = memo(function SubagentChatTranscript({
  items,
  originChatTabId,
  streaming = false,
  receivingContext,
}: SubagentChatTranscriptProps): JSX.Element {
  const renderContent = useCallback(
    (
      item: SubagentTranscriptContentItem<SubagentChatTranscriptItem>,
    ): ReactNode => (
      <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-2`}>
        {item.blocks.map((block, index) => (
          <ChatBlockRenderer
            key={`${item.key}-${index}`}
            block={block}
            streaming={streaming}
            originChatTabId={originChatTabId}
            originMessageId={item.displayMessage.id}
            stripAgentCitations
            preserveLineBreaks={item.displayMessage.role === 'user'}
          />
        ))}
      </div>
    ),
    [originChatTabId, streaming],
  );
  return (
    <SubagentTranscriptRows
      items={items}
      renderContent={renderContent}
      receivingContext={receivingContext}
    />
  );
});

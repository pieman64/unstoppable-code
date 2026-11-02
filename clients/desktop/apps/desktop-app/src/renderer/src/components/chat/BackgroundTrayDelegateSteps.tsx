import { memo, useEffect, useMemo } from 'react';
import { delegateAgentStatus } from '@canopy/ui-app';
import { publishChatBackgroundAgentLive } from '@/stores/chatBackgroundWorkStore';
import { agentSteps } from './background-tray-agents';
import { useDelegatedAgentTranscript } from './delegated-agent-transcript';
import type { DisplayBlock } from './types';

type DelegatedAgentDisplayBlock = Extract<
  DisplayBlock,
  { type: 'delegated_agent_call' }
>;

/**
 * Renders nothing. While its row is listed, reads a logged delegate's own
 * transcript (its log and live snapshot, as its card does) and publishes the
 * steps and live status for the composer's background drawer: the parent's
 * transcript has none of the steps. A stream-backed delegate's rows come
 * from paged child reads instead, so its row keeps showing its prompt.
 */
export const BackgroundTrayDelegateSteps = memo(
  function BackgroundTrayDelegateSteps({
    chatKey,
    block,
  }: {
    readonly chatKey: string;
    readonly block: DelegatedAgentDisplayBlock;
  }): null {
    const transcript = useDelegatedAgentTranscript(block);
    const steps = useMemo(
      () => agentSteps(transcript.subBlocks),
      [transcript.subBlocks],
    );
    // The saved card drops a pending approval; the live snapshot keeps it.
    const status = delegateAgentStatus(transcript);
    const agentId = `managed:${block.delegationId}`;
    useEffect(() => {
      publishChatBackgroundAgentLive(chatKey, agentId, { steps, status });
    }, [agentId, chatKey, status, steps]);
    useEffect(
      () => (): void => publishChatBackgroundAgentLive(chatKey, agentId, null),
      [agentId, chatKey],
    );
    return null;
  },
);

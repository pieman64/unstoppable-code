import { createContext, useContext, useEffect, useMemo } from 'react';
import { delegationChildMessages } from '@canopy/agent-transcript';
import { DELEGATION_TRANSCRIPT_CHAT_LOG } from '@canopy/protocol/delegation';
import type { DelegatedAgentCallBlock } from '@canopy/agent-transcript/types';
import { mergeToolResults } from '@canopy/desktop-shared/lib/message-transforms';
import type { DisplayBlock } from './types';
import {
  useDelegationTranscriptStore,
  delegationRunKey,
  holdDelegationRun,
  type DelegationTranscriptSource,
} from '@/stores/delegationTranscriptStore';

/** The chat (and archive) whose transcript is being rendered. */
export const DelegationTranscriptSourceContext =
  createContext<DelegationTranscriptSource | null>(null);

type DelegatedAgentDisplayBlock = Extract<
  DisplayBlock,
  { type: 'delegated_agent_call' }
>;

function persistedBlock(
  block: DelegatedAgentDisplayBlock,
): DelegatedAgentCallBlock {
  const { subBlocks, ...card } = block;
  void subBlocks;
  return card;
}

/**
 * A logged card (`transcriptStore: 'chat-log-v1'`) with its live progress
 * and child blocks: from this session's live snapshots, else from the
 * delegate log, read once when the card mounts. Other cards are returned
 * unchanged: their children are rows of the committed transcript.
 */
export function useDelegatedAgentTranscript(
  block: DelegatedAgentDisplayBlock,
): DelegatedAgentDisplayBlock {
  const source = useContext(DelegationTranscriptSourceContext);
  const logged = block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG;
  const key =
    logged && source
      ? delegationRunKey(source, {
          delegationId: block.delegationId,
          runGeneration: block.runGeneration,
        })
      : undefined;
  const entry = useDelegationTranscriptStore((state) =>
    key === undefined ? undefined : state.runs[key],
  );
  const load = useDelegationTranscriptStore((state) => state.load);
  // The store keeps the run while this card shows it.
  useEffect(
    () => (key === undefined ? undefined : holdDelegationRun(key)),
    [key],
  );
  useEffect(() => {
    if (!logged || !source) return;
    load(source, {
      delegationId: block.delegationId,
      runGeneration: block.runGeneration,
    });
  }, [logged, source, load, block.delegationId, block.runGeneration]);

  return useMemo(() => {
    if (!logged || !entry) return block;
    const live = entry.live;
    // The live card is newer while its sequence has not been passed by a
    // committed card (a restart recovery or a later run's settle).
    const card: DelegatedAgentCallBlock =
      live && live.sequence >= block.sequence
        ? {
            ...persistedBlock(block),
            ...live.snapshot,
            sequence: live.sequence,
          }
        : persistedBlock(block);
    const items = live?.transcript ?? entry.logged ?? [];
    if (items.length === 0) return { ...card, subBlocks: [] };
    const [display] = mergeToolResults([
      {
        id: card.agentBlockId,
        role: 'assistant',
        timestamp: card.createdAt,
        blocks: [card],
      },
      ...delegationChildMessages(card.agentBlockId, items),
    ]);
    const merged = display?.blocks.find(
      (candidate): candidate is DelegatedAgentDisplayBlock =>
        candidate.type === 'delegated_agent_call',
    );
    return merged ?? { ...card, subBlocks: [] };
  }, [block, entry, logged]);
}

import { createContext, useContext, useEffect, useMemo } from 'react';
import { delegationChildMessages } from '@canopy/agent-transcript';
import { DELEGATION_TRANSCRIPT_CHAT_LOG } from '@canopy/protocol/delegation';
import type { DelegatedAgentCallBlock } from '@canopy/agent-transcript/types';
import type { TranscriptReadSource } from '@canopy/app-core';
import { isStreamBackedDelegation } from '@canopy/ui-app';
import { mergeToolResults } from '@canopy/desktop-shared/lib/message-transforms';
import type { DisplayBlock } from './types';
import { useChatStore } from '@/stores/chatStore';
import { chatScopeKey } from '@/stores/chat/revisioned-sync';
import { selectDelegationStreamHint } from '@/stores/chat/slices/revisioned';
import {
  useDelegationTranscriptStore,
  delegationRunKey,
  holdDelegationRun,
  type DelegationTranscriptSource,
} from '@/stores/delegationTranscriptStore';

/** The chat (and archive) whose transcript is being rendered. */
export const DelegationTranscriptSourceContext =
  createContext<DelegationTranscriptSource | null>(null);

/** The shared transcript readers' form of the rendered chat. */
export function transcriptReadSource(
  source: DelegationTranscriptSource,
): TranscriptReadSource {
  return {
    scope: {
      workspaceId: source.projectId,
      worktreeId: source.worktreeId,
      chatId: source.chatId,
    },
    ...(source.archivedContainerId
      ? { archivedContainerId: source.archivedContainerId }
      : {}),
    ...(source.standaloneHistory ? { standaloneHistory: true } : {}),
  };
}

type DelegatedAgentDisplayBlock = Extract<
  DisplayBlock,
  { type: 'delegated_agent_call' }
>;

/** Accepted revision state is independent of the card's own loaded snapshot. */
export function useDelegationStreamHint(
  block: DelegatedAgentDisplayBlock,
): { epoch: number; streamRevision: number } | undefined {
  const source = useContext(DelegationTranscriptSourceContext);
  const projectId = source?.projectId;
  const worktreeId = source?.worktreeId;
  const chatId = source?.chatId;
  // Only a stream card reads child pages, so only it subscribes to hints.
  const streamBacked = isStreamBackedDelegation(block.transcriptStore);
  const selector = useMemo(
    () =>
      streamBacked && projectId && worktreeId && chatId
        ? selectDelegationStreamHint(
            chatScopeKey(projectId, worktreeId),
            chatId,
            block.delegationId,
            block.runGeneration,
          )
        : (): undefined => undefined,
    [
      streamBacked,
      projectId,
      worktreeId,
      chatId,
      block.delegationId,
      block.runGeneration,
    ],
  );
  return useChatStore(selector);
}

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
 * delegate log, read once when the card mounts. Active current-chat cards
 * bootstrap their progress separately from the existing snapshot endpoint.
 * Other cards are returned
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
  const hydrateCurrent = useDelegationTranscriptStore(
    (state) => state.hydrateCurrent,
  );
  const current =
    source !== null && !source.archivedContainerId && !source.standaloneHistory;
  const active = block.status === 'pending' || block.status === 'running';
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
  useEffect(() => {
    if (!logged || !source || !current || !active) return;
    hydrateCurrent(source, {
      delegationId: block.delegationId,
      runGeneration: block.runGeneration,
    });
  }, [
    logged,
    source,
    current,
    active,
    hydrateCurrent,
    block.delegationId,
    block.runGeneration,
  ]);

  return useMemo(() => {
    if (!logged || !entry) return block;
    const live = entry.live;
    // A historical copy never reads current state. A settled committed card
    // also wins over reconnect hydration, even at the same revision.
    const hydrated = current && active ? entry.hydrated : undefined;
    const progress =
      live && (!hydrated || live.sequence >= hydrated.revision)
        ? { snapshot: live.snapshot, revision: live.sequence }
        : hydrated;
    // Read and live progress can only overlay a committed card whose
    // sequence has not passed their revision.
    const card: DelegatedAgentCallBlock =
      progress && progress.revision >= block.sequence
        ? {
            ...persistedBlock(block),
            ...progress.snapshot,
            sequence: progress.revision,
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
  }, [block, entry, logged, current, active]);
}

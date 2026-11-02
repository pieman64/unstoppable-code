import { createHash } from 'node:crypto';
import {
  delegationChildMessages,
  type DelegatedAgentCallBlock,
  type DelegationChildRow,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';
import type {
  TranscriptStreamDescriptor,
  TranscriptTarget,
} from '@canopy/protocol/canopy-core';
import type { ChatDelegationLogs } from './chat-delegation-log';
import { delegationStreamKey } from './transcript-stream-paths';
import { isDelegationChildRow } from './chat-transcript-log';

type DelegationTarget = Extract<TranscriptTarget, { kind: 'delegation' }>;

/** A card selected evidence that is absent, rather than a known empty run. */
export class MissingDelegationTranscriptSourceError extends Error {
  public override readonly name = 'MissingDelegationTranscriptSourceError';
  public readonly code = 'missing_source';

  public constructor(public readonly source: 'chat-log-v1' | 'chat-stream-v2') {
    // Preserve the existing dispatcher not-found classification.
    super('Unknown child stream');
  }
}

export interface LegacyDelegationRead {
  readonly descriptor: TranscriptStreamDescriptor;
  readonly rows: readonly DelegationChildRow[];
  readonly runTruncated?: true;
}

/** Select the exact generation's card, never a broker record or another run. */
export function delegationReadCard(
  target: DelegationTarget,
  rows: readonly PersistedChatMessage[],
): DelegatedAgentCallBlock | undefined {
  for (const row of rows)
    for (const block of row.blocks)
      if (
        block.type === 'delegated_agent_call' &&
        block.delegationId === target.delegationId &&
        block.runGeneration === target.runGeneration
      )
        return block;
  return undefined;
}

/**
 * Read only the card-selected legacy evidence. No writer, registry, recovery or
 * index is opened here. The digest includes the source and all retained fields,
 * including lone UTF-16 code units (JSON escapes them without replacement).
 */
export async function readLegacyDelegation(
  target: DelegationTarget,
  card: Pick<
    DelegatedAgentCallBlock,
    'agentBlockId' | 'transcriptStore' | 'outputTruncated'
  >,
  parentRows: readonly PersistedChatMessage[],
  logs: Pick<ChatDelegationLogs, 'has' | 'read'>,
): Promise<LegacyDelegationRead> {
  let selected: PersistedChatMessage[];
  if (card.transcriptStore === 'chat-log-v1') {
    if (!(await logs.has(target.chatId, target)))
      throw new MissingDelegationTranscriptSourceError('chat-log-v1');
    selected = delegationChildMessages(
      card.agentBlockId,
      await logs.read(target.chatId, target),
    );
  } else {
    selected = parentRows.filter(
      (row) => row.parentBlockId === card.agentBlockId,
    );
  }
  const latest = new Map<string, PersistedChatMessage>();
  for (const row of selected) latest.set(row.id, row);
  const rows: DelegationChildRow[] = Array.from(latest.values()).map((row) =>
    isDelegationChildRow(row) ? row : { ...row, itemRevision: 0, final: true },
  );
  const runTruncated =
    card.outputTruncated ||
    rows.some((row) => 'truncated' in row && row.truncated === true);
  const serialized = JSON.stringify({
    source: card.transcriptStore ?? 'inline',
    runTruncated,
    rows,
  });
  const digest = createHash('sha256').update(serialized).digest('hex');
  // Existing portable read cursors carry safe integer revisions. A 52-bit
  // content/source fingerprint pins legacy revisions without writing an index.
  const revision = Number.parseInt(digest.slice(0, 13), 16);
  return {
    rows,
    ...(runTruncated ? { runTruncated: true } : {}),
    // Read-local metadata only: never published as a registered stream.
    descriptor: {
      version: 1,
      target,
      streamKey: delegationStreamKey(target),
      checkpointRevision: revision,
      status: 'open',
      streamRevision: revision,
      committedRowCount: rows.length,
      latestRowTimestamp: rows[rows.length - 1]?.timestamp ?? null,
      committedByteLength: Buffer.byteLength(serialized),
      committedSha256: digest,
      settleReceipt: null,
      cardState: null,
    },
  };
}

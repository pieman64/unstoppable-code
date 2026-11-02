import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { format4Scope, reopenFormat4Scope } from './chat-format4-scope';
import { scopeSource } from './chat-delta-journal-harness';
import { card, child, parent, target } from './stream-closure-copy-fixture';
import type { ChatStateV2Backend } from '../../services/chat-state-v2-backend';

export const OLD_TEXT = 'oldest child page: preserved verbatim';
export const BODY_TEXT = 'beyond preview sentinel\n'.repeat(6000);
export const PAGED_TEXT = 'logical block page sentinel\n'.repeat(2500);

export async function portableFixture(
  root: string,
  scopeId = 'portable',
): Promise<Awaited<ReturnType<typeof format4Scope>>> {
  const legacyCard = {
    ...card(),
    delegationId: 'legacy',
    agentBlockId: 'delegated-agent-legacy',
    transcriptStore: 'chat-log-v1' as const,
  };
  const fixture = await format4Scope(
    root,
    scopeId,
    scopeSource([
      {
        id: 'chat',
        messages: [
          parent(),
          { ...parent(), id: 'legacy-parent', blocks: [legacyCard] },
        ],
      },
    ]),
  );
  await fixture.backend.registerTranscriptStream(target);
  const first = { ...child(false, OLD_TEXT), id: 'row-0' };
  const finalRows: DelegationChildRow[] = Array.from(
    { length: 105 },
    (_, i) => ({
      ...child(true, `chronological child ${i + 1}`),
      id: `row-${i + 1}`,
      delegationSequence: i + 1,
    }),
  );
  finalRows[0] = {
    ...child(true),
    id: 'row-1',
    delegationSequence: 1,
    blocks: [
      { type: 'text', text: 'first logical block' },
      ...Array.from({ length: 20 }, () => ({
        type: 'text' as const,
        text: PAGED_TEXT,
      })),
      {
        type: 'tool_result',
        toolUseId: 'tool',
        toolName: 'Read',
        output: BODY_TEXT,
        isError: false,
      },
    ],
  };
  // Physical finalization order is deliberately the reverse of logical order.
  await fixture.backend.commitChildStream(target, 'reverse-finals', [
    first,
    ...finalRows.reverse(),
  ]);
  await fixture.backend.appendDelegationLog('chat', [
    {
      run: { delegationId: 'legacy', runGeneration: 1 },
      items: [
        {
          id: 'legacy-answer',
          sequence: 1,
          occurredAt: 3,
          type: 'text',
          text: 'legacy child exact text',
        },
      ],
    },
  ]);
  await fixture.backend.demoteFromDeltaJournal();
  return reopenFormat4Scope(root, scopeId, {
    deltaJournal: false,
    enableFormat4: false,
  });
}

export async function portableRows(
  backend: ChatStateV2Backend,
  fullOutputs = true,
): Promise<PersistedChatMessage[]> {
  return backend.consumeTranscript(
    'chat',
    fullOutputs,
    async (source) => {
      const rows: PersistedChatMessage[] = [];
      for await (const row of source) rows.push(row);
      return rows;
    },
    { inlineDelegationChildren: true },
  );
}

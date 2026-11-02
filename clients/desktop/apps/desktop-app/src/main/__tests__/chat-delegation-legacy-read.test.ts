import {
  MissingDelegationTranscriptSourceError,
  readLegacyDelegation,
} from '../lib/chat-delegation-legacy-read';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import type { PersistedChatMessage } from '@canopy/agent-transcript';

const target = {
  kind: 'delegation' as const,
  chatId: 'chat',
  delegationId: 'delegate',
  runGeneration: 2,
};
const inline = { agentBlockId: 'generation-2', outputTruncated: false };
const log = { ...inline, transcriptStore: 'chat-log-v1' as const };
const row: PersistedChatMessage = {
  id: 'inline-id',
  role: 'assistant',
  timestamp: 3,
  parentBlockId: 'generation-2',
  delegationSequence: 0,
  blocks: [{ type: 'text', text: 'inline only' }],
};

describe('write-free legacy delegation projection', () => {
  it('uses only the marker-selected source and distinguishes absent from empty logs', async () => {
    const logs = {
      has: jest.fn().mockResolvedValue(false),
      read: jest.fn().mockResolvedValue([]),
    };
    await expect(
      readLegacyDelegation(target, log, [row], logs),
    ).rejects.toBeInstanceOf(MissingDelegationTranscriptSourceError);
    expect(logs.read).not.toHaveBeenCalled();
    logs.has.mockResolvedValue(true);
    expect((await readLegacyDelegation(target, log, [row], logs)).rows).toEqual(
      [],
    );
    logs.has.mockClear();
    logs.read.mockClear();
    expect((await readLegacyDelegation(target, inline, [], logs)).rows).toEqual(
      [],
    );
    expect(logs.has).not.toHaveBeenCalled();
    expect(logs.read).not.toHaveBeenCalled();
  });

  it('preserves inline ids, order, author/delivery and latest repeated rows without inspecting logs', async () => {
    const logs = { has: jest.fn(), read: jest.fn() };
    const authored: PersistedChatMessage = {
      ...row,
      id: 'authored',
      role: 'user',
      delegationSequence: 1,
      delegationAuthor: { kind: 'user' },
      delegationDelivery: 'steer',
      blocks: [{ type: 'text', text: 'retained 🌲\ud800' }],
    };
    const result = await readLegacyDelegation(
      target,
      inline,
      [
        row,
        authored,
        { ...row, blocks: [{ type: 'text', text: 'newer' }] },
        { ...row, id: 'foreign', parentBlockId: 'generation-1' },
      ],
      logs,
    );
    expect(result.rows).toEqual([
      {
        ...row,
        blocks: [{ type: 'text', text: 'newer' }],
        itemRevision: 0,
        final: true,
      },
      { ...authored, itemRevision: 0, final: true },
    ]);
    expect(logs.has).not.toHaveBeenCalled();
    expect(logs.read).not.toHaveBeenCalled();
  });

  it('retains tool input/output and authored metadata in the log projection', async () => {
    const items: AgentDelegationTranscriptItem[] = [
      {
        id: 'tool',
        sequence: 0,
        occurredAt: 1,
        type: 'tool',
        toolName: 'shell',
        input: 'echo 🌲\ud800',
        output: 'out\udc00',
        isError: true,
        truncated: true,
      },
      {
        id: 'human',
        sequence: 1,
        occurredAt: 2,
        type: 'text',
        text: 'steer 漢字',
        author: { kind: 'agent', depth: 1, delegationId: 'parent' },
        delivery: 'follow_up',
      },
    ];
    const logs = {
      has: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue(items),
    };
    const result = await readLegacyDelegation(target, log, [row], logs);
    expect(result.rows).toEqual([
      {
        id: 'generation-2:tool',
        role: 'assistant',
        timestamp: 1,
        parentBlockId: 'generation-2',
        delegationSequence: 0,
        itemRevision: 0,
        final: true,
        truncated: true,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'generation-2:tool',
            toolName: 'shell',
            input: 'echo 🌲\ud800',
          },
          {
            type: 'tool_result',
            toolUseId: 'generation-2:tool',
            toolName: 'shell',
            output: 'out\udc00',
            isError: true,
          },
        ],
      },
      {
        id: 'generation-2:human',
        role: 'user',
        timestamp: 2,
        parentBlockId: 'generation-2',
        delegationSequence: 1,
        itemRevision: 0,
        final: true,
        delegationAuthor: { kind: 'agent', depth: 1, delegationId: 'parent' },
        delegationDelivery: 'follow_up',
        blocks: [{ type: 'text', text: 'steer 漢字' }],
      },
    ]);
    expect(result.runTruncated).toBe(true);
  });

  it('pins source, retained body and truncation in the read revision', async () => {
    const logs = {
      has: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue([]),
    };
    const first = await readLegacyDelegation(target, inline, [row], logs);
    expect(first).not.toHaveProperty('runTruncated');
    expect(
      (await readLegacyDelegation(target, inline, [row], logs)).descriptor
        .streamRevision,
    ).toBe(first.descriptor.streamRevision);
    const changed = await readLegacyDelegation(
      target,
      inline,
      [{ ...row, blocks: [{ type: 'text', text: 'changed' }] }],
      logs,
    );
    expect(changed.descriptor.streamRevision).not.toBe(
      first.descriptor.streamRevision,
    );
    const empty = await readLegacyDelegation(target, inline, [], logs);
    expect(
      (await readLegacyDelegation(target, log, [], logs)).descriptor
        .streamRevision,
    ).not.toBe(empty.descriptor.streamRevision);
    const truncated = await readLegacyDelegation(
      target,
      { ...inline, outputTruncated: true },
      [],
      logs,
    );
    expect(truncated).toHaveProperty('runTruncated', true);
    expect(truncated.descriptor.streamRevision).not.toBe(
      empty.descriptor.streamRevision,
    );
  });
});

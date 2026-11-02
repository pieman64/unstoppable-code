import {
  isAgentDelegationTranscript,
  type AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import type {
  DelegatedAgentCallBlock,
  PersistedChatMessage,
} from '../../types';
import {
  applyDelegationTranscriptEvent,
  delegationChildMessages,
  delegationTranscriptMessages,
} from '../delegation-transcript';
import {
  createEmptyTranscriptReducerState,
  type TranscriptReducerState,
} from '../transcript-parser';

const reference = {
  version: 1 as const,
  artifactId: `sha256-v1-${'b'.repeat(64)}`,
  sha256: 'b'.repeat(64),
  byteLength: 100,
  encoding: 'utf-8' as const,
  mediaType: 'text/plain' as const,
};
const card: DelegatedAgentCallBlock & {
  futureRef: { key: string };
  futureFlag: string;
} = {
  type: 'delegated_agent_call',
  agentBlockId: 'delegated-agent-child',
  delegationId: 'child',
  runGeneration: 1,
  sequence: 2,
  status: 'pending',
  parentHarnessId: 'claude',
  parentTurnId: 'turn',
  parentToolCallId: 'tool',
  createdAt: 10,
  selectedModelId: 'model',
  runtimeModelId: '',
  targetHarnessId: '',
  requestedModelId: 'model',
  outputTruncated: false,
  description: 'Task',
  prompt: 'Prompt',
  executionMode: 'background',
  partialText: 'same',
  partialTextRef: reference,
  finalText: 'done',
  finalTextRef: reference,
  futureRef: { key: 'opaque' },
  futureFlag: 'keep',
};
function event(sequence = 3): AgentDelegationTranscript {
  return {
    delegationId: 'child',
    runGeneration: 1,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'tool',
    createdAt: 10,
    task: {
      description: 'Task',
      prompt: 'Prompt',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'child',
      status: 'pending',
      requestedModelId: 'model',
      outputTruncated: false,
      partialText: 'same',
      finalText: 'done',
    },
    transcript: [],
  };
}
function state(block: DelegatedAgentCallBlock = card): TranscriptReducerState {
  const row: PersistedChatMessage & {
    futureRowRef: { key: string };
    futureFlag: string;
  } = {
    id: 'delegated-agent-child',
    role: 'assistant',
    timestamp: 10,
    blocks: [block],
    futureRowRef: { key: 'opaque-row' },
    futureFlag: 'row-keep',
  };
  return { ...createEmptyTranscriptReducerState(), messages: [row] };
}

describe('phase 14 legacy rewrite preservation', () => {
  beforeEach(() => {
    expect(isAgentDelegationTranscript(event())).toBe(true);
  });
  it('retains prior card and row unknown fields and unchanged body references', () => {
    const updated = applyDelegationTranscriptEvent(state(), {
      delegation: event(),
    });
    expect(updated.messages[0]).toMatchObject({
      futureRowRef: { key: 'opaque-row' },
      futureFlag: 'row-keep',
    });
    expect(updated.messages[0]?.blocks[0]).toMatchObject({
      sequence: 3,
      futureRef: { key: 'opaque' },
      futureFlag: 'keep',
      partialTextRef: reference,
      finalTextRef: reference,
    });
  });
  it('drops only references whose corresponding body was replaced', () => {
    const next = event();
    const updated = applyDelegationTranscriptEvent(state(), {
      delegation: {
        ...next,
        snapshot: { ...next.snapshot, partialText: 'replacement' },
      },
    });
    const block = updated.messages[0]?.blocks[0];
    expect(block).toMatchObject({
      partialText: 'replacement',
      finalTextRef: reference,
      futureRef: { key: 'opaque' },
    });
    expect(block).not.toHaveProperty('partialTextRef');
  });
  it('does not restore omitted known bodies or their references (control)', () => {
    const next = event();
    const updated = applyDelegationTranscriptEvent(state(), {
      delegation: {
        ...next,
        snapshot: {
          delegationId: 'child',
          status: 'pending',
          requestedModelId: 'model',
          outputTruncated: false,
        },
      },
    });
    const block = updated.messages[0]?.blocks[0];
    expect(block).not.toHaveProperty('partialText');
    expect(block).not.toHaveProperty('partialTextRef');
    expect(block).not.toHaveProperty('finalText');
    expect(block).not.toHaveProperty('finalTextRef');
  });
  it.each([1, 2])(
    'keeps equal/stale sequence %i state unchanged (control)',
    (sequence) => {
      const previous = state();
      expect(
        applyDelegationTranscriptEvent(previous, {
          delegation: event(sequence),
        }),
      ).toBe(previous);
    },
  );
  it('keeps a stream card write-once under a later legacy envelope', () => {
    const previous = state({ ...card, transcriptStore: 'chat-stream-v2' });
    expect(
      applyDelegationTranscriptEvent(previous, { delegation: event(9) }),
    ).toBe(previous);
  });
  it('projects item truncation only when written', () => {
    expect(
      delegationChildMessages('card', [
        {
          id: 'short',
          type: 'text',
          text: 'retained',
          occurredAt: 20,
          sequence: 1,
          truncated: true,
        },
        {
          id: 'whole',
          type: 'thinking',
          text: 'whole',
          occurredAt: 21,
          sequence: 2,
        },
      ]),
    ).toEqual([
      {
        id: 'card:short',
        role: 'assistant',
        timestamp: 20,
        parentBlockId: 'card',
        delegationSequence: 1,
        blocks: [{ type: 'text', text: 'retained' }],
        truncated: true,
      },
      {
        id: 'card:whole',
        role: 'assistant',
        timestamp: 21,
        parentBlockId: 'card',
        delegationSequence: 2,
        blocks: [{ type: 'thinking', text: 'whole' }],
      },
    ]);
  });
  it('keeps the legacy projection byte-equal to an independent literal golden (control)', () => {
    const value = event(1);
    expect(
      JSON.stringify(
        delegationTranscriptMessages({
          ...value,
          transcript: [
            {
              id: 'text',
              type: 'text',
              text: 'hello',
              occurredAt: 20,
              sequence: 1,
            },
          ],
        }),
      ),
    ).toBe(
      JSON.stringify([
        {
          id: 'delegated-agent-child',
          role: 'assistant',
          timestamp: 10,
          blocks: [
            {
              delegationId: 'child',
              status: 'pending',
              requestedModelId: 'model',
              outputTruncated: false,
              partialText: 'same',
              finalText: 'done',
              type: 'delegated_agent_call',
              agentBlockId: 'delegated-agent-child',
              runGeneration: 1,
              sequence: 1,
              parentHarnessId: 'claude',
              parentTurnId: 'turn',
              parentToolCallId: 'tool',
              createdAt: 10,
              selectedModelId: 'model',
              runtimeModelId: '',
              targetHarnessId: '',
              description: 'Task',
              prompt: 'Prompt',
              executionMode: 'background',
            },
          ],
        },
        {
          id: 'delegated-agent-child:text',
          role: 'assistant',
          timestamp: 20,
          parentBlockId: 'delegated-agent-child',
          delegationSequence: 1,
          blocks: [{ type: 'text', text: 'hello' }],
        },
      ]),
    );
  });
  it('keeps a legacy rewrite without extensions byte-equal to a literal golden (control)', () => {
    const previous = {
      ...createEmptyTranscriptReducerState(),
      messages: [
        {
          id: 'delegated-agent-child',
          role: 'assistant' as const,
          timestamp: 10,
          blocks: [
            {
              type: 'delegated_agent_call' as const,
              agentBlockId: 'delegated-agent-child',
              delegationId: 'child',
              runGeneration: 1,
              sequence: 1,
              status: 'pending' as const,
              outputTruncated: false,
              parentHarnessId: 'claude',
              parentTurnId: 'turn',
              parentToolCallId: 'tool',
              createdAt: 10,
              selectedModelId: 'model',
              runtimeModelId: '',
              targetHarnessId: '',
              description: 'Task',
              prompt: 'Prompt',
              executionMode: 'background' as const,
            },
          ],
        },
      ],
    };
    expect(
      JSON.stringify(
        applyDelegationTranscriptEvent(previous, { delegation: event() })
          .messages,
      ),
    ).toBe(
      JSON.stringify([
        {
          id: 'delegated-agent-child',
          role: 'assistant',
          timestamp: 10,
          blocks: [
            {
              delegationId: 'child',
              status: 'pending',
              requestedModelId: 'model',
              outputTruncated: false,
              partialText: 'same',
              finalText: 'done',
              type: 'delegated_agent_call',
              agentBlockId: 'delegated-agent-child',
              runGeneration: 1,
              sequence: 3,
              parentHarnessId: 'claude',
              parentTurnId: 'turn',
              parentToolCallId: 'tool',
              createdAt: 10,
              selectedModelId: 'model',
              runtimeModelId: '',
              targetHarnessId: '',
              description: 'Task',
              prompt: 'Prompt',
              executionMode: 'background',
            },
          ],
        },
      ]),
    );
  });
});

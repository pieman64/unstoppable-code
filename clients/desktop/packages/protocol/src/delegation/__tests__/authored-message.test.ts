import {
  isAgentDelegationTranscript,
  isAgentDelegationTranscriptItem,
} from '..';
import { isAgentDelegationTranscript as previousValidator } from './fixtures/previous-transcript-validator';

const item = {
  id: 'user-message',
  sequence: 1,
  occurredAt: 1,
  type: 'text',
  text: 'Please review this.',
  author: { kind: 'user' },
  delivery: 'follow_up',
};
const event = {
  delegationId: 'child',
  runGeneration: 1,
  sequence: 1,
  createdAt: 1,
  parentHarnessId: 'claude',
  parentTurnId: 'turn',
  parentToolCallId: 'call',
  task: {
    description: 'Review',
    prompt: 'Inspect',
    executionMode: 'background',
  },
  snapshot: {
    delegationId: 'child',
    status: 'pending',
    requestedModelId: 'review',
    outputTruncated: false,
  },
  transcript: [item],
};

describe('authored delegation messages', () => {
  it('is accepted by the exact previous event validator as plain text', () => {
    expect(previousValidator(event)).toBe(true);
    expect(isAgentDelegationTranscript(event)).toBe(true);
  });
  it('accepts agent lineage and legacy text without new fields', () => {
    expect(
      isAgentDelegationTranscriptItem({
        ...item,
        author: {
          kind: 'agent',
          depth: 2,
          delegationId: 'parent',
          description: 'Review',
        },
        delivery: 'steer',
      }),
    ).toBe(true);
    expect(
      isAgentDelegationTranscriptItem({
        id: 'plain',
        sequence: 2,
        occurredAt: 2,
        type: 'text',
        text: 'Legacy',
      }),
    ).toBe(true);
  });
  it.each([
    { author: { kind: 'user', depth: 0 } },
    { author: { kind: 'agent', depth: 10 } },
    { author: { kind: 'agent', depth: -1 } },
    { author: { kind: 'agent', depth: 1, delegationId: 'x'.repeat(513) } },
    { author: { kind: 'agent', depth: 1, description: 'x'.repeat(201) } },
    { author: { kind: 'robot' } },
    { delivery: 'interrupt' },
    { delivery: { toString: (): string => 'steer' } },
    { type: 'thinking' },
    { type: 'tool', toolName: 'Read', input: '{}' },
  ])('rejects invalid additive fields %p', (fields) => {
    expect(isAgentDelegationTranscriptItem({ ...item, ...fields })).toBe(false);
  });
});

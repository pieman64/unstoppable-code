import type { PersistedChatMessage } from '../../types';
import { resolveClaudeForkResumePoint } from '../claude-fork-resume-point';

const CHAIN_A1 = '11111111-1111-4111-8111-111111111111';
const CHAIN_A2 = '22222222-2222-4222-8222-222222222222';
const CHAIN_A3 = '33333333-3333-4333-8333-333333333333';
const CHAIN_R1 = '44444444-4444-4444-8444-444444444444';

function message(
  id: string,
  claudeUuid?: string,
  role: PersistedChatMessage['role'] = 'assistant',
): PersistedChatMessage {
  return {
    id,
    role,
    timestamp: 1,
    blocks: [{ type: 'text', text: id }],
    ...(claudeUuid ? { claudeUuid } : {}),
  };
}

describe('resolveClaudeForkResumePoint', () => {
  it('returns the anchor message chain uuid', () => {
    const messages = [
      message('u1', undefined, 'user'),
      message('a1', CHAIN_A1),
    ];
    expect(resolveClaudeForkResumePoint(messages, 'a1')).toBe(CHAIN_A1);
  });

  it('walks back to the nearest earlier stamped message when the anchor has none', () => {
    // Turn timers are Canopy-minted system rows with no provider chain entry,
    // and they are frequently the last kept message of a fork.
    const messages = [
      message('u1', undefined, 'user'),
      message('a1', CHAIN_A1),
      message('timer-1', undefined, 'system'),
    ];
    expect(resolveClaudeForkResumePoint(messages, 'timer-1')).toBe(CHAIN_A1);
  });

  it('ignores messages after the anchor', () => {
    const messages = [
      message('a1', CHAIN_A1),
      message('a2', CHAIN_A2),
      message('a3', CHAIN_A3),
    ];
    expect(resolveClaudeForkResumePoint(messages, 'a1')).toBe(CHAIN_A1);
  });

  it('returns undefined when no kept message carries a chain uuid', () => {
    const messages = [
      message('u1', undefined, 'user'),
      message('a1'),
      message('timer-1', undefined, 'system'),
    ];
    expect(resolveClaudeForkResumePoint(messages, 'timer-1')).toBeUndefined();
  });

  it('returns undefined when the anchor is not in the transcript', () => {
    const messages = [message('a1', CHAIN_A1)];
    expect(resolveClaudeForkResumePoint(messages, 'missing')).toBeUndefined();
  });

  it('falls back to the last stamped message when no anchor is supplied', () => {
    const messages = [message('a1', CHAIN_A1), message('a2', CHAIN_A2)];
    expect(resolveClaudeForkResumePoint(messages, undefined)).toBe(CHAIN_A2);
  });

  it('ignores malformed persisted chain uuids', () => {
    const messages = [message('a1', 'not-a-chain-uuid')];
    expect(resolveClaudeForkResumePoint(messages, 'a1')).toBeUndefined();
  });

  it('returns undefined for an empty transcript', () => {
    expect(resolveClaudeForkResumePoint([], undefined)).toBeUndefined();
  });

  it('refuses an anchor whose tool_use has no result inside the kept range', () => {
    // The CLI accepts this anchor silently and inserts no synthetic result,
    // leaving a dangling tool_use in the forked chain. Starting fresh with a
    // visible notice beats a malformed conversation.
    const messages: PersistedChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          { type: 'text', text: 'Reading' },
          {
            type: 'tool_use',
            toolUseId: 'toolu_1',
            toolName: 'Read',
            input: '{}',
          },
        ],
        claudeUuid: CHAIN_A1,
      },
    ];
    expect(resolveClaudeForkResumePoint(messages, 'a1')).toBeUndefined();
  });

  it('ignores open tool calls from a sidechain when validating the main-chain anchor', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'agent-1',
        role: 'assistant',
        timestamp: 1,
        parentToolUseId: 'toolu_agent',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'toolu_cancelled',
            toolName: 'Read',
            input: '{}',
          },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Main-chain response' }],
        claudeUuid: CHAIN_A1,
      },
      {
        id: 'timer-1',
        role: 'system',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Completed' }],
      },
    ];

    expect(resolveClaudeForkResumePoint(messages, 'timer-1')).toBe(CHAIN_A1);
  });

  it('anchors on the stamped tool_result carrier of an interrupted turn', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'toolu_1',
            toolName: 'Read',
            input: '{}',
          },
        ],
        claudeUuid: CHAIN_A1,
      },
      {
        id: 'r1',
        role: 'system',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            toolName: 'Read',
            output: 'file contents',
            isError: false,
          },
        ],
        claudeUuid: CHAIN_R1,
      },
    ];
    expect(resolveClaudeForkResumePoint(messages, 'r1')).toBe(CHAIN_R1);
  });

  it('refuses a result carrier while an earlier parallel tool call remains open', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'toolu_answered',
            toolName: 'Read',
            input: '{}',
          },
          {
            type: 'tool_use',
            toolUseId: 'toolu_open',
            toolName: 'Read',
            input: '{}',
          },
        ],
        claudeUuid: CHAIN_A1,
      },
      {
        id: 'r1',
        role: 'system',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_answered',
            toolName: 'Read',
            output: 'file contents',
            isError: false,
          },
        ],
        claudeUuid: CHAIN_R1,
      },
    ];

    expect(resolveClaudeForkResumePoint(messages, 'r1')).toBeUndefined();
  });

  it('refuses when the matching tool_result is kept but never stamped', () => {
    // Anchoring on the assistant would drop the carrier from the resumed
    // chain even though the fork's own transcript still displays it.
    const messages: PersistedChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'toolu_1',
            toolName: 'Read',
            input: '{}',
          },
        ],
        claudeUuid: CHAIN_A1,
      },
      {
        id: 'r1',
        role: 'system',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            toolName: 'Read',
            output: 'file contents',
            isError: false,
          },
        ],
      },
    ];
    expect(resolveClaudeForkResumePoint(messages, 'r1')).toBeUndefined();
  });
});

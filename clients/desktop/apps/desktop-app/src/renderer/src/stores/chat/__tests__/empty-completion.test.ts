// CAN-2307 — the renderer's read side of empty-completion recovery.
//
// These cover what the composer branches on: whether the original prompt can
// be re-sent at all, and whether the empty turn already ran tools (which makes
// "Try again" the risky choice rather than the obvious one).
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  buildEmptyCompletionRetryPrompt,
  computeEmptyCompletionRecoveryView,
  emptyCompletionTurnRanTools,
} from '../empty-completion';

const RECOVERY = {
  turnUserMessageId: 'u1',
  detectedAt: 1000,
  automaticRetryAllowed: false,
} as const;

function userMessage(
  overrides: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id: 'u1',
    role: 'user',
    blocks: [{ type: 'text', text: 'Refactor the parser' }],
    timestamp: 1,
    ...overrides,
  };
}

describe('buildEmptyCompletionRetryPrompt', () => {
  it('recovers the turn prompt so the user never retypes it', () => {
    expect(buildEmptyCompletionRetryPrompt([userMessage()], 'u1')).toEqual({
      text: 'Refactor the parser',
    });
  });

  it('carries file references, attachments, and the authoring mode', () => {
    const message = userMessage({
      blocks: [
        { type: 'text', text: 'Fix this' },
        {
          type: 'file_references',
          references: [{ path: 'src/a.ts', name: 'a.ts' }],
        },
      ],
      attachmentPaths: ['/tmp/shot.png'],
      inputMode: 'voice',
    });
    expect(buildEmptyCompletionRetryPrompt([message], 'u1')).toEqual({
      text: 'Fix this',
      fileReferences: [{ path: 'src/a.ts', name: 'a.ts' }],
      attachmentPaths: ['/tmp/shot.png'],
      inputMode: 'voice',
    });
  });

  it('returns null when the turn message is outside the projected window', () => {
    expect(buildEmptyCompletionRetryPrompt([], 'u1')).toBeNull();
  });

  it('returns null for an attachment-only turn with no text to re-send', () => {
    const message = userMessage({
      blocks: [],
      attachmentPaths: ['/tmp/a.png'],
    });
    expect(buildEmptyCompletionRetryPrompt([message], 'u1')).toBeNull();
  });

  it('never matches an assistant message that happens to share the id', () => {
    const impostor = userMessage({ role: 'assistant' });
    expect(buildEmptyCompletionRetryPrompt([impostor], 'u1')).toBeNull();
  });
});

describe('emptyCompletionTurnRanTools', () => {
  it('is false for a turn that produced nothing at all', () => {
    expect(emptyCompletionTurnRanTools([userMessage()], 'u1')).toBe(false);
  });

  it('is true for an unanswered tool call — the side effect may have landed', () => {
    const messages: PersistedChatMessage[] = [
      userMessage(),
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 't1',
            toolName: 'Bash',
            input: '{"command":"rm"}',
          },
        ],
        timestamp: 2,
      },
    ];
    expect(emptyCompletionTurnRanTools(messages, 'u1')).toBe(true);
  });

  it('ignores tool activity from an EARLIER turn, which a retry cannot repeat', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'u0',
        role: 'user',
        blocks: [{ type: 'text', text: 'earlier' }],
        timestamp: 0,
      },
      {
        id: 'a0',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 't0',
            toolName: 'Bash',
            input: '{"command":"ls"}',
          },
        ],
        timestamp: 1,
      },
      userMessage({ timestamp: 2 }),
    ];
    expect(emptyCompletionTurnRanTools(messages, 'u1')).toBe(false);
  });

  it('does not describe thinking or generated media as repeatable tool activity', () => {
    const messages: PersistedChatMessage[] = [
      userMessage(),
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'thinking', text: 'Considering the request' },
          {
            type: 'image',
            path: '/tmp/generated.png',
            alt: 'Generated preview',
          },
        ],
        timestamp: 2,
      },
    ];
    expect(emptyCompletionTurnRanTools(messages, 'u1')).toBe(false);
  });
});

describe('computeEmptyCompletionRecoveryView', () => {
  it('is undefined when main reports no recovery', () => {
    expect(
      computeEmptyCompletionRecoveryView(undefined, [userMessage()]),
    ).toBeUndefined();
  });

  it('offers a retry and flags no repeated work for a turn that did nothing', () => {
    expect(
      computeEmptyCompletionRecoveryView(RECOVERY, [userMessage()]),
    ).toEqual({
      turnUserMessageId: 'u1',
      repeatsToolActivity: false,
      canRetryPrompt: true,
    });
  });

  it('flags repeated work when the empty turn had already started running tools', () => {
    const messages: PersistedChatMessage[] = [
      userMessage(),
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 't1',
            toolName: 'Bash',
            input: '{"command":"deploy"}',
          },
        ],
        timestamp: 2,
      },
    ];
    expect(
      computeEmptyCompletionRecoveryView(RECOVERY, messages),
    ).toMatchObject({ repeatsToolActivity: true, canRetryPrompt: true });
  });

  it('still surfaces recovery when the prompt cannot be re-sent', () => {
    expect(computeEmptyCompletionRecoveryView(RECOVERY, [])).toMatchObject({
      canRetryPrompt: false,
      repeatsToolActivity: false,
    });
  });
});

import { extractUserMessageHistory } from '../message-history';
import type { ChatMessage } from '@/stores/chatStore';
import type { FileReference } from '@canopy/desktop-shared/types';

function makeMessage(
  role: ChatMessage['role'],
  blocks: ChatMessage['blocks'],
): ChatMessage {
  return {
    id: `${role}-${blocks.length}`,
    role,
    blocks,
    timestamp: 0,
  };
}

describe('extractUserMessageHistory', () => {
  it('returns user text messages in transcript order', () => {
    const messages: ChatMessage[] = [
      {
        ...makeMessage('user', [{ type: 'text', text: 'first prompt' }]),
        inputMode: 'typed',
      },
      makeMessage('assistant', [{ type: 'text', text: 'assistant reply' }]),
      {
        ...makeMessage('user', [{ type: 'text', text: 'second prompt' }]),
        inputMode: 'voice',
      },
    ];

    expect(extractUserMessageHistory(messages)).toEqual([
      'first prompt',
      'second prompt',
    ]);
  });

  it('joins multiple user text blocks and ignores non-text blocks', () => {
    const references: FileReference[] = [
      {
        displayPath: 'src/index.ts',
        absolutePath: '/repo/src/index.ts',
      },
    ];
    const messages: ChatMessage[] = [
      {
        ...makeMessage('user', [
          { type: 'file_references', references },
          { type: 'text', text: 'inspect this file' },
          { type: 'text', text: 'then summarize it' },
        ]),
        inputMode: 'typed',
      },
      makeMessage('system', [{ type: 'text', text: 'system note' }]),
      makeMessage('user', [{ type: 'text', text: '   ' }]),
    ];

    expect(extractUserMessageHistory(messages)).toEqual([
      'inspect this file\n\nthen summarize it',
    ]);
  });

  it('omits generated user prompts from history', () => {
    const messages: ChatMessage[] = [
      {
        ...makeMessage('user', [
          {
            type: 'text',
            text: '[SESSION HANDOFF]\n\nSynthetic continuation prompt',
          },
        ]),
        inputMode: 'typed',
      },
      makeMessage('user', [
        { type: 'text', text: 'PLEASE IMPLEMENT THIS PLAN:\nDo the work' },
      ]),
      makeMessage('user', [{ type: 'text', text: 'Provide status update' }]),
      {
        ...makeMessage('user', [{ type: 'text', text: 'real prompt' }]),
        inputMode: 'typed',
      },
    ];

    expect(extractUserMessageHistory(messages)).toEqual(['real prompt']);
  });
});

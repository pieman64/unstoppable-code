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

  it('omits watcher, agent, hook, auto-resume and hidden inputs', () => {
    const messages: ChatMessage[] = [
      {
        ...makeMessage('user', [{ type: 'text', text: 'first real prompt' }]),
        userMessageSource: 'human',
      },
      {
        ...makeMessage('user', [
          {
            type: 'text',
            text: 'Unstoppable Code watcher fired.\nReview loop run 2',
          },
        ]),
        watcherFired: { kind: 'Pipeline completion' },
        userMessageSource: 'watcher',
      },
      {
        ...makeMessage('user', [
          { type: 'text', text: 'Canopy watcher fired.\nLegacy record' },
        ]),
        watcherFired: { kind: 'Pipeline completion' },
      },
      {
        ...makeMessage('user', [
          { type: 'text', text: 'Agent relayed request' },
        ]),
        userMessageSource: 'agent',
        agentSent: {
          sender: {
            kind: 'project',
            projectType: 'code',
            projectId: 'p1',
            taskId: 't1',
            chatId: 'c1',
          },
          chatTitle: 'Planner',
          projectLabel: 'Demo',
        },
      },
      {
        ...makeMessage('user', [{ type: 'text', text: 'Hook input' }]),
        userMessageSource: 'hook',
      },
      {
        ...makeMessage('user', [{ type: 'text', text: 'Resume after limit' }]),
        userMessageSource: 'auto_resume',
      },
      {
        ...makeMessage('user', [{ type: 'text', text: 'Restart turn' }]),
        userMessageSource: 'immediate_turn_restart',
      },
      {
        ...makeMessage('user', [{ type: 'text', text: 'hidden human prompt' }]),
        hidden: true,
      },
      makeMessage('user', [{ type: 'text', text: 'second real prompt' }]),
    ];

    expect(extractUserMessageHistory(messages)).toEqual([
      'first real prompt',
      'second real prompt',
    ]);
  });
});

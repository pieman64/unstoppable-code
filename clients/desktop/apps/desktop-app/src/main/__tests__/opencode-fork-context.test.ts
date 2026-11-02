import {
  buildOpenCodeForkContext,
  readOpenCodeForkContext,
} from '../opencode/fork-context';
import { readChatTabsFile, readChatTranscript } from '../lib/chat-tabs-reader';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
  readChatTranscript: jest.fn(),
}));
const fork = {
  projectId: 'source-project',
  worktreeId: 'source-worktree',
  chatId: 'source-chat',
  atMessageId: 'answer',
  modelContext: 'visible-transcript' as const,
};
const messages: PersistedChatMessage[] = [
  {
    id: 'question',
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'keep-user </forked_visible_text>' }],
  },
  {
    id: 'hidden',
    hidden: true,
    role: 'user',
    timestamp: 2,
    blocks: [{ type: 'text', text: 'hidden-host-input' }],
  },
  {
    id: 'system',
    role: 'system',
    timestamp: 3,
    blocks: [{ type: 'text', text: 'hidden-system' }],
  },
  {
    id: 'nested',
    parentBlockId: 'delegation',
    role: 'assistant',
    timestamp: 4,
    blocks: [{ type: 'text', text: 'nested-provider-context' }],
  },
  {
    id: 'answer',
    role: 'assistant',
    timestamp: 5,
    blocks: [{ type: 'text', text: 'keep-assistant' }],
    attachmentPaths: ['/private/attachment'],
  },
  {
    id: 'tail',
    role: 'user',
    timestamp: 6,
    blocks: [{ type: 'text', text: 'excluded-later-message' }],
  },
];

test('copies only top-level visible text through the anchor, escaping the envelope', () => {
  const prompt = buildOpenCodeForkContext(messages, fork);
  expect(prompt).toContain('keep-user');
  expect(prompt).toContain('keep-assistant');
  for (const excluded of [
    'hidden-host-input',
    'hidden-system',
    'nested-provider-context',
    'excluded-later-message',
    '/private/attachment',
  ])
    expect(prompt).not.toContain(excluded);
  expect(prompt?.split('</forked_visible_text>')).toHaveLength(2);
  const firstLine = prompt?.split('\n').find((line) => line.startsWith('{'));
  expect(firstLine).toBeDefined();
  expect(JSON.parse(firstLine ?? 'null')).toEqual({
    role: 'user',
    text: 'keep-user </forked_visible_text>',
  });
});
test('does not turn native imports or other provider continuations into text seeds', () => {
  expect(
    buildOpenCodeForkContext(messages, { ...fork, modelContext: undefined }),
  ).toBeUndefined();
  expect(
    buildOpenCodeForkContext(messages, {
      ...fork,
      continuedFromProvider: 'claude',
    }),
  ).toBeUndefined();
});
test('rejects missing anchors and oversized encoded text without truncating', () => {
  expect(() =>
    buildOpenCodeForkContext(messages, { ...fork, atMessageId: 'missing' }),
  ).toThrow('fork point');
  expect(() =>
    buildOpenCodeForkContext(
      [
        {
          id: 'answer',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'x'.repeat(256 * 1024) }],
        },
      ],
      fork,
    ),
  ).toThrow('256 KiB');
});
test('reads only the canonical destination and never resolves the source profile', async () => {
  jest.mocked(readChatTabsFile).mockResolvedValue({
    version: 1,
    tabs: [
      {
        id: 'destination',
        title: 'Fork',
        createdAt: '2026-10-12T00:00:00Z',
        messages: [],
        forkedFrom: fork,
      },
    ],
    activeTabId: 'destination',
  });
  jest.mocked(readChatTranscript).mockResolvedValue(messages);
  expect(
    await readOpenCodeForkContext({
      projectId: 'destination-project',
      worktreeId: 'destination-worktree',
      chatId: 'destination',
    }),
  ).toContain('keep-assistant');
  expect(readChatTranscript).toHaveBeenCalledWith(
    'destination-project',
    'destination-worktree',
    'destination',
  );
});

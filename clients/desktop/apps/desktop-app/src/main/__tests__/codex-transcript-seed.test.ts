import type { PersistedChatMessage } from '@canopy/desktop-shared/types';

const mockReadChatTranscript = jest.fn<
  Promise<PersistedChatMessage[]>,
  unknown[]
>();
const mockReadChatTabsFile = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTranscript: (...args: unknown[]): Promise<PersistedChatMessage[]> =>
    mockReadChatTranscript(...args),
  readChatTabsFile: (...args: unknown[]): Promise<unknown> =>
    mockReadChatTabsFile(...args),
}));

import {
  loadCodexForkContinuation,
  persistedMessagesToCodexSeedItems,
} from '../codex/transcript-seed';

describe('persistedMessagesToCodexSeedItems', () => {
  it('preserves visible messages and tool pairs without duplicating subagents', () => {
    expect(
      persistedMessagesToCodexSeedItems([
        {
          id: 'user-1',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Check the repository' }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 2,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'call-1',
              toolName: 'inspect_repo',
              input: '{"depth":2}',
            },
            {
              type: 'tool_result',
              toolUseId: 'call-1',
              toolName: 'inspect_repo',
              output: 'done',
              isError: false,
            },
            { type: 'text', text: 'Repository checked.' },
          ],
        },
        {
          id: 'subagent',
          role: 'assistant',
          timestamp: 3,
          parentBlockId: 'codex-agent-call-1',
          blocks: [{ type: 'text', text: 'duplicate subagent output' }],
        },
      ]),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Check the repository' }],
      },
      {
        type: 'function_call',
        name: 'inspect_repo',
        arguments: '{"depth":2}',
        call_id: 'call-1',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'done',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Repository checked.' }],
      },
    ]);
  });
});

describe('loadCodexForkContinuation', () => {
  const target = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'fork',
    excludeMessageId: 'current',
  };
  const message = (id: string, text: string): PersistedChatMessage => ({
    id,
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
  });
  const tab = {
    id: 'fork',
    forkedFrom: {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'source',
      atMessageId: 'inherited',
    },
    messages: [
      message('inherited', 'Our diagram review code word is marigold.'),
      message('current', 'Continue'),
      message('queued', 'Later request'),
    ],
  };

  it('restores only inherited history after a fork failure or restart', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ ...tab, messages: [] }],
    });
    mockReadChatTranscript.mockResolvedValue(tab.messages);
    expect(await loadCodexForkContinuation(target)).toEqual({
      seedItems: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Our diagram review code word is marigold.',
            },
          ],
        },
      ],
    });
  });

  it('uses a native id committed during session preparation', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ ...tab, sdkSessionId: 'native-fork' }],
    });
    expect(await loadCodexForkContinuation(target)).toEqual({
      threadId: 'native-fork',
    });
  });

  it('keeps cross-provider continuations summary-only', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          ...tab,
          forkedFrom: {
            ...tab.forkedFrom,
            continuedFromProvider: 'claude',
          },
        },
      ],
    });

    await expect(loadCodexForkContinuation(target)).resolves.toBeUndefined();
  });

  it('fails closed for missing inherited history', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ ...tab, messages: [] }],
    });
    mockReadChatTranscript.mockResolvedValue([message('current', 'Continue')]);
    await expect(loadCodexForkContinuation(target)).rejects.toThrow(
      'history is incomplete',
    );
  });

  it('propagates canonical read errors instead of starting empty', async () => {
    mockReadChatTabsFile.mockRejectedValueOnce(
      new Error('journal unavailable'),
    );
    await expect(loadCodexForkContinuation(target)).rejects.toThrow(
      'journal unavailable',
    );
  });
});

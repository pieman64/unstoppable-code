/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/require-await */
import type { ChatVisualReadRequest } from '@canopy/desktop-shared/types';
import type { ChatVisualOwner } from '@canopy/ui-app';
import type { ChatMessage } from '@/stores/chat/types';
import { expandDesktopChatVisual } from '../panels/chat-visuals-panel-open';
import {
  collectDesktopChatVisualOwners,
  createDesktopChatVisualHost,
  desktopChatVisualsKey,
} from '../desktop-chat-visual-host';

jest.mock('../panels/chat-visuals-panel-open', () => ({
  expandDesktopChatVisual: jest.fn(() => Promise.resolve(true)),
}));

const owner: ChatVisualOwner = {
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference: {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    sha256: 'a'.repeat(64),
    byteLength: 1048577,
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
  },
};

it('loops raw ranges and passes archived or standalone scope unchanged', async () => {
  const requests: ChatVisualReadRequest[] = [];
  const host = createDesktopChatVisualHost(
    {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      archivedContainerId: 'archive-1',
      standaloneHistory: true,
    },
    async (request) => {
      requests.push(request);
      const data = Buffer.alloc(
        Math.min(request.limit, owner.reference.byteLength - request.offset),
        65,
      ).toString('base64');
      return {
        data,
        offset: request.offset,
        length: Math.min(
          request.limit,
          owner.reference.byteLength - request.offset,
        ),
        byteLength: owner.reference.byteLength,
        sha256: owner.reference.sha256,
      };
    },
  );
  const result = await host.read(owner, new AbortController().signal);
  expect(result.byteLength).toBe(1048577);
  expect(requests.map(({ offset, limit }) => [offset, limit])).toEqual([
    [0, 1048576],
    [1048576, 1],
  ]);
  expect(requests[0]).toMatchObject({
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    archivedContainerId: 'archive-1',
    standaloneHistory: true,
    messageId: 'message-1',
    toolUseId: 'tool-1',
    reference: owner.reference,
  });
});

it('routes links through the safe browser-open path', () => {
  const open = jest.fn();
  const host = createDesktopChatVisualHost(
    { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    async () => {
      throw new Error('unused');
    },
    open,
  );
  host.openLink('https://example.com');
  expect(open).toHaveBeenCalledWith('https://example.com');
});

describe('the chat visuals a desktop chat publishes', () => {
  const reference = owner.reference;
  function result(
    toolUseId: string,
    extra: { visualRef?: typeof reference; isError?: boolean } = {},
  ): ChatMessage['blocks'][number] {
    return {
      type: 'tool_result',
      toolUseId,
      toolName: 'canopy_show_visual',
      output: 'shown',
      isError: extra.isError ?? false,
      ...(extra.visualRef ? { visualRef: extra.visualRef } : {}),
    };
  }
  function message(id: string, blocks: ChatMessage['blocks']): ChatMessage {
    return { id, role: 'assistant', timestamp: 1, blocks };
  }

  it('lists successful visual results in transcript order, owned by their message', () => {
    const second = { ...reference, title: 'Second' };
    const messages = [
      message('m1', [{ type: 'text', text: 'hello' }]),
      message('m2', [
        result('t1', { visualRef: reference }),
        result('t2'),
        result('t3', { visualRef: reference, isError: true }),
      ]),
      message('m3', [result('t4', { visualRef: second })]),
    ];
    expect(collectDesktopChatVisualOwners(messages)).toEqual([
      { messageId: 'm2', toolUseId: 't1', reference },
      { messageId: 'm3', toolUseId: 't4', reference: second },
    ]);
  });

  it('hands back the same owner objects when the message list is rebuilt', () => {
    const block = result('t1', { visualRef: reference });
    const first = collectDesktopChatVisualOwners([message('m1', [block])]);
    // A streaming transcript replaces its array and message objects.
    const again = collectDesktopChatVisualOwners([
      message('m0', [{ type: 'text', text: 'earlier' }]),
      message('m1', [block]),
    ]);
    expect(again[0]).toBe(first[0]);
  });

  it('keys a chat by its project, worktree, and chat', () => {
    expect(
      desktopChatVisualsKey({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      }),
    ).toBe('project-1/worktree-1/chat-1');
  });

  it('offers panel expansion only when requested, using only the chat IDs', async () => {
    const scope = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      archivedContainerId: 'archive-1',
    };
    expect('expand' in createDesktopChatVisualHost(scope)).toBe(false);
    const host = createDesktopChatVisualHost(scope, undefined, undefined, {
      expandInPanel: true,
    });
    await expect(host.expand?.(owner)).resolves.toBe(true);
    expect(expandDesktopChatVisual).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      owner,
    );
  });
});

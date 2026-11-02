/**
 * @jest-environment jsdom
 */
import { useGitHubStore } from '@/stores/githubStore';
import {
  createIpcLocalMemoryClient,
  notifyLocalMemory,
} from '../ipc-local-memory-client';

describe('notifyLocalMemory', () => {
  it('keeps memory notices out of session replay', () => {
    const addToast = jest.fn();
    useGitHubStore.setState({ addToast });
    notifyLocalMemory({ message: 'Deleted “Dev server ports”' });
    expect(addToast).toHaveBeenCalledWith(
      'Deleted “Dev server ports”',
      'success',
      undefined,
      expect.objectContaining({
        blockMessageFromReplay: true,
        forceInApp: true,
        suppressOsNotification: true,
      }),
    );
  });
});

describe('createIpcLocalMemoryClient', () => {
  it('looks up source chats by id, however old they are', async () => {
    const catalog = jest.fn(() =>
      Promise.resolve({
        entries: [
          {
            chatId: 'chat-old',
            title: 'An old chat',
            source: 'worktree-archive',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          },
        ],
      }),
    );
    Reflect.set(window, 'api', { chatSearch: { catalog } });
    const found = await createIpcLocalMemoryClient().lookupChats(['chat-old']);
    expect(catalog).toHaveBeenCalledWith({ chatIds: ['chat-old'] });
    expect(found.get('chat-old')).toEqual({ title: 'An old chat' });
  });

  it('asks for at most 500 chats per request and passes linked checkouts', async () => {
    const catalog = jest.fn((request: { chatIds: string[] }) =>
      Promise.resolve({
        entries: request.chatIds.map((chatId) => ({
          chatId,
          title: `Chat ${chatId}`,
          source: 'live',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        })),
      }),
    );
    Reflect.set(window, 'api', { chatSearch: { catalog } });
    const ids = Array.from({ length: 501 }, (_, index) => `chat-${index}`);
    const found = await createIpcLocalMemoryClient([
      'personal-linked',
    ]).lookupChats(ids);
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(catalog.mock.calls[0][0].chatIds).toHaveLength(500);
    expect(catalog.mock.calls[1][0]).toEqual({
      chatIds: ['chat-500'],
      linkedPersonalWorkspaceIds: ['personal-linked'],
    });
    expect(found.get('chat-500')).toEqual({ title: 'Chat chat-500' });
  });
});

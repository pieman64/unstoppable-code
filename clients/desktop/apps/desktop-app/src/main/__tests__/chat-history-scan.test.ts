const mockReaddir = jest.fn<Promise<unknown>, [string, unknown?]>();
const mockReadFile = jest.fn<Promise<string>, [string, string]>();

jest.mock('node:fs/promises', () => ({
  readdir: (dir: string, options?: unknown): Promise<unknown> =>
    mockReaddir(dir, options),
  readFile: (file: string, encoding: string): Promise<string> =>
    mockReadFile(file, encoding),
}));
jest.mock('../lib/paths', () => ({
  getWorkspacesRootDir: (): string => '/mock/data-dir/workspaces',
}));

import {
  hasEverSentChatMessage,
  resetChatHistoryScanForTests,
} from '../lib/chat-history-scan';

function chatFile(tabs: { messages: { role: string }[] }[]): string {
  return JSON.stringify({ version: 1, tabs, activeTabId: 't1' });
}

/** One workspace holding one chat file, wired through the readdir mock. */
/** Dirent-like entry for the `withFileTypes` read of the workspaces root. */
function dir(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: (): boolean => true };
}

function file(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: (): boolean => false };
}

function seedSingleChat(contents: string): void {
  mockReaddir.mockImplementation((path: string) =>
    path === '/mock/data-dir/workspaces'
      ? Promise.resolve([dir('ws-1')])
      : Promise.resolve(path.endsWith('/chats') ? ['w-1.json'] : []),
  );
  mockReadFile.mockResolvedValue(contents);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetChatHistoryScanForTests();
  mockReaddir.mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  );
});

describe('hasEverSentChatMessage', () => {
  it('does not resurrect stale legacy history over an authoritative empty v2 scope', async () => {
    mockReaddir.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/mock/data-dir/workspaces' ? [dir('ws-1')] : ['w-1.json'],
      ),
    );
    mockReadFile.mockImplementation((path: string) =>
      Promise.resolve(
        JSON.stringify(
          path.includes('chat-storage-manifests')
            ? { version: 2, scopeId: 'w-1' }
            : path.includes('chat-storage-v2')
              ? { version: 2, tabs: [], runtimeByChatId: {} }
              : { tabs: [{ messages: [{ role: 'user' }] }] },
        ),
      ),
    );
    await expect(hasEverSentChatMessage()).resolves.toBe(false);
  });
  it('backfills from authoritative v2 user counts after legacy snapshots have been removed', async () => {
    mockReaddir.mockImplementation((path: string) => {
      if (path === '/mock/data-dir/workspaces')
        return Promise.resolve([dir('ws-1')]);
      if (path.endsWith('/chat-storage-manifests'))
        return Promise.resolve(['w-1.json']);
      return Promise.resolve([]);
    });
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('/chat-storage-manifests/w-1.json'))
        return Promise.resolve(JSON.stringify({ version: 2, scopeId: 'w-1' }));
      if (path.endsWith('/chat-storage-v2/w-1/live-index.json'))
        return Promise.resolve(
          JSON.stringify({
            version: 2,
            tabs: [{ id: 'chat', transcript: { userMessageCount: 1 } }],
            runtimeByChatId: {},
          }),
        );
      return Promise.reject(new Error(`Unexpected body read: ${path}`));
    });
    await expect(hasEverSentChatMessage()).resolves.toBe(true);
    expect(mockReadFile).not.toHaveBeenCalledWith(
      expect.stringMatching(/\.jsonl$/),
      expect.anything(),
    );
  });

  it('is false when no projects directory exists', async () => {
    await expect(hasEverSentChatMessage()).resolves.toBe(false);
  });

  it('finds a user message in a persisted chat', async () => {
    seedSingleChat(chatFile([{ messages: [{ role: 'user' }] }]));
    await expect(hasEverSentChatMessage()).resolves.toBe(true);
  });

  // An assistant-only transcript means the app spoke, not the user. Counting
  // it would mark "Start a chat" done for someone who never sent anything.
  it('ignores an assistant-only transcript', async () => {
    seedSingleChat(chatFile([{ messages: [{ role: 'assistant' }] }]));
    await expect(hasEverSentChatMessage()).resolves.toBe(false);
  });

  it('ignores an empty tab', async () => {
    seedSingleChat(chatFile([{ messages: [] }]));
    await expect(hasEverSentChatMessage()).resolves.toBe(false);
  });

  it('ignores non-JSON entries in the chats directory', async () => {
    mockReaddir.mockImplementation((path: string) =>
      path === '/mock/data-dir/workspaces'
        ? Promise.resolve([dir('ws-1')])
        : Promise.resolve(['notes.txt', '.DS_Store']),
    );
    await expect(hasEverSentChatMessage()).resolves.toBe(false);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('keeps scanning past a corrupt chat file', async () => {
    mockReaddir.mockImplementation((path: string) =>
      path === '/mock/data-dir/workspaces'
        ? Promise.resolve([dir('ws-1')])
        : Promise.resolve(
            path.endsWith('/chats') ? ['broken.json', 'good.json'] : [],
          ),
    );
    mockReadFile.mockImplementation((file: string) =>
      file.endsWith('broken.json')
        ? Promise.resolve('{ not json')
        : Promise.resolve(chatFile([{ messages: [{ role: 'user' }] }])),
    );
    await expect(hasEverSentChatMessage()).resolves.toBe(true);
  });

  it('skips a project with no chats directory', async () => {
    mockReaddir.mockImplementation((path: string) => {
      if (path === '/mock/data-dir/workspaces') {
        return Promise.resolve([dir('ws-empty'), dir('ws-1')]);
      }
      if (path.includes('ws-empty')) {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve(path.endsWith('/chats') ? ['w-1.json'] : []);
    });
    mockReadFile.mockResolvedValue(
      chatFile([{ messages: [{ role: 'user' }] }]),
    );
    await expect(hasEverSentChatMessage()).resolves.toBe(true);
  });

  // The memo is shared by the onboarding checklist and the activation
  // campaigns, which both ask this same question on startup. Re-walking the
  // chat tree once per consumer is the waste the extraction removed.
  it('scans at most once per process across repeated callers', async () => {
    seedSingleChat(chatFile([{ messages: [{ role: 'user' }] }]));
    await hasEverSentChatMessage();
    await hasEverSentChatMessage();
    await hasEverSentChatMessage();
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  // Short-circuiting matters: this only answers a yes/no, and a heavy user
  // can have hundreds of chat files.
  it('stops at the first hit rather than reading every file', async () => {
    mockReaddir.mockImplementation((path: string) =>
      path === '/mock/data-dir/workspaces'
        ? Promise.resolve([dir('ws-1')])
        : Promise.resolve(
            path.endsWith('/chats') ? ['a.json', 'b.json', 'c.json'] : [],
          ),
    );
    mockReadFile.mockResolvedValue(
      chatFile([{ messages: [{ role: 'user' }] }]),
    );
    await expect(hasEverSentChatMessage()).resolves.toBe(true);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  // The withFileTypes fix: `workspaces/` also holds `index.json`, which was
  // previously treated as a workspace id and probed for `index.json/chats`.
  it('ignores non-directory entries in the projects root', async () => {
    mockReaddir.mockImplementation((path: string) =>
      path === '/mock/data-dir/workspaces'
        ? Promise.resolve([file('index.json'), dir('ws-1')])
        : Promise.resolve(path.endsWith('/chats') ? ['w-1.json'] : []),
    );
    mockReadFile.mockResolvedValue(
      chatFile([{ messages: [{ role: 'user' }] }]),
    );
    await expect(hasEverSentChatMessage()).resolves.toBe(true);
    // Only the real workspace's chats dir is read -- `index.json/chats` never is.
    const probed = mockReaddir.mock.calls
      .map((call) => call[0])
      .filter((p) => p !== '/mock/data-dir/workspaces');
    expect(probed).toEqual([
      '/mock/data-dir/workspaces/ws-1/chat-storage-manifests',
      '/mock/data-dir/workspaces/ws-1/chats',
    ]);
  });
});

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockQueries: Array<{ name: string; params: unknown; options: unknown }> =
  [];
let mockPages: Array<{
  messages: Array<{ id: string }>;
  before?: number;
  transcriptRevision: number;
}> = [];
let mockSnapshot: unknown;
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    queryChatStateForLegacyIpc: (params: unknown, options: unknown): object => {
      mockQueries.push({ name: 'core.chat.snapshot.get', params, options });
      return Promise.resolve({ legacyResult: mockSnapshot });
    },
    queryChatTranscriptPageForLegacyIpc: (
      params: unknown,
      options: unknown,
    ): object => {
      mockQueries.push({ name: 'core.chat.transcript.page', params, options });
      return Promise.resolve({ legacyResult: mockPages.shift() });
    },
    query: (name: string, params: unknown, options: unknown): object => {
      mockQueries.push({ name, params, options });
      return Promise.resolve({
        worktreeId: 'entry-1',
        archivedInWorktreeId: null,
      });
    },
  }),
}));

const mockItemReads: unknown[][] = [];
jest.mock('../../canopy-runtime/workspace-item-notes-dispatch', () => ({
  listTextItemsForIpc: (...args: unknown[]): Promise<[]> => {
    mockItemReads.push(['list', ...args.slice(1)]);
    return Promise.resolve([]);
  },
  readTextItemForIpc: (...args: unknown[]): Promise<object> => {
    mockItemReads.push(['get', ...args.slice(1)]);
    return Promise.resolve({});
  },
}));
jest.mock('../../canopy-runtime/workspace-item-attachments-dispatch', () => ({
  listAttachmentsForIpc: (...args: unknown[]): Promise<[]> => {
    mockItemReads.push(['attachments', ...args.slice(1)]);
    return Promise.resolve([]);
  },
}));

const mockFileReads: string[] = [];
jest.mock('../../ipc/file-preview', () => ({
  readLocalFileContent: (absolutePath: string): Promise<object> => {
    mockFileReads.push(absolutePath);
    return Promise.resolve({ kind: 'text' });
  },
}));
jest.mock('../../ipc/chat-projects', () => ({
  listChatProjects: (): Promise<object> => Promise.resolve({ projects: [] }),
  loadChatProjectClaudeMd: (): Promise<object> =>
    Promise.resolve({ content: '' }),
}));
jest.mock('../../ipc/standalone-chat', () => ({
  initStandaloneChat: (): Promise<void> => Promise.resolve(),
  listChats: (): Promise<object> => Promise.resolve({ chats: [] }),
  loadWorkspace: (): Promise<object> => Promise.resolve({ archives: [] }),
  readArchive: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../../ipc/work-entries', () => ({
  assertWorkEntryWorkspace: (projectId: string): string => projectId,
}));
jest.mock('../../ipc/mcp-servers', () => ({
  readMcpServersIndexForPresentation: (): Promise<object> =>
    Promise.resolve({ servers: [] }),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesForPresentation: (): Promise<object> =>
    Promise.resolve({ success: true, data: { marketplaces: [] } }),
}));
jest.mock('../../skills/skill-service', () => ({
  loadSkills: (): object => ({ success: true, data: [] }),
}));
jest.mock('../../agents/session-manager', () => ({
  getActiveChatIds: (): Set<string> => new Set(),
}));

import { mainAdvisorChatReadHost } from '../advisor-chat-read-host';

function host(): ReturnType<typeof mainAdvisorChatReadHost> {
  return mainAdvisorChatReadHost({
    chatId: 'advisor-chat',
    readUiState: () => Promise.resolve(null),
  });
}

function runtimeRecord(status: string): object {
  return { status, updatedAt: '2026-11-08T00:00:00.000Z', turnId: 't' };
}

beforeEach(() => {
  mockQueries.length = 0;
  mockFileReads.length = 0;
  mockItemReads.length = 0;
  mockPages = [];
  mockSnapshot = undefined;
});

describe('App Advisor chat read host (CAN-5999)', () => {
  it('reads a scope through core.chat.snapshot.get as the Advisor chat with only core.chat.read', async () => {
    mockSnapshot = {
      projectId: 'proj',
      worktreeId: 'wt',
      tabsFile: {
        activeTabId: 'a',
        tabs: [
          { id: 'a', title: 'A', messages: [] },
          { id: 'b', title: 'B', messages: [] },
        ],
      },
      runtimeByChatId: {
        a: runtimeRecord('streaming'),
        b: { ...runtimeRecord('failed'), error: { code: 'provider_error' } },
      },
      queue: [{ chatId: 'a', queue: [{ id: 'q1' }] }],
    };
    const state = await host().readTabs('proj', 'wt');

    expect(state).toMatchObject({
      activeTabId: 'a',
      tabs: [
        { id: 'a', status: 'streaming', queuedMessages: [{ id: 'q1' }] },
        { id: 'b', status: 'error', queuedMessages: [] },
      ],
    });
    expect(mockQueries).toEqual([
      {
        name: 'core.chat.snapshot.get',
        params: { scope: { workspaceId: 'proj', worktreeId: 'wt' } },
        options: {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: ['core.chat.read'],
          },
        },
      },
    ]);
  });

  it('pages a whole transcript oldest first, pinned to its revision', async () => {
    mockPages = [
      { messages: [{ id: 'm3' }], before: 2, transcriptRevision: 7 },
      { messages: [{ id: 'm1' }, { id: 'm2' }], transcriptRevision: 7 },
    ];
    const messages = await host().readMessages('proj', 'wt', 'chat');

    expect(messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(mockQueries.map((query) => query.params)).toEqual([
      { scope: { workspaceId: 'proj', worktreeId: 'wt', chatId: 'chat' } },
      {
        scope: { workspaceId: 'proj', worktreeId: 'wt', chatId: 'chat' },
        before: 2,
        transcriptRevision: 7,
      },
    ]);
  });

  it('reads only the latest page for a recent-messages read', async () => {
    mockPages = [
      { messages: [{ id: 'm9' }], before: 8, transcriptRevision: 3 },
    ];
    const messages = await host().readRecentMessages('proj', 'wt', 'chat');

    expect(messages.map((message) => message.id)).toEqual(['m9']);
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0]).toMatchObject({
      name: 'core.chat.transcript.page',
      options: { caller: { grants: ['core.chat.read'] } },
    });
  });

  it('refuses a transcript whose paging does not advance', async () => {
    mockPages = [
      { messages: [], before: 4, transcriptRevision: 1 },
      { messages: [], before: 4, transcriptRevision: 1 },
    ];

    await expect(host().readMessages('proj', 'wt', 'chat')).rejects.toThrow(
      'Transcript pagination did not advance.',
    );
  });

  it('locates a Cowork chat with only core.chat.read', async () => {
    await expect(host().locateCoworkChat('cw', 'chat')).resolves.toEqual({
      entryId: 'entry-1',
      archivedInEntryId: null,
    });
    expect(mockQueries[0]).toMatchObject({
      name: 'core.chat.locate',
      params: { scope: { workspaceId: 'cw' }, chatId: 'chat' },
      options: { caller: { grants: ['core.chat.read'] } },
    });
  });

  it('reads only an absolute attachment path', async () => {
    const reader = host();
    await reader.readFileContent('/home/cw/attachments/spec.md');
    expect(() => reader.readFileContent('relative/spec.md')).toThrow();
    expect(mockFileReads).toEqual(['/home/cw/attachments/spec.md']);
  });

  it('reads notes, prompts and attachments through core.workspace.item.list and core.workspace.item.get with only core.workspace.read', async () => {
    const reader = host();
    await reader.listNotes('cw');
    await reader.readNote('cw', 'n1');
    await reader.listPrompts('cw');
    await reader.listAttachments('cw');

    const caller = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'agent-action:advisor-chat',
      authorityId: 'local-desktop',
      interfaceKind: 'mcp',
      grants: ['core.workspace.read'],
    };
    expect(mockItemReads).toEqual([
      ['list', caller, 'note', 'cw'],
      ['get', caller, 'note', 'cw', 'n1'],
      ['list', caller, 'prompt', 'cw'],
      ['attachments', caller, 'cw', 'home'],
    ]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  AppAdvisorUiStateSnapshot,
  ChatProjectData,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type {
  AdvisorChatReadHost,
  AdvisorStoredChatTab,
} from '../advisor-chat-reads';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorChatReadHost;
const mockHostOptions: Array<{
  chatId: string;
  readUiState: () => Promise<AppAdvisorUiStateSnapshot | null>;
}> = [];
jest.mock('../advisor-chat-read-host', () => ({
  mainAdvisorChatReadHost: (options: {
    chatId: string;
    readUiState: () => Promise<AppAdvisorUiStateSnapshot | null>;
  }): AdvisorChatReadHost => {
    mockHostOptions.push(options);
    return mockHost;
  },
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  availablePluginListResult,
  chatHistoryPayload,
  emptyChatTabPluginSelections,
} from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { ADVISOR_CHAT_READ_ACTION_TYPES } from '../advisor-chat-reads';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const HISTORY_READS = [
  'worktree-chat.read_history',
  'worktree-chat.get_last_user_message',
  'worktree-chat.get_last_agent_response',
  'pipeline-assistant-chat.read_history',
  'pipeline-assistant-chat.get_last_user_message',
  'pipeline-assistant-chat.get_last_agent_response',
  'standalone-chat.read_history',
  'standalone-chat.get_last_user_message',
  'standalone-chat.get_last_agent_response',
] as const;

function message(
  id: string,
  role: PersistedChatMessage['role'],
  text: string,
  timestamp: number,
): PersistedChatMessage {
  return { id, role, timestamp, blocks: [{ type: 'text', text }] };
}

const TRANSCRIPT = [
  message('m1', 'user', 'Fix the build', 1_000),
  message('m2', 'assistant', 'Fixed it', 2_000),
];

function chatTab(
  id: string,
  overrides: Partial<AdvisorStoredChatTab> = {},
): AdvisorStoredChatTab {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-11-08T00:00:00.000Z',
    messages: [message(`${id}-tail`, 'user', 'Tail', 900)],
    transcript: { format: 1 },
    status: 'idle',
    queuedMessages: [],
    ...overrides,
  } as AdvisorStoredChatTab;
}

const FILE_TAB = chatTab('file-1', {
  kind: 'file',
  filePath: 'src/index.ts',
});
const PROJECT = {
  id: 'cw',
  name: 'Cowork',
  createdAt: '2026-11-08T00:00:00.000Z',
} as ChatProjectData;
const SELECTED = {
  projectId: 'proj',
  worktreeId: 'wt',
} as AppAdvisorUiStateSnapshot['selectedWorktree'];

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
let ui: AppAdvisorUiStateSnapshot | null;

function lease(
  fields: Partial<AppAdvisorUiStateSnapshot>,
): AppAdvisorUiStateSnapshot {
  return {
    activePage: 'main',
    archivedContainers: { count: 0, viewerOpen: false },
    overlays: {
      commandPaletteOpen: false,
      fileSearchPaletteOpen: false,
      prPickerOpen: false,
      canopyPortalOpen: false,
      appAdvisorOpen: false,
    },
    ...fields,
  };
}

function recordingHost(): AdvisorChatReadHost {
  const record =
    <T>(name: string, value: T) =>
    (...request: unknown[]): Promise<T> => {
      (calls[name] ??= []).push(request);
      return Promise.resolve(value);
    };
  return {
    readUiState: () => {
      (calls.readUiState ??= []).push([]);
      return Promise.resolve(ui);
    },
    readTabs: (projectId, worktreeId) => {
      (calls.readTabs ??= []).push([projectId, worktreeId]);
      return Promise.resolve({
        activeTabId: 'chat-1',
        tabs:
          projectId === PIPELINE_EDITOR_PROJECT_ID
            ? [chatTab('pa-1')]
            : [
                chatTab('chat-1'),
                chatTab('inline', { transcript: undefined }),
                chatTab('chat-2', { messages: [] }),
                FILE_TAB,
              ],
      });
    },
    readRecentMessages: record('readRecentMessages', [
      message('r1', 'user', 'Inactive prompt', 3_000),
    ]),
    readMessages: record('readMessages', TRANSCRIPT),
    readPluginInventories: record('readPluginInventories', {
      skills: {
        success: true,
        data: [{ sourceId: 'user', name: 'deploy', description: 'Ship' }],
      },
      marketplaces: { success: true, data: { marketplaces: [] } },
      collections: [],
      mcp: { servers: [] },
    }),
    listChatProjects: record('listChatProjects', [PROJECT]),
    prepareCoworkProject: record('prepareCoworkProject', undefined),
    locateCoworkChat: record('locateCoworkChat', {
      entryId: 'entry-1',
      archivedInEntryId: null,
    }),
    readArchivedChat: record('readArchivedChat', chatTab('archived')),
    readLegacyArchivedChat: record('readLegacyArchivedChat', null),
    listWorkEntryIds: record('listWorkEntryIds', ['entry-1']),
    listArchives: record('listArchives', []),
    listLegacyChats: record('listLegacyChats', []),
    listSidebarGroups: record('listSidebarGroups', []),
    listProjectArchiveIds: record('listProjectArchiveIds', []),
    listNotes: record('listNotes', [{ id: 'n1', title: 'Note' }]),
    readNote: record('readNote', { id: 'n1', content: 'Body' }),
    listPrompts: record('listPrompts', []),
    readPrompt: record('readPrompt', { id: 'p1' }),
    listAttachments: record('listAttachments', [
      { filename: 'spec.md', absolutePath: '/home/cw/attachments/spec.md' },
    ]),
    readFileContent: record('readFileContent', { kind: 'text', text: 'x' }),
    readCoworkClaudeMd: record('readCoworkClaudeMd', '# Rules'),
  };
}

const ACTIONS: Record<
  (typeof ADVISOR_CHAT_READ_ACTION_TYPES)[number],
  unknown
> = {
  'worktree-chat.list_tabs': {
    type: 'worktree-chat.list_tabs',
    projectId: 'proj',
    worktreeId: 'wt',
  },
  'worktree-chat.read_history': {
    type: 'worktree-chat.read_history',
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
  },
  'worktree-chat.get_last_user_message': {
    type: 'worktree-chat.get_last_user_message',
    projectId: 'proj',
    worktreeId: 'wt',
  },
  'worktree-chat.get_last_agent_response': {
    type: 'worktree-chat.get_last_agent_response',
    projectId: 'proj',
    worktreeId: 'wt',
  },
  'worktree-chat.list_plugins': {
    type: 'worktree-chat.list_plugins',
    projectId: 'proj',
    worktreeId: 'wt',
  },
  'pipeline-assistant-chat.list_tabs': {
    type: 'pipeline-assistant-chat.list_tabs',
  },
  'pipeline-assistant-chat.read_history': {
    type: 'pipeline-assistant-chat.read_history',
    chatId: 'pa-1',
  },
  'pipeline-assistant-chat.get_last_user_message': {
    type: 'pipeline-assistant-chat.get_last_user_message',
    chatId: 'pa-1',
  },
  'pipeline-assistant-chat.get_last_agent_response': {
    type: 'pipeline-assistant-chat.get_last_agent_response',
    chatId: 'pa-1',
  },
  'pipeline-assistant-chat.list_plugins': {
    type: 'pipeline-assistant-chat.list_plugins',
    chatId: 'pa-1',
  },
  'standalone-chat.list_projects': { type: 'standalone-chat.list_projects' },
  'standalone-chat.list_chats': {
    type: 'standalone-chat.list_chats',
    projectId: 'cw',
  },
  'standalone-chat.get_settings': {
    type: 'standalone-chat.get_settings',
    projectId: 'cw',
  },
  'standalone-chat.list_plugins': {
    type: 'standalone-chat.list_plugins',
    projectId: 'cw',
  },
  'standalone-chat.read_history': {
    type: 'standalone-chat.read_history',
    projectId: 'cw',
    chatId: 'chat-1',
  },
  'standalone-chat.get_last_user_message': {
    type: 'standalone-chat.get_last_user_message',
    projectId: 'cw',
    chatId: 'chat-1',
  },
  'standalone-chat.get_last_agent_response': {
    type: 'standalone-chat.get_last_agent_response',
    projectId: 'cw',
    chatId: 'chat-1',
  },
  'standalone-chat.list_prompts': {
    type: 'standalone-chat.list_prompts',
    projectId: 'cw',
  },
  'standalone-chat.get_prompt': {
    type: 'standalone-chat.get_prompt',
    projectId: 'cw',
    promptId: 'p1',
  },
  'standalone-chat.list_notes': {
    type: 'standalone-chat.list_notes',
    projectId: 'cw',
  },
  'standalone-chat.get_note': {
    type: 'standalone-chat.get_note',
    projectId: 'cw',
    noteId: 'n1',
  },
  'standalone-chat.list_attachments': {
    type: 'standalone-chat.list_attachments',
    projectId: 'cw',
  },
  'standalone-chat.get_attachment': {
    type: 'standalone-chat.get_attachment',
    projectId: 'cw',
    attachmentId: 'spec.md',
  },
};

function setup(): {
  surfaces: Record<string, jest.Mock>;
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
} {
  const surfaces = {
    getMainWindow: jest.fn(() => null),
    getAppAdvisorWindow: jest.fn(() => null),
    openAppAdvisorWindow: jest.fn(),
    ensureAppAdvisorWindow: jest.fn(),
  };
  const runtime = createAppAdvisorToolRuntime(surfaces, {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId: 'advisor-chat',
  });
  return {
    surfaces,
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

/** As the tool text carries it: undefined fields drop out. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-5999-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  ui = null;
  mockHost = recordingHost();
  mockHostOptions.length = 0;
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor chat reads in main (CAN-5999)', () => {
  it('the 23 moved reads are core reads: history through transcript-read, the rest through worktree-actions', () => {
    expect([...ADVISOR_CHAT_READ_ACTION_TYPES].sort()).toEqual(
      Object.keys(ACTIONS).sort(),
    );
    expect(ADVISOR_CHAT_READ_ACTION_TYPES).toHaveLength(23);
    for (const type of ADVISOR_CHAT_READ_ACTION_TYPES)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'read',
        executor: (HISTORY_READS as readonly string[]).includes(type)
          ? 'transcript-read'
          : 'worktree-actions',
      });
    expect(
      appAdvisorActionDisposition('worktree-chat.list_background_processes'),
    ).toMatchObject({ kind: 'legacy' });
  });

  it('each moved read runs in main with no window and never reaches a renderer', async () => {
    const h = setup();
    for (const [type, input] of Object.entries(ACTIONS)) {
      const result = await h.route(input);
      expect({ type, ok: result.ok }).toEqual({ type, ok: true });
    }
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
    expect(h.surfaces.ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect(h.surfaces.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(mockHostOptions[0]?.chatId).toBe('advisor-chat');
  });

  it('history answers with the shared payload over the whole transcript', async () => {
    const result = await setup().route({
      ...(ACTIONS['worktree-chat.read_history'] as object),
      query: 'build',
    });

    expect(result).toEqual({
      requestId: 'toolu_1',
      ok: true,
      result: wire(
        chatHistoryPayload(
          {
            projectId: 'proj',
            worktreeId: 'wt',
            chatId: 'chat-1',
            tab: { ...chatTab('chat-1'), messages: TRANSCRIPT },
          },
          'transcript',
          'build',
          20,
        ),
      ),
    });
    expect(calls.readMessages).toEqual([['proj', 'wt', 'chat-1']]);
  });

  it('a tab with no transcript descriptor answers from its inline messages', async () => {
    const result = await setup().route({
      type: 'worktree-chat.get_last_user_message',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'inline',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { message: { id: 'inline-tail' } },
    });
    expect(calls.readMessages).toBeUndefined();
  });

  it('an implicit worktree comes from the lease, and with no lease is refused, never guessed', async () => {
    const h = setup();
    const refused = await h.route({ type: 'worktree-chat.read_history' });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'No worktree is selected. Provide projectId/worktreeId/chatId or select a worktree first.',
      },
    });
    expect(calls.readTabs).toBeUndefined();

    ui = lease({ selectedWorktree: SELECTED });
    const leased = await h.route({ type: 'worktree-chat.list_tabs' });
    expect(leased).toMatchObject({
      ok: true,
      result: { projectId: 'proj', worktreeId: 'wt' },
    });
    expect(calls.readTabs).toEqual([['proj', 'wt']]);
  });

  it('explicit ids never ask the lease', async () => {
    await setup().route(ACTIONS['worktree-chat.read_history']);

    expect(calls.readUiState).toBeUndefined();
  });

  it("file tabs report no unsaved changes with no lease, and the window's own with one", async () => {
    const h = setup();
    const fileTab = async (): Promise<unknown> =>
      (
        (await h.route(ACTIONS['worktree-chat.list_tabs'])).result as {
          fileTabs: Array<{ unsavedChanges: unknown }>;
        }
      ).fileTabs[0]?.unsavedChanges;

    expect(await fileTab()).toBe(false);
    ui = lease({ dirtyFileTabIds: ['file-1'] });
    expect(await fileTab()).toBe(true);
    ui = lease({ dirtyFileTabIds: ['other'] });
    expect(await fileTab()).toBe(false);
    ui = lease({});
    expect(await fileTab()).toBeNull();
  });

  it('an omitted Cowork project comes from the lease, and with no lease is refused, never guessed', async () => {
    const h = setup();
    const refused = await h.route({ type: 'standalone-chat.list_chats' });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'No Cowork project is selected. Provide projectId.',
      },
    });
    expect(calls.listWorkEntryIds).toBeUndefined();

    const projects = await h.route(ACTIONS['standalone-chat.list_projects']);
    expect(projects).toMatchObject({
      ok: true,
      result: { activeProjectId: null },
    });

    ui = lease({ activeCoworkProjectId: 'cw' });
    const leased = await h.route({ type: 'standalone-chat.list_chats' });
    expect(leased).toMatchObject({ ok: true, result: { projectId: 'cw' } });
    expect(
      (await h.route(ACTIONS['standalone-chat.list_projects'])).result,
    ).toMatchObject({ activeProjectId: 'cw' });
  });

  it('Cowork history prepares the project, then reads the chat in its Work Entry', async () => {
    const result = await setup().route(
      ACTIONS['standalone-chat.get_last_agent_response'],
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        projectId: 'cw',
        worktreeId: 'entry-1',
        message: { id: 'm2' },
      },
    });
    expect(calls.prepareCoworkProject).toEqual([['cw']]);
    expect(calls.readMessages).toEqual([['cw', 'entry-1', 'chat-1']]);
  });

  it('Pipeline Assistant reads use the pipeline editor scope', async () => {
    const result = await setup().route(
      ACTIONS['pipeline-assistant-chat.list_tabs'],
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatTabs: [{ id: 'pa-1' }],
      },
    });
  });

  it("plugin lists answer with the shared builder over main's inventories", async () => {
    const result = await setup().route(ACTIONS['standalone-chat.list_plugins']);

    expect(result.result).toEqual(
      wire(
        availablePluginListResult(
          {
            skills: {
              success: true,
              data: [{ sourceId: 'user', name: 'deploy', description: 'Ship' }],
            },
            marketplaces: { success: true, data: { marketplaces: [] } },
            collections: [],
            mcp: { servers: [] },
          },
          emptyChatTabPluginSelections(),
          {
            projectId: 'cw',
            projectName: 'Cowork',
            scope: 'standalone-project-defaults',
          },
          { type: 'standalone-chat.list_plugins' } as never,
        ),
      ),
    );
  });

  it('list_tabs gives an inactive chat its last user message from its latest page', async () => {
    const result = await setup().route(ACTIONS['worktree-chat.list_tabs']);
    const tabs = (
      result.result as {
        chatTabs: Array<{ id: string; lastUserMessage: unknown }>;
      }
    ).chatTabs;

    expect(tabs.find((tab) => tab.id === 'chat-2')?.lastUserMessage).toEqual({
      id: 'r1',
      timestamp: 3_000,
      text: 'Inactive prompt',
      truncated: false,
    });
    expect(
      tabs.find((tab) => tab.id === 'chat-1')?.lastUserMessage,
    ).toMatchObject({ id: 'chat-1-tail' });
    expect(calls.readRecentMessages).toEqual([['proj', 'wt', 'chat-2']]);
    expect(calls.readMessages).toBeUndefined();
  });

  it('Pipeline Assistant list_plugins names the chat as the renderer did', async () => {
    const result = await setup().route(
      ACTIONS['pipeline-assistant-chat.list_plugins'],
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        target: {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'pa-1',
          title: 'Chat pa-1',
          session: { state: 'idle', expired: false },
        },
      },
    });
  });

  it("an attachment read opens only a listed attachment's own path", async () => {
    const h = setup();
    const read = await h.route({
      ...(ACTIONS['standalone-chat.get_attachment'] as object),
      includeContent: true,
    });
    const missing = await h.route({
      type: 'standalone-chat.get_attachment',
      projectId: 'cw',
      attachmentId: '../../etc/passwd',
      includeContent: true,
    });

    expect(read).toMatchObject({
      ok: true,
      result: { content: { text: 'x' } },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls.readFileContent).toEqual([['/home/cw/attachments/spec.md']]);
  });

  it('empty and traversal ids are refused before any read', async () => {
    const h = setup();
    for (const input of [
      { type: 'standalone-chat.read_history', projectId: 'cw', chatId: '' },
      {
        type: 'worktree-chat.read_history',
        projectId: '../x',
        worktreeId: 'wt',
      },
      { type: 'standalone-chat.list_notes', projectId: '../../etc' },
    ]) {
      const result = await h.route(input);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
    }
    expect(calls.readTabs).toBeUndefined();
    expect(calls.listNotes).toBeUndefined();
  });

  it('an unknown Cowork project is not_found before its settings are read', async () => {
    const result = await setup().route({
      type: 'standalone-chat.get_settings',
      projectId: 'gone',
      includeClaudeMd: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: 'Cowork project gone was not found.',
      },
    });
    expect(calls.readCoworkClaudeMd).toBeUndefined();
  });
});

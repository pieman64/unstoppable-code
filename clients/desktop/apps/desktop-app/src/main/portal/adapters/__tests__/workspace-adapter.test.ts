import type * as SidebarItemsModule from '../../../lib/sidebar-items';
import type { SidebarItemsFile } from '@canopy/desktop-shared/types';
import {
  IPC_CHANNELS,
  type PortalCommandEnvelope,
  type PortalEventEnvelope,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type * as PreferencesStoreModule from '../../../lib/preferences-store';
import {
  handlePortalWorkspaceClaudeMdGet,
  handlePortalWorkspaceClaudeMdSave,
  handlePortalWorkspaceCreate,
  handlePortalWorkspaceDelete,
  handlePortalWorkspaceReorder,
  handlePortalWorkspaceScriptsGet,
  handlePortalWorkspaceScriptsSave,
  handlePortalWorkspaceUpdate,
} from '../workspace-adapter';
import type { PortalAdapterContext } from '../types';
import { deleteWorkspaceById } from '../../../lib/workspace-deletion';
import {
  LIVE_DELEGATES_REMOVAL_REFUSAL,
  LiveDelegationsError,
} from '../../../agents/delegation/activity';
import type * as WorkspaceMetadataModule from '../../../lib/workspace-metadata';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
  WorkspaceMetadataRefusedError,
} from '../../../lib/workspace-metadata';
import { readWorkspaceScriptCommands } from '../../../lib/workspace-script-config';
import { updateWorkspaceScripts } from '../../../lib/workspace-script-hook-settings';
import {
  loadWorkspaceClaudeMd,
  saveWorkspaceClaudeMd,
} from '../../../lib/workspace-claude-md';
import { addWorkspaceFromRemote } from '../../../lib/workspace-service';
import { recordWorkspaceCrudTelemetry } from '../../../lib/desktop-telemetry';
import { getDefaultReposDir } from '../../../lib/paths';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../../../lib/preferences-store';
import { readAllSidebarItems } from '../../../lib/sidebar-items';
import { sendToWindow } from '../../../lib/window-send';

jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../../../lib/workspace-deletion', () => ({
  deleteWorkspaceById: jest.fn(),
}));
jest.mock('../../../lib/workspace-metadata', () => ({
  ...jest.requireActual<typeof WorkspaceMetadataModule>(
    '../../../lib/workspace-metadata',
  ),
  reorderWorkspaces: jest.fn(),
  updateWorkspaceMetadata: jest.fn(),
}));
jest.mock('../../../lib/workspace-script-config', () => ({
  readWorkspaceScriptCommands: jest.fn(),
}));
jest.mock('../../../lib/workspace-script-hook-settings', () => ({
  updateWorkspaceScripts: jest.fn(),
}));
jest.mock('../../../lib/workspace-claude-md', () => ({
  loadWorkspaceClaudeMd: jest.fn(),
  saveWorkspaceClaudeMd: jest.fn(),
}));
jest.mock('../../../lib/workspace-service', () => ({
  addWorkspaceFromRemote: jest.fn(),
}));
jest.mock('../../../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));
jest.mock('../../../lib/paths', () => ({
  getDefaultReposDir: jest.fn(() => '/data/repos'),
}));
jest.mock('../../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../../lib/preferences-store',
  ),
  readPreferencesFile: jest.fn(),
}));
jest.mock('../../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../portal-workspace-reads', () => ({
  readPortalSidebarItems: (): Promise<SidebarItemsFile> =>
    jest
      .requireMock<typeof SidebarItemsModule>('../../../lib/sidebar-items')
      .readAllSidebarItems(),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

const mockStartedCreates = new Set<string>();
const mockMarkStartedCreate = jest.fn(
  ({ commandId }: { commandId: string }): Promise<boolean> => {
    if (mockStartedCreates.has(commandId)) return Promise.resolve(false);
    mockStartedCreates.add(commandId);
    return Promise.resolve(true);
  },
);
jest.mock('../../portal-state-store', () => ({
  markPortalWorkspaceCreateStarted: (
    ...args: Parameters<typeof mockMarkStartedCreate>
  ): ReturnType<typeof mockMarkStartedCreate> => mockMarkStartedCreate(...args),
}));

const mockedDelete = jest.mocked(deleteWorkspaceById);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedUpdateMeta = jest.mocked(updateWorkspaceMetadata);
const mockedReadScripts = jest.mocked(readWorkspaceScriptCommands);
const mockedSaveScripts = jest.mocked(updateWorkspaceScripts);
const mockedLoadClaudeMd = jest.mocked(loadWorkspaceClaudeMd);
const mockedSaveClaudeMd = jest.mocked(saveWorkspaceClaudeMd);
const mockedAddRemote = jest.mocked(addWorkspaceFromRemote);
const mockedTelemetry = jest.mocked(recordWorkspaceCrudTelemetry);
const mockedDefaultReposDir = jest.mocked(getDefaultReposDir);
const mockedReadPreferences = jest.mocked(readPreferencesFile);
const mockedReadSidebarItems = jest.mocked(readAllSidebarItems);
const mockedReorderWorkspaces = jest.mocked(reorderWorkspaces);

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    sessionId: 'session-1',
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (command, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: command.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (command, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: command.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

function command(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceDelete>[0] {
  return {
    id: 'cmd-1',
    sequence: 1,
    type: 'portal.workspace.delete',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorkspaceDelete>[0];
}

function reorderCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceReorder>[0] {
  const reorder: PortalCommandEnvelope<unknown> = {
    id: 'cmd-r',
    sequence: 1,
    type: 'portal.workspace.reorder',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  };
  return reorder;
}

const operationIdMatcher: unknown = expect.any(String);

describe('project portal adapter — delete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes a project via the shared service (source "portal") and completes', async () => {
    mockedDelete.mockResolvedValue();
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceDelete(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(mockedDelete).toHaveBeenCalledWith('ws-1', 'portal');
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1' },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('fails on an invalid payload with no workspaceId', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceDelete(command({}), adapterContext(events));

    expect(mockedDelete).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });

  it('rejects a malformed workspaceId before touching the service', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceDelete(
      command({ workspaceId: 'Bad Id!' }),
      adapterContext(events),
    );

    expect(mockedDelete).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });

  it('reports a refusal for live delegates as a conflict', async () => {
    mockedDelete.mockRejectedValue(
      new LiveDelegationsError(LIVE_DELEGATES_REMOVAL_REFUSAL),
    );
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceDelete(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.failed',
        payload: {
          error: {
            code: 'conflict',
            message: 'Delegates are still running here. Stop them first.',
          },
        },
      }),
    ]);
  });

  it('reports a service error as a command failure', async () => {
    mockedDelete.mockRejectedValue(new Error('rm exploded'));
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceDelete(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });
});

describe('project portal adapter — reorder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadPreferences.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      worktreeFilterHiddenWorkspaceIds: [],
    });
    mockedReorderWorkspaces.mockResolvedValue({ workspaceIds: [] });
  });

  it('reorders visible projects without moving hidden, auto-hidden, or cowork slots', async () => {
    const base: SidebarItem = {
      type: 'single-repo',
      id: 'base',
      name: 'Base',
      repoPath: '/data/repos/base',
      color: '#fff',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const items: SidebarItem[] = [
      { ...base, id: 'ws-a', name: 'A', order: 0 },
      { ...base, id: 'ws-hidden', name: 'Hidden', order: 1 },
      {
        ...base,
        type: 'multi-repo',
        id: 'ws-temporary',
        name: 'Temporary',
        repos: [],
        worktrees: [],
        alwaysShow: false,
        temporary: true,
        order: 2,
      },
      {
        type: 'cowork',
        id: 'ws-cowork',
        name: 'Cowork',
        color: '#fff',
        collapsed: false,
        order: 3,
      },
      { ...base, id: 'ws-b', name: 'B', order: 4 },
    ];
    mockedReadPreferences.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      worktreeFilterHiddenWorkspaceIds: ['ws-hidden'],
    });
    mockedReadSidebarItems.mockResolvedValue({ version: 1, items });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceReorder(
      reorderCommand({
        activeWorkspaceId: 'ws-b',
        overWorkspaceId: 'ws-a',
      }),
      adapterContext(events),
    );

    expect(mockedReorderWorkspaces).toHaveBeenCalledWith({
      visibleWorkspaceIds: ['ws-a', 'ws-b'],
      activeWorkspaceId: 'ws-b',
      overWorkspaceId: 'ws-a',
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-b' },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('moves the active project over the target and normalizes order', async () => {
    const base: SidebarItem = {
      type: 'single-repo',
      id: 'base',
      name: 'Base',
      repoPath: '/data/repos/base',
      color: '#fff',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const items: SidebarItem[] = [
      { ...base, id: 'ws-a', name: 'A', order: 0 },
      { ...base, id: 'ws-b', name: 'B', order: 1 },
      { ...base, id: 'ws-c', name: 'C', order: 2 },
    ];
    mockedReadSidebarItems.mockResolvedValue({ version: 1, items });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceReorder(
      reorderCommand({
        activeWorkspaceId: 'ws-c',
        overWorkspaceId: 'ws-a',
      }),
      adapterContext(events),
    );

    expect(mockedReorderWorkspaces).toHaveBeenCalledWith({
      visibleWorkspaceIds: ['ws-a', 'ws-b', 'ws-c'],
      activeWorkspaceId: 'ws-c',
      overWorkspaceId: 'ws-a',
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-c' },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('fails with not_found without writing when a project is missing', async () => {
    const base: SidebarItem = {
      type: 'single-repo',
      id: 'ws-a',
      name: 'A',
      repoPath: '/data/repos/a',
      color: '#fff',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    mockedReadSidebarItems.mockResolvedValue({ version: 1, items: [base] });
    mockedReorderWorkspaces.mockRejectedValue(
      new WorkspaceMetadataRefusedError(
        'not-found',
        'Project to reorder was not found.',
      ),
    );
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceReorder(
      reorderCommand({
        activeWorkspaceId: 'ws-a',
        overWorkspaceId: 'missing',
      }),
      adapterContext(events),
    );

    expect(mockedReorderWorkspaces).toHaveBeenCalledWith({
      visibleWorkspaceIds: ['ws-a'],
      activeWorkspaceId: 'ws-a',
      overWorkspaceId: 'missing',
    });
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          code: 'not_found',
          message: 'Project to reorder was not found.',
        },
      },
    });
  });

  it.each([
    ['a missing active id', { overWorkspaceId: 'ws-b' }],
    [
      'a non-string target id',
      { activeWorkspaceId: 'ws-a', overWorkspaceId: 7 },
    ],
  ])('rejects a reorder payload with %s', async (_description, payload) => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceReorder(
      reorderCommand(payload),
      adapterContext(events),
    );

    expect(mockedReadSidebarItems).not.toHaveBeenCalled();
    expect(mockedReorderWorkspaces).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });
});

function createCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceCreate>[0] {
  return {
    id: 'cmd-c',
    sequence: 2,
    type: 'portal.workspace.create',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorkspaceCreate>[0];
}

const clonedWorkspace: SidebarItem = {
  type: 'single-repo',
  id: 'ws-cloned',
  name: 'repo',
  repoPath: '/data/repos/repo',
  color: '#fff',
  worktrees: [],
  collapsed: false,
  order: 0,
};

describe('project portal adapter — create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartedCreates.clear();
  });

  it.each(['tree/main/pstack', 'blob/main/pstack/README.md'])(
    'normalizes a GitHub %s link before creation',
    async (suffix) => {
      mockedAddRemote.mockResolvedValue(clonedWorkspace);
      await handlePortalWorkspaceCreate(
        createCommand({
          kind: 'remote-clone',
          remoteUrl: `https://github.com/cursor/plugins/${suffix}`,
        }),
        adapterContext([]),
      );
      expect(mockedAddRemote).toHaveBeenCalledWith(
        'https://github.com/cursor/plugins',
        '/data/repos',
      );
    },
  );

  it('clones a remote project using the desktop default repos dir, completing with only the project id (no local path leak)', async () => {
    mockedAddRemote.mockResolvedValue(clonedWorkspace);
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceCreate(
      createCommand({
        kind: 'remote-clone',
        remoteUrl: 'https://github.com/org/repo.git',
      }),
      adapterContext(events),
    );

    expect(mockedDefaultReposDir).toHaveBeenCalled();
    expect(mockedAddRemote).toHaveBeenCalledWith(
      'https://github.com/org/repo.git',
      '/data/repos',
    );
    expect(mockedTelemetry).toHaveBeenCalledWith({
      action: 'create',
      workspaceId: 'ws-cloned',
      source: 'portal',
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-cloned' },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    // The completed payload must not carry the absolute local repoPath.
    const completed = events[0];
    expect(completed.payload).toEqual({
      result: {
        workspaceId: 'ws-cloned',
        scriptActionsOperationId: operationIdMatcher,
      },
    });
    expect(JSON.stringify(completed)).not.toContain('/data/repos/repo');
    // The desktop renderer learns about the brand-new workspace through the
    // workspace-id-only event, which triggers its silent full projects reload.
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-cloned' },
    );
  });

  it('does not clone a redelivered create a second time before cursor acknowledgement', async () => {
    mockedAddRemote.mockResolvedValue(clonedWorkspace);
    const events: PortalEventEnvelope[] = [];
    const request = createCommand({
      kind: 'remote-clone',
      remoteUrl: 'https://github.com/org/repo.git',
    });
    await handlePortalWorkspaceCreate(request, adapterContext(events));
    await handlePortalWorkspaceCreate(request, adapterContext(events));
    expect(mockedAddRemote).toHaveBeenCalledTimes(1);
    expect(events[1]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          message:
            'The desktop restarted before the clone result was confirmed. Check Projects before trying again.',
        },
      },
    });
  });

  it('does not invoke the clone when persisting its started marker fails', async () => {
    mockMarkStartedCreate.mockRejectedValueOnce(new Error('write failed'));
    mockedAddRemote.mockResolvedValue(clonedWorkspace);
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceCreate(
      createCommand({
        kind: 'remote-clone',
        remoteUrl: 'https://host/repo.git',
      }),
      adapterContext(events),
    );
    expect(mockedAddRemote).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'portal.command.failed' });
  });

  it('does not clone without a session or before the started marker is durable', async () => {
    const context = adapterContext([]);
    context.sessionId = null;
    const request = createCommand({
      kind: 'remote-clone',
      remoteUrl: 'https://host/repo.git',
    });
    await handlePortalWorkspaceCreate(request, context);
    expect(mockedAddRemote).not.toHaveBeenCalled();
    let release: ((claimed: boolean) => void) | undefined;
    mockMarkStartedCreate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    mockedAddRemote.mockResolvedValue(clonedWorkspace);
    const pending = handlePortalWorkspaceCreate(request, adapterContext([]));
    await Promise.resolve();
    expect(mockedAddRemote).not.toHaveBeenCalled();
    if (!release) throw new Error('marker not requested');
    release(true);
    await pending;
    expect(mockedAddRemote).toHaveBeenCalledTimes(1);
  });

  it.each(['complete', 'fail'] as const)(
    'keeps the invocation marker when %s reporting rejects',
    async (report) => {
      if (report === 'complete')
        mockedAddRemote.mockResolvedValue(clonedWorkspace);
      else
        mockedAddRemote.mockRejectedValue(
          new Error('/private/clone-destination'),
        );
      const context = adapterContext([]);
      const rejectReport = jest.fn(() => {
        throw new Error('report rejected');
      });
      if (report === 'complete') context.complete = rejectReport;
      else context.fail = rejectReport;
      const request = createCommand({
        kind: 'remote-clone',
        remoteUrl: 'https://host/repo.git',
      });
      await expect(
        handlePortalWorkspaceCreate(request, context),
      ).rejects.toThrow('report rejected');
      const events: PortalEventEnvelope[] = [];
      await handlePortalWorkspaceCreate(request, adapterContext(events));
      expect(mockedAddRemote).toHaveBeenCalledTimes(1);
      expect(events[0]?.type).toBe('portal.command.failed');
      expect(JSON.stringify(events[0])).toContain(
        'Check Projects before trying again',
      );
    },
  );

  it('accepts scp-like git remotes (git@host:path)', async () => {
    mockedAddRemote.mockResolvedValue(clonedWorkspace);
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceCreate(
      createCommand({
        kind: 'remote-clone',
        remoteUrl: 'git@github.com:org/repo.git',
      }),
      adapterContext(events),
    );

    expect(mockedAddRemote).toHaveBeenCalledWith(
      'git@github.com:org/repo.git',
      '/data/repos',
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('rejects blank URLs, bare local paths, file:// URLs, and non-remote-clone payloads without cloning', async () => {
    const events: PortalEventEnvelope[] = [];

    // Each of these is not a plausible REMOTE git URL, so no clone happens:
    // bare/local paths and `file://` (browser cloning arbitrary local content),
    // and an option-looking URL (`git clone` argument injection — the scp-like
    // pattern would otherwise admit `--upload-pack=...`).
    for (const remoteUrl of [
      '   ',
      '/etc/passwd',
      'file:///etc/passwd',
      '--upload-pack=touch /tmp/pwn@host:repo',
    ]) {
      await handlePortalWorkspaceCreate(
        createCommand({ kind: 'remote-clone', remoteUrl }),
        adapterContext(events),
      );
    }
    await handlePortalWorkspaceCreate(
      createCommand({ kind: 'cowork', name: 'My Space' }),
      adapterContext(events),
    );
    await handlePortalWorkspaceCreate(
      createCommand({ kind: 'bogus' }),
      adapterContext(events),
    );

    expect(mockedAddRemote).not.toHaveBeenCalled();
    expect(mockedTelemetry).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
      'portal.command.failed',
      'portal.command.failed',
      'portal.command.failed',
      'portal.command.failed',
      'portal.command.failed',
    ]);
  });

  it('reports a clone failure with a generic message that does not leak the destination path', async () => {
    mockedAddRemote.mockRejectedValue(
      new Error(
        "fatal: could not create work tree dir '/data/repos/secret-path': Permission denied",
      ),
    );
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceCreate(
      createCommand({
        kind: 'remote-clone',
        remoteUrl: 'https://github.com/org/repo.git',
      }),
      adapterContext(events),
    );

    expect(mockedTelemetry).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
    // The raw git error (with the absolute dest path) must not reach the browser.
    expect(JSON.stringify(events[0])).not.toContain('/data/repos/secret-path');
    expect(JSON.stringify(events[0])).toContain(
      'Failed to clone the repository',
    );
  });
});

function claudeMdGetCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceClaudeMdGet>[0] {
  return {
    id: 'cmd-g',
    sequence: 3,
    type: 'portal.workspace.claude_md.get',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorkspaceClaudeMdGet>[0];
}

function claudeMdSaveCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceClaudeMdSave>[0] {
  return {
    id: 'cmd-s',
    sequence: 4,
    type: 'portal.workspace.claude_md.save',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorkspaceClaudeMdSave>[0];
}

describe('project portal adapter — CLAUDE.md get/save', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the project CLAUDE.md content in the completion result', async () => {
    mockedLoadClaudeMd.mockResolvedValue('# hello\n');
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceClaudeMdGet(
      claudeMdGetCommand({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(mockedLoadClaudeMd).toHaveBeenCalledWith('ws-1');
    expect(events[0].type).toBe('portal.command.completed');
    expect(events[0].payload).toEqual({ result: { content: '# hello\n' } });
  });

  it('fails a get with no workspaceId and never reads', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceClaudeMdGet(
      claudeMdGetCommand({}),
      adapterContext(events),
    );
    expect(mockedLoadClaudeMd).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });

  it('rejects a malformed workspaceId on get before reading', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceClaudeMdGet(
      claudeMdGetCommand({ workspaceId: 'Bad Id!' }),
      adapterContext(events),
    );
    expect(mockedLoadClaudeMd).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });

  it('saves the project CLAUDE.md via the shared service (source "portal")', async () => {
    mockedSaveClaudeMd.mockResolvedValue();
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceClaudeMdSave(
      claudeMdSaveCommand({ workspaceId: 'ws-1', content: '# new\n' }),
      adapterContext(events),
    );

    expect(mockedSaveClaudeMd).toHaveBeenCalledWith(
      'ws-1',
      '# new\n',
      'portal',
    );
    expect(events.map((e) => e.type)).toEqual(['portal.command.completed']);
  });

  it('fails a save when content is missing and never writes', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceClaudeMdSave(
      claudeMdSaveCommand({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );
    expect(mockedSaveClaudeMd).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });

  it('rejects a malformed workspaceId on save before writing', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceClaudeMdSave(
      claudeMdSaveCommand({ workspaceId: 'Bad Id!', content: 'x' }),
      adapterContext(events),
    );
    expect(mockedSaveClaudeMd).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });
});

function updateCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceUpdate>[0] {
  return {
    id: 'cmd-u',
    sequence: 5,
    type: 'portal.workspace.update',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorkspaceUpdate>[0];
}

describe('project portal adapter — update (rename/recolor)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renames + recolors via the shared service (source "portal")', async () => {
    mockedUpdateMeta.mockResolvedValue({
      workspaceId: 'ws-1',
      indexWritten: true,
      manifestWritten: false,
    });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceUpdate(
      updateCommand({ workspaceId: 'ws-1', name: 'Renamed', color: '#22C55E' }),
      adapterContext(events),
    );

    expect(mockedUpdateMeta).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      patch: { name: 'Renamed', color: '#22C55E' },
      source: 'portal',
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1' },
    );
    expect(events.map((e) => e.type)).toEqual(['portal.command.completed']);
  });

  it('passes a sidebar collapse toggle through to the shared service', async () => {
    mockedUpdateMeta.mockResolvedValue({
      workspaceId: 'ws-1',
      indexWritten: true,
      manifestWritten: false,
    });
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceUpdate(
      updateCommand({ workspaceId: 'ws-1', collapsed: true }),
      adapterContext(events),
    );
    expect(mockedUpdateMeta).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      patch: { collapsed: true },
      source: 'portal',
    });
  });

  it('passes only the provided fields (name-only rename)', async () => {
    mockedUpdateMeta.mockResolvedValue({
      workspaceId: 'ws-1',
      indexWritten: true,
      manifestWritten: false,
    });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorkspaceUpdate(
      updateCommand({ workspaceId: 'ws-1', name: 'Just Name' }),
      adapterContext(events),
    );

    expect(mockedUpdateMeta).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      patch: { name: 'Just Name', color: undefined },
      source: 'portal',
    });
    expect(events.map((e) => e.type)).toEqual(['portal.command.completed']);
  });

  it('fails when workspaceId is missing and never touches the service', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceUpdate(
      updateCommand({ name: 'x' }),
      adapterContext(events),
    );
    expect(mockedUpdateMeta).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });

  it('surfaces a service validation error (e.g. bad color) as a command failure', async () => {
    mockedUpdateMeta.mockRejectedValue(new Error('Invalid project color.'));
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceUpdate(
      updateCommand({ workspaceId: 'ws-1', color: '#000000' }),
      adapterContext(events),
    );
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });
});

function scriptsGetCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceScriptsGet>[0] {
  return {
    id: 'cmd-sg',
    sequence: 6,
    type: 'portal.workspace.scripts.get',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorkspaceScriptsGet>[0];
}

function scriptsSaveCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorkspaceScriptsSave>[0] {
  return {
    id: 'cmd-ss',
    sequence: 7,
    type: 'portal.workspace.scripts.save',
    payload,
    createdAt: '2026-07-11T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorkspaceScriptsSave>[0];
}

describe('project portal adapter — scripts get/save', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the project script commands in the completion result', async () => {
    mockedReadScripts.mockResolvedValue({
      setup: 'npm ci',
      launch: 'npm run dev',
    });
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceScriptsGet(
      scriptsGetCommand({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );
    expect(mockedReadScripts).toHaveBeenCalledWith('ws-1');
    expect(events[0].payload).toEqual({
      result: { commands: { setup: 'npm ci', launch: 'npm run dev' } },
    });
  });

  it('fails a scripts get with no workspaceId', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceScriptsGet(
      scriptsGetCommand({}),
      adapterContext(events),
    );
    expect(mockedReadScripts).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });

  it('saves scripts through the W5 scripts command, keeping only string commands', async () => {
    mockedSaveScripts.mockResolvedValue();
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceScriptsSave(
      scriptsSaveCommand({
        workspaceId: 'ws-1',
        // The number/nested values are ignored (wire is untrusted).
        commands: { setup: 'npm ci', launch: 42, teardown: '' },
      }),
      adapterContext(events),
    );
    expect(mockedSaveScripts).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      change: {
        kind: 'merge-commands',
        commands: { setup: 'npm ci', teardown: '' },
      },
      source: 'portal',
    });
    expect(events.map((e) => e.type)).toEqual(['portal.command.completed']);
  });

  it('fails a scripts save without a commands map', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceScriptsSave(
      scriptsSaveCommand({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );
    expect(mockedSaveScripts).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });

  it('rejects a malformed workspaceId on scripts save', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalWorkspaceScriptsSave(
      scriptsSaveCommand({ workspaceId: 'Bad Id!', commands: { setup: 'x' } }),
      adapterContext(events),
    );
    expect(mockedSaveScripts).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['portal.command.failed']);
  });
});

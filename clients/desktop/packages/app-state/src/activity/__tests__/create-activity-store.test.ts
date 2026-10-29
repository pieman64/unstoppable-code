import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  SessionViewModel,
  Unsubscribe,
} from '@canopy/app-core';
import {
  createActivityStore,
  selectChangedFiles,
  selectPrStatus,
  selectSectionOrder,
  selectWorktreeItems,
} from '../create-activity-store';
import {
  DEFAULT_ACTIVITY_SECTION_ORDER,
  resolveActivitySectionOrder,
} from '../section-order';

const DESKTOP_CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

interface RecordedCommand {
  name: CommandName;
  args: unknown;
}

interface MockClient {
  client: CanopyClient;
  commandCalls: RecordedCommand[];
}

function createMockClient(): MockClient {
  const commandCalls: RecordedCommand[] = [];
  const client: CanopyClient = {
    capabilities: DESKTOP_CAPS,
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('query not exercised in this test'));
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      commandCalls.push({ name, args });
      return Promise.reject(new Error('command result not used in this test'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
  return { client, commandCalls };
}

/** A complete, mostly-empty shell snapshot; override the fields under test. */
function makeSnapshot(
  overrides: Partial<SessionViewModel> = {},
): SessionViewModel {
  return {
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
    ...overrides,
  };
}

describe('createActivityStore', () => {
  it('hydrates the snapshot', () => {
    const store = createActivityStore(createMockClient().client);
    expect(store.getState().snapshot).toBeNull();
    const snapshot = makeSnapshot();
    store.getState().hydrate(snapshot);
    expect(store.getState().snapshot).toBe(snapshot);
  });

  it('patches fields on an already-hydrated neutral snapshot', () => {
    const store = createActivityStore(createMockClient().client);
    store.getState().hydrate(makeSnapshot());
    const plans = [
      {
        localId: 'p1',
        title: 'Patched',
        status: 'draft',
        worktreeLocalId: 'wt1',
      },
    ];
    store.getState().patch({ plans, refreshing: true });
    expect(store.getState().snapshot?.plans).toEqual(plans);
    expect(store.getState().snapshot?.refreshing).toBe(true);
    expect(store.getState().snapshot?.workspaces).toEqual([]);
  });

  it('resolves section order from the snapshot, then an override', () => {
    const store = createActivityStore(createMockClient().client);
    store.getState().hydrate(
      makeSnapshot({
        workspaces: [
          {
            localId: 'ws1',
            name: 'WS',
            type: 'single-repo',
            activitySectionOrder: ['scripts', 'summary'],
          },
        ],
      }),
    );

    // Snapshot order (normalized: known-first, then remaining defaults).
    const fromSnapshot = selectSectionOrder(store.getState(), 'ws1');
    expect(fromSnapshot.slice(0, 2)).toEqual(['scripts', 'summary']);

    // Override wins — and is normalized (a partial list is completed, not truncated).
    store.getState().setSectionOrder('ws1', ['hooks']);
    const overridden = selectSectionOrder(store.getState(), 'ws1');
    expect(overridden[0]).toBe('hooks');
    expect(overridden).toEqual(resolveActivitySectionOrder(['hooks']));
    expect(overridden).toHaveLength(DEFAULT_ACTIVITY_SECTION_ORDER.length);
  });

  it('normalizes an empty setSectionOrder to the default order (never hides sections)', () => {
    const store = createActivityStore(createMockClient().client);
    store.getState().setSectionOrder('ws1', []);
    expect(selectSectionOrder(store.getState(), 'ws1')).toEqual([
      ...DEFAULT_ACTIVITY_SECTION_ORDER,
    ]);
  });

  it('clears an optimistic override once a snapshot confirms the order', () => {
    const store = createActivityStore(createMockClient().client);
    store.getState().setSectionOrder('ws1', ['hooks', 'scripts']);
    const confirmed = resolveActivitySectionOrder(['hooks', 'scripts']);

    // A snapshot arrives carrying the now-persisted order.
    store.getState().hydrate(
      makeSnapshot({
        workspaces: [
          {
            localId: 'ws1',
            name: 'WS',
            type: 'single-repo',
            activitySectionOrder: confirmed,
          },
        ],
      }),
    );

    // Override dropped; the resolved order still matches (now from the snapshot).
    expect(store.getState().sectionOrderOverrides['ws1']).toBeUndefined();
    expect(selectSectionOrder(store.getState(), 'ws1')).toEqual(confirmed);
  });

  it('falls back to the default order for an unknown workspace', () => {
    const store = createActivityStore(createMockClient().client);
    store.getState().hydrate(makeSnapshot());
    expect(selectSectionOrder(store.getState(), 'missing')).toEqual([
      'summary',
      'changed-files',
      'pull-request',
      'background-processes',
      'mcp-servers',
      'plans',
      'pipeline-runs',
      'cost',
      'scripts',
      'hooks',
      'terminals',
      'todo',
    ]);
  });

  it('setSectionOrder issues the persist command with the new order', () => {
    const mock = createMockClient();
    const store = createActivityStore(mock.client);
    store.getState().setSectionOrder('ws1', ['hooks', 'scripts']);
    const call = mock.commandCalls.find(
      (c) => c.name === 'activity.setSectionOrder',
    );
    expect(call?.args).toEqual({
      workspaceLocalId: 'ws1',
      order: resolveActivitySectionOrder(['hooks', 'scripts']),
    });
  });

  it('round-trips an unknown section id through the persist command', () => {
    const mock = createMockClient();
    const store = createActivityStore(mock.client);
    store.getState().setSectionOrder('ws1', ['hooks', 'notes', 'scripts']);

    const call = mock.commandCalls.find(
      (candidate) => candidate.name === 'activity.setSectionOrder',
    );
    expect(call).toEqual({
      name: 'activity.setSectionOrder',
      args: {
        workspaceLocalId: 'ws1',
        order: resolveActivitySectionOrder(['hooks', 'notes', 'scripts']),
      },
    });
  });

  it('selects changed files and PR status by worktree', () => {
    const store = createActivityStore(createMockClient().client);
    store.getState().hydrate(
      makeSnapshot({
        changedFiles: {
          wt1: {
            worktreeLocalId: 'wt1',
            uncommitted: [{ filePath: 'a.ts', status: 'M' }],
            committed: [],
          },
        },
        prStatuses: {
          wt1: { worktreeLocalId: 'wt1', number: 42, state: 'open' },
        },
      }),
    );
    expect(selectChangedFiles(store.getState(), 'wt1')?.uncommitted).toEqual([
      { filePath: 'a.ts', status: 'M' },
    ]);
    expect(selectChangedFiles(store.getState(), 'other')).toBeUndefined();
    expect(selectPrStatus(store.getState(), 'wt1')?.number).toBe(42);
  });
});

describe('selectWorktreeItems', () => {
  it('filters a worktree-scoped list and tolerates undefined', () => {
    const runs = [
      { localId: 'r1', worktreeLocalId: 'wt1' },
      { localId: 'r2', worktreeLocalId: 'wt2' },
      { localId: 'r3', worktreeLocalId: 'wt1' },
    ];
    expect(selectWorktreeItems(runs, 'wt1').map((r) => r.localId)).toEqual([
      'r1',
      'r3',
    ]);
    expect(selectWorktreeItems(undefined, 'wt1')).toEqual([]);
  });
});

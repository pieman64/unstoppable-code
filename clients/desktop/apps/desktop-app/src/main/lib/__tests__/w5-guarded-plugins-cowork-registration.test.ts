// W7b-1c (CAN-5568): the guarded W5 commands #9 `core.workspace.plugins.update`
// and #12 `core.workspace.cowork.update` on the desktop dispatcher, and the
// Cowork part of `chat-project:update` projected onto #12, with the real
// commit-log worker and files.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  hostPlatformOperatingSystem,
  hostPlatformServices,
  createPlatformEndpointServices,
} from '@canopy/core-platform';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordStandaloneProjectCrudTelemetry: jest.fn(),
}));
jest.mock('../workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): { context: { kind: 'personal' } } => ({
      context: { kind: 'personal' },
    }),
  }),
}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  IPC_CHANNELS,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { projectedWorkspaceGuardedCommands } from '../../canopy-runtime/workspace-guarded-dispatch';
import { registerChatProjectHandlers } from '../../ipc/chat-projects';
import { registerIpcHandler } from '../../ipc/register';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { getWorkspaceWorkEntriesFilePath } from '../paths';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';
import {
  updateWorkspacePlugins,
  WorkspacePluginsRefusedError,
} from '../workspace-plugin-defaults';
import { registerWorkspaceTypes } from '../workspace-registry';
import {
  runW5Maintenance,
  type W5MaintenanceContext,
  type W5MaintenanceDecision,
} from '../w5-maintenance';

jest.setTimeout(60_000);
let dir: string;
let dataRoot: string;
let root: string;
let host: W5CommitLogHost;
let dispatcher: DesktopCanopyDispatcher;
let originalDataDir: string | undefined;

const dbPath = (): string => join(dataRoot, 'w5', 'commit-log.sqlite');
const manifestPath = (id: string): string => join(root, id, 'workspace.json');
const STALE_TOUCH = '2020-01-01T00:00:00.000Z';
const DEFAULTS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'source', skillName: 'chosen-skill' }],
  pluginRefs: [],
};
const PRESET: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'source', skillName: 'preset-skill' }],
  pluginRefs: [],
};

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: dbPath(),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
  registerWorkspaceTypes(
    new Map([
      ['a', 'single-repo'],
      ['c', 'cowork'],
    ]),
  );
}

function readObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`Expected an object in ${path}`);
  return { ...parsed };
}
const manifest = (id: string): Record<string, unknown> =>
  readObject(manifestPath(id));
function cowork(): Record<string, unknown> {
  const settings = manifest('c').cowork;
  if (typeof settings !== 'object' || settings === null)
    throw new Error('Expected Cowork settings');
  return { ...settings };
}
function indexEntry(id: string): Record<string, unknown> | undefined {
  const { workspaces } = readObject(join(root, 'index.json'));
  if (!Array.isArray(workspaces)) return undefined;
  for (const entry of workspaces as unknown[])
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      entry.id === id
    )
      return { ...entry };
  return undefined;
}
function images(): string[] {
  return ['index.json', 'a/workspace.json', 'c/workspace.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}
function touches(): unknown[] {
  const { entries } = readObject(getWorkspaceWorkEntriesFilePath('c'));
  return Array.isArray(entries)
    ? entries.map((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'lastTouchedAt' in entry
          ? entry.lastTouchedAt
          : null,
      )
    : [];
}

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture());
  const index = readObject(join(root, 'index.json'));
  const workspaces: unknown[] = Array.isArray(index.workspaces)
    ? index.workspaces
    : [];
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      ...index,
      workspaces: [
        ...workspaces,
        {
          id: 'c',
          name: 'Cowork',
          type: 'cowork',
          color: '#7C3AED',
          collapsed: false,
          order: 1,
        },
      ],
    }),
  );
  mkdirSync(join(root, 'c'), { recursive: true });
  writeFileSync(
    manifestPath('c'),
    JSON.stringify({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: {
        description: 'original',
        presets: [{ id: 'preset', name: 'Preset', pluginSelections: PRESET }],
        futureSetting: true,
      },
    }),
  );
  writeFileSync(
    join(root, 'c', 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees: [] }),
  );
  dataRoot = join(dir, 'data');
  // Maintenance runs only under a private data root.
  chmodSync(dataRoot, 0o700);
  mkdirSync(join(dataRoot, 'runtime'), { mode: 0o700 });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataRoot;
  mkdirSync(join(getWorkspaceWorkEntriesFilePath('c'), '..'), {
    recursive: true,
  });
  writeFileSync(
    getWorkspaceWorkEntriesFilePath('c'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'first',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastTouchedAt: STALE_TOUCH,
        },
      ],
    }),
  );
  setBeforeProjectPluginDefaultsChangeHandler(() => Promise.resolve());
  startHost();
  dispatcher = createDesktopRuntime();
  jest.clearAllMocks();
});
afterEach(async () => {
  await dispatcher.shutdown();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const IPC_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'core.worktree.read'],
};
const AGENT: CanopyCallerDescriptor = {
  ...IPC_CALLER,
  principalId: 'agent-7',
  clientInstanceId: 'agent-client',
  grants: ['core.workspace.write', 'core.worktree.write'],
};

/** Any operation by name, as a wire caller sends it. */
function instruct(
  operation: string,
  params: Record<string, unknown>,
  idempotencyKey = 'wire-key',
  caller: CanopyCallerDescriptor = AGENT,
): Promise<unknown> {
  const call = dispatcher.instruction.bind(dispatcher) as unknown as (
    name: string,
    params: Record<string, unknown>,
    options: {
      caller: CanopyCallerDescriptor;
      metadata: { idempotencyKey: string };
    },
  ) => Promise<unknown>;
  return call(
    operation,
    { ...params, _meta: { idempotencyKey } },
    { caller, metadata: { idempotencyKey } },
  );
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
}

/** The caller of the first receipt the spied commits saved. */
function receiptCaller(commits: {
  mock: { calls: ReadonlyArray<readonly unknown[]> };
}): string | undefined {
  for (const [request] of commits.mock.calls) {
    const { receipt } = request as { receipt?: { caller?: string } };
    if (receipt) return receipt.caller;
  }
  return undefined;
}

const projected = (): ReturnType<typeof projectedWorkspaceGuardedCommands> =>
  projectedWorkspaceGuardedCommands({ dispatcher, caller: IPC_CALLER });

/** The registered `chat-project:update` handler over this dispatcher. */
function chatProjectUpdate(): (request: unknown) => Promise<unknown> {
  jest.mocked(registerIpcHandler).mockClear();
  registerChatProjectHandlers({ dispatcher, resolveCaller: () => IPC_CALLER });
  const registration = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([channel]) => channel === IPC_CHANNELS.chatProjectUpdate);
  if (!registration) throw new Error('chat-project:update is not registered');
  const handler = registration[1] as (
    event: unknown,
    request: unknown,
  ) => Promise<unknown>;
  return (request) => handler({}, request);
}

const WIRE: ReadonlyArray<[string, Record<string, unknown>]> = [
  [
    'core.workspace.plugins.update',
    {
      workspaceId: 'a',
      change: { kind: 'setDefaults', defaultPluginSelections: DEFAULTS },
    },
  ],
  [
    'core.workspace.cowork.update',
    { workspaceId: 'c', settings: { description: 'edited' } },
  ],
];

describe('registration (D-1(a))', () => {
  it.each(WIRE)(
    'refuses %s without core.workspace.write before the handler runs',
    async (operation, params) => {
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      const reserves = jest.spyOn(host, 'reserve');
      for (const caller of [
        IPC_CALLER,
        {
          ...AGENT,
          grants: ['core.worktree.write'],
        } satisfies CanopyCallerDescriptor as CanopyCallerDescriptor,
      ])
        expect(
          await failureOf(instruct(operation, params, 'k', caller)),
        ).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(commits).not.toHaveBeenCalled();
      expect(reserves).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
    },
  );
});

describe('IPC projections', () => {
  it("a projected plugins change runs today's unkeyed write under the per-call grant", async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const lookups = jest.spyOn(host, 'lookupReceipt');
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const outcome = await projected().updatePlugins({
      workspaceId: 'a',
      change: { kind: 'setDefaults', defaultPluginSelections: DEFAULTS },
      source: 'project_settings',
    });
    expect(outcome).toMatchObject({ workspaceId: 'a', written: true });
    expect(manifest('a').defaultPluginSelections).toEqual(DEFAULTS);
    const [name, params, options] = instructions.mock.calls[0] ?? [];
    expect(name).toBe('core.workspace.plugins.update');
    expect(params).toMatchObject({
      workspaceId: 'a',
      change: { kind: 'setDefaults', defaultPluginSelections: DEFAULTS },
    });
    expect(options?.caller.grants).toEqual(['core.workspace.write']);
    await expect(instructions.mock.results[0]?.value).resolves.toMatchObject({
      workspaceId: 'a',
      written: true,
    });
    expect(reserves).not.toHaveBeenCalled();
    expect(lookups).not.toHaveBeenCalled();
  });

  it('a projected recommendation answers what the direct call answers', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const change = {
      kind: 'selectRecommended',
      selections: [{ kind: 'skill', sourceId: 'source', skillName: 'rec' }],
      optOutKeys: ['skill:other'],
      clearOptOutKeys: [],
    } as const;
    const viaDispatcher = await projected().updatePlugins({
      workspaceId: 'a',
      change,
      source: 'recommended_plugins',
    });
    expect(instructions.mock.calls[0]?.[0]).toBe(
      'core.workspace.plugins.update',
    );
    await expect(instructions.mock.results[0]?.value).resolves.toMatchObject({
      workspaceId: 'a',
      written: viaDispatcher.written,
    });
    // Applying the same change again in process finds it already applied.
    const direct = await updateWorkspacePlugins({
      workspaceId: 'a',
      change,
      source: 'recommended_plugins',
    });
    expect(viaDispatcher).toEqual(direct);
    expect(viaDispatcher.recommendedPluginOptOutKeys).toEqual(['skill:other']);
    const refusal = await failureOf(
      projected().updatePlugins({
        workspaceId: 'missing',
        change,
        source: 'recommended_plugins',
      }),
    );
    expect(refusal).toBeInstanceOf(WorkspacePluginsRefusedError);
    expect(refusal).toMatchObject({ reason: 'not-found' });
  });

  it('keeps the in-process plugins call for a request the wire cannot express, or a keyed one', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    // The legacy alias the page omits.
    const legacy: ChatTabPluginSelections = { ...DEFAULTS, bundleIds: ['b'] };
    await projected().updatePlugins({
      workspaceId: 'a',
      change: { kind: 'setDefaults', defaultPluginSelections: legacy },
      source: 'project_settings',
    });
    expect(manifest('a').defaultPluginSelections).toEqual(
      normalizePluginSelections(legacy),
    );
    await projected().updatePlugins({
      workspaceId: 'a',
      change: { kind: 'setDefaults', defaultPluginSelections: DEFAULTS },
      source: 'project_settings',
      idempotencyKey: 'host-key',
    });
    expect(instructions).not.toHaveBeenCalled();
  });

  it('a projected Cowork settings save commits #12 unkeyed under the per-call grant', async () => {
    const commits = jest.spyOn(host, 'commit');
    const reserves = jest.spyOn(host, 'reserve');
    const instructions = jest.spyOn(dispatcher, 'instruction');
    await expect(
      projected().updateCoworkSettings({
        projectId: 'c',
        description: 'edited',
        defaultPresetId: 'preset',
      }),
    ).resolves.toEqual({ workspaceId: 'c' });
    expect(cowork()).toMatchObject({
      description: 'edited',
      defaultPresetId: 'preset',
      futureSetting: true,
    });
    expect(manifest('c').defaultPluginSelections).toEqual(PRESET);
    const [name, params, options] = instructions.mock.calls[0] ?? [];
    expect(name).toBe('core.workspace.cowork.update');
    expect(params).toMatchObject({
      workspaceId: 'c',
      settings: { description: 'edited', defaultPresetId: 'preset' },
    });
    expect(options?.caller.grants).toEqual(['core.workspace.write']);
    expect(commits.mock.calls.map(([request]) => request.operation)).toEqual([
      'core.workspace.cowork.update',
    ]);
    expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
    expect(reserves).not.toHaveBeenCalled();
  });

  it('chat-project:update projects its settings onto #12, then its name onto #3', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const commits = jest.spyOn(host, 'commit');
    await chatProjectUpdate()({
      projectId: 'c',
      name: ' Renamed ',
      color: '#EF4444',
      description: 'edited',
      archiveRetentionDays: 14,
    });
    expect(instructions.mock.calls.map(([name]) => name)).toEqual([
      'core.workspace.cowork.update',
      'core.workspace.update',
    ]);
    expect(instructions.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: 'c',
      settings: { description: 'edited', archiveRetentionDays: 14 },
    });
    expect(instructions.mock.calls[0]?.[1]).not.toHaveProperty('settings.name');
    expect(commits.mock.calls[0]?.[0].operation).toBe(
      'core.workspace.cowork.update',
    );
    expect(cowork()).toMatchObject({
      description: 'edited',
      archiveRetentionDays: 14,
      futureSetting: true,
    });
    expect(indexEntry('c')).toMatchObject({
      name: 'Renamed',
      color: '#EF4444',
    });
  });

  it("chat-project:update keeps explicit defaults with the save's rest, and a selected preset still wins", async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const save = chatProjectUpdate();
    await save({ projectId: 'c', defaultPluginSelections: DEFAULTS });
    // #9's part stays on the unkeyed save (CAN-5568 inventory debt).
    expect(instructions).not.toHaveBeenCalled();
    expect(manifest('c').defaultPluginSelections).toEqual(DEFAULTS);
    await save({
      projectId: 'c',
      alwaysShow: true,
      defaultPresetId: 'preset',
      defaultPluginSelections: DEFAULTS,
    });
    expect(instructions.mock.calls.map(([name]) => name)).toEqual([
      'core.workspace.cowork.update',
      'core.workspace.update',
    ]);
    expect(manifest('c')).toMatchObject({
      alwaysShow: true,
      defaultPluginSelections: PRESET,
    });
  });

  it('chat-project:update refuses an invalid part before any part writes', async () => {
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    const save = chatProjectUpdate();
    await expect(
      save({ projectId: 'c', name: '   ', description: 'edited' }),
    ).rejects.toThrow('Project name is required');
    await expect(
      save({ projectId: 'c', name: 'Renamed', autoArchiveDays: 0 }),
    ).rejects.toThrow('Auto Delete inactivity must be null');
    await expect(
      save({ projectId: 'a', description: 'edited' }),
    ).rejects.toThrow('Chat project not found');
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });
});

describe('wire calls', () => {
  it('#9 answers its saved outcome, keyed to the principal, and replays it', async () => {
    const commits = jest.spyOn(host, 'commit');
    const params = WIRE[0]?.[1] ?? {};
    const first = await instruct('core.workspace.plugins.update', params);
    expect(first).toEqual({
      workspaceId: 'a',
      written: true,
      defaultPluginSelections: normalizePluginSelections(DEFAULTS),
      recommendedPluginOptOutKeys: [],
    });
    expect(receiptCaller(commits)).toBe('daemon:agent-7:workspace_settings');
    commits.mockClear();
    await expect(
      instruct('core.workspace.plugins.update', params),
    ).resolves.toEqual(first);
    expect(commits).not.toHaveBeenCalled();
    // One source for every wire change: another change under the key is
    // the same caller's, so it is refused rather than decided.
    expect(
      await failureOf(
        instruct('core.workspace.plugins.update', {
          workspaceId: 'a',
          change: {
            kind: 'selectRecommended',
            selections: [],
            optOutKeys: ['skill:x'],
            clearOptOutKeys: [],
          },
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.workspace.idempotencyKeyReused',
        retry: { kind: 'never' },
      },
    });
  });

  it('#9 refuses an unknown workspace as notFound before any key, and checks its revision', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct(
          'core.workspace.plugins.update',
          {
            workspaceId: 'missing',
            change: { kind: 'setDefaults', defaultPluginSelections: DEFAULTS },
          },
          'k-missing',
        ),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.workspace.notFound' },
    });
    expect(reserves).not.toHaveBeenCalled();
    const before = images();
    expect(
      await failureOf(
        instruct(
          'core.workspace.plugins.update',
          {
            workspaceId: 'a',
            expectedRevision: 9,
            change: { kind: 'setDefaults', defaultPluginSelections: DEFAULTS },
          },
          'k-stale',
        ),
      ),
    ).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.workspace.revisionConflict',
        retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
      },
    });
    expect(images()).toEqual(before);
  });

  it('#12 answers its saved outcome, keyed to the principal, and replays it', async () => {
    const commits = jest.spyOn(host, 'commit');
    const params = { workspaceId: 'c', settings: { description: 'edited' } };
    await expect(
      instruct('core.workspace.cowork.update', params),
    ).resolves.toEqual({ workspaceId: 'c' });
    expect(cowork()).toMatchObject({
      description: 'edited',
      futureSetting: true,
    });
    expect(receiptCaller(commits)).toBe('daemon:agent-7:chat_project_update');
    commits.mockClear();
    await expect(
      instruct('core.workspace.cowork.update', params),
    ).resolves.toEqual({ workspaceId: 'c' });
    expect(commits).not.toHaveBeenCalled();
    expect(
      await failureOf(
        instruct('core.workspace.cowork.update', {
          workspaceId: 'c',
          settings: { description: 'changed' },
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.workspace.idempotencyKeyReused',
      },
    });
  });

  it('#12 refuses a code workspace and an unknown one as notFound, releasing the key', async () => {
    const before = images();
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct(
          'core.workspace.cowork.update',
          { workspaceId: 'missing', settings: { description: 'x' } },
          'k-missing',
        ),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.workspace.notFound' },
    });
    expect(reserves).not.toHaveBeenCalled();
    const code = (): Promise<unknown> =>
      instruct(
        'core.workspace.cowork.update',
        { workspaceId: 'a', settings: { description: 'x' } },
        'k-code',
      );
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await failureOf(code())).toMatchObject({
        payload: {
          kind: 'not_found',
          code: 'core.workspace.notFound',
          message: 'Chat project not found',
        },
      });
    expect(images()).toEqual(before);
  });

  it("#12 publishes a failed Auto Delete stamp with the page's reason and releases the key", async () => {
    const entries = getWorkspaceWorkEntriesFilePath('c');
    const valid = readFileSync(entries, 'utf8');
    writeFileSync(entries, '{"version":1,"entries":');
    const call = (): Promise<unknown> =>
      instruct(
        'core.workspace.cowork.update',
        { workspaceId: 'c', settings: { autoArchiveDays: 7 } },
        'k-stamp',
      );
    const refusal = await failureOf(call());
    expect(refusal).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.invalidState',
        details: { reason: 'activity_unavailable' },
        retry: { kind: 'same_idempotency_key' },
      },
    });
    writeFileSync(entries, valid);
    await expect(call()).resolves.toEqual({ workspaceId: 'c' });
    expect(cowork()).toMatchObject({ autoArchiveDays: 7 });
    expect(touches().every((touch) => touch !== STALE_TOUCH)).toBe(true);
  });
});

describe('recovery classes (RX2)', () => {
  /** Maintenance needs a host that never started a worker. */
  function maintenanceContext(): W5MaintenanceContext {
    const os = hostPlatformOperatingSystem();
    const platform = hostPlatformServices(createPlatformEndpointServices(os));
    return {
      host: new W5CommitLogHost({
        dbPath: dbPath(),
        root,
        workerEntry: join(
          __dirname,
          '../../w5-commit-log/commit-log-worker.ts',
        ),
      }),
      dataRoot,
      platform: {
        ...platform,
        supervision: {
          ...platform.supervision,
          inspectProcess: ({ pid }) =>
            Promise.resolve(
              pid === process.pid
                ? { state: 'running', startIdentity: 'fixture-self-start' }
                : { state: 'absent' },
            ),
        },
      },
    };
  }

  const resolve = (
    decisions: readonly W5MaintenanceDecision[],
  ): ReturnType<typeof runW5Maintenance> =>
    runW5Maintenance(maintenanceContext(), {
      source: 'offline_maintenance',
      mode: 'resolve',
      decisions,
    });

  const posix = process.platform === 'win32' ? it.skip : it;
  const RECOVERY_REQUIRED = 'core.workspace.recoveryRequired';

  posix.each(WIRE)(
    '%s: an interrupted decision is recoveryRequired, diagnosed, then resolved on its key',
    async (operation, params) => {
      const call = (): Promise<unknown> => instruct(operation, params, 'rx');
      jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
        await host.shutdown();
        throw new Error('interrupted at decision');
      });
      expect(await failureOf(call())).toMatchObject({
        payload: { kind: 'internal' },
      });
      await host.shutdown();
      startHost();
      expect(await failureOf(call())).toMatchObject({
        payload: { kind: 'failed_precondition', code: RECOVERY_REQUIRED },
      });
      await host.shutdown();
      const diagnosis = await runW5Maintenance(maintenanceContext(), {
        source: 'offline_maintenance',
        mode: 'diagnose',
      });
      if (diagnosis.mode !== 'diagnose') throw new Error('Expected diagnosis');
      const [reservation] = diagnosis.diagnosis.reservations;
      expect(reservation).toMatchObject({
        operation,
        state: 'recovery-required',
      });
      await expect(
        resolve([
          {
            kind: 'resolve-reservation',
            reservationId: reservation?.reservationId ?? '',
          },
        ]),
      ).resolves.toMatchObject({ results: [{ status: 'resolved' }] });
      startHost();
      // The released key decides again.
      await expect(call()).resolves.toBeDefined();
    },
  );

  const FOREIGN = '{"foreign":true}\n';

  /**
   * A wire call whose decision commits but whose files changed out of band
   * before they applied. Returns the files' original bytes.
   */
  async function decidedButUnapplied(
    call: () => Promise<unknown>,
  ): Promise<Map<string, string>> {
    const originals = new Map<string, string>();
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      for (const { path, previousFingerprint } of request.files) {
        if (previousFingerprint === null) continue;
        originals.set(path, readFileSync(path, 'utf8'));
        writeFileSync(path, FOREIGN);
      }
      return commit(request);
    });
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await failureOf(call())).toMatchObject({
        payload: { kind: 'failed_precondition', code: RECOVERY_REQUIRED },
      });
    expect(originals.size).toBeGreaterThan(0);
    return originals;
  }

  async function wedgedCommitId(operation: string): Promise<number> {
    await host.shutdown();
    const diagnosis = await runW5Maintenance(maintenanceContext(), {
      source: 'offline_maintenance',
      mode: 'diagnose',
    });
    if (diagnosis.mode !== 'diagnose') throw new Error('Expected diagnosis');
    const [commit] = diagnosis.diagnosis.commits;
    expect(commit).toMatchObject({ operation, state: 'recovery-required' });
    return commit?.commitId ?? 0;
  }

  posix(
    'a decided but unapplied #12 retries once its files are restored, then replays its outcome',
    async () => {
      const call = (): Promise<unknown> =>
        instruct(
          'core.workspace.cowork.update',
          { workspaceId: 'c', settings: { description: 'Decided' } },
          'rx-commit',
        );
      const originals = await decidedButUnapplied(call);
      const commitId = await wedgedCommitId('core.workspace.cowork.update');
      for (const [path, bytes] of originals) writeFileSync(path, bytes);
      await expect(
        resolve([{ kind: 'retry-commit', commitId }]),
      ).resolves.toMatchObject({ results: [{ status: 'applied' }] });
      startHost();
      expect(cowork()).toMatchObject({ description: 'Decided' });
      const commits = jest.spyOn(host, 'commit');
      await expect(call()).resolves.toEqual({ workspaceId: 'c' });
      expect(commits).not.toHaveBeenCalled();
    },
  );

  posix(
    'a decided but unapplied #9 whose retry fails again is abandoned, which releases its key',
    async () => {
      const call = (): Promise<unknown> =>
        instruct(
          'core.workspace.plugins.update',
          {
            workspaceId: 'a',
            change: { kind: 'setDefaults', defaultPluginSelections: DEFAULTS },
          },
          'rx-abandon',
        );
      const originals = await decidedButUnapplied(call);
      const commitId = await wedgedCommitId('core.workspace.plugins.update');
      await expect(
        resolve([{ kind: 'retry-commit', commitId }]),
      ).resolves.toMatchObject({ results: [{ status: 'recovery-required' }] });
      await expect(
        resolve([{ kind: 'abandon-commit', commitId }]),
      ).resolves.toMatchObject({
        results: [{ status: 'abandoned' }],
        diagnosis: { commits: [], reservations: [] },
      });
      for (const [path, bytes] of originals) writeFileSync(path, bytes);
      startHost();
      await expect(call()).resolves.toMatchObject({
        workspaceId: 'a',
        written: true,
      });
      expect(manifest('a').defaultPluginSelections).toEqual(
        normalizePluginSelections(DEFAULTS),
      );
    },
  );
});

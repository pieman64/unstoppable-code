import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// The real commit-log worker and files, as the other keyed W5 boundary suites.
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
}));

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import * as coreWorkspaceAdapter from '../../canopy-runtime/core-workspace-adapter';
import { projectedWorkspaceMetadataCommands } from '../../canopy-runtime/workspace-metadata-dispatch';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { setW5PreEffectAttempts } from '../w5-pre-effect-retry';
import { W5FileWriteRefusedError } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  updateWorkspaceMetadata,
  WorkspaceMetadataRefusedError,
} from '../workspace-metadata';
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

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: dbPath(),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture(() => [], ['b']));
  dataRoot = join(dir, 'data');
  // Maintenance runs only under a private data root.
  chmodSync(dataRoot, 0o700);
  mkdirSync(join(dataRoot, 'runtime'), { mode: 0o700 });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataRoot;
  startHost();
  dispatcher = createDesktopRuntime();
  jest.clearAllMocks();
});
afterEach(async () => {
  await dispatcher.shutdown();
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
  grants: ['core.workspace.read'],
};
const AGENT: CanopyCallerDescriptor = {
  ...IPC_CALLER,
  principalId: 'agent-7',
  clientInstanceId: 'agent-client',
  grants: ['core.workspace.write'],
};

function index(): { workspaces: Array<Record<string, unknown>> } {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'index.json'), 'utf8'),
  );
  return parsed as { workspaces: Array<Record<string, unknown>> };
}
function manifest(id = 'a'): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, id, 'workspace.json'), 'utf8'),
  );
  return parsed as Record<string, unknown>;
}
/** Any operation by name, as a wire caller sends it. */
function instruct(
  operation: string,
  params: Record<string, unknown>,
  options: {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  },
): Promise<unknown> {
  const call = dispatcher.instruction.bind(dispatcher) as unknown as (
    name: string,
    params: Record<string, unknown>,
    options: {
      caller: CanopyCallerDescriptor;
      metadata: { idempotencyKey: string };
    },
  ) => Promise<unknown>;
  return call(operation, params, options);
}
function images(): string[] {
  return ['index.json', 'a/workspace.json', 'b/workspace.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}
function writeIndex(workspaces: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: workspaces.map((entry) => ({ color: '#7C3AED', ...entry })),
    }),
  );
  __resetSidebarItemsStateForTests();
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
}

const projected = (): ReturnType<typeof projectedWorkspaceMetadataCommands> =>
  projectedWorkspaceMetadataCommands({ dispatcher, caller: IPC_CALLER });

describe('registration (DM-1)', () => {
  it.each<[string, Record<string, unknown>]>([
    [
      'core.workspace.update',
      {
        workspaceId: 'a',
        patch: { pinned: true },
        _meta: { idempotencyKey: 'k' },
      },
    ],
    [
      'core.workspace.reorder',
      {
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'a',
        overWorkspaceId: 'b',
      },
    ],
    [
      'core.workspace.scripts.update',
      { workspaceId: 'a', change: { kind: 'replace' } },
    ],
    [
      'core.workspace.planDetection.update',
      { workspaceId: 'a', planDetection: {} },
    ],
    [
      'core.workspace.privateMemory.update',
      { workspaceId: 'a', privateMemory: true },
    ],
    ['core.workspace.repository.remove', { workspaceId: 'a', repoId: 'r' }],
  ])(
    'refuses %s without core.workspace.write before the handler runs',
    async (operation, params) => {
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      const reserves = jest.spyOn(host, 'reserve');
      const error = await failureOf(
        instruct(operation, params, {
          caller: IPC_CALLER,
          metadata: { idempotencyKey: 'k' },
        }),
      );
      expect(error).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(commits).not.toHaveBeenCalled();
      expect(reserves).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
    },
  );
});

describe('IPC projections', () => {
  it("a projected update commits today's unkeyed decision: no receipt or reservation for the minted key", async () => {
    const commits = jest.spyOn(host, 'commit');
    const reserves = jest.spyOn(host, 'reserve');
    const lookups = jest.spyOn(host, 'lookupReceipt');
    const instructions = jest.spyOn(dispatcher, 'instruction');
    // The IPC caller never uses #3's workspace projection, so it is not read.
    const wireResultReads = jest.spyOn(
      coreWorkspaceAdapter,
      'readDecidedCoreWorkspace',
    );
    const outcome = await projected().updateMetadata({
      workspaceId: 'a',
      patch: { name: 'Renamed', itemSortMode: 'last-updated' },
      source: 'desktop_canopy_client',
    });
    expect(wireResultReads).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      workspaceId: 'a',
      indexWritten: true,
      manifestWritten: true,
    });
    const [name, params, options] = instructions.mock.calls[0] ?? [];
    expect([name, params]).toMatchObject([
      'core.workspace.update',
      { workspaceId: 'a' },
    ]);
    expect(options?.caller.grants).toEqual(['core.workspace.write']);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      operation: 'core.workspace.update',
    });
    expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
    expect(commits.mock.calls[0]?.[0].reservationId).toBeUndefined();
    expect(reserves).not.toHaveBeenCalled();
    expect(lookups).not.toHaveBeenCalled();
    expect(index().workspaces[0]).toMatchObject({ name: 'Renamed' });
    expect(manifest()).toMatchObject({ itemSortMode: 'last-updated' });
  });

  it('a projection answers exactly what the direct call answers, refusals included', async () => {
    const direct = await failureOf(
      updateWorkspaceMetadata({
        workspaceId: 'missing',
        patch: { pinned: true },
        source: 'desktop_canopy_client',
      }),
    );
    const viaDispatcher = await failureOf(
      projected().updateMetadata({
        workspaceId: 'missing',
        patch: { pinned: true },
        source: 'desktop_canopy_client',
      }),
    );
    expect(direct).toBeInstanceOf(WorkspaceMetadataRefusedError);
    expect(viaDispatcher).toBeInstanceOf(WorkspaceMetadataRefusedError);
    expect(viaDispatcher).toMatchObject({
      reason: 'not-found',
      message: direct instanceof Error ? direct.message : '',
    });
  });

  it('a thrown host failure reaches the IPC caller unchanged and leaves no reservation', async () => {
    const failure = new Error('interrupted at decision');
    jest.spyOn(host, 'commit').mockRejectedValueOnce(failure);
    const reserves = jest.spyOn(host, 'reserve');
    const marks = jest.spyOn(host, 'markReservationRecoveryRequired');
    const error = await failureOf(
      projected().updateMetadata({
        workspaceId: 'a',
        patch: { pinned: true },
        source: 'desktop_canopy_client',
      }),
    );
    expect(error).toBe(failure);
    expect(reserves).not.toHaveBeenCalled();
    expect(marks).not.toHaveBeenCalled();
    // Unkeyed as before: the next call is a new edit.
    await expect(
      projected().updateMetadata({
        workspaceId: 'a',
        patch: { pinned: true },
        source: 'desktop_canopy_client',
      }),
    ).resolves.toMatchObject({ indexWritten: true });
  });

  it("rethrows the host request's own error even where the wire would rewrite it", async () => {
    // The dispatcher normalizes a keyed same_request retry; IPC must not see that.
    const failure = new CanopyOperationError({
      kind: 'unavailable',
      message: 'Busy.',
      retry: { kind: 'same_request' },
    });
    const error = await failureOf(
      projected().updateCoworkMetadata(
        { workspaceId: 'a', patch: { name: 'Renamed' } },
        () => Promise.reject(failure),
      ),
    );
    expect(error).toBe(failure);
  });

  it('keeps the in-process call for a request the wire cannot express', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    // Over #3's 256-character name, and a three-digit color.
    const longName = 'n'.repeat(300);
    await projected().updateMetadata({
      workspaceId: 'a',
      patch: { name: longName },
      source: 'desktop_canopy_client',
    });
    expect(index().workspaces[0]).toMatchObject({ name: longName });
    await expect(
      projected().updateMetadata({
        workspaceId: 'a',
        patch: { color: '#fff' },
        source: 'desktop_canopy_client',
      }),
    ).rejects.toMatchObject({ reason: 'invalid-patch' });
    expect(instructions).not.toHaveBeenCalled();
  });

  it('a projected update of a long-named workspace still answers as today', async () => {
    writeIndex([
      { id: 'a', name: 'n'.repeat(300), type: 'single-repo', order: 0 },
      { id: 'b', name: 'b', type: 'single-repo', order: 1 },
    ]);
    const instructions = jest.spyOn(dispatcher, 'instruction');
    await expect(
      projected().updateMetadata({
        workspaceId: 'a',
        patch: { pinned: true },
        source: 'desktop_canopy_client',
      }),
    ).resolves.toEqual({
      workspaceId: 'a',
      indexWritten: true,
      manifestWritten: false,
    });
    // Dispatched, and answered from the IPC request's own outcome.
    expect(instructions).toHaveBeenCalledTimes(1);
    expect(index().workspaces[0]).toMatchObject({ pinned: true });
  });

  it('projects the plan detection, private memory and reorder channels', async () => {
    const commands = projected();
    await commands.updatePlanDetection({
      workspaceId: 'a',
      planDetection: { disabledRuleIds: ['x'] },
      source: 'desktop',
    });
    expect(manifest()).toMatchObject({
      planDetection: { disabledRuleIds: ['x'] },
    });
    await expect(
      commands.updatePrivateMemory({
        workspaceId: 'a',
        privateMemory: true,
        source: 'workspace_settings',
      }),
    ).resolves.toEqual({ workspaceId: 'a', privateMemory: true });
    await expect(
      commands.reorder({
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
      }),
    ).resolves.toEqual({ workspaceIds: ['b', 'a'] });
    expect(index().workspaces.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

describe('wire calls', () => {
  const update = (
    patch: Record<string, unknown>,
    idempotencyKey = 'wire-key',
    caller = AGENT,
  ): Promise<unknown> =>
    dispatcher.instruction(
      'core.workspace.update',
      { workspaceId: 'a', patch, _meta: { idempotencyKey } },
      { caller, metadata: { idempotencyKey } },
    );

  it('#3 answers the decided workspace, keyed to the principal, and replays it (RR4)', async () => {
    const commits = jest.spyOn(host, 'commit');
    // An index field and a manifest field: the decided read sees both.
    const patch = {
      name: 'Wire name',
      pinned: true,
      itemSortMode: 'last-updated',
    };
    const first = await update(patch);
    expect(first).toMatchObject({
      workspaceId: 'a',
      name: 'Wire name',
      kind: 'git',
      pinned: true,
      itemSortMode: 'last-updated',
      repositorySources: [],
    });
    expect(first).not.toHaveProperty('revision');
    const saved = commits.mock.calls.find(([call]) => call.receipt)?.[0];
    expect(saved?.receipt).toMatchObject({
      caller: 'daemon:agent-7:workspace-metadata',
      operation: 'core.workspace.update',
    });
    expect(saved?.outcome).toMatchObject({
      workspaceId: 'a',
      indexWritten: true,
      workspace: first,
    });
    // A later change does not alter the replay.
    await projected().updateMetadata({
      workspaceId: 'a',
      patch: { name: 'Later' },
      source: 'desktop_canopy_client',
    });
    const count = commits.mock.calls.length;
    await expect(update(patch)).resolves.toEqual(first);
    expect(commits).toHaveBeenCalledTimes(count);
  });

  it('RR5: an unknown workspace is not_found and duplicate rows are invalid_argument, with no key reserved', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const missing = await failureOf(
      dispatcher.instruction(
        'core.workspace.update',
        {
          workspaceId: 'missing',
          patch: { pinned: true },
          _meta: { idempotencyKey: 'k1' },
        },
        { caller: AGENT, metadata: { idempotencyKey: 'k1' } },
      ),
    );
    expect(missing).toMatchObject({
      payload: { kind: 'not_found', code: 'core.workspace.notFound' },
    });
    const scripts = await failureOf(
      dispatcher.instruction(
        'core.workspace.scripts.update',
        { workspaceId: 'missing', change: { kind: 'replace' } },
        { caller: AGENT, metadata: { idempotencyKey: 'k2' } },
      ),
    );
    expect(scripts).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.configurationUnavailable',
      },
    });
    writeIndex([
      { id: 'a', name: 'A', type: 'single-repo', order: 0 },
      { id: 'a', name: 'A again', type: 'single-repo', order: 1 },
      { id: 'b', name: 'b', type: 'single-repo', order: 2 },
    ]);
    const duplicate = await failureOf(update({ pinned: true }, 'k3'));
    expect(duplicate).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'duplicate-workspace' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  it('RR5: a malformed row sharing the workspace id is a duplicate row, refused before the key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    // `notebook` is a type this version cannot read: the row is unreadable,
    // and a write would replace it with the addressed workspace's row.
    writeIndex([
      { id: 'a', name: 'A', type: 'single-repo', order: 0 },
      { id: 'a', type: 'notebook', order: 1 },
      { id: 'b', name: 'b', type: 'single-repo', order: 2 },
    ]);
    const before = images();
    expect(await failureOf(update({ pinned: true }, 'k-malformed'))).toEqual(
      expect.objectContaining({
        payload: {
          kind: 'invalid_argument',
          message:
            'More than one project is stored as a. Repair the project list and try again.',
          details: { reason: 'duplicate-workspace' },
          retry: { kind: 'never' },
        },
      }),
    );
    expect(reserves).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    // #4 admits both of its workspaces: a malformed `over` row refuses too.
    writeIndex([
      { id: 'a', name: 'A', type: 'single-repo', order: 0 },
      { id: 'b', name: 'b', type: 'single-repo', order: 1 },
      { id: 'a', type: 'notebook', order: 2 },
    ]);
    const unmoved = images();
    expect(
      await failureOf(
        dispatcher.instruction(
          'core.workspace.reorder',
          {
            visibleWorkspaceIds: ['a', 'b'],
            activeWorkspaceId: 'b',
            overWorkspaceId: 'a',
          },
          { caller: AGENT, metadata: { idempotencyKey: 'k-malformed' } },
        ),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'duplicate-workspace' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
    expect(images()).toEqual(unmoved);
    // Only the readable row is the workspace: alone, a malformed one is unknown.
    writeIndex([
      { id: 'a', type: 'notebook', order: 0 },
      { id: 'b', name: 'b', type: 'single-repo', order: 1 },
    ]);
    expect(
      await failureOf(update({ pinned: true }, 'k-unreadable')),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.workspace.notFound' },
    });
    expect(reserves).not.toHaveBeenCalled();
    // Malformed rows of other ids, or of none, do not address `a`; the key
    // the refusal left unreserved decides this call.
    writeIndex([
      { id: 'a', name: 'A', type: 'single-repo', order: 0 },
      { id: 'other', type: 'notebook', order: 1 },
      { type: 'notebook', order: 2 },
      { id: 'b', name: 'b', type: 'single-repo', order: 3 },
    ]);
    await expect(
      update({ pinned: true }, 'k-malformed'),
    ).resolves.toMatchObject({ workspaceId: 'a', pinned: true });
    expect(reserves).toHaveBeenCalledTimes(1);
  });

  it('refuses a workspace #3 cannot describe before the decision and releases the key', async () => {
    writeIndex([
      { id: 'a', name: 'n'.repeat(300), type: 'single-repo', order: 0 },
      { id: 'b', name: 'b', type: 'single-repo', order: 1 },
    ]);
    const before = images();
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await failureOf(update({ pinned: true }))).toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason: 'result-unavailable' },
        },
      });
    expect(images()).toEqual(before);
  });

  it('a stale-file rerun (CAN-5537) keeps one reservation and the principal receipt', async () => {
    const restore = setW5PreEffectAttempts(3);
    try {
      const commit = host.commit.bind(host);
      const commits = jest
        .spyOn(host, 'commit')
        .mockRejectedValueOnce(
          new W5FileWriteRefusedError(join(root, 'index.json')),
        )
        .mockImplementation((request) => commit(request));
      const reserves = jest.spyOn(host, 'reserve');
      const lookups = jest.spyOn(host, 'lookupReceipt');
      const first = await update({ pinned: true }, 'rerun');
      expect(first).toMatchObject({ workspaceId: 'a', pinned: true });
      expect(commits).toHaveBeenCalledTimes(2);
      expect(reserves).toHaveBeenCalledTimes(1);
      expect(lookups).toHaveBeenCalledTimes(1);
      expect(commits.mock.calls[1]?.[0].receipt).toMatchObject({
        caller: 'daemon:agent-7:workspace-metadata',
      });
      await expect(update({ pinned: true }, 'rerun')).resolves.toEqual(first);
      expect(commits).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it('a failed read of the decided workspace is unavailable and releases the key', async () => {
    const before = images();
    const marks = jest.spyOn(host, 'markReservationRecoveryRequired');
    jest
      .spyOn(coreWorkspaceAdapter, 'readDecidedCoreWorkspace')
      .mockRejectedValueOnce(new Error('EIO: read failed'));
    expect(await failureOf(update({ pinned: true }))).toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
    expect(marks).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    await expect(update({ pinned: true })).resolves.toMatchObject({
      workspaceId: 'a',
      pinned: true,
    });
  });

  it('#3 refuses a color outside the desktop palette (cross-host difference)', async () => {
    expect(await failureOf(update({ color: '#abcdef' }))).toMatchObject({
      payload: { kind: 'invalid_argument', message: 'Invalid project color.' },
    });
  });

  it('#4 acknowledges a move, keyed to the principal', async () => {
    const commits = jest.spyOn(host, 'commit');
    await expect(
      dispatcher.instruction(
        'core.workspace.reorder',
        {
          visibleWorkspaceIds: ['a', 'b'],
          activeWorkspaceId: 'b',
          overWorkspaceId: 'a',
        },
        { caller: AGENT, metadata: { idempotencyKey: 'move' } },
      ),
    ).resolves.toEqual({ acknowledged: true });
    expect(
      commits.mock.calls.find(([call]) => call.receipt)?.[0].receipt,
    ).toMatchObject({ caller: 'daemon:agent-7:workspace-reorder' });
    expect(index().workspaces.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('#13 is capability_unavailable until a selection service exists', async () => {
    const before = images();
    expect(
      await failureOf(
        dispatcher.instruction(
          'core.workspace.repository.add',
          {
            workspaceId: 'a',
            repository: {
              selection: { kind: 'local_picker_selection', selectionId: 's' },
            },
          },
          { caller: AGENT, metadata: { idempotencyKey: 'add' } },
        ),
      ),
    ).toMatchObject({
      payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
    });
    expect(images()).toEqual(before);
  });

  it('#14 refuses an organization-owned multi-repo workspace before any key, and answers a path-free removal otherwise', async () => {
    const config = manifest();
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        ...config,
        type: 'multi-repo',
        repos: [{ id: 'r', name: 'R', repoPath: join(dir, 'repo') }],
        owner: {
          type: 'organization',
          organizationId: '00000000-0000-4000-8000-000000000001',
          projectId: '00000000-0000-4000-8000-000000000002',
          instanceId: '00000000-0000-4000-8000-000000000003',
          bindingGeneration: 1,
        },
      }),
    );
    const reserves = jest.spyOn(host, 'reserve');
    const remove = (key: string): Promise<unknown> =>
      dispatcher.instruction(
        'core.workspace.repository.remove',
        { workspaceId: 'a', repoId: 'r' },
        { caller: AGENT, metadata: { idempotencyKey: key } },
      );
    expect(await failureOf(remove('org'))).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'organization-owned' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
    const personal = manifest();
    delete personal.owner;
    writeFileSync(join(root, 'a', 'workspace.json'), JSON.stringify(personal));
    const removed = await remove('personal');
    expect(removed).toEqual({ removed: { id: 'r', name: 'R' } });
    expect(JSON.stringify(removed)).not.toContain(dir);
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

  const posix = process.platform === 'win32' ? it.skip : it;

  posix.each<[string, Record<string, unknown>]>([
    [
      'core.workspace.update',
      {
        workspaceId: 'a',
        patch: { pinned: true },
        _meta: { idempotencyKey: 'rx' },
      },
    ],
    [
      'core.workspace.reorder',
      {
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
      },
    ],
    [
      'core.workspace.scripts.update',
      {
        workspaceId: 'a',
        change: { kind: 'merge-commands', commands: { dev: 'x' } },
      },
    ],
    [
      'core.workspace.planDetection.update',
      { workspaceId: 'a', planDetection: { disabledRuleIds: ['x'] } },
    ],
    [
      'core.workspace.privateMemory.update',
      { workspaceId: 'a', privateMemory: true },
    ],
    // A keyed removal saves its outcome even when nothing is removed.
    ['core.workspace.repository.remove', { workspaceId: 'a', repoId: 'r' }],
  ])(
    '%s: an interrupted decision is recoveryRequired, diagnosed, then resolved on its key',
    async (operation, params) => {
      const call = (): Promise<unknown> =>
        instruct(operation, params, {
          caller: AGENT,
          metadata: { idempotencyKey: 'rx' },
        });
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
        payload: {
          kind: 'failed_precondition',
          code: 'core.workspace.recoveryRequired',
        },
      });
      await host.shutdown();
      const context = maintenanceContext();
      const diagnosis = await runW5Maintenance(context, {
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
        runW5Maintenance(context, {
          source: 'offline_maintenance',
          mode: 'resolve',
          decisions: [
            {
              kind: 'resolve-reservation',
              reservationId: reservation?.reservationId ?? '',
            },
          ],
        }),
      ).resolves.toMatchObject({ results: [{ status: 'resolved' }] });
      startHost();
      // The released key decides again.
      await expect(call()).resolves.toBeDefined();
    },
  );

  const FOREIGN = '{"foreign":true}\n';

  /**
   * A wire call whose decision commits but whose files changed out of band
   * before they applied: the commit is decided but unapplied. Returns the
   * files' original bytes so a test can restore them.
   */
  async function decidedButUnapplied(
    call: () => Promise<unknown>,
  ): Promise<Map<string, string>> {
    const originals = new Map<string, string>();
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      for (const { path, previousFingerprint } of request.files) {
        // A file the change replaces; one it creates has nothing to restore.
        if (previousFingerprint === null) continue;
        originals.set(path, readFileSync(path, 'utf8'));
        writeFileSync(path, FOREIGN);
      }
      return commit(request);
    });
    expect(await failureOf(call())).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.recoveryRequired',
      },
    });
    // The key holds the decided commit, not a new decision.
    expect(await failureOf(call())).toMatchObject({
      payload: { code: 'core.workspace.recoveryRequired' },
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

  const resolve = (
    decisions: readonly W5MaintenanceDecision[],
  ): ReturnType<typeof runW5Maintenance> =>
    runW5Maintenance(maintenanceContext(), {
      source: 'offline_maintenance',
      mode: 'resolve',
      decisions,
    });

  posix(
    'a decided but unapplied #3 retries once its files are restored, then replays its first outcome',
    async () => {
      const call = (): Promise<unknown> =>
        instruct(
          'core.workspace.update',
          {
            workspaceId: 'a',
            patch: { name: 'Decided', itemSortMode: 'last-updated' },
            _meta: { idempotencyKey: 'rx-commit' },
          },
          { caller: AGENT, metadata: { idempotencyKey: 'rx-commit' } },
        );
      const originals = await decidedButUnapplied(call);
      const commitId = await wedgedCommitId('core.workspace.update');
      for (const [path, bytes] of originals) writeFileSync(path, bytes);
      await expect(
        resolve([{ kind: 'retry-commit', commitId }]),
      ).resolves.toMatchObject({ results: [{ status: 'applied' }] });
      startHost();
      expect(index().workspaces[0]).toMatchObject({ name: 'Decided' });
      expect(manifest()).toMatchObject({ itemSortMode: 'last-updated' });
      const commits = jest.spyOn(host, 'commit');
      await expect(call()).resolves.toMatchObject({
        workspaceId: 'a',
        name: 'Decided',
        itemSortMode: 'last-updated',
      });
      expect(commits).not.toHaveBeenCalled();
    },
  );

  posix(
    'a decided but unapplied #10 whose retry fails again is abandoned, which releases its key',
    async () => {
      const call = (): Promise<unknown> =>
        instruct(
          'core.workspace.privateMemory.update',
          { workspaceId: 'a', privateMemory: true },
          { caller: AGENT, metadata: { idempotencyKey: 'rx-abandon' } },
        );
      const originals = await decidedButUnapplied(call);
      const commitId = await wedgedCommitId(
        'core.workspace.privateMemory.update',
      );
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
      await expect(call()).resolves.toEqual({
        workspaceId: 'a',
        privateMemory: true,
      });
      expect(manifest()).toMatchObject({ privateMemory: true });
    },
  );
});

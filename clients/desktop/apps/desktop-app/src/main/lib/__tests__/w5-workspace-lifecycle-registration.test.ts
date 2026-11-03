// W7b-3 (CAN-5551): the lifecycle creates #1, #2 and #21 registered on the
// in-process desktop dispatcher, over the real commit-log worker, canonical
// files and Git, as the other keyed W5 boundary suites run them.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
import type * as WindowSend from '../window-send';
import type * as MainProcessLogging from '../main-process-logging';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
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
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../services/script-actions-lifecycle', () => ({
  notifyScriptActionsRepositoryAdd: jest.fn(),
}));
jest.mock('../window-send', () => ({
  ...jest.requireActual<typeof WindowSend>('../window-send'),
  sendToAllWindows: jest.fn(),
}));
jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>('../main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../org-shared-multi-repo-readiness', () => ({
  assertSharedMultiRepoWorkReady: jest.fn(() => Promise.resolve()),
}));

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { deriveCoreLifecycleOperationId } from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { projectedWorkspaceLifecycleCommands } from '../../canopy-runtime/workspace-lifecycle-dispatch';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { createWorkspace } from '../workspace-creation';
import { WorkspaceCreationRefusedError } from '../workspace-creation-refusal';
import { createWorktreeFromSelection } from '../worktree-creation';
import * as worktreeCreation from '../worktree-creation';
import { WorktreeCreationRefusedError } from '../worktree-creation-selection';
import { runW5Maintenance, type W5MaintenanceContext } from '../w5-maintenance';
import { sendToAllWindows } from '../window-send';
import { logMainProcessWarn } from '../main-process-logging';
import { assertSharedMultiRepoWorkReady } from '../org-shared-multi-repo-readiness';

jest.setTimeout(90_000);
let dir: string;
let dataRoot: string;
let root: string;
let repo: string;
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
  ({ dir, root, repo } = createW5BoundaryFixture(() => [], ['b']));
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
  await settleDetachedWork();
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
  grants: ['core.workspace.read', 'core.worktree.read'],
};
/** A wire caller the Q8 allowlist admits (agents share this principal). */
const WIRE: CanopyCallerDescriptor = {
  ...IPC_CALLER,
  clientInstanceId: 'agent-client',
  grants: ['core.workspace.write', 'core.worktree.write'],
};
const REMOTE_DEVICE: CanopyCallerDescriptor = {
  ...IPC_CALLER,
  principalId: 'remote-device:dev-1',
  clientInstanceId: 'remote-bridge:2',
};

interface IndexFile {
  workspaces: Array<Record<string, unknown>>;
}
function index(): IndexFile {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'index.json'), 'utf8'),
  );
  return parsed as IndexFile;
}
function worktrees(id = 'a'): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, id, 'worktrees.json'), 'utf8'),
  );
  return (parsed as { worktrees: Array<Record<string, unknown>> }).worktrees;
}
function images(): string[] {
  return ['index.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}

/** Any operation by name, as a wire caller sends it. */
function instruct(
  operation: string,
  params: Record<string, unknown>,
  caller: CanopyCallerDescriptor = WIRE,
  idempotencyKey = 'wire-key',
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

const projected = (
  caller: CanopyCallerDescriptor = IPC_CALLER,
): ReturnType<typeof projectedWorkspaceLifecycleCommands> =>
  projectedWorkspaceLifecycleCommands({ dispatcher, caller });

const CREATE = {
  name: 'Wire project',
  temporary: false,
  source: { kind: 'empty', workspaceKind: 'single_repo' },
};
const OPERATIONS: Array<[string, Record<string, unknown>]> = [
  ['core.workspace.create', CREATE],
  [
    'core.workspace.import',
    {
      source: { kind: 'git_url', value: 'https://github.com/acme/app.git' },
      name: 'app',
    },
  ],
  ['core.worktree.create', { workspaceId: 'a', branch: 'wire-branch' }],
];

function newGitFolder(name: string): string {
  const folder = join(dir, name);
  mkdirSync(folder);
  execFileSync('git', ['init', '-q', '-b', 'main', folder]);
  execFileSync('git', [
    '-C',
    folder,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ]);
  return folder;
}

describe('registration and callers (D-1(a), Q8)', () => {
  it.each(OPERATIONS)(
    '%s needs its write grant before the handler runs',
    async (operation, params) => {
      const before = images();
      const reserves = jest.spyOn(host, 'reserve');
      expect(
        await failureOf(instruct(operation, params, IPC_CALLER)),
      ).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(reserves).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
    },
  );

  it.each<[string, Partial<CanopyCallerDescriptor>]>([
    [
      'a renderer relay surface',
      { principalId: 'local-desktop-renderer:main' },
    ],
    [
      'a Portal session',
      { interfaceKind: 'portal', clientInstanceId: 'portal-session:s-1' },
    ],
    ['another principal', { principalId: 'agent-7' }],
  ])(
    'refuses %s holding both grants, with nothing read or written',
    async (_name, overrides) => {
      for (const [operation, params] of OPERATIONS) {
        const before = images();
        const reserves = jest.spyOn(host, 'reserve');
        const lookups = jest.spyOn(host, 'lookupReceipt');
        expect(
          await failureOf(
            instruct(operation, params, { ...WIRE, ...overrides }),
          ),
        ).toMatchObject({
          payload: { kind: 'permission_denied', retry: { kind: 'never' } },
        });
        expect(reserves).not.toHaveBeenCalled();
        expect(lookups).not.toHaveBeenCalled();
        expect(images()).toEqual(before);
      }
    },
  );
});

describe('IPC projections', () => {
  it("a projected create commits today's unkeyed decision under the IPC caller", async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const reserves = jest.spyOn(host, 'reserve');
    const lookups = jest.spyOn(host, 'lookupReceipt');
    const run = (): ReturnType<typeof createWorkspace> =>
      createWorkspace({
        source: 'new_single_repo',
        variant: { kind: 'new-single-repo', name: 'Projected' },
      });
    const outcome = await projected().createWorkspace(
      { name: 'Projected', workspaceKind: 'single_repo' },
      run,
    );
    expect(outcome.workspace).toMatchObject({
      name: 'Projected',
      type: 'single-repo',
    });
    expect(outcome.scriptActionsOperationId).toEqual(expect.any(String));
    const [name, , options] = instructions.mock.calls[0] ?? [];
    expect(name).toBe('core.workspace.create');
    expect(options?.caller).toMatchObject({
      principalId: 'local-desktop-user',
      grants: ['core.workspace.write'],
    });
    // Only the create's own lifecycle reservation: no receipt for the key.
    expect(reserves.mock.calls.map(([input]) => input.receipt)).toEqual([
      undefined,
    ]);
    expect(lookups).not.toHaveBeenCalled();
    expect(index().workspaces.map((entry) => entry.name)).toContain(
      'Projected',
    );
    // The IPC caller folds in its own answer; only wire creates broadcast.
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      expect.anything(),
    );
  });

  it('a projected remote import keeps the URL credentials off the wire', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const answer = { workspace: { id: 'cloned' } };
    await expect(
      projected().importRemote(
        {
          remoteUrl: 'https://user:s3cret-token@github.com/acme/app.git',
          name: 'app',
        },
        () => Promise.resolve(answer),
      ),
    ).resolves.toBe(answer);
    const [name, params] = instructions.mock.calls[0] ?? [];
    expect(name).toBe('core.workspace.import');
    expect(JSON.stringify(params)).not.toContain('s3cret-token');
    expect(params).toMatchObject({
      source: { kind: 'git_url', value: 'https://github.com/acme/app.git' },
    });
  });

  it('a paired controller projects through the IPC bridge (B5)', async () => {
    const outcome = await projected(REMOTE_DEVICE).createWorkspace(
      { name: 'From a controller', workspaceKind: 'multi_repo' },
      () =>
        createWorkspace({
          source: 'new_multi_repo',
          variant: { kind: 'new-multi-repo', name: 'From a controller' },
        }),
    );
    expect(outcome.workspace).toMatchObject({ type: 'multi-repo' });
  });

  it('a projected import keeps its trusted folder and answers as the direct call', async () => {
    const folder = newGitFolder('imported');
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const outcome = await projected().importFolder(folder, () =>
      createWorkspace({
        source: 'folder',
        variant: { kind: 'local-folder', folderPath: folder },
      }),
    );
    expect(outcome.workspace).toMatchObject({ type: 'single-repo' });
    const [name, params] = instructions.mock.calls[0] ?? [];
    expect(name).toBe('core.workspace.import');
    // The wire names the folder by a minted selection, never its path.
    expect(JSON.stringify(params)).not.toContain(dir);
    // A refusal reaches the IPC caller as the boundary's own error.
    const missing = join(dir, 'missing');
    const direct = await failureOf(
      createWorkspace({
        source: 'folder',
        variant: { kind: 'local-folder', folderPath: missing },
      }),
    );
    const viaDispatcher = await failureOf(
      projected().importFolder(missing, () =>
        createWorkspace({
          source: 'folder',
          variant: { kind: 'local-folder', folderPath: missing },
        }),
      ),
    );
    expect(direct).toBeInstanceOf(WorkspaceCreationRefusedError);
    expect(viaDispatcher).toBeInstanceOf(WorkspaceCreationRefusedError);
    expect(viaDispatcher).toMatchObject({
      reason: 'missing-folder',
      message: direct instanceof Error ? direct.message : '',
    });
  });

  it('a projected worktree create runs its host request unkeyed, with core.worktree.write', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const reserves = jest.spyOn(host, 'reserve');
    const outcome = await projected().createWorktree(
      { workspaceId: 'a', branchName: 'projected' },
      () =>
        createWorktreeFromSelection({
          workspaceId: 'a',
          workspaceKind: 'single-repo',
          branch: { kind: 'new', branchName: 'projected' },
          base: { kind: 'repository-default' },
          allowBaseBranchNetwork: false,
          seedPanelLayoutMode: false,
        }),
    );
    expect(outcome).toMatchObject({
      status: 'created',
      response: { branchName: 'projected' },
    });
    expect(instructions.mock.calls[0]?.[2]?.caller.grants).toEqual([
      'core.worktree.write',
    ]);
    expect(reserves).not.toHaveBeenCalled();
    expect(worktrees().map((row) => row.branchName)).toContain('projected');
  });

  it('keeps the in-process call for a request the wire cannot express', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    await expect(
      projected().createWorkspace(
        { name: '', workspaceKind: 'single_repo' },
        () =>
          createWorkspace({
            source: 'new_single_repo',
            variant: { kind: 'new-single-repo', name: '' },
          }),
      ),
    ).rejects.toMatchObject({ reason: 'name-required' });
    expect(instructions).not.toHaveBeenCalled();
  });
});

describe('wire calls', () => {
  it('#1 creates a personal project under a principal receipt and replays it (B7, D-2)', async () => {
    const commits = jest.spyOn(host, 'commit');
    const first = await instruct('core.workspace.create', CREATE);
    const anyId: unknown = expect.any(String);
    expect(first).toEqual({
      workspace: {
        workspaceId: anyId,
        name: 'Wire project',
        kind: 'single_repo',
        temporary: false,
        repositories: [],
      },
      operation: null,
    });
    const { workspaceId } = (first as { workspace: { workspaceId: string } })
      .workspace;
    expect(
      commits.mock.calls.find(([request]) => request.receipt)?.[0].receipt,
    ).toMatchObject({
      caller: 'daemon:local-desktop-user:workspace-create',
      operation: 'core.workspace.create',
    });
    // No owner crosses the wire: the host records none, so it is personal.
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, workspaceId, 'workspace.json'), 'utf8'),
    );
    expect(manifest).not.toHaveProperty('owner');
    expect(JSON.stringify(first)).not.toContain(dir);
    // Main's own write wakes no watcher: the renderer is told to reload.
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId },
    );
    const count = commits.mock.calls.length;
    await expect(instruct('core.workspace.create', CREATE)).resolves.toEqual(
      first,
    );
    expect(commits).toHaveBeenCalledTimes(count);
    expect(
      index().workspaces.filter((entry) => entry.name === 'Wire project'),
    ).toHaveLength(1);
  });

  it('#1 refuses a forms the desktop cannot serve before any key, and a reused key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    const before = images();
    expect(
      await failureOf(
        instruct('core.workspace.create', {
          ...CREATE,
          source: { kind: 'empty', workspaceKind: 'cowork' },
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'unserved' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    await instruct('core.workspace.create', CREATE, WIRE, 'reused');
    expect(
      await failureOf(
        instruct(
          'core.workspace.create',
          { ...CREATE, name: 'Other' },
          WIRE,
          'reused',
        ),
      ),
    ).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.workspace.idempotencyKeyReused',
        details: { reason: 'key-reused' },
        retry: { kind: 'never' },
      },
    });
  });

  it('#2 is capability_unavailable on the wire, with no key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    for (const source of [
      { kind: 'local_picker_selection', selectionId: 'sel' },
      { kind: 'git_url', value: 'https://github.com/acme/app.git' },
    ])
      expect(
        await failureOf(
          instruct('core.workspace.import', { source, name: 'app' }),
        ),
      ).toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(reserves).not.toHaveBeenCalled();
  });

  it.each(['branch-not-found', 'base-not-found'] as const)(
    '#21 preserves the existing uncoded %s refusal',
    async (reason) => {
      jest
        .spyOn(worktreeCreation, 'createWorktreeFromSelection')
        .mockRejectedValue(
          new WorktreeCreationRefusedError(reason, 'Not found.'),
        );
      const before = images();
      const error = await failureOf(
        instruct('core.worktree.create', { workspaceId: 'a', branch: 'new' }),
      );
      expect(error).toMatchObject({
        payload: {
          kind: 'not_found',
          details: { reason },
          retry: { kind: 'never' },
        },
      });
      if (!(error instanceof CanopyOperationError))
        throw new Error('Untyped refusal');
      expect(error.payload).not.toHaveProperty('code');
      expect(images()).toEqual(before);
    },
  );

  it('#21 creates a ready worktree and answers a derived operation reference (DP-3)', async () => {
    const commits = jest.spyOn(host, 'commit');
    const first = await instruct('core.worktree.create', {
      workspaceId: 'a',
      branch: 'wire-branch',
      baseHeadSha: null,
      targetId: null,
    });
    const row = worktrees().find((entry) => entry.branchName === 'wire-branch');
    expect(first).toEqual({
      operationId: deriveCoreLifecycleOperationId(
        'local-desktop-user',
        'core.worktree.create',
        'wire-key',
      ),
      kind: 'core.worktree.create',
      status: 'completed',
      workspaceId: 'a',
      worktreeId: row?.id,
      branchName: 'wire-branch',
      setupPhase: 'git-ready',
    });
    expect(
      commits.mock.calls.find(([request]) => request.receipt)?.[0].receipt,
    ).toMatchObject({
      caller: 'daemon:local-desktop-user:worktree-create',
      operation: 'core.worktree.create',
    });
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'a' },
    );
    const count = commits.mock.calls.length;
    await expect(
      instruct('core.worktree.create', {
        workspaceId: 'a',
        branch: 'wire-branch',
      }),
    ).resolves.toEqual(first);
    expect(commits).toHaveBeenCalledTimes(count);
  });

  it('a renderer refresh that throws never fails a committed #1 or #21 create', async () => {
    const sendFailure = new Error('Object has been destroyed');
    jest.mocked(sendToAllWindows).mockImplementation((channel) => {
      if (channel === IPC_CHANNELS.workspaceWorktreesUpdated) throw sendFailure;
    });
    const commits = jest.spyOn(host, 'commit');
    try {
      const workspace = await instruct('core.workspace.create', CREATE);
      expect(workspace).toMatchObject({
        workspace: { name: 'Wire project', kind: 'single_repo' },
      });
      const worktree = await instruct(
        'core.worktree.create',
        { workspaceId: 'a', branch: 'refresh-throws' },
        WIRE,
        'worktree-key',
      );
      expect(worktree).toMatchObject({
        kind: 'core.worktree.create',
        status: 'completed',
        workspaceId: 'a',
        branchName: 'refresh-throws',
      });
      expect(sendToAllWindows).toHaveBeenCalledTimes(2);
      expect(logMainProcessWarn).toHaveBeenCalledTimes(2);
      expect(logMainProcessWarn).toHaveBeenCalledWith(
        'Workspace lifecycle renderer refresh failed',
        sendFailure,
      );
      // A retry replays each key's committed answer and creates nothing more.
      const count = commits.mock.calls.length;
      await expect(instruct('core.workspace.create', CREATE)).resolves.toEqual(
        workspace,
      );
      await expect(
        instruct(
          'core.worktree.create',
          { workspaceId: 'a', branch: 'refresh-throws' },
          WIRE,
          'worktree-key',
        ),
      ).resolves.toEqual(worktree);
      expect(commits).toHaveBeenCalledTimes(count);
      expect(
        index().workspaces.filter((entry) => entry.name === 'Wire project'),
      ).toHaveLength(1);
      expect(
        worktrees().filter((entry) => entry.branchName === 'refresh-throws'),
      ).toHaveLength(1);
    } finally {
      jest.mocked(sendToAllWindows).mockReset();
    }
  });

  it('#21 refuses unknown, Cowork and unservable requests before any key', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct('core.worktree.create', { workspaceId: 'missing' }),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.worktree.notFound' },
    });
    const indexFile = index();
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        ...indexFile,
        workspaces: indexFile.workspaces.map((entry) =>
          entry.id === 'b' ? { ...entry, type: 'cowork' } : entry,
        ),
      }),
    );
    __resetSidebarItemsStateForTests();
    expect(
      await failureOf(instruct('core.worktree.create', { workspaceId: 'b' })),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.invalidState',
        details: { reason: 'cowork-project' },
      },
    });
    expect(
      await failureOf(
        instruct('core.worktree.create', {
          workspaceId: 'a',
          baseHeadSha: 'abc1234',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { fields: ['baseHeadSha'] },
      },
    });
    // A selection the kind refuses is the boundary's own refusal, keyless.
    expect(
      await failureOf(
        instruct('core.worktree.create', {
          workspaceId: 'a',
          includedRepositoryIds: ['api'],
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'invalid-repository-selection' },
      },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  it('#21 refuses a shared project that is not ready as a typed precondition, with no key', async () => {
    const indexFile = index();
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        ...indexFile,
        workspaces: indexFile.workspaces.map((entry) =>
          entry.id === 'a' ? { ...entry, type: 'multi-repo' } : entry,
        ),
      }),
    );
    __resetSidebarItemsStateForTests();
    jest
      .mocked(assertSharedMultiRepoWorkReady)
      .mockRejectedValueOnce(
        new Error('Shared project setup has not finished'),
      );
    const reserves = jest.spyOn(host, 'reserve');
    const lookups = jest.spyOn(host, 'lookupReceipt');
    const before = images();
    expect(
      await failureOf(
        instruct('core.worktree.create', { workspaceId: 'a', branch: 'org' }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.invalidState',
        details: { reason: 'shared-project-not-ready' },
        retry: { kind: 'after_refresh', resource: 'core.worktree.list' },
      },
    });
    expect(assertSharedMultiRepoWorkReady).toHaveBeenCalledWith('a');
    expect(reserves).not.toHaveBeenCalled();
    expect(lookups).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  it('#21 answers a project root that needs repair as a failed reference, never repairing it', async () => {
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: repo,
        repos: [],
      }),
    );
    const indexFile = index();
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        ...indexFile,
        workspaces: indexFile.workspaces.map((entry) =>
          entry.id === 'a' ? { ...entry, type: 'multi-repo' } : entry,
        ),
      }),
    );
    __resetSidebarItemsStateForTests();
    const result = await instruct('core.worktree.create', {
      workspaceId: 'a',
      branch: 'repair',
      includedRepositoryIds: [],
    });
    expect(result).toMatchObject({
      kind: 'core.worktree.create',
      status: 'failed',
      workspaceId: 'a',
      branchName: 'repair',
      setupPhase: 'git-pending',
    });
    expect(existsSync(join(repo, 'canopy.json'))).toBe(false);
  });
});

describe('recovery classes (§8, A24-L)', () => {
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

  posix.each<[string, Record<string, unknown>, string]>([
    ['core.workspace.create', CREATE, 'core.workspace.recoveryRequired'],
    [
      'core.worktree.create',
      { workspaceId: 'a', branch: 'interrupted' },
      'core.worktree.recoveryRequired',
    ],
  ])(
    '%s: an interrupted create is terminal: diagnosed, and its key never released',
    async (operation, params, code) => {
      const call = (): Promise<unknown> =>
        instruct(operation, params, WIRE, 'rx');
      jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
        await host.shutdown();
        throw new Error('interrupted at decision');
      });
      expect(await failureOf(call())).toMatchObject({
        payload: { kind: 'internal' },
      });
      await host.shutdown();
      startHost();
      const refused = await failureOf(call());
      expect(refused).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code,
          details: { reason: 'recovery-required' },
          retry: { kind: 'never' },
        },
      });
      await host.shutdown();
      const context = maintenanceContext();
      const diagnosis = await runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'diagnose',
      });
      if (diagnosis.mode !== 'diagnose') throw new Error('Expected diagnosis');
      const reservation = diagnosis.diagnosis.reservations.find(
        (entry) => entry.operation === operation,
      );
      expect(reservation).toMatchObject({ state: 'recovery-required' });
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
      ).rejects.toMatchObject({ reason: 'operation-excluded' });
      for (const { commitId } of diagnosis.diagnosis.commits)
        await expect(
          runW5Maintenance(context, {
            source: 'offline_maintenance',
            mode: 'resolve',
            decisions: [{ kind: 'abandon-commit', commitId }],
          }),
        ).rejects.toMatchObject({ reason: 'operation-excluded' });
      startHost();
      // Still terminal: the same key keeps refusing.
      expect(await failureOf(call())).toMatchObject({
        payload: { details: { reason: 'recovery-required' } },
      });
    },
  );

  posix(
    'a decided but unapplied #1 keeps its key on the reservation: no exit releases it',
    async () => {
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
        for (const { path, previousFingerprint } of request.files)
          if (previousFingerprint !== null) writeFileSync(path, '{"x":1}\n');
        return commit(request);
      });
      const call = (): Promise<unknown> =>
        instruct('core.workspace.create', CREATE, WIRE, 'rx-commit');
      expect(await failureOf(call())).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          details: { reason: 'recovery-required' },
        },
      });
      await host.shutdown();
      const context = maintenanceContext();
      const diagnosis = await runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'diagnose',
      });
      if (diagnosis.mode !== 'diagnose') throw new Error('Expected diagnosis');
      // The canonical commit carries no receipt; the reservation holds the key.
      const [wedged] = diagnosis.diagnosis.commits;
      expect(wedged).toMatchObject({
        operation: 'core.workspace.create',
        state: 'recovery-required',
        receiptOperations: [],
      });
      const [reservation] = diagnosis.diagnosis.reservations;
      expect(reservation).toMatchObject({
        operation: 'core.workspace.create',
        state: 'recovery-required',
      });
      // All or nothing: the reservation's release refuses the whole batch.
      await expect(
        runW5Maintenance(context, {
          source: 'offline_maintenance',
          mode: 'resolve',
          decisions: [
            { kind: 'abandon-commit', commitId: wedged?.commitId ?? 0 },
            {
              kind: 'resolve-reservation',
              reservationId: reservation?.reservationId ?? '',
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 1 });
      startHost();
      expect(await failureOf(call())).toMatchObject({
        payload: { details: { reason: 'recovery-required' } },
      });
    },
  );
});

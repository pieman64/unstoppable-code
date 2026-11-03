// W7b-1b (CAN-5549): the guarded W5 commands #7, #11, #22, #23 and #26 on
// the desktop dispatcher, with the real commit-log worker and files.
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

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { HookInputMap } from '@canopy/desktop-shared/hooks';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { projectedWorkspaceGuardedCommands } from '../../canopy-runtime/workspace-guarded-dispatch';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { updateWorktree, WorktreeUpdateRefusedError } from '../worktree-update';
import { updateWorkspaceWorktrees } from '../workspace-persistence';
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

let createdAt: string;
const ROWS = (at: string): WorktreeData[] => [
  { id: 'one', branchName: 'feature-one', createdAt: at },
  { id: 'two', branchName: 'feature-two', createdAt: at, hidden: true },
  { id: 'three', branchName: 'feature-three', createdAt: at },
];

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture(
    (at) => {
      createdAt = at;
      return ROWS(at);
    },
    ['b'],
  ));
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
  grants: ['core.workspace.read', 'core.worktree.read'],
};
const AGENT: CanopyCallerDescriptor = {
  ...IPC_CALLER,
  principalId: 'agent-7',
  clientInstanceId: 'agent-client',
  grants: ['core.workspace.write', 'core.worktree.write'],
};

function json(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(root, file), 'utf8'));
  return parsed as Record<string, unknown>;
}
function rows(workspaceId = 'a'): WorktreeData[] {
  return json(`${workspaceId}/worktrees.json`).worktrees as WorktreeData[];
}
function row(id: string): WorktreeData | undefined {
  return rows().find((entry) => entry.id === id);
}
function images(): string[] {
  return [
    'index.json',
    'a/workspace.json',
    'a/worktrees.json',
    'b/workspace.json',
    'b/worktrees.json',
  ].map((file) => readFileSync(join(root, file), 'utf8'));
}
/** An edit outside the commit log, as the CLI makes one. */
function writeRows(workspaceId: string, worktrees: WorktreeData[]): void {
  writeFileSync(
    join(root, workspaceId, 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees }),
  );
  __resetSidebarItemsStateForTests();
}

/**
 * Replaces a list through the commit log. `fresh` first drops the fixture's
 * unlogged file, so a logged decision creates it and its rows' revisions are
 * verifiable (DP-1); the rows then start at revision 1.
 */
async function commitRows(
  workspaceId: string,
  worktrees: readonly WorktreeData[],
  fresh = false,
): Promise<void> {
  if (fresh) rmSync(join(root, workspaceId, 'worktrees.json'));
  __resetSidebarItemsStateForTests();
  await updateWorkspaceWorktrees(workspaceId, () =>
    worktrees.map((entry) => ({ ...entry })),
  );
  __resetSidebarItemsStateForTests();
}

/** The row's `core.worktree.get` read, as a wire client sees it. */
function readWorktree(
  worktreeId: string,
  workspaceId = 'a',
): Promise<{ revision?: number }> {
  return dispatcher.query(
    'core.worktree.get',
    { worktreeId, scope: { workspaceId } },
    { caller: IPC_CALLER },
  );
}

/** The revision a DP-1 client sends: the read's, or `0` when it has none. */
async function readRevision(
  worktreeId = 'one',
  workspaceId = 'a',
): Promise<number> {
  return (await readWorktree(worktreeId, workspaceId)).revision ?? 0;
}

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

const HOOKS: HookInputMap = {
  'worktree:created': [{ type: 'command', command: 'pnpm install' }],
};

const WIRE: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  [
    'core.workspace.hooks.update',
    { workspaceId: 'a', change: { kind: 'replace', hooks: HOOKS } },
    'core.workspace.write',
  ],
  [
    'core.workspace.retention.update',
    { workspaceId: 'a', patch: { archiveRetentionDays: 7 } },
    'core.workspace.write',
  ],
  [
    'core.worktree.update',
    {
      scope: { workspaceId: 'a' },
      worktreeId: 'one',
      // The row's revision once `commitRows` created the list.
      expectedRevision: 1,
      patch: { pinned: true },
    },
    'core.worktree.write',
  ],
  [
    'core.worktree.reorder',
    { workspaceId: 'a', activeWorktreeId: 'three', overWorktreeId: 'one' },
    'core.worktree.write',
  ],
  [
    'core.worktree.hooks.setPaused',
    {
      workspaceId: 'a',
      worktreeId: 'one',
      change: { kind: 'pause', hookKeys: ['project:manual'] },
    },
    'core.worktree.write',
  ],
];

describe('registration (D-1(a))', () => {
  it.each(WIRE)(
    'refuses %s without its write grant before the handler runs',
    async (operation, params, grant) => {
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      const reserves = jest.spyOn(host, 'reserve');
      // The IPC caller's read grants, and the other domain's write grant.
      const other =
        grant === 'core.workspace.write'
          ? 'core.worktree.write'
          : 'core.workspace.write';
      for (const caller of [
        IPC_CALLER,
        {
          ...AGENT,
          grants: [other],
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
  it("a projected worktree update commits today's unkeyed decision under the per-call grant", async () => {
    const commits = jest.spyOn(host, 'commit');
    const reserves = jest.spyOn(host, 'reserve');
    const lookups = jest.spyOn(host, 'lookupReceipt');
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const outcome = await projected().updateWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      patch: { pinned: true, label: ' Mine ' },
    });
    // The host request's full row, host fields included.
    expect(outcome).toMatchObject({
      worktree: {
        id: 'one',
        branchName: 'feature-one',
        createdAt,
        pinned: true,
        label: 'Mine',
      },
      changed: true,
    });
    const [name, params, options] = instructions.mock.calls[0] ?? [];
    expect(name).toBe('core.worktree.update');
    expect(params).toMatchObject({
      scope: { workspaceId: 'a' },
      worktreeId: 'one',
      patch: { pinned: true, label: ' Mine ' },
    });
    expect(options?.caller.grants).toEqual(['core.worktree.write']);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      operation: 'core.worktree.update',
    });
    expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
    expect(commits.mock.calls[0]?.[0].reservationId).toBeUndefined();
    expect(reserves).not.toHaveBeenCalled();
    expect(lookups).not.toHaveBeenCalled();
    expect(row('one')).toMatchObject({ pinned: true, label: 'Mine' });
  });

  it('a projection answers exactly what the direct call answers, refusals included', async () => {
    const request = {
      workspaceId: 'a',
      worktreeId: 'missing',
      patch: { pinned: true },
    };
    const direct = await failureOf(updateWorktree(request));
    const viaDispatcher = await failureOf(projected().updateWorktree(request));
    expect(direct).toBeInstanceOf(WorktreeUpdateRefusedError);
    expect(viaDispatcher).toBeInstanceOf(WorktreeUpdateRefusedError);
    expect(viaDispatcher).toMatchObject({
      reason: 'not-found',
      message: direct instanceof Error ? direct.message : '',
    });
  });

  it('a thrown host failure reaches the IPC caller unchanged and leaves no reservation', async () => {
    const failure = new Error('interrupted at decision');
    jest.spyOn(host, 'commit').mockRejectedValueOnce(failure);
    const reserves = jest.spyOn(host, 'reserve');
    const error = await failureOf(
      projected().setWorktreeHooksPaused({
        workspaceId: 'a',
        worktreeId: 'one',
        change: { kind: 'replace', pausedHookKeys: ['project:manual'] },
        source: 'desktop',
      }),
    );
    expect(error).toBe(failure);
    expect(reserves).not.toHaveBeenCalled();
    await expect(
      projected().setWorktreeHooksPaused({
        workspaceId: 'a',
        worktreeId: 'one',
        change: { kind: 'replace', pausedHookKeys: ['project:manual'] },
        source: 'desktop',
      }),
    ).resolves.toMatchObject({ changed: true });
  });

  it('projects the hooks, retention, move and paused-hook channels with their grants', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    const commands = projected();
    await commands.updateHooks({
      workspaceId: 'a',
      change: { kind: 'replace', hooks: HOOKS },
      source: 'desktop',
    });
    expect(json('a/workspace.json').hooks).toEqual(HOOKS);
    await expect(
      commands.updateRetention({
        workspaceId: 'a',
        patch: { archiveRetentionDays: 7 },
        source: 'workspace_settings',
      }),
    ).resolves.toMatchObject({ workspaceId: 'a' });
    expect(json('a/workspace.json')).toMatchObject({
      archiveRetentionDays: 7,
    });
    await commands.moveWorktree({
      workspaceId: 'a',
      activeWorktreeId: 'three',
      overWorktreeId: 'one',
    });
    expect(rows().map((entry) => entry.id)).toEqual(['three', 'two', 'one']);
    const paused = await commands.setWorktreeHooksPaused({
      workspaceId: 'a',
      worktreeId: 'one',
      change: { kind: 'replace', pausedHookKeys: ['project:manual'] },
      source: 'desktop',
    });
    expect(paused).toMatchObject({
      pausedHookKeys: ['project:manual'],
      changed: true,
    });
    expect(
      instructions.mock.calls.map(([name, , options]) => [
        name,
        options.caller.grants,
      ]),
    ).toEqual([
      ['core.workspace.hooks.update', ['core.workspace.write']],
      ['core.workspace.retention.update', ['core.workspace.write']],
      ['core.worktree.reorder', ['core.worktree.write']],
      ['core.worktree.hooks.setPaused', ['core.worktree.write']],
    ]);
  });

  it('the host-only order and incarnation ride the host request only', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    await projected().updateWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      expectedCreatedAt: createdAt,
      patch: { branchGroupingOverride: 'group' },
      worktreeOrder: ['three', 'two', 'one'],
    });
    expect(instructions).toHaveBeenCalledTimes(1);
    const params = instructions.mock.calls[0]?.[1];
    expect(params).not.toHaveProperty('worktreeOrder');
    expect(params).not.toHaveProperty('expectedCreatedAt');
    expect(rows().map((entry) => entry.id)).toEqual(['three', 'two', 'one']);
    expect(row('one')).toMatchObject({ branchGroupingOverride: 'group' });
  });

  it('keeps the in-process call for a request the wire cannot express, or a keyed one', async () => {
    const instructions = jest.spyOn(dispatcher, 'instruction');
    // Over the page's 256-character label.
    const label = 'n'.repeat(300);
    await projected().updateWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      patch: { label },
    });
    expect(row('one')).toMatchObject({ label });
    await projected().moveWorktree({
      workspaceId: 'a',
      activeWorktreeId: 'three',
      overWorktreeId: 'one',
      idempotencyKey: 'host-key',
    });
    expect(instructions).not.toHaveBeenCalled();
  });
});

describe('wire calls', () => {
  beforeEach(() => commitRows('a', ROWS(createdAt), true));

  /** #22 with the revision the row's read publishes, unless `params` sets one. */
  const update = async (
    params: Record<string, unknown>,
    idempotencyKey = 'wire-key',
  ): Promise<unknown> =>
    instruct(
      'core.worktree.update',
      {
        worktreeId: 'one',
        ...('expectedRevision' in params
          ? {}
          : { expectedRevision: await readRevision() }),
        ...params,
      },
      idempotencyKey,
    );

  it('#22 refuses a stale revision once the list changed outside the commit log, writing nothing (DP-1)', async () => {
    const revision = await readRevision();
    expect(revision).toBe(1);
    // Same counter, other bytes: the CLI relabels the row.
    writeRows(
      'a',
      ROWS(createdAt).map((entry) =>
        entry.id === 'one' ? { ...entry, label: 'Outside' } : entry,
      ),
    );
    expect(await readWorktree('one')).not.toHaveProperty('revision');
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    const reserves = jest.spyOn(host, 'reserve');
    for (const [scope, expectedRevision, key] of [
      [{ workspaceId: 'a' }, revision, 'k-stale'],
      [undefined, revision, 'k-stale-unscoped'],
      // `0` is for a row with no committed revision, not an unverified one.
      [{ workspaceId: 'a' }, 0, 'k-zero'],
    ] as const) {
      const refusal = await failureOf(
        update(
          {
            ...(scope && { scope }),
            expectedRevision,
            patch: { pinned: true },
          },
          key,
        ),
      );
      expect(refusal).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.worktree.invalidState',
          details: { reason: 'revision-unverified' },
          retry: { kind: 'never' },
        },
      });
      // The stored revision never crosses the wire.
      expect(
        (refusal as { payload: { details: unknown } }).payload.details,
      ).toEqual({ reason: 'revision-unverified' });
    }
    expect(reserves).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    expect(row('one')).toMatchObject({ label: 'Outside' });
    expect(row('one')).not.toHaveProperty('pinned');
  });

  it('#22 refuses a list changed outside the commit log after its revision was verified, releasing the key (DP-1)', async () => {
    const revision = await readRevision();
    const reserve = host.reserve.bind(host);
    // Between the provenance check and the decision's own read.
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
      writeRows(
        'a',
        ROWS(createdAt).map((entry) =>
          entry.id === 'one' ? { ...entry, label: 'Outside' } : entry,
        ),
      );
      return reserve(input);
    });
    const commits = jest.spyOn(host, 'commit');
    const call = (): Promise<unknown> =>
      update(
        {
          scope: { workspaceId: 'a' },
          expectedRevision: revision,
          patch: { label: 'Wire' },
        },
        'k-race',
      );
    expect(await failureOf(call())).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.worktree.revisionConflict',
        details: { reason: 'concurrent-write' },
        retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
      },
    });
    expect(commits).not.toHaveBeenCalled();
    expect(row('one')).toMatchObject({ label: 'Outside' });
    // The key was released: its retry is a new attempt, which DP-1 refuses.
    expect(await failureOf(call())).toMatchObject({
      payload: { details: { reason: 'revision-unverified' } },
    });
    expect(row('one')).toMatchObject({ label: 'Outside' });
  });

  it('#22 meets a logged write between its check and its decision as a refreshable concurrent write', async () => {
    const revision = await readRevision();
    const reserve = host.reserve.bind(host);
    // A logged write to another row: the list moves, row one's revision does not.
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
      await commitRows(
        'a',
        ROWS(createdAt).map((entry) =>
          entry.id === 'three' ? { ...entry, label: 'Logged' } : entry,
        ),
      );
      return reserve(input);
    });
    const call = (): Promise<unknown> =>
      update(
        {
          scope: { workspaceId: 'a' },
          expectedRevision: revision,
          patch: { label: 'Wire' },
        },
        'k-logged',
      );
    expect(await failureOf(call())).toMatchObject({
      payload: {
        kind: 'conflict',
        details: { reason: 'concurrent-write' },
        retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
      },
    });
    expect(row('one')).not.toHaveProperty('label');
    // The list is still verified, so the released key's retry applies.
    expect(await readRevision()).toBe(revision);
    await expect(call()).resolves.toMatchObject({ worktreeId: 'one' });
    expect(row('one')).toMatchObject({ label: 'Wire' });
    expect(rows().find((entry) => entry.id === 'three')).toMatchObject({
      label: 'Logged',
    });
  });

  it('#22 replays a saved outcome after the list changed outside the commit log', async () => {
    const first = await update({
      scope: { workspaceId: 'a' },
      patch: { pinned: true },
    });
    writeRows('a', ROWS(createdAt));
    const commits = jest.spyOn(host, 'commit');
    await expect(
      update({
        scope: { workspaceId: 'a' },
        expectedRevision: 2,
        patch: { pinned: true },
      }),
    ).resolves.toEqual(first);
    expect(commits).not.toHaveBeenCalled();
  });

  it('#22 answers the row as the read projects it, keyed to the principal, and replays it (RR4)', async () => {
    const commits = jest.spyOn(host, 'commit');
    const first = await update({
      scope: { workspaceId: 'a' },
      patch: { label: 'Mine', trackedBaseBranch: 'main' },
    });
    expect(first).toEqual({
      worktreeId: 'one',
      workspaceId: 'a',
      name: 'Mine',
      state: 'ready',
      baseBranch: 'main',
      branch: 'feature-one',
      createdAt,
    });
    expect(receiptCaller(commits)).toBe('daemon:agent-7:worktree-metadata');
    // A later change does not alter the replay.
    await projected().updateWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      patch: { label: 'Later' },
    });
    const count = commits.mock.calls.length;
    await expect(
      update({
        scope: { workspaceId: 'a' },
        patch: { label: 'Mine', trackedBaseBranch: 'main' },
      }),
    ).resolves.toEqual(first);
    expect(commits).toHaveBeenCalledTimes(count);
  });

  it('#22 resolves an unscoped id as the read does, and refuses an ambiguous or unknown one before any key', async () => {
    await expect(update({ patch: { pinned: true } })).resolves.toMatchObject({
      worktreeId: 'one',
      workspaceId: 'a',
    });
    expect(row('one')).toMatchObject({ pinned: true });
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct(
          'core.worktree.update',
          {
            worktreeId: 'missing',
            expectedRevision: 0,
            patch: { pinned: true },
          },
          'k-missing',
        ),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.worktree.notFound' },
    });
    await commitRows(
      'b',
      [{ id: 'one', branchName: 'other', createdAt }],
      true,
    );
    expect(
      await failureOf(update({ patch: { pinned: false } }, 'k-ambiguous')),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'Workspace scope required for ambiguous worktree ID.',
      },
    });
    expect(reserves).not.toHaveBeenCalled();
    // A scope settles it.
    await expect(
      update(
        {
          scope: { workspaceId: 'b' },
          expectedRevision: await readRevision('one', 'b'),
          patch: { pinned: true },
        },
        'k-b',
      ),
    ).resolves.toMatchObject({ workspaceId: 'b', branch: 'other' });
  });

  it('#22 refuses a routed targetId, an unselectable scope and a scoped unknown workspace before any key', async () => {
    const before = images();
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        update({ scope: { workspaceId: 'a' }, patch: { targetId: 'remote' } }),
      ),
    ).toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(
      await failureOf(
        update({ scope: { workspaceId: 'a' }, patch: { targetId: null } }),
      ),
    ).toMatchObject({
      payload: { kind: 'invalid_argument', message: 'Patch is empty.' },
    });
    expect(
      await failureOf(
        update({
          scope: { workspaceId: 'a', targetId: 'remote' },
          patch: { pinned: true },
        }),
      ),
    ).toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(
      await failureOf(
        update({ scope: { workspaceId: 'missing' }, patch: { pinned: true } }),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.worktree.notFound' },
    });
    expect(reserves).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    // A null targetId beside a field is dropped.
    await expect(
      update({
        scope: { workspaceId: 'a' },
        patch: { pinned: true, targetId: null },
      }),
    ).resolves.toMatchObject({ worktreeId: 'one' });
  });

  it('#22 checks its required row revision and releases the key on drift', async () => {
    const before = images();
    expect(
      await failureOf(
        update({
          scope: { workspaceId: 'a' },
          expectedRevision: 5,
          patch: { pinned: true },
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.worktree.revisionConflict',
        retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
      },
    });
    expect(images()).toEqual(before);
    await expect(
      update({ scope: { workspaceId: 'a' }, patch: { pinned: true } }),
    ).resolves.toMatchObject({ worktreeId: 'one' });
  });

  it('#22 refuses a row its result cannot carry before the decision, releasing the key', async () => {
    await commitRows('a', [
      { id: 'one', branchName: 'b'.repeat(600), createdAt },
    ]);
    const before = images();
    const marks = jest.spyOn(host, 'markReservationRecoveryRequired');
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await failureOf(
          update({
            scope: { workspaceId: 'a' },
            // The read cannot answer this row either; the replace made it 2.
            expectedRevision: 2,
            patch: { pinned: true },
          }),
        ),
      ).toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason: 'result-unavailable' },
        },
      });
    expect(marks).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  it('#22 answers a branch-derived name over 256 characters (can5549-name-bound)', async () => {
    const branchName = 'b'.repeat(300);
    await commitRows('a', [{ id: 'one', branchName, createdAt }]);
    await expect(
      update({ scope: { workspaceId: 'a' }, patch: { pinned: true } }),
    ).resolves.toMatchObject({ name: branchName, branch: branchName });
    expect(row('one')).toMatchObject({ pinned: true });
  });

  it('#22 checks the selected organization and authority before any key, and replays one key across scope spellings', async () => {
    const reserves = jest.spyOn(host, 'reserve');
    for (const scope of [
      { workspaceId: 'a', organizationId: 'org-other' },
      { organizationId: 'org-other' },
      { workspaceId: 'a', worktreeId: 'two' },
    ])
      expect(
        await failureOf(update({ scope, patch: { pinned: true } }, 'k-scope')),
      ).toMatchObject({
        payload: { kind: 'not_found', code: 'core.worktree.notFound' },
      });
    expect(reserves).not.toHaveBeenCalled();
    const first = await update(
      {
        scope: { workspaceId: 'a', authorityId: 'local-desktop' },
        patch: { pinned: true },
      },
      'k-same',
    );
    expect(first).toMatchObject({ worktreeId: 'one', workspaceId: 'a' });
    const commits = jest.spyOn(host, 'commit');
    for (const scope of [
      undefined,
      { workspaceId: 'a' },
      { workspaceId: 'a', worktreeId: 'one' },
    ])
      await expect(
        update({ ...(scope && { scope }), patch: { pinned: true } }, 'k-same'),
      ).resolves.toEqual(first);
    expect(commits).not.toHaveBeenCalled();
  });

  it('#7 binds the hooks, keyed to the principal, and refuses an unknown workspace before any key', async () => {
    const commits = jest.spyOn(host, 'commit');
    await expect(
      instruct('core.workspace.hooks.update', {
        workspaceId: 'a',
        change: { kind: 'replace', hooks: HOOKS },
      }),
    ).resolves.toEqual({});
    expect(json('a/workspace.json').hooks).toEqual(HOOKS);
    expect(receiptCaller(commits)).toBe('daemon:agent-7:desktop');
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct(
          'core.workspace.hooks.update',
          { workspaceId: 'missing', change: { kind: 'replace', hooks: HOOKS } },
          'k-missing',
        ),
      ),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.configurationUnavailable',
      },
    });
    // An action the page accepts but the desktop would drop is refused.
    const before = images();
    for (const action of [
      { type: 'chat', prompt: '   ' },
      { type: 'chat', prompt: 'Review', model: 5 },
    ])
      expect(
        await failureOf(
          instruct(
            'core.workspace.hooks.update',
            {
              workspaceId: 'a',
              change: {
                kind: 'replace',
                hooks: { 'worktree:created': [action] },
              },
            },
            'k-invalid',
          ),
        ),
      ).toMatchObject({
        payload: {
          kind: 'invalid_argument',
          message: 'A hook action is not valid.',
        },
      });
    expect(reserves).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  it('#11 answers its outcome, keyed to the principal, and refuses an unknown workspace as notFound', async () => {
    const commits = jest.spyOn(host, 'commit');
    const first = await instruct('core.workspace.retention.update', {
      workspaceId: 'a',
      patch: { archiveRetentionDays: 7 },
    });
    expect(first).toMatchObject({ workspaceId: 'a' });
    expect(
      typeof (first as { activityBaselineRecorded?: unknown })
        .activityBaselineRecorded,
    ).toBe('boolean');
    expect(receiptCaller(commits)).toBe('daemon:agent-7:workspace_settings');
    await expect(
      instruct('core.workspace.retention.update', {
        workspaceId: 'a',
        patch: { archiveRetentionDays: 7 },
      }),
    ).resolves.toEqual(first);
    const reserves = jest.spyOn(host, 'reserve');
    expect(
      await failureOf(
        instruct(
          'core.workspace.retention.update',
          { workspaceId: 'missing', patch: { archiveRetentionDays: 7 } },
          'k-missing',
        ),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.workspace.notFound' },
    });
    expect(reserves).not.toHaveBeenCalled();
  });

  it("#11 refuses a Cowork workspace with the page's reason and releases the key", async () => {
    const config = json('b/workspace.json');
    writeFileSync(
      join(root, 'b', 'workspace.json'),
      JSON.stringify({ ...config, type: 'cowork' }),
    );
    __resetSidebarItemsStateForTests();
    const before = images();
    const call = (): Promise<unknown> =>
      instruct(
        'core.workspace.retention.update',
        { workspaceId: 'b', patch: { archiveRetentionDays: 7 } },
        'k-cowork',
      );
    const refusal = await failureOf(call());
    expect(refusal).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        details: { reason: 'cowork_workspace' },
        retry: { kind: 'never' },
      },
    });
    expect(images()).toEqual(before);
    // Released: the same key is refused again, not replayed or in progress.
    expect(await failureOf(call())).toMatchObject({
      payload: { details: { reason: 'cowork_workspace' } },
    });
  });

  it('#23 moves a row, keyed to the principal, and refuses a hidden row as notFound', async () => {
    const commits = jest.spyOn(host, 'commit');
    await expect(
      instruct('core.worktree.reorder', {
        workspaceId: 'a',
        activeWorktreeId: 'three',
        overWorktreeId: 'one',
      }),
    ).resolves.toEqual({});
    expect(rows().map((entry) => entry.id)).toEqual(['three', 'two', 'one']);
    expect(receiptCaller(commits)).toBe('daemon:agent-7:worktree-metadata');
    expect(
      await failureOf(
        instruct(
          'core.worktree.reorder',
          { workspaceId: 'a', activeWorktreeId: 'two', overWorktreeId: 'one' },
          'k-hidden',
        ),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.worktree.notFound' },
    });
  });

  it("#26 answers the row's portable projection, keyed to the principal and its interface", async () => {
    const commits = jest.spyOn(host, 'commit');
    const first = await instruct(
      'core.worktree.hooks.setPaused',
      {
        workspaceId: 'a',
        worktreeId: 'one',
        change: { kind: 'pause', hookKeys: ['project:manual'] },
      },
      'pause',
      { ...AGENT, interfaceKind: 'portal' },
    );
    expect(first).toEqual({
      worktree: {
        id: 'one',
        branchName: 'feature-one',
        createdAt,
        pausedHookKeys: ['project:manual'],
      },
      pausedHookKeys: ['project:manual'],
      changed: true,
    });
    expect(receiptCaller(commits)).toBe('daemon:agent-7:portal');
    const list = join(root, 'a', 'worktrees.json');
    const bytes = readFileSync(list, 'utf8');
    writeFileSync(list, '{not json');
    __resetSidebarItemsStateForTests();
    const resume = (): Promise<unknown> =>
      instruct(
        'core.worktree.hooks.setPaused',
        {
          workspaceId: 'a',
          worktreeId: 'one',
          change: { kind: 'resume', hookKeys: ['project:manual'] },
        },
        'resume',
      );
    expect(await failureOf(resume())).toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.worktree.listUnavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
    writeFileSync(list, bytes);
    __resetSidebarItemsStateForTests();
    // The refusal released the key.
    await expect(resume()).resolves.toMatchObject({
      pausedHookKeys: [],
      changed: true,
    });
    expect(
      await failureOf(
        instruct(
          'core.worktree.hooks.setPaused',
          {
            workspaceId: 'a',
            worktreeId: 'missing',
            change: { kind: 'pause', hookKeys: ['project:manual'] },
          },
          'k-missing',
        ),
      ),
    ).toMatchObject({
      payload: { kind: 'not_found', code: 'core.worktree.notFound' },
    });
  });
});

describe('recovery classes (RX2)', () => {
  beforeEach(() => commitRows('a', ROWS(createdAt), true));

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

  const code = (operation: string): string =>
    `${operation.startsWith('core.worktree.') ? 'core.worktree' : 'core.workspace'}.recoveryRequired`;

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
        payload: { kind: 'failed_precondition', code: code(operation) },
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
    operation: string,
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
        payload: { kind: 'failed_precondition', code: code(operation) },
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
    'a decided but unapplied #22 retries once its files are restored, then replays its first outcome',
    async () => {
      const call = (): Promise<unknown> =>
        instruct(
          'core.worktree.update',
          {
            scope: { workspaceId: 'a' },
            worktreeId: 'one',
            expectedRevision: 1,
            patch: { label: 'Decided' },
          },
          'rx-commit',
        );
      const originals = await decidedButUnapplied('core.worktree.update', call);
      const commitId = await wedgedCommitId('core.worktree.update');
      for (const [path, bytes] of originals) writeFileSync(path, bytes);
      await expect(
        resolve([{ kind: 'retry-commit', commitId }]),
      ).resolves.toMatchObject({ results: [{ status: 'applied' }] });
      startHost();
      expect(row('one')).toMatchObject({ label: 'Decided' });
      const commits = jest.spyOn(host, 'commit');
      await expect(call()).resolves.toMatchObject({
        worktreeId: 'one',
        name: 'Decided',
      });
      expect(commits).not.toHaveBeenCalled();
    },
  );

  posix(
    'a new #22 key meets a decided but unapplied change as an unverified revision a refresh can settle (DP-1)',
    async () => {
      const commit = host.commit.bind(host);
      // The decision commits, but its list changed out of band (the row
      // stays), so it is recovery-required and the read withholds revisions.
      jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
        for (const { path, previousFingerprint } of request.files)
          if (previousFingerprint !== null)
            writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
        return commit(request);
      });
      const call = (
        key: string,
        patch: Record<string, unknown>,
      ): Promise<unknown> =>
        instruct(
          'core.worktree.update',
          {
            scope: { workspaceId: 'a' },
            worktreeId: 'one',
            expectedRevision: 1,
            patch,
          },
          key,
        );
      expect(
        await failureOf(call('rx-decided', { label: 'Decided' })),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: code('core.worktree.update'),
        },
      });
      expect(row('one')).toBeDefined();
      expect(await readWorktree('one')).not.toHaveProperty('revision');
      const reserves = jest.spyOn(host, 'reserve');
      const refusal = await failureOf(call('rx-pending', { pinned: true }));
      expect(refusal).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.worktree.invalidState',
          retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
        },
      });
      expect(
        (refusal as { payload: { details: unknown } }).payload.details,
      ).toEqual({ reason: 'revision-unverified' });
      expect(reserves).not.toHaveBeenCalled();
    },
  );

  posix(
    'a decided but unapplied #26 whose retry fails again is abandoned, which releases its key',
    async () => {
      const call = (): Promise<unknown> =>
        instruct(
          'core.worktree.hooks.setPaused',
          {
            workspaceId: 'a',
            worktreeId: 'one',
            change: { kind: 'pause', hookKeys: ['project:manual'] },
          },
          'rx-abandon',
        );
      const originals = await decidedButUnapplied(
        'core.worktree.hooks.setPaused',
        call,
      );
      const commitId = await wedgedCommitId('core.worktree.hooks.setPaused');
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
        pausedHookKeys: ['project:manual'],
        changed: true,
      });
      expect(row('one')).toMatchObject({ pausedHookKeys: ['project:manual'] });
    },
  );
});

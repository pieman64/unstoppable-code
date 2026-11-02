import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import {
  binding,
  TEAM_A,
} from '../../../../../core-daemon/src/__tests__/filesystem-fixtures';
import type {
  WorkerFilesystemDirectoryListResult,
  WorkerFilesystemRootsListResult,
} from '@canopy/protocol/canopy-core';
import {
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../../lib/workspace-registry';
import {
  listFileTreeDirectory,
  listFileTreeRoots,
} from '../../services/files-service';
import {
  isDirectoryEntryName,
  normalizeDaemonFilesError,
} from '../daemon-files-route';
import {
  AUTHORITY,
  bridgeCaller,
  createRouteHarness,
  deferred,
  FakeSender,
  FIXTURE_TYPES,
  holdReplies,
  localCaller,
  rejection,
  untilReached,
  type RouteHarness,
} from './daemon-files-route-harness';

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };
const MULTI = { workspaceId: 'multi', worktreeId: 'task' };
const COWORK_HOME = { workspaceId: 'cowork', worktreeId: 'home' };

let h: RouteHarness;
let senderIds = 100;
const sender = (): FakeSender => new FakeSender((senderIds += 1));

afterEach(async () => {
  await h?.close();
});

function expectNoDaemonContact(): void {
  expect(h.connectionsFactory).not.toHaveBeenCalled();
  expect(h.hostContext).not.toHaveBeenCalled();
  expect(h.connections.gets).toHaveLength(0);
  expect(h.daemon.queries).toHaveLength(0);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function rewriteWorkspace(
  workspaceId: string,
  change: (document: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const path = join(h.dataRoot, 'workspaces', workspaceId, 'workspace.json');
  const document: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof document !== 'object' || document === null)
    throw new Error('Expected a manifest.');
  await writeJson(path, change({ ...document }));
}

async function renameCowork(name: string): Promise<void> {
  const path = join(h.dataRoot, 'workspaces', 'index.json');
  const document: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    typeof document !== 'object' ||
    document === null ||
    !('workspaces' in document) ||
    !Array.isArray(document.workspaces)
  )
    throw new Error('Expected workspace index');
  await writeJson(path, {
    ...document,
    workspaces: document.workspaces.map((entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      entry.id === 'cowork'
        ? { ...entry, name }
        : entry,
    ),
  });
}

async function touchWorktreeRecord(
  workspaceId: string,
  createdAt: string,
): Promise<void> {
  await writeJson(
    join(h.dataRoot, 'workspaces', workspaceId, 'worktrees.json'),
    {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'topic', createdAt }],
    },
  );
}

describe('flag absent, off or unavailable', () => {
  it.each([
    ['roots', SINGLE],
    ['directory', SINGLE],
    ['roots', { workspaceId: APP_ADVISOR_PROJECT_ID, worktreeId: 'task' }],
  ] as const)(
    'serves %s for %o directly with zero daemon contact',
    async (operation, scope) => {
      h = await createRouteHarness({ flag: false });
      const local = sender();
      const bridge = sender();
      for (const [who, caller] of [
        [local, localCaller(local)],
        [bridge, bridgeCaller(bridge, 'controller-1')],
      ] as const) {
        if (operation === 'roots') {
          await h.roots(scope, who, caller).catch(() => undefined);
        } else {
          await h
            .directory(scope, 'single', '', who, caller)
            .catch(() => undefined);
        }
        expect(who.retiringListeners()).toBe(0);
      }
      expectNoDaemonContact();
      expect(
        operation === 'roots' ? h.direct.roots : h.direct.directory,
      ).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps the direct capture unchanged with the flag off', async () => {
    h = await createRouteHarness({ flag: false });
    const result = await h.roots(SINGLE, sender());
    expect(result.legacyResult).toEqual(
      await h.direct.roots.mock.results[0]?.value,
    );
    expectNoDaemonContact();
  });
});

describe('enabled routing', () => {
  it('routes eligible roots through the daemon with the trusted mapping', async () => {
    h = await createRouteHarness();
    resetWorkCounters();
    const local = sender();
    const { canonicalResult, legacyResult } = await h.roots(SINGLE, local);
    expect(h.direct.roots).not.toHaveBeenCalled();
    expect(h.daemon.queries).toHaveLength(1);
    expect(h.daemon.queries[0]?.params).toEqual({
      scope: {
        workspaceId: 'single',
        worktreeId: 'task',
        authorityId: AUTHORITY,
      },
    });
    expect(h.daemon.queries[0]?.options?.metadata?.deadlineAt).toEqual(
      expect.any(String),
    );
    expect(canonicalResult.catalogRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyResult.roots.map((root) => root.repoId)).toEqual([
      'single',
      'attachments',
    ]);
    // Only the authority changes; principal, instance and grants are kept.
    expect(h.connections.gets[0]?.caller).toEqual({
      ...localCaller(local),
      authorityId: AUTHORITY,
    });
    expect(snapshotWorkCounters().route).toEqual({
      'files.roots.daemon': 1,
      'files.roots.daemon.queries': 1,
      'files.roots.daemon.served': 1,
    });
  });

  it.each([
    ['single-repo', SINGLE, 'single'],
    ['multi-repo', MULTI, WORKSPACE_ROOT_REPO_ID],
    ['Cowork', COWORK_HOME, 'workspace'],
  ] as const)(
    'matches the direct reader for %s roots and directories, paths included',
    async (_label, scope, rootId) => {
      h = await createRouteHarness();
      const legacyRoots = await listFileTreeRoots({
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
      });
      const routed = await h.roots(scope, sender());
      expect(routed.legacyResult).toEqual(legacyRoots);
      expect(
        routed.legacyResult.roots[0]?.absolutePath.startsWith(h.displayRoot),
      ).toBe(true);

      const legacyEntries = await listFileTreeDirectory({
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        repoId: rootId,
        relativeDir: '',
      });
      const listed = await h.directory(scope, rootId, '', sender());
      expect(listed.legacyResult).toEqual(legacyEntries);
      expect(h.direct.roots).not.toHaveBeenCalled();
      expect(h.direct.directory).not.toHaveBeenCalled();
    },
  );

  it('matches the direct reader for an attached Cowork folder outside the data root', async () => {
    h = await createRouteHarness();
    const external = join(h.base, 'external');
    await writeJson(join(external, 'doc.md'), 'attached');
    await rewriteWorkspace('cowork', (document) => ({
      ...document,
      externalPath: external,
    }));
    registerWorkspaceExternalPaths(new Map([['cowork', external]]));
    try {
      const legacyRoots = await listFileTreeRoots({
        projectId: 'cowork',
        worktreeId: 'home',
      });
      const routed = await h.roots(COWORK_HOME, sender());
      expect(routed.legacyResult).toEqual(legacyRoots);
      expect(routed.legacyResult.roots[0]?.absolutePath).toBe(external);

      const legacyEntries = await listFileTreeDirectory({
        projectId: 'cowork',
        worktreeId: 'home',
        repoId: 'workspace',
        relativeDir: '',
      });
      const listed = await h.directory(COWORK_HOME, 'workspace', '', sender());
      expect(listed.legacyResult).toEqual(legacyEntries);
      expect(
        listed.legacyResult.entries.find((entry) => entry.name === 'doc.md')
          ?.absolutePath,
      ).toBe(join(external, 'doc.md'));
      expect(h.direct.roots).not.toHaveBeenCalled();
      expect(h.direct.directory).not.toHaveBeenCalled();
    } finally {
      registerWorkspaceExternalPaths(new Map());
    }
  });

  it('normalizes the relative directory like the direct reader', async () => {
    h = await createRouteHarness();
    const listed = await h.directory(SINGLE, 'single', 'src/', sender());
    expect(h.daemon.queries[0]?.params).toMatchObject({ relativePath: 'src' });
    expect(
      listed.legacyResult.entries.map((entry) => entry.relativePath),
    ).toEqual(['src/index.ts']);
    for (const [path, message] of [
      ['/etc', 'Path must be relative.'],
      ['C:\\x', 'Path must be relative.'],
      ['src/../..', 'Path cannot traverse outside the worktree.'],
    ] as const) {
      await expect(
        rejection(h.directory(SINGLE, 'single', path, sender())),
      ).resolves.toMatchObject({ kind: 'invalid_argument', message });
    }
    expect(h.daemon.queries).toHaveLength(1);
    expect(h.direct.directory).not.toHaveBeenCalled();
  });

  it.each(['./', '.\\', './/'])(
    'lists the root for %j like the direct reader',
    async (relativeDir) => {
      h = await createRouteHarness();
      const legacyEntries = await listFileTreeDirectory({
        projectId: 'single',
        worktreeId: 'task',
        repoId: 'single',
        relativeDir,
      });
      const listed = await h.directory(SINGLE, 'single', relativeDir, sender());
      expect(h.daemon.queries[0]?.params).toMatchObject({ relativePath: '' });
      expect(listed.legacyResult).toEqual(legacyEntries);
      expect(h.direct.directory).not.toHaveBeenCalled();
    },
  );

  it('routes standalone Cowork through the trusted alias to its home', async () => {
    h = await createRouteHarness();
    const routed = await h.roots(
      { workspaceId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'cowork' },
      sender(),
    );
    expect(h.daemon.queries[0]?.params).toEqual({
      scope: {
        workspaceId: 'cowork',
        worktreeId: 'home',
        authorityId: AUTHORITY,
      },
    });
    expect(routed.legacyResult.roots.map((root) => root.repoId)).toEqual([
      'workspace',
      'notes',
      'prompts',
    ]);
    // Same roots, ids and paths the direct reader serves for the alias, so
    // later alias-keyed mutations, previews and watches resolve them.
    const alias = {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'cowork',
    };
    expect(routed.legacyResult).toEqual(await listFileTreeRoots(alias));
    const listed = await h.directory(
      { workspaceId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'cowork' },
      'workspace',
      '',
      sender(),
    );
    expect(listed.legacyResult).toEqual(
      await listFileTreeDirectory({
        ...alias,
        repoId: 'workspace',
        relativeDir: '',
      }),
    );
    expect(h.direct.roots).not.toHaveBeenCalled();
    expect(h.direct.directory).not.toHaveBeenCalled();
  });

  it('keeps standalone aliases that do not resolve to Cowork on the direct reader', async () => {
    h = await createRouteHarness();
    await h
      .roots(
        { workspaceId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'single' },
        sender(),
      )
      .catch(() => undefined);
    expectNoDaemonContact();
    expect(h.direct.roots).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown and unregistered ids on the direct reader', async () => {
    h = await createRouteHarness();
    registerWorkspaceTypes(new Map());
    await h.roots(SINGLE, sender());
    await h.roots({ workspaceId: 'never-seen', worktreeId: 'task' }, sender());
    expectNoDaemonContact();
    expect(h.direct.roots).toHaveBeenCalledTimes(2);
    registerWorkspaceTypes(new Map(FIXTURE_TYPES));
  });

  it.each([
    APP_ADVISOR_PROJECT_ID,
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    CODE_REVIEW_CHAT_PROJECT_ID,
  ])(
    'keeps %s on its existing route for local and remote senders',
    async (workspaceId) => {
      h = await createRouteHarness();
      // Registered under the same id, the exclusion still applies first.
      registerWorkspaceTypes(
        new Map([...FIXTURE_TYPES, [workspaceId, 'single-repo']]),
      );
      const local = sender();
      const bridge = sender();
      await h
        .roots({ workspaceId, worktreeId: 'task' }, local)
        .catch(() => undefined);
      await h
        .roots(
          { workspaceId, worktreeId: 'task' },
          bridge,
          bridgeCaller(bridge, 'controller-1'),
        )
        .catch(() => undefined);
      await h
        .directory({ workspaceId, worktreeId: 'task' }, 'x', '', local)
        .catch(() => undefined);
      expectNoDaemonContact();
      expect(h.direct.roots).toHaveBeenCalledTimes(2);
      expect(h.direct.directory).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps callers that are not this sender, or carry other selections, direct', async () => {
    h = await createRouteHarness();
    resetWorkCounters();
    const local = sender();
    await h.roots(SINGLE, local, localCaller({ id: local.id + 1 }));
    await h.roots(SINGLE, local, {
      ...localCaller(local),
      authorityId: 'other',
    });
    await h
      .roots(SINGLE, local, { ...localCaller(local), interfaceKind: 'cli' })
      .catch(() => undefined);
    await h
      .roots({ ...SINGLE, authorityId: 'foreign' }, local)
      .catch(() => undefined);
    await h
      .roots({ ...SINGLE, targetId: 'remote-target' }, local)
      .catch(() => undefined);
    await h
      .roots({ ...SINGLE, organizationId: TEAM_A }, local)
      .catch(() => undefined);
    expectNoDaemonContact();
    // The direct adapter itself refuses a target or foreign authority, as before.
    expect(snapshotWorkCounters().route).toEqual({ 'files.roots.direct': 6 });
    expect(h.direct.roots).toHaveBeenCalledTimes(4);
  });

  it('gates both reads on the actual caller grants in main, before contact', async () => {
    h = await createRouteHarness();
    const local = sender();
    const caller = localCaller(local);
    const withoutRead = {
      ...caller,
      grants: caller.grants.filter(
        (grant) => grant !== 'worker.filesystem.read',
      ),
    };
    expect(await rejection(h.roots(SINGLE, local, withoutRead))).toMatchObject({
      kind: 'permission_denied',
    });
    expect(
      await rejection(h.directory(SINGLE, 'single', '', local, withoutRead)),
    ).toMatchObject({ kind: 'permission_denied' });
    expectNoDaemonContact();
    expect(h.direct.roots).not.toHaveBeenCalled();
    expect(h.direct.directory).not.toHaveBeenCalled();
  });

  it('serves only file-tree IPC requests; other dispatcher callers stay direct', async () => {
    h = await createRouteHarness();
    const caller = localCaller(sender());
    await h.runtime.query(
      'worker.filesystem.roots.list',
      { scope: SINGLE },
      { caller },
    );
    await h.runtime.queryFileTreeRootsForLegacyIpc(
      { scope: SINGLE },
      { caller },
    );
    expectNoDaemonContact();
    expect(h.direct.roots).toHaveBeenCalledTimes(2);
  });
});

describe('Cowork worktree ids (R4b)', () => {
  const entries = (rows: unknown[]): unknown => ({ version: 1, entries: rows });
  const workEntries = (): string =>
    join(h.dataRoot, 'workspaces', 'cowork', 'work-entries.json');
  const entryId = '3f6d1c1e-2b7a-4c3d-9e8f-0a1b2c3d4e5f';

  it('passes a registered work entry id and home through unchanged', async () => {
    h = await createRouteHarness();
    await h.roots(COWORK_HOME, sender());
    await writeJson(
      workEntries(),
      entries([{ id: entryId, createdAt: '2026-10-17T00:00:00.000Z' }]),
    );
    await h.roots({ workspaceId: 'cowork', worktreeId: entryId }, sender());
    await h.roots(COWORK_HOME, sender());
    expect(
      h.daemon.queries.map((query) => query.params.scope.worktreeId),
    ).toEqual(['home', entryId, 'home']);
  });

  it('returns typed notFound for a stale id the direct reader still serves', async () => {
    h = await createRouteHarness();
    const stale = { workspaceId: 'cowork', worktreeId: entryId };
    await expect(rejection(h.roots(stale, sender()))).resolves.toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.roots.notFound',
    });
    h.flag.set(false);
    await expect(h.roots(stale, sender())).resolves.toBeDefined();
    expect(h.direct.roots).toHaveBeenCalledTimes(1);
  });

  it('refuses a registered home row as invalid state', async () => {
    h = await createRouteHarness();
    await writeJson(workEntries(), entries([{ id: 'home', createdAt: 'now' }]));
    await expect(
      rejection(h.roots(COWORK_HOME, sender())),
    ).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.roots.invalidState',
    });
    expect(h.direct.roots).not.toHaveBeenCalled();
  });
});

describe('organization owners (Q2)', () => {
  it('refuses a malformed organization owner before any daemon contact', async () => {
    h = await createRouteHarness();
    for (const operation of ['roots', 'directory'] as const) {
      const read =
        operation === 'roots'
          ? h.roots({ workspaceId: 'malformed', worktreeId: 'task' }, sender())
          : h.directory(
              { workspaceId: 'malformed', worktreeId: 'task' },
              'malformed',
              '',
              sender(),
            );
      await expect(rejection(read)).resolves.toMatchObject({
        kind: 'failed_precondition',
        code: `worker.filesystem.${operation}.invalidState`,
      });
    }
    expect(h.connections.gets).toHaveLength(0);
    expect(h.daemon.queries).toHaveLength(0);
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('serves absent, lower-case, upper-case and padded organization owners', async () => {
    h = await createRouteHarness();
    await h.roots(SINGLE, sender());
    await h.roots({ workspaceId: 'team-b', worktreeId: 'task' }, sender());
    await h.roots({ workspaceId: 'team-a', worktreeId: 'task' }, sender());
    await rewriteWorkspace('team-a', (document) => ({
      ...document,
      owner: binding(`  ${TEAM_A.toUpperCase()}  `),
    }));
    await h.roots({ workspaceId: 'team-a', worktreeId: 'task' }, sender());
    expect(h.daemon.queries).toHaveLength(4);
    expect(h.direct.roots).not.toHaveBeenCalled();
  });
});

describe('typed failures', () => {
  const leaseRefusals = [
    {
      kind: 'not_found',
      message:
        'This operation requires a live client lease on this connection.',
    },
    { kind: 'cancelled', message: 'The client lease was released.' },
    { kind: 'not_found', message: 'The client lease expired.' },
    {
      kind: 'failed_precondition',
      message: 'The client lease moved to another connection.',
    },
  ] as const;

  it.each(leaseRefusals)(
    'returns lease refusal $kind code-free with no direct read',
    async (refusal) => {
      h = await createRouteHarness();
      h.daemon.fail = (): Error =>
        new CanopyClientError({ ...refusal, retry: { kind: 'never' } });
      for (const read of [
        (): Promise<unknown> => h.roots(SINGLE, sender()),
        (): Promise<unknown> => h.directory(SINGLE, 'single', '', sender()),
      ]) {
        const failure = await rejection(read());
        expect(failure).toEqual({
          kind: refusal.kind,
          message: refusal.message,
          retry: { kind: 'never' },
        });
      }
      expect(h.direct.roots).not.toHaveBeenCalled();
      expect(h.direct.directory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['setup', 'deadline_exceeded', 'Desktop connection setup timed out.'],
    [
      'authority',
      'failed_precondition',
      'Desktop caller selected a different authority.',
    ],
    ['auth', 'unauthenticated', 'Desktop caller identity is invalid.'],
    [
      'transport',
      'capability_unavailable',
      'Desktop daemon transport is disabled.',
    ],
  ] as const)('returns a %s failure typed', async (_label, kind, message) => {
    h = await createRouteHarness();
    h.connections.fail = (): Error =>
      new CanopyClientError({ kind, message, retry: { kind: 'never' } });
    await expect(rejection(h.roots(SINGLE, sender()))).resolves.toEqual({
      kind,
      message,
      retry: { kind: 'never' },
    });
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('returns query, deadline and unadvertised failures typed, never internal', async () => {
    h = await createRouteHarness();
    for (const [kind, message, retry] of [
      ['unavailable', 'The connection closed.', { kind: 'same_request' }],
      [
        'deadline_exceeded',
        'The request deadline passed.',
        { kind: 'same_request' },
      ],
      [
        'capability_unavailable',
        'worker.filesystem.roots.list is not available on this connection.',
        { kind: 'never' },
      ],
    ] as const) {
      h.daemon.fail = (): Error =>
        new CanopyClientError({ kind, message, retry });
      await expect(rejection(h.roots(SINGLE, sender()))).resolves.toEqual({
        kind,
        message,
        retry: { kind: 'never' },
      });
    }
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('refuses an unversioned daemon result without a fallback', async () => {
    h = await createRouteHarness();
    h.daemon.rewriteRoots = ({ roots }): WorkerFilesystemRootsListResult => ({
      roots,
    });
    await expect(rejection(h.roots(SINGLE, sender()))).resolves.toMatchObject({
      kind: 'capability_unavailable',
      code: 'worker.filesystem.roots.invalidState',
    });
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('reports a data root it cannot prepare as unavailable', async () => {
    h = await createRouteHarness();
    h.hostContext.mockRejectedValueOnce(new Error('EACCES /private/path'));
    await expect(rejection(h.roots(SINGLE, sender()))).resolves.toEqual({
      kind: 'unavailable',
      message: 'The desktop daemon data root could not be prepared.',
      retry: { kind: 'never' },
    });
    expect(h.connections.gets).toHaveLength(0);
  });

  it('keeps only the operation codes the operation declares', () => {
    const wrongOperation = normalizeDaemonFilesError(
      'directory',
      new CanopyClientError({
        kind: 'not_found',
        code: 'worker.filesystem.roots.notFound',
        message: 'gone',
        details: { reason: 'x' },
        retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
      }),
    );
    expect(wrongOperation.payload).toEqual({
      kind: 'not_found',
      message: 'gone',
      details: { reason: 'x' },
      retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
    });
    expect(
      normalizeDaemonFilesError('roots', new Error('boom')).payload,
    ).toEqual({
      kind: 'internal',
      message: 'The daemon Files read failed.',
      retry: { kind: 'never' },
    });
  });

  it('passes a daemon directory notFound through typed, with no direct listing', async () => {
    h = await createRouteHarness();
    h.daemon.fail = (record): Error | null =>
      record.name === 'worker.filesystem.directory.list'
        ? new CanopyClientError({
            kind: 'not_found',
            message: 'The file root is not registered.',
            code: 'worker.filesystem.directory.notFound',
            retry: { kind: 'never' },
          })
        : null;
    await expect(
      rejection(h.directory(SINGLE, 'single', '', sender())),
    ).resolves.toEqual({
      kind: 'not_found',
      code: 'worker.filesystem.directory.notFound',
      message: 'The file root is not registered.',
      retry: { kind: 'never' },
    });
    expect(h.direct.directory).not.toHaveBeenCalled();
  });
});

describe('request validation matches the direct reader', () => {
  /** The typed payload and the error the file-tree IPC handler rethrows. */
  async function failureOf(
    read: Promise<unknown>,
  ): Promise<{ payload: unknown; ipc: string }> {
    try {
      await read;
    } catch (error) {
      if (!(error instanceof CanopyOperationError)) throw error;
      // rethrowLegacyFileTreeError: the runtime cause when there is one.
      const thrown =
        error.runtimeCause instanceof Error
          ? error.runtimeCause
          : new Error(error.payload.message);
      return { payload: error.payload, ipc: String(thrown) };
    }
    throw new Error('Expected the read to be rejected.');
  }

  const cases: Array<
    [
      string,
      { workspaceId: string; worktreeId: string },
      { fileRootId: string; relativePath: string } | null,
    ]
  > = [
    ['a malformed worktreeId (roots)', { ...SINGLE, worktreeId: 'Task' }, null],
    ['an unsafe worktreeId (roots)', { ...SINGLE, worktreeId: 'task_2' }, null],
    [
      'a malformed worktreeId (directory)',
      { ...SINGLE, worktreeId: 'Task' },
      { fileRootId: 'single', relativePath: '' },
    ],
    ['a malformed repoId', SINGLE, { fileRootId: 'Single', relativePath: '' }],
    [
      'a malformed repoId before a bad path',
      SINGLE,
      { fileRootId: 'single_1', relativePath: '/etc' },
    ],
    [
      'a malformed worktreeId before a bad path',
      { ...SINGLE, worktreeId: 'Task' },
      { fileRootId: 'single', relativePath: '../x' },
    ],
    [
      'an absolute path',
      SINGLE,
      { fileRootId: 'single', relativePath: '/etc' },
    ],
    ['a drive path', SINGLE, { fileRootId: 'single', relativePath: 'C:\\x' }],
    [
      'a traversal',
      SINGLE,
      { fileRootId: 'single', relativePath: 'src/../..' },
    ],
  ];

  it.each(cases)(
    'refuses %s with the direct error, before contact',
    async (_label, scope, directory) => {
      h = await createRouteHarness();
      const read = (): Promise<unknown> =>
        directory
          ? h.directory(
              scope,
              directory.fileRootId,
              directory.relativePath,
              sender(),
            )
          : h.roots(scope, sender());
      resetWorkCounters();
      const routed = await failureOf(read());
      expectNoDaemonContact();
      expect(h.direct.roots).not.toHaveBeenCalled();
      expect(h.direct.directory).not.toHaveBeenCalled();
      const operation = directory ? 'directory' : 'roots';
      expect(snapshotWorkCounters().route).toEqual({
        [`files.${operation}.daemon`]: 1,
        [`files.${operation}.daemon.failed.invalid_argument`]: 1,
      });

      h.flag.set(false);
      const direct = await failureOf(read());
      expect(routed).toEqual(direct);
      expect(routed.payload).toMatchObject({ kind: 'invalid_argument' });
    },
  );

  // Disclosed: requests the checks accept but the read itself refuses. The
  // daemon reports its typed code and never forwards host error text; the
  // root is known only to the daemon's catalog, after the pre-contact checks.
  it.each([
    ['an unknown root', 'other', 'src', 'not_found', 'not_found'],
    [
      'an unknown root with a bad path',
      'other',
      '/etc',
      'invalid_argument',
      'not_found',
    ],
    [
      'a file as the directory',
      'single',
      'README.md',
      'failed_precondition',
      'internal',
    ],
    [
      'a link escaping the root',
      'single',
      'escape',
      'failed_precondition',
      'internal',
    ],
    ['a null byte', 'single', 'a\0b', 'failed_precondition', 'internal'],
  ] as const)(
    'reports %s as the daemon does, not as the direct reader',
    async (_label, fileRootId, relativePath, routedKind, directKind) => {
      h = await createRouteHarness();
      const read = (): Promise<unknown> =>
        h.directory(SINGLE, fileRootId, relativePath, sender());
      const routed = await failureOf(read());
      h.flag.set(false);
      const direct = await failureOf(read());
      expect(routed.payload).toMatchObject({ kind: routedKind });
      expect(direct.payload).toMatchObject({ kind: directKind });
    },
  );

  it('reports an unrecorded worktree as notFound where the direct reader lists its path', async () => {
    h = await createRouteHarness();
    const gone = { ...SINGLE, worktreeId: 'gone' };
    await expect(failureOf(h.roots(gone, sender()))).resolves.toMatchObject({
      payload: { kind: 'not_found', code: 'worker.filesystem.roots.notFound' },
    });
    h.flag.set(false);
    const direct = await h.roots(gone, sender());
    expect(direct.legacyResult.roots.map((root) => root.repoId)).toEqual([
      'single',
    ]);
  });
});

describe('invalid daemon results', () => {
  // Type aliases, not interfaces: their implicit index signature satisfies
  // the protocol's JSON catchall.
  type Entry = {
    name: string;
    relativePath: string;
    kind: 'file' | 'directory';
    isIgnored: boolean;
    isIndexExcluded: boolean;
    isSymlink: boolean;
    hasChildren: boolean;
  };
  type Root = {
    fileRootId: string;
    name: string;
    kind: 'git-repo' | 'workspace-root' | 'attachments' | 'standalone';
  };
  function first(list: readonly Entry[]): Entry;
  function first(list: readonly Root[]): Root;
  function first(list: readonly (Entry | Root)[]): Entry | Root {
    const [head] = list;
    if (head === undefined) throw new Error('Expected a listed item.');
    return head;
  }

  const invalidEntries: Array<[string, (entries: Entry[]) => Entry[]]> = [
    [
      'an absolute path',
      (e): Entry[] => [{ ...first(e), relativePath: '/abs' }],
    ],
    [
      'a parent segment',
      (e): Entry[] => [{ ...first(e), name: '..', relativePath: '..' }],
    ],
    [
      'the wrong parent',
      (e): Entry[] => [{ ...first(e), relativePath: `other/${first(e).name}` }],
    ],
    ['a name mismatch', (e): Entry[] => [{ ...first(e), name: 'renamed' }]],
    [
      'a .git segment',
      (e): Entry[] => [{ ...first(e), name: '.git', relativePath: '.git' }],
    ],
    ['a duplicate', (e): Entry[] => [first(e), first(e)]],
  ];

  it.each(invalidEntries)(
    'rejects a directory with %s',
    async (_label, mutate) => {
      h = await createRouteHarness();
      h.daemon.rewriteDirectory = (
        result,
      ): WorkerFilesystemDirectoryListResult => ({
        ...result,
        entries: mutate(result.entries),
      });
      await expect(
        rejection(h.directory(SINGLE, 'single', '', sender())),
      ).resolves.toMatchObject({
        kind: 'failed_precondition',
        code: 'worker.filesystem.directory.invalidState',
      });
      expect(h.direct.directory).not.toHaveBeenCalled();
    },
  );

  const invalidRoots: Array<[string, (roots: Root[]) => Root[]]> = [
    [
      'an unknown root id',
      (r): Root[] => [{ ...first(r), fileRootId: 'other' }],
    ],
    ['a duplicate root id', (r): Root[] => [first(r), first(r)]],
    ['out-of-order roots', (r): Root[] => [...r].reverse()],
    ['a renamed root', (r): Root[] => [{ ...first(r), name: 'renamed' }]],
    ['a re-kinded root', (r): Root[] => [{ ...first(r), kind: 'standalone' }]],
    // Only a hidden attachments root may be missing from a daemon reply.
    [
      'a dropped repository root',
      (r): Root[] => r.filter((root) => root.kind !== 'git-repo'),
    ],
  ];

  it.each(invalidRoots)('rejects roots with %s', async (_label, mutate) => {
    h = await createRouteHarness();
    h.daemon.rewriteRoots = (result): WorkerFilesystemRootsListResult => ({
      ...result,
      roots: mutate(result.roots),
    });
    await expect(rejection(h.roots(SINGLE, sender()))).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.roots.invalidState',
    });
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('accepts roots that omit a hidden attachments root', async () => {
    h = await createRouteHarness();
    const { legacyResult } = await h.roots(MULTI, sender());
    expect(legacyResult.roots.map((root) => root.repoId)).toEqual([
      WORKSPACE_ROOT_REPO_ID,
      'api',
    ]);
  });

  it('refuses roots that omit a visible attachments root, after one refresh', async () => {
    h = await createRouteHarness();
    h.daemon.rewriteRoots = (result): WorkerFilesystemRootsListResult => ({
      ...result,
      roots: result.roots.filter((root) => root.kind !== 'attachments'),
    });
    await expect(rejection(h.roots(SINGLE, sender()))).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.roots.invalidState',
    });
    expect(h.daemon.queries).toHaveLength(2);
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('retries roots read just before the attachments root gained its first file', async () => {
    h = await createRouteHarness();
    const attachments = join(
      h.dataRoot,
      'workspaces',
      'multi',
      'attachments',
      'task',
    );
    h.daemon.afterReply = async (_record, attempt): Promise<void> => {
      if (attempt !== 1) return;
      await mkdir(attachments, { recursive: true });
      await writeFile(join(attachments, 'a.png'), 'png');
    };
    const { legacyResult } = await h.roots(MULTI, sender());
    expect(h.daemon.queries).toHaveLength(2);
    expect(legacyResult).toEqual(
      await listFileTreeRoots({ projectId: 'multi', worktreeId: 'task' }),
    );
    expect(legacyResult.roots.map((root) => root.rootKind)).toContain(
      'attachments',
    );
  });

  it('refuses roots that list a hidden attachments root, after one refresh', async () => {
    h = await createRouteHarness();
    h.daemon.rewriteRoots = (result): WorkerFilesystemRootsListResult => ({
      ...result,
      roots: [
        ...result.roots,
        { fileRootId: 'attachments', name: 'attachments', kind: 'attachments' },
      ],
    });
    await expect(rejection(h.roots(MULTI, sender()))).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.roots.invalidState',
    });
    expect(h.daemon.queries).toHaveLength(2);
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('retries roots read just before the attachments root lost its last file', async () => {
    h = await createRouteHarness();
    h.daemon.afterReply = async (_record, attempt): Promise<void> => {
      if (attempt !== 1) return;
      // The file, not the directory: the revision covers the directory.
      await rm(
        join(
          h.dataRoot,
          'workspaces',
          'single',
          'attachments',
          'task',
          'image.png',
        ),
      );
    };
    const { legacyResult } = await h.roots(SINGLE, sender());
    expect(h.daemon.queries).toHaveLength(2);
    expect(legacyResult).toEqual(
      await listFileTreeRoots({ projectId: 'single', worktreeId: 'task' }),
    );
    expect(legacyResult.roots.map((root) => root.repoId)).toEqual(['single']);
  });

  it.each([
    ['missing', null],
    ['holding only .git', '.git'],
  ] as const)(
    'reports a directory read of a hidden attachments root (%s) as not found, as the direct reader does',
    async (_label, only) => {
      h = await createRouteHarness();
      if (only)
        await mkdir(
          join(h.dataRoot, 'workspaces', 'multi', 'attachments', 'task', only),
          { recursive: true },
        );
      const read = (): Promise<unknown> =>
        h.directory(MULTI, 'attachments', '', sender());
      await expect(rejection(read())).resolves.toMatchObject({
        kind: 'not_found',
        code: 'worker.filesystem.directory.notFound',
      });
      expect(h.direct.directory).not.toHaveBeenCalled();
      h.flag.set(false);
      await expect(rejection(read())).resolves.toMatchObject({
        kind: 'not_found',
      });
    },
  );

  it('lists a visible attachments root as the direct reader does', async () => {
    h = await createRouteHarness();
    const routed = await h.directory(SINGLE, 'attachments', '', sender());
    expect(routed.legacyResult).toEqual(
      await listFileTreeDirectory({
        projectId: 'single',
        worktreeId: 'task',
        repoId: 'attachments',
        relativeDir: '',
      }),
    );
    expect(routed.legacyResult.entries.map((entry) => entry.name)).toEqual([
      'image.png',
    ]);
  });

  it('rejects multi-repo roots that drop a member repository', async () => {
    h = await createRouteHarness();
    h.daemon.rewriteRoots = (result): WorkerFilesystemRootsListResult => ({
      ...result,
      roots: result.roots.filter((root) => root.fileRootId !== 'api'),
    });
    await expect(rejection(h.roots(MULTI, sender()))).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.roots.invalidState',
    });
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  const posixOnly = process.platform === 'win32' ? it.skip : it;
  posixOnly(
    'lists POSIX-legal names the direct reader lists, such as a backslash or drive-like prefix',
    async () => {
      h = await createRouteHarness();
      const task = join(
        h.dataRoot,
        'workspaces',
        'single',
        'worktrees',
        'task',
      );
      await writeFile(join(task, 'back\\slash.txt'), 'x');
      await writeFile(join(task, 'c:notes.txt'), 'x');
      const legacyEntries = await listFileTreeDirectory({
        projectId: 'single',
        worktreeId: 'task',
        repoId: 'single',
        relativeDir: '',
      });
      expect(legacyEntries.entries.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(['back\\slash.txt', 'c:notes.txt']),
      );
      const listed = await h.directory(SINGLE, 'single', '', sender());
      expect(listed.legacyResult).toEqual(legacyEntries);
      expect(h.direct.directory).not.toHaveBeenCalled();
    },
  );

  // Each would make `join(root, name)` a drive-relative, stream, device,
  // `.git` or trailing-stripped alias path on Windows, not the listed child.
  const windowsSpecialNames = [
    'C:notes',
    'c:',
    'foo:stream',
    'file.txt::$DATA',
    'CON',
    'con',
    'Con.txt',
    'NUL.tar.gz',
    'aux',
    'PRN',
    'COM1',
    'com9.log',
    'LPT1',
    'lpt9',
    'COM¹',
    'LPT³.txt',
    'CONIN$',
    'conout$.txt',
    'CON .txt',
    'nul ',
    'trailing.',
    'trailing ',
    'dots...',
    ' ',
    '.GIT',
    '.Git',
    'GIT~1',
    'git~1',
  ];
  it.each(windowsSpecialNames)('refuses %j as a Windows entry name', (name) => {
    expect(isDirectoryEntryName(name, 'win32')).toBe(false);
  });

  it.each(windowsSpecialNames)('accepts %j as a POSIX entry name', (name) => {
    expect(isDirectoryEntryName(name, 'posix')).toBe(true);
  });

  it.each([
    'notes.txt',
    '.env',
    '.hidden',
    ' leading space.txt',
    'name with space.txt',
    'CONSOLE',
    'con-fig.ts',
    'auxiliary.md',
    'NULL',
    'CONIN',
    'COM0',
    'COM10',
    'LPT0',
    'lpt10.txt',
    'a.b.c',
    'résumé.txt',
    '.gitignore',
    '.github',
    'git',
  ])('accepts %j as a Windows entry name', (name) => {
    expect(isDirectoryEntryName(name, 'win32')).toBe(true);
  });

  it.each(['', '.', '..', 'a/b', 'a\0b'])(
    'refuses %j on both platforms',
    (name) => {
      expect(isDirectoryEntryName(name, 'win32')).toBe(false);
      expect(isDirectoryEntryName(name, 'posix')).toBe(false);
    },
  );

  it('refuses a backslash only on Windows', () => {
    expect(isDirectoryEntryName('back\\slash.txt', 'win32')).toBe(false);
    expect(isDirectoryEntryName('back\\slash.txt', 'posix')).toBe(true);
  });

  it.each(['C:notes', 'foo:stream', 'CON', 'trailing.', 'GIT~1'])(
    'rejects a directory listing %j on Windows',
    async (name: string) => {
      h = await createRouteHarness({ entryNamePlatform: 'win32' });
      h.daemon.rewriteDirectory = (
        result,
      ): WorkerFilesystemDirectoryListResult => ({
        ...result,
        entries: [{ ...first(result.entries), name, relativePath: name }],
      });
      await expect(
        rejection(h.directory(SINGLE, 'single', '', sender())),
      ).resolves.toMatchObject({
        kind: 'failed_precondition',
        code: 'worker.filesystem.directory.invalidState',
      });
      expect(h.direct.directory).not.toHaveBeenCalled();
    },
  );

  it('serves an ordinary listing under Windows entry-name rules', async () => {
    h = await createRouteHarness({ entryNamePlatform: 'win32' });
    const legacyEntries = await listFileTreeDirectory({
      projectId: 'single',
      worktreeId: 'task',
      repoId: 'single',
      relativeDir: '',
    });
    expect(legacyEntries.entries).not.toEqual([]);
    const listed = await h.directory(SINGLE, 'single', '', sender());
    expect(listed.legacyResult).toEqual(legacyEntries);
    expect(h.direct.directory).not.toHaveBeenCalled();
  });
});

describe('directory entry order', () => {
  type Listed = WorkerFilesystemDirectoryListResult['entries'][number];
  const codeUnits = (a: Listed, b: Listed): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const swedish = new Intl.Collator('sv');
  // Orders a daemon with another locale or comparator could return. Names
  // that every ICU collator ranks equal (zero-width space, soft hyphen) come
  // in the direct reader's readdir order only when the daemon's collator also
  // ranks them equal, so only the collator case lists them.
  const foreignOrders: Array<
    [string, (a: Listed, b: Listed) => number, string[]]
  > = [
    [
      'code-unit order, files first',
      (a, b): number =>
        a.kind === b.kind ? codeUnits(a, b) : a.kind === 'file' ? -1 : 1,
      [],
    ],
    [
      'Swedish collation, with names it ranks equal',
      (a, b): number =>
        a.kind === b.kind
          ? swedish.compare(a.name, b.name)
          : a.kind === 'directory'
            ? -1
            : 1,
      ['ab.md', 'a\u200bb.md', 'a\u00adb.md'],
    ],
    ['reversed code-unit order', (a, b): number => codeUnits(b, a), []],
  ];

  it.each(foreignOrders)(
    'returns the direct reader order for a daemon reply in %s',
    async (_label, compare, equalNames) => {
      h = await createRouteHarness();
      const task = join(
        h.dataRoot,
        'workspaces',
        'single',
        'worktrees',
        'task',
      );
      for (const name of [
        'Zeta.md',
        'zebra.md',
        'alpha.md',
        'Ångström.md',
        'ärende.md',
        'öl.md',
        'émile.md',
        'eclair.md',
        'a10.md',
        'a2.md',
        '_under.md',
        '#hash.md',
        ...equalNames,
      ])
        await writeFile(join(task, name), 'x');
      for (const name of ['Bdir', 'adir', 'Ödir'])
        await mkdir(join(task, name));
      const direct = await listFileTreeDirectory({
        projectId: 'single',
        worktreeId: 'task',
        repoId: 'single',
        relativeDir: '',
      });
      const directOrder = direct.entries.map((entry) => entry.relativePath);
      let replied: string[] = [];
      h.daemon.rewriteDirectory = (
        result,
      ): WorkerFilesystemDirectoryListResult => {
        const entries = [...result.entries].sort(compare);
        replied = entries.map((entry) => entry.relativePath);
        return { ...result, entries };
      };

      const listed = await h.directory(SINGLE, 'single', '', sender());

      // The reply really is in another order, so the assertion below bites.
      expect(replied).not.toEqual(directOrder);
      expect(
        listed.canonicalResult.entries.map((entry) => entry.relativePath),
      ).toEqual(directOrder);
      expect(listed.legacyResult).toEqual(direct);
      expect(h.direct.directory).not.toHaveBeenCalled();
    },
  );
});

describe('races and the one bounded retry', () => {
  it('refreshes the named Cowork root through both readers and its legacy alias', async () => {
    h = await createRouteHarness();
    for (const name of ['Vendor Spend Q3 / 支出 🌳', 'Renamed Q4']) {
      await renameCowork(name);
      const direct = await listFileTreeRoots({
        projectId: 'cowork',
        worktreeId: 'home',
      });
      expect(direct.roots[0]?.repoName).toBe(name);
      for (const scope of [
        COWORK_HOME,
        { workspaceId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'cowork' },
      ]) {
        const routed = await h.roots(scope, sender());
        expect(routed.legacyResult).toEqual(direct);
        expect(routed.canonicalResult.roots[0]?.name).toBe(name);
      }
    }
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('retries a Cowork rename between daemon reply and local projection', async () => {
    h = await createRouteHarness();
    await renameCowork('Vendor Spend Q3');
    h.daemon.afterReply = async (_record, attempt): Promise<void> => {
      if (attempt === 1) await renameCowork('Renamed Q4');
    };
    const result = await h.roots(COWORK_HOME, sender());
    expect(result.legacyResult.roots[0]?.repoName).toBe('Renamed Q4');
    expect(h.daemon.queries).toHaveLength(2);
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('returns a typed conflict when Cowork metadata keeps changing', async () => {
    h = await createRouteHarness();
    let revision = 0;
    h.daemon.afterReply = async (): Promise<void> => {
      await renameCowork(`Renamed ${++revision}`);
    };
    await expect(
      rejection(h.roots(COWORK_HOME, sender())),
    ).resolves.toMatchObject({
      kind: 'conflict',
      code: 'worker.filesystem.roots.revisionConflict',
    });
    expect(h.daemon.queries).toHaveLength(2);
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it('retries once when the catalog changes between the reply and the guard', async () => {
    h = await createRouteHarness();
    resetWorkCounters();
    h.daemon.afterReply = async (_record, attempt): Promise<void> => {
      if (attempt === 1) await touchWorktreeRecord('single', 'later');
    };
    const { legacyResult } = await h.roots(SINGLE, sender());
    expect(legacyResult.roots[0]?.repoId).toBe('single');
    expect(h.daemon.queries).toHaveLength(2);
    expect(h.direct.roots).not.toHaveBeenCalled();
    expect(snapshotWorkCounters().route).toMatchObject({
      'files.roots.daemon.queries': 2,
      'files.roots.daemon.retries': 1,
      'files.roots.daemon.served': 1,
    });
  });

  it('returns a typed conflict after exactly two daemon queries', async () => {
    h = await createRouteHarness();
    let stamp = 0;
    h.daemon.afterReply = (): Promise<void> =>
      touchWorktreeRecord('single', `t${(stamp += 1)}`);
    for (const read of [
      (): Promise<unknown> => h.roots(SINGLE, sender()),
      (): Promise<unknown> => h.directory(SINGLE, 'single', '', sender()),
    ]) {
      const before = h.daemon.queries.length;
      const failure = await rejection(read());
      expect(failure.kind).toBe('conflict');
      expect(failure.code).toMatch(
        /^worker\.filesystem\.(roots|directory)\.revisionConflict$/,
      );
      expect(failure.retry).toEqual({
        kind: 'after_refresh',
        resource: 'filesystem-roots',
      });
      expect(h.daemon.queries.length - before).toBe(2);
    }
    expect(h.direct.roots).not.toHaveBeenCalled();
    expect(h.direct.directory).not.toHaveBeenCalled();
  });

  it('retries when a root is replaced at the same path', async () => {
    h = await createRouteHarness();
    const home = join(h.dataRoot, 'workspaces', 'single', 'worktrees', 'task');
    h.daemon.afterReply = async (_record, attempt): Promise<void> => {
      if (attempt !== 1) return;
      await rename(home, `${home}-old`);
      await mkdir(home);
    };
    await h.roots(SINGLE, sender());
    expect(h.daemon.queries).toHaveLength(2);
  });

  it('re-resolves an owner changed during projection', async () => {
    h = await createRouteHarness();
    h.daemon.afterReply = async (_record, attempt): Promise<void> => {
      if (attempt === 1)
        await rewriteWorkspace('single', (document) => ({
          ...document,
          owner: binding(TEAM_A),
        }));
    };
    await h.roots(SINGLE, sender());
    expect(h.daemon.queries).toHaveLength(2);
  });

  it('fails closed when the owner becomes malformed during projection', async () => {
    h = await createRouteHarness();
    h.daemon.afterReply = (): Promise<void> =>
      rewriteWorkspace('single', (document) => ({
        ...document,
        owner: { type: 'organization', organizationId: 'team-a' },
      }));
    await expect(rejection(h.roots(SINGLE, sender()))).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.roots.invalidState',
    });
    // The refresh re-resolved the owner locally and stopped before contact.
    expect(h.daemon.queries).toHaveLength(1);
  });

  it('discards a routed read when the flag turns off, and closes its session', async () => {
    h = await createRouteHarness();
    const hold = holdReplies(h.daemon);
    const local = sender();
    const read = rejection(h.roots(SINGLE, local));
    await hold.reached(1, read);
    const owner = h.connections.gets[0]?.owner;
    h.flag.set(false);
    hold.release();
    expect(await read).toEqual({
      kind: 'cancelled',
      message:
        'The Files read route changed while this read ran. Refresh and retry.',
      retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
    });
    expect(owner?.aborted).toBe(true);
    expect(h.connections.sessions[0]?.closed).toBe(true);
    // Off again: the next read is direct and the document was not retired.
    await h.roots(SINGLE, local);
    expect(h.direct.roots).toHaveBeenCalledTimes(1);
    expect(h.daemon.queries).toHaveLength(1);
  });

  it('discards a direct read that finishes after the flag turns on, without contact', async () => {
    h = await createRouteHarness({ flag: false });
    const hold = holdDirectRoots();
    const read = rejection(h.roots(SINGLE, sender()));
    await untilReached(hold.started, read);
    h.flag.set(true);
    hold.release();
    expect(await read).toMatchObject({
      kind: 'cancelled',
      retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
    });
    expectNoDaemonContact();
  });

  it.each([
    [
      'an excluded scope',
      { workspaceId: APP_ADVISOR_PROJECT_ID, worktreeId: 'task' },
      'local',
    ],
    [
      'an unregistered id',
      { workspaceId: 'never-seen', worktreeId: 'task' },
      'local',
    ],
    ['a remote bridge kept direct', SINGLE, 'bridge'],
  ] as const)(
    'keeps a direct read of %s whatever the flag does mid-read',
    async (_label, scope, who) => {
      h = await createRouteHarness({ flag: false });
      const hold = holdDirectRoots();
      const reader = sender();
      const caller =
        who === 'bridge'
          ? bridgeCaller(reader, 'controller-1')
          : localCaller(reader);
      const read = h.roots(scope, reader, caller).then(
        () => 'served',
        (error: unknown) =>
          error instanceof Error && /route changed/.test(error.message)
            ? 'discarded'
            : 'failed',
      );
      await untilReached(hold.started, read);
      h.flag.set(true);
      hold.release();
      expect(await read).not.toBe('discarded');
      expectNoDaemonContact();
    },
  );

  it('discards a read spanning an account reset that flips the flag off and on', async () => {
    h = await createRouteHarness();
    const hold = holdReplies(h.daemon);
    const read = rejection(h.roots(SINGLE, sender()));
    await hold.reached(1, read);
    h.flag.set(false);
    h.flag.set(true);
    hold.release();
    expect((await read).kind).toBe('cancelled');
  });

  it('fails typed when the backend connection changes during a read', async () => {
    h = await createRouteHarness();
    h.daemon.afterReply = (): Promise<void> => {
      h.connections.reattach();
      h.daemon.afterReply = null;
      return Promise.resolve();
    };
    await expect(rejection(h.roots(SINGLE, sender()))).resolves.toEqual({
      kind: 'unavailable',
      message: 'The desktop daemon connection changed. Retry the read.',
      retry: { kind: 'never' },
    });
    expect(h.daemon.queries).toHaveLength(1);
    // The next read attaches through the current backend.
    await h.roots(SINGLE, sender());
  });
});

describe('document lifetime', () => {
  it('reuses one owner and session across requests from one document', async () => {
    h = await createRouteHarness();
    const local = sender();
    await h.roots(SINGLE, local);
    await h.directory(SINGLE, 'single', '', local);
    await h.roots(MULTI, local);
    const owners = new Set(h.connections.gets.map((get) => get.owner));
    expect(owners.size).toBe(1);
    expect(h.connections.sessions).toHaveLength(1);
  });

  it('retires the document on a committed reload; the next read gets a new session', async () => {
    h = await createRouteHarness();
    const local = sender();
    await h.roots(SINGLE, local);
    const first = h.connections.gets[0]?.owner;
    local.emit('did-navigate', {}, 'app://index.html', 200, 'OK');
    expect(first?.aborted).toBe(true);
    expect(h.connections.sessions[0]?.closed).toBe(true);
    expect(local.retiringListeners()).toBe(0);
    await h.roots(SINGLE, local);
    expect(h.connections.gets[1]?.owner).not.toBe(first);
    expect(h.connections.sessions).toHaveLength(2);
  });

  it('keeps the document current through cancelled, same-document and subframe navigations', async () => {
    h = await createRouteHarness();
    const local = sender();
    await h.roots(SINGLE, local);
    const owner = h.connections.gets[0]?.owner;
    const hold = holdReplies(h.daemon);
    const pending = h.roots(SINGLE, local);
    await hold.reached(1, pending);
    expect(h.daemon.queries).toHaveLength(2);
    local.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    local.emit('will-navigate', { preventDefault: jest.fn() }, 'blocked://x');
    local.emit('did-navigate-in-page', {}, 'app://index.html#x', true);
    local.emit('did-frame-navigate', {}, 'app://frame', 200, 'OK', false);
    hold.release();
    await expect(pending).resolves.toBeDefined();
    expect(owner?.aborted).toBe(false);
    expect(h.connections.sessions).toHaveLength(1);
  });

  it('retires a read made between navigation start and commit when it commits', async () => {
    h = await createRouteHarness();
    const hold = holdReplies(h.daemon);
    const local = sender();
    local.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    const pending = rejection(h.roots(SINGLE, local));
    await hold.reached(1, pending);
    local.emit('did-navigate', {}, 'app://index.html', 200, 'OK');
    hold.release();
    expect(await pending).toEqual({
      kind: 'cancelled',
      message: 'The requesting window closed or reloaded.',
      retry: { kind: 'never' },
    });
    expect(h.direct.roots).not.toHaveBeenCalled();
  });

  it.each(['destroyed', 'render-process-gone'] as const)(
    'retires the document when the sender emits %s',
    async (event) => {
      h = await createRouteHarness();
      const local = sender();
      await h.roots(SINGLE, local);
      local.emit(event);
      expect(h.connections.gets[0]?.owner.aborted).toBe(true);
      expect(local.retiringListeners()).toBe(0);
    },
  );

  it('gives a new window with a reused numeric id its own owner and session', async () => {
    h = await createRouteHarness();
    const first = new FakeSender(9_001);
    await h.roots(SINGLE, first);
    first.destroy();
    const second = new FakeSender(9_001);
    await h.roots(SINGLE, second);
    expect(h.connections.gets.map((get) => get.caller)).toEqual([
      { ...localCaller(first), authorityId: AUTHORITY },
      { ...localCaller(second), authorityId: AUTHORITY },
    ]);
    expect(h.connections.gets[1]?.owner).not.toBe(h.connections.gets[0]?.owner);
    expect(h.connections.gets[0]?.owner.aborted).toBe(true);
    expect(h.connections.sessions[0]?.closed).toBe(true);
    expect(h.connections.sessions[1]?.closed).toBe(false);
  });

  it('closes every document at quit', async () => {
    h = await createRouteHarness();
    const local = sender();
    await h.roots(SINGLE, local);
    h.lifetime.disposeAll();
    expect(h.connections.gets[0]?.owner.aborted).toBe(true);
    expect(h.lifetime.ownerFor(sender()).aborted).toBe(true);
  });
});

describe('remote-control bridges', () => {
  // Remote-control bridge Files reads stay direct by Mike's decision; the
  // future remote topology is not chosen.
  it('keeps bridge roots and directory reads direct with the flag on, with zero daemon contact', async () => {
    h = await createRouteHarness();
    const bridge = sender();
    const caller = bridgeCaller(bridge, 'controller-1');
    const roots = await h.roots(SINGLE, bridge, caller);
    const listed = await h.directory(SINGLE, 'single', '', bridge, caller);
    expect(roots.legacyResult).toEqual(
      await listFileTreeRoots({ projectId: 'single', worktreeId: 'task' }),
    );
    expect(listed.legacyResult).toEqual(
      await listFileTreeDirectory({
        projectId: 'single',
        worktreeId: 'task',
        repoId: 'single',
        relativeDir: '',
      }),
    );
    expectNoDaemonContact();
    expect(h.direct.roots).toHaveBeenCalledTimes(1);
    expect(h.direct.directory).toHaveBeenCalledTimes(1);
    // Never a document owner: nothing listens to the bridge's lifetime.
    expect(bridge.retiringListeners()).toBe(0);
  });

  it('serves a bridge direct after a local read of the same scope, reusing no daemon session', async () => {
    h = await createRouteHarness();
    const local = sender();
    const bridge = sender();
    await h.roots(SINGLE, local);
    await h.directory(SINGLE, 'single', '', local);
    const factoryCalls = h.connectionsFactory.mock.calls.length;
    const hostCalls = h.hostContext.mock.calls.length;
    const gets = h.connections.gets.length;
    const queries = h.daemon.queries.length;
    const caller = bridgeCaller(bridge, 'controller-1');
    const roots = await h.roots(SINGLE, bridge, caller);
    const listed = await h.directory(SINGLE, 'single', '', bridge, caller);
    expect(roots.legacyResult).toEqual(
      await listFileTreeRoots({ projectId: 'single', worktreeId: 'task' }),
    );
    expect(listed.legacyResult).toEqual(
      await listFileTreeDirectory({
        projectId: 'single',
        worktreeId: 'task',
        repoId: 'single',
        relativeDir: '',
      }),
    );
    expect(h.connectionsFactory).toHaveBeenCalledTimes(factoryCalls);
    expect(h.hostContext).toHaveBeenCalledTimes(hostCalls);
    expect(h.connections.gets).toHaveLength(gets);
    expect(h.daemon.queries).toHaveLength(queries);
    expect(h.connections.sessions).toHaveLength(1);
    expect(h.connections.gets.map((get) => get.caller)).toEqual([
      { ...localCaller(local), authorityId: AUTHORITY },
      { ...localCaller(local), authorityId: AUTHORITY },
    ]);
    expect(h.direct.roots).toHaveBeenCalledTimes(1);
    expect(h.direct.directory).toHaveBeenCalledTimes(1);
    expect(bridge.retiringListeners()).toBe(0);
    // The local window keeps its daemon session.
    await h.roots(SINGLE, local);
    expect(h.daemon.queries).toHaveLength(queries + 1);
    expect(h.connections.sessions).toHaveLength(1);
  });
});

/** Holds the next direct roots read until `release`; `started` marks its call. */
function holdDirectRoots(): { started: Promise<void>; release(): void } {
  const gate = deferred();
  const started = deferred();
  const actual = h.direct.roots.getMockImplementation();
  h.direct.roots.mockImplementationOnce(async (request) => {
    started.resolve();
    await gate.promise;
    if (!actual) throw new Error('Expected the direct reader.');
    return actual(request);
  });
  return { started: started.promise, release: () => gate.resolve() };
}

describe('bounded production route evidence', () => {
  it('observes daemon service and effective generations but not harmless notifications', async () => {
    h = await createRouteHarness();
    const baseline = h.route.observe().cursor;
    const local = sender();
    await h.roots(SINGLE, local);
    expect(h.route.observe(baseline)).toMatchObject({
      complete: true,
      enabled: true,
      generation: 0,
    });
    expect(
      h.route
        .observe(baseline)
        .entries.map((event) => [event.phase, event.backend, event.senderId]),
    ).toEqual([
      ['started', 'daemon', local.id],
      ['success', 'daemon', local.id],
    ]);
    h.flag.set(true);
    expect(h.route.observe().generation).toBe(0);
    h.flag.set(false);
    expect(h.route.observe().generation).toBe(1);
    const off = h.route.observe().cursor;
    await h.roots(SINGLE, local);
    expect(h.route.observe(off).entries.map((event) => event.backend)).toEqual([
      'direct',
      'direct',
    ]);
    expect(JSON.stringify(h.route.observe(baseline))).not.toContain(h.dataRoot);
  });

  it('records a rejected mid-read result as failure, not a served response', async () => {
    h = await createRouteHarness();
    const gate = deferred();
    const reached = deferred();
    h.daemon.beforeReply = async (): Promise<void> => {
      reached.resolve();
      await gate.promise;
    };
    const baseline = h.route.observe().cursor;
    const pending = rejection(h.roots(SINGLE, sender()));
    await untilReached(reached.promise, pending);
    h.flag.set(false);
    gate.resolve();
    await pending;
    expect(
      h.route.observe(baseline).entries.map((event) => event.phase),
    ).toEqual(['started', 'failed']);
    expect(h.route.observe(baseline).generation).toBe(1);
  });
});

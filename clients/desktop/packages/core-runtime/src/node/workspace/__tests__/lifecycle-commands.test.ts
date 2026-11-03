import {
  hasHostAbsolutePath,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CoreWorktreeCommandResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcher } from '../../../runtime/types';
import { StorageWriteRefusedError } from '../../../storage';
import { IdentifierValidationError } from '../../identifiers';
import {
  W5CommitLogError,
  W5CommitRefusedError,
} from '../../w5/commit-log/errors';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../../w5/commit-log-file-store';
import {
  CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS,
  createCoreWorkspaceLifecycleHandlers,
  deriveCoreLifecycleOperationId,
  isCoreWorkspaceLifecycleCaller,
  type CoreWorkspaceLifecycleCommandName,
  type CoreWorkspaceLifecycleHost,
} from '../lifecycle-commands';
import {
  CoreLifecycleRefusedError,
  toCoreLifecycleWireError,
  type CoreLifecycleNamespace,
  type CoreLifecycleWireProfile,
} from '../lifecycle-wire-errors';

const USER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.write', 'core.worktree.write'],
};

type Calls = Array<[string, unknown]>;

function fakeHost(calls: Calls): CoreWorkspaceLifecycleHost {
  return {
    createWorkspace: (request) => {
      calls.push(['createWorkspace', request]);
      if (request.kind === 'unserved') return Promise.reject(request.refusal);
      return Promise.resolve({
        workspaceId: 'app',
        name: request.name,
        kind: request.workspaceKind,
      });
    },
    importWorkspace: (request) => {
      calls.push(['importWorkspace', request]);
      return Promise.reject(request.refusal);
    },
    createWorktree: (request) => {
      calls.push(['createWorktree', request]);
      if (request.kind === 'unserved') return Promise.reject(request.refusal);
      return Promise.resolve({
        workspaceId: request.workspaceId,
        worktreeId: 'wt-1',
        branchName: request.branch ?? 'wt-1',
        setupPhase: 'git-ready',
        status: 'completed',
      });
    },
    archiveWorktree: () => Promise.reject(new Error('Unexpected archive')),
    deleteWorkspace: () => Promise.reject(new Error('Unexpected delete')),
    deleteWorktree: () =>
      Promise.reject(new Error('Unexpected worktree delete')),
    restoreArchive: () => Promise.reject(new Error('Unexpected restore')),
  };
}

function dispatcherOver(host: CoreWorkspaceLifecycleHost): CanopyDispatcher {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createCoreWorkspaceLifecycleHandlers(host),
      streams: {},
    },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
}

function instruct(
  dispatcher: CanopyDispatcher,
  operation: CoreWorkspaceLifecycleCommandName,
  params: Record<string, unknown>,
  caller: CanopyCallerDescriptor = USER,
  key = 'k-1',
): Promise<unknown> {
  return dispatcher.instruction(
    operation,
    { ...params, _meta: { idempotencyKey: key } },
    { caller, metadata: { idempotencyKey: key } },
  );
}

const CREATE = {
  name: 'App',
  temporary: false,
  source: { kind: 'empty', workspaceKind: 'single_repo' },
};

describe('caller admission (Q8)', () => {
  it.each<[string, Partial<CanopyCallerDescriptor>, boolean]>([
    ['the local desktop user', {}, true],
    [
      'a paired controller through the IPC bridge (B5)',
      {
        principalId: 'remote-device:dev-1',
        clientInstanceId: 'remote-bridge:4',
      },
      true,
    ],
    ['the trusted core', { principalId: 'core', interfaceKind: 'mcp' }, true],
    [
      'a renderer relay surface',
      { principalId: 'local-desktop-renderer:main' },
      false,
    ],
    [
      'a Portal session',
      { clientInstanceId: 'portal-session:s-1', interfaceKind: 'portal' },
      false,
    ],
    [
      'a Portal-shaped session id on the desktop interface',
      { clientInstanceId: 'portal-session:s-1' },
      false,
    ],
    ['an agent principal', { principalId: 'agent-7' }, false],
    [
      'a remote device outside the desktop interface',
      { principalId: 'remote-device:dev-1', interfaceKind: 'mcp' },
      false,
    ],
  ])('%s: %s', (_name, overrides, admitted) => {
    expect(isCoreWorkspaceLifecycleCaller({ ...USER, ...overrides })).toBe(
      admitted,
    );
  });

  it.each<CoreWorkspaceLifecycleCommandName>([
    'core.workspace.create',
    'core.workspace.import',
    'core.worktree.create',
  ])(
    '%s refuses a relay surface with both grants before the host runs',
    async (operation) => {
      const calls: Calls = [];
      const dispatcher = dispatcherOver(fakeHost(calls));
      const params =
        operation === 'core.workspace.create'
          ? CREATE
          : operation === 'core.workspace.import'
            ? {
                source: { kind: 'git_url', value: 'https://x.dev/a' },
                name: 'a',
              }
            : { workspaceId: 'app' };
      expect(
        await failureOf(
          instruct(dispatcher, operation, params, {
            ...USER,
            principalId: 'local-desktop-renderer:main',
          }),
        ),
      ).toMatchObject({
        payload: { kind: 'permission_denied', retry: { kind: 'never' } },
      });
      expect(calls).toEqual([]);
    },
  );
});

describe('#1 core.workspace.create (A5, D-2)', () => {
  it.each(['single_repo', 'multi_repo'])(
    'serves an empty %s project and answers without revisions or times',
    async (workspaceKind) => {
      const calls: Calls = [];
      const result = await instruct(
        dispatcherOver(fakeHost(calls)),
        'core.workspace.create',
        {
          ...CREATE,
          source: { kind: 'empty', workspaceKind },
        },
      );
      expect(result).toEqual({
        workspace: {
          workspaceId: 'app',
          name: 'App',
          kind: workspaceKind,
          temporary: false,
          repositories: [],
        },
        operation: null,
      });
      expect(calls).toEqual([
        ['createWorkspace', { kind: 'empty', workspaceKind, name: 'App' }],
      ]);
    },
  );

  it.each<[string, Record<string, unknown>, string]>([
    ['a temporary project', { ...CREATE, temporary: true }, 'temporary'],
    [
      'a Cowork project',
      { ...CREATE, source: { kind: 'empty', workspaceKind: 'cowork' } },
      'source.workspaceKind',
    ],
    [
      'a local root grant (no portable-root service)',
      {
        ...CREATE,
        source: {
          kind: 'local_repository',
          rootGrantId: 'grant-1',
          workspaceKind: 'single_repo',
        },
      },
      'source.rootGrantId',
    ],
    [
      'remote repositories (the clone names itself)',
      {
        ...CREATE,
        source: {
          kind: 'remote_repositories',
          workspaceKind: 'single_repo',
          repositories: [
            { remoteUrl: 'https://github.com/a/b', defaultBranch: null },
          ],
        },
      },
      'source.repositories',
    ],
    [
      'integration resources',
      {
        ...CREATE,
        source: {
          kind: 'integration_resources',
          integrationId: 'i',
          resourceIds: ['r'],
          workspaceKind: 'single_repo',
        },
      },
      'source.integrationId',
    ],
  ])('answers %s capability_unavailable', async (_name, params, field) => {
    const calls: Calls = [];
    expect(
      await failureOf(
        instruct(
          dispatcherOver(fakeHost(calls)),
          'core.workspace.create',
          params,
        ),
      ),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'unserved', fields: [field] },
        retry: { kind: 'never' },
      },
    });
  });

  it('refuses an owner or organization in params before the handler (B7)', async () => {
    const calls: Calls = [];
    for (const extra of [
      { ownerOrganizationId: 'org-1' },
      { owner: { type: 'organization', organizationId: 'org-1' } },
    ])
      expect(
        await failureOf(
          instruct(dispatcherOver(fakeHost(calls)), 'core.workspace.create', {
            ...CREATE,
            ...extra,
          }),
        ),
      ).toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(calls).toEqual([]);
  });
});

describe('#2 core.workspace.import (A5)', () => {
  it.each<[Record<string, unknown>, string]>([
    [
      { kind: 'local_picker_selection', selectionId: 's-1' },
      'source.selectionId',
    ],
    [{ kind: 'git_url', value: 'https://github.com/a/b.git' }, 'source.value'],
    [{ kind: 'provider_project', value: 'p-1' }, 'source.value'],
  ])('answers the %o source capability_unavailable', async (source, field) => {
    const calls: Calls = [];
    expect(
      await failureOf(
        instruct(dispatcherOver(fakeHost(calls)), 'core.workspace.import', {
          source,
          name: 'b',
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { fields: [field] },
      },
    });
  });

  it('answers a non-null targetId capability_unavailable and takes null', async () => {
    const calls: Calls = [];
    const dispatcher = dispatcherOver(fakeHost(calls));
    const source = { kind: 'git_url', value: 'https://github.com/a/b.git' };
    expect(
      await failureOf(
        instruct(dispatcher, 'core.workspace.import', {
          source,
          name: 'b',
          targetId: 't-1',
        }),
      ),
    ).toMatchObject({ payload: { details: { fields: ['targetId'] } } });
    expect(
      await failureOf(
        instruct(dispatcher, 'core.workspace.import', {
          source,
          name: 'b',
          targetId: null,
        }),
      ),
    ).toMatchObject({ payload: { details: { fields: ['source.value'] } } });
  });

  it('answers an operation reference when a host serves it (DP-3)', async () => {
    const host: CoreWorkspaceLifecycleHost = {
      ...fakeHost([]),
      importWorkspace: () => Promise.resolve({ workspaceId: 'b' }),
    };
    await expect(
      instruct(dispatcherOver(host), 'core.workspace.import', {
        source: { kind: 'git_url', value: 'https://github.com/a/b.git' },
        name: 'b',
      }),
    ).resolves.toEqual({
      operationId: deriveCoreLifecycleOperationId(
        'local-desktop-user',
        'core.workspace.import',
        'k-1',
      ),
      kind: 'core.workspace.import',
      status: 'completed',
      workspaceId: 'b',
    });
  });
});

describe('#21 core.worktree.create (A5, DP-3)', () => {
  it('maps every served selector and answers a derived operation reference', async () => {
    const calls: Calls = [];
    const dispatcher = dispatcherOver(fakeHost(calls));
    const params = {
      workspaceId: 'app',
      branch: 'feature',
      baseBranch: 'main',
      includedRepositoryIds: ['api'],
      sidebarItemGroupId: 'grp-1',
      baseHeadSha: null,
      targetId: null,
    };
    const first = await instruct(dispatcher, 'core.worktree.create', params);
    expect(first).toEqual({
      operationId: deriveCoreLifecycleOperationId(
        'local-desktop-user',
        'core.worktree.create',
        'k-1',
      ),
      kind: 'core.worktree.create',
      status: 'completed',
      workspaceId: 'app',
      worktreeId: 'wt-1',
      branchName: 'feature',
      setupPhase: 'git-ready',
    });
    expect(calls[0]).toEqual([
      'createWorktree',
      {
        kind: 'worktree',
        workspaceId: 'app',
        branch: 'feature',
        baseBranch: 'main',
        includedRepositoryIds: ['api'],
        sidebarItemGroupId: 'grp-1',
      },
    ]);
    // The id is the principal's and the key's: a retry answers the same one.
    await expect(
      instruct(dispatcher, 'core.worktree.create', params),
    ).resolves.toEqual(first);
    const other = await instruct(dispatcher, 'core.worktree.create', params, {
      ...USER,
      principalId: 'remote-device:dev-1',
    });
    expect(other).toMatchObject({ kind: 'core.worktree.create' });
    expect(other).not.toEqual(first);
  });

  it.each<[Record<string, unknown>, string[]]>([
    [{ baseHeadSha: 'abc1234' }, ['baseHeadSha']],
    [{ targetId: 't-1' }, ['targetId']],
    [{ baseHeadSha: 'abc1234', targetId: 't-1' }, ['baseHeadSha', 'targetId']],
  ])('refuses %o capability_unavailable (B6)', async (extra, fields) => {
    const calls: Calls = [];
    expect(
      await failureOf(
        instruct(dispatcherOver(fakeHost(calls)), 'core.worktree.create', {
          workspaceId: 'app',
          ...extra,
        }),
      ),
    ).toMatchObject({
      payload: { kind: 'capability_unavailable', details: { fields } },
    });
  });

  it('answers a root that needs repair as a failed operation', async () => {
    const host: CoreWorkspaceLifecycleHost = {
      ...fakeHost([]),
      createWorktree: () =>
        Promise.resolve({
          workspaceId: 'app',
          worktreeId: 'wt-1',
          branchName: 'wt-1',
          setupPhase: 'git-pending',
          status: 'failed',
        }),
    };
    await expect(
      instruct(dispatcherOver(host), 'core.worktree.create', {
        workspaceId: 'app',
      }),
    ).resolves.toMatchObject({ status: 'failed', setupPhase: 'git-pending' });
  });
});

describe('A7: lifecycle refusals on the wire', () => {
  function wire(
    operation: CoreWorkspaceLifecycleCommandName,
    error: unknown,
  ): CanopyErrorPayload {
    const mapped = toCoreLifecycleWireError(
      CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS[operation],
      operation === 'core.worktree.create' ? 'core.worktree' : 'core.workspace',
      error,
    );
    if (!(mapped instanceof CanopyOperationError))
      throw new Error(`${operation}: not typed`);
    expect(
      CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS[operation].error.safeParse(
        mapped.payload,
      ).success,
    ).toBe(true);
    expect(hasHostAbsolutePath(mapped.payload.message)).toBe(false);
    expect(hasHostAbsolutePath(mapped.payload.details ?? null)).toBe(false);
    return mapped.payload;
  }

  it.each<[W5CommitRefusedError['reason'], string, string, string]>([
    ['key-reused', 'conflict', 'idempotencyKeyReused', 'never'],
    ['in-progress', 'unavailable', 'requestInProgress', 'same_idempotency_key'],
    ['recovery-required', 'failed_precondition', 'recoveryRequired', 'never'],
    ['outcome-expired', 'failed_precondition', 'outcomeExpired', 'never'],
    ['unapplied-change', 'failed_precondition', 'recoveryRequired', 'never'],
  ])(
    '%s: each create carries its namespace code and names it in details',
    (reason, kind, code, retry) => {
      const error = new W5CommitRefusedError(reason, 'Refused.', {
        reservationId: 'r-1',
      });
      expect(wire('core.worktree.create', error)).toEqual({
        kind,
        message: 'Refused.',
        code: `core.worktree.${code}`,
        details: { reason, reservationId: 'r-1' },
        retry: { kind: retry },
      });
      for (const operation of [
        'core.workspace.create',
        'core.workspace.import',
      ] as const) {
        const payload = wire(operation, error);
        expect(payload).toEqual({
          kind,
          message: 'Refused.',
          code: `core.workspace.${code}`,
          details: { reason, reservationId: 'r-1' },
          retry: { kind: retry },
        });
      }
    },
  );

  it('maps a host refusal by its shape, keeping a code the enum has', () => {
    const error = new CoreLifecycleRefusedError(
      'cowork-project',
      'A Cowork project has no worktrees.',
      { kind: 'failed_precondition', retry: 'never', code: 'invalidState' },
    );
    expect(wire('core.worktree.create', error)).toEqual({
      kind: 'failed_precondition',
      message: 'A Cowork project has no worktrees.',
      code: 'core.worktree.invalidState',
      details: { reason: 'cowork-project' },
      retry: { kind: 'never' },
    });
    expect(
      wire(
        'core.workspace.create',
        new CoreLifecycleRefusedError('index-unavailable', 'Try again.', {
          kind: 'failed_precondition',
          retry: 'refresh',
          code: 'invalidState',
        }),
      ),
    ).toMatchObject({
      code: 'core.workspace.invalidState',
      retry: { kind: 'after_refresh', resource: 'core.workspace.list' },
    });
  });

  it('keeps the host error as the runtime cause and strips paths', () => {
    const hostError = new Error('original');
    const mapped = toCoreLifecycleWireError(
      CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS['core.workspace.create'],
      'core.workspace',
      new CoreLifecycleRefusedError(
        'missing-folder',
        'Folder not found: /Users/me/secret',
        { kind: 'failed_precondition', retry: 'never', code: 'invalidState' },
        hostError,
      ),
    );
    if (!(mapped instanceof CanopyOperationError)) throw new Error('untyped');
    expect(mapped.runtimeCause).toBe(hostError);
    expect(mapped.payload.message).not.toContain('/Users/me');
  });

  it('types host failures and leaves the rest internal', () => {
    expect(
      wire('core.worktree.create', new IdentifierValidationError('Bad id')),
    ).toMatchObject({ kind: 'invalid_argument' });
    expect(
      wire(
        'core.worktree.create',
        new W5FileWriteRefusedError('/tmp/data/workspaces/a/worktrees.json'),
      ),
    ).toMatchObject({
      kind: 'conflict',
      code: 'core.worktree.revisionConflict',
      retry: { kind: 'after_refresh', resource: 'core.worktree.list' },
    });
    expect(
      wire(
        'core.workspace.create',
        new W5CommitLogError('STORAGE_UNAVAILABLE', 'Down.'),
      ),
    ).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'same_idempotency_key' },
    });
    expect(
      wire(
        'core.workspace.create',
        new StorageWriteRefusedError('workspace_index', 'x', 'unlisted_writer'),
      ),
    ).toMatchObject({ kind: 'capability_unavailable' });
    const untyped = new Error('boom');
    expect(
      toCoreLifecycleWireError(
        CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS['core.workspace.create'],
        'core.workspace',
        untyped,
      ),
    ).toBe(untyped);
  });
});

// W7b-2a (CAN-5550): archive #24, workspace delete #5 and archive restore #28.

const GRANTS: CanopyCallerDescriptor['grants'] = [
  'core.worktree.write',
  'core.workspace.write',
  'core.archive.write',
];

function caller(
  principalId: string,
  interfaceKind: CanopyCallerDescriptor['interfaceKind'] = 'desktop',
): CanopyCallerDescriptor {
  return {
    principalId,
    clientInstanceId: 'client-1',
    authorityId: 'local-desktop',
    interfaceKind,
    grants: GRANTS,
  };
}

const TEARDOWN_USER = caller('local-desktop-user');

const RESULT: CoreWorktreeCommandResult = {
  worktreeId: 'one',
  workspaceId: 'a',
  name: 'old',
  state: 'archived',
  baseBranch: null,
  branch: 'old',
  createdAt: '2026-11-01T00:00:00.000Z',
};

interface FakeHost extends CoreWorkspaceLifecycleHost {
  calls: Array<[string, unknown, unknown]>;
}

/** The W7b-2a commands' host; its creates are W7b-3's fake. */
function teardownHost(): FakeHost {
  const calls: FakeHost['calls'] = [];
  return {
    ...fakeHost([]),
    calls,
    archiveWorktree: (input, call) => {
      calls.push(['archive', input, call]);
      return Promise.resolve(RESULT);
    },
    deleteWorkspace: (input, call) => {
      calls.push(['delete', input, call]);
      return Promise.resolve();
    },
    deleteWorktree: (input, call) => {
      calls.push(['deleteWorktree', input, call]);
      return Promise.resolve();
    },
    restoreArchive: (input, call) => {
      calls.push(['restore', input, call]);
      return Promise.resolve({
        restoredScope: { workspaceId: input.workspaceId, worktreeId: 'new' },
      });
    },
  };
}

/** Any operation by name, as a wire caller sends it, keyed or not. */
function send(
  dispatcher: CanopyDispatcher,
  operation: CoreWorkspaceLifecycleCommandName,
  params: Record<string, unknown>,
  by: CanopyCallerDescriptor = TEARDOWN_USER,
): Promise<unknown> {
  const bound: unknown = dispatcher.instruction.bind(dispatcher);
  const call = bound as (
    name: string,
    params: Record<string, unknown>,
    options: {
      caller: CanopyCallerDescriptor;
      metadata?: { idempotencyKey: string };
    },
  ) => Promise<unknown>;
  const key = params._meta;
  return call(operation, params, {
    caller: by,
    ...(key !== undefined && { metadata: { idempotencyKey: 'key-1' } }),
  });
}

const ARCHIVE = { worktreeId: 'one', expectedRevision: 3, archived: true };
const DELETE = {
  workspaceId: 'a',
  expectedRevision: 2,
  _meta: { idempotencyKey: 'key-1' },
};
const DELETE_WORKTREE = {
  worktreeId: 'one',
  scope: { workspaceId: 'a' },
  expectedRevision: 0,
  _meta: { idempotencyKey: 'key-1' },
};
const RESTORE = {
  archiveId: 'archive-1',
  expectedRevision: 4,
  destinationScope: { workspaceId: 'a' },
  conflictPolicy: 'fail',
  _meta: { idempotencyKey: 'key-1' },
};
const TEARDOWNS: Array<
  [CoreWorkspaceLifecycleCommandName, Record<string, unknown>]
> = [
  ['core.worktree.archive', ARCHIVE],
  ['core.workspace.delete', DELETE],
  ['core.worktree.delete', DELETE_WORKTREE],
  ['core.archive.container.restore', RESTORE],
];

describe('the registered handlers keep operation-specific A7 profiles', () => {
  const operations: Array<
    [CoreWorkspaceLifecycleCommandName, Record<string, unknown>, string]
  > = [
    [
      'core.workspace.create',
      { ...CREATE, _meta: DELETE._meta },
      'core.workspace.list',
    ],
    [
      'core.workspace.import',
      {
        source: { kind: 'git_url', value: 'https://github.com/acme/app.git' },
        name: 'app',
        _meta: DELETE._meta,
      },
      'core.workspace.list',
    ],
    [
      'core.worktree.create',
      { workspaceId: 'a', _meta: DELETE._meta },
      'core.worktree.list',
    ],
    ['core.worktree.archive', ARCHIVE, 'core.worktree.get'],
    ['core.workspace.delete', DELETE, 'core.workspace.get'],
    ['core.worktree.delete', DELETE_WORKTREE, 'core.worktree.get'],
    ['core.archive.container.restore', RESTORE, 'core.worktree.list'],
  ];

  it.each(operations)(
    '%s isolates revision, recovery and retry policy',
    async (operation, params, refresh) => {
      let cause: Error = new W5RevisionConflictError('worktree:a/one', 3, 7);
      const fail = (): Promise<never> => Promise.reject(cause);
      const dispatcher = dispatcherOver({
        createWorkspace: fail,
        importWorkspace: fail,
        createWorktree: fail,
        archiveWorktree: fail,
        deleteWorkspace: fail,
        deleteWorktree: fail,
        restoreArchive: fail,
      });
      const conflict = await failureOf(send(dispatcher, operation, params));
      expect(conflict).toMatchObject({
        payload: {
          kind: 'conflict',
          details: {
            reason: 'revision-conflict',
            resource: 'worktree:a/one',
            expected: 3,
          },
          retry: { kind: 'after_refresh', resource: refresh },
        },
      });
      if (!(conflict instanceof CanopyOperationError))
        throw new Error('Untyped conflict');
      const isCreate =
        operation.endsWith('.create') || operation.endsWith('.import');
      if (isCreate)
        expect(conflict.payload.details).toHaveProperty('actual', 7);
      else expect(conflict.payload.details).not.toHaveProperty('actual');

      cause = new W5CommitRefusedError('unapplied-change', 'Needs recovery.');
      expect(
        await failureOf(send(dispatcher, operation, params)),
      ).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          details: {
            reason:
              operation === 'core.worktree.archive'
                ? 'recovery-required'
                : 'unapplied-change',
          },
          retry: { kind: 'never' },
        },
      });
      cause = new W5CommitLogError('WRITER_UNAVAILABLE', 'Unavailable.');
      expect(
        await failureOf(send(dispatcher, operation, params)),
      ).toMatchObject({
        payload: {
          kind: 'unavailable',
          retry: {
            kind:
              operation === 'core.worktree.archive'
                ? 'same_request'
                : 'same_idempotency_key',
          },
        },
      });
    },
  );
});

describe('Q8 for archive, delete and restore', () => {
  it.each([
    ['the local user', caller('local-desktop-user'), true],
    ['a paired remote device', caller('remote-device:device-1'), true],
    ['the desktop core', caller('core'), true],
    ['the renderer relay', caller('local-desktop-renderer:main'), false],
    ['a Portal session', caller('portal-session:s-1', 'portal'), false],
    ['an unlisted principal', caller('agent-7'), false],
    [
      'the local user outside the desktop',
      caller('local-desktop-user', 'portal'),
      false,
    ],
    ['an agent action', caller('local-desktop-user', 'mcp'), false],
  ])('%s', (_label, by, admitted) => {
    expect(isCoreWorkspaceLifecycleCaller(by)).toBe(admitted);
  });

  it.each(TEARDOWNS)(
    '%s refuses a refused caller before the host, despite its grants',
    async (operation, params) => {
      const host = teardownHost();
      for (const by of [
        caller('local-desktop-renderer:main'),
        caller('portal-session:s-1', 'portal'),
      ]) {
        const error = await failureOf(
          send(dispatcherOver(host), operation, params, by),
        );
        expect(error).toMatchObject({
          payload: {
            kind: 'permission_denied',
            details: { reason: 'caller-refused' },
            retry: { kind: 'never' },
          },
        });
      }
      expect(host.calls).toEqual([]);
    },
  );

  it.each(TEARDOWNS)(
    '%s without its grant is permission_denied before the handler',
    async (operation, params) => {
      const host = teardownHost();
      const error = await failureOf(
        send(dispatcherOver(host), operation, params, {
          ...TEARDOWN_USER,
          grants: ['core.worktree.read'],
        }),
      );
      expect(error).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(host.calls).toEqual([]);
    },
  );
});

describe('core.worktree.archive (#24)', () => {
  it('hands the host the target and answers its projection', async () => {
    const host = teardownHost();
    await expect(
      send(dispatcherOver(host), 'core.worktree.archive', {
        ...ARCHIVE,
        scope: { workspaceId: 'a' },
        expectedCreatedAt: RESULT.createdAt,
      }),
    ).resolves.toEqual(RESULT);
    expect(host.calls).toEqual([
      [
        'archive',
        {
          worktreeId: 'one',
          expectedRevision: 3,
          scope: { workspaceId: 'a' },
          expectedCreatedAt: RESULT.createdAt,
        },
        { caller: TEARDOWN_USER },
      ],
    ]);
  });

  it('D-6(1): archived:false is invalid_argument use-container-restore', async () => {
    const host = teardownHost();
    expect(
      await failureOf(
        send(dispatcherOver(host), 'core.worktree.archive', {
          ...ARCHIVE,
          archived: false,
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        details: { reason: 'use-container-restore' },
        retry: { kind: 'never' },
      },
    });
    expect(host.calls).toEqual([]);
  });
});

describe('core.worktree.delete (#25)', () => {
  it.each([
    ['key-reused', 'conflict', 'idempotencyKeyReused', 'never'],
    ['in-progress', 'unavailable', 'requestInProgress', 'same_idempotency_key'],
    ['recovery-required', 'failed_precondition', 'recoveryRequired', 'never'],
    ['outcome-expired', 'failed_precondition', 'outcomeExpired', 'never'],
  ] as const)(
    'maps %s onto the worktree keyed error page',
    async (reason, kind, code, retry): Promise<void> => {
      const host = teardownHost();
      host.deleteWorktree = (): Promise<void> =>
        Promise.reject(new W5CommitRefusedError(reason, 'Refused.'));
      expect(
        await failureOf(
          send(dispatcherOver(host), 'core.worktree.delete', DELETE_WORKTREE),
        ),
      ).toMatchObject({
        payload: {
          kind,
          code: `core.worktree.${code}`,
          details: { reason },
          retry: { kind: retry },
        },
      });
    },
  );

  it('projects only the served fields and returns a principal-scoped completed reference', async () => {
    const host = teardownHost();
    const result = await send(dispatcherOver(host), 'core.worktree.delete', {
      ...DELETE_WORKTREE,
      force: false,
      expectedCreatedAt: RESULT.createdAt,
    });
    expect(result).toEqual({
      operationId: deriveCoreLifecycleOperationId(
        'local-desktop-user',
        'core.worktree.delete',
        'key-1',
      ),
      kind: 'core.worktree.delete',
      status: 'completed',
    });
    expect(host.calls).toEqual([
      [
        'deleteWorktree',
        {
          worktreeId: 'one',
          scope: { workspaceId: 'a' },
          expectedRevision: 0,
          expectedCreatedAt: RESULT.createdAt,
        },
        { caller: TEARDOWN_USER, idempotencyKey: 'key-1' },
      ],
    ]);
    expect(
      await failureOf(
        send(dispatcherOver(host), 'core.worktree.delete', {
          ...DELETE_WORKTREE,
          force: true,
        }),
      ),
    ).toMatchObject({
      payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
    });
    expect(host.calls).toHaveLength(1);
  });
});

describe('core.workspace.delete (#5)', () => {
  it('DP-3: answers a completed operation reference derived as the web core derives it', async () => {
    const host = teardownHost();
    await expect(
      send(dispatcherOver(host), 'core.workspace.delete', DELETE),
    ).resolves.toEqual({
      // webCoreDerivedId('local-desktop-user', 'core.workspace.delete', 'key-1', 'operation')
      operationId: '472ee81c-958f-5e66-82f4-1b8eba6d109b',
      kind: 'core.workspace.delete',
      status: 'completed',
    });
    expect(host.calls).toEqual([
      [
        'delete',
        { workspaceId: 'a', expectedRevision: 2 },
        { caller: TEARDOWN_USER, idempotencyKey: 'key-1' },
      ],
    ]);
    expect(
      deriveCoreLifecycleOperationId(
        'remote-device:d',
        'core.workspace.delete',
        'key-1',
      ),
    ).not.toBe('472ee81c-958f-5e66-82f4-1b8eba6d109b');
  });

  it('B6: deleteRemoteBranches true is capability_unavailable; false is a no-op', async () => {
    const host = teardownHost();
    const dispatcher = dispatcherOver(host);
    expect(
      await failureOf(
        send(dispatcher, 'core.workspace.delete', {
          ...DELETE,
          deleteRemoteBranches: true,
        }),
      ),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'delete-remote-branches-unavailable' },
      },
    });
    expect(host.calls).toEqual([]);
    await expect(
      send(dispatcher, 'core.workspace.delete', {
        ...DELETE,
        deleteRemoteBranches: false,
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(host.calls).toHaveLength(1);
  });
});

describe('core.archive.container.restore (#28)', () => {
  it('restores into the named workspace and answers a completed operation', async () => {
    const host = teardownHost();
    await expect(
      send(dispatcherOver(host), 'core.archive.container.restore', {
        ...RESTORE,
        destinationScope: { workspaceId: 'a', authorityId: 'local-desktop' },
      }),
    ).resolves.toEqual({
      operation: {
        operationId: '36360b8f-59e4-59b4-aa8c-188b1b8f25a4',
        kind: 'core.archive.container.restore',
        status: 'completed',
      },
      restoredScope: { workspaceId: 'a', worktreeId: 'new' },
    });
    expect(host.calls).toEqual([
      [
        'restore',
        { archiveId: 'archive-1', workspaceId: 'a', expectedRevision: 4 },
        { caller: TEARDOWN_USER, idempotencyKey: 'key-1' },
      ],
    ]);
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    [
      'a destination without a workspace',
      { destinationScope: {} },
      'invalid_argument',
      'destination-workspace-required',
    ],
    [
      'a destination worktree',
      { destinationScope: { workspaceId: 'a', worktreeId: 'w' } },
      'capability_unavailable',
      'destination-unavailable',
    ],
    [
      'a foreign authority',
      { destinationScope: { workspaceId: 'a', authorityId: 'elsewhere' } },
      'capability_unavailable',
      'destination-unavailable',
    ],
    [
      'the merge policy',
      { conflictPolicy: 'merge' },
      'capability_unavailable',
      'conflict-policy-unavailable',
    ],
    [
      'the rename policy',
      { conflictPolicy: 'rename' },
      'capability_unavailable',
      'conflict-policy-unavailable',
    ],
  ])('refuses %s before the host', async (_label, change, kind, reason) => {
    const host = teardownHost();
    expect(
      await failureOf(
        send(dispatcherOver(host), 'core.archive.container.restore', {
          ...RESTORE,
          ...change,
        }),
      ),
    ).toMatchObject({
      payload: { kind, details: { reason }, retry: { kind: 'never' } },
    });
    expect(host.calls).toEqual([]);
  });
});

const PROFILES: Array<
  [
    CoreWorkspaceLifecycleCommandName,
    CoreLifecycleNamespace,
    string,
    CoreLifecycleWireProfile,
  ]
> = [
  [
    'core.worktree.archive',
    'core.worktree',
    'core.worktree.get',
    {
      namespace: 'core.worktree',
      refreshResource: 'core.worktree.get',
      withholdStoredRevision: true,
      oneRecoveryReason: true,
    },
  ],
  [
    'core.workspace.delete',
    'core.workspace',
    'core.workspace.get',
    {
      namespace: 'core.workspace',
      refreshResource: 'core.workspace.get',
      withholdStoredRevision: true,
    },
  ],
  [
    'core.archive.container.restore',
    'core.archive',
    'core.worktree.list',
    {
      namespace: 'core.archive',
      refreshResource: 'core.worktree.list',
      withholdStoredRevision: true,
    },
  ],
];

/** The page the handlers map an operation's failures with. */
function profileOf(
  operation: CoreWorkspaceLifecycleCommandName,
): CoreLifecycleWireProfile {
  const row = PROFILES.find(([name]) => name === operation);
  if (!row) throw new Error(`${operation}: no profile`);
  return row[3];
}

function teardownWire(
  operation: CoreWorkspaceLifecycleCommandName,
  error: unknown,
): CanopyErrorPayload {
  const definition = CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS[operation];
  const mapped = toCoreLifecycleWireError(
    definition,
    profileOf(operation),
    error,
  );
  if (!(mapped instanceof CanopyOperationError))
    throw new Error(`${operation}: not typed`);
  // The dispatcher keeps only payloads the definition's error schema accepts.
  expect(definition.error.safeParse(mapped.payload).success).toBe(true);
  expect(hasHostAbsolutePath(mapped.payload.message)).toBe(false);
  expect(hasHostAbsolutePath(mapped.payload.details ?? null)).toBe(false);
  return mapped.payload;
}

describe('A7: archive, delete and restore failures on the wire', () => {
  it('a host refusal takes its family code and keeps the host error as the cause', () => {
    const cause = new Error('Worktree not found.');
    const refusal = new CoreLifecycleRefusedError(
      'not-found',
      'Worktree not found.',
      { kind: 'not_found', retry: 'never', code: 'notFound' },
      cause,
    );
    const mapped = toCoreLifecycleWireError(
      CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS['core.worktree.archive'],
      profileOf('core.worktree.archive'),
      refusal,
    );
    expect(mapped).toBeInstanceOf(CanopyOperationError);
    if (!(mapped instanceof CanopyOperationError)) return;
    expect(mapped.runtimeCause).toBe(cause);
    expect(mapped.payload).toEqual({
      kind: 'not_found',
      code: 'core.worktree.notFound',
      message: 'Worktree not found.',
      details: { reason: 'not-found' },
      retry: { kind: 'never' },
    });
  });

  it('a busy archive is invalidState with an after_refresh of the worktree', () => {
    expect(
      teardownWire(
        'core.worktree.archive',
        new CoreLifecycleRefusedError('busy', 'A worktree is busy.', {
          kind: 'failed_precondition',
          retry: 'refresh',
          code: 'invalidState',
        }),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.worktree.invalidState',
      message: 'A worktree is busy.',
      details: { reason: 'busy' },
      retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
    });
  });

  it('a code the enum lacks is left out, and details.reason names the refusal', () => {
    // core.archive.* has no notFound; core.workspace.* no recoveryRequired.
    expect(
      teardownWire(
        'core.archive.container.restore',
        new CoreLifecycleRefusedError(
          'archive-not-found',
          'Archive not found.',
          {
            kind: 'not_found',
            retry: 'never',
            code: 'notFound',
          },
        ),
      ),
    ).toEqual({
      kind: 'not_found',
      message: 'Archive not found.',
      details: { reason: 'archive-not-found' },
      retry: { kind: 'never' },
    });
    expect(
      teardownWire(
        'core.workspace.delete',
        new W5CommitRefusedError('recovery-required', 'Needs recovery.', {
          reservationId: 'r-1',
        }),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      message: 'Needs recovery.',
      details: { reason: 'recovery-required', reservationId: 'r-1' },
      retry: { kind: 'never' },
    });
  });

  it('an expired archive is core.archive.expired', () => {
    expect(
      teardownWire(
        'core.archive.container.restore',
        new CoreLifecycleRefusedError('expired', 'This archive has expired.', {
          kind: 'failed_precondition',
          retry: 'never',
          code: 'expired',
        }),
      ),
    ).toMatchObject({ code: 'core.archive.expired', retry: { kind: 'never' } });
  });

  it.each(PROFILES)(
    '%s: a revision conflict never names the stored revision (DP-1)',
    (operation, namespace, refresh) => {
      for (const error of [
        new W5RevisionConflictError('worktree:a/one', 3, 7),
        new W5CommitRefusedError('revision-conflict', 'Changed.', {
          resource: 'worktree:a/one',
          expected: 3,
          actual: 7,
        }),
      ]) {
        const payload = teardownWire(operation, error);
        expect(payload).toMatchObject({
          kind: 'conflict',
          code: `${namespace}.revisionConflict`,
          details: {
            reason: 'revision-conflict',
            resource: 'worktree:a/one',
            expected: 3,
          },
          retry: { kind: 'after_refresh', resource: refresh },
        });
        expect(payload.details).not.toHaveProperty('actual');
      }
      expect(
        teardownWire(
          operation,
          new W5FileWriteRefusedError('/Users/me/a/worktrees.json'),
        ),
      ).toMatchObject({
        kind: 'conflict',
        details: { reason: 'concurrent-write' },
      });
    },
  );

  it('keyed commit refusals take the keyed codes where the enum has them', () => {
    const rows: Array<[W5CommitRefusedError, Partial<CanopyErrorPayload>]> = [
      [
        new W5CommitRefusedError('key-reused', 'Reused.'),
        {
          kind: 'conflict',
          code: 'core.archive.idempotencyKeyReused',
          retry: { kind: 'never' },
        },
      ],
      [
        new W5CommitRefusedError('in-progress', 'Running.', {
          reservationId: 'r',
        }),
        {
          kind: 'unavailable',
          code: 'core.archive.requestInProgress',
          retry: { kind: 'same_idempotency_key' },
        },
      ],
      [
        new W5CommitRefusedError('recovery-required', 'Recover.', {
          commitId: 4,
        }),
        {
          kind: 'failed_precondition',
          code: 'core.archive.recoveryRequired',
          details: { reason: 'recovery-required', commitId: 4 },
        },
      ],
      [
        new W5CommitRefusedError('unapplied-change', 'Unapplied.'),
        {
          code: 'core.archive.recoveryRequired',
          details: { reason: 'unapplied-change' },
        },
      ],
      [
        new W5CommitRefusedError('outcome-expired', 'Expired.', {
          commitId: 2,
        }),
        {
          kind: 'failed_precondition',
          code: 'core.archive.outcomeExpired',
        },
      ],
    ];
    for (const [error, payload] of rows)
      expect(
        teardownWire('core.archive.container.restore', error),
      ).toMatchObject(payload);
  });

  it('the inherent archive names both recovery classes recovery-required and retries the same request', () => {
    expect(
      teardownWire(
        'core.worktree.archive',
        new W5CommitRefusedError('unapplied-change', 'Unapplied.'),
      ),
    ).toMatchObject({
      code: 'core.worktree.recoveryRequired',
      details: { reason: 'recovery-required' },
      retry: { kind: 'never' },
    });
    expect(
      teardownWire(
        'core.worktree.archive',
        new W5CommitLogError('WRITER_UNAVAILABLE', 'Writer unavailable.'),
      ),
    ).toMatchObject({ kind: 'unavailable', retry: { kind: 'same_request' } });
    expect(
      teardownWire(
        'core.workspace.delete',
        new W5CommitLogError('WRITER_UNAVAILABLE', 'Writer unavailable.'),
      ),
    ).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'same_idempotency_key' },
    });
  });

  it('host failures keep their kinds; anything else stays untyped', () => {
    expect(
      teardownWire(
        'core.workspace.delete',
        new IdentifierValidationError('Invalid id'),
      ),
    ).toMatchObject({ kind: 'invalid_argument' });
    expect(
      teardownWire(
        'core.workspace.delete',
        new StorageWriteRefusedError('workspace_index', 'x', 'unlisted_writer'),
      ),
    ).toMatchObject({ kind: 'capability_unavailable' });
    const untyped = new Error('/Users/me/secret failed');
    expect(
      toCoreLifecycleWireError(
        CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS['core.workspace.delete'],
        profileOf('core.workspace.delete'),
        untyped,
      ),
    ).toBe(untyped);
  });

  it('a host failure reaches the dispatcher as internal, its typed refusal with its code', async () => {
    const host = teardownHost();
    host.archiveWorktree = (): Promise<never> =>
      Promise.reject(
        new CoreLifecycleRefusedError(
          'revision-unverified',
          "This worktree's revision can't be verified yet.",
          { kind: 'failed_precondition', retry: 'never', code: 'invalidState' },
        ),
      );
    host.deleteWorkspace = (): Promise<never> =>
      Promise.reject(new Error('/Users/me/secret failed'));
    const dispatcher = dispatcherOver(host);
    expect(
      await failureOf(send(dispatcher, 'core.worktree.archive', ARCHIVE)),
    ).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.worktree.invalidState',
        details: { reason: 'revision-unverified' },
      },
    });
    const internal = await failureOf(
      send(dispatcher, 'core.workspace.delete', DELETE),
    );
    expect(internal).toMatchObject({ payload: { kind: 'internal' } });
    if (internal instanceof CanopyOperationError)
      expect(internal.payload.message).not.toContain('/Users/me');
  });
});

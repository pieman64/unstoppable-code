import {
  hasHostAbsolutePath,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CoreWorkspacePluginsUpdateResult,
  type CoreWorktreeCommandResult,
  type CoreWorktreeHooksSetPausedResult,
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
import { W5CommitLogHostError } from '../../w5/commit-log-host';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../../w5/commit-log-file-store';
import { WorkspaceIndexUnreadableError } from '../../w5/workspace-index-repository';
import { ScriptHookSettingsRefusedError } from '../../w5/workspace-metadata/settings';
import {
  CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS,
  createCoreWorkspaceGuardedHandlers,
  type CoreWorkspaceGuardedCommandName,
  type CoreWorkspaceGuardedHost,
} from '../guarded-commands';
import {
  CoreGuardedRefusedError,
  toCoreGuardedWireError,
} from '../guarded-wire-errors';
import { CoreWorkspaceAddressRefusedError } from '../metadata-wire-errors';

const WORKSPACE_OPS = [
  'core.workspace.hooks.update',
  'core.workspace.plugins.update',
  'core.workspace.retention.update',
  'core.workspace.cowork.update',
] as const;
const WORKTREE_OPS = [
  'core.worktree.update',
  'core.worktree.reorder',
  'core.worktree.hooks.setPaused',
] as const;
const ALL: CoreWorkspaceGuardedCommandName[] = [
  ...WORKSPACE_OPS,
  ...WORKTREE_OPS,
];

const domain = (operation: string): string =>
  operation.startsWith('core.worktree.') ? 'core.worktree' : 'core.workspace';

const NEVER = { kind: 'never' } as const;
const SAME_KEY = { kind: 'same_idempotency_key' } as const;
const refresh = (operation: string): CanopyErrorPayload['retry'] => ({
  kind: 'after_refresh',
  resource:
    operation === 'core.worktree.reorder'
      ? 'core.worktree.list'
      : operation.startsWith('core.worktree.')
        ? 'core.worktree.get'
        : 'core.workspace.get',
});

function wire(
  operation: CoreWorkspaceGuardedCommandName,
  error: unknown,
): CanopyErrorPayload {
  const mapped = toCoreGuardedWireError(
    CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS[operation],
    operation,
    error,
  );
  if (!(mapped instanceof CanopyOperationError))
    throw new Error(`${operation}: not typed`);
  expect(mapped.runtimeCause).toBe(error);
  // The dispatcher keeps only payloads the definition's error schema accepts.
  expect(
    CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS[operation].error.safeParse(
      mapped.payload,
    ).success,
  ).toBe(true);
  expect(hasHostAbsolutePath(mapped.payload.message)).toBe(false);
  expect(hasHostAbsolutePath(mapped.payload.details ?? null)).toBe(false);
  return mapped.payload;
}

describe('A7: guarded refusals on the wire', () => {
  it.each(ALL)('%s: invalid requests are uncoded invalid_argument', (op) => {
    for (const error of [
      new CoreGuardedRefusedError('invalid-patch', 'Invalid patch.'),
      new ScriptHookSettingsRefusedError('invalid-request', 'Invalid hooks.'),
      new IdentifierValidationError('Invalid workspaceId'),
    ]) {
      const payload = wire(op, error);
      expect(payload).toMatchObject({
        kind: 'invalid_argument',
        message: error.message,
        retry: NEVER,
      });
      expect(payload.code).toBeUndefined();
    }
  });

  it.each(ALL)('%s: the four A7 key codes, in its own domain', (op) => {
    const refused = (
      reason: W5CommitRefusedError['reason'],
      details: Record<string, unknown> = {},
    ): CanopyErrorPayload =>
      wire(op, new W5CommitRefusedError(reason, `${reason}.`, details));
    expect(refused('key-reused', { commitId: 3 })).toEqual({
      kind: 'conflict',
      code: `${domain(op)}.idempotencyKeyReused`,
      message: 'key-reused.',
      details: { commitId: 3 },
      retry: NEVER,
    });
    expect(refused('in-progress', { reservationId: 'r' })).toEqual({
      kind: 'unavailable',
      code: `${domain(op)}.requestInProgress`,
      message: 'in-progress.',
      details: { reservationId: 'r' },
      retry: SAME_KEY,
    });
    expect(refused('recovery-required')).toMatchObject({
      kind: 'failed_precondition',
      code: `${domain(op)}.recoveryRequired`,
      retry: NEVER,
    });
    expect(refused('outcome-expired')).toMatchObject({
      kind: 'failed_precondition',
      code: `${domain(op)}.outcomeExpired`,
      retry: NEVER,
    });
    expect(
      refused('unapplied-change', { path: '/Users/me/w/a/worktrees.json' }),
    ).toEqual({
      kind: 'failed_precondition',
      code: `${domain(op)}.recoveryRequired`,
      message: 'unapplied-change.',
      details: { reason: 'unapplied-change' },
      retry: NEVER,
    });
  });

  it.each(ALL)('%s: revision and file conflicts refresh its read', (op) => {
    expect(wire(op, new W5RevisionConflictError('worktree:a/b', 1, 2))).toEqual(
      {
        kind: 'conflict',
        code: `${domain(op)}.revisionConflict`,
        message: 'This was changed since it was read. Reload and try again.',
        details: { resource: 'worktree:a/b', expected: 1, actual: 2 },
        retry: refresh(op),
      },
    );
    expect(
      wire(op, new W5FileWriteRefusedError('/Users/me/w/a/worktrees.json')),
    ).toEqual({
      kind: 'conflict',
      code: `${domain(op)}.revisionConflict`,
      message: 'This was changed since it was read. Reload and try again.',
      details: { reason: 'concurrent-write' },
      retry: refresh(op),
    });
  });

  it.each(ALL)('%s: host availability and storage refusals', (op) => {
    for (const code of ['STORAGE_UNAVAILABLE', 'WRITER_UNAVAILABLE'] as const)
      expect(wire(op, new W5CommitLogError(code, 'Log closed.'))).toMatchObject(
        { kind: 'unavailable', retry: SAME_KEY },
      );
    expect(
      wire(op, new W5CommitLogHostError('unavailable', 'Busy.')),
    ).toMatchObject({ kind: 'unavailable', retry: SAME_KEY });
    expect(
      wire(op, new W5CommitLogError('UNSUPPORTED_SCHEMA', 'Newer.')),
    ).toMatchObject({ kind: 'failed_precondition', retry: NEVER });
    expect(
      wire(
        op,
        new StorageWriteRefusedError('worktree_list', 'x', 'unlisted_writer'),
      ),
    ).toMatchObject({
      kind: 'capability_unavailable',
      details: { namespaceId: 'worktree_list', reason: 'unlisted_writer' },
      retry: NEVER,
    });
  });

  it.each(ALL)('%s: untyped failures and typed errors pass through', (op) => {
    const typed = new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'No.',
      retry: NEVER,
    });
    for (const error of [
      new Error('/Users/me/secret failed'),
      new W5CommitRefusedError('invalid-state', 'Bad state.'),
      new W5CommitLogHostError('outcome-unknown', 'Stopped.'),
      'not an error',
      typed,
    ])
      expect(
        toCoreGuardedWireError(
          CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS[op],
          op,
          error,
        ),
      ).toBe(error);
  });

  it.each([
    'core.workspace.hooks.update',
    'core.worktree.reorder',
    'core.worktree.hooks.setPaused',
  ] as const)('%s: the read-only viewer scope is readOnly', (op) => {
    for (const error of [
      new ScriptHookSettingsRefusedError('read-only-scope', 'Read-only.'),
      new CoreGuardedRefusedError('read-only-scope', 'Read-only.'),
    ])
      expect(wire(op, error)).toEqual({
        kind: 'failed_precondition',
        code: `${domain(op)}.readOnly`,
        message: 'Read-only.',
        details: { reason: 'read-only-scope' },
        retry: NEVER,
      });
  });

  it('#22 has no readOnly code: the scope is invalidState with its reason', () => {
    expect(
      wire(
        'core.worktree.update',
        new CoreGuardedRefusedError('read-only-scope', 'Read-only.'),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.worktree.invalidState',
      message: 'Read-only.',
      details: { reason: 'read-only-scope' },
      retry: NEVER,
    });
  });

  it('#7 names a missing repository; #11 and the worktree commands a missing resource', () => {
    expect(
      wire(
        'core.workspace.hooks.update',
        new ScriptHookSettingsRefusedError(
          'not-found',
          'Repo r not found in project a',
        ),
      ),
    ).toEqual({
      kind: 'not_found',
      code: 'core.workspace.repositoryNotFound',
      message: 'Repo r not found in project a',
      details: { reason: 'not-found' },
      retry: NEVER,
    });
    for (const op of [
      'core.workspace.plugins.update',
      'core.workspace.retention.update',
      'core.workspace.cowork.update',
      ...WORKTREE_OPS,
    ])
      for (const error of [
        new CoreGuardedRefusedError('not-found', 'Not found.'),
        new CoreWorkspaceAddressRefusedError('not-found', 'Not found.'),
      ])
        expect(
          wire(op as CoreWorkspaceGuardedCommandName, error),
        ).toMatchObject({
          kind: 'not_found',
          code: `${domain(op)}.notFound`,
          retry: NEVER,
        });
  });

  it('an unreadable manifest is configurationUnavailable on #7, #9, #11 and #12', () => {
    for (const op of WORKSPACE_OPS)
      for (const error of [
        new ScriptHookSettingsRefusedError('configuration-unavailable', 'X.'),
        new CoreGuardedRefusedError('configuration-unavailable', 'X.'),
        new CoreWorkspaceAddressRefusedError('configuration-unavailable', 'X.'),
      ])
        expect(wire(op, error)).toMatchObject({
          kind: 'failed_precondition',
          code: 'core.workspace.configurationUnavailable',
          retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
        });
  });

  it('#26 an unreadable list is listUnavailable, retried on its key', () => {
    expect(
      wire(
        'core.worktree.hooks.setPaused',
        new ScriptHookSettingsRefusedError('worktrees-unavailable', 'No list.'),
      ),
    ).toEqual({
      kind: 'unavailable',
      code: 'core.worktree.listUnavailable',
      message: 'No list.',
      details: { reason: 'worktrees-unavailable' },
      retry: SAME_KEY,
    });
  });

  it('#11 publishes its invalidState reasons', () => {
    expect(
      wire(
        'core.workspace.retention.update',
        new CoreGuardedRefusedError('unsupported-for-cowork', 'Cowork.'),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.invalidState',
      message: 'Cowork.',
      details: { reason: 'cowork_workspace' },
      retry: NEVER,
    });
    expect(
      wire(
        'core.workspace.retention.update',
        new CoreGuardedRefusedError('retention-busy', 'Busy.'),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.invalidState',
      message: 'Busy.',
      details: { reason: 'retention_busy' },
      retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
    });
  });

  it('#22 an unverified revision is invalidState revision-unverified, refreshable only while pending (DP-1)', () => {
    expect(
      wire(
        'core.worktree.update',
        new CoreGuardedRefusedError('revision-unverified', 'Unverified.'),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.worktree.invalidState',
      message: 'Unverified.',
      details: { reason: 'revision-unverified' },
      retry: NEVER,
    });
    expect(
      wire(
        'core.worktree.update',
        new CoreGuardedRefusedError('revision-pending', 'Pending.'),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.worktree.invalidState',
      message: 'Pending.',
      details: { reason: 'revision-unverified' },
      retry: { kind: 'after_refresh', resource: 'core.worktree.get' },
    });
  });

  it('addressing: duplicates and ambiguity are invalid_argument, an unselectable scope capability_unavailable', () => {
    expect(
      wire(
        'core.workspace.retention.update',
        new CoreWorkspaceAddressRefusedError('duplicate-workspace', 'Twice.'),
      ),
    ).toEqual({
      kind: 'invalid_argument',
      message: 'Twice.',
      details: { reason: 'duplicate-workspace' },
      retry: NEVER,
    });
    expect(
      wire(
        'core.worktree.update',
        new CoreGuardedRefusedError(
          'ambiguous-worktree',
          'Workspace scope required for ambiguous worktree ID.',
        ),
      ),
    ).toEqual({
      kind: 'invalid_argument',
      message: 'Workspace scope required for ambiguous worktree ID.',
      details: { reason: 'ambiguous-worktree' },
      retry: NEVER,
    });
    expect(
      wire(
        'core.worktree.update',
        new CoreGuardedRefusedError('scope-unavailable', 'Unavailable.'),
      ),
    ).toEqual({
      kind: 'capability_unavailable',
      message: 'Unavailable.',
      details: { reason: 'scope-unavailable' },
      retry: NEVER,
    });
  });

  it('#12 publishes a failed Auto Delete stamp as invalidState, retried on its key', () => {
    expect(
      wire(
        'core.workspace.cowork.update',
        new CoreGuardedRefusedError(
          'activity-unavailable',
          'Cannot read /Users/me/w/one/work-entries.json',
        ),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.invalidState',
      message: 'This change was refused.',
      details: { reason: 'activity_unavailable' },
      retry: SAME_KEY,
    });
  });

  it("#12's page reads an unreadable index as unavailable configuration", () => {
    for (const error of [
      new WorkspaceIndexUnreadableError(),
      new CoreWorkspaceAddressRefusedError('index-unavailable', 'No index.'),
      new CoreGuardedRefusedError('index-unavailable', 'No index.'),
    ])
      expect(wire('core.workspace.cowork.update', error)).toMatchObject({
        kind: 'failed_precondition',
        code: 'core.workspace.configurationUnavailable',
        details: { reason: 'index-unavailable' },
        retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
      });
  });

  it('an unreadable index is invalidState where the enum has it, uncoded elsewhere', () => {
    for (const op of [
      'core.workspace.retention.update',
      'core.worktree.update',
    ])
      expect(
        wire(
          op as CoreWorkspaceGuardedCommandName,
          new WorkspaceIndexUnreadableError(),
        ),
      ).toMatchObject({
        kind: 'failed_precondition',
        code: `${domain(op)}.invalidState`,
        details: { reason: 'index-unavailable' },
        retry: refresh(op),
      });
    for (const op of [
      'core.workspace.hooks.update',
      'core.workspace.plugins.update',
      'core.worktree.reorder',
      'core.worktree.hooks.setPaused',
    ] as const) {
      const payload = wire(
        op,
        new CoreWorkspaceAddressRefusedError('index-unavailable', 'No list.'),
      );
      expect(payload.code).toBeUndefined();
      expect(payload).toMatchObject({
        kind: 'failed_precondition',
        details: { reason: 'index-unavailable' },
      });
    }
  });

  it('replaces a message that can name a host path', () => {
    expect(
      wire(
        'core.worktree.update',
        new CoreGuardedRefusedError(
          'invalid-patch',
          'Cannot read /Users/me/w/a/worktrees.json',
        ),
      ).message,
    ).toBe('This change was refused.');
  });
});

function caller(
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor {
  return {
    principalId: 'agent',
    clientInstanceId: 'client',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants,
  };
}

type GuardedDispatcher = CanopyDispatcher<
  Record<never, never>,
  typeof CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS,
  Record<never, never>
>;

const WORKTREE: CoreWorktreeCommandResult = {
  worktreeId: 'wt',
  workspaceId: 'a',
  name: 'Mine',
  state: 'ready',
  baseBranch: null,
  branch: 'feature',
  createdAt: '2026-01-01',
};
const PAUSED: CoreWorktreeHooksSetPausedResult = {
  worktree: { id: 'wt', branchName: 'feature', createdAt: '2026-01-01' },
  pausedHookKeys: ['project:manual'],
  changed: true,
};

const PLUGINS: CoreWorkspacePluginsUpdateResult = {
  workspaceId: 'a',
  written: true,
  defaultPluginSelections: {
    collectionIds: [],
    skillRefs: [{ sourceId: 'source', skillName: 'skill' }],
    pluginRefs: [],
  },
  recommendedPluginOptOutKeys: [],
};

type Host = CoreWorkspaceGuardedHost;
type FakeHost = { [K in keyof Host]: jest.MockedFunction<Host[K]> };

function fakeHost(): FakeHost {
  return {
    updateHooks: jest.fn<
      ReturnType<Host['updateHooks']>,
      Parameters<Host['updateHooks']>
    >(() => Promise.resolve()),
    updatePlugins: jest.fn<
      ReturnType<Host['updatePlugins']>,
      Parameters<Host['updatePlugins']>
    >(() => Promise.resolve(PLUGINS)),
    updateRetention: jest.fn<
      ReturnType<Host['updateRetention']>,
      Parameters<Host['updateRetention']>
    >(() =>
      Promise.resolve({ workspaceId: 'a', activityBaselineRecorded: false }),
    ),
    updateCoworkSettings: jest.fn<
      ReturnType<Host['updateCoworkSettings']>,
      Parameters<Host['updateCoworkSettings']>
    >(() => Promise.resolve({ workspaceId: 'a' })),
    updateWorktree: jest.fn<
      ReturnType<Host['updateWorktree']>,
      Parameters<Host['updateWorktree']>
    >(() => Promise.resolve(WORKTREE)),
    reorderWorktree: jest.fn<
      ReturnType<Host['reorderWorktree']>,
      Parameters<Host['reorderWorktree']>
    >(() => Promise.resolve()),
    setWorktreeHooksPaused: jest.fn<
      ReturnType<Host['setWorktreeHooksPaused']>,
      Parameters<Host['setWorktreeHooksPaused']>
    >(() => Promise.resolve(PAUSED)),
  };
}

function dispatcherOver(host: Host): GuardedDispatcher {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createCoreWorkspaceGuardedHandlers(host),
      streams: {},
    },
  });
}

/** Any operation by name, as a wire caller sends it. */
function instruct(
  dispatcher: GuardedDispatcher,
  operation: CoreWorkspaceGuardedCommandName,
  params: Record<string, unknown>,
  grants: CanopyCallerDescriptor['grants'],
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
    { ...params, _meta: { idempotencyKey: 'key-1' } },
    { caller: caller(grants), metadata: { idempotencyKey: 'key-1' } },
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

const PARAMS: Record<
  CoreWorkspaceGuardedCommandName,
  Record<string, unknown>
> = {
  'core.workspace.hooks.update': {
    workspaceId: 'a',
    change: { kind: 'replace', hooks: {} },
  },
  'core.workspace.plugins.update': {
    workspaceId: 'a',
    change: {
      kind: 'selectRecommended',
      selections: [{ kind: 'skill', sourceId: 'source', skillName: 'skill' }],
      optOutKeys: [],
      clearOptOutKeys: ['skill:source/skill'],
    },
  },
  'core.workspace.retention.update': {
    workspaceId: 'a',
    patch: { archiveRetentionDays: 7 },
  },
  'core.workspace.cowork.update': {
    workspaceId: 'a',
    settings: { description: 'Notes', startPage: null },
  },
  'core.worktree.update': {
    worktreeId: 'wt',
    expectedRevision: 2,
    patch: { pinned: true },
  },
  'core.worktree.reorder': {
    workspaceId: 'a',
    activeWorktreeId: 'wt',
    overWorktreeId: 'other',
  },
  'core.worktree.hooks.setPaused': {
    workspaceId: 'a',
    worktreeId: 'wt',
    change: { kind: 'pause', hookKeys: ['project:manual'] },
  },
};

const GRANT: Record<
  CoreWorkspaceGuardedCommandName,
  CanopyCallerDescriptor['grants'][number]
> = {
  'core.workspace.hooks.update': 'core.workspace.write',
  'core.workspace.plugins.update': 'core.workspace.write',
  'core.workspace.retention.update': 'core.workspace.write',
  'core.workspace.cowork.update': 'core.workspace.write',
  'core.worktree.update': 'core.worktree.write',
  'core.worktree.reorder': 'core.worktree.write',
  'core.worktree.hooks.setPaused': 'core.worktree.write',
};

const HOST_METHOD: Record<CoreWorkspaceGuardedCommandName, keyof Host> = {
  'core.workspace.hooks.update': 'updateHooks',
  'core.workspace.plugins.update': 'updatePlugins',
  'core.workspace.retention.update': 'updateRetention',
  'core.workspace.cowork.update': 'updateCoworkSettings',
  'core.worktree.update': 'updateWorktree',
  'core.worktree.reorder': 'reorderWorktree',
  'core.worktree.hooks.setPaused': 'setWorktreeHooksPaused',
};

describe('the registered handlers', () => {
  it.each(ALL)(
    '%s needs its own write grant before the host runs',
    async (op) => {
      const host = fakeHost();
      const dispatcher = dispatcherOver(host);
      // The other domain's write grant does not authorize it.
      const other =
        GRANT[op] === 'core.workspace.write'
          ? 'core.worktree.write'
          : 'core.workspace.write';
      for (const grants of [[], ['core.workspace.read', other]] as const)
        expect(
          await failureOf(instruct(dispatcher, op, PARAMS[op], [...grants])),
        ).toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(host[HOST_METHOD[op]]).not.toHaveBeenCalled();
      await expect(
        instruct(dispatcher, op, PARAMS[op], [GRANT[op]]),
      ).resolves.toBeDefined();
      expect(host[HOST_METHOD[op]]).toHaveBeenCalledTimes(1);
      expect(host[HOST_METHOD[op]].mock.calls[0]?.[1]).toEqual({
        caller: caller([GRANT[op]]),
        idempotencyKey: 'key-1',
      });
    },
  );

  it('#7, #23: an empty result; #11, #26: the host outcome', async () => {
    const host = fakeHost();
    const dispatcher = dispatcherOver(host);
    const run = (op: CoreWorkspaceGuardedCommandName): Promise<unknown> =>
      instruct(dispatcher, op, PARAMS[op], [GRANT[op]]);
    await expect(run('core.workspace.hooks.update')).resolves.toEqual({});
    await expect(run('core.worktree.reorder')).resolves.toEqual({});
    await expect(run('core.workspace.retention.update')).resolves.toEqual({
      workspaceId: 'a',
      activityBaselineRecorded: false,
    });
    await expect(run('core.worktree.hooks.setPaused')).resolves.toEqual(PAUSED);
    await expect(run('core.worktree.update')).resolves.toEqual(WORKTREE);
    expect(host.updateHooks.mock.calls[0]?.[0]).toEqual({
      workspaceId: 'a',
      change: { kind: 'replace', hooks: {} },
    });
    expect(host.reorderWorktree.mock.calls[0]?.[0]).toEqual({
      workspaceId: 'a',
      activeWorktreeId: 'wt',
      overWorktreeId: 'other',
    });
  });

  it('#9 and #12: the host outcome, from the change and settings the wire carries', async () => {
    const host = fakeHost();
    const dispatcher = dispatcherOver(host);
    await expect(
      instruct(
        dispatcher,
        'core.workspace.plugins.update',
        { ...PARAMS['core.workspace.plugins.update'], expectedRevision: 3 },
        ['core.workspace.write'],
      ),
    ).resolves.toEqual(PLUGINS);
    expect(host.updatePlugins.mock.calls[0]?.[0]).toEqual({
      workspaceId: 'a',
      expectedRevision: 3,
      change: PARAMS['core.workspace.plugins.update'].change,
    });
    await expect(
      instruct(
        dispatcher,
        'core.workspace.cowork.update',
        PARAMS['core.workspace.cowork.update'],
        ['core.workspace.write'],
      ),
    ).resolves.toEqual({ workspaceId: 'a' });
    expect(host.updateCoworkSettings.mock.calls[0]?.[0]).toEqual({
      workspaceId: 'a',
      settings: { description: 'Notes', startPage: null },
    });
  });

  it("#12 refuses a field A28'(a) gives another operation before the host", async () => {
    const host = fakeHost();
    for (const field of [
      { name: 'Renamed' },
      { color: '#EF4444' },
      { alwaysShow: true },
      {
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
      },
    ])
      expect(
        await failureOf(
          instruct(
            dispatcherOver(host),
            'core.workspace.cowork.update',
            { workspaceId: 'a', settings: field },
            ['core.workspace.write'],
          ),
        ),
      ).toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(host.updateCoworkSettings).not.toHaveBeenCalled();
  });

  it('#22 passes its scope, revision and patch, and drops a null targetId', async () => {
    const host = fakeHost();
    const dispatcher = dispatcherOver(host);
    await instruct(
      dispatcher,
      'core.worktree.update',
      {
        scope: { workspaceId: 'a' },
        worktreeId: 'wt',
        expectedRevision: 4,
        patch: { label: 'Mine', targetId: null },
      },
      ['core.worktree.write'],
    );
    expect(host.updateWorktree.mock.calls[0]?.[0]).toEqual({
      scope: { workspaceId: 'a' },
      worktreeId: 'wt',
      expectedRevision: 4,
      patch: { label: 'Mine' },
    });
  });

  it('#22 refuses a routed targetId, and a patch it leaves empty, before the host', async () => {
    const host = fakeHost();
    const dispatcher = dispatcherOver(host);
    const update = (patch: Record<string, unknown>): Promise<unknown> =>
      instruct(
        dispatcher,
        'core.worktree.update',
        { worktreeId: 'wt', expectedRevision: 4, patch },
        ['core.worktree.write'],
      );
    expect(
      await failureOf(update({ pinned: true, targetId: 'remote' })),
    ).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'target-unavailable' },
        retry: NEVER,
      },
    });
    expect(await failureOf(update({ targetId: null }))).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'Patch is empty.',
        retry: NEVER,
      },
    });
    // The schema refuses an empty patch, and #22's required revision.
    expect(await failureOf(update({}))).toMatchObject({
      payload: { kind: 'invalid_argument' },
    });
    expect(
      await failureOf(
        instruct(
          dispatcher,
          'core.worktree.update',
          { worktreeId: 'wt', patch: { pinned: true } },
          ['core.worktree.write'],
        ),
      ),
    ).toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(host.updateWorktree).not.toHaveBeenCalled();
  });

  it('#23 refuses group membership as an unknown field', async () => {
    const host = fakeHost();
    expect(
      await failureOf(
        instruct(
          dispatcherOver(host),
          'core.worktree.reorder',
          { ...PARAMS['core.worktree.reorder'], sidebarItemGroupId: 'grp-a' },
          ['core.worktree.write'],
        ),
      ),
    ).toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(host.reorderWorktree).not.toHaveBeenCalled();
  });

  it('answers a typed refusal with its page shape and the boundary error as cause', async () => {
    const host = fakeHost();
    const refusal = new ScriptHookSettingsRefusedError(
      'worktrees-unavailable',
      'No list.',
    );
    host.setWorktreeHooksPaused.mockRejectedValueOnce(refusal);
    const error = await failureOf(
      instruct(
        dispatcherOver(host),
        'core.worktree.hooks.setPaused',
        PARAMS['core.worktree.hooks.setPaused'],
        ['core.worktree.write'],
      ),
    );
    expect(error).toBeInstanceOf(CanopyOperationError);
    expect(error).toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.worktree.listUnavailable',
        retry: SAME_KEY,
      },
      runtimeCause: refusal,
    });
  });

  it('an untyped host failure is internal', async () => {
    const host = fakeHost();
    host.updateRetention.mockRejectedValueOnce(new Error('/Users/me/x'));
    expect(
      await failureOf(
        instruct(
          dispatcherOver(host),
          'core.workspace.retention.update',
          PARAMS['core.workspace.retention.update'],
          ['core.workspace.write'],
        ),
      ),
    ).toMatchObject({ payload: { kind: 'internal' } });
  });
});

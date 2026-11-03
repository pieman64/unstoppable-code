import {
  hasHostAbsolutePath,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CoreWorkspaceScriptsChange,
  type CoreWorkspaceUpdateResult,
} from '@canopy/protocol/canopy-core';
import { normalizeWorkspacePlanDetection } from '@canopy/protocol/plan-detection';
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
import { WorkspaceConfigUnreadableError } from '../../w5/workspace-manifest-repository';
import { WorkspaceMetadataRefusedError } from '../../w5/workspace-metadata/metadata';
import { WorkspacePrivateMemoryRefusedError } from '../../w5/workspace-metadata/private-memory';
import { WorkspaceRepositoryRefusedError } from '../../w5/workspace-metadata/repositories';
import { ScriptHookSettingsRefusedError } from '../../w5/workspace-metadata/settings';
import {
  CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
  createCoreWorkspaceMetadataHandlers,
  type CoreWorkspaceMetadataCommandName,
  type CoreWorkspaceMetadataHost,
} from '../metadata-commands';
import {
  CoreWorkspaceAddressRefusedError,
  toCoreWorkspaceMetadataWireError,
} from '../metadata-wire-errors';

const ALL: CoreWorkspaceMetadataCommandName[] = [
  'core.workspace.update',
  'core.workspace.reorder',
  'core.workspace.scripts.update',
  'core.workspace.planDetection.update',
  'core.workspace.privateMemory.update',
  'core.workspace.repository.add',
  'core.workspace.repository.remove',
];

function wire(
  operation: CoreWorkspaceMetadataCommandName,
  error: unknown,
): CanopyErrorPayload {
  const mapped = toCoreWorkspaceMetadataWireError(
    CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS[operation],
    operation,
    error,
  );
  if (!(mapped instanceof CanopyOperationError))
    throw new Error(`${operation}: not typed`);
  expect(mapped.runtimeCause).toBe(error);
  // The dispatcher keeps only payloads the definition's error schema accepts.
  expect(
    CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS[operation].error.safeParse(
      mapped.payload,
    ).success,
  ).toBe(true);
  expect(hasHostAbsolutePath(mapped.payload.message)).toBe(false);
  expect(hasHostAbsolutePath(mapped.payload.details ?? null)).toBe(false);
  return mapped.payload;
}

const NEVER = { kind: 'never' } as const;
const SAME_KEY = { kind: 'same_idempotency_key' } as const;
const refresh = (operation: string): CanopyErrorPayload['retry'] => ({
  kind: 'after_refresh',
  resource:
    operation === 'core.workspace.reorder'
      ? 'core.workspace.list'
      : 'core.workspace.get',
});

describe('A7: W5 refusals on the wire', () => {
  it.each(ALL)('%s: invalid requests are invalid_argument', (operation) => {
    for (const error of [
      new WorkspaceMetadataRefusedError('invalid-patch', 'Invalid color.'),
      new ScriptHookSettingsRefusedError('invalid-request', 'Invalid script.'),
      new IdentifierValidationError('Invalid workspaceId'),
    ])
      expect(wire(operation, error)).toMatchObject({
        kind: 'invalid_argument',
        message: error.message,
        retry: NEVER,
      });
  });

  it.each(ALL)(
    '%s: RR5 duplicate rows are invalid_argument with no code',
    (operation) => {
      const payload = wire(
        operation,
        new CoreWorkspaceAddressRefusedError('duplicate-workspace', 'Twice.'),
      );
      expect(payload).toEqual({
        kind: 'invalid_argument',
        message: 'Twice.',
        details: { reason: 'duplicate-workspace' },
        retry: NEVER,
      });
    },
  );

  it.each(ALL)('%s: storage refusals are capability_unavailable', (op) => {
    expect(
      wire(
        op,
        new StorageWriteRefusedError('workspace_index', 'x', 'unlisted_writer'),
      ),
    ).toMatchObject({
      kind: 'capability_unavailable',
      details: { namespaceId: 'workspace_index', reason: 'unlisted_writer' },
      retry: NEVER,
    });
  });

  it.each(ALL)('%s: commit-log availability', (operation) => {
    for (const code of ['STORAGE_UNAVAILABLE', 'WRITER_UNAVAILABLE'] as const)
      expect(
        wire(operation, new W5CommitLogError(code, 'Log closed.')),
      ).toMatchObject({ kind: 'unavailable', retry: SAME_KEY });
    expect(
      wire(operation, new W5CommitLogHostError('unavailable', 'Busy.')),
    ).toMatchObject({ kind: 'unavailable', retry: SAME_KEY });
    expect(
      wire(operation, new W5CommitLogError('UNSUPPORTED_SCHEMA', 'Newer.')),
    ).toMatchObject({ kind: 'failed_precondition', retry: NEVER });
  });

  it.each(ALL)('%s: revision and file conflicts', (operation) => {
    expect(
      wire(operation, new W5RevisionConflictError('workspace:a', 1, 2)),
    ).toEqual({
      kind: 'conflict',
      code: 'core.workspace.revisionConflict',
      message: 'This was changed since it was read. Reload and try again.',
      details: { resource: 'workspace:a', expected: 1, actual: 2 },
      retry: refresh(operation),
    });
    expect(
      wire(operation, new W5FileWriteRefusedError('/Users/me/w/index.json')),
    ).toEqual({
      kind: 'conflict',
      code: 'core.workspace.revisionConflict',
      message: 'This was changed since it was read. Reload and try again.',
      details: { reason: 'concurrent-write' },
      retry: refresh(operation),
    });
  });

  it.each(ALL)('%s: keyed and recovery refusals', (operation) => {
    const refused = (
      reason: W5CommitRefusedError['reason'],
      details: Record<string, unknown> = {},
    ): CanopyErrorPayload =>
      wire(operation, new W5CommitRefusedError(reason, `${reason}.`, details));
    expect(refused('key-reused', { commitId: 3 })).toEqual({
      kind: 'conflict',
      code: 'core.workspace.idempotencyKeyReused',
      message: 'key-reused.',
      details: { commitId: 3 },
      retry: NEVER,
    });
    expect(refused('in-progress', { reservationId: 'r' })).toEqual({
      kind: 'unavailable',
      code: 'core.workspace.requestInProgress',
      message: 'in-progress.',
      details: { reservationId: 'r' },
      retry: SAME_KEY,
    });
    expect(refused('recovery-required')).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.workspace.recoveryRequired',
      retry: NEVER,
    });
    expect(refused('outcome-expired')).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.workspace.outcomeExpired',
      retry: NEVER,
    });
    // The path the change could not apply stays off the wire.
    expect(
      refused('unapplied-change', { path: '/Users/me/w/a/workspace.json' }),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.recoveryRequired',
      message: 'unapplied-change.',
      details: { reason: 'unapplied-change' },
      retry: NEVER,
    });
  });

  it.each(ALL)(
    '%s: thrown, invalid-state and unknown-reservation stay untyped (internal)',
    (operation) => {
      for (const error of [
        new Error('/Users/me/secret failed'),
        new W5CommitRefusedError('invalid-state', 'Bad state.'),
        new W5CommitRefusedError('unknown-reservation', 'Unknown.'),
        new W5CommitLogHostError('outcome-unknown', 'Stopped.'),
        'not an error',
      ])
        expect(
          toCoreWorkspaceMetadataWireError(
            CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS[operation],
            operation,
            error,
          ),
        ).toBe(error);
    },
  );

  it.each(ALL)('%s: a typed error passes through', (operation) => {
    const error = new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'No.',
      retry: NEVER,
    });
    expect(
      toCoreWorkspaceMetadataWireError(
        CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS[operation],
        operation,
        error,
      ),
    ).toBe(error);
  });

  it('maps a missing workspace to notFound, and #6 a missing repository to repositoryNotFound', () => {
    for (const operation of [
      'core.workspace.update',
      'core.workspace.reorder',
      'core.workspace.privateMemory.update',
      'core.workspace.repository.add',
      'core.workspace.repository.remove',
    ] as const)
      expect(
        wire(
          operation,
          new WorkspaceMetadataRefusedError(
            'not-found',
            'Project a not found.',
          ),
        ),
      ).toEqual({
        kind: 'not_found',
        code: 'core.workspace.notFound',
        message: 'Project a not found.',
        details: { reason: 'not-found' },
        retry: NEVER,
      });
    expect(
      wire(
        'core.workspace.scripts.update',
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
  });

  it('read-only scope is failed_precondition readOnly on #6 and #8', () => {
    for (const operation of [
      'core.workspace.scripts.update',
      'core.workspace.planDetection.update',
    ] as const)
      expect(
        wire(
          operation,
          new ScriptHookSettingsRefusedError('read-only-scope', 'Read-only.'),
        ),
      ).toEqual({
        kind: 'failed_precondition',
        code: 'core.workspace.readOnly',
        message: 'Read-only.',
        details: { reason: 'read-only-scope' },
        retry: NEVER,
      });
  });

  it('configuration-unavailable retries after core.workspace.get', () => {
    for (const operation of [
      'core.workspace.update',
      'core.workspace.scripts.update',
      'core.workspace.planDetection.update',
      'core.workspace.privateMemory.update',
      'core.workspace.repository.add',
      'core.workspace.repository.remove',
    ] as const) {
      for (const error of [
        new ScriptHookSettingsRefusedError('configuration-unavailable', 'X.'),
        new CoreWorkspaceAddressRefusedError('configuration-unavailable', 'X.'),
        new WorkspaceConfigUnreadableError(),
      ])
        expect(wire(operation, error)).toMatchObject({
          kind: 'failed_precondition',
          code: 'core.workspace.configurationUnavailable',
          details: { reason: 'configuration-unavailable' },
          retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
        });
    }
  });

  it('index-unavailable is invalidState on #3 and #4, uncoded where the enum lacks it', () => {
    for (const operation of [
      'core.workspace.update',
      'core.workspace.reorder',
    ] as const)
      for (const error of [
        new WorkspaceMetadataRefusedError('index-unavailable', 'No list.'),
        new WorkspaceIndexUnreadableError(),
      ])
        expect(wire(operation, error)).toMatchObject({
          kind: 'failed_precondition',
          code: 'core.workspace.invalidState',
          details: { reason: 'index-unavailable' },
          retry: refresh(operation),
        });
    const uncoded = wire(
      'core.workspace.scripts.update',
      new CoreWorkspaceAddressRefusedError('index-unavailable', 'No list.'),
    );
    expect(uncoded.code).toBeUndefined();
    expect(uncoded).toMatchObject({
      kind: 'failed_precondition',
      details: { reason: 'index-unavailable' },
    });
  });

  it('Cowork start pages, organization memory and repository state are invalidState', () => {
    expect(
      wire(
        'core.workspace.update',
        new WorkspaceMetadataRefusedError('unsupported-for-cowork', 'Cowork.'),
      ),
    ).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.workspace.invalidState',
      details: { reason: 'unsupported-for-cowork' },
      retry: NEVER,
    });
    expect(
      wire(
        'core.workspace.privateMemory.update',
        new WorkspacePrivateMemoryRefusedError(
          'managed-by-organization',
          'Managed.',
        ),
      ),
    ).toMatchObject({
      code: 'core.workspace.invalidState',
      message: 'Managed.',
      details: { reason: 'managed-by-organization' },
    });
    expect(
      wire(
        'core.workspace.repository.add',
        new WorkspaceRepositoryRefusedError(
          'not-multi-repo',
          'Project a is not a multi-repo project',
        ),
      ),
    ).toMatchObject({
      code: 'core.workspace.invalidState',
      message: 'Project a is not a multi-repo project',
      details: { reason: 'not-multi-repo' },
    });
    // The desktop message names the folder; the wire's is fixed.
    expect(
      wire(
        'core.workspace.repository.add',
        new WorkspaceRepositoryRefusedError(
          'not-a-repository',
          'Not a git repository: /Users/me/folder',
        ),
      ),
    ).toMatchObject({
      code: 'core.workspace.invalidState',
      message: 'The selected folder is not a Git repository.',
      details: { reason: 'not-a-repository' },
    });
    expect(
      wire(
        'core.workspace.repository.add',
        new WorkspaceRepositoryRefusedError('duplicate', 'Already added.'),
      ),
    ).toEqual({
      kind: 'already_exists',
      message: 'Already added.',
      details: { reason: 'duplicate' },
      retry: NEVER,
    });
  });

  it('refuses an organization-owned workspace as uncoded capability_unavailable', () => {
    for (const error of [
      new WorkspaceRepositoryRefusedError('organization-owned', 'Org.'),
      new CoreWorkspaceAddressRefusedError('organization-owned', 'Org.'),
    ])
      expect(wire('core.workspace.repository.remove', error)).toEqual({
        kind: 'capability_unavailable',
        message: 'Org.',
        details: { reason: 'organization-owned' },
        retry: NEVER,
      });
  });

  it('replaces a message that can name a host path', () => {
    expect(
      wire(
        'core.workspace.update',
        new WorkspaceMetadataRefusedError(
          'invalid-patch',
          'Cannot read /Users/me/w/a/workspace.json',
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

type MetadataDispatcher = CanopyDispatcher<
  Record<never, never>,
  typeof CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
  Record<never, never>
>;

const WRITE = {
  caller: caller(['core.workspace.write']),
  metadata: { idempotencyKey: 'key-1' },
};

const WORKSPACE: CoreWorkspaceUpdateResult = {
  workspaceId: 'a',
  name: 'A',
  kind: 'git',
  repositorySources: [],
  settings: {},
};

type Host = CoreWorkspaceMetadataHost;
type FakeHost = { [K in keyof Host]: jest.MockedFunction<Host[K]> };

function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    update: jest.fn<ReturnType<Host['update']>, Parameters<Host['update']>>(
      () => Promise.resolve(WORKSPACE),
    ),
    reorder: jest.fn<ReturnType<Host['reorder']>, Parameters<Host['reorder']>>(
      () => Promise.resolve(),
    ),
    updateScripts: jest.fn<
      ReturnType<Host['updateScripts']>,
      Parameters<Host['updateScripts']>
    >(() => Promise.resolve()),
    updatePlanDetection: jest.fn<
      ReturnType<Host['updatePlanDetection']>,
      Parameters<Host['updatePlanDetection']>
    >(() => Promise.resolve()),
    updatePrivateMemory: jest.fn<
      ReturnType<Host['updatePrivateMemory']>,
      Parameters<Host['updatePrivateMemory']>
    >(() => Promise.resolve({ workspaceId: 'a', privateMemory: true })),
    addRepository: jest.fn<
      ReturnType<Host['addRepository']>,
      Parameters<Host['addRepository']>
    >(() => Promise.resolve({ repository: { id: 'r', name: 'R' } })),
    removeRepository: jest.fn<
      ReturnType<Host['removeRepository']>,
      Parameters<Host['removeRepository']>
    >(() => Promise.resolve({ removed: null })),
    ...overrides,
  };
}

function runtime(host: CoreWorkspaceMetadataHost): MetadataDispatcher {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createCoreWorkspaceMetadataHandlers(host),
      streams: {},
    },
  });
}

describe('core.workspace.* metadata handlers', () => {
  const call = { caller: WRITE.caller, idempotencyKey: 'key-1' };

  it('refuses a caller without core.workspace.write before the host runs', async () => {
    const host = fakeHost();
    const dispatcher = runtime(host);
    await expect(
      dispatcher.instruction(
        'core.workspace.privateMemory.update',
        { workspaceId: 'a', privateMemory: true },
        { ...WRITE, caller: caller(['core.workspace.read']) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(host.updatePrivateMemory).not.toHaveBeenCalled();
  });

  it('maps a #3 patch, start pages included, to the typed command', async () => {
    const host = fakeHost();
    const dispatcher = runtime(host);
    const result = await dispatcher.instruction(
      'core.workspace.update',
      {
        workspaceId: 'a',
        expectedRevision: 2,
        patch: {
          name: 'A',
          color: '#0EA5E9',
          activitySectionOrder: ['plans'],
          startPage: { kind: 'url', url: 'https://example.com/' },
        },
        _meta: { idempotencyKey: 'key-1' },
      },
      WRITE,
    );
    expect(result).toEqual(WORKSPACE);
    expect(host.update).toHaveBeenCalledWith(
      {
        workspaceId: 'a',
        expectedRevision: 2,
        patch: {
          name: 'A',
          color: '#0EA5E9',
          activitySectionOrder: ['plans'],
          startPage: {
            kind: 'set',
            startPage: { kind: 'url', url: 'https://example.com/' },
          },
        },
      },
      call,
    );
    for (const [startPage, change] of [
      [null, { kind: 'set', startPage: null }],
      [{ kind: 'inherit' }, { kind: 'inherit' }],
      [
        { kind: 'file', repoId: 'r', path: 'docs/a.md' },
        {
          kind: 'set',
          startPage: { kind: 'file', repoId: 'r', path: 'docs/a.md' },
        },
      ],
    ] as const) {
      await dispatcher.instruction(
        'core.workspace.update',
        {
          workspaceId: 'a',
          patch: { startPage },
          _meta: { idempotencyKey: 'key-1' },
        },
        WRITE,
      );
      expect(host.update).toHaveBeenLastCalledWith(
        { workspaceId: 'a', patch: { startPage: change } },
        call,
      );
    }
  });

  it('refuses an unsafe start page path before the host runs', async () => {
    const host = fakeHost();
    await expect(
      runtime(host).instruction(
        'core.workspace.update',
        {
          workspaceId: 'a',
          patch: { startPage: { kind: 'file', path: '../outside.md' } },
          _meta: { idempotencyKey: 'key-1' },
        },
        WRITE,
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'invalid_argument', message: 'Invalid start page' },
    });
    expect(host.update).not.toHaveBeenCalled();
  });

  it('acknowledges a reorder (A17(a))', async () => {
    const host = fakeHost();
    await expect(
      runtime(host).instruction(
        'core.workspace.reorder',
        {
          visibleWorkspaceIds: ['a', 'b'],
          activeWorkspaceId: 'a',
          overWorkspaceId: 'b',
        },
        WRITE,
      ),
    ).resolves.toEqual({ acknowledged: true });
    expect(host.reorder).toHaveBeenCalledWith(
      {
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'a',
        overWorkspaceId: 'b',
      },
      call,
    );
  });

  it('maps every #6 change kind and answers {}', async () => {
    const host = fakeHost();
    const dispatcher = runtime(host);
    const changes: CoreWorkspaceScriptsChange[] = [
      { kind: 'replace', scripts: { dev: 'pnpm dev', off: null } },
      { kind: 'merge-commands', commands: { dev: 'pnpm start' } },
      { kind: 'repositories', repos: [{ repoId: 'r', scripts: { t: 'x' } }] },
      {
        kind: 'definition',
        repoId: 'r',
        name: 'dev',
        value: { command: 'pnpm dev', interactive: true },
      },
      { kind: 'remove-definition', name: 'dev' },
    ];
    for (const change of changes) {
      await expect(
        dispatcher.instruction(
          'core.workspace.scripts.update',
          { workspaceId: 'a', change },
          WRITE,
        ),
      ).resolves.toEqual({});
      expect(host.updateScripts).toHaveBeenLastCalledWith(
        { workspaceId: 'a', change },
        call,
      );
    }
  });

  it('stores plan detection normalized, as the qualification port does', async () => {
    const host = fakeHost();
    await expect(
      runtime(host).instruction(
        'core.workspace.planDetection.update',
        {
          workspaceId: 'a',
          planDetection: { disabledRuleIds: ['b', 'a', 'b'] },
        },
        WRITE,
      ),
    ).resolves.toEqual({});
    const [input] = host.updatePlanDetection.mock.calls[0] ?? [];
    expect(input?.planDetection).toEqual(
      normalizeWorkspacePlanDetection({ disabledRuleIds: ['b', 'a', 'b'] }),
    );
  });

  it('returns the private memory, repository add and removal results', async () => {
    const host = fakeHost();
    host.removeRepository.mockResolvedValue({
      removed: { id: 'r', name: 'R', source: 'local' },
    });
    const dispatcher = runtime(host);
    await expect(
      dispatcher.instruction(
        'core.workspace.privateMemory.update',
        { workspaceId: 'a', privateMemory: true },
        WRITE,
      ),
    ).resolves.toEqual({ workspaceId: 'a', privateMemory: true });
    await expect(
      dispatcher.instruction(
        'core.workspace.repository.add',
        {
          workspaceId: 'a',
          repository: {
            selection: { kind: 'local_picker_selection', selectionId: 's' },
            name: 'R',
          },
        },
        WRITE,
      ),
    ).resolves.toEqual({ repository: { id: 'r', name: 'R' } });
    expect(host.addRepository).toHaveBeenCalledWith(
      {
        workspaceId: 'a',
        repository: {
          selection: { kind: 'local_picker_selection', selectionId: 's' },
          name: 'R',
        },
      },
      call,
    );
    await expect(
      dispatcher.instruction(
        'core.workspace.repository.remove',
        { workspaceId: 'a', repoId: 'r' },
        WRITE,
      ),
    ).resolves.toEqual({ removed: { id: 'r', name: 'R', source: 'local' } });
  });

  it('answers a host refusal with its A7 shape and keeps the host error as the cause', async () => {
    const refusal = new WorkspacePrivateMemoryRefusedError(
      'managed-by-organization',
      'Private memory is managed by your organization',
    );
    const host = fakeHost();
    host.updatePrivateMemory.mockRejectedValue(refusal);
    const dispatcher = runtime(host);
    const error: unknown = await dispatcher
      .instruction(
        'core.workspace.privateMemory.update',
        { workspaceId: 'a', privateMemory: true },
        WRITE,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanopyOperationError);
    expect(error).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.invalidState',
        message: refusal.message,
        details: { reason: 'managed-by-organization' },
      },
      runtimeCause: refusal,
    });
  });

  it('answers an untyped host failure as internal, keeping its cause', async () => {
    const failure = new Error('disk on fire at /Users/me');
    const host = fakeHost();
    host.reorder.mockRejectedValue(failure);
    const error: unknown = await runtime(host)
      .instruction(
        'core.workspace.reorder',
        {
          visibleWorkspaceIds: ['a'],
          activeWorkspaceId: 'a',
          overWorkspaceId: 'a',
        },
        WRITE,
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      payload: { kind: 'internal', message: 'The operation failed.' },
      runtimeCause: failure,
    });
  });
});

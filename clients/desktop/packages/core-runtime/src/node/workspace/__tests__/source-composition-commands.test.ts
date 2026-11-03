import {
  hasHostAbsolutePath,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import { IdentifierValidationError } from '../../identifiers';
import { W5CommitRefusedError } from '../../w5/commit-log/errors';
import { W5RevisionConflictError } from '../../w5/commit-log-file-store';
import {
  deriveCoreLifecycleOperationId,
  isCoreWorkspaceLifecycleCaller,
} from '../lifecycle-commands';
import {
  CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS,
  createCoreSourceCompositionHandlers,
  type CoreSourceCompositionCommandName,
  type CoreSourceCompositionHost,
} from '../source-composition-commands';
import {
  CoreLifecycleRefusedError,
  toCoreLifecycleWireError,
  type CoreLifecycleRefusal,
} from '../source-composition-wire-errors';

const USER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.write', 'core.worktree.write'],
};

const PARAMS: Record<
  CoreSourceCompositionCommandName,
  Record<string, unknown>
> = {
  'core.workspace.sourceRepo.initialize': { workspaceId: 'a' },
  'core.workspace.type.convert': {
    workspaceId: 'a',
    targetKind: 'multi_repo',
  },
  'core.workspace.sourceChanges.apply': {
    workspaceId: 'a',
    target: { mode: 'existing', worktreeId: 'w' },
  },
  'core.workspace.composition.combine': {
    optionId: 'option',
    expectedRevision: 3,
    moveChats: true,
  },
  'core.workspace.composition.split': {
    previewId: 'preview',
    expectedWorkspaceRevision: 3,
    approvedDestructiveItems: [],
  },
  'core.workspace.composition.promote': {
    workspaceId: 'a',
    expectedRevision: 0,
    name: 'Promoted',
  },
  'core.worktree.branch.rename': {
    workspaceId: 'a',
    worktreeId: 'w',
    branchName: 'renamed',
  },
  'core.sharedContainer.fork': {
    containerId: 'c',
    revisionId: 'r',
    sourceOwnerDisplayName: 'Ada',
    destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
  },
};
const ALL = Object.keys(PARAMS).filter(
  (name): name is CoreSourceCompositionCommandName =>
    name in CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS,
);

function fakeHost(calls: string[]): CoreSourceCompositionHost {
  const record = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    initializeSourceRepo: (input) =>
      record('initializeSourceRepo', {
        workspaceId: input.workspaceId,
        manifest: { version: 1 },
        warnings: [],
      }),
    convertType: (input) =>
      record('convertType', {
        workspaceId: input.workspaceId,
        kind: input.targetKind,
      }),
    applySourceChanges: (input) =>
      record('applySourceChanges', {
        workspaceId: input.workspaceId,
        worktreeId: 'w',
        branchName: 'main',
        createdWorktree: false,
      }),
    promote: (input) => record('promote', { workspaceId: input.workspaceId }),
    renameBranch: (input) =>
      record('renameBranch', {
        workspaceId: input.workspaceId,
        worktreeId: input.worktreeId,
        branchName: input.branchName,
      }),
    fork: () =>
      record('fork', {
        containerType: 'CODE_WORKTREE',
        workspaceId: 'forked',
        worktreeId: 'w',
        warnings: [],
        provenance: {
          sourceContainerId: 'c',
          sourceRevisionId: 'r',
          sourceOwnerDisplayName: 'Ada',
          forkedAt: '2026-11-01T00:00:00.000Z',
        },
      }),
  };
}

function dispatcherOver(
  host: CoreSourceCompositionHost,
): ReturnType<typeof createCanopyDispatcher> {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createCoreSourceCompositionHandlers(host),
      streams: {},
    },
  });
}

/** Any operation by name, as a wire caller sends it. */
function instruct(
  host: CoreSourceCompositionHost,
  operation: CoreSourceCompositionCommandName,
  caller: CanopyCallerDescriptor,
  key = 'key-1',
): Promise<unknown> {
  const dispatcher = dispatcherOver(host);
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
    { ...PARAMS[operation], _meta: { idempotencyKey: key } },
    { caller, metadata: { idempotencyKey: key } },
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

function wire(
  operation: CoreSourceCompositionCommandName,
  error: unknown,
): CanopyErrorPayload {
  const mapped = toCoreLifecycleWireError(
    CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS[operation],
    operation,
    error,
  );
  if (!(mapped instanceof CanopyOperationError))
    throw new Error(`${operation}: not typed`);
  // The dispatcher keeps only payloads the definition's error schema accepts.
  expect(
    CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS[operation].error.safeParse(
      mapped.payload,
    ).success,
  ).toBe(true);
  expect(hasHostAbsolutePath(mapped.payload.message)).toBe(false);
  return mapped.payload;
}

describe('callers (Q8, OD-4)', () => {
  it.each([
    ['local-desktop-user', 'desktop', 'electron-web-contents:1', true],
    ['remote-device:phone-1', 'desktop', 'remote-bridge:4', true],
    ['core', 'desktop', 'core', true],
    [
      'local-desktop-renderer:main',
      'desktop',
      'electron-web-contents:1',
      false,
    ],
    ['portal-session:abc', 'portal', 'portal-session:abc', false],
    ['local-desktop-user', 'portal', 'electron-web-contents:1', false],
    ['local-desktop-user', 'desktop', 'portal-session:s-1', false],
    ['agent-7', 'desktop', 'electron-web-contents:1', false],
  ] as const)(
    '%s over %s from %s: %s',
    (principalId, interfaceKind, clientInstanceId, allowed) => {
      expect(
        isCoreWorkspaceLifecycleCaller({
          principalId,
          interfaceKind,
          clientInstanceId,
        }),
      ).toBe(allowed);
    },
  );

  it.each(ALL)(
    '%s refuses a renderer relay principal holding the grant before the host runs',
    async (operation) => {
      const calls: string[] = [];
      const error = await failureOf(
        instruct(fakeHost(calls), operation, {
          ...USER,
          principalId: 'local-desktop-renderer:main',
        }),
      );
      expect(error).toMatchObject({
        payload: {
          kind: 'permission_denied',
          details: { reason: 'caller-refused' },
          retry: { kind: 'never' },
        },
      });
      expect(calls).toEqual([]);
    },
  );

  it.each(ALL)('%s refuses a Portal session', async (operation) => {
    const calls: string[] = [];
    const error = await failureOf(
      instruct(fakeHost(calls), operation, {
        ...USER,
        principalId: 'portal-session:abc',
        interfaceKind: 'portal',
      }),
    );
    expect(error).toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(calls).toEqual([]);
  });

  it('runs a paired controller and host-internal callers', async () => {
    const calls: string[] = [];
    const host = fakeHost(calls);
    await instruct(host, 'core.worktree.branch.rename', {
      ...USER,
      principalId: 'remote-device:phone-1',
    });
    await instruct(host, 'core.workspace.type.convert', {
      ...USER,
      principalId: 'core',
    });
    expect(calls).toEqual(['renameBranch', 'convertType']);
  });
});

describe('composition (#18–20)', () => {
  it.each([
    ['core.workspace.composition.combine', 'option-unavailable'],
    ['core.workspace.composition.split', 'preview-unavailable'],
  ] as const)(
    '%s is capability_unavailable before any host call',
    async (operation, reason) => {
      const calls: string[] = [];
      const error = await failureOf(instruct(fakeHost(calls), operation, USER));
      expect(error).toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { reason },
          retry: { kind: 'never' },
        },
      });
      expect(calls).toEqual([]);
    },
  );

  it('promote answers a DP-3 operation reference derived from principal and key', async () => {
    const host = fakeHost([]);
    const first = await instruct(
      host,
      'core.workspace.composition.promote',
      USER,
      'k',
    );
    const replay = await instruct(
      host,
      'core.workspace.composition.promote',
      USER,
      'k',
    );
    const other = await instruct(
      host,
      'core.workspace.composition.promote',
      USER,
      'k2',
    );
    const operationId = deriveCoreLifecycleOperationId(
      'local-desktop-user',
      'core.workspace.composition.promote',
      'k',
    );
    expect(first).toEqual({
      workspaceId: 'a',
      operation: { operationId, state: 'succeeded' },
    });
    expect(replay).toEqual(first);
    expect(other).not.toEqual(first);
    expect(operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('A7: lifecycle refusals on the wire', () => {
  const refusal = (
    reason: CoreLifecycleRefusal,
    message = 'Refused.',
  ): CoreLifecycleRefusedError =>
    new CoreLifecycleRefusedError(reason, message);

  it('names each domain in its codes', () => {
    expect(
      wire('core.worktree.branch.rename', refusal('read-only-scope')),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.worktree.readOnly',
      message: 'Refused.',
      details: { reason: 'read-only-scope' },
      retry: { kind: 'never' },
    });
    expect(wire('core.worktree.branch.rename', refusal('not-found'))).toEqual(
      expect.objectContaining({
        kind: 'not_found',
        code: 'core.worktree.notFound',
      }),
    );
    expect(
      wire('core.sharedContainer.fork', refusal('source-unavailable')),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.sharedContainer.invalidState',
      message: 'Refused.',
      details: { reason: 'source-unavailable' },
      retry: { kind: 'after_refresh', resource: 'core.workspace.list' },
    });
    expect(
      wire(
        'core.workspace.sourceRepo.initialize',
        refusal('configuration-unavailable'),
      ),
    ).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.workspace.configurationUnavailable',
      retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
    });
  });

  it('leaves out a code the operation enum lacks, keeping the reason', () => {
    // #18–20's catalog enum has no configurationUnavailable code.
    expect(
      wire(
        'core.workspace.composition.promote',
        refusal('configuration-unavailable'),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      message: 'Refused.',
      details: { reason: 'configuration-unavailable' },
      retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
    });
  });

  it('request refusals are uncoded invalid_argument', () => {
    for (const operation of ALL)
      expect(wire(operation, refusal('invalid-request'))).toEqual({
        kind: 'invalid_argument',
        message: 'Refused.',
        details: { reason: 'invalid-request' },
        retry: { kind: 'never' },
      });
  });

  it.each([
    ['organization-repository-outside', { kind: 'never' }],
    [
      'organization-catalog-unavailable',
      { kind: 'after_refresh', resource: 'core.workspace.get' },
    ],
    [
      'organization-remote-unreadable',
      { kind: 'after_refresh', resource: 'core.workspace.get' },
    ],
    [
      'organization-repository-mismatch',
      { kind: 'after_refresh', resource: 'core.workspace.get' },
    ],
    [
      'organization-sync-failed',
      { kind: 'after_refresh', resource: 'core.workspace.get' },
    ],
    ['repository-not-local', { kind: 'never' }],
    ['repository-id-conflict', { kind: 'never' }],
  ] as const)(
    'the repository addition refusal %s is #17 invalidState',
    (reason, retry) => {
      expect(
        wire('core.workspace.sourceChanges.apply', refusal(reason)),
      ).toEqual({
        kind: 'failed_precondition',
        code: 'core.workspace.invalidState',
        message: 'Refused.',
        details: { reason },
        retry,
      });
    },
  );

  it('keeps messages path-free', () => {
    const payload = wire(
      'core.workspace.type.convert',
      refusal('has-worktrees', 'Remove /Users/someone/repo/worktrees first'),
    );
    expect(payload.message).not.toContain('/Users/someone');
  });

  it('keeps the host refusal as the runtime cause', () => {
    const hostError = new Error('host');
    const mapped = toCoreLifecycleWireError(
      CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS[
        'core.worktree.branch.rename'
      ],
      'core.worktree.branch.rename',
      new CoreLifecycleRefusedError('branch-unavailable', 'Taken.', hostError),
    );
    expect(mapped).toBeInstanceOf(CanopyOperationError);
    expect(mapped instanceof CanopyOperationError && mapped.runtimeCause).toBe(
      hostError,
    );
  });
});

describe("A7: commit-log failures take W7a's rows in their own domain", () => {
  it.each([
    ['core.worktree.branch.rename', 'core.worktree'],
    ['core.sharedContainer.fork', 'core.sharedContainer'],
    ['core.workspace.composition.promote', 'core.workspace'],
  ] as const)('%s', (operation, prefix) => {
    expect(
      wire(operation, new W5CommitRefusedError('key-reused', 'Reused.')),
    ).toMatchObject({
      kind: 'conflict',
      code: `${prefix}.idempotencyKeyReused`,
      retry: { kind: 'never' },
    });
    expect(
      wire(operation, new W5CommitRefusedError('in-progress', 'Busy.')),
    ).toMatchObject({
      kind: 'unavailable',
      code: `${prefix}.requestInProgress`,
      retry: { kind: 'same_idempotency_key' },
    });
    for (const reason of ['recovery-required', 'outcome-expired'] as const)
      expect(
        wire(operation, new W5CommitRefusedError(reason, 'Stuck.')),
      ).toMatchObject({
        kind: 'failed_precondition',
        code: `${prefix}.${reason === 'recovery-required' ? 'recoveryRequired' : 'outcomeExpired'}`,
        retry: { kind: 'never' },
      });
    expect(
      wire(operation, new W5RevisionConflictError('workspaces', 1, 2)),
    ).toMatchObject({
      kind: 'conflict',
      code: `${prefix}.revisionConflict`,
      retry: { kind: 'after_refresh' },
    });
    expect(
      wire(operation, new IdentifierValidationError('Invalid workspaceId')),
    ).toMatchObject({ kind: 'invalid_argument', retry: { kind: 'never' } });
  });

  it('leaves an unclassified failure untyped', () => {
    const error = new Error('boom');
    expect(
      toCoreLifecycleWireError(
        CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS[
          'core.workspace.type.convert'
        ],
        'core.workspace.type.convert',
        error,
      ),
    ).toBe(error);
  });
});

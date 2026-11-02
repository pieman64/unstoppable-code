import {
  CORE_WORKSPACE_REPO_RULES_INSTRUCTIONS,
  CORE_WORKSPACE_REPO_RULES_QUERIES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  RepoRulesPolicy,
  type ReadRepoRule,
  type RepoRuleCheckout,
  type RepoRulesPolicyRead,
  type RepoRulesPolicyState,
  type RepoRulesRead,
} from '../repo-rules';
import {
  createCoreWorkspaceRepoRulesHandlers,
  isRepoRulesLocalCaller,
  repoRulesSessionKey,
  type CoreWorkspaceRepoRulesBinding,
} from '../workspace-repo-rules';

function caller(
  overrides: Partial<CanopyCallerDescriptor> = {},
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['core.workspace.read', 'core.workspace.write'],
    ...overrides,
  };
}

const HASH = 'a'.repeat(64);
function rule(path: string): ReadRepoRule {
  return {
    id: `r:${path}`,
    repoId: 'r',
    path,
    kind: 'always',
    description: '',
    globs: [],
    scope: '',
    hash: HASH,
    bytes: 4,
    selected: true,
    flags: [],
    body: `${path} body`,
  };
}

function emptyState(): RepoRulesPolicyRead {
  return {
    version: 1,
    enabled: false,
    revision: 0,
    disabledRuleIds: [],
    reviewed: {},
    nestedDirectories: {},
    diagnostic: 'missing',
  };
}

interface Fixture {
  binding: CoreWorkspaceRepoRulesBinding;
  writes: RepoRulesPolicyState[];
  resolve: jest.Mock<Promise<RepoRuleCheckout[]>, [unknown]>;
  scans: jest.Mock<Promise<RepoRulesRead>, [RepoRuleCheckout[]]>;
  failWrite: (error: Error | undefined) => void;
}

function fixture(): Fixture {
  let state = emptyState();
  let writeError: Error | undefined;
  const writes: RepoRulesPolicyState[] = [];
  const resolve = jest.fn<Promise<RepoRuleCheckout[]>, [unknown]>(() =>
    Promise.resolve([{ repoId: 'r', root: '/checkout', prefix: '' }]),
  );
  const scans = jest.fn<Promise<RepoRulesRead>, [RepoRuleCheckout[]]>(() =>
    Promise.resolve({
      rules: [rule('.cursorrules'), rule('.cursor/rules/a.mdc')],
      skipped: [],
      nestedDirectories: {},
    }),
  );
  const policy = new RepoRulesPolicy({
    store: {
      read: (): Promise<RepoRulesPolicyRead> => Promise.resolve(state),
      update: async (_workspaceId, operation): Promise<RepoRulesPolicyRead> => {
        const next = await operation(state);
        if (writeError) throw writeError;
        writes.push(next);
        state = next;
        return next;
      },
    },
    resolve,
    worker: {
      scan: scans,
      readSession: (): Promise<RepoRulesRead> =>
        Promise.resolve({ rules: [], skipped: [], nestedDirectories: {} }),
    },
  });
  const storeFailures = new WeakSet<Error>();
  return {
    binding: {
      policy,
      errorCode: (error) =>
        error instanceof Error && storeFailures.has(error)
          ? 'core.workspace.repoRules.saveFailed'
          : undefined,
    },
    writes,
    resolve,
    scans,
    failWrite: (error): void => {
      writeError = error;
      if (error) storeFailures.add(error);
    },
  };
}

type RepoRulesDispatcher = CanopyDispatcher<
  typeof CORE_WORKSPACE_REPO_RULES_QUERIES,
  typeof CORE_WORKSPACE_REPO_RULES_INSTRUCTIONS,
  Record<never, never>
>;

function runtime(f: Fixture): RepoRulesDispatcher {
  const handlers = createCoreWorkspaceRepoRulesHandlers({
    load: () => Promise.resolve(f.binding),
  });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_WORKSPACE_REPO_RULES_QUERIES,
      instructions: CORE_WORKSPACE_REPO_RULES_INSTRUCTIONS,
      streams: {},
    },
    handlers: {
      queries: handlers.queries,
      instructions: handlers.instructions,
      streams: {},
    },
  });
}

async function payload(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError)
      return {
        ...error.payload,
        cause:
          error.runtimeCause instanceof Error
            ? error.runtimeCause.message
            : undefined,
      };
    throw error;
  }
  throw new Error('expected a failure');
}

describe('repo-rules local-only predicate', () => {
  it('admits only the local desktop user on the desktop interface', () => {
    expect(isRepoRulesLocalCaller(caller())).toBe(true);
    for (const refused of [
      caller({ principalId: 'remote-device:controller-1' }),
      caller({ principalId: 'local-desktop-renderer:main' }),
      caller({ interfaceKind: 'portal' }),
      caller({ interfaceKind: 'cli' }),
    ])
      expect(isRepoRulesLocalCaller(refused)).toBe(false);
  });

  it('keys reviews by principal and client instance', () => {
    expect(repoRulesSessionKey(caller())).toBe(
      'local-desktop-user:electron-web-contents:1',
    );
  });
});

describe('core.workspace.repoRules handlers', () => {
  it.each([
    ['a remote device', { principalId: 'remote-device:controller-1' }],
    [
      'a renderer relay surface',
      { principalId: 'local-desktop-renderer:main' },
    ],
    ['a Portal session', { interfaceKind: 'portal' as const }],
  ])(
    'refuses %s on every operation before loading the host',
    async (_name, overrides) => {
      const f = fixture();
      let loads = 0;
      const handlers = createCoreWorkspaceRepoRulesHandlers({
        load: () => {
          loads += 1;
          return Promise.resolve(f.binding);
        },
      });
      const dispatcher = createCanopyDispatcher({
        profile: 'core',
        definitions: {
          queries: CORE_WORKSPACE_REPO_RULES_QUERIES,
          instructions: CORE_WORKSPACE_REPO_RULES_INSTRUCTIONS,
          streams: {},
        },
        handlers: { ...handlers, streams: {} },
      });
      const options = { caller: caller(overrides) };
      const refusal = {
        kind: 'permission_denied',
        code: 'core.workspace.repoRules.localOnly',
        message: 'Editor setup is available on the local desktop.',
        retry: { kind: 'never' },
        cause: 'Editor setup is available on the local desktop.',
      };
      expect(
        await Promise.all([
          payload(
            dispatcher.query(
              'core.workspace.repoRules.scan',
              { workspaceId: 'w' },
              options,
            ),
          ),
          payload(
            dispatcher.query(
              'core.workspace.repoRules.preview',
              {
                workspaceId: 'w',
                scanId: '12345678-1234-4234-8234-123456789abc',
                ruleId: 'r',
              },
              options,
            ),
          ),
          payload(
            dispatcher.query(
              'core.workspace.repoRules.status',
              { workspaceId: 'w' },
              options,
            ),
          ),
          payload(
            dispatcher.instruction(
              'core.workspace.repoRules.apply',
              { workspaceId: 'w', enabled: false },
              options,
            ),
          ),
        ]),
      ).toEqual([refusal, refusal, refusal, refusal]);
      expect(loads).toBe(0);
      expect(f.writes).toEqual([]);
    },
  );

  it('requires exactly the read or write grant per operation', async () => {
    const dispatcher = runtime(fixture());
    const reader = { caller: caller({ grants: ['core.workspace.read'] }) };
    const writer = { caller: caller({ grants: ['core.workspace.write'] }) };
    await expect(
      dispatcher.query(
        'core.workspace.repoRules.status',
        { workspaceId: 'w' },
        reader,
      ),
    ).resolves.toMatchObject({ enabled: false, revision: 0 });
    expect(
      await payload(
        dispatcher.query(
          'core.workspace.repoRules.scan',
          { workspaceId: 'w' },
          writer,
        ),
      ),
    ).toMatchObject({ kind: 'permission_denied' });
    expect(
      await payload(
        dispatcher.instruction(
          'core.workspace.repoRules.apply',
          { workspaceId: 'w', enabled: false },
          reader,
        ),
      ),
    ).toMatchObject({ kind: 'permission_denied' });
    await expect(
      dispatcher.instruction(
        'core.workspace.repoRules.apply',
        { workspaceId: 'w', enabled: false },
        writer,
      ),
    ).resolves.toMatchObject({ enabled: false, revision: 1 });
  });

  it('refuses an idempotency key on apply', async () => {
    expect(
      await payload(
        runtime(fixture()).instruction(
          'core.workspace.repoRules.apply',
          { workspaceId: 'w', enabled: false },
          { caller: caller(), metadata: { idempotencyKey: 'k' } },
        ),
      ),
    ).toMatchObject({ kind: 'invalid_argument' });
  });

  it('binds a review to the scanning session and consumes it on apply', async () => {
    const f = fixture();
    const dispatcher = runtime(f);
    const scan = await dispatcher.query(
      'core.workspace.repoRules.scan',
      { workspaceId: 'w' },
      { caller: caller() },
    );
    expect(scan.proposals.map((proposal) => proposal.id)).toEqual([
      'r:.cursorrules',
      'r:.cursor/rules/a.mdc',
    ]);
    const preview = {
      workspaceId: 'w',
      scanId: scan.scanId,
      ruleId: 'r:.cursorrules',
    };
    await expect(
      dispatcher.query('core.workspace.repoRules.preview', preview, {
        caller: caller(),
      }),
    ).resolves.toEqual({ body: '.cursorrules body' });
    expect(
      await payload(
        dispatcher.query('core.workspace.repoRules.preview', preview, {
          caller: caller({ clientInstanceId: 'electron-web-contents:2' }),
        }),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.repoRules.reviewExpired',
      message: 'This review is unavailable or expired. Scan again.',
      retry: { kind: 'never' },
      cause: 'This review is unavailable or expired. Scan again.',
    });
    expect(
      await payload(
        dispatcher.query(
          'core.workspace.repoRules.preview',
          { ...preview, ruleId: 'r:absent' },
          { caller: caller() },
        ),
      ),
    ).toMatchObject({
      kind: 'not_found',
      code: 'core.workspace.repoRules.ruleNotInReview',
    });
    const apply = {
      workspaceId: 'w',
      enabled: true,
      scanId: scan.scanId,
      disabledRuleIds: ['r:.cursor/rules/a.mdc'],
    };
    await expect(
      dispatcher.instruction('core.workspace.repoRules.apply', apply, {
        caller: caller(),
      }),
    ).resolves.toMatchObject({
      enabled: true,
      revision: 1,
      disabledRuleIds: ['r:.cursor/rules/a.mdc'],
    });
    expect(
      await payload(
        dispatcher.instruction('core.workspace.repoRules.apply', apply, {
          caller: caller(),
        }),
      ),
    ).toMatchObject({ code: 'core.workspace.repoRules.reviewExpired' });
    expect(f.writes).toHaveLength(1);
  });

  it('types each refusal with its code and keeps the message as the cause', async () => {
    const f = fixture();
    const dispatcher = runtime(f);
    const options = { caller: caller() };
    const scanned = async (): Promise<string> =>
      (
        await dispatcher.query(
          'core.workspace.repoRules.scan',
          { workspaceId: 'w' },
          options,
        )
      ).scanId;
    const apply = (params: {
      enabled: boolean;
      scanId?: string;
      disabledRuleIds?: string[];
    }): Promise<unknown> =>
      payload(
        dispatcher.instruction(
          'core.workspace.repoRules.apply',
          { workspaceId: 'w', ...params },
          options,
        ),
      );
    const outcomes: Record<string, unknown> = {
      withoutReview: await apply({ enabled: true, disabledRuleIds: [] }),
      foreign: await apply({
        enabled: true,
        scanId: await scanned(),
        disabledRuleIds: ['r:elsewhere'],
      }),
    };
    const stale = await scanned();
    await dispatcher.instruction(
      'core.workspace.repoRules.apply',
      { workspaceId: 'w', enabled: false },
      options,
    );
    outcomes.policyChanged = await apply({
      enabled: true,
      scanId: stale,
      disabledRuleIds: [],
    });
    const moved = await scanned();
    f.resolve.mockResolvedValueOnce([
      { repoId: 'r', root: '/elsewhere', prefix: '' },
    ]);
    outcomes.checkoutChanged = await apply({
      enabled: true,
      scanId: moved,
      disabledRuleIds: [],
    });
    const edited = await scanned();
    f.scans.mockResolvedValueOnce({
      rules: [{ ...rule('.cursorrules'), hash: 'b'.repeat(64) }],
      skipped: [],
      nestedDirectories: {},
    });
    outcomes.rulesChanged = await apply({
      enabled: true,
      scanId: edited,
      disabledRuleIds: [],
    });
    f.resolve.mockRejectedValueOnce(
      new Error('The code workspace is unavailable.'),
    );
    outcomes.checkoutUnavailable = await payload(
      dispatcher.query(
        'core.workspace.repoRules.scan',
        { workspaceId: 'w' },
        options,
      ),
    );
    const saving = await scanned();
    f.failWrite(new Error('Unable to save workspace rule policy.'));
    outcomes.saveFailed = await apply({
      enabled: true,
      scanId: saving,
      disabledRuleIds: [],
    });
    f.failWrite(undefined);
    f.scans.mockRejectedValueOnce(new Error('worker crashed'));
    outcomes.untyped = await payload(
      dispatcher.query(
        'core.workspace.repoRules.scan',
        { workspaceId: 'w' },
        options,
      ),
    );
    expect(outcomes).toEqual({
      withoutReview: {
        kind: 'invalid_argument',
        code: 'core.workspace.repoRules.selectionInvalid',
        message: 'A review is required to change rule selections.',
        retry: { kind: 'never' },
        cause: 'A review is required to change rule selections.',
      },
      foreign: {
        kind: 'invalid_argument',
        code: 'core.workspace.repoRules.selectionInvalid',
        message: 'Selections must belong to this review.',
        retry: { kind: 'never' },
        cause: 'Selections must belong to this review.',
      },
      policyChanged: {
        kind: 'conflict',
        code: 'core.workspace.repoRules.policyChanged',
        message: 'Workspace policy changed. Scan again.',
        retry: { kind: 'never' },
        cause: 'Workspace policy changed. Scan again.',
      },
      checkoutChanged: {
        kind: 'conflict',
        code: 'core.workspace.repoRules.checkoutChanged',
        message: 'The reviewed checkout changed. Scan again.',
        retry: { kind: 'never' },
        cause: 'The reviewed checkout changed. Scan again.',
      },
      rulesChanged: {
        kind: 'conflict',
        code: 'core.workspace.repoRules.checkoutChanged',
        message: 'Cursor rules changed since this review. Scan again.',
        retry: { kind: 'never' },
        cause: 'Cursor rules changed since this review. Scan again.',
      },
      checkoutUnavailable: {
        kind: 'failed_precondition',
        code: 'core.workspace.repoRules.checkoutUnavailable',
        message: 'The code workspace is unavailable.',
        retry: { kind: 'never' },
        cause: 'The code workspace is unavailable.',
      },
      saveFailed: {
        kind: 'internal',
        code: 'core.workspace.repoRules.saveFailed',
        message: 'Unable to save workspace rule policy.',
        retry: { kind: 'never' },
        cause: 'Unable to save workspace rule policy.',
      },
      untyped: {
        kind: 'internal',
        message: 'The operation failed.',
        retry: { kind: 'never' },
        cause: 'worker crashed',
      },
    });
  });

  it('reads status without a review, a resolver or the worker', async () => {
    const f = fixture();
    await expect(
      runtime(f).query(
        'core.workspace.repoRules.status',
        { workspaceId: 'w' },
        { caller: caller({ clientInstanceId: 'other' }) },
      ),
    ).resolves.toEqual({
      enabled: false,
      disabledRuleIds: [],
      revision: 0,
      diagnostic: 'missing',
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.scans).not.toHaveBeenCalled();
  });
});

import { CanopyOperationError } from '@canopy/core-runtime';
import { WorkerCodeGraphBuildResultSchema } from '@canopy/protocol/canopy-core';
import {
  abortPreparingCodeGraphBuilds,
  buildCodeGraph,
} from '../lib/code-graph-worker-builds';

const mockRunWorktreeBuild = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../lib/code-graph-build-service', () => ({
  runWorktreeCodeGraphBuild: (input: unknown): Promise<unknown> =>
    mockRunWorktreeBuild(input),
}));
const mockMaintain = jest.fn<Promise<unknown>, unknown[]>();
const mockRepair = jest.fn<Promise<unknown>, unknown[]>();
const mockSync = jest.fn<void, unknown[]>();
jest.mock('../lib/code-graph-base-manager', () => ({
  maintainCodeGraphBasesForWorkspace: (...args: unknown[]): Promise<unknown> =>
    mockMaintain(...args),
  requestCodeGraphBaseSummaryRepair: (...args: unknown[]): Promise<unknown> =>
    mockRepair(...args),
  syncCodeGraphBaseRepositories: (...args: unknown[]): void => {
    mockSync(...args);
  },
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({
      version: 1,
      items: [
        { id: 'w', type: 'single-repo', worktrees: [{ id: 't' }] },
        { id: 'chat', type: 'cowork', worktrees: [] },
      ],
    }),
}));
// The code-review chat scope `code-review-chat`/`w--t` borrows worktree `t`
// of project `w`; `w--x` borrows a worktree the sidebar no longer records.
jest.mock('../lib/resolve-worktree', () => ({
  resolveRegisteredChatWorktree: (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } => {
    if (projectId !== 'code-review-chat') return { projectId, worktreeId };
    if (worktreeId === 'w--t') return { projectId: 'w', worktreeId: 't' };
    if (worktreeId === 'w--x') return { projectId: 'w', worktreeId: 'x' };
    throw new Error(`No code-review target registered for scope ${worktreeId}`);
  },
  resolveWorktreeCwd: (): string => {
    throw new Error('No worktree path in this suite.');
  },
}));
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE: 'unavailable message',
}));

// The generation's cancellation signal and queued callback.
const ANY_SIGNAL: unknown = expect.any(AbortSignal);
const ANY_CALLBACK: unknown = expect.any(Function);

const result = {
  filesScanned: 10,
  filesParsed: 4,
  filesUnchanged: 6,
  filesSkipped: 0,
  filesRemoved: 1,
  parseFailures: 0,
  symbolCount: 40,
  edgeCount: 70,
  durationMs: 12.6,
  derived: [],
  customLanguages: null,
  lastBuildAt: Date.parse('2026-11-02T16:00:00.000Z'),
  derivedDeferred: true,
};

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error.payload;
    throw error;
  }
  throw new Error('Expected a refusal.');
}

beforeEach(() => {
  mockRunWorktreeBuild.mockReset();
  mockMaintain.mockReset();
  mockRepair.mockReset();
  mockSync.mockReset();
});

describe('worker.codeGraph.build on Electron main', () => {
  it.each([
    ['incremental', {}],
    ['verified', { verifyContent: true }],
    ['full', { forceReparse: true }],
  ] as const)(
    'builds a worktree in %s mode with the matching options',
    async (mode, options) => {
      mockRunWorktreeBuild.mockResolvedValue({ ok: true, result });

      await expect(
        buildCodeGraph({
          kind: 'worktree',
          workspaceId: 'w',
          worktreeId: 't',
          mode,
        }),
      ).resolves.toEqual({
        kind: 'worktree',
        filesScanned: 10,
        filesParsed: 4,
        filesUnchanged: 6,
        filesSkipped: 0,
        filesRemoved: 1,
        parseFailures: 0,
        symbolCount: 40,
        edgeCount: 70,
        durationMs: 13,
        lastBuildAt: '2026-11-02T16:00:00.000Z',
        derivedPending: true,
        customLanguageDiagnostics: null,
        derivedWarnings: null,
      });
      expect(mockRunWorktreeBuild).toHaveBeenCalledWith({
        projectId: 'w',
        worktreeId: 't',
        reason: 'manual',
        options,
        signal: ANY_SIGNAL,
        onQueued: ANY_CALLBACK,
      });
    },
  );

  it("builds an agent's request as a tool request and carries its warnings", async () => {
    mockRunWorktreeBuild.mockResolvedValue({
      ok: true,
      result: {
        ...result,
        customLanguages: {
          configPath: '/private/repo/.canopy/languages.json',
          loaded: [],
          diagnostics: [
            { entryId: null, index: -1, message: 'config is malformed' },
            { entryId: 'zig', index: 0, message: 'grammar missing' },
          ],
        },
        derived: [
          {
            repoId: 'r',
            computed: true,
            communityCount: 0,
            flowCount: 0,
            communitiesSkipped: true,
            flowsGlobalCapReached: false,
            warnings: ['r: community detection skipped'],
          },
        ],
      },
    });

    const built = await buildCodeGraph({
      kind: 'worktree',
      workspaceId: 'w',
      worktreeId: 't',
      mode: 'verified',
      requestedBy: 'agent',
    });

    expect(mockRunWorktreeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'tool-request' }),
    );
    expect(built).toMatchObject({
      customLanguageDiagnostics: [
        { entryId: null, message: 'config is malformed' },
        { entryId: 'zig', message: 'grammar missing' },
      ],
      derivedWarnings: ['r: community detection skipped'],
    });
    expect(JSON.stringify(built)).not.toContain('/private/');
  });

  it.each([
    [
      'with the fingerprint it observed',
      {
        trigger: 'refresh',
        observedFingerprint: { value: 'f1', observedMs: 7 },
      },
      {
        reason: 'refresh',
        observedFingerprint: 'f1',
        observedFingerprintMs: 7,
      },
    ],
    [
      'without one',
      { trigger: 'worktree-created' },
      { reason: 'worktree-created' },
    ],
  ] as const)(
    "builds a scheduler's background request %s as the scheduler did",
    async (_label, background, expected) => {
      mockRunWorktreeBuild.mockResolvedValue({ ok: true, result });

      await buildCodeGraph({
        kind: 'worktree',
        workspaceId: 'w',
        worktreeId: 't',
        mode: 'incremental',
        background,
      });

      expect(mockRunWorktreeBuild).toHaveBeenCalledWith({
        projectId: 'w',
        worktreeId: 't',
        options: {},
        ...expected,
        signal: ANY_SIGNAL,
        onQueued: ANY_CALLBACK,
      });
    },
  );

  it('stops a generation canceled while it resolves its scope, before it queues', async () => {
    let seen: { signal: AbortSignal } | undefined;
    mockRunWorktreeBuild.mockImplementation((input) => {
      seen = input as { signal: AbortSignal };
      return Promise.resolve({ ok: true, result });
    });
    const pending = buildCodeGraph({
      kind: 'worktree',
      workspaceId: 'w',
      worktreeId: 't',
      mode: 'incremental',
    });

    // The generation is still reading the sidebar records.
    expect(abortPreparingCodeGraphBuilds('w', 't')).toBe(1);
    await pending;
    expect(seen?.signal.aborted).toBe(true);
    expect(abortPreparingCodeGraphBuilds('w', 't')).toBe(0);
  });

  it('leaves a queued generation to the queue count', async () => {
    let finish: () => void = () => undefined;
    mockRunWorktreeBuild.mockImplementation((input) => {
      (input as { onQueued: () => void }).onQueued();
      return new Promise((resolve) => {
        finish = (): void => resolve({ ok: true, result });
      });
    });
    const pending = buildCodeGraph({
      kind: 'worktree',
      workspaceId: 'w',
      worktreeId: 't',
      mode: 'incremental',
    });
    for (
      let turn = 0;
      turn < 50 && mockRunWorktreeBuild.mock.calls.length === 0;
      turn += 1
    )
      await Promise.resolve();

    expect(abortPreparingCodeGraphBuilds('w', 't')).toBe(0);
    finish();
    await pending;
  });

  it('refuses typed when generation is unavailable, times out, is canceled or fails', async () => {
    const scope = {
      kind: 'worktree',
      workspaceId: 'w',
      worktreeId: 't',
      mode: 'verified',
    } as const;
    mockRunWorktreeBuild.mockResolvedValueOnce({
      ok: false,
      message: 'unavailable message',
    });
    await expect(refusal(buildCodeGraph(scope))).resolves.toMatchObject({
      code: 'worker.codeGraph.unavailable',
    });
    mockRunWorktreeBuild.mockRejectedValueOnce({ reason: 'timeout' });
    await expect(refusal(buildCodeGraph(scope))).resolves.toMatchObject({
      kind: 'deadline_exceeded',
      code: 'worker.codeGraph.buildTimedOut',
    });
    mockRunWorktreeBuild.mockRejectedValueOnce({ reason: 'canceled' });
    await expect(refusal(buildCodeGraph(scope))).resolves.toMatchObject({
      kind: 'cancelled',
      code: 'worker.codeGraph.buildCanceled',
    });
    mockRunWorktreeBuild.mockResolvedValueOnce({
      ok: false,
      message: 'Failed at /private/repo/graph.db',
    });
    const failed = await refusal(buildCodeGraph(scope));
    expect(failed).toMatchObject({
      code: 'worker.codeGraph.buildFailed',
      details: { failure: 'build_error' },
    });
    expect(JSON.stringify(failed)).not.toContain('/private/');
  });

  it('keeps host paths out of build warnings', async () => {
    mockRunWorktreeBuild.mockResolvedValue({
      ok: true,
      result: {
        ...result,
        customLanguages: {
          configPath: '/private/repo/.canopy/languages.json',
          loaded: [],
          diagnostics: [
            {
              entryId: 'zig',
              index: 0,
              message:
                'grammar failed to load: /private/repo/.canopy/grammars/zig.wasm is not a module',
            },
            {
              entryId: 'odin',
              index: 1,
              message: 'tags file queries/odin.scm is unreadable: io',
            },
          ],
        },
        derived: [
          {
            repoId: 'r',
            computed: false,
            communityCount: 0,
            flowCount: 0,
            communitiesSkipped: false,
            flowsGlobalCapReached: false,
            warnings: [
              'r: derived analysis failed (SQLITE_BUSY at /Users/someone/Library/graph.db)',
            ],
          },
        ],
      },
    });

    const built = await buildCodeGraph({
      kind: 'worktree',
      workspaceId: 'w',
      worktreeId: 't',
      mode: 'verified',
    });

    expect(built).toMatchObject({
      customLanguageDiagnostics: [
        {
          entryId: 'zig',
          message: 'grammar failed to load: grammars/zig.wasm is not a module',
        },
        {
          entryId: 'odin',
          message: 'tags file queries/odin.scm is unreadable: io',
        },
      ],
      derivedWarnings: ['r: derived analysis failed (SQLITE_BUSY at <path>)'],
    });
    expect(JSON.stringify(built)).not.toMatch(/\/private\/|\/Users\//);
  });

  it('builds a registered chat scope under its own identity and refuses an unregistered or stale one', async () => {
    mockRunWorktreeBuild.mockResolvedValue({ ok: true, result });

    await expect(
      buildCodeGraph({
        kind: 'worktree',
        workspaceId: 'code-review-chat',
        worktreeId: 'w--t',
        mode: 'verified',
        requestedBy: 'agent',
      }),
    ).resolves.toMatchObject({ kind: 'worktree', filesParsed: 4 });
    expect(mockRunWorktreeBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'code-review-chat',
        worktreeId: 'w--t',
      }),
    );

    mockRunWorktreeBuild.mockClear();
    for (const worktreeId of ['gone', 'w--x']) {
      await expect(
        refusal(
          buildCodeGraph({
            kind: 'worktree',
            workspaceId: 'code-review-chat',
            worktreeId,
            mode: 'verified',
          }),
        ),
      ).resolves.toMatchObject({ code: 'worker.codeGraph.graphScopeNotFound' });
    }
    expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
  });

  it("keeps a repository's oversized warnings within the result schema", async () => {
    const long = 'x'.repeat(10_000);
    mockRunWorktreeBuild.mockResolvedValue({
      ok: true,
      result: {
        ...result,
        customLanguages: {
          configPath: '/repo/.canopy/languages.json',
          loaded: [],
          diagnostics: Array.from({ length: 1_500 }, (_, index) => ({
            entryId: long,
            index,
            message: `entry ${index}: ${long}`,
          })),
        },
        derived: [
          {
            repoId: 'r',
            computed: true,
            communityCount: 0,
            flowCount: 0,
            communitiesSkipped: false,
            flowsGlobalCapReached: false,
            warnings: Array.from({ length: 1_200 }, () => long),
          },
        ],
      },
    });

    const built = await buildCodeGraph({
      kind: 'worktree',
      workspaceId: 'w',
      worktreeId: 't',
      mode: 'verified',
    });

    expect(WorkerCodeGraphBuildResultSchema.safeParse(built).success).toBe(
      true,
    );
    if (built.kind !== 'worktree') throw new Error('Expected a worktree.');
    expect(built.customLanguageDiagnostics).toHaveLength(1_024);
    expect(built.customLanguageDiagnostics?.at(-1)?.message).toMatch(
      /\(476 more not shown\)$/,
    );
    expect(built.derivedWarnings).toHaveLength(1_000);
    expect(built.derivedWarnings?.at(-1)).toMatch(/\(200 more not shown\)$/);
  });

  it.each([
    ['worker-exit', 'worker_exit'],
    ['spawn-failed', 'spawn_failed'],
    ['post-failed', 'post_failed'],
    ['malformed-response', 'malformed_response'],
    ['something-else', 'internal'],
  ])(
    'names a %s scheduler failure as %s without its message',
    async (reason, failure) => {
      mockRunWorktreeBuild.mockRejectedValueOnce({
        reason,
        message: 'spawn failed for /private/entry.js',
      });
      const failed = await refusal(
        buildCodeGraph({
          kind: 'worktree',
          workspaceId: 'w',
          worktreeId: 't',
          mode: 'verified',
        }),
      );
      expect(failed).toMatchObject({
        code: 'worker.codeGraph.buildFailed',
        details: { failure },
      });
      expect(JSON.stringify(failed)).not.toContain('/private/');
    },
  );

  it.each([
    ['a traversal worktree ID', { workspaceId: 'w', worktreeId: '../escape' }],
    ['a worktree of another project', { workspaceId: 'w', worktreeId: 'x' }],
    ['an unknown project', { workspaceId: 'gone', worktreeId: 't' }],
    ['a cowork folder', { workspaceId: 'chat', worktreeId: 't' }],
  ])('refuses %s before any build work', async (_label, ids) => {
    await expect(
      refusal(buildCodeGraph({ kind: 'worktree', mode: 'verified', ...ids })),
    ).resolves.toMatchObject({
      kind: 'not_found',
      code: 'worker.codeGraph.graphScopeNotFound',
    });
    expect(mockRunWorktreeBuild).not.toHaveBeenCalled();
  });

  it.each(['gone', 'chat', '../escape'])(
    'refuses a base refresh for %s before syncing the bases',
    async (workspaceId) => {
      await expect(
        refusal(buildCodeGraph({ kind: 'workspace_base', workspaceId })),
      ).resolves.toMatchObject({
        kind: 'not_found',
        code: 'worker.codeGraph.graphScopeNotFound',
      });
      expect(mockSync).not.toHaveBeenCalled();
      expect(mockMaintain).not.toHaveBeenCalled();
    },
  );

  it('refreshes the workspace bases and reports each repository by outcome, never by message', async () => {
    mockMaintain.mockResolvedValue([
      { repoId: 'built', ok: true },
      { repoId: 'slow', ok: false, message: 'worker exceeded 600000 ms' },
      { repoId: 'off', ok: false, message: 'unavailable message' },
      { repoId: 'broken', ok: false, message: 'Failed at /private/repo' },
    ]);

    await expect(
      buildCodeGraph({ kind: 'workspace_base', workspaceId: 'w' }),
    ).resolves.toEqual({
      kind: 'workspace_base',
      repositories: [
        { repositoryId: 'built', outcome: 'built' },
        { repositoryId: 'slow', outcome: 'timed_out' },
        { repositoryId: 'off', outcome: 'unavailable' },
        { repositoryId: 'broken', outcome: 'failed' },
      ],
    });
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockMaintain).toHaveBeenCalledWith('w', { forceRefresh: true });
  });

  it("maintains the workspace bases over the base manager's repositories without a refresh or re-sync", async () => {
    mockMaintain.mockResolvedValue([{ repoId: 'built', ok: true }]);

    await expect(
      buildCodeGraph({
        kind: 'workspace_base',
        workspaceId: 'w',
        background: { trigger: 'maintenance' },
      }),
    ).resolves.toEqual({
      kind: 'workspace_base',
      repositories: [{ repositoryId: 'built', outcome: 'built' }],
    });
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockMaintain).toHaveBeenCalledWith('w', { maintenance: true });
  });

  it('maintains a workspace the last sidebar load preserved but no longer lists', async () => {
    mockMaintain.mockResolvedValue([{ repoId: 'built', ok: true }]);

    await expect(
      buildCodeGraph({
        kind: 'workspace_base',
        workspaceId: 'preserved',
        background: { trigger: 'maintenance' },
      }),
    ).resolves.toMatchObject({ kind: 'workspace_base' });
    expect(mockMaintain).toHaveBeenCalledWith('preserved', {
      maintenance: true,
    });
    expect(mockSync).not.toHaveBeenCalled();

    mockMaintain.mockClear();
    await expect(
      refusal(
        buildCodeGraph({
          kind: 'workspace_base',
          workspaceId: '../escape',
          background: { trigger: 'maintenance' },
        }),
      ),
    ).resolves.toMatchObject({ code: 'worker.codeGraph.graphScopeNotFound' });
    expect(mockMaintain).not.toHaveBeenCalled();
  });

  it.each([
    [{ repoId: 'repo', ok: true }, 'built'],
    [
      { repoId: 'repo', ok: false, message: 'unavailable message' },
      'unavailable',
    ],
    [
      {
        repoId: 'repo',
        ok: false,
        message: 'A code-graph base summary repair recently failed.',
      },
      'failed',
    ],
  ] as const)(
    "repairs one repository's base summary through the base manager without a refresh (%o)",
    async (outcome, expected) => {
      mockRepair.mockResolvedValue(outcome);

      await expect(
        buildCodeGraph({
          kind: 'workspace_base',
          workspaceId: 'preserved',
          background: { trigger: 'summary-repair', repoId: 'repo' },
        }),
      ).resolves.toEqual({
        kind: 'workspace_base',
        repositories: [{ repositoryId: 'repo', outcome: expected }],
      });
      expect(mockRepair).toHaveBeenCalledWith('preserved', 'repo');
      expect(mockMaintain).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    },
  );
});

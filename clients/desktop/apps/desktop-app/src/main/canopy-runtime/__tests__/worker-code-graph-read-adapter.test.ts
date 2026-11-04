import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '@canopy/code-graph/engine';
import { executeCodeGraphRead } from '@canopy/code-graph/host/read-host';
import type {
  CodeGraphWorkerReadRequest,
  CodeGraphWorkerReadResponse,
} from '@canopy/code-graph/host/read-protocol';
import { acquireCodeGraphWriterLease } from '@canopy/code-graph/store/writer-lease';
import {
  CodeGraphReadFailureError,
  CodeGraphWorkerReadError,
} from '@canopy/code-graph/host/read-scheduler';
import {
  createCodeGraphReadService,
  type CodeGraphReadServiceHost,
  type CodeGraphWorkspaceBaseGraph,
} from '@canopy/code-graph/host/read-service';
import type {
  CodeGraphBuildState,
  CodeGraphSnapshotEnvelope,
} from '@canopy/code-graph/types/code-graph-tools';
import {
  createFixtureRepository,
  GOLDEN_REPO_ID,
} from '@canopy/code-graph/__tests__/golden/fixture-repository';
import {
  CanopyOperationError,
  createCanopyDispatcher,
} from '@canopy/core-runtime';
import {
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCodeGraphReadServiceWorker } from '@canopy/code-graph/host/read-worker';
import { createWorkerCodeGraphReadAdapter } from '../worker-code-graph-read-adapter';
import {
  readWorkspaceBaseCodeGraphSummaries,
  readWorktreeCodeGraph,
  readWorktreeCodeGraphStatus,
  validateWorktreeCodeGraphLanguages,
} from '../../code-graph/graph-reads';
import { installCodeGraphReadDispatcherForTests } from '../../__tests__/helpers/code-graph-read-dispatcher';

jest.setTimeout(120_000);

const CALLER: CanopyCallerDescriptor = {
  principalId: 'test',
  clientInstanceId: 'test',
  authorityId: 'test',
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.read, WORKER_CODE_GRAPH_GRANTS.write],
};
const SCOPE = { workspaceId: 'project', worktreeId: 'worktree' };

let root: string;
let repo: string;
let graphPath: string;
let buildState: CodeGraphBuildState = 'idle';

function host(
  overrides: Partial<CodeGraphReadServiceHost> = {},
): CodeGraphReadServiceHost {
  return {
    scheduler: { run: ({ request }) => executeCodeGraphRead(request) },
    dbPath: () => graphPath,
    hasGraph: () => existsSync(graphPath),
    buildState: () => buildState,
    worktreeRoot: () => repo,
    repositories: () =>
      Promise.resolve([{ repoId: GOLDEN_REPO_ID, rootPath: repo }]),
    resourcesDir: () => path.join(root, 'resources'),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// The code-graph subset of the desktop dispatcher, as these tests call it.
interface CodeGraphReadDispatcher {
  query(
    name: string,
    params: unknown,
    options: { caller: CanopyCallerDescriptor; signal?: AbortSignal },
  ): Promise<unknown>;
  instruction(
    name: string,
    params: unknown,
    options: {
      caller: CanopyCallerDescriptor;
      metadata: { idempotencyKey: string };
    },
  ): Promise<unknown>;
}

function dispatcherOver(serviceHost: CodeGraphReadServiceHost): {
  adapter: ReturnType<typeof createWorkerCodeGraphReadAdapter>;
  dispatcher: CodeGraphReadDispatcher;
} {
  const service = createCodeGraphReadService(serviceHost);
  const adapter = createWorkerCodeGraphReadAdapter(() =>
    Promise.resolve(createCodeGraphReadServiceWorker(service)),
  );
  return {
    adapter,
    dispatcher: createCanopyDispatcher({
      profile: 'worker',
      definitions: {
        queries: WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
        instructions: WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
        streams: {},
      },
      handlers: {
        queries: adapter.queries,
        instructions: adapter.instructions,
        streams: {},
      },
    }),
  };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'worker-code-graph-adapter-'));
  repo = path.join(root, 'repo');
  createFixtureRepository(repo);
  graphPath = path.join(root, 'worktree', 'graph.db');
  const engine = await CodeGraphEngine.open({
    dbPath: graphPath,
    repositories: [{ repoId: GOLDEN_REPO_ID, rootPath: repo }],
    worktreeRootPath: repo,
  });
  try {
    await engine.buildOrUpdate();
  } finally {
    engine.close();
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  buildState = 'idle';
});

describe('worker.codeGraph reads on the desktop dispatcher', () => {
  it('reports graph presence and build state beside every read', async () => {
    const uninstall = installCodeGraphReadDispatcherForTests(
      dispatcherOver(host()).adapter,
    );
    try {
      buildState = 'running';
      await expect(
        readWorktreeCodeGraphStatus({ projectId: 'project', worktreeId: 'x' }),
      ).resolves.toEqual({ presence: 'present', buildState: 'running' });
      await expect(
        dispatcherOver(host()).dispatcher.query(
          'worker.codeGraph.status.get',
          { scope: SCOPE },
          { caller: CALLER },
        ),
      ).resolves.toEqual({ presence: 'present', buildState: 'running' });
      const answer = await readWorktreeCodeGraph(
        { projectId: 'project', worktreeId: 'worktree' },
        'context',
        { kind: 'summary' },
      );
      expect(answer.presence).toBe('present');
      expect(answer.buildState).toBe('running');
      expect(answer.result.kind).toBe('readonly-summary');
    } finally {
      uninstall();
    }
  });

  it('reads a missing graph as missing and says it is absent', async () => {
    const missing = path.join(root, 'missing', 'graph.db');
    const uninstall = installCodeGraphReadDispatcherForTests(
      dispatcherOver(
        host({ dbPath: () => missing, hasGraph: () => existsSync(missing) }),
      ).adapter,
    );
    try {
      await expect(
        readWorktreeCodeGraph(
          { projectId: 'project', worktreeId: 'worktree' },
          'ui-summary',
          { kind: 'summary' },
        ),
      ).resolves.toEqual({
        presence: 'absent',
        buildState: 'idle',
        result: { kind: 'readonly-summary', value: { state: 'missing' } },
      });
    } finally {
      uninstall();
    }
  });

  it.each([
    [
      'busy',
      'resource_exhausted',
      'worker.codeGraph.read.busy',
      'same_request',
    ],
    [
      'queue-timeout',
      'deadline_exceeded',
      'worker.codeGraph.read.queueTimeout',
      'same_request',
    ],
    [
      'execution-timeout',
      'deadline_exceeded',
      'worker.codeGraph.read.executionTimeout',
      'same_request',
    ],
    [
      'worker-exit',
      'unavailable',
      'worker.codeGraph.read.hostExit',
      'same_request',
    ],
    ['canceled', 'cancelled', 'worker.codeGraph.read.canceled', 'never'],
    [
      'invalid-response',
      'internal',
      'worker.codeGraph.read.invalidResponse',
      'never',
    ],
    [
      'database-error',
      'internal',
      'worker.codeGraph.read.databaseError',
      'never',
    ],
  ] as const)(
    'keeps the %s refusal across the boundary',
    async (failure, kind, code, retry) => {
      const { adapter, dispatcher } = dispatcherOver(
        host({
          scheduler: {
            run: () =>
              Promise.resolve({
                ok: false,
                code: failure,
                message:
                  'The retained Code Graph could not be read. Try again.',
              }),
          },
        }),
      );
      const error = await dispatcher
        .query(
          'worker.codeGraph.query',
          {
            scope: SCOPE,
            queryKind: 'query',
            read: { kind: 'calls', calls: [] },
          },
          { caller: CALLER },
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CanopyOperationError);
      expect(error).toMatchObject({
        payload: { kind, code, retry: { kind: retry } },
      });

      const uninstall = installCodeGraphReadDispatcherForTests(adapter);
      try {
        const read = await readWorktreeCodeGraph(
          { projectId: 'project', worktreeId: 'worktree' },
          'query',
          { kind: 'calls', calls: [] },
        ).catch((caught: unknown) => caught);
        expect(read).toBeInstanceOf(CodeGraphReadFailureError);
        expect(read).toMatchObject({ readFailure: failure });
      } finally {
        uninstall();
      }
    },
  );

  it('cancels a read when its caller aborts', async () => {
    let received: AbortSignal | undefined;
    const { dispatcher } = dispatcherOver(
      host({
        scheduler: {
          run: ({ signal }) =>
            new Promise((_resolve, reject) => {
              received = signal;
              signal?.addEventListener('abort', () =>
                reject(
                  new CodeGraphWorkerReadError(
                    'canceled',
                    'Code-graph read canceled.',
                  ),
                ),
              );
            }),
        },
      }),
    );
    const controller = new AbortController();
    const read = dispatcher
      .query(
        'worker.codeGraph.query',
        {
          scope: SCOPE,
          queryKind: 'query',
          read: { kind: 'calls', calls: [] },
        },
        { caller: CALLER, signal: controller.signal },
      )
      .catch((caught: unknown) => caught);
    await new Promise((resolve) => setImmediate(resolve));
    expect(received?.aborted).toBe(false);
    controller.abort();
    const error = await read;
    expect(received?.aborted).toBe(true);
    expect(error).toBeInstanceOf(CanopyOperationError);
  });

  it('exports and imports a snapshot through the worker, and refuses an import during a build', async () => {
    const { dispatcher } = dispatcherOver(host());
    const exported = await dispatcher.query(
      'worker.codeGraph.snapshot.export',
      { scope: SCOPE },
      { caller: CALLER },
    );
    const snapshot: unknown = Reflect.get(exported as object, 'snapshot');
    expect(snapshot).toMatchObject({
      generatedAt: '2026-01-01T00:00:00.000Z',
      repository: { repoId: GOLDEN_REPO_ID },
    });

    const target = path.join(root, 'imported', 'graph.db');
    const importer = dispatcherOver(
      host({ dbPath: () => target, hasGraph: () => existsSync(target) }),
    ).dispatcher;
    buildState = 'queued';
    await expect(
      importer.instruction(
        'worker.codeGraph.snapshot.import',
        { scope: SCOPE, snapshot },
        { caller: CALLER, metadata: { idempotencyKey: 'import-during-build' } },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.codeGraph.invalidState',
      },
    });
    expect(existsSync(target)).toBe(false);

    buildState = 'idle';
    const imported = await importer.instruction(
      'worker.codeGraph.snapshot.import',
      { scope: SCOPE, snapshot },
      { caller: CALLER, metadata: { idempotencyKey: 'import' } },
    );
    expect(Reflect.get(imported as object, 'filesImported')).toBeGreaterThan(0);
    expect(Reflect.get(imported as object, 'symbolsImported')).toBeGreaterThan(
      0,
    );

    const again = await importer.query(
      'worker.codeGraph.snapshot.export',
      { scope: SCOPE },
      { caller: CALLER },
    );
    expect(again).toEqual(exported);
  });

  it('carries graph answers and snapshots past the bounded error-details JSON limits', async () => {
    const exported = await dispatcherOver(host()).dispatcher.query(
      'worker.codeGraph.snapshot.export',
      { scope: SCOPE },
      { caller: CALLER },
    );
    const real: unknown = Reflect.get(exported as object, 'snapshot');
    if (typeof real !== 'object' || real === null)
      throw new Error('No snapshot was exported.');
    const files: unknown = Reflect.get(real, 'files');
    if (!Array.isArray(files)) throw new Error('The snapshot has no files.');
    const fileList: unknown[] = files;
    const first: unknown = fileList[0];
    if (typeof first !== 'object' || first === null)
      throw new Error('The snapshot has no files.');
    const big = {
      ...real,
      files: [
        ...fileList,
        ...Array.from({ length: 1_500 }, (_, index) => ({
          ...first,
          relativePath: `generated/file-${index}.ts`,
        })),
      ],
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(32_768);
    // A real export with more files: the envelope the read host would answer.
    const envelope = big as unknown as CodeGraphSnapshotEnvelope;
    const hits = Array.from({ length: 3_000 }, (_, index) => ({
      qualifiedName: `src/generated.ts::symbol${index}`,
    }));
    const tasks: CodeGraphWorkerReadRequest['task']['kind'][] = [];
    const { dispatcher } = dispatcherOver(
      host({
        scheduler: {
          run: ({ request }): Promise<CodeGraphWorkerReadResponse> => {
            tasks.push(request.task.kind);
            if (request.task.kind === 'snapshot-export')
              return Promise.resolve({
                ok: true,
                result: { kind: 'snapshot-export', value: envelope },
              });
            if (request.task.kind === 'snapshot-import')
              return Promise.resolve({
                ok: true,
                result: {
                  kind: 'snapshot-import',
                  value: {
                    filesImported: 1_501,
                    symbolsImported: 0,
                    edgesImported: 0,
                    warnings: [],
                  },
                },
              });
            return Promise.resolve({
              ok: true,
              result: { kind: 'calls', value: [hits] },
            });
          },
        },
      }),
    );

    const answer = await dispatcher.query(
      'worker.codeGraph.query',
      {
        scope: SCOPE,
        queryKind: 'query',
        read: { kind: 'calls', calls: [{ method: 'callers', target: 'x' }] },
      },
      { caller: CALLER },
    );
    expect(answer).toMatchObject({ result: { kind: 'calls', value: [hits] } });
    await expect(
      dispatcher.query(
        'worker.codeGraph.snapshot.export',
        { scope: SCOPE },
        { caller: CALLER },
      ),
    ).resolves.toEqual({ snapshot: big });
    await expect(
      dispatcher.instruction(
        'worker.codeGraph.snapshot.import',
        { scope: SCOPE, snapshot: big },
        { caller: CALLER, metadata: { idempotencyKey: 'big-import' } },
      ),
    ).resolves.toMatchObject({ filesImported: 1_501 });
    expect(tasks).toEqual(['calls', 'snapshot-export', 'snapshot-import']);
  });

  it('replays a keyed import instead of importing again, and refuses the key with other parameters', async () => {
    const exported = await dispatcherOver(host()).dispatcher.query(
      'worker.codeGraph.snapshot.export',
      { scope: SCOPE },
      { caller: CALLER },
    );
    const snapshot: unknown = Reflect.get(exported as object, 'snapshot');
    let imports = 0;
    const { dispatcher } = dispatcherOver(
      host({
        scheduler: {
          run: () => {
            imports += 1;
            return Promise.resolve({
              ok: true,
              result: {
                kind: 'snapshot-import',
                value: {
                  filesImported: imports,
                  symbolsImported: 0,
                  edgesImported: 0,
                  warnings: [],
                },
              },
            });
          },
        },
      }),
    );
    const send = (params: unknown): Promise<unknown> =>
      dispatcher.instruction('worker.codeGraph.snapshot.import', params, {
        caller: CALLER,
        metadata: { idempotencyKey: 'replayed-import' },
      });

    await expect(send({ scope: SCOPE, snapshot })).resolves.toMatchObject({
      filesImported: 1,
    });
    await expect(send({ scope: SCOPE, snapshot })).resolves.toMatchObject({
      filesImported: 1,
    });
    expect(imports).toBe(1);
    await expect(
      send({ scope: SCOPE, repoId: GOLDEN_REPO_ID, snapshot }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'worker.codeGraph.idempotencyKeyReused',
      },
    });
    expect(imports).toBe(1);
  });

  it('runs a keyed import again after a refusal its caller may retry', async () => {
    const exported = await dispatcherOver(host()).dispatcher.query(
      'worker.codeGraph.snapshot.export',
      { scope: SCOPE },
      { caller: CALLER },
    );
    const snapshot: unknown = Reflect.get(exported as object, 'snapshot');
    let attempts = 0;
    const { dispatcher } = dispatcherOver(
      host({
        scheduler: {
          run: (): Promise<CodeGraphWorkerReadResponse> => {
            attempts += 1;
            return Promise.resolve(
              attempts === 1
                ? {
                    ok: false,
                    code: 'busy',
                    message:
                      'The retained Code Graph could not be read. Try again.',
                  }
                : {
                    ok: true,
                    result: {
                      kind: 'snapshot-import',
                      value: {
                        filesImported: 1,
                        symbolsImported: 0,
                        edgesImported: 0,
                        warnings: [],
                      },
                    },
                  },
            );
          },
        },
      }),
    );
    const send = (): Promise<unknown> =>
      dispatcher.instruction(
        'worker.codeGraph.snapshot.import',
        { scope: SCOPE, snapshot },
        { caller: CALLER, metadata: { idempotencyKey: 'retried-import' } },
      );

    await expect(send()).rejects.toMatchObject({
      payload: {
        code: 'worker.codeGraph.read.busy',
        retry: { kind: 'same_idempotency_key' },
      },
    });
    await expect(send()).resolves.toMatchObject({ filesImported: 1 });
    await expect(send()).resolves.toMatchObject({ filesImported: 1 });
    expect(attempts).toBe(2);
  });

  it('refuses an import as busy while another writer holds the graph', async () => {
    const exported = await dispatcherOver(host()).dispatcher.query(
      'worker.codeGraph.snapshot.export',
      { scope: SCOPE },
      { caller: CALLER },
    );
    const snapshot: unknown = Reflect.get(exported as object, 'snapshot');
    const target = path.join(root, 'leased', 'graph.db');
    mkdirSync(path.dirname(target), { recursive: true });
    const lease = await acquireCodeGraphWriterLease(target);
    try {
      await expect(
        dispatcherOver(
          host({ dbPath: () => target, hasGraph: () => existsSync(target) }),
        ).dispatcher.instruction(
          'worker.codeGraph.snapshot.import',
          { scope: SCOPE, snapshot },
          { caller: CALLER, metadata: { idempotencyKey: 'leased-import' } },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'resource_exhausted',
          code: 'worker.codeGraph.read.busy',
          retry: { kind: 'same_idempotency_key' },
        },
      });
    } finally {
      lease.release();
    }
  });

  it('refuses a scope ID that could name another directory', async () => {
    const run = jest.fn();
    const { dispatcher } = dispatcherOver(host({ scheduler: { run } }));
    for (const worktreeId of ['..', 'a/b', 'a\\b'])
      await expect(
        dispatcher.query(
          'worker.codeGraph.query',
          {
            scope: { workspaceId: 'project', worktreeId },
            queryKind: 'query',
            read: { kind: 'summary' },
          },
          { caller: CALLER },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'worker.codeGraph.invalidScope',
        },
      });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a malformed snapshot before any graph work', async () => {
    const run = jest.fn();
    const { dispatcher } = dispatcherOver(host({ scheduler: { run } }));
    await expect(
      dispatcher.instruction(
        'worker.codeGraph.snapshot.import',
        { scope: SCOPE, snapshot: { schemaVersion: 'nope' } },
        { caller: CALLER, metadata: { idempotencyKey: 'malformed' } },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'worker.codeGraph.invalidScope',
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('validates the worktree custom-language configuration', async () => {
    const uninstall = installCodeGraphReadDispatcherForTests(
      dispatcherOver(host()).adapter,
    );
    try {
      await expect(
        validateWorktreeCodeGraphLanguages({
          projectId: 'project',
          worktreeId: 'worktree',
        }),
      ).resolves.toEqual({ config: 'absent', languages: [], diagnostics: [] });
      const configDir = path.join(repo, '.canopy', 'code-graph');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        path.join(configDir, 'languages.json'),
        JSON.stringify({
          version: 1,
          languages: [
            {
              id: 'zig',
              extensions: ['.ZIG'],
              wasmFile: 'tree-sitter-zig.wasm',
              tagsFiles: ['tags.scm'],
            },
            { id: 'typescript', extensions: ['.ts'] },
          ],
        }),
      );
      const validation = await validateWorktreeCodeGraphLanguages({
        projectId: 'project',
        worktreeId: 'worktree',
      });
      expect(validation.config).toBe('present');
      expect(validation.languages).toEqual([
        { id: 'zig', extensions: ['.zig'] },
      ]);
      expect(validation.diagnostics).toHaveLength(1);
    } finally {
      rmSync(path.join(repo, '.canopy'), { recursive: true, force: true });
      uninstall();
    }
  });
});

describe('workspace base summaries through worker.codeGraph.query', () => {
  const BASE_SCOPE = { kind: 'workspace_base', workspaceId: 'project' };

  it("reads each repository's published base summary with its build state", async () => {
    const runs: Array<{ key: string; diagnosticOwner: unknown }> = [];
    const serviceHost = host({
      scheduler: {
        run: (input) => {
          runs.push({ key: input.key, diagnosticOwner: input.diagnosticOwner });
          return executeCodeGraphRead(input.request);
        },
      },
      workspaceBases: () =>
        Promise.resolve({
          prepared: true,
          repositories: [
            {
              repoId: 'published',
              graph: (): Promise<CodeGraphWorkspaceBaseGraph> =>
                Promise.resolve({
                  key: 'base/published',
                  buildState: 'queued',
                  published: {
                    dbPath: graphPath,
                    behindCheckout: () => Promise.resolve(true),
                  },
                }),
            },
            {
              repoId: 'unpublished',
              graph: (): Promise<CodeGraphWorkspaceBaseGraph> =>
                Promise.resolve({
                  key: 'base/unpublished',
                  buildState: 'running',
                  published: null,
                }),
            },
            {
              repoId: 'unresolved',
              graph: (): Promise<CodeGraphWorkspaceBaseGraph> =>
                Promise.reject(new Error('No checkout.')),
            },
          ],
        }),
    });
    const { adapter, dispatcher } = dispatcherOver(serviceHost);
    const uninstall = installCodeGraphReadDispatcherForTests(adapter);
    try {
      const { repositories } =
        await readWorkspaceBaseCodeGraphSummaries('project');
      const readySummary: unknown = expect.objectContaining({ state: 'ready' });
      expect(repositories).toEqual([
        expect.objectContaining({
          repoId: 'published',
          state: 'read',
          buildState: 'queued',
          published: true,
          behindCheckout: true,
          summary: readySummary,
        }),
        {
          repoId: 'unpublished',
          state: 'read',
          buildState: 'running',
          published: false,
          behindCheckout: false,
          summary: { state: 'missing' },
        },
        {
          repoId: 'unresolved',
          state: 'failed',
          buildState: null,
          failure: 'database-error',
        },
      ]);
      expect(runs).toEqual([
        {
          key: 'base/published',
          diagnosticOwner: { projectId: 'project', worktreeId: '' },
        },
      ]);
      await expect(
        dispatcher.query(
          'worker.codeGraph.query',
          {
            scope: BASE_SCOPE,
            queryKind: 'ui-summary',
            read: { kind: 'summary' },
          },
          { caller: CALLER },
        ),
      ).resolves.toMatchObject({
        presence: 'present',
        buildState: 'running',
        result: { kind: 'workspace-base-summary' },
      });
    } finally {
      uninstall();
    }
  });

  it('reads every repository as missing before the workspace prepares its bases', async () => {
    const run = jest.fn();
    const { dispatcher } = dispatcherOver(
      host({
        scheduler: { run },
        workspaceBases: () =>
          Promise.resolve({ prepared: false, repoIds: ['a', 'b'] }),
      }),
    );
    const missing = (repoId: string): unknown => ({
      repoId,
      state: 'read',
      buildState: null,
      published: false,
      behindCheckout: false,
      summary: { state: 'missing' },
    });
    await expect(
      dispatcher.query(
        'worker.codeGraph.query',
        {
          scope: BASE_SCOPE,
          queryKind: 'ui-summary',
          read: { kind: 'summary' },
        },
        { caller: CALLER },
      ),
    ).resolves.toEqual({
      presence: 'absent',
      buildState: 'idle',
      result: {
        kind: 'workspace-base-summary',
        value: { repositories: [missing('a'), missing('b')] },
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses workspace bases a worker does not serve, and any read but the summary', async () => {
    const { dispatcher } = dispatcherOver(host());
    await expect(
      dispatcher.query(
        'worker.codeGraph.query',
        {
          scope: BASE_SCOPE,
          queryKind: 'ui-summary',
          read: { kind: 'summary' },
        },
        { caller: CALLER },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.codeGraph.invalidState',
      },
    });
    const serving = dispatcherOver(
      host({
        workspaceBases: () => Promise.resolve({ prepared: false, repoIds: [] }),
      }),
    );
    for (const request of [
      { queryKind: 'context', read: { kind: 'summary' } },
      { queryKind: 'ui-summary', read: { kind: 'build-stamp' } },
    ])
      await expect(
        serving.dispatcher.query(
          'worker.codeGraph.query',
          { scope: BASE_SCOPE, ...request },
          { caller: CALLER },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });
});

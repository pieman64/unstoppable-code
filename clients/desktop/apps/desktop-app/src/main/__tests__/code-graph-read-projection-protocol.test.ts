/** PRIVATE CANDIDATE: unrun; depends on R2/B1/B3. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '@canopy/desktop-shared/node/code-graph/engine';
import {
  codeGraphSummaryProjectionV1Schema,
  type CodeGraphSummaryProjectionV1,
  type ReadCodeGraphSummaryProjectionResult,
} from '@canopy/desktop-shared/node/code-graph/summary-projection';
import { parseGraphDiagnostics } from '@canopy/desktop-shared/node/code-graph/diagnostics';
import type { CodeGraphDiagnostics } from '@canopy/desktop-shared/types/code-graph';
class Child extends EventEmitter {
  public readonly postMessage = jest.fn();
  public readonly kill = jest.fn(() => true);
}
const children: Child[] = [];
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (): Child => {
      const child = new Child();
      children.push(child);
      return child;
    },
  },
}));
const mockTelemetry = jest.fn();
const mockDiagnostic = jest.fn();
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphQueryTelemetry: (input: unknown): void => {
    mockTelemetry(input);
  },
  recordCodeGraphReadDiagnostic: (input: unknown): void => {
    mockDiagnostic(input);
  },
  flushCodeGraphQueryTelemetry: jest.fn(),
  flushCodeGraphReadDiagnostics: jest.fn(),
}));
import {
  runCodeGraphWorkerRead,
  fenceCodeGraphReads,
  cancelCodeGraphReads,
  resetCodeGraphReadRunnerForTests,
  type CodeGraphWorkerReadTask,
} from '../code-graph/read-runner';
import { executeCodeGraphRead } from '../code-graph/read-worker';
const observed = {
  schemaVersion: 1,
  extractorVersion: 1,
  projectionRevision: null,
  lastBuildAt: 10,
  completedBuildAt: null,
  derivedAt: null,
};
describe('dedicated projection union transport', () => {
  beforeEach(() => {
    resetCodeGraphReadRunnerForTests();
    children.length = 0;
    mockTelemetry.mockClear();
    mockDiagnostic.mockReset();
  });
  afterEach(async () => {
    const wait = cancelCodeGraphReads('workspace/worktree');
    for (const child of children) child.emit('exit', 0);
    await wait;
  });
  it('settles a read even when the local diagnostic recorder throws', async () => {
    mockDiagnostic.mockImplementationOnce(() => {
      throw new Error('Diagnostic storage is unavailable.');
    });
    const pending = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: {
        dbPath: '/private/graph.db',
        task: { kind: 'readonly-summary' },
      },
    });
    const response = {
      ok: true,
      result: { kind: 'readonly-summary', value: { state: 'missing' } },
    };
    expect(() => children[0]?.emit('message', response)).not.toThrow();
    await expect(pending).resolves.toEqual(response);
    expect(mockTelemetry).toHaveBeenCalledTimes(1);
    expect(mockDiagnostic).toHaveBeenCalledTimes(1);
  });
  it('cancels an active read even when local diagnostics throw, retaining the actual exit fence', async () => {
    mockDiagnostic.mockImplementationOnce(() => {
      throw new Error('Diagnostic storage is unavailable.');
    });
    const pending = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: {
        dbPath: '/private/graph.db',
        task: { kind: 'readonly-summary' },
      },
    });
    expect(() => {
      void pending.catch(() => undefined);
    }).not.toThrow();
    const cleanup = cancelCodeGraphReads('workspace/worktree');
    let closed = false;
    void cleanup.then(() => {
      closed = true;
    });
    await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
    expect(closed).toBe(false);
    children[0]?.emit('exit', 0);
    await cleanup;
    expect(closed).toBe(true);
    expect(mockDiagnostic).toHaveBeenCalledTimes(1);
  });
  it('removes a fenced queued read even when local diagnostics throw', async () => {
    const keys = ['occupied-a', 'occupied-b', 'occupied-c'];
    const occupied = keys.map((key) =>
      runCodeGraphWorkerRead({
        key,
        kind: 'context',
        request: {
          dbPath: '/private/graph.db',
          task: { kind: 'readonly-summary' },
        },
      }),
    );
    for (const read of occupied) void read.catch(() => undefined);
    const queued = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: {
        dbPath: '/private/graph.db',
        task: { kind: 'readonly-summary' },
      },
    });
    void queued.catch(() => undefined);
    expect(children).toHaveLength(3);
    const release = fenceCodeGraphReads('workspace/worktree');
    mockDiagnostic.mockImplementationOnce(() => {
      throw new Error('Diagnostic storage is unavailable.');
    });
    try {
      const cleanup = cancelCodeGraphReads('workspace/worktree');
      await expect(queued).rejects.toMatchObject({ reason: 'canceled' });
      await cleanup;
      expect(children).toHaveLength(3);
      expect(mockDiagnostic).toHaveBeenCalledTimes(1);
    } finally {
      release();
      const cleanup = Promise.all(keys.map((key) => cancelCodeGraphReads(key)));
      for (const child of children) child.emit('exit', 0);
      await cleanup;
    }
  });
  it.each<ReadCodeGraphSummaryProjectionResult>([
    { state: 'missing' },
    {
      state: 'pending',
      reason: 'projection-missing',
      observed,
      diagnostics: null,
    },
    {
      state: 'pending',
      reason: 'projection-invalid',
      observed,
      diagnostics: null,
    },
    {
      state: 'pending',
      reason: 'projection-mismatch',
      observed,
      diagnostics: null,
    },
    {
      state: 'pending',
      reason: 'build-incomplete',
      observed,
      diagnostics: null,
    },
    { state: 'error', classification: 'permission-denied' },
    { state: 'error', classification: 'busy' },
    { state: 'error', classification: 'corrupt' },
    { state: 'error', classification: 'unsupported-schema' },
    { state: 'error', classification: 'io' },
  ])('preserves %j without replacing absence with zero', async (value) => {
    const pending = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: {
        dbPath: '/private/graph.db',
        task: { kind: 'readonly-summary' },
      },
    });
    children[0]?.emit('message', {
      ok: true,
      result: { kind: 'readonly-summary', value },
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      result: { kind: 'readonly-summary', value },
    });
    expect(JSON.stringify(value)).not.toContain('fileCount');
    expect(mockTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: value.state === 'error' ? 'error' : 'success',
      }),
    );
  });
  it('accepts measured zero in a strict ready projection and not as pending placeholder', async () => {
    const counts = {
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      contextUnresolvedEdgeCount: 0,
      contextFilesWithErrors: 0,
      legacyUnresolvedEdgeCount: 0,
      legacyFilesWithErrors: 0,
      communityCount: 0,
      flowCount: 0,
    };
    const value: ReadCodeGraphSummaryProjectionResult = {
      state: 'ready',
      diagnostics: null,
      projection: {
        formatVersion: 1,
        schemaVersion: 1,
        extractorVersion: 1,
        projectionRevision: 1,
        lastBuildAt: null,
        completedBuildAt: null,
        derivedAt: null,
        assembly: 'imported',
        customLanguagesFingerprint: null,
        repositories: [],
        totals: counts,
        topCommunities: [],
        customLanguages: null,
      },
    };
    const pending = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: {
        dbPath: '/private/graph.db',
        task: { kind: 'readonly-summary' },
      },
    });
    children[0]?.emit('message', {
      ok: true,
      result: { kind: 'readonly-summary', value },
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      result: { kind: 'readonly-summary', value },
    });
  });
  it('rejects malformed ready payload instead of claiming a measured zero', async () => {
    const pending = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: {
        dbPath: '/private/graph.db',
        task: { kind: 'readonly-summary' },
      },
    });
    children[0]?.emit('message', {
      ok: true,
      result: {
        kind: 'readonly-summary',
        value: {
          state: 'ready',
          projection: { totals: { fileCount: 0 } },
          diagnostics: null,
        },
      },
    });
    await expect(pending).rejects.toMatchObject({
      reason: 'malformed-response',
    });
    expect(mockDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ readFailure: 'invalid-response' }),
    );
  });
  it('requires a discriminated safe worker failure code', async () => {
    const pending = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: {
        dbPath: '/private/graph.db',
        task: { kind: 'readonly-summary' },
      },
    });
    children[0]?.emit('message', {
      ok: false,
      message: 'SELECT /private/graph.db',
    });
    await expect(pending).rejects.toMatchObject({
      reason: 'malformed-response',
    });
  });
  const identityTask: CodeGraphWorkerReadTask = {
    kind: 'base-identity',
    identity: {
      canonicalRepoRoot: '/private/repo',
      repoId: 'repo',
      customLanguagesFingerprint: 'none',
    },
    gitHead: 'head',
  };
  const readable = {
    state: 'readable',
    matches: {
      schema: true,
      extractor: true,
      canonicalRoot: true,
      customLanguagesFingerprint: true,
      repoId: true,
      gitHead: true,
      completed: true,
    },
    observed: {
      schemaVersion: 1,
      extractorVersion: 1,
      lastBuildAt: 10,
      completedBuildAt: 10,
    },
    repository: { repoId: 'repo', gitHead: 'head' },
  };
  function reply(
    task: CodeGraphWorkerReadTask,
    result: unknown,
  ): Promise<unknown> {
    const pending = runCodeGraphWorkerRead({
      key: 'workspace/worktree',
      kind: 'context',
      request: { dbPath: '/private/graph.db', task },
    });
    const child = children[children.length - 1];
    if (child === undefined) throw new Error('Missing child');
    child.emit('message', { ok: true, result });
    return pending;
  }
  const pendingArm = {
    state: 'pending',
    reason: 'projection-missing',
    observed,
    diagnostics: null,
  };
  const counts = {
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    contextUnresolvedEdgeCount: 0,
    contextFilesWithErrors: 0,
    legacyUnresolvedEdgeCount: 0,
    legacyFilesWithErrors: 0,
    communityCount: 0,
    flowCount: 0,
  };
  const readyArm: Extract<
    ReadCodeGraphSummaryProjectionResult,
    { state: 'ready' }
  > = {
    state: 'ready',
    diagnostics: null,
    projection: {
      formatVersion: 1,
      schemaVersion: 1,
      extractorVersion: 1,
      projectionRevision: 1,
      lastBuildAt: null,
      completedBuildAt: null,
      derivedAt: null,
      assembly: 'imported',
      customLanguagesFingerprint: null,
      repositories: [],
      totals: counts,
      topCommunities: [],
      customLanguages: null,
    },
  };
  function sizedProjection(bytes: number): CodeGraphSummaryProjectionV1 {
    const projection: CodeGraphSummaryProjectionV1 = {
      ...readyArm.projection,
      repositories: Array.from({ length: 1_024 }, (_, index) => ({
        repoId: `repo-${index}`,
        gitHead: null,
        counts: { ...counts },
      })),
    };
    let remaining =
      bytes - Buffer.byteLength(JSON.stringify(projection), 'utf8');
    for (const repository of projection.repositories) {
      const added = Math.min(remaining, 1_024 - repository.repoId.length);
      repository.repoId += 'x'.repeat(added);
      remaining -= added;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(projection), 'utf8')).toBe(bytes);
    return projection;
  }
  function sizedDiagnostics(bytes: number): CodeGraphDiagnostics {
    const diagnostics: CodeGraphDiagnostics = {
      freshness: 'stat',
      recordedAt: 1,
      repositories: [
        {
          repoId: 'repo',
          symbolCount: 0,
          edgeCount: 0,
          communityLimits: {
            symbolResolution: 0,
            fileProjection: 0,
            maxSymbols: 0,
            maxEdges: 0,
          },
          eligibleFiles: 0,
          unsupportedFiles: 0,
          excludedFiles: 0,
          examples: [],
          filesWithErrors: 0,
          oversizedFiles: 0,
          communityStatus: 'not-computed',
          flowStatus: 'not-computed',
          warnings: [''],
          edges: [],
        },
      ],
    };
    const repository = diagnostics.repositories[0];
    if (repository === undefined)
      throw new Error('Missing diagnostic repository');
    repository.warnings[0] = 'w'.repeat(
      bytes - Buffer.byteLength(JSON.stringify(diagnostics), 'utf8'),
    );
    expect(Buffer.byteLength(JSON.stringify(diagnostics), 'utf8')).toBe(bytes);
    expect(parseGraphDiagnostics(JSON.stringify(diagnostics))).toEqual(
      diagnostics,
    );
    return diagnostics;
  }
  it.each(['projection', 'diagnostics', 'both', 'pending'])(
    'accepts independently bounded 1MiB %s components with envelope overhead',
    async (component) => {
      const projection =
        component === 'diagnostics' || component === 'pending'
          ? readyArm.projection
          : sizedProjection(1_048_576);
      expect(
        codeGraphSummaryProjectionV1Schema.safeParse(projection).success,
      ).toBe(true);
      const diagnostics =
        component === 'projection' ? null : sizedDiagnostics(1_048_576);
      const value =
        component === 'pending'
          ? { ...pendingArm, diagnostics }
          : { ...readyArm, projection, diagnostics };
      expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeGreaterThan(
        1_048_576,
      );
      const result = { kind: 'readonly-summary', value };
      await expect(
        reply({ kind: 'readonly-summary' }, result),
      ).resolves.toEqual({ ok: true, result });
    },
  );
  it.each([
    'projection',
    'diagnostics',
    'extra-envelope',
    'wrong-kind',
    'extra-diagnostic',
  ])(
    'rejects oversized or malformed %s summary components',
    async (component) => {
      const projection = sizedProjection(
        component === 'projection' ? 1_048_577 : 1_048_576,
      );
      expect(
        codeGraphSummaryProjectionV1Schema.safeParse(projection).success,
      ).toBe(component !== 'projection');
      const diagnostics = sizedDiagnostics(
        component === 'diagnostics' ? 1_048_577 : 1_048_576,
      );
      const value = {
        ...readyArm,
        projection,
        diagnostics:
          component === 'extra-diagnostic'
            ? { ...diagnostics, unexpected: true }
            : diagnostics,
        ...(component === 'extra-envelope'
          ? { unexpected: 'x'.repeat(128) }
          : {}),
      };
      if (component === 'extra-envelope')
        expect(
          Buffer.byteLength(JSON.stringify(value), 'utf8'),
        ).toBeGreaterThan(2 * 1_048_576 + 64);
      await expect(
        reply(
          { kind: 'readonly-summary' },
          {
            kind:
              component === 'wrong-kind' ? 'base-identity' : 'readonly-summary',
            value,
          },
        ),
      ).rejects.toMatchObject({ reason: 'malformed-response' });
    },
  );
  it.each([
    {
      name: 'ready outer',
      good: readyArm,
      bad: { ...readyArm, dbPath: '/private/leak.db' },
    },
    {
      name: 'ready diagnostics',
      good: {
        ...readyArm,
        diagnostics: { freshness: 'stat', recordedAt: 0, repositories: [] },
      },
      bad: {
        ...readyArm,
        diagnostics: {
          freshness: 'stat',
          recordedAt: 0,
          repositories: [],
          dbPath: '/private/leak.db',
        },
      },
    },
    {
      name: 'pending outer',
      good: pendingArm,
      bad: { ...pendingArm, message: '/private/leak.db' },
    },
    {
      name: 'pending observed',
      good: pendingArm,
      bad: {
        ...pendingArm,
        observed: { ...observed, rootPath: '/private/leak.db' },
      },
    },
    {
      name: 'error outer',
      good: { state: 'error', classification: 'io' },
      bad: {
        state: 'error',
        classification: 'io',
        message: 'SELECT /private/leak.db',
      },
    },
    {
      name: 'ready projection',
      good: readyArm,
      bad: {
        ...readyArm,
        projection: { ...readyArm.projection, dbPath: '/private/leak.db' },
      },
    },
  ])(
    'rejects extra raw paths in $name with a valid same-arm control',
    async ({ good, bad }) => {
      const task: CodeGraphWorkerReadTask = { kind: 'readonly-summary' };
      await expect(
        reply(task, { kind: 'readonly-summary', value: good }),
      ).resolves.toEqual({
        ok: true,
        result: { kind: 'readonly-summary', value: good },
      });
      await expect(
        reply(task, { kind: 'readonly-summary', value: bad }),
      ).rejects.toMatchObject({ reason: 'malformed-response' });
    },
  );
  it.each([
    {
      name: 'readable outer',
      good: readable,
      bad: { ...readable, canonicalRoot: '/private/leak' },
    },
    {
      name: 'matches',
      good: readable,
      bad: {
        ...readable,
        matches: { ...readable.matches, rootPath: '/private/leak' },
      },
    },
    {
      name: 'observed',
      good: readable,
      bad: {
        ...readable,
        observed: { ...readable.observed, rawMarker: '/private/leak' },
      },
    },
    {
      name: 'repository extra',
      good: readable,
      bad: {
        ...readable,
        repository: { ...readable.repository, rootPath: '/private/leak' },
      },
    },
    {
      name: 'repository raw path',
      good: readable,
      bad: {
        ...readable,
        repository: { repoId: '/private/leak', gitHead: 'head' },
      },
    },
    {
      name: 'error',
      good: { state: 'error', classification: 'busy' },
      bad: {
        state: 'error',
        classification: 'busy',
        message: 'SELECT /private/leak.db',
      },
    },
    {
      name: 'missing',
      good: { state: 'missing' },
      bad: { state: 'missing', dbPath: '/private/leak.db' },
    },
  ])(
    'rejects base identity $name extras/path with a valid same-arm control',
    async ({ good, bad }) => {
      await expect(
        reply(identityTask, { kind: 'base-identity', value: good }),
      ).resolves.toEqual({
        ok: true,
        result: { kind: 'base-identity', value: good },
      });
      await expect(
        reply(identityTask, { kind: 'base-identity', value: bad }),
      ).rejects.toMatchObject({ reason: 'malformed-response' });
    },
  );
  it('rejects a metadata reply for another task even when its own arm is valid', async () => {
    await expect(
      reply(
        { kind: 'readonly-summary' },
        { kind: 'base-identity', value: readable },
      ),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
  });
  it('transports maximum-size persisted diagnostics from the actual readonly worker', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'summary-envelope-'));
    const dbPath = path.join(dir, '.graph', 'graph.db');
    writeFileSync(path.join(dir, 'fixture.ts'), 'export function work() {}');
    try {
      const engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: 'repo', rootPath: dir }],
      });
      try {
        await engine.buildOrUpdate();
      } finally {
        engine.close();
      }
      const initial = await executeCodeGraphRead({
        dbPath,
        task: { kind: 'readonly-summary' },
      });
      if (
        !initial.ok ||
        initial.result.kind !== 'readonly-summary' ||
        initial.result.value.state !== 'ready' ||
        initial.result.value.diagnostics === null
      ) {
        throw new Error('Expected ready diagnostics from the generated graph');
      }
      const diagnostics = initial.result.value.diagnostics;
      const repository = diagnostics.repositories[0];
      if (repository === undefined)
        throw new Error('Missing generated repository');
      repository.warnings = [''];
      repository.warnings[0] = 'w'.repeat(
        1_048_576 - Buffer.byteLength(JSON.stringify(diagnostics), 'utf8'),
      );
      const raw = JSON.stringify(diagnostics);
      expect(Buffer.byteLength(raw, 'utf8')).toBe(1_048_576);
      const writer = new DatabaseSync(dbPath);
      try {
        writer
          .prepare(
            "UPDATE graph_metadata SET value = ? WHERE key = 'graph_diagnostics'",
          )
          .run(raw);
      } finally {
        writer.close();
      }
      const response = await executeCodeGraphRead({
        dbPath,
        task: { kind: 'readonly-summary' },
      });
      expect(response).toEqual(initial);
      if (!response.ok) throw new Error('Readonly worker failed');
      await expect(
        reply({ kind: 'readonly-summary' }, response.result),
      ).resolves.toEqual(response);
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          reader
            .prepare(
              "SELECT value FROM graph_metadata WHERE key = 'graph_diagnostics'",
            )
            .get()?.value,
        ).toBe(raw);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('validates each status-only projection value and exact response cardinality', async () => {
    const task: CodeGraphWorkerReadTask = {
      kind: 'calls',
      calls: [{ method: 'status' }],
    };
    await expect(
      reply(task, { kind: 'calls', value: [pendingArm] }),
    ).resolves.toEqual({
      ok: true,
      result: { kind: 'calls', value: [pendingArm] },
    });
    await expect(
      reply(task, {
        kind: 'calls',
        value: [{ ...pendingArm, dbPath: '/private/leak.db' }],
      }),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
  });
  it('validates the status position in a mixed structural batch without changing structural data', async () => {
    const task: CodeGraphWorkerReadTask = {
      kind: 'calls',
      calls: [
        { method: 'search', query: 'item', limit: 2 },
        { method: 'status' },
      ],
    };
    const symbols = [{ symbolId: 'symbol', filePath: 'src/item.ts' }];
    await expect(
      reply(task, { kind: 'calls', value: [symbols, pendingArm] }),
    ).resolves.toEqual({
      ok: true,
      result: { kind: 'calls', value: [symbols, pendingArm] },
    });
    await expect(
      reply(task, {
        kind: 'calls',
        value: [symbols, { ...pendingArm, dbPath: '/private/leak.db' }],
      }),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
  });
  it('does not admit legacy measured status as the dedicated status projection', async () => {
    await expect(
      reply(
        { kind: 'calls', calls: [{ method: 'status' }] },
        { kind: 'calls', value: [{ repositories: [], fileCount: 0 }] },
      ),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
  });
  it('preserves structural values without interpreting them as metadata DTOs', async () => {
    const task: CodeGraphWorkerReadTask = {
      kind: 'calls',
      calls: [{ method: 'search', query: 'item', limit: 2 }],
    };
    const value = [{ symbolId: 'symbol', filePath: 'src/item.ts' }];
    await expect(
      reply(task, { kind: 'calls', value: [value] }),
    ).resolves.toEqual({ ok: true, result: { kind: 'calls', value: [value] } });
  });
  it('rejects extra outer/result transport keys and wrong calls cardinality', async () => {
    const task: CodeGraphWorkerReadTask = { kind: 'readonly-summary' };
    await expect(
      reply(task, {
        kind: 'readonly-summary',
        value: { state: 'missing' },
        dbPath: '/private/leak.db',
      }),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
    await expect(
      reply(
        { kind: 'calls', calls: [{ method: 'status' }] },
        { kind: 'calls', value: [] },
      ),
    ).rejects.toMatchObject({ reason: 'malformed-response' });
  });
});

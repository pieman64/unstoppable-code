/**
 * Code-graph build and read goldens (CAN-5064), bound to today's in-process
 * build and read workers (`executeCodeGraphBuild`, `executeCodeGraphRead`).
 *
 * The fixture repository, the read cases and the golden files are
 * host-neutral and live with the engine in
 * `packages/code-graph/src/__tests__/golden/`. This file is
 * only the binding: it turns each neutral case into the current worker
 * request and records the response. A later host (a worker port, a child
 * process) rebinds the same cases and must reproduce the same goldens.
 *
 * Re-record only for an intended behavior change:
 * `RECORD_CODE_GRAPH_GOLDEN=1 pnpm test code-graph-golden`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '@canopy/code-graph/engine';
import { fingerprintCustomLanguageInputs } from '@canopy/code-graph/languages/custom-config';
import { getBundledCodeGraphDir } from '@canopy/execution-engine/pipelines/config-paths';
import { createFixtureRepository } from '@canopy/code-graph/__tests__/golden/fixture-repository';
import {
  expectCodeGraphGolden,
  goldenPath,
} from '@canopy/code-graph/__tests__/golden/golden-file';
import { createCodeGraphReadService } from '@canopy/code-graph/host/read-service';
import type { CodeGraphServiceRead } from '@canopy/code-graph/host/read-service';
import { createGoldenNormalizer } from '@canopy/code-graph/__tests__/golden/normalize';
import {
  GOLDEN_READ_CASES,
  GOLDEN_REPO_ID,
  type GoldenBaseIdentityVariant,
  type GoldenGraph,
  type GoldenGraphRead,
} from '@canopy/code-graph/__tests__/golden/read-cases';
import type { CodeGraphBaseIdentity } from '@canopy/code-graph/base-graph';
import {
  executeCodeGraphBuild,
  type CodeGraphBuildExecutionOptions,
} from '../code-graph/build-worker';
import type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
} from '../code-graph/build-runner';
import { executeCodeGraphRead } from '../code-graph/read-worker';
import { createCodeGraphReadServiceWorker } from '@canopy/code-graph/host/read-worker';
import { createWorkerCodeGraphReadAdapter } from '../canopy-runtime/worker-code-graph-read-adapter';
import { readWorktreeCodeGraph } from '../code-graph/graph-reads';
import { CodeGraphReadFailureError } from '../code-graph/read-runner';
import { installCodeGraphReadDispatcherForTests } from './helpers/code-graph-read-dispatcher';
import type {
  CodeGraphReadCall,
  CodeGraphWorkerReadTask,
} from '../code-graph/read-runner';

jest.setTimeout(120_000);

const VOLATILE_NUMBER_KEYS = new Set([
  'lastBuildAt',
  'completedBuildAt',
  'derivedAt',
  'durationMs',
  'generatedAt',
  'builtAt',
  'recordedAt',
]);

interface Fixture {
  root: string;
  repo: string;
  head: string;
  baseTag: string;
  dbPaths: Record<GoldenGraph, string>;
  baseIdentity: CodeGraphBaseIdentity;
  resourcesDir: string;
}

let fixture: Fixture;
let builds: Record<string, unknown> = {};

function buildRequest(
  dbPath: string,
  overrides: Partial<CodeGraphWorkerBuildRequest> = {},
): CodeGraphWorkerBuildRequest {
  return {
    dbPath,
    worktreeRootPath: fixture.repo,
    resourcesDir: fixture.resourcesDir,
    repositories: [{ repoId: GOLDEN_REPO_ID, rootPath: fixture.repo }],
    options: {},
    ...overrides,
  };
}

async function build(
  request: CodeGraphWorkerBuildRequest,
  execution?: CodeGraphBuildExecutionOptions,
): Promise<CodeGraphWorkerBuildResponse> {
  const response = await executeCodeGraphBuild(request, execution);
  if (!response.ok)
    throw new Error(`Fixture build failed: ${response.message}`);
  return response;
}

function identityFor(variant: GoldenBaseIdentityVariant): {
  identity: CodeGraphBaseIdentity;
  gitHead: string | null;
} {
  const identity = fixture.baseIdentity;
  switch (variant) {
    case 'built':
      return { identity, gitHead: fixture.head };
    case 'other-head':
      return { identity, gitHead: '0'.repeat(40) };
    case 'other-root':
      return {
        identity: {
          ...identity,
          canonicalRepoRoot: path.join(fixture.root, 'x'),
        },
        gitHead: fixture.head,
      };
    case 'other-repo':
      return {
        identity: { ...identity, repoId: 'other' },
        gitHead: fixture.head,
      };
    case 'other-languages':
      return {
        identity: { ...identity, customLanguagesFingerprint: 'other' },
        gitHead: fixture.head,
      };
  }
}

function queryCall(
  read: Extract<GoldenGraphRead, { op: 'query' }>,
): CodeGraphReadCall {
  const repoId = read.scoped === true ? GOLDEN_REPO_ID : undefined;
  const repo = repoId === undefined ? {} : { repoId };
  const target = read.target ?? '';
  const limit = read.limit ?? 10;
  switch (read.method) {
    case 'call-path':
    case 'relationship-path':
      return {
        method: 'relationship-path',
        options: {
          mode: read.method,
          target,
          to: read.to ?? '',
          ...repo,
          ...(read.maxDepth === undefined ? {} : { maxDepth: read.maxDepth }),
          ...(read.maxNodes === undefined ? {} : { maxNodes: read.maxNodes }),
        },
      };
    case 'impact-radius':
      return {
        method: 'impact-radius',
        target,
        options: {
          ...(read.maxDepth === undefined ? {} : { maxDepth: read.maxDepth }),
          ...(read.maxNodes === undefined ? {} : { maxNodes: read.maxNodes }),
        },
      };
    case 'search':
      return { method: 'search', query: read.query ?? '', limit };
    case 'derived-stats':
      return { method: 'derived-stats', ...repo };
    case 'communities':
    case 'flows':
    case 'hubs':
      return { method: read.method, ...repo, limit };
    case 'flows-for-symbol':
      return { method: 'flows-for-symbol', target, ...repo, limit };
    case 'file-summary':
    case 'scripts-for-file':
    case 'ipc-channel':
    case 'symbol-detail':
    case 'community-for-symbol':
    case 'callers':
    case 'callees':
    case 'importers':
    case 'imports':
    case 'children':
    case 'tests-for':
    case 'docs-for':
    case 'rationale-for':
      return { method: read.method, target, ...repo };
  }
}

function readTask(read: GoldenGraphRead): CodeGraphWorkerReadTask {
  switch (read.op) {
    case 'status':
      return { kind: 'calls', calls: [{ method: 'status' }] };
    case 'summary':
      return { kind: 'readonly-summary' };
    case 'fingerprint-metadata':
      return { kind: 'fingerprint-metadata' };
    case 'query':
      return { kind: 'calls', calls: [queryCall(read)] };
    case 'detect-changed':
      return {
        kind: 'detect-changed',
        repoId: GOLDEN_REPO_ID,
        rootPath: fixture.repo,
        baseRef: read.base,
      };
    case 'change-impact':
      return {
        kind: 'change-impact',
        repoId: GOLDEN_REPO_ID,
        rootPath: fixture.repo,
        baseRef: read.base,
        resourcesDir: fixture.resourcesDir,
        ...(read.maxDepth === undefined ? {} : { maxDepth: read.maxDepth }),
      };
    case 'base-identity':
      return { kind: 'base-identity', ...identityFor(read.identity) };
    case 'validate-base':
      return { kind: 'validate-base', ...identityFor(read.identity) };
  }
}

/** The same read as a `worker.codeGraph.query` read; `null` for a base-only read. */
function serviceRead(read: GoldenGraphRead): CodeGraphServiceRead | null {
  switch (read.op) {
    case 'status':
      return { kind: 'calls', calls: [{ method: 'status' }] };
    case 'summary':
      return { kind: 'summary' };
    case 'fingerprint-metadata':
      return { kind: 'build-stamp' };
    case 'query':
      return { kind: 'calls', calls: [queryCall(read)] };
    case 'detect-changed':
      return {
        kind: 'detect-changed',
        repoId: GOLDEN_REPO_ID,
        baseRef: read.base,
      };
    case 'change-impact':
      return {
        kind: 'change-impact',
        repoId: GOLDEN_REPO_ID,
        baseRef: read.base,
        ...(read.maxDepth === undefined ? {} : { maxDepth: read.maxDepth }),
      };
    case 'base-identity':
    case 'validate-base':
      return null;
  }
}

describe('code-graph build and read goldens', () => {
  let normalize: (value: unknown) => unknown;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-golden-reads-'));
    const repo = path.join(root, 'repo');
    const { head, tags } = createFixtureRepository(repo);
    const baseTag = Object.keys(tags)[0] ?? '';
    const resourcesDir = getBundledCodeGraphDir();
    fixture = {
      root,
      repo,
      head,
      baseTag,
      resourcesDir,
      dbPaths: {
        worktree: path.join(root, 'worktree', 'graph.db'),
        base: path.join(root, 'base', 'graph.db'),
        missing: path.join(root, 'missing', 'graph.db'),
        empty: path.join(root, 'empty', 'graph.db'),
      },
      baseIdentity: {
        repoId: GOLDEN_REPO_ID,
        canonicalRepoRoot: repo,
        customLanguagesFingerprint: (
          await fingerprintCustomLanguageInputs(repo)
        ).value,
      },
    };
    normalize = createGoldenNormalizer({
      paths: [
        [repo, '<repo>'],
        [root, '<root>'],
        [resourcesDir, '<resources>'],
      ],
      volatileNumberKeys: VOLATILE_NUMBER_KEYS,
      volatileTreeKeys: new Set(['timings']),
    });

    const first = await build(buildRequest(fixture.dbPaths.worktree));
    const unchanged = await build(buildRequest(fixture.dbPaths.worktree));
    const verified = await build(
      buildRequest(fixture.dbPaths.worktree, {
        options: { verifyContent: true },
      }),
    );
    const base = await build(
      buildRequest(fixture.dbPaths.base, {
        customLanguagesRootPath: repo,
        baseFinalization: {
          identity: fixture.baseIdentity,
          gitHead: fixture.head,
        },
      }),
    );
    const empty = await CodeGraphEngine.open({
      dbPath: fixture.dbPaths.empty,
      repositories: [{ repoId: GOLDEN_REPO_ID, rootPath: repo }],
    });
    empty.close();
    builds = { first, unchanged, verified, base };
  });

  afterAll(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('builds the fixture graph exactly as recorded', () => {
    expectCodeGraphGolden('build', normalize(builds));
  });

  it('answers every read exactly as recorded', async () => {
    const results: Record<string, unknown> = {};
    for (const readCase of GOLDEN_READ_CASES) {
      const response = await executeCodeGraphRead({
        dbPath: fixture.dbPaths[readCase.graph],
        task: readTask(readCase.read),
      });
      results[readCase.name] = response;
    }
    expectCodeGraphGolden('reads', normalize(results));
  });

  // CAN-4150: callers read through the worker operation; its answers must be
  // the recorded ones, refusals included.
  it('answers every worktree read through worker.codeGraph.query as recorded', async () => {
    const service = createCodeGraphReadService({
      scheduler: { run: ({ request }) => executeCodeGraphRead(request) },
      dbPath: ({ worktreeId }) => fixture.dbPaths[worktreeId as GoldenGraph],
      hasGraph: ({ worktreeId }) =>
        existsSync(fixture.dbPaths[worktreeId as GoldenGraph]),
      buildState: () => 'idle',
      worktreeRoot: () => fixture.repo,
      repositories: () =>
        Promise.resolve([{ repoId: GOLDEN_REPO_ID, rootPath: fixture.repo }]),
      resourcesDir: () => fixture.resourcesDir,
      now: () => new Date(0),
    });
    const uninstall = installCodeGraphReadDispatcherForTests(
      createWorkerCodeGraphReadAdapter(() =>
        Promise.resolve(createCodeGraphReadServiceWorker(service)),
      ),
    );
    const recorded: unknown = JSON.parse(
      readFileSync(goldenPath('reads'), 'utf8'),
    );
    if (typeof recorded !== 'object' || recorded === null)
      throw new Error('The reads golden is not an object.');
    const results: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    try {
      for (const readCase of GOLDEN_READ_CASES) {
        const read = serviceRead(readCase.read);
        if (read === null || readCase.graph === 'base') continue;
        try {
          const { result } = await readWorktreeCodeGraph(
            { projectId: 'golden', worktreeId: readCase.graph },
            'query',
            read,
          );
          results[readCase.name] = { ok: true, result };
        } catch (error) {
          if (!(error instanceof CodeGraphReadFailureError)) throw error;
          results[readCase.name] = {
            ok: false,
            code: error.readFailure,
            message: 'The retained Code Graph could not be read. Try again.',
          };
        }
        expected[readCase.name] = Reflect.get(recorded, readCase.name);
      }
    } finally {
      uninstall();
    }
    expect(Object.keys(results).length).toBeGreaterThan(20);
    expect(normalize(results)).toEqual(expected);
  });
});

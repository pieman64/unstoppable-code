/**
 * A worktree build must not open its `graph.db` on the Electron main thread,
 * neither to decide whether the graph is already complete nor to persist the
 * end-of-build fingerprint. Both reach SQLite only through the code-graph
 * read worker lane. `node:sqlite` is replaced with a constructor that records
 * and rejects every call, so any main-thread SQLite access is observable.
 */
import type * as NodePath from 'node:path';
import type * as NodeOs from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';

const mockSqliteConstructions: string[] = [];
jest.mock('node:sqlite', () => ({
  DatabaseSync: class {
    public constructor(location: string) {
      mockSqliteConstructions.push(location);
      throw new Error('Synchronous SQLite was opened on the calling thread.');
    }
  },
  backup: (): Promise<void> =>
    Promise.reject(
      new Error('Synchronous SQLite backup on the calling thread.'),
    ),
}));

function mockTestRoot(): string {
  const nodePath = jest.requireActual<typeof NodePath>('node:path');
  const nodeOs = jest.requireActual<typeof NodeOs>('node:os');
  return nodePath.join(
    nodeOs.tmpdir(),
    `canopy-build-service-offmain-${process.pid}`,
  );
}

jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (): string => `${mockTestRoot()}/graph.db`,
  getWorktreeCodeGraphDir: (): string => mockTestRoot(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/worktrees/stork',
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  resolveWorktreeCodeGraphRepositories: (): Promise<unknown[]> =>
    Promise.resolve([
      { repoId: '__workspace_root__', rootPath: '/worktrees/stork' },
    ]),
}));
jest.mock('../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (): Promise<unknown> =>
    Promise.resolve({ name: 'Canopy' }),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: (): Promise<unknown> =>
    Promise.resolve({ type: 'single-repo', repoPath: '/repos/canopy' }),
}));
jest.mock('../lib/code-graph-base-store', () => ({
  copyCompatibleCodeGraphBaseForSeed: (): Promise<null> =>
    Promise.resolve(null),
}));
jest.mock('@canopy/code-graph/languages/custom-config', () => ({
  fingerprintCustomLanguageInputs: (): Promise<unknown> =>
    Promise.resolve({ value: 'languages' }),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): unknown => ({
    withWorktreeClosed: (
      _projectId: string,
      _worktreeId: string,
      callback: () => unknown,
    ): unknown => callback(),
  }),
}));
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE:
    'Code graph tools are not available for this project.',
  isCodeGraphAvailableForWorkspace: (): boolean => true,
}));
jest.mock('../lib/code-graph-telemetry', () => ({
  codeGraphGenerationFailureReason: (): string => 'unknown',
  completeCodeGraphGenerationTelemetry: jest.fn(),
  failCodeGraphGenerationTelemetry: jest.fn(),
  startCodeGraphGenerationTelemetry: (): unknown => ({
    operationKey: 'operation',
    startedAtMs: 0,
    context: {},
  }),
}));
jest.mock('../code-graph/fingerprint-runner', () => ({
  runCodeGraphWorkerFingerprint: (): Promise<unknown> =>
    Promise.resolve({ ok: true, fingerprint: 'stable-fingerprint' }),
}));

const mockRunCodeGraphWorkerBuild = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../code-graph/build-runner', () => ({
  beginCodeGraphWorkerBuild: (...args: unknown[]): unknown => ({
    attemptId: 'admitted-offmain-fixture',
    promise: mockRunCodeGraphWorkerBuild(...args),
  }),
  runCodeGraphWorkerBuild: (...args: unknown[]): unknown =>
    mockRunCodeGraphWorkerBuild(...args),
}));

interface MockReadInput {
  key: string;
  kind: string;
  request: { dbPath: string; task: { kind: string; fingerprint?: string } };
}
const mockRunCodeGraphWorkerRead = jest.fn(
  (input: MockReadInput): Promise<unknown> => {
    if (input.request.task.kind === 'fingerprint-metadata') {
      return Promise.resolve({
        ok: true,
        result: {
          kind: 'fingerprint-metadata',
          value: {
            fingerprint: null,
            schemaVersion: 3,
            extractorVersion: 6,
            completed: true,
          },
        },
      });
    }
    return Promise.resolve({
      ok: true,
      result: { kind: input.request.task.kind },
    });
  },
);
jest.mock('../code-graph/read-runner', () => ({
  runCodeGraphWorkerRead: (input: MockReadInput): Promise<unknown> =>
    mockRunCodeGraphWorkerRead(input),
}));

import { runWorktreeCodeGraphBuild } from '../lib/code-graph-build-service';

describe('code graph build service main-thread SQLite boundary', () => {
  beforeEach(async () => {
    mockSqliteConstructions.length = 0;
    mockRunCodeGraphWorkerRead.mockClear();
    mockRunCodeGraphWorkerBuild.mockReset();
    mockRunCodeGraphWorkerBuild.mockResolvedValue({
      ok: true,
      result: {
        filesScanned: 1,
        filesParsed: 1,
        filesUnchanged: 0,
        filesSkipped: 0,
        filesRemoved: 0,
        parseFailures: 0,
        symbolCount: 1,
        edgeCount: 0,
        durationMs: 1,
        derived: [],
        customLanguages: null,
      },
      seedOutcomes: [
        { repoId: WORKSPACE_ROOT_REPO_ID, status: 'existing-graph-reused' },
      ],
    });
    await rm(mockTestRoot(), { recursive: true, force: true });
    await mkdir(mockTestRoot(), { recursive: true });
    await writeFile(path.join(mockTestRoot(), 'graph.db'), 'existing-graph');
  });

  afterAll(async () => {
    await rm(mockTestRoot(), { recursive: true, force: true });
  });

  it('checks completion and persists the stable fingerprint through the worker lane', async () => {
    const response = await runWorktreeCodeGraphBuild({
      projectId: 'canopy',
      worktreeId: 'stork',
      reason: 'refresh',
      observedFingerprint: 'stable-fingerprint',
    });

    expect(response.ok).toBe(true);
    expect(mockSqliteConstructions).toEqual([]);
    expect(mockRunCodeGraphWorkerRead).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'canopy/stork',
        request: {
          dbPath: path.join(mockTestRoot(), 'graph.db'),
          task: {
            kind: 'persist-fingerprint',
            fingerprint: 'stable-fingerprint',
          },
        },
      }),
    );
  }, 15_000);
});

import '../../../__tests__/worktree-replica-compatibility';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import type { W5CommitRequest } from '@canopy/desktop-shared/node/w5-commit-log';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as Instructions from '../instruction-files';
import type * as DecisionPort from '../workspace-record-decision-port';

const mockEvents: string[] = [];
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../git', () => ({
  getRemoteUrl: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../../agents/session-manager', () => ({}));
jest.mock('../../pipelines/execution-runtime', () => ({}));
jest.mock('../../ledger/lifecycle', () => ({}));
jest.mock('../workspace-record-decision-port', () => {
  const actual = jest.requireActual<typeof DecisionPort>(
    '../workspace-record-decision-port',
  );
  return {
    ...actual,
    applyWorktreeListUpdate: jest.fn(
      (...args: Parameters<typeof actual.applyWorktreeListUpdate>) => {
        mockEvents.push(args[1].kind);
        return actual.applyWorktreeListUpdate(...args);
      },
    ),
    applyWorkspaceIndexDecision: jest.fn(
      (...args: Parameters<typeof actual.applyWorkspaceIndexDecision>) => {
        mockEvents.push(args[0].kind);
        return actual.applyWorkspaceIndexDecision(...args);
      },
    ),
    applyWorkspaceIndexRemoval: jest.fn(
      (...args: Parameters<typeof actual.applyWorkspaceIndexRemoval>) => {
        mockEvents.push('composition.destination.cleanup');
        return actual.applyWorkspaceIndexRemoval(...args);
      },
    ),
  };
});

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
  w5ResourceKey,
} from '../w5-commit-log-file-store';
import { isJsonObject, nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  createOrReuseTemporaryWorkspaceFromRepos,
  createOrReuseTemporaryWorkspaceFromWorkspaces,
} from '../adhoc-multi-repo-workspaces';
import { ensureAgentsMdSymlink } from '../instruction-files';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let commits: W5CommitRequest[];
let committedRevisions: number[][];
let failure:
  | 'none'
  | 'records-before'
  | 'records-after'
  | 'index-before'
  | 'index-after';

function seed(file: string, value: unknown): void {
  const target = join(root, file);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
}

function readIndex(): { workspaces: Record<string, unknown>[] } {
  const index: unknown = JSON.parse(
    readFileSync(join(root, 'index.json'), 'utf8'),
  );
  if (
    !isJsonObject(index) ||
    !Array.isArray(index.workspaces) ||
    !index.workspaces.every(isJsonObject)
  ) {
    throw new Error('Expected workspace index with object entries');
  }
  return { ...index, workspaces: index.workspaces };
}

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'w5-temp-'));
  root = join(dir, 'data', 'workspaces');
  mkdirSync(root, { recursive: true });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  seed('index.json', {
    version: 1,
    workspaces: ['a', 'b'].map((id, order) => ({
      id,
      name: id.toUpperCase(),
      type: 'single-repo',
      color: '#123456',
      collapsed: false,
      order,
    })),
  });
  for (const id of ['a', 'b']) {
    const repoPath = join(dir, 'repos', id);
    mkdirSync(repoPath, { recursive: true });
    seed(join(id, 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repoPath,
    });
    seed(join(id, 'worktrees.json'), { version: 1, worktrees: [] });
  }
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  commits = [];
  committedRevisions = [];
  failure = 'none';
  mockEvents.length = 0;
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    const publishing = request.files.some(
      (file) => file.path === join(root, 'index.json'),
    );
    const creating = request.files.some((file) =>
      file.path.endsWith('workspace.json'),
    );
    if (creating && failure === 'records-before') {
      failure = 'none';
      throw new Error('records unavailable');
    }
    if (publishing && failure === 'index-before') {
      failure = 'none';
      throw new Error('index unavailable');
    }
    if (publishing && commits.length === 1) {
      expect(existsSync(join(root, 'a-b', 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(root, 'a-b', 'AGENTS.md'))).toBe(true);
    }
    const result = await commit(request);
    commits.push(request);
    committedRevisions.push(await revisions());
    mockEvents.push(creating ? 'records-committed' : 'index-committed');
    if (creating && failure === 'records-after') {
      failure = 'none';
      throw new Error('records answer lost');
    }
    if (publishing && failure === 'index-after') {
      failure = 'none';
      throw new Error('index answer lost');
    }
    return result;
  });
  const instructions = jest.requireActual<typeof Instructions>(
    '../instruction-files',
  );
  const realInstructions = instructions.ensureAgentsMdSymlink;
  jest
    .spyOn(instructions, 'ensureAgentsMdSymlink')
    .mockImplementation(async (workspaceDir) => {
      expect(commits).toHaveLength(1);
      expect(existsSync(join(workspaceDir, 'workspace.json'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'worktrees.json'))).toBe(true);
      expect(readFileSync(join(workspaceDir, 'CLAUDE.md'), 'utf8')).not.toBe(
        '',
      );
      mockEvents.push('instructions');
      await realInstructions(workspaceDir);
    });
});

afterEach(async () => {
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  jest.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

async function revisions(): Promise<number[]> {
  return Promise.all([
    host.revision({ kind: 'workspaces' }),
    host.revision({ kind: 'workspace', workspaceId: 'a-b' }),
    host.revision({ kind: 'worktrees', workspaceId: 'a-b' }),
    host.revision({ kind: 'workspace', workspaceId: 'a' }),
    host.revision({ kind: 'workspace', workspaceId: 'b' }),
  ]);
}

describe.each(['repositories', 'workspaces'] as const)(
  'temporary selection from %s',
  (route) => {
    function select(): ReturnType<
      typeof createOrReuseTemporaryWorkspaceFromRepos
    > {
      return route === 'repositories'
        ? createOrReuseTemporaryWorkspaceFromRepos(
            ['a', 'b'].map((id) => ({
              name: id.toUpperCase(),
              path: join(dir, 'repos', id),
            })),
          )
        : createOrReuseTemporaryWorkspaceFromWorkspaces(['b', 'a']);
    }

    it('rejects empty and duplicate selections without a commit', async () => {
      const empty =
        route === 'repositories'
          ? createOrReuseTemporaryWorkspaceFromRepos([])
          : createOrReuseTemporaryWorkspaceFromWorkspaces([]);
      await expect(empty).rejects.toThrow(/Choose at least one/);
      const duplicate =
        route === 'repositories'
          ? createOrReuseTemporaryWorkspaceFromRepos([
              { name: 'A', path: join(dir, 'repos', 'a') },
              { name: 'A', path: join(dir, 'repos', 'a') },
            ])
          : createOrReuseTemporaryWorkspaceFromWorkspaces(['a', 'a']);
      await expect(duplicate).rejects.toThrow(/more than once|must be unique/);
      expect(commits).toEqual([]);
      expect(await revisions()).toEqual([0, 0, 0, 0, 0]);
    });

    it('reuses a single selected repository without instructions or commits', async () => {
      const result =
        route === 'repositories'
          ? await createOrReuseTemporaryWorkspaceFromRepos([
              { name: 'A', path: join(dir, 'repos', 'a') },
            ])
          : await createOrReuseTemporaryWorkspaceFromWorkspaces(['a']);
      expect(result).toMatchObject({
        workspace: { id: 'a', type: 'single-repo' },
        createdTemporaryWorkspace: false,
        reusedWorkspace: true,
      });
      expect(commits).toEqual([]);
      expect(mockEvents).toEqual([]);
      expect(await revisions()).toEqual([0, 0, 0, 0, 0]);
    });

    it('prefers a matching permanent workspace over a temporary one without a commit', async () => {
      const indexPath = join(root, 'index.json');
      const index = readIndex();
      ['cached', 'permanent'].forEach((id, order) => {
        index.workspaces.push({
          id,
          name: id,
          type: 'multi-repo',
          color: '#123456',
          collapsed: false,
          order: order + 2,
        });
        seed(join(id, 'workspace.json'), {
          version: 1,
          type: 'multi-repo',
          repos: ['a', 'b'].map((repoId) => ({
            id: repoId,
            name: repoId.toUpperCase(),
            repoPath: join(dir, 'repos', repoId),
          })),
          ...(id === 'cached'
            ? {
                temporary: true,
                temporaryRepoIdentityKeys: ['a', 'b'].map(
                  (repoId) => `path:${join(dir, 'repos', repoId)}`,
                ),
                temporarySourceWorkspaceIds: ['a', 'b'],
              }
            : {}),
        });
        seed(join(id, 'worktrees.json'), { version: 1, worktrees: [] });
      });
      seed('index.json', index);
      const before = readFileSync(indexPath, 'utf8');
      await expect(select()).resolves.toMatchObject({
        workspace: { id: 'permanent', type: 'multi-repo' },
        createdTemporaryWorkspace: false,
        reusedWorkspace: true,
      });
      expect(commits).toEqual([]);
      expect(mockEvents).toEqual([]);
      expect(ensureAgentsMdSymlink).not.toHaveBeenCalled();
      expect(await revisions()).toEqual([0, 0, 0, 0, 0]);
      for (const id of ['cached', 'permanent']) {
        expect(
          await host.revision({ kind: 'workspace', workspaceId: id }),
        ).toBe(0);
        expect(
          await host.revision({ kind: 'worktrees', workspaceId: id }),
        ).toBe(0);
      }
      expect(readFileSync(indexPath, 'utf8')).toBe(before);
      expect(existsSync(join(root, 'a-b'))).toBe(false);
    });

    it('labels both record steps as create, keeps exact advances and ordering, and reuses without a commit', async () => {
      expect(await revisions()).toEqual([0, 0, 0, 0, 0]);
      const result = await select();
      expect(result).toMatchObject({
        workspace: { id: 'a-b', temporary: true },
        createdTemporaryWorkspace: true,
        reusedWorkspace: false,
      });
      expect(result.workspace).toMatchObject({
        temporaryRepoIdentityKeys: ['a', 'b'].map(
          (id) => `path:${join(dir, 'repos', id)}`,
        ),
        ...(route === 'workspaces'
          ? { temporarySourceWorkspaceIds: ['a', 'b'] }
          : {}),
      });
      expect(
        commits.map((request) => ({
          operation: request.operation,
          advance: request.advance.map(w5ResourceKey),
          files: request.files.map((file) => relative(root, file.path)),
          receipt: request.receipt,
          reservationId: request.reservationId,
          expectedRevisions: request.expectedRevisions,
        })),
      ).toEqual([
        {
          operation: 'core.workspace.create',
          advance: ['workspace:a-b'],
          files: ['a-b/workspace.json', 'a-b/worktrees.json'],
          receipt: undefined,
          reservationId: undefined,
          expectedRevisions: [],
        },
        {
          operation: 'core.workspace.create',
          advance: ['workspaces', 'workspace:a-b'],
          files: ['index.json', 'index.json.bak'],
          receipt: undefined,
          reservationId: undefined,
          expectedRevisions: undefined,
        },
      ]);
      expect(mockEvents).toEqual([
        'composition.temporary.create',
        'records-committed',
        'instructions',
        'composition.temporary.index',
        'index-committed',
      ]);
      expect(await revisions()).toEqual([1, 2, 0, 0, 0]);
      expect(committedRevisions).toEqual([
        [0, 1, 0, 0, 0],
        [1, 2, 0, 0, 0],
      ]);
      const beforeReuse = readFileSync(join(root, 'index.json'), 'utf8');
      const reused = await select();
      expect(reused).toMatchObject({
        workspace: { id: result.workspace.id },
        createdTemporaryWorkspace: false,
        reusedWorkspace: true,
      });
      expect(commits).toHaveLength(2);
      expect(ensureAgentsMdSymlink).toHaveBeenCalledTimes(1);
      expect(await revisions()).toEqual([1, 2, 0, 0, 0]);
      expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(beforeReuse);
    });

    it.each([
      'records-before',
      'records-after',
      'claude',
      'agents',
      'index-before',
      'index-after',
    ] as const)('retains cleanup after %s failure', async (stage) => {
      if (stage === 'claude') {
        const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
        const write = fs.writeFile;
        jest
          .spyOn(fs, 'writeFile')
          .mockImplementation((...args) =>
            typeof args[0] === 'string' && args[0].endsWith('CLAUDE.md')
              ? Promise.reject(new Error('instructions unavailable'))
              : write(...args),
          );
      } else if (stage === 'agents') {
        jest
          .mocked(ensureAgentsMdSymlink)
          .mockRejectedValueOnce(new Error('instructions unavailable'));
      } else failure = stage;
      await expect(select()).rejects.toThrow(
        stage === 'records-before'
          ? 'records unavailable'
          : stage === 'records-after'
            ? 'records answer lost'
            : stage.startsWith('index')
              ? /index/
              : 'instructions unavailable',
      );
      expect(existsSync(join(root, 'a-b'))).toBe(false);
      expect(readIndex().workspaces.map((entry) => entry.id)).toEqual([
        'a',
        'b',
      ]);
      expect(mockEvents).toContain('composition.destination.cleanup');
      expect(await revisions()).toEqual(
        stage === 'records-before'
          ? [0, 0, 0, 0, 0]
          : stage === 'index-after'
            ? [2, 3, 0, 0, 0]
            : [0, 1, 0, 0, 0],
      );
      expect(
        commits.map((request) => request.advance.map(w5ResourceKey)),
      ).toEqual(
        stage === 'records-before'
          ? []
          : stage === 'index-after'
            ? [
                ['workspace:a-b'],
                ['workspaces', 'workspace:a-b'],
                ['workspaces', 'workspace:a-b'],
              ]
            : [['workspace:a-b']],
      );
      expect(commits.map((request) => request.operation)).toEqual(
        stage === 'records-before'
          ? []
          : stage === 'index-after'
            ? [
                'core.workspace.create',
                'core.workspace.create',
                'w5.workspace_index.write',
              ]
            : ['core.workspace.create'],
      );
    });
  },
);

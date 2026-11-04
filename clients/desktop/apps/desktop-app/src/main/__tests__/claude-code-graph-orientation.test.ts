import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginClaudeCodeGraphToolCall,
  isClaudeCodeGraphOrientationCurrent,
  readClaudeCodeGraphToolAnswer,
  recordClaudeCodeGraphOrientation,
  resetClaudeCodeGraphOrientationForTests,
  resolveClaudeCodeGraphWorktreeRoot,
  setClaudeCodeGraphOrientationReadersForTests,
  type ClaudeCodeGraphOrientationScope,
  type GraphIdentity,
} from '../lib/claude-code-graph-orientation';

const mockResolveRepositories = jest.fn<Promise<unknown>, [string, string]>();
let mockGraphDbPath = '';

jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (): string => mockGraphDbPath,
}));
const mockBuildStamp = jest.fn<Promise<string | null>, [string, string]>();
// The stamp is read through `worker.codeGraph.query` on the read hosts.
jest.mock('../code-graph/read-runner', () => ({
  runCodeGraphWorkerRead: async (input: {
    key: string;
    request: { dbPath: string };
  }): Promise<unknown> => ({
    ok: true,
    result: {
      kind: 'fingerprint-metadata',
      value: {
        fingerprint: null,
        schemaVersion: null,
        extractorVersion: null,
        completed: false,
        lastBuildAt: await mockBuildStamp(input.request.dbPath, input.key),
      },
    },
  }),
}));
jest.mock('../code-graph/build-runner', () => ({
  getCodeGraphSourceBuildState: (): string => 'idle',
}));
const mockResolveWorktreeCwd = jest.fn<string, [string, string]>();
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (projectId: string, worktreeId: string): string =>
    mockResolveWorktreeCwd(projectId, worktreeId),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  resolveWorktreeCodeGraphRepositories: (
    projectId: string,
    cwd: string,
  ): Promise<unknown> => mockResolveRepositories(projectId, cwd),
}));

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

let root: string;

function writeText(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

function makeRepository(name: string, commit = COMMIT_A): string {
  const repo = path.join(root, name);
  writeText(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeText(path.join(repo, '.git', 'refs', 'heads', 'main'), `${commit}\n`);
  return repo;
}

function scope(
  overrides: Partial<ClaudeCodeGraphOrientationScope> = {},
): ClaudeCodeGraphOrientationScope {
  return {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: path.join(root, 'repo'),
    turn: {},
    ...overrides,
  };
}

function touch(filePath: string, seconds: number): void {
  utimesSync(filePath, seconds, seconds);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'claude-graph-orientation-'));
  mockGraphDbPath = path.join(root, 'data', 'graph.db');
  writeText(mockGraphDbPath, 'graph');
  touch(mockGraphDbPath, 1_000);
  mockResolveRepositories.mockImplementation((_projectId, cwd: string) =>
    Promise.resolve([{ repoId: '__workspace_root__', rootPath: cwd }]),
  );
  mockBuildStamp.mockResolvedValue('stamp-1');
  mockResolveWorktreeCwd.mockImplementation(() => {
    throw new Error('unregistered worktree');
  });
  resetClaudeCodeGraphOrientationForTests();
});

afterEach(() => {
  resetClaudeCodeGraphOrientationForTests();
  rmSync(root, { recursive: true, force: true });
});

import { installCodeGraphReadDispatcherForTests } from './helpers/code-graph-read-dispatcher';

beforeAll(() => {
  installCodeGraphReadDispatcherForTests();
});

describe('Claude code-graph orientation', () => {
  it('is not oriented before a graph call is recorded', async () => {
    makeRepository('repo');
    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
  });

  it('keeps orientation across turns while graph and HEAD are unchanged', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(true);
  });

  it('scopes orientation to the chat', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope({ chatId: 'chat-a' }));

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ chatId: 'chat-b' })),
    ).resolves.toBe(false);
    await expect(
      isClaudeCodeGraphOrientationCurrent(
        scope({ chatId: 'chat-a', worktreeId: 'other-worktree' }),
      ),
    ).resolves.toBe(false);
  });

  it('invalidates orientation when the branch HEAD commit moves', async () => {
    const repo = makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());

    writeText(path.join(repo, '.git', 'refs', 'heads', 'main'), COMMIT_B);

    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
    // Invalidation is durable: restoring HEAD needs a fresh graph call.
    writeText(path.join(repo, '.git', 'refs', 'heads', 'main'), COMMIT_A);
    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
  });

  it('invalidates orientation when HEAD switches branches', async () => {
    const repo = makeRepository('repo');
    writeText(path.join(repo, '.git', 'refs', 'heads', 'other'), COMMIT_A);
    await recordClaudeCodeGraphOrientation(scope());

    writeText(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/other\n');

    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
  });

  it('invalidates orientation when the graph database is rebuilt', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());

    mockBuildStamp.mockResolvedValue('stamp-2');
    touch(mockGraphDbPath, 2_000);

    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
  });

  it('invalidates orientation when a rebuild is still held in the WAL', async () => {
    makeRepository('repo');
    writeText(`${mockGraphDbPath}-wal`, '');
    touch(`${mockGraphDbPath}-wal`, 1_000);
    await recordClaudeCodeGraphOrientation(scope());

    mockBuildStamp.mockResolvedValue('stamp-2');
    writeText(`${mockGraphDbPath}-wal`, 'committed rebuild frames');

    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
  });

  it('resolves the worktree root for config and falls back to the chat cwd', () => {
    mockResolveWorktreeCwd.mockReturnValueOnce('/workspace/worktree');
    expect(
      resolveClaudeCodeGraphWorktreeRoot(
        'project',
        'worktree',
        '/workspace/worktree/repos/app',
      ),
    ).toBe('/workspace/worktree');
    expect(
      resolveClaudeCodeGraphWorktreeRoot('project', 'worktree', '/fallback'),
    ).toBe('/fallback');
  });

  it('keeps recently checked chats when evicting past the cache bound', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope({ chatId: 'kept' }));
    await recordClaudeCodeGraphOrientation(scope({ chatId: 'evicted' }));
    for (let index = 0; index < 254; index += 1) {
      await recordClaudeCodeGraphOrientation(
        scope({ chatId: `chat-${index}` }),
      );
    }
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ chatId: 'kept', turn: {} })),
    ).resolves.toBe(true);

    await recordClaudeCodeGraphOrientation(scope({ chatId: 'newest' }));

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ chatId: 'kept', turn: {} })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(
        scope({ chatId: 'evicted', turn: {} }),
      ),
    ).resolves.toBe(false);
  });

  it('adopts derived-analysis writes that keep the build stamp', async () => {
    makeRepository('repo');
    const turn = {};
    await recordClaudeCodeGraphOrientation(scope({ turn }));

    writeText(`${mockGraphDbPath}-wal`, 'derived analysis frames');

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(true);
  });

  it('invalidates orientation in the same turn when any writer rebuilds the graph', async () => {
    makeRepository('repo');
    const turn = {};
    await recordClaudeCodeGraphOrientation(scope({ turn }));

    // e.g. the desktop CLI's in-process build: same database, new stamp.
    mockBuildStamp.mockResolvedValue('stamp-2');
    writeText(mockGraphDbPath, 'rebuilt in place');

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(false);
  });

  it('reads a fresh stamp for a WAL-only publication', async () => {
    makeRepository('repo');
    writeText(`${mockGraphDbPath}-wal`, '');
    await recordClaudeCodeGraphOrientation(scope());
    const readsBefore = mockBuildStamp.mock.calls.length;

    mockBuildStamp.mockResolvedValue('stamp-2');
    writeText(`${mockGraphDbPath}-wal`, 'published build frames');

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
    expect(mockBuildStamp.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('skips the stamp read while the graph is unchanged', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());
    mockBuildStamp.mockClear();

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(true);
    expect(mockBuildStamp).not.toHaveBeenCalled();
  });

  it('reads the build stamp off-main for the worktree graph', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());

    expect(mockBuildStamp).toHaveBeenCalledWith(
      mockGraphDbPath,
      'project/worktree',
    );
  });

  it('invalidates orientation on a replacement even with the same stamp', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());

    const replacement = `${mockGraphDbPath}.next`;
    writeText(replacement, 'graph');
    touch(replacement, 1_000);
    renameSync(replacement, mockGraphDbPath);

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('invalidates orientation when the changed graph has an unreadable stamp', async () => {
    makeRepository('repo');
    const turn = {};
    await recordClaudeCodeGraphOrientation(scope({ turn }));

    mockBuildStamp.mockResolvedValue(null);
    writeText(`${mockGraphDbPath}-wal`, 'unattributable frames');

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(false);
  });

  it('retries the stamp read when the graph changes during it', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());
    writeText(`${mockGraphDbPath}-wal`, 'derived analysis frames');

    let reads = 0;
    mockBuildStamp.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        writeText(`${mockGraphDbPath}-wal`, 'more derived analysis frames');
      }
      return Promise.resolve('stamp-1');
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(true);
    expect(reads).toBe(2);
  });

  it('invalidates orientation when the graph keeps changing during stamp reads', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());
    writeText(`${mockGraphDbPath}-wal`, 'write 0');
    // Keep mtime fixed so each write must be detectable by its growing size.
    touch(`${mockGraphDbPath}-wal`, 1_000);

    let reads = 0;
    mockBuildStamp.mockImplementation(() => {
      reads += 1;
      writeText(`${mockGraphDbPath}-wal`, `write ${reads}`.repeat(reads + 1));
      touch(`${mockGraphDbPath}-wal`, 1_000);
      return Promise.resolve('stamp-1');
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
    expect(reads).toBe(2);
  });

  it('holds an orientation with an unreadable stamp only for its turn', async () => {
    makeRepository('repo');
    const turn = {};
    mockBuildStamp.mockResolvedValue(null);
    await recordClaudeCodeGraphOrientation(scope({ turn }));

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('orients on a graph call whose state held still', async () => {
    makeRepository('repo');
    await beginClaudeCodeGraphToolCall(scope(), 'call-1');

    await recordClaudeCodeGraphOrientation(scope(), {
      toolUseId: 'call-1',
      rebuildsGraph: false,
      answeredBuildAt: null,
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(true);
  });

  it('leaves the chat unoriented when HEAD moves during the graph call', async () => {
    const repo = makeRepository('repo');
    await beginClaudeCodeGraphToolCall(scope(), 'call-1');
    writeText(path.join(repo, '.git', 'refs', 'heads', 'main'), COMMIT_B);

    await recordClaudeCodeGraphOrientation(scope(), {
      toolUseId: 'call-1',
      rebuildsGraph: false,
      answeredBuildAt: null,
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('leaves the chat unoriented when the graph changes during a read-only call', async () => {
    makeRepository('repo');
    await beginClaudeCodeGraphToolCall(scope(), 'call-1');
    mockBuildStamp.mockResolvedValue('stamp-2');
    writeText(`${mockGraphDbPath}-wal`, 'rebuild landed mid-call');

    await recordClaudeCodeGraphOrientation(scope(), {
      toolUseId: 'call-1',
      rebuildsGraph: false,
      answeredBuildAt: null,
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('orients on the graph a BuildOrUpdateCodeGraph call rebuilt', async () => {
    makeRepository('repo');
    mockBuildStamp.mockResolvedValue('1001');
    await beginClaudeCodeGraphToolCall(scope(), 'build-1');
    mockBuildStamp.mockResolvedValue('1002');
    writeText(`${mockGraphDbPath}-wal`, 'the call rebuilt the graph');

    await recordClaudeCodeGraphOrientation(scope(), {
      toolUseId: 'build-1',
      rebuildsGraph: true,
      answeredBuildAt: 1002,
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(true);
  });

  it('does not revive an orientation after a later turn could not verify it', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());
    setClaudeCodeGraphOrientationReadersForTests({
      readHeadIdentity: () => Promise.resolve(null),
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);

    setClaudeCodeGraphOrientationReadersForTests(null);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('holds an orientation only for its turn when the pre-call snapshot was unreadable', async () => {
    makeRepository('repo');
    const turn = {};
    setClaudeCodeGraphOrientationReadersForTests({
      readHeadIdentity: () => Promise.resolve(null),
    });
    await beginClaudeCodeGraphToolCall(scope({ turn }), 'call-1');
    setClaudeCodeGraphOrientationReadersForTests(null);

    await recordClaudeCodeGraphOrientation(scope({ turn }), {
      toolUseId: 'call-1',
      rebuildsGraph: false,
      answeredBuildAt: null,
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('holds an orientation only for its turn when the pre-call snapshot is missing', async () => {
    makeRepository('repo');
    const turn = {};

    await recordClaudeCodeGraphOrientation(scope({ turn }), {
      toolUseId: 'never-snapshotted',
      rebuildsGraph: false,
      answeredBuildAt: null,
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('ends orientation when HEAD moves during the orienting turn', async () => {
    const repo = makeRepository('repo');
    const turn = {};
    await recordClaudeCodeGraphOrientation(scope({ turn }));

    writeText(path.join(repo, '.git', 'refs', 'heads', 'main'), COMMIT_B);

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(false);
  });

  it('resolves graph repositories from the worktree root for a selected-repository chat', async () => {
    const workspaceRoot = path.join(root, 'workspace');
    const selected = makeRepository(path.join('workspace', 'repos', 'app'));
    const sibling = makeRepository(path.join('workspace', 'repos', 'lib'));
    mockResolveWorktreeCwd.mockReturnValue(workspaceRoot);
    mockResolveRepositories.mockImplementation((_projectId, worktreeRoot) =>
      Promise.resolve(
        worktreeRoot === workspaceRoot
          ? [
              { repoId: 'app', rootPath: selected },
              { repoId: 'lib', rootPath: sibling },
            ]
          : [{ repoId: 'app', rootPath: selected }],
      ),
    );
    await recordClaudeCodeGraphOrientation(scope({ cwd: selected }));

    writeText(path.join(sibling, '.git', 'refs', 'heads', 'main'), COMMIT_B);

    expect(mockResolveWorktreeCwd).toHaveBeenCalledWith('project', 'worktree');
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ cwd: selected, turn: {} })),
    ).resolves.toBe(false);
  });

  it('invalidates orientation when the graph database is replaced', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());

    // Base seeding publishes a new database by renaming it over the old one;
    // same size and mtime, different inode.
    const replacement = `${mockGraphDbPath}.next`;
    writeText(replacement, 'graph');
    touch(replacement, 1_000);
    renameSync(replacement, mockGraphDbPath);

    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
  });

  it('ignores graph shared-memory churn from readers', async () => {
    makeRepository('repo');
    await recordClaudeCodeGraphOrientation(scope());

    writeText(`${mockGraphDbPath}-shm`, 'reader state');

    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      true,
    );
  });

  it('tracks every graph repository, including child repositories', async () => {
    const parent = makeRepository('repo');
    const child = makeRepository(path.join('repo', 'repos', 'child'));
    mockResolveRepositories.mockResolvedValue([
      { repoId: '__workspace_root__', rootPath: parent },
      { repoId: 'child', rootPath: child },
    ]);
    await recordClaudeCodeGraphOrientation(scope());
    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      true,
    );

    writeText(path.join(child, '.git', 'refs', 'heads', 'main'), COMMIT_B);

    await expect(isClaudeCodeGraphOrientationCurrent(scope())).resolves.toBe(
      false,
    );
  });

  it('resolves linked worktree HEADs through commondir and packed-refs', async () => {
    const common = path.join(root, 'main-repo', '.git');
    const gitDirectory = path.join(common, 'worktrees', 'linked');
    const linked = path.join(root, 'linked');
    writeText(path.join(linked, '.git'), `gitdir: ${gitDirectory}\n`);
    writeText(path.join(gitDirectory, 'HEAD'), 'ref: refs/heads/feature\n');
    writeText(path.join(gitDirectory, 'commondir'), '../..\n');
    writeText(
      path.join(common, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${COMMIT_A} refs/heads/feature\n`,
    );
    const linkedScope = scope({ cwd: linked });
    await recordClaudeCodeGraphOrientation(linkedScope);
    await expect(
      isClaudeCodeGraphOrientationCurrent({ ...linkedScope, turn: {} }),
    ).resolves.toBe(true);

    writeText(
      path.join(common, 'packed-refs'),
      `${COMMIT_B} refs/heads/feature\n`,
    );

    await expect(
      isClaudeCodeGraphOrientationCurrent({ ...linkedScope, turn: {} }),
    ).resolves.toBe(false);
  });

  it('tracks a detached HEAD', async () => {
    const repo = makeRepository('repo');
    writeText(path.join(repo, '.git', 'HEAD'), `${COMMIT_A}\n`);
    await recordClaudeCodeGraphOrientation(scope());
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(true);

    writeText(path.join(repo, '.git', 'HEAD'), `${COMMIT_B}\n`);

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('holds an unverifiable orientation only within its own turn', async () => {
    // The worktree root is not a repository, so its HEAD cannot be read.
    mkdirSync(path.join(root, 'repo'), { recursive: true });
    const turn = {};
    await recordClaudeCodeGraphOrientation(scope({ turn }));

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('does not carry orientation into a later turn when HEAD reads start failing', async () => {
    makeRepository('repo');
    const turn = {};
    await recordClaudeCodeGraphOrientation(scope({ turn }));
    setClaudeCodeGraphOrientationReadersForTests({
      readHeadIdentity: () => Promise.resolve(null),
    });

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('treats a reftable repository as unverifiable rather than unborn', async () => {
    const repo = path.join(root, 'repo');
    writeText(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    mkdirSync(path.join(repo, '.git', 'reftable'), { recursive: true });
    await recordClaudeCodeGraphOrientation(scope());

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  it('treats a failed repository lookup as unverifiable', async () => {
    makeRepository('repo');
    mockResolveRepositories.mockRejectedValue(new Error('config unreadable'));
    const turn = {};
    await recordClaudeCodeGraphOrientation(scope({ turn }));

    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn })),
    ).resolves.toBe(true);
    await expect(
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
    ).resolves.toBe(false);
  });

  describe('repository membership', () => {
    let roots: string[] = [];
    let resolutionFails = false;

    beforeEach(() => {
      roots = [];
      resolutionFails = false;
      mockResolveRepositories.mockImplementation(() =>
        resolutionFails
          ? Promise.reject(new Error('config unreadable'))
          : Promise.resolve(
              roots.map((rootPath) => ({
                repoId: path.basename(rootPath),
                rootPath,
              })),
            ),
      );
    });

    function workspaceRepository(name: string): string {
      return makeRepository(path.join('workspace', 'repos', name));
    }

    it('invalidates orientation when a repository is added without a rebuild', async () => {
      const app = workspaceRepository('app');
      roots = [app];
      await recordClaudeCodeGraphOrientation(scope({ cwd: app }));

      roots = [app, workspaceRepository('added')];

      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(false);
    });

    it('invalidates orientation when a repository is removed', async () => {
      const app = workspaceRepository('app');
      const lib = workspaceRepository('lib');
      roots = [app, lib];
      await recordClaudeCodeGraphOrientation(scope({ cwd: app }));

      roots = [app];

      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(false);
    });

    it('invalidates orientation, even in its turn, when an added repository has no readable HEAD', async () => {
      const app = workspaceRepository('app');
      roots = [app];
      const turn = {};
      await recordClaudeCodeGraphOrientation(scope({ cwd: app, turn }));

      const unborn = path.join(root, 'workspace', 'repos', 'unborn');
      mkdirSync(unborn, { recursive: true });
      roots = [app, unborn];

      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn })),
      ).resolves.toBe(false);
      roots = [app];
      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(false);
    });

    it('invalidates orientation, even in its turn, when every repository is removed', async () => {
      const app = workspaceRepository('app');
      roots = [app];
      const turn = {};
      await recordClaudeCodeGraphOrientation(scope({ cwd: app, turn }));

      roots = [];

      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn })),
      ).resolves.toBe(false);
    });

    it('holds an unreadable-HEAD orientation for its turn only while membership is unchanged', async () => {
      const app = workspaceRepository('app');
      roots = [app];
      const turn = {};
      await recordClaudeCodeGraphOrientation(scope({ cwd: app, turn }));

      rmSync(path.join(app, '.git', 'HEAD'));

      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn })),
      ).resolves.toBe(true);
      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(false);
    });

    it('never orients on a graph call during which membership changed', async () => {
      const app = workspaceRepository('app');
      roots = [app];
      const call = scope({ cwd: app });
      await beginClaudeCodeGraphToolCall(call, 'graph-call');

      const unborn = path.join(root, 'workspace', 'repos', 'unborn');
      mkdirSync(unborn, { recursive: true });
      roots = [app, unborn];
      await recordClaudeCodeGraphOrientation(call, {
        toolUseId: 'graph-call',
        rebuildsGraph: false,
        answeredBuildAt: null,
      });

      await expect(isClaudeCodeGraphOrientationCurrent(call)).resolves.toBe(
        false,
      );
    });

    it('keeps orientation while membership is unchanged, in any listing order', async () => {
      const app = workspaceRepository('app');
      const lib = workspaceRepository('lib');
      roots = [app, lib];
      await recordClaudeCodeGraphOrientation(scope({ cwd: app }));
      const resolutions = mockResolveRepositories.mock.calls.length;

      roots = [lib, app];
      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(true);
      roots = [app, lib];
      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(true);
      expect(mockResolveRepositories.mock.calls.length).toBe(resolutions + 2);
    });

    it('drops a durable orientation when membership cannot be resolved', async () => {
      const app = workspaceRepository('app');
      roots = [app];
      await recordClaudeCodeGraphOrientation(scope({ cwd: app }));

      resolutionFails = true;
      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(false);
      resolutionFails = false;
      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: app, turn: {} })),
      ).resolves.toBe(false);
    });

    it('re-resolves membership from the worktree root for a selected-repository chat', async () => {
      const workspaceRoot = path.join(root, 'workspace');
      const selected = workspaceRepository('app');
      roots = [selected];
      mockResolveWorktreeCwd.mockReturnValue(workspaceRoot);
      mockResolveRepositories.mockImplementation((_projectId, worktreeRoot) =>
        Promise.resolve(
          (worktreeRoot === workspaceRoot ? roots : [selected]).map(
            (rootPath) => ({ repoId: path.basename(rootPath), rootPath }),
          ),
        ),
      );
      await recordClaudeCodeGraphOrientation(scope({ cwd: selected }));

      roots = [selected, workspaceRepository('lib')];

      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ cwd: selected, turn: {} })),
      ).resolves.toBe(false);
    });
  });

  describe('build-stamp attribution', () => {
    const turn = {};
    const record = (
      toolUseId: string,
      answeredBuildAt: number | null,
      rebuildsGraph = true,
    ): Promise<void> =>
      recordClaudeCodeGraphOrientation(scope({ turn }), {
        toolUseId,
        rebuildsGraph,
        answeredBuildAt,
      });
    const orientedNow = (): Promise<boolean> =>
      isClaudeCodeGraphOrientationCurrent(scope({ turn }));
    const orientedLater = (): Promise<boolean> =>
      isClaudeCodeGraphOrientationCurrent(scope({ turn: {} }));
    const publish = (stamp: string, payload: string): void => {
      mockBuildStamp.mockResolvedValue(stamp);
      writeText(`${mockGraphDbPath}-wal`, payload);
    };

    beforeEach(() => {
      makeRepository('repo');
      mockBuildStamp.mockResolvedValue('1001');
    });

    it('rejects a foreign build published after its own build answered', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'build-1');
      publish('1002', 'own build');
      publish('1003', 'foreign build, larger payload');

      await record('build-1', 1002);

      await expect(orientedNow()).resolves.toBe(false);
      await expect(orientedLater()).resolves.toBe(false);
    });

    it('orients durably on the build its answer reported', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'build-1');
      publish('1002', 'own build');

      await record('build-1', 1002);

      await expect(orientedNow()).resolves.toBe(true);
      await expect(orientedLater()).resolves.toBe(true);
    });

    it('invalidates when a foreign build publishes after the record', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'build-1');
      publish('1002', 'own build');
      await record('build-1', 1002);

      publish('1003', 'foreign build, larger payload');

      await expect(orientedNow()).resolves.toBe(false);
    });

    it('holds a legacy build answer for its turn only after the graph changed', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'build-1');
      publish('1002', 'own or foreign build');

      await record('build-1', null);

      await expect(orientedNow()).resolves.toBe(true);
      await expect(orientedLater()).resolves.toBe(false);
    });

    it('orients durably on a legacy build answer when the graph held still', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'build-1');

      await record('build-1', null);

      await expect(orientedLater()).resolves.toBe(true);
    });

    it('holds a stamped answer for its turn only when the current stamp is unreadable', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'build-1');
      publish('1002', 'own build');
      mockBuildStamp.mockResolvedValue(null);

      await record('build-1', 1002);

      await expect(orientedNow()).resolves.toBe(true);
      await expect(orientedLater()).resolves.toBe(false);
    });

    it('drops a turn-only orientation on a known mismatch', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'legacy-build');
      publish('1002', 'unattributed build');
      await record('legacy-build', null);
      await expect(orientedNow()).resolves.toBe(true);

      await beginClaudeCodeGraphToolCall(scope({ turn }), 'context-1');
      publish('1003', 'foreign build, larger payload');
      await record('context-1', 1002, false);

      await expect(orientedNow()).resolves.toBe(false);
    });

    it('adopts a derived write during a read-only call whose stamp matches', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'context-1');
      writeText(`${mockGraphDbPath}-wal`, 'derived analysis');

      await record('context-1', 1001, false);

      await expect(orientedLater()).resolves.toBe(true);
    });

    it('rejects a read-only answer whose stamp no longer matches', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'context-1');
      publish('1002', 'foreign build');

      await record('context-1', 1001, false);

      await expect(orientedNow()).resolves.toBe(false);
    });

    it('rejects a read-only answer when the database was replaced with the same stamp', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'context-1');
      const replacement = `${mockGraphDbPath}.next`;
      writeText(replacement, 'graph copy');
      renameSync(replacement, mockGraphDbPath);

      await record('context-1', 1001, false);

      await expect(orientedNow()).resolves.toBe(false);
    });

    it('rejects a matching build answer when HEAD moved during the call', async () => {
      await beginClaudeCodeGraphToolCall(scope({ turn }), 'build-1');
      writeText(
        path.join(root, 'repo', '.git', 'refs', 'heads', 'main'),
        COMMIT_B,
      );
      publish('1002', 'own build');

      await record('build-1', 1002);

      await expect(orientedNow()).resolves.toBe(false);
    });

    describe('around each graph call', () => {
      const begin = (toolUseId: string): Promise<void> =>
        beginClaudeCodeGraphToolCall(scope({ turn }), toolUseId);
      const orientOnBuild = async (): Promise<void> => {
        await begin('build-0');
        await record('build-0', 1001);
        await expect(orientedLater()).resolves.toBe(true);
      };
      const replaceWithSameStamp = (): void => {
        const replacement = `${mockGraphDbPath}.next`;
        writeText(replacement, 'graph copy');
        renameSync(replacement, mockGraphDbPath);
      };

      it('keeps an orientation through a stampless call that overlapped a derived write', async () => {
        await orientOnBuild();
        await begin('query-1');
        writeText(`${mockGraphDbPath}-wal`, 'derived analysis frames');

        await record('query-1', null, false);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(true);
      });

      it('keeps an orientation through a stampless call that overlapped a WAL checkpoint', async () => {
        writeText(`${mockGraphDbPath}-wal`, 'committed frames');
        await orientOnBuild();
        await begin('query-1');
        writeText(mockGraphDbPath, 'graph with checkpointed frames');
        writeText(`${mockGraphDbPath}-wal`, '');

        await record('query-1', null, false);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(true);
      });

      it('orients durably on a stampless call that overlapped a derived write', async () => {
        await begin('query-1');
        writeText(`${mockGraphDbPath}-wal`, 'derived analysis frames');

        await record('query-1', null, false);

        await expect(orientedLater()).resolves.toBe(true);
      });

      it('invalidates in the same turn when a foreign rebuild overlaps a stampless call', async () => {
        await orientOnBuild();
        await begin('query-1');
        publish('1002', 'foreign rebuild');

        await record('query-1', null, false);

        await expect(orientedNow()).resolves.toBe(false);
      });

      it('invalidates a stampless orientation when a foreign rebuild follows it', async () => {
        await begin('query-1');
        await record('query-1', null, false);

        publish('1002', 'foreign rebuild');

        await expect(orientedNow()).resolves.toBe(false);
      });

      it('orients across turns on a first build that created the graph', async () => {
        rmSync(mockGraphDbPath);
        await begin('build-1');
        writeText(mockGraphDbPath, 'first build');

        await record('build-1', 1001);

        await expect(orientedLater()).resolves.toBe(true);
      });

      it('reads the build stamp off-main before a graph call', async () => {
        mockBuildStamp.mockClear();

        await begin('query-1');

        expect(mockBuildStamp).toHaveBeenCalledWith(
          mockGraphDbPath,
          'project/worktree',
        );
      });

      it('reads no build stamp before a first build', async () => {
        rmSync(mockGraphDbPath);
        mockBuildStamp.mockClear();

        await begin('build-1');

        expect(mockBuildStamp).not.toHaveBeenCalled();
      });

      it('holds a legacy first build for its turn only', async () => {
        rmSync(mockGraphDbPath);
        await begin('build-1');
        writeText(mockGraphDbPath, 'first build');

        await record('build-1', null);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(false);
      });

      it('invalidates an orientation when the graph is deleted', async () => {
        await orientOnBuild();

        rmSync(mockGraphDbPath);

        await expect(orientedNow()).resolves.toBe(false);
      });

      it('never orients durably when the pre-call database could not be read', async () => {
        const dataDirectory = path.dirname(mockGraphDbPath);
        chmodSync(dataDirectory, 0o000);
        try {
          await begin('context-1');
        } finally {
          chmodSync(dataDirectory, 0o755);
        }
        replaceWithSameStamp();

        await record('context-1', 1001, false);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(false);
      });

      it('never orients durably when the pre-call stamp could not be read', async () => {
        mockBuildStamp.mockResolvedValue(null);
        await begin('build-1');
        mockBuildStamp.mockResolvedValue('1001');
        replaceWithSameStamp();

        await record('build-1', 1001);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(false);
      });

      it('keeps a still-valid orientation when a later answer is unattributable', async () => {
        await orientOnBuild();
        await begin('context-1');
        mockBuildStamp.mockResolvedValue(null);

        await record('context-1', 1001, false);
        mockBuildStamp.mockResolvedValue('1001');

        await expect(orientedLater()).resolves.toBe(true);
      });

      it('keeps a still-valid orientation when a later call has no snapshot', async () => {
        await orientOnBuild();

        await record('never-snapshotted', null, false);

        await expect(orientedLater()).resolves.toBe(true);
      });

      it('replaces a no-longer-valid orientation with a turn-only one when the answer is unattributable', async () => {
        await orientOnBuild();
        await begin('legacy-build');
        publish('1002', 'own or foreign build');

        await record('legacy-build', null);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(false);
      });
    });

    describe('around a tool that reports its build stamp', () => {
      const CONTEXT_TOOL = 'mcp__canopy__GetCodeGraphContext';
      const BUILD_TOOL = 'mcp__canopy__BuildOrUpdateCodeGraph';
      const begin = (toolUseId: string, toolName: string): Promise<void> =>
        beginClaudeCodeGraphToolCall(scope({ turn }), toolUseId, toolName);

      it('orients with one stamp read', async () => {
        mockBuildStamp.mockClear();

        await begin('context-1', CONTEXT_TOOL);
        await record('context-1', 1001, false);

        expect(mockBuildStamp).toHaveBeenCalledTimes(1);
        await expect(orientedLater()).resolves.toBe(true);
      });

      it('reorients after a rebuild with one stamp read', async () => {
        await begin('context-1', CONTEXT_TOOL);
        await record('context-1', 1001, false);
        publish('1002', 'rebuild frames');
        await expect(orientedNow()).resolves.toBe(false);
        mockBuildStamp.mockClear();

        await begin('context-2', CONTEXT_TOOL);
        await record('context-2', 1002, false);

        expect(mockBuildStamp).toHaveBeenCalledTimes(1);
        await expect(orientedLater()).resolves.toBe(true);
      });

      it('drops orientation when a rebuild lands during a read-only call', async () => {
        await begin('context-1', CONTEXT_TOOL);
        await record('context-1', 1001, false);
        await expect(orientedLater()).resolves.toBe(true);

        await begin('context-2', CONTEXT_TOOL);
        publish('1002', 'rebuild landed mid-call');
        await record('context-2', 1001, false);

        await expect(orientedNow()).resolves.toBe(false);
        await expect(orientedLater()).resolves.toBe(false);
      });

      it('rejects a build answer overtaken by a foreign build', async () => {
        await begin('build-1', BUILD_TOOL);
        publish('1002', 'own build');
        publish('1003', 'foreign build, larger payload');

        await record('build-1', 1002);

        await expect(orientedNow()).resolves.toBe(false);
      });

      it('rejects a read-only answer when the database was replaced with the same stamp', async () => {
        await begin('context-1', CONTEXT_TOOL);
        const replacement = `${mockGraphDbPath}.next`;
        writeText(replacement, 'graph copy');
        renameSync(replacement, mockGraphDbPath);

        await record('context-1', 1001, false);

        await expect(orientedNow()).resolves.toBe(false);
      });

      it('holds a stampless answer for its turn only', async () => {
        await begin('context-1', CONTEXT_TOOL);

        await record('context-1', null, false);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(false);
      });

      it('holds a stampless build answer for its turn only', async () => {
        await begin('build-1', BUILD_TOOL);

        await record('build-1', null);

        await expect(orientedNow()).resolves.toBe(true);
        await expect(orientedLater()).resolves.toBe(false);
      });

      it('never orients on a stampless read-only answer when the graph changed during the call', async () => {
        await begin('context-1', CONTEXT_TOOL);
        publish('1002', 'rebuild landed mid-call');

        await record('context-1', null, false);

        await expect(orientedNow()).resolves.toBe(false);
      });

      it('still reads the stamp before a tool that reports none', async () => {
        mockBuildStamp.mockClear();

        await begin('query-1', 'mcp__canopy__QueryCodeGraph');

        expect(mockBuildStamp).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('stamp reads', () => {
    it('reads the stamp once when the read recreates an empty WAL', async () => {
      makeRepository('repo');
      const wal = `${mockGraphDbPath}-wal`;
      // A read-only SQLite open recreates the WAL a clean close deleted.
      mockBuildStamp.mockImplementation(() => {
        if (!existsSync(wal)) writeText(wal, '');
        return Promise.resolve('stamp-1');
      });
      mockBuildStamp.mockClear();

      await beginClaudeCodeGraphToolCall(scope(), 'call-1');

      expect(mockBuildStamp).toHaveBeenCalledTimes(1);
    });

    it('keeps orientation through a checkpoint that deleted the WAL', async () => {
      makeRepository('repo');
      const wal = `${mockGraphDbPath}-wal`;
      writeText(wal, 'committed frames');
      await recordClaudeCodeGraphOrientation(scope());
      mockBuildStamp.mockImplementation(() => {
        if (!existsSync(wal)) writeText(wal, '');
        return Promise.resolve('stamp-1');
      });
      writeText(mockGraphDbPath, 'graph with checkpointed frames');
      rmSync(wal);
      mockBuildStamp.mockClear();

      await expect(
        isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
      ).resolves.toBe(true);
      expect(mockBuildStamp).toHaveBeenCalledTimes(1);
    });

    describe('shared between revalidation probes', () => {
      let graph: GraphIdentity;
      let pendingStamps: ((stamp: string | null) => void)[];

      const flush = (): Promise<void> =>
        new Promise((resolve) => setImmediate(resolve));
      const settleStamps = (stamp: string | null): void => {
        for (const settle of pendingStamps.splice(0)) settle(stamp);
      };
      const probe = (): Promise<boolean> =>
        isClaudeCodeGraphOrientationCurrent(scope({ turn: {} }));

      beforeEach(async () => {
        graph = { instance: 'graph-db', content: 'v1' };
        pendingStamps = [];
        setClaudeCodeGraphOrientationReadersForTests({
          resolveRepositoryRoots: () => Promise.resolve(['/repo']),
          readHeadIdentity: () =>
            Promise.resolve(`refs/heads/main=${COMMIT_A}`),
          readGraphIdentity: () => Promise.resolve(graph),
          readBuildStamp: () => mockBuildStamp('graph.db', 'project/worktree'),
        });
        mockBuildStamp.mockResolvedValue('stamp-1');
        await recordClaudeCodeGraphOrientation(scope());
        mockBuildStamp.mockReset();
        mockBuildStamp.mockImplementation(
          () =>
            new Promise((resolve) => {
              pendingStamps.push(resolve);
            }),
        );
      });

      it('lets concurrent probes of one graph share one stamp read', async () => {
        graph = { instance: 'graph-db', content: 'v2' };

        const probes = Array.from({ length: 6 }, () => probe());
        await flush();

        expect(mockBuildStamp).toHaveBeenCalledTimes(1);
        settleStamps('stamp-2');
        await expect(Promise.all(probes)).resolves.toEqual(
          Array.from({ length: 6 }, () => false),
        );
      });

      it('adopts a derived write for every probe that shared its stamp read', async () => {
        graph = { instance: 'graph-db', content: 'v2' };

        const probes = Array.from({ length: 6 }, () => probe());
        await flush();
        settleStamps('stamp-1');

        await expect(Promise.all(probes)).resolves.toEqual(
          Array.from({ length: 6 }, () => true),
        );
        expect(mockBuildStamp).toHaveBeenCalledTimes(1);
      });

      it('lets probes of different chats on one graph share one stamp read', async () => {
        mockBuildStamp.mockResolvedValueOnce('stamp-1');
        await recordClaudeCodeGraphOrientation(scope({ chatId: 'chat-b' }));
        mockBuildStamp.mockClear();
        graph = { instance: 'graph-db', content: 'v2' };

        const probes = [
          probe(),
          isClaudeCodeGraphOrientationCurrent(
            scope({ chatId: 'chat-b', turn: {} }),
          ),
        ];
        await flush();

        expect(mockBuildStamp).toHaveBeenCalledTimes(1);
        settleStamps('stamp-1');
        await expect(Promise.all(probes)).resolves.toEqual([true, true]);
      });

      it('never reuses a settled stamp read for a later probe', async () => {
        mockBuildStamp.mockResolvedValueOnce('stamp-1');
        await recordClaudeCodeGraphOrientation(scope({ chatId: 'chat-b' }));
        mockBuildStamp.mockClear();
        graph = { instance: 'graph-db', content: 'v2' };
        const first = probe();
        await flush();
        settleStamps('stamp-1');
        await expect(first).resolves.toBe(true);

        // A rebuild the unchanged `stat` cannot show: only a new read sees it.
        const later = isClaudeCodeGraphOrientationCurrent(
          scope({ chatId: 'chat-b', turn: {} }),
        );
        await flush();

        expect(mockBuildStamp).toHaveBeenCalledTimes(2);
        settleStamps('stamp-2');
        await expect(later).resolves.toBe(false);
      });

      it('reads again for a probe that observed a different graph', async () => {
        graph = { instance: 'graph-db', content: 'v2' };
        const first = probe();
        await flush();
        graph = { instance: 'graph-db', content: 'v3' };

        const second = probe();
        await flush();

        expect(mockBuildStamp).toHaveBeenCalledTimes(2);
        mockBuildStamp.mockResolvedValue('stamp-2');
        settleStamps('stamp-2');
        await expect(Promise.all([first, second])).resolves.toEqual([
          false,
          false,
        ]);
      });

      it('never lets a graph call share a probe stamp read', async () => {
        graph = { instance: 'graph-db', content: 'v2' };
        const probing = probe();
        await flush();

        const beginning = beginClaudeCodeGraphToolCall(
          scope(),
          'query-1',
          'mcp__canopy__QueryCodeGraph',
        );
        await flush();
        expect(mockBuildStamp).toHaveBeenCalledTimes(2);
        // Settle only the graph call's read; the probe's stays in flight.
        pendingStamps.splice(1, 1)[0]?.('stamp-1');
        await beginning;

        const recording = recordClaudeCodeGraphOrientation(scope(), {
          toolUseId: 'query-1',
          rebuildsGraph: false,
          answeredBuildAt: null,
        });
        await flush();
        expect(mockBuildStamp).toHaveBeenCalledTimes(3);

        // Settle the probe's read before the record's, which replaces the
        // entry the probe is checking.
        pendingStamps.shift()?.('stamp-1');
        await expect(probing).resolves.toBe(true);
        settleStamps('stamp-1');
        await expect(recording).resolves.toBeUndefined();
        await expect(probe()).resolves.toBe(true);
      });

      it("never lets a record's revalidation share a probe stamp read", async () => {
        graph = { instance: 'graph-db', content: 'v2' };
        const probing = probe();
        await flush();
        await beginClaudeCodeGraphToolCall(
          scope(),
          'context-1',
          'mcp__canopy__GetCodeGraphContext',
        );
        expect(mockBuildStamp).toHaveBeenCalledTimes(1);

        // A stampless answer cannot bind, so the record revalidates the
        // existing orientation instead.
        const recording = recordClaudeCodeGraphOrientation(scope(), {
          toolUseId: 'context-1',
          rebuildsGraph: false,
          answeredBuildAt: null,
        });
        await flush();
        expect(mockBuildStamp).toHaveBeenCalledTimes(2);
        pendingStamps.splice(1, 1)[0]?.('stamp-1');
        await flush();
        expect(mockBuildStamp).toHaveBeenCalledTimes(3);

        settleStamps('stamp-1');
        await expect(probing).resolves.toBe(true);
        await expect(recording).resolves.toBeUndefined();
        await expect(probe()).resolves.toBe(true);
        expect(mockBuildStamp).toHaveBeenCalledTimes(3);
      });
    });

    it('records the stamp reads each scenario turn performs', async () => {
      makeRepository('repo');
      const wal = `${mockGraphDbPath}-wal`;
      let stamp = '1001';
      // A read-only SQLite open recreates the WAL a clean close deleted.
      mockBuildStamp.mockImplementation(() => {
        if (!existsSync(wal)) writeText(wal, '');
        return Promise.resolve(stamp);
      });
      const turn = {};
      const readsDuring = async (
        action: () => Promise<unknown>,
      ): Promise<number> => {
        mockBuildStamp.mockClear();
        await action();
        return mockBuildStamp.mock.calls.length;
      };
      const graphCall = async (
        toolUseId: string,
        toolName: string,
        answeredBuildAt: number,
      ): Promise<void> => {
        await beginClaudeCodeGraphToolCall(
          scope({ turn }),
          toolUseId,
          toolName,
        );
        await recordClaudeCodeGraphOrientation(scope({ turn }), {
          toolUseId,
          rebuildsGraph: false,
          answeredBuildAt,
        });
      };
      const sixSearches = async (expected: boolean): Promise<void> => {
        await expect(
          Promise.all(
            Array.from({ length: 6 }, () =>
              isClaudeCodeGraphOrientationCurrent(scope({ turn: {} })),
            ),
          ),
        ).resolves.toEqual(Array.from({ length: 6 }, () => expected));
      };
      // A writer's clean close checkpoints and deletes the WAL.
      const writeAndClose = (content: string): void => {
        writeText(mockGraphDbPath, content);
        rmSync(wal, { force: true });
      };

      const reads = {
        orient: await readsDuring(() =>
          graphCall('context-1', 'mcp__canopy__GetCodeGraphContext', 1001),
        ),
        unchangedTurn: await readsDuring(() => sixSearches(true)),
        nonBuildWriteTurn: await readsDuring(async () => {
          writeAndClose('derived analysis');
          await sixSearches(true);
        }),
        rebuiltTurn: await readsDuring(async () => {
          stamp = '1002';
          writeAndClose('rebuilt graph');
          await sixSearches(false);
        }),
        reorient: await readsDuring(() =>
          graphCall('context-2', 'mcp__canopy__GetCodeGraphContext', 1002),
        ),
        unstampedToolOrient: await readsDuring(async () => {
          await beginClaudeCodeGraphToolCall(
            scope({ turn }),
            'query-1',
            'mcp__canopy__QueryCodeGraph',
          );
          await recordClaudeCodeGraphOrientation(scope({ turn }), {
            toolUseId: 'query-1',
            rebuildsGraph: false,
            answeredBuildAt: null,
          });
        }),
      };

      expect(reads).toEqual({
        orient: 1,
        unchangedTurn: 0,
        nonBuildWriteTurn: 1,
        rebuiltTurn: 1,
        reorient: 1,
        unstampedToolOrient: 2,
      });
    });
  });
});

describe('readClaudeCodeGraphToolAnswer', () => {
  const text = (value: unknown): { type: 'text'; text: string } => ({
    type: 'text',
    text: JSON.stringify(value),
  });

  it('reads the stamp from CLI content blocks and SDK-wrapped content', () => {
    const answer = { status: 'ok', lastBuildAt: 1002 };
    expect(readClaudeCodeGraphToolAnswer([text(answer)])).toEqual({
      failed: false,
      lastBuildAt: 1002,
    });
    expect(readClaudeCodeGraphToolAnswer({ content: [text(answer)] })).toEqual({
      failed: false,
      lastBuildAt: 1002,
    });
    expect(readClaudeCodeGraphToolAnswer(JSON.stringify(answer))).toEqual({
      failed: false,
      lastBuildAt: 1002,
    });
  });

  it('reports legacy, malformed and ambiguous answers without a stamp', () => {
    expect(
      readClaudeCodeGraphToolAnswer([text({ status: 'ok', filesParsed: 1 })]),
    ).toEqual({ failed: false, lastBuildAt: null });
    expect(
      readClaudeCodeGraphToolAnswer([{ type: 'text', text: 'not json' }]),
    ).toEqual({ failed: false, lastBuildAt: null });
    expect(
      readClaudeCodeGraphToolAnswer([text({ lastBuildAt: '1002' })]),
    ).toEqual({ failed: false, lastBuildAt: null });
    expect(
      readClaudeCodeGraphToolAnswer([
        text({ lastBuildAt: 1002 }),
        text({ lastBuildAt: 1003 }),
      ]),
    ).toEqual({ failed: false, lastBuildAt: null });
    expect(readClaudeCodeGraphToolAnswer({})).toEqual({
      failed: false,
      lastBuildAt: null,
    });
  });

  it('reports failed answers in either shape', () => {
    expect(
      readClaudeCodeGraphToolAnswer({ content: [], isError: true }).failed,
    ).toBe(true);
    expect(
      readClaudeCodeGraphToolAnswer([text({ status: 'error', summary: 'x' })])
        .failed,
    ).toBe(true);
  });
});

// CAN-5931: legacy effects captured before dispatcher routing. No PR6 adapter imports.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS, type WorkspaceType } from '@canopy/desktop-shared/types';

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
import {
  persistTurnDiffTreeRef,
  restoreToSnapshot,
  revertUncommittedFile,
} from '../lib/git';
import {
  ensureRepoShadow,
  clearRepoShadowRuntimeCaches,
} from '../lib/repo-shadow';
import { archiveGitEnv } from '../lib/git-tree-snapshot';
import {
  getEnhancedEnv,
  registerUserEnvironmentInjector,
  registerSecretsEnvInjector,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { registerActivityGoldenHandlers } from './helpers/activity-golden-registration';

jest.setTimeout(30_000);
let root: string;
let data: string;
let serial = 0;
let registration: ReturnType<typeof registerActivityGoldenHandlers>;
let savedEnvironment: NodeJS.ProcessEnv;
const workspace = 'local-mutations';
function git(path: string, args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}
function json(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function repository(unborn = false): string {
  const path = join(root, `repo-${serial++}`);
  mkdirSync(path);
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  if (!unborn) {
    writeFileSync(join(path, 'file.txt'), 'original\n');
    writeFileSync(join(path, '.gitignore'), 'ignored\n');
    git(path, ['add', '.']);
    git(path, ['commit', '-qm', 'initial']);
  }
  return path;
}
async function revertIpc(
  worktreeId: string,
  fields: Record<string, unknown>,
  event: object = {},
): Promise<unknown> {
  const handler = mockHandlers.get(IPC_CHANNELS.activityRevertFile);
  if (!handler) throw new Error('revert handler missing');
  return handler(event, {
    projectId: workspace,
    worktreeId,
    filePath: 'file.txt',
    status: 'modified',
    ...fields,
  });
}
function ipcWorktree(): { path: string; id: string } {
  const source = repository();
  const id = `work-${serial++}`;
  const path = join(data, 'workspaces', workspace, 'worktrees', id);
  git(source, ['worktree', 'add', '-qb', id, path]);
  json(join(data, 'workspaces', workspace, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: source,
    repos: [],
  });
  json(join(data, 'workspaces', workspace, 'worktrees.json'), {
    version: 1,
    worktrees: [{ id, name: id, branchName: id, createdAt: 'now' }],
  });
  return { path, id };
}
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git-local-golden-')));
  data = join(root, 'data');
  savedEnvironment = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith('GIT_')) delete process.env[key];
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(root, 'empty-config');
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  process.env.CANOPY_DATA_DIR = data;
  json(join(data, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      { id: workspace, name: workspace, type: 'single-repo', order: 0 },
    ],
  });
  registerWorkspaceTypes(
    new Map<string, WorkspaceType>([[workspace, 'single-repo']]),
  );
  registration = registerActivityGoldenHandlers();
});
afterAll(async () => {
  await registration?.shutdown();
  clearRepoShadowRuntimeCaches();
  for (const key of Object.keys(process.env))
    if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  rmSync(root, { recursive: true, force: true });
});

describe('legacy activity:revert-file wire capture', () => {
  it.each([
    { caller: 'local desktop', event: {} },
    { caller: 'paired controller', event: { remoteDeviceId: 'device-01' } },
  ])(
    'returns void and prefers live Git status over stale modal status for $caller',
    async ({ event }) => {
      const { path, id } = ipcWorktree();
      writeFileSync(join(path, 'file.txt'), 'edited\n');
      const result = await revertIpc(id, { status: 'untracked' }, event);
      expect(result).toBeUndefined();
      expect(readFileSync(join(path, 'file.txt'), 'utf8')).toBe('original\n');
      expect(git(path, ['status', '--porcelain'])).toBe('');
    },
  );
  it('pins request validation messages before Git effects', async () => {
    const { id } = ipcWorktree();
    await expect(revertIpc(id, { status: 'renamed' })).rejects.toThrow(
      'previousPath is required for renamed files',
    );
    await expect(revertIpc(id, { status: 'unknown' })).rejects.toThrow(
      'Cannot revert file "file.txt": unknown status is not supported',
    );
    await expect(revertIpc(id, { filePath: '../outside' })).rejects.toThrow();
  });
});

describe('legacy uncommitted file effects', () => {
  it.each(['modified', 'deleted', 'type-changed', 'unmerged'] as const)(
    'restores HEAD for %s',
    async (status) => {
      const path = repository();
      writeFileSync(join(path, 'file.txt'), 'edited\n');
      git(path, ['add', '.']);
      if (status === 'deleted') rmSync(join(path, 'file.txt'));
      await expect(
        revertUncommittedFile(path, 'file.txt', status),
      ).resolves.toBeUndefined();
      expect(readFileSync(join(path, 'file.txt'), 'utf8')).toBe('original\n');
      expect(git(path, ['status', '--porcelain'])).toBe('');
    },
  );
  it.each(['untracked', 'added', 'copied'] as const)(
    'removes a new %s file',
    async (status) => {
      const path = repository();
      writeFileSync(join(path, 'new file.txt'), 'new\n');
      if (status !== 'untracked') git(path, ['add', '.']);
      await revertUncommittedFile(path, 'new file.txt', status);
      expect(existsSync(join(path, 'new file.txt'))).toBe(false);
      expect(git(path, ['status', '--porcelain'])).toBe('');
    },
  );
  it('restores both paths of a rename and keeps other edits', async () => {
    const path = repository();
    git(path, ['mv', 'file.txt', 'renamed.txt']);
    writeFileSync(join(path, 'other'), 'keep');
    await revertUncommittedFile(path, 'renamed.txt', 'renamed', 'file.txt');
    expect(existsSync(join(path, 'renamed.txt'))).toBe(false);
    expect(readFileSync(join(path, 'file.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(path, 'other'), 'utf8')).toBe('keep');
    await expect(revertUncommittedFile(path, 'x', 'renamed')).rejects.toThrow(
      'Cannot revert renamed file "x": previousPath is required',
    );
    await expect(revertUncommittedFile(path, 'x', 'unknown')).rejects.toThrow(
      'Cannot revert file "x": unknown status is not supported',
    );
    await expect(
      revertUncommittedFile(path, 'absent', 'untracked'),
    ).rejects.toThrow();
  });
});

describe('legacy snapshot restore and turn refs', () => {
  it('rolls back HEAD, overlays the snapshot, cleans new files, preserves ignored files and disables hooks', async () => {
    const path = repository();
    const headCommitSha = git(path, ['rev-parse', 'HEAD']);
    writeFileSync(join(path, 'file.txt'), 'snapshot edits\n');
    git(path, ['add', '.']);
    const treeSha = git(path, ['write-tree']);
    git(path, ['commit', '-qm', 'later']);
    writeFileSync(join(path, 'file.txt'), 'later edits');
    writeFileSync(join(path, 'new'), 'remove');
    writeFileSync(join(path, 'ignored'), 'keep');
    const marker = join(root, 'hook-ran');
    const hook = join(path, '.git', 'hooks', 'reference-transaction');
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    await expect(
      restoreToSnapshot(path, { treeSha, headCommitSha }),
    ).resolves.toBeUndefined();
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(headCommitSha);
    expect(readFileSync(join(path, 'file.txt'), 'utf8')).toBe(
      'snapshot edits\n',
    );
    expect(existsSync(join(path, 'new'))).toBe(false);
    expect(readFileSync(join(path, 'ignored'), 'utf8')).toBe('keep');
    expect(existsSync(marker)).toBe(false);
    expect(git(path, ['diff', '--cached', '--name-only'])).toBe('file.txt');
  });
  it.each([false, true])(
    'restores a snapshot with no captured HEAD (unborn=%s)',
    async (unborn) => {
      const path = repository(unborn);
      writeFileSync(join(path, 'snapshot'), 'before first commit');
      git(path, ['add', '.']);
      const treeSha = git(path, ['write-tree']);
      if (unborn) git(path, ['commit', '-qm', 'first']);
      await restoreToSnapshot(path, { treeSha });
      expect(() => git(path, ['rev-parse', '--verify', 'HEAD'])).toThrow();
      expect(readFileSync(join(path, 'snapshot'), 'utf8')).toBe(
        'before first commit',
      );
      expect(git(path, ['write-tree'])).toBe(treeSha);
    },
  );
  it('validates both IDs before mutating and preserves turn tree objects by ref', async () => {
    const path = repository();
    const head = git(path, ['rev-parse', 'HEAD']);
    const treeSha = git(path, ['rev-parse', 'HEAD^{tree}']);
    await expect(restoreToSnapshot(path, { treeSha: 'bad' })).rejects.toThrow(
      'Invalid tree SHA',
    );
    await expect(
      restoreToSnapshot(path, { treeSha, headCommitSha: '-HEAD' }),
    ).rejects.toThrow('Invalid HEAD commit SHA');
    await expect(
      persistTurnDiffTreeRef(path, 'project', 'turn', ''),
    ).rejects.toThrow('Invalid tree SHA');
    await persistTurnDiffTreeRef(path, 'project', 'turn', treeSha);
    const refs = git(path, [
      'for-each-ref',
      '--format=%(objectname)',
      'refs/app/turn-diff-trees',
    ]);
    expect(refs).toBe(treeSha);
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(head);
  });
});

describe('legacy repository-shadow port', () => {
  it('creates a detached shadow without touching the user checkout and reuses fresh metadata', async () => {
    const path = repository();
    const origin = join(root, `origin-${serial++}.git`);
    git(root, ['clone', '-q', '--bare', path, origin]);
    git(path, ['remote', 'add', 'origin', origin]);
    git(path, ['fetch', '-q', 'origin']);
    git(path, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    const head = git(path, ['rev-parse', 'HEAD']);
    writeFileSync(join(path, 'file.txt'), 'user changes\n');
    const [one, two] = await Promise.all([
      ensureRepoShadow(path),
      ensureRepoShadow(path),
    ]);
    expect(two).toEqual(one);
    expect(one.repoPath).toBe(path);
    expect(one.defaultBranch).toBe('main');
    expect(git(one.shadowPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
      'HEAD',
    );
    expect(readFileSync(join(one.shadowPath, 'file.txt'), 'utf8')).toBe(
      'original\n',
    );
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(path, 'file.txt'), 'utf8')).toBe('user changes\n');
    expect(await ensureRepoShadow(path, { allowStale: true })).toEqual(one);
  });
  it('retains failure messages and allows an explicit bypass after fixing origin', async () => {
    const path = repository();
    let message = '';
    try {
      await ensureRepoShadow(path);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe('');
    await expect(ensureRepoShadow(path)).rejects.toThrow(
      message.replace(/^Error: /, ''),
    );
    const origin = join(root, `origin-${serial++}.git`);
    git(root, ['clone', '-q', '--bare', path, origin]);
    git(path, ['remote', 'add', 'origin', origin]);
    expect(
      (await ensureRepoShadow(path, { bypassFailureCache: true }))
        .defaultBranch,
    ).toBe('main');
  });
});

describe('Git runner environment membership', () => {
  it('preserves inherited Git selectors while excluding user and secret overlays; archive runner strips selectors', async () => {
    const path = repository();
    const treeSha = git(path, ['rev-parse', 'HEAD^{tree}']);
    const before = { ...process.env };
    try {
      Object.assign(process.env, {
        GIT_DIR: join(path, '.git'),
        GIT_INDEX_FILE: join(path, '.git', 'index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'canopy.golden',
        GIT_CONFIG_VALUE_0: 'inherited',
        GIT_TERMINAL_PROMPT: '1',
        GCM_INTERACTIVE: 'always',
      });
      registerUserEnvironmentInjector(() => ({
        CANOPY_GOLDEN_USER_OVERLAY: 'not-in-git',
      }));
      registerSecretsEnvInjector(() => ({
        CANOPY_GOLDEN_SECRET_OVERLAY: 'not-in-git',
      }));
      const env = getEnhancedEnv({
        includeCanopySecrets: false,
        environment: false,
      });
      expect(env.GIT_DIR).toBe(process.env.GIT_DIR);
      expect(env.GIT_INDEX_FILE).toBe(process.env.GIT_INDEX_FILE);
      expect(env.GIT_CONFIG_KEY_0).toBe('canopy.golden');
      expect(env.GIT_TERMINAL_PROMPT).toBe('1');
      expect(env.GCM_INTERACTIVE).toBe('always');
      expect(env.CANOPY_GOLDEN_USER_OVERLAY).toBeUndefined();
      expect(env.CANOPY_GOLDEN_SECRET_OVERLAY).toBeUndefined();
      expect(env.PATH).toBeTruthy();
      const archive = archiveGitEnv(process.env);
      expect(archive.GIT_DIR).toBeUndefined();
      expect(archive.GIT_INDEX_FILE).toBeUndefined();
      expect(archive.GIT_CONFIG_KEY_0).toBeUndefined();
      // The real mutation must remain usable with the inherited selectors.
      await persistTurnDiffTreeRef(path, 'env-project', 'env-turn', treeSha);
      expect(
        git(path, [
          'rev-parse',
          `refs/app/turn-diff-trees/env-project/env-turn/${treeSha}`,
        ]),
      ).toBe(treeSha);
    } finally {
      registerUserEnvironmentInjector(null);
      registerSecretsEnvInjector(null);
      for (const key of Object.keys(process.env))
        if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  });
});

import {
  WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyHostExecution,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import type { WorkspaceFileRead } from '../../workspace/read-formats';
import { createRecordedWorkerGitHosts } from '../recorded-worker-git-hosts';
import {
  GitRepositoryReadError,
  type GitChildEnvironment,
  type GitRepositoryReader,
} from '../repository-reads';
import {
  GitRepositoryWriteError,
  type GitRepositoryWrite,
  type GitRepositoryWritePort,
} from '../repository-writes';
import { createWorkerGitSyncWriteHandlers } from '../worker-git-sync-writes';

// CAN-5517: the daemon's fetch and pull host over canonical records and the
// Git write host's fixed commands.

const ROOT = '/data';
const CHECKOUT = '/data/workspaces/single/worktrees/task';
const MEMBER = '/data/workspaces/multi/worktrees/task/repos/api';
const core: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'bundled-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.git.write'],
};

const RECORDS: Record<string, unknown> = {
  '/data/workspaces/index.json': {
    version: 1,
    workspaces: [
      { id: 'single', name: 'single', type: 'single-repo', color: '#fff' },
      { id: 'multi', name: 'multi', type: 'multi-repo', color: '#fff' },
    ],
  },
  '/data/workspaces/single/workspace.json': {
    version: 1,
    type: 'single-repo',
    repoPath: '/src/single',
    repos: [],
  },
  '/data/workspaces/single/worktrees.json': {
    version: 1,
    worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
  },
  '/data/workspaces/multi/workspace.json': {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'api', name: 'API', repoPath: '/src/api' }],
  },
  '/data/workspaces/multi/worktrees.json': {
    version: 1,
    worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
  },
};

const UNUSED_READER: GitRepositoryReader = {
  read: () => Promise.reject(new GitRepositoryReadError('git_unavailable')),
  selectExecutable: () => Promise.reject(new Error('unused')),
};

interface Run {
  readonly write: GitRepositoryWrite;
  readonly cwd: string;
  readonly environment: GitChildEnvironment | undefined;
}

type Answer = { exitCode: number; stdout?: string } | Error;

/** Answers by kind, or `kind:value` for a branch or state name. */
function writePort(
  runs: Run[],
  answers: Record<string, Answer>,
  onRun?: (write: GitRepositoryWrite) => void,
): GitRepositoryWritePort {
  return {
    run: (write, cwd, environment) => {
      runs.push({ write, cwd, environment });
      onRun?.(write);
      const value =
        'branch' in write ? write.branch : 'name' in write ? write.name : '';
      const answer = answers[`${write.kind}:${value}`] ?? answers[write.kind];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({
        exitCode: answer?.exitCode ?? 1,
        stdout: answer?.stdout ?? '',
      });
    },
  };
}

function dispatcher(
  writes: GitRepositoryWritePort,
  existing: readonly string[] = [],
  stats: string[] = [],
): CanopyDispatcher<
  Record<never, never>,
  typeof WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS
> {
  const hosts = createRecordedWorkerGitHosts({
    dataRoot: ROOT,
    authorityId: 'authority',
    recordsTargetId: 'in-process',
    os: 'darwin',
    arch: 'arm64',
    git: UNUSED_READER,
    writes,
    files: {
      readRecord: (path): Promise<WorkspaceFileRead> => {
        const value = RECORDS[path];
        return Promise.resolve(
          value === undefined
            ? { state: 'absent' }
            : { state: 'present', raw: JSON.stringify(value) },
        );
      },
      stat: (path) => {
        stats.push(path);
        return existing.includes(path)
          ? Promise.resolve({
              isFile: (): boolean => false,
              isDirectory: (): boolean => true,
              isSymbolicLink: (): boolean => false,
            })
          : Promise.reject(new Error('ENOENT'));
      },
    },
  });
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: {},
      instructions: WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createWorkerGitSyncWriteHandlers(hosts.syncWrite),
      streams: {},
    },
  });
}

const single = { workspaceId: 'single', worktreeId: 'task' };

describe('recorded worker.git.fetch', () => {
  it('fetches in the recorded checkout, or a member repository, with the forwarded environment', async () => {
    const runs: Run[] = [];
    const run = dispatcher(
      writePort(runs, { 'fetch-origin': { exitCode: 0 } }),
    );
    const execution: CanopyHostExecution = {
      childEnvironment: { PATH: '/login/bin:/usr/bin', HOME: '/home/user' },
    };
    await expect(
      run.instruction(
        'worker.git.fetch',
        { scope: single, prune: true },
        { caller: core, execution },
      ),
    ).resolves.toEqual({ remote: 'origin', pruned: true });
    await run.instruction(
      'worker.git.fetch',
      { scope: { workspaceId: 'multi', worktreeId: 'task', repoId: 'api' }, prune: false }, // prettier-ignore
      { caller: core },
    );
    expect(runs).toEqual([
      {
        write: { kind: 'fetch-origin', prune: true },
        cwd: CHECKOUT,
        environment: execution.childEnvironment,
      },
      {
        write: { kind: 'fetch-origin', prune: false },
        cwd: MEMBER,
        environment: undefined,
      },
    ]);
  });

  it('fails a fetch Git refuses as internal, and a stopped host as unavailable', async () => {
    await expect(
      dispatcher(writePort([], {})).instruction(
        'worker.git.fetch',
        { scope: single, prune: true },
        { caller: core },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    for (const code of ['stopped', 'git_unavailable'] as const)
      await expect(
        dispatcher(
          writePort([], { 'fetch-origin': new GitRepositoryWriteError(code) }),
        ).instruction(
          'worker.git.fetch',
          { scope: single, prune: true },
          { caller: core },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'unavailable', retry: { kind: 'after_refresh' } },
      });
  });

  it('runs nothing for a workspace or worktree the records do not list', async () => {
    const runs: Run[] = [];
    for (const scope of [
      { workspaceId: 'unknown', worktreeId: 'task' },
      { workspaceId: 'single', worktreeId: 'absent' },
      { workspaceId: 'code-review-chat', worktreeId: 'single--task' },
    ])
      await expect(
        dispatcher(writePort(runs, {})).instruction(
          'worker.git.fetch',
          { scope, prune: true },
          { caller: core },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'worker.git.fetch.scopeUnsupported',
        },
      });
    expect(runs).toEqual([]);
  });
});

describe('recorded worker.git.pull', () => {
  const pull = (
    run: ReturnType<typeof dispatcher>,
    strategy: 'fast-forward' | 'rebase',
    options: { signal?: AbortSignal; expected?: { branch: string } } = {},
  ): Promise<unknown> =>
    run.instruction(
      'worker.git.pull',
      {
        scope: single,
        branch: 'topic',
        strategy,
        ...(options.expected && { expected: options.expected }),
      },
      { caller: core, ...(options.signal && { signal: options.signal }) },
    );

  it('fast-forwards and rebases in the recorded checkout', async () => {
    const runs: Run[] = [];
    const run = dispatcher(
      writePort(runs, {
        'pull-fast-forward:topic': { exitCode: 0 },
        'pull-rebase:topic': { exitCode: 0 },
      }),
    );
    await expect(pull(run, 'fast-forward')).resolves.toEqual({
      outcome: 'pulled',
    });
    await expect(pull(run, 'rebase')).resolves.toEqual({ outcome: 'pulled' });
    expect(runs.map(({ write, cwd }) => [write, cwd])).toEqual([
      [{ kind: 'pull-fast-forward', branch: 'topic' }, CHECKOUT],
      [{ kind: 'pull-rebase', branch: 'topic' }, CHECKOUT],
    ]);
  });

  it("answers a rebase in progress from Git's state directory, relative to the checkout", async () => {
    const runs: Run[] = [];
    const stats: string[] = [];
    const merge = '/src/single/.git/worktrees/task/rebase-merge';
    const run = dispatcher(
      writePort(runs, {
        'rebase-state-path:rebase-merge': { exitCode: 0, stdout: `${merge}\n` },
        'rebase-state-path:rebase-apply': {
          exitCode: 0,
          stdout: '.git/rebase-apply\n',
        },
      }),
      [merge],
      stats,
    );
    await expect(pull(run, 'rebase')).resolves.toEqual({
      outcome: 'conflict',
      conflict: 'rebase',
    });
    expect(stats.sort()).toEqual([`${CHECKOUT}/.git/rebase-apply`, merge]);
  });

  it('answers an autostash left unmerged', async () => {
    const run = dispatcher(
      writePort([], {
        'rebase-state-path': { exitCode: 0, stdout: '.git/x\n' },
        'stash-list': {
          exitCode: 0,
          stdout: 'stash@{0}: autostash\nstash@{1}: WIP on topic\n',
        },
        'porcelain-status': { exitCode: 0, stdout: ' M a.txt\nAA b.txt\n' },
      }),
    );
    await expect(pull(run, 'rebase')).resolves.toEqual({
      outcome: 'conflict',
      conflict: 'autostash',
    });
  });

  it('fails as internal when the failed rebase is neither, or Git cannot name its state', async () => {
    for (const answers of [
      <Record<string, Answer>>{
        'rebase-state-path': { exitCode: 0, stdout: '.git/x\n' },
        'stash-list': { exitCode: 0, stdout: 'stash@{0}: autostash\n' },
        // A failed status reads as no unmerged path, as on the desktop.
        'porcelain-status': { exitCode: 128 },
      },
      <Record<string, Answer>>{ 'rebase-state-path': { exitCode: 128 } },
    ])
      await expect(
        pull(dispatcher(writePort([], answers)), 'rebase'),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
  });

  it('stops as unavailable when the host stops during the conflict reads', async () => {
    const run = dispatcher(
      writePort([], {
        'rebase-state-path': new GitRepositoryWriteError('stopped'),
      }),
    );
    await expect(pull(run, 'rebase')).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
  });

  it('does not start the pull after a cancel during the head check', async () => {
    const runs: Run[] = [];
    const controller = new AbortController();
    const run = dispatcher(
      writePort(
        runs,
        { 'current-branch': { exitCode: 0, stdout: 'topic\n' } },
        (write) => {
          if (write.kind === 'current-branch') controller.abort();
        },
      ),
    );
    await expect(
      pull(run, 'rebase', {
        signal: controller.signal,
        expected: { branch: 'topic' },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    // Let the handler run past the head check.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runs.map(({ write }) => write.kind)).toEqual(['current-branch']);
  });

  it('refuses a changed head before the pull', async () => {
    const runs: Run[] = [];
    await expect(
      pull(
        dispatcher(
          writePort(runs, {
            'current-branch': { exitCode: 0, stdout: 'other\n' },
          }),
        ),
        'fast-forward',
        { expected: { branch: 'topic' } },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'conflict', code: 'worker.git.pull.headChanged' },
    });
    expect(runs.map(({ write }) => write.kind)).toEqual(['current-branch']);
  });
});

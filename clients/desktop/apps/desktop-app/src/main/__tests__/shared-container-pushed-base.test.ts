import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveSharedContainerPushedBase } from '../shared-containers/pushed-base';

const execFileAsync = promisify(execFile);

describe('shared-container pushed base', () => {
  it('selects the newest remote-tracked ancestor without requiring a network token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-pushed-base-'));
    const remote = join(root, 'remote.git');
    const repo = join(root, 'repo');
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init', repo]);
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'file.txt'), 'base');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repo });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], {
      cwd: repo,
    });
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: repo });
    const { stdout: pushed } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      {
        cwd: repo,
      },
    );
    await writeFile(join(repo, 'file.txt'), 'unpushed');
    await execFileAsync('git', ['commit', '-am', 'unpushed'], { cwd: repo });
    // Candidate selection is commit-based, so detaching HEAD must not turn an
    // otherwise shareable branch into a gate.
    await execFileAsync('git', ['checkout', '--detach'], { cwd: repo });

    await expect(
      resolveSharedContainerPushedBase(
        { projectId: 'p', worktreeId: 'w', repoId: 'r', repoPath: repo },
        {
          getHead: async (path) =>
            (
              await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })
            ).stdout.trim(),
          resolveBaseBranch: () => Promise.resolve({ branch: 'main' }),
          listCandidates: () => Promise.resolve(['origin/main']),
          mergeBase: async (path, a, b) =>
            (
              await execFileAsync('git', ['merge-base', a, b], { cwd: path })
            ).stdout.trim(),
          countCommits: async (path, range) =>
            Number(
              (
                await execFileAsync('git', ['rev-list', '--count', range], {
                  cwd: path,
                })
              ).stdout.trim(),
            ),
          getRemoteUrl: () => Promise.resolve(remote),
          resolveToken: () => Promise.resolve(''),
          probeCommit: () => Promise.resolve(undefined),
        },
      ),
    ).resolves.toMatchObject({
      baseSha: pushed.trim(),
      unpushedCommitCount: 1,
    });
  }, 20_000);

  it('passes a local-only base branch lookup through to the base resolver', async () => {
    const resolveBaseBranch = jest.fn(() => Promise.resolve({ branch: null }));
    await resolveSharedContainerPushedBase(
      {
        projectId: 'p',
        worktreeId: 'w',
        repoId: 'r',
        repoPath: '/repo',
        allowRemoteLookup: false,
      },
      {
        getHead: () => Promise.resolve('a'.repeat(40)),
        resolveBaseBranch,
        listCandidates: () => Promise.resolve([]),
        mergeBase: () => Promise.resolve(null),
        countCommits: () => Promise.resolve(0),
        getRemoteUrl: () => Promise.resolve(null),
        resolveToken: () => Promise.resolve(''),
        probeCommit: () => Promise.resolve(undefined),
      },
    );
    expect(resolveBaseBranch).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo', allowRemoteLookup: false }),
    );
  });

  it('tries the next local candidate when GitHub does not contain the nearest one', async () => {
    const nearest = 'a'.repeat(40);
    const fallback = 'b'.repeat(40);
    const probeCommit = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('not found'), { status: 404 }),
      )
      .mockResolvedValueOnce(undefined);

    await expect(
      resolveSharedContainerPushedBase(
        { projectId: 'p', worktreeId: 'w', repoId: 'r', repoPath: '/repo' },
        {
          getHead: () => Promise.resolve('c'.repeat(40)),
          resolveBaseBranch: () => Promise.resolve({ branch: 'main' }),
          listCandidates: () =>
            Promise.resolve(['origin/feature', 'origin/main']),
          mergeBase: (_path, _head, ref) =>
            Promise.resolve(ref === 'origin/feature' ? nearest : fallback),
          countCommits: (_path, range) =>
            Promise.resolve(range.startsWith(nearest) ? 1 : 2),
          getRemoteUrl: () =>
            Promise.resolve('https://github.com/acme/repository.git'),
          resolveToken: () => Promise.resolve('token'),
          probeCommit,
        },
      ),
    ).resolves.toEqual({
      baseSha: fallback,
      headSha: 'c'.repeat(40),
      unpushedCommitCount: 2,
    });
    expect(probeCommit).toHaveBeenCalledTimes(2);
  });

  it('returns null when the repository has no HEAD', async () => {
    const listCandidates = jest.fn(() => Promise.resolve(['origin/main']));

    await expect(
      resolveSharedContainerPushedBase(
        { projectId: 'p', worktreeId: 'w', repoId: 'r', repoPath: '/repo' },
        {
          getHead: () => Promise.resolve(null),
          resolveBaseBranch: () => Promise.resolve({ branch: 'main' }),
          listCandidates,
          mergeBase: () => Promise.resolve(null),
          countCommits: () => Promise.resolve(0),
          getRemoteUrl: () => Promise.resolve(null),
          resolveToken: () => Promise.resolve(''),
          probeCommit: () => Promise.resolve(),
        },
      ),
    ).resolves.toBeNull();
    expect(listCandidates).not.toHaveBeenCalled();
  });
});

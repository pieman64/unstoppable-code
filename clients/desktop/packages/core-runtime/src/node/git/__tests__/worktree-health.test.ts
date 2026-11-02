import { join, resolve } from 'node:path';
import {
  inspectWorktreeHealth,
  type WorktreeHealthPathKind,
  type WorktreeHealthRepoEntry,
  type WorktreeHealthSources,
  type WorktreeHealthWorkspace,
} from '../worktree-health';

const ROOT = resolve('/worktrees/wt-1');
const NOW = new Date('2026-10-27T12:00:00.000Z');
const ANY_STRING: unknown = expect.any(String);

type Node = 'dir' | 'file' | 'link';

const kind = (node: Node): WorktreeHealthPathKind => ({
  isDirectory: () => node === 'dir',
  isFile: () => node === 'file',
});

interface Fixture {
  workspace?: Partial<WorktreeHealthWorkspace>;
  nodes?: Record<string, Node>;
  /** `.git` file contents by checkout path. */
  dotGit?: Record<string, string>;
  /** Git's answer by checkout path; an Error rejects. */
  git?: Record<string, string | Error>;
  entries?: WorktreeHealthRepoEntry[];
  includedRepoIds?: readonly string[] | Error;
}

/** Sources over a virtual tree that log every read in order. */
function sources(fixture: Fixture): {
  sources: WorktreeHealthSources;
  reads: string[];
} {
  const reads: string[] = [];
  const nodes = fixture.nodes ?? {};
  const lookup = (path: string): Promise<WorktreeHealthPathKind> => {
    const node = nodes[path];
    return node
      ? Promise.resolve(kind(node))
      : Promise.reject(new Error(`ENOENT ${path}`));
  };
  return {
    reads,
    sources: {
      worktreePath: ROOT,
      readWorkspace: (): Promise<WorktreeHealthWorkspace> => {
        reads.push('workspace');
        return Promise.resolve({
          type: 'multi-repo',
          repos: [],
          hasSourceRepository: false,
          ...fixture.workspace,
        });
      },
      listRepositoryEntries: (): Promise<WorktreeHealthRepoEntry[]> => {
        reads.push('entries');
        return Promise.resolve(fixture.entries ?? []);
      },
      readIncludedRepoIds: (): Promise<readonly string[] | undefined> => {
        reads.push('included');
        const included = fixture.includedRepoIds;
        return included instanceof Error
          ? Promise.reject(included)
          : Promise.resolve(included);
      },
      stat: (path: string): Promise<WorktreeHealthPathKind> => {
        reads.push(`stat ${path}`);
        // stat follows a link to the directory it names.
        return nodes[path] === 'link'
          ? Promise.resolve(kind('dir'))
          : lookup(path);
      },
      lstat: (path: string): Promise<WorktreeHealthPathKind> => {
        reads.push(`lstat ${path}`);
        return lookup(path);
      },
      readText: (path: string): Promise<string> => {
        reads.push(`read ${path}`);
        const contents = fixture.dotGit?.[join(path, '..')];
        return contents === undefined
          ? Promise.reject(new Error('EISDIR'))
          : Promise.resolve(contents);
      },
      confirmWorkTree: (path: string): Promise<string> => {
        reads.push(`git ${path}`);
        const answer = fixture.git?.[path] ?? 'true\n';
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer);
      },
      now: () => NOW,
    },
  };
}

const single = { type: 'single-repo' };
const dotGit = (path: string): string => join(path, '.git');

describe('inspectWorktreeHealth: single-repository worktrees', () => {
  it('confirms a .git file whose target exists with Git', async () => {
    const admin = resolve('/repo/.git/worktrees/wt-1');
    const { sources: s, reads } = sources({
      workspace: single,
      nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'file', [admin]: 'dir' },
      dotGit: { [ROOT]: `gitdir: ${admin}\n` },
    });
    await expect(inspectWorktreeHealth(s)).resolves.toBeNull();
    expect(reads).toEqual([
      'workspace',
      `stat ${ROOT}`,
      `lstat ${dotGit(ROOT)}`,
      `read ${dotGit(ROOT)}`,
      `stat ${admin}`,
      `git ${ROOT}`,
    ]);
  });

  it.each([
    ['a missing checkout', {}, 'missing-worktree-path', undefined],
    [
      'a file instead of a directory',
      { nodes: { [ROOT]: 'file' } },
      'missing-worktree-path',
      undefined,
    ],
    [
      'no .git',
      { nodes: { [ROOT]: 'dir' } },
      'missing-git-metadata',
      undefined,
    ],
    [
      'a .git file without a pointer',
      {
        nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'file' },
        dotGit: { [ROOT]: 'nothing here\n' },
      },
      'invalid-git-worktree',
      undefined,
    ],
    [
      'an unreadable .git file',
      { nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'file' } },
      'invalid-git-worktree',
      undefined,
    ],
    [
      'a relative pointer to a missing target',
      {
        nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'file' },
        dotGit: { [ROOT]: 'gitdir: ../admin\n' },
      },
      'invalid-git-worktree',
      `Missing gitdir target: ${resolve(ROOT, '../admin')}`,
    ],
    [
      'Git answering false for a .git directory',
      {
        nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'dir' },
        git: { [ROOT]: 'false\n' },
      },
      'invalid-git-worktree',
      undefined,
    ],
    [
      'Git failing for a .git link',
      {
        nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'link' },
        git: { [ROOT]: new Error('fatal: not a git repository') },
      },
      'git-error',
      'fatal: not a git repository',
    ],
  ] satisfies Array<[string, Fixture, string, string | undefined]>)(
    'reports %s',
    async (_name, fixture, code, gitError) => {
      const issue = await inspectWorktreeHealth(
        sources({ ...fixture, workspace: single }).sources,
      );
      expect(issue).toEqual({
        status: 'broken',
        code,
        message: ANY_STRING,
        checkedAt: NOW.toISOString(),
        worktreePath: ROOT,
        gitError,
        repoIssues: undefined,
      });
      // The legacy response carries both keys even when they are undefined.
      expect(Object.keys(issue ?? {})).toEqual([
        'status',
        'code',
        'message',
        'checkedAt',
        'worktreePath',
        'gitError',
        'repoIssues',
      ]);
    },
  );

  it('reports a Git rejection that is not an Error as text', async () => {
    const { sources: s } = sources({
      workspace: single,
      nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'dir' },
    });
    await expect(
      inspectWorktreeHealth({
        ...s,
        confirmWorkTree: (): Promise<string> =>
          // A port may reject with a non-Error value.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject('timed out'),
      }),
    ).resolves.toMatchObject({ code: 'git-error', gitError: 'timed out' });
  });

  it('lets Git decide when the pointer names a file', async () => {
    const target = resolve('/admin/file');
    const { sources: s } = sources({
      workspace: single,
      nodes: { [ROOT]: 'dir', [dotGit(ROOT)]: 'file', [target]: 'file' },
      dotGit: { [ROOT]: `gitdir: ${target}` },
      git: { [ROOT]: new Error('fatal: bad gitdir') },
    });
    // The confirmation's error replaces the invalid-target detail.
    await expect(inspectWorktreeHealth(s)).resolves.toMatchObject({
      code: 'git-error',
      gitError: 'fatal: bad gitdir',
    });
  });

  it('propagates a workspace read failure', async () => {
    const failing = sources({}).sources;
    await expect(
      inspectWorktreeHealth({
        ...failing,
        readWorkspace: () => Promise.reject(new Error('unreadable')),
      }),
    ).rejects.toThrow('unreadable');
  });
});

describe('inspectWorktreeHealth: multi-repository worktrees', () => {
  const repo = (repoId: string): WorktreeHealthRepoEntry => ({
    repoId,
    repoName: repoId.toUpperCase(),
    repoPath: join(ROOT, 'repos', repoId),
  });
  const healthy = (path: string): Record<string, Node> => ({
    [path]: 'dir',
    [dotGit(path)]: 'dir',
  });
  const workspace = {
    type: 'multi-repo',
    repos: [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: '' },
    ],
  };

  it('reports a missing root without reading repositories', async () => {
    const { sources: s, reads } = sources({ workspace });
    await expect(inspectWorktreeHealth(s)).resolves.toMatchObject({
      code: 'missing-worktree-path',
      repoIssues: undefined,
    });
    expect(reads).toEqual(['workspace', `stat ${ROOT}`]);
  });

  it('orders missing, present and root issues and names the missing by id', async () => {
    const { sources: s } = sources({
      workspace: { ...workspace, hasSourceRepository: true },
      nodes: { [ROOT]: 'dir', [repo('notes').repoPath]: 'dir' },
      entries: [
        { ...repo('__workspace_root__'), repoPath: ROOT },
        repo('notes'),
      ],
    });
    const issue = await inspectWorktreeHealth(s);
    expect(issue?.code).toBe('missing-repository');
    expect(issue?.gitError).toBeUndefined();
    expect(issue?.repoIssues).toEqual([
      {
        repoId: 'alpha',
        repoName: 'Alpha',
        repoPath: join(ROOT, 'repos', 'alpha'),
        code: 'missing-repository',
        message: 'Repository directory is missing from this worktree.',
      },
      {
        repoId: 'beta',
        repoName: 'beta',
        repoPath: join(ROOT, 'repos', 'beta'),
        code: 'missing-repository',
        message: 'Repository directory is missing from this worktree.',
      },
      {
        repoId: 'notes',
        repoName: 'NOTES',
        repoPath: repo('notes').repoPath,
        code: 'missing-git-metadata',
        message: 'Git metadata is missing for this worktree.',
        gitError: undefined,
      },
      {
        repoId: '__workspace_root__',
        repoName: 'Project root',
        repoPath: ROOT,
        code: 'missing-git-metadata',
        message: 'Git metadata is missing for this worktree.',
        gitError: undefined,
      },
    ]);
    // A missing repository has no gitError key at all.
    expect(Object.keys(issue?.repoIssues?.[0] ?? {})).not.toContain('gitError');
  });

  it('checks only included repositories and skips payload directories', async () => {
    const { sources: s, reads } = sources({
      workspace,
      nodes: { [ROOT]: 'dir', ...healthy(repo('alpha').repoPath) },
      entries: [repo('alpha'), repo('notes')],
      includedRepoIds: ['alpha'],
    });
    await expect(inspectWorktreeHealth(s)).resolves.toBeNull();
    expect(reads.some((read) => read.includes('notes'))).toBe(false);
  });

  it('treats an unreadable worktree list as untracked', async () => {
    const { sources: s } = sources({
      workspace,
      nodes: {
        [ROOT]: 'dir',
        ...healthy(repo('alpha').repoPath),
        ...healthy(repo('beta').repoPath),
        [repo('notes').repoPath]: 'dir',
      },
      entries: [repo('alpha'), repo('beta'), repo('notes')],
      includedRepoIds: new Error('locked'),
    });
    await expect(inspectWorktreeHealth(s)).resolves.toMatchObject({
      code: 'missing-git-metadata',
      repoIssues: [{ repoId: 'notes' }],
    });
  });

  it('carries the only issue’s Git error and the first code of several', async () => {
    const broken = sources({
      workspace: { type: 'multi-repo', repos: [] },
      nodes: {
        [ROOT]: 'dir',
        [repo('alpha').repoPath]: 'dir',
        [dotGit(repo('alpha').repoPath)]: 'dir',
      },
      entries: [repo('alpha')],
      git: { [repo('alpha').repoPath]: new Error('fatal: broken') },
    }).sources;
    await expect(inspectWorktreeHealth(broken)).resolves.toMatchObject({
      code: 'git-error',
      gitError: 'fatal: broken',
    });
    const several = sources({
      workspace: { type: 'multi-repo', repos: [], hasSourceRepository: true },
      nodes: {
        [ROOT]: 'dir',
        [repo('alpha').repoPath]: 'dir',
        [dotGit(repo('alpha').repoPath)]: 'dir',
      },
      entries: [repo('alpha')],
      git: { [repo('alpha').repoPath]: new Error('fatal: broken') },
    }).sources;
    const issue = await inspectWorktreeHealth(several);
    expect(issue).toMatchObject({ code: 'git-error', gitError: undefined });
    expect(issue?.repoIssues?.map(({ code }) => code)).toEqual([
      'git-error',
      'missing-git-metadata',
    ]);
  });

  it('never validates the root of a workspace without a source repository', async () => {
    const { sources: s, reads } = sources({
      workspace: { type: 'cowork', repos: [] },
      nodes: { [ROOT]: 'dir' },
      entries: [{ ...repo('__workspace_root__'), repoPath: ROOT }],
    });
    await expect(inspectWorktreeHealth(s)).resolves.toBeNull();
    expect(reads).toEqual(['workspace', `stat ${ROOT}`, 'entries', 'included']);
  });
});

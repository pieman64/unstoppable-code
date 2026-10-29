jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve('git'),
}));

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertGitMetadataSelfContained,
  classifyUnmanagedWorktreeRepository,
  listUnmanagedWorktreeRepositories,
} from '../lib/unmanaged-worktree-repository';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('unmanaged workspace repository classification', () => {
  let root: string;
  let source: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'unmanaged-repo-')));
    source = join(root, 'source');
    mkdirSync(source);
    git(source, 'init', '-b', 'main');
    git(
      source,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'Initial',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps a temporary clone out of Git worktree removal', async () => {
    const clone = join(root, 'extra');
    git(root, 'clone', source, clone);
    await expect(classifyUnmanagedWorktreeRepository(clone)).resolves.toEqual({
      kind: 'standalone-clone',
    });
  });

  it('does not classify an ordinary directory using ancestor Git metadata', async () => {
    const folder = join(source, 'repos', 'notes');
    mkdirSync(folder, { recursive: true });
    await expect(classifyUnmanagedWorktreeRepository(folder)).resolves.toEqual({
      kind: 'directory',
    });
  });

  it('does not mistake bare-looking ordinary files for ancestor Git metadata', async () => {
    const folder = join(source, 'repos', 'notes');
    mkdirSync(join(folder, 'objects'), { recursive: true });
    writeFileSync(join(folder, 'HEAD'), 'ordinary note');
    await expect(classifyUnmanagedWorktreeRepository(folder)).resolves.toEqual({
      kind: 'directory',
    });
  });

  it('preserves the source repository for a linked worktree', async () => {
    const linked = join(root, 'linked');
    git(source, 'worktree', 'add', '-b', 'linked', linked);
    await expect(classifyUnmanagedWorktreeRepository(linked)).resolves.toEqual({
      kind: 'linked-worktree',
      referenceRepoPath: source,
    });
  });

  it('resolves a moved linked worktree before its registration is repaired', async () => {
    const linked = join(root, 'linked');
    const quarantined = join(root, 'quarantined');
    git(source, 'worktree', 'add', '-b', 'linked', linked);
    renameSync(linked, quarantined);
    await expect(
      classifyUnmanagedWorktreeRepository(quarantined),
    ).resolves.toEqual({ kind: 'linked-worktree', referenceRepoPath: source });
  });

  it('supports a linked worktree whose source repository is bare', async () => {
    const bare = join(root, 'bare.git');
    const linked = join(root, 'linked');
    git(root, 'clone', '--bare', source, bare);
    git(bare, 'worktree', 'add', '-b', 'linked', linked);
    await expect(classifyUnmanagedWorktreeRepository(linked)).resolves.toEqual({
      kind: 'linked-worktree',
      referenceRepoPath: bare,
    });
  });

  it('retains a self-contained bare repository as standalone payload', async () => {
    const bare = join(root, 'extra.git');
    git(root, 'clone', '--bare', '--no-hardlinks', source, bare);
    await expect(classifyUnmanagedWorktreeRepository(bare)).resolves.toEqual({
      kind: 'standalone-clone',
    });
  });

  it('preserves a bare repository that owns an external checkout', async () => {
    const bare = join(root, 'extra.git');
    const external = join(root, 'external');
    git(root, 'clone', '--bare', '--no-hardlinks', source, bare);
    git(bare, 'worktree', 'add', '-b', 'external', external);
    await expect(classifyUnmanagedWorktreeRepository(bare)).rejects.toThrow(
      'owns linked worktrees',
    );
    expect(git(external, 'rev-parse', 'HEAD')).toBe(
      git(source, 'rev-parse', 'HEAD'),
    );
  });

  it.each(['refs', 'packed-refs', 'modules', 'objects/pack'])(
    'rejects external metadata links at .git/%s',
    async (metadataEntry) => {
      const clone = join(root, 'extra');
      git(root, 'clone', '--no-hardlinks', source, clone);
      if (metadataEntry === 'modules') {
        git(
          clone,
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          source,
          'child',
        );
      }
      if (metadataEntry === 'objects/pack') git(clone, 'repack', '-ad');
      if (metadataEntry === 'packed-refs') git(clone, 'pack-refs', '--all');
      const metadata = join(clone, '.git', metadataEntry);
      const external = join(root, 'external-metadata');
      renameSync(metadata, external);
      symlinkSync(external, metadata, 'junction');
      expect(git(clone, 'cat-file', '-p', 'HEAD')).toBe(
        git(source, 'cat-file', '-p', 'HEAD'),
      );
      await expect(classifyUnmanagedWorktreeRepository(clone)).rejects.toThrow(
        'linked Git metadata',
      );
      expect(existsSync(external)).toBe(true);
    },
  );

  it('retains a self-contained submodule metadata closure', async () => {
    const clone = join(root, 'extra');
    git(root, 'clone', '--no-hardlinks', source, clone);
    git(
      clone,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      source,
      'child',
    );
    await expect(classifyUnmanagedWorktreeRepository(clone)).resolves.toEqual({
      kind: 'standalone-clone',
    });
  });

  it.each(['alternates', 'commondir', 'owned-worktree'])(
    'rejects a submodule with external %s metadata dependencies',
    async (dependency) => {
      const clone = join(root, 'extra');
      git(root, 'clone', '--no-hardlinks', source, clone);
      git(
        clone,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        source,
        'child',
      );
      const child = join(clone, 'child');
      const childMetadata = git(child, 'rev-parse', '--absolute-git-dir');
      const external = join(root, 'external-submodule-worktree');
      if (dependency === 'alternates') {
        writeFileSync(
          join(childMetadata, 'objects', 'info', 'alternates'),
          join(source, '.git', 'objects') + '\n',
        );
      } else if (dependency === 'commondir') {
        writeFileSync(
          join(childMetadata, 'commondir'),
          join(source, '.git') + '\n',
        );
      } else {
        git(child, 'worktree', 'add', '-b', 'external-module', external);
      }
      expect(git(child, 'cat-file', '-p', 'HEAD')).toBe(
        git(source, 'cat-file', '-p', 'HEAD'),
      );
      await expect(classifyUnmanagedWorktreeRepository(clone)).rejects.toThrow(
        /external Git|owns linked worktrees/,
      );
      if (dependency === 'owned-worktree') {
        expect(git(external, 'rev-parse', 'HEAD')).toBe(
          git(source, 'rev-parse', 'HEAD'),
        );
      }
    },
  );

  it('uses retained metadata roots when a partially deleted submodule owns an external checkout', async () => {
    const clone = join(root, 'extra');
    git(root, 'clone', '--no-hardlinks', source, clone);
    git(
      clone,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      source,
      'child',
    );
    const child = join(clone, 'child');
    const childMetadata = git(child, 'rev-parse', '--absolute-git-dir');
    const retainedMetadata = join(root, 'retained-metadata');
    cpSync(join(clone, '.git'), retainedMetadata, { recursive: true });
    git(
      child,
      'worktree',
      'add',
      '-b',
      'external-module',
      join(root, 'external'),
    );
    rmSync(join(childMetadata, 'HEAD'));
    rmSync(join(childMetadata, 'objects'), { recursive: true });
    await expect(
      assertGitMetadataSelfContained(join(clone, '.git'), retainedMetadata),
    ).rejects.toThrow('owns linked worktrees');
    expect(
      existsSync(join(childMetadata, 'worktrees', 'external', 'gitdir')),
    ).toBe(true);
  });

  it('preserves clones that own another checkout', async () => {
    const clone = join(root, 'extra');
    const external = join(root, 'external');
    git(root, 'clone', source, clone);
    git(clone, 'worktree', 'add', '-b', 'external', external);
    await expect(classifyUnmanagedWorktreeRepository(clone)).rejects.toThrow(
      'owns linked worktrees',
    );
    expect(git(external, 'rev-parse', 'HEAD')).toBe(
      git(clone, 'rev-parse', 'HEAD'),
    );
  });

  it('does not follow a repository directory symlink', async () => {
    const linked = join(root, 'linked');
    symlinkSync(source, linked, 'junction');
    await expect(classifyUnmanagedWorktreeRepository(linked)).resolves.toEqual({
      kind: 'directory',
    });
    expect(existsSync(join(source, '.git'))).toBe(true);
  });

  it('rejects a clone that links to external Git metadata', async () => {
    const clone = join(root, 'extra');
    const gitMetadata = join(root, 'external.git');
    git(root, 'clone', source, clone);
    renameSync(join(clone, '.git'), gitMetadata);
    symlinkSync(gitMetadata, join(clone, '.git'), 'junction');
    await expect(classifyUnmanagedWorktreeRepository(clone)).rejects.toThrow(
      'linked Git metadata',
    );
    expect(existsSync(gitMetadata)).toBe(true);
  });

  it('rejects a main checkout using a separate Git directory', async () => {
    const clone = join(root, 'extra');
    const gitMetadata = join(root, 'external.git');
    git(root, 'clone', '--separate-git-dir', gitMetadata, source, clone);
    await expect(classifyUnmanagedWorktreeRepository(clone)).rejects.toThrow(
      'external Git metadata',
    );
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(
      git(source, 'rev-parse', 'HEAD'),
    );
  });

  it('preserves a shared clone that depends on external Git objects', async () => {
    const clone = join(root, 'shared-clone');
    git(root, 'clone', '--shared', source, clone);
    await expect(classifyUnmanagedWorktreeRepository(clone)).rejects.toThrow(
      'external Git objects',
    );
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(
      git(source, 'rev-parse', 'HEAD'),
    );
  });

  it('preserves a clone whose object directory is an external symlink', async () => {
    const clone = join(root, 'extra');
    const externalObjects = join(root, 'external-objects');
    git(root, 'clone', source, clone);
    renameSync(join(clone, '.git', 'objects'), externalObjects);
    symlinkSync(externalObjects, join(clone, '.git', 'objects'), 'junction');
    await expect(classifyUnmanagedWorktreeRepository(clone)).rejects.toThrow(
      'external Git objects',
    );
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(
      git(source, 'rev-parse', 'HEAD'),
    );
  });

  it('rejects a repos directory pointing outside the worktree', async () => {
    const worktree = join(root, 'worktree');
    const external = join(root, 'external');
    mkdirSync(worktree);
    mkdirSync(external);
    git(root, 'clone', source, join(external, 'extra'));
    symlinkSync(external, join(worktree, 'repos'), 'junction');
    await expect(
      listUnmanagedWorktreeRepositories(worktree, []),
    ).rejects.toThrow('outside');
    expect(git(join(external, 'extra'), 'rev-parse', 'HEAD')).toBe(
      git(source, 'rev-parse', 'HEAD'),
    );
  });

  it('lists only direct unmanaged directories without following child symlinks', async () => {
    const worktree = join(root, 'worktree');
    const repos = join(worktree, 'repos');
    mkdirSync(join(repos, 'notes'), { recursive: true });
    git(root, 'clone', source, join(repos, 'extra'));
    git(source, 'worktree', 'add', '-b', 'linked', join(repos, 'linked'));
    mkdirSync(join(repos, 'managed'));
    symlinkSync(source, join(repos, 'external-link'), 'junction');
    const entries = await listUnmanagedWorktreeRepositories(worktree, [
      'managed',
    ]);
    expect(
      entries
        .map((entry) => ({ repoId: entry.repoId, kind: entry.repository.kind }))
        .sort((a, b) => a.repoId.localeCompare(b.repoId)),
    ).toEqual([
      { repoId: 'extra', kind: 'standalone-clone' },
      { repoId: 'linked', kind: 'linked-worktree' },
      { repoId: 'notes', kind: 'directory' },
    ]);
    expect(existsSync(join(source, '.git'))).toBe(true);
  });

  it('returns an empty inventory when the worktree or repos directory is absent', async () => {
    await expect(
      listUnmanagedWorktreeRepositories(join(root, 'missing'), []),
    ).resolves.toEqual([]);
    await expect(
      listUnmanagedWorktreeRepositories(source, []),
    ).resolves.toEqual([]);
  });

  it('rejects a symlinked worktree root without inspecting external repositories', async () => {
    const worktree = join(root, 'worktree');
    symlinkSync(source, worktree, 'junction');
    await expect(
      listUnmanagedWorktreeRepositories(worktree, []),
    ).rejects.toThrow('symbolic link');
    expect(existsSync(join(source, '.git'))).toBe(true);
  });
});

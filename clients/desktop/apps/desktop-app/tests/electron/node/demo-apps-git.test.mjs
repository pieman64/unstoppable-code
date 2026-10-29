import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createInitialCommit,
  createWorktree,
  initRepo,
} from '../../../../../demo-apps/lib/git.mjs';

const REPOSITORY_ENV_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

function git(cwd, args) {
  const env = { ...process.env };
  for (const key of REPOSITORY_ENV_KEYS) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

function localConfig(repo, key) {
  try {
    return git(repo, ['config', '--local', '--get', key]);
  } catch {
    return null;
  }
}

function createOuterRepository(root) {
  const outer = path.join(root, 'outer');
  mkdirSync(outer, { recursive: true });
  git(outer, ['init', '-q']);
  git(outer, ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
  writeFileSync(path.join(outer, 'README.md'), 'outer\n');
  git(outer, ['add', 'README.md']);
  git(outer, [
    '-c',
    'user.name=Outer Owner',
    '-c',
    'user.email=outer@example.invalid',
    'commit',
    '-q',
    '-m',
    'outer',
  ]);
  return outer;
}

function withEnv(overrides, run) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('demo seeding ignores an inherited GIT_DIR and never configures the caller repository', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'demo-apps-git-env-'));
  try {
    const outer = createOuterRepository(root);
    const outerHead = git(outer, ['rev-parse', 'HEAD']);
    const demo = path.join(root, 'fixtures', 'demo-app');
    mkdirSync(demo, { recursive: true });
    writeFileSync(path.join(demo, 'index.js'), 'export {};\n');

    // Git exports these to hooks; a test run from a hook inherits them.
    await withEnv(
      {
        GIT_DIR: path.join(outer, '.git'),
        GIT_WORK_TREE: outer,
        GIT_INDEX_FILE: path.join(outer, '.git', 'index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.worktree',
        GIT_CONFIG_VALUE_0: outer,
      },
      async () => {
        await createWorktree({
          repoPath: demo,
          worktreePath: path.join(root, 'worktrees', 'demo-main'),
          branchName: 'demo-main',
        });
      },
    );

    assert.equal(localConfig(outer, 'user.name'), null);
    assert.equal(localConfig(outer, 'user.email'), null);
    assert.equal(git(outer, ['symbolic-ref', 'HEAD']), 'refs/heads/develop');
    assert.equal(git(outer, ['rev-parse', 'HEAD']), outerHead);
    assert.equal(
      git(outer, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)
        ?.length,
      1,
    );

    assert.equal(
      realpathSync(git(demo, ['rev-parse', '--absolute-git-dir'])),
      realpathSync(path.join(demo, '.git')),
    );
    assert.equal(localConfig(demo, 'user.name'), 'Canopy Demo');
    assert.equal(
      git(demo, ['log', '-1', '--format=%s']),
      'Initial demo app import',
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

test('demo seeding refuses a path whose Git directory belongs to another repository', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'demo-apps-git-owner-'));
  try {
    const outer = createOuterRepository(root);
    const linked = path.join(root, 'linked');
    git(outer, ['worktree', 'add', '-q', '-b', 'linked', linked]);

    await assert.rejects(initRepo(linked), /not its own Git repository/);
    await assert.rejects(
      createInitialCommit(linked),
      /not its own Git repository/,
    );
    assert.equal(localConfig(outer, 'user.name'), null);
    assert.equal(localConfig(outer, 'user.email'), null);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

test('demo seeding refuses a symlinked Git directory without changing its target', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'demo-apps-git-symlink-'));
  try {
    const outer = createOuterRepository(root);
    const outerHead = git(outer, ['rev-parse', 'HEAD']);
    const demo = path.join(root, 'demo');
    mkdirSync(demo);
    writeFileSync(path.join(demo, 'index.js'), 'export {};\n');
    symlinkSync(path.join(outer, '.git'), path.join(demo, '.git'), 'dir');

    await assert.rejects(initRepo(demo), /not its own Git repository/);
    await assert.rejects(
      createInitialCommit(demo),
      /not its own Git repository/,
    );
    assert.equal(localConfig(outer, 'user.name'), null);
    assert.equal(localConfig(outer, 'user.email'), null);
    assert.equal(git(outer, ['rev-parse', 'HEAD']), outerHead);
    assert.equal(git(outer, ['status', '--porcelain']), '');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});

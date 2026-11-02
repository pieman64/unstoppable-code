// CAN-5516 goldens: the desktop branch-delete helpers over a real repository,
// captured on unchanged code before they ran the shared policy behind
// `worker.git.branch.delete`. Their lifecycle callers stay with CAN-4098.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.unmock('../lib/git');

import {
  deleteBranch,
  deleteBranchIfMatches,
  forceDeleteBranch,
} from '../lib/git';

let dir: string;
let repo: string;
let linked: string;
let originalGitEnv: [string, string | undefined][] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function commit(file: string): void {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', file]);
}

function hasBranch(branch: string): boolean {
  try {
    git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  // User config and hook-inherited GIT_DIR would change the fixture; the
  // helpers' Git inherits process.env.
  originalGitEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('GIT_'),
  );
  for (const [key] of originalGitEnv) delete process.env[key];
});

afterAll(() => {
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_CONFIG_GLOBAL;
  for (const [key, value] of originalGitEnv) process.env[key] = value;
});

// A repository on `main` with `merged` (at main), `unmerged` (one commit
// ahead) and `held` checked out in a linked worktree.
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-branch-delete-')));
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'delete@example.com']);
  git(repo, ['config', 'user.name', 'Delete']);
  commit('README.md');
  git(repo, ['branch', 'merged']);
  git(repo, ['checkout', '-q', '-b', 'unmerged']);
  commit('ahead.md');
  git(repo, ['checkout', '-q', 'main']);
  linked = join(dir, 'linked');
  git(repo, ['worktree', 'add', '-q', '-b', 'held', linked]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deleteBranch (branch -d)', () => {
  it('deletes a merged branch', async () => {
    await expect(deleteBranch(repo, 'merged')).resolves.toBeUndefined();
    expect(hasBranch('merged')).toBe(false);
  });

  it("surfaces Git's refusal of an unmerged branch and keeps it", async () => {
    await expect(deleteBranch(repo, 'unmerged')).rejects.toThrow(
      /not fully merged/,
    );
    expect(hasBranch('unmerged')).toBe(true);
  });

  it("surfaces Git's refusal of a branch a worktree has checked out", async () => {
    await expect(deleteBranch(repo, 'held')).rejects.toThrow(/held/);
    expect(hasBranch('held')).toBe(true);
  });

  it("surfaces Git's error for a missing branch", async () => {
    await expect(deleteBranch(repo, 'missing')).rejects.toThrow(/not found/);
  });
});

describe('forceDeleteBranch (branch -D)', () => {
  it('deletes an unmerged branch', async () => {
    await expect(forceDeleteBranch(repo, 'unmerged')).resolves.toBeUndefined();
    expect(hasBranch('unmerged')).toBe(false);
  });

  it("surfaces Git's refusal of a branch a worktree has checked out", async () => {
    await expect(forceDeleteBranch(repo, 'held')).rejects.toThrow(/held/);
    expect(hasBranch('held')).toBe(true);
  });
});

describe('deleteBranchIfMatches (update-ref -d)', () => {
  it('deletes an unmerged branch still at the expected tip', async () => {
    const tip = git(repo, ['rev-parse', 'refs/heads/unmerged']);
    await expect(
      deleteBranchIfMatches(repo, 'unmerged', tip),
    ).resolves.toBeUndefined();
    expect(hasBranch('unmerged')).toBe(false);
  });

  it("surfaces Git's refusal when the branch moved, and keeps it", async () => {
    const stale = git(repo, ['rev-parse', 'refs/heads/main']);
    await expect(
      deleteBranchIfMatches(repo, 'unmerged', stale),
    ).rejects.toThrow(/unmerged/);
    expect(hasBranch('unmerged')).toBe(true);
  });

  it('refuses a branch a linked worktree has checked out, naming its path', async () => {
    const tip = git(repo, ['rev-parse', 'refs/heads/held']);
    await expect(deleteBranchIfMatches(repo, 'held', tip)).rejects.toThrow(
      new Error(
        `Cannot delete branch "held" because it is checked out at ${linked}`,
      ),
    );
    expect(hasBranch('held')).toBe(true);
  });

  it('refuses the branch the main worktree has checked out', async () => {
    const tip = git(repo, ['rev-parse', 'refs/heads/main']);
    await expect(deleteBranchIfMatches(repo, 'main', tip)).rejects.toThrow(
      new Error(
        `Cannot delete branch "main" because it is checked out at ${repo}`,
      ),
    );
    expect(hasBranch('main')).toBe(true);
  });

  it('runs from a linked worktree against the shared refs', async () => {
    const tip = git(repo, ['rev-parse', 'refs/heads/merged']);
    await expect(
      deleteBranchIfMatches(linked, 'merged', tip),
    ).resolves.toBeUndefined();
    expect(hasBranch('merged')).toBe(false);
  });
});

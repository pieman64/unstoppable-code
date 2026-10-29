import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  WORKTREE_GIT_GATE_PATH,
  installWorktreeGitGate,
} from './worktree-git-gate.mjs';

const posixOnly = process.platform === 'win32' ? test.skip : test;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixtureRepo(root) {
  const repoPath = path.join(root, 'repo');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.name', 'Perf Test']);
  git(repoPath, ['config', 'user.email', 'perf@example.invalid']);
  writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
  return repoPath;
}

/** Runs `git worktree add` the way the app does, without awaiting it. */
function addWorktree(repoPath, worktreePath, branch) {
  const child = spawn(
    'git',
    [
      '-c',
      `core.hooksPath=${os.devNull}`,
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      'main',
    ],
    { cwd: repoPath, stdio: 'ignore' },
  );
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error('condition not met');
}

posixOnly(
  'the worktree Git gate holds an app worktree checkout until it is released',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-perf-gate-'));
    try {
      const repoPath = fixtureRepo(root);
      // A space in the gate path must survive Git's shell parsing of the
      // filter command.
      const gate = installWorktreeGitGate(repoPath, {
        gateDir: path.join(root, 'gate dir'),
        maxHoldMs: 30_000,
      });
      const worktreePath = path.join(
        root,
        'data/workspaces/demo/worktrees/otter',
      );

      let settled = false;
      const done = addWorktree(repoPath, worktreePath, 'otter-1').then(
        (code) => {
          settled = true;
          return code;
        },
      );
      await gate.waitForEntered('otter', { timeoutMs: 10_000 });
      await delay(300);
      assert.equal(settled, false, 'checkout finished while the gate was held');

      gate.release('otter');
      assert.equal(await done, 0);
      assert.equal(
        readFileSync(path.join(worktreePath, WORKTREE_GIT_GATE_PATH), 'utf8'),
        readFileSync(path.join(repoPath, WORKTREE_GIT_GATE_PATH), 'utf8'),
      );
      assert.equal(git(worktreePath, ['status', '--porcelain']), '');
      assert.deepEqual(gate.expiredIds(), []);
      assert.ok(gate.heldMs('otter') >= 300);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

posixOnly(
  'the worktree Git gate passes other checkouts through and marks an expired hold',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-perf-gate-'));
    try {
      const repoPath = fixtureRepo(root);
      const gate = installWorktreeGitGate(repoPath, {
        gateDir: path.join(root, 'gate'),
        maxHoldMs: 200,
      });

      assert.equal(
        await addWorktree(repoPath, path.join(root, 'elsewhere'), 'other'),
        0,
      );
      assert.equal(
        existsSync(path.join(root, 'gate', 'entered.elsewhere')),
        false,
      );

      const held = addWorktree(
        repoPath,
        path.join(root, 'data/workspaces/demo/worktrees/heron'),
        'heron-1',
      );
      assert.equal(await held, 0);
      assert.deepEqual(gate.expiredIds(), ['heron']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

posixOnly(
  'waitForEntered reports a checkout that never reaches the gate',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-perf-gate-'));
    try {
      const gate = installWorktreeGitGate(fixtureRepo(root), {
        gateDir: path.join(root, 'gate'),
        maxHoldMs: 1_000,
      });
      await assert.rejects(
        gate.waitForEntered('ghost', { timeoutMs: 100 }),
        /Worktree ghost Git checkout never reached the performance gate/,
      );
      gate.releaseAll();
      await waitFor(() => existsSync(path.join(root, 'gate', 'release.all')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

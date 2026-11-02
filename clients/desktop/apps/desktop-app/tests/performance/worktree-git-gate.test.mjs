import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  WORKTREE_GIT_GATE_PATH,
  WORKTREE_GIT_GATE_TAIL_PATH,
  assertGateCheckoutOrder,
  checkoutWritesTailLast,
  installWorktreeGitGate,
  readCheckoutGitConfig,
  selectCheckoutProcesses,
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

      assert.equal(
        existsSync(path.join(root, 'gate dir', 'written.otter')),
        false,
        'the tail file was written while the gate held the checkout',
      );
      const releasedAt = Date.now();
      gate.release('otter');
      assert.equal(await done, 0);
      const doneAt = Date.now();
      for (const tracked of [
        WORKTREE_GIT_GATE_PATH,
        WORKTREE_GIT_GATE_TAIL_PATH,
      ]) {
        assert.equal(
          readFileSync(path.join(worktreePath, tracked), 'utf8'),
          readFileSync(path.join(repoPath, tracked), 'utf8'),
        );
      }
      assert.equal(git(worktreePath, ['status', '--porcelain']), '');
      assert.deepEqual(gate.expiredIds(), []);
      assert.equal(gate.holdExpired('otter'), false);
      assert.ok(gate.heldMs('otter') >= 300);
      assert.ok(Number.isFinite(gate.enteredAtMs('otter')));
      assert.ok(Number.isFinite(gate.writtenAtMs('otter')));
      const resumedMs = gate.resumedAfterReleaseMs('otter');
      assert.ok(resumedMs >= 0, `resumed ${resumedMs}ms after release`);
      // The scenario subtracts the resume stamp from the renderer's
      // Date.now(), so the marker must fall on that clock between release
      // and exit. 10 ms covers Linux's tick-granular file times.
      const resumedAt = gate.resumedAtMs('otter');
      assert.ok(
        resumedAt >= releasedAt - 10 && resumedAt <= doneAt + 1,
        `resume stamp ${resumedAt} outside [${releasedAt}, ${doneAt}]`,
      );
      // Two small files: the installed filters start without the first-run
      // executable assessment macOS adds to a new script.
      const writtenMs = gate.checkoutWrittenAfterResumeMs('otter');
      assert.ok(
        writtenMs >= 0 && writtenMs < 100,
        `Git reached the tail ${writtenMs}ms after resuming`,
      );
      assert.equal(writtenMs, gate.writtenAtMs('otter') - resumedAt);
      // Each filter stamps after passing its file on, before Git writes the
      // next one; the checkout exits only after both.
      const gatePassMs = gate.gatePassThroughMs('otter');
      const tailPassMs = gate.tailPassThroughMs('otter');
      assert.ok(
        gatePassMs >= 0 && gatePassMs <= writtenMs,
        `gate passed its file ${gatePassMs}ms after resuming`,
      );
      assert.ok(
        tailPassMs >= 0 && gate.writtenAtMs('otter') + tailPassMs <= doneAt + 1,
        `tail passed its file ${tailPassMs}ms after its stamp`,
      );
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
      // The install-time warm-up runs outside any app worktree, so it leaves
      // no markers.
      assert.deepEqual(readdirSync(path.join(root, 'gate')).sort(), [
        'smudge-tail.sh',
        'smudge.sh',
      ]);

      assert.equal(
        await addWorktree(repoPath, path.join(root, 'elsewhere'), 'other'),
        0,
      );
      for (const kind of [
        'entered',
        'resumed',
        'passed',
        'written',
        'tail-passed',
      ]) {
        assert.equal(
          existsSync(path.join(root, 'gate', `${kind}.elsewhere`)),
          false,
        );
      }

      const held = addWorktree(
        repoPath,
        path.join(root, 'data/workspaces/demo/worktrees/heron'),
        'heron-1',
      );
      assert.equal(await held, 0);
      assert.deepEqual(gate.expiredIds(), ['heron']);
      assert.equal(gate.holdExpired('heron'), true);
      assert.equal(gate.holdExpired('elsewhere'), false);
      // An expired hold still resumes Git; the scenario rejects its timing.
      assert.ok(Number.isFinite(gate.resumedAtMs('heron')));
      assert.ok(gate.gatePassThroughMs('heron') >= 0);
      assert.equal(gate.resumedAfterReleaseMs('heron'), undefined);
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
        (error) => {
          assert.match(
            error.message,
            /^Worktree ghost Git checkout never reached the performance gate within 100ms; checkout state: /,
          );
          // Nothing ran for this worktree: Git never registered it and no
          // process names its directory.
          const state = JSON.parse(error.message.split('checkout state: ')[1]);
          assert.equal(state.gitWorktreeRegistered, false);
          assert.deepEqual(state.processes, []);
          return true;
        },
      );
      gate.releaseAll();
      await waitFor(() => existsSync(path.join(root, 'gate', 'release.all')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

posixOnly(
  'a held checkout is described as registered with its running Git processes',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-perf-gate-'));
    try {
      const repoPath = fixtureRepo(root);
      const gate = installWorktreeGitGate(repoPath, {
        gateDir: path.join(root, 'gate'),
        maxHoldMs: 30_000,
      });
      const done = addWorktree(
        repoPath,
        path.join(root, 'data/workspaces/demo/worktrees/wren'),
        'wren-1',
      );
      await gate.waitForEntered('wren', { timeoutMs: 10_000 });
      const state = gate.describePendingCheckout('wren');
      assert.equal(state.gitWorktreeRegistered, true);
      assert.ok(
        state.processes.some((line) => /worktree add/.test(line)),
        JSON.stringify(state.processes),
      );
      // The filter runs as a descendant that does not name the directory.
      assert.ok(
        state.processes.some((line) => /smudge\.sh/.test(line)),
        JSON.stringify(state.processes),
      );
      gate.release('wren');
      assert.equal(await done, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('checkout process selection follows descendants of the worktree add', () => {
  const ps = [
    '  100     1 Ss   0:00.01 0:10 /bin/zsh',
    '  200   100 S    0:00.20 0:05 /usr/sbin/taskpolicy -c utility git worktree add -b dev-wren /data/workspaces/demo/worktrees/dev-wren',
    '  201   200 S    0:00.10 0:05 git reset --hard --no-recurse-submodules',
    "  202   201 S    0:00.00 0:04 /bin/sh -c '/gate/smudge.sh'",
    '  203   202 S    0:00.00 0:00 sleep 0.1',
    '  300   100 S    0:00.30 0:02 git worktree add -b dev-wren-2 /data/workspaces/demo/worktrees/dev-wren-2',
    '  400     1 S    0:01.00 1:00 node setup.js /data/workspaces/demo/worktrees/dev-wren/node_modules',
  ].join('\n');
  assert.deepEqual(
    selectCheckoutProcesses(ps, 'dev-wren').map((line) => line.split(/\s+/)[0]),
    ['200', '201', '202', '203', '400'],
  );
  assert.deepEqual(selectCheckoutProcesses(ps, 'dev-heron'), []);
  assert.deepEqual(selectCheckoutProcesses('', 'dev-wren'), []);
});

test('the gate requires the hold first and the tail last in checkout order', () => {
  assert.doesNotThrow(() =>
    assertGateCheckoutOrder([
      WORKTREE_GIT_GATE_PATH,
      '.gitattributes',
      'README.md',
      'src/main.tsx',
      'tsconfig.json',
      WORKTREE_GIT_GATE_TAIL_PATH,
    ]),
  );
  assert.throws(
    () =>
      assertGateCheckoutOrder([
        '.babelrc',
        WORKTREE_GIT_GATE_PATH,
        WORKTREE_GIT_GATE_TAIL_PATH,
      ]),
    /needs \.canopy-performance-gate first .* found \.babelrc first/,
  );
  assert.throws(
    () =>
      assertGateCheckoutOrder([
        WORKTREE_GIT_GATE_PATH,
        WORKTREE_GIT_GATE_TAIL_PATH,
        '中文.txt',
      ]),
    /and 中文\.txt last$/,
  );
  assert.throws(() => assertGateCheckoutOrder([]), /found undefined first/);
});

posixOnly(
  'installing the gate rejects a path that sorts after the tail',
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-perf-gate-'));
    try {
      const repoPath = fixtureRepo(root);
      writeFileSync(path.join(repoPath, '中文.txt'), 'late\n');
      git(repoPath, ['add', '中文.txt']);
      git(repoPath, ['commit', '-q', '-m', 'late path']);
      assert.throws(
        () =>
          installWorktreeGitGate(repoPath, {
            gateDir: path.join(root, 'gate'),
            maxHoldMs: 1_000,
          }),
        /last in checkout order/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

posixOnly('checkout configuration reports set and unset keys', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-perf-gate-'));
  try {
    const repoPath = fixtureRepo(root);
    git(repoPath, ['config', 'checkout.workers', '4']);
    const config = readCheckoutGitConfig(repoPath);
    assert.equal(config['checkout.workers'], '4');
    assert.deepEqual(Object.keys(config), [
      'checkout.workers',
      'core.fsmonitor',
      'core.untrackedCache',
      'feature.manyFiles',
      'index.version',
    ]);
    assert.equal(checkoutWritesTailLast(config), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only a sequential checkout writes the tail file last', () => {
  assert.equal(checkoutWritesTailLast({ 'checkout.workers': null }), true);
  assert.equal(checkoutWritesTailLast({ 'checkout.workers': '1' }), true);
  assert.equal(checkoutWritesTailLast({ 'checkout.workers': '0' }), false);
  assert.equal(checkoutWritesTailLast({ 'checkout.workers': '8' }), false);
  assert.equal(checkoutWritesTailLast(undefined), true);
});

// Holds the app's `git worktree add` for a created worktree until the harness
// releases it (CAN-3804). The worktree scenario probes responsiveness while
// Git setup is pending; without a hold a fast disk finishes the checkout
// before the first probe starts, so the measurement depended on fixture speed.
//
// The hold is a Git smudge filter on one tracked file, configured in the
// fixture's source repository. Git runs it during checkout whatever executable
// or hook settings the app uses (the app disables hooks, not filters), so the
// measured application and its build are unchanged. The filter only waits for
// checkouts under `.../workspaces/<id>/worktrees/<worktree id>`; every other
// checkout passes straight through. A hold never outlives `maxHoldMs`: the
// filter then marks the worktree expired and continues, and the scenario
// fails on the marker instead of hanging.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const FILTER_NAME = 'canopy-perf-gate';
/** Sorts ahead of every other tracked path, so the hold precedes all writes. */
export const WORKTREE_GIT_GATE_PATH = '.canopy-performance-gate';

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function gateScript(gateDir, maxHoldMs) {
  const maxTicks = Math.max(1, Math.ceil(maxHoldMs / 100));
  return `#!/bin/sh
# Smudge filter installed by the desktop performance worktree scenario.
case "$PWD" in
  */workspaces/*/worktrees/*) ;;
  *) exec cat ;;
esac
id=$(basename "$PWD")
gate=${shellQuote(gateDir)}
: > "$gate/entered.$id"
ticks=0
while [ ! -e "$gate/release.$id" ] && [ ! -e "$gate/release.all" ]; do
  if [ "$ticks" -ge ${maxTicks} ]; then
    : > "$gate/expired.$id"
    break
  fi
  sleep 0.1
  ticks=$((ticks + 1))
done
exec cat
`;
}

function git(repoPath, args) {
  execFileSync('git', args, {
    cwd: repoPath,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/**
 * Configures the hold in `repoPath` and commits the gated file. Returns the
 * harness controls for the gate directory.
 */
export function installWorktreeGitGate(repoPath, { gateDir, maxHoldMs }) {
  mkdirSync(gateDir, { recursive: true });
  const scriptPath = path.join(gateDir, 'smudge.sh');
  writeFileSync(scriptPath, gateScript(gateDir, maxHoldMs), 'utf8');
  chmodSync(scriptPath, 0o755);
  // Git runs the filter value through a shell, so quote the script path.
  git(repoPath, [
    'config',
    `filter.${FILTER_NAME}.smudge`,
    shellQuote(scriptPath),
  ]);
  git(repoPath, ['config', `filter.${FILTER_NAME}.clean`, 'cat']);
  writeFileSync(
    path.join(repoPath, '.gitattributes'),
    `/${WORKTREE_GIT_GATE_PATH} filter=${FILTER_NAME}\n`,
    { flag: 'a' },
  );
  writeFileSync(
    path.join(repoPath, WORKTREE_GIT_GATE_PATH),
    'Held by the desktop performance worktree scenario.\n',
    'utf8',
  );
  git(repoPath, ['add', '--', '.gitattributes', WORKTREE_GIT_GATE_PATH]);
  git(repoPath, [
    '-c',
    'user.name=Canopy Performance',
    '-c',
    'user.email=performance@example.invalid',
    '-c',
    `core.hooksPath=${os.devNull}`,
    'commit',
    '-q',
    '-m',
    'Add performance worktree Git gate',
  ]);
  return worktreeGitGate(gateDir);
}

/** Harness controls for a gate directory created by installWorktreeGitGate. */
export function worktreeGitGate(gateDir) {
  const marker = (kind, id) => path.join(gateDir, `${kind}.${id}`);
  const touch = (file) => writeFileSync(file, '', 'utf8');
  return {
    gateDir,
    async waitForEntered(worktreeId, { timeoutMs, intervalMs = 10 }) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (existsSync(marker('entered', worktreeId))) return;
        await delay(intervalMs);
      }
      throw new Error(
        `Worktree ${worktreeId} Git checkout never reached the performance gate within ${timeoutMs}ms`,
      );
    },
    release(worktreeId) {
      touch(marker('release', worktreeId));
    },
    releaseAll() {
      touch(path.join(gateDir, 'release.all'));
    },
    /** Time from entering the gate to its release, or undefined. */
    heldMs(worktreeId) {
      const entered = marker('entered', worktreeId);
      const released = marker('release', worktreeId);
      if (!existsSync(entered) || !existsSync(released)) return undefined;
      return statSync(released).mtimeMs - statSync(entered).mtimeMs;
    },
    expiredIds() {
      return readdirSync(gateDir)
        .filter((name) => name.startsWith('expired.'))
        .map((name) => name.slice('expired.'.length))
        .sort();
    },
  };
}

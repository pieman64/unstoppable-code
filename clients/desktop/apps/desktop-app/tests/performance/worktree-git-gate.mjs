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
//
// The gate stamps when it lets Git continue (`resumed.<id>`), so a timed
// creation starts there instead of at the harness's release. A second,
// pass-through filter on the path that sorts last stamps when the checkout
// wrote its final file, which splits the time after resume into Git's own
// file writes and the app's work until it reports Git ready. Each filter also
// stamps when it finished passing its file to Git (`passed.<id>`,
// `tail-passed.<id>`): the harness work left inside the timed interval.

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
const TAIL_FILTER_NAME = 'canopy-perf-gate-tail';
/** Sorts ahead of every other tracked path, so the hold precedes all writes. */
export const WORKTREE_GIT_GATE_PATH = '.canopy-performance-gate';
/** Sorts after every ASCII path, so a sequential checkout writes it last. */
export const WORKTREE_GIT_GATE_TAIL_PATH = '~canopy-performance-checkout-end';

/**
 * Git settings that change how a checkout writes files, recorded with each run
 * as fixture conditions. With `checkout.workers` above 1 Git writes the tail
 * file before its parallel batch, so the tail timing is not reported.
 */
export const CHECKOUT_GIT_CONFIG_KEYS = Object.freeze([
  'checkout.workers',
  'core.fsmonitor',
  'core.untrackedCache',
  'feature.manyFiles',
  'index.version',
]);

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const APP_WORKTREE_ONLY = `case "$PWD" in
  */workspaces/*/worktrees/*) ;;
  *) exec cat ;;
esac
id=$(basename "$PWD")`;

/**
 * Copies the file to Git, then stamps `<kind>.<id>` with a shell builtin.
 * Forking `cat` instead of exec'ing it falls inside the stamped time.
 */
const PASS_THROUGH = (kind) => `cat || exit
: > "$gate/${kind}.$id"
`;

function gateScript(gateDir, maxHoldMs) {
  const maxTicks = Math.max(1, Math.ceil(maxHoldMs / 100));
  return `#!/bin/sh
# Smudge filter installed by the desktop performance worktree scenario.
${APP_WORKTREE_ONLY}
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
: > "$gate/resumed.$id"
${PASS_THROUGH('passed')}`;
}

function tailScript(gateDir) {
  return `#!/bin/sh
# Pass-through smudge filter: marks that the checkout reached its last file.
${APP_WORKTREE_ONLY}
gate=${shellQuote(gateDir)}
: > "$gate/written.$id"
${PASS_THROUGH('tail-passed')}`;
}

function git(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function installFilter(repoPath, gateDir, { name, fileName, script }) {
  const scriptPath = path.join(gateDir, fileName);
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  // Git runs the filter value through a shell, so quote the script path.
  git(repoPath, ['config', `filter.${name}.smudge`, shellQuote(scriptPath)]);
  git(repoPath, ['config', `filter.${name}.clean`, 'cat']);
  warmFilter(scriptPath);
}

/**
 * Runs the filter once outside any app worktree, where it passes through.
 * macOS assesses a new executable on its first run (130-250 ms on the
 * baseline Mac), which would otherwise land in the first timed release.
 */
function warmFilter(scriptPath) {
  if (process.platform === 'win32') return;
  execFileSync('/bin/sh', ['-c', shellQuote(scriptPath)], {
    cwd: '/',
    input: '',
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

/**
 * Throws unless the gate is the first tracked path and the tail the last, so
 * a fixture change cannot move file writes ahead of the hold or after the
 * tail marker.
 */
export function assertGateCheckoutOrder(trackedPaths) {
  const first = trackedPaths[0];
  const last = trackedPaths.at(-1);
  if (
    first !== WORKTREE_GIT_GATE_PATH ||
    last !== WORKTREE_GIT_GATE_TAIL_PATH
  ) {
    throw new Error(
      `The performance Git gate needs ${WORKTREE_GIT_GATE_PATH} first and ${WORKTREE_GIT_GATE_TAIL_PATH} last in checkout order; found ${first} first and ${last} last`,
    );
  }
}

/**
 * Configures the hold in `repoPath` and commits the gated files. Returns the
 * harness controls for the gate directory.
 */
export function installWorktreeGitGate(repoPath, { gateDir, maxHoldMs }) {
  mkdirSync(gateDir, { recursive: true });
  installFilter(repoPath, gateDir, {
    name: FILTER_NAME,
    fileName: 'smudge.sh',
    script: gateScript(gateDir, maxHoldMs),
  });
  installFilter(repoPath, gateDir, {
    name: TAIL_FILTER_NAME,
    fileName: 'smudge-tail.sh',
    script: tailScript(gateDir),
  });
  writeFileSync(
    path.join(repoPath, '.gitattributes'),
    [
      `/${WORKTREE_GIT_GATE_PATH} filter=${FILTER_NAME}`,
      `/${WORKTREE_GIT_GATE_TAIL_PATH} filter=${TAIL_FILTER_NAME}`,
      '',
    ].join('\n'),
    { flag: 'a' },
  );
  writeFileSync(
    path.join(repoPath, WORKTREE_GIT_GATE_PATH),
    'Held by the desktop performance worktree scenario.\n',
    'utf8',
  );
  writeFileSync(
    path.join(repoPath, WORKTREE_GIT_GATE_TAIL_PATH),
    'Written last by a desktop performance worktree checkout.\n',
    'utf8',
  );
  git(repoPath, [
    'add',
    '--',
    '.gitattributes',
    WORKTREE_GIT_GATE_PATH,
    WORKTREE_GIT_GATE_TAIL_PATH,
  ]);
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
  assertGateCheckoutOrder(
    git(repoPath, ['ls-files', '-z']).split('\0').filter(Boolean),
  );
  const gitCommonDir = path.resolve(
    repoPath,
    git(repoPath, ['rev-parse', '--git-common-dir']).trim(),
  );
  return worktreeGitGate(gateDir, { gitCommonDir });
}

/**
 * The fixture's checkout settings as the harness's Git resolves them. The app
 * resolves the same repository, global and system files unless its Git
 * executable has a different system configuration.
 */
export function readCheckoutGitConfig(repoPath) {
  return Object.fromEntries(
    CHECKOUT_GIT_CONFIG_KEYS.map((key) => {
      try {
        return [key, git(repoPath, ['config', '--get', key]).trim()];
      } catch {
        // `git config --get` exits 1 for an unset key.
        return [key, null];
      }
    }),
  );
}

/** Whether a checkout under these settings writes the tail file last. */
export function checkoutWritesTailLast(checkoutConfig) {
  const workers = checkoutConfig?.['checkout.workers'] ?? null;
  return workers === null || Number(workers) === 1;
}

/**
 * The lines of `ps -axo pid=,ppid=,stat=,time=,etime=,command=` output for
 * processes whose arguments name this worktree's checkout directory, plus
 * their descendants: `git worktree add` runs its checkout and filters as
 * children that do not repeat the path.
 */
export function selectCheckoutProcesses(psOutput, worktreeId) {
  const rows = psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid] = line.split(/\s+/, 2);
      return { pid, ppid, line };
    });
  const needle = `/worktrees/${worktreeId}`;
  const namesWorktree = (line) => {
    for (
      let index = line.indexOf(needle);
      index !== -1;
      index = line.indexOf(needle, index + 1)
    ) {
      const next = line[index + needle.length];
      if (next === undefined || next === ' ' || next === '/') return true;
    }
    return false;
  };
  const selected = new Set(
    rows.filter((row) => namesWorktree(row.line)).map((row) => row.pid),
  );
  for (let grew = selected.size > 0; grew; ) {
    grew = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => selected.has(row.pid)).map((row) => row.line);
}

function listProcesses() {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync(
      'ps',
      ['-ww', '-axo', 'pid=,ppid=,stat=,time=,etime=,command='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
}

/** Harness controls for a gate directory created by installWorktreeGitGate. */
export function worktreeGitGate(gateDir, { gitCommonDir } = {}) {
  const marker = (kind, id) => path.join(gateDir, `${kind}.${id}`);
  const touch = (file) => writeFileSync(file, '', 'utf8');
  const markerTimeMs = (kind, id) => {
    const file = marker(kind, id);
    return existsSync(file) ? statSync(file).mtimeMs : undefined;
  };
  const elapsedMs = (fromKind, toKind, id) => {
    const from = markerTimeMs(fromKind, id);
    const to = markerTimeMs(toKind, id);
    return from === undefined || to === undefined ? undefined : to - from;
  };
  /**
   * Where a checkout that has not reached the gate stands. No registered Git
   * worktree and no process means the app has not run `git worktree add` yet;
   * a running process with little CPU time means Git is starved.
   */
  const describePendingCheckout = (worktreeId) => {
    const psOutput = listProcesses();
    return {
      gitWorktreeRegistered: gitCommonDir
        ? existsSync(path.join(gitCommonDir, 'worktrees', worktreeId))
        : null,
      processes:
        psOutput === null
          ? null
          : selectCheckoutProcesses(psOutput, worktreeId),
    };
  };
  return {
    gateDir,
    describePendingCheckout,
    async waitForEntered(worktreeId, { timeoutMs, intervalMs = 10 }) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (existsSync(marker('entered', worktreeId))) return;
        await delay(intervalMs);
      }
      throw new Error(
        `Worktree ${worktreeId} Git checkout never reached the performance gate within ${timeoutMs}ms; checkout state: ${JSON.stringify(describePendingCheckout(worktreeId))}`,
      );
    },
    release(worktreeId) {
      touch(marker('release', worktreeId));
    },
    releaseAll() {
      touch(path.join(gateDir, 'release.all'));
    },
    /** Wall-clock time the checkout reached the gate, or undefined. */
    enteredAtMs(worktreeId) {
      return markerTimeMs('entered', worktreeId);
    },
    /** Time from entering the gate to its release, or undefined. */
    heldMs(worktreeId) {
      return elapsedMs('entered', 'release', worktreeId);
    },
    /**
     * Time from release until the held filter let Git continue, or
     * undefined: harness latency of the 100 ms release poll, outside every
     * timed task.
     */
    resumedAfterReleaseMs(worktreeId) {
      return elapsedMs('release', 'resumed', worktreeId);
    },
    /** Wall-clock time the gate let Git continue, or undefined. */
    resumedAtMs(worktreeId) {
      return markerTimeMs('resumed', worktreeId);
    },
    /** Time from the gate's resume until Git wrote the tail file, or undefined. */
    checkoutWrittenAfterResumeMs(worktreeId) {
      return elapsedMs('resumed', 'written', worktreeId);
    },
    /**
     * Time the gate filter took to pass its file to Git after resuming, or
     * undefined: harness work inside the timed creation.
     */
    gatePassThroughMs(worktreeId) {
      return elapsedMs('resumed', 'passed', worktreeId);
    },
    /**
     * Time the tail filter took to pass its file to Git, or undefined:
     * harness work inside the app's share.
     */
    tailPassThroughMs(worktreeId) {
      return elapsedMs('written', 'tail-passed', worktreeId);
    },
    /** Whether this worktree's hold outlived `maxHoldMs` unreleased. */
    holdExpired(worktreeId) {
      return existsSync(marker('expired', worktreeId));
    },
    /** Wall-clock time Git reached the tail file, or undefined. */
    writtenAtMs(worktreeId) {
      return markerTimeMs('written', worktreeId);
    },
    expiredIds() {
      return readdirSync(gateDir)
        .filter((name) => name.startsWith('expired.'))
        .map((name) => name.slice('expired.'.length))
        .sort();
    },
  };
}

import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes a `CANOPY_GIT_EXECUTABLE` shim that makes `git worktree add` slow
 * (repo hooks can't: the app runs git with `core.hooksPath=<null device>`),
 * so a send lands while the new worktree's Git setup is still pending.
 * `worktreeExitCode` makes that add fail after its sleep instead of running.
 * The shadow-fetch options delay only fetches inside repo shadows.
 */
export function writeSlowGitShim(
  userDataDir,
  {
    worktreeSleepSeconds = 8,
    worktreeExitCode,
    shadowFetchSleepSeconds = 0,
    shadowFetchMarkerPath = '',
    shadowFetchCompletedMarkerPath = '',
  } = {},
) {
  const shimPath = path.join(userDataDir, 'git-slow-shim.sh');
  const worktreeAddHook =
    worktreeExitCode === undefined
      ? `sleep ${worktreeSleepSeconds}`
      : `sleep ${worktreeSleepSeconds}; echo 'fatal: simulated worktree add failure' >&2; exit ${worktreeExitCode}`;
  const shadowFetchHook = shadowFetchMarkerPath
    ? `touch '${shadowFetchMarkerPath}'; `
    : '';
  const shadowFetchCompletedHook = shadowFetchCompletedMarkerPath
    ? `touch '${shadowFetchCompletedMarkerPath}'; `
    : '';
  writeFileSync(
    shimPath,
    `#!/bin/sh\ncase "$*" in *"worktree add"*) ${worktreeAddHook};; *"fetch"*) case "$PWD" in *"/repo-shadows/"*) ${shadowFetchHook}sleep ${shadowFetchSleepSeconds}; ${shadowFetchCompletedHook};; esac;; esac\nexec /usr/bin/git "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

// CAN-4466: a clone that fails on GitHub credentials, without network. The
// shim answers clones from a local bare repository unless a failure file is
// present, so production classification sees real git stderr.
function quoteShell(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

const FAILURES = {
  auth: [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ],
  notfound: [
    'remote: Repository not found.',
    "fatal: repository 'https://github.com/' not found",
  ],
};

/**
 * Writes a `CANOPY_GIT_EXECUTABLE` shim. Clones record their remote, fail
 * while a failure is set (before any URL rewrite, so SSH remotes fail too),
 * and otherwise clone `localBareRepo` in place of `remoteUrl`.
 */
export function writeGitHubCloneAuthShim({
  userDataDir,
  remoteUrl,
  localBareRepo,
}) {
  const root = path.join(userDataDir, 'can-4466-git');
  mkdirSync(root, { recursive: true });
  const invocationsFile = path.join(root, 'invocations');
  const shim = path.join(root, 'git-github-auth.sh');
  const failureFile = (kind) => path.join(root, `fail-${kind}`);
  const failureBranches = Object.entries(FAILURES).flatMap(([kind, lines]) => [
    `    if [ -f ${quoteShell(failureFile(kind))} ]; then`,
    ...lines.map((line) => `      printf '%s\\n' ${quoteShell(line)} >&2`),
    '      exit 128',
    '    fi',
  ]);
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" clone "*)',
      '    previous=""; last=""',
      '    for argument; do previous="$last"; last="$argument"; done',
      `    printf '%s\\n' "$previous" >> ${quoteShell(invocationsFile)}`,
      ...failureBranches,
      '    ;;',
      'esac',
      `exec /usr/bin/git -c ${quoteShell(`url.${localBareRepo}.insteadOf=${remoteUrl}`)} "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  return {
    env: {
      CANOPY_GIT_EXECUTABLE: shim,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
    },
    /** The remote of every clone so far. */
    arguments() {
      return existsSync(invocationsFile)
        ? readFileSync(invocationsFile, 'utf8').trim().split('\n')
        : [];
    },
    /** `'auth'`, `'notfound'`, or `null` for a working clone. */
    setFailure(kind) {
      for (const known of Object.keys(FAILURES))
        rmSync(failureFile(known), { force: true });
      if (kind) writeFileSync(failureFile(kind), '');
    },
  };
}

/**
 * Replaces the credential and PTY boundary the GitHub sign-in uses, as the
 * CAN-4006 spec does. `globalThis.__can4466.connected` drives the CLI status.
 * With `listRequiresConnection`, the Home repository list throws until the
 * user connects; otherwise it lists `repository` (a stale-token clone).
 */
export async function installGitHubConnectStubs(
  electronApp,
  { repository, listRequiresConnection = false } = {},
) {
  await electronApp.evaluate(
    ({ ipcMain }, options) => {
      const fixture = { connected: false, refreshes: 0 };
      globalThis.__can4466 = fixture;
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      replace('settings:load-github-pat', () => '');
      replace('settings:github-cli-status', () => ({
        installed: true,
        authenticated: fixture.connected,
      }));
      replace('settings:refresh-github-credentials', () => {
        fixture.refreshes++;
      });
      replace('auth-terminal:start', () => ({ sessionId: 'can4466-login' }));
      replace('auth-terminal:stop', () => {});
      replace('auth-terminal:resize', () => {});
      replace('auth-terminal:write', () => {});
      if (!options.repository) return;
      replace('github:get-repo-slug', (_event, request) => ({
        owner: 'acme',
        repo: String(request?.repoPath ?? '')
          .split('/')
          .at(-1),
      }));
      replace('github:list-user-repos', () => {
        if (options.listRequiresConnection && !fixture.connected)
          throw new Error('GitHub authentication required');
        return [options.repository];
      });
    },
    { repository, listRequiresConnection },
  );
}

export async function setGitHubConnected(electronApp, connected) {
  await electronApp.evaluate((_electron, value) => {
    globalThis.__can4466.connected = value;
  }, connected);
}

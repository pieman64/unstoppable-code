import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Write a fake `gh` executable that answers `auth status --json hosts` with
 * `authStatus` and exits non-zero for every other subcommand.
 *
 * @param {string} userDataDir Directory to write the fixture into.
 * @param {object} authStatus Payload printed as JSON for `auth status`. A
 *   single quote would end the shell literal, so the writer rejects one.
 * @returns {string} Absolute path to set as `GH_EXECUTABLE`.
 */
function writeGhFixture(userDataDir, authStatus) {
  const authStatusJson = JSON.stringify(authStatus);
  if (authStatusJson.includes("'")) {
    throw new Error('gh fixture auth status must not contain a single quote');
  }
  mkdirSync(userDataDir, { recursive: true });
  const ghFixturePath = path.join(userDataDir, 'gh-fixture');
  writeFileSync(
    ghFixturePath,
    [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      `  printf '%s\\n' '${authStatusJson}'`,
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n'),
    'utf8',
  );
  chmodSync(ghFixturePath, 0o755);
  return ghFixturePath;
}

/**
 * Write a fake `gh` executable that reports an empty credential store.
 *
 * The GitHub auth label in `ProviderAuthPanel` reads `ghStatus?.authenticated`,
 * which `checkGitHubCliStatus()` derives by running the real `gh auth status`
 * against the host's own `~/.config/gh/hosts.yml` with Canopy's PAT injection
 * deliberately stripped. `launchCanopy` keeps the real login `HOME`, so
 * without a fixture the label is decided by whether the developer or CI runner
 * happens to have run `gh auth login` — a spec that passes locally and fails on
 * a clean runner.
 *
 * `getBundledGhBinaryPath()` honours `GH_EXECUTABLE`, and both `github-auth.ts`
 * and `auth-terminal/manager.ts` route through it, so pointing that variable at
 * this script pins the status probe *and* the sign-in attempt:
 *
 * - `auth status --json hosts` returns `{"hosts":{}}` — no credentials, so
 *   every GitHub surface renders its unauthenticated arm. An empty object
 *   rather than a non-zero exit matters: it yields `envOverride: false`, so the
 *   button renders instead of being replaced by the override warning.
 * - every other subcommand (i.e. `auth login`) exits non-zero, so the sign-in
 *   modal lands in its "did not complete" view instead of waiting on a real
 *   browser flow.
 *
 * Callers should NOT also pass `GH_TOKEN`/`GITHUB_TOKEN` in `env`.
 * `buildElectronEnv` deletes those keys only when the spec does not supply
 * them, so passing `''` opts out of that scrub and leaves them present-but-empty.
 *
 * @param {string} userDataDir Directory to write the fixture into.
 * @returns {string} Absolute path to set as `GH_EXECUTABLE`.
 */
export function writeUnauthenticatedGhFixture(userDataDir) {
  return writeGhFixture(userDataDir, { hosts: {} });
}

/**
 * Write a fake `gh` executable that reports a signed-in github.com account.
 *
 * The authenticated counterpart of `writeUnauthenticatedGhFixture`, for specs
 * whose flow depends on GitHub being connected, such as the onboarding
 * examples preview that only queues behind a connected tool. Without it those
 * specs pass on a machine where `gh auth login` was run and fail on a clean
 * runner.
 *
 * The login comes from the credential store (`tokenSource` is not an env
 * variable), so `envOverride` stays false and no override warning renders.
 * Every other subcommand, including `auth token`, still exits non-zero, so no
 * request is ever made with a token. The same `GH_TOKEN`/`GITHUB_TOKEN` caveat
 * applies.
 *
 * @param {string} userDataDir Directory to write the fixture into.
 * @returns {string} Absolute path to set as `GH_EXECUTABLE`.
 */
export function writeAuthenticatedGhFixture(userDataDir) {
  return writeGhFixture(userDataDir, {
    hosts: {
      'github.com': [
        {
          state: 'success',
          active: true,
          host: 'github.com',
          login: 'e2e-user',
          tokenSource: 'keyring',
          gitProtocol: 'https',
        },
      ],
    },
  });
}

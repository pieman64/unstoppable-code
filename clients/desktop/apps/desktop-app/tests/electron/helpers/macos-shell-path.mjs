import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { writeUnauthenticatedGhFixture } from '../ghAuthFixture.mjs';
import { chooseCloneDestination, fillCloneUrl } from './add-project.mjs';

export const FISH_PATH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish'].find(
  (candidate) => existsSync(candidate),
);

/** Real shells, isolated startup config, and Git wrappers that record selection. */
export function seedMacosShellPath(root, shell, exported = false) {
  const sourceRepo = path.join(root, 'shell-path-source');
  mkdirSync(sourceRepo, { recursive: true });
  execFileSync('/usr/bin/git', ['init', sourceRepo], { stdio: 'ignore' });
  writeFileSync(path.join(sourceRepo, 'README.md'), '# Shell PATH fixture\n');
  execFileSync('/usr/bin/git', ['-C', sourceRepo, 'add', '.']);
  execFileSync(
    '/usr/bin/git',
    [
      '-C',
      sourceRepo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'Fixture',
    ],
    { stdio: 'ignore' },
  );

  const customBin = path.join(root, 'custom Git', 'back\\slash', '$literal');
  const fallbackBin = path.join(root, 'fallback-bin');
  const selectedGitLog = path.join(root, 'selected-git.log');
  const fallbackGitLog = path.join(root, 'fallback-git.log');
  for (const dir of [customBin, fallbackBin])
    mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(customBin, 'git'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$CANOPY_E2E_SELECTED_GIT_LOG"',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(fallbackBin, 'git'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$CANOPY_E2E_FALLBACK_GIT_LOG"',
      'echo "Fixture: Git unavailable in inherited PATH" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(path.join(customBin, 'git'), 0o755);
  chmodSync(path.join(fallbackBin, 'git'), 0o755);

  const shellPath = path.join(root, 'login-shell');
  // The harness supervisor uses /usr/bin/env node before Electron starts.
  const systemPath = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const inheritedPath = `${fallbackBin}:${systemPath}`;
  const resolvedPath = `${customBin}:${systemPath}`;
  // The clone helper opens the direct URL form, so keep every durable and
  // capture caller independent of the developer host's GitHub login state.
  const env = {
    GH_EXECUTABLE: writeUnauthenticatedGhFixture(
      path.join(root, 'github-auth'),
    ),
    SHELL: shellPath,
    PATH: inheritedPath,
    CANOPY_GIT_EXECUTABLE: '',
    CANOPY_E2E_SHELL_PATH: resolvedPath,
    CANOPY_E2E_SELECTED_GIT_LOG: selectedGitLog,
    CANOPY_E2E_FALLBACK_GIT_LOG: fallbackGitLog,
  };
  if (shell === 'fish') {
    if (!FISH_PATH) throw new Error('Real Fish is required for this fixture');
    const configDir = path.join(root, 'config', 'fish');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, 'config.fish'),
      [
        `set -g${exported ? 'x' : 'u'} PATH (string split : -- "$CANOPY_E2E_SHELL_PATH")`,
        'echo fixture-startup-banner',
        'function fixture_exit --on-event fish_exit',
        '  echo misleading-logout-output',
        'end',
        '',
      ].join('\n'),
    );
    Object.assign(env, {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
    });
    writeFileSync(shellPath, `#!/bin/sh\nexec '${FISH_PATH}' "$@"\n`);
  } else {
    const setup = `PATH="$CANOPY_E2E_SHELL_PATH"; ${
      exported
        ? 'export PATH'
        : shell === 'zsh'
          ? 'typeset +x PATH'
          : 'export -n PATH'
    }; echo fixture-startup-banner; eval "$1"`;
    // Only the trusted probe is evaluated; PATH itself remains a quoted value.
    writeFileSync(
      shellPath,
      [
        '#!/bin/sh',
        `exec /bin/${shell} ${shell === 'zsh' ? '-f' : '--noprofile --norc'} -lic '${setup}' fixture "$2"`,
        '',
      ].join('\n'),
    );
  }
  chmodSync(shellPath, 0o755);
  const cloneRoot = path.join(root, 'clones');
  mkdirSync(cloneRoot);
  return { env, sourceRepo, cloneRoot, selectedGitLog, fallbackGitLog };
}

export async function submitShellPathClone(window, app, fixture, electronApp) {
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await window.getByTestId('sidebar-section-code-toggle').hover();
  await window.getByTestId('sidebar-section-code-add').click();
  // Capture runs exercise both the retained pre-rename bundle and the current UI.
  await expect(
    window.getByRole('heading', { name: /Add (?:workspace|project)/ }),
  ).toBeVisible();
  await window.getByTestId('add-workspace-mode-remote').click();
  await fillCloneUrl(window, fixture.sourceRepo);
  await chooseCloneDestination(electronApp, window, fixture.cloneRoot);
  await window
    .getByRole('button', { name: 'Clone and add', exact: true })
    .click();
}

export async function expectShellPathClone(window, fixture) {
  await expect
    .poll(
      () =>
        existsSync(fixture.selectedGitLog)
          ? readFileSync(fixture.selectedGitLog, 'utf8')
          : '',
      {
        message: 'Clone must use the Git selected by the login-shell PATH',
        timeout: 10_000,
      },
    )
    .toMatch(/\bclone\b/);
  await expect(
    window.getByRole('heading', { name: /Add (?:workspace|project)/ }),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(
    window
      .getByTestId('sidebar-section-code')
      .getByRole('button', { name: 'Collapse shell-path-source' }),
  ).toBeVisible({ timeout: 30_000 });
  expect(
    existsSync(path.join(fixture.cloneRoot, 'shell-path-source', 'README.md')),
  ).toBe(true);
  const fallbackCalls = existsSync(fixture.fallbackGitLog)
    ? readFileSync(fixture.fallbackGitLog, 'utf8')
    : '';
  expect(fallbackCalls).not.toMatch(/\bclone\b/);
}

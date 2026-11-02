import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// CAN-3089: real tracked paths produce >8 MiB from the six-attribute query,
// while individual path listings stay below the normal Git buffer limit.
export function seedLargeArchiveRepository(repoPath) {
  // The fixture asserts exact LF bytes. A host's Windows autocrlf default also
  // produces >1 MiB of warnings for these paths, overflowing git add's buffer.
  execFileSync('git', ['config', '--local', 'core.autocrlf', 'false'], {
    cwd: repoPath,
  });
  const paths = Array.from(
    { length: 12_000 },
    (_, index) => `large-${'x'.repeat(100)}-${index}.txt`,
  );
  for (const name of paths) {
    writeFileSync(path.join(repoPath, name), 'retained content\n');
  }
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-q', '-m', 'Large archive fixture'], {
    cwd: repoPath,
  });
  const output = execFileSync(
    'git',
    [
      'check-attr',
      '-z',
      '--stdin',
      'filter',
      'text',
      'eol',
      'working-tree-encoding',
      'ident',
      'crlf',
    ],
    {
      cwd: repoPath,
      input: `${paths.join('\0')}\0`,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (output.byteLength <= 8 * 1024 * 1024) {
    throw new Error(
      'Large archive fixture did not exceed the old output limit.',
    );
  }
  return { paths, attributeBytes: output.byteLength };
}

export function configureArchiveFixture(userDataDir, workspaceId) {
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // Exercise teardown without inheriting the demo app's POSIX-only rm command.
  // Archive tests do not install or build that demo app.
  config.scripts = {
    ...config.scripts,
    teardown: {
      command: 'echo Archive fixture teardown',
      shell: { windows: 'cmd' },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function confirmWorktreeDeletion(window, row) {
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-delete').click();
  const dialog = window.getByRole('dialog', { name: /^Delete worktree/ });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByTestId('worktree-removal-preserve-branch').click();
}

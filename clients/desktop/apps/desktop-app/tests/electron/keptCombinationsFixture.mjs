import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const KEPT_COMBINATION = 'kept-combination';
export const DISPOSABLE_COMBINATION = 'disposable-combination';

// Two empty Personal combinations, with no archive directories. The only
// visibility difference is explicit Always show. Seed before launching so
// both belong to the automatic pass's original inventory.
export function seedEmptyTemporaryCombinations(userDataDir) {
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const configPaths = {};
  for (const [id, name, alwaysShow] of [
    [KEPT_COMBINATION, 'Kept combination', true],
    [DISPOSABLE_COMBINATION, 'Disposable combination', false],
  ]) {
    const repoPath = path.join(userDataDir, 'repos', id);
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, 'README.md'), `${name}\n`);
    for (const args of [
      ['init', '--initial-branch=main'],
      ['add', 'README.md'],
      [
        '-c',
        'user.name=Canopy Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'initial',
      ],
      ['remote', 'add', 'origin', 'https://github.com/acme/setup-repo.git'],
    ]) {
      execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    }
    const workspaceDir = path.join(userDataDir, 'workspaces', id);
    mkdirSync(workspaceDir, { recursive: true });
    configPaths[id] = path.join(workspaceDir, 'workspace.json');
    writeFileSync(
      configPaths[id],
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        temporary: true,
        alwaysShow,
        repos: [{ id: 'setup-repo', name: 'setup-repo', repoPath }],
      }),
    );
    writeFileSync(
      path.join(workspaceDir, 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [] }),
    );
    index.workspaces.push({
      id,
      name,
      type: 'multi-repo',
      color: '#7C9B6D',
      collapsed: false,
      order: index.workspaces.length,
    });
  }
  writeFileSync(indexPath, JSON.stringify(index));
  return configPaths;
}

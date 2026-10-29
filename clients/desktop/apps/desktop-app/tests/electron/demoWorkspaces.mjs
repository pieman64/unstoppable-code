import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const repoRoot = path.resolve(currentDirPath, '../../../..');
const seedScriptPath = path.join(repoRoot, 'demo-apps', 'seed-canopy-data.mjs');

export function seedDemoWorkspaces(options = {}) {
  const {
    userDataDir,
    set: requestedSet,
    apps,
    fixturesDir,
    force = true,
    checkRuntimes = false,
    createWorktrees = true,
  } = options;
  const set = requestedSet ?? (apps?.length ? null : 'first-wave');

  if (!userDataDir) {
    throw new Error('seedDemoWorkspaces requires userDataDir');
  }

  const args = [seedScriptPath, '--data-dir', userDataDir, '--json'];
  if (set) {
    args.push('--set', set);
  }
  if (apps?.length) {
    args.push('--apps', apps.join(','));
  }
  if (fixturesDir) {
    args.push('--fixtures-dir', fixturesDir);
  }
  if (force) {
    args.push('--force');
  }
  if (createWorktrees) {
    args.push('--create-worktrees');
  } else {
    // The seed script's own default is create-worktrees ON; without the
    // explicit negative flag, `createWorktrees: false` was a silent no-op
    // that seeded a demo-main worktree anyway (Task G1 finding).
    args.push('--no-create-worktrees');
  }
  if (checkRuntimes) {
    args.push('--check-runtimes');
  } else {
    args.push('--no-check-runtimes');
  }

  const stdout = execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const summary = JSON.parse(stdout);
  validateSeededWorkspaces(summary);
  return summary;
}

// Fail fast (with a readable message) if a fixture didn't actually
// git-init/commit — otherwise a partial seed only surfaces later as an opaque
// worktree error masked by a Playwright timeout.
function validateSeededWorkspaces(summary) {
  if (!summary?.ok) {
    throw new Error(
      `seedDemoWorkspaces: seed reported failure: ${JSON.stringify(summary)}`,
    );
  }
  for (const workspace of summary.workspaces ?? []) {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      continue;
    }
    if (!existsSync(path.join(worktreePath, '.git'))) {
      throw new Error(
        `seedDemoWorkspaces: missing .git in worktree for ${workspace.id} (${worktreePath})`,
      );
    }
    try {
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      throw new Error(
        `seedDemoWorkspaces: no commit (git rev-parse HEAD) in worktree for ${workspace.id} (${worktreePath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export function cleanupDemoWorkspaces(seedResult) {
  if (!seedResult?.fixturesDir) {
    return;
  }
  rmSync(seedResult.fixturesDir, { recursive: true, force: true });
}

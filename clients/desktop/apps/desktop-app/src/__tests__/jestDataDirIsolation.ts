import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keep unit tests out of the developer's real data directory.
 *
 * Jest runs with `NODE_ENV=test`, which the runtime-mode resolver maps to the
 * production brand root (`~/.canopy`). Any test that reaches an unmocked
 * writer — observability diagnostics, caches, registries — therefore wrote
 * into the live desktop app's data (fixture sessions such as
 * `workspace-1/worktree-1` appeared in real session diagnostics). Every Jest
 * worker now defaults to a private temporary root; a test that sets or deletes
 * these variables itself still controls resolution.
 */
export function configureJestDataDirIsolation(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  workerId: string = env.JEST_WORKER_ID ?? String(process.pid),
): string {
  const worktreeKey = createHash('sha256')
    .update(cwd)
    .digest('hex')
    .slice(0, 12);
  const root = join(
    tmpdir(),
    'canopy-jest-data',
    `${worktreeKey}-${process.pid}-${workerId}`,
  );
  if (!env.CANOPY_DATA_DIR?.trim()) {
    env.CANOPY_DATA_DIR = join(root, 'data');
  }
  if (!env.CANOPY_SECURE_DATA_DIR?.trim()) {
    env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  }
  return root;
}

configureJestDataDirIsolation();

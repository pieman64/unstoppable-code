// Run by repository-durability.test.ts in a separate process, which kills
// itself at the requested repository checkpoint: no finally block, cleanup or
// lease release runs, as when a desktop or CLI writer is terminated.
import type { BrowserTaskScope } from '@canopy/protocol/browser-profiles';
import { BrowserProfileRepository } from '../repository';

const [root, mode, stage, operationId] = process.argv.slice(2);
if (!root || !mode || !stage)
  throw new Error('usage: <root> <mutate|recover> <stage> [operationId]');

const scope: BrowserTaskScope = {
  kind: 'worktree',
  projectId: 'project-a',
  worktreeId: 'task-a',
};

const repository = new BrowserProfileRepository(root, {
  checkpoint: (point): void => {
    if (point === stage) process.kill(process.pid, 'SIGKILL');
  },
});

const run =
  mode === 'recover'
    ? repository.list()
    : repository.ensureTask(scope, '2026-09-11T00:00:00.000Z', operationId);
run.then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    // Not 1: Windows reports a self-kill as exit status 1.
    process.exit(2);
  },
);

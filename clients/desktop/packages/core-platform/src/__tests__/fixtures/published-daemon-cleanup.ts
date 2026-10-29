import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FixtureCleanup, FixtureRelease } from './pipe-test-cleanup';

export function createPublishedDaemonCleanup(
  parent: FixtureCleanup,
  files: FixtureRelease,
  dataRoot: string,
): { scope: FixtureCleanup; close: () => Promise<void> } {
  // Keep scratch deletion in the hook, after publication cleanup is verified.
  const scope = parent.fork([files]);
  return {
    scope,
    async close(): Promise<void> {
      const failures = await scope.close();
      if (failures) throw new Error('Daemon teardown incomplete');
      // Parent deletion must not manufacture the descriptor's absence.
      expect((await stat(dataRoot)).isDirectory()).toBe(true);
      await expect(
        stat(join(dataRoot, 'runtime', 'core.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  };
}

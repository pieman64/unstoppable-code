import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureIndexTreeSha,
  setGitTreeSnapshotRuntime,
} from '../lib/git-tree-snapshot';

describe('snapshot command timeout', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'snapshot-timeout-'));
    // Node executes this fixture with the same write-tree argument as Git.
    setGitTreeSnapshotRuntime({
      resolveExecutable: () => Promise.resolve(process.execPath),
      environment: () => process.env,
    });
  });

  afterEach(async () => {
    setGitTreeSnapshotRuntime();
    await rm(directory, { recursive: true, force: true });
  });

  it('allows a snapshot command to finish after the former five-second deadline', async () => {
    const tree = 'a'.repeat(40);
    await writeFile(
      join(directory, 'write-tree'),
      `setTimeout(() => process.stdout.write('${tree}'), 6_000);`,
    );
    await expect(captureIndexTreeSha(directory)).resolves.toBe(tree);
  }, 15_000);

  it('still terminates a snapshot command at the thirty-second deadline', async () => {
    await writeFile(
      join(directory, 'write-tree'),
      'setInterval(() => undefined, 1_000);',
    );
    const start = Date.now();
    await expect(captureIndexTreeSha(directory)).rejects.toThrow(
      'Git command timed out.',
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(29_000);
  }, 40_000);

  it('cancels a snapshot without waiting for its command deadline and observes child exit', async () => {
    await writeFile(
      join(directory, 'write-tree'),
      'setInterval(() => undefined, 1_000);',
    );
    const controller = new AbortController();
    let exited = false;
    setGitTreeSnapshotRuntime({
      resolveExecutable: () => Promise.resolve(process.execPath),
      environment: () => process.env,
      signal: controller.signal,
      childStarted: () => controller.abort(),
      childExited: () => {
        exited = true;
      },
    });
    await expect(captureIndexTreeSha(directory)).rejects.toThrow(
      'Archived Git diff was cancelled.',
    );
    expect(exited).toBe(true);
  });
});

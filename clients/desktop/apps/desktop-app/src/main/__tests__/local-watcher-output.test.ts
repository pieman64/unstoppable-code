import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWatcherOutputPreview } from '../app-advisor/local-watcher-output';
let root: string;
jest.mock('../lib/paths', () => ({
  getWorktreeAttachmentsDir: (): string => join(root, 'live'),
  getArchivedContainerAttachmentsDir: (): string => join(root, 'archive'),
}));

describe('watcher output references', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'local-watcher-output-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('resolves a bounded preview and preserves the same reference across archive and restore', async () => {
    const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    const reference = 'watcher:test-watcher:1';
    await mkdir(join(root, 'live', 'watcher-output', 'test-watcher'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'live', 'watcher-output', 'test-watcher', 'attempt-1.log'),
      'first\nsecond\nthird',
    );
    const live: unknown = JSON.parse(
      await readWatcherOutputPreview(scope, reference, 1),
    );
    if (
      live === null ||
      typeof live !== 'object' ||
      !('preview' in live) ||
      typeof live.preview !== 'string' ||
      !('byteSize' in live) ||
      typeof live.byteSize !== 'number' ||
      !('path' in live) ||
      typeof live.path !== 'string'
    ) {
      throw new Error('Expected a watcher output preview.');
    }
    expect(live.preview).toBe('first');
    expect(live.byteSize).toBe(18);
    await rename(join(root, 'live'), join(root, 'archive'));
    expect(await readWatcherOutputPreview(scope, reference, 1)).toContain(
      'archive',
    );
    await rename(join(root, 'archive'), join(root, 'live'));
    expect(await readWatcherOutputPreview(scope, reference, 1)).toContain(
      live.path,
    );
    await expect(
      readWatcherOutputPreview(scope, 'watcher:../../secret:1', 1),
    ).rejects.toThrow('Invalid');
  });
});

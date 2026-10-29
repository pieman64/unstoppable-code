import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanBrowserProfileDirectory } from '../inventory-scan';

describe('worker-side browser inventory', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'browser-inventory-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('counts bytes without reading native database contents or returning paths', async () => {
    await mkdir(join(root, 'native', 'nested'), { recursive: true });
    await writeFile(join(root, 'native', 'cookies'), 'secret cookie value');
    await writeFile(
      join(root, 'native', 'nested', 'leveldb'),
      Buffer.alloc(32),
    );
    const result = await scanBrowserProfileDirectory(join(root, 'native'));
    expect(result).toEqual({
      approximateBytes: 51,
      files: 2,
      directories: 2,
      skippedEntries: 0,
      partial: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret|cookies|leveldb|browser-inventory/,
    );
  });

  it('does not follow directory or file symlinks outside owned storage', async () => {
    await mkdir(join(root, 'native'));
    await mkdir(join(root, 'unrelated'));
    await writeFile(join(root, 'unrelated', 'secret'), Buffer.alloc(4096));
    await symlink(
      join(root, 'unrelated'),
      join(root, 'native', 'linked-directory'),
      'junction',
    );
    await symlink(
      join(root, 'unrelated', 'secret'),
      join(root, 'native', 'linked-file'),
    );
    expect(
      await scanBrowserProfileDirectory(join(root, 'native')),
    ).toMatchObject({
      approximateBytes: 0,
      files: 0,
      skippedEntries: 2,
      partial: true,
    });
    await expect(
      scanBrowserProfileDirectory(join(root, 'native', 'linked-directory')),
    ).rejects.toThrow('not an owned directory');
  });

  it('bounds traversal and reports incomplete measurements instead of inventing totals', async () => {
    await mkdir(join(root, 'native'));
    for (let i = 0; i < 12; i++)
      await writeFile(join(root, 'native', String(i)), Buffer.alloc(10));
    expect(
      await scanBrowserProfileDirectory(join(root, 'native'), {
        maxEntries: 5,
      }),
    ).toMatchObject({ approximateBytes: 50, files: 5, partial: true });
  });

  it('closes open directory iterators when cancellation interrupts progress', async () => {
    await mkdir(join(root, 'native'));
    for (let i = 0; i < 12; i++)
      await writeFile(join(root, 'native', String(i)), 'x');
    const controller = new AbortController();
    await expect(
      scanBrowserProfileDirectory(join(root, 'native'), {
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('inventory cancelled')),
      }),
    ).rejects.toThrow('inventory cancelled');
    // Removal succeeds on Windows only if traversal released its directory handles.
    await rm(join(root, 'native'), { recursive: true });
  });

  it('reports an unused nonexistent directory without creating it', async () => {
    expect(
      await scanBrowserProfileDirectory(join(root, 'unused')),
    ).toMatchObject({
      approximateBytes: 0,
      files: 0,
      directories: 0,
      partial: false,
    });
  });
});

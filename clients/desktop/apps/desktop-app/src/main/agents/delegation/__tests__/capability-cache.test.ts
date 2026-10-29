import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DelegationCapabilityCache,
  installedContentDigest,
} from '../capability-cache';

function treeKey(identity: string): {
  readonly harness: 'claude';
  readonly identity: string;
  readonly directory: string;
} {
  return { harness: 'claude', identity, directory: '/source/' + identity };
}

function sourceTree(content: string): ReadonlyMap<string, string> {
  return new Map([['SKILL.md', content]]);
}

describe('DelegationCapabilityCache', () => {
  it('shares concurrent reads, returns copies, and reuses the cached tree', async () => {
    const cache = new DelegationCapabilityCache({
      digest: (): Promise<string> => Promise.resolve('digest-one'),
    });
    const read = jest.fn(() =>
      Promise.resolve(sourceTree('Review carefully.')),
    );
    const [first, concurrent] = await Promise.all([
      cache.readTree(treeKey('review'), read),
      cache.readTree(treeKey('review'), read),
    ]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(Array.from(first.entries())).toEqual([
      ['SKILL.md', 'Review carefully.'],
    ]);
    expect(Array.from(concurrent.entries())).toEqual(
      Array.from(first.entries()),
    );
    const next = await cache.readTree(treeKey('review'), read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(next.get('SKILL.md')).toBe('Review carefully.');
  });

  it('reads again when the installed-content digest changes', async () => {
    let digest = 'before';
    const cache = new DelegationCapabilityCache({
      digest: (): Promise<string> => Promise.resolve(digest),
    });
    const read = jest
      .fn<Promise<ReadonlyMap<string, string>>, []>()
      .mockResolvedValueOnce(sourceTree('first'))
      .mockResolvedValueOnce(sourceTree('second'));

    await cache.readTree(treeKey('plugin'), read);
    digest = 'after';
    const updated = await cache.readTree(treeKey('plugin'), read);

    expect(read).toHaveBeenCalledTimes(2);
    expect(updated.get('SKILL.md')).toBe('second');
  });

  it('does not cache trees when a digest is unavailable', async () => {
    const cache = new DelegationCapabilityCache({
      digest: (): Promise<undefined> => Promise.resolve(undefined),
    });
    const read = jest.fn(() => Promise.resolve(sourceTree('fresh')));

    await cache.readTree(treeKey('review'), read);
    await cache.readTree(treeKey('review'), read);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not cache rejected reads', async () => {
    const cache = new DelegationCapabilityCache({
      digest: (): Promise<string> => Promise.resolve('digest-one'),
    });
    const read = jest
      .fn<Promise<ReadonlyMap<string, string>>, []>()
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(sourceTree('recovered'));

    await expect(cache.readTree(treeKey('review'), read)).rejects.toThrow(
      'temporary read failure',
    );
    const recovered = await cache.readTree(treeKey('review'), read);

    expect(read).toHaveBeenCalledTimes(2);
    expect(recovered.get('SKILL.md')).toBe('recovered');
  });

  it('evicts least-recently-used entries when the entry limit is reached', async () => {
    const cache = new DelegationCapabilityCache({
      maxEntries: 2,
      digest: (): Promise<string> => Promise.resolve('same-digest'),
    });
    const read = jest.fn(() => Promise.resolve(sourceTree('x')));

    await cache.readTree(treeKey('one'), read);
    await cache.readTree(treeKey('two'), read);
    await cache.readTree(treeKey('one'), read);
    await cache.readTree(treeKey('three'), read);
    await cache.readTree(treeKey('one'), read);
    await cache.readTree(treeKey('two'), read);

    expect(read).toHaveBeenCalledTimes(4);
  });

  it('evicts entries when the UTF-8 byte limit is reached', async () => {
    const cache = new DelegationCapabilityCache({
      maxBytes: 3,
      digest: (): Promise<string> => Promise.resolve('same-digest'),
    });
    const read = jest.fn((key?: { readonly identity: string }) =>
      Promise.resolve(sourceTree(key?.identity === 'one' ? 'aa' : 'bb')),
    );

    await cache.readTree(treeKey('one'), () => read({ identity: 'one' }));
    await cache.readTree(treeKey('two'), () => read({ identity: 'two' }));
    await cache.readTree(treeKey('one'), () => read({ identity: 'one' }));

    expect(read).toHaveBeenCalledTimes(3);
  });

  it('clears cached entries', async () => {
    const cache = new DelegationCapabilityCache({
      digest: (): Promise<string> => Promise.resolve('digest-one'),
    });
    const read = jest.fn(() => Promise.resolve(sourceTree('fresh')));

    await cache.readTree(treeKey('review'), read);
    cache.clear();
    await cache.readTree(treeKey('review'), read);

    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('installedContentDigest', () => {
  it('changes when a file changes and returns undefined for a missing directory', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'delegation-cache-'),
    );
    try {
      const nested = path.join(directory, 'nested');
      await mkdir(nested);
      const file = path.join(nested, 'SKILL.md');
      await writeFile(file, 'first');
      const first = await installedContentDigest(directory);

      await writeFile(file, 'a longer update');
      const second = await installedContentDigest(directory);

      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(second).toMatch(/^[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(
        await installedContentDigest(path.join(directory, 'missing')),
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

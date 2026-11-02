import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNodeW5FileStore,
  createSerialQueue,
  isJsonObject,
  withUnknownFields,
  type W5AtomicFileWriter,
  type W5FileReplacement,
} from '../file-store';
import type { W5StorageTarget } from '../storage-target';

const storage: W5StorageTarget = {
  namespace: 'workspace_index',
  writer: 'electron_main',
};
const replacement: W5FileReplacement = {
  operation: 'test.replace',
  advance: [],
  previousRaw: null,
};

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'core-w5-file-store-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function recordingWriter(fail?: string): {
  calls: Array<Parameters<W5AtomicFileWriter>>;
  write: W5AtomicFileWriter;
} {
  const calls: Array<Parameters<W5AtomicFileWriter>> = [];
  return {
    calls,
    write: async (filePath, contents, options): Promise<void> => {
      calls.push([filePath, contents, options]);
      if (filePath === fail) throw new Error(`write failed: ${filePath}`);
      await writeFile(filePath, contents, options.encoding);
    },
  };
}

describe('createNodeW5FileStore', () => {
  it('reads absent, present and unreadable files', async () => {
    const store = createNodeW5FileStore(recordingWriter().write);
    const file = join(root, 'index.json');
    expect(await store.read(file)).toEqual({ state: 'absent' });
    await writeFile(file, '{"a":1}\n', 'utf8');
    expect(await store.read(file)).toEqual({
      state: 'present',
      raw: '{"a":1}\n',
    });
    const directory = join(root, 'directory');
    await mkdir(directory);
    expect(await store.read(directory)).toEqual({ state: 'unreadable' });
  });

  it('creates the parent and writes the backup before the target without durability', async () => {
    const writer = recordingWriter();
    const store = createNodeW5FileStore(writer.write);
    const target = join(root, 'nested', 'deeper', 'index.json');
    const backup = join(root, 'nested', 'deeper', 'index.json.bak');
    await store.replace(target, 'next', storage, {
      ...replacement,
      backup: { path: backup, contents: 'previous', previousRaw: null },
    });
    expect(writer.calls).toEqual([
      [backup, 'previous', { encoding: 'utf8', storage }],
      [target, 'next', { encoding: 'utf8', storage }],
    ]);
    for (const [, , options] of writer.calls) {
      expect(Object.keys(options).sort()).toEqual(['encoding', 'storage']);
      expect(options.storage).toBe(storage);
    }
    expect(await readFile(backup, 'utf8')).toBe('previous');
    expect(await readFile(target, 'utf8')).toBe('next');
  });

  it('writes only the target without a backup', async () => {
    const writer = recordingWriter();
    const target = join(root, 'list.json');
    await createNodeW5FileStore(writer.write).replace(
      target,
      'only',
      storage,
      replacement,
    );
    expect(writer.calls).toEqual([
      [target, 'only', { encoding: 'utf8', storage }],
    ]);
  });

  it('leaves the target untouched when the backup write fails', async () => {
    const backup = join(root, 'index.json.bak');
    const writer = recordingWriter(backup);
    const target = join(root, 'index.json');
    await writeFile(target, 'kept', 'utf8');
    await expect(
      createNodeW5FileStore(writer.write).replace(target, 'next', storage, {
        ...replacement,
        backup: { path: backup, contents: 'previous', previousRaw: 'kept' },
      }),
    ).rejects.toThrow(`write failed: ${backup}`);
    expect(writer.calls.map(([path]) => path)).toEqual([backup]);
    expect(await readFile(target, 'utf8')).toBe('kept');
  });
});

describe('JSON helpers', () => {
  it('accepts only plain JSON objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('row')).toBe(false);
  });

  it('retains unknown previous fields without restoring cleared known ones', () => {
    const known = new Set(['id', 'name', 'cleared']);
    expect(
      withUnknownFields(
        { id: 'a', name: 'next', cleared: undefined },
        { id: 'a', name: 'old', cleared: 'old', future: { x: 1 } },
        known,
      ),
    ).toEqual({ id: 'a', name: 'next', cleared: undefined, future: { x: 1 } });
    expect(
      withUnknownFields({ id: 'a' }, { id: 'a', cleared: 1 }, known),
    ).toEqual({ id: 'a' });
    expect(
      withUnknownFields({ future: 'next' }, { future: 'old' }, known),
    ).toEqual({ future: 'next' });
    expect(withUnknownFields({ id: 'a' }, undefined, known)).toEqual({
      id: 'a',
    });
  });
});

describe('createSerialQueue', () => {
  it('starts each task after earlier ones settle, including rejections', async () => {
    const enqueue = createSerialQueue();
    const events: string[] = [];
    let release = (): void => {};
    const first = enqueue(
      () =>
        new Promise<void>((resolve) => {
          events.push('first:start');
          release = (): void => {
            events.push('first:end');
            resolve();
          };
        }),
    );
    const second = enqueue(() => {
      events.push('second');
      return Promise.reject(new Error('second failed'));
    });
    const third = enqueue(() => {
      events.push('third');
      return Promise.resolve(3);
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['first:start']);
    release();
    await first;
    await expect(second).rejects.toThrow('second failed');
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(['first:start', 'first:end', 'second', 'third']);
  });
});

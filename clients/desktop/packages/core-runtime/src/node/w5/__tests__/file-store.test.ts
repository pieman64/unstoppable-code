import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNodeW5FileStore,
  createSerialQueue,
  isJsonObject,
  W5_HOSTLESS_READ_MESSAGE,
  W5_UNREACHABLE_READ_MESSAGE,
  W5AuthorityUnreachableError,
  W5RecordUnservedError,
  w5ReadUnreachable,
  w5UnreadableMessage,
  withUnknownFields,
  type W5AtomicFileWriter,
  type W5FileReplacement,
} from '../file-store';
import type { W5StorageTarget } from '../storage-target';
import { WorkspaceIndexUnreadableError } from '../workspace-index-repository';
import { WorkspaceConfigUnreadableError } from '../workspace-manifest-repository';
import { WorktreeRegistryUnreadableError } from '../worktree-list-repository';

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

describe('W5RecordUnservedError (CAN-5531)', () => {
  it('names each capture class the record port cannot serve, by file', () => {
    expect(
      [
        new W5RecordUnservedError('unsupported-id', 'worktrees'),
        new W5RecordUnservedError('unsupported-id', 'manifest'),
        new W5RecordUnservedError('limit-exceeded', 'worktrees'),
        new W5RecordUnservedError('limit-exceeded', 'manifest'),
        new W5RecordUnservedError('limit-exceeded', 'index'),
        new W5RecordUnservedError('limit-exceeded', 'index-backup'),
      ].map(({ name, reason, message }) => ({ name, reason, message })),
    ).toEqual([
      {
        name: 'W5RecordUnservedError',
        reason: 'unsupported-id',
        message:
          "Couldn't read this project's worktree list. The project's ID isn't supported.",
      },
      {
        name: 'W5RecordUnservedError',
        reason: 'unsupported-id',
        message:
          "Couldn't read this project's settings. The project's ID isn't supported.",
      },
      {
        name: 'W5RecordUnservedError',
        reason: 'limit-exceeded',
        message:
          "Couldn't read this project's worktree list. It's too large to read.",
      },
      {
        name: 'W5RecordUnservedError',
        reason: 'limit-exceeded',
        message:
          "Couldn't read this project's settings. It's too large to read.",
      },
      {
        name: 'W5RecordUnservedError',
        reason: 'limit-exceeded',
        message: "Couldn't read the project list. It's too large to read.",
      },
      {
        name: 'W5RecordUnservedError',
        reason: 'limit-exceeded',
        message: "Couldn't read the project list. It's too large to read.",
      },
    ]);
  });

  it('keeps the refusal it describes as its cause', () => {
    const refusal = new Error('The W5 capture exceeds its limits.');
    expect(
      new W5RecordUnservedError('limit-exceeded', 'index', refusal).cause,
    ).toBe(refusal);
    expect(
      'cause' in new W5RecordUnservedError('unsupported-id', 'worktrees'),
    ).toBe(false);
  });

  it('gives each unreadable-file refusal its specific message, and no other cause', () => {
    const unserved = new W5RecordUnservedError('unsupported-id', 'manifest');
    for (const Refusal of [
      WorktreeRegistryUnreadableError,
      WorkspaceConfigUnreadableError,
      WorkspaceIndexUnreadableError,
    ]) {
      expect(new Refusal(unserved).message).toBe(unserved.message);
      expect(new Refusal(new Error('EACCES')).message).toBe(
        new Refusal().message,
      );
    }
    expect(new WorktreeRegistryUnreadableError().message).toBe(
      'Worktree registry is unreadable',
    );
  });
});

describe('W5AuthorityUnreachableError (CAN-5542)', () => {
  it('says whether the change was refused or may have saved, keeping its cause', () => {
    const drop = new Error('Connection closed.');
    const refused = new W5AuthorityUnreachableError('refused', 'connect');
    const unknown = new W5AuthorityUnreachableError(
      'outcome-unknown',
      'lost',
      drop,
    );
    expect(refused).toMatchObject({
      name: 'W5AuthorityUnreachableError',
      certainty: 'refused',
      reason: 'connect',
      message:
        "Couldn't save this change because the background service isn't running. Reconnect from the notice, then try again.",
    });
    expect('cause' in refused).toBe(false);
    expect(unknown).toMatchObject({
      certainty: 'outcome-unknown',
      reason: 'lost',
      cause: drop,
      message:
        'This change may not have saved. The background service stopped before it confirmed. Reconnect, check the project, then try again.',
    });
  });

  it('gives each unreadable-file refusal its message instead of "could not be read"', () => {
    for (const certainty of ['refused', 'outcome-unknown'] as const) {
      const unreachable = new W5AuthorityUnreachableError(certainty, 'lost');
      for (const Refusal of [
        WorktreeRegistryUnreadableError,
        WorkspaceConfigUnreadableError,
        WorkspaceIndexUnreadableError,
      ]) {
        const refusal = new Refusal(unreachable);
        expect(refusal.message).toBe(unreachable.message);
        expect(refusal.cause).toBe(unreachable);
      }
    }
  });

  it('never gives a read-only refusal the save copy', () => {
    const unserved = new W5RecordUnservedError('limit-exceeded', 'manifest');
    for (const certainty of ['refused', 'outcome-unknown'] as const) {
      const unreachable = new W5AuthorityUnreachableError(certainty, 'connect');
      expect(w5UnreadableMessage('fallback', unreachable, 'read')).toBe(
        W5_UNREACHABLE_READ_MESSAGE,
      );
      expect(
        new WorkspaceConfigUnreadableError(unreachable, 'read').message,
      ).toBe(W5_UNREACHABLE_READ_MESSAGE);
    }
    expect(W5_UNREACHABLE_READ_MESSAGE).not.toMatch(/save/i);
    // A class the port can't serve reads the same either way.
    expect(w5UnreadableMessage('fallback', unserved, 'read')).toBe(
      unserved.message,
    );
    expect(w5UnreadableMessage('fallback', new Error('EACCES'), 'read')).toBe(
      'fallback',
    );
  });

  it('says a reached service that serves no project records needs a restart, not the notice', () => {
    const hostless = new W5AuthorityUnreachableError(
      'refused',
      'w5_host_unavailable',
    );
    expect(hostless.message).toBe(
      "Couldn't save this change because the background service can't save projects. Restart the app, then try again.",
    );
    expect(w5UnreadableMessage('fallback', hostless, 'read')).toBe(
      W5_HOSTLESS_READ_MESSAGE,
    );
    expect(W5_HOSTLESS_READ_MESSAGE).toBe(
      "Couldn't load this because the background service can't load projects. Restart the app, then try again.",
    );
    for (const message of [hostless.message, W5_HOSTLESS_READ_MESSAGE])
      expect(message).not.toMatch(/notice|isn't running|reconnect/i);
    expect(new WorkspaceConfigUnreadableError(hostless).message).toBe(
      hostless.message,
    );
    expect(new WorkspaceConfigUnreadableError(hostless, 'read').message).toBe(
      W5_HOSTLESS_READ_MESSAGE,
    );
    // Every other reason keeps the not-running copy.
    for (const reason of ['connect', 'lost', 'held'] as const)
      expect(
        w5UnreadableMessage(
          'fallback',
          new W5AuthorityUnreachableError('refused', reason),
          'read',
        ),
      ).toBe(W5_UNREACHABLE_READ_MESSAGE);
    // A change that may have saved says so, whatever the reason.
    expect(
      new W5AuthorityUnreachableError('outcome-unknown', 'w5_host_unavailable')
        .message,
    ).toMatch(/^This change may not have saved\./);
  });

  it('is found only on an unreadable read that carries it', () => {
    const unreachable = new W5AuthorityUnreachableError('refused', 'held');
    expect(w5ReadUnreachable({ state: 'unreadable', error: unreachable })).toBe(
      unreachable,
    );
    expect(
      w5ReadUnreachable({ state: 'unreadable', error: new Error('EACCES') }),
    ).toBeUndefined();
    expect(w5ReadUnreachable({ state: 'unreadable' })).toBeUndefined();
    expect(w5ReadUnreachable({ state: 'absent' })).toBeUndefined();
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

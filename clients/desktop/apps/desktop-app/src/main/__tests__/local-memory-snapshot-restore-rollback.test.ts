const mockWriteFailure: { failOn: ((filePath: string) => boolean) | null } = {
  failOn: null,
};
/** Runs as if outside the app: after a file is staged, or after a rename. */
const mockOutsideEdit: {
  afterStage: ((stagedPath: string) => Promise<void>) | null;
  afterRename: ((target: string) => Promise<void>) | null;
} = { afterStage: null, afterRename: null };

/** A staged memory file, not the scope's manifest or lock bookkeeping. */
function mockIsStagedMemoryFile(path: string): boolean {
  return (
    path.endsWith('.tmp') &&
    !/[\\/]\.lock[\\/]/.test(path) &&
    !/[\\/]manifest\.json\./.test(path)
  );
}

// A restore stages every file first, so a failed write surfaces when a staged
// file is renamed over its target, part way through the restore.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const staged = mockIsStagedMemoryFile(from);
      if (staged && mockWriteFailure.failOn?.(to)) {
        throw new Error('The disk is full');
      }
      await actual.rename(from, to);
      if (staged) await mockOutsideEdit.afterRename?.(to);
    },
    writeFile: async (
      ...args: Parameters<typeof actual.writeFile>
    ): Promise<void> => {
      await actual.writeFile(...args);
      const [file] = args;
      if (typeof file === 'string' && mockIsStagedMemoryFile(file)) {
        await mockOutsideEdit.afterStage?.(file);
      }
    },
  };
});

import type * as FsPromisesModule from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  createLocalMemorySnapshot,
  LOCAL_MEMORY_RESTORE_ROLLBACK_SCOPE_CHANGED_MESSAGE,
  LOCAL_MEMORY_RESTORE_SCOPE_CHANGED_MESSAGE,
  restoreLocalMemorySnapshot,
} from '../memory/local/snapshots';
import { prepareMemoryScopeForWrite } from '../memory/local/scope-manifest';

const PROFILE_TOPIC = 'chat-history-profile.md';
const PROFILE_LINE =
  '- [Chat history profile](topics/chat-history-profile.md): Role: Engineer.';

async function write(
  scopeDir: string,
  fileKey: string,
  content: string,
): Promise<void> {
  const path = join(scopeDir, fileKey);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/**
 * Every memory file in the scope outside the snapshots folder, with its
 * bytes; the manifest's revision is the scope's bookkeeping, not memory.
 */
async function scopeFiles(scopeDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.snapshots') await walk(path);
      } else if (path !== join(scopeDir, 'manifest.json')) {
        files[relative(scopeDir, path)] = await readFile(path, 'utf8');
      }
    }
  }
  await walk(scopeDir);
  return files;
}

/** Saves a snapshot holding exactly these files, then removes them. */
async function snapshotOf(
  scopeDir: string,
  files: Record<string, string>,
): Promise<string> {
  for (const [fileKey, content] of Object.entries(files)) {
    await write(scopeDir, fileKey, content);
  }
  const snapshot = await createLocalMemorySnapshot(scopeDir, 'consolidation');
  if (snapshot === null) throw new Error('Expected a snapshot');
  await rm(join(scopeDir, 'MEMORY.md'), { force: true });
  await rm(join(scopeDir, 'topics'), { recursive: true, force: true });
  return snapshot.id;
}

describe('a snapshot restore that fails part way', () => {
  let scopeDir: string;

  beforeEach(async () => {
    mockWriteFailure.failOn = null;
    mockOutsideEdit.afterStage = null;
    mockOutsideEdit.afterRename = null;
    scopeDir = await mkdtemp(join(tmpdir(), 'local-memory-restore-rollback-'));
    // A scope this build already gave identities, as every scope is once
    // written: the restore under test then changes only memory files.
    await prepareMemoryScopeForWrite(scopeDir);
  });

  afterEach(async () => {
    mockWriteFailure.failOn = null;
    mockOutsideEdit.afterStage = null;
    mockOutsideEdit.afterRename = null;
    await rm(scopeDir, { recursive: true, force: true });
  });

  it('leaves an empty scope empty', async () => {
    const id = await snapshotOf(scopeDir, {
      'MEMORY.md': `# Memory\n\n- [A](topics/a.md)\n${PROFILE_LINE}\n`,
      'topics/a.md': 'A',
      'topics/b.md': 'B',
      [`topics/${PROFILE_TOPIC}`]: 'Saved profile',
    });
    const before = await scopeFiles(scopeDir);
    expect(before).toEqual({});
    mockWriteFailure.failOn = (filePath: string): boolean =>
      basename(filePath) === 'MEMORY.md';

    await expect(restoreLocalMemorySnapshot(scopeDir, id)).rejects.toThrow(
      'The disk is full',
    );

    expect(await scopeFiles(scopeDir)).toEqual(before);
  });

  it('puts a scope without a profile back exactly, dropping the profile the restore wrote', async () => {
    const id = await snapshotOf(scopeDir, {
      'MEMORY.md': `# Memory\n\n- [A](topics/a.md)\n${PROFILE_LINE}\n`,
      'topics/a.md': 'Restored A',
      [`topics/${PROFILE_TOPIC}`]: 'Saved profile',
    });
    await write(scopeDir, 'MEMORY.md', '# Current\n\n- [A](topics/a.md)\n');
    await write(scopeDir, 'topics/a.md', 'Current A');
    await write(scopeDir, 'topics/c.md', 'Current C');
    await write(scopeDir, 'inbox/2026-09-01-note.md', 'Pending note');
    const before = await scopeFiles(scopeDir);
    mockWriteFailure.failOn = (filePath: string): boolean =>
      basename(filePath) === 'MEMORY.md';

    await expect(restoreLocalMemorySnapshot(scopeDir, id)).rejects.toThrow(
      'The disk is full',
    );

    expect(await scopeFiles(scopeDir)).toEqual(before);
  });

  it('puts a scope with a profile back exactly when a topic write fails', async () => {
    const id = await snapshotOf(scopeDir, {
      'MEMORY.md': '# Memory\n\n- [A](topics/a.md)\n- [B](topics/b.md)\n',
      'topics/a.md': 'Restored A',
      'topics/b.md': 'Restored B',
    });
    await write(scopeDir, 'MEMORY.md', `# Current\n\n${PROFILE_LINE}\n`);
    await write(scopeDir, `topics/${PROFILE_TOPIC}`, 'Current profile');
    await write(scopeDir, 'topics/c.md', 'Current C');
    const before = await scopeFiles(scopeDir);
    mockWriteFailure.failOn = (filePath: string): boolean =>
      basename(filePath) === 'b.md';

    await expect(restoreLocalMemorySnapshot(scopeDir, id)).rejects.toThrow(
      'The disk is full',
    );

    expect(await scopeFiles(scopeDir)).toEqual(before);
  });

  it('overwrites nothing when a file is edited after the restore staged its files', async () => {
    const id = await snapshotOf(scopeDir, {
      'MEMORY.md': '# Memory\n\n- [A](topics/a.md)\n',
      'topics/a.md': 'Restored A',
    });
    await write(scopeDir, 'MEMORY.md', '# Current\n\n- [A](topics/a.md)\n');
    await write(scopeDir, 'topics/a.md', 'Current A');
    await write(scopeDir, 'topics/c.md', 'Current C');
    // The index is staged last: the edit lands after every file is staged
    // and before the first rename.
    mockOutsideEdit.afterStage = async (stagedPath): Promise<void> => {
      if (basename(stagedPath).startsWith('MEMORY.md.')) {
        await write(scopeDir, 'topics/a.md', 'A edited meanwhile');
      }
    };
    const expected = {
      ...(await scopeFiles(scopeDir)),
      'topics/a.md': 'A edited meanwhile',
    };

    await expect(restoreLocalMemorySnapshot(scopeDir, id)).rejects.toThrow(
      LOCAL_MEMORY_RESTORE_SCOPE_CHANGED_MESSAGE,
    );

    // Nothing overwritten or deleted, and no staged file left behind.
    expect(await scopeFiles(scopeDir)).toEqual(expected);
  });

  it('stops before the next rename when a file is edited part way, leaving the edit', async () => {
    const id = await snapshotOf(scopeDir, {
      'MEMORY.md': '# Memory\n\n- [A](topics/a.md)\n- [B](topics/b.md)\n',
      'topics/a.md': 'Restored A',
      'topics/b.md': 'Restored B',
    });
    await write(scopeDir, 'MEMORY.md', '# Current\n');
    await write(scopeDir, 'topics/a.md', 'Current A');
    await write(scopeDir, 'topics/b.md', 'Current B');
    mockOutsideEdit.afterRename = async (target): Promise<void> => {
      if (basename(target) === 'a.md') {
        await write(scopeDir, 'topics/b.md', 'B edited meanwhile');
      }
    };
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    try {
      await expect(restoreLocalMemorySnapshot(scopeDir, id)).rejects.toThrow(
        LOCAL_MEMORY_RESTORE_ROLLBACK_SCOPE_CHANGED_MESSAGE,
      );
    } finally {
      emitWarningSpy.mockRestore();
    }

    // b.md and the index were never replaced; the edit survives, and the
    // rollback refused to touch a scope that no longer matches.
    expect(await scopeFiles(scopeDir)).toEqual({
      'MEMORY.md': '# Current\n',
      'topics/a.md': 'Restored A',
      'topics/b.md': 'B edited meanwhile',
    });
  });
});

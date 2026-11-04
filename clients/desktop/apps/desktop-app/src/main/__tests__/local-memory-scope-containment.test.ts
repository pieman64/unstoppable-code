import type { LocalMemoryDocument } from '@canopy/desktop-shared/types';
import type * as DocumentParser from '../memory/local/document-parser';
import type * as FsPromises from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MemoryManifestFileSchema } from '@canopy/protocol/memory-sync';
import { withMemoryWriteLock } from '../memory/local/edit-coordination';
import { listLocalMemoryFiles } from '../memory/local/explorer';
import { withMemoryScopeLock } from '../memory/local/scope-lock';
import { appendInboxNote } from '../memory/local/store';

jest.mock('../memory/local/parse-runner', () => ({
  parseMemoryDocumentInWorker: (
    fileKey: string,
    content: string,
  ): Promise<LocalMemoryDocument> =>
    Promise.resolve(
      jest
        .requireActual<typeof DocumentParser>('../memory/local/document-parser')
        .parseMemoryDocument(fileKey, content),
    ),
}));

/** Lets a test change the tree right after a note is read. */
let mockOnReadFile: ((path: string) => Promise<void>) | null = null;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: async (
      ...args: Parameters<typeof actual.readFile>
    ): ReturnType<typeof actual.readFile> => {
      const content = await actual.readFile(...args);
      const hook = mockOnReadFile;
      if (hook && typeof args[0] === 'string') await hook(args[0]);
      return content;
    },
  };
});

jest.setTimeout(60_000);

const OLD = new Date('2026-01-01T00:00:00.000Z');
const isWindows = process.platform === 'win32';

/** A directory link: a junction on Windows, which needs no privilege. */
async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, isWindows ? 'junction' : 'dir');
}

/** A file link, or false where the OS refuses to create one. */
async function linkFile(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (error) {
    if (
      isWindows &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    ) {
      return false;
    }
    throw error;
  }
}

/** Every entry under `root`, with its kind, mode, mtime and content. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    const key = relative(root, path) || '.';
    const shape = `${info.isDirectory() ? 'dir' : 'file'}:${(info.mode & 0o777).toString(8)}:${info.mtimeMs}`;
    if (info.isDirectory()) {
      entries[key] = shape;
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name));
      }
    } else {
      entries[key] = `${shape}:${await readFile(path, 'utf8')}`;
    }
  };
  await visit(root);
  return entries;
}

async function writeOld(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
  await chmod(path, 0o644);
  await utimes(path, OLD, OLD);
}

/** A directory outside every scope, holding notes a backfill would rewrite. */
async function outsideFolder(root: string): Promise<string> {
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeOld(join(outside, 'report.md'), 'Quarterly report\n');
  await writeOld(
    join(outside, '2026-01-01T00-00-00-plan.md'),
    '---\ncreated: "2026-01-01T00:00:00.000Z"\n---\n\nPlan\n',
  );
  await chmod(outside, 0o755);
  await utimes(outside, OLD, OLD);
  return outside;
}

async function readManifest(
  scopeDir: string,
): Promise<ReturnType<typeof MemoryManifestFileSchema.parse>> {
  return MemoryManifestFileSchema.parse(
    JSON.parse(await readFile(join(scopeDir, 'manifest.json'), 'utf8')),
  );
}

describe('local memory scope containment', () => {
  let root: string;
  let scopeDir: string;
  let warning: jest.SpyInstance;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'local-memory-containment-')),
    );
    scopeDir = join(root, 'memory');
    await mkdir(scopeDir);
    await writeFile(join(scopeDir, 'manifest.json'), '{ "version": 1 }\n');
    warning = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  });

  afterEach(async () => {
    mockOnReadFile = null;
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  function linkWarnings(): unknown[] {
    return warning.mock.calls.filter((call: unknown[]) =>
      JSON.stringify(call).includes('LOCAL_MEMORY_LINK_SKIPPED'),
    );
  }

  it('opening the Memory panel never follows a linked inbox out of the scope, and still readies the rest', async () => {
    const outside = await outsideFolder(root);
    const before = await snapshot(outside);
    await linkDirectory(outside, join(scopeDir, 'inbox'));
    await mkdir(join(scopeDir, 'topics'));
    await writeFile(join(scopeDir, 'topics', 'kept.md'), '# Kept\n');

    const files = await listLocalMemoryFiles(scopeDir);
    await listLocalMemoryFiles(scopeDir);

    expect(await snapshot(outside)).toEqual(before);
    expect(files.map((file) => file.fileKey)).toEqual(['topics/kept.md']);
    expect((await lstat(join(scopeDir, 'inbox'))).isSymbolicLink()).toBe(true);
    // A linked folder is skipped, not a failure: the scope's backfill completes.
    expect((await readManifest(scopeDir)).backfilledAt).not.toBeNull();
    expect(linkWarnings()).toHaveLength(1);
  });

  it('never follows a linked archive out of the scope while it backfills the pending notes', async () => {
    const outside = await outsideFolder(root);
    const before = await snapshot(outside);
    await mkdir(join(scopeDir, 'inbox'));
    await writeOld(
      join(scopeDir, 'inbox', '2026-01-02T00-00-00-pending.md'),
      'Pending\n',
    );
    await linkDirectory(outside, join(scopeDir, 'inbox', '.consolidated'));

    await withMemoryWriteLock(scopeDir, () => Promise.resolve());

    expect(await snapshot(outside)).toEqual(before);
    const pending = await readdir(join(scopeDir, 'inbox'));
    expect(pending.filter((name) => name.endsWith('.md'))).toHaveLength(1);
    expect(
      await readFile(
        join(
          scopeDir,
          'inbox',
          pending.find((name) => name.endsWith('.md')) ?? '',
        ),
        'utf8',
      ),
    ).toMatch(/^---\nid: "[0-9A-Z]{26}"\n/);
    expect((await readManifest(scopeDir)).backfilledAt).not.toBeNull();
  });

  it('leaves a linked note file and its target as they are', async () => {
    const outside = await outsideFolder(root);
    const before = await snapshot(outside);
    await mkdir(join(scopeDir, 'inbox'));
    const linked = [
      join(scopeDir, 'inbox', 'linked note.md'),
      join(scopeDir, 'inbox', '2026-01-03T00-00-00-linked.md'),
    ];
    if (
      !(await linkFile(join(outside, 'report.md'), linked[0] ?? '')) ||
      !(await linkFile(
        join(outside, '2026-01-01T00-00-00-plan.md'),
        linked[1] ?? '',
      ))
    ) {
      // Windows without symlink privilege cannot create file links.
      return;
    }

    await listLocalMemoryFiles(scopeDir);
    await withMemoryWriteLock(scopeDir, () => Promise.resolve());

    expect(await snapshot(outside)).toEqual(before);
    for (const path of linked) {
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
    }
  });

  it('refuses a note rewrite once its folder is swapped for a link mid-backfill', async () => {
    const outside = await outsideFolder(root);
    const before = await snapshot(outside);
    await mkdir(join(scopeDir, 'inbox'));
    await writeOld(join(scopeDir, 'inbox', 'swapped note.md'), 'Swapped\n');
    mockOnReadFile = async (path): Promise<void> => {
      if (!path.endsWith('swapped note.md')) return;
      mockOnReadFile = null;
      await rename(join(scopeDir, 'inbox'), join(root, 'moved-inbox'));
      await linkDirectory(outside, join(scopeDir, 'inbox'));
    };

    await withMemoryWriteLock(scopeDir, () => Promise.resolve());

    expect(await snapshot(outside)).toEqual(before);
    // Refused part way, so the next write tries the scope again.
    expect((await readManifest(scopeDir)).backfilledAt).toBeNull();
  });

  it('saves no note through a linked inbox', async () => {
    const outside = await outsideFolder(root);
    const before = await snapshot(outside);
    await linkDirectory(outside, join(scopeDir, 'inbox'));

    await expect(
      appendInboxNote(scopeDir, {
        text: 'Never leaves the scope',
        source: { provider: 'claude', chatId: 'chat-1' },
      }),
    ).resolves.toBe('');

    expect(await snapshot(outside)).toEqual(before);
  });

  it.each(['.lock', '.lock.takeover'])(
    'never creates or marks the scope lock through a %s link',
    async (name) => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      await chmod(outside, 0o755);
      await utimes(outside, OLD, OLD);
      const before = await snapshot(outside);
      await linkDirectory(outside, join(scopeDir, name));

      let heldIsDirectory = false;
      await withMemoryScopeLock(scopeDir, async () => {
        heldIsDirectory = (await lstat(join(scopeDir, '.lock'))).isDirectory();
        await readFile(join(scopeDir, '.lock', 'owner.json'), 'utf8');
      });

      expect(heldIsDirectory).toBe(true);
      expect(await snapshot(outside)).toEqual(before);
      await expect(lstat(join(scopeDir, '.lock'))).rejects.toThrow(/ENOENT/);
    },
  );
});

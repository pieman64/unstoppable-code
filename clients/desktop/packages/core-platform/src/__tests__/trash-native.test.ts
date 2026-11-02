import { existsSync, realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  type PlatformExecutionProcessServices,
  PlatformTrashError,
  type PlatformTrashErrorCode,
} from '@canopy/core-runtime';
import { hostPlatformOperatingSystem } from '../platform-services';
import { createExecutionProcessServices } from '../supervision/execution-process';
import { loadRecycleItem } from '../supervision/owned-child';
import { createNativeTrashServices } from '../trash';
import { darwinTrashAttempt } from '../trash/darwin';
import { createTrashServices, type TrashAttempt } from '../trash/trash';

// Native Trash evidence (CAN-4726) on the host OS: each case moves a fresh
// entry through the real backend, checks that the trashed item is the same
// inode (moved, not copied) and that link targets stay intact, then removes
// what it put in the trash. darwin uses osascript; linux needs gio (a host
// without it checks the unavailable report instead), with HOME and
// XDG_DATA_HOME pointed into the test directory; win32 needs the prebuilt
// owned-child addon (CANOPY_OWNED_CHILD_ADDON, required when
// CANOPY_OWNED_CHILD_ACCEPTANCE=1, else the `build:owned-child` output).

const os = hostPlatformOperatingSystem();
const ROOT = path.resolve(__dirname, '../../../..');
const forOs = (target: typeof os): typeof describe =>
  os === target ? describe : describe.skip;

function evidence(line: string): void {
  process.stderr.write(`[trash evidence] ${line}\n`);
}

async function code(promise: Promise<void>): Promise<PlatformTrashErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlatformTrashError) return error.code;
    throw error;
  }
  throw new Error('expected a Trash rejection');
}

const inode = async (entry: string): Promise<bigint> =>
  (await lstat(entry, { bigint: true })).ino;

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'canopy-trash-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

forOs('darwin')('darwin trashItemAtURL', () => {
  let processes: PlatformExecutionProcessServices;
  beforeAll(() => {
    processes = createExecutionProcessServices({ os });
  });
  afterAll(() => processes.shutdown());

  /** The shared Trash over the real darwin backend, recording where each entry went. */
  function recordingTrash(): {
    readonly trash: ReturnType<typeof createTrashServices>;
    readonly locations: string[];
  } {
    const locations: string[] = [];
    const trash = createTrashServices(
      os,
      () =>
        async (entry): Promise<TrashAttempt> => {
          const attempt = await darwinTrashAttempt(processes, entry);
          if (attempt.kind !== 'moved') return attempt;
          // Cleanup needs the resulting URL, which macOS reports here.
          if (attempt.location === undefined)
            throw new Error('macOS named no trash location');
          locations.push(attempt.location);
          return attempt;
        },
    );
    return { trash, locations };
  }

  // Only what this suite moved, and only inside a trash directory.
  const discard = async (locations: readonly string[]): Promise<void> => {
    for (const location of locations) {
      expect(location).toMatch(/\/\.Trash(?:es)?\//);
      await rm(location, { recursive: true, force: true });
    }
  };

  it('moves a file, a directory, a symlink and a broken symlink, each as itself', async () => {
    const file = path.join(root, `file ${process.pid}.txt`);
    const directory = path.join(root, `directory ${process.pid}`);
    const target = path.join(root, `target ${process.pid}`);
    const link = path.join(root, `link ${process.pid}`);
    const broken = path.join(root, `broken ${process.pid}`);
    await writeFile(file, 'file');
    await mkdir(directory);
    await writeFile(path.join(directory, 'inside'), 'inside');
    await mkdir(target);
    await symlink(target, link);
    await symlink(path.join(root, 'nothing'), broken);
    const { trash, locations } = recordingTrash();
    try {
      for (const entry of [file, directory, link, broken]) {
        const before = await inode(entry);
        await trash.trashItem(entry);
        expect(existsSync(entry)).toBe(false);
        await expect(lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
        const location = locations.at(-1) ?? '';
        expect(await inode(location)).toBe(before);
      }
      const [, movedDirectory, movedLink, movedBroken] = locations;
      expect(
        await readFile(path.join(movedDirectory ?? '', 'inside'), 'utf8'),
      ).toBe('inside');
      expect((await lstat(movedLink ?? '')).isSymbolicLink()).toBe(true);
      expect(await readlink(movedLink ?? '')).toBe(target);
      expect((await stat(target)).isDirectory()).toBe(true);
      expect((await lstat(movedBroken ?? '')).isSymbolicLink()).toBe(true);
      evidence(
        `darwin moved file, directory and links to ${locations.join(', ')}`,
      );
    } finally {
      await discard(locations);
    }
  });

  it('keeps names with spaces, quotes and non-ASCII text, and names a second same-name entry apart', async () => {
    const name = `it's "quoted" é ü ✓ ${process.pid}`;
    const first = path.join(root, 'a', name);
    const second = path.join(root, 'b', name);
    await mkdir(path.dirname(first));
    await mkdir(path.dirname(second));
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    const { trash, locations } = recordingTrash();
    try {
      await trash.trashItem(first);
      await trash.trashItem(second);
      expect(locations).toHaveLength(2);
      expect(path.basename(locations[0] ?? '')).toBe(name);
      expect(locations[1]).not.toBe(locations[0]);
      expect(await readFile(locations[0] ?? '', 'utf8')).toBe('first');
      expect(await readFile(locations[1] ?? '', 'utf8')).toBe('second');
      evidence(`darwin kept names: ${locations.join(', ')}`);
    } finally {
      await discard(locations);
    }
  });

  it('moves an entry whose name ends in a backslash', async () => {
    const entry = path.join(root, `backslash ${process.pid}\\`);
    await writeFile(entry, 'backslash');
    const before = await inode(entry);
    const { trash, locations } = recordingTrash();
    try {
      await trash.trashItem(entry);
      await expect(lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(locations).toHaveLength(1);
      expect(await inode(locations[0] ?? '')).toBe(before);
      evidence(`darwin moved a trailing-backslash name to ${locations[0]}`);
    } finally {
      await discard(locations);
    }
  });

  it('refuses a missing entry as failed and changes nothing', async () => {
    const missing = path.join(root, 'missing');
    expect(await code(createNativeTrashServices(os).trashItem(missing))).toBe(
      'failed',
    );
    // The backend's own refusal, past the up-front read.
    await expect(darwinTrashAttempt(processes, missing)).resolves.toEqual({
      kind: 'refused',
      code: 'failed',
      reason: 'macOS refused to move the entry to the trash.',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('moves an entry through the composed factory', async () => {
    const name = `factory ${process.pid}-${Date.now()}`;
    const entry = path.join(root, name);
    await writeFile(entry, 'factory');
    const before = await inode(entry);
    await createNativeTrashServices(os).trashItem(entry);
    expect(existsSync(entry)).toBe(false);
    // A unique name on the home volume lands under its own name.
    const location = path.join(homedir(), '.Trash', name);
    try {
      expect(await inode(location)).toBe(before);
      evidence(`darwin factory moved ${location}`);
    } finally {
      await rm(location, { force: true });
    }
  });
});

forOs('linux')('linux gio trash', () => {
  const gio = ['/usr/bin/gio', '/bin/gio'].find((file) => existsSync(file));
  const saved = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  let data = '';
  beforeEach(async () => {
    // HOME on the entry's device selects the home trash; XDG_DATA_HOME places it.
    data = path.join(root, 'data');
    await mkdir(data);
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = data;
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });

  (gio ? it : it.skip)(
    'moves a file, a directory and a symlink into the home trash, each as itself',
    async () => {
      const file = path.join(root, 'file one.txt');
      const directory = path.join(root, 'directory é');
      const target = path.join(root, 'target');
      const link = path.join(root, 'link');
      await writeFile(file, 'file');
      await mkdir(directory);
      await writeFile(path.join(directory, 'inside'), 'inside');
      await mkdir(target);
      await symlink(target, link);
      const trash = createNativeTrashServices(os);
      for (const entry of [file, directory, link]) {
        const before = await inode(entry);
        await trash.trashItem(entry);
        expect(existsSync(entry)).toBe(false);
        const moved = path.join(data, 'Trash', 'files', path.basename(entry));
        expect(await inode(moved)).toBe(before);
      }
      const movedLink = path.join(data, 'Trash', 'files', 'link');
      expect((await lstat(movedLink)).isSymbolicLink()).toBe(true);
      expect(await readlink(movedLink)).toBe(target);
      expect((await stat(target)).isDirectory()).toBe(true);
      expect((await readdir(path.join(data, 'Trash', 'info'))).sort()).toEqual([
        'directory é.trashinfo',
        'file one.txt.trashinfo',
        'link.trashinfo',
      ]);
      evidence(`linux ${gio} moved file, directory and symlink`);
    },
  );

  (gio ? it : it.skip)(
    'moves an entry whose name ends in a backslash',
    async () => {
      const entry = path.join(root, 'backslash\\');
      await writeFile(entry, 'backslash');
      const before = await inode(entry);
      await createNativeTrashServices(os).trashItem(entry);
      await expect(lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
      const moved = path.join(data, 'Trash', 'files', 'backslash\\');
      expect(await inode(moved)).toBe(before);
      evidence(`linux ${gio} moved a trailing-backslash name`);
    },
  );

  (gio ? it : it.skip)('refuses a missing entry as failed', async () => {
    expect(
      await code(createNativeTrashServices(os).trashItem(path.join(root, 'x'))),
    ).toBe('failed');
  });

  (gio ? it.skip : it)('reports Trash unavailable without gio', async () => {
    const entry = path.join(root, 'kept');
    await writeFile(entry, 'kept');
    expect(await code(createNativeTrashServices(os).trashItem(entry))).toBe(
      'unavailable',
    );
    expect(await readFile(entry, 'utf8')).toBe('kept');
    evidence('linux has no gio; Trash reported unavailable');
  });
});

/**
 * CANOPY_OWNED_CHILD_ADDON, or else outside acceptance the default
 * `build:owned-child` output when it already carries `recycleItem`.
 */
function windowsAddon(): string | undefined {
  const configured = process.env.CANOPY_OWNED_CHILD_ADDON;
  if (configured) return path.resolve(ROOT, configured);
  if (process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1') return undefined;
  const built = path.join(
    ROOT,
    '.cache',
    'native-owned-child',
    `${process.platform}-${process.arch}`,
    'core-owned-child.node',
  );
  if (!existsSync(built)) return undefined;
  try {
    loadRecycleItem(os, built);
    return built;
  } catch {
    return undefined;
  }
}

forOs('win32')('win32 IFileOperation recycle', () => {
  // A skipped describe body still runs, so other hosts look for no addon.
  const addon = os === 'win32' ? windowsAddon() : undefined;
  const present = addon !== undefined && existsSync(addon);
  if (!present && process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1')
    throw new Error('Trash acceptance requires CANOPY_OWNED_CHILD_ADDON');
  beforeAll(() => {
    evidence(`win32 addon: ${addon ?? 'none, so the addon cases skip'}`);
  });
  const recycleRoots: { readonly form: string; readonly long: string }[] = [];
  // The record may hold the long or the 8.3 form of the temp directory.
  const recycle = (directory: string): void => {
    const long = `${realpathSync.native(directory).toLowerCase()}\\`;
    for (const form of [`${directory.toLowerCase()}\\`, long])
      recycleRoots.push({ form, long });
  };
  /** `entry` as `recycledRecords` names it. */
  const recordName = (entry: string): string =>
    path
      .join(realpathSync.native(path.dirname(entry)), path.basename(entry))
      .toLowerCase();

  /**
   * The Recycle Bin records naming a path under this run's directories,
   * lowercased with the long form of each root. `$I` v2: version, size,
   * time, then a 4-byte character count and the UTF-16 path.
   */
  interface RecycledRecord {
    readonly original: string;
    readonly record: string;
    readonly item: string;
  }
  const recycledRecords = async (): Promise<RecycledRecord[]> => {
    const found: RecycledRecord[] = [];
    const bins = path.join(path.parse(tmpdir()).root, '$Recycle.Bin');
    let users: string[] = [];
    try {
      users = await readdir(bins);
    } catch {
      return [];
    }
    for (const user of users) {
      let names: string[] = [];
      try {
        names = await readdir(path.join(bins, user));
      } catch {
        continue;
      }
      for (const name of names.filter((item) => item.startsWith('$I'))) {
        const record = await readFile(path.join(bins, user, name));
        if (record.length < 28 || record.readBigUInt64LE(0) !== 2n) continue;
        const lower = record
          .subarray(28, 28 + record.readUInt32LE(24) * 2)
          .toString('utf16le')
          .replace(/\0+$/, '')
          .toLowerCase();
        const root = recycleRoots.find(({ form }) => lower.startsWith(form));
        if (root === undefined) continue;
        found.push({
          original: `${root.long}${lower.slice(root.form.length)}`,
          record: path.join(bins, user, name),
          item: path.join(bins, user, `$R${name.slice(2)}`),
        });
      }
    }
    return found;
  };

  // Removes what this suite recycled, and nothing else.
  afterAll(async () => {
    for (const { record, item } of await recycledRecords()) {
      await rm(item, { recursive: true, force: true });
      await rm(record, { force: true });
    }
  });

  (present ? it : it.skip)(
    'recycles a file, a directory and a junction, each as itself',
    async () => {
      recycle(root);
      const trash = createNativeTrashServices(os, { ownedChildPath: addon });
      const file = path.join(root, 'file one.txt');
      const directory = path.join(root, 'directory é');
      const target = path.join(root, 'target');
      const junction = path.join(root, 'junction');
      await writeFile(file, 'file');
      await mkdir(directory);
      await writeFile(path.join(directory, 'inside'), 'inside');
      await mkdir(target);
      await writeFile(path.join(target, 'kept'), 'kept');
      await symlink(target, junction, 'junction');
      const entries = [file, directory, junction];
      const names = entries.map(recordName);
      for (const entry of entries) {
        await trash.trashItem(entry);
        await expect(lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(path.join(target, 'kept'), 'utf8')).toBe('kept');
      // In the Recycle Bin, not deleted.
      const records = await recycledRecords();
      expect(
        names.filter((name) => !records.some((r) => r.original === name)),
      ).toEqual([]);
      const recycledJunction = records.find(
        (r) => r.original === recordName(junction),
      );
      expect((await lstat(recycledJunction?.item ?? '')).isSymbolicLink()).toBe(
        true,
      );
      evidence(
        `win32 recycled a file, a directory and a junction: ${records.map((r) => r.item).join(', ')}`,
      );
    },
  );

  // The shell may not parse a path past MAX_PATH; either way the report is true.
  (present ? it : it.skip)(
    'reports a long path truthfully: recycled and gone, or refused and in place',
    async () => {
      recycle(root);
      const long = path.join(
        root,
        'l'.repeat(80),
        'o'.repeat(80),
        'n'.repeat(80),
      );
      await mkdir(path.dirname(long), { recursive: true });
      await writeFile(long, 'long');
      const trash = createNativeTrashServices(os, { ownedChildPath: addon });
      let outcome: string;
      try {
        await trash.trashItem(long);
        await expect(lstat(long)).rejects.toMatchObject({ code: 'ENOENT' });
        outcome = 'recycled';
      } catch (error) {
        if (!(error instanceof PlatformTrashError)) throw error;
        expect(['unavailable', 'failed']).toContain(error.code);
        expect(await readFile(long, 'utf8')).toBe('long');
        outcome = error.code;
      }
      evidence(`win32 ${long.length}-character path: ${outcome}`);
    },
  );

  (present ? it : it.skip)(
    'refuses a network path it cannot recycle and leaves the entry in place',
    async () => {
      const entry = path.join(root, 'network.txt');
      await writeFile(entry, 'kept');
      const drive = entry.slice(0, 1);
      const unc = `\\\\localhost\\${drive}$${entry.slice(2)}`;
      if (!existsSync(unc)) {
        evidence(
          'win32 administrative share unavailable; network case not run',
        );
        return;
      }
      const result = await code(
        createNativeTrashServices(os, { ownedChildPath: addon }).trashItem(unc),
      );
      expect(['unavailable', 'failed']).toContain(result);
      expect(await readFile(entry, 'utf8')).toBe('kept');
      evidence(`win32 refused a UNC path as ${result}`);
    },
  );

  (present ? it : it.skip)('refuses a missing entry as failed', async () => {
    expect(
      await code(
        createNativeTrashServices(os, { ownedChildPath: addon }).trashItem(
          path.join(root, 'missing'),
        ),
      ),
    ).toBe('failed');
  });

  it('is unavailable when the addon is not staged', async () => {
    const entry = path.join(root, 'kept');
    await writeFile(entry, 'kept');
    expect(await code(createNativeTrashServices(os).trashItem(entry))).toBe(
      'unavailable',
    );
    expect(await readFile(entry, 'utf8')).toBe('kept');
  });
});

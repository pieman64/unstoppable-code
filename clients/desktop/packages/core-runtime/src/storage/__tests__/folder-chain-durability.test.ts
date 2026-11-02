import {
  ensureFolderChainDurable,
  folderIdentityOf,
  type ConfirmedFolders,
  type FolderChainOptions,
  type FolderChainPorts,
} from '..';

/** A POSIX-shaped folder tree: each folder and the identity it has now. */
class FakeFolders {
  readonly folders = new Map<string, string>();
  readonly flushed: string[] = [];
  private next = 0;
  /** Each call fails once with this error, then succeeds. */
  failFlushOnce = new Map<string, Error>();
  /** Fails the next `mkdir` after creating this many missing folders. */
  failMkdirAfter: number | undefined;
  /** Runs inside `mkdir`, as another process creating folders first. */
  beforeMkdir: (() => void) | undefined;

  constructor(...existing: string[]) {
    for (const folder of existing) this.create(folder);
  }

  create(folder: string): void {
    this.next += 1;
    this.folders.set(folder, `1:${this.next}:${this.next}`);
  }

  readonly ports: FolderChainPorts = {
    mkdir: (folder) => {
      this.beforeMkdir?.();
      const missing: string[] = [];
      for (let f = folder; !this.folders.has(f); f = dirname(f)) {
        missing.unshift(f);
      }
      for (let index = 0; index < missing.length; index += 1) {
        if (index === this.failMkdirAfter) {
          this.failMkdirAfter = undefined;
          return Promise.reject(new Error('ENOSPC'));
        }
        this.create(missing[index]);
      }
      return Promise.resolve();
    },
    identity: (folder) => {
      const id = this.folders.get(folder);
      return id === undefined
        ? Promise.reject(new Error(`ENOENT ${folder}`))
        : Promise.resolve(id);
    },
    dirname,
    flush: (folder) => {
      const failure = this.failFlushOnce.get(folder);
      if (failure !== undefined) {
        this.failFlushOnce.delete(folder);
        return Promise.reject(failure);
      }
      this.flushed.push(folder);
      return Promise.resolve();
    },
  };
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

const HOME = '/Users/u';
const DATA = '/Users/u/.canopy';

function options(confirmed: ConfirmedFolders): FolderChainOptions {
  return { dataRoot: DATA, confirmed };
}

describe('ensureFolderChainDurable (CAN-5153)', () => {
  it('flushes the anchor for a data root something else created', async () => {
    // Registration created the data root without flushing its parent.
    const fs = new FakeFolders('/', '/Users', HOME, DATA);
    await ensureFolderChainDurable([DATA], fs.ports, options(new Map()));
    expect(fs.flushed).toEqual([HOME]);
  });

  it('flushes each holder on the chain once, deepest first, anchor last', async () => {
    const fs = new FakeFolders('/', '/Users', HOME);
    await ensureFolderChainDurable(
      [`${DATA}/workspaces`, `${DATA}/w5`],
      fs.ports,
      options(new Map()),
    );
    expect(fs.flushed).toEqual([DATA, HOME]);
  });

  it('flushes nothing on a second call', async () => {
    const fs = new FakeFolders('/', '/Users', HOME);
    const confirmed: ConfirmedFolders = new Map();
    await ensureFolderChainDurable(
      [`${DATA}/a/b`],
      fs.ports,
      options(confirmed),
    );
    fs.flushed.length = 0;
    await ensureFolderChainDurable(
      [`${DATA}/a/b`],
      fs.ports,
      options(confirmed),
    );
    await ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed));
    expect(fs.flushed).toEqual([]);
  });

  it('never flushes above the anchor', async () => {
    const fs = new FakeFolders('/');
    await ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(new Map()));
    expect(fs.flushed).toEqual([DATA, HOME]);
    expect(fs.folders.has('/Users')).toBe(true);
  });

  it('retries a failed flush on the next call', async () => {
    const fs = new FakeFolders('/', '/Users', HOME);
    const confirmed: ConfirmedFolders = new Map();
    const eio = new Error('EIO');
    fs.failFlushOnce.set(HOME, eio);
    await expect(
      ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed)),
    ).rejects.toBe(eio);
    expect(fs.flushed).toEqual([DATA]);
    fs.flushed.length = 0;
    await ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed));
    expect(fs.flushed).toEqual([HOME]);
  });

  it('records nothing for a mkdir that created some folders and failed', async () => {
    const fs = new FakeFolders('/', '/Users', HOME);
    const confirmed: ConfirmedFolders = new Map();
    fs.failMkdirAfter = 1;
    await expect(
      ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed)),
    ).rejects.toThrow('ENOSPC');
    expect(fs.folders.has(DATA)).toBe(true);
    expect(fs.flushed).toEqual([]);
    expect(confirmed.size).toBe(0);
    await ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed));
    expect(fs.flushed).toEqual([DATA, HOME]);
  });

  it('flushes a folder another creator made first', async () => {
    const fs = new FakeFolders('/', '/Users', HOME);
    fs.beforeMkdir = (): void => {
      fs.beforeMkdir = undefined;
      fs.create(DATA);
      fs.create(`${DATA}/a`);
    };
    await ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(new Map()));
    expect(fs.flushed).toEqual([DATA, HOME]);
  });

  it('flushes a folder again once it was deleted and recreated', async () => {
    const fs = new FakeFolders('/', '/Users', HOME);
    const confirmed: ConfirmedFolders = new Map();
    await ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed));
    fs.flushed.length = 0;
    fs.folders.delete(`${DATA}/a`);
    await ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed));
    expect(fs.flushed).toEqual([DATA]);
  });

  it.each([['/Users/u/other'], [HOME], ['/Users/u/.canopy-dev/a']])(
    'refuses a target outside the data root: %s',
    async (target) => {
      const fs = new FakeFolders('/', '/Users', HOME);
      await expect(
        ensureFolderChainDurable([target], fs.ports, options(new Map())),
      ).rejects.toBeInstanceOf(TypeError);
      expect(fs.folders.size).toBe(3);
      expect(fs.flushed).toEqual([]);
    },
  );

  it('refuses a data root with no parent to anchor it', async () => {
    const fs = new FakeFolders('/');
    await expect(
      ensureFolderChainDurable(['/'], fs.ports, {
        dataRoot: '/',
        confirmed: new Map(),
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  // CAN-5151 D1 (Mike, 2026-10-30): no refusal of the anchor is tolerated.
  it.each([
    ['open', 'EPERM'],
    ['open', 'EACCES'],
    ['flush', 'EPERM'],
  ])(
    'fails closed when the anchor refuses its flush at %s with %s',
    async (stage, code) => {
      const fs = new FakeFolders('/', '/Users', HOME, DATA);
      const confirmed: ConfirmedFolders = new Map();
      const denied = Object.assign(new Error(`${code} ${stage}`), {
        name: 'DirectoryFlushError',
        stage,
        code,
      });
      fs.failFlushOnce.set(HOME, denied);
      await expect(
        ensureFolderChainDurable([`${DATA}/a`], fs.ports, options(confirmed)),
      ).rejects.toBe(denied);
      expect(confirmed.has(DATA)).toBe(false);
      fs.flushed.length = 0;
      await ensureFolderChainDurable(
        [`${DATA}/a`],
        fs.ports,
        options(confirmed),
      );
      expect(fs.flushed).toEqual([HOME]);
    },
  );
});

describe('folderIdentityOf', () => {
  it('joins device, inode and birth time', () => {
    expect(folderIdentityOf({ dev: 1n, ino: 22n, birthtimeNs: 333n })).toBe(
      '1:22:333',
    );
  });
});

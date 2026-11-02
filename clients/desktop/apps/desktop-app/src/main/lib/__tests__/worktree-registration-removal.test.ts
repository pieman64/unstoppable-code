import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  hasWorktreeRegistration,
  removeAbsentWorktreeRegistrations,
} from '../worktree-registration-removal';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
  return {
    ...actual,
    rename: jest.fn(actual.rename),
    rm: jest.fn(actual.rm),
    writeFile: jest.fn(actual.writeFile),
  };
});
const actualFsPromises =
  jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
const mockedFsPromises =
  jest.requireMock<typeof NodeFsPromises>('node:fs/promises');
const renameMock = jest.mocked(mockedFsPromises.rename);
const rmMock = jest.mocked(mockedFsPromises.rm);
const writeFileMock = jest.mocked(mockedFsPromises.writeFile);

let root: string;
let repo: string;

const runGit = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const commonDir = (): string => join(repo, '.git');
const entry = (id: string): string => join(commonDir(), 'worktrees', id);
const entries = (): string[] => readdirSync(join(commonDir(), 'worktrees'));
const registered = (): string[] =>
  runGit(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
const lockedLines = (): string[] =>
  runGit(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line === 'locked' || line.startsWith('locked '));
const checkout = (name: string): string => join(root, 'checkouts', name);
const addCheckout = (name: string, path = checkout(name)): void => {
  runGit(repo, ['worktree', 'add', '-q', '-b', name, path, 'main']);
};
const isEntryPath = (path: unknown): path is string =>
  typeof path === 'string' && dirname(path) === join(commonDir(), 'worktrees');

/** Runs `race` once, just after the cleanup locks its first entry. */
function afterFirstLock(race: (lockedEntry: string) => void): void {
  let raced = false;
  writeFileMock.mockImplementation(async (path, data, options) => {
    await actualFsPromises.writeFile(path, data, options);
    if (
      raced ||
      typeof path !== 'string' ||
      !path.endsWith('locked') ||
      !isEntryPath(dirname(path))
    )
      return;
    raced = true;
    race(dirname(path));
  });
}

/**
 * Runs `race` once, just before the cleanup starts removing its first entry:
 * its first `rename` or `rm` of an entry.
 */
function beforeFirstDelete(race: (deletedEntry: string) => void): void {
  let raced = false;
  const raceOnce = (path: unknown): void => {
    if (raced || !isEntryPath(path)) return;
    raced = true;
    race(path);
  };
  renameMock.mockImplementation(async (from, to) => {
    raceOnce(from);
    return actualFsPromises.rename(from, to);
  });
  rmMock.mockImplementation(async (path, options) => {
    raceOnce(path);
    return actualFsPromises.rm(path, options);
  });
}

/** Runs `race` once, just after the cleanup moves its first entry aside. */
function afterMoveAside(
  race: (aside: string, movedEntry: string) => void,
): void {
  let raced = false;
  renameMock.mockImplementation(async (from, to) => {
    await actualFsPromises.rename(from, to);
    if (
      raced ||
      !isEntryPath(from) ||
      typeof to !== 'string' ||
      !basename(to).startsWith('.canopy-removing-')
    )
      return;
    raced = true;
    race(to, from);
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-registration-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  runGit(repo, ['init', '-q', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'Test']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'commit.gpgsign', 'false']);
  runGit(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
  mkdirSync(join(root, 'checkouts'));
});

afterEach(() => {
  renameMock.mockImplementation(actualFsPromises.rename);
  rmMock.mockImplementation(actualFsPromises.rm);
  writeFileMock.mockImplementation(actualFsPromises.writeFile);
  rmSync(root, { recursive: true, force: true });
});

describe('removeAbsentWorktreeRegistrations', () => {
  it("removes a named absent checkout's entry and keeps a moved checkout's awaiting repair", async () => {
    addCheckout('own');
    addCheckout('paused');
    rmSync(checkout('own'), { recursive: true });
    renameSync(checkout('paused'), join(root, 'paused-quarantine'));

    await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

    expect(registered()).not.toContain(checkout('own'));
    expect(registered()).toContain(checkout('paused'));
    runGit(repo, ['worktree', 'repair', join(root, 'paused-quarantine')]);
    expect(registered()).toContain(join(root, 'paused-quarantine'));
  });

  it('removes the entry of a checkout moved without repair only by its named pre-move path', async () => {
    addCheckout('own');
    addCheckout('paused');
    const moved = join(root, 'own-quarantine');
    renameSync(checkout('own'), moved);
    renameSync(checkout('paused'), join(root, 'paused-quarantine'));

    await removeAbsentWorktreeRegistrations(commonDir(), [moved]);
    expect(registered()).toContain(checkout('own'));

    await removeAbsentWorktreeRegistrations(commonDir(), [
      moved,
      checkout('own'),
    ]);
    expect(registered()).not.toContain(checkout('own'));
    expect(registered()).toContain(checkout('paused'));
  });

  it("keeps a moved checkout's entry while its pre-move path is occupied", async () => {
    addCheckout('own');
    const moved = join(root, 'own-quarantine');
    renameSync(checkout('own'), moved);
    mkdirSync(checkout('own'));

    await removeAbsentWorktreeRegistrations(commonDir(), [
      moved,
      checkout('own'),
    ]);

    expect(registered()).toContain(checkout('own'));
    expect(lockedLines()).toEqual([]);
  });

  it('follows relative Git links', async () => {
    runGit(repo, ['config', 'worktree.useRelativePaths', 'true']);
    addCheckout('own');
    addCheckout('stale');
    rmSync(checkout('stale'), { recursive: true });
    const moved = join(root, 'checkouts', 'own-quarantine');
    renameSync(checkout('own'), moved);

    await removeAbsentWorktreeRegistrations(commonDir(), [
      moved,
      checkout('own'),
      checkout('stale'),
    ]);

    expect(registered()).toEqual([repo]);
  });

  it("keeps another checkout's entry that reused a removed entry's id after a crash (CAN-5034)", async () => {
    addCheckout('own');
    const moved = join(root, 'own-quarantine');
    renameSync(checkout('own'), moved);
    // A cleanup removed the moved checkout's entry, then crashed before its
    // quarantine was removed.
    rmSync(entry('own'), { recursive: true });
    const reuser = join(root, 'elsewhere', 'own');
    mkdirSync(dirname(reuser));
    runGit(repo, ['worktree', 'add', '-q', '-b', 'reuser', reuser, 'main']);
    expect(entries()).toEqual(['own']);
    // Moved into another quarantine, awaiting its repair.
    renameSync(reuser, join(root, 'reuser-quarantine'));

    await removeAbsentWorktreeRegistrations(commonDir(), [
      moved,
      checkout('own'),
    ]);

    expect(registered()).toContain(reuser);
    runGit(repo, ['worktree', 'repair', join(root, 'reuser-quarantine')]);
    expect(registered()).toContain(join(root, 'reuser-quarantine'));
  });

  it.each([
    [
      'ENOTDIR',
      (): string => {
        writeFileSync(join(root, 'a-file'), '');
        return join(root, 'a-file', 'unrelated');
      },
    ],
    [
      'ELOOP',
      (): string => {
        execFileSync('ln', ['-s', 'loop', join(root, 'loop')]);
        return join(root, 'loop', 'unrelated');
      },
    ],
  ])(
    'still removes a named entry when an unrelated registered path raises %s (CAN-5034)',
    async (_code, unresolvablePath) => {
      addCheckout('own');
      addCheckout('unrelated');
      rmSync(checkout('own'), { recursive: true });
      writeFileSync(
        join(entry('unrelated'), 'gitdir'),
        `${join(unresolvablePath(), '.git')}\n`,
      );

      await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

      expect(entries()).toEqual(['unrelated']);
    },
  );

  it('still removes the other named entries when a named path raises ENOTDIR or ELOOP (CAN-5034)', async () => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    writeFileSync(join(root, 'a-file'), '');
    execFileSync('ln', ['-s', 'loop', join(root, 'loop')]);

    await removeAbsentWorktreeRegistrations(commonDir(), [
      join(root, 'a-file', 'moved'),
      join(root, 'loop', 'moved'),
      checkout('own'),
    ]);

    expect(registered()).toEqual([repo]);
  });

  it('reports a failed delete, not the failed release of its lock', async () => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    const deleteFailure = Object.assign(new Error('entry busy'), {
      code: 'EBUSY',
    });
    rmMock.mockImplementation(async (path, options) => {
      if (typeof path === 'string' && path.endsWith('locked'))
        throw new Error('lock busy');
      if (isEntryPath(path)) throw deleteFailure;
      return actualFsPromises.rm(path, options);
    });

    await expect(
      removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]),
    ).rejects.toBe(deleteFailure);
  });

  it('counts an entry left moved aside by a stopped removal as registered, and the next pass removes it', async () => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    const stopped = new Error('stopped after the move');
    rmMock.mockImplementationOnce(() => Promise.reject(stopped));

    await expect(
      removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]),
    ).rejects.toBe(stopped);
    expect(entries()).toEqual([
      expect.stringMatching(/^\.canopy-removing-own-/) as unknown,
    ]);
    await expect(
      hasWorktreeRegistration(commonDir(), [checkout('own')]),
    ).resolves.toBe(true);

    await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);
    expect(entries()).toEqual([]);
    expect(registered()).toEqual([repo]);
  });

  it.each([
    [
      'a lock a crashed cleanup left',
      'canopy: removing stale registration x\n',
    ],
    ['a user lock', ''],
  ])('removes a stale entry held by %s', async (_case, reason) => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    writeFileSync(join(entry('own'), 'locked'), reason);

    await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

    expect(registered()).toEqual([repo]);
  });

  it("leaves a Git checkout's locked entry openable while the cleanup holds it", async () => {
    addCheckout('own');
    const moved = join(root, 'own-quarantine');
    renameSync(checkout('own'), moved);
    let head = '';
    beforeFirstDelete(() => {
      head = runGit(moved, ['rev-parse', '--abbrev-ref', 'HEAD']);
    });

    await removeAbsentWorktreeRegistrations(commonDir(), [
      moved,
      checkout('own'),
    ]);

    expect(head).toBe('own');
    expect(registered()).toEqual([repo]);
  });

  it('releases only its own lock when the path reappears before its final check', async () => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    afterFirstLock(() => mkdirSync(checkout('own')));

    await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

    expect(registered()).toContain(checkout('own'));
    expect(existsSync(join(entry('own'), 'locked'))).toBe(false);
  });

  it('keeps the entry and releases its lock when the path reappears after its final check', async () => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    beforeFirstDelete(() => mkdirSync(checkout('own')));

    await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

    expect(entries()).toEqual(['own']);
    expect(registered()).toContain(checkout('own'));
    expect(existsSync(join(entry('own'), 'locked'))).toBe(false);
  });

  it('moves the entry back and reports the failure when it cannot check the moved entry', async () => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    renameMock.mockImplementationOnce(async (from, to) => {
      await actualFsPromises.rename(from, to);
      chmodSync(String(to), 0o000);
    });

    try {
      await expect(
        removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]),
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(entries()).toEqual(['own']);
    } finally {
      for (const name of entries())
        chmodSync(join(commonDir(), 'worktrees', name), 0o755);
    }
    expect(registered()).toContain(checkout('own'));
  });

  it('stops before removing anything once its signal is aborted', async () => {
    addCheckout('own');
    rmSync(checkout('own'), { recursive: true });
    const controller = new AbortController();
    controller.abort();

    await expect(
      removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(registered()).toContain(checkout('own'));
  });

  it('stops before its next entry when its signal is aborted', async () => {
    addCheckout('first');
    addCheckout('second');
    rmSync(checkout('first'), { recursive: true });
    rmSync(checkout('second'), { recursive: true });
    const controller = new AbortController();
    afterFirstLock(() => controller.abort());

    await expect(
      removeAbsentWorktreeRegistrations(
        commonDir(),
        [checkout('first'), checkout('second')],
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(registered()).toHaveLength(2);
    expect(lockedLines()).toEqual([]);
  });

  it.each([
    ['locks', afterFirstLock],
    ['deletes', beforeFirstDelete],
  ])(
    'fails as aborted when its signal is aborted as it %s its only entry (CAN-5034)',
    async (_step, hook) => {
      addCheckout('own');
      rmSync(checkout('own'), { recursive: true });
      const controller = new AbortController();
      hook(() => controller.abort());

      await expect(
        removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')], {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(registered()).toEqual([repo]);
    },
  );

  it('does nothing without any linked worktree', async () => {
    await expect(
      removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]),
    ).resolves.toBeUndefined();
  });

  describe('and `git worktree add` at the same path', () => {
    beforeEach(() => {
      addCheckout('own');
      rmSync(checkout('own'), { recursive: true });
    });

    const addReplacement = (
      force: string[] = ['-f'],
      branch = 'replacement',
    ): void => {
      runGit(repo, [
        'worktree',
        'add',
        '-q',
        ...force,
        '-b',
        branch,
        checkout('own'),
        'main',
      ]);
    };
    const expectReplacementRegisteredOnce = (): void => {
      expect(registered().filter((path) => path === checkout('own'))).toEqual([
        checkout('own'),
      ]);
      expect(
        runGit(checkout('own'), ['rev-parse', '--abbrev-ref', 'HEAD']),
      ).toBe('replacement');
    };

    it('refuses an `add -f` while the cleanup holds the entry, then accepts it', async () => {
      let refusal = '';
      beforeFirstDelete(() => {
        try {
          // Git creates the branch before it refuses the path.
          addReplacement(['-f'], 'refused');
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
      });

      await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

      expect(refusal).toMatch(/missing but locked worktree/);
      expect(existsSync(checkout('own'))).toBe(false);
      expect(registered()).toEqual([repo]);
      addReplacement([]);
      expectReplacementRegisteredOnce();
    });

    it('keeps a replacement Git added after removing the entry it checked before the lock', async () => {
      afterFirstLock((lockedEntry) => {
        rmSync(lockedEntry, { recursive: true });
        addReplacement([]);
      });

      await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

      expect(entries()).toEqual(['own']);
      expectReplacementRegisteredOnce();
      expect(lockedLines()).toEqual([]);
    });

    it('keeps a replacement Git added under the same id after the final check, which still counts as registered (review r5 finding 3)', async () => {
      beforeFirstDelete((checkedEntry) => {
        rmSync(checkedEntry, { recursive: true });
        addReplacement([]);
      });

      await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

      expect(entries()).toEqual(['own']);
      expectReplacementRegisteredOnce();
      expect(lockedLines()).toEqual([]);
      await expect(
        hasWorktreeRegistration(commonDir(), [checkout('own')]),
      ).resolves.toBe(true);
    });

    it('keeps an entry Git re-created under the same id that it has not finished adding', async () => {
      afterFirstLock((lockedEntry) => {
        const gitdir = readFileSync(join(lockedEntry, 'gitdir'), 'utf8');
        rmSync(lockedEntry, { recursive: true });
        mkdirSync(lockedEntry);
        writeFileSync(join(lockedEntry, 'locked'), 'initializing');
        writeFileSync(join(lockedEntry, 'gitdir'), gitdir);
      });

      await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

      expect(readFileSync(join(entry('own'), 'locked'), 'utf8')).toBe(
        'initializing',
      );
    });

    it('keeps an entry re-created under the same id after the final check that names the same absent checkout', async () => {
      beforeFirstDelete((checkedEntry) => {
        const gitdir = readFileSync(join(checkedEntry, 'gitdir'), 'utf8');
        rmSync(checkedEntry, { recursive: true });
        mkdirSync(checkedEntry);
        writeFileSync(join(checkedEntry, 'gitdir'), gitdir);
      });

      await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

      expect(entries()).toEqual(['own']);
      expect(existsSync(join(entry('own'), 'locked'))).toBe(false);
      await expect(
        hasWorktreeRegistration(commonDir(), [checkout('own')]),
      ).resolves.toBe(true);
    });

    describe('when Git re-creates the empty entry under the same id after the move aside (review r6 finding 1)', () => {
      const asideEntries = (): string[] =>
        entries().filter((name) => name.startsWith('.canopy-removing-own-'));
      const expectGitEntryKeptAndOldEntryAside = (gitdir: string): void => {
        expect(readdirSync(entry('own'))).toEqual([]);
        const [aside] = asideEntries();
        expect(asideEntries()).toHaveLength(1);
        expect(
          readFileSync(join(commonDir(), 'worktrees', aside, 'gitdir'), 'utf8'),
        ).toBe(gitdir);
      };

      const reappearAndRecreateAfterMoveAside = (): void => {
        afterMoveAside((_aside, movedEntry) => {
          // The path reappears empty, and an `add` there makes its entry
          // (`mkdir`, before it writes `locked`).
          mkdirSync(checkout('own'));
          mkdirSync(movedEntry);
        });
      };

      it('keeps it when the moved entry is no longer the checked one, and the moved entry still counts as registered', async () => {
        const gitdir = readFileSync(join(entry('own'), 'gitdir'), 'utf8');
        reappearAndRecreateAfterMoveAside();

        await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);

        expectGitEntryKeptAndOldEntryAside(gitdir);
        await expect(
          hasWorktreeRegistration(commonDir(), [checkout('own')]),
        ).resolves.toBe(true);
      });

      it("leaves the old entry locked, so `git worktree prune` keeps Git's finished entry instead of dropping it as a duplicate", async () => {
        reappearAndRecreateAfterMoveAside();

        await removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]);
        // Git finishes its add: the same files, for the same path.
        const [aside] = asideEntries();
        const asidePath = join(commonDir(), 'worktrees', aside);
        for (const name of readdirSync(asidePath))
          if (name !== 'locked')
            cpSync(join(asidePath, name), join(entry('own'), name), {
              recursive: true,
            });
        writeFileSync(
          join(checkout('own'), '.git'),
          `gitdir: ${entry('own')}\n`,
        );
        // Prune drops an unlocked duplicate's later id, here Git's `own`.
        runGit(repo, ['worktree', 'prune']);

        expect(entries().sort()).toEqual([aside, 'own']);
        expect(runGit(checkout('own'), ['rev-parse', '--git-dir'])).toBe(
          entry('own'),
        );
      });

      it('keeps it when the moved entry cannot be checked, and reports the failure', async () => {
        const gitdir = readFileSync(join(entry('own'), 'gitdir'), 'utf8');
        afterMoveAside((aside, movedEntry) => {
          // A lock that can't be read; macOS refuses to move an unreadable
          // directory over another, which would hide the race.
          rmSync(join(aside, 'locked'));
          mkdirSync(join(aside, 'locked'));
          mkdirSync(movedEntry);
        });

        await expect(
          removeAbsentWorktreeRegistrations(commonDir(), [checkout('own')]),
        ).rejects.toMatchObject({ code: 'EISDIR' });
        expectGitEntryKeptAndOldEntryAside(gitdir);
        await expect(
          hasWorktreeRegistration(commonDir(), [checkout('own')]),
        ).resolves.toBe(true);
      });
    });
  });
});

describe('hasWorktreeRegistration (CAN-5334)', () => {
  it("finds a named checkout's entry, present or absent, through a symlinked root or a relative link, and none for another", async () => {
    addCheckout('present');
    addCheckout('gone');
    rmSync(checkout('gone'), { recursive: true });
    runGit(repo, ['config', 'worktree.useRelativePaths', 'true']);
    addCheckout('relative');
    rmSync(checkout('relative'), { recursive: true });
    const link = join(root, 'link');
    symlinkSync(join(root, 'checkouts'), link, 'junction');

    for (const name of ['present', 'gone', 'relative'])
      await expect(
        hasWorktreeRegistration(commonDir(), [join(link, name)]),
      ).resolves.toBe(true);
    await expect(
      hasWorktreeRegistration(commonDir(), [checkout('other')]),
    ).resolves.toBe(false);
  });

  it.each([
    [
      'ENOTDIR',
      (): string => {
        writeFileSync(join(root, 'a-file'), '');
        return join(root, 'a-file', 'unrelated');
      },
    ],
    [
      'ELOOP',
      (): string => {
        execFileSync('ln', ['-s', 'loop', join(root, 'loop')]);
        return join(root, 'loop', 'unrelated');
      },
    ],
  ])(
    'still finds a named entry beside an unrelated entry whose path raises %s, or one without a gitdir',
    async (_code, unresolvablePath) => {
      addCheckout('own');
      addCheckout('unrelated');
      rmSync(checkout('own'), { recursive: true });
      writeFileSync(
        join(entry('unrelated'), 'gitdir'),
        `${join(unresolvablePath(), '.git')}\n`,
      );
      mkdirSync(join(commonDir(), 'worktrees', 'being-added'));

      await expect(
        hasWorktreeRegistration(commonDir(), [checkout('own')]),
      ).resolves.toBe(true);
      await expect(
        hasWorktreeRegistration(commonDir(), [checkout('other')]),
      ).resolves.toBe(false);
    },
  );

  it("rejects when any entry's gitdir cannot be read, which the removal leaves in place, even after finding a named one", async () => {
    addCheckout('a-found');
    addCheckout('z-unreadable');
    rmSync(checkout('z-unreadable'), { recursive: true });
    rmSync(join(entry('z-unreadable'), 'gitdir'));
    mkdirSync(join(entry('z-unreadable'), 'gitdir'));

    await removeAbsentWorktreeRegistrations(commonDir(), [
      checkout('z-unreadable'),
    ]);

    expect(entries()).toContain('z-unreadable');
    // The cleanup's look after removing `a-found` would reach it, so the
    // description's look must too.
    for (const named of ['a-found', 'z-unreadable'])
      await expect(
        hasWorktreeRegistration(commonDir(), [checkout(named)]),
      ).rejects.toThrow();
  });
});

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserOwnedScratch,
  type BrowserScratchOwner,
} from '../owned-scratch';

const owner: BrowserScratchOwner = {
  browserId: 'browser',
  profileId: 'profile',
  storageGeneration: 1,
  runtimeGeneration: 1,
  taskIncarnationId: 'incarnation',
  taskScope: { kind: 'worktree', projectId: 'project', worktreeId: 'task' },
};
const withOwner = <T>(
  _owner: BrowserScratchOwner,
  commit: () => Promise<T>,
): Promise<T> => commit();

describe('durable app-owned browser scratch', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'browser-scratch-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serializes quota reservations across instances before any bytes are written', async () => {
    const first = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner,
      profileLimitBytes: 10,
      globalLimitBytes: 20,
    });
    const second = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner,
      profileLimitBytes: 10,
      globalLimitBytes: 20,
    });
    const results = await Promise.allSettled([
      first.write(owner, 'png', Buffer.alloc(7)),
      second.write(owner, 'md', Buffer.alloc(7)),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: 'storage_unavailable',
        }) as unknown,
      }),
    ]);
    expect(await readdir(join(root, 'scratch', 'files'))).toHaveLength(1);
    const catalog: { records: Record<string, { status: string }> } =
      parseCatalog(await readFile(join(root, 'scratch', 'jobs.json'), 'utf8'));
    expect(Object.values(catalog.records)).toEqual([
      expect.objectContaining({ bytes: 7, owner, status: 'complete' }),
    ]);
  });

  it('applies the global limit across profiles and reclaims only browser-owned files', async () => {
    const scratch = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner,
      profileLimitBytes: 10,
      globalLimitBytes: 12,
    });
    const file = await scratch.write(owner, 'png', Buffer.alloc(8));
    const userFile = join(root, 'user-download.png');
    await writeFile(userFile, await readFile(file));
    await expect(
      scratch.write({ ...owner, profileId: 'other' }, 'png', Buffer.alloc(8)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await scratch.cleanup((source) => source.browserId === owner.browserId);
    expect(await readFile(userFile)).toEqual(Buffer.alloc(8));
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await scratch.write(
        { ...owner, profileId: 'other' },
        'png',
        Buffer.alloc(8),
      ),
    ).toBeTruthy();
  });

  it('removes a completed write whose captured generation becomes stale before publication', async () => {
    let calls = 0;
    const scratch = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner: async <T>(
        _source: BrowserScratchOwner,
        commit: () => Promise<T>,
      ): Promise<T> => {
        if (++calls > 1) throw new Error('stale generation');
        return commit();
      },
    });
    await expect(scratch.write(owner, 'png', Buffer.alloc(8))).rejects.toThrow(
      'stale generation',
    );
    expect(await readdir(join(root, 'scratch', 'files'))).toEqual([]);
    const catalog: { records: Record<string, { status: string }> } =
      parseCatalog(await readFile(join(root, 'scratch', 'jobs.json'), 'utf8'));
    expect(catalog.records).toEqual({});
  });

  it('reclaims interrupted reservations from known records while preserving unknown files', async () => {
    const scratch = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner,
    });
    const file = await scratch.write(owner, 'md', Buffer.from('recording'));
    const catalogPath = join(root, 'scratch', 'jobs.json');
    const catalog: { records: Record<string, { status: string }> } =
      parseCatalog(await readFile(catalogPath, 'utf8'));
    Object.values(
      catalog.records as Record<string, { status: string }>,
    ).forEach((record) => {
      record.status = 'reserved';
    });
    await writeFile(catalogPath, JSON.stringify(catalog));
    const unknown = join(root, 'scratch', 'files', 'unknown.md');
    await writeFile(unknown, 'preserve');
    await new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner,
    }).recover();
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unknown, 'utf8')).toBe('preserve');
  });

  it('rejects a replaced scratch directory without touching its target', async () => {
    await mkdir(join(root, 'unrelated'));
    await writeFile(join(root, 'unrelated', 'keep'), 'user file');
    await symlink(join(root, 'unrelated'), join(root, 'scratch'), 'junction');
    const scratch = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner,
    });
    await expect(
      scratch.write(owner, 'png', Buffer.alloc(1)),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(scratch.cleanup(() => true)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await readFile(join(root, 'unrelated', 'keep'), 'utf8')).toBe(
      'user file',
    );
  });
  it('cancels publication of an in-flight write before cleaning its reservation', async () => {
    let reachPublication!: () => void;
    const atPublication = new Promise<void>((resolve) => {
      reachPublication = resolve;
    });
    let resumePublication!: () => void;
    const continuePublication = new Promise<void>((resolve) => {
      resumePublication = resolve;
    });
    let checks = 0;
    const scratch = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner: async <T>(
        _source: BrowserScratchOwner,
        commit: () => Promise<T>,
      ): Promise<T> => {
        if (++checks === 2) {
          reachPublication();
          await continuePublication;
        }
        return commit();
      },
    });
    const writing = scratch.write(owner, 'png', Buffer.alloc(8));
    const rejected = expect(writing).rejects.toMatchObject({
      code: 'cancelled',
    });
    await atPublication;
    const cleaning = scratch.cleanup(
      (source) => source.browserId === owner.browserId,
    );
    const deadline = Date.now() + 2000;
    for (;;) {
      const state: { records: Record<string, { status: string }> } =
        parseCatalog(
          await readFile(join(root, 'scratch', 'jobs.json'), 'utf8'),
        );
      if (
        Object.values(state.records as Record<string, { status: string }>).some(
          (record) => record.status === 'deleting',
        )
      )
        break;
      if (Date.now() > deadline)
        throw new Error('Cleanup did not fence publication');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    resumePublication();
    await rejected;
    await cleaning;
    expect(await readdir(join(root, 'scratch', 'files'))).toEqual([]);
  });

  it('preserves unreadable scratch metadata and refuses a new reservation', async () => {
    const scratch = new BrowserOwnedScratch(join(root, 'scratch'), {
      withOwner,
    });
    const existing = await scratch.write(owner, 'md', Buffer.from('keep'));
    const metadata = join(root, 'scratch', 'jobs.json');
    await writeFile(metadata, '{damaged');
    await expect(
      scratch.write(owner, 'png', Buffer.alloc(1)),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await readFile(existing, 'utf8')).toBe('keep');
    expect(await readFile(metadata, 'utf8')).toBe('{damaged');
  });
});

function parseCatalog(raw: string): {
  records: Record<string, { status: string }>;
} {
  return JSON.parse(raw) as { records: Record<string, { status: string }> };
}

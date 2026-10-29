import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VISUAL_STAGING_RETENTION_MS,
  VISUAL_STAGING_SWEEP_INTERVAL_MS,
  type StageVisualDocument,
} from '../lib/chat-visual-contracts';
import {
  VISUAL_PREPARED_MAX_BYTES,
  VISUAL_HEIGHTS_MAX_ENTRIES,
} from '@canopy/agent-transcript/lib/visual-ref';
import { ChatVisualStagingSweep } from '../lib/chat-visual-staging-sweep';
import { VisualStagingStoreImpl } from '../lib/visual-staging';

const visualId = 'vis_00000000-0000-0000-0000-000000000001';
const otherVisualId = 'vis_00000000-0000-0000-0000-000000000002';

function document(
  overrides: Partial<StageVisualDocument> = {},
): StageVisualDocument {
  return {
    visualId,
    html: '<!doctype html><h1>Tree 🌲</h1>',
    title: ' Forest ',
    maxHeight: 640,
    ...overrides,
  };
}

async function withStaging(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'visual-staging-'));
  try {
    await run(join(root, 'visual-staging'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hash(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => release?.(),
  };
}

describe('visual staging store', (): void => {
  it('rejects more than the allowed measured heights', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const store = new VisualStagingStoreImpl(directory);
      const heights: Array<[number, number]> = Array.from(
        { length: VISUAL_HEIGHTS_MAX_ENTRIES + 1 },
        () => [100, 200],
      );
      await expect(
        store.stage({ chatId: 'chat-1' }, document({ heights }), 100),
      ).rejects.toThrow('heights');
    });
  });
  it('stages and reads Unicode HTML with a byte-accurate sidecar', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const store = new VisualStagingStoreImpl(directory);
      const source = document();
      const sidecar = await store.stage({ chatId: 'chat-1' }, source, 100);

      expect(sidecar).toEqual({
        version: 1,
        visualId,
        chatId: 'chat-1',
        toolKey: 'show_visual',
        createdAt: 100,
        sha256: hash(source.html),
        byteLength: Buffer.byteLength(source.html, 'utf8'),
        title: 'Forest',
        maxHeight: 640,
      });
      expect(await store.readCandidate('chat-1', visualId)).toEqual({
        sidecar,
        html: source.html,
      });
      expect(store.hasEntries()).toBe(true);
      expect(Array.from(store.stagedIds())).toEqual([visualId]);
    });
  });

  it('keeps a leading byte-order mark in staged HTML', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const store = new VisualStagingStoreImpl(directory);
      const source = document({ html: '\uFEFF<!doctype html><p>BOM</p>' });
      const sidecar = await store.stage({ chatId: 'chat-1' }, source, 100);

      expect(sidecar.byteLength).toBe(Buffer.byteLength(source.html, 'utf8'));
      expect(await store.readCandidate('chat-1', visualId)).toEqual({
        sidecar,
        html: source.html,
      });
    });
  });

  it('does not return candidates for the wrong chat or tampered HTML', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const store = new VisualStagingStoreImpl(directory);
      await store.stage({ chatId: 'chat-1' }, document(), 100);
      expect(await store.readCandidate('chat-2', visualId)).toBeUndefined();

      await writeFile(join(directory, `${visualId}.html`), '<h1>Changed</h1>');
      expect(await store.readCandidate('chat-1', visualId)).toBeUndefined();
    });
  });

  it('allows an identical re-stage and rejects changes to bytes or metadata', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const store = new VisualStagingStoreImpl(directory);
      const source = document();
      const first = await store.stage({ chatId: 'chat-1' }, source, 100);
      expect(await store.stage({ chatId: 'chat-1' }, source, 200)).toEqual(
        first,
      );
      await expect(
        store.stage(
          { chatId: 'chat-1' },
          document({ html: '<p>Different</p>' }),
          200,
        ),
      ).rejects.toThrow('already staged');
      await expect(
        store.stage(
          { chatId: 'chat-1' },
          document({ title: 'Different' }),
          200,
        ),
      ).rejects.toThrow('already staged');
    });
  });

  it('rejects invalid ids, titles, measured heights, malformed UTF-16 and oversized HTML', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const store = new VisualStagingStoreImpl(directory);
      await expect(
        store.stage(
          { chatId: 'chat-1' },
          document({ visualId: 'vis_bad' }),
          100,
        ),
      ).rejects.toThrow('visual id');
      await expect(
        store.stage({ chatId: 'chat-1' }, document({ title: '   ' }), 100),
      ).rejects.toThrow('title');
      await expect(
        store.stage(
          { chatId: 'chat-1' },
          document({ heights: [[640, -1]] }),
          100,
        ),
      ).rejects.toThrow('heights');
      await expect(
        store.stage(
          { chatId: 'chat-1' },
          document({ html: '<p>broken\ud800</p>' }),
          100,
        ),
      ).rejects.toThrow('well-formed');
      await expect(
        store.stage(
          { chatId: 'chat-1' },
          document({ html: 'x'.repeat(VISUAL_PREPARED_MAX_BYTES + 1) }),
          100,
        ),
      ).rejects.toThrow('byte limit');

      const clamped = await store.stage(
        { chatId: 'chat-1' },
        document({ visualId: otherVisualId, maxHeight: 20 }),
        100,
      );
      expect(clamped.maxHeight).toBe(80);
    });
  });

  it('initializes without creating a missing directory', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const store = new VisualStagingStoreImpl(directory);
      await store.initialize(100);
      expect(store.hasEntries()).toBe(false);
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('keeps the exact retention boundary and removes old entries, orphans, and temps', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const now = 25 * VISUAL_STAGING_RETENTION_MS;
      const store = new VisualStagingStoreImpl(directory);
      await store.stage(
        { chatId: 'chat-1' },
        document(),
        now - VISUAL_STAGING_RETENTION_MS,
      );
      await store.stage(
        { chatId: 'chat-1' },
        document({ visualId: otherVisualId }),
        now - VISUAL_STAGING_RETENTION_MS - 1,
      );
      const oldOrphanId = 'vis_00000000-0000-0000-0000-000000000003';
      const youngOrphanId = 'vis_00000000-0000-0000-0000-000000000004';
      const oldTemp = join(directory, '.old.tmp');
      const youngTemp = join(directory, '.young.tmp');
      await writeFile(join(directory, `${oldOrphanId}.html`), 'old orphan');
      await writeFile(join(directory, `${youngOrphanId}.html`), 'young orphan');
      await writeFile(oldTemp, 'old temp');
      await writeFile(youngTemp, 'young temp');
      const oldDate = new Date(now - VISUAL_STAGING_RETENTION_MS - 1);
      const youngDate = new Date(now - VISUAL_STAGING_RETENTION_MS + 1);
      await utimes(join(directory, `${oldOrphanId}.html`), oldDate, oldDate);
      await utimes(oldTemp, oldDate, oldDate);
      await utimes(
        join(directory, `${youngOrphanId}.html`),
        youngDate,
        youngDate,
      );
      await utimes(youngTemp, youngDate, youngDate);

      const initialized = new VisualStagingStoreImpl(directory);
      await initialized.initialize(now);
      expect(Array.from(initialized.stagedIds())).toEqual([visualId]);
      expect((await readdir(directory)).sort()).toEqual(
        [
          `${visualId}.html`,
          `${visualId}.json`,
          `${youngOrphanId}.html`,
          '.young.tmp',
        ].sort(),
      );
      // Young orphans count as remaining work until a later pass removes them.
      await expect(initialized.sweep(now)).resolves.toEqual({
        removed: 0,
        remaining: 3,
      });
    });
  });

  it('sweeps expired entries and removes all entries for a chat', async (): Promise<void> => {
    await withStaging(async (directory): Promise<void> => {
      const now = 3 * VISUAL_STAGING_RETENTION_MS;
      const store = new VisualStagingStoreImpl(directory);
      await store.stage({ chatId: 'chat-1' }, document(), 0);
      await store.stage(
        { chatId: 'chat-2' },
        document({ visualId: otherVisualId }),
        now,
      );
      expect(await store.sweep(now)).toEqual({ removed: 1, remaining: 1 });
      await store.removeChat('chat-2');
      expect(store.hasEntries()).toBe(false);
      expect(await readdir(directory)).toEqual([]);
    });
  });
});

describe('chat visual staging sweep scheduler', (): void => {
  afterEach((): void => {
    jest.useRealTimers();
  });

  it('runs immediately, skips overlapping ticks, and stop awaits the active pass', async (): Promise<void> => {
    jest.useFakeTimers();
    const firstPass = deferred();
    const sweep = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(() => firstPass.promise)
      .mockResolvedValue(undefined);
    const scheduler = new ChatVisualStagingSweep(sweep);

    scheduler.start();
    expect(sweep).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(VISUAL_STAGING_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);

    firstPass.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(VISUAL_STAGING_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);

    const pending = deferred();
    const stoppingScheduler = new ChatVisualStagingSweep(() => pending.promise);
    stoppingScheduler.start();
    let stopped = false;
    const stoppedPromise = stoppingScheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    pending.resolve();
    await stoppedPromise;
    expect(stopped).toBe(true);
    await scheduler.stop();
  });
});

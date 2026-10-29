import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserObservedSites } from '../observed-sites';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
async function fixture(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'browser-observation-test-'));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const run = async <T>(
  _id: string,
  _generation: number,
  action: () => Promise<T>,
): Promise<T> => action();
describe('browser observed-site metadata', () => {
  it('strips credentials, paths and queries before persistence and retains only browser-supplied cookie-domain scope', async () =>
    fixture(async (root) => {
      const id = randomUUID(),
        store = new BrowserObservedSites(root, run, () => 123);
      store.record(
        id,
        1,
        'https://person:secret@sub.example.co.uk/private?token=secret',
        'https://top.test/full-path',
        'example.co.uk',
      );
      await store.close();
      const raw = await readFile(join(root, `${id}-g1.json`), 'utf8');
      expect(raw).not.toMatch(/person|secret|private|token|full-path/);
      expect((JSON.parse(raw) as { sites: unknown[] }).sites).toEqual([
        {
          origin: 'https://sub.example.co.uk',
          topLevelOrigin: 'https://top.test',
          cookieDomain: 'example.co.uk',
          observedAt: 123,
        },
      ]);
    }));
  it('does not publish a retired generation and does not turn the failure into a zero summary', async () =>
    fixture(async (root) => {
      const id = randomUUID(),
        store = new BrowserObservedSites(root, () => {
          return Promise.reject(
            new BrowserProfileError('scope_retired', 'Retired'),
          );
        });
      store.record(
        id,
        1,
        'https://example.test',
        'https://example.test',
        'example.test',
      );
      await expect(store.read(id, 1)).rejects.toMatchObject({
        code: 'storage_unavailable',
      });
      await expect(readFile(join(root, `${id}-g1.json`))).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
      await store.close();
    }));
  it('requeues a failed batch so an unchanged observation retries', async () =>
    fixture(async (root) => {
      const id = randomUUID();
      let attempts = 0;
      const store = new BrowserObservedSites(
        root,
        async (_id, _generation, action) => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary writer failure');
          return action();
        },
      );
      store.record(
        id,
        1,
        'https://retry.test/path',
        'https://retry.test',
        'retry.test',
      );

      await expect(store.read(id, 1)).rejects.toMatchObject({
        code: 'storage_unavailable',
      });
      await expect(store.read(id, 1)).resolves.toMatchObject({
        sites: [expect.objectContaining({ origin: 'https://retry.test' })],
      });
      expect(attempts).toBe(2);
      await store.close();
    }));
  it('merges concurrent observers without losing another tab and flags opaque or bounded-out contexts', async () =>
    fixture(async (root) => {
      const id = randomUUID(),
        a = new BrowserObservedSites(root, run),
        b = new BrowserObservedSites(root, run);
      a.record(id, 1, 'https://first.test', 'https://first.test', 'first.test');
      b.record(
        id,
        1,
        'https://second.test',
        'https://second.test',
        'second.test',
      );
      b.record(id, 1, 'null', 'https://second.test', undefined);
      await Promise.all([a.flush(), b.flush()]);
      expect((await a.read(id, 1)).sites).toHaveLength(2);
      expect((await a.read(id, 1)).truncated).toBe(true);
      for (let i = 0; i < 1005; i++)
        a.record(
          id,
          1,
          `https://site${i}.test/path`,
          'https://top.test',
          undefined,
        );
      const result = await a.read(id, 1);
      expect(result.sites).toHaveLength(1000);
      expect(result.truncated).toBe(true);
      expect(
        result.sites.find((site) => site.origin === 'https://site0.test')
          ?.cookieDomain,
      ).toBeNull();
      await Promise.all([a.close(), b.close()]);
    }));
});

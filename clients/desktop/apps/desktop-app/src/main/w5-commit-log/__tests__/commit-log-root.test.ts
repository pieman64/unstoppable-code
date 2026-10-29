import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureW5DataRoot } from '../commit-log-root';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-root-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ancestors(folder: string): string[] {
  const out: string[] = [];
  for (let current = folder; dirname(current) !== current; ) {
    current = dirname(current);
    out.push(current);
  }
  return out;
}

describe('W5 data root (CAN-3805)', () => {
  it('creates a missing root and flushes every folder above it', async () => {
    const root = join(dir, 'data', 'workspaces');
    const synced: string[] = [];
    await ensureW5DataRoot(root, (folder) => {
      synced.push(folder);
      return Promise.resolve();
    });
    expect(statSync(root).isDirectory()).toBe(true);
    expect(synced).toEqual(ancestors(root));
  });

  // A worker that created the root and stopped before flushing it.
  it('flushes an existing root again on every start', async () => {
    const root = join(dir, 'data', 'workspaces');
    mkdirSync(root, { recursive: true });
    const synced: string[] = [];
    await ensureW5DataRoot(root, (folder) => {
      synced.push(folder);
      return Promise.resolve();
    });
    expect(synced).toEqual(ancestors(root));
  });

  it('fails the start when a flush fails, so no commit is applied unprotected', async () => {
    const root = join(dir, 'workspaces');
    await expect(
      ensureW5DataRoot(root, () => Promise.reject(new Error('EIO'))),
    ).rejects.toThrow('EIO');
  });
});

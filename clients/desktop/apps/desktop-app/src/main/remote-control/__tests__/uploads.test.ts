import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REMOTE_UPLOAD_TOO_LARGE_MESSAGE } from '@canopy/desktop-shared/types';
import { RemoteUploadStore } from '../host/uploads';

const dirs: string[] = [];

function createStore(): { store: RemoteUploadStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'remote-uploads-'));
  dirs.push(root);
  return { store: new RemoteUploadStore(root), root };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('RemoteUploadStore', () => {
  it("stores a file under its controller's directory", async () => {
    const { store, root } = createStore();
    const path = await store.put(
      'controller-1',
      'notes.md',
      new TextEncoder().encode('hello'),
    );
    expect(dirname(dirname(path))).toBe(join(root, 'controller-1'));
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  it('never lets a file name leave its upload directory', async () => {
    const { store, root } = createStore();
    const path = await store.put(
      'controller-1',
      '../../escape.txt',
      new Uint8Array([1]),
    );
    // Separators are replaced, so the name stays one path segment.
    expect(dirname(dirname(path))).toBe(join(root, 'controller-1'));
  });

  it('refuses a file over the upload limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'remote-uploads-'));
    dirs.push(root);
    const store = new RemoteUploadStore(root, {
      maxBytes: 4,
      tooLargeMessage: REMOTE_UPLOAD_TOO_LARGE_MESSAGE,
    });
    await expect(
      store.put('controller-1', 'big.bin', new Uint8Array(5)),
    ).rejects.toThrow('too large');
    await expect(
      store.put('controller-1', 'fits.bin', new Uint8Array(4)),
    ).resolves.toContain('fits.bin');
  });
});

import { createHash } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import type * as NodeChildProcess from 'node:child_process';
import type * as NodePath from 'node:path';
import type * as NodeFileSystem from 'node:fs/promises';
import type * as FileAccessModule from '@canopy/desktop-shared/node/delegation/file-access';
import { renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  open,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PORTAL_ASSET_CHUNK_BYTES,
  PORTAL_ASSET_MAX_BYTES,
} from '@canopy/protocol/portal';
import {
  closePortalAssetTransfers,
  readPortalAssetDataUrl,
  readPortalAssetFile,
} from '../portal-asset-service';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return { ...actual, createHash: jest.fn(actual.createHash) };
});

/** Exit of every real broker started for an asset transfer, in start order. */
const mockBrokerExits: Promise<void>[] = [];
const mockOpenPortalAssetFiles = jest.fn(
  async (
    root: string,
    signal: AbortSignal,
  ): Promise<FileAccessModule.NativeDelegationFiles> => {
    const childProcess =
      jest.requireActual<typeof NodeChildProcess>('node:child_process');
    const paths = jest.requireActual<typeof NodePath>('node:path');
    const { realpath } =
      jest.requireActual<typeof NodeFileSystem>('node:fs/promises');
    const { NativeDelegationFiles } = jest.requireActual<
      typeof FileAccessModule
    >('@canopy/desktop-shared/node/delegation/file-access');
    const child = childProcess.spawn(
      paths.join(
        process.cwd(),
        '.cache/bin',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32'
          ? 'canopy-file-broker.exe'
          : 'canopy-file-broker',
      ),
      [await realpath(root), '--asset-readonly'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    mockBrokerExits.push(exited);
    return NativeDelegationFiles.open(
      {
        stdin: child.stdin,
        stdout: child.stdout,
        exited,
        terminate: () => {
          child.kill();
        },
      },
      signal,
      { fileBytes: 197_632, totalBytes: 104_857_600 + 197_632 },
      process.platform === 'win32' ? 'win32' : 'darwin',
    );
  },
);
jest.mock('../../agents/delegation/file-process', () => ({
  openPortalAssetFiles: (
    root: string,
    signal: AbortSignal,
  ): Promise<FileAccessModule.NativeDelegationFiles> =>
    mockOpenPortalAssetFiles(root, signal),
}));

describe('Portal original asset reads', () => {
  let directory = '';
  let root = '';

  beforeAll(async () => {
    await promisify(execFile)(
      process.execPath,
      ['scripts/build-delegation-file-broker.mjs', '--host'],
      { timeout: 60_000 },
    );
  }, 65_000);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'portal-assets-'));
    root = join(directory, 'root');
    await mkdir(root);
  });
  afterEach(async () => {
    closePortalAssetTransfers();
    await Promise.all(mockBrokerExits.splice(0));
    mockOpenPortalAssetFiles.mockClear();
    await rm(directory, { recursive: true, force: true });
  });

  function read(
    path: string,
    offset?: number,
    version?: string,
  ): ReturnType<typeof readPortalAssetFile> {
    return readPortalAssetFile({
      path,
      root,
      assetId: 'asset-one-attachment-0',
      range: { offset, version },
    });
  }

  it('downloads exact originals in bounded version-pinned chunks with non-ASCII names', async () => {
    const bytes = Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 37, 0xab);
    const path = join(root, 'árvore-日本語.pdf');
    await writeFile(path, bytes);
    const first = await read(path);
    expect(first.filename).toBe('árvore-日本語.pdf');
    expect(first.mediaType).toBe('application/pdf');
    expect(first.size).toBe(bytes.byteLength);
    expect(first.nextOffset).toBe(PORTAL_ASSET_CHUNK_BYTES);
    expect(first.contentSha256).toBe(
      createHash('sha256')
        .update(bytes.subarray(0, PORTAL_ASSET_CHUNK_BYTES))
        .digest('hex'),
    );
    const second = await read(
      path,
      first.nextOffset ?? undefined,
      first.version,
    );
    expect(second.nextOffset).toBeNull();
    expect(
      Buffer.concat([
        Buffer.from(first.dataBase64, 'base64'),
        Buffer.from(second.dataBase64, 'base64'),
      ]),
    ).toEqual(bytes);
  });

  it('starts one broker per transfer and stops it after the final chunk', async () => {
    const bytes = Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES * 2 + 5);
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = index % 251;
    const path = join(root, 'three-chunks.bin');
    await writeFile(path, bytes);
    const chunks: Buffer[] = [];
    let next = await read(path);
    chunks.push(Buffer.from(next.dataBase64, 'base64'));
    while (next.nextOffset !== null) {
      next = await read(path, next.nextOffset, next.version);
      chunks.push(Buffer.from(next.dataBase64, 'base64'));
    }
    expect(chunks).toHaveLength(3);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(mockOpenPortalAssetFiles).toHaveBeenCalledTimes(1);
    // The final chunk releases the transfer's broker without waiting for the
    // idle timeout.
    expect(mockBrokerExits).toHaveLength(1);
    await mockBrokerExits[0];
    // A new transfer of the same original starts its own broker.
    const again = await read(path);
    await read(path, again.nextOffset ?? undefined, again.version);
    expect(mockOpenPortalAssetFiles).toHaveBeenCalledTimes(2);
  });

  it('reads continuations from the opened original and rejects a renamed replacement', async () => {
    const path = join(root, 'notes.txt');
    const replacement = join(directory, 'replacement.txt');
    await writeFile(path, Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 1, 1));
    await writeFile(replacement, Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 1, 2));
    const first = await read(path);
    renameSync(replacement, path);
    // The broker still holds the original, which no longer has a link, and
    // refuses it instead of reading the replacement at the same path.
    await expect(
      read(path, PORTAL_ASSET_CHUNK_BYTES, first.version),
    ).rejects.toThrow('changed originals cannot be read');
    expect(mockOpenPortalAssetFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps reading the opened original when an ancestor is swapped around a continuation', async () => {
    const child = join(root, 'child');
    const originalChild = join(root, 'original-child');
    const replacement = join(directory, 'replacement');
    await mkdir(child);
    await mkdir(replacement);
    const original = Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 3, 1);
    await writeFile(join(child, 'notes.bin'), original);
    await writeFile(
      join(replacement, 'notes.bin'),
      Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 3, 9),
    );
    const path = join(child, 'notes.bin');
    const first = await read(path);
    let checks = 0;
    const canRead = (): boolean => {
      checks += 1;
      if (checks === 3) {
        renameSync(child, originalChild);
        renameSync(replacement, child);
      }
      if (checks === 4) {
        renameSync(child, replacement);
        renameSync(originalChild, child);
      }
      return true;
    };
    const second = await readPortalAssetFile({
      path,
      root,
      assetId: 'asset-one-attachment-0',
      range: { offset: first.nextOffset ?? undefined, version: first.version },
      canRead,
    });
    expect(checks).toBe(5);
    expect(Buffer.from(second.dataBase64, 'base64')).toEqual(
      original.subarray(PORTAL_ASSET_CHUNK_BYTES),
    );
    expect(mockOpenPortalAssetFiles).toHaveBeenCalledTimes(1);
  });

  it('continues an interrupted transfer with a new broker when its session is gone', async () => {
    const bytes = Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 9, 7);
    const path = join(root, 'resume.bin');
    await writeFile(path, bytes);
    const first = await read(path);
    closePortalAssetTransfers();
    const second = await read(
      path,
      first.nextOffset ?? undefined,
      first.version,
    );
    expect(second.nextOffset).toBeNull();
    expect(
      Buffer.concat([
        Buffer.from(first.dataBase64, 'base64'),
        Buffer.from(second.dataBase64, 'base64'),
      ]),
    ).toEqual(bytes);
    expect(mockOpenPortalAssetFiles).toHaveBeenCalledTimes(2);
  });

  it('rejects originals replaced between chunks and continuation without a version', async () => {
    const path = join(root, 'notes.txt');
    await writeFile(path, Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 1, 1));
    const first = await read(path);
    await expect(read(path, PORTAL_ASSET_CHUNK_BYTES)).rejects.toThrow(
      'Restart the download',
    );
    await writeFile(path, Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 1, 2));
    // A same-size rewrite can share the original's timestamp tick on fast hosts.
    const changedAt = new Date(Date.now() + 60_000);
    await utimes(path, changedAt, changedAt);
    await expect(
      read(path, PORTAL_ASSET_CHUNK_BYTES, first.version),
    ).rejects.toThrow('Restart the download');
  });

  it('rejects outside roots, traversal, final and intermediate symlinks, and nonregular files', async () => {
    const outside = join(directory, 'secret.txt');
    await writeFile(outside, 'secret');
    await expect(read(outside)).rejects.toThrow('outside');
    await expect(read(join(root, '..', 'secret.txt'))).rejects.toThrow(
      'outside',
    );
    await symlink(outside, join(root, 'linked.txt'));
    await expect(read(join(root, 'linked.txt'))).rejects.toThrow('Linked');
    await symlink(directory, join(root, 'linked-directory'));
    await expect(
      read(join(root, 'linked-directory', 'secret.txt')),
    ).rejects.toThrow('Linked');
    await mkdir(join(root, 'folder'));
    await expect(read(join(root, 'folder'))).rejects.toThrow('regular');
  });

  it('reports missing originals and excluded roots without returning bytes', async () => {
    await expect(read(join(root, 'missing.txt'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await mkdir(join(root, 'excluded'));
    const path = join(root, 'excluded', 'secret.txt');
    await writeFile(path, 'secret');
    await expect(
      readPortalAssetFile({
        path,
        root,
        excludedRoots: [join(root, 'excluded')],
        assetId: 'asset',
        range: {},
      }),
    ).rejects.toThrow('excluded');
  });

  it('refuses oversized originals and invalid ranges instead of truncating', async () => {
    const path = join(root, 'large.bin');
    const handle = await open(path, 'w');
    await handle.truncate(PORTAL_ASSET_MAX_BYTES + 1);
    await handle.close();
    await expect(read(path)).rejects.toThrow('100 MiB');
    await writeFile(path, 'hello');
    for (const offset of [-1, NaN, Infinity, 0.5, 6]) {
      await expect(read(path, offset)).rejects.toThrow('offset');
    }
  });

  it('keeps unknown desktop file formats available as opaque original downloads', async () => {
    const path = join(root, 'model.stl');
    await writeFile(path, Buffer.from([0, 1, 2]));
    expect(await read(path)).toMatchObject({
      mediaType: 'application/octet-stream',
      size: 3,
    });
  });

  it('reads inline raster originals while rejecting active content and malformed base64', () => {
    const bytes = Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 5, 0xa3);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    const first = readPortalAssetDataUrl({
      assetId: 'asset-image',
      dataUrl,
      range: {},
    });
    const second = readPortalAssetDataUrl({
      assetId: 'asset-image',
      dataUrl,
      range: { offset: first.nextOffset ?? undefined, version: first.version },
    });
    expect(
      Buffer.concat([
        Buffer.from(first.dataBase64, 'base64'),
        Buffer.from(second.dataBase64, 'base64'),
      ]),
    ).toEqual(bytes);
    for (const invalid of [
      'data:image/svg+xml;base64,AAAA',
      'data:text/html;base64,AAAA',
      'data:image/png;base64,AB==',
      'data:image/png;base64,A',
    ]) {
      expect(() =>
        readPortalAssetDataUrl({
          assetId: 'asset',
          dataUrl: invalid,
          range: {},
        }),
      ).toThrow();
    }
    const unaligned = readPortalAssetDataUrl({
      assetId: 'asset-image',
      dataUrl,
      range: { offset: 1, version: first.version },
    });
    expect(Buffer.from(unaligned.dataBase64, 'base64')).toEqual(
      bytes.subarray(1, 1 + PORTAL_ASSET_CHUNK_BYTES),
    );
  });

  it('pins inline source metadata once while hashing every returned chunk separately', () => {
    const bytes = Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES * 3 + 1, 0xa3);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    const hash = jest.mocked(createHash);
    hash.mockClear();
    const first = readPortalAssetDataUrl({
      assetId: 'asset-cached-image',
      dataUrl,
      range: {},
    });
    const second = readPortalAssetDataUrl({
      assetId: 'asset-cached-image',
      dataUrl,
      range: { offset: PORTAL_ASSET_CHUNK_BYTES, version: first.version },
    });
    const third = readPortalAssetDataUrl({
      assetId: 'asset-cached-image',
      dataUrl,
      range: { offset: PORTAL_ASSET_CHUNK_BYTES * 2, version: first.version },
    });
    expect(second.version).toBe(first.version);
    expect(third.version).toBe(first.version);
    expect(hash).toHaveBeenCalledTimes(4);
    const changed = `${dataUrl.slice(0, -4)}AAAA`;
    expect(() =>
      readPortalAssetDataUrl({
        assetId: 'asset-cached-image',
        dataUrl: changed,
        range: { offset: PORTAL_ASSET_CHUNK_BYTES, version: first.version },
      }),
    ).toThrow('changed');
  });

  it('denies revoked read consent without returning file or cached inline bytes', async () => {
    const path = join(root, 'notes.txt');
    await writeFile(path, 'secret');
    await expect(
      readPortalAssetFile({
        path,
        root,
        assetId: 'asset',
        range: {},
        canRead: () => false,
      }),
    ).rejects.toThrow('authorized');
    let checks = 0;
    await expect(
      readPortalAssetFile({
        path,
        root,
        assetId: 'asset',
        range: {},
        canRead: () => ++checks < 4,
      }),
    ).rejects.toThrow('authorized');
    const dataUrl = 'data:image/png;base64,AAAA';
    readPortalAssetDataUrl({
      assetId: 'asset-consent-image',
      dataUrl,
      range: {},
    });
    expect(() =>
      readPortalAssetDataUrl({
        assetId: 'asset-consent-image',
        dataUrl,
        range: {},
        canRead: () => false,
      }),
    ).toThrow('authorized');
  });

  it('detects an ancestor swapped to a symlink while the opened original is being read', async () => {
    const child = join(root, 'child');
    const outside = join(directory, 'outside');
    await mkdir(child);
    await mkdir(outside);
    await writeFile(join(child, 'notes.txt'), 'public');
    await writeFile(join(outside, 'notes.txt'), 'secret');
    let checks = 0;
    const canRead = (): boolean => {
      checks += 1;
      if (checks === 3) {
        renameSync(child, join(root, 'original-child'));
        symlinkSync(outside, child);
      }
      return true;
    };
    await expect(
      readPortalAssetFile({
        path: join(child, 'notes.txt'),
        root,
        assetId: 'asset',
        range: {},
        canRead,
      }),
    ).rejects.toThrow('Linked');
  });

  it('rejects an ordinary ancestor swapped during the native read and restored before reinspection', async () => {
    const child = join(root, 'child');
    const originalChild = join(root, 'original-child');
    const replacement = join(directory, 'replacement');
    await mkdir(child);
    await mkdir(replacement);
    await writeFile(join(child, 'notes.txt'), 'public');
    await writeFile(join(replacement, 'notes.txt'), 'secret');
    let checks = 0;
    const canRead = (): boolean => {
      checks += 1;
      if (checks === 3) {
        renameSync(child, originalChild);
        renameSync(replacement, child);
      }
      if (checks === 4) {
        renameSync(child, replacement);
        renameSync(originalChild, child);
      }
      return true;
    };
    await expect(
      readPortalAssetFile({
        path: join(child, 'notes.txt'),
        root,
        assetId: 'asset',
        range: {},
        canRead,
      }),
    ).rejects.toThrow('changed during');
    expect(checks).toBe(4);
  });

  it('detects the opened original changing during a bounded read', async () => {
    const path = join(root, 'notes.txt');
    await writeFile(path, Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 1, 1));
    let checks = 0;
    const canRead = (): boolean => {
      checks += 1;
      if (checks === 3) {
        writeFileSync(path, Buffer.alloc(PORTAL_ASSET_CHUNK_BYTES + 1, 2));
        // A same-size rewrite can share the fingerprint's timestamp tick.
        const changedAt = new Date(Date.now() + 60_000);
        utimesSync(path, changedAt, changedAt);
      }
      return true;
    };
    await expect(
      readPortalAssetFile({ path, root, assetId: 'asset', range: {}, canRead }),
    ).rejects.toThrow('changed during');
  });
});

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeToOpen,
  copyRemoteFile,
  parseFileOpenTarget,
  remoteImageForLocalOpen,
  runsProgramsWhenOpened,
} from '../client/remote-file-opens';
import { RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_FILE_READ_CHUNK_BYTES,
  type FileReadParams,
  type FileReadResult,
} from '../remote-protocol';
import { RpcRemoteError } from '../transport/rpc-peer';

const dirs: string[] = [];

function createStore(): { store: RemoteUploadStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'remote-file-opens-'));
  dirs.push(root);
  return { store: new RemoteUploadStore(root), root };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Serves a host file from memory, as `file.read` would. */
function hostFile(
  bytes: Uint8Array,
  fileName = 'report.pdf',
): {
  read: (params: FileReadParams) => Promise<FileReadResult>;
  reads: FileReadParams[];
  modifiedAtMs: { value: number };
} {
  const reads: FileReadParams[] = [];
  const modifiedAtMs = { value: 1 };
  return {
    reads,
    modifiedAtMs,
    read: (params: FileReadParams): Promise<FileReadResult> => {
      reads.push(params);
      return Promise.resolve({
        fileName,
        sizeBytes: bytes.byteLength,
        modifiedAtMs: modifiedAtMs.value,
        bytes: bytes.slice(params.offset, params.offset + params.length),
      });
    },
  };
}

function preview(content: string, filename = 'shot.png'): unknown {
  return {
    kind: 'image',
    content,
    filename,
    sizeBytes: 3,
    truncated: false,
    modifiedAtMs: 0,
  };
}

describe('parseFileOpenTarget', () => {
  it('reads the file and scope of an open request', () => {
    expect(parseFileOpenTarget([{ absolutePath: 'C:\\shots\\a.png' }])).toEqual(
      { absolutePath: 'C:\\shots\\a.png' },
    );
    expect(
      parseFileOpenTarget([
        { absolutePath: '/a.pdf', projectId: 'p', worktreeId: 'w', extra: 1 },
      ]),
    ).toEqual({ absolutePath: '/a.pdf', projectId: 'p', worktreeId: 'w' });
  });

  it('rejects malformed requests', () => {
    for (const args of [[], [{ absolutePath: '' }], [{ absolutePath: 7 }]]) {
      expect(() => parseFileOpenTarget(args)).toThrow('Invalid file.');
    }
  });
});

describe('runsProgramsWhenOpened', () => {
  it('flags types that run programs, however they are spelled', () => {
    for (const name of [
      'setup.exe',
      'Setup.EXE',
      'setup.exe.',
      'setup.exe ',
      'photo.png.exe',
      'install.command',
      'run.sh',
      'Installer.pkg',
      'launch.lnk',
      '.exe',
      '.cmd',
      '.hta',
      '.EXE',
      '.exe.',
      '.exe ',
      '.Exe. . ',
      'C:\\Users\\host\\.bat',
      '/Users/host/.command',
    ]) {
      expect(runsProgramsWhenOpened(name)).toBe(true);
    }
  });

  it('lets documents, pictures and archives through', () => {
    for (const name of ['report.pdf', 'photo.png', 'notes', 'a.zip', '.env']) {
      expect(runsProgramsWhenOpened(name)).toBe(false);
    }
    expect(() => assertSafeToOpen('/Users/host/setup.exe')).toThrow(
      "Couldn't open setup.exe. Files of this type can run programs",
    );
  });
});

describe('copyRemoteFile', () => {
  it('copies a picture larger than a preview carries, in full-size parts', async () => {
    const { store } = createStore();
    // Previews stop at 5 MB; filled, not random, to keep this cheap.
    const bytes = Buffer.alloc(6 * 1024 * 1024, 7);
    const host = hostFile(bytes, 'scan.png');

    const path = await copyRemoteFile({
      deviceId: 'desktop',
      target: { absolutePath: '/Users/host/scan.png' },
      read: host.read,
      store,
    });

    expect(host.reads.map((read) => read.offset)).toEqual([
      0,
      REMOTE_FILE_READ_CHUNK_BYTES,
    ]);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('copies a file larger than one part, part by part', async () => {
    const { store, root } = createStore();
    const bytes = randomBytes(10 * 1024 + 7);
    const host = hostFile(bytes);

    const path = await copyRemoteFile({
      deviceId: 'desktop',
      target: { absolutePath: '/Users/host/report.pdf' },
      read: host.read,
      store,
      chunkBytes: 4 * 1024,
    });

    expect(host.reads.map((read) => read.offset)).toEqual([0, 4096, 8192]);
    expect(path.startsWith(join(root, 'desktop'))).toBe(true);
    expect(path.endsWith('report.pdf')).toBe(true);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('copies an empty file', async () => {
    const { store } = createStore();
    const path = await copyRemoteFile({
      deviceId: 'desktop',
      target: { absolutePath: '/Users/host/empty.txt' },
      read: hostFile(new Uint8Array(0), 'empty.txt').read,
      store,
    });
    expect(readFileSync(path)).toHaveLength(0);
  });

  it('deletes the copy when the file changes between parts', async () => {
    const { store, root } = createStore();
    const host = hostFile(randomBytes(9000));
    const read = (params: FileReadParams): Promise<FileReadResult> => {
      if (params.offset > 0) host.modifiedAtMs.value = 2;
      return host.read(params);
    };

    await expect(
      copyRemoteFile({
        deviceId: 'desktop',
        target: { absolutePath: '/Users/host/report.pdf' },
        read,
        store,
        chunkBytes: 4096,
      }),
    ).rejects.toThrow('changed while it was being copied');
    expect(readdirSync(join(root, 'desktop'))).toEqual([]);
  });

  it('refuses files over the limit with their name', async () => {
    const { store, root } = createStore();
    const tooLarge = (): Promise<FileReadResult> =>
      Promise.reject(new RpcRemoteError('too large', 'remote_file_too_large'));
    await expect(
      copyRemoteFile({
        deviceId: 'desktop',
        target: { absolutePath: '/Users/host/movie.mov' },
        read: tooLarge,
        store,
      }),
    ).rejects.toThrow("Couldn't open movie.mov. Files over 240 MB");
    await expect(
      copyRemoteFile({
        deviceId: 'desktop',
        target: { absolutePath: '/Users/host/movie.mov' },
        read: hostFile(new Uint8Array(9), 'movie.mov').read,
        store,
        maxBytes: 8,
      }),
    ).rejects.toThrow('Files over 0 MB');
    expect(existsSync(join(root, 'desktop'))).toBe(false);
  });

  it('refuses a host name that is stored as a type that runs programs', async () => {
    const { store, root } = createStore();
    // Stored names keep 200 characters, which here end in `.exe`.
    const fileName = `${'a'.repeat(196)}.exe.pdf`;
    expect(runsProgramsWhenOpened(fileName)).toBe(true);
    await expect(
      copyRemoteFile({
        deviceId: 'desktop',
        target: { absolutePath: '/Users/host/report.pdf' },
        read: hostFile(new Uint8Array([1]), fileName).read,
        store,
      }),
    ).rejects.toThrow('can run programs');
    expect(existsSync(join(root, 'desktop'))).toBe(false);
  });

  it('refuses a host name that is only an extension', async () => {
    const { store, root } = createStore();
    const host = hostFile(new Uint8Array([1]), '.exe');
    await expect(
      copyRemoteFile({
        deviceId: 'desktop',
        target: { absolutePath: '/Users/host/photo.png' },
        read: host.read,
        store,
      }),
    ).rejects.toThrow('can run programs');
    expect(existsSync(join(root, 'desktop'))).toBe(false);
  });

  it('refuses types that run programs, before and after links resolve', async () => {
    const { store, root } = createStore();
    const host = hostFile(new Uint8Array([1]), 'install.command');
    await expect(
      copyRemoteFile({
        deviceId: 'desktop',
        target: { absolutePath: '/Users/host/install.command' },
        read: host.read,
        store,
      }),
    ).rejects.toThrow('can run programs');
    expect(host.reads).toEqual([]);
    await expect(
      copyRemoteFile({
        deviceId: 'desktop',
        target: { absolutePath: '/Users/host/photo.png' },
        read: host.read,
        store,
      }),
    ).rejects.toThrow('can run programs');
    expect(existsSync(join(root, 'desktop'))).toBe(false);
  });
});

describe('remoteImageForLocalOpen', () => {
  it('decodes a raster image and names it after its actual type', () => {
    expect(
      remoteImageForLocalOpen(
        preview('data:image/jpeg;base64,AQID', 'holiday.png'),
      ),
    ).toEqual({ fileName: 'holiday.jpg', bytes: new Uint8Array([1, 2, 3]) });
    expect(
      remoteImageForLocalOpen(preview('data:image/png;base64,AQID', '.png'))
        ?.fileName,
    ).toBe('image.png');
  });

  it('ignores anything that is not a raster image', () => {
    expect(
      remoteImageForLocalOpen(preview('data:image/svg+xml;base64,AQID')),
    ).toBeNull();
    expect(
      remoteImageForLocalOpen(preview('data:image/png,not-base64')),
    ).toBeNull();
    expect(remoteImageForLocalOpen({ kind: 'text', content: 'hi' })).toBeNull();
    expect(remoteImageForLocalOpen(null)).toBeNull();
  });
});

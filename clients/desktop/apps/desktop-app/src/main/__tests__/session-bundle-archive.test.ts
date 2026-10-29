import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import {
  packSessionBundle,
  unpackSessionBundle,
} from '../lib/session-bundle-archive';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-bundle-archive-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(async (): Promise<void> => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('session bundle archive', () => {
  it('packs and unpacks byte-identical contents including long nested paths', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'session.tar.gz');
    const longDirectoryName = `codex-rollout-${'x'.repeat(110)}`;
    const longRelativePath = join(
      'provider-sessions',
      longDirectoryName,
      'rollout.jsonl',
    );
    const manifestBytes = Buffer.from(
      '{"version":1,"title":"Byte faithful"}\n',
      'utf8',
    );
    const rolloutBytes = Buffer.from([0, 1, 2, 10, 13, 127, 128, 254, 255]);

    expect(longRelativePath.length).toBeGreaterThan(100);
    await mkdir(join(sourceDir, 'provider-sessions', longDirectoryName), {
      recursive: true,
    });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(sourceDir, 'canopy-session.json'), manifestBytes);
    await writeFile(join(sourceDir, longRelativePath), rolloutBytes);

    const packed = await packSessionBundle(sourceDir, archivePath);
    const archiveBytes = await readFile(archivePath);
    expect(packed).toEqual({
      sizeBytes: (await stat(archivePath)).size,
      contentHash: createHash('sha256').update(archiveBytes).digest('hex'),
    });

    await unpackSessionBundle(archivePath, destinationDir);

    await expect(
      readFile(join(destinationDir, 'canopy-session.json')),
    ).resolves.toEqual(manifestBytes);
    await expect(
      readFile(join(destinationDir, longRelativePath)),
    ).resolves.toEqual(rolloutBytes);
  });

  it('rejects archives containing parent-directory traversal entries', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'malicious-source');
    const nestedSourceDir = join(sourceDir, 'nested');
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'malicious.tar.gz');
    const escapedDestination = join(root, 'escaped.txt');
    await mkdir(nestedSourceDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(sourceDir, 'escaped.txt'), 'malicious');
    await tar.create(
      {
        cwd: nestedSourceDir,
        file: archivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
      },
      ['../escaped.txt'],
    );

    await expect(
      unpackSessionBundle(archivePath, destinationDir),
    ).rejects.toThrow("path contains '..'");
    await expect(readFile(escapedDestination)).rejects.toThrow();
  });

  it('rejects archives containing a symbolic link entry', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'malicious-link.tar.gz');
    const targetPath = join(sourceDir, 'target.txt');
    const linkPath = join(sourceDir, 'linked.txt');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(targetPath, 'sensitive');
    await symlink(targetPath, linkPath);
    await tar.create(
      {
        cwd: sourceDir,
        file: archivePath,
        gzip: true,
        portable: true,
      },
      ['target.txt', 'linked.txt'],
    );

    await expect(
      unpackSessionBundle(archivePath, destinationDir),
    ).rejects.toThrow('forbidden symbolic link entry');
    await expect(
      readFile(join(destinationDir, 'linked.txt')),
    ).rejects.toThrow();
  });

  it('rejects archives containing a hard link entry', async () => {
    const root = await makeTempRoot();
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'malicious-hard-link.tar.gz');
    const headerBlock = Buffer.alloc(512);
    const header = new tar.Header({
      path: 'linked.txt',
      type: 'Link',
      linkpath: 'target.txt',
      size: 0,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
    });
    header.encode(headerBlock);
    await mkdir(destinationDir, { recursive: true });
    await writeFile(
      archivePath,
      gzipSync(Buffer.concat([headerBlock, Buffer.alloc(1024)])),
    );

    await expect(
      unpackSessionBundle(archivePath, destinationDir),
    ).rejects.toThrow('forbidden hard link entry');
    await expect(
      readFile(join(destinationDir, 'linked.txt')),
    ).rejects.toThrow();
  });

  it('rejects excessive entry counts before extracting any files', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'too-many-entries.tar.gz');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(sourceDir, 'first.txt'), 'first');
    await writeFile(join(sourceDir, 'second.txt'), 'second');
    await tar.create(
      { cwd: sourceDir, file: archivePath, gzip: true, portable: true },
      ['first.txt', 'second.txt'],
    );

    await expect(
      unpackSessionBundle(archivePath, destinationDir, {
        maxEntries: 1,
        maxExpandedBytes: 1024,
      }),
    ).rejects.toThrow('exceeds the 1 entry limit');
    await expect(readFile(join(destinationDir, 'first.txt'))).rejects.toThrow();
  });

  it('rejects excessive expanded size before extracting any files', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'oversized-expanded.tar.gz');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(sourceDir, 'large.txt'), '12345');
    await tar.create(
      { cwd: sourceDir, file: archivePath, gzip: true, portable: true },
      ['large.txt'],
    );

    await expect(
      unpackSessionBundle(archivePath, destinationDir, {
        maxEntries: 10,
        maxExpandedBytes: 4,
      }),
    ).rejects.toThrow('exceeds the 4 byte expanded-size limit');
    await expect(readFile(join(destinationDir, 'large.txt'))).rejects.toThrow();
  });

  it('counts extended-header metadata toward the entry limit', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'metadata-entry.tar.gz');
    const longName = `${'metadata-'.repeat(16)}file.txt`;
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(sourceDir, longName), 'x');
    await tar.create(
      { cwd: sourceDir, file: archivePath, gzip: true, portable: true },
      [longName],
    );

    await expect(
      unpackSessionBundle(archivePath, destinationDir, {
        maxEntries: 1,
        maxExpandedBytes: 1024,
      }),
    ).rejects.toThrow('exceeds the 1 entry limit');
    await expect(readFile(join(destinationDir, longName))).rejects.toThrow();
  });

  it('counts extended-header metadata toward the expanded-size limit', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'metadata-size.tar.gz');
    const longName = `${'metadata-'.repeat(16)}file.txt`;
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(sourceDir, longName), 'x');
    await tar.create(
      { cwd: sourceDir, file: archivePath, gzip: true, portable: true },
      [longName],
    );

    await expect(
      unpackSessionBundle(archivePath, destinationDir, {
        maxEntries: 10,
        maxExpandedBytes: 1,
      }),
    ).rejects.toThrow('exceeds the 1 byte expanded-size limit');
    await expect(readFile(join(destinationDir, longName))).rejects.toThrow();
  });

  it('rejects oversized ignored metadata before extraction', async () => {
    const root = await makeTempRoot();
    const destinationDir = join(root, 'destination');
    const archivePath = join(root, 'oversized-metadata.tar.gz');
    const oversizedPaxRecord = new tar.Pax({
      path: 'file.txt',
      comment: 'x'.repeat(1024 * 1024),
    }).encode();
    const archiveBytes = Buffer.concat([
      oversizedPaxRecord,
      Buffer.alloc(1024),
    ]);
    await mkdir(destinationDir, { recursive: true });
    await writeFile(archivePath, gzipSync(archiveBytes));

    await expect(
      unpackSessionBundle(archivePath, destinationDir, {
        maxEntries: 10,
        maxExpandedBytes: 512 * 1024,
      }),
    ).rejects.toThrow('exceeds the 524288 byte expanded-size limit');
  });
});

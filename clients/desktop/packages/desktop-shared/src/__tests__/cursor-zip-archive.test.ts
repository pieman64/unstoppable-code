import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCursorZip,
  isSafeCursorEntryName,
} from '../node/cursor/zip-archive';
import {
  buildZip,
  symlinkEntry,
  type ZipFixtureEntry,
} from './helpers/zip-fixture';

let root: string;
let archive: string;
let destination: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursor-zip-test-'));
  archive = join(root, 'package.zip');
  destination = join(root, 'unpacked');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function extract(entries: readonly ZipFixtureEntry[]): Promise<void> {
  await writeFile(archive, buildZip(entries));
  await extractCursorZip({
    archive,
    destination,
    root: 'dist-package',
    maxEntries: 100,
    maxBytes: 4096,
    signal: new AbortController().signal,
  });
}

test('extracts stored and deflated entries, stripping the dist-package root', async () => {
  await extract([
    { name: 'dist-package/' },
    { name: 'dist-package/index.js', content: 'console.log(1)\n' },
    { name: 'dist-package/node.exe', content: 'MZbinary', method: 'deflate' },
    {
      name: 'dist-package/nested/deep/file.txt',
      content: 'nested',
      method: 'deflate',
    },
  ]);
  expect(await readFile(join(destination, 'index.js'), 'utf8')).toBe(
    'console.log(1)\n',
  );
  expect(await readFile(join(destination, 'node.exe'), 'utf8')).toBe(
    'MZbinary',
  );
  expect(
    await readFile(join(destination, 'nested/deep/file.txt'), 'utf8'),
  ).toBe('nested');
  expect((await readdir(destination)).sort()).toEqual([
    'index.js',
    'nested',
    'node.exe',
  ]);
});

test.each([
  [
    'a traversal segment',
    [{ name: 'dist-package/../escape.js', content: 'x' }],
  ],
  ['an absolute path', [{ name: '/etc/passwd', content: 'x' }]],
  ['a Windows drive path', [{ name: 'C:\\evil.js', content: 'x' }]],
  ['a backslash separator', [{ name: 'dist-package\\evil.js', content: 'x' }]],
  [
    'an entry outside the root',
    [{ name: 'other-package/evil.js', content: 'x' }],
  ],
  ['a bare root escape', [{ name: '../evil.js', content: 'x' }]],
  [
    'a duplicate entry',
    [
      { name: 'dist-package/index.js', content: 'first' },
      { name: 'dist-package/index.js', content: 'second' },
    ],
  ],
  [
    // `lib` and `lib/` extract to the same path, so they must collide during
    // validation rather than fail mid-extraction with a raw ENOTDIR/EEXIST.
    'a name that differs only by a trailing slash',
    [
      { name: 'dist-package/lib', content: 'file' },
      { name: 'dist-package/lib/' },
    ],
  ],
  ['a symlink', [symlinkEntry('dist-package/escape', '/etc/passwd')]],
])('rejects %s and writes nothing', async (_label, entries) => {
  await expect(extract(entries)).rejects.toThrow('archive');
  await expect(readdir(destination)).rejects.toThrow();
});

test('rejects an archive with more entries than the limit', async () => {
  const entries = Array.from({ length: 101 }, (_value, index) => ({
    name: `dist-package/file-${index}.js`,
    content: 'x',
  }));
  await expect(extract(entries)).rejects.toThrow('archive');
  await expect(readdir(destination)).rejects.toThrow();
});

test('rejects an archive larger than the byte limit before extracting', async () => {
  await expect(
    extract([{ name: 'dist-package/big.js', content: 'x'.repeat(5000) }]),
  ).rejects.toThrow('archive');
  await expect(readdir(destination)).rejects.toThrow();
});

test('rejects an entry whose real bytes exceed the size it declared', async () => {
  // A lying central directory must not become an unbounded write.
  await writeFile(
    archive,
    buildZip([
      {
        name: 'dist-package/lie.js',
        content: 'x'.repeat(2000),
        declaredSize: 4,
      },
    ]),
  );
  await expect(
    extractCursorZip({
      archive,
      destination,
      root: 'dist-package',
      maxEntries: 100,
      maxBytes: 4096,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});

test('stops when the signal is already aborted', async () => {
  await writeFile(
    archive,
    buildZip([{ name: 'dist-package/index.js', content: 'x' }]),
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    extractCursorZip({
      archive,
      destination,
      root: 'dist-package',
      maxEntries: 100,
      maxBytes: 4096,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});

// yauzl rejects some malicious names before Canopy's policy runs, so the
// policy is exercised directly here: deleting a rule below fails these tests
// even though the end-to-end cases above would still be caught by the library.
describe('isSafeCursorEntryName', () => {
  it('accepts the root and paths beneath it', () => {
    expect(isSafeCursorEntryName('dist-package', 'dist-package')).toBe(true);
    expect(isSafeCursorEntryName('dist-package/', 'dist-package')).toBe(true);
    expect(isSafeCursorEntryName('dist-package/index.js', 'dist-package')).toBe(
      true,
    );
    expect(
      isSafeCursorEntryName('dist-package/a/b/c.node', 'dist-package'),
    ).toBe(true);
  });

  it.each([
    ['traversal', 'dist-package/../escape.js'],
    ['bare traversal', '../escape.js'],
    ['absolute path', '/etc/passwd'],
    ['windows drive', 'C:/evil.js'],
    ['backslash separator', 'dist-package\\evil.js'],
    ['sibling root', 'other-package/evil.js'],
    ['root prefix collision', 'dist-package-evil/x.js'],
    ['current-dir segment', 'dist-package/./x.js'],
    ['empty segment', 'dist-package//x.js'],
    ['nul byte', 'dist-package/x\u0000.js'],
    ['empty name', ''],
  ])('rejects %s', (_label, name) => {
    expect(isSafeCursorEntryName(name, 'dist-package')).toBe(false);
  });
});

test.each([
  ['a FIFO', 0o010777],
  ['a socket', 0o140777],
  ['a character device', 0o020777],
  ['a block device', 0o060777],
])('rejects %s entry, not just symlinks', async (_label, mode) => {
  // The tar path's contract is files and directories only, so the policy
  // allow-lists those two types rather than deny-listing symlinks alone.
  await expect(
    extract([
      {
        name: 'dist-package/special',
        content: 'x',
        versionMadeBy: (3 << 8) | 20,
        externalAttributes: (mode * 0x10000) >>> 0,
      },
    ]),
  ).rejects.toThrow('archive');
  await expect(readdir(destination)).rejects.toThrow();
});

test('still accepts a normal Unix-created regular file', async () => {
  await extract([
    {
      name: 'dist-package/index.js',
      content: 'ok',
      versionMadeBy: (3 << 8) | 20,
      externalAttributes: (0o100644 * 0x10000) >>> 0,
    },
  ]);
  expect(await readFile(join(destination, 'index.js'), 'utf8')).toBe('ok');
});

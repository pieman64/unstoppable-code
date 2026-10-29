import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readOpenCodeAttachments } from '../prompt-attachments';

let directory: string;
let baseDir: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'opencode-attachments-'));
  baseDir = join(directory, 'attachments');
  await mkdir(baseDir);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('delivers image bytes, UTF-8 text and PDF bytes in selection order', async () => {
  const image = join(baseDir, 'photo.png');
  const text = join(baseDir, 'notes.txt');
  const pdf = join(baseDir, 'document.pdf');
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(text, 'Selected notes — café');
  await writeFile(pdf, '%PDF-1.7\nfixture');
  expect(
    await readOpenCodeAttachments(
      { baseDir, paths: [image, text, pdf] },
      new AbortController().signal,
    ),
  ).toEqual([
    {
      type: 'image',
      mimeType: 'image/png',
      uri: pathToFileURL(await realpath(image)).href,
      data: 'iVBORw0KGgo=',
    },
    {
      type: 'resource',
      resource: {
        uri: pathToFileURL(await realpath(text)).href,
        mimeType: 'text/plain',
        text: 'Selected notes — café',
      },
    },
    {
      type: 'resource',
      resource: {
        uri: pathToFileURL(await realpath(pdf)).href,
        mimeType: 'application/pdf',
        blob: Buffer.from('%PDF-1.7\nfixture').toString('base64'),
      },
    },
  ]);
});

test('delivers an explicitly selected Portal upload inside its request directory', async () => {
  const uploadDir = join(
    baseDir,
    'portal-8e3b6ca8-272c-4fb0-adfd-ff49f3911c9e',
  );
  await mkdir(uploadDir);
  const file = join(uploadDir, 'notes.txt');
  await writeFile(file, 'Portal attachment content.');
  await expect(
    readOpenCodeAttachments(
      { baseDir, paths: [file] },
      new AbortController().signal,
    ),
  ).resolves.toEqual([
    {
      type: 'resource',
      resource: {
        uri: pathToFileURL(await realpath(file)).href,
        mimeType: 'text/plain',
        text: 'Portal attachment content.',
      },
    },
  ]);
});

test.each([
  'outside',
  'relative',
  'parent-symlink',
  'symlink',
  'hardlink',
  'directory',
])('refuses %s paths instead of reading an unselected file', async (kind) => {
  const outside = join(directory, 'private.txt');
  await writeFile(outside, 'Unselected contents');
  let file = join(baseDir, 'selected.txt');
  if (kind === 'outside') file = outside;
  if (kind === 'relative') file = 'selected.txt';
  if (kind === 'parent-symlink') {
    await symlink(directory, join(baseDir, 'linked'));
    file = join(baseDir, 'linked', 'private.txt');
  }
  if (kind === 'symlink') await symlink(outside, file);
  if (kind === 'hardlink') await link(outside, file);
  if (kind === 'directory') await mkdir(file);
  await expect(
    readOpenCodeAttachments(
      { baseDir, paths: [file] },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/attachment|regular files/);
});

test('rejects a linked attachment root', async () => {
  const alias = join(directory, 'alias');
  await symlink(baseDir, alias);
  await expect(
    readOpenCodeAttachments(
      { baseDir: alias, paths: [join(alias, 'file.txt')] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('attachment directory');
});

test('bounds the aggregate size across files', async () => {
  const first = join(baseDir, 'first.txt');
  const second = join(baseDir, 'second.txt');
  await writeFile(first, Buffer.alloc(3 * 1024 * 1024, 65));
  await writeFile(second, Buffer.alloc(2 * 1024 * 1024, 66));
  await expect(
    readOpenCodeAttachments(
      { baseDir, paths: [first, second] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('4 MB');
});

test('bounds escaped text before it reaches the protocol transport', async () => {
  const file = join(baseDir, 'escaped.txt');
  await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 1));
  await expect(
    readOpenCodeAttachments(
      { baseDir, paths: [file] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('after encoding');
});

test('refuses unrecognized binary files rather than corrupting them as text', async () => {
  const file = join(baseDir, 'binary.bin');
  await writeFile(file, Buffer.from([255, 254, 0, 128]));
  await expect(
    readOpenCodeAttachments(
      { baseDir, paths: [file] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('UTF-8');
});

test('refuses an excessive selection before opening files', async () => {
  await expect(
    readOpenCodeAttachments(
      {
        baseDir,
        paths: Array.from({ length: 33 }, () => join(baseDir, 'missing')),
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('32 attachments');
});

test('observes cancellation before reading', async () => {
  await expect(
    readOpenCodeAttachments(
      { baseDir, paths: [join(baseDir, 'missing')] },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  await expect(
    readOpenCodeAttachments(undefined, new AbortController().signal),
  ).resolves.toEqual([]);
});

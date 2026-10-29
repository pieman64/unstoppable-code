import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  openAuthorizedRegularFile,
  readAuthorizedRegularFile,
} from '../authorized-file-open';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'visual-open-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('reads bounded regular files and closes the handle', async () => {
  const file = join(root, 'a.png');
  const roots = { paths: [await realpath(root)] };
  await writeFile(file, Buffer.from([1, 2, 3]));
  expect(await readAuthorizedRegularFile(file, roots, 3)).toEqual(
    Buffer.from([1, 2, 3]),
  );
  await expect(readAuthorizedRegularFile(file, roots, 2)).rejects.toThrow();
});

test('rejects outside roots, escaping symlinks, and network device paths', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'visual-outside-'));
  const roots = { paths: [await realpath(root)] };
  try {
    const file = join(outside, 'secret.png');
    await writeFile(file, 'secret');
    await symlink(file, join(root, 'escape.png'));
    await expect(openAuthorizedRegularFile(file, roots)).rejects.toThrow(
      'outside',
    );
    await expect(
      openAuthorizedRegularFile(join(root, 'escape.png'), roots),
    ).rejects.toThrow('outside');
    await expect(
      openAuthorizedRegularFile('\\\\server\\share\\x.png', roots),
    ).rejects.toThrow('network and device');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// A read-only open of a FIFO with no writer blocks; Windows has no mkfifo.
(process.platform === 'win32' ? test.skip : test)(
  'rejects a FIFO without hanging',
  async () => {
    const path = join(root, 'pipe.png');
    execFileSync('mkfifo', [path]);
    const roots = { paths: [await realpath(root)] };
    await expect(openAuthorizedRegularFile(path, roots)).rejects.toThrow(
      'regular file',
    );
  },
);

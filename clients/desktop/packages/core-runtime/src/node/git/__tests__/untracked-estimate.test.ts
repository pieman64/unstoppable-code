import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateGitUntrackedChanges } from '../untracked-estimate';

const posix = process.platform === 'win32' ? describe.skip : describe;
let base = '';
let root = '';
let outside = '';

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'untracked-')));
  root = join(base, 'checkout');
  outside = join(base, 'outside');
  await mkdir(join(root, 'dir'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'two.txt'), 'a\nb\n');
  await writeFile(join(root, 'dir', 'open.txt'), 'a\nb\nc');
  await writeFile(join(root, 'bin.dat'), Buffer.from([0x61, 0, 0x62]));
  await writeFile(join(outside, 'secret.txt'), 'x\ny\nz\nw\n');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

posix('untracked line estimates', () => {
  it('counts lines and flags binary files alike with and without confinement', async () => {
    const files = ['two.txt', 'dir/open.txt', 'bin.dat', 'missing.txt'];
    const expected = [
      { insertions: 2, binary: false },
      { insertions: 3, binary: false },
      { insertions: 0, binary: true },
      { insertions: 0, binary: false },
    ];
    await expect(estimateGitUntrackedChanges(root, files)).resolves.toEqual(expected); // prettier-ignore
    await expect(estimateGitUntrackedChanges(root, files, { confined: true })).resolves.toEqual(expected); // prettier-ignore
  });

  it('never follows a final symbolic link', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    for (const confined of [false, true])
      await expect(
        estimateGitUntrackedChanges(root, ['link.txt'], { confined }),
      ).resolves.toEqual([{ insertions: 0, binary: false }]);
  });

  it('reads nothing through a directory that resolves outside the checkout when confined', async () => {
    // A directory swapped for a link after Git listed `swapped/secret.txt`.
    await symlink(outside, join(root, 'swapped'));
    const files = ['swapped/secret.txt', '../outside/secret.txt', 'two.txt'];
    await expect(
      estimateGitUntrackedChanges(root, files, { confined: true }),
    ).resolves.toEqual([
      { insertions: 0, binary: false },
      { insertions: 0, binary: false },
      { insertions: 2, binary: false },
    ]);
    // The desktop's unconfined read follows the directory, as before.
    await expect(
      estimateGitUntrackedChanges(root, files.slice(0, 1)),
    ).resolves.toEqual([{ insertions: 4, binary: false }]);
  });

  it('counts nothing when the confined checkout cannot be resolved', async () => {
    await expect(
      estimateGitUntrackedChanges(join(base, 'gone'), ['two.txt'], {
        confined: true,
      }),
    ).resolves.toEqual([{ insertions: 0, binary: false }]);
  });
});

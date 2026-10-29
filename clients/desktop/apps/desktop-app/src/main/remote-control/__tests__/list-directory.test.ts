import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRemoteDirectory } from '../host/list-directory';

describe('listRemoteDirectory', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'remote-list-'));
    mkdirSync(join(root, 'real-folder'));
    writeFileSync(join(root, 'real-file.txt'), 'x');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists links to folders and files by what they point at', async () => {
    symlinkSync(join(root, 'real-folder'), join(root, 'linked-folder'));
    symlinkSync(join(root, 'real-file.txt'), join(root, 'linked-file.txt'));
    symlinkSync(join(root, 'missing'), join(root, 'broken-link'));
    const listing = await listRemoteDirectory({ path: root });
    expect(listing.entries).toEqual([
      {
        name: 'linked-folder',
        path: join(root, 'linked-folder'),
        kind: 'directory',
      },
      {
        name: 'real-folder',
        path: join(root, 'real-folder'),
        kind: 'directory',
      },
      {
        name: 'linked-file.txt',
        path: join(root, 'linked-file.txt'),
        kind: 'file',
      },
      {
        name: 'real-file.txt',
        path: join(root, 'real-file.txt'),
        kind: 'file',
      },
    ]);
  });
});

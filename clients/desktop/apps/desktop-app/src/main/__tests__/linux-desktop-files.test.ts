import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  desktopFileIndex,
  linuxDataRoots,
  readDesktopBytes,
} from '../lib/linux-desktop-files';

// Real filesystem fixtures use Linux/POSIX paths; Windows keeps the portable
// parser, launch, cache, and unchanged Windows application suites.
const testPosix =
  jest
    .requireActual<{
      hostOperatingSystem: () => 'darwin' | 'linux' | 'win32' | null;
    }>('@canopy/core-platform/host-platform')
    .hostOperatingSystem() === 'win32'
    ? test.skip
    : test;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-files-'));
});
afterEach(async () => {
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
});

testPosix(
  'XDG accepts absolute roots only, deduplicates, and uses standard fallback',
  () => {
    expect(
      linuxDataRoots(
        { XDG_DATA_HOME: 'relative', XDG_DATA_DIRS: 'relative::also-relative' },
        '/home/user',
      ),
    ).toEqual(['/home/user/.local/share', '/usr/local/share', '/usr/share']);
    expect(
      linuxDataRoots(
        {
          XDG_DATA_HOME: '/custom',
          XDG_DATA_DIRS: '/system:relative:/custom:/system',
        },
        '/home/user',
      ),
    ).toEqual(['/custom', '/system']);
    expect(
      linuxDataRoots(
        { XDG_DATA_HOME: '/bad\nroot', XDG_DATA_DIRS: '' },
        '/home/user',
      )[0],
    ).toBe('/home/user/.local/share');
  },
);

testPosix(
  'dangling user symlink claims its desktop ID before system fallback',
  async () => {
    const user = join(root, 'user'),
      system = join(root, 'system');
    await mkdir(join(user, 'applications'), { recursive: true });
    await mkdir(join(system, 'applications'), { recursive: true });
    await symlink(
      join(root, 'missing'),
      join(user, 'applications/editor.desktop'),
    );
    await writeFile(
      join(system, 'applications/editor.desktop'),
      'valid system entry',
    );
    expect((await desktopFileIndex([user, system])).get('editor.desktop')).toBe(
      join(user, 'applications/editor.desktop'),
    );
  },
);

testPosix('bounded file reads refuse oversized and special files', async () => {
  const file = join(root, 'entry');
  await writeFile(file, '12345');
  expect(await readDesktopBytes(file, 4)).toBeUndefined();
  expect((await readDesktopBytes(file, 5))?.toString()).toBe('12345');
  expect(await readDesktopBytes(root, 100)).toBeUndefined();
});

testPosix(
  'scan depth exhaustion fails closed rather than resurrecting system entries',
  async () => {
    const user = join(root, 'user'),
      system = join(root, 'system');
    await mkdir(
      join(user, 'applications', ...Array.from({ length: 14 }, () => 'nested')),
      { recursive: true },
    );
    await mkdir(join(system, 'applications'), { recursive: true });
    await writeFile(join(system, 'applications/editor.desktop'), 'system');
    expect(await desktopFileIndex([user, system])).toEqual(new Map());
  },
);

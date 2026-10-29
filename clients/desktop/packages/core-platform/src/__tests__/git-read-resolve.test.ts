import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBareCommand, searchDirectories } from '../git-read/commands';
import {
  type ExecutableProbe,
  nodeExecutableProbe,
  resolveBareCommand,
} from '../git-read/resolve';

const posix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

/** Accepts only `present`, recording every candidate it was asked about. */
function probeFor(present: readonly string[]): {
  probe: ExecutableProbe;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    probe: (candidate): Promise<boolean> => {
      asked.push(candidate);
      return Promise.resolve(present.includes(candidate));
    },
  };
}

describe('isBareCommand', () => {
  it.each<['darwin' | 'linux' | 'win32', string, boolean]>([
    ['win32', 'where.exe', true],
    ['win32', 'git', true],
    ['win32', '.git', true],
    ['win32', 'sub\\git.exe', false],
    ['win32', 'sub/git.exe', false],
    ['win32', '.\\git.exe', false],
    ['win32', 'C:git.exe', false],
    ['win32', 'C:\\Git\\git.exe', false],
    ['win32', '.', false],
    ['win32', '..', false],
    ['win32', '', false],
    ['win32', 'g\0it', false],
    ['linux', 'git', true],
    // POSIX names may contain backslashes and colons.
    ['linux', 'a\\b:c', true],
    ['linux', './git', false],
    ['linux', 'bin/git', false],
    ['linux', '/usr/bin/git', false],
    ['darwin', '..', false],
  ])('%s %j is bare: %s', (os, file, bare) => {
    expect(isBareCommand(os, file)).toBe(bare);
  });
});

describe('searchDirectories', () => {
  it('keeps only absolute POSIX entries, in order', () => {
    expect(
      searchDirectories('linux', '::/usr/bin:bin:.:/opt/git/:./x:/bin'),
    ).toEqual(['/usr/bin', '/opt/git/', '/bin']);
  });

  it('unquotes Windows entries and keeps only drive or UNC paths', () => {
    expect(
      searchDirectories(
        'win32',
        ';"C:\\Program Files\\Git\\cmd";bin;.;C:rel;\\rooted;\\\\server\\share;D:/Tools;\'E:\\Quoted\'',
      ),
    ).toEqual([
      'C:\\Program Files\\Git\\cmd',
      '\\\\server\\share',
      'D:/Tools',
      'E:\\Quoted',
    ]);
  });

  // libuv v1.51 `src/win/process.c` `search_path`: a quoted entry runs to its
  // closing quote, then to the next `;`; one leading and one trailing quote
  // are then removed.
  it.each<[string, string, string[]]>([
    ['a double-quoted entry containing ;', '"C:\\a;b";C:\\c', ['C:\\a;b', 'C:\\c']], // prettier-ignore
    ['a single-quoted entry containing ;', "'C:\\a;b';C:\\c", ['C:\\a;b', 'C:\\c']], // prettier-ignore
    ['an unterminated quote, to the end', 'C:\\x;"D:\\a;b', ['C:\\x', 'D:\\a;b']], // prettier-ignore
    ['an unterminated quote ending in the other quote', "\"D:\\a;b'", ['D:\\a;b']], // prettier-ignore
    ['a quoted entry holding the other quote', "\"C:\\it's;x\";D:\\", ["C:\\it's;x", 'D:\\']], // prettier-ignore
    ['mismatched quotes', '"C:\\a\';D:\\b', ["C:\\a';D:\\b"]],
    ['text after the closing quote', '"C:\\a"b;C:\\c', ['C:\\a"b', 'C:\\c']],
    ['a leading ;', ';C:\\a', ['C:\\a']],
    ['leading ;;', ';;C:\\a', ['C:\\a']],
    ['empty slices', 'C:\\a;;C:\\b;', ['C:\\a', 'C:\\b']],
    ['only separators', ';;;', []],
    ['unquoted entries ending in a quote', 'C:\\a";D:\\b\'', ['C:\\a', 'D:\\b']], // prettier-ignore
    ['a quote inside an unquoted entry', 'C:\\a"b;c";D:\\d', ['C:\\a"b', 'D:\\d']], // prettier-ignore
    ['only one quote removed from each end', '""C:\\a"";D:\\b', ['D:\\b']],
    ['an empty quoted entry', '"";\'\';C:\\a', ['C:\\a']],
    ['a lone trailing quote', 'C:\\a;"', ['C:\\a']],
    ['a quoted UNC entry containing ;', '"\\\\server\\a;b";\\\\?\\C:\\x', ['\\\\server\\a;b']], // prettier-ignore
  ])('walks Windows PATH like libuv: %s', (_case, value, expected) => {
    expect(searchDirectories('win32', value)).toEqual(expected);
  });

  it('splits POSIX PATH on every colon, quotes included', () => {
    expect(searchDirectories('linux', '"/a:b";/c:/d"')).toEqual(['/d"']);
  });

  it('is empty for an unset or empty PATH', () => {
    expect(searchDirectories('linux', undefined)).toEqual([]);
    expect(searchDirectories('win32', undefined)).toEqual([]);
    expect(searchDirectories('win32', '')).toEqual([]);
  });
});

describe('resolveBareCommand', () => {
  it('tries the libuv Windows candidates per directory, in PATH order', async () => {
    const { probe, asked } = probeFor(['D:\\Git\\git.exe']);
    const found = await resolveBareCommand(
      'win32',
      'git',
      'C:\\Windows\\System32\\;rel;D:\\Git',
      probe,
    );
    expect(found).toBe('D:\\Git\\git.exe');
    // A name without an extension is never tried as-is; relative entries never.
    expect(asked).toEqual([
      'C:\\Windows\\System32\\git.com',
      'C:\\Windows\\System32\\git.exe',
      'D:\\Git\\git.com',
      'D:\\Git\\git.exe',
    ]);
  });

  it('probes a quoted Windows directory containing ; as one directory', async () => {
    const { probe, asked } = probeFor([]);
    await resolveBareCommand('win32', 'git', '"C:\\a;b";D:\\c', probe);
    expect(asked).toEqual([
      'C:\\a;b\\git.com',
      'C:\\a;b\\git.exe',
      'D:\\c\\git.com',
      'D:\\c\\git.exe',
    ]);
  });

  it('tries a name with an extension as-is first', async () => {
    const { probe, asked } = probeFor(['C:\\Windows\\System32\\where.exe']);
    const found = await resolveBareCommand(
      'win32',
      'where.exe',
      'C:\\Windows\\System32',
      probe,
    );
    expect(found).toBe('C:\\Windows\\System32\\where.exe');
    expect(asked).toEqual(['C:\\Windows\\System32\\where.exe']);
  });

  // libuv `search_path`: `wcschr(name, '.')` with a non-NUL next character;
  // `search_path_join_test` adds the dot only after a name not ending in one.
  it.each<[string, string[]]>([
    ['where.exe', ['where.exe', 'where.exe.com', 'where.exe.exe']],
    ['a.b.', ['a.b.', 'a.b.com', 'a.b.exe']],
    ['.git', ['.git', '.git.com', '.git.exe']],
    ['.git.', ['.git.', '.git.com', '.git.exe']],
    ['..git', ['..git', '..git.com', '..git.exe']],
    ['a..', ['a..', 'a..com', 'a..exe']],
    ['git.', ['git.com', 'git.exe']],
    ['git', ['git.com', 'git.exe']],
  ])('tries the libuv Windows candidates for %j', async (name, names) => {
    const { probe, asked } = probeFor([]);
    expect(
      await resolveBareCommand('win32', name, 'C:\\Bin', probe),
    ).toBeUndefined();
    expect(asked).toEqual(names.map((candidate) => `C:\\Bin\\${candidate}`));
  });

  // libuv `search_path_join_test`: no separator after `\`, `/` or `:`.
  it('adds no separator after a Windows directory ending in a separator or colon', async () => {
    const { probe, asked } = probeFor([]);
    await resolveBareCommand('win32', 'git', 'C:\\A\\;D:/B/;E:\\C:', probe);
    expect(asked).toEqual([
      'C:\\A\\git.com',
      'C:\\A\\git.exe',
      'D:/B/git.com',
      'D:/B/git.exe',
      'E:\\C:git.com',
      'E:\\C:git.exe',
    ]);
  });

  it.each<['darwin' | 'linux' | 'win32', string]>([
    ['win32', ''],
    ['win32', '.'],
    ['linux', ''],
    ['linux', '.'],
  ])('%s: is undefined, asking nothing, for %j', async (os, name) => {
    const { probe, asked } = probeFor([]);
    const path = os === 'win32' ? 'C:\\Bin' : '/bin';
    expect(await resolveBareCommand(os, name, path, probe)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('prefers .com to .exe within a directory, as libuv does', async () => {
    const { probe } = probeFor(['C:\\Bin\\git.com', 'C:\\Bin\\git.exe']);
    expect(await resolveBareCommand('win32', 'git', 'C:\\Bin', probe)).toBe(
      'C:\\Bin\\git.com',
    );
  });

  it('joins POSIX entries literally, without normalizing', async () => {
    const { probe, asked } = probeFor([]);
    expect(
      await resolveBareCommand('linux', 'git', '/a/../b:/c/', probe),
    ).toBeUndefined();
    expect(asked).toEqual(['/a/../b/git', '/c/git']);
  });

  it('is undefined, asking nothing, without an absolute entry', async () => {
    const { probe, asked } = probeFor(['git']);
    expect(await resolveBareCommand('linux', 'git', ':.:bin', probe)).toBeUndefined(); // prettier-ignore
    expect(asked).toEqual([]);
  });
});

posix('nodeExecutableProbe on the running POSIX host', () => {
  let dir = '';
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';

  beforeAll(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'git-read-resolve-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips directories and non-executable files, as execvp does', async () => {
    const [first, second, third] = ['a', 'b', 'c'].map((name) => {
      const entry = join(dir, name);
      mkdirSync(entry);
      return entry;
    });
    mkdirSync(join(first ?? '', 'git'));
    writeFileSync(join(second ?? '', 'git'), '#!/bin/sh\n');
    chmodSync(join(second ?? '', 'git'), 0o644);
    writeFileSync(join(third ?? '', 'git'), '#!/bin/sh\n');
    chmodSync(join(third ?? '', 'git'), 0o755);
    const found = await resolveBareCommand(
      os,
      'git',
      [first, second, third].join(':'),
      nodeExecutableProbe(os),
    );
    expect(found).toBe(join(third ?? '', 'git'));
  });

  it('is undefined when no directory has the command', async () => {
    expect(
      await resolveBareCommand(os, 'canopy-missing', dir, nodeExecutableProbe(os)), // prettier-ignore
    ).toBeUndefined();
  });
});

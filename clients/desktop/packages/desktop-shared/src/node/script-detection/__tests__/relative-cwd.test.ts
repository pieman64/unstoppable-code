import {
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTerminalRelativeCwd } from '../../terminal-relative-cwd';

describe('terminal relative directory', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'script-cwd-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('resolves packages and preserves an absent directory', async () => {
    await mkdir(join(root, 'apps/web'), { recursive: true });
    expect(resolveTerminalRelativeCwd(root, '')).toBeUndefined();
    expect(resolveTerminalRelativeCwd(root, undefined)).toBeUndefined();
    expect(resolveTerminalRelativeCwd(root, 'apps/web')).toBe(
      await realpath(join(root, 'apps/web')),
    );
  });
  it.each([
    '../outside',
    'a/../b',
    '/tmp',
    'C:/tmp',
    'C:tmp',
    '\\\\host\\share',
    'a\\b',
    'a\0b',
    'missing',
  ])('refuses %s', (value) => {
    expect(() => resolveTerminalRelativeCwd(root, value)).toThrow();
  });
  it('refuses files and realpath escapes including sibling prefixes', async () => {
    await writeFile(join(root, 'file'), 'x');
    const sibling = `${root}-sibling`;
    await mkdir(sibling);
    try {
      await symlink(sibling, join(root, 'escape'));
      expect(() => resolveTerminalRelativeCwd(root, 'escape')).toThrow();
      expect(() => resolveTerminalRelativeCwd(root, 'file')).toThrow();
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutableOnPath } from '../path-lookup';

const originalPath = process.env.PATH;
const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('findExecutableOnPath', () => {
  it('skips non-executable POSIX files that shadow commands', () => {
    const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-lookup-'));
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-lookup-'));
    tempDirs.push(firstDir, secondDir);

    const shadow = path.join(firstDir, 'tool');
    const executable = path.join(secondDir, 'tool');
    fs.writeFileSync(shadow, '');
    fs.writeFileSync(executable, '');
    fs.chmodSync(shadow, 0o644);
    fs.chmodSync(executable, 0o755);
    process.env.PATH = [firstDir, secondDir].join(path.delimiter);

    expect(findExecutableOnPath('tool')).toBe(fs.realpathSync(executable));
  });

  it('can resolve against an explicit PATH value', () => {
    const executableDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'path-lookup-'),
    );
    tempDirs.push(executableDir);
    const executable = path.join(executableDir, 'tool');
    fs.writeFileSync(executable, '');
    fs.chmodSync(executable, 0o755);
    process.env.PATH = '';

    expect(findExecutableOnPath('tool', executableDir)).toBe(
      fs.realpathSync(executable),
    );
  });

  it('ignores relative PATH entries before resolving an executable', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-lookup-'));
    const trustedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-lookup-'));
    tempDirs.push(rootDir, trustedDir);
    const relativeDir = path.join(rootDir, 'tools');
    fs.mkdirSync(relativeDir);

    const untrustedExecutable = path.join(relativeDir, 'tool');
    const trustedExecutable = path.join(trustedDir, 'tool');
    fs.writeFileSync(untrustedExecutable, '');
    fs.writeFileSync(trustedExecutable, '');
    fs.chmodSync(untrustedExecutable, 0o755);
    fs.chmodSync(trustedExecutable, 0o755);
    process.chdir(rootDir);

    const relativePathEntries = ['.', 'tools', trustedDir].join(path.delimiter);

    expect(findExecutableOnPath('tool', relativePathEntries)).toBe(
      fs.realpathSync(trustedExecutable),
    );
  });
});

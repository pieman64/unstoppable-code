import type * as NodeFs from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicallySync } from '../atomic-file';

const actualFs = jest.requireActual<typeof NodeFs>('node:fs');
const mockRenameSync = jest.fn<void, [NodeFs.PathLike, NodeFs.PathLike]>();
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof NodeFs>('node:fs'),
  renameSync: (source: NodeFs.PathLike, target: NodeFs.PathLike): void =>
    mockRenameSync(source, target),
}));

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('writeFileAtomicallySync', () => {
  const originalPlatform = process.platform;
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atomic-file-sync-'));
    mockRenameSync.mockReset();
    mockRenameSync.mockImplementation(actualFs.renameSync);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    rmSync(root, { recursive: true, force: true });
  });

  it('installs complete content through a renamed sibling and leaves no temporary file', () => {
    const target = join(root, 'state.json');
    writeFileSync(target, 'previous');
    const previousInode = statSync(target).ino;

    writeFileAtomicallySync(target, 'next', {
      encoding: 'utf8',
      durable: true,
    });

    expect(readFileSync(target, 'utf8')).toBe('next');
    expect(statSync(target).ino).not.toBe(previousInode);
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('keeps the previous file and removes its temporary sibling when the install fails', () => {
    const target = join(root, 'state.json');
    writeFileSync(target, 'previous');
    mockRenameSync.mockImplementation(() => {
      throw errnoError('EIO');
    });

    expect(() =>
      writeFileAtomicallySync(target, 'next', { durable: true }),
    ).toThrow('EIO');

    expect(readFileSync(target, 'utf8')).toBe('previous');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('retries a transient Windows sharing violation before installing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const target = join(root, 'state.json');
    let failures = 0;
    mockRenameSync.mockImplementation((source, destination) => {
      if (failures < 2) {
        failures += 1;
        throw errnoError('EBUSY');
      }
      actualFs.renameSync(source, destination);
    });

    writeFileAtomicallySync(target, 'next');

    expect(failures).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe('next');
  });

  it('gives up after its retry budget and leaves no target', () => {
    const target = join(root, 'state.json');
    mockRenameSync.mockImplementation(() => {
      throw errnoError('EBUSY');
    });

    expect(() => writeFileAtomicallySync(target, 'next')).toThrow('EBUSY');
    expect(mockRenameSync).toHaveBeenCalledTimes(5);
    expect(existsSync(target)).toBe(false);
  });

  it('does not retry a failure that is not a sharing violation', () => {
    const target = join(root, 'state.json');
    mockRenameSync.mockImplementation(() => {
      throw errnoError('EIO');
    });

    expect(() => writeFileAtomicallySync(target, 'next')).toThrow('EIO');
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });
});

/**
 * Published base generations are 1–1.6 GB. Preparing an incremental staging
 * build must request a copy-on-write clone (APFS/ReFS/Btrfs) instead of a
 * full byte copy; `COPYFILE_FICLONE` still falls back to a regular copy on
 * filesystems without cloning.
 */
import type * as NodeFsPromises from 'node:fs/promises';
import {
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const mockCopyFile = jest.fn();
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
  return {
    ...actual,
    copyFile: (...args: Parameters<typeof actual.copyFile>): Promise<void> => {
      mockCopyFile(...args);
      return actual.copyFile(...args);
    },
  };
});

import { prepareCodeGraphBaseStaging } from '../base-graph';

describe('code graph base staging copies', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-staging-copy-'));
    mockCopyFile.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('clones the published generation into private staging', async () => {
    const sourceDbPath = path.join(root, 'published.db');
    writeFileSync(sourceDbPath, 'published-generation');

    const staging = await prepareCodeGraphBaseStaging({
      variantDir: path.join(root, 'variant'),
      buildId: 'build-a',
      sourceDbPath,
    });

    expect(mockCopyFile).toHaveBeenCalledWith(
      sourceDbPath,
      staging.dbPath,
      fsConstants.COPYFILE_FICLONE,
    );
    expect(readFileSync(staging.dbPath, 'utf8')).toBe('published-generation');
  });
});

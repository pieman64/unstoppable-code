import { homedir, tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import {
  getBrandDataDirCandidates,
  getCanopyDataDir,
  getResolvedCanopySecureDataDir,
  resetResolvedCanopyDataDirCache,
} from '@canopy/desktop-shared/canopy-paths';

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

describe('jest data directory isolation', () => {
  beforeEach(() => {
    resetResolvedCanopyDataDirCache();
  });

  it('never resolves the developer’s real data or secure directory', () => {
    const dataDir = getCanopyDataDir();
    const brandRoots = getBrandDataDirCandidates('prod').concat(
      getBrandDataDirCandidates('dev'),
    );

    for (const root of brandRoots) {
      expect(dataDir === root || isInside(dataDir, root)).toBe(false);
    }
    expect(isInside(dataDir, homedir()) && !isInside(dataDir, tmpdir())).toBe(
      false,
    );
    expect(
      isInside(dataDir, realpathSync(tmpdir())) || isInside(dataDir, tmpdir()),
    ).toBe(true);
    expect(
      isInside(getResolvedCanopySecureDataDir().path, homedir()) &&
        !isInside(getResolvedCanopySecureDataDir().path, tmpdir()),
    ).toBe(false);
  });
});

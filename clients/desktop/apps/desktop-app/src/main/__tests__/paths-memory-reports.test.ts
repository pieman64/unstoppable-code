import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { getMemoryReportsDir } from '../lib/paths';

describe('main memory reports path', () => {
  const originalCanopyEnv = process.env.CANOPY_ENV;
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  const originalNodeEnv = process.env.NODE_ENV;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalCanopyEnv === undefined) {
      delete process.env.CANOPY_ENV;
    } else {
      process.env.CANOPY_ENV = originalCanopyEnv;
    }
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    resetResolvedCanopyDataDirForTests();
  });

  afterAll(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves under the selected data root without creating the reports directory', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-memory-reports-'),
    );
    tempDirs.push(dataDir);
    process.env.CANOPY_DATA_DIR = dataDir;

    expect(getMemoryReportsDir()).toBe(path.join(dataDir, 'memory-reports'));
    expect(fs.existsSync(path.join(dataDir, 'memory-reports'))).toBe(false);
  });
});

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FsModule from 'node:fs';
import type * as V8Module from 'node:v8';

// Runs against the real filesystem so symlinked ancestors resolve the way
// they do for a user's data directory.
const mockPaths = { reportsDir: '' };

jest.mock('electron', () => ({
  app: { getAppMetrics: (): never[] => [], getVersion: (): string => '1.0.0' },
}));
jest.mock('../../lib/paths', () => ({
  getMemoryReportsDir: (): string => mockPaths.reportsDir,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('node:inspector', () => ({
  Session: class {
    connect(): void {
      throw new Error('Inspector is unavailable in this test.');
    }
    disconnect(): void {}
    post(): void {}
  },
}));
jest.mock('node:v8', () => {
  const actualV8 = jest.requireActual<typeof V8Module>('node:v8');
  const actualFs = jest.requireActual<typeof FsModule>('node:fs');
  return {
    ...actualV8,
    writeHeapSnapshot: (path: string): string => {
      actualFs.writeFileSync(path, '{}');
      return path;
    },
  };
});

describe('memory diagnostics with a symlinked data directory', () => {
  let baseDir = '';

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'memory-diagnostics-'));
    const realDataDir = join(baseDir, 'real-data');
    const linkedDataDir = join(baseDir, 'linked-data');
    mkdirSync(realDataDir);
    // `junction` lets Windows create the link without elevation; other
    // platforms ignore the type.
    symlinkSync(realDataDir, linkedDataDir, 'junction');
    mockPaths.reportsDir = join(linkedDataDir, 'memory-reports');
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('creates and resolves reports under the canonical reports folder', async () => {
    const { configureMemoryDiagnostics, getMemoryDiagnosticsService } =
      await import('../index');
    configureMemoryDiagnostics({ getAppRenderers: () => [] });
    const service = getMemoryDiagnosticsService();
    service.setEnabled(true);

    try {
      const result = await service.createReport();
      if (!result.ok) {
        throw new Error(`Report failed: ${result.reason} ${result.message}`);
      }
      const canonicalReportsDir = join(
        realpathSync(join(baseDir, 'real-data')),
        'memory-reports',
      );
      expect(service.resolveReportPath(result.report.reportId)).toBe(
        join(canonicalReportsDir, result.report.reportId),
      );
    } finally {
      await service.dispose();
    }
  });
});

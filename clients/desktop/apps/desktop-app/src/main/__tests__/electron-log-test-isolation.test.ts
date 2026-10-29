import log from 'electron-log/main.js';
import { join } from 'node:path';
import { configureJestElectronLog } from '../../__tests__/jestElectronLogSetup';

describe('Jest electron-log isolation', () => {
  it('keeps file logging disabled unless this Jest run opted in', () => {
    if (process.env.CANOPY_JEST_FILE_LOGGING === '1') {
      expect(log.transports.file.level).not.toBe(false);
      return;
    }

    expect(log.transports.file.level).toBe(false);
  });

  it('routes opted-in logging to an isolated worker path', () => {
    const originalLevel = log.transports.file.level;
    const originalResolvePathFn = log.transports.file.resolvePathFn;

    try {
      const logPath = configureJestElectronLog(
        {
          CANOPY_JEST_FILE_LOGGING: '1',
          CANOPY_JEST_LOG_DIR: '/private/tmp/canopy-jest-diagnostics',
        },
        '/repo/worktrees/halibut',
        'worker/7',
      );

      expect(logPath).toBe(
        join(
          '/private/tmp/canopy-jest-diagnostics',
          'worker-worker_7',
          'main.log',
        ),
      );
      expect(log.transports.file.resolvePathFn()).toBe(logPath);
      expect(log.transports.file.level).toBe('silly');
    } finally {
      log.transports.file.resolvePathFn = originalResolvePathFn;
      log.transports.file.level = originalLevel;
    }
  });
});

const mockSetAppLogsPath = jest.fn();
const mockGetPath = jest.fn(() => '/test/user-data');
const mockLogInitialize = jest.fn();
const mockLogDebug = jest.fn();
const mockLogError = jest.fn();
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockIsE2eBuild = jest.fn(() => false);
const mockExistsSync = jest.fn(() => true);
let mockIsPackaged = false;

const mockFileTransport: {
  fileName: string;
  format: string;
  level: 'info' | 'debug' | false;
  maxSize: number;
  resolvePathFn: () => string;
} = {
  fileName: 'main.log',
  format: '',
  level: 'info',
  maxSize: 0,
  resolvePathFn: jest.fn(() => ''),
};

const mockConsoleTransport: {
  format: string;
  level: 'warn' | false;
} = {
  format: '',
  level: 'warn',
};
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

jest.mock('node:os', () => ({
  homedir: jest.fn(() => '/Users/test'),
}));

jest.mock('node:fs', () => ({
  get existsSync(): typeof mockExistsSync {
    return mockExistsSync;
  },
}));

jest.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return mockIsPackaged;
    },
    get getPath(): typeof mockGetPath {
      return mockGetPath;
    },
    get setAppLogsPath(): typeof mockSetAppLogsPath {
      return mockSetAppLogsPath;
    },
  },
}));

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: {
    get debug(): typeof mockLogDebug {
      return mockLogDebug;
    },
    get error(): typeof mockLogError {
      return mockLogError;
    },
    get info(): typeof mockLogInfo {
      return mockLogInfo;
    },
    get initialize(): typeof mockLogInitialize {
      return mockLogInitialize;
    },
    transports: {
      get console(): typeof mockConsoleTransport {
        return mockConsoleTransport;
      },
      get file(): typeof mockFileTransport {
        return mockFileTransport;
      },
    },
    get warn(): typeof mockLogWarn {
      return mockLogWarn;
    },
  },
}));

jest.mock('../lib/e2e-gate', () => ({
  get isE2eBuild(): typeof mockIsE2eBuild {
    return mockIsE2eBuild;
  },
}));

import {
  getMainLogPath,
  initializeMainProcessLogging,
  logMainProcessInfo,
  logMainProcessWarn,
  resetMainProcessLoggingForTests,
} from '../lib/main-process-logging';

describe('main process logging', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    resetMainProcessLoggingForTests();
    mockIsE2eBuild.mockReturnValue(false);
    mockExistsSync.mockReturnValue(true);
    mockIsPackaged = false;
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_E2E_USER_DATA_DIR;
    delete process.env.CANOPY_E2E_ISOLATED_LOGGING;
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetMainProcessLoggingForTests();
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_E2E_USER_DATA_DIR;
    delete process.env.CANOPY_E2E_ISOLATED_LOGGING;
    jest.restoreAllMocks();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('uses the same branded macOS main.log path collected by feedback bundles', () => {
    expect(getMainLogPath('darwin', '/Users/test')).toBe(
      '/Users/test/Library/Logs/canopy-ui/main.log',
    );
  });

  it('isolates E2E file logging under the launch data directory', () => {
    mockIsE2eBuild.mockReturnValue(true);
    process.env.CANOPY_DATA_DIR = '/private/tmp/canopy-electron-test';

    expect(initializeMainProcessLogging()).toBe(
      '/private/tmp/canopy-electron-test/logs/main.log',
    );
    expect(mockFileTransport.resolvePathFn()).toBe(
      '/private/tmp/canopy-electron-test/logs/main.log',
    );
    expect(mockSetAppLogsPath).toHaveBeenCalledWith(
      '/private/tmp/canopy-electron-test/logs',
    );
  });

  it('falls back to the E2E user-data directory when the launch data directory is blank', () => {
    mockIsE2eBuild.mockReturnValue(true);
    process.env.CANOPY_DATA_DIR = '';
    process.env.CANOPY_E2E_USER_DATA_DIR =
      '/private/tmp/canopy-electron-user-data';

    expect(initializeMainProcessLogging()).toBe(
      '/private/tmp/canopy-electron-user-data/logs/main.log',
    );
  });

  it('does not let logging create a missing E2E data directory', () => {
    mockIsE2eBuild.mockReturnValue(true);
    mockExistsSync.mockReturnValue(false);
    process.env.CANOPY_DATA_DIR = '/private/tmp/missing-canopy-test';

    expect(initializeMainProcessLogging()).toBe(
      '/Users/test/Library/Logs/canopy-ui/main.log',
    );
    expect(mockSetAppLogsPath).not.toHaveBeenCalledWith(
      '/private/tmp/missing-canopy-test/logs',
    );
  });

  it('isolates unpackaged production-bundle logging for an explicit E2E harness launch', () => {
    mockIsE2eBuild.mockReturnValue(false);
    process.env.CANOPY_E2E_ISOLATED_LOGGING = '1';
    process.env.CANOPY_DATA_DIR = '/private/tmp/canopy-release-like-test';

    expect(initializeMainProcessLogging()).toBe(
      '/private/tmp/canopy-release-like-test/logs/main.log',
    );
  });

  it('ignores a data-directory logging override in a normal production launch', () => {
    mockIsE2eBuild.mockReturnValue(false);
    process.env.CANOPY_DATA_DIR = '/private/tmp/untrusted-log-override';

    expect(initializeMainProcessLogging()).toBe(
      '/Users/test/Library/Logs/canopy-ui/main.log',
    );
  });

  it('ignores the E2E harness marker in a packaged production launch', () => {
    mockIsPackaged = true;
    process.env.CANOPY_E2E_ISOLATED_LOGGING = '1';
    process.env.CANOPY_DATA_DIR = '/private/tmp/packaged-log-override';

    expect(initializeMainProcessLogging()).toBe(
      '/Users/test/Library/Logs/canopy-ui/main.log',
    );
  });

  it('uses the Electron user-data logs directory outside macOS', () => {
    expect(getMainLogPath('win32', '/unused')).toBe(
      '/test/user-data/logs/main.log',
    );
  });

  it('routes direct main-process diagnostics through the shared logger', () => {
    logMainProcessInfo('auth transition confirmed');
    logMainProcessWarn('auth probe failed', 'cli failed');

    expect(mockLogInfo).toHaveBeenCalledWith('auth transition confirmed');
    expect(mockLogWarn).toHaveBeenCalledWith('auth probe failed', 'cli failed');
  });

  it('initializes rotation and forwards console errors to the file logger', () => {
    // eslint-disable-next-line no-console -- capturing the original output contract
    const originalConsoleError = console.error;
    const logPath = initializeMainProcessLogging();

    expect(logPath).toBe('/Users/test/Library/Logs/canopy-ui/main.log');
    expect(mockSetAppLogsPath).toHaveBeenCalledWith(
      '/Users/test/Library/Logs/canopy-ui',
    );
    expect(mockFileTransport.maxSize).toBe(10 * 1024 * 1024);
    expect(mockFileTransport.resolvePathFn()).toBe(logPath);
    expect(mockLogInitialize).toHaveBeenCalledWith({
      preload: false,
      spyRendererConsole: false,
    });
    expect(mockConsoleTransport.level).toBe(false);

    const error = new Error('deletion failed');
    // eslint-disable-next-line no-console -- exercising the console forwarding contract
    console.error('Could not remove worktree', error);
    expect(mockLogError).toHaveBeenCalledWith(
      'Could not remove worktree',
      error,
    );
    expect(originalConsoleError).toHaveBeenCalledWith(
      'Could not remove worktree',
      error,
    );
  });

  it('initializes only once', () => {
    initializeMainProcessLogging();
    initializeMainProcessLogging();

    expect(mockLogInitialize).toHaveBeenCalledTimes(1);
    expect(mockSetAppLogsPath).toHaveBeenCalledTimes(1);
  });
});

import {
  type execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  stat: jest.fn(),
}));

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/mock/data'),
  getCanopyRuntimeMode: jest.fn(() => 'dev'),
}));

type ProbeCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;
type ProbeMock = jest.Mock<
  ReturnType<typeof execFile> | { unref: () => void },
  [string, string[], ExecFileOptionsWithStringEncoding, ProbeCallback]
>;
const { execFile: mockExecFile } = jest.requireMock<{ execFile: ProbeMock }>(
  'node:child_process',
);

import {
  getLinuxProbeEnv,
  getLoginShellPath,
  prewarmLoginShellPath,
  resetLoginShellPathCache,
  setLoginShellProbe,
  type LoginShellProbe,
} from '@canopy/desktop-shared/pipelines/config-paths';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);
const originalArchDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
const originalEnv = { ...process.env };
const macosTest = process.platform === 'darwin' ? it : it.skip;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    writable: true,
    configurable: true,
  });
}

/**
 * Make the execFile mock complete asynchronously with `stdout` (or an
 * error), mirroring the real child-process callback timing.
 */
function mockShellResolution(stdout: string | Error): void {
  mockExecFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queueMicrotask(() => {
        if (stdout instanceof Error) {
          callback(stdout, '', '');
        } else {
          callback(null, stdout, '');
        }
      });
      return { unref: (): void => {} };
    },
  );
}

describe('getLoginShellPath', () => {
  beforeEach(() => {
    resetLoginShellPathCache();
    mockExecFile.mockReset();
    process.env = { ...originalEnv };
    setPlatform('darwin');
  });

  afterAll(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    process.env = originalEnv;
  });

  macosTest.each(['zsh', 'bash'])(
    'preserves an unexported PATH from real %s without interpreting its contents',
    async (shell) => {
      const realExecFile = jest.requireActual<{ execFile: typeof execFile }>(
        'node:child_process',
      ).execFile;
      const expected = '/custom Git/back\\slash/$literal:/usr/bin:/bin';
      process.env.PATH = '/usr/bin:/bin';
      process.env.SHELL = `/bin/${shell}`;
      mockExecFile.mockImplementation(
        (
          file: string,
          args: string[],
          options: ExecFileOptionsWithStringEncoding,
          callback: (
            error: ExecFileException | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => {
          const setup = `PATH='${expected}'; ${
            shell === 'zsh' ? 'typeset +x PATH' : 'export -n PATH'
          }; `;
          return realExecFile(
            file,
            [
              ...(shell === 'zsh' ? ['-f'] : ['--noprofile', '--norc']),
              '-lic',
              setup + args[1],
            ],
            options,
            callback,
          );
        },
      );

      await prewarmLoginShellPath();

      expect(getLoginShellPath()).toBe(expected);
    },
  );

  it('returns the fallback immediately on a cold cache and serves the resolved PATH after the background refresh', async () => {
    process.env.PATH = '/usr/bin:/bin';
    mockShellResolution('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\n');

    // Cold call never blocks: it returns the fallback and kicks off the
    // background login-shell resolution.
    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
    await prewarmLoginShellPath();
    expect(getLoginShellPath()).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      }),
      expect.any(Function),
    );
  });

  it('prewarmLoginShellPath resolves the cache before first use', async () => {
    mockShellResolution('/opt/homebrew/bin:/usr/bin:/bin\n');

    await prewarmLoginShellPath();

    expect(getLoginShellPath()).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('takes the last non-empty line to skip motd output', async () => {
    mockShellResolution('Welcome to zsh\n\n/opt/homebrew/bin:/usr/bin:/bin\n');

    await prewarmLoginShellPath();

    expect(getLoginShellPath()).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('falls back to process.env.PATH when the shell resolution errors', async () => {
    process.env.PATH = '/usr/bin:/bin';
    mockShellResolution(new Error('spawn failed'));

    await prewarmLoginShellPath();

    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
  });

  it('falls back to process.env.PATH when output is empty', async () => {
    process.env.PATH = '/usr/bin:/bin';
    mockShellResolution('\n');

    await prewarmLoginShellPath();

    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
  });

  it('falls back to the safe default PATH when process.env.PATH is unset', async () => {
    delete process.env.PATH;
    mockShellResolution(new Error('spawn failed'));

    await prewarmLoginShellPath();

    expect(getLoginShellPath()).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('returns process.env.PATH directly on Windows without spawning', () => {
    setPlatform('win32');
    process.env.PATH = '/usr/local/bin:/usr/bin';

    const result = getLoginShellPath();

    expect(result).toBe('/usr/local/bin:/usr/bin');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('caches the result after the first resolution', async () => {
    mockShellResolution('/opt/homebrew/bin:/usr/bin\n');

    await prewarmLoginShellPath();
    getLoginShellPath();
    getLoginShellPath();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('serves the stale value and re-resolves in the background after the TTL', async () => {
    mockShellResolution('/usr/bin:/bin\n');

    const nowSpy = jest.spyOn(Date, 'now');
    const baseTime = 1_000_000;
    nowSpy.mockReturnValue(baseTime);

    await prewarmLoginShellPath();
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Still within TTL — should use the cache without a new spawn.
    nowSpy.mockReturnValue(baseTime + 4 * 60_000);
    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Past TTL — the expired call still returns the stale value immediately
    // (never blocks) while triggering a background re-resolution.
    nowSpy.mockReturnValue(baseTime + 6 * 60_000);
    mockShellResolution('/new/path:/usr/bin\n');
    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    // Once the background refresh lands, callers see the new value.
    await prewarmLoginShellPath();
    expect(getLoginShellPath()).toBe('/new/path:/usr/bin');

    nowSpy.mockRestore();
  });

  it('resetLoginShellPathCache allows re-computation', async () => {
    mockShellResolution('/first/path\n');
    await prewarmLoginShellPath();
    expect(getLoginShellPath()).toBe('/first/path');

    resetLoginShellPathCache();
    mockShellResolution('/second/path\n');
    await prewarmLoginShellPath();

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(getLoginShellPath()).toBe('/second/path');
  });

  it('uses SHELL env var when available', async () => {
    process.env.SHELL = '/bin/fish';
    mockShellResolution('/usr/bin:/bin\n');

    await prewarmLoginShellPath();

    expect(mockExecFile).toHaveBeenCalledWith(
      '/bin/fish',
      ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('reads Fish PATH as a colon-separated string instead of list expansion', async () => {
    process.env.SHELL = '/opt/homebrew/bin/fish';
    const exportedPath = '/opt/homebrew/bin:/usr/bin:/bin';
    mockExecFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const command = args[1];
        queueMicrotask(() => {
          callback(
            null,
            command === 'exec /usr/bin/printf \'%s\\n\' "$PATH"'
              ? `${exportedPath}\n`
              : '/opt/homebrew/bin /usr/bin /bin\n',
            '',
          );
        });
        return { unref: (): void => {} };
      },
    );

    await prewarmLoginShellPath();

    expect(getLoginShellPath()).toBe(exportedPath);
  });

  it('runs lookups through an installed probe instead of execFile', async () => {
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const probe = jest.fn<
      ReturnType<LoginShellProbe>,
      Parameters<LoginShellProbe>
    >(() => Promise.resolve('motd\n/probed/bin:/usr/bin\n'));
    setLoginShellProbe(probe);
    try {
      await prewarmLoginShellPath();
    } finally {
      setLoginShellProbe(undefined);
    }

    expect(getLoginShellPath()).toBe('/probed/bin:/usr/bin');
    expect(mockExecFile).not.toHaveBeenCalled();
    const [request] = probe.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      file: '/bin/zsh',
      args: ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'],
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
    });
    expect(request?.env.PATH).toBe('/usr/bin:/bin');
    expect(request?.env.SHELL).toBe('/bin/zsh');
  });

  it('keeps the fallback when an installed probe fails', async () => {
    process.env.PATH = '/inherited/bin';
    setLoginShellProbe(() => Promise.resolve(undefined));
    try {
      await prewarmLoginShellPath();
    } finally {
      setLoginShellProbe(undefined);
    }

    expect(getLoginShellPath()).toBe('/inherited/bin');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('defaults to /bin/zsh when SHELL is not set', async () => {
    delete process.env.SHELL;
    mockShellResolution('/usr/bin:/bin\n');

    await prewarmLoginShellPath();

    expect(mockExecFile).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe.each(['x64', 'arm64'])('Linux %s login-shell PATH', (arch) => {
  type ProbeCallback = (
    error: Error | null,
    stdout: string,
    stderr: string,
  ) => void;
  const fileStats = statSync(__filename);
  const directoryStats = statSync(process.cwd());
  const mockAccess = jest.mocked(access);
  const mockStat = jest.mocked(stat);
  const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  const marker = '__CANOPY_LOGIN_PATH__';
  const resolvedPath = '/home/user/.local/bin:/usr/bin:/bin';

  function marked(value = resolvedPath): string {
    return `${marker}${value}\n`;
  }

  function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  function mockResponses(responses: Record<string, string | Error>): void {
    mockExecFile.mockImplementation(
      (
        file: string,
        _args: string[],
        _options: unknown,
        callback: ProbeCallback,
      ) => {
        const response = responses[file] ?? marked();
        queueMicrotask(() =>
          callback(
            response instanceof Error ? response : null,
            typeof response === 'string' ? response : '',
            '',
          ),
        );
        return { unref: jest.fn() };
      },
    );
  }

  function deferredProbes(): ProbeCallback[] {
    const callbacks: ProbeCallback[] = [];
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: ProbeCallback,
      ) => {
        callbacks.push(callback);
        return { unref: jest.fn() };
      },
    );
    return callbacks;
  }

  beforeEach(() => {
    resetLoginShellPathCache();
    mockExecFile.mockReset();
    mockAccess.mockReset().mockResolvedValue(undefined);
    mockStat.mockReset().mockResolvedValue(fileStats);
    process.env = { ...originalEnv, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' };
    setPlatform('linux');
    Object.defineProperty(process, 'arch', {
      value: arch,
      configurable: true,
    });
    Object.defineProperty(process, 'getuid', {
      value: () => 1001,
      configurable: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetLoginShellPathCache();
    if (originalPlatformDescriptor)
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    if (originalArchDescriptor)
      Object.defineProperty(process, 'arch', originalArchDescriptor);
    if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor);
    else Reflect.deleteProperty(process, 'getuid');
    process.env = { ...originalEnv };
  });

  it('runs the account and shell lookups through an installed probe', async () => {
    delete process.env.SHELL;
    const probe = jest.fn<
      ReturnType<LoginShellProbe>,
      Parameters<LoginShellProbe>
    >((request) =>
      Promise.resolve(
        request.file === '/usr/bin/getent'
          ? 'user:x:1001:1001::/home/user:/bin/bash\n'
          : `noise${marked()}`,
      ),
    );
    setLoginShellProbe(probe);
    try {
      await prewarmLoginShellPath();
    } finally {
      setLoginShellProbe(undefined);
    }

    expect(getLoginShellPath()).toBe(resolvedPath);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(probe.mock.calls.map(([request]) => request.file)).toEqual([
      '/usr/bin/getent',
      '/bin/bash',
    ]);
    expect(probe).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 10_000, maxBuffer: 64 * 1024 }),
    );
  });

  it.each(['darwin', 'win32'])(
    'does no executable validation on unsupported resolver route %s',
    async (platform) => {
      setPlatform(platform);
      Object.defineProperty(process, 'arch', {
        value: 'arm64',
        configurable: true,
      });
      mockShellResolution('/mac/bin:/usr/bin\n');
      await prewarmLoginShellPath();
      if (platform !== 'darwin') {
        expect(getLoginShellPath()).toBe('/usr/bin:/bin');
        expect(mockExecFile).not.toHaveBeenCalled();
      } else {
        expect(getLoginShellPath()).toBe('/mac/bin:/usr/bin');
        expect(mockExecFile).toHaveBeenCalledTimes(1);
      }
      expect(mockStat).not.toHaveBeenCalled();
      expect(mockAccess).not.toHaveBeenCalled();
    },
  );

  it.each(['/bin/bash', '/usr/bin/zsh', '/usr/bin/fish'])(
    'uses the Linux default %s and reads marked output after noisy profiles',
    async (shell) => {
      process.env.SHELL = shell;
      mockShellResolution(
        `welcome without newline${marked()}logout noise\n/usr/false-path\n`,
      );
      await prewarmLoginShellPath();
      expect(getLoginShellPath()).toBe(resolvedPath);
      expect(mockExecFile).toHaveBeenCalledWith(
        shell,
        ['-lic', `exec /usr/bin/printf '${marker}%s\\n' "$PATH"`],
        expect.objectContaining({
          timeout: 10_000,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
        }),
        expect.any(Function),
      );
      expect(mockAccess).toHaveBeenCalledWith(shell, constants.X_OK);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['error', 'unmarked'])(
    'retries the failed default once with validated Bash (%s)',
    async (failure) => {
      process.env.SHELL = '/usr/bin/zsh';
      mockResponses({
        '/usr/bin/zsh':
          failure === 'error' ? new Error('ETIMEDOUT') : '/usr/false-path\n',
      });
      await prewarmLoginShellPath();
      expect(mockExecFile.mock.calls.map((call) => call[0])).toEqual([
        '/usr/bin/zsh',
        '/bin/bash',
      ]);
      expect(getLoginShellPath()).toBe(resolvedPath);
    },
  );

  it('retains inherited PATH when both default and Bash fail', async () => {
    process.env.SHELL = '/usr/bin/zsh';
    mockResponses({
      '/usr/bin/zsh': new Error('ETIMEDOUT'),
      '/bin/bash': new Error('EACCES'),
    });
    await prewarmLoginShellPath();
    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it.each(['literal', 'last-marker', 'crlf', 'no-newline'])(
    'preserves marked PATH with %s output',
    async (variant) => {
      const value = '/custom Git/back\\slash/$literal:/usr/bin:/bin ';
      const outputs: Record<string, string> = {
        literal: marked(value),
        'last-marker': `${marked('/wrong/bin')}noise${marked(value)}trailing noise\n`,
        crlf: `${marker}${value}\r\ntrailing noise\r\n`,
        'no-newline': `${marker}${value}`,
      };
      mockShellResolution(outputs[variant]);
      await prewarmLoginShellPath();
      expect(getLoginShellPath()).toBe(value);
    },
  );

  it.each([undefined, '', '   '])(
    'looks up real UID when SHELL is %j, never USER',
    async (shell) => {
      if (shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = shell;
      process.env.USER = 'spoofed';
      mockResponses({
        '/usr/bin/getent': 'user:x:1001:1001::/home/user:/usr/bin/fish\n',
      });
      expect(getLoginShellPath()).toBe('/usr/bin:/bin');
      await prewarmLoginShellPath();
      expect(getLoginShellPath()).toBe(resolvedPath);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        '/usr/bin/getent',
        ['passwd', '1001'],
        expect.objectContaining({
          timeout: 1000,
          maxBuffer: 16 * 1024,
          killSignal: 'SIGKILL',
        }),
        expect.any(Function),
      );
      expect(mockExecFile.mock.calls[1][0]).toBe('/usr/bin/fish');
    },
  );

  it.each([
    new Error('ETIMEDOUT'),
    'malformed',
    'other:x:999:999::/home/other:/bin/zsh\n',
    'user:x:1001:1001::/home/user:/bin/zsh\nother:x:1002:1002::/home/other:/bin/fish\n',
    'user:x:1001:1001::/home/user:\n',
    'user:x:1001:1001::/home/user:relative-shell\n',
  ])(
    'falls back to validated Bash after unusable account lookup %j',
    async (output) => {
      delete process.env.SHELL;
      mockResponses({ '/usr/bin/getent': output });
      await prewarmLoginShellPath();
      expect(getLoginShellPath()).toBe(resolvedPath);
      expect(mockExecFile.mock.calls.map((call) => call[0])).toEqual([
        '/usr/bin/getent',
        '/bin/bash',
      ]);
    },
  );

  it('uses validated Bash without getent when real UID is unavailable', async () => {
    delete process.env.SHELL;
    Object.defineProperty(process, 'getuid', {
      value: undefined,
      configurable: true,
    });
    mockResponses({});
    await prewarmLoginShellPath();
    expect(mockExecFile.mock.calls.map((call) => call[0])).toEqual([
      '/bin/bash',
    ]);
    expect(getLoginShellPath()).toBe(resolvedPath);
  });

  it.each(['relative-shell', '/missing-shell', '/bin/bash\0bad', '/directory'])(
    'validates Bash after invalid default %j',
    async (shell) => {
      process.env.SHELL = shell;
      mockAccess.mockImplementation((file) =>
        file === '/missing-shell'
          ? Promise.reject(new Error('EACCES'))
          : Promise.resolve(),
      );
      mockStat.mockImplementation((file) =>
        Promise.resolve(file === '/directory' ? directoryStats : fileStats),
      );
      mockResponses({});
      await prewarmLoginShellPath();
      expect(mockExecFile.mock.calls.map((call) => call[0])).toEqual([
        '/bin/bash',
      ]);
      expect(mockAccess).toHaveBeenCalledWith('/bin/bash', constants.X_OK);
      expect(getLoginShellPath()).toBe(resolvedPath);
    },
  );

  it.each(['directory', 'non-executable'])(
    'does not spawn an invalid Bash fallback (%s)',
    async (failure) => {
      process.env.SHELL = '/usr/bin/zsh';
      mockResponses({ '/usr/bin/zsh': new Error('ETIMEDOUT') });
      mockStat.mockImplementation((file) =>
        Promise.resolve(
          file === '/bin/bash' && failure === 'directory'
            ? directoryStats
            : fileStats,
        ),
      );
      mockAccess.mockImplementation((file) =>
        file === '/bin/bash'
          ? Promise.reject(new Error('EACCES'))
          : Promise.resolve(),
      );
      await prewarmLoginShellPath();
      expect(getLoginShellPath()).toBe('/usr/bin:/bin');
      expect(mockExecFile.mock.calls.map((call) => call[0])).toEqual([
        '/usr/bin/zsh',
      ]);
    },
  );

  it.each([
    'unmarked /usr/false-path\n',
    '__CANOPY_LOGIN_PATH__\n',
    '__CANOPY_LOGIN_PATH__/bin\0:/usr/bin\n',
  ])('rejects invalid marked output %j', async (output) => {
    mockShellResolution(output);
    await prewarmLoginShellPath();
    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns safe Linux default when PATH is absent and Bash times out, without retrying Bash', async () => {
    delete process.env.PATH;
    mockShellResolution(new Error('ETIMEDOUT'));
    const fallback =
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    expect(getLoginShellPath()).toBe(fallback);
    await prewarmLoginShellPath();
    await tick();
    expect(getLoginShellPath()).toBe(fallback);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns cold/stale PATH immediately, deduplicates refresh and advances failed-refresh TTL', async () => {
    const callbacks = deferredProbes();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
    expect(getLoginShellPath()).toBe('/usr/bin:/bin');
    const cold = prewarmLoginShellPath();
    await tick();
    expect(callbacks).toHaveLength(1);
    callbacks[0](null, marked(), '');
    await cold;
    const expiredAt = 1_000_000 + 6 * 60_000;
    now.mockReturnValue(expiredAt);
    expect(getLoginShellPath()).toBe(resolvedPath);
    expect(getLoginShellPath()).toBe(resolvedPath);
    const stale = prewarmLoginShellPath();
    await tick();
    expect(callbacks).toHaveLength(2);
    callbacks[1](new Error('ETIMEDOUT'), '', '');
    await stale;
    now.mockReturnValue(expiredAt + 4 * 60_000);
    expect(getLoginShellPath()).toBe(resolvedPath);
    await tick();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it.each(['old-first', 'new-first'])(
    'fences reset probes in %s completion order',
    async (order) => {
      const callbacks = deferredProbes();
      const old = prewarmLoginShellPath();
      await tick();
      resetLoginShellPathCache();
      const current = prewarmLoginShellPath();
      await tick();
      if (order === 'old-first') {
        callbacks[0](null, marked('/old/bin:/bin'), '');
        await old;
        expect(getLoginShellPath()).toBe('/usr/bin:/bin');
        await tick();
        expect(mockExecFile).toHaveBeenCalledTimes(2);
      }
      callbacks[1](null, marked('/new/bin:/bin'), '');
      await current;
      if (order === 'new-first') {
        callbacks[0](null, marked('/old/bin:/bin'), '');
        await old;
      }
      expect(getLoginShellPath()).toBe('/new/bin:/bin');
      await tick();
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['stat', 'access'])(
    'reset during deferred %s stops stale work before spawn',
    async (stage) => {
      const callbacks: Array<() => void> = [];
      if (stage === 'stat')
        mockStat.mockImplementationOnce(
          () =>
            new Promise((resolve) => callbacks.push(() => resolve(fileStats))),
        );
      else
        mockAccess.mockImplementationOnce(
          () =>
            new Promise((resolve) => callbacks.push(() => resolve(undefined))),
        );
      mockResponses({});
      const old = prewarmLoginShellPath();
      await tick();
      expect(callbacks).toHaveLength(1);
      resetLoginShellPathCache();
      const current = prewarmLoginShellPath();
      await current;
      callbacks[0]();
      await old;
      expect(getLoginShellPath()).toBe(resolvedPath);
      await tick();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    },
  );

  it('reset during deferred account lookup stops stale work before shell validation/spawn', async () => {
    delete process.env.SHELL;
    const callbacks = deferredProbes();
    const old = prewarmLoginShellPath();
    await tick();
    resetLoginShellPathCache();
    process.env.SHELL = '/bin/bash';
    const current = prewarmLoginShellPath();
    await tick();
    callbacks[1](null, marked(), '');
    await current;
    callbacks[0](null, 'user:x:1001:1001::/home/user:/usr/bin/zsh\n', '');
    await old;
    await tick();
    expect(getLoginShellPath()).toBe(resolvedPath);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockStat).toHaveBeenCalledTimes(1);
  });

  it('does not retry Bash after an invalidated default probe fails', async () => {
    process.env.SHELL = '/usr/bin/zsh';
    const callbacks = deferredProbes();
    const old = prewarmLoginShellPath();
    await tick();
    resetLoginShellPathCache();
    process.env.SHELL = '/bin/bash';
    const current = prewarmLoginShellPath();
    await tick();
    callbacks[0](new Error('ETIMEDOUT'), '', '');
    await old;
    await tick();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    callbacks[1](null, marked(), '');
    await current;
    expect(getLoginShellPath()).toBe(resolvedPath);
  });

  it('strips loader/startup variables, preserves HOME/locale and leaves process.env unmodified', async () => {
    delete process.env.SHELL;
    const blocked = [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'NODE_OPTIONS',
      'NODE_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_FRAMEWORK_PATH',
      'BASH_ENV',
      'ENV',
      'GLIBC_TUNABLES',
    ];
    for (const key of blocked) process.env[key] = 'blocked-fixture';
    process.env.HOME = '/home/user';
    process.env.LANG = 'en_US.UTF-8';
    const before = { ...process.env };
    mockResponses({
      '/usr/bin/getent': 'user:x:1001:1001::/home/user:/bin/bash\n',
    });
    await prewarmLoginShellPath();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    for (const call of mockExecFile.mock.calls) {
      expect(call[2].env).toEqual(
        expect.objectContaining({
          PATH: '/usr/bin:/bin',
          HOME: '/home/user',
          LANG: 'en_US.UTF-8',
        }),
      );
      for (const key of blocked) expect(call[2].env?.[key]).toBeUndefined();
    }
    expect(process.env).toEqual(before);
  });

  describe('probe environment', () => {
    it('drops loader and startup injection while keeping PATH and HOME', () => {
      process.env = {
        ...originalEnv,
        PATH: '/usr/bin:/bin',
        HOME: '/home/user',
        LD_PRELOAD: '/evil.so',
        LD_LIBRARY_PATH: '/evil',
        NODE_OPTIONS: '--require /evil.js',
        BASH_ENV: '/evil.sh',
        ENV: '/evil.sh',
        GLIBC_TUNABLES: 'x',
        BASH_FUNC_foo: '() { :; }',
      };
      const before = { ...process.env };
      const env = getLinuxProbeEnv();

      expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/user' });
      for (const key of [
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'NODE_OPTIONS',
        'BASH_ENV',
        'ENV',
        'GLIBC_TUNABLES',
        'BASH_FUNC_foo',
      ]) {
        expect(env).not.toHaveProperty(key);
      }
      expect(process.env).toEqual(before);
    });
  });

  describe('forced refresh for Git recheck', () => {
    it('re-probes a fresh cache, serving the stale value without blocking', async () => {
      mockShellResolution(marked('/old/bin:/usr/bin'));
      await prewarmLoginShellPath();
      await prewarmLoginShellPath();
      expect(mockExecFile).toHaveBeenCalledTimes(1);

      const callbacks = deferredProbes();
      const forced = prewarmLoginShellPath({ force: true });
      await tick();
      expect(callbacks).toHaveLength(1);
      expect(getLoginShellPath()).toBe('/old/bin:/usr/bin');
      callbacks[0](null, marked('/new/bin:/usr/bin'), '');
      await forced;
      expect(getLoginShellPath()).toBe('/new/bin:/usr/bin');
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('keeps the stale cache when the forced refresh fails', async () => {
      mockShellResolution(marked('/old/bin:/usr/bin'));
      await prewarmLoginShellPath();
      mockResponses({
        '/bin/bash': new Error('ETIMEDOUT'),
      });
      await prewarmLoginShellPath({ force: true });
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(getLoginShellPath()).toBe('/old/bin:/usr/bin');
    });

    it('shares one in-flight probe across concurrent forced refreshes', async () => {
      const callbacks = deferredProbes();
      const first = prewarmLoginShellPath({ force: true });
      const second = prewarmLoginShellPath({ force: true });
      const background = prewarmLoginShellPath();
      await tick();
      expect(callbacks).toHaveLength(1);
      callbacks[0](null, marked(), '');
      await Promise.all([first, second, background]);
      expect(getLoginShellPath()).toBe(resolvedPath);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['win32', 'x64'],
      ['linux', 's390x'],
    ])('stays a no-op on %s %s', async (platform, arch) => {
      setPlatform(platform);
      Object.defineProperty(process, 'arch', {
        value: arch,
        configurable: true,
      });
      mockShellResolution(marked());
      await prewarmLoginShellPath({ force: true });
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});

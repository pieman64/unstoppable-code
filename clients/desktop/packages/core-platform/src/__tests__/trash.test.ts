import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type PlatformExecutionOutcome,
  type PlatformExecutionOutput,
  type PlatformExecutionProcess,
  type PlatformExecutionProcessServices,
  type PlatformExecutionRequest,
  PlatformTrashError,
} from '@canopy/core-runtime';
import { hostPlatformOperatingSystem } from '../platform-services';
import { createExecutionProcessServices } from '../supervision/execution-process';
import { createNativeTrashServices } from '../trash';
import {
  darwinTrashAttempt,
  darwinTrashCommand,
  parseDarwinTrashReport,
} from '../trash/darwin';
import { runTrashHelper, type TrashHelperCommand } from '../trash/helper';
import {
  linuxTrashBackend,
  linuxTrashCommand,
  parseLinuxTrashReport,
} from '../trash/linux';
import {
  createTrashServices,
  type InspectTrashEntry,
  type TrashAttempt,
  type TrashAttempter,
  type TrashBackend,
  type TrashIdentity,
} from '../trash/trash';
import {
  parseWindowsRecycleResult,
  windowsTrashBackend,
} from '../trash/windows';

const os = hostPlatformOperatingSystem();
const posix = os !== 'win32';

const ENTRY = '/work/tree/file.txt';
const SAME: TrashIdentity = { dev: 1n, ino: 2n };
const OTHER: TrashIdentity = { dev: 1n, ino: 3n };

/** Inspect results in call order: before the attempt, then after it. */
function inspections(
  ...results: (TrashIdentity | null | Error)[]
): InspectTrashEntry & { readonly calls: string[] } {
  const calls: string[] = [];
  const inspect = (entry: string): Promise<TrashIdentity | null> => {
    calls.push(entry);
    const next = results.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? null);
  };
  return Object.assign(inspect, { calls });
}

async function rejection(
  promise: Promise<unknown>,
): Promise<PlatformTrashError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlatformTrashError) return error;
    throw error;
  }
  throw new Error('expected a Trash rejection');
}

describe('Trash classification', () => {
  const attempted = (
    attempt: TrashAttempt | Error,
  ): { readonly entries: string[]; readonly backend: TrashBackend } => {
    const entries: string[] = [];
    const backend = (): TrashAttempter => (entry) => {
      entries.push(entry);
      return attempt instanceof Error
        ? Promise.reject(attempt)
        : Promise.resolve(attempt);
    };
    return { entries, backend };
  };

  it('resolves only when the backend reports the move and the entry left its path', async () => {
    const { entries, backend } = attempted({ kind: 'moved' });
    for (const after of [null, OTHER]) {
      const inspect = inspections(SAME, after);
      await expect(
        createTrashServices('linux', backend, inspect).trashItem(ENTRY),
      ).resolves.toBeUndefined();
      expect(inspect.calls).toEqual([ENTRY, ENTRY]);
    }
    expect(entries).toEqual([ENTRY, ENTRY]);
  });

  it('refuses a reported move whose entry is still in place', async () => {
    const { backend } = attempted({ kind: 'moved' });
    const error = await rejection(
      createTrashServices('linux', backend, inspections(SAME, SAME)).trashItem(
        ENTRY,
      ),
    );
    expect(error.code).toBe('failed');
  });

  it.each(['unavailable', 'failed'] as const)(
    'reports a %s refusal when the entry is still in place',
    async (code) => {
      const { backend } = attempted({ kind: 'refused', code, reason: 'No.' });
      const error = await rejection(
        createTrashServices(
          'linux',
          backend,
          inspections(SAME, SAME),
        ).trashItem(ENTRY),
      );
      expect(error).toMatchObject({ code, message: 'No.' });
    },
  );

  it.each([
    ['refused', { kind: 'refused', code: 'failed', reason: 'No.' }],
    ['unfinished', { kind: 'unfinished', reason: 'Ended.' }],
  ] as const)(
    'reports a %s attempt as unconfirmed once the entry left its path',
    async (_kind, attempt) => {
      const { backend } = attempted(attempt);
      for (const after of [null, OTHER, new Error('EACCES')]) {
        const error = await rejection(
          createTrashServices(
            'linux',
            backend,
            inspections(SAME, after),
          ).trashItem(ENTRY),
        );
        expect(error.code).toBe('unconfirmed');
        expect(error.message).toBe(
          `${attempt.reason} The entry is no longer at its path.`,
        );
      }
    },
  );

  it('reports an unfinished or throwing backend as failed while the entry is in place', async () => {
    for (const attempt of [
      { kind: 'unfinished', reason: 'Ended.' } as const,
      new Error('/work/tree/file.txt crashed'),
    ]) {
      const { backend } = attempted(attempt);
      const error = await rejection(
        createTrashServices(
          'linux',
          backend,
          inspections(SAME, SAME),
        ).trashItem(ENTRY),
      );
      expect(error.code).toBe('failed');
      expect(error.message).toMatch(/The entry is still in place\.$/);
      expect(error.message).not.toContain('/work');
    }
  });

  it('opens no backend for an invalid path, and moves nothing', async () => {
    const opened: string[] = [];
    const backend = (): TrashAttempter => {
      opened.push('open');
      return (): Promise<TrashAttempt> => Promise.resolve({ kind: 'moved' });
    };
    const cases = [
      ['linux', 'relative/file'],
      ['linux', ''],
      ['linux', '/work/a\0b'],
      ['linux', '/work/./file'],
      ['linux', '/work/../file'],
      ['linux', '/work//file'],
      ['linux', '/work/link/'],
      ['darwin', '/work/\ud800'],
      ['win32', 'C:/work/file'],
      ['win32', 'C:\\work\\..\\file'],
      ['win32', 'C:\\work\\'],
      ['win32', 'C:\\work/'],
      ['win32', '\\work\\file'],
      ['win32', '\\\\?\\C:\\work\\file'],
      ['win32', '\\\\.\\C:\\work\\file'],
    ] as const;
    for (const [host, entry] of cases) {
      const inspect = inspections(SAME, null);
      const error = await rejection(
        createTrashServices(host, backend, inspect).trashItem(entry),
      );
      expect([host, entry, error.code, error.message]).toEqual([
        host,
        entry,
        'failed',
        'Trash needs a normalized absolute path.',
      ]);
      expect(inspect.calls).toEqual([]);
    }
    expect(opened).toEqual([]);
  });

  it('accepts normalized absolute paths on each host', async () => {
    const { entries, backend } = attempted({ kind: 'moved' });
    const cases = [
      ['darwin', '/Users/a/b c/é.txt'],
      ['darwin', '/Users/a/\ud83d\ude00'],
      // A backslash is an ordinary name character on POSIX hosts.
      ['darwin', '/Users/a/name\\'],
      ['linux', '/work/name\\'],
      ['linux', '/work/a\\/b\\..'],
      ['win32', 'C:\\work\\file.txt'],
      ['win32', '\\\\server\\share\\file.txt'],
    ] as const;
    for (const [host, entry] of cases)
      await expect(
        createTrashServices(host, backend, inspections(SAME, null)).trashItem(
          entry,
        ),
      ).resolves.toBeUndefined();
    expect(entries).toEqual(cases.map(([, entry]) => entry));
  });

  it('reports a host without a backend as unavailable before reading the entry', async () => {
    const inspect = inspections(SAME, null);
    const error = await rejection(
      createTrashServices('linux', () => 'No trash here.', inspect).trashItem(
        ENTRY,
      ),
    );
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'No trash here.',
    });
    expect(inspect.calls).toEqual([]);
  });

  it('reports a backend that throws while opening as unavailable', async () => {
    const inspect = inspections(SAME, null);
    const error = await rejection(
      createTrashServices(
        'linux',
        () => {
          throw new Error('/work/tree/file.txt');
        },
        inspect,
      ).trashItem(ENTRY),
    );
    expect(error).toMatchObject({
      code: 'unavailable',
      message: "The trash backend couldn't start; nothing was moved.",
    });
    expect(inspect.calls).toEqual([]);
  });

  it('refuses a missing or unreadable entry without attempting a move', async () => {
    for (const before of [null, new Error('EACCES')]) {
      const { entries, backend } = attempted({ kind: 'moved' });
      const error = await rejection(
        createTrashServices('linux', backend, inspections(before)).trashItem(
          ENTRY,
        ),
      );
      expect(error).toMatchObject({
        code: 'failed',
        message: "The entry couldn't be read; nothing was moved.",
      });
      expect(entries).toEqual([]);
    }
  });

  (posix ? describe : describe.skip)('over the real filesystem', () => {
    let root = '';
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'trash-classify-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('identifies a symlink as the link, so moving its target leaves it in place', async () => {
      const target = path.join(root, 'target');
      const link = path.join(root, 'link');
      await writeFile(target, 'kept');
      await symlink(target, link);
      // A backend that moves the target and claims the link moved.
      const backend = () => async (): Promise<TrashAttempt> => {
        await rename(target, path.join(root, 'elsewhere'));
        return { kind: 'moved' };
      };
      const error = await rejection(
        createTrashServices(os, backend).trashItem(link),
      );
      expect(error.code).toBe('failed');
    });

    it('resolves for a backend that renames the entry away', async () => {
      const entry = path.join(root, 'entry');
      await writeFile(entry, 'moved');
      const backend =
        () =>
        async (moved: string): Promise<TrashAttempt> => {
          await rename(moved, path.join(root, 'trash'));
          return { kind: 'moved' };
        };
      await expect(
        createTrashServices(os, backend).trashItem(entry),
      ).resolves.toBeUndefined();
    });
  });
});

interface FakeChild {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly outcome?: Partial<PlatformExecutionOutcome>;
  /** Holds the outcome until the child is terminated. */
  readonly hang?: boolean;
}

/** Process services whose children replay `child`, recording each request. */
function fakeProcesses(
  child: FakeChild,
  start: 'starts' | 'fails' = 'starts',
): PlatformExecutionProcessServices & {
  readonly requests: PlatformExecutionRequest[];
  readonly terminated: string[];
} {
  const requests: PlatformExecutionRequest[] = [];
  const terminated: string[] = [];
  const output = (chunks: readonly string[] = []): PlatformExecutionOutput => {
    const queue = chunks.map((chunk) => new TextEncoder().encode(chunk));
    return {
      read: () => Promise.resolve(queue.shift() ?? null),
      acknowledge: () => undefined,
      discard: () => undefined,
    };
  };
  return {
    requests,
    terminated,
    start: (request) => {
      requests.push(request);
      if (start === 'fails') return Promise.reject(new Error('no start'));
      let end: (outcome: PlatformExecutionOutcome) => void = () => undefined;
      const outcome = new Promise<PlatformExecutionOutcome>((resolve) => {
        end = resolve;
      });
      const finished: PlatformExecutionOutcome = {
        kind: 'exited',
        code: 0,
        signal: null,
        output: 'complete',
        ...child.outcome,
      };
      if (!child.hang) end(finished);
      const process: PlatformExecutionProcess = {
        pid: 1,
        stdin: null,
        stdout: output(child.stdout),
        stderr: output(child.stderr),
        outcome,
        terminate: (options) => {
          terminated.push(options?.mode ?? 'graceful');
          end({
            kind: 'cancelled',
            code: null,
            signal: 'SIGKILL',
            output: 'discarded',
          });
          return Promise.resolve();
        },
      };
      return Promise.resolve(process);
    },
    shutdown: () => Promise.resolve(),
  };
}

const COMMAND = {
  executable: '/usr/bin/helper',
  args: ['one'],
  environment: { LC_ALL: 'C' },
};

describe('Trash helper runs', () => {
  it('reports a helper that exited on its own with all of its output', async () => {
    const processes = fakeProcesses({
      stdout: ['mov', 'ed\n'],
      stderr: ['note'],
      outcome: { code: 3 },
    });
    await expect(runTrashHelper(processes, COMMAND)).resolves.toEqual({
      kind: 'exited',
      code: 3,
      stdout: 'moved\n',
      stderr: 'note',
    });
    expect(processes.requests).toEqual([
      {
        ...COMMAND,
        cwd: '/',
        stdin: 'ignore',
        stderr: 'pipe',
        outputWindowBytes: 4096,
      },
    ]);
    expect(processes.terminated).toEqual([]);
  });

  it.each([
    ['crashed', { kind: 'crashed', signal: 'SIGSEGV', code: null }],
    ['lost', { kind: 'lost' }],
    ['discarded', { output: 'discarded' }],
  ] as const)('reports a %s helper as unfinished', async (_name, outcome) => {
    await expect(
      runTrashHelper(fakeProcesses({ stdout: ['moved /x'], outcome }), COMMAND),
    ).resolves.toEqual({ kind: 'unfinished' });
  });

  it('reports a helper that could not start as unfinished', async () => {
    await expect(
      runTrashHelper(fakeProcesses({}, 'fails'), COMMAND),
    ).resolves.toEqual({ kind: 'unfinished' });
  });

  it('stops a helper past its output bound and reads no report', async () => {
    const processes = fakeProcesses({
      stdout: ['x'.repeat(10), 'y'.repeat(10)],
      hang: true,
    });
    await expect(
      runTrashHelper(processes, COMMAND, {
        timeoutMs: 60_000,
        outputBytes: 16,
      }),
    ).resolves.toEqual({ kind: 'unfinished' });
    expect(processes.terminated).toEqual(['force']);
  });

  it('stops a helper that hangs past the timeout', async () => {
    const processes = fakeProcesses({ hang: true });
    await expect(
      runTrashHelper(processes, COMMAND, { timeoutMs: 10, outputBytes: 16 }),
    ).resolves.toEqual({ kind: 'unfinished' });
    expect(processes.terminated).toEqual(['force']);
  });

  (posix ? describe : describe.skip)('under real process custody', () => {
    const processes = createExecutionProcessServices({ os });
    afterAll(() => processes.shutdown());

    it('stops a real helper on timeout and on overflow', async () => {
      const shell = (script: string): TrashHelperCommand => ({
        executable: '/bin/sh',
        args: ['-c', script],
        environment: { PATH: '/usr/bin:/bin' },
      });
      const started = Date.now();
      await expect(
        runTrashHelper(processes, shell('sleep 30'), {
          timeoutMs: 100,
          outputBytes: 64,
        }),
      ).resolves.toEqual({ kind: 'unfinished' });
      expect(Date.now() - started).toBeLessThan(10_000);
      await expect(
        runTrashHelper(processes, shell('while :; do echo flood; done'), {
          timeoutMs: 10_000,
          outputBytes: 64,
        }),
      ).resolves.toEqual({ kind: 'unfinished' });
      await expect(
        runTrashHelper(processes, shell('printf ok; exit 4'), {
          timeoutMs: 10_000,
          outputBytes: 64,
        }),
      ).resolves.toEqual({ kind: 'exited', code: 4, stdout: 'ok', stderr: '' });
    });
  });
});

describe('darwin backend', () => {
  const entry = '/Users/a/it\'s "quoted" é -x.txt';

  it('runs osascript at its fixed path with the entry encoded in argv, never in the script', async () => {
    const processes = fakeProcesses({
      stdout: ['moved %2FUsers%2Fa%2F.Trash%2Fx\n'],
    });
    await expect(darwinTrashAttempt(processes, entry)).resolves.toEqual({
      kind: 'moved',
      location: '/Users/a/.Trash/x',
    });
    const [request] = processes.requests;
    expect(request?.executable).toBe('/usr/bin/osascript');
    expect(request?.environment).toEqual({ LC_ALL: 'C' });
    const args = darwinTrashCommand(entry);
    expect(request?.args).toEqual(args);
    expect(args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(args).toHaveLength(5);
    expect(args[3]).not.toContain('quoted');
    expect(args[4]).toBe(encodeURIComponent(entry));
    expect(args[4]).toMatch(/^%2F/);
  });

  it.each([
    ['moved %2Fa%2F.Trash%2Fb\n', { kind: 'moved', location: '/a/.Trash/b' }],
    [
      'refused 3328 NSCocoaErrorDomain\n',
      {
        kind: 'refused',
        code: 'unavailable',
        reason: 'This volume has no trash.',
      },
    ],
    [
      'refused 4 NSCocoaErrorDomain\n',
      {
        kind: 'refused',
        code: 'failed',
        reason: 'macOS refused to move the entry to the trash.',
      },
    ],
    [
      'refused 3328 NSPOSIXErrorDomain\n',
      {
        kind: 'refused',
        code: 'failed',
        reason: 'macOS refused to move the entry to the trash.',
      },
    ],
    ['moved \n', { kind: 'moved' }],
    ['moved relative\n', { kind: 'unfinished' }],
    ['moved %E0%A4%A\n', { kind: 'unfinished' }],
    ['moved /a\nmoved /b\n', { kind: 'unfinished' }],
    ['usage\n', { kind: 'unfinished' }],
    ['', { kind: 'unfinished' }],
  ] as const)('reads %j', (stdout, expected) => {
    expect(parseDarwinTrashReport(stdout)).toMatchObject(expected);
  });

  it('reports a failed or killed osascript as unfinished, whatever it printed', async () => {
    for (const outcome of [
      { code: 1 },
      { kind: 'crashed', code: null, signal: 'SIGSEGV' },
    ] as const)
      await expect(
        darwinTrashAttempt(
          fakeProcesses({ stdout: ['moved %2Fx\n'], outcome }),
          entry,
        ),
      ).resolves.toEqual({
        kind: 'unfinished',
        reason: 'The trash helper ended without a report.',
      });
  });
});

describe('linux backend', () => {
  it('runs gio trash with the local VFS and only the trash location variables', () => {
    expect(
      linuxTrashCommand('/usr/bin/gio', '/home/a/file', {
        HOME: '/home/a',
        XDG_DATA_HOME: '/home/a/.data',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
        PATH: '/opt/evil',
        LD_PRELOAD: '/tmp/x.so',
      }),
    ).toEqual({
      executable: '/usr/bin/gio',
      args: ['trash', '/home/a/file'],
      environment: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIO_USE_VFS: 'local',
        HOME: '/home/a',
        XDG_DATA_HOME: '/home/a/.data',
      },
    });
    expect(
      linuxTrashCommand('/bin/gio', '/f', { HOME: '', XDG_DATA_HOME: 'a\0b' })
        .environment,
    ).toEqual({ PATH: '/usr/bin:/bin', LC_ALL: 'C', GIO_USE_VFS: 'local' });
  });

  // stderr as GLib 2.74's gio prints it, which exits 1 on each.
  it.each([
    [0, '/tmp/a/x', '', { kind: 'moved' }],
    [
      1,
      '/mnt/x',
      'gio: file:///mnt/x: Unable to find or create trash directory for /mnt/x\n',
      { kind: 'refused', code: 'unavailable' },
    ],
    [
      1,
      '/mnt/tmpfs/x',
      'gio: file:///mnt/tmpfs/x: Trashing on system internal mounts is not supported\n',
      { kind: 'refused', code: 'unavailable' },
    ],
    [
      1,
      '/tmp/a/x',
      'gio: file:///tmp/a/x: Unable to trash file /tmp/a/x across filesystem boundaries\n',
      { kind: 'refused', code: 'unavailable' },
    ],
    [
      1,
      '/tmp/a/ro/f',
      'gio: file:///tmp/a/ro/f: Unable to trash file /tmp/a/ro/f: Permission denied\n',
      { kind: 'refused', code: 'failed' },
    ],
    // The message text in the path itself is not GLib's report.
    [
      1,
      '/tmp/a/trash directory not supported/f',
      'gio: file:///tmp/a/trash%20directory%20not%20supported/f: Unable to trash file /tmp/a/trash directory not supported/f: Permission denied\n',
      { kind: 'refused', code: 'failed' },
    ],
    [1, '/tmp/a/x', '', { kind: 'refused', code: 'failed' }],
    [null, '/tmp/a/x', '', { kind: 'unfinished' }],
  ] as const)(
    'reads exit %s for %j with %j',
    (code, entry, stderr, expected) => {
      expect(parseLinuxTrashReport(code, stderr, entry)).toMatchObject(
        expected,
      );
    },
  );

  it('uses the first gio present, and stays unavailable until one is', async () => {
    const present = new Set<string>();
    const probed: string[] = [];
    const processes = fakeProcesses({});
    const backend = linuxTrashBackend({
      exists: (file) => {
        probed.push(file);
        return present.has(file);
      },
      processes: () => processes,
      environment: () => ({ HOME: '/home/a' }),
    });
    expect(backend()).toBe('Trash needs gio, which is missing.');
    expect(probed).toEqual(['/usr/bin/gio', '/bin/gio']);
    present.add('/bin/gio');
    const attempt = backend();
    if (typeof attempt === 'string') throw new Error(attempt);
    await expect(attempt('/home/a/f')).resolves.toEqual({ kind: 'moved' });
    present.add('/usr/bin/gio');
    backend();
    expect(processes.requests.map((request) => request.executable)).toEqual([
      '/bin/gio',
    ]);
    expect(probed).toEqual([
      '/usr/bin/gio',
      '/bin/gio',
      '/usr/bin/gio',
      '/bin/gio',
    ]);
  });
});

describe('win32 backend', () => {
  it.each([
    ['recycled', { kind: 'moved' }],
    ['refused', { kind: 'refused', code: 'unavailable' }],
    ['failed', { kind: 'refused', code: 'failed' }],
    [
      'deleted',
      {
        kind: 'unfinished',
        reason: 'Windows reported the entry deleted, not recycled.',
      },
    ],
    ['unreported', { kind: 'unfinished' }],
    [undefined, { kind: 'unfinished' }],
    [true, { kind: 'unfinished' }],
  ] as const)('reads %j', (result, expected) => {
    expect(parseWindowsRecycleResult(result)).toMatchObject(expected);
  });

  it('loads the addon once, on the first request, and stays unavailable without it', async () => {
    expect(windowsTrashBackend(null)()).toBe(
      'Recycle Bin support is not staged on this host.',
    );
    let loads = 0;
    const failing = windowsTrashBackend(() => {
      loads += 1;
      throw new Error('no addon');
    });
    expect(failing()).toBe('Recycle Bin support is not staged on this host.');
    expect(failing()).toBe('Recycle Bin support is not staged on this host.');
    expect(loads).toBe(1);

    const recycled: string[] = [];
    const working = windowsTrashBackend(() => (entry): Promise<unknown> => {
      recycled.push(entry);
      return Promise.resolve('recycled');
    });
    const attempt = working();
    if (typeof attempt === 'string') throw new Error(attempt);
    await expect(attempt('C:\\a')).resolves.toEqual({ kind: 'moved' });
    expect(recycled).toEqual(['C:\\a']);
  });

  it('reports Trash unavailable through the factory when the addon is not staged', async () => {
    const error = await rejection(
      createNativeTrashServices('win32').trashItem('C:\\work\\file.txt'),
    );
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'Recycle Bin support is not staged on this host.',
    });
  });
});

it('builds a frozen Trash for every host', () => {
  for (const host of ['darwin', 'win32', 'linux'] as const) {
    const trash = createNativeTrashServices(host);
    expect(Object.isFrozen(trash)).toBe(true);
    expect(typeof trash.trashItem).toBe('function');
  }
});

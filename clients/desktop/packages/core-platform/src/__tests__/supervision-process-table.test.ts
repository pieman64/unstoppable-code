import {
  auxvPageSize,
  createProcessTableReader,
  parseLinuxStat,
  parseMacProcessTable,
  parseWindowsProcessTable,
  type ProcessTableOperations,
} from '../supervision/process-table';
import { createSupervisionServices } from '../supervision';

const MIB = 1024 * 1024;

function stat(
  pid: number,
  comm: string,
  fields: { ppid: number; pgid: number; utime: number; stime: number },
  start = 5000,
  rssPages = 256,
  state = 'S',
): string {
  // Fields 3..24 of proc(5): state, ppid, pgrp, session, tty_nr, tpgid,
  // flags, minflt, cminflt, majflt, cmajflt, utime, stime, cutime, cstime,
  // priority, nice, num_threads, itrealvalue, starttime, vsize, rss.
  const rest = [
    state,
    fields.ppid,
    fields.pgid,
    1,
    0,
    -1,
    0,
    0,
    0,
    0,
    0,
    fields.utime,
    fields.stime,
    0,
    0,
    20,
    0,
    1,
    0,
    start,
    1000,
    rssPages,
  ];
  return `${pid} (${comm}) ${rest.join(' ')} 0 0 0\n`;
}

function auxv(entries: [number, number][]): Uint8Array {
  const bytes = new Uint8Array((entries.length + 1) * 16);
  const view = new DataView(bytes.buffer);
  entries.forEach(([type, value], index) => {
    view.setUint32(index * 16, type, true);
    view.setUint32(index * 16 + 8, value, true);
  });
  return bytes;
}

function linuxOps(
  files: Map<string, string>,
  clock: { now: number },
): Partial<ProcessTableOperations> {
  return {
    listDirectory: () =>
      Promise.resolve([
        ...new Set(
          Array.from(files.keys())
            .map((path) => /^\/proc\/(\d+)\//.exec(path)?.[1])
            .filter((pid): pid is string => pid !== undefined),
        ),
        'self',
        'sys',
      ]),
    readText: (path): Promise<string> => {
      const text = files.get(path);
      return text === undefined
        ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        : Promise.resolve(text);
    },
    readBytes: () =>
      Promise.resolve(
        auxv([
          [33, 1],
          [6, 16384],
        ]),
      ),
    logicalCpuCount: () => 2,
    now: () => clock.now,
  };
}

describe('process table parsing', () => {
  it('parses macOS rows, normalizes CPU and keeps only the executable name', () => {
    const rows = parseMacProcessTable(
      '200 100 200 400.0 128 /usr/local/bin/node --token secret\nbad row\n',
      8,
    );
    expect(Array.from(rows.values())).toEqual([
      {
        pid: 200,
        ppid: 100,
        pgid: 200,
        cpuPercent: 50,
        memoryRssBytes: 128 * 1024,
        command: 'node',
      },
    ]);
  });

  it('derives Windows CPU from the previous read and rejects empty output', () => {
    const entry = (cpu: number): string =>
      JSON.stringify([
        {
          ProcessId: 200,
          ParentProcessId: 100,
          CpuTime100ns: cpu,
          WorkingSetSize: 128 * MIB,
          Name: 'node.exe',
          CommandLine: 'node.exe --token secret',
        },
      ]);
    const first = parseWindowsProcessTable(
      entry(100_000_000),
      new Map(),
      1000,
      4,
    );
    const second = parseWindowsProcessTable(
      entry(140_000_000),
      first.samples,
      3000,
      4,
    );
    expect(first.rows.get(200)).toMatchObject({ cpuPercent: 0, pgid: 200 });
    expect(second.rows.get(200)).toMatchObject({
      cpuPercent: 50,
      command: 'node.exe',
    });
    expect(() => parseWindowsProcessTable(' \n', new Map(), 0, 1)).toThrow(
      'Windows process table output was empty',
    );
  });

  it('parses procfs stat lines whose command contains spaces and parentheses', () => {
    expect(
      parseLinuxStat(
        stat(42, 'my (odd) cmd', { ppid: 1, pgid: 42, utime: 30, stime: 10 }),
      ),
    ).toEqual({
      pid: 42,
      comm: 'my (odd) cmd',
      ppid: 1,
      pgid: 42,
      cpuTicks: 40,
      startTicks: '5000',
      rssPages: 256,
    });
    expect(
      parseLinuxStat(
        stat(
          43,
          'zombie',
          { ppid: 1, pgid: 43, utime: 0, stime: 0 },
          1,
          0,
          'Z',
        ),
      ),
    ).toBeNull();
    expect(parseLinuxStat('garbage')).toBeNull();
  });

  it('reads the page size from auxv', () => {
    expect(
      auxvPageSize(
        auxv([
          [33, 1],
          [6, 16384],
        ]),
      ),
    ).toBe(16384);
    expect(auxvPageSize(auxv([[33, 1]]))).toBeNull();
  });
});

describe('createProcessTableReader', () => {
  it('reads procfs on Linux with CPU between reads and argv0 commands', async () => {
    const clock = { now: 1000 };
    const files = new Map<string, string>([
      [
        '/proc/100/stat',
        stat(100, 'canopy', { ppid: 1, pgid: 100, utime: 10, stime: 0 }),
      ],
      ['/proc/100/cmdline', '/opt/Canopy/canopy\0--flag\0'],
      [
        '/proc/200/stat',
        stat(200, 'node', { ppid: 100, pgid: 200, utime: 100, stime: 0 }),
      ],
      ['/proc/200/cmdline', ''],
    ]);
    const read = createProcessTableReader('linux', linuxOps(files, clock));

    const first = await read();
    files.set(
      '/proc/200/stat',
      stat(200, 'node', { ppid: 100, pgid: 200, utime: 150, stime: 50 }),
    );
    clock.now = 3000;
    const second = await read();

    expect(first).toEqual({
      kind: 'sampled',
      rows: new Map([
        [
          100,
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            cpuPercent: 0,
            memoryRssBytes: 256 * 16384,
            command: 'canopy',
          },
        ],
        [
          200,
          {
            pid: 200,
            ppid: 100,
            pgid: 200,
            cpuPercent: 0,
            memoryRssBytes: 256 * 16384,
            command: 'node',
          },
        ],
      ]),
    });
    // 100 ticks over two seconds on two CPUs is a quarter of the machine.
    expect(second.kind === 'sampled' && second.rows.get(200)?.cpuPercent).toBe(
      25,
    );
  });

  it('does not charge a reused Linux PID with its predecessor CPU time', async () => {
    const clock = { now: 1000 };
    const files = new Map([
      [
        '/proc/200/stat',
        stat(200, 'a', { ppid: 1, pgid: 200, utime: 500, stime: 0 }, 10),
      ],
    ]);
    const read = createProcessTableReader('linux', linuxOps(files, clock));
    await read();
    files.set(
      '/proc/200/stat',
      stat(200, 'b', { ppid: 1, pgid: 200, utime: 900, stime: 0 }, 20),
    );
    clock.now = 2000;
    const second = await read();
    expect(second.kind === 'sampled' && second.rows.get(200)?.cpuPercent).toBe(
      0,
    );
  });

  it('reports unavailable instead of rejecting when the table cannot be read', async () => {
    const read = createProcessTableReader('darwin', {
      run: () =>
        Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })),
    });
    await expect(read()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'process table read failed (ENOENT)',
    });
    const empty = createProcessTableReader('linux', {
      listDirectory: () => Promise.resolve(['self']),
      readBytes: () => Promise.reject(new Error('no auxv')),
    });
    await expect(empty()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'process table read failed',
    });
  });

  it('runs ps on macOS and PowerShell on Windows with bounded options', async () => {
    const calls: unknown[] = [];
    const run: ProcessTableOperations['run'] = (file, args, options) => {
      calls.push([file, args.slice(0, 2), options]);
      return Promise.resolve(
        file === '/bin/ps'
          ? '1 0 1 0.0 4 /sbin/launchd\n'
          : JSON.stringify({
              ProcessId: 4,
              ParentProcessId: 0,
              CpuTime100ns: 0,
              WorkingSetSize: 1,
              Name: 'System',
              CommandLine: '',
            }),
      );
    };
    await createProcessTableReader('darwin', { run })();
    await createProcessTableReader('win32', { run })();
    expect(calls).toEqual([
      [
        '/bin/ps',
        ['-axo', 'pid=,ppid=,pgid=,pcpu=,rss=,command='],
        { windowsHide: false },
      ],
      [
        'powershell.exe',
        ['-NoLogo', '-NoProfile'],
        { windowsHide: true, timeoutMs: 15_000 },
      ],
    ]);
  });

  it('rejects only when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      createProcessTableReader('darwin')({ signal: controller.signal }),
    ).rejects.toThrow('stop');
  });

  it('is part of every supervision composition', () => {
    for (const os of ['darwin', 'linux', 'win32'] as const) {
      expect(typeof createSupervisionServices(os).readProcessTable).toBe(
        'function',
      );
    }
  });
});

if (process.platform === 'linux' || process.platform === 'darwin') {
  it('reads this host and finds the test process', async () => {
    const os = process.platform === 'linux' ? 'linux' : 'darwin';
    const result = await createProcessTableReader(os)();
    expect(result.kind).toBe('sampled');
    if (result.kind === 'sampled') {
      expect(result.rows.get(process.pid)).toMatchObject({
        pid: process.pid,
        ppid: process.ppid,
      });
      expect(result.rows.get(process.pid)?.memoryRssBytes).toBeGreaterThan(0);
    }
  });
}

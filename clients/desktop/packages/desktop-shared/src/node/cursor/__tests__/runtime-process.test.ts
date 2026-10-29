import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  runCursorRuntimeCommand,
  stopCursorProcessGroup,
  verifyCursorRuntimeVersion,
  type CursorVersionProbeDiagnostic,
} from '../runtime-process';

describe('Cursor process group shutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('completes promptly when the parent closes and still drains surviving tools', async () => {
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    await stopCursorProcessGroup(1234, Promise.resolve());
    expect(kill.mock.calls).toEqual([
      [-1234, 'SIGTERM'],
      [-1234, 'SIGKILL'],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('escalates an unresponsive group after the grace period and awaits reaping', async () => {
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    let close = (): void => {};
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    let done = false;
    const stopping = stopCursorProcessGroup(1234, closed).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(1499);
    expect(kill.mock.calls).toEqual([[-1234, 'SIGTERM']]);
    await jest.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenLastCalledWith(-1234, 'SIGKILL');
    expect(done).toBe(false);
    close();
    await stopping;
    expect(done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('tolerates an already-exited group without leaving a timer', async () => {
    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await stopCursorProcessGroup(1234, Promise.resolve());
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('runCursorRuntimeCommand', () => {
  it('rejects promptly when the executable cannot be spawned', async () => {
    await expect(
      runCursorRuntimeCommand(
        {
          command: join(tmpdir(), `missing-cursor-agent-${process.pid}`),
          prefix: [],
        },
        ['--version'],
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});

describe('verifyCursorRuntimeVersion', () => {
  const launch = (source: string): { command: string; prefix: string[] } => ({
    command: process.execPath,
    prefix: ['-e', source, '--'],
  });

  it('accepts the pinned version from a successful process', async () => {
    await expect(
      verifyCursorRuntimeVersion(
        launch('process.stdout.write("1.2.3\\n")'),
        {},
        new AbortController().signal,
        '1.2.3',
      ),
    ).resolves.toBeUndefined();
  });

  it('reports a failed launch without asking to reinstall', async () => {
    const diagnostic = jest.fn();
    await expect(
      verifyCursorRuntimeVersion(
        {
          command: join(tmpdir(), `missing-cursor-${process.pid}`),
          prefix: [],
        },
        {},
        new AbortController().signal,
        '1.2.3',
        undefined,
        diagnostic,
      ),
    ).rejects.toThrow("Couldn't start the Cursor version check. Try again.");
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'spawn-error',
        errorCode: 'ENOENT',
        attempt: 1,
      }),
    );
  });

  it.each([
    [
      'process.stdout.write("1.2.3"); process.exitCode = 7',
      'The Cursor version check exited before it completed. Try again.',
    ],
    ['', "Couldn't read the Cursor version. Try again."],
    [
      'process.stdout.write("x".repeat(20_000))',
      'The Cursor version check returned too much output. Try again.',
    ],
  ])('distinguishes an incomplete probe: %s', async (source, message) => {
    const diagnostic = jest.fn();
    await expect(
      verifyCursorRuntimeVersion(
        launch(source),
        {},
        new AbortController().signal,
        '1.2.3',
        undefined,
        diagnostic,
      ),
    ).rejects.toThrow(message);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it('reports cancellation during a running probe without reinstall guidance', async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await expect(
        verifyCursorRuntimeVersion(
          launch('setInterval(() => {}, 1000)'),
          {},
          abort.signal,
          '1.2.3',
        ),
      ).rejects.toThrow('Cursor version check cancelled.');
    } finally {
      clearTimeout(timer);
    }
  });

  it('does not start a probe when already cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const diagnostic = jest.fn();
    await expect(
      verifyCursorRuntimeVersion(
        launch('process.exit(99)'),
        {},
        abort.signal,
        '1.2.3',
        undefined,
        diagnostic,
      ),
    ).rejects.toThrow('Cursor version check cancelled.');
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cancelled', exitCode: undefined }),
    );
  });

  it('does not let diagnostic failures replace the probe failure', async () => {
    await expect(
      verifyCursorRuntimeVersion(
        launch('process.exit(7)'),
        {},
        new AbortController().signal,
        '1.2.3',
        undefined,
        () => {
          throw new Error('log failed');
        },
      ),
    ).rejects.toThrow(
      'The Cursor version check exited before it completed. Try again.',
    );
  });

  it('stops after two timeouts without suggesting reinstall', async () => {
    const diagnostics: CursorVersionProbeDiagnostic[] = [];
    await expect(
      verifyCursorRuntimeVersion(
        launch('setInterval(() => {}, 1000)'),
        {},
        new AbortController().signal,
        '1.2.3',
        undefined,
        (event) => {
          diagnostics.push(event);
        },
      ),
    ).rejects.toThrow(
      'The Cursor version check timed out. Try again when workspace setup has finished.',
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        outcome: 'timeout',
        attempt: 1,
        timeoutMs: 10_000,
      }),
      expect.objectContaining({
        outcome: 'timeout',
        attempt: 2,
        timeoutMs: 30_000,
      }),
    ]);
  }, 55_000);

  it('honors cancellation between attempts instead of spawning the retry', async () => {
    const abort = new AbortController();
    const diagnostic = jest.fn(() => abort.abort());
    await expect(
      verifyCursorRuntimeVersion(
        launch('setInterval(() => {}, 1000)'),
        {},
        abort.signal,
        '1.2.3',
        undefined,
        diagnostic,
      ),
    ).rejects.toThrow('Cursor version check cancelled.');
    expect(diagnostic).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('retries a timed-out probe once and accepts the pinned version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursor-version-retry-'));
    const marker = join(root, 'attempt');
    const diagnostics: CursorVersionProbeDiagnostic[] = [];
    try {
      await expect(
        verifyCursorRuntimeVersion(
          launch(
            `const fs = require('node:fs'); if (fs.existsSync(process.env.PROBE_MARKER)) { process.stdout.write('1.2.3'); } else { fs.writeFileSync(process.env.PROBE_MARKER, 'started'); setInterval(() => {}, 1000); }`,
          ),
          { PROBE_MARKER: marker },
          new AbortController().signal,
          '1.2.3',
          undefined,
          (event) => {
            diagnostics.push(event);
          },
        ),
      ).resolves.toBeUndefined();
      expect(diagnostics).toEqual([
        expect.objectContaining({ outcome: 'timeout', attempt: 1 }),
        expect.objectContaining({
          outcome: 'verified',
          attempt: 2,
          exitCode: 0,
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects with a context-free message when the reported version does not match', async () => {
    await expect(
      verifyCursorRuntimeVersion(
        {
          command: process.execPath,
          prefix: [
            '-e',
            'process.stdout.write("not-the-pinned-version")',
            '--',
          ],
        },
        {},
        new AbortController().signal,
        '1.2.3',
      ),
      // The message must read on its own wherever it surfaces (e.g. the
      // approval-check error passthrough in apps/desktop-app/src/main/cursor/
      // approval-check.ts), not only inline after "This check requires...".
    ).rejects.toThrow('Cursor CLI 1.2.3 is required.');
  });
});

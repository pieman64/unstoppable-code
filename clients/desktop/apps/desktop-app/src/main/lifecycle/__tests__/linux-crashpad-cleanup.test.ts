import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopLinuxCrashpadHandlers } from '../linux-crashpad-cleanup';

describe('Linux Crashpad shutdown', () => {
  it.each(['darwin', 'win32'] as const)(
    'does nothing on %s without reading procfs',
    async (platform) => {
      const signal = jest.fn();
      await stopLinuxCrashpadHandlers({
        platform,
        executablePath: '/opt/app/code',
        crashDumpsPath: '/home/test/Crashpad',
        procDirectory: '/nonexistent-can-5661-procfs',
        signal,
      });
      expect(signal).not.toHaveBeenCalled();
    },
  );

  // Windows has neither Unix uid ownership nor unprivileged procfs symlinks.
  // The platform no-op contract above still runs there.
  const describeProcfs =
    process.platform === 'win32' ? describe.skip : describe;
  describeProcfs('procfs handler ownership', () => {
    let procDirectory: string;
    const executablePath = '/opt/Unstoppable Code/internal-code';
    const handlerPath = '/opt/Unstoppable Code/chrome_crashpad_handler';
    const crashDumpsPath = '/home/test/.config/Unstoppable Code/Crashpad';

    beforeEach(async () => {
      procDirectory = await mkdtemp(join(tmpdir(), 'crashpad-cleanup-'));
    });
    afterEach(async () => rm(procDirectory, { recursive: true, force: true }));

    async function handler(
      pid: number,
      {
        exe = handlerPath,
        database = crashDumpsPath,
        start = '12345',
        state = 'S',
        comm = 'chrome_crashpad',
      } = {},
    ): Promise<void> {
      const directory = join(procDirectory, String(pid));
      await mkdir(directory, { recursive: true });
      await symlink(exe, join(directory, 'exe'));
      await writeFile(
        join(directory, 'cmdline'),
        `${exe}\0--database=${database}\0--shared-client-connection\0`,
      );
      await writeFile(
        join(directory, 'stat'),
        `${pid} (${comm}) ${state} ${Array(18).fill('0').join(' ')} ${start} 0 0\n`,
      );
    }

    it('terminates the detached handler for this executable and crash database', async () => {
      await handler(123);
      const signals: [number, NodeJS.Signals][] = [];
      await stopLinuxCrashpadHandlers({
        platform: 'linux',
        executablePath,
        crashDumpsPath,
        procDirectory,
        signal: (pid, signal) => {
          signals.push([pid, signal]);
          rmSync(join(procDirectory, String(pid)), {
            recursive: true,
            force: true,
          });
        },
      });
      expect(signals).toEqual([[123, 'SIGTERM']]);
    });

    it('escalates a handler that ignores SIGTERM', async () => {
      await handler(123);
      const signal = jest.fn((pid: number, nextSignal: NodeJS.Signals) => {
        if (nextSignal === 'SIGKILL')
          rmSync(join(procDirectory, String(pid)), {
            recursive: true,
            force: true,
          });
      });
      await stopLinuxCrashpadHandlers({
        platform: 'linux',
        executablePath,
        crashDumpsPath,
        procDirectory,
        signal,
      });
      expect(signal.mock.calls).toEqual([
        [123, 'SIGTERM'],
        [123, 'SIGKILL'],
      ]);
    });

    it('cleans a deleted handler alongside unrelated processes and parses comm parentheses', async () => {
      await handler(123, {
        exe: `${handlerPath} (deleted)`,
        comm: 'crashpad ) helper',
      });
      await handler(124, { database: `${crashDumpsPath}-other` });
      const signal = jest.fn((pid: number) =>
        rmSync(join(procDirectory, String(pid)), {
          recursive: true,
          force: true,
        }),
      );
      await stopLinuxCrashpadHandlers({
        platform: 'linux',
        executablePath,
        crashDumpsPath,
        procDirectory,
        signal,
      });
      expect(signal.mock.calls).toEqual([[123, 'SIGTERM']]);
    });

    it('reports a handler that remains alive after bounded setTimeout polling and escalation', async () => {
      await handler(123);
      await expect(
        stopLinuxCrashpadHandlers({
          platform: 'linux',
          executablePath,
          crashDumpsPath,
          procDirectory,
          signal: jest.fn(),
        }),
      ).rejects.toThrow('did not exit after SIGKILL');
    });

    it('propagates a signal permission failure so shutdown diagnostics record it', async () => {
      await handler(123);
      const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
      await expect(
        stopLinuxCrashpadHandlers({
          platform: 'linux',
          executablePath,
          crashDumpsPath,
          procDirectory,
          signal: () => {
            throw denied;
          },
        }),
      ).rejects.toBe(denied);
    });

    it('leaves other installations, profiles, zombies and malformed entries alone', async () => {
      await handler(123, { exe: '/opt/Other/chrome_crashpad_handler' });
      await handler(124, { database: `${crashDumpsPath}-other` });
      await handler(125, { state: 'Z' });
      await handler(126);
      await writeFile(join(procDirectory, '126', 'stat'), 'malformed');
      await mkdir(join(procDirectory, '127'));
      const signal = jest.fn();
      await stopLinuxCrashpadHandlers({
        platform: 'linux',
        executablePath,
        crashDumpsPath,
        procDirectory,
        signal,
      });
      expect(signal).not.toHaveBeenCalled();
    });

    it('does not signal a reused PID during escalation', async () => {
      await handler(123);
      const signal = jest.fn((pid: number) => {
        writeFileSync(
          join(procDirectory, String(pid), 'stat'),
          `${pid} (unrelated) S ${Array(18).fill('0').join(' ')} 99999 0 0\n`,
        );
      });
      await stopLinuxCrashpadHandlers({
        platform: 'linux',
        executablePath,
        crashDumpsPath,
        procDirectory,
        signal,
      });
      expect(signal).toHaveBeenCalledTimes(1);
    });

    it('tolerates a handler disappearing before it can be signalled', async () => {
      await handler(123);
      const signal = jest.fn(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      await expect(
        stopLinuxCrashpadHandlers({
          platform: 'linux',
          executablePath,
          crashDumpsPath,
          procDirectory,
          signal,
        }),
      ).resolves.toBeUndefined();
    });
  });
});

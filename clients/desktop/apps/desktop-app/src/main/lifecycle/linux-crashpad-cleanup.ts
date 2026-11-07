import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export interface LinuxCrashpadCleanupOptions {
  platform: NodeJS.Platform;
  executablePath: string;
  crashDumpsPath: string;
  procDirectory?: string;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

export async function stopLinuxCrashpadHandlers(
  options: LinuxCrashpadCleanupOptions,
): Promise<void> {
  if (options.platform !== 'linux') return;
  const procDirectory = options.procDirectory ?? '/proc';
  const handlerPath = join(
    dirname(options.executablePath),
    'chrome_crashpad_handler',
  );
  const signal =
    options.signal ??
    ((pid: number, nextSignal: NodeJS.Signals): void => {
      process.kill(pid, nextSignal);
    });
  const uid = process.getuid?.();
  if (uid === undefined) return;

  // Crashpad detaches, so PPid and Electron's child-process metrics cannot
  // establish ownership. The single-instance lock scopes this crash database;
  // also require our user and exact installation, never just a process name.
  async function identity(pid: number): Promise<string | null> {
    try {
      const directory = join(procDirectory, String(pid));
      const exe = await readlink(join(directory, 'exe'));
      if (exe.replace(/ \(deleted\)$/, '') !== handlerPath) return null;
      const [owner, command, processStat] = await Promise.all([
        stat(directory),
        readFile(join(directory, 'cmdline'), 'utf8'),
        readFile(join(directory, 'stat'), 'utf8'),
      ]);
      if (
        owner.uid !== uid ||
        !command.split('\0').includes(`--database=${options.crashDumpsPath}`)
      )
        return null;
      // proc(5) field 22 follows the comm field, which may contain spaces or ')'.
      const fields = processStat
        .slice(processStat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      const start = fields[19];
      if (!start || !/^\d+$/.test(start) || fields[0] === 'Z') return null;
      return start;
    } catch {
      // Entries disappear during enumeration; foreign users may be unreadable.
      return null;
    }
  }

  async function stop(pid: number): Promise<void> {
    const start = await identity(pid);
    if (start === null) return;
    for (const nextSignal of ['SIGTERM', 'SIGKILL'] as const) {
      // Revalidate before every signal, especially after waiting: PID reuse
      // must never turn a quit into termination of an unrelated process.
      if ((await identity(pid)) !== start) return;
      try {
        signal(pid, nextSignal);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
          return;
        throw error;
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        await setTimeout(25);
        if ((await identity(pid)) !== start) return;
      }
    }
    throw new Error(`Crashpad handler ${pid} did not exit after SIGKILL`);
  }

  const pids = (await readdir(procDirectory)).filter((name) =>
    /^[1-9]\d*$/.test(name),
  );
  await Promise.all(pids.map((pid) => stop(Number(pid))));
}

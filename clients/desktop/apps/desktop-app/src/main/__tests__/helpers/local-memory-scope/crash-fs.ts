import {
  constants,
  type MakeDirectoryOptions,
  type Mode,
  type PathLike,
  type TimeLike,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';

/*
 * Simulates a process dying part way through a memory write. Installed from
 * a `jest.mock('node:fs/promises', ...)` factory, it routes every call that
 * changes the disk through the active {@link FsCrashPlan}: the plan records
 * the calls, cuts one short (it never happens or, for a write, only its
 * first half lands) and fails every later one, as a dead process changes
 * nothing more. Reads pass through. Without a plan every call passes through.
 */

export class SimulatedCrashError extends Error {
  readonly code = 'ESIMULATEDCRASH';

  constructor(step: string) {
    super(`Simulated crash at ${step}`);
    this.name = 'SimulatedCrashError';
  }
}

export type CrashMode = 'before' | 'torn';

export interface FsStep {
  call: string;
  path: string;
}

export interface CrashPoint extends FsStep {
  index: number;
  mode: CrashMode;
}

const WRITES = new Set(['writeFile', 'copyFile']);

export class FsCrashPlan {
  readonly steps: FsStep[] = [];
  private crashedAt: CrashPoint | null = null;

  constructor(
    private readonly point: { index: number; mode: CrashMode } | null,
    /** False for a file system without hard links, which refuses `link`. */
    readonly hardLinks = true,
  ) {}

  get crashed(): boolean {
    return this.crashedAt !== null;
  }

  async perform(
    call: string,
    path: string,
    run: () => Promise<void>,
    torn: () => Promise<void>,
  ): Promise<void> {
    if (this.crashedAt !== null) {
      throw new SimulatedCrashError(`${call} ${path}, after the crash`);
    }
    const index = this.steps.length;
    this.steps.push({ call, path });
    if (this.point?.index !== index) return run();
    this.crashedAt = { call, path, ...this.point };
    if (this.point.mode === 'torn') await torn();
    throw new SimulatedCrashError(`${call} ${path}`);
  }
}

/** Every point to cut `steps` short: before each call, halfway into writes. */
export function crashPoints(steps: readonly FsStep[]): CrashPoint[] {
  return steps.flatMap((step, index) => [
    { ...step, index, mode: 'before' as const },
    ...(WRITES.has(step.call)
      ? [{ ...step, index, mode: 'torn' as const }]
      : []),
  ]);
}

function firstHalf(data: unknown): Buffer | null {
  if (typeof data === 'string') return firstHalf(Buffer.from(data, 'utf8'));
  if (!Buffer.isBuffer(data)) return null;
  return data.subarray(0, Math.floor(data.length / 2));
}

function linksUnsupported(): Error & { code: string } {
  return Object.assign(new Error('EPERM: operation not permitted, link'), {
    code: 'EPERM',
  });
}

/** `node:fs/promises`, with `mkdir` resolving the first directory it made. */
type CrashableFsPromises = Omit<typeof FsPromises, 'mkdir'> & {
  mkdir: (
    path: PathLike,
    options?: Mode | MakeDirectoryOptions | null,
  ) => Promise<string | undefined>;
};

export function crashableFsPromises(
  base: typeof FsPromises,
  activePlan: () => FsCrashPlan | null,
): CrashableFsPromises {
  const step = (
    call: string,
    path: unknown,
    run: () => Promise<void>,
    torn: () => Promise<void> = run,
  ): Promise<void> => {
    const plan = activePlan();
    return plan === null ? run() : plan.perform(call, String(path), run, torn);
  };
  type WriteFile = typeof base.writeFile;
  const writeFile = (
    file: Parameters<WriteFile>[0],
    data: Parameters<WriteFile>[1],
    options?: Parameters<WriteFile>[2],
  ): Promise<void> =>
    step(
      'writeFile',
      file,
      () => base.writeFile(file, data, options),
      () => base.writeFile(file, firstHalf(data) ?? data, options),
    );
  type CopyFile = typeof base.copyFile;
  const copyFile = (
    source: Parameters<CopyFile>[0],
    destination: Parameters<CopyFile>[1],
    mode?: Parameters<CopyFile>[2],
  ): Promise<void> =>
    step(
      'copyFile',
      destination,
      () => base.copyFile(source, destination, mode),
      async () => {
        const bytes = await base.readFile(source);
        await base.writeFile(
          destination,
          bytes.subarray(0, Math.floor(bytes.length / 2)),
          {
            flag: ((mode ?? 0) & constants.COPYFILE_EXCL) !== 0 ? 'wx' : 'w',
          },
        );
      },
    );
  const mkdir = async (
    path: PathLike,
    options?: Mode | MakeDirectoryOptions | null,
  ): Promise<string | undefined> => {
    let made: string | undefined;
    await step('mkdir', path, async () => {
      made = await base.mkdir(path, options);
    });
    return made;
  };
  return {
    ...base,
    writeFile,
    copyFile,
    mkdir,
    rename: (from: PathLike, to: PathLike): Promise<void> =>
      step('rename', to, () => base.rename(from, to)),
    link: (existing: PathLike, path: PathLike): Promise<void> =>
      activePlan()?.hardLinks === false
        ? Promise.reject(linksUnsupported())
        : step('link', path, () => base.link(existing, path)),
    unlink: (path: PathLike): Promise<void> =>
      step('unlink', path, () => base.unlink(path)),
    utimes: (path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> =>
      step('utimes', path, () => base.utimes(path, atime, mtime)),
    chmod: (path: PathLike, mode: Mode): Promise<void> =>
      step('chmod', path, () => base.chmod(path, mode)),
    rm: (
      path: PathLike,
      options?: Parameters<typeof base.rm>[1],
    ): Promise<void> => step('rm', path, () => base.rm(path, options)),
  };
}

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import * as paths from 'node:path';

interface InventoryEntry {
  type: 'file' | 'directory' | 'other';
  mode: number;
  mtimeNs: bigint;
  size: number;
  sha256?: string;
}

/** Bytes (size and SHA-256), mode and mtime of every path beneath `root`. */
export async function inventory(
  root: string,
): Promise<Map<string, InventoryEntry>> {
  const result = new Map<string, InventoryEntry>();
  const visit = async (relative: string): Promise<void> => {
    const absolute = paths.join(root, relative);
    const stats = await lstat(absolute, { bigint: true });
    const type = stats.isFile()
      ? 'file'
      : stats.isDirectory()
        ? 'directory'
        : 'other';
    result.set(relative, {
      type,
      mode: Number(stats.mode),
      mtimeNs: stats.mtimeNs,
      size: type === 'directory' ? 0 : Number(stats.size),
      ...(type === 'file'
        ? {
            sha256: createHash('sha256')
              .update(await readFile(absolute))
              .digest('hex'),
          }
        : {}),
    });
    if (type === 'directory') {
      for (const name of (await readdir(absolute)).sort()) {
        await visit(paths.join(relative, name));
      }
    }
  };
  await visit('.');
  return result;
}

type SpyTarget = Record<string, unknown>;

const FORBIDDEN_PROMISE_CALLS = [
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'rename',
  'rm',
  'rmdir',
  'unlink',
  'copyFile',
  'cp',
  'chmod',
  'lchmod',
  'chown',
  'lchown',
  'utimes',
  'lutimes',
  'truncate',
  'symlink',
  'link',
];
const FORBIDDEN_SYNC_AND_CALLBACK_CALLS = FORBIDDEN_PROMISE_CALLS.flatMap(
  (name) => [name, `${name}Sync`],
).concat([
  'createWriteStream',
  'write',
  'writeSync',
  'writev',
  'writevSync',
  'ftruncate',
  'ftruncateSync',
]);
const OPEN_CALLS = { 'fs/promises': ['open'], fs: ['open', 'openSync'] };

// `fs.open(path, callback)` defaults to read-only `'r'`.
function isReadOnlyOpenFlag(flags: unknown): boolean {
  return (
    flags === undefined ||
    typeof flags === 'function' ||
    flags === 'r' ||
    flags === 0
  );
}

export function instrumentForbiddenWrites(): {
  calls: string[];
  restore(): void;
} {
  const calls: string[] = [];
  const restores: (() => void)[] = [];
  const instrument = (
    label: string,
    target: SpyTarget,
    names: readonly string[],
    isForbidden: (args: unknown[]) => boolean = () => true,
  ): void => {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      target[name] = (...args: unknown[]): unknown => {
        if (isForbidden(args)) calls.push(`${label}.${name}`);
        const result: unknown = Reflect.apply(original, target, args);
        return result;
      };
      restores.push(() => {
        target[name] = original;
      });
    }
  };
  const promises = jest.requireActual<SpyTarget>('node:fs/promises');
  const callbacks = jest.requireActual<SpyTarget>('node:fs');
  const writableOpen = (args: unknown[]): boolean =>
    !isReadOnlyOpenFlag(args[1]);
  instrument('fs/promises', promises, FORBIDDEN_PROMISE_CALLS);
  instrument('fs', callbacks, FORBIDDEN_SYNC_AND_CALLBACK_CALLS);
  instrument('fs/promises', promises, OPEN_CALLS['fs/promises'], writableOpen);
  instrument('fs', callbacks, OPEN_CALLS.fs, writableOpen);
  return {
    calls,
    restore: (): void => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

/** Runs `reads` with forbidden writes instrumented, then compares inventories. */
export async function expectNoWrites(
  inventoryRoot: string,
  reads: () => Promise<void>,
): Promise<void> {
  const before = await inventory(inventoryRoot);
  const writes = instrumentForbiddenWrites();
  try {
    await reads();
  } finally {
    writes.restore();
  }
  expect(writes.calls).toEqual([]);
  expect(await inventory(inventoryRoot)).toEqual(before);
}

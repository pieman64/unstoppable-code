// The commit log as a host composes it, for suites that exercise the applier.
// The port mirrors the desktop's atomic-file semantics with node:fs, which
// core-runtime may import: a sibling temp file, fsync, a rename retried over
// transient sharing violations, then a sync of its folder, skipped on Windows,
// where folders cannot be opened.
import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  applyW5Commit as applyW5CommitWith,
  recoverW5CommitLog as recoverW5CommitLogWith,
  type W5ApplyOptions as W5PortableApplyOptions,
  type W5ApplyResult,
  type W5CommitLog,
  type W5DurabilityPort,
  type W5PendingCommit,
  type W5RecoveryReport,
} from '../..';

export * from '../..';

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// The desktop's rename-with-retry delays and codes.
async function renameWithRetry(source: string, target: string): Promise<void> {
  for (const wait of [50, 100, 150, 200, 250, null]) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      // Not instanceof Error: fs errors come from another realm under Jest.
      const code: unknown =
        error !== null && typeof error === 'object'
          ? Reflect.get(error, 'code')
          : undefined;
      if (
        wait === null ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(String(code))
      ) {
        throw error;
      }
      await delay(wait);
    }
  }
}

async function writeFileDurably(path: string, contents: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(path));
}

export const testW5Durability: W5DurabilityPort = {
  syncDirectory,
  writeFileDurably,
};

export type W5ApplyOptions = Omit<W5PortableApplyOptions, 'durability'> &
  Partial<Pick<W5PortableApplyOptions, 'durability'>>;

export function applyW5Commit(
  log: W5CommitLog,
  commit: W5PendingCommit,
  options: W5ApplyOptions,
): Promise<W5ApplyResult> {
  return applyW5CommitWith(log, commit, {
    ...options,
    durability: options.durability ?? testW5Durability,
  });
}

export function recoverW5CommitLog(
  log: W5CommitLog,
  options: W5ApplyOptions,
): Promise<W5RecoveryReport> {
  return recoverW5CommitLogWith(log, {
    ...options,
    durability: options.durability ?? testW5Durability,
  });
}

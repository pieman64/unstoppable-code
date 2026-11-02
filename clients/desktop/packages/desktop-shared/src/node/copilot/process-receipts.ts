import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically, syncDirectory } from '../lib/atomic-file';
import {
  remainingCopilotProcesses,
  terminateCopilotDescendants,
  type ProcessIdentity,
} from './process-ownership';

function parseIdentities(value: unknown): ProcessIdentity[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('processes' in value) ||
    !Array.isArray(value.processes) ||
    value.processes.length > 16_384
  )
    throw new Error('Copilot process receipt is invalid.');
  return value.processes.map((row: unknown): ProcessIdentity => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('pid' in row) ||
      typeof row.pid !== 'number' ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      !('parent' in row) ||
      typeof row.parent !== 'number' ||
      !Number.isSafeInteger(row.parent) ||
      row.parent < 0 ||
      !('group' in row) ||
      typeof row.group !== 'number' ||
      !Number.isSafeInteger(row.group) ||
      row.group < 0 ||
      !('started' in row) ||
      typeof row.started !== 'string' ||
      !row.started ||
      row.started.length > 128
    )
      throw new Error('Copilot process receipt is invalid.');
    return {
      pid: row.pid,
      parent: row.parent,
      group: row.group,
      started: row.started,
    };
  });
}

/** A host-private receipt, separate from provider-owned session state. */
export class CopilotProcessReceipt {
  private readonly path: string;
  private contents = '';
  constructor(private readonly directory: string) {
    this.path = join(directory, `${randomUUID()}.json`);
  }

  async save(processes: readonly ProcessIdentity[]): Promise<void> {
    if (!processes.length) return;
    const contents = JSON.stringify({
      version: 1,
      processes: processes.map((row) => ({
        pid: row.pid,
        parent: row.parent,
        group: row.group,
        started: row.started,
      })),
    });
    if (contents === this.contents) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFileAtomically(this.path, contents, {
      mode: 0o600,
      durable: true,
    });
    this.contents = contents;
  }

  async removeIfReaped(processes: readonly ProcessIdentity[]): Promise<void> {
    if (!this.contents || (await remainingCopilotProcesses(processes)).length)
      return;
    await rm(this.path, { force: true });
    await syncDirectory(this.directory);
  }
}

// Startup recovery only: a SIGKILLed process can still be exiting in the
// snapshot taken right after the kill. Normal close and quit never wait here.
const RECOVERY_EXIT_TIMEOUT_MS = 2000;
const RECOVERY_EXIT_POLL_MS = 50;

const identityKey = (row: ProcessIdentity): string =>
  `${row.pid} ${row.started}`;

/**
 * One probe per poll covers every receipt, so slow Windows queries cannot
 * stack. A probe started before the deadline may finish after it.
 */
async function survivorsAfterRecovery(
  processes: readonly ProcessIdentity[],
): Promise<ReadonlySet<string>> {
  const deadline = Date.now() + RECOVERY_EXIT_TIMEOUT_MS;
  let remaining = await remainingCopilotProcesses(processes);
  while (remaining.length && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, RECOVERY_EXIT_POLL_MS),
    );
    remaining = await remainingCopilotProcesses(remaining);
  }
  return new Set(remaining.map(identityKey));
}

/** Run before admission on the next boot. Never infer ownership from a PID alone. */
export async function reapCopilotProcessReceipts(
  directory: string,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return;
    throw error;
  }
  const failures: unknown[] = [];
  const signaled: { path: string; processes: ProcessIdentity[] }[] = [];
  for (const name of names.filter((name) =>
    /^[a-f0-9-]{36}\.json$/.test(name),
  )) {
    try {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        throw new Error('Copilot process receipt is invalid.');
      const processes = parseIdentities(
        JSON.parse(await readFile(path, 'utf8')),
      );
      await terminateCopilotDescendants(processes);
      signaled.push({ path, processes });
    } catch (error) {
      failures.push(error);
    }
  }
  if (signaled.length) {
    try {
      const survivors = await survivorsAfterRecovery(
        signaled.flatMap((receipt) => receipt.processes),
      );
      for (const { path, processes } of signaled) {
        try {
          if (processes.some((row) => survivors.has(identityKey(row))))
            throw new Error('Copilot processes remain after recovery.');
          await rm(path);
          await syncDirectory(directory);
        } catch (error) {
          failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;
  const error = new Error('Copilot process recovery did not finish.');
  // The first failure; non-enumerable like a native cause.
  Object.defineProperty(error, 'cause', {
    value: failures[0],
    configurable: true,
    writable: true,
  });
  throw error;
}

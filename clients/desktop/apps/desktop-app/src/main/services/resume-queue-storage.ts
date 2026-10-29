import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ResumeQueueSnapshot } from '@canopy/desktop-shared/types';
import { renameWithRetry } from '../lib/atomic-file';

const id = z.string().min(1).max(512);
const target = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat'),
    projectId: id,
    worktreeId: id,
    chatId: id,
  }),
  z.object({
    kind: z.literal('pipeline'),
    executionId: id,
    statusReasonIds: z.array(id).min(1).max(1000),
  }),
]);
const snapshotSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  paused: z.boolean(),
  error: z.string().optional(),
  suppressedAutomaticResumes: z
    .array(
      z.object({
        targetKey: z.string().max(1600),
        interruptionId: z.string().max(10000),
      }),
    )
    .optional(),
  entries: z
    .array(
      z.object({
        id,
        target,
        interruptionId: z.string().max(10000),
        accountProxyConnectionId: id.optional(),
        accountProxyDetectedAt: z.number().finite().optional(),
        title: z.string().max(1000),
        workspaceName: z.string().max(1000),
        providers: z
          .array(z.enum(['claude', 'codex', 'ollama', 'cursor']))
          .max(4)
          .optional(),
        createdAt: z.number().finite(),
        status: z.enum([
          'waiting',
          'resuming',
          'resumed',
          'skipped',
          'failed',
          'stopped',
        ]),
        error: z.string().optional(),
      }),
    )
    .max(2000),
});

/** One writer, atomic publication, fsync off the main event loop. Never discard corrupt intent. */
export class ResumeQueueStorage {
  constructor(private readonly file: string) {}

  async load(): Promise<ResumeQueueSnapshot | null> {
    let data: string;
    try {
      data = await readFile(this.file, 'utf8');
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null;
      throw error;
    }
    try {
      return snapshotSchema.parse(JSON.parse(data));
    } catch (error) {
      const failure = new Error(
        'Resume queue state is unsupported or corrupt.',
      );
      Object.assign(failure, { cause: error });
      throw failure;
    }
  }

  async save(snapshot: ResumeQueueSnapshot): Promise<void> {
    const data = JSON.stringify(snapshotSchema.parse(snapshot));
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, this.file);
      // Windows does not support opening directories through this API. The
      // synced file and atomic rename still protect against process crashes.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.file), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

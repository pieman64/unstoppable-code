import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FieldSpool } from '../../lib/chat-transcript-field-spool';
import { getDelegationTranscriptSpoolRootDir } from '../../lib/paths';

/** A spool operation, named for the test fault hook. */
export type CommandSpoolOperation =
  | 'create'
  | 'append'
  | 'finish'
  | 'read'
  | 'close'
  | 'remove';

export interface CommandSpoolFaultHook {
  /** Runs before each operation; a rejection fails that operation. */
  before(operation: CommandSpoolOperation, key: string): Promise<void>;
}

export interface CommandOutputSpoolsOptions {
  /** Directory that holds every run's spool directory. */
  readonly root: () => string;
  readonly faults?: CommandSpoolFaultHook;
}

/** Exact output of one Codex command while it runs. */
export interface CommandSpool {
  append(text: string): Promise<void>;
  /** Finish the spool and return its whole content, read once. */
  read(): Promise<string>;
  discard(): Promise<void>;
}

/** One owner per run generation; it touches only its own directory. */
export interface DelegationCommandSpools {
  acquire(key: string): Promise<CommandSpool>;
  /** Close every spool and remove the run directory; idempotent. */
  close(): Promise<void>;
}

interface OwnedSpool {
  readonly key: string;
  readonly field: FieldSpool;
  readonly spool: CommandSpool;
  disposed: boolean;
  failed: boolean;
  closePromise?: Promise<void>;
  readPromise?: Promise<string>;
}

/** Private, lazy run directory; no sweeps or cancellation-sensitive I/O. */
export function createCommandOutputSpools(
  options: CommandOutputSpoolsOptions,
): DelegationCommandSpools {
  const live = new Map<string, OwnedSpool>();
  const handles = new Set<OwnedSpool>();
  let directory: string | undefined;
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  // One lane also fences acquisitions and reads against owner teardown.
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (closePromise)
      return Promise.reject(new Error('Command spools are closed'));
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function closeField(state: OwnedSpool): Promise<void> {
    state.closePromise ??= (async (): Promise<void> => {
      const errors: unknown[] = [];
      try {
        await options.faults?.before('close', state.key);
      } catch (error) {
        errors.push(error);
      }
      // A hook failure must never prevent the actual handle-close attempt.
      try {
        await state.field.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw errors[0];
    })();
    return state.closePromise;
  }

  async function useField<T>(
    state: OwnedSpool,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (state.failed || state.disposed || state.closePromise)
      throw new Error('Command spool is closed');
    try {
      return await operation();
    } catch (error) {
      // The caller must latch this error before any fallible teardown runs.
      // Explicit discard/owner close retain ownership of this handle.
      state.failed = true;
      throw error;
    }
  }

  async function discard(state: OwnedSpool): Promise<void> {
    if (state.disposed) return;
    state.disposed = true;
    state.readPromise = undefined;
    live.delete(state.key);
    const errors: unknown[] = [];
    try {
      await closeField(state);
    } catch (error) {
      errors.push(error);
    }
    try {
      await options.faults?.before('remove', state.key);
      await rm(state.field.path, { force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
    handles.delete(state);
  }

  return {
    acquire(key): Promise<CommandSpool> {
      return enqueue(async (): Promise<CommandSpool> => {
        const existing = live.get(key);
        if (existing) return existing.spool;
        await options.faults?.before('create', key);
        directory ??= join(options.root(), randomUUID());
        await mkdir(directory, { recursive: true });
        const field = await FieldSpool.create(directory);
        const state: OwnedSpool = {
          key,
          field,
          disposed: false,
          failed: false,
          spool: {
            append(text): Promise<void> {
              if (state.failed)
                return Promise.reject(new Error('Command spool is closed'));
              return enqueue(() =>
                useField(state, async (): Promise<void> => {
                  await options.faults?.before('append', key);
                  await field.append(text);
                }),
              );
            },
            read(): Promise<string> {
              if (closePromise || state.disposed || state.failed)
                return Promise.reject(new Error('Command spool is closed'));
              state.readPromise ??= enqueue(() =>
                useField(state, async (): Promise<string> => {
                  await options.faults?.before('finish', key);
                  await field.finish();
                  await options.faults?.before('read', key);
                  const chunks: string[] = [];
                  for await (const chunk of field.strings()) chunks.push(chunk);
                  return chunks.join('');
                }),
              );
              return state.readPromise;
            },
            discard(): Promise<void> {
              return enqueue(() => discard(state));
            },
          },
        };
        handles.add(state);
        live.set(key, state);
        return state.spool;
      });
    },
    close(): Promise<void> {
      closePromise ??= tail.then(async (): Promise<void> => {
        const errors: unknown[] = [];
        for (const state of Array.from(handles)) {
          state.disposed = true;
          state.readPromise = undefined;
          try {
            await closeField(state);
          } catch (error) {
            errors.push(error);
          }
        }
        handles.clear();
        live.clear();
        if (directory !== undefined) {
          try {
            // The empty key denotes the owner directory, never a file key.
            await options.faults?.before('remove', '');
            await rm(directory, { recursive: true, force: true });
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw errors[0];
      });
      return closePromise;
    },
  };
}

/** Default desktop owner; construction performs no filesystem work. */
export function createDefaultCommandOutputSpools(): DelegationCommandSpools {
  return createCommandOutputSpools({
    root: getDelegationTranscriptSpoolRootDir,
  });
}

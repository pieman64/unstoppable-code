import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CreateSharedMultiRepoParamsSchema,
  SharedMultiRepoCreationStatusSchema,
} from '@canopy/protocol/canopy-core';
import type {
  SharedMultiRepoCreationJournal,
  SharedMultiRepoJournalStore,
} from './org-shared-multi-repo';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
function parse(value: unknown): SharedMultiRepoCreationJournal {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('accountId' in value) ||
    typeof value.accountId !== 'string' ||
    !value.accountId ||
    !('deviceId' in value) ||
    typeof value.deviceId !== 'string' ||
    !('params' in value) ||
    !('status' in value) ||
    !('requestDigest' in value) ||
    typeof value.requestDigest !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error(
      'Unknown or corrupt shared creation journal; preserve it for recovery',
    );
  const params = CreateSharedMultiRepoParamsSchema.parse(value.params);
  const status = SharedMultiRepoCreationStatusSchema.parse(value.status);
  if (
    hash(JSON.stringify(params)) !== value.requestDigest ||
    status.creationKey !== params.request.creationKey ||
    status.organizationId !== params.request.organizationId ||
    status.deviceId !== value.deviceId
  )
    throw new Error('Shared creation journal identity mismatch');
  return {
    version: 1,
    accountId: value.accountId,
    deviceId: value.deviceId,
    params,
    status,
    requestDigest: value.requestDigest,
    createdAt: value.createdAt,
  };
}

/** Account isolation and permanent unresolved records; no age-based pruning. */
export function createSharedMultiRepoJournalStore(options: {
  rootDir(): string;
  writeAtomic(path: string, content: string): Promise<void>;
}): SharedMultiRepoJournalStore {
  let writes: Promise<void> = Promise.resolve();
  async function directory(accountId: string, create = false): Promise<string> {
    const root = options.rootDir();
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    // The host supplies the trusted root; an OS alias such as /var on macOS
    // is valid. Account directories beneath it must not redirect elsewhere.
    const dir = join(await realpath(root), hash(accountId));
    if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await realpath(dir)) !== dir)
      throw new Error('Shared creation journal directory changed');
    return dir;
  }
  async function read(
    accountId: string,
    creationKey: string,
  ): Promise<SharedMultiRepoCreationJournal | null> {
    try {
      const dir = await directory(accountId);
      const path = join(dir, `${hash(creationKey)}.json`);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 131072)
        throw new Error('Invalid shared creation journal file');
      const journal = parse(JSON.parse(await readFile(path, 'utf8')));
      if (
        journal.accountId !== accountId ||
        journal.params.request.creationKey !== creationKey
      )
        throw new Error('Shared creation journal belongs to another request');
      return journal;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  return {
    read,
    async list(accountId): Promise<SharedMultiRepoCreationJournal[]> {
      let dir: string;
      try {
        dir = await directory(accountId);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      const names = await readdir(dir).catch((error: unknown): string[] => {
        if (missing(error)) return [];
        throw error;
      });
      if (names.length > 4096)
        throw new Error(
          'Too many retained shared creation records; recovery requires inspection',
        );
      const result: SharedMultiRepoCreationJournal[] = [];
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name))
          throw new Error(
            'Unknown shared creation journal file; preserve it for recovery',
          );
        const path = join(dir, name);
        const info = await lstat(path);
        if (!info.isFile() || info.size > 131072)
          throw new Error('Invalid shared creation journal file');
        const journal = parse(JSON.parse(await readFile(path, 'utf8')));
        if (
          journal.accountId !== accountId ||
          hash(journal.params.request.creationKey) + '.json' !== name
        )
          throw new Error('Shared creation journal identity mismatch');
        result.push(journal);
      }
      return result;
    },
    write(journal): Promise<void> {
      const validated = parse(journal);
      const write = async (): Promise<void> => {
        const dir = await directory(validated.accountId, true);
        const existing = await read(
          validated.accountId,
          validated.params.request.creationKey,
        );
        if (
          existing &&
          (existing.requestDigest !== validated.requestDigest ||
            existing.deviceId !== validated.deviceId)
        )
          throw new Error(
            'Cannot replace an immutable shared creation request',
          );
        await options.writeAtomic(
          join(dir, `${hash(validated.params.request.creationKey)}.json`),
          JSON.stringify(validated),
        );
      };
      const next = writes.then(write, write);
      writes = next.catch((): void => {});
      return next;
    },
  };
}

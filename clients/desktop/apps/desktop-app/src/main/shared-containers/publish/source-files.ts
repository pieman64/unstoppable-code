import { createHash } from 'node:crypto';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
} from '@canopy/protocol/shared-containers';
import { SharedContainerPublishRefusalError } from './errors';

export interface PublishFileSource {
  sizeBytes: number;
  hash: string;
  createReadStream: () => Readable;
  dispose?: () => Promise<void>;
}

export class SharedContainerPublishInventoryChangedError extends Error {
  constructor() {
    super('Shared-container source changed during publication');
    this.name = 'SharedContainerPublishInventoryChangedError';
  }
}

function rethrowSourcePathRace(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP' ||
    code === 'ESTALE'
  ) {
    throw new SharedContainerPublishInventoryChangedError();
  }
  throw error;
}

export function assertArtifactSize(size: number): void {
  if (size > MAX_SHARED_CONTAINER_ARTIFACT_BYTES) {
    throw new SharedContainerPublishRefusalError(
      'artifact-budget',
      'A shared file exceeds the 25 MiB per-file limit. Commit it or remove it from the approved scope and try again.',
    );
  }
}

export function addToRevisionSize(total: number, size: number): number {
  const next = total + size;
  if (next > MAX_SHARED_CONTAINER_REVISION_BYTES) {
    throw new SharedContainerPublishRefusalError(
      'artifact-budget',
      'This revision exceeds the 500 MiB shared-content limit. Commit or narrow the approved scope and try again.',
    );
  }
  return next;
}

export async function openVerifiedFile(
  requestedPath: string,
  expectedCanonicalPath: string,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(
      requestedPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    rethrowSourcePathRace(error);
  }
  try {
    const [openedInfo, currentInfo, currentCanonicalPath] = await Promise.all([
      handle.stat(),
      lstat(requestedPath),
      realpath(requestedPath),
    ]);
    if (
      !openedInfo.isFile() ||
      !currentInfo.isFile() ||
      currentInfo.isSymbolicLink() ||
      currentCanonicalPath !== expectedCanonicalPath ||
      openedInfo.dev !== currentInfo.dev ||
      openedInfo.ino !== currentInfo.ino
    ) {
      throw new SharedContainerPublishInventoryChangedError();
    }
    return handle;
  } catch (error) {
    await handle.close();
    rethrowSourcePathRace(error);
  }
}

export function assertStableFile(
  before: BigIntStats,
  after: BigIntStats,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new SharedContainerPublishInventoryChangedError();
  }
}

async function hashStableFile(
  handle: FileHandle,
  before: BigIntStats,
  startOffset = 0,
): Promise<string> {
  const hash = createHash('sha256');
  const stream = handle.createReadStream({
    autoClose: false,
    start: startOffset,
  }) as AsyncIterable<unknown>;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error(
        'Shared-container file stream returned non-binary content',
      );
    }
    hash.update(chunk);
  }
  assertStableFile(before, await handle.stat({ bigint: true }));
  return `sha256:${hash.digest('hex')}`;
}

function createStableFileReadStream(
  requestedPath: string,
  canonicalPath: string,
  expected: BigIntStats,
  startOffset: number,
): Readable {
  return Readable.from(
    (async function* (): AsyncGenerator<Buffer> {
      const handle = await openVerifiedFile(requestedPath, canonicalPath);
      try {
        const before = await handle.stat({ bigint: true });
        assertStableFile(expected, before);
        const stream = handle.createReadStream({
          autoClose: false,
          start: startOffset,
        }) as AsyncIterable<unknown>;
        for await (const chunk of stream) {
          if (!Buffer.isBuffer(chunk)) {
            throw new Error(
              'Shared-container file stream returned non-binary content',
            );
          }
          yield chunk;
        }
        assertStableFile(expected, await handle.stat({ bigint: true }));
      } finally {
        await handle.close();
      }
    })(),
  );
}

export async function createStableFileSource(
  requestedPath: string,
  canonicalPath: string,
  handle: FileHandle,
  snapshot: BigIntStats,
  startOffset = 0,
): Promise<PublishFileSource> {
  const sizeBytes = Number(snapshot.size) - startOffset;
  if (sizeBytes < 0) throw new SharedContainerPublishInventoryChangedError();
  return {
    sizeBytes,
    hash: await hashStableFile(handle, snapshot, startOffset),
    createReadStream: () =>
      createStableFileReadStream(
        requestedPath,
        canonicalPath,
        snapshot,
        startOffset,
      ),
  };
}

export async function inspectPublishFile(
  requestedPath: string,
): Promise<{ canonicalPath: string; info: Stats } | null> {
  let info: Stats;
  try {
    info = await lstat(requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return null;
  return { info, canonicalPath: await realpath(requestedPath) };
}

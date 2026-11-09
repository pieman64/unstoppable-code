import { createHash } from 'node:crypto';
import { isNativeError, isUint8Array } from 'node:util/types';
import { loadMigrationFilesystem } from './supervision/owned-child';

export function isWindowsMigrationStreamError(
  error: unknown,
): error is Error & { readonly code: 'ERR_MIGRATION_FILESYSTEM_STREAMS' } {
  return (
    isNativeError(error) &&
    'code' in error &&
    error.code === 'ERR_MIGRATION_FILESYSTEM_STREAMS'
  );
}

export interface MigrationFilesystemObservation {
  readonly dev: number;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtime: bigint;
  readonly attributes: number;
  readonly security: string;
}

export interface WindowsMigrationFilesystem {
  inspect(path: string): MigrationFilesystemObservation;
  mkdir(path: string): void;
  copy(from: string, to: string): void;
  /** Preserve admitted source ACL/attributes/times on an existing file or directory. */
  finish(from: string, to: string): void;
  read(path: string): Buffer;
  /** Publish a private replacement without changing readonly destination attributes. */
  replace(from: string, to: string): void;
  /** In-process copy-flush receipt, never reconstructed from disk. */
  hasReadonlyCopyFlush(path: string): boolean;
  /** Only journaled construction/publication roots; descendants stay handle-relative. */
  removeRecordedTree(path: string, identity: string): void;
}

/** Trusted host injection only; no runtime lookup or enabled migration caller. */
export function createWindowsMigrationFilesystem(
  ownedChildPath: string,
): WindowsMigrationFilesystem {
  const native = loadMigrationFilesystem(ownedChildPath);
  const receipts = new Map<string, string>();
  function observation(value: unknown): MigrationFilesystemObservation {
    if (typeof value !== 'object' || value === null)
      throw new Error('Missing filesystem observation');
    const dev: unknown = Reflect.get(value, 'dev');
    const ino: unknown = Reflect.get(value, 'ino');
    const attributes: unknown = Reflect.get(value, 'attributes');
    const size: unknown = Reflect.get(value, 'size');
    const mtime: unknown = Reflect.get(value, 'mtime');
    const security: unknown = Reflect.get(value, 'security');
    if (
      typeof dev !== 'number' ||
      !Number.isSafeInteger(dev) ||
      typeof ino !== 'bigint' ||
      ino <= 0n ||
      typeof attributes !== 'number' ||
      !Number.isSafeInteger(attributes) ||
      typeof size !== 'bigint' ||
      size < 0n ||
      typeof mtime !== 'bigint' ||
      mtime < 0n ||
      typeof security !== 'string' ||
      !security
    )
      throw new Error('Invalid filesystem observation');
    return { dev, ino, size, mtime, attributes, security };
  }
  function receipt(value: MigrationFilesystemObservation): string {
    return `${value.size}:${value.mtime}:${value.attributes}:${createHash('sha256').update(value.security).digest('hex')}`;
  }
  return Object.freeze({
    inspect(path: string): MigrationFilesystemObservation {
      return observation(native('inspect', path));
    },
    hasReadonlyCopyFlush(path: string): boolean {
      const value = observation(native('inspect', path));
      return (
        (value.attributes & 1) !== 0 &&
        receipts.get(`${value.dev}:${value.ino}`) === receipt(value)
      );
    },
    removeRecordedTree(path: string, identity: string): void {
      native('remove', path, identity);
    },
    mkdir(path: string): void {
      native('mkdir', path);
    },
    copy(from: string, to: string): void {
      const value = native('copy', from, to);
      // Directories have no content-flush receipt; regular copies return one
      // only after metadata/readonly and FlushFileBuffers on the retained handle.
      if (value !== undefined) {
        const copied = observation(value);
        if (copied.attributes & 1)
          receipts.set(`${copied.dev}:${copied.ino}`, receipt(copied));
      }
    },
    finish(from: string, to: string): void {
      const value = native('finish', from, to);
      if (value !== undefined) {
        const finished = observation(value);
        if (finished.attributes & 1)
          receipts.set(`${finished.dev}:${finished.ino}`, receipt(finished));
      }
    },
    replace(from: string, to: string): void {
      native('replace', from, to);
    },
    read(path: string): Buffer {
      const value = native('read', path);
      if (!isUint8Array(value) || value.byteLength > 16 * 1024 * 1024)
        throw new Error('Invalid filesystem read');
      return Buffer.from(value);
    },
  });
}

export { loadMigrationRenameNoReplace } from './supervision/owned-child';

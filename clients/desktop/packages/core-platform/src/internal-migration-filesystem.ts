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
}

/** Trusted host injection only; no runtime lookup or enabled migration caller. */
export function createWindowsMigrationFilesystem(
  ownedChildPath: string,
): WindowsMigrationFilesystem {
  const native = loadMigrationFilesystem(ownedChildPath);
  return Object.freeze({
    inspect(path: string): MigrationFilesystemObservation {
      const value = native('inspect', path);
      if (typeof value !== 'object' || value === null)
        throw new Error('Missing filesystem observation');
      const dev: unknown = Reflect.get(value, 'dev');
      const ino: unknown = Reflect.get(value, 'ino');
      const attributes: unknown = Reflect.get(value, 'attributes');
      const security: unknown = Reflect.get(value, 'security');
      if (
        typeof dev !== 'number' ||
        !Number.isSafeInteger(dev) ||
        typeof ino !== 'bigint' ||
        ino <= 0n ||
        typeof attributes !== 'number' ||
        !Number.isSafeInteger(attributes) ||
        typeof security !== 'string' ||
        !security
      )
        throw new Error('Invalid filesystem observation');
      return { dev, ino, attributes, security };
    },
    mkdir(path: string): void {
      native('mkdir', path);
    },
    copy(from: string, to: string): void {
      native('copy', from, to);
    },
    finish(from: string, to: string): void {
      native('finish', from, to);
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

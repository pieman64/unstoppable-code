import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertTranscriptIdentity } from './chat-transcript-artifacts';
import type { TranscriptTarget } from '@canopy/protocol/canopy-core';

/** Target-owned layout for independently serialized transcript streams. */
export interface TranscriptStreamPaths {
  assertKey(key: string): void;
  directory(key: string): string;
  file(key: string, extension: string): string;
  locatorParent(key: string): string;
  locatorDirectory(key: string): string;
  locatorFile(key: string, messageId: string): string;
  stagedAppendFile(key: string, stagedId: string): string;
  isStagedAppend(key: string, basename: string): boolean;
  owner(key: string): string;
}

/** Byte-for-byte compatible layout for the primary chat transcript. */
export function primaryTranscriptPaths(root: string): TranscriptStreamPaths {
  const assertKey = (key: string): void => assertTranscriptIdentity(key);
  const directory = (key: string): string => {
    assertKey(key);
    return root;
  };
  const file = (key: string, extension: string): string => {
    assertKey(key);
    return join(root, `${key}.${extension}`);
  };
  const locatorParent = (key: string): string => {
    assertKey(key);
    return join(root, 'message-index');
  };
  const locatorDirectory = (key: string): string =>
    join(locatorParent(key), key);
  return {
    assertKey,
    directory,
    file,
    locatorParent,
    locatorDirectory,
    locatorFile: (key, messageId) =>
      join(
        locatorDirectory(key),
        `${createHash('sha256').update(messageId).digest('hex')}.json`,
      ),
    stagedAppendFile: (key, stagedId) => file(key, `${stagedId}.append.tmp`),
    isStagedAppend: (key, basename): boolean => {
      assertKey(key);
      return basename.startsWith(`${key}.`) && basename.endsWith('.append.tmp');
    },
    owner: (key): string => {
      assertKey(key);
      return key;
    },
  };
}

/** Digest of the complete identity tuple; opaque IDs are never path segments. */
export function delegationStreamKey(
  target: Extract<TranscriptTarget, { kind: 'delegation' }>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'delegation',
        target.chatId,
        target.delegationId,
        target.runGeneration,
      ]),
    )
    .digest('hex');
}

/** Parent-owned child stream layout, separate from primary transcript bytes. */
export function delegationTranscriptPaths(
  root: string,
  target: Extract<TranscriptTarget, { kind: 'delegation' }>,
): TranscriptStreamPaths {
  assertTranscriptIdentity(target.chatId);
  const expected = delegationStreamKey(target);
  const assertKey = (key: string): void => {
    if (key !== expected)
      throw new Error('Invalid delegation transcript stream key');
  };
  const directory = (key: string): string => {
    assertKey(key);
    return join(root, 'delegations', target.chatId, 'v2', key);
  };
  const file = (key: string, extension: string): string => {
    assertKey(key);
    return join(directory(key), `transcript.${extension}`);
  };
  const locatorParent = (key: string): string =>
    join(directory(key), 'message-index');
  const locatorDirectory = (key: string): string =>
    join(locatorParent(key), key);
  return {
    assertKey,
    directory,
    file,
    locatorParent,
    locatorDirectory,
    locatorFile: (key, messageId) =>
      join(
        locatorDirectory(key),
        `${createHash('sha256').update(messageId).digest('hex')}.json`,
      ),
    stagedAppendFile: (key, stagedId) => file(key, `${stagedId}.append.tmp`),
    isStagedAppend: (key, basename): boolean => {
      assertKey(key);
      return (
        basename.startsWith('transcript.') && basename.endsWith('.append.tmp')
      );
    },
    owner: (key): string => {
      assertKey(key);
      return target.chatId;
    },
  };
}

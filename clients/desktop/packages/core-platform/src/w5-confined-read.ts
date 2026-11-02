import { isUint8Array } from 'node:util/types';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type {
  W5ConfinedFileRead,
  W5ConfinedFileReader,
  W5ConfinedFileReaderSource,
} from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import { loadConfinedRead } from './supervision/owned-child';

/*
 * Windows W5 capture reads (CAN-5202) through the owned-child addon's
 * `readConfinedFile`: the root handle must name the resolved root, and each
 * component opens relative to its parent's handle, refusing every reparse
 * point (packages/core-platform/native/owned-child/src/confined_read_win.c).
 * Anything unexpected from the addon reads as `io`; an addon that does not
 * load leaves the capture refused, never a pathname-only fallback.
 */

type NativeRead = (
  root: string,
  components: readonly string[],
  maxBytes: number,
) => unknown;

const IO: W5ConfinedFileRead = Object.freeze({
  state: 'unreadable',
  reason: 'io',
});

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;

function parseRead(value: unknown, maxBytes: number): W5ConfinedFileRead {
  const state = field(value, 'state');
  switch (state) {
    case 'present': {
      const bytes = field(value, 'bytes');
      return isUint8Array(bytes) && bytes.byteLength <= maxBytes
        ? { state, bytes }
        : IO;
    }
    case 'absent':
    case 'too-large':
    case 'root-unavailable':
    case 'root-changed':
      return { state };
    case 'unreadable': {
      const reason = field(value, 'reason');
      return reason === 'unsafe-path' ||
        reason === 'not-file' ||
        reason === 'io'
        ? { state, reason }
        : IO;
    }
    default:
      return IO;
  }
}

/** A reader over the addon's call; its errors and malformed results read as `io`. */
export function createW5ConfinedFileReader(
  read: NativeRead,
): W5ConfinedFileReader {
  return {
    read: (root, components, maxBytes): Promise<W5ConfinedFileRead> => {
      try {
        return Promise.resolve(
          parseRead(read(root, [...components], maxBytes), maxBytes),
        );
      } catch {
        return Promise.resolve(IO);
      }
    },
  };
}

function load(
  os: PlatformOperatingSystem | null,
  nativePath: string | undefined,
): W5ConfinedFileReader | null {
  if (os !== 'win32' || nativePath === undefined) return null;
  try {
    return createW5ConfinedFileReader(loadConfinedRead(os, nativePath));
  } catch {
    return null;
  }
}

/**
 * The trusted host's Windows reader from the owned-child addon at
 * `nativePath`, loaded once on first use. Null off Windows, without a fully
 * qualified path, or when the addon does not load or lacks the call; a
 * failed load is not retried until the worker restarts.
 */
export function windowsW5ConfinedFileReader(
  os: PlatformOperatingSystem | null,
  nativePath: string | undefined,
): W5ConfinedFileReaderSource {
  let loaded: W5ConfinedFileReader | null | undefined;
  return (): W5ConfinedFileReader | null => {
    if (loaded === undefined) loaded = load(os, nativePath);
    return loaded;
  };
}

import { basename } from 'node:path';
import {
  openRegularFileForRead,
  type AuthorizedFileRoots,
} from '../../lib/authorized-file-open';
import {
  RemoteFileTooLargeError,
  type FileReadParams,
  type FileReadResult,
  type RemoteFileTarget,
} from '../remote-protocol';

export interface HostFileReadPolicy {
  /**
   * Fails unless this computer would open the file itself; returns the roots
   * the file must be inside, or null when the request names no project.
   */
  authorize: (target: RemoteFileTarget) => Promise<AuthorizedFileRoots | null>;
  maxBytes: number;
}

export type HostFileReader = (
  params: FileReadParams,
) => Promise<FileReadResult>;

/**
 * Serves `file.read`: one part of a file a controller opens in its own
 * default app. Every part is authorized and opened again, so a read never
 * outlives the checks that allowed it.
 */
export function createHostFileReader(
  policy: HostFileReadPolicy,
): HostFileReader {
  return async (params: FileReadParams): Promise<FileReadResult> => {
    const { offset, length, ...target } = params;
    const roots = await policy.authorize(target);
    const opened = await openRegularFileForRead(target.absolutePath, roots);
    try {
      const sizeBytes = opened.fileStat.size;
      if (sizeBytes > policy.maxBytes) throw new RemoteFileTooLargeError();
      const bytes = new Uint8Array(
        Math.max(0, Math.min(length, sizeBytes - offset)),
      );
      let filled = 0;
      while (filled < bytes.byteLength) {
        const { bytesRead } = await opened.fileHandle.read(
          bytes,
          filled,
          bytes.byteLength - filled,
          offset + filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return {
        fileName: basename(opened.absolutePath),
        sizeBytes,
        modifiedAtMs: opened.fileStat.mtimeMs,
        bytes: filled === bytes.byteLength ? bytes : bytes.slice(0, filled),
      };
    } finally {
      await opened.fileHandle.close();
    }
  };
}

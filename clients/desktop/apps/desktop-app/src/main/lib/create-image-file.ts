import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';
import {
  FileNameConflictError,
  FileSaveOperationalError,
  FileSaveUnsupportedError,
  FileSaveValidationError,
  MAX_IMAGE_SAVE_BASE64_LENGTH,
  MAX_IMAGE_SAVE_BYTES,
} from '@canopy/protocol/file-image-save';
import type {
  SaveFileContentRequest,
  SaveFileContentResponse,
} from '@canopy/desktop-shared/types';

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/** Validate before path resolution, allocation of decoded bytes, or file effects. */
export function decodeImageSave(request: SaveFileContentRequest): Buffer {
  if (
    request.createOnly !== true ||
    request.expectedModifiedAtMs !== undefined ||
    typeof request.content !== 'string'
  ) {
    throw new FileSaveValidationError(
      'Image saves require createOnly and cannot include an edit version.',
    );
  }
  const encoding = request.encoding ?? 'utf8';
  if (encoding !== 'utf8' && encoding !== 'base64') {
    throw new FileSaveValidationError('Invalid file encoding.');
  }
  const extension = extname(request.absolutePath).toLowerCase();
  if (
    (extension !== '.png' && extension !== '.svg') ||
    (extension === '.png' && encoding !== 'base64') ||
    (extension === '.svg' && encoding !== 'utf8')
  ) {
    throw new FileSaveUnsupportedError(
      'Only PNG/base64 and SVG/UTF-8 image saves are supported.',
    );
  }
  if (encoding === 'utf8') {
    if (
      !request.content ||
      request.content.includes('\0') ||
      Buffer.byteLength(request.content, 'utf8') > MAX_IMAGE_SAVE_BYTES
    ) {
      throw new FileSaveValidationError('Invalid or oversized SVG content.');
    }
    return Buffer.from(request.content, 'utf8');
  }
  const content = request.content;
  if (
    !content ||
    content.length > MAX_IMAGE_SAVE_BASE64_LENGTH ||
    content.length % 4 !== 0
  ) {
    throw new FileSaveValidationError('Invalid or oversized base64 content.');
  }
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  if (
    (content.length / 4) * 3 - padding > MAX_IMAGE_SAVE_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content)
  ) {
    throw new FileSaveValidationError('Invalid or oversized base64 content.');
  }
  const bytes = Buffer.from(content, 'base64');
  if (
    bytes.toString('base64') !== content ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new FileSaveValidationError('Invalid PNG content.');
  }
  return bytes;
}

/** Existing file:save-content compatibility effect; never used by text editing. */
export async function createImageFile(
  request: SaveFileContentRequest,
  bytes: Buffer,
  allowedRoots: string[],
  recordActivity: () => Promise<void>,
): Promise<SaveFileContentResponse> {
  if (
    !isAbsolute(request.absolutePath) ||
    request.absolutePath.split(/[\\/]/).includes('..')
  ) {
    throw new FileSaveValidationError('Invalid image destination.');
  }
  let parent: string;
  try {
    parent = await realpath(dirname(request.absolutePath));
  } catch (error) {
    throw new FileSaveOperationalError('Cannot access the image destination.', {
      cause: error,
    });
  }
  let root: string | undefined;
  for (const candidate of allowedRoots) {
    try {
      const resolved = await realpath(candidate);
      if (inside(parent, resolved)) {
        root = resolved;
        break;
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        throw new FileSaveOperationalError(
          'Cannot validate the image destination.',
          { cause: error },
        );
      }
    }
  }
  if (!root)
    throw new FileSaveValidationError(
      'Image destination is outside allowed worktree roots.',
    );
  const destination = join(parent, basename(request.absolutePath));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o666,
    );
  } catch (error) {
    if (hasCode(error, 'EEXIST')) throw new FileNameConflictError();
    throw new FileSaveOperationalError('Cannot create the image file.', {
      cause: error,
    });
  }
  let created: Stats | undefined;
  try {
    created = await handle.stat();
    const validated = await realpath(destination);
    if (
      !inside(validated, root) ||
      !sameFile(created, await lstat(destination))
    ) {
      throw new FileSaveValidationError(
        'Image destination changed while saving.',
      );
    }
    await recordActivity();
    await handle.writeFile(bytes);
    await handle.sync();
    const saved = await handle.stat();
    if (
      !inside(await realpath(destination), root) ||
      !sameFile(saved, await lstat(destination))
    ) {
      throw new FileSaveValidationError(
        'Image destination changed while saving.',
      );
    }
    await handle.close();
    return {
      filename: basename(destination),
      sizeBytes: saved.size,
      modifiedAtMs: saved.mtimeMs,
    };
  } catch (error) {
    try {
      await handle.close();
    } catch {
      /* Preserve the original failure. */
    }
    try {
      // A competing replacement belongs to its writer, even after our failure.
      if (created && sameFile(created, await lstat(destination)))
        await unlink(destination);
    } catch {
      /* Cleanup is best effort; never hide an unknown write outcome. */
    }
    if (error instanceof FileSaveValidationError) throw error;
    throw new FileSaveOperationalError(
      'Could not finish saving the image file.',
      { cause: error },
    );
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ensureOwnerOnlyDir, redactMemoryContent } from '../store';

function slug(value: string, maximum: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maximum)
    .replace(/-+$/g, '');
  return normalized || 'memory';
}

// The digest covers the source revision (path + original-content hash), so a
// changed source always stages under a fresh name: a ledger write that fails
// after staging can leave an orphan, but never an old entry aliasing new
// bytes.
export function stagedFilenameForSource(
  sourcePath: string,
  originalName: string,
  fileHash: string,
): string {
  const extension = extname(originalName);
  const originalStem = basename(originalName, extension);
  const pathSlug = slug(sourcePath.slice(0, -originalName.length), 72);
  const nameSlug = slug(originalStem, 48);
  const digest = createHash('sha256')
    .update(`${sourcePath}\0${fileHash}`)
    .digest('hex')
    .slice(0, 16);
  return `${pathSlug}-${nameSlug}-${digest}.md`;
}

export function prepareStagedMemoryContent(content: string): string {
  const normalizedContent = content.replace(/\r\n?/g, '\n').replace(/\0/g, '');
  return redactMemoryContent(normalizedContent);
}

/**
 * Atomically writes already-prepared imported memory content verbatim.
 * Callers own normalization and redaction via prepareStagedMemoryContent.
 */
export async function stageImportedMemory(options: {
  scopeDir: string;
  sourcePath: string;
  originalName: string;
  fileHash: string;
  content: string;
  previousStagedAs?: string;
}): Promise<string> {
  const importedDir = join(options.scopeDir, 'imported');
  await ensureOwnerOnlyDir(importedDir);
  const filename = stagedFilenameForSource(
    options.sourcePath,
    options.originalName,
    options.fileHash,
  );
  const stagedAs = `imported/${filename}`;
  const destination = join(options.scopeDir, stagedAs);
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, options.content, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, destination);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  if (
    options.previousStagedAs !== undefined &&
    options.previousStagedAs !== stagedAs
  ) {
    await unlink(join(options.scopeDir, options.previousStagedAs)).catch(
      (error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) {
          throw error;
        }
      },
    );
  }
  return stagedAs;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

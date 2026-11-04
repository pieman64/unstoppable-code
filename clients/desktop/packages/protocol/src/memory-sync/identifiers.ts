import { z } from 'zod';
import { MEMORY_SYNC_LIMITS } from './constants';
import { MEMORY_ULID_PATTERN } from './ulid';

export const MemoryUlidSchema = z.string().regex(MEMORY_ULID_PATTERN);
export const MemoryNoteIdSchema = MemoryUlidSchema;
export const MemoryCommitIdSchema = MemoryUlidSchema;

/**
 * Lower case only: replica directories are named after account and project
 * IDs, and a case-sensitive filesystem would give two spellings two replicas.
 */
export const MemoryUuidSchema = z
  .uuid()
  .refine(
    (value: string): boolean => value === value.toLowerCase(),
    'Expected a lower-case UUID',
  );
export const MemoryAccountIdSchema = MemoryUuidSchema;
export const MemoryDeviceIdSchema = MemoryUuidSchema;
export const MemoryScopeIdSchema = MemoryUuidSchema;
export const MemoryProjectIdSchema = MemoryUuidSchema;
export const MemoryOrganizationIdSchema = MemoryUuidSchema;

export const MemorySha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const MemoryTimestampSchema = z.iso.datetime();
export const MemoryRevisionSchema = z.int().min(0).max(2_147_483_647);
export const MemoryLeaseEpochSchema = z.int().min(1).max(2_147_483_647);
export const MemoryInstallationGenerationSchema = z
  .int()
  .min(0)
  .max(2_147_483_647);

export const MemoryChangeSeqSchema = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const MEMORY_INDEX_PATH = 'MEMORY.md';
const TOPIC_PREFIX = 'topics/';
const MARKDOWN_EXTENSION = '.md';
const FILE_STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;
const TRAILING_DOTS_AND_SPACES_PATTERN = /[. ]+$/;

/**
 * A file or directory name every desktop platform stores as written. Windows
 * opens a device for `CON`, `nul.md` and the rest in any case, and drops
 * trailing dots and spaces, so such a name never round-trips.
 */
export function isPortableFileName(name: string): boolean {
  return (
    name.length > 0 &&
    !TRAILING_DOTS_AND_SPACES_PATTERN.test(name) &&
    !WINDOWS_DEVICE_NAME_PATTERN.test(name)
  );
}

/** Two names with one identity are one file on macOS or Windows. */
export function portableFileNameIdentity(name: string): string {
  return name.toLowerCase().replace(TRAILING_DOTS_AND_SPACES_PATTERN, '');
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isFileStem(stem: string): boolean {
  return (
    FILE_STEM_PATTERN.test(stem) &&
    !stem.toLowerCase().endsWith(MARKDOWN_EXTENSION) &&
    isPortableFileName(stem + MARKDOWN_EXTENSION) &&
    utf8Length(stem + MARKDOWN_EXTENSION) <= MEMORY_SYNC_LIMITS.fileNameMaxBytes
  );
}

function stemOf(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix) || !path.endsWith(MARKDOWN_EXTENSION)) {
    return null;
  }
  return path.slice(prefix.length, -MARKDOWN_EXTENSION.length);
}

/**
 * `MEMORY.md` or `topics/<name>.md`. A stem ending in `.md` is refused because
 * the local store strips one `.md` when it reads a topic name, so such a file
 * would never round-trip through the replica.
 */
export function isMemoryDocumentPath(value: string): boolean {
  if (value === MEMORY_INDEX_PATH) return true;
  const stem = stemOf(value, TOPIC_PREFIX);
  return stem !== null && isFileStem(stem);
}

/** Topic identity is case-folded, as macOS and Windows resolve file names. */
export function memoryDocumentIdentity(path: string): string {
  return path === MEMORY_INDEX_PATH ? path : portableFileNameIdentity(path);
}

export const MemoryDocumentPathSchema = z
  .string()
  .refine(isMemoryDocumentPath, 'Expected MEMORY.md or topics/<name>.md');

export const MEMORY_NOTE_FOLDERS = {
  inbox: 'inbox/',
  import: 'imported/',
} as const;

export type MemoryNoteKindKey = keyof typeof MEMORY_NOTE_FOLDERS;

export function isMemoryNoteFileKey(
  value: string,
  kind: MemoryNoteKindKey,
): boolean {
  const stem = stemOf(value, MEMORY_NOTE_FOLDERS[kind]);
  return stem !== null && isFileStem(stem);
}

export const MemoryNoteFileKeySchema = z
  .string()
  .refine(
    (value: string): boolean =>
      isMemoryNoteFileKey(value, 'inbox') ||
      isMemoryNoteFileKey(value, 'import'),
    'Expected inbox/<name>.md or imported/<name>.md',
  );

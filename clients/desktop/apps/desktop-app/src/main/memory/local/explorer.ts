import { parseMemoryDocumentInWorker } from './parse-runner';
import { recordMemoryEdit, withMemoryWriteLock } from './edit-coordination';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  LocalMemoryDocument,
  LocalMemoryFileSummary,
  LocalMemoryItem,
} from '@canopy/desktop-shared/types';
import { isMemoryMarkdownFileName, redactMemoryContent } from './store';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2_000;
const TITLE_PROBE_BYTES = 4 * 1024;
function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

class ExcludedMemoryFileError extends Error {}

async function safePath(scopeDir: string, fileKey: string): Promise<string> {
  if (
    typeof fileKey !== 'string' ||
    fileKey.includes('..') ||
    !/^(?:MEMORY\.md|(?:topics|inbox)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/.test(
      fileKey,
    )
  )
    throw new ExcludedMemoryFileError('Invalid memory file.');
  const root = await realpath(scopeDir);
  const lexical = resolve(scopeDir, fileKey);
  const actual = await realpath(lexical);
  if (
    !inside(root, actual) ||
    (await lstat(lexical)).isSymbolicLink() ||
    (await realpath(
      join(scopeDir, fileKey === 'MEMORY.md' ? '.' : fileKey.split('/')[0]),
    )) !== resolve(root, fileKey === 'MEMORY.md' ? '.' : fileKey.split('/')[0])
  )
    throw new ExcludedMemoryFileError('Memory links cannot be edited.');
  return actual;
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error('This memory file is too large to open.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_FILE_BYTES)
      throw new Error('This memory file is too large to open.');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

const INBOX_TITLE_MAX_CHARS = 80;

/** Drops a leading YAML front matter block (`---` … `---`) from probe lines. */
function skipFrontMatter(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.trim() !== '');
  if (start === -1 || lines[start].trim() !== '---') return lines;
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === '---',
  );
  // An unterminated block within the probe hides nothing usable anyway.
  return end === -1 ? [] : lines.slice(end + 1);
}

function isSpaceOrTab(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

/**
 * Removes a closing `#` run the way CommonMark does: only when the run is
 * preceded by a space or tab (`Title #` → `Title`, `Title#` stays). A
 * remainder that is nothing but hashes has no title.
 */
function stripClosingHashes(text: string): string | undefined {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === text.length) return text.trim() || undefined;
  if (end === 0) return undefined;
  if (!isSpaceOrTab(text[end - 1])) return text.trim() || undefined;
  const stripped = text.slice(0, end).trim();
  return stripped === '' ? undefined : stripped;
}

/**
 * Level-1 ATX heading text, parsed without a regex: probe lines are attacker-
 * sized (up to 4 KiB of arbitrary whitespace) and this runs on the main
 * process for every listed file, so the walk must stay linear.
 */
function atxLevelOneTitle(line: string): string | undefined {
  // CommonMark allows up to three leading spaces; four is an indented code
  // block and never a heading.
  let indent = 0;
  while (indent < 4 && line[indent] === ' ') indent += 1;
  if (indent === 4) return undefined;
  const marker = line.slice(indent);
  if (marker[0] !== '#' || marker[1] === '#' || !isSpaceOrTab(marker[1]))
    return undefined;
  // Unicode whitespace is heading content, not CommonMark ATX padding.
  let start = 2;
  while (isSpaceOrTab(marker[start])) start += 1;
  let end = marker.length;
  while (end > start && isSpaceOrTab(marker[end - 1])) end -= 1;
  return stripClosingHashes(marker.slice(start, end));
}

/** Drops a `- `, `* `, `+ `, `1. ` or `1) ` list marker (space or tab). */
function stripListMarker(text: string): string {
  const first = text[0];
  if (
    (first === '-' || first === '*' || first === '+') &&
    isSpaceOrTab(text[1])
  )
    return text.slice(2).trimStart();
  let digits = 0;
  while (digits < text.length && text[digits] >= '0' && text[digits] <= '9')
    digits += 1;
  const delimiter = text[digits];
  if (
    digits > 0 &&
    (delimiter === '.' || delimiter === ')') &&
    isSpaceOrTab(text[digits + 1])
  )
    return text.slice(digits + 2).trimStart();
  return text;
}

/** Drops a one-to-six `#` heading marker followed by a space or tab. */
function stripHeadingMarker(text: string): string {
  let hashes = 0;
  while (hashes < text.length && text[hashes] === '#') hashes += 1;
  if (hashes >= 1 && hashes <= 6) {
    // A bare `##` line (marker with nothing after it) is an empty heading.
    if (hashes === text.length) return '';
    if (isSpaceOrTab(text[hashes])) return text.slice(hashes + 1).trimStart();
  }
  return text;
}

/** First body line as an inbox title: markers and heading hashes stripped. */
function inboxLineTitle(line: string): string | undefined {
  const text = stripHeadingMarker(stripListMarker(line.trim())).trim();
  if (!text) return undefined;
  const characters = Array.from(text);
  return characters.length > INBOX_TITLE_MAX_CHARS
    ? `${characters.slice(0, INBOX_TITLE_MAX_CHARS).join('').trimEnd()}…`
    : text;
}

/**
 * Title of a memory file from its decoded probe head: skips a leading front
 * matter block and returns the text of an ATX level-1 heading when it is the
 * first non-blank body line. Inbox notes rarely carry a heading, so for them
 * the first non-blank body line stands in (list marker stripped, clipped).
 */
export function titleFromProbeHead(
  probeHead: string,
  options: { inbox: boolean },
): string | undefined {
  const head = probeHead.replace(/^\uFEFF/, '');
  const firstLine = skipFrontMatter(head.split(/\r?\n/)).find(
    (line) => line.trim() !== '',
  );
  if (firstLine === undefined) return undefined;
  const heading = atxLevelOneTitle(firstLine);
  if (heading !== undefined) return heading;
  return options.inbox ? inboxLineTitle(firstLine) : undefined;
}

/** Reads at most the first 4 KiB of a memory file and titles it from them. */
async function readLeadingTitle(
  path: string,
  options: { inbox: boolean },
): Promise<string | undefined> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(TITLE_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return titleFromProbeHead(
      buffer.subarray(0, bytesRead).toString('utf8'),
      options,
    );
  } finally {
    await handle.close();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function listLocalMemoryFiles(
  scopeDir: string,
): Promise<LocalMemoryFileSummary[]> {
  const candidates = ['MEMORY.md'];
  for (const folder of ['topics', 'inbox']) {
    try {
      const entries = await readdir(join(scopeDir, folder), {
        withFileTypes: true,
      });
      candidates.push(
        ...entries
          .filter(
            (entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name),
          )
          .map((entry) => `${folder}/${entry.name}`),
      );
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  if (candidates.length > MAX_FILES)
    throw new Error('There are too many memory files to browse.');
  const files: LocalMemoryFileSummary[] = [];
  for (const fileKey of candidates.sort()) {
    try {
      const path = await safePath(scopeDir, fileKey);
      const stat = await lstat(path);
      if (!stat.isFile()) continue;
      const title = await readLeadingTitle(path, {
        inbox: fileKey.startsWith('inbox/'),
      });
      files.push({
        fileKey,
        kind:
          fileKey === 'MEMORY.md'
            ? 'index'
            : fileKey.startsWith('topics/')
              ? 'topic'
              : 'inbox',
        modifiedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        ...(title === undefined ? {} : { title }),
      });
    } catch (error) {
      if (
        !(error instanceof ExcludedMemoryFileError) &&
        !hasErrorCode(error, 'ENOENT')
      )
        throw error;
    }
  }
  return files;
}

export async function readLocalMemoryDocument(
  scopeDir: string,
  fileKey: string,
): Promise<LocalMemoryDocument> {
  return parseMemoryDocumentInWorker(
    fileKey,
    await readBounded(await safePath(scopeDir, fileKey)),
  );
}

export function mutateLocalMemoryItem(
  scopeDir: string,
  request: { fileKey: string; itemId: string; revision: string; text?: string },
): Promise<LocalMemoryDocument> {
  return withMemoryWriteLock(scopeDir, async () => {
    const path = await safePath(scopeDir, request.fileKey);
    const content = await readBounded(path);
    if (revision(content) !== request.revision)
      throw new Error(
        'Memory changed since you opened it. Refresh before saving.',
      );
    const find = (items: LocalMemoryItem[]): LocalMemoryItem | undefined => {
      for (const item of items) {
        if (item.id === request.itemId) return item;
        const child = find(item.children);
        if (child) return child;
      }
      return undefined;
    };
    const document = await parseMemoryDocumentInWorker(
      request.fileKey,
      content,
    );
    const item = find(document.items);
    if (!item)
      throw new Error(
        'This memory item no longer exists. Refresh before saving.',
      );
    const [start, end] = item.id.split(':').map(Number);
    let replacement = '';
    if (request.text !== undefined) {
      if (
        typeof request.text !== 'string' ||
        !request.text.trim() ||
        Buffer.byteLength(request.text, 'utf8') > MAX_FILE_BYTES
      )
        throw new Error('Enter a memory item smaller than 512 KiB.');
      replacement = redactMemoryContent(
        request.text.replace(/\r\n?/g, '\n').replace(/\0/g, ''),
      );
      if (content.includes('\r\n'))
        replacement = replacement.replace(/\n/g, '\r\n');
    }
    const result = content.slice(0, start) + replacement + content.slice(end);
    if (Buffer.byteLength(result, 'utf8') > MAX_FILE_BYTES)
      throw new Error('This memory file is too large to save.');
    const updatedDocument = await parseMemoryDocumentInWorker(
      request.fileKey,
      result,
    );
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(temporaryPath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, result, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      if (
        (await safePath(scopeDir, request.fileKey)) !== path ||
        revision(await readBounded(path)) !== request.revision
      )
        throw new Error(
          'Memory changed since you opened it. Refresh before saving.',
        );
      await rename(temporaryPath, path);
      recordMemoryEdit(scopeDir);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return updatedDocument;
  });
}

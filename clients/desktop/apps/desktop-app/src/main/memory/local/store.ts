import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MemorySource, SearchHit } from '@canopy/desktop-shared/types';
import {
  clipAtBoundaries,
  LOCAL_MEMORY_MORE_MARKER,
  type BoundaryClip,
} from '@canopy/memory-consolidation/boundary-truncation';
import { fitMemoryIndex } from '@canopy/memory-consolidation/memory-index';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import { normalizeMemoryText as normalizeText } from '@canopy/memory-consolidation/text';
import { normalizeTopicName } from '@canopy/memory-consolidation/topic-identity';
import { withMemoryWriteLock } from './edit-coordination';
import {
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
  isNodeError,
  writeNewMemoryFile,
} from './memory-files';
import {
  memoryNoteFileName,
  memoryNoteIdAt,
  withMemoryNoteId,
} from './note-identity';
import { LocalMemoryScopeLockLostError } from './scope-lock';
import { LocalMemoryScopeReadOnlyError } from './scope-manifest';

const DEFAULT_RECENT_MAX_NOTES = 5;
const DEFAULT_RECENT_MAX_CHARS_PER_NOTE = 1_000;
const MAX_SEARCH_HITS = 50;
const MAX_SEARCH_SNIPPET_CHARS = 400;
const MAX_READ_MEMORY_BYTES = 24 * 1024;
const READ_MEMORY_TRUNCATION_NOTICE =
  '\n\n[Memory content truncated at 24 KiB.]';
const MAX_SOURCE_FIELD_CHARS = 500;
const MAX_NOTE_TEXT_CHARS = 2_000;

function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maxBytes) return text;
  return encoded
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function normalizeSource(source: MemorySource): MemorySource {
  const normalized: MemorySource = {
    provider: normalizeText(source.provider).slice(0, MAX_SOURCE_FIELD_CHARS),
    chatId: normalizeText(source.chatId).slice(0, MAX_SOURCE_FIELD_CHARS),
  };
  const sessionId = normalizeText(source.sessionId ?? '').slice(
    0,
    MAX_SOURCE_FIELD_CHARS,
  );
  return sessionId ? { ...normalized, sessionId } : normalized;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function readNormalizedFile(path: string): Promise<string> {
  try {
    return normalizeText(await readFile(path, 'utf8'));
  } catch {
    return '';
  }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function contentLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[0] !== '---') return lines;
  const end = lines.indexOf('---', 1);
  return end >= 0 ? lines.slice(end + 1) : lines;
}

function bestMatchIndex(
  text: string,
  normalizedQuery: string,
  tokens: string[],
): number {
  const normalizedText = text.toLowerCase();
  const phraseIndex = normalizedText.indexOf(normalizedQuery);
  if (phraseIndex >= 0) return phraseIndex;

  let bestToken = '';
  let bestIndex = -1;
  for (const token of tokens) {
    const tokenIndex = normalizedText.indexOf(token);
    if (
      tokenIndex >= 0 &&
      (token.length > bestToken.length ||
        (token.length === bestToken.length &&
          (bestIndex < 0 || tokenIndex < bestIndex)))
    ) {
      bestToken = token;
      bestIndex = tokenIndex;
    }
  }
  return bestIndex;
}

function sliceWholeCodePoints(
  text: string,
  requestedStart: number,
  requestedEnd: number,
): string {
  let start = requestedStart;
  let end = requestedEnd;
  if (
    start > 0 &&
    start < text.length &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? '') &&
    /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')
  ) {
    start += 1;
  }
  if (
    end > 0 &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[end] ?? '')
  ) {
    end -= 1;
  }
  return text.slice(start, end);
}

function searchSnippetWindow(
  text: string,
  normalizedQuery: string,
  tokens: string[],
): string {
  if (text.length <= MAX_SEARCH_SNIPPET_CHARS) return text;
  const matchIndex = bestMatchIndex(text, normalizedQuery, tokens);
  if (matchIndex < 0) {
    return sliceWholeCodePoints(text, 0, MAX_SEARCH_SNIPPET_CHARS);
  }
  const halfWindow = Math.floor(MAX_SEARCH_SNIPPET_CHARS / 2);
  let start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(text.length, start + MAX_SEARCH_SNIPPET_CHARS);
  if (end === text.length) {
    start = Math.max(0, end - MAX_SEARCH_SNIPPET_CHARS);
  }
  return sliceWholeCodePoints(text, start, end);
}

function searchHitForFile(options: {
  fileKey: string;
  scope: 'user' | 'workspace';
  content: string;
  normalizedQuery: string;
  tokens: string[];
}): SearchHit | undefined {
  const lines = contentLines(options.content);
  const searchable = `${options.fileKey}\n${lines.join('\n')}`.toLowerCase();
  const matchesPhrase = searchable.includes(options.normalizedQuery);
  const matchesTokens =
    options.tokens.length > 0 &&
    options.tokens.every((token) => searchable.includes(token));
  if (!matchesPhrase && !matchesTokens) return undefined;

  let heading: string | undefined;
  let matchedHeading: string | undefined;
  let snippet = '';
  let fallbackSnippet = '';
  let fallbackHeading: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      heading = trimmed.replace(/^#{1,6}\s+/, '').trim();
    }
    if (!fallbackSnippet && trimmed) {
      fallbackSnippet = trimmed;
      fallbackHeading = heading;
    }
    const normalizedLine = trimmed.toLowerCase();
    if (
      !snippet &&
      trimmed &&
      (normalizedLine.includes(options.normalizedQuery) ||
        options.tokens.some((token) => normalizedLine.includes(token)))
    ) {
      snippet = trimmed;
      matchedHeading = heading;
    }
  }
  if (!snippet) {
    snippet = fallbackSnippet;
    matchedHeading = fallbackHeading;
  }
  const hit: SearchHit = {
    fileKey: options.fileKey,
    scope: options.scope,
    snippet: searchSnippetWindow(
      snippet,
      options.normalizedQuery,
      options.tokens,
    ),
  };
  return matchedHeading ? { ...hit, heading: matchedHeading } : hit;
}

/**
 * The scope's index within its line and byte limits, and whether those
 * limits cut it, so recall can say more is saved even when the clipped text
 * is small.
 */
export async function readMemoryIndex(scopeDir: string): Promise<BoundaryClip> {
  const content = await readNormalizedFile(join(scopeDir, 'MEMORY.md'));
  return content ? fitMemoryIndex(content) : { text: '', truncated: false };
}

function isAllowedMemoryFileKey(fileKey: string): boolean {
  if (fileKey === 'MEMORY.md') return true;
  if (fileKey.includes('..') || fileKey.includes('\\')) return false;
  return /^(?:topics|inbox)\/[^/\\]+\.md$/.test(fileKey);
}

function isInsideDirectory(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function clipReadMemoryContent(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= MAX_READ_MEMORY_BYTES) {
    return content;
  }
  const contentBudget =
    MAX_READ_MEMORY_BYTES -
    Buffer.byteLength(READ_MEMORY_TRUNCATION_NOTICE, 'utf8');
  return `${clipUtf8(content, contentBudget)}${READ_MEMORY_TRUNCATION_NOTICE}`;
}

/**
 * Read one exact file key returned by searchMemory. Both lexical and real paths
 * must remain under the scope directory so direct calls cannot escape through
 * traversal segments or symlinks.
 */
export async function readMemoryFile(
  scopeDir: string,
  fileKey: string,
): Promise<string | undefined> {
  if (!isAllowedMemoryFileKey(fileKey)) return undefined;
  const scopePath = resolve(scopeDir);
  const filePath = resolve(scopePath, fileKey);
  if (!isInsideDirectory(scopePath, filePath)) return undefined;

  try {
    const [realScopePath, realFilePath] = await Promise.all([
      realpath(scopePath),
      realpath(filePath),
    ]);
    if (!isInsideDirectory(realScopePath, realFilePath)) return undefined;
    const content = normalizeText(await readFile(realFilePath, 'utf8'));
    return clipReadMemoryContent(content);
  } catch {
    return undefined;
  }
}

const MAX_NOTE_NAME_ATTEMPTS = 100;

/** Writes a new note create-only and whole, under the next free name. */
async function writeNewInboxNote(
  scopeDir: string,
  filename: string,
  content: string,
): Promise<string> {
  const inboxDir = join(scopeDir, 'inbox');
  const stem = filename.slice(0, -'.md'.length);
  for (let attempt = 1; attempt <= MAX_NOTE_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? filename : `${stem}-${attempt}.md`;
    try {
      await writeNewMemoryFile(scopeDir, join(inboxDir, name), content);
      return `inbox/${name}`;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  }
  return '';
}

/**
 * Saves a note into the scope's inbox under a new ID and returns its file
 * key, or '' when it could not be written. A scope a newer build made
 * read-only rejects with `LocalMemoryScopeReadOnlyError`, and a scope lock
 * another process took over before the note was written with
 * `LocalMemoryScopeLockLostError`.
 */
export async function appendInboxNote(
  scopeDir: string,
  note: { text: string; source: MemorySource },
): Promise<string> {
  // Normalize BEFORE redacting: normalization strips NUL and other control
  // bytes, so redacting first would let an obfuscated key like
  // `api\0_key=...` slip past the redaction regexes and be reconstituted
  // into a well-formed secret assignment afterwards. Both the persisted
  // body and the filename slug derive from this single normalized-then-
  // redacted value.
  const redactedText = redactMemoryContent(normalizeText(note.text)).slice(
    0,
    MAX_NOTE_TEXT_CHARS,
  );
  if (!redactedText) return '';
  const redactedSource = normalizeSource({
    provider: redactMemoryContent(normalizeText(note.source.provider)),
    chatId: redactMemoryContent(normalizeText(note.source.chatId)),
    ...(note.source.sessionId !== undefined
      ? { sessionId: redactMemoryContent(normalizeText(note.source.sessionId)) }
      : {}),
  });
  const createdMs = Date.now();
  const noteId = memoryNoteIdAt(createdMs);
  const created = new Date(createdMs).toISOString();
  const sourceLines = [
    'source:',
    `  provider: ${yamlString(redactedSource.provider)}`,
    `  chatId: ${yamlString(redactedSource.chatId)}`,
    ...(redactedSource.sessionId
      ? [`  sessionId: ${yamlString(redactedSource.sessionId)}`]
      : []),
  ];
  // The ID goes in after redaction, which must never rewrite it.
  const fileContent = withMemoryNoteId(
    redactMemoryContent(
      [
        '---',
        ...sourceLines,
        `created: ${yamlString(created)}`,
        `modified: ${yamlString(created)}`,
        'type: inbox',
        '---',
        '',
        redactedText,
        '',
      ].join('\n'),
    ),
    noteId,
  );
  try {
    return await withMemoryWriteLock(scopeDir, async () => {
      await ensureOwnerOnlyMemoryDir(scopeDir, join(scopeDir, 'inbox'));
      return writeNewInboxNote(
        scopeDir,
        memoryNoteFileName(createdMs, redactedText, noteId),
        fileContent,
      );
    });
  } catch (error) {
    if (
      error instanceof LocalMemoryScopeReadOnlyError ||
      error instanceof LocalMemoryScopeLockLostError
    ) {
      throw error;
    }
    return '';
  }
}

export interface RecentInboxNote {
  fileKey: string;
  text: string;
}

/**
 * The newest inbox note bodies, each fitted to `maxCharsPerNote` at line or
 * sentence boundaries with a pointer to the full note when shortened.
 */
export async function readRecentInboxNotes(
  scopeDir: string,
  opts?: { maxNotes?: number; maxCharsPerNote?: number },
): Promise<string[]> {
  return (await readRecentInboxNoteEntries(scopeDir, opts)).map(
    (note) => note.text,
  );
}

/** {@link readRecentInboxNotes} with each note's file key. */
export async function readRecentInboxNoteEntries(
  scopeDir: string,
  opts?: { maxNotes?: number; maxCharsPerNote?: number },
): Promise<RecentInboxNote[]> {
  const maxNotes = clampInteger(opts?.maxNotes, DEFAULT_RECENT_MAX_NOTES, 100);
  const maxCharsPerNote = clampInteger(
    opts?.maxCharsPerNote,
    DEFAULT_RECENT_MAX_CHARS_PER_NOTE,
    100_000,
  );
  if (maxNotes === 0 || maxCharsPerNote === 0) return [];
  const inboxDir = join(scopeDir, 'inbox');
  // Filename timestamps only have second precision, so lexical order can
  // drop or misorder notes created within the same second; sort by mtime.
  const stamped = await Promise.all(
    (await listMarkdownFiles(inboxDir)).map(async (filename) => {
      try {
        const stats = await stat(join(inboxDir, filename));
        return { filename, modifiedMs: stats.mtimeMs };
      } catch {
        return { filename, modifiedMs: 0 };
      }
    }),
  );
  const filenames = stamped
    .sort(
      (left, right) =>
        right.modifiedMs - left.modifiedMs ||
        right.filename.localeCompare(left.filename),
    )
    .slice(0, maxNotes)
    .map((entry) => entry.filename);
  const notes: RecentInboxNote[] = [];
  for (const filename of filenames) {
    const content = await readNormalizedFile(join(inboxDir, filename));
    if (!content) continue;
    const body = contentLines(content).join('\n').trim();
    if (!body) continue;
    const clipped = clipAtBoundaries(
      body,
      { maxChars: maxCharsPerNote },
      { marker: LOCAL_MEMORY_MORE_MARKER, sentences: true },
    ).text;
    if (clipped) notes.push({ fileKey: `inbox/${filename}`, text: clipped });
  }
  return notes;
}

export async function searchMemory(
  scopeDirs: { scope: 'user' | 'workspace'; dir: string }[],
  query: string,
): Promise<SearchHit[]> {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) return [];
  const tokens = Array.from(
    new Set(normalizedQuery.match(/[a-z0-9_-]+/g) ?? []),
  ).filter((token) => token.length > 1);
  const hits: SearchHit[] = [];
  for (const scopeDir of scopeDirs) {
    const index = (await readMemoryIndex(scopeDir.dir)).text;
    const candidates: { fileKey: string; content: string }[] = index
      ? [{ fileKey: 'MEMORY.md', content: index }]
      : [];
    for (const folder of ['topics', 'inbox']) {
      const filenames = await listMarkdownFiles(join(scopeDir.dir, folder));
      for (const filename of filenames) {
        const content = await readNormalizedFile(
          join(scopeDir.dir, folder, filename),
        );
        if (content)
          candidates.push({ fileKey: `${folder}/${filename}`, content });
      }
    }
    for (const candidate of candidates) {
      const hit = searchHitForFile({
        fileKey: candidate.fileKey,
        scope: scopeDir.scope,
        content: candidate.content,
        normalizedQuery,
        tokens,
      });
      if (hit) hits.push(hit);
      if (hits.length >= MAX_SEARCH_HITS) return hits;
    }
  }
  return hits;
}

export async function listTopics(scopeDir: string): Promise<string[]> {
  // Only list names that are ALREADY in normalized form, so every listed
  // name round-trips through readTopic to the same file (a stem like
  // "release.md" from "release.md.md" normalizes to a different file and
  // must not be listed).
  return (await listMarkdownFiles(join(scopeDir, 'topics')))
    .map((filename) => filename.slice(0, -3))
    .filter((name) => normalizeTopicName(name) === name);
}

export async function readTopic(
  scopeDir: string,
  topic: string,
): Promise<string | undefined> {
  const normalizedTopic = normalizeTopicName(topic);
  if (!normalizedTopic) return undefined;
  const content = await readNormalizedFile(
    join(scopeDir, 'topics', `${normalizedTopic}.md`),
  );
  return content || undefined;
}

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  redactSecrets as redactSharedSecrets,
  SECRET_ASSIGNMENT_KEYS_SOURCE,
} from '@canopy/desktop-shared/lib/redaction';
import type { MemorySource, SearchHit } from '@canopy/desktop-shared/types';
import {
  clipAtBoundaries,
  LOCAL_MEMORY_MORE_MARKER,
  type BoundaryClip,
} from './boundary-truncation';
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

const MEMORY_INDEX_MAX_LINES = 200;
const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
const DEFAULT_RECENT_MAX_NOTES = 5;
const DEFAULT_RECENT_MAX_CHARS_PER_NOTE = 1_000;
const MAX_SEARCH_HITS = 50;
const MAX_SEARCH_SNIPPET_CHARS = 400;
const MAX_READ_MEMORY_BYTES = 24 * 1024;
const READ_MEMORY_TRUNCATION_NOTICE =
  '\n\n[Memory content truncated at 24 KiB.]';
const MAX_SOURCE_FIELD_CHARS = 500;
const MAX_NOTE_TEXT_CHARS = 2_000;

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
}

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

// Built from the shared redactor's complete assignment-key vocabulary so the
// two passes can never drift apart again: any key the shared `key: value` /
// `key=value` rules treat as secret-bearing is also rest-of-line-redacted
// here, with optional `[a-z0-9]+[_-]` prefixes and the bare `apikey` spelling
// on top.
const MEMORY_SECRET_ASSIGNMENT_RULE = new RegExp(
  `\\b((?:[a-z0-9]+[_-])*(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})|apikey)(["']?[^\\S\\n]*[=:]+[^\\S\\n]*)([^\\n]+)`,
  'gi',
);

/**
 * Memory-specific redaction: the shared telemetry scrubber as a base pass
 * plus the store's additional credential patterns (connection strings, token
 * prefixes, high-entropy blobs, assignment rest-of-line). Exported so
 * consolidation output is scrubbed with the SAME rules as note content
 * before it is persisted at rest.
 */
export function redactMemoryContent(text: string): string {
  return redactSecrets(text);
}

function redactSecrets(text: string): string {
  // Base pass: the shared scrubber (`@canopy/desktop-shared/lib/redaction`)
  // owns the common secret/PII vocabulary — PEM private-key blocks, JWTs,
  // GitHub classic and fine-grained tokens, AWS access keys, `sk-` keys,
  // Authorization/Cookie/API-key headers, Bearer tokens, `key: value` /
  // `key=value` secret pairs, email addresses, IPv4 addresses, and user
  // home-directory paths.
  let result = redactSharedSecrets(text);
  // Memory-specific additions the shared corpus does not cover follow.
  // Credential-bearing connection strings: known database/broker schemes, and
  // any scheme carrying user:password@ credentials.
  result = result.replace(
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']+/gi,
    '<CONNECTION_STRING>',
  );
  result = result.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s:/@"']+@[^\s"']+/gi,
    '<CONNECTION_STRING>',
  );
  // Token prefixes the shared module lacks, anchored to their real key
  // shapes (separator or distinctive prefix) so ordinary words that merely
  // start with `sk`/`pk` can never match.
  result = result.replace(
    /\b(?:(?:sk|pk|rk|csk)[-_][A-Za-z0-9_-]{10,}|xox[bapr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9_.-]{20,}|AKIA[A-Z0-9]{16}|gh[po]_[A-Za-z0-9]{20,})\b/g,
    '<API_KEY>',
  );
  // High-entropy 40-char base64ish blobs (classic AWS secret-key shape).
  result = result.replace(
    /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
    '<SECRET>',
  );
  // Prefixed assignment keys (e.g. OPENAI_CUSTOM_TOKEN=...) that the shared
  // module's word-boundary key list cannot reach. The key vocabulary is the
  // shared redactor's own SECRET_ASSIGNMENT_KEYS_SOURCE (never a
  // hand-maintained subset), extended with optional prefixes and the bare
  // `apikey` spelling. A real assignment separator (= or :) is required so
  // ordinary prose like "password reminder123" is never rewritten; whitespace
  // is tolerated on both sides of the separator. Once a secret-key assignment
  // is present, the REST OF THE LINE is redacted: no value parsing (quotes,
  // spaces, length) is attempted, so no shape of credential can partially
  // survive. Deliberately conservative — trailing same-line prose after an
  // explicit secret assignment is sacrificed rather than risking a leaked
  // fragment.
  result = result.replace(
    MEMORY_SECRET_ASSIGNMENT_RULE,
    (match, key: string, separator: string, value: string): string => {
      // Leave values the shared pass already fully replaced untouched.
      if (/^["']?<[A-Za-z_-]+>["']?$/.test(value.trim())) return match;
      return `${key}${separator}<TOKEN>`;
    },
  );
  return result;
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

/**
 * Normalize a topic name to the stem the store reads and lists. Exported so
 * consolidation output validation can enforce the same round-trip contract:
 * only filenames whose stem satisfies `normalizeTopicName(stem) === stem`
 * are reachable through {@link listTopics} / {@link readTopic}.
 */
export function normalizeTopicName(topic: string): string | undefined {
  const normalized = normalizeText(topic);
  if (normalized.includes('/') || normalized.includes('\\')) return undefined;
  const name = basename(normalized).replace(/\.md$/i, '');
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    return undefined;
  }
  return name;
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

function fitMemoryIndex(content: string): BoundaryClip {
  return clipAtBoundaries(content, {
    maxLines: MEMORY_INDEX_MAX_LINES,
    maxBytes: MEMORY_INDEX_MAX_BYTES,
  });
}

/** Fits an index to its line and byte limits, cutting only at boundaries. */
export function clipMemoryIndex(content: string): string {
  return fitMemoryIndex(content).text;
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
  const redactedText = redactSecrets(normalizeText(note.text)).slice(
    0,
    MAX_NOTE_TEXT_CHARS,
  );
  if (!redactedText) return '';
  const redactedSource = normalizeSource({
    provider: redactSecrets(normalizeText(note.source.provider)),
    chatId: redactSecrets(normalizeText(note.source.chatId)),
    ...(note.source.sessionId !== undefined
      ? { sessionId: redactSecrets(normalizeText(note.source.sessionId)) }
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
    redactSecrets(
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

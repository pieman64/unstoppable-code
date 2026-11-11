import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import {
  matchLeadingLineSuffix,
  type FileLinkLineLocation,
} from '@canopy/ui-shared/lib/file-link-line-suffix';
import { formatFileReferencePath } from './file-reference-paths';

export interface FilePathMentionTarget {
  absolutePath: string;
  displayPath: string;
  filename: string;
}

export interface FilePathMentionIndex {
  /**
   * One entry per file, keyed by its display path with `/` separators.
   * Lookup maps `./`, absolute and Windows backslash spellings onto these keys, so a
   * large repository does not pay for every spelling up front.
   */
  aliases: Map<string, FilePathMentionTarget>;
  /** Backslashes are separators only for a Windows absolute cwd. */
  windowsPaths?: boolean;
  /**
   * The cwd as the files' absolute paths spell it, with `/` separators and a
   * trailing `/`. An absolute mention drops it before lookup.
   */
  absolutePrefixes?: readonly string[];
  /** Literal delimiter names, longest first, keyed by their undecorated prefix. */
  delimiterAliasesByPrefix?: Map<string, string[]>;
  /**
   * Lengths of exact, path-marker-free aliases grouped by their first
   * character. This is normally a tiny set (for example `Dockerfile`) and
   * lets the scanner retain bare top-level filenames without emitting every
   * prose word as a lookup candidate.
   */
  bareAliasLengthsByFirstCode: Map<number, Set<number>>;
}

export type FilePathMentionPiece =
  | { type: 'text'; text: string }
  | {
      type: 'file';
      text: string;
      target: FilePathMentionTarget;
      location?: FileLinkLineLocation;
    };

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', '!', '?', ')', ']', '}']);
const UNDEFINED_CWD_CACHE_KEY = '\u0000';
const filePathMentionIndexCache = new WeakMap<
  readonly RepoFileIndex[],
  Map<string, FilePathMentionIndex | null>
>();

function toSlashes(value: string, windowsPaths: boolean | undefined): string {
  return windowsPaths && value.includes('\\')
    ? value.split('\\').join('/')
    : value;
}

export function buildFilePathMentionIndex(
  repos: readonly RepoFileIndex[],
  cwd: string | undefined,
): FilePathMentionIndex | null {
  if (!cwd || repos.length === 0) return null;

  const windowsPaths =
    /^[A-Za-z]:[\\/]/.test(cwd) || /^(?:\\\\|\/\/)/.test(cwd);
  const aliases = new Map<string, FilePathMentionTarget>();
  const absolutePrefixes = new Set<string>();
  for (const repo of repos) {
    for (const file of repo.files) {
      const { absolutePath } = file;
      const formatted = formatFileReferencePath(absolutePath, cwd);
      if (formatted === absolutePath) continue;

      const prefixLength = absolutePath.length - formatted.length;
      const isTail = prefixLength > 0 && absolutePath.endsWith(formatted);
      if (isTail) {
        absolutePrefixes.add(
          toSlashes(absolutePath.slice(0, prefixLength), windowsPaths),
        );
      }
      const target: FilePathMentionTarget = {
        absolutePath,
        // A slice of the indexed path shares its characters.
        displayPath: isTail ? absolutePath.slice(prefixLength) : formatted,
        filename: file.filename,
      };
      const alias = toSlashes(target.displayPath.trim(), windowsPaths);
      if (alias && !aliases.has(alias)) aliases.set(alias, target);
    }
  }

  if (aliases.size === 0) return null;

  const bareAliasLengthsByFirstCode = new Map<number, Set<number>>();
  aliases.forEach((_target, alias) => {
    if (alias.includes('.') || alias.includes('/') || alias.includes('\\')) {
      return;
    }
    const firstCode = alias.charCodeAt(0);
    let lengths = bareAliasLengthsByFirstCode.get(firstCode);
    if (!lengths) {
      lengths = new Set();
      bareAliasLengthsByFirstCode.set(firstCode, lengths);
    }
    lengths.add(alias.length);
  });

  const delimiterAliasesByPrefix = new Map<string, string[]>();
  aliases.forEach((_target, alias) => {
    const delimiter = firstLocationDelimiter(alias);
    if (delimiter < 1) return;
    const prefix = alias.slice(0, delimiter);
    const names: string[] = delimiterAliasesByPrefix.get(prefix) ?? [];
    names.push(alias);
    delimiterAliasesByPrefix.set(prefix, names);
  });
  delimiterAliasesByPrefix.forEach((names) => {
    names.sort((left, right) => right.length - left.length);
  });
  return {
    aliases,
    windowsPaths,
    absolutePrefixes: Array.from(absolutePrefixes),
    bareAliasLengthsByFirstCode,
    delimiterAliasesByPrefix,
  };
}

/** How many leading characters (`./` or the cwd) a candidate drops before lookup. */
function aliasPrefixLength(
  candidate: string,
  index: FilePathMentionIndex,
): number {
  if (
    candidate.startsWith('./') ||
    (index.windowsPaths && candidate.startsWith('.\\'))
  )
    return 2;
  for (const prefix of index.absolutePrefixes ?? []) {
    if (
      candidate.length > prefix.length &&
      toSlashes(candidate.slice(0, prefix.length), index.windowsPaths) ===
        prefix
    ) {
      return prefix.length;
    }
  }
  return 0;
}

export function getFilePathMentionIndex(
  repos: readonly RepoFileIndex[],
  cwd: string | undefined,
): FilePathMentionIndex | null {
  let indexesByCwd = filePathMentionIndexCache.get(repos);
  if (!indexesByCwd) {
    indexesByCwd = new Map();
    filePathMentionIndexCache.set(repos, indexesByCwd);
  }

  const cwdKey = cwd === undefined ? UNDEFINED_CWD_CACHE_KEY : cwd;
  if (indexesByCwd.has(cwdKey)) return indexesByCwd.get(cwdKey) ?? null;

  const index = buildFilePathMentionIndex(repos, cwd);
  indexesByCwd.set(cwdKey, index);
  return index;
}

function firstLocationDelimiter(candidate: string): number {
  const driveOffset = /^[a-zA-Z]:[\\/]/.test(candidate) ? 2 : 0;
  const relativeDelimiter = candidate.slice(driveOffset).search(/[:#]/);
  return relativeDelimiter < 0 ? -1 : relativeDelimiter + driveOffset;
}

function lookupTarget(
  rawCandidate: string,
  index: FilePathMentionIndex,
): { text: string; target: FilePathMentionTarget } | null {
  let candidate = rawCandidate;
  while (candidate.length > 0) {
    const target = index.aliases.get(candidate);
    if (target) return { text: candidate, target };
    const last = candidate[candidate.length - 1];
    if (!TRAILING_PUNCTUATION.has(last)) break;
    candidate = candidate.slice(0, -1);
  }
  return null;
}

const splitCache = new WeakMap<
  FilePathMentionIndex,
  Map<string, FilePathMentionPiece[]>
>();
const SPLIT_CACHE_MAX_ENTRIES = 4096;

function isCandidateCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 35 || // # (indexed literal filename or location)
    code === 58 || // : (indexed literal filename or location)
    code === 43 || // +
    code === 45 || // -
    code === 46 || // .
    code === 47 || // /
    code === 64 || // @
    code === 92 || // \
    code === 95 || // _
    code === 126 // ~
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Walk path-like tokens linearly instead of running one large backtracking
 * regular expression over every historical text block. Alias lookup remains
 * the source of truth, so prose, URLs, and path-looking text that is not in the
 * current file inventory stays untouched.
 */
function findNextCandidate(
  text: string,
  fromIndex: number,
  index: FilePathMentionIndex,
): { start: number; end: number } | null {
  let cursor = fromIndex;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    const isWindowsDrive =
      isAsciiLetter(code) &&
      text.charCodeAt(cursor + 1) === 58 &&
      (text.charCodeAt(cursor + 2) === 47 ||
        text.charCodeAt(cursor + 2) === 92);
    if (!isCandidateCharacter(code) && !isWindowsDrive) {
      cursor += 1;
      continue;
    }

    const start = cursor;
    let hasPathMarker =
      code === 46 || code === 47 || code === 92 || code === 35 || code === 58;
    cursor += isWindowsDrive ? 3 : 1;
    while (
      cursor < text.length &&
      isCandidateCharacter(text.charCodeAt(cursor))
    ) {
      const candidateCode = text.charCodeAt(cursor);
      if (
        candidateCode === 46 ||
        candidateCode === 47 ||
        candidateCode === 92 ||
        candidateCode === 35 ||
        candidateCode === 58
      ) {
        hasPathMarker = true;
      }
      cursor += 1;
    }

    const candidateLength = cursor - start;
    const isKnownBareAlias =
      index.bareAliasLengthsByFirstCode
        .get(text.charCodeAt(start))
        ?.has(candidateLength) === true &&
      index.aliases.has(text.slice(start, cursor));
    if (hasPathMarker || isWindowsDrive || isKnownBareAlias) {
      return { start, end: cursor };
    }
  }
  return null;
}

export function splitTextByFilePathMentions(
  text: string,
  index: FilePathMentionIndex | null | undefined,
): FilePathMentionPiece[] {
  if (!index || index.aliases.size === 0 || text.length === 0) {
    return [{ type: 'text', text }];
  }

  let cache = splitCache.get(index);
  if (cache) {
    const cached = cache.get(text);
    if (cached) return cached;
  } else {
    cache = new Map();
    splitCache.set(index, cache);
  }

  const pieces: FilePathMentionPiece[] = [];
  let lastIndex = 0;
  let searchIndex = 0;
  let candidateRange: { start: number; end: number } | null;
  while (
    (candidateRange = findNextCandidate(text, searchIndex, index)) !== null
  ) {
    const spelled = text.slice(candidateRange.start, candidateRange.end);
    // Windows separator normalization keeps offsets; POSIX backslashes
    // remain literal inventory characters.
    const skipped = aliasPrefixLength(spelled, index);
    const candidate = toSlashes(
      skipped > 0 ? spelled.slice(skipped) : spelled,
      index.windowsPaths,
    );
    // Exact inventory names win over suffix syntax, including literal : and #.
    const delimiter = firstLocationDelimiter(candidate);
    const prefix = delimiter > 0 ? candidate.slice(0, delimiter) : candidate;
    const literalAlias = index.delimiterAliasesByPrefix
      ?.get(prefix)
      ?.find(
        (alias) =>
          candidate.startsWith(alias) &&
          /[:#]/.test(candidate.charAt(alias.length)),
      );
    const resolved =
      lookupTarget(candidate, index) ??
      (literalAlias ? lookupTarget(literalAlias, index) : null) ??
      (delimiter > 0 ? lookupTarget(prefix, index) : null);
    searchIndex = candidateRange.end;
    if (!resolved) continue;

    if (candidateRange.start > lastIndex) {
      pieces.push({
        type: 'text',
        text: text.slice(lastIndex, candidateRange.start),
      });
    }
    const pathEnd = candidateRange.start + skipped + resolved.text.length;
    // Bound the slice to this token plus boundary lookahead. Never copy or
    // parse the entire remaining transcript for each resolved mention.
    const suffix = matchLeadingLineSuffix(
      text.slice(pathEnd, candidateRange.end + 2),
    );
    const end = pathEnd + (suffix?.length ?? 0);
    pieces.push({
      type: 'file',
      text: text.slice(candidateRange.start, end),
      target: resolved.target,
      ...(suffix ? { location: suffix.location } : {}),
    });
    lastIndex = end;
    searchIndex = lastIndex;
  }

  if (lastIndex < text.length) {
    pieces.push({ type: 'text', text: text.slice(lastIndex) });
  }

  const result: FilePathMentionPiece[] =
    pieces.length > 0 ? pieces : [{ type: 'text', text }];
  if (cache.size >= SPLIT_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(text, result);
  return result;
}

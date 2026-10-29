import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import {
  BUILTIN_INDEX_GLOBS,
  BUILTIN_INDEX_GLOB_IDS,
  createDefaultFileIndexingPreferences,
  type FileIndexingCustomGlob,
  type FileIndexingPreferences,
} from '@canopy/protocol/file-indexing';
import { hasGitPathSegment } from './directory-reader';

export interface FileIndexingMatchPolicy {
  readonly caseSensitive: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFileIndexingCustomGlob(
  value: unknown,
): FileIndexingCustomGlob | null {
  if (!isRecord(value)) {
    return null;
  }
  const pattern =
    typeof value.pattern === 'string' ? value.pattern.trim() : null;
  if (!pattern) {
    return null;
  }
  const id =
    typeof value.id === 'string' && value.id.trim()
      ? value.id.trim()
      : `custom-${createHash('sha256').update(pattern).digest('hex').slice(0, 12)}`;
  return {
    id,
    pattern,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
  };
}

export function normalizeFileIndexingPreferences(
  value: unknown,
): FileIndexingPreferences {
  if (!isRecord(value)) {
    return createDefaultFileIndexingPreferences();
  }

  const rawDisabled = Array.isArray(value.disabledBuiltinGlobIds)
    ? value.disabledBuiltinGlobIds
    : [];
  const seenDisabled = new Set<string>();
  const disabledBuiltinGlobIds: string[] = [];
  for (const entry of rawDisabled) {
    if (
      typeof entry === 'string' &&
      BUILTIN_INDEX_GLOB_IDS.has(entry) &&
      !seenDisabled.has(entry)
    ) {
      seenDisabled.add(entry);
      disabledBuiltinGlobIds.push(entry);
    }
  }

  const rawCustom = Array.isArray(value.customGlobs) ? value.customGlobs : [];
  const seenCustom = new Set<string>();
  const customGlobs: FileIndexingCustomGlob[] = [];
  for (const entry of rawCustom) {
    const normalized = normalizeFileIndexingCustomGlob(entry);
    if (normalized && !seenCustom.has(normalized.pattern)) {
      seenCustom.add(normalized.pattern);
      customGlobs.push(normalized);
    }
  }

  return { disabledBuiltinGlobIds, customGlobs };
}

export interface FileGlobMatcher {
  isIndexExcluded(relativePath: string, kind: 'file' | 'directory'): boolean;
  isTraversalDeferred?(relativePath: string): boolean;
  patterns: string[];
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function buildFileGlobMatcher(
  preferences: FileIndexingPreferences,
  policy: FileIndexingMatchPolicy,
): FileGlobMatcher {
  const disabledBuiltinIds = new Set(preferences.disabledBuiltinGlobIds);
  const builtinPatterns = BUILTIN_INDEX_GLOBS.filter(
    (glob) => !disabledBuiltinIds.has(glob.id),
  ).map((glob) => glob.pattern);
  const customPatterns = preferences.customGlobs
    .filter((glob) => glob.enabled)
    .map((glob) => glob.pattern.trim())
    .filter(Boolean);
  const patterns = [...builtinPatterns, ...customPatterns];
  const matcher = picomatch(patterns, {
    dot: true,
    nocase: !policy.caseSensitive,
  });

  return {
    patterns,
    isIndexExcluded(relativePath, kind): boolean {
      const normalized = normalizeRelativePath(relativePath);
      if (!normalized) {
        return false;
      }
      if (hasGitPathSegment(normalized)) {
        return true;
      }
      if (matcher(normalized)) {
        return true;
      }
      if (kind === 'directory') {
        return matcher(`${normalized}/`) || matcher(`${normalized}/child`);
      }
      return false;
    },
  };
}

/**
 * Explorer search walks every path the lazy tree can display. User indexing
 * preferences intentionally do not apply here because Settings promises they
 * affect Cmd+P and `@` mentions only; `.git` remains hidden everywhere.
 */
export function buildFileExplorerGlobMatcher(
  policy: FileIndexingMatchPolicy,
): FileGlobMatcher {
  const deferredMatcher = picomatch(
    BUILTIN_INDEX_GLOBS.map((glob) => glob.pattern),
    {
      dot: true,
      nocase: !policy.caseSensitive,
    },
  );
  return {
    patterns: [],
    isIndexExcluded(relativePath): boolean {
      return hasGitPathSegment(relativePath);
    },
    isTraversalDeferred(relativePath): boolean {
      const normalized = normalizeRelativePath(relativePath);
      return deferredMatcher(`${normalized}/child`);
    },
  };
}

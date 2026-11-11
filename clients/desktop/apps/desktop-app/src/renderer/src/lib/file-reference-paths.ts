import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_WORKSPACE_FILE_ROOT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type FileReference,
  type RepoFileIndex,
} from '@canopy/desktop-shared/types';
import { isPluginMentionReference } from '@canopy/desktop-shared/lib/plugin-mention';

type AbsolutePathStyle = 'posix' | 'win32';

interface ParsedAbsolutePath {
  style: AbsolutePathStyle;
  root: string;
  segments: string[];
}

function normalizePathSeparators(
  pathValue: string,
  style: AbsolutePathStyle,
): string {
  if (style === 'posix') {
    return pathValue;
  }
  return pathValue.split('/').join('\\');
}

function parsePosixAbsolutePath(pathValue: string): ParsedAbsolutePath | null {
  if (!pathValue.startsWith('/')) {
    return null;
  }
  return {
    style: 'posix',
    root: '/',
    segments: pathValue.split('/').filter(Boolean),
  };
}

function parseWindowsAbsolutePath(
  pathValue: string,
): ParsedAbsolutePath | null {
  const normalized = normalizePathSeparators(pathValue, 'win32');
  const driveLetterMatch = /^([A-Za-z]:)\\?(.*)$/.exec(normalized);
  if (driveLetterMatch) {
    const [, driveLetter, remainder] = driveLetterMatch;
    if (!normalized.startsWith(`${driveLetter}\\`)) {
      return null;
    }
    return {
      style: 'win32',
      root: `${driveLetter.toUpperCase()}\\`,
      segments: remainder.split('\\').filter(Boolean),
    };
  }

  if (!normalized.startsWith('\\\\')) {
    return null;
  }
  const uncSegments = normalized.slice(2).split('\\').filter(Boolean);
  if (uncSegments.length < 2) {
    return null;
  }
  return {
    style: 'win32',
    root: `\\\\${uncSegments[0]}\\${uncSegments[1]}\\`,
    segments: uncSegments.slice(2),
  };
}

function parseAbsolutePath(pathValue: string): ParsedAbsolutePath | null {
  return (
    parsePosixAbsolutePath(pathValue) ?? parseWindowsAbsolutePath(pathValue)
  );
}

function equalPathPart(
  left: string,
  right: string,
  style: AbsolutePathStyle,
): boolean {
  if (style === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function buildAbsolutePath(parsedPath: ParsedAbsolutePath): string {
  if (parsedPath.segments.length === 0) {
    return parsedPath.root;
  }
  const separator = parsedPath.style === 'posix' ? '/' : '\\';
  return `${parsedPath.root}${parsedPath.segments.join(separator)}`;
}

function getParentDirectory(pathValue: string): string {
  const parsedPath = parseAbsolutePath(pathValue);
  if (!parsedPath) {
    return '.';
  }
  if (parsedPath.segments.length === 0) {
    return parsedPath.root;
  }
  return buildAbsolutePath({
    ...parsedPath,
    segments: parsedPath.segments.slice(0, -1),
  });
}

/**
 * Convert a file's absolute path into a path the agent can resolve from its
 * working directory. Files inside the cwd become relative paths; files
 * outside (sibling repos, attachments, workspace-root files when scoped to a
 * child repo) keep their absolute path so they remain unambiguous.
 */
export function formatFileReferencePath(
  absolutePath: string,
  cwd: string | undefined,
): string {
  if (!cwd) {
    return absolutePath;
  }
  const absoluteFilePath = parseAbsolutePath(absolutePath);
  const absoluteCwd = parseAbsolutePath(cwd);
  if (!absoluteFilePath || !absoluteCwd) {
    return absolutePath;
  }
  if (absoluteFilePath.style !== absoluteCwd.style) {
    return absolutePath;
  }
  if (
    !equalPathPart(
      absoluteFilePath.root,
      absoluteCwd.root,
      absoluteFilePath.style,
    )
  ) {
    return absolutePath;
  }
  if (absoluteFilePath.segments.length <= absoluteCwd.segments.length) {
    return absolutePath;
  }
  const isInsideCwd = absoluteCwd.segments.every((segment, index) =>
    equalPathPart(
      segment,
      absoluteFilePath.segments[index] ?? '',
      absoluteFilePath.style,
    ),
  );
  if (!isInsideCwd) {
    return absolutePath;
  }
  const separator = absoluteFilePath.style === 'posix' ? '/' : '\\';
  return absoluteFilePath.segments
    .slice(absoluteCwd.segments.length)
    .join(separator);
}

/**
 * Resolve the working directory for the chat from the file index. The main
 * process owns the canonical resolution via `resolveWorktreeCwd`, but the
 * renderer needs the same answer to render the user message exactly as it
 * will be sent to the agent. We derive it from the file-index roots so the
 * renderer never has to round-trip the cwd through IPC.
 */
export function getCwdFromFileIndex(
  repos: RepoFileIndex[],
  selectedRepoId: string | undefined,
): string | undefined {
  if (selectedRepoId && selectedRepoId !== WORKSPACE_ROOT_REPO_ID) {
    return repos.find((repo) => repo.repoId === selectedRepoId)?.absolutePath;
  }
  const workspaceRoot = repos.find(
    (repo) => repo.rootKind === 'workspace-root',
  );
  if (workspaceRoot) return workspaceRoot.absolutePath;
  const gitRepo = repos.find((repo) => repo.rootKind === 'git-repo');
  if (gitRepo) return gitRepo.absolutePath;
  // Cowork and App Advisor file indexes list the agent cwd itself as a
  // standalone root with a recognized id. Other standalone roots represent
  // subdirectories whose parent is the meaningful working directory.
  const managedWorkspaceRoot = repos.find(
    (repo) =>
      repo.rootKind === 'standalone' &&
      (repo.repoId === COWORK_WORKSPACE_FILE_ROOT_ID ||
        repo.repoId === APP_ADVISOR_PROJECT_ID),
  );
  if (managedWorkspaceRoot) return managedWorkspaceRoot.absolutePath;
  const standaloneRoot = repos.find(
    (repo) => repo.rootKind === 'standalone' || repo.rootKind === 'attachments',
  );
  if (standaloneRoot) return getParentDirectory(standaloneRoot.absolutePath);
  return undefined;
}

export interface RewrittenFileReferences {
  text: string;
  fileReferences: FileReference[];
}

/**
 * Rewrite the user message so the same text is shown in the bubble and sent
 * to the agent. Slate serializes each `@`-mention by inlining the reference's
 * `displayPath` directly into the message text (`serializeEditorValue` in
 * `slate-utils.ts`). We walk the references in document order, replacing each
 * inline occurrence forward from the previous match so repeated references
 * map to repeated text occurrences. Each reference's `displayPath` is also
 * updated so badges, clipboard copy, and the persisted transcript stay
 * consistent with the rendered bubble.
 */
/**
 * Rewrite each reference's `absolutePath` onto `targetCwd` when it currently
 * points somewhere else, by re-rooting the reference's own root-relative path
 * (recovered from its `displayPath`) under the target cwd. `displayPath` (and
 * therefore the serialized message text, which inlines it verbatim via
 * `serializeEditorValue`) is never touched.
 *
 * Why this exists (Task F3 + review fix round 1): the Home composer's `@`
 * typeahead indexes whatever the draft's branch target resolves to at
 * pick time — a repo-shadow checkout for `new-worktree`/`branch` targets, a
 * worktree checkout, or the cowork root — and the draft's pills survive
 * later target/workspace switches (clearing them would delete user-typed
 * message content). So by send time a pill's `absolutePath` can point into
 * a root that is NOT the send target's cwd (the shadow, or a previously
 * selected worktree). Every send route that dispatches structured
 * `fileReferences` against a known target cwd runs them through here first.
 *
 * Per-reference rules:
 * - Already inside (or equal to) `targetCwd` → unchanged (picked against
 *   this target; multi-repo worktree child-repo roots all live under the
 *   workspace worktree dir, so one containment check covers them).
 * - Carries `repoName` → unchanged. `repoName` is only set when the pill
 *   was picked from a multi-root index (`includeRepoName`), where
 *   `displayPath` may or may not be repo-prefixed — the original root
 *   cannot be recovered unambiguously from the suffix alone, so the
 *   reference passes through with its (still correct) display text.
 * - Otherwise the pill came from a single-root index (repo shadow, cowork
 *   root, or a single-repo worktree), where `displayPath` IS the path
 *   relative to that root: verify the `absolutePath` actually ends with the
 *   `displayPath` segments, then re-root those segments under `targetCwd`.
 *   Absolute `displayPath`s (attachment-root pills) and any suffix mismatch
 *   pass through unchanged.
 */
export function rewriteFileReferencesForTargetCwd(
  fileReferences: FileReference[],
  targetCwd: string,
): FileReference[] {
  const parsedTarget = parseAbsolutePath(targetCwd);
  if (!parsedTarget) {
    return fileReferences;
  }
  return fileReferences.map((reference) => {
    const parsedFile = parseAbsolutePath(reference.absolutePath);
    if (!parsedFile || parsedFile.style !== parsedTarget.style) {
      return reference;
    }

    const insideTarget =
      equalPathPart(parsedFile.root, parsedTarget.root, parsedFile.style) &&
      parsedFile.segments.length >= parsedTarget.segments.length &&
      parsedTarget.segments.every((segment, index) =>
        equalPathPart(
          segment,
          parsedFile.segments[index] ?? '',
          parsedFile.style,
        ),
      );
    if (insideTarget) {
      return reference;
    }

    if (reference.repoName) {
      // Multi-root-sourced pill — original root is ambiguous (see doc).
      return reference;
    }
    if (parseAbsolutePath(reference.displayPath)) {
      // Absolute displayPath (attachment-root pills) — not root-relative.
      return reference;
    }

    const separator = parsedFile.style === 'posix' ? '/' : '\\';
    const displaySegments = normalizePathSeparators(
      reference.displayPath,
      parsedFile.style,
    )
      .split(separator)
      .filter(Boolean);
    if (
      displaySegments.length === 0 ||
      displaySegments.length > parsedFile.segments.length ||
      displaySegments.some((segment) => segment === '.' || segment === '..')
    ) {
      return reference;
    }
    const absoluteTail = parsedFile.segments.slice(-displaySegments.length);
    const suffixMatches = displaySegments.every((segment, index) =>
      equalPathPart(segment, absoluteTail[index] ?? '', parsedFile.style),
    );
    if (!suffixMatches) {
      return reference;
    }

    return {
      ...reference,
      absolutePath: buildAbsolutePath({
        ...parsedTarget,
        segments: [...parsedTarget.segments, ...displaySegments],
      }),
    };
  });
}

function isInsideRoot(
  parsedFile: ParsedAbsolutePath,
  parsedRoot: ParsedAbsolutePath,
): boolean {
  return (
    parsedFile.style === parsedRoot.style &&
    equalPathPart(parsedFile.root, parsedRoot.root, parsedFile.style) &&
    parsedFile.segments.length >= parsedRoot.segments.length &&
    parsedRoot.segments.every((segment, index) =>
      equalPathPart(
        segment,
        parsedFile.segments[index] ?? '',
        parsedFile.style,
      ),
    )
  );
}

/**
 * Re-roots references picked from one multi-root file index onto the
 * matching roots of another, keyed by `repoId` (the multi-repo working-tree
 * shape: `WORKSPACE_ROOT_REPO_ID` plus child repo ids — the Home baseline
 * shadow index deliberately mirrors the real worktree index's repo ids so
 * this mapping is exact).
 *
 * Why this exists: `rewriteFileReferencesForTargetCwd` intentionally passes
 * `repoName`-carrying pills through untouched (a repo-prefixed `displayPath`
 * can't be re-rooted unambiguously from its suffix alone). Multi-repo
 * baseline indexes ARE multi-root, so shadow-picked pills would otherwise
 * keep pointing into the shadow checkout after a send provisions the real
 * worktree. Here the source index's roots are still known, so each pill's
 * root — and therefore its root-relative tail — is recovered by containment
 * instead of display-path guessing.
 *
 * Per-reference rules: already inside some target root → unchanged; inside a
 * source root whose `repoId` also exists in the target index → re-rooted
 * under that target root; anything else (unknown root, unmatched repoId) →
 * unchanged, for the suffix-based fallback to handle.
 */
export function rewriteFileReferencesAcrossRepoRoots(
  fileReferences: FileReference[],
  sourceRepos: readonly RepoFileIndex[],
  targetRepos: readonly RepoFileIndex[],
): FileReference[] {
  if (sourceRepos.length === 0 || targetRepos.length === 0) {
    return fileReferences;
  }
  const parsedSources = sourceRepos
    .map((repo) => ({ repo, parsed: parseAbsolutePath(repo.absolutePath) }))
    .filter(
      (entry): entry is { repo: RepoFileIndex; parsed: ParsedAbsolutePath } =>
        entry.parsed !== null,
    );
  const parsedTargets = targetRepos
    .map((repo) => ({ repo, parsed: parseAbsolutePath(repo.absolutePath) }))
    .filter(
      (entry): entry is { repo: RepoFileIndex; parsed: ParsedAbsolutePath } =>
        entry.parsed !== null,
    );
  if (parsedSources.length === 0 || parsedTargets.length === 0) {
    return fileReferences;
  }

  return fileReferences.map((reference) => {
    const parsedFile = parseAbsolutePath(reference.absolutePath);
    if (!parsedFile) {
      return reference;
    }
    if (parsedTargets.some(({ parsed }) => isInsideRoot(parsedFile, parsed))) {
      return reference;
    }
    // Deepest containing source root wins so a root that nests another
    // (workspace root containing child repo checkouts) never shadows the
    // more specific child match.
    const sourceMatch = parsedSources
      .filter(({ parsed }) => isInsideRoot(parsedFile, parsed))
      .sort((a, b) => b.parsed.segments.length - a.parsed.segments.length)[0];
    if (!sourceMatch) {
      return reference;
    }
    const targetMatch = parsedTargets.find(
      ({ repo }) => repo.repoId === sourceMatch.repo.repoId,
    );
    if (!targetMatch) {
      return reference;
    }
    return {
      ...reference,
      absolutePath: buildAbsolutePath({
        ...targetMatch.parsed,
        segments: [
          ...targetMatch.parsed.segments,
          ...parsedFile.segments.slice(sourceMatch.parsed.segments.length),
        ],
      }),
    };
  });
}

export function rewriteFileReferencesForCwd(
  text: string,
  fileReferences: FileReference[],
  cwd: string | undefined,
): RewrittenFileReferences {
  if (!cwd || fileReferences.length === 0) {
    return { text, fileReferences };
  }
  let rewrittenText = text;
  let cursor = 0;
  const rewrittenReferences: FileReference[] = [];
  for (const reference of fileReferences) {
    // Plugin mentions carry a `plugin://` locator, not a path: their display
    // token is the plugin name and must never be rewritten against the cwd.
    if (isPluginMentionReference(reference)) {
      rewrittenReferences.push(reference);
      continue;
    }
    const newPath = formatFileReferencePath(reference.absolutePath, cwd);
    const idx = rewrittenText.indexOf(reference.displayPath, cursor);
    if (idx === -1) {
      rewrittenReferences.push({ ...reference, displayPath: newPath });
      continue;
    }
    if (newPath !== reference.displayPath) {
      rewrittenText =
        rewrittenText.slice(0, idx) +
        newPath +
        rewrittenText.slice(idx + reference.displayPath.length);
    }
    cursor = idx + newPath.length;
    rewrittenReferences.push({ ...reference, displayPath: newPath });
  }
  return { text: rewrittenText, fileReferences: rewrittenReferences };
}

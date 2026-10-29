import type { TranscriptTurnFile } from '@canopy/agent-transcript/transcript-storage';
import type { TurnBlock, TurnMessage } from './turn-utils';
import { CANOPY_INJECTED_TOOL_REGISTRY } from './canopy-injected-tools';
import { getCanonicalAppAdvisorToolKey } from './app-advisor-tools';

const SHOW_FILES_NAMES = new Set([
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.displayName,
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.claudeToolName,
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.codexToolName,
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.cursorToolName,
  ...CANOPY_INJECTED_TOOL_REGISTRY.show_files.legacyToolNames,
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Lexical identity only; opening always goes through the host's scoped reader. */
export function turnFilePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))
    return undefined;
  const slash = value.replace(/\\/g, '/');
  const prefix = slash.startsWith('//')
    ? '//'
    : slash.startsWith('/')
      ? '/'
      : '';
  const segments: string[] = [];
  for (const segment of slash.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (
      segment === '..' &&
      segments.length &&
      segments[segments.length - 1] !== '..' &&
      !/^[a-z]:$/i.test(segments[segments.length - 1] ?? '')
    )
      segments.pop();
    else segments.push(segment);
  }
  return segments.length ? prefix + segments.join('/') : undefined;
}

interface FileContribution extends TranscriptTurnFile {
  requestedPath?: string;
}

export function turnFileTarget(value: unknown): TranscriptTurnFile['target'] {
  if (
    record(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.projectId) &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.worktreeId)
  )
    return { projectId: value.projectId, worktreeId: value.worktreeId };
  return undefined;
}

const blockFiles = new WeakMap<TurnBlock, readonly FileContribution[]>();

function filesFromBlock(block: TurnBlock): readonly FileContribution[] {
  const cached = blockFiles.get(block);
  if (cached) return cached;
  const files: FileContribution[] = [];
  if ('subBlocks' in block) {
    for (const child of block.subBlocks)
      for (const file of filesFromBlock(child)) files.push(file);
    blockFiles.set(block, files);
    return files;
  }
  if (block.type !== 'tool_use') return files;
  const state = !block.result
    ? 'creating'
    : block.result.isError
      ? 'failed'
      : 'ready';
  const add = (
    value: unknown,
    request?: unknown,
    target?: TranscriptTurnFile['target'],
  ): void => {
    const path = turnFilePath(value);
    const requestedPath = turnFilePath(request);
    if (path)
      files.push({
        path,
        state,
        ...(requestedPath ? { requestedPath } : {}),
        ...(target ? { target } : {}),
      });
  };
  if (block.toolName === 'Write') {
    const input = parse(block.input);
    if (record(input)) add(input.file_path ?? input.path);
  } else if (block.toolName === 'file_change') {
    for (const line of block.input.split('\n')) {
      const match = /^add: (.+)$/.exec(line);
      if (match) add(match[1]);
    }
  } else if (
    block.toolName === 'apply_patch' ||
    block.toolName === 'functions.apply_patch'
  ) {
    for (const line of block.input.split('\n')) {
      const match = /^\*\*\* Add File: (.+)$/.exec(line);
      if (match) add(match[1]);
    }
  } else if (
    (SHOW_FILES_NAMES.has(block.toolName) ||
      getCanonicalAppAdvisorToolKey(block.toolName) === 'show_files') &&
    block.result &&
    !block.result.isError
  ) {
    // A presentation receipt also covers outputs produced by shell commands.
    // Only returned successful paths qualify; denied request inputs do not.
    const output = parse(block.result.output);
    const input = parse(block.input);
    const target =
      getCanonicalAppAdvisorToolKey(block.toolName) === 'show_files' &&
      record(input)
        ? turnFileTarget(input.workspace)
        : undefined;
    if (record(output) && Array.isArray(output.files)) {
      for (const file of output.files) {
        if (record(file) && file.ok === true)
          add(file.absolutePath ?? file.path, file.path, target);
      }
    }
  }
  blockFiles.set(block, files);
  return files;
}

/** No prose/path guessing, filesystem scans, or user-upload projection. */
export function collectTurnFiles(
  messages: readonly TurnMessage[],
  retained: readonly TranscriptTurnFile[] = [],
): TranscriptTurnFile[] {
  const files = new Map<string, TranscriptTurnFile>(
    retained.map((file) => [fileKey(file.path), file]),
  );
  const presentedPaths = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'user') continue;
    for (const block of message.blocks) {
      for (const file of filesFromBlock(block)) {
        if (file.requestedPath && file.requestedPath !== file.path) {
          files.delete(fileKey(file.requestedPath));
          presentedPaths.set(fileKey(file.requestedPath), file.path);
        }
        const path = presentedPaths.get(fileKey(file.path)) ?? file.path;
        const target = file.target ?? files.get(fileKey(path))?.target;
        files.set(fileKey(path), {
          path,
          state: file.state,
          ...(target ? { target } : {}),
        });
      }
    }
  }
  return Array.from(files.values());
}

function fileKey(path: string): string {
  return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
}

function sameRelativePath(
  changedPath: string,
  file: TurnFileLocation,
): boolean {
  const normalized = changedPath.replace(/\\/g, '/');
  return /^(?:[a-z]:\/|\/\/)/i.test(file.absolutePath)
    ? normalized.toLowerCase() === file.relativePath.toLowerCase()
    : normalized === file.relativePath;
}

export interface TurnFileRoot {
  repoId: string;
  absolutePath: string;
}

/** A turn file projected onto one of the target's advertised roots. */
export interface TurnFileLocation {
  /** Transcript path identity, unchanged, for opening and keys. */
  path: string;
  /** Normalized absolute path with forward slashes. */
  absolutePath: string;
  repoId: string;
  /** Root-relative path with forward slashes, the changed-file record form. */
  relativePath: string;
  /** Explicit workspace selected by an App Advisor ShowFiles call. */
  target?: TranscriptTurnFile['target'];
}

function isAbsoluteTurnPath(path: string): boolean {
  return /^(?:\/|[a-z]:\/)/i.test(path);
}

/** Root-relative remainder when the normalized path sits under the root. */
function pathUnderRoot(
  absolutePath: string,
  rootPath: string,
): string | undefined {
  if (!rootPath) return undefined;
  const insensitive = /^(?:[a-z]:\/|\/\/)/i.test(rootPath);
  const candidate = insensitive ? absolutePath.toLowerCase() : absolutePath;
  const base = insensitive ? rootPath.toLowerCase() : rootPath;
  return candidate.startsWith(`${base}/`)
    ? absolutePath.slice(rootPath.length + 1)
    : undefined;
}

/**
 * Lexical projection only: the deepest root whose path contains the file.
 * Relative paths resolve against the first root, as the host's file opener
 * does. Existence and authorization remain the host's decision.
 */
export function locateTurnFile(
  path: string,
  roots: readonly TurnFileRoot[],
): TurnFileLocation | undefined {
  const normalized = turnFilePath(path);
  const first = roots[0];
  if (!normalized || !first) return undefined;
  const absolutePath = isAbsoluteTurnPath(normalized)
    ? normalized
    : turnFilePath(`${turnFilePath(first.absolutePath) ?? ''}/${normalized}`);
  if (!absolutePath || !isAbsoluteTurnPath(absolutePath)) return undefined;
  let match: { repoId: string; relativePath: string } | undefined;
  for (const root of roots) {
    const relativePath = pathUnderRoot(
      absolutePath,
      turnFilePath(root.absolutePath) ?? '',
    );
    // The deepest root leaves the shortest remainder.
    if (
      relativePath !== undefined &&
      (!match || relativePath.length < match.relativePath.length)
    )
      match = { repoId: root.repoId, relativePath };
  }
  return match ? { path, absolutePath, ...match } : undefined;
}

/** Files the turn diff does not already list; a diff is the primary home. */
export function turnFilesOutsideDiff<T extends TurnFileLocation>(
  files: readonly T[],
  turnDiff: { files: readonly { path: string; repoId?: string }[] } | undefined,
  primaryRepoId?: string,
): T[] {
  if (!turnDiff?.files.length) return [...files];
  return files.filter(
    (file) =>
      !turnDiff.files.some(
        (changed) =>
          (changed.repoId ?? primaryRepoId) === file.repoId &&
          sameRelativePath(changed.path, file),
      ),
  );
}

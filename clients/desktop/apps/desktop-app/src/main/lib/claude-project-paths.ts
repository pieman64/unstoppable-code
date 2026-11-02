import type { Dirent } from 'node:fs';
import { access, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const CLAUDE_PROJECT_SCAN_ENTRY_LIMIT = 10_000;

export function getClaudeCodeProjectsDir(configDir?: string): string {
  const configuredDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(
    configDir?.trim() || configuredDirectory || path.join(homedir(), '.claude'),
    'projects',
  );
}

export function claudeProjectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Candidate `<Claude config>/projects/<dir>` names for a cwd, most likely first.
 *
 * Claude Code ≥2.1.x slugs the cwd's real path with underscores replaced by
 * dashes. Older versions preserved underscores, so both forms remain lookup
 * candidates for resolved and unresolved paths.
 */
export async function claudeProjectDirCandidates(
  cwd: string,
): Promise<string[]> {
  const resolved = path.resolve(cwd);
  let real = resolved;
  try {
    real = await realpath(resolved);
  } catch {
    // Removed worktrees still need to fall back to the unresolved path.
  }
  const modernSlug = (value: string): string =>
    value.replace(/[^A-Za-z0-9-]/g, '-');
  const legacySlug = (value: string): string =>
    value.replace(/[^A-Za-z0-9_-]/g, '-');
  return Array.from(
    new Set([
      modernSlug(real),
      modernSlug(resolved),
      legacySlug(real),
      legacySlug(resolved),
    ]),
  );
}

export async function resolveClaudeCodeSessionTranscriptPath(
  sdkSessionId: string,
  cwd: string,
): Promise<string | undefined> {
  const projectsDir = getClaudeCodeProjectsDir();
  const fileName = `${sdkSessionId}.jsonl`;
  return findClaudeCodeSessionTranscriptInProjectsDir(
    projectsDir,
    fileName,
    cwd,
  );
}

export interface ClaudeCodeSessionTranscriptCandidates {
  paths: string[];
  /** True when the bounded project scan could not inspect every candidate. */
  scanExhausted: boolean;
}

/**
 * Return every matching session transcript under the Claude projects root.
 * The slug candidates are checked first, followed by the same bounded scan
 * used by the compatibility resolver.
 */
export async function findClaudeCodeSessionTranscriptCandidates(
  sdkSessionId: string,
  cwd: string,
  configDir?: string,
): Promise<ClaudeCodeSessionTranscriptCandidates> {
  const projectsDir = getClaudeCodeProjectsDir(configDir);
  const fileName = `${sdkSessionId}.jsonl`;
  const paths = new Set<string>();
  for (const dirName of await claudeProjectDirCandidates(cwd)) {
    const candidatePath = path.join(projectsDir, dirName, fileName);
    try {
      await access(candidatePath);
      paths.add(candidatePath);
    } catch {
      // Continue through the remaining slug candidates and bounded scan.
    }
  }

  const stack = [projectsDir];
  let visitedEntries = 0;
  let scanExhausted = false;
  while (stack.length > 0 && visitedEntries < CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A skipped directory could contain another matching transcript.
      scanExhausted = true;
      continue;
    }
    for (const entry of entries) {
      if (visitedEntries >= CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
        scanExhausted = true;
        break;
      }
      visitedEntries += 1;
      if (entry.isFile() && entry.name === fileName) {
        paths.add(path.join(dir, entry.name));
      }
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      }
    }
  }
  if (stack.length > 0) scanExhausted = true;

  return { paths: Array.from(paths), scanExhausted };
}

export async function findClaudeCodeSessionTranscriptInProjectsDir(
  projectsDir: string,
  fileName: string,
  cwd: string,
): Promise<string | undefined> {
  for (const dirName of await claudeProjectDirCandidates(cwd)) {
    const canonicalPath = path.join(projectsDir, dirName, fileName);
    try {
      await access(canonicalPath);
      return canonicalPath;
    } catch {
      // Try the next slug candidate, then the bounded scan.
    }
  }

  const stack = [projectsDir];
  let visitedEntries = 0;
  while (stack.length > 0 && visitedEntries < CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visitedEntries += 1;
      if (entry.isFile() && entry.name === fileName) {
        return path.join(dir, entry.name);
      }
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      }
      if (visitedEntries >= CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
        break;
      }
    }
  }
  return undefined;
}

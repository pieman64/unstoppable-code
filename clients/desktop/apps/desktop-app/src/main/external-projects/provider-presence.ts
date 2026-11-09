import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  getBrandOwnedDataDirRoots,
  getCanopySecureDataDir,
} from '@canopy/desktop-shared/canopy-paths';
import { isPathInside } from '../lib/path-safety';
import { getDataDir } from '../lib/paths';
import { isRecord } from '../lib/type-guards';
import {
  claudeProjectDirSlug,
  isClaudeProjectDirUnderRoots,
  readClaudeTranscriptHeadMetadata,
} from './claude-discovery';
import {
  listCodexDayDirectoriesNewestFirst,
  readCodexRolloutHeadMetadata,
} from './codex-discovery';
import {
  createReadPool,
  listFilesNewestFirst,
  parseJsonLinesHead,
  readFileHead,
  type ReadPool,
} from './file-head';
import {
  resolveClaudeGlobalConfigPath,
  resolveClaudeProjectsDir,
  resolveCodexGlobalStatePath,
  resolveCodexSessionsDir,
} from './provider-paths';
import { DEFAULT_DISCOVERY_LIMITS } from './types';

/**
 * Cheap "does this machine hold any Claude or Codex project evidence that
 * did not come from Canopy itself?" probe (CAN-2439). It gates the onboarding
 * step, the Getting started entry, and the one-time invite, so it must stay
 * far cheaper than a scan and must not fire for Canopy's own footprint:
 * every Canopy chat writes a Claude transcript under `~/.claude/projects`
 * and a Codex rollout under `~/.codex/sessions`, so mere existence of those
 * directories proves nothing. Evidence counts only when it points outside the
 * brand data directories (Claude) or carries a foreign originator (Codex).
 */

const MAX_ROLLOUTS_INSPECTED = 25;
const ROLLOUT_HEAD_BYTES = 16 * 1024;
/** External Claude project directories whose transcripts are inspected. */
const MAX_CLAUDE_DIRS_INSPECTED = 40;
/** Newest transcripts read per directory when looking for a native session. */
const MAX_CLAUDE_TRANSCRIPTS_PER_DIR = 5;
const CLAUDE_HEAD_BYTES = 16 * 1024;

export interface ProviderPresenceOptions {
  claudeProjectsDir?: string;
  claudeGlobalConfigPath?: string;
  codexSessionsDir?: string;
  codexGlobalStatePath?: string;
  /** Canonical directories whose contents are Canopy's own footprint. */
  excludedRoots?: string[];
  /**
   * Further roots that are Canopy's, added to the defaults: the external
   * folders of attached Cowork projects, whose Claude project directories
   * would otherwise read as evidence of provider use.
   */
  extraExcludedRoots?: string[];
  ownOriginators?: readonly string[];
}

async function safeRealpath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function defaultExcludedRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const candidate of [
    getDataDir(),
    getCanopySecureDataDir(),
    ...getBrandOwnedDataDirRoots(),
  ]) {
    roots.add(await safeRealpath(candidate));
    roots.add(path.resolve(candidate));
  }
  return Array.from(roots);
}

function isOutsideRoots(candidate: string, roots: string[]): boolean {
  return !roots.some((root) => isPathInside(root, candidate));
}

async function claudeProjectsDirHasExternalEntry(
  projectsDir: string,
  roots: string[],
  pool: ReadPool,
): Promise<boolean> {
  let entries: string[];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  // The same rule the discovery adapter uses to skip its own footprint.
  const slugs = roots.map(claudeProjectDirSlug);
  const external = entries.filter(
    (name) => !isClaudeProjectDirUnderRoots(name, slugs),
  );
  // A directory outside Canopy's roots still proves nothing on its own:
  // Canopy chats in an external folder write there too. Only a transcript a
  // person started themselves (not through the SDK) counts as evidence.
  for (const name of external.slice(0, MAX_CLAUDE_DIRS_INSPECTED)) {
    if (
      await claudeProjectDirHasNativeTranscript(
        path.join(projectsDir, name),
        pool,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function claudeProjectDirHasNativeTranscript(
  directory: string,
  pool: ReadPool,
): Promise<boolean> {
  const files = await listFilesNewestFirst(
    directory,
    (entry) => entry.isFile() && entry.name.endsWith('.jsonl'),
    pool,
  );
  for (const file of files.slice(0, MAX_CLAUDE_TRANSCRIPTS_PER_DIR)) {
    try {
      const head = await readFileHead(file.path, CLAUDE_HEAD_BYTES);
      const metadata = readClaudeTranscriptHeadMetadata(
        parseJsonLinesHead(head, CLAUDE_HEAD_BYTES),
      );
      if (metadata?.native) return true;
    } catch {
      // Unreadable transcript: not evidence either way.
    }
  }
  return false;
}

async function claudeGlobalConfigHasExternalProject(
  filePath: string,
  roots: string[],
): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size > DEFAULT_DISCOVERY_LIMITS.maxGlobalConfigBytes)
      return false;
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.projects)) return false;
    return Object.keys(parsed.projects).some(
      (key) => path.isAbsolute(key) && isOutsideRoots(key, roots),
    );
  } catch {
    return false;
  }
}

async function codexGlobalStateHasProject(
  filePath: string,
  roots: string[],
): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size > DEFAULT_DISCOVERY_LIMITS.maxGlobalConfigBytes)
      return false;
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed['local-projects'])) return false;
    return Object.values(parsed['local-projects']).some(
      (project) =>
        isRecord(project) &&
        Array.isArray(project.rootPaths) &&
        project.rootPaths.some(
          (root) =>
            typeof root === 'string' &&
            path.isAbsolute(root) &&
            isOutsideRoots(root, roots),
        ),
    );
  } catch {
    return false;
  }
}

async function codexSessionsHaveForeignThread(
  sessionsDir: string,
  roots: string[],
  ownOriginators: ReadonlySet<string>,
  pool: ReadPool,
): Promise<boolean> {
  let inspected = 0;
  for (const dayDir of await listCodexDayDirectoriesNewestFirst(sessionsDir)) {
    const files = await listFilesNewestFirst(
      dayDir,
      (entry) =>
        entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'),
      pool,
    );
    for (const file of files) {
      if (inspected >= MAX_ROLLOUTS_INSPECTED) return false;
      inspected += 1;
      let head: string;
      try {
        head = await readFileHead(file.path, ROLLOUT_HEAD_BYTES);
      } catch {
        continue;
      }
      const metadata = readCodexRolloutHeadMetadata(
        parseJsonLinesHead(head, ROLLOUT_HEAD_BYTES),
      );
      if (!metadata) continue;
      if (ownOriginators.has(metadata.originator)) continue;
      if (isOutsideRoots(metadata.cwd, roots)) return true;
    }
  }
  return false;
}

export async function detectProviderStorePresence(
  options: ProviderPresenceOptions = {},
): Promise<boolean> {
  const roots = [...(options.excludedRoots ?? (await defaultExcludedRoots()))];
  for (const extra of options.extraExcludedRoots ?? []) {
    roots.push(await safeRealpath(extra), path.resolve(extra));
  }
  const ownOriginators = new Set(
    options.ownOriginators ?? [BRAND.id, 'canopy'],
  );
  // One read pool for the whole probe, the same bound a scan uses, so the
  // directory listings below can never fan out past it.
  const pool = createReadPool(DEFAULT_DISCOVERY_LIMITS.maxConcurrentReads);
  // Cheapest signals first, stopping at the first hit: the small Codex
  // desktop registry, then the Claude projects directory (a listing plus a
  // bounded number of 16 KiB transcript heads), then rollout heads, and the
  // potentially large `~/.claude.json` parse last.
  if (
    await codexGlobalStateHasProject(
      options.codexGlobalStatePath ?? resolveCodexGlobalStatePath(),
      roots,
    )
  ) {
    return true;
  }
  if (
    await claudeProjectsDirHasExternalEntry(
      options.claudeProjectsDir ?? resolveClaudeProjectsDir(),
      roots,
      pool,
    )
  ) {
    return true;
  }
  if (
    await codexSessionsHaveForeignThread(
      options.codexSessionsDir ?? resolveCodexSessionsDir(),
      roots,
      ownOriginators,
      pool,
    )
  ) {
    return true;
  }
  return claudeGlobalConfigHasExternalProject(
    options.claudeGlobalConfigPath ?? resolveClaudeGlobalConfigPath(),
    roots,
  );
}

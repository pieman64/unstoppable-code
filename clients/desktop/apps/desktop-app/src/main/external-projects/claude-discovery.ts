import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { mapWithConcurrency } from '../lib/concurrency';
import { isPathInside } from '../lib/path-safety';
import { isRecord } from '../lib/type-guards';
import { mapValues } from './file-head';
import {
  createReadPool,
  isoFromMs,
  isoFromValue,
  laterIso,
  lastMessageAt,
  listFilesNewestFirst,
  parseJsonLinesHead,
  readFileHead,
  type FileEntryWithStats,
  type ReadPool,
} from './file-head';
import {
  resolveClaudeDesktopCoworkSessionsDir,
  resolveClaudeDesktopDataDir,
  resolveClaudeGlobalConfigPath,
  resolveClaudeProjectsDir,
} from './provider-paths';
import {
  DEFAULT_DISCOVERY_LIMITS,
  type AdapterResult,
  type DiscoveredRoot,
  type DiscoveredSession,
  type DiscoveryDiagnostic,
  type DiscoveryLimits,
} from './types';

/**
 * Claude discovery adapters (CAN-2439). Read-only, bounded, and allowlisted:
 *
 * - `~/.claude.json` → only the keys of its `projects` object. The file also
 *   holds OAuth and MCP state, so nothing else is read, retained, or logged.
 * - `~/.claude/projects/<slug>/<session>.jsonl` → the first metadata records
 *   of each transcript for the exact `cwd`, session id, entrypoint, and
 *   timestamps, plus the provider's own `ai-title`/`summary` record or the
 *   first user line for a title. Prompt bodies are never retained.
 * - Claude Desktop `claude-code-sessions` and `local-agent-mode-sessions`
 *   records → session id, `cwd`/`originCwd`/`userSelectedFolders`, title, and
 *   timestamps only. A Cowork session run without a chosen folder lives in
 *   its own `outputs` scratch directory under the desktop data root; that
 *   root is reported under the session title, since the folder name
 *   (`outputs`) says nothing and repeats for every such session (CAN-3076).
 *
 * The `projects/<slug>` directory name is a lossy encoding of a path and is
 * never decoded; the recorded `cwd` inside the transcript is the source of
 * truth for where a session ran. The one thing the name is trusted for is
 * exclusion: a directory whose slug sits under one of the app's own data
 * roots can only yield roots the normalizer would drop, so its transcripts
 * are never opened. On a long-lived install those directories are most of
 * the store.
 */

const CLAUDE_TITLE_MAX_LENGTH = 120;
/** Only the first lines can become a title; never scan a whole transcript block. */
const CLAUDE_TITLE_SCAN_CHARS = 4096;

export interface ClaudeDiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  limits?: DiscoveryLimits;
  /** Override for tests; defaults to the resolved Claude config paths. */
  globalConfigPath?: string;
  projectsDir?: string;
  desktopDataDir?: string | null;
  /**
   * Directories that are the app's own footprint (its data roots). Project
   * directories whose slug falls under them are skipped before any
   * transcript is read; see {@link isClaudeProjectDirUnderRoots}.
   */
  excludedRoots?: readonly string[];
}

/** Claude Code's `projects/<slug>` name for a cwd: every other character becomes `-`. */
export function claudeProjectDirSlug(root: string): string {
  return root.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Whether a `projects/<slug>` directory name lies at or under one of the
 * given roots' slugs. A slug either names the root itself or a path beneath
 * it (`<slug>-…`); a bare prefix match would also swallow unrelated
 * siblings such as `~/.canopy2`.
 *
 * The encoding is lossy: `/`, `.`, and space all become `-`, so a sibling
 * spelled `<root>-x`, `<root>.x`, or `<root> x` is indistinguishable from a
 * path under the root and is skipped too. Every root the adapter excludes is
 * a dot-directory in the home folder or a temp root, so that needs a project
 * folder literally named after the app's data directory; the trade is
 * accepted for the speed. The presence probe applies the same rule, and also
 * to attached Cowork folders, where a sibling spelled `<folder>-x` is a
 * known false negative backstopped by its global-config check.
 */
export function isClaudeProjectDirUnderRoots(
  name: string,
  rootSlugs: readonly string[],
): boolean {
  return rootSlugs.some((slug) => name === slug || name.startsWith(`${slug}-`));
}

function isSdkEntrypoint(record: Record<string, unknown>): boolean {
  const entrypoint =
    typeof record.entrypoint === 'string' ? record.entrypoint : '';
  const promptSource =
    typeof record.promptSource === 'string' ? record.promptSource : '';
  return entrypoint.startsWith('sdk') || promptSource === 'sdk';
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string'
        ? item.text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** First non-empty line of a user prompt, without XML-ish system wrappers. */
export function summarizeTitle(text: string): string | null {
  const stripped = text
    .slice(0, CLAUDE_TITLE_SCAN_CHARS)
    .replace(/<[a-zA-Z_-]+[^>]*>[\s\S]*?<\/[a-zA-Z_-]+>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!stripped) return null;
  return stripped.length > CLAUDE_TITLE_MAX_LENGTH
    ? `${stripped.slice(0, CLAUDE_TITLE_MAX_LENGTH - 1)}…`
    : stripped;
}

interface TranscriptHeadMetadata {
  cwd: string;
  sessionId: string;
  native: boolean;
  startedAt: string | null;
  title: string | null;
}

export function readClaudeTranscriptHeadMetadata(
  records: Record<string, unknown>[],
): TranscriptHeadMetadata | null {
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let native = true;
  let startedAt: string | null = null;
  let aiTitle: string | null = null;
  let summaryTitle: string | null = null;
  let firstUserTitle: string | null = null;
  for (const record of records) {
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'ai-title' && typeof record.aiTitle === 'string') {
      aiTitle ??= summarizeTitle(record.aiTitle);
      continue;
    }
    if (type === 'summary' && typeof record.summary === 'string') {
      summaryTitle ??= summarizeTitle(record.summary);
      continue;
    }
    if (
      cwd === null &&
      typeof record.cwd === 'string' &&
      path.isAbsolute(record.cwd)
    ) {
      cwd = record.cwd;
      if (typeof record.sessionId === 'string') sessionId = record.sessionId;
      native = !isSdkEntrypoint(record);
      startedAt = isoFromValue(record.timestamp);
    }
    if (
      firstUserTitle === null &&
      type === 'user' &&
      record.isMeta !== true &&
      record.isSidechain !== true &&
      isRecord(record.message)
    ) {
      firstUserTitle = summarizeTitle(textFromContent(record.message.content));
    }
  }
  if (!cwd || !sessionId) return null;
  return {
    cwd,
    sessionId,
    native,
    startedAt,
    title: aiTitle ?? summaryTitle ?? firstUserTitle,
  };
}

async function readGlobalConfigProjectKeys(
  filePath: string,
  limits: DiscoveryLimits,
  pool: ReadPool,
  diagnostics: DiscoveryDiagnostic[],
): Promise<{ keys: string[]; detected: boolean }> {
  let raw: string;
  try {
    const stats = await pool.run(() => stat(filePath));
    if (stats.size > limits.maxGlobalConfigBytes) {
      diagnostics.push({
        source: 'claude-code',
        message: `The Claude Code settings file is larger than ${Math.round(limits.maxGlobalConfigBytes / (1024 * 1024))} MB and was skipped; projects were found from transcripts only.`,
      });
      return { keys: [], detected: true };
    }
    raw = await pool.run(() => readFile(filePath, 'utf8'));
  } catch {
    return { keys: [], detected: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    diagnostics.push({
      source: 'claude-code',
      message: 'The Claude Code settings file could not be read as JSON.',
    });
    return { keys: [], detected: true };
  }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) {
    return { keys: [], detected: true };
  }
  const keys = Object.keys(parsed.projects).filter(
    (key) => typeof key === 'string' && path.isAbsolute(key),
  );
  if (keys.length > limits.maxRegistryEntries) {
    diagnostics.push({
      source: 'claude-code',
      message: `Only the first ${limits.maxRegistryEntries} Claude Code project entries were considered.`,
    });
  }
  return { keys: keys.slice(0, limits.maxRegistryEntries), detected: true };
}

interface ProjectDirEntry {
  path: string;
  mtimeMs: number;
}

async function readClaudeSession(
  file: FileEntryWithStats,
  limits: DiscoveryLimits,
  pool: ReadPool,
): Promise<DiscoveredSession | null> {
  if (file.sizeBytes === 0) return null;
  let head: string;
  try {
    head = await pool.run(() => readFileHead(file.path, limits.headBytes));
  } catch {
    return null;
  }
  const metadata = readClaudeTranscriptHeadMetadata(
    parseJsonLinesHead(head, limits.headBytes),
  );
  if (!metadata) return null;
  const messageAt = await lastMessageAt(
    file,
    head,
    limits.headBytes,
    pool,
    (record) => record.type === 'user' || record.type === 'assistant',
  );
  return {
    id: metadata.sessionId,
    provider: 'claude',
    surface: 'claude-code',
    kind: 'claude-jsonl',
    cwd: metadata.cwd,
    sourcePath: file.path,
    title: metadata.title,
    startedAt: metadata.startedAt,
    lastActivityAt: messageAt ?? isoFromMs(file.mtimeMs),
    sizeBytes: file.sizeBytes,
    native: metadata.native,
  };
}

async function scanProjectsDir(
  projectsDir: string,
  limits: DiscoveryLimits,
  excludedRootSlugs: readonly string[],
  pool: ReadPool,
  diagnostics: DiscoveryDiagnostic[],
): Promise<{ sessions: DiscoveredSession[]; detected: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { sessions: [], detected: false };
  }
  const candidateDirs = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      !isClaudeProjectDirUnderRoots(entry.name, excludedRootSlugs),
  );
  const projectDirs = (
    await mapWithConcurrency(
      candidateDirs,
      limits.maxConcurrentReads,
      async (entry): Promise<ProjectDirEntry | null> => {
        const dirPath = path.join(projectsDir, entry.name);
        try {
          const stats = await pool.run(() => stat(dirPath));
          return { path: dirPath, mtimeMs: stats.mtimeMs };
        } catch {
          // Removed during the scan.
          return null;
        }
      },
    )
  ).filter((dir): dir is ProjectDirEntry => dir !== null);
  projectDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Each project's newest transcripts first, then taken in rounds (one per
  // project per round) so the budget spreads across projects. A store with
  // hundreds of project directories must not spend it all on the few most
  // recently touched ones and leave every older project looking chat-less.
  const queues = (
    await mapWithConcurrency(projectDirs, limits.maxConcurrentReads, (dir) =>
      listFilesNewestFirst(
        dir.path,
        (entry) => entry.name.endsWith('.jsonl'),
        pool,
      ),
    )
  )
    .filter((files) => files.length > 0)
    .map((files) => files.slice(0, limits.maxSessionFilesPerProject));

  const planned: FileEntryWithStats[] = [];
  let truncated = false;
  rounds: for (let round = 0; ; round += 1) {
    let anyLeft = false;
    for (const queue of queues) {
      const file = queue[round];
      if (!file) continue;
      anyLeft = true;
      if (planned.length >= limits.maxSessionFiles) {
        truncated = true;
        break rounds;
      }
      planned.push(file);
    }
    if (!anyLeft) break;
  }
  const sessions = (
    await mapWithConcurrency(planned, limits.maxConcurrentReads, (file) =>
      readClaudeSession(file, limits, pool),
    )
  ).filter((session): session is DiscoveredSession => session !== null);
  if (truncated) {
    diagnostics.push({
      source: 'claude-code',
      message: `Only ${limits.maxSessionFiles} Claude Code sessions were scanned, the newest of each project first.`,
    });
  }
  return { sessions, detected: true };
}

async function listDesktopRecordFiles(
  root: string,
  limit: number,
): Promise<string[]> {
  // `<root>/<account>/<org>/local_*.json`, bounded to `limit` records.
  const files: string[] = [];
  let accounts: Dirent[];
  try {
    accounts = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const account of accounts) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(root, account.name);
    let orgs: Dirent[];
    try {
      orgs = await readdir(accountDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const org of orgs) {
      if (!org.isDirectory()) continue;
      const orgDir = path.join(accountDir, org.name);
      let records: Dirent[];
      try {
        records = await readdir(orgDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const record of records) {
        if (!record.isFile()) continue;
        if (
          !record.name.startsWith('local_') ||
          !record.name.endsWith('.json')
        ) {
          continue;
        }
        files.push(path.join(orgDir, record.name));
        if (files.length >= limit) return files;
      }
    }
  }
  return files;
}

interface DesktopRecord {
  cwd: string | null;
  folders: string[];
  title: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  cliSessionId: string | null;
  archived: boolean;
}

function readDesktopRecord(value: unknown): DesktopRecord | null {
  if (!isRecord(value)) return null;
  const cwd =
    typeof value.cwd === 'string' && path.isAbsolute(value.cwd)
      ? value.cwd
      : typeof value.originCwd === 'string' && path.isAbsolute(value.originCwd)
        ? value.originCwd
        : null;
  const folders = Array.isArray(value.userSelectedFolders)
    ? value.userSelectedFolders.filter(
        (folder): folder is string =>
          typeof folder === 'string' && path.isAbsolute(folder),
      )
    : [];
  if (!cwd && folders.length === 0) return null;
  return {
    cwd,
    folders,
    title:
      typeof value.title === 'string'
        ? value.title.trim().slice(0, CLAUDE_TITLE_MAX_LENGTH) || null
        : null,
    createdAt: isoFromValue(value.createdAt),
    lastActivityAt: isoFromValue(value.lastActivityAt),
    cliSessionId:
      typeof value.cliSessionId === 'string' ? value.cliSessionId : null,
    archived: value.isArchived === true,
  };
}

async function scanDesktopRecords(
  desktopDir: string,
  limits: DiscoveryLimits,
  pool: ReadPool,
): Promise<{
  roots: DiscoveredRoot[];
  titles: Map<string, string>;
  detected: boolean;
}> {
  const roots: DiscoveredRoot[] = [];
  const titles = new Map<string, string>();
  let detected = false;
  const coworkSessionsDir = resolveClaudeDesktopCoworkSessionsDir(desktopDir);
  for (const tree of ['claude-code-sessions', 'local-agent-mode-sessions']) {
    const treeRoot = path.join(desktopDir, tree);
    const files = await listDesktopRecordFiles(
      treeRoot,
      limits.maxDesktopRecords,
    );
    if (files.length > 0) detected = true;
    for (const filePath of files) {
      let record: DesktopRecord | null;
      try {
        const stats = await pool.run(() => stat(filePath));
        if (stats.size > limits.maxDesktopRecordBytes) continue;
        record = readDesktopRecord(
          JSON.parse(await pool.run(() => readFile(filePath, 'utf8'))),
        );
      } catch {
        continue;
      }
      if (!record) continue;
      // A session the user archived in Claude Desktop is neither evidence
      // nor a candidate; only its explicit choice to keep it counts.
      if (record.archived) continue;
      if (record.cliSessionId && record.title) {
        titles.set(record.cliSessionId, record.title);
      }
      const folderRoots = record.cwd
        ? [record.cwd, ...record.folders]
        : record.folders;
      for (const folder of Array.from(new Set(folderRoots))) {
        // A session's own scratch folder has no name of its own; the session
        // title is the one the user knows it by. A folder the user chose
        // keeps its folder name.
        const scratch =
          folder === record.cwd && isPathInside(coworkSessionsDir, folder);
        roots.push({
          provider: 'claude',
          surface: 'claude-desktop',
          rootPath: folder,
          ...(scratch && record.title ? { displayName: record.title } : {}),
          lastActivityAt: record.lastActivityAt ?? record.createdAt,
          sessions: [],
        });
      }
    }
  }
  return { roots, titles, detected };
}

export async function discoverClaudeProjects(
  options: ClaudeDiscoveryOptions = {},
): Promise<AdapterResult> {
  const env = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_DISCOVERY_LIMITS;
  const diagnostics: DiscoveryDiagnostic[] = [];
  const globalConfigPath =
    options.globalConfigPath ?? resolveClaudeGlobalConfigPath(env);
  const projectsDir = options.projectsDir ?? resolveClaudeProjectsDir(env);
  const desktopDir =
    options.desktopDataDir === undefined
      ? resolveClaudeDesktopDataDir(options.platform, env)
      : options.desktopDataDir;

  const excludedRootSlugs = Array.from(
    new Set(
      (options.excludedRoots ?? []).flatMap((root) => [
        claudeProjectDirSlug(root),
        claudeProjectDirSlug(path.resolve(root)),
      ]),
    ),
  );

  // One pool for the whole scan: registry, transcripts, and desktop
  // records together never hold more than `maxConcurrentReads` stats or
  // file reads in flight, whichever of them is running.
  const pool = createReadPool(limits.maxConcurrentReads);
  const [registry, transcripts, desktop] = await Promise.all([
    readGlobalConfigProjectKeys(globalConfigPath, limits, pool, diagnostics),
    scanProjectsDir(projectsDir, limits, excludedRootSlugs, pool, diagnostics),
    desktopDir
      ? scanDesktopRecords(desktopDir, limits, pool)
      : Promise.resolve({
          roots: [],
          titles: new Map<string, string>(),
          detected: false,
        }),
  ]);

  const rootsByPath = new Map<string, DiscoveredRoot>();
  const upsertRoot = (root: DiscoveredRoot): DiscoveredRoot => {
    const existing = rootsByPath.get(root.rootPath);
    if (!existing) {
      rootsByPath.set(root.rootPath, root);
      return root;
    }
    existing.lastActivityAt = laterIso(
      existing.lastActivityAt,
      root.lastActivityAt,
    );
    existing.displayName ??= root.displayName;
    existing.sessions.push(...root.sessions);
    if (existing.surface !== root.surface) {
      const surfaces = existing.surfaces ?? [existing.surface];
      if (!surfaces.includes(root.surface)) surfaces.push(root.surface);
      existing.surfaces = surfaces;
    }
    return existing;
  };

  for (const key of registry.keys) {
    upsertRoot({
      provider: 'claude',
      surface: 'claude-code',
      rootPath: key,
      lastActivityAt: null,
      sessions: [],
    });
  }
  for (const session of transcripts.sessions) {
    const desktopTitle = desktop.titles.get(session.id);
    const withTitle = desktopTitle
      ? { ...session, title: desktopTitle }
      : session;
    upsertRoot({
      provider: 'claude',
      surface: 'claude-code',
      rootPath: session.cwd,
      lastActivityAt: session.lastActivityAt,
      sessions: [withTitle],
    });
  }
  for (const root of desktop.roots) {
    upsertRoot(root);
  }

  return {
    roots: mapValues(rootsByPath),
    diagnostics,
    detected: registry.detected || transcripts.detected || desktop.detected,
  };
}

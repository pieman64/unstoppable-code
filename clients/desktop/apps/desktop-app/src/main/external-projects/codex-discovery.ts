import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { mapWithConcurrency, normalizeLimit } from '../lib/concurrency';
import { isRecord } from '../lib/type-guards';
import { compareText, mapValues } from './file-head';
import { summarizeTitle } from './claude-discovery';
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
  resolveCodexGlobalStatePath,
  resolveCodexSessionIndexPath,
  resolveCodexSessionsDir,
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
 * Codex discovery adapters (CAN-2439). Read-only, bounded, and allowlisted:
 *
 * - `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` → the leading
 *   `session_meta` record (thread id, exact `cwd`, originator, source,
 *   timestamp) and the first user message line for a title. Newest day
 *   directories are walked first so the bound keeps the most recent threads.
 * - `~/.codex/.codex-global-state.json` → only `local-projects` entries'
 *   `id`, `name`, and `rootPaths`; the desktop app's explicit project registry.
 * - `~/.codex/session_index.jsonl` → only `id` and `thread_name`; the name
 *   Codex itself shows for a thread, preferred over a summary of its first
 *   prompt (CAN-3076).
 *
 * `state_5.sqlite` is deliberately not opened: it is a live, private,
 * versioned database and the rollout metadata already carries every field
 * the import needs.
 */

/** Provider-supplied project and thread names become sidebar names; keep them bounded. */
const CODEX_PROJECT_NAME_MAX_LENGTH = 120;
const CODEX_THREAD_NAME_MAX_LENGTH = 120;

export interface CodexDiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  limits?: DiscoveryLimits;
  sessionsDir?: string;
  globalStatePath?: string;
  sessionIndexPath?: string;
  /**
   * Originators whose threads Canopy itself created (the brand id and the
   * legacy product name). Those threads are evidence, never importable chats.
   */
  ownOriginators?: readonly string[];
}

interface RolloutHeadMetadata {
  threadId: string;
  cwd: string;
  originator: string;
  startedAt: string | null;
  title: string | null;
}

export function readCodexRolloutHeadMetadata(
  records: Record<string, unknown>[],
): RolloutHeadMetadata | null {
  const meta = records.find((record) => record.type === 'session_meta');
  if (!meta || !isRecord(meta.payload)) return null;
  const payload = meta.payload;
  if (
    typeof payload.id !== 'string' ||
    typeof payload.cwd !== 'string' ||
    !path.isAbsolute(payload.cwd)
  ) {
    return null;
  }
  let title: string | null = null;
  for (const record of records) {
    if (record.type !== 'event_msg' || !isRecord(record.payload)) continue;
    if (record.payload.type !== 'user_message') continue;
    if (typeof record.payload.message !== 'string') continue;
    title = summarizeTitle(record.payload.message);
    if (title) break;
  }
  return {
    threadId: payload.id,
    cwd: payload.cwd,
    originator:
      typeof payload.originator === 'string' ? payload.originator : '',
    startedAt: isoFromValue(payload.timestamp) ?? isoFromValue(meta.timestamp),
    title,
  };
}

export async function listCodexDayDirectoriesNewestFirst(
  root: string,
): Promise<string[]> {
  // sessions/YYYY/MM/DD — lexical descending order is chronological descending.
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => compareText(b, a));
    for (const name of dirs) {
      const next = path.join(dir, name);
      if (depth === 2) out.push(next);
      else await walk(next, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/** A turn someone took: a user or agent message, not session bookkeeping. */
function isCodexMessage(record: Record<string, unknown>): boolean {
  if (!isRecord(record.payload)) return false;
  const kind = record.payload.type;
  // Developer and system messages are instructions written on start or
  // resume, not a turn anyone took.
  return record.type === 'response_item'
    ? kind === 'message' &&
        (record.payload.role === 'user' || record.payload.role === 'assistant')
    : record.type === 'event_msg' &&
        (kind === 'user_message' || kind === 'agent_message');
}

async function readCodexSession(
  file: FileEntryWithStats,
  limits: DiscoveryLimits,
  ownOriginators: ReadonlySet<string>,
  pool: ReadPool,
): Promise<DiscoveredSession | null> {
  if (file.sizeBytes === 0) return null;
  let head: string;
  try {
    head = await pool.run(() => readFileHead(file.path, limits.headBytes));
  } catch {
    return null;
  }
  const metadata = readCodexRolloutHeadMetadata(
    parseJsonLinesHead(head, limits.headBytes),
  );
  if (!metadata) return null;
  const messageAt = await lastMessageAt(
    file,
    head,
    limits.headBytes,
    pool,
    isCodexMessage,
  );
  return {
    id: metadata.threadId,
    provider: 'codex',
    surface: 'codex-cli',
    kind: 'codex-rollout',
    cwd: metadata.cwd,
    sourcePath: file.path,
    title: metadata.title,
    startedAt: metadata.startedAt,
    lastActivityAt: messageAt ?? isoFromMs(file.mtimeMs),
    sizeBytes: file.sizeBytes,
    native: !ownOriginators.has(metadata.originator),
  };
}

function isRolloutFile(entry: Dirent): boolean {
  return entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl');
}

async function scanRollouts(
  sessionsDir: string,
  limits: DiscoveryLimits,
  ownOriginators: ReadonlySet<string>,
  pool: ReadPool,
  diagnostics: DiscoveryDiagnostic[],
): Promise<{ sessions: DiscoveredSession[]; detected: boolean }> {
  const dayDirs = await listCodexDayDirectoriesNewestFirst(sessionsDir);
  if (dayDirs.length === 0) {
    let detected = false;
    try {
      await readdir(sessionsDir);
      detected = true;
    } catch {
      detected = false;
    }
    return { sessions: [], detected };
  }
  // Day directories newest first, listed a pool's width at a time so the
  // listing stops once the budget is met instead of touching every day of
  // the store's history; results land by input position, so order holds.
  const width = normalizeLimit(limits.maxConcurrentReads);
  const planned: FileEntryWithStats[] = [];
  let truncated = false;
  for (let start = 0; start < dayDirs.length && !truncated; start += width) {
    if (planned.length >= limits.maxSessionFiles) {
      // The budget was met exactly at a batch boundary. Day directories
      // remain unlisted, so more rollouts may remain; the scan is reported
      // as bounded rather than listing them only to find out.
      truncated = true;
      break;
    }
    const listed = await mapWithConcurrency(
      dayDirs.slice(start, start + width),
      width,
      (dayDir) => listFilesNewestFirst(dayDir, isRolloutFile, pool),
    );
    for (const files of listed) {
      for (const file of files) {
        if (planned.length >= limits.maxSessionFiles) {
          truncated = true;
          break;
        }
        planned.push(file);
      }
      if (truncated) break;
    }
  }
  const sessions = (
    await mapWithConcurrency(planned, limits.maxConcurrentReads, (file) =>
      readCodexSession(file, limits, ownOriginators, pool),
    )
  ).filter((session): session is DiscoveredSession => session !== null);
  if (truncated) {
    diagnostics.push({
      source: 'codex-cli',
      message: `Only the ${limits.maxSessionFiles} most recent Codex threads were scanned.`,
    });
  }
  return { sessions, detected: true };
}

interface CodexLocalProject {
  name: string | null;
  rootPaths: string[];
  updatedAt: string | null;
}

async function readGlobalStateProjects(
  filePath: string,
  limits: DiscoveryLimits,
  pool: ReadPool,
  diagnostics: DiscoveryDiagnostic[],
): Promise<{ projects: CodexLocalProject[]; detected: boolean }> {
  let raw: string;
  try {
    const stats = await pool.run(() => stat(filePath));
    if (stats.size > limits.maxGlobalConfigBytes) {
      diagnostics.push({
        source: 'codex-desktop',
        message: `The Codex desktop project list is larger than ${Math.round(limits.maxGlobalConfigBytes / (1024 * 1024))} MB and was skipped.`,
      });
      return { projects: [], detected: true };
    }
    raw = await pool.run(() => readFile(filePath, 'utf8'));
  } catch {
    return { projects: [], detected: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    diagnostics.push({
      source: 'codex-desktop',
      message: 'The Codex desktop project list could not be read as JSON.',
    });
    return { projects: [], detected: true };
  }
  if (!isRecord(parsed) || !isRecord(parsed['local-projects'])) {
    return { projects: [], detected: true };
  }
  const projects: CodexLocalProject[] = [];
  for (const value of Object.values(parsed['local-projects'])) {
    if (!isRecord(value) || !Array.isArray(value.rootPaths)) continue;
    const rootPaths = value.rootPaths.filter(
      (root): root is string =>
        typeof root === 'string' && path.isAbsolute(root),
    );
    if (rootPaths.length === 0) continue;
    projects.push({
      name:
        typeof value.name === 'string'
          ? value.name.trim().slice(0, CODEX_PROJECT_NAME_MAX_LENGTH) || null
          : null,
      rootPaths,
      updatedAt: isoFromValue(value.updatedAt) ?? isoFromValue(value.createdAt),
    });
    if (projects.length >= limits.maxRegistryEntries) break;
  }
  return { projects, detected: true };
}

/**
 * Thread names from Codex's own resume index, by thread id. Supplementary
 * only: a missing or unreadable index never counts against detection, and a
 * torn row is skipped rather than fatal. The index is append-only with one
 * row per thread, so it outgrows the rollout scan; only its newest
 * `maxSessionFiles` rows are parsed, which are the threads that scan can
 * still reach (later rows win when a thread was renamed).
 */
async function readSessionIndexTitles(
  filePath: string,
  limits: DiscoveryLimits,
  pool: ReadPool,
  diagnostics: DiscoveryDiagnostic[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let raw: string;
  try {
    const stats = await pool.run(() => stat(filePath));
    if (stats.size > limits.maxGlobalConfigBytes) {
      diagnostics.push({
        source: 'codex-cli',
        message: `The Codex thread name list is larger than ${Math.round(limits.maxGlobalConfigBytes / (1024 * 1024))} MB and was skipped; chats were named from their first message.`,
      });
      return titles;
    }
    raw = await pool.run(() => readFile(filePath, 'utf8'));
  } catch {
    return titles;
  }
  // The size cap above bounds memory and the walk (one cheap step per
  // newline); walking back from the end bounds the rows kept and parsed to
  // the session budget. They are then applied oldest first so a renamed
  // thread keeps its latest name.
  const newest: string[] = [];
  let end = raw.length;
  while (end > 0 && newest.length < limits.maxSessionFiles) {
    const start = raw.lastIndexOf('\n', end - 1);
    const line = raw.slice(start + 1, end).trim();
    if (line) newest.push(line);
    end = start;
  }
  for (const trimmed of newest.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.id !== 'string' ||
      typeof parsed.thread_name !== 'string'
    ) {
      continue;
    }
    const name = parsed.thread_name
      .trim()
      .slice(0, CODEX_THREAD_NAME_MAX_LENGTH);
    if (name) titles.set(parsed.id, name);
  }
  return titles;
}

export async function discoverCodexProjects(
  options: CodexDiscoveryOptions = {},
): Promise<AdapterResult> {
  const env = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_DISCOVERY_LIMITS;
  const diagnostics: DiscoveryDiagnostic[] = [];
  const sessionsDir = options.sessionsDir ?? resolveCodexSessionsDir(env);
  const globalStatePath =
    options.globalStatePath ?? resolveCodexGlobalStatePath(env);
  const sessionIndexPath =
    options.sessionIndexPath ?? resolveCodexSessionIndexPath(env);
  const ownOriginators = new Set(options.ownOriginators ?? []);

  // One pool for the whole scan, so rollouts, the project list, and the
  // thread names together never exceed `maxConcurrentReads` in flight.
  const pool = createReadPool(limits.maxConcurrentReads);
  const [rollouts, registry, threadNames] = await Promise.all([
    scanRollouts(sessionsDir, limits, ownOriginators, pool, diagnostics),
    readGlobalStateProjects(globalStatePath, limits, pool, diagnostics),
    readSessionIndexTitles(sessionIndexPath, limits, pool, diagnostics),
  ]);

  const rootsByPath = new Map<string, DiscoveredRoot>();
  const upsertRoot = (root: DiscoveredRoot): void => {
    const existing = rootsByPath.get(root.rootPath);
    if (!existing) {
      rootsByPath.set(root.rootPath, root);
      return;
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
  };

  for (const project of registry.projects) {
    project.rootPaths.forEach((rootPath, index) => {
      upsertRoot({
        provider: 'codex',
        surface: 'codex-desktop',
        rootPath,
        ...(index === 0 && project.name ? { displayName: project.name } : {}),
        lastActivityAt: project.updatedAt,
        sessions: [],
      });
    });
  }
  for (const session of rollouts.sessions) {
    const threadName = threadNames.get(session.id);
    upsertRoot({
      provider: 'codex',
      surface: 'codex-cli',
      rootPath: session.cwd,
      lastActivityAt: session.lastActivityAt,
      sessions: [threadName ? { ...session, title: threadName } : session],
    });
  }

  return {
    roots: mapValues(rootsByPath),
    diagnostics,
    detected: rollouts.detected || registry.detected,
  };
}

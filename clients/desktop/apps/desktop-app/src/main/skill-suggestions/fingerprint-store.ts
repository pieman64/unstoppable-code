import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactSecrets } from '@canopy/desktop-shared/lib/redaction';
import { writeFileAtomically } from '../lib/atomic-file';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getSkillSuggestionFingerprintsFilePath } from '../lib/paths';
import { MAX_PROMPT_EXCERPT_CHARS, MAX_PROMPT_INPUT_CHARS } from './normalize';
import { isPrivatePartitionOfWorkspace } from './partition';

/**
 * Rebuildable, append-only request fingerprints for repeat-task skill
 * suggestions (CAN-385). Main is the only writer. Rows are compacted at scan
 * time; losing the file only means repeats are counted again from scratch.
 */
export const FINGERPRINT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
export const FINGERPRINT_TURN_ROW_CAP = 2000;

export interface TurnFingerprint {
  kind: 'turn';
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Transcript row id of the user message; the live and backfill paths agree. */
  userMessageId: string;
  auditEntryId?: string;
  partition: string;
  createdAt: number;
  /** Local `YYYY-MM-DD` at record time; "different days" compares this. */
  day: string;
  /** Redacted, at most {@link MAX_PROMPT_EXCERPT_CHARS} characters. */
  excerpt: string;
  tokens: string[];
  tools: string[];
  status: string;
}

export interface ChatChainFingerprint {
  kind: 'chat_chain';
  projectId: string;
  worktreeId: string;
  chatId: string;
  partition: string;
  /** Ordered skill names invoked across the chat's eligible turns. */
  skills: string[];
  lastActivityAt: number;
  day: string;
}

export type FingerprintRow = TurnFingerprint | ChatChainFingerprint;

export function turnRowKey(row: {
  chatId: string;
  userMessageId: string;
}): string {
  return JSON.stringify([row.chatId, row.userMessageId]);
}

/** Stable id of a turn inside suggestion state; carries its workspace. */
export function turnMatchId(row: {
  projectId: string;
  chatId: string;
  userMessageId: string;
}): string {
  return JSON.stringify([row.projectId, row.chatId, row.userMessageId]);
}

/** Chain matches count once per chat. */
export function chainMatchId(row: {
  projectId: string;
  chatId: string;
}): string {
  return JSON.stringify([row.projectId, row.chatId, '#chain']);
}

/** Workspace and chat of a match id; an unparseable id is its own chat. */
export function matchIdChatKey(id: string): string {
  try {
    const parsed: unknown = JSON.parse(id);
    return Array.isArray(parsed) ? JSON.stringify(parsed.slice(0, 2)) : id;
  } catch {
    return id;
  }
}

export function matchIdProjectId(id: string): string | null {
  try {
    const parsed: unknown = JSON.parse(id);
    return Array.isArray(parsed) && typeof parsed[0] === 'string'
      ? parsed[0]
      : null;
  } catch {
    return null;
  }
}

/** Local calendar day for `timestamp`, as `YYYY-MM-DD`. */
export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function prepareExcerpt(text: string): string {
  // Redact before cutting, so a secret crossing the cap is still matched.
  return redactSecrets(text.slice(0, MAX_PROMPT_INPUT_CHARS)).slice(
    0,
    MAX_PROMPT_EXCERPT_CHARS,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length <= 512)
  );
}
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseFingerprintRow(value: unknown): FingerprintRow | null {
  if (
    !isRecord(value) ||
    !isString(value.projectId) ||
    !isString(value.worktreeId) ||
    !isString(value.chatId) ||
    !isString(value.partition) ||
    typeof value.day !== 'string' ||
    !DAY_PATTERN.test(value.day)
  )
    return null;
  if (value.kind === 'turn') {
    if (
      !isString(value.userMessageId) ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      typeof value.excerpt !== 'string' ||
      value.excerpt.length > MAX_PROMPT_EXCERPT_CHARS ||
      !isStringArray(value.tokens) ||
      !isStringArray(value.tools) ||
      typeof value.status !== 'string'
    )
      return null;
    return {
      kind: 'turn',
      projectId: value.projectId,
      worktreeId: value.worktreeId,
      chatId: value.chatId,
      userMessageId: value.userMessageId,
      ...(isString(value.auditEntryId)
        ? { auditEntryId: value.auditEntryId }
        : {}),
      partition: value.partition,
      createdAt: value.createdAt,
      day: value.day,
      excerpt: value.excerpt,
      tokens: value.tokens,
      tools: value.tools,
      status: value.status,
    };
  }
  if (value.kind === 'chat_chain') {
    if (
      !isStringArray(value.skills) ||
      typeof value.lastActivityAt !== 'number' ||
      !Number.isFinite(value.lastActivityAt)
    )
      return null;
    return {
      kind: 'chat_chain',
      projectId: value.projectId,
      worktreeId: value.worktreeId,
      chatId: value.chatId,
      partition: value.partition,
      skills: value.skills,
      lastActivityAt: value.lastActivityAt,
      day: value.day,
    };
  }
  return null;
}

/**
 * Parses JSONL, skipping corrupt lines. Turn rows keep their first copy per
 * `(chatId, userMessageId)`; chain rows keep their latest copy per chat.
 */
export function parseFingerprintLines(text: string): FingerprintRow[] {
  const turns = new Map<string, TurnFingerprint>();
  const chains = new Map<string, ChatChainFingerprint>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = parseFingerprintRow(parsed);
    if (!row) continue;
    if (row.kind === 'turn') {
      const key = turnRowKey(row);
      if (!turns.has(key)) turns.set(key, row);
    } else {
      chains.set(row.chatId, row);
    }
  }
  return [...Array.from(turns.values()), ...Array.from(chains.values())];
}

export interface CompactionOptions {
  now: number;
  /** Chats that still exist; rows for other chats are pruned. */
  liveChatIds?: ReadonlySet<string> | null;
  /** Workspaces that still exist; rows for other workspaces are pruned. */
  liveProjectIds?: ReadonlySet<string> | null;
}

/** Retention: 60 days, 2,000 newest turn rows; chain rows follow their chat. */
export function compactRows(
  rows: readonly FingerprintRow[],
  options: CompactionOptions,
): FingerprintRow[] {
  const cutoff = options.now - FINGERPRINT_RETENTION_MS;
  const live = options.liveChatIds ?? null;
  const projects = options.liveProjectIds ?? null;
  const exists = (row: FingerprintRow): boolean =>
    (live === null || live.has(row.chatId)) &&
    (projects === null || projects.has(row.projectId));
  const turns = rows
    .filter(
      (row): row is TurnFingerprint =>
        row.kind === 'turn' && row.createdAt >= cutoff && exists(row),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, FINGERPRINT_TURN_ROW_CAP)
    .reverse();
  const keptChats = new Set(turns.map((row) => row.chatId));
  const chains = rows.filter(
    (row): row is ChatChainFingerprint =>
      row.kind === 'chat_chain' && keptChats.has(row.chatId) && exists(row),
  );
  return [...turns, ...chains];
}

function serializeRows(rows: readonly FingerprintRow[]): string {
  return (
    rows.map((row) => JSON.stringify(row)).join('\n') +
    (rows.length ? '\n' : '')
  );
}

export class FingerprintStore {
  private chain: Promise<unknown> = Promise.resolve();
  /** Turn keys already on disk, loaded once; avoids re-reading per append. */
  private knownTurnKeys: Set<string> | null = null;

  constructor(
    private readonly path: () => string = getSkillSuggestionFingerprintsFilePath,
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(operation, operation);
    this.chain = pending.catch(() => undefined);
    return pending;
  }

  private async readText(): Promise<string> {
    try {
      return await readFile(this.path(), 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return '';
      throw error;
    }
  }

  private async loadKnownTurnKeys(): Promise<Set<string>> {
    if (this.knownTurnKeys) return this.knownTurnKeys;
    const keys = new Set<string>();
    for (const row of parseFingerprintLines(await this.readText())) {
      if (row.kind === 'turn') keys.add(turnRowKey(row));
    }
    this.knownTurnKeys = keys;
    return keys;
  }

  /** Appends rows, skipping turn rows already recorded. Returns rows written. */
  append(rows: readonly FingerprintRow[]): Promise<number> {
    return this.enqueue(async () => {
      if (rows.length === 0) return 0;
      const known = await this.loadKnownTurnKeys();
      const fresh: FingerprintRow[] = [];
      // Keys are remembered only once the write succeeds, so a failed append
      // can be retried.
      const freshKeys = new Set<string>();
      for (const row of rows) {
        if (row.kind === 'turn') {
          const key = turnRowKey(row);
          if (known.has(key) || freshKeys.has(key)) continue;
          freshKeys.add(key);
          fresh.push({
            ...row,
            excerpt: prepareExcerpt(row.excerpt),
          });
        } else {
          fresh.push(row);
        }
      }
      if (fresh.length === 0) return 0;
      const path = this.path();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, serializeRows(fresh), {
        encoding: 'utf8',
        mode: 0o600,
      });
      for (const key of Array.from(freshKeys)) known.add(key);
      return fresh.length;
    });
  }

  read(): Promise<FingerprintRow[]> {
    return this.enqueue(async () =>
      parseFingerprintLines(await this.readText()),
    );
  }

  /** Rewrites the file through a temporary file and rename. */
  compact(options: CompactionOptions): Promise<FingerprintRow[]> {
    return this.enqueue(async () => {
      const rows = parseFingerprintLines(await this.readText());
      const kept = compactRows(rows, options);
      await this.rewrite(kept);
      return kept;
    });
  }

  /** Drops a deleted workspace's rows and its private partition. */
  purgeWorkspace(workspaceId: string): Promise<number> {
    return this.enqueue(async () => {
      const rows = parseFingerprintLines(await this.readText());
      const kept = rows.filter(
        (row) =>
          row.projectId !== workspaceId &&
          row.worktreeId !== workspaceId &&
          !isPrivatePartitionOfWorkspace(row.partition, workspaceId),
      );
      const removed = rows.length - kept.length;
      if (removed > 0) await this.rewrite(kept);
      return removed;
    });
  }

  /** Deletes every fingerprint (the preference was turned off). */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.knownTurnKeys = new Set();
      await rm(this.path(), { force: true });
    });
  }

  private async rewrite(rows: readonly FingerprintRow[]): Promise<void> {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    if (rows.length === 0) {
      await rm(path, { force: true });
    } else {
      await writeFileAtomically(path, serializeRows(rows), {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    this.knownTurnKeys = new Set(
      rows.filter((row) => row.kind === 'turn').map((row) => turnRowKey(row)),
    );
  }
}

let defaultStore: FingerprintStore | null = null;
export function getFingerprintStore(): FingerprintStore {
  defaultStore ??= new FingerprintStore();
  return defaultStore;
}

export function logFingerprintFailureOnce(): (error: unknown) => void {
  let logged = false;
  return (error) => {
    if (logged) return;
    logged = true;
    logMainProcessWarn('[skill-suggestions] fingerprint write failed', error);
  };
}

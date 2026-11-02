import { createHash } from 'node:crypto';

/**
 * Per-scope accounting of canonical chat-storage work, for local diagnostics.
 *
 * `work-counters.ts` counts chat-storage work process-wide for the performance
 * harness. This module splits the same writes, syncs, commits and mutations by
 * the chat-storage scope (`chat-storage-v2/<scope>`) they belong to, so the
 * desktop app can record which scopes churn, and how much, on a user's
 * machine. It is fed from the work-counter hooks and the commit path, holds a
 * bounded number of scopes, and is drained about once a minute by the
 * diagnostics emitter. It never touches the storage it describes.
 *
 * Scope identity (workspace and worktree or Work Entry id) is registered by
 * the chat-state repository when it opens a scope. Totals carry no identity,
 * so they may go to app-level diagnostics; per-scope entries may not.
 *
 * No Electron dependency, so a future core daemon can host it.
 */

export interface ChatStorageScopeIdentity {
  projectId: string;
  worktreeId: string;
}

export interface ChatStorageActivity {
  commits: number;
  mutations: number;
  bytesWritten: number;
  /** Transcript JSONL and append staging bytes only, not other storage classes. */
  transcriptBytesWritten: number;
  fileSyncs: number;
  directorySyncs: number;
  /** Summed commit durations, queue wait included. */
  commitMsTotal: number;
  commitMsMax: number;
  /** Longest wait for the scope's previous transaction. */
  queueWaitMsMax: number;
}

export interface ChatStorageScopeActivity {
  /** Opaque digest of the normalized scope directory; no raw identifiers. */
  scopeKey: string;
  /** Undefined when no repository registered the scope's directory. */
  identity: ChatStorageScopeIdentity | undefined;
  activity: ChatStorageActivity;
}

export interface ChatStorageActivityWindow {
  scopes: ChatStorageScopeActivity[];
  /** Every scope, plus work outside any single scope (manifests, parents). */
  total: ChatStorageActivity;
}

export interface ChatStorageCommitTiming {
  /** The `chat-storage-v2/<scope>` directory the commit published into. */
  scopeDirectory: string;
  /** From queue admission to applied indexes. */
  durationMs: number;
  /** Wait for the scope's previous transaction. */
  queueWaitMs: number;
}

/** Scopes tracked per window; activity beyond it still counts in the total. */
export const CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT = 256;
/** Registered scope identities remembered; the oldest is forgotten first. */
export const CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT = 4096;

const SCOPE_ROOT = '/chat-storage-v2/';

function emptyActivity(): ChatStorageActivity {
  return {
    commits: 0,
    mutations: 0,
    bytesWritten: 0,
    transcriptBytesWritten: 0,
    fileSyncs: 0,
    directorySyncs: 0,
    commitMsTotal: 0,
    commitMsMax: 0,
    queueWaitMsMax: 0,
  };
}

const identities = new Map<string, ChatStorageScopeIdentity>();
let scopes = new Map<string, ChatStorageActivity>();
let total = emptyActivity();
let active = false;
let commitTotal = 0;

/**
 * The normalized `…/chat-storage-v2/<scope>` prefix of `path`, or undefined
 * for a path outside every scope directory.
 */
function scopeKeyOf(path: string): string | undefined {
  const normalized = path.includes('\\') ? path.replace(/\\/g, '/') : path;
  const root = normalized.lastIndexOf(SCOPE_ROOT);
  if (root === -1) return undefined;
  const scopeStart = root + SCOPE_ROOT.length;
  const scopeEnd = normalized.indexOf('/', scopeStart);
  const key = scopeEnd === -1 ? normalized : normalized.slice(0, scopeEnd);
  return key.length > scopeStart ? key : undefined;
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

/** Applies `update` to the path's scope (if any) and to the total. */
function record(
  path: string | undefined,
  update: (activity: ChatStorageActivity) => void,
): void {
  active = true;
  update(total);
  const key = path === undefined ? undefined : scopeKeyOf(path);
  if (key === undefined) return;
  let activity = scopes.get(key);
  if (activity === undefined) {
    if (scopes.size >= CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT) return;
    activity = emptyActivity();
    scopes.set(key, activity);
  }
  update(activity);
}

/** Remembers which workspace and worktree (or Work Entry) own a scope. */
export function registerChatStorageScope(
  directory: string,
  identity: ChatStorageScopeIdentity,
): void {
  const key = scopeKeyOf(`${directory}/`);
  if (key === undefined) return;
  identities.delete(key);
  if (identities.size >= CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT) {
    const oldest = identities.keys().next();
    if (!oldest.done) identities.delete(oldest.value);
  }
  identities.set(key, {
    projectId: identity.projectId,
    worktreeId: identity.worktreeId,
  });
}

/** Bytes a chat-storage writer put in `path`. */
export function recordChatStorageScopeWrite(
  path: string,
  bytes: number,
  transcript = false,
): void {
  if (!(bytes > 0)) return;
  record(path, (activity) => {
    activity.bytesWritten += bytes;
    if (transcript) activity.transcriptBytesWritten += bytes;
  });
}

export function recordChatStorageScopeSync(
  path: string,
  kind: 'file' | 'directory',
): void {
  record(path, (activity) => {
    if (kind === 'file') activity.fileSyncs += 1;
    else activity.directorySyncs += 1;
  });
}

/** One published commit, with its scope and timing when the caller has them. */
export function recordChatStorageScopeCommit(
  timing?: ChatStorageCommitTiming,
): void {
  commitTotal += 1;
  const durationMs = timing === undefined ? 0 : roundMs(timing.durationMs);
  const queueWaitMs = timing === undefined ? 0 : roundMs(timing.queueWaitMs);
  record(
    timing === undefined ? undefined : `${timing.scopeDirectory}/`,
    (activity) => {
      activity.commits += 1;
      activity.commitMsTotal = roundMs(activity.commitMsTotal + durationMs);
      activity.commitMsMax = Math.max(activity.commitMsMax, durationMs);
      activity.queueWaitMsMax = Math.max(activity.queueWaitMsMax, queueWaitMs);
    },
  );
}

/** Canonical mutations one commit carried. */
export function recordChatStorageScopeMutations(
  count: number,
  scopeDirectory?: string,
): void {
  if (!(count > 0)) return;
  record(
    scopeDirectory === undefined ? undefined : `${scopeDirectory}/`,
    (activity) => {
      activity.mutations += count;
    },
  );
}

/** Commits published since the process started; never reset. */
export function chatStorageCommitTotal(): number {
  return commitTotal;
}

/**
 * The activity since the previous call, or undefined when there was none.
 * Starts a new window either way.
 */
export function takeChatStorageActivity():
  | ChatStorageActivityWindow
  | undefined {
  if (!active) return undefined;
  const window: ChatStorageActivityWindow = {
    scopes: Array.from(scopes, ([key, activity]) => ({
      scopeKey: createHash('sha256')
        .update('chat-storage-activity\0')
        .update(key)
        .digest('hex')
        .slice(0, 16),
      identity: identities.get(key),
      activity,
    })),
    total,
  };
  scopes = new Map();
  total = emptyActivity();
  active = false;
  return window;
}

export function resetChatStorageActivityForTests(): void {
  identities.clear();
  scopes = new Map();
  total = emptyActivity();
  active = false;
}

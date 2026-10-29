import { buildChatSessionKey } from '../session-key';

/**
 * Separate from root-turn state: children keep resources alive without
 * blocking the chat queue. `count` is slot holders only (running or starting
 * work); `queued` is work waiting for a slot, which holds no resources.
 */
const counts = new Map<
  string,
  { sessionKey: string; count: number; queued: number }
>();

/** Aggregated per root chat; sessionKey is `${projectId}/${worktreeId}/${chatId}`. */
export interface DelegationActivityEntry {
  readonly sessionKey: string;
  /** Slot holders: starting or running. */
  readonly live: number;
  /** Waiting for a slot. */
  readonly queued: number;
}

type DelegationActivityListener = (entry: DelegationActivityEntry) => void;

const listeners = new Set<DelegationActivityListener>();

/** Refusal for closing or archiving a chat whose delegates are still live. */
export const LIVE_DELEGATES_CHAT_REFUSAL =
  'Delegates are still running in this chat. Stop them first.';
/** Refusal for removing a worktree, Work Entry or project with live delegates. */
export const LIVE_DELEGATES_REMOVAL_REFUSAL =
  'Delegates are still running here. Stop them first.';
/** SetAutoArchive result when the archive waits for live delegates. */
export const AUTO_ARCHIVE_DEFERRED_FOR_DELEGATES =
  'Auto-archive is on. This chat will be archived after its delegates finish.';

/**
 * A close, archive or removal refused because delegates are live. `code`
 * lets Portal adapters report it as a conflict rather than a failure.
 */
export class LiveDelegationsError extends Error {
  readonly code = 'conflict';

  constructor(message: string) {
    super(message);
    this.name = 'LiveDelegationsError';
  }
}

function aggregate(sessionKey: string): DelegationActivityEntry {
  let live = 0;
  let queued = 0;
  for (const entry of Array.from(counts.values()))
    if (entry.sessionKey === sessionKey) {
      live += entry.count;
      queued += entry.queued;
    }
  return { sessionKey, live, queued };
}

function notify(entry: DelegationActivityEntry): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(entry);
    } catch {
      // A failing observer must not break the broker's activity callback.
    }
  }
}

export function setDelegationActivity(
  owner: string,
  sessionKey: string,
  count: number,
  queued = 0,
): void {
  const previousKey = counts.get(owner)?.sessionKey;
  const affected =
    previousKey !== undefined && previousKey !== sessionKey
      ? [previousKey, sessionKey]
      : [sessionKey];
  const before = new Map(
    affected.map((key): [string, DelegationActivityEntry] => [
      key,
      aggregate(key),
    ]),
  );
  if (count > 0 || queued > 0) counts.set(owner, { sessionKey, count, queued });
  else counts.delete(owner);
  for (const key of affected) {
    const after = aggregate(key);
    const prior = before.get(key);
    if (
      prior === undefined ||
      prior.live !== after.live ||
      prior.queued !== after.queued
    )
      notify(after);
  }
}

/** Slot holders only: wake lock, resource guard and client retention. */
export function activeDelegationCount(sessionKey?: string): number {
  let total = 0;
  for (const entry of Array.from(counts.values()))
    if (!sessionKey || entry.sessionKey === sessionKey) total += entry.count;
  return total;
}

/** Work waiting for a slot. */
export function queuedDelegationCount(sessionKey?: string): number {
  let total = 0;
  for (const entry of Array.from(counts.values()))
    if (!sessionKey || entry.sessionKey === sessionKey) total += entry.queued;
  return total;
}

/** Any running, starting or queued delegated work, e.g. to keep it live. */
export function hasLiveDelegations(sessionKey?: string): boolean {
  for (const entry of Array.from(counts.values()))
    if (
      (!sessionKey || entry.sessionKey === sessionKey) &&
      entry.count + entry.queued > 0
    )
      return true;
  return false;
}

/** Every root chat with live or queued delegates, aggregated across owners. */
export function listDelegationActivity(): DelegationActivityEntry[] {
  const sessionKeys = new Set<string>();
  for (const entry of Array.from(counts.values()))
    if (entry.count + entry.queued > 0) sessionKeys.add(entry.sessionKey);
  return Array.from(sessionKeys, aggregate);
}

/** Fires when a chat's aggregate changes, including the change to 0/0. */
export function subscribeDelegationActivity(
  listener: (entry: DelegationActivityEntry) => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** The chat a delegation session key names, or null for another key shape. */
export function parseDelegationSessionKey(
  sessionKey: string,
): { projectId: string; worktreeId: string; chatId: string } | null {
  const parts = sessionKey.split('/');
  if (parts.length !== 3) return null;
  const [projectId, worktreeId, chatId] = parts;
  if (!projectId || !worktreeId || !chatId) return null;
  return { projectId, worktreeId, chatId };
}

function hasLiveDelegationsWithPrefix(prefix: string): boolean {
  for (const entry of Array.from(counts.values()))
    if (entry.sessionKey.startsWith(prefix) && entry.count + entry.queued > 0)
      return true;
  return false;
}

/** Live delegates in one chat. */
export function chatHasLiveDelegations(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return hasLiveDelegations(buildChatSessionKey(projectId, worktreeId, chatId));
}

/** Live delegates in any chat of a worktree or Work Entry. */
export function worktreeHasLiveDelegations(
  projectId: string,
  worktreeId: string,
): boolean {
  return hasLiveDelegationsWithPrefix(`${projectId}/${worktreeId}/`);
}

/** Live delegates in any chat of a workspace. */
export function workspaceHasLiveDelegations(projectId: string): boolean {
  return hasLiveDelegationsWithPrefix(`${projectId}/`);
}

/** Refuses in-app removal of a worktree or Work Entry with live delegates. */
export function assertNoLiveDelegationsInWorktree(
  projectId: string,
  worktreeId: string,
): void {
  if (worktreeHasLiveDelegations(projectId, worktreeId))
    throw new LiveDelegationsError(LIVE_DELEGATES_REMOVAL_REFUSAL);
}

/** Refuses in-app removal of a workspace with live delegates. */
export function assertNoLiveDelegationsInWorkspace(projectId: string): void {
  if (workspaceHasLiveDelegations(projectId))
    throw new LiveDelegationsError(LIVE_DELEGATES_REMOVAL_REFUSAL);
}

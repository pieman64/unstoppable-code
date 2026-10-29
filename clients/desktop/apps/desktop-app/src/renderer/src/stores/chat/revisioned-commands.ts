// Typed chat-command dispatch with per-command optimistic overlays (frontend
// plan, Phase 4).
//
// The renderer mutates canonical chat state ONLY by submitting typed command
// envelopes; visible immediacy comes from optimistic overlays registered per
// `commandId` and reconciled or rolled back when a terminal result (or a
// transport failure) arrives. Nothing here persists anything: unacknowledged
// commands are in-memory only, so a reload can never replay them.

import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandResult,
} from '@canopy/desktop-shared/types';
import { chatScopeKey } from './revisioned-sync';

/** Mint a fresh, collision-safe id for commands and user messages. */
export function mintChatCommandId(prefix = 'cmd'): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && 'randomUUID' in cryptoApi) {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

export interface ChatCommandScope {
  projectId: string;
  worktreeId: string;
}

export function createChatCommandEnvelope<T extends ChatCommand>(
  scope: ChatCommandScope,
  command: T,
  options: {
    commandId?: string;
    expectedRevision?: number;
    expectedTabRevision?: number;
  } = {},
): ChatCommandEnvelope<T> {
  return {
    schemaVersion: 1,
    commandId: options.commandId ?? mintChatCommandId(),
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    ...(options.expectedRevision === undefined
      ? {}
      : { expectedRevision: options.expectedRevision }),
    ...(options.expectedTabRevision === undefined
      ? {}
      : { expectedTabRevision: options.expectedTabRevision }),
    command,
  };
}

/**
 * How the renderer must react to a settled command:
 *  - accepted: canonical state (result revision / committed delta) confirms
 *    the change; reconcile and clear the overlay.
 *  - conflict: the entity changed elsewhere or no longer exists. Roll back the
 *    overlay, surface the conflict notice, refresh the view; never auto-retry.
 *  - rejected: the command was invalid or refused. Roll back only this
 *    overlay and surface the failure notice.
 *  - transport_failed: no durable outcome is known. Roll back the overlay and
 *    let the user retry explicitly (destructive commands must not auto-retry).
 */
export type ChatCommandDisposition =
  | 'accepted'
  | 'conflict'
  | 'rejected'
  | 'transport_failed';

export function classifyChatCommandResult(
  result: ChatCommandResult,
): Exclude<ChatCommandDisposition, 'transport_failed'> {
  switch (result.outcome) {
    case 'applied':
    case 'already_applied':
      return 'accepted';
    case 'conflict':
    case 'not_found':
      return 'conflict';
    case 'rejected':
      return 'rejected';
  }
}

export interface OptimisticCommandEntry {
  commandId: string;
  projectId: string;
  worktreeId: string;
  /** Undo exactly this command's optimistic overlay. */
  rollback: () => void;
  /** Reconcile the overlay against confirmed canonical state. */
  reconcile?: (result: ChatCommandResult) => void;
}

export interface SettledCommand {
  entry: OptimisticCommandEntry;
  disposition: ChatCommandDisposition;
  result?: ChatCommandResult;
}

/**
 * In-memory registry of optimistic overlays keyed by `commandId`.
 * Deliberately not persisted anywhere: reload/reconnect drops unacknowledged
 * overlays instead of replaying their commands.
 */
export class OptimisticCommandTracker {
  private readonly entries = new Map<string, OptimisticCommandEntry>();

  register(entry: OptimisticCommandEntry): void {
    this.entries.set(entry.commandId, entry);
  }

  has(commandId: string): boolean {
    return this.entries.has(commandId);
  }

  pendingCount(): number {
    return this.entries.size;
  }

  /** Settle a command that produced a terminal result. */
  settleResult(result: ChatCommandResult): SettledCommand | null {
    const entry = this.entries.get(result.commandId);
    if (!entry) return null;
    this.entries.delete(result.commandId);
    const disposition = classifyChatCommandResult(result);
    if (disposition === 'accepted') {
      entry.reconcile?.(result);
    } else {
      entry.rollback();
    }
    return { entry, disposition, result };
  }

  /** Settle a command whose transport failed before any durable outcome. */
  settleTransportFailure(commandId: string): SettledCommand | null {
    const entry = this.entries.get(commandId);
    if (!entry) return null;
    this.entries.delete(commandId);
    entry.rollback();
    return { entry, disposition: 'transport_failed' };
  }

  /**
   * Drop (without rolling back) every overlay for a scope whose projection
   * was just replaced wholesale by a fresh canonical snapshot — the snapshot
   * already superseded whatever the overlays painted.
   */
  dropScope(projectId: string, worktreeId: string): void {
    const key = chatScopeKey(projectId, worktreeId);
    for (const [commandId, entry] of Array.from(this.entries)) {
      if (chatScopeKey(entry.projectId, entry.worktreeId) === key) {
        this.entries.delete(commandId);
      }
    }
  }
}

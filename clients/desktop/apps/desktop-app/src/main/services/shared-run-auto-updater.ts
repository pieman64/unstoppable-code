import type { AgentAuditEntry } from '@canopy/desktop-shared/types/observability';
import { getObservabilityService } from '../observability';
import { readSharedRunMetadata } from '../lib/chat-tabs-reader';
import { shareRun } from '../lib/shared-run-sync';

/**
 * Re-share debounce: coalesce a burst of finished turns (e.g. an agent that
 * auto-continues across several turns) into a single re-share once activity
 * settles, so a long shared session isn't re-ingested on every turn.
 */
const RESHARE_DEBOUNCE_MS = 10_000;

/**
 * Conversation surfaces whose finished turns should keep an already-shared run
 * current. Helper audit events (branch naming, chat summary, PR/commit
 * generation, …) are intentionally excluded — they are not conversation turns.
 */
const SHAREABLE_CHAT_EVENT_TYPES: ReadonlySet<AgentAuditEntry['eventType']> =
  new Set<AgentAuditEntry['eventType']>(['worktree_chat', 'standalone_chat']);

/**
 * Keeps an already-shared chat's `SharedRun` current.
 *
 * A shared run is a consent snapshot bounded at the last explicit share
 * (`SharedRun.updatedAt`), so turns added afterward don't appear in the web
 * viewer until the run is re-shared. Users expect that once they've shared a
 * chat, its later turns stay available — that IS the ongoing consent. This
 * main-process service watches finished conversation turns and, for any chat
 * carrying persisted `sharedRun` metadata, debounces a best-effort re-share.
 *
 * `shareRun` is idempotent (deterministic `clientLocalRunId` from
 * `(project, worktree, chat)`), so a re-share updates the existing grant in
 * place — same `/runs/{id}` URL, no duplicate grant or feed spam — re-ingests
 * the newer turns, and advances the snapshot bound. Unsharing clears the
 * metadata, so this stops re-sharing automatically.
 */
class SharedRunAutoUpdater {
  private unsubscribe: (() => void) | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposing = false;

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.disposing = false;
    this.unsubscribe = getObservabilityService().subscribe((event) => {
      if (event.type !== 'entries') {
        return;
      }
      for (const entry of event.entries) {
        this.handleEntry(entry);
      }
    });
  }

  private handleEntry(entry: AgentAuditEntry): void {
    if (this.disposing) {
      return;
    }
    // Only a finished conversation turn advances a share; in-flight turns and
    // non-conversation helper events are ignored.
    if (entry.status === 'running') {
      return;
    }
    if (!SHAREABLE_CHAT_EVENT_TYPES.has(entry.eventType)) {
      return;
    }
    const { projectId, worktreeId, chatId } = entry;
    if (!projectId || !worktreeId || !chatId) {
      return;
    }
    this.scheduleReshare(projectId, worktreeId, chatId);
  }

  /**
   * Cancel a pending (not-yet-fired) re-share for a session. Called
   * synchronously by the unshare IPC handler so unsharing a chat can't be
   * undone by a debounced timer that was scheduled by a turn which finished
   * moments earlier — that timer would otherwise re-read the chat-tabs file
   * (whose `sharedRun` clear is still debounced in the renderer) and resurrect
   * the just-deleted grant via the deterministic idempotency key.
   */
  cancelPending(projectId: string, worktreeId: string, chatId: string): void {
    const key = `${projectId}\n${worktreeId}\n${chatId}`;
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  private scheduleReshare(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void {
    const key = `${projectId}\n${worktreeId}\n${chatId}`;
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.reshareIfShared(projectId, worktreeId, chatId);
    }, RESHARE_DEBOUNCE_MS);
    // A pending auto-reshare must not keep the app alive on quit.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async reshareIfShared(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<void> {
    if (this.disposing) {
      return;
    }
    try {
      // Re-read fresh each time: the chat may have been unshared since the turn
      // finished, in which case there's nothing to re-share.
      const meta = await readSharedRunMetadata(projectId, worktreeId, chatId);
      // A legacy private run share is a hidden copy nobody else can read, and
      // its Manage/Unshare controls are gone, so it is not kept up to date.
      if (!meta || meta.shareScope === 'private') {
        return;
      }
      await shareRun({
        projectId,
        worktreeId,
        chatId,
        shareScope: meta.shareScope,
        // Local metadata can lag an explicit audience change while this
        // debounced request is in flight. The server must refresh content
        // without treating this cached audience as a new user selection.
        preserveExistingOwner: true,
        ...(meta.teamId ? { teamId: meta.teamId } : {}),
        ...(meta.organizationId ? { organizationId: meta.organizationId } : {}),
      });
    } catch (error) {
      // Best-effort: a failed auto-reshare just means the shared view lags until
      // the next finished turn re-triggers it (or the user re-shares manually) —
      // never disrupt the chat over a background publish. But a persistently
      // failing re-publish would otherwise be invisible, so record a triageable
      // session diagnostic (matching the telemetry-sync ingest-failure pattern).
      getObservabilityService().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'shared_run_reshare_failed',
        sessionKey: `${projectId}/${worktreeId}/${chatId}`,
        projectId,
        worktreeId,
        chatId,
        providerType: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  shutdown(): void {
    this.disposing = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of Array.from(this.timers.values())) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

let instance: SharedRunAutoUpdater | null = null;

export function getSharedRunAutoUpdater(): SharedRunAutoUpdater {
  if (!instance) {
    instance = new SharedRunAutoUpdater();
  }
  return instance;
}

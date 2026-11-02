import { useEffect, useMemo, useState } from 'react';
import type {
  UsageLimitedChatGroup,
  UsageLimitedSessionGroup,
  UsageLimitedSessionItem,
} from '@canopy/desktop-shared/types';
import { excludeScheduledResumeSessions } from '@/lib/interruptedSessions';
import { useScheduledResumeAutomations } from '@/hooks/useScheduledResumeAutomations';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';

type UsageLimitedSessionsProvider = 'claude' | 'codex' | null;

/** One usage-limited session with the workspace it was listed under. */
export interface UsageLimitedSessionEntry {
  readonly session: UsageLimitedSessionItem;
  readonly workspaceName: string;
  /** Current owner, including migrated legacy standalone-chat identities. */
  readonly workspaceId?: string;
}

/**
 * One coherent read of the usage-limited registry. `count` is always
 * `sessions.length`. `status` separates a confirmed empty registry
 * (`loaded`) from one that has not loaded yet (`idle`) or failed (`error`).
 */
export interface UsageLimitedSessionsSnapshot {
  readonly status: 'idle' | 'loaded' | 'error';
  readonly sessions: readonly UsageLimitedSessionEntry[];
  readonly count: number;
}

const IDLE_SNAPSHOT: UsageLimitedSessionsSnapshot = {
  status: 'idle',
  sessions: [],
  count: 0,
};

const ERROR_SNAPSHOT: UsageLimitedSessionsSnapshot = {
  status: 'error',
  sessions: [],
  count: 0,
};

/** The raw registry read, before scheduled resumes are excluded. */
type RegistryListing =
  | { readonly status: 'idle' }
  | { readonly status: 'loaded'; readonly groups: UsageLimitedSessionGroup[] }
  | { readonly status: 'error' };

const IDLE_LISTING: RegistryListing = { status: 'idle' };

function loadedSnapshot(
  sessions: UsageLimitedSessionEntry[],
): UsageLimitedSessionsSnapshot {
  return { status: 'loaded', sessions, count: sessions.length };
}

function entriesFromSessionGroups(
  groups: UsageLimitedSessionGroup[],
): UsageLimitedSessionEntry[] {
  return groups.flatMap((group) =>
    group.sessions.map((session) => ({
      session,
      workspaceName: group.workspaceName,
      workspaceId: group.workspaceId,
    })),
  );
}

/** Legacy chat-only registry results, keeping each chat's full identity. */
function sessionGroupsFromChatGroups(
  groups: UsageLimitedChatGroup[],
): UsageLimitedSessionGroup[] {
  return groups.map((group) => ({
    groupId: group.workspaceId,
    groupKind: 'workspace',
    workspaceId: group.workspaceId,
    workspaceName: group.workspaceName,
    workspaceType: group.workspaceType,
    workspaceColor: group.workspaceColor,
    sessions: group.chats.map((chat) => ({ ...chat, kind: 'chat' as const })),
  }));
}

/**
 * Usage-limited idle sessions (chats + pipelines) recorded for a provider —
 * the population the {@link UsageLimitResumeModal} offers to resume. Drives
 * the Usage page/panel Resume button and waiting row.
 *
 * Chats with a pending usage-limit resume automation are excluded, as on
 * Home (CAN-5014): the count, the single-session Open action, and the chooser
 * all come from the same filtered list. A loaded listing reports `idle` until
 * the automations snapshot is settled and not loading, since an unloaded or
 * failed automations list is not an authoritative empty one; the store load
 * is retried on each `nowMs` tick. Eligibility is evaluated at `nowMs`, so a
 * passed schedule restores its chat, and schedule changes re-filter the last
 * listing without reading the registry again.
 *
 * Refetches when `nowMs` ticks (the usage surfaces already re-render on a
 * 30s clock, which also covers limits going stale), when the resume modal
 * closes, and when the asynchronous resume queue changes. The queue's terminal
 * revision arrives after dispatch updates the registry, so a completed resume
 * shrinks or hides the control. The previous snapshot remains visible during
 * a refresh of the same provider; a snapshot for another provider is never
 * returned, and a superseded request never replaces a newer one. Returns an
 * empty `idle` snapshot before the first load and in environments without
 * the preload API (jsdom tests), and an empty `error` snapshot on failure.
 */
export function useUsageLimitedSessions(
  provider: UsageLimitedSessionsProvider,
  nowMs: number,
): UsageLimitedSessionsSnapshot {
  const [state, setState] = useState<{
    provider: UsageLimitedSessionsProvider;
    listing: RegistryListing;
  }>({ provider, listing: IDLE_LISTING });
  const resumeModalOpen = useUsageLimitResumePromptStore((s) => s.isOpen);
  const resumeQueueRevision = useResumeQueueStore((s) => s.snapshot?.revision);
  const {
    activities,
    settled: automationsSettled,
    loading: automationsLoading,
    retry: retryAutomations,
  } = useScheduledResumeAutomations(true);
  const automationsReady = automationsSettled && !automationsLoading;

  // Activation loads automations once; a failed load is retried on the clock
  // rather than whenever its loading or error state changes.
  useEffect(() => {
    retryAutomations();
  }, [nowMs, retryAutomations]);

  useEffect(() => {
    // While the modal is open it owns the registry interaction; the close
    // transition re-runs this effect and refreshes the snapshot.
    if (resumeModalOpen) {
      return;
    }
    const api = window.api;
    const listSessions =
      api && typeof api.listUsageLimitedIdleSessions === 'function'
        ? api.listUsageLimitedIdleSessions
        : undefined;
    const listChats =
      api && typeof api.listUsageLimitedIdleChats === 'function'
        ? api.listUsageLimitedIdleChats
        : undefined;
    if (!listSessions && !listChats) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      let next: RegistryListing;
      try {
        if (listSessions) {
          const groups = await listSessions(
            provider ? { provider } : { resumeReason: 'app_shutdown' },
          );
          next = { status: 'loaded', groups };
        } else if (listChats && provider) {
          next = {
            status: 'loaded',
            groups: sessionGroupsFromChatGroups(await listChats({ provider })),
          };
        } else {
          next = { status: 'loaded', groups: [] };
        }
      } catch {
        // Keep the control hidden rather than surfacing a fetch error on a
        // read-only affordance, but do not report it as an empty registry.
        next = { status: 'error' };
      }
      if (!cancelled) {
        setState({ provider, listing: next });
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [provider, nowMs, resumeModalOpen, resumeQueueRevision]);

  const listing = state.provider === provider ? state.listing : IDLE_LISTING;
  return useMemo(() => {
    if (listing.status === 'error') return ERROR_SNAPSHOT;
    if (listing.status === 'idle' || !automationsReady) return IDLE_SNAPSHOT;
    return loadedSnapshot(
      entriesFromSessionGroups(
        excludeScheduledResumeSessions(listing.groups, activities, nowMs),
      ),
    );
  }, [listing, automationsReady, activities, nowMs]);
}

/**
 * Number of usage-limited idle sessions for a provider; see
 * {@link useUsageLimitedSessions}. Returns 0 before the first successful
 * load, on error, or without the preload API.
 */
export function useUsageLimitedSessionCount(
  provider: UsageLimitedSessionsProvider,
  nowMs: number,
): number {
  return useUsageLimitedSessions(provider, nowMs).count;
}

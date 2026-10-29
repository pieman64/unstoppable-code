import { useEffect, useRef, useState } from 'react';
import type { UsageLimitedSessionGroup } from '@canopy/desktop-shared/types';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import {
  resumeQueueProgress,
  useResumeQueueStore,
} from '@/stores/resumeQueueStore';
import {
  EMPTY_INTERRUPTED_SESSIONS,
  summarizeInterruptedSessions,
  type InterruptedSessionsSummary,
} from '@/lib/interruptedSessions';
import { usageLimitedSessionWorkspaceId } from '@/components/usage-limit/usageLimitResumeScope';

const REFRESH_INTERVAL_MS = 30_000;
const ALL_WORKSPACES = (): boolean => true;

/** The listing shared by every effect run of one hook instance. */
interface ListingState {
  inFlight: boolean;
  /** A refresh was requested while the listing was in flight. */
  requested: boolean;
  /** The current effect's refresh; null while the hook is inactive. */
  refresh: (() => void) | null;
}

function scopeGroupsToContext(
  groups: UsageLimitedSessionGroup[],
  isWorkspaceInContext: (workspaceId: string) => boolean,
): UsageLimitedSessionGroup[] {
  return groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) => {
        const workspaceId = usageLimitedSessionWorkspaceId(
          session,
          group.workspaceId,
        );
        return workspaceId === undefined || isWorkspaceInContext(workspaceId);
      }),
    }))
    .filter((group) => group.sessions.length > 0);
}

/**
 * Every idle interrupted session across all providers and interruption
 * reasons — the population the Home Continue "Resume interrupted sessions"
 * row advertises and the `UsageLimitResumeModal` (origin `home`) offers.
 *
 * Refreshes on mount, every 30s while `active`, on window focus, when the
 * workspace context changes, and when the resume modal closes or a queued
 * resume settles so the banner stays current. Nothing is fetched while
 * inactive (a hidden Home surface) or while the modal is open, since the modal
 * owns the registry interaction then. The previous summary stays in place
 * while a refresh is in flight or fails; the banner is a read-only affordance
 * and a fetch error is not worth a flicker.
 *
 * Listing sessions reads the chat registry and pipeline executions in main,
 * so one listing runs at a time, across effect restarts too: refreshes
 * requested while it is in flight fold into a single follow-up listing for
 * the latest effect.
 */
export function useInterruptedSessions(
  active: boolean,
  isWorkspaceInContext: (workspaceId: string) => boolean = ALL_WORKSPACES,
): InterruptedSessionsSummary {
  const [summary, setSummary] = useState<InterruptedSessionsSummary>(
    EMPTY_INTERRUPTED_SESSIONS,
  );
  const listing = useRef<ListingState>({
    inFlight: false,
    requested: false,
    refresh: null,
  });
  const resumeModalOpen = useUsageLimitResumePromptStore((s) => s.isOpen);
  const processedResumes = useResumeQueueStore((state) =>
    state.snapshot ? resumeQueueProgress(state.snapshot).processed : 0,
  );

  useEffect(() => {
    if (!active || resumeModalOpen) {
      return;
    }
    const api = window.api;
    const listSessions =
      api && typeof api.listUsageLimitedIdleSessions === 'function'
        ? api.listUsageLimitedIdleSessions
        : undefined;
    if (!listSessions) {
      return;
    }
    const shared = listing.current;
    let cancelled = false;
    const refresh = (): void => {
      if (shared.inFlight) {
        shared.requested = true;
        return;
      }
      shared.inFlight = true;
      void (async (): Promise<void> => {
        try {
          const groups = await listSessions({});
          if (cancelled) return;
          const next = summarizeInterruptedSessions(
            scopeGroupsToContext(groups, isWorkspaceInContext),
          );
          setSummary((previous) =>
            previous.signature === next.signature ? previous : next,
          );
        } catch {
          // Keep the last known summary; see the hook doc.
        } finally {
          shared.inFlight = false;
          if (shared.requested) {
            shared.requested = false;
            shared.refresh?.();
          }
        }
      })();
    };
    shared.refresh = refresh;
    refresh();
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    return (): void => {
      cancelled = true;
      if (shared.refresh === refresh) shared.refresh = null;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [active, resumeModalOpen, processedResumes, isWorkspaceInContext]);

  return summary;
}

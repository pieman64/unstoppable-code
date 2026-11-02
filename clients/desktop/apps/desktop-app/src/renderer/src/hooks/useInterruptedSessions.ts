import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ScheduledActivity,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useScheduledResumeAutomations } from '@/hooks/useScheduledResumeAutomations';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import {
  resumeQueueProgress,
  useResumeQueueStore,
} from '@/stores/resumeQueueStore';
import {
  EMPTY_INTERRUPTED_SESSIONS,
  excludeScheduledResumeSessions,
  summarizeInterruptedSessions,
  resolveInterruptedSessionProviders,
  type InterruptedSessionsSummary,
} from '@/lib/interruptedSessions';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { usageLimitedSessionWorkspaceId } from '@/components/usage-limit/usageLimitResumeScope';

const REFRESH_INTERVAL_MS = 30_000;
/** Readiness is recomputed in memory on this clock; it never fetches. */
const READINESS_CLOCK_MS = 30_000;
const ALL_WORKSPACES = (): boolean => true;

/** The listing shared by every effect run of one hook instance. */
interface ListingState {
  inFlight: boolean;
  /** A refresh was requested while the listing was in flight. */
  requested: boolean;
  /** The current effect's refresh; null while the hook is inactive. */
  refresh: (() => void) | null;
}

/** The latest unscoped listing. */
interface Listing {
  contextKey: string;
  groups: UsageLimitedSessionGroup[];
  /** Serialized `groups`, to keep the listing when a refresh is unchanged. */
  snapshot: string;
  /** When the listing was stored; eligibility was last re-evaluated then. */
  evaluatedAt: number;
}

/** Whether any automation's scheduled time fell within `(since, now]`. */
function scheduledTimePassed(
  activities: readonly ScheduledActivity[],
  since: number,
  now: number,
): boolean {
  return activities.some((activity) => {
    if (!activity.nextRunAt) return false;
    const next = new Date(activity.nextRunAt).getTime();
    return next > since && next <= now;
  });
}

/**
 * Every visible field of a summary, for retaining an unchanged object. Session
 * details are included so a rename or context change shows, while dismissal
 * stays keyed to the signature alone.
 */
function summaryIdentity(summary: InterruptedSessionsSummary): string {
  return `${summary.signature}\n${JSON.stringify(summary.readiness)}\n${JSON.stringify(summary.sessions)}`;
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
 * and a fetch error is not worth a flicker. A context change invalidates
 * readiness until a fresh listing arrives; a previous context's result
 * cannot expose sessions or an Advisor count while that request is pending.
 *
 * Chats with a pending usage-limit resume automation are excluded (CAN-4970):
 * the automation will resume them, so Home must not offer an immediate resume
 * as well. The hook owns the automations store subscription so this works
 * before any worktree has been opened, and reports nothing until both the
 * listing and the automations snapshot are loaded, since an unloaded
 * automations list is not an authoritative empty one. Eligibility is
 * re-evaluated against the current time whenever either input updates, so a
 * passed schedule restores its chat on the next refresh.
 *
 * Listing sessions reads the chat registry and pipeline executions in main,
 * so one listing runs at a time, across effect restarts too: refreshes
 * requested while it is in flight fold into a single follow-up listing for
 * the latest effect.
 *
 * Readiness (ready now versus waiting for a provider reset) is derived in
 * memory from the listing, the observability usage snapshot, and a 30s clock;
 * usage updates and clock ticks never trigger another listing. The current
 * workspace scope is applied at derivation time, so a scope change never
 * summarizes the previous scope's sessions.
 */
export function useInterruptedSessions(
  active: boolean,
  isWorkspaceInContext: (workspaceId: string) => boolean = ALL_WORKSPACES,
): InterruptedSessionsSummary {
  const context = useSidebarScopingContext();
  const generation = useWorkspaceContextStore(
    (state) => state.appliedGeneration,
  );
  const contextKey = context
    ? `${serializeWorkspaceContext(context)}:${generation}`
    : 'all';
  const [listed, setListed] = useState<Listing | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasSessions = listed !== null && listed.groups.length > 0;
  // Only a listing with sessions follows usage updates.
  const usage = useObservabilityStore((state) =>
    hasSessions ? state.usage : undefined,
  );
  const [stableSummary, setStableSummary] =
    useState<InterruptedSessionsSummary>(EMPTY_INTERRUPTED_SESSIONS);
  const listing = useRef<ListingState>({
    inFlight: false,
    requested: false,
    refresh: null,
  });
  const resumeModalOpen = useUsageLimitResumePromptStore((s) => s.isOpen);
  const processedResumes = useResumeQueueStore((state) =>
    state.snapshot ? resumeQueueProgress(state.snapshot).processed : 0,
  );
  const {
    activities,
    settled: automationsSettled,
    loading: automationsLoading,
    retry: retryAutomations,
  } = useScheduledResumeAutomations(active);
  const automationsReady = automationsSettled && !automationsLoading;

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
          const groups = await resolveInterruptedSessionProviders(
            await listSessions({}),
          );
          if (cancelled) return;
          // Keep an unchanged listing, so a refresh does not rerender Home,
          // unless a scheduled time has passed since the last evaluation.
          const snapshot = JSON.stringify(groups);
          setListed((previous) => {
            const now = Date.now();
            return previous?.contextKey === contextKey &&
              previous.snapshot === snapshot &&
              !scheduledTimePassed(
                useAutomationsStore.getState().activities,
                previous.evaluatedAt,
                now,
              )
              ? previous
              : { groups, snapshot, evaluatedAt: now, contextKey };
          });
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
    // Periodic and focus refreshes also retry a failed automations load.
    // The initial load belongs to the subscription effect, so an effect
    // restart never retries a failing load in a loop.
    const refreshWithAutomations = (): void => {
      retryAutomations();
      refresh();
    };
    shared.refresh = refresh;
    refresh();
    const interval = window.setInterval(
      refreshWithAutomations,
      REFRESH_INTERVAL_MS,
    );
    window.addEventListener('focus', refreshWithAutomations);
    return (): void => {
      cancelled = true;
      if (shared.refresh === refresh) shared.refresh = null;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWithAutomations);
    };
  }, [
    active,
    resumeModalOpen,
    processedResumes,
    isWorkspaceInContext,
    contextKey,
    retryAutomations,
  ]);

  // Readiness needs the provider usage snapshot, which loads lazily; a failed
  // load leaves every session ready, matching the Usage card.
  useEffect(() => {
    if (!active || !hasSessions) return;
    void useObservabilityStore
      .getState()
      .initialize()
      .catch(() => undefined);
  }, [active, hasSessions]);

  useEffect(() => {
    if (!active || !hasSessions) return;
    setNowMs(Date.now());
    const interval = window.setInterval(
      () => setNowMs(Date.now()),
      READINESS_CLOCK_MS,
    );
    return (): void => window.clearInterval(interval);
  }, [active, hasSessions]);

  const summary = useMemo(
    () =>
      listed === null ||
      listed.contextKey !== contextKey ||
      !automationsReady ||
      !hasSessions
        ? EMPTY_INTERRUPTED_SESSIONS
        : summarizeInterruptedSessions(
            excludeScheduledResumeSessions(
              scopeGroupsToContext(listed.groups, isWorkspaceInContext),
              activities,
              Date.now(),
            ),
            usage,
            nowMs,
          ),
    [
      listed,
      isWorkspaceInContext,
      automationsReady,
      activities,
      contextKey,
      hasSessions,
      usage,
      nowMs,
    ],
  );
  // Retain the last resolved object across refreshes; unresolved inputs still
  // return the empty summary below. The signature leaves out reset times, so
  // the readiness counts and shared reset are compared as well.
  const summaryKey = summaryIdentity(summary);
  if (automationsReady && summaryKey !== summaryIdentity(stableSummary)) {
    setStableSummary(summary);
  }
  return summaryKey === summaryIdentity(stableSummary)
    ? stableSummary
    : summary;
}

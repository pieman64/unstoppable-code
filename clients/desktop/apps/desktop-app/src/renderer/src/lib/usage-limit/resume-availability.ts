/**
 * Visibility logic for the Usage page/panel "Resume interrupted sessions"
 * button. The button is only offered when resuming could actually make
 * progress: a provider whose usage window is still pegged at 100% (and whose
 * reset time has not passed) would immediately re-limit anything resumed, so
 * a confirmed at-limit window suppresses the button. A window reported at
 * 100% whose `resetsAt` is already in the past is treated as stale data — the
 * limit has really reset even though the snapshot hasn't refreshed yet — and
 * does not block.
 *
 * The same rule decides which interrupted sessions Home and the resume dialog
 * offer for an immediate resume; the descriptive helpers below only add the
 * blocking window's label and reset around it.
 */
import type {
  AgentProviderType,
  AgentUsageOverview,
  ProviderRateLimitSnapshot,
  ProviderRateLimitWindow,
  UsageLimitedSessionItem,
} from '@canopy/desktop-shared/types';

const MINUTES_PER_DAY = 24 * 60;

function resetsAtMs(resetsAt: string | number | undefined): number | undefined {
  if (resetsAt === undefined) {
    return undefined;
  }
  if (typeof resetsAt === 'number') {
    return Number.isFinite(new Date(resetsAt).getTime()) ? resetsAt : undefined;
  }
  const parsed = Date.parse(resetsAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function windowBlocks(
  window: { usedPercent?: number; resetsAt?: string | number } | undefined,
  nowMs: number,
): boolean {
  if (window?.usedPercent === undefined || window.usedPercent < 100) {
    return false;
  }
  const resetMs = resetsAtMs(window.resetsAt);
  // An unparsable/absent reset time on a 100% window blocks: we can't prove
  // the limit has reset, and the rule is to hide only-if-reached, show
  // only-if-plausibly-resumable.
  return resetMs === undefined || resetMs > nowMs;
}

interface BlockingWindow {
  limit: ProviderRateLimitSnapshot;
  window: ProviderRateLimitWindow;
  /** Absent when the provider reported no parsable reset. */
  resetMs?: number;
}

/** Every window confirmed at its limit, in snapshot order (primary first). */
function blockingWindows(
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
  nowMs: number,
): BlockingWindow[] {
  const blocking: BlockingWindow[] = [];
  for (const limit of rateLimits ?? []) {
    for (const window of [limit.primary, limit.secondary]) {
      if (window && windowBlocks(window, nowMs)) {
        const parsedResetMs = resetsAtMs(window.resetsAt);
        // Describe only valid dates; keep the existing boolean rule above.
        const resetMs =
          parsedResetMs !== undefined &&
          Number.isFinite(new Date(parsedResetMs).getTime())
            ? parsedResetMs
            : undefined;
        blocking.push(
          resetMs === undefined
            ? { limit, window }
            : { limit, window, resetMs },
        );
      }
    }
  }
  return blocking;
}

/**
 * True when any rate-limit window for the provider is confirmed still at its
 * limit (>= 100% used with no elapsed reset), meaning a resume would be
 * pointless right now.
 */
export function hasBlockingRateLimit(
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
  nowMs: number,
): boolean {
  return blockingWindows(rateLimits, nowMs).length > 0;
}

function windowDurationMins(
  limit: ProviderRateLimitSnapshot,
  window: ProviderRateLimitWindow,
): number | undefined {
  if (
    window.windowDurationMins !== undefined &&
    window.windowDurationMins > 0
  ) {
    return window.windowDurationMins;
  }
  // Legacy Claude snapshots name the window instead of reporting a duration.
  const id = (limit.limitId ?? '').toLowerCase();
  if (id === 'five_hour' || id === 'session') return 5 * 60;
  if (id.startsWith('seven_day') || id.startsWith('weekly')) {
    return 7 * MINUTES_PER_DAY;
  }
  return undefined;
}

/** `Weekly limit`, `5-hour limit`, or `Usage limit` when the span is unknown. */
function windowLabel(
  limit: ProviderRateLimitSnapshot,
  window: ProviderRateLimitWindow,
): string {
  const minutes = windowDurationMins(limit, window);
  if (minutes === undefined) return 'Usage limit';
  if (minutes === 7 * MINUTES_PER_DAY) return 'Weekly limit';
  if (minutes % MINUTES_PER_DAY === 0) {
    return `${minutes / MINUTES_PER_DAY}-day limit`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

export interface BlockingRateLimitDetail {
  windowLabel: string;
  /** Known window reset to display when another block has no reset. */
  displayResetMs?: number;
  hasAdditionalUnknownReset?: true;
  /**
   * The farthest reset among the blocking windows. Absent when any blocking
   * window has no known reset, since no single time then clears every block.
   */
  resetMs?: number;
}

/**
 * Describe the block {@link hasBlockingRateLimit} reports: the window that
 * clears last and its reset. Returns `null` exactly when that helper returns
 * false. Ties keep the first window in snapshot order.
 */
export function describeBlockingRateLimit(
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
  nowMs: number,
): BlockingRateLimitDetail | null {
  const blocking = blockingWindows(rateLimits, nowMs);
  const first = blocking[0];
  if (!first) return null;
  const unknown = blocking.find((candidate) => candidate.resetMs === undefined);
  const known = blocking.filter((candidate) => candidate.resetMs !== undefined);
  let farthest = known[0];
  if (!farthest) {
    const detail: BlockingRateLimitDetail = {
      windowLabel: windowLabel(first.limit, first.window),
    };
    if (blocking.length > 1) detail.hasAdditionalUnknownReset = true;
    return detail;
  }
  for (const candidate of known) {
    if ((candidate.resetMs ?? 0) > (farthest.resetMs ?? 0))
      farthest = candidate;
  }
  if (unknown) {
    return {
      windowLabel: windowLabel(farthest.limit, farthest.window),
      displayResetMs: farthest.resetMs,
      hasAdditionalUnknownReset: true,
    };
  }
  return {
    windowLabel: windowLabel(farthest.limit, farthest.window),
    ...(farthest.resetMs === undefined ? {} : { resetMs: farthest.resetMs }),
  };
}

export type SessionResumeReadiness =
  | { state: 'ready' }
  | {
      state: 'waiting';
      provider: AgentProviderType;
      windowLabel: string;
      hasAdditionalUnknownReset?: true;
      /** Reset from the provider snapshot; the only time scheduling trusts. */
      resetMs?: number;
      /**
       * Farthest known window reset, else a future recorded session reset.
       * Display only — never blocks or schedules; unknown additional blocks
       * remain explicit in the metadata.
       */
      displayResetMs?: number;
    };

const READY: SessionResumeReadiness = { state: 'ready' };

/**
 * Whether a session can resume now under the current provider snapshot. A
 * session without a provider, or whose provider has no snapshot, stays
 * eligible, matching the Usage card. Ready means eligible under the available
 * snapshot, not that sign-in or execution will succeed.
 */
export function sessionResumeReadiness(
  session: { provider?: AgentProviderType; resetsAt?: number },
  usage: AgentUsageOverview | undefined,
  nowMs: number,
): SessionResumeReadiness {
  const provider = session.provider;
  if (!provider) return READY;
  const summary = usage?.providers.find(
    (candidate) => candidate.provider === provider,
  );
  const detail = describeBlockingRateLimit(summary?.rateLimits, nowMs);
  if (!detail) return READY;
  const fallbackMs =
    session.resetsAt !== undefined &&
    Number.isFinite(new Date(session.resetsAt).getTime()) &&
    session.resetsAt > nowMs
      ? session.resetsAt
      : undefined;
  const displayResetMs = detail.displayResetMs ?? detail.resetMs ?? fallbackMs;
  return {
    state: 'waiting',
    provider,
    windowLabel: detail.windowLabel,
    ...(detail.hasAdditionalUnknownReset
      ? { hasAdditionalUnknownReset: true }
      : {}),
    ...(detail.resetMs === undefined ? {} : { resetMs: detail.resetMs }),
    ...(displayResetMs === undefined ? {} : { displayResetMs }),
  };
}

export interface ResumeReadinessSummary {
  total: number;
  readyCount: number;
  waitingCount: number;
  /** Listed chats and pipelines; they sum to `total`. */
  chatCount: number;
  pipelineCount: number;
  /** The ready subsets of `chatCount` and `pipelineCount`. */
  readyChatCount: number;
  readyPipelineCount: number;
  /** Distinct waiting providers, in a stable alphabetical order. */
  waitingProviders: AgentProviderType[];
  /** Set only when every waiting session shares the same authoritative reset. */
  sharedWaitingResetMs?: number;
}

export const EMPTY_RESUME_READINESS_SUMMARY: ResumeReadinessSummary = {
  total: 0,
  readyCount: 0,
  waitingCount: 0,
  chatCount: 0,
  pipelineCount: 0,
  readyChatCount: 0,
  readyPipelineCount: 0,
  waitingProviders: [],
};

/** Count sessions by kind and readiness, deduplicated by full session key. */
export function summarizeResumeReadiness(
  entries: readonly {
    key: string;
    kind: UsageLimitedSessionItem['kind'];
    readiness: SessionResumeReadiness;
  }[],
): ResumeReadinessSummary {
  const byKey = new Map<
    string,
    { kind: UsageLimitedSessionItem['kind']; readiness: SessionResumeReadiness }
  >();
  entries.forEach((entry) => byKey.set(entry.key, entry));
  let readyCount = 0;
  let waitingCount = 0;
  let chatCount = 0;
  let readyChatCount = 0;
  let readyPipelineCount = 0;
  const providers = new Set<AgentProviderType>();
  const resets = new Set<number | undefined>();
  byKey.forEach(({ kind, readiness }) => {
    if (kind === 'chat') chatCount += 1;
    if (readiness.state === 'ready') {
      readyCount += 1;
      if (kind === 'chat') readyChatCount += 1;
      else readyPipelineCount += 1;
      return;
    }
    waitingCount += 1;
    providers.add(readiness.provider);
    resets.add(readiness.resetMs);
  });
  const [onlyReset] = Array.from(resets);
  const sharedWaitingResetMs =
    resets.size === 1 && onlyReset !== undefined ? onlyReset : undefined;
  return {
    total: byKey.size,
    readyCount,
    waitingCount,
    chatCount,
    pipelineCount: byKey.size - chatCount,
    readyChatCount,
    readyPipelineCount,
    waitingProviders: Array.from(providers).sort(),
    ...(sharedWaitingResetMs === undefined ? {} : { sharedWaitingResetMs }),
  };
}

/**
 * When the provider is expected to be usable again: the latest reset among
 * the windows that {@link hasBlockingRateLimit} considers blocking, in ms.
 *
 * Returns `null` both when nothing blocks and when any blocking window has a
 * missing or unparsable reset; callers tell those apart with
 * `hasBlockingRateLimit`. A mix of known and unknown blockers deliberately
 * returns `null`: one window's reset cannot show when the provider frees up
 * while another exhausted window has no reported reset.
 */
export function selectBlockingResetAtMs(
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
  nowMs: number,
): number | null {
  let latest: number | null = null;
  for (const limit of rateLimits ?? []) {
    for (const window of [limit.primary, limit.secondary]) {
      if (!windowBlocks(window, nowMs)) {
        continue;
      }
      const resetMs = resetsAtMs(window?.resetsAt);
      if (resetMs === undefined) {
        return null;
      }
      latest = latest === null ? resetMs : Math.max(latest, resetMs);
    }
  }
  return latest;
}

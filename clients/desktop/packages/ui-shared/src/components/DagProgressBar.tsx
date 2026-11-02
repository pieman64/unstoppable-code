import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import {
  runStatusGlyphState,
  type StatusGlyphState,
} from '../lib/status-glyph';
import { SpinnerStyleProvider } from './spinner-style';
import { StatusGlyph } from './StatusGlyph';
import { CometSpinner } from './CometSpinner';

/**
 * Closed enumeration of DAG job statuses understood by the shared progress
 * bar. Mirrors the desktop executor enum but is intentionally portable so
 * the web portal can map its own status strings into this shape.
 */
export type DagJobStatus =
  | 'pending'
  | 'running'
  | 'restarting'
  | 'success'
  | 'failure'
  | 'paused'
  | 'cancelled'
  | 'skipped';

export interface DagJobMeta {
  /** Job id used as the React key and the `data-job-id` selector. */
  jobId: string;
  /** Human-readable job name shown in the popover title. */
  name: string;
  status: DagJobStatus | undefined;
  /** Optional started-at ISO 8601 timestamp; drives the duration field. */
  startedAt?: string;
  /** Optional completed-at ISO 8601 timestamp; clamps the duration. */
  completedAt?: string;
  /** Optional `completed/total` step progress for the popover. Caller pre-
   * computes this so the shared component does not need to walk the
   * executor's step result map. */
  stepProgress?: string;
  /** Optional `3 / 5 complete` progress for a logical matrix group. */
  variantProgress?: string;
  /** Optional `3 succeeded · 1 failed · 1 running` aggregate variant counts. */
  variantBreakdown?: string;
  /** Optional resolved concurrency limit, rendered verbatim. */
  maxParallel?: number;
}

export interface DagProgressBarProps {
  /** Tiers of job ids, layered by dependency depth. Caller computes this
   * (desktop uses `computeDagTiers` against the executor snapshot; the web
   * portal does the equivalent from the protocol payload). */
  tiers: string[][];
  /** Job lookup keyed by job id. */
  jobs: Record<string, DagJobMeta>;
  /** Render the bar in a low-opacity muted form (used for completed runs). */
  muted?: boolean;
  /** Click handler invoked when a job dot is clicked. */
  onJobClick?: (jobId: string) => void;
}

/**
 * A job's place on the shared status glyph map. A job that has not started
 * yet is queued; a skipped one ends without an outcome, like a cancelled one.
 */
function jobGlyphState(status: DagJobStatus | undefined): StatusGlyphState {
  return runStatusGlyphState(status) ?? 'queued';
}

function getPopoverStatusBadge(status: DagJobStatus | undefined): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'running':
    case 'restarting':
      return {
        label: status,
        className: `${OPERATIONAL_STATUS_COLORS.active.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.active.foreground}`,
      };
    case 'success':
      return {
        label: 'success',
        className: `${OPERATIONAL_STATUS_COLORS.success.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.success.foreground}`,
      };
    case 'failure':
      return {
        label: 'failure',
        className: `${OPERATIONAL_STATUS_COLORS.failed.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.failed.foreground}`,
      };
    case 'paused':
      return {
        label: 'paused',
        className: `${OPERATIONAL_STATUS_COLORS.paused.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.paused.foreground}`,
      };
    case 'cancelled':
      return {
        label: 'cancelled',
        className: `${OPERATIONAL_STATUS_COLORS.paused.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.paused.foregroundMuted}`,
      };
    case 'skipped':
      return {
        label: 'skipped',
        className: `${OPERATIONAL_STATUS_COLORS.paused.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.paused.foregroundMuted}`,
      };
    default:
      return {
        label: status ?? 'pending',
        className: `${OPERATIONAL_STATUS_COLORS.paused.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.paused.foregroundMuted}`,
      };
  }
}

function formatDuration(
  startedAt: string | undefined,
  completedAt: string | undefined,
): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Pixels to scroll per arrow click. */
const SCROLL_STEP = 80;
const OVERFLOW_MEASUREMENTS_PER_FRAME = 8;
const pendingOverflowMeasurements = new Set<() => void>();
let overflowMeasurementFramePending = false;

function flushOverflowMeasurements(): void {
  overflowMeasurementFramePending = false;
  const callbacks = Array.from(pendingOverflowMeasurements).slice(
    0,
    OVERFLOW_MEASUREMENTS_PER_FRAME,
  );
  for (const callback of callbacks) {
    pendingOverflowMeasurements.delete(callback);
    callback();
  }
  if (pendingOverflowMeasurements.size > 0) {
    requestOverflowMeasurementFrame();
  }
}

function requestOverflowMeasurementFrame(): void {
  if (overflowMeasurementFramePending) return;
  overflowMeasurementFramePending = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flushOverflowMeasurements);
  } else {
    setTimeout(flushOverflowMeasurements, 0);
  }
}

function scheduleOverflowMeasurement(callback: () => void): void {
  pendingOverflowMeasurements.add(callback);
  requestOverflowMeasurementFrame();
}

function cancelOverflowMeasurement(callback: () => void): void {
  pendingOverflowMeasurements.delete(callback);
}

function ScrollArrow({
  direction,
  onClick,
}: {
  direction: 'left' | 'right';
  onClick: () => void;
}): JSX.Element {
  const isLeft = direction === 'left';
  return (
    <button
      type="button"
      aria-label={`Scroll ${direction}`}
      onClick={(e: MouseEvent<HTMLButtonElement>): void => {
        e.stopPropagation();
        onClick();
      }}
      className={`absolute inset-y-0 ${isLeft ? 'left-0' : 'right-0'} z-10 flex w-5 items-center ${isLeft ? 'justify-start bg-gradient-to-r' : 'justify-end bg-gradient-to-l'} from-base to-transparent`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="fg-primary/30 transition-colors hover:fg-primary/60"
      >
        <path d={isLeft ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
      </svg>
    </button>
  );
}

const POPOVER_APPROX_HEIGHT = 100;
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 8;

function JobDot({
  job,
  onJobClick,
}: {
  job: DagJobMeta;
  onJobClick?: (jobId: string) => void;
}): JSX.Element {
  const statusBadge = getPopoverStatusBadge(job.status);
  const isActive = job.status === 'running' || job.status === 'restarting';
  const durationLabel = isActive ? 'Elapsed' : 'Duration';
  const duration = formatDuration(job.startedAt, job.completedAt);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);

  const handleMouseEnter = (): void => {
    if (buttonRef.current) {
      setHoverRect(buttonRef.current.getBoundingClientRect());
    }
  };

  const handleMouseLeave = (): void => {
    setHoverRect(null);
  };

  const handleFocus = (): void => {
    if (buttonRef.current) {
      setHoverRect(buttonRef.current.getBoundingClientRect());
    }
  };

  const handleBlur = (): void => {
    setHoverRect(null);
  };

  let popoverStyle: React.CSSProperties | undefined;
  let flipBelow = false;
  if (hoverRect) {
    flipBelow =
      hoverRect.top < POPOVER_APPROX_HEIGHT + POPOVER_GAP + VIEWPORT_PADDING;
    const top = flipBelow
      ? hoverRect.bottom + POPOVER_GAP
      : hoverRect.top - POPOVER_GAP;
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(
        hoverRect.left + hoverRect.width / 2,
        window.innerWidth - VIEWPORT_PADDING,
      ),
    );
    popoverStyle = {
      top: `${top}px`,
      left: `${left}px`,
      transform: flipBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
    };
  }

  return (
    <div className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-job-id={job.jobId}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onClick={(e: MouseEvent<HTMLButtonElement>): void => {
          e.stopPropagation();
          onJobClick?.(job.jobId);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>): void => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
          }
        }}
        className="inline-flex h-3 w-3 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-125"
        data-status-glyph-state={jobGlyphState(job.status)}
        aria-label={`${job.name}: ${job.status ?? 'pending'}`}
      >
        <StatusGlyph state={jobGlyphState(job.status)} size={12} />
      </button>
      {hoverRect &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="pointer-events-none fixed z-tooltip min-w-45 max-w-55 rounded-lg bg-popover p-2.5 shadow-xl"
            style={popoverStyle}
          >
            <div
              className={`absolute left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-popover ${
                flipBelow
                  ? '-top-1.25 border-l border-t'
                  : '-bottom-1.25 border-b border-r'
              }`}
            />
            <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold fg-primary/80">
              <StatusGlyph state={jobGlyphState(job.status)} size={12} />
              {job.name}
            </div>
            <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
              <span>Status</span>
              <span
                className={`inline-block rounded px-1.5 py-px text-3xs font-semibold ${statusBadge.className}`}
              >
                {statusBadge.label}
              </span>
            </div>
            {duration && (
              <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
                <span>{durationLabel}</span>
                <span className="font-medium fg-primary/80">{duration}</span>
              </div>
            )}
            {job.stepProgress && (
              <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
                <span>Steps</span>
                <span className="font-medium fg-primary/80">
                  {job.stepProgress}
                </span>
              </div>
            )}
            {job.variantProgress && (
              <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
                <span>Children</span>
                <span className="font-medium fg-primary/80">
                  {job.variantProgress}
                </span>
              </div>
            )}
            {job.maxParallel !== undefined && (
              <div className="flex items-center justify-between py-0.5 text-3xs fg-secondary">
                <span>Max parallel</span>
                <span className="font-medium fg-primary/80">
                  {job.maxParallel}
                </span>
              </div>
            )}
            {job.variantBreakdown && (
              <div className="pt-0.5 text-3xs fg-secondary">
                {job.variantBreakdown}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

function DagProgressBarInner({
  tiers,
  jobs,
  muted = false,
  onJobClick,
}: DagProgressBarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevOverflowRef = useRef({ left: false, right: false });
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  const tierStructureKey = useMemo(
    () => tiers.map((tier) => tier.join('\u001f')).join('\u001e'),
    [tiers],
  );

  const activeJobKey = useMemo((): string => {
    const ids: string[] = [];
    for (const tier of tiers) {
      for (const jobId of tier) {
        const status = jobs[jobId]?.status;
        if (status === 'running' || status === 'restarting') {
          ids.push(jobId);
        }
      }
    }
    return ids.join(',');
  }, [tiers, jobs]);

  const recalcOverflow = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 2;
    const left = el.scrollLeft > threshold;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - threshold;
    if (
      left !== prevOverflowRef.current.left ||
      right !== prevOverflowRef.current.right
    ) {
      prevOverflowRef.current = { left, right };
      setOverflow({ left, right });
    }
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = (): void =>
      scheduleOverflowMeasurement(recalcOverflow);
    el.addEventListener('scroll', handleScroll, { passive: true });
    return (): void => {
      el.removeEventListener('scroll', handleScroll);
      cancelOverflowMeasurement(recalcOverflow);
    };
  }, [recalcOverflow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      scheduleOverflowMeasurement(recalcOverflow),
    );
    observer.observe(el);
    return (): void => {
      observer.disconnect();
      cancelOverflowMeasurement(recalcOverflow);
    };
  }, [recalcOverflow]);

  useEffect(() => {
    scheduleOverflowMeasurement(recalcOverflow);
    return (): void => cancelOverflowMeasurement(recalcOverflow);
  }, [tierStructureKey, recalcOverflow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || activeJobKey === '') return;
    const firstActiveId = activeJobKey.split(',')[0];
    const dotEl = el.querySelector<HTMLElement>(
      `[data-job-id="${CSS.escape(firstActiveId)}"]`,
    );
    if (!dotEl) return;
    const dotRect = dotEl.getBoundingClientRect();
    const containerRect = el.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const dotCenter =
      dotRect.left - containerRect.left + el.scrollLeft + dotRect.width / 2;
    const targetScroll = dotCenter - containerWidth / 2;
    el.scrollTo({ left: Math.max(0, targetScroll), behavior: 'smooth' });
  }, [activeJobKey]);

  const handleScrollLeft = useCallback((): void => {
    scrollRef.current?.scrollBy({ left: -SCROLL_STEP, behavior: 'smooth' });
  }, []);

  const handleScrollRight = useCallback((): void => {
    scrollRef.current?.scrollBy({ left: SCROLL_STEP, behavior: 'smooth' });
  }, []);

  if (tiers.length === 0) {
    return <div />;
  }

  return (
    <div className={`mt-2.5 border-t pt-2 ${muted ? 'opacity-70' : ''}`}>
      <div className="relative flex items-center">
        {overflow.left && (
          <ScrollArrow direction="left" onClick={handleScrollLeft} />
        )}
        <div
          ref={scrollRef}
          className="scrollbar-hide flex min-w-0 flex-1 items-center overflow-x-auto"
        >
          {tiers.map((tier, tierIndex) => (
            <div key={tierIndex} className="contents">
              {tierIndex > 0 && (
                <span className="px-px text-3xs leading-none fg-primary/15 select-none">
                  &middot;
                </span>
              )}
              <div
                data-testid="dag-progress-tier"
                // The tier chip is 18px tall (12px status glyphs inside 3px of
                // padding), and its corner keeps the 24px `rounded-md`
                // control's proportion at that height: `--radius-md` less 2px.
                // The round glyphs inside carry no corner of their own to nest.
                className="flex items-center gap-1.25 rounded-[calc(var(--radius-md)-2px)] bg-fg-primary/[0.025] px-1.5 py-0.75"
              >
                {tier.map((jobId) => {
                  const job = jobs[jobId] ?? {
                    jobId,
                    name: jobId,
                    status: undefined,
                  };
                  return (
                    <JobDot key={jobId} job={job} onJobClick={onJobClick} />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {overflow.right && (
          <ScrollArrow direction="right" onClick={handleScrollRight} />
        )}
      </div>
    </div>
  );
}

export const DagProgressBar = memo(DagProgressBarInner);

/**
 * The progress bar inline, for the composer's background drawer rows: the
 * same tiers and glyphs with no tier chips, popovers or clicks, and
 * a hairline between tiers. Decorative: the row names the run's state, and
 * its inspector holds the full bar. A strip is a row of circles, so a running
 * job always draws the round comet, whatever spinner style the host uses.
 */
export const DagProgressDots = memo(function DagProgressDots({
  tiers,
  jobs,
  appearance = 'glyphs',
}: Pick<DagProgressBarProps, 'tiers' | 'jobs'> & {
  readonly appearance?: 'glyphs' | 'tiny';
}): JSX.Element | null {
  if (tiers.length === 0) return null;
  if (appearance === 'tiny')
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1.5"
        aria-hidden="true"
        data-testid="dag-progress-dots"
      >
        {tiers.flat().map((jobId) => {
          const status = jobs[jobId]?.status;
          const running = status === 'running' || status === 'restarting';
          const color =
            status === 'success'
              ? OPERATIONAL_STATUS_COLORS.success.background
              : status === 'failure'
                ? OPERATIONAL_STATUS_COLORS.failed.background
                : status === 'paused'
                  ? 'bg-fg-warning-strong'
                  : 'bg-fg-tertiary/40';
          return (
            <span
              key={jobId}
              className="inline-flex h-4 items-center justify-center"
              data-status-glyph-state={jobGlyphState(status)}
            >
              <span
                className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${running ? 'h-3 w-3' : `h-1 w-1 ${color}`}`}
              >
                {running && (
                  <>
                    <span className="h-1 w-1 rounded-full bg-fg-primary" />
                    <span className="absolute inset-0 rounded-full border-2 border-current fg-primary/25" />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <CometSpinner sizePx={12} tone="primary" />
                    </span>
                  </>
                )}
              </span>
            </span>
          );
        })}
      </span>
    );
  return (
    <SpinnerStyleProvider value="comet">
      <span
        className="inline-flex shrink-0 items-center gap-1"
        aria-hidden="true"
        data-testid="dag-progress-dots"
      >
        {tiers.map((tier, tierIndex) => (
          <span key={tierIndex} className="inline-flex items-center gap-1">
            {tierIndex > 0 && (
              <span
                className="h-px w-1.5 bg-fg-primary/20"
                data-dag-tier-separator=""
              />
            )}
            {/* 3px between parallel jobs: apart, but still one tier. */}
            <span className="inline-flex items-center gap-0.75">
              {tier.map((jobId) => {
                const state = jobGlyphState(jobs[jobId]?.status);
                return (
                  <span
                    key={jobId}
                    className="inline-flex"
                    data-status-glyph-state={state}
                  >
                    <StatusGlyph state={state} size={12} />
                  </span>
                );
              })}
            </span>
          </span>
        ))}
      </span>
    </SpinnerStyleProvider>
  );
});

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AgentAssistantIcon } from '@canopy/ui-shared/icons';
import { statusBadgeClassName } from '@canopy/ui-shared/lib';
import { useWindowPositionInvalidation } from '@/hooks/useWindowPositionInvalidation';
import type {
  ExecutionSummary,
  PipelineAdvisorInefficiency,
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';
import {
  advisorErrorIsStale,
  computeAdvisorPreviewPosition,
  formatAdvisorEta,
  usePipelineAdvisorEtaNow,
} from './PipelineAdvisorEta';
import { PipelineAdvisorMarkdownText } from './PipelineAdvisorMarkdown';

export function AdvisorEtaBadge({
  snapshot,
  pipelineStatus,
  interactive = true,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionSummary['status'];
  interactive?: boolean;
}): JSX.Element | null {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const etaNowMs = usePipelineAdvisorEtaNow(Boolean(snapshot?.latestReport));
  if (!snapshot) {
    return null;
  }
  const etaText =
    formatAdvisorEta(snapshot, pipelineStatus, etaNowMs) ?? 'Advisor pending';
  const stale = advisorErrorIsStale(snapshot);
  // Shared pipeline-row status badge: active tint while the advisor is
  // healthy, the warning tint once its last update failed.
  const className = statusBadgeClassName(stale ? 'warning' : 'active');
  const showPreview = interactive && (hoverOpen || focusOpen);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={
        interactive
          ? (): void => {
              setHoverOpen(true);
            }
          : undefined
      }
      onMouseLeave={
        interactive
          ? (): void => {
              setHoverOpen(false);
            }
          : undefined
      }
    >
      <span
        tabIndex={interactive ? 0 : undefined}
        role="status"
        aria-label="Pipeline Advisor ETA"
        ref={badgeRef}
        className={interactive ? `${className} focus-ring` : className}
        onFocus={
          interactive
            ? (): void => {
                setFocusOpen(true);
              }
            : undefined
        }
        onBlur={
          interactive
            ? (): void => {
                setFocusOpen(false);
              }
            : undefined
        }
      >
        <AgentAssistantIcon className="h-3 w-3" />
        <span>{etaText}</span>
        {stale ? <span aria-hidden="true">!</span> : null}
      </span>
      {showPreview ? (
        <AdvisorPreviewPopover
          snapshot={snapshot}
          pipelineStatus={pipelineStatus}
          anchorRef={badgeRef}
          currentTimeMs={etaNowMs}
        />
      ) : null}
    </span>
  );
}

function severityLabel(
  severity: PipelineAdvisorInefficiency['severity'],
): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'warning':
      return 'Warning';
    case 'info':
    default:
      return 'Info';
  }
}

export function AdvisorPreviewPopover({
  snapshot,
  pipelineStatus,
  anchorRef,
  currentTimeMs = Date.now(),
}: {
  snapshot: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionSummary['status'];
  anchorRef?: RefObject<HTMLElement | null>;
  currentTimeMs?: number;
}): JSX.Element {
  const popoverRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const report: PipelineAdvisorReport | undefined = snapshot.latestReport;
  const stale = advisorErrorIsStale(snapshot);
  const healthSummary =
    report?.health.summary ??
    (stale
      ? 'Advisor update failed before a health assessment.'
      : 'Waiting for first assessment.');
  const etaText =
    formatAdvisorEta(snapshot, pipelineStatus, currentTimeMs) ??
    'Advisor pending';
  const inefficiencies = report?.inefficiencies ?? [];
  const errorMessage = stale ? snapshot.lastError?.message : undefined;

  const updatePosition = useCallback((): void => {
    const anchorEl = anchorRef?.current;
    if (!anchorEl) {
      return;
    }
    const popoverEl = popoverRef.current;
    const next = computeAdvisorPreviewPosition({
      anchorRect: anchorEl.getBoundingClientRect(),
      popoverWidth: popoverEl?.offsetWidth || undefined,
      popoverHeight: popoverEl?.offsetHeight ?? 0,
    });
    setPosition((previous) => {
      if (
        previous &&
        previous.top === next.top &&
        previous.left === next.left
      ) {
        return previous;
      }
      return next;
    });
  }, [anchorRef]);

  useLayoutEffect((): void => {
    if (!anchorRef) {
      return;
    }
    updatePosition();
  }, [anchorRef, updatePosition]);

  useWindowPositionInvalidation(Boolean(anchorRef), updatePosition);

  const tooltip = (
    <span
      ref={popoverRef}
      role="tooltip"
      className={
        anchorRef
          ? 'pointer-events-none fixed z-tooltip w-70 rounded-md bg-popover px-3 py-2 text-left text-2xs leading-snug shadow-tooltip fg-primary'
          : 'pointer-events-none absolute right-0 top-full z-30 mt-1 w-70 rounded-md bg-popover px-3 py-2 text-left text-2xs leading-snug shadow-tooltip fg-primary'
      }
      style={
        anchorRef
          ? position
            ? { top: position.top, left: position.left }
            : { visibility: 'hidden' }
          : undefined
      }
    >
      <span className="block text-2xs font-semibold fg-secondary">
        Pipeline Advisor
      </span>
      <span className="mt-1.5 block">
        <span className="block text-3xs font-medium fg-secondary/70">
          Health
        </span>
        <PipelineAdvisorMarkdownText className="mt-0.5 block break-words fg-primary/85">
          {healthSummary}
        </PipelineAdvisorMarkdownText>
      </span>
      <span className="mt-1.5 block">
        <span className="block text-3xs font-medium fg-secondary/70">ETA</span>
        <span className="mt-0.5 block break-words fg-primary/85">
          {etaText}
        </span>
      </span>
      <span className="mt-1.5 block">
        <span className="block text-3xs font-medium fg-secondary/70">
          Inefficiencies
        </span>
        {inefficiencies.length === 0 ? (
          <span className="mt-0.5 block fg-primary/85">
            No inefficiencies flagged.
          </span>
        ) : (
          <span className="mt-0.5 block space-y-0.5">
            {inefficiencies.slice(0, 2).map((item, index) => (
              <span
                key={`${item.title}-${index}`}
                className="block break-words"
              >
                <span className="font-medium fg-primary/90">
                  {severityLabel(item.severity)}:
                </span>{' '}
                <PipelineAdvisorMarkdownText className="fg-primary/80">
                  {item.title}
                </PipelineAdvisorMarkdownText>
              </span>
            ))}
          </span>
        )}
      </span>
      {errorMessage ? (
        <span className="mt-1.5 block break-words fg-warning">
          Advisor update failed: {errorMessage}
        </span>
      ) : null}
    </span>
  );

  return anchorRef && typeof document !== 'undefined'
    ? createPortal(tooltip, document.body)
    : tooltip;
}

'use client';

import { useLayoutEffect, useRef, type JSX } from 'react';
import { SIDEBAR_ROW_TEXT_INSET_CLASSNAME } from './sidebar-item-classes';

export interface ProjectListPaginationProps {
  readonly remainingCount: number;
  readonly expanded: boolean;
  readonly onShowMore: () => void;
  readonly onShowLess: () => void;
  readonly touchTargets?: boolean;
  /**
   * Reads `More` / `Less` with no count. The accessible name keeps the full
   * description. Desktop turns it on under early access.
   */
  readonly compactLabels?: boolean;
}

/** Quiet sidebar disclosure shared by the desktop and web project lists. */
export function ProjectListPagination({
  remainingCount,
  expanded,
  onShowMore,
  onShowLess,
  touchTargets = false,
  compactLabels = false,
}: ProjectListPaginationProps): JSX.Element | null {
  const moreRef = useRef<HTMLButtonElement>(null);
  const lessRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (moreRef.current ?? lessRef.current)?.focus();
  }, [remainingCount, expanded]);
  if (remainingCount === 0 && !expanded) return null;
  // A text-only row in the project list, so the first label starts on the
  // title column the project names use. A second button on the same line
  // follows it at the ordinary padding instead of repeating the inset.
  const buttonClassName = (firstInRow: boolean): string =>
    `focus-ring flex ${
      touchTargets ? 'min-h-11' : 'h-7'
    } min-w-0 items-center gap-1.5 rounded-row ${
      firstInRow ? `${SIDEBAR_ROW_TEXT_INSET_CLASSNAME} pr-1.5` : 'px-1.5'
    } text-left text-s font-normal fg-tertiary hover:bg-subtle hover:fg-primary`;
  const showMore = remainingCount > 0;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="sidebar-projects-pagination"
    >
      {showMore && (
        <button
          ref={moreRef}
          type="button"
          className={buttonClassName(true)}
          data-testid="sidebar-projects-show-more"
          aria-label={`Show more projects (${remainingCount} remaining)`}
          onClick={() => {
            restoreFocus.current = true;
            onShowMore();
          }}
        >
          {compactLabels ? (
            'More'
          ) : (
            <>
              Show more <span className="tabular-nums">({remainingCount})</span>
            </>
          )}
        </button>
      )}
      {expanded && (
        <button
          ref={lessRef}
          type="button"
          className={buttonClassName(!showMore)}
          data-testid="sidebar-projects-show-less"
          aria-label="Show fewer projects"
          onClick={() => {
            restoreFocus.current = true;
            onShowLess();
          }}
        >
          {compactLabels ? 'Less' : 'Show less'}
        </button>
      )}
    </div>
  );
}

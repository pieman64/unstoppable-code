// Compact eye-tracking icon button used by pipeline cards, the pipeline
// details modal, and chat panels. The button is intentionally driven by a
// prop-supplied watcher list so the caller controls filtering and the
// component stays stateless apart from local tooltip/modal toggles.
//
// The button:
//  - renders nothing when `watchers.length === 0` (so unwatched surfaces
//    don't reserve dead space),
//  - shows a count badge when the surface has more than one matching
//    watcher,
//  - opens an inline hover/focus preview listing up to five rows so the
//    user can decide whether to click in,
//  - opens the shared `WatcherManagementModal` on click, which handles all
//    jump and delete interactions.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import { ChatComposerToolbarChip } from '@canopy/ui-shared';
import { AppAdvisorWatcherIcon, WatcherEyeIcon } from '@canopy/ui-shared/icons';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import {
  formatGitHubRunSampleLabel,
  formatRelativeTime,
  githubRunSampleOverflow,
  githubWatcherTargetDisplay,
  liveWatcherDestinationTitle,
  triggerTitle,
  watcherDestinationDisplay,
  watcherOwnerDelegateDisplay,
  watcherTargetDisplay,
} from './watcherDisplay';
import { WatcherManagementModal } from './WatcherManagementModal';

export interface WatcherManagementButtonProps {
  /** Pre-filtered watcher list this button manages. */
  watchers: AppAdvisorWatcherSummary[];
  /** Title rendered in the management modal header. */
  modalTitle: string;
  /** Body text rendered in the modal when no watchers remain. */
  modalEmptyMessage: string;
  /** Accessible label for the icon button. */
  ariaLabel: string;
  /** `data-testid` for the button. */
  dataTestId: string;
  /** Icon used in the button. Defaults to the target-side eye tracking icon. */
  icon?: 'eye' | 'bigtop';
  /** Upper tooltip title. Defaults to the target-side copy. */
  tooltipTitle?: string;
  /** Extra classes appended to the button container (optional). */
  className?: string;
  /**
   * `composer-chip` draws the chat composer's capsule chip beside +, the
   * Plan chip's shape: the glyph alone in a circle for one watcher, the
   * glyph and the count past one. `icon` (the default) is the compact icon
   * button other surfaces use.
   */
  appearance?: 'icon' | 'composer-chip';
  /**
   * Optional override for the jump-to-chat handler. Forwarded to the modal.
   * Useful for the Automations Watchers tab which wants a different
   * close/navigation flow than the default management button.
   */
  onJumpToChat?: (
    watcher: AppAdvisorWatcherSummary,
  ) => { ok: true } | { ok: false; error: string };
}

const TOOLTIP_GAP = 8;
const VIEWPORT_PADDING = 8;
const MAX_TOOLTIP_ROWS = 5;
// One grouped GitHub watcher is a single tooltip row; inside that row we sample
// at most three of its watched runs before collapsing the rest into `+N more`.
const MAX_TOOLTIP_SAMPLE_RUNS = 3;

export function WatcherManagementButton({
  watchers,
  modalTitle,
  modalEmptyMessage,
  ariaLabel,
  dataTestId,
  icon = 'eye',
  tooltipTitle = 'Active watchers',
  className,
  appearance = 'icon',
  onJumpToChat,
}: WatcherManagementButtonProps): JSX.Element | null {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const visibleTooltipRows = useMemo(
    () => watchers.slice(0, MAX_TOOLTIP_ROWS),
    [watchers],
  );
  const liveDestinationTitles = useChatSidebarStore(
    useShallow((s) =>
      visibleTooltipRows.map((watcher) =>
        liveWatcherDestinationTitle(s.worktrees, watcher.destination),
      ),
    ),
  );
  const overflowCount = Math.max(0, watchers.length - MAX_TOOLTIP_ROWS);

  // When the underlying list goes empty (e.g. the last watcher was deleted
  // while the modal was open) close the modal so the caller can unmount us.
  useEffect(() => {
    if (watchers.length === 0) {
      setTooltipOpen(false);
      setModalOpen(false);
    }
  }, [watchers.length]);

  const updateTooltipPosition = useCallback((): void => {
    const button = buttonRef.current;
    const tooltip = tooltipRef.current;
    if (!button || !tooltip) return;
    const rect = button.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const preferredTop = rect.top - tooltipHeight - TOOLTIP_GAP;
    const fallbackTop = rect.bottom + TOOLTIP_GAP;
    const top =
      preferredTop >= VIEWPORT_PADDING
        ? preferredTop
        : Math.min(
            fallbackTop,
            Math.max(
              VIEWPORT_PADDING,
              window.innerHeight - tooltipHeight - VIEWPORT_PADDING,
            ),
          );
    const centeredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      window.innerWidth - tooltipWidth - VIEWPORT_PADDING,
    );
    const left = Math.min(Math.max(VIEWPORT_PADDING, centeredLeft), maxLeft);
    setTooltipPos((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, []);

  useLayoutEffect(() => {
    if (!tooltipOpen) {
      setTooltipPos(null);
      return undefined;
    }
    updateTooltipPosition();
    const handleResize = (): void => {
      updateTooltipPosition();
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    return (): void => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [tooltipOpen, watchers, updateTooltipPosition]);

  const closeModal = useCallback((): void => {
    setModalOpen(false);
  }, []);

  if (watchers.length === 0) return null;

  const buttonClasses = [
    'focus-ring inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-fg-info/30 bg-info-subtle px-1.5 fg-info transition hover:bg-info-subtle/80',
    watchers.length === 1 ? 'w-7 px-0' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const openModal = (): void => {
    setTooltipOpen(false);
    setModalOpen(true);
  };

  return (
    <>
      {appearance === 'composer-chip' ? (
        // The wrapper carries the hover preview and stops the click from
        // reaching the composer, which would refocus its editor.
        <span
          className="inline-flex shrink-0"
          onMouseEnter={(): void => setTooltipOpen(true)}
          onMouseLeave={(): void => setTooltipOpen(false)}
          onFocus={(): void => setTooltipOpen(true)}
          onBlur={(): void => setTooltipOpen(false)}
          onClick={(event): void => event.stopPropagation()}
        >
          <ChatComposerToolbarChip
            variant="capsule"
            buttonRef={buttonRef}
            active
            activeTone="status-active"
            ariaLabel={ariaLabel}
            aria-describedby={tooltipOpen ? tooltipId : undefined}
            ariaHasPopup="dialog"
            dataTestId={dataTestId}
            onClick={openModal}
            icon={
              icon === 'bigtop' ? (
                <AppAdvisorWatcherIcon width={16} height={16} />
              ) : (
                <WatcherEyeIcon width={16} height={16} />
              )
            }
            {...(watchers.length > 1
              ? {
                  trailing: (
                    <span
                      data-testid={`${dataTestId}-count`}
                      className="tabular-nums"
                    >
                      {watchers.length}
                    </span>
                  ),
                }
              : {})}
          />
        </span>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          aria-label={ariaLabel}
          aria-describedby={tooltipOpen ? tooltipId : undefined}
          data-testid={dataTestId}
          className={buttonClasses}
          onMouseEnter={(): void => setTooltipOpen(true)}
          onMouseLeave={(): void => setTooltipOpen(false)}
          onFocus={(): void => setTooltipOpen(true)}
          onBlur={(): void => setTooltipOpen(false)}
          onClick={(event): void => {
            // Pipeline rows and chat panels treat the surrounding click area as
            // their own selection target — stop propagation so opening the
            // watcher modal does not also open the pipeline detail modal /
            // refocus the chat composer.
            event.stopPropagation();
            openModal();
          }}
        >
          {icon === 'bigtop' ? (
            <AppAdvisorWatcherIcon width={15} height={15} />
          ) : (
            <WatcherEyeIcon width={15} height={15} />
          )}
          {watchers.length > 1 && (
            <span
              data-testid={`${dataTestId}-count`}
              className="text-3xs font-semibold leading-none fg-info"
            >
              {watchers.length}
            </span>
          )}
        </button>
      )}

      {tooltipOpen &&
        watchers.length > 0 &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            data-testid={`${dataTestId}-tooltip`}
            className="pointer-events-none fixed z-tooltip w-72 rounded-md bg-popover px-3 py-2 text-xs font-normal fg-primary shadow-tooltip"
            style={
              tooltipPos
                ? { top: tooltipPos.top, left: tooltipPos.left }
                : { visibility: 'hidden', top: 0, left: 0 }
            }
          >
            <div className="mb-1.5 text-xs font-normal fg-secondary">
              {tooltipTitle}
            </div>
            <ul className="flex flex-col gap-1.5">
              {visibleTooltipRows.map((watcher, index) => {
                const target = watcherTargetDisplay(watcher.target);
                const github = githubWatcherTargetDisplay(watcher.target);
                const sampleRows =
                  github?.sample.slice(0, MAX_TOOLTIP_SAMPLE_RUNS) ?? [];
                const sampleOverflow = github
                  ? githubRunSampleOverflow(github, sampleRows.length)
                  : 0;
                const owner = watcher.ownerDelegate
                  ? watcherOwnerDelegateDisplay(watcher.ownerDelegate)
                  : null;
                return (
                  <li
                    key={watcher.id}
                    className="flex flex-col gap-0.5 text-xs leading-tight"
                  >
                    <span className="truncate font-medium fg-primary">
                      {watcher.label || target.title}
                    </span>
                    <span className="truncate text-2xs fg-secondary">
                      {triggerTitle(watcher.trigger)}
                    </span>
                    <span
                      className="truncate text-2xs fg-secondary"
                      data-testid={`${dataTestId}-destination-${watcher.id}`}
                    >
                      Subscribed chat:{' '}
                      {watcherDestinationDisplay(
                        watcher.destination,
                        liveDestinationTitles[index],
                      )}
                    </span>
                    {owner && (
                      <span
                        className="truncate text-2xs fg-secondary"
                        data-testid={`${dataTestId}-owner-${watcher.id}`}
                      >
                        Delegate: {owner.name}
                        {owner.detail ? ` · ${owner.detail}` : ''}
                      </span>
                    )}
                    {github ? (
                      <>
                        {github.subtitle && (
                          <span className="truncate text-2xs fg-secondary">
                            {github.subtitle}
                          </span>
                        )}
                        {sampleRows.map((run) => (
                          <span
                            key={`${run.repository}#${run.runId}`}
                            className="truncate text-3xs fg-secondary/80"
                          >
                            {formatGitHubRunSampleLabel(run)}
                          </span>
                        ))}
                        {sampleOverflow > 0 && (
                          <span className="text-3xs fg-secondary/80">
                            +{sampleOverflow} more
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-3xs fg-secondary/80">
                        {formatRelativeTime(watcher.createdAt)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {overflowCount > 0 && (
              <div className="mt-1.5 text-2xs fg-secondary">
                +{overflowCount} more
              </div>
            )}
          </div>,
          document.body,
        )}

      {modalOpen && (
        <WatcherManagementModal
          title={modalTitle}
          emptyMessage={modalEmptyMessage}
          watchers={watchers}
          onClose={closeModal}
          onJumpToChat={onJumpToChat}
        />
      )}
    </>
  );
}

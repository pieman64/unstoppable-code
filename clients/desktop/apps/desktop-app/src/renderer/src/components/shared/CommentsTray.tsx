import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ResizeHandle } from '@/components/shared/ResizeHandle';
import { Button } from '@/components/shared/Button';
import { ChevronTopMediumIcon as AppCatalogChevronTopMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * Shared bottom "comments tray" shell — a resizable, always-mounted panel
 * listing active + archived (resolved/outdated) comment threads, with a
 * general (unanchored) note composer and a batched submit-to-chat button.
 * Extracted from the Code Review modal's original tray
 * (`CodeChangesPanel.tsx`) so the Plan Explore modal can reuse the exact same
 * behavior instead of re-implementing it — see `PlanDocumentPanel.tsx` for the
 * plan-explore instantiation.
 *
 * `T` is the caller's own thread type (`ReviewCommentThread` /
 * `PlanCommentThread`); this component never inspects thread internals beyond
 * counting them — rendering is fully delegated to `renderThread`.
 *
 * Resize smoothing: dragging the top handle writes the tray's `flexBasis`
 * directly to the DOM (rAF-batched, coalescing every mousemove in a frame
 * into one write) instead of going through `setState` on every move, which
 * was the source of the reported "a little jumpy" tray resize — every move
 * re-rendered this panel's full thread list. `onHeightCommit` fires once on
 * mouseup with the final value so the caller can persist it; the caller's
 * `heightPercent` prop is otherwise only read to seed the initial/rest-state
 * `flexBasis`, so there is no state-vs-paint snap-back.
 */
export interface CommentsTrayProps<T> {
  /** Ancestor whose bounding-rect height defines the drag's 0–100% range —
   * the handle sits at the tray's top edge, so the tray occupies everything
   * below the pointer within this container (mirrors the original
   * `panelRootRef`-relative math in `CodeChangesPanel.tsx`). */
  containerRef: RefObject<HTMLElement | null>;
  /** Committed height, as a percentage of `containerRef`'s height. */
  heightPercent: number;
  /** Clamp a raw dragged percentage to the caller's allowed range. */
  clampHeightPercent: (value: number) => number;
  /** Fires once on mouseup with the final (already clamped) percentage. */
  onHeightCommit: (percent: number) => void;
  resizeAriaLabel: string;
  containerTestId: string;
  /** Exposes the tray's root DOM node to the caller (e.g. so the plan
   * document panel can scroll a specific card into view when its anchored
   * highlight is clicked). Optional — most callers don't need it. */
  rootRef?: Ref<HTMLDivElement>;
  /** Total thread count shown in the "Comments (N)" header. */
  totalCount: number;
  activeThreads: T[];
  archivedThreads: T[];
  renderThread: (thread: T) => JSX.Element;
  /** When true, hides the add-note affordance (e.g. viewing a read-only plan
   * revision). Existing threads still render and staged submits stay
   * available. */
  readOnly?: boolean;
  /** Stage a general (unanchored) note. The tray owns the composer's local
   * open/draft state and resets it after calling this. */
  onAddNote: (body: string) => void;
  stagedCount: number;
  /** Submit the staged comments. When omitted, no submit action renders
   * (the surface stages comments without handing them off yet). */
  onSubmitStaged?: () => void;
  emptyStateText: string;
  addNoteTestId: string;
  noteInputTestId: string;
  noteSaveTestId: string;
  submitTestId: string;
  archivedToggleTestId: string;
  /** When true, only the header row shows — the composer, thread list, and
   * resize handle are hidden and the tray shrinks to the header. Requires
   * `onToggleCollapsed` to be actionable; defaults to expanded. */
  collapsed?: boolean;
  /** Toggle the collapsed state. When omitted, the collapse affordance is not
   * rendered (the tray stays always-expanded, preserving prior behavior). */
  onToggleCollapsed?: () => void;
  /** Test id for the collapse/expand toggle button. */
  collapseToggleTestId?: string;
  /** Optional trailing header content (e.g. none currently; reserved for
   * parity with future per-modal affordances). */
  headerExtra?: ReactNode;
}

export function CommentsTray<T>({
  containerRef,
  heightPercent,
  clampHeightPercent,
  onHeightCommit,
  resizeAriaLabel,
  containerTestId,
  rootRef,
  totalCount,
  activeThreads,
  archivedThreads,
  renderThread,
  readOnly = false,
  onAddNote,
  stagedCount,
  onSubmitStaged,
  emptyStateText,
  addNoteTestId,
  noteInputTestId,
  noteSaveTestId,
  submitTestId,
  archivedToggleTestId,
  collapsed = false,
  onToggleCollapsed,
  collapseToggleTestId,
  headerExtra,
}: CommentsTrayProps<T>): JSX.Element {
  // A collapsed tray without a toggle would strand callers in an
  // inaccessible state. Keep the legacy always-expanded behavior unless the
  // caller supplies the affordance needed to restore the tray.
  const isCollapsed = collapsed && onToggleCollapsed !== undefined;
  const trayElRef = useRef<HTMLDivElement | null>(null);
  const setTrayEl = useCallback(
    (node: HTMLDivElement | null): void => {
      trayElRef.current = node;
      if (typeof rootRef === 'function') {
        rootRef(node);
      } else if (rootRef) {
        rootRef.current = node;
      }
    },
    [rootRef],
  );

  const pendingPercentRef = useRef(heightPercent);
  const isDraggingRef = useRef(false);
  const resizeRafRef = useRef<number | null>(null);

  useEffect(() => {
    pendingPercentRef.current = heightPercent;
  }, [heightPercent]);

  useEffect(
    () => (): void => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
      }
    },
    [],
  );

  const applyHeight = useCallback((percent: number): void => {
    const el = trayElRef.current;
    if (el) {
      el.style.flexBasis = `${percent}%`;
    }
  }, []);

  const scheduleHeightPaint = useCallback(
    (percent: number): void => {
      pendingPercentRef.current = percent;
      if (resizeRafRef.current !== null) {
        return;
      }
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        applyHeight(pendingPercentRef.current);
      });
    },
    [applyHeight],
  );

  const handleDrag = useCallback(
    (clientY: number): void => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.height <= 0) {
        return;
      }
      isDraggingRef.current = true;
      // The handle sits at the tray's top edge, so the tray occupies
      // everything below the pointer.
      const nextPercent = clampHeightPercent(
        ((rect.bottom - clientY) / rect.height) * 100,
      );
      scheduleHeightPaint(nextPercent);
    },
    [containerRef, clampHeightPercent, scheduleHeightPaint],
  );

  const handleCommit = useCallback((): void => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
      applyHeight(pendingPercentRef.current);
    }
    isDraggingRef.current = false;
    onHeightCommit(pendingPercentRef.current);
  }, [applyHeight, onHeightCommit]);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  const submitNote = useCallback((): void => {
    const body = noteDraft.trim();
    if (body.length === 0) {
      return;
    }
    onAddNote(body);
    setNoteDraft('');
    setAddingNote(false);
  }, [noteDraft, onAddNote]);

  return (
    <>
      {/* When collapsed there is nothing to resize, so the handle is hidden
          and the tray shrinks to just its header row. */}
      {!isCollapsed && (
        <ResizeHandle
          orientation="vertical"
          onDrag={handleDrag}
          onCommit={handleCommit}
          divider
          ariaLabel={resizeAriaLabel}
        />
      )}
      <div
        ref={setTrayEl}
        data-testid={containerTestId}
        // `flex-basis` (not `height`) sizes this correctly: a percentage
        // flex-basis resolves against the flex column's main size, whereas a
        // percentage `height` on a flex child doesn't reliably resolve here
        // and collapses to content height. `grow-0 shrink-0` pin it to that
        // basis so the sibling above (flex-1) takes the rest. While a drag is
        // active, a re-render (e.g. new threads streaming in) must paint the
        // latest dragged value, not the stale committed prop — otherwise the
        // tray would snap back until the next mousemove repaints it. Collapsed,
        // it uses content-height (`flex-basis: auto`) so only the header shows.
        style={
          isCollapsed
            ? undefined
            : {
                flexBasis: `${
                  isDraggingRef.current
                    ? pendingPercentRef.current
                    : heightPercent
                }%`,
              }
        }
        className="flex min-h-0 shrink-0 grow-0 flex-col overflow-auto border-t bg-base"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <div className="flex items-center gap-1.5">
            {onToggleCollapsed && (
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                className="-ml-1"
                data-testid={collapseToggleTestId}
                onClick={onToggleCollapsed}
                aria-label={
                  isCollapsed ? 'Expand comments' : 'Collapse comments'
                }
                aria-expanded={!isCollapsed}
              >
                <AppCatalogChevronTopMediumIcon
                  width="14"
                  height="14"
                  className={`transition-transform ${isCollapsed ? '' : 'rotate-180'}`}
                />
              </Button>
            )}
            <span className="text-xs font-semibold fg-primary">
              Comments ({totalCount})
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {headerExtra}
            {/* Hidden while collapsed: its composer lives in the collapsed
                body, so the button would otherwise open a composer nothing
                can see. */}
            {!readOnly && !isCollapsed && (
              <Button
                variant="secondary"
                size="compact"
                data-testid={addNoteTestId}
                onClick={(): void => {
                  setAddingNote((prev) => !prev);
                  setNoteDraft('');
                }}
              >
                + Add comment
              </Button>
            )}
            {/* Not gated on readOnly: staged drafts always belong to the
                latest revision, so submitting stays available even while
                viewing an older one (matches the original plan tray). */}
            {stagedCount > 0 && onSubmitStaged && (
              <Button
                variant="primary"
                size="compact"
                data-testid={submitTestId}
                onClick={onSubmitStaged}
              >
                Submit {stagedCount} comment
                {stagedCount === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </div>

        <div
          data-testid={`${containerTestId}-body`}
          aria-hidden={isCollapsed}
          // Blocked from session replay: the threads quote file and plan
          // content. The tray's header ("Comments (n)") stays recorded.
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} ${isCollapsed ? 'hidden' : 'block'}`}
        >
          {addingNote && !readOnly && (
            <div className="px-3 pb-2">
              <textarea
                value={noteDraft}
                onChange={(event): void => setNoteDraft(event.target.value)}
                onKeyDown={(event): void => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    submitNote();
                  }
                }}
                placeholder="Add a general comment… (Enter to save, Shift+Enter for a new line)"
                rows={2}
                autoFocus
                data-testid={noteInputTestId}
                className="focus-ring w-full resize-none rounded-md border bg-fg-primary/[0.04] px-2 py-1 text-xs fg-primary"
              />
              <div className="mt-1 flex items-center justify-end gap-1.5">
                <Button
                  size="compact"
                  onClick={(): void => {
                    setAddingNote(false);
                    setNoteDraft('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={submitNote}
                  disabled={noteDraft.trim().length === 0}
                  data-testid={noteSaveTestId}
                >
                  Add
                </Button>
              </div>
            </div>
          )}

          {totalCount > 0 ? (
            <div className="flex flex-col gap-2 px-3 pb-3">
              {activeThreads.map(renderThread)}
              {archivedThreads.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="compact"
                    className="mt-1 self-start"
                    data-testid={archivedToggleTestId}
                    onClick={(): void => setArchivedOpen((prev) => !prev)}
                  >
                    {archivedOpen ? 'Hide' : 'Show'} resolved &amp; outdated (
                    {archivedThreads.length})
                  </Button>
                  {archivedOpen && archivedThreads.map(renderThread)}
                </>
              )}
            </div>
          ) : (
            !addingNote && (
              <p className="px-3 pb-3 text-2xs fg-secondary">
                {emptyStateText}
              </p>
            )
          )}
        </div>
      </div>
    </>
  );
}

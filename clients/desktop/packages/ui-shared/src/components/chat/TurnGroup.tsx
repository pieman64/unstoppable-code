import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../../icons';
import { CollapsedTurnSummary, type TurnSummary } from './CollapsedTurnSummary';

export interface TurnGroupProps {
  /** Pre-rendered user-message bubble (typically a `UserBubble` instance). */
  userBubble: ReactNode;
  /**
   * Pre-rendered intermediate region children. Hosts pass the recursive
   * block-renderer output for the intermediate assistant messages. The
   * component owns when to actually mount them based on collapse state.
   */
  intermediateBlocks?: ReactNode;
  /**
   * Aggregate counts surfaced on the collapsed chip-row. Omit when the host
   * doesn't have the summary (component still renders the intermediate
   * region in that case).
   */
  intermediateSummary?: TurnSummary;
  /**
   * Wall-clock duration of the collapsed turn, forwarded to
   * {@link CollapsedTurnSummary} so the row can read "4 steps · 12s" rather
   * than a bare step count. Optional, and safe to pass a raw computed
   * difference: the summary discards zero, negative, and non-finite values.
   */
  intermediateElapsedMs?: number;
  /** Optional host-provided branded app icon for app/tool summary chips. */
  appIcon?: ReactNode;
  /** Whether the intermediate region defaults to collapsed. Defaults to `true`. */
  collapsedByDefault?: boolean;
  /** True when this turn was reverted by a later marker. */
  reverted?: boolean;
  /** Optional preview of the user prompt rendered alongside the reverted bar. */
  revertedPreview?: string;
  /** Pre-rendered final-assistant-message blocks. */
  finalBlocks: ReactNode;
  /** Optional pre-rendered TurnTimer / fork-action slot. */
  turnTimerSlot?: ReactNode;
  /** Optional post-final slot (e.g. diff summary card). */
  trailingSlot?: ReactNode;
  /** Test ID hook for automation on the outer wrapper. */
  dataTestId?: string;
}

/**
 * Pure display turn-group wrapper. Renders the user message, an optional
 * collapsed-by-default intermediate region (driven by `intermediateSummary`
 * + the host's pre-rendered `intermediateBlocks`), the final assistant
 * blocks, an optional turn-timer slot, and the optional reverted fade.
 *
 * All stateful concerns (revert handler wiring, fork buttons, copy/expand
 * persistence) live in the host wrappers — this primitive only owns the
 * local expand toggle + the reverted-fade visual treatment.
 */
export function TurnGroup({
  userBubble,
  intermediateBlocks,
  intermediateSummary,
  intermediateElapsedMs,
  appIcon,
  collapsedByDefault = true,
  reverted = false,
  revertedPreview,
  finalBlocks,
  turnTimerSlot,
  trailingSlot,
  dataTestId,
}: TurnGroupProps): JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState(collapsedByDefault);
  const [isRevertedCollapsed, setIsRevertedCollapsed] = useState(reverted);

  useEffect(() => {
    if (reverted) {
      setIsRevertedCollapsed(true);
    }
  }, [reverted]);

  const hasIntermediate = intermediateBlocks != null;
  const hasSummary = intermediateSummary != null;

  if (reverted && isRevertedCollapsed) {
    return (
      <div
        className="-ml-3 space-y-2 border-l-2 border-line-attention/40 pl-3 opacity-60"
        aria-label="Reverted turn"
        data-testid={dataTestId}
        data-reverted="true"
        data-reverted-collapsed="true"
      >
        <button
          type="button"
          onClick={(): void => setIsRevertedCollapsed(false)}
          aria-expanded={false}
          aria-label="Expand reverted turn"
          className="focus-ring flex w-full items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-1.5 text-left text-xs fg-secondary transition hover:bg-fg-primary/[0.04]"
        >
          <span className="flex-shrink-0">
            <ChevronRightIcon />
          </span>
          <span className="font-medium fg-primary/80">Reverted</span>
          {revertedPreview ? (
            <span className="truncate">— {revertedPreview}</span>
          ) : null}
        </button>
      </div>
    );
  }

  const content = (
    <>
      {reverted && (
        <button
          type="button"
          onClick={(): void => setIsRevertedCollapsed(true)}
          aria-expanded={true}
          aria-label="Collapse reverted turn"
          className="focus-ring flex w-full items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-1.5 text-left text-xs fg-secondary transition hover:bg-fg-primary/[0.04]"
        >
          <span className="flex-shrink-0">
            <ChevronDownIcon />
          </span>
          <span className="font-medium fg-primary/80">Reverted</span>
          {revertedPreview ? (
            <span className="truncate">— {revertedPreview}</span>
          ) : null}
        </button>
      )}
      {userBubble}

      {hasIntermediate && hasSummary ? (
        <>
          <CollapsedTurnSummary
            summary={intermediateSummary}
            elapsedMs={intermediateElapsedMs}
            isExpanded={!isCollapsed}
            onToggle={(): void => setIsCollapsed((prev) => !prev)}
            appIcon={appIcon}
          />
          {!isCollapsed && (
            <div
              className="animate-collapse-in space-y-2"
              data-testid="turn-group-intermediate-region"
            >
              {intermediateBlocks}
            </div>
          )}
        </>
      ) : hasIntermediate ? (
        <div className="space-y-2" data-testid="turn-group-intermediate-region">
          {intermediateBlocks}
        </div>
      ) : null}

      {finalBlocks}
      {trailingSlot}
      {turnTimerSlot}
    </>
  );

  if (reverted) {
    return (
      <div
        className="-ml-3 space-y-2 border-l-2 border-line-attention/40 pl-3 opacity-60"
        aria-label="Reverted turn"
        data-testid={dataTestId}
        data-reverted="true"
        data-reverted-collapsed="false"
      >
        {content}
      </div>
    );
  }

  return (
    <div data-testid={dataTestId} className="space-y-2">
      {content}
    </div>
  );
}

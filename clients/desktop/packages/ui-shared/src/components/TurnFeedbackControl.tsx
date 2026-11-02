import {
  createContext,
  useContext,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { TurnFeedbackRating } from '@canopy/protocol/turn-feedback';
import { ThumbsDownIcon } from '../icons/ThumbsDownIcon';
import { ThumbsUpIcon } from '../icons/ThumbsUpIcon';
import {
  CLASSIC_FOOTER_ICON_BUTTON_CLASS,
  CLEAN_FOOTER_ICON_BUTTON_CLASS,
  useCleanChatLook,
} from './chat-look';
import { DropdownMenuItem, DropdownMenuItemIcon } from './DropdownMenu';

/**
 * Set by a menu that hosts the thumbs (the clean chat look's "•••" menu):
 * the control then renders "Good response" and "Bad response" menu rows.
 */
export const TurnFeedbackAsMenuItemsContext = createContext(false);

export interface TurnFeedbackControlProps {
  /** The rating already recorded on this turn, if any. */
  rating?: TurnFeedbackRating;
  /**
   * Sync state of the recorded rating. A `failed` rating still renders as
   * selected — a rejected upload must never silently revert the user's click.
   */
  syncState?: 'pending' | 'synced' | 'failed';
  /**
   * Called when the user picks a rating. Clicking the already-selected rating
   * passes `null` so the host can clear it.
   */
  onRate: (rating: TurnFeedbackRating | null) => void;
  /**
   * Optional tooltip wrapper. `ActionTooltip` is renderer-only and cannot be
   * imported into this package, so hosts inject their own via this render
   * prop. The default renders the child unchanged.
   */
  renderTooltip?: (node: ReactElement, label: string) => ReactNode;
}

// Selected reads through a filled icon and a stronger tone, never a border.
const SELECTED_CLASS =
  'focus-ring flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-md fg-primary transition-colors hover:bg-fg-primary/[0.04] active:bg-fg-primary/[0.08]';

/**
 * Turn-level thumbs up/down control (CAN-1521).
 *
 * Both buttons are **always mounted** — never conditionally rendered, never
 * `hidden`/`display:none`, so the control stays in the accessibility tree and
 * the tab order at all times and adds no layout shift. The turn footer shows
 * it right after the completion stamp and, like the stamp, always visible
 * (CAN-4278).
 */
export function TurnFeedbackControl({
  rating,
  syncState,
  onRate,
  renderTooltip,
}: TurnFeedbackControlProps): JSX.Element {
  const asMenuItems = useContext(TurnFeedbackAsMenuItemsContext);
  const wrap = (node: ReactElement, label: string): ReactNode =>
    renderTooltip ? renderTooltip(node, label) : node;

  // Under the clean look the thumbs take the footer text's ink and the step
  // icons' 14px size; a rating still reads through the filled icon.
  const clean = useCleanChatLook();
  const restClass = clean
    ? CLEAN_FOOTER_ICON_BUTTON_CLASS
    : CLASSIC_FOOTER_ICON_BUTTON_CLASS;
  const selectedClass = clean
    ? // A variant, so it outranks the quiet base ink.
      `${CLEAN_FOOTER_ICON_BUTTON_CLASS} aria-pressed:fg-primary`
    : SELECTED_CLASS;
  const iconSize = clean ? '14' : '13';
  const upSelected = rating === 'up';
  const downSelected = rating === 'down';

  if (asMenuItems) {
    // A rating reads through the filled icon and `aria-checked`.
    return (
      <>
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={upSelected}
          data-testid="turn-feedback-up"
          onClick={(): void => {
            onRate(upSelected ? null : 'up');
          }}
        >
          <DropdownMenuItemIcon>
            <ThumbsUpIcon
              aria-hidden="true"
              {...(upSelected ? { fill: 'currentColor' } : {})}
            />
          </DropdownMenuItemIcon>
          Good response
        </DropdownMenuItem>
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={downSelected}
          data-testid="turn-feedback-down"
          onClick={(): void => {
            onRate(downSelected ? null : 'down');
          }}
        >
          <DropdownMenuItemIcon>
            <ThumbsDownIcon
              aria-hidden="true"
              {...(downSelected ? { fill: 'currentColor' } : {})}
            />
          </DropdownMenuItemIcon>
          Bad response
        </DropdownMenuItem>
      </>
    );
  }

  return (
    <div
      data-testid="turn-feedback-control"
      data-rating={rating ?? 'none'}
      data-sync-state={syncState ?? 'none'}
      className="flex items-center gap-0.5"
    >
      {wrap(
        <button
          type="button"
          data-testid="turn-feedback-up"
          aria-label="Good response"
          aria-pressed={upSelected}
          className={upSelected ? selectedClass : restClass}
          onClick={(): void => {
            onRate(upSelected ? null : 'up');
          }}
        >
          <ThumbsUpIcon
            width={iconSize}
            height={iconSize}
            aria-hidden="true"
            {...(upSelected ? { fill: 'currentColor' } : {})}
          />
        </button>,
        'Good response',
      )}
      {wrap(
        <button
          type="button"
          data-testid="turn-feedback-down"
          aria-label="Bad response"
          aria-pressed={downSelected}
          className={downSelected ? selectedClass : restClass}
          onClick={(): void => {
            onRate(downSelected ? null : 'down');
          }}
        >
          <ThumbsDownIcon
            width={iconSize}
            height={iconSize}
            aria-hidden="true"
            {...(downSelected ? { fill: 'currentColor' } : {})}
          />
        </button>,
        'Bad response',
      )}
    </div>
  );
}

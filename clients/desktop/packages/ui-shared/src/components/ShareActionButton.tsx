import type { JSX } from 'react';
import { ShareIcon } from '../icons/AppIcons';
import {
  SECONDARY_ACTION_BUTTON_CLASS,
  SECONDARY_ICON_BUTTON_CLASS,
} from '../lib/row-chips';
import type { MarketplaceShareAction } from '../lib/marketplace-share';
import { Tooltip } from './Tooltip';

/**
 * The one Share action: the share glyph, labelled `Share`, wherever a
 * shareable resource is listed or opened. A list row and a detail header
 * render the same control, so sharing looks and reads the same for skills,
 * pipelines, automations, agents, collections, plugins and project templates.
 *
 * The icon placements show `Share` as their tooltip. Their accessible name
 * names the resource, so a screen reader can tell a list's Share buttons
 * apart. The `detail` placement shows a visible `Share` label instead, with
 * the shared secondary recipe. Every Marketplace detail puts it in the same
 * place: the top right of its Back row, or of a dialog's title bar.
 *
 * A disabled Share stays focusable, using `aria-disabled` instead of the
 * native attribute. Keyboard users can still reach the tooltip and its
 * `aria-description`, which explain why sharing is unavailable. Activation
 * never calls `onClick`.
 */
export interface ShareActionButtonProps {
  /** Accessible name, e.g. `Share Release notes`. */
  ariaLabel: string;
  onClick: () => void;
  /**
   * `row` is the quiet square at the end of a list row; `header` is the
   * secondary square that sits with a detail header's other actions;
   * `detail` is the labeled secondary button at the top right of a
   * Marketplace detail's Back row or dialog title bar.
   */
  placement: 'row' | 'header' | 'detail';
  disabled?: boolean;
  disabledReason?: string;
  dataTestId?: string;
}

/** The label every Share action shows. */
export const SHARE_ACTION_LABEL = 'Share';

const DISABLED_CLASS =
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-40';

const ROW_CLASS = `focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md fg-secondary transition-colors hover:bg-subtle hover:fg-primary pointer-coarse:h-11 pointer-coarse:w-11 ${DISABLED_CLASS}`;

const HEADER_CLASS = `${SECONDARY_ICON_BUTTON_CLASS} ${DISABLED_CLASS}`;

const DETAIL_CLASS = `${SECONDARY_ACTION_BUTTON_CLASS} gap-1.5 ${DISABLED_CLASS}`;

const PLACEMENT_CLASS: Record<ShareActionButtonProps['placement'], string> = {
  row: ROW_CLASS,
  header: HEADER_CLASS,
  detail: DETAIL_CLASS,
};

export function ShareActionButton({
  ariaLabel,
  onClick,
  placement,
  disabled = false,
  disabledReason,
  dataTestId,
}: ShareActionButtonProps): JSX.Element {
  const labeled = placement === 'detail';
  const button = (
    <button
      type="button"
      data-testid={dataTestId}
      aria-label={ariaLabel}
      aria-disabled={disabled ? true : undefined}
      aria-description={disabled ? disabledReason : undefined}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick();
      }}
      className={PLACEMENT_CLASS[placement]}
    >
      <ShareIcon
        width={labeled ? 14 : 16}
        height={labeled ? 14 : 16}
        aria-hidden
      />
      {labeled && SHARE_ACTION_LABEL}
    </button>
  );
  if (disabled && disabledReason) {
    return <Tooltip label={disabledReason}>{button}</Tooltip>;
  }
  // A labeled button already reads `Share`; a redundant tooltip adds noise.
  if (labeled) return button;
  return <Tooltip label={SHARE_ACTION_LABEL}>{button}</Tooltip>;
}

export interface MarketplaceShareButtonProps {
  /** Omitted when the host has no sharing capability: nothing renders. */
  action: MarketplaceShareAction | undefined;
  /** The resource name, used in the accessible name. */
  name: string;
  placement: ShareActionButtonProps['placement'];
  dataTestId?: string;
}

/**
 * Renders a Marketplace entry's share action from its one discriminated
 * state: an enabled callback or a blocked reason. Hosts never pass separate
 * callback, reason and visibility props that could disagree.
 */
export function MarketplaceShareButton({
  action,
  name,
  placement,
  dataTestId,
}: MarketplaceShareButtonProps): JSX.Element | null {
  if (!action) return null;
  return (
    <ShareActionButton
      placement={placement}
      dataTestId={dataTestId}
      ariaLabel={`Share ${name}`}
      onClick={action.status === 'shareable' ? action.onShare : noop}
      disabled={action.status === 'blocked'}
      disabledReason={action.status === 'blocked' ? action.reason : undefined}
    />
  );
}

function noop(): void {}

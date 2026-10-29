import type { JSX, ReactNode } from 'react';
import {
  ChevronDownMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';
import { USAGE_TOUCH_FLOOR_CLASS } from './usage-indicator-meter';

/**
 * The popover's expandable rows (Context, Cost, a listed account): no hover
 * surface; the row's quieter ink brightens and its chevron turns over.
 */
export const USAGE_DISCLOSURE_ROW_CLASS = `group focus-ring flex rounded-sm text-left text-xs ${USAGE_TOUCH_FLOOR_CLASS}`;

/** The expandable row's quieter ink, brightening with the row's hover. */
export const USAGE_DISCLOSURE_INK_CLASS =
  'fg-secondary transition-colors group-hover:fg-primary';

/** The expandable row's chevron, at the row's right edge. */
export function UsageDisclosureChevron({
  open,
}: {
  open: boolean;
}): JSX.Element {
  return (
    <ChevronDownMediumIcon
      size={16}
      aria-hidden
      className={`shrink-0 transition-transform motion-reduce:transition-none ${
        open ? 'rotate-180' : ''
      }`}
    />
  );
}

/**
 * The popover's quiet actions ("See detailed breakdown", Manage): one style,
 * so they always read alike.
 */
const USAGE_QUIET_ACTION_CLASS =
  'text-xs fg-secondary transition-colors hover:fg-primary';

/**
 * The popover's action rows ("See detailed breakdown", a host's Manage row):
 * a quiet label with a chevron at the right edge; the whole row is the
 * target, and hovering it lights both. `band` is the popover's footer: a
 * full-bleed quaternary band whose clipped corners would cut a focus ring,
 * so keyboard focus tints the band instead.
 */
export function UsageActionRow({
  label,
  onClick,
  testId,
  band = false,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
  band?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`flex w-full items-center justify-between gap-2 text-left ${USAGE_QUIET_ACTION_CLASS} ${USAGE_TOUCH_FLOOR_CLASS} ${
        band
          ? 'bg-quaternary px-3 py-3 outline-none focus-visible:bg-subtle focus-visible:fg-primary'
          : 'focus-ring rounded-sm'
      }`}
    >
      {label}
      <ChevronRightMediumIcon
        width={16}
        height={16}
        aria-hidden="true"
        className="shrink-0"
      />
    </button>
  );
}

/**
 * The popover's quiet text action ("Manage"): secondary ink that brightens
 * on hover, the touch floor on coarse pointers.
 */
export function UsageTextAction({
  label,
  onClick,
  ariaLabel,
  testId,
}: {
  label: string;
  onClick: () => void;
  ariaLabel?: string;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`focus-ring relative shrink-0 rounded-sm ${USAGE_QUIET_ACTION_CLASS} ${USAGE_TOUCH_FLOOR_CLASS}`}
    >
      {label}
    </button>
  );
}

/**
 * A popover section's header row, styled as the Context and Cost rows: its
 * name left, then an optional quiet action and the chevron at the right
 * edge. The whole row is the toggle except the action, which sits above it.
 */
export function UsageSectionHeader({
  label,
  expanded,
  onToggle,
  action,
  testId,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  /** A quiet action between the name and the chevron (`UsageTextAction`). */
  action?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    // The action and chevron sit 4px apart, as the Context and Cost rows'
    // value and chevron do, so their right edges and chevrons line up.
    <div className="relative flex items-center text-xs">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid={testId}
        // The row's overlay (`after:`) takes clicks anywhere on the row; the
        // action and chevron that follow light up with it as its peers.
        className={`${USAGE_DISCLOSURE_ROW_CLASS} peer flex-1 items-center after:absolute after:inset-0 after:content-['']`}
      >
        <span className="whitespace-nowrap fg-primary">{label}</span>
      </button>
      {action && <span className="ml-3 flex">{action}</span>}
      <span
        aria-hidden="true"
        className="pointer-events-none ml-1 flex fg-secondary transition-colors peer-hover:fg-primary"
      >
        <UsageDisclosureChevron open={expanded} />
      </span>
    </div>
  );
}

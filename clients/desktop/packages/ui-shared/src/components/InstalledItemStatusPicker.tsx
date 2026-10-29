'use client';

import { useId, useRef, useState, type JSX } from 'react';
import type { InstalledItemStatus } from '@canopy/protocol/installed-items';
import { CheckIcon, ChevronDownIcon } from '../icons/AppIcons';
import {
  INSTALLED_ITEM_STATUS_COPY,
  INSTALLED_ITEM_STATUS_ORDER,
} from '../lib/installed-item-status';
import { DropdownMenuItem, DropdownMenuItemIcon } from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { LoadingSpinner } from './LoadingSpinner';
import { Tooltip } from './Tooltip';

/**
 * Active / Available / Disabled picker for one installed item (CAN-4255).
 *
 * Pure display: the host owns the status and the write. Each option pairs its
 * glyph with a label and a one-line description, and the selected option
 * carries a checkmark. A `disabledReason` renders the same trigger shape,
 * disabled and without a menu; it stays focusable, and its reason shows on
 * hover and keyboard focus and is the button's accessible description.
 */

/**
 * A clear state dot (CAN-4261): filled green for Active, filled neutral for
 * Available, an outline for Disabled. A dashed circle read as loading.
 */
const STATUS_DOT: Record<InstalledItemStatus, string> = {
  active: 'bg-success',
  available: 'bg-fg-tertiary',
  disabled: 'border border-current fg-tertiary',
};

export function InstalledItemStatusIcon({
  status,
  size = 14,
  disabled = false,
}: {
  readonly status: InstalledItemStatus;
  readonly size?: number;
  /** Takes the disabled ink, for a status the user cannot change. */
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span
        data-status-dot={status}
        className={`h-2 w-2 rounded-full ${
          disabled
            ? status === 'disabled'
              ? 'border border-current fg-disabled'
              : 'bg-fg-quaternary'
            : STATUS_DOT[status]
        }`}
      />
    </span>
  );
}

export interface InstalledItemStatusPickerProps {
  /** Names the item in the trigger's accessible name. */
  readonly itemName: string;
  readonly status: InstalledItemStatus;
  /** Omit to render the current status read-only. */
  readonly onChange?: (status: InstalledItemStatus) => void;
  /** A write for this item is in flight. */
  readonly busy?: boolean;
  readonly retryCurrent?: boolean;
  /** Why the status cannot change here; shown on hover and focus. */
  readonly disabledReason?: string;
  readonly testId?: string;
  /** Where the menu opens; a control leading its row opens to the right. */
  readonly menuPlacement?: 'bottom-right' | 'bottom-left';
}

const TRIGGER_CLASS =
  'focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium whitespace-nowrap transition-colors';

/**
 * The picker's trigger shape for a status that cannot change here: no menu
 * and no chevron, the disabled ink, and the reason on hover and keyboard
 * focus and as the button's accessible description.
 */
function DisabledStatusTrigger({
  label,
  ariaLabel,
  icon,
  reason,
  status,
  testId,
}: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly icon: InstalledItemStatus;
  readonly reason: string;
  readonly status?: InstalledItemStatus;
  readonly testId: string;
}): JSX.Element {
  const reasonId = useId();
  return (
    <Tooltip label={reason}>
      <button
        type="button"
        data-testid={testId}
        data-status={status}
        aria-label={ariaLabel}
        aria-disabled="true"
        aria-describedby={reasonId}
        className={`${TRIGGER_CLASS} cursor-not-allowed fg-disabled`}
      >
        <InstalledItemStatusIcon status={icon} disabled />
        {label}
        {/* Holds the chevron's place, so labels line up with live pickers. */}
        <span className="w-3 shrink-0" aria-hidden />
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * A row whose status cannot be read: the same control shape as the picker,
 * disabled, with the reason in its tooltip.
 */
export function InstalledItemStatusUnavailable({
  itemName,
  reason,
  testId = 'installed-item-status-unavailable',
}: {
  readonly itemName: string;
  readonly reason: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <DisabledStatusTrigger
      label="Unavailable"
      ariaLabel={`Status for ${itemName}: Unavailable`}
      icon="available"
      reason={reason}
      testId={testId}
    />
  );
}

export function InstalledItemStatusPicker({
  itemName,
  status,
  onChange,
  busy = false,
  retryCurrent = false,
  disabledReason,
  testId = 'installed-item-status-picker',
  menuPlacement = 'bottom-right',
}: InstalledItemStatusPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copy = INSTALLED_ITEM_STATUS_COPY[status];
  const interactive = onChange !== undefined && disabledReason === undefined;
  const label = `Status for ${itemName}: ${copy.label}`;

  if (disabledReason !== undefined)
    return (
      <DisabledStatusTrigger
        label={copy.label}
        ariaLabel={label}
        icon={status}
        status={status}
        reason={disabledReason}
        testId={testId}
      />
    );
  if (!interactive) {
    return (
      <button
        type="button"
        data-testid={testId}
        data-status={status}
        aria-label={label}
        aria-disabled="true"
        className={`${TRIGGER_CLASS} cursor-default fg-primary`}
      >
        <InstalledItemStatusIcon status={status} />
        {copy.label}
      </button>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        data-status={status}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={(): void => setOpen((value) => !value)}
        className={`${TRIGGER_CLASS} fg-primary hover:bg-subtle disabled:cursor-progress`}
      >
        {busy ? (
          <LoadingSpinner sizePx={14} decorative />
        ) : (
          <InstalledItemStatusIcon status={status} />
        )}
        {copy.label}
        <ChevronDownIcon
          width={12}
          height={12}
          aria-hidden
          className="fg-tertiary"
        />
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement={menuPlacement}
        data-testid={`${testId}-menu`}
        aria-label={`Status for ${itemName}`}
        className="w-64"
      >
        {INSTALLED_ITEM_STATUS_ORDER.map((option) => {
          const optionCopy = INSTALLED_ITEM_STATUS_COPY[option];
          const selected = option === status;
          return (
            <DropdownMenuItem
              key={option}
              role="menuitemradio"
              aria-checked={selected}
              multiline
              data-testid={`${testId}-option-${option}`}
              onClick={(): void => {
                setOpen(false);
                if (!selected || retryCurrent) onChange(option);
              }}
            >
              <DropdownMenuItemIcon>
                <InstalledItemStatusIcon status={option} />
              </DropdownMenuItemIcon>
              <span className="min-w-0 flex-1">
                <span className="block font-medium fg-primary">
                  {optionCopy.label}
                </span>
                <span className="block text-xs fg-tertiary">
                  {optionCopy.description}
                </span>
              </span>
              <DropdownMenuItemIcon>
                {selected && <CheckIcon width={16} height={16} aria-hidden />}
              </DropdownMenuItemIcon>
            </DropdownMenuItem>
          );
        })}
      </FloatingMenu>
    </>
  );
}

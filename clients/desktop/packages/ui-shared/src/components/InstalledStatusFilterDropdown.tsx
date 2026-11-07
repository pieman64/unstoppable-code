'use client';

import { useRef, useState, type JSX } from 'react';
import type { InstalledItemStatus } from '@canopy/protocol/installed-items';
import { CheckIcon } from '../icons/AppIcons';
import {
  INSTALLED_ITEM_STATUS_COPY,
  INSTALLED_ITEM_STATUS_ORDER,
  installedStatusFilterLabel,
} from '../lib/installed-item-status';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
} from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { InstalledItemStatusIcon } from './InstalledItemStatusPicker';
import { PickerTrigger, PickerTriggerChevron } from './PickerMenu';

/**
 * Any status / Active / Available / Disabled filter after the Customize
 * search (CAN-4838): a page search row's quiet dropdown. Pure display: the host owns the applied value. Status
 * rows reuse the item picker's glyphs and descriptions.
 */
export interface InstalledStatusFilterDropdownProps {
  /** `null` is Any status. */
  readonly value: InstalledItemStatus | null;
  readonly onChange: (value: InstalledItemStatus | null) => void;
  readonly testId?: string;
}

const OPTIONS: readonly (InstalledItemStatus | null)[] = [
  null,
  ...INSTALLED_ITEM_STATUS_ORDER,
];

export function InstalledStatusFilterDropdown({
  value,
  onChange,
  testId = 'customize-installed-status-filter',
}: InstalledStatusFilterDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = installedStatusFilterLabel(value);
  return (
    <>
      <PickerTrigger
        ref={triggerRef}
        variant="capsule"
        size="page"
        labelOnly={value === null}
        className="shrink-0"
        data-testid={testId}
        data-status={value ?? 'any'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Filter installed items by status: ${label}`}
        onClick={(): void => setOpen((current) => !current)}
      >
        {value !== null && <InstalledItemStatusIcon status={value} />}
        <span className="whitespace-nowrap">{label}</span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        data-testid={`${testId}-menu`}
        aria-label="Filter installed items by status"
        className="w-64"
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          {OPTIONS.map((option) => {
            const selected = option === value;
            return (
              <DropdownMenuItem
                key={option ?? 'any'}
                role="menuitemradio"
                aria-checked={selected}
                multiline
                data-testid={`${testId}-option-${option ?? 'any'}`}
                onClick={(): void => {
                  setOpen(false);
                  onChange(option);
                }}
              >
                <DropdownMenuItemIcon>
                  {option !== null && (
                    <InstalledItemStatusIcon status={option} />
                  )}
                </DropdownMenuItemIcon>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium fg-primary">
                    {installedStatusFilterLabel(option)}
                  </span>
                  {option !== null && (
                    <span className="block text-xs fg-tertiary">
                      {INSTALLED_ITEM_STATUS_COPY[option].description}
                    </span>
                  )}
                </span>
                <DropdownMenuItemIcon>
                  {selected && <CheckIcon size="sm" aria-hidden />}
                </DropdownMenuItemIcon>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

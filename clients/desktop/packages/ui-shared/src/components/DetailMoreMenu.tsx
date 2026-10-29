'use client';

import {
  Fragment,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { MoreHorizontalIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { ActionMenuRowStyle } from './ActionMenuItems';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
} from './DropdownMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from './FloatingMenu';
import { Tooltip } from './Tooltip';

export interface DetailMoreMenuItem {
  readonly id: string;
  readonly label: string;
  /** The row's leading icon, as on every action menu row. */
  readonly icon: ReactNode;
  readonly testId: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Shown beneath a disabled item, so every user sees what to do. */
  readonly reason?: string;
  /** Delete, Remove: last, below a divider, in the destructive tone. */
  readonly destructive?: boolean;
}

export interface DetailMoreMenuProps {
  /** The item's name, for the trigger's and menu's accessible names. */
  readonly name: string;
  /** Visible items in menu order; a destructive item belongs last. */
  readonly items: readonly DetailMoreMenuItem[];
  readonly triggerTestId: string;
  readonly menuTestId: string;
}

/**
 * The ⋯ More menu that leads a detail's action bar: rarer actions, with the
 * destructive one last below a divider (the host still confirms it). A
 * disabled item with a reason shows the reason beneath it, so keyboard and
 * pointer users both see what to do. Renders nothing when no item applies,
 * so the bar never shows an empty menu.
 */
export function DetailMoreMenu({
  name,
  items,
  triggerTestId,
  menuTestId,
}: DetailMoreMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const menuId = useId();
  const reasonIdBase = useId();
  if (items.length === 0) return null;
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <Tooltip label="More actions">
          <Button
            variant="secondary"
            size="control"
            iconOnly
            aria-label={`More actions for ${name}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            data-testid={triggerTestId}
            onClick={(): void => setOpen((current) => !current)}
          >
            <MoreHorizontalIcon width={14} height={14} aria-hidden="true" />
          </Button>
        </Tooltip>
      </span>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-left"
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-label={`Actions for ${name}`}
        data-testid={menuTestId}
        className="min-w-44 max-w-64"
      >
        <ActionMenuRowStyle>
          {items.map((item, index) => {
            const reasonId = `${reasonIdBase}-${item.id}`;
            const explained =
              item.disabled === true && item.reason !== undefined;
            return (
              <Fragment key={item.id}>
                {item.destructive && index > 0 ? <DropdownMenuDivider /> : null}
                <DropdownMenuItem
                  tone={item.destructive ? 'destructive' : 'default'}
                  disabled={item.disabled}
                  aria-describedby={explained ? reasonId : undefined}
                  data-testid={item.testId}
                  onClick={(): void => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <DropdownMenuItemIcon>{item.icon}</DropdownMenuItemIcon>
                  {item.label}
                </DropdownMenuItem>
                {explained ? (
                  // Only menu items may be children of a menu, so the reason is
                  // hidden from the tree and read through `aria-describedby`.
                  <DropdownMenuLabel
                    id={reasonId}
                    aria-hidden="true"
                    className="whitespace-normal"
                  >
                    {item.reason}
                  </DropdownMenuLabel>
                ) : null}
              </Fragment>
            );
          })}
        </ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
}

import { type JSX, Fragment, useRef, useState } from 'react';
import { DropdownMenuDivider, DropdownMenuItem } from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { isMenuOpenBodyFlagSet } from '../lib/menu-open-body-flag';
import { MoreHorizontalIcon } from '../icons/AppIcons';

export interface CustomizeRowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /** Destructive items render last, after a divider. */
  readonly destructive?: boolean;
}

export interface CustomizeRowMenuProps {
  readonly entryName: string;
  /** Section-qualified, so repeated entries keep unique identifiers. */
  readonly idPrefix: string;
  readonly items: readonly CustomizeRowMenuItem[];
  readonly testId?: string;
}

/** A row's secondary actions. Renders nothing when no action exists. */
export function CustomizeRowMenu({
  entryName,
  idPrefix,
  items,
  testId,
}: CustomizeRowMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groups = [
    items.filter((item) => item.destructive !== true),
    items.filter((item) => item.destructive === true),
  ].filter((group) => group.length > 0);
  if (groups.length === 0) return null;
  const menuId = `${idPrefix}-menu`;
  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        id={`${idPrefix}-menu-trigger`}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${entryName}`}
        onPointerDown={() => {
          if (!open && isMenuOpenBodyFlagSet(document)) setOpen(true);
        }}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg fg-tertiary transition-colors hover:bg-subtle hover:fg-primary pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <MoreHorizontalIcon width={16} height={16} aria-hidden />
      </button>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        data-testid={testId ? `${testId}-surface` : undefined}
        className="min-w-40"
      >
        {groups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 && <DropdownMenuDivider />}
            {group.map((item) => (
              <DropdownMenuItem
                key={item.id}
                data-testid={testId ? `${testId}-${item.id}` : undefined}
                tone={item.destructive ? 'destructive' : 'default'}
                disabled={item.disabled && !item.disabledReason}
                aria-disabled={item.disabled || undefined}
                title={item.disabledReason}
                aria-description={item.disabledReason}
                aria-label={
                  item.disabledReason
                    ? `${item.label}: ${item.disabledReason}`
                    : item.label
                }
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </FloatingMenu>
    </div>
  );
}

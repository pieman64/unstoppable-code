'use client';

import { useRef, useState, type JSX, type ReactNode } from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuLabel,
  FloatingMenu,
  PickerTrigger,
  type ActionMenuItem,
  PickerTriggerChevron,
  TableActionButton,
} from '@canopy/ui-shared/components';
import {
  CheckIcon,
  MoreHorizontalIcon,
  SearchIcon,
} from '@canopy/ui-shared/icons/AppIcons';

export interface WorkflowsSearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly testId: string;
  /** Placement and width only; the field owns its own shape. */
  readonly className?: string;
}

/** The search field at the head of the Runs and Library toolbars. */
export function WorkflowsSearchField({
  value,
  onChange,
  placeholder,
  testId,
  className = 'w-64',
}: WorkflowsSearchFieldProps): JSX.Element {
  return (
    <label className={`relative block min-w-0 ${className}`}>
      <span className="sr-only">{placeholder}</span>
      <SearchIcon
        width={16}
        height={16}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 fg-tertiary"
      />
      <input
        type="search"
        value={value}
        data-testid={testId}
        placeholder={placeholder}
        onChange={(event): void => onChange(event.target.value)}
        onKeyDown={(event): void => {
          if (event.key === 'Escape' && value !== '') {
            event.preventDefault();
            onChange('');
          }
        }}
        className="focus-ring h-8 w-full appearance-none rounded-md border bg-base pl-9 pr-3 text-s fg-primary placeholder:fg-tertiary [&::-webkit-search-cancel-button]:appearance-none"
      />
    </label>
  );
}

export interface WorkflowsFilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Rows carrying this value in the unfiltered set; omitted when unknown. */
  readonly count?: number;
  readonly icon?: ReactNode;
}

export interface WorkflowsFilterMenuProps<T extends string> {
  /** The menu's heading and the capsule's accessible name: `Trigger`. */
  readonly title: string;
  /** The capsule's text for the current selection: `Any trigger`. */
  readonly label: string;
  /** The row that clears the filter: `Any trigger`. */
  readonly anyLabel: string;
  readonly options: readonly WorkflowsFilterOption<T>[];
  readonly selected: readonly T[];
  readonly onToggle: (value: T) => void;
  readonly onClear: () => void;
  /** Keep the menu open so several values can be picked. */
  readonly multiple?: boolean;
  readonly testId: string;
}

/**
 * A capsule filter with a menu of counted values, as in the Marketplace
 * filters. The capsule shows the current value; picking the "any" row clears
 * the filter.
 */
export function WorkflowsFilterMenu<T extends string>({
  title,
  label,
  anyLabel,
  options,
  selected,
  onToggle,
  onClear,
  multiple = false,
  testId,
}: WorkflowsFilterMenuProps<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const active = selected.length > 0;
  return (
    <>
      <PickerTrigger
        ref={anchorRef}
        variant="capsule"
        labelOnly
        tone={active ? 'default' : 'secondary'}
        aria-label={`${title}: ${label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid={testId}
        data-active={active ? 'true' : 'false'}
        onClick={(): void => setOpen((current) => !current)}
      >
        <span className={`truncate ${active ? 'fg-primary' : ''}`}>
          {label}
        </span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-left"
        closeOnSelect={!multiple}
        className="min-w-52"
        data-testid={`${testId}-menu`}
      >
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={!active}
          data-testid={`${testId}-any`}
          onClick={onClear}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {active ? null : (
              <CheckIcon width={14} height={14} aria-hidden="true" />
            )}
          </span>
          <span className="truncate">{anyLabel}</span>
        </DropdownMenuItem>
        <DropdownMenuDivider />
        {options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <DropdownMenuItem
              key={option.value}
              role={multiple ? 'menuitemcheckbox' : 'menuitemradio'}
              aria-checked={checked}
              data-testid={`${testId}-option-${option.value}`}
              onClick={(): void => onToggle(option.value)}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {checked ? (
                  <CheckIcon width={14} height={14} aria-hidden="true" />
                ) : null}
              </span>
              {option.icon ? (
                <span className="flex shrink-0 items-center fg-secondary">
                  {option.icon}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.count !== undefined ? (
                <span className="shrink-0 pl-3 text-xs tabular-nums fg-tertiary">
                  {option.count}
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </FloatingMenu>
    </>
  );
}

export interface WorkflowsRowMenuItem {
  readonly id: string;
  readonly label: string;
  /**
   * Leading icon. Consecutive rows in one group that pass the same icon
   * element (Share… and Copy share link) show it once, on the first row.
   */
  readonly icon: ReactNode;
  /** Rows sharing a group sit together; a hairline divides the groups. */
  readonly group?: string;
  /** Destructive rows (red) close the menu in their own last group. */
  readonly destructive?: boolean;
  /** A plain row that removes the item from view, grouped with removals. */
  readonly removal?: boolean;
  readonly onSelect: () => void;
}

export interface WorkflowsRowMenuProps {
  /** Accessible name of the trigger: `More actions for Standup notes`. */
  readonly label: string;
  readonly items: readonly WorkflowsRowMenuItem[];
  readonly testId: string;
}

/** The rows in menu order: removal rows last, a divider between groups. */
export function workflowsRowMenuActionItems(
  items: readonly WorkflowsRowMenuItem[],
  testId: string,
): ActionMenuItem[] {
  const isRemoval = (item: WorkflowsRowMenuItem): boolean =>
    item.destructive === true || item.removal === true;
  const ordered = [
    ...items.filter((item) => !isRemoval(item)),
    ...items.filter(isRemoval),
  ];
  // Removal rows form their own group, apart from any named group.
  const groupOf = (item: WorkflowsRowMenuItem): string | null =>
    isRemoval(item) ? null : (item.group ?? '');
  return ordered.map((item, index) => {
    const previous = ordered[index - 1];
    return {
      key: item.id,
      label: item.label,
      icon: item.icon,
      tone: item.destructive === true ? 'destructive' : 'default',
      separatorBefore:
        previous !== undefined && groupOf(previous) !== groupOf(item),
      testId: `${testId}-item-${item.id}`,
      onSelect: item.onSelect,
    };
  });
}

/**
 * A row's More menu, on the shared action-menu recipe: a leading icon on
 * every row, groups split by hairlines, and removal rows in their own last
 * group. Renders nothing when no item applies, so a row never shows an empty
 * menu.
 */
export function WorkflowsRowMenu({
  label,
  items,
  testId,
}: WorkflowsRowMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <TableActionButton
          label={label}
          testId={testId}
          onClick={(): void => setOpen((current) => !current)}
        >
          <MoreHorizontalIcon width={14} height={14} aria-hidden="true" />
        </TableActionButton>
      </span>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        data-testid={`${testId}-menu`}
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={workflowsRowMenuActionItems(items, testId)}
            onSelect={(item): void => {
              setOpen(false);
              // Hand focus back to the trigger, as a FloatingMenu pick does.
              anchorRef.current
                ?.querySelector<HTMLElement>('button')
                ?.focus({ preventScroll: true });
              item.onSelect?.();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
}

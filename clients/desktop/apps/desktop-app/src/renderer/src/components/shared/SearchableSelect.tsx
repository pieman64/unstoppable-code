// Anchored, searchable single-select used by the Automations form surfaces.
// Extracted from `pages/AutomationsPage.tsx` so
// `components/automations/AutomationChatTargetPicker.tsx` can reuse the exact
// same control without importing the page (which would be a module cycle).
import { useCallback, useRef, useState, type JSX, type ReactNode } from 'react';
import { ChevronDownIcon } from '@canopy/ui-shared/icons';
import {
  FloatingPickerMenu,
  PickList,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  Tooltip,
} from '@canopy/ui-shared';

const SEARCHABLE_SELECT_MENU_WIDTH = '320px';

function optionMatches(option: SearchableSelectOption, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    option.label.toLowerCase().includes(normalized) ||
    (option.subtitle ?? '').toLowerCase().includes(normalized)
  );
}

export interface SearchableSelectOption {
  id: string;
  label: string;
  subtitle?: string;
  badge?: ReactNode;
}

export interface SearchableSelectProps {
  value: string;
  options: ReadonlyArray<SearchableSelectOption>;
  onChange: (id: string) => void;
  placeholder: string;
  emptyOption?: { id: ''; label: string; subtitle?: string };
  /** Selected value shown in the trigger when it is no longer in `options`. */
  selectedFallback?: SearchableSelectOption;
  emptyListMessage?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  disabledHint?: string;
  testId?: string;
  /** Id of the trigger, for a `FormField` label. */
  id?: string;
  ownerDocument?: Document;
}

export function SearchableSelect({
  value,
  options,
  onChange,
  placeholder,
  emptyOption,
  selectedFallback,
  emptyListMessage,
  searchPlaceholder = 'Search',
  disabled = false,
  disabledHint,
  testId,
  id,
  ownerDocument,
}: SearchableSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  // The menu focuses its search field once it is placed (a field focused
  // while the menu is still hidden would not take focus).
  const searchRef = useRef<HTMLInputElement | null>(null);
  const setSurface = useCallback((node: HTMLDivElement | null): void => {
    searchRef.current = node?.querySelector('input') ?? null;
  }, []);

  const selected = value
    ? (options.find((option) => option.id === value) ??
      (selectedFallback?.id === value ? selectedFallback : undefined))
    : undefined;
  // The empty option leads the list and drops out once the user searches.
  const items: readonly SearchableSelectOption[] = emptyOption
    ? [emptyOption, ...options]
    : options;
  const triggerLabel = selected
    ? selected.label
    : emptyOption && value === ''
      ? emptyOption.label
      : placeholder;
  const triggerSubtitle = selected?.subtitle;

  return (
    <>
      <Tooltip label={disabledHint} suppressed={!disabled} className="w-full">
        <button
          ref={anchorRef}
          id={id}
          type="button"
          onClick={(): void => {
            if (disabled) return;
            setOpen((prev) => !prev);
          }}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid={testId}
          className="focus-ring flex w-full items-center justify-between gap-2 rounded-md border bg-base px-2.5 py-1.5 text-left text-s fg-primary transition-colors hover:bg-fg-primary/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selected?.badge}
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={`truncate ${selected ? 'font-medium' : 'fg-secondary'}`}
              >
                {triggerLabel}
              </span>
              {triggerSubtitle && (
                <span className="truncate text-2xs fg-secondary">
                  {triggerSubtitle}
                </span>
              )}
            </span>
          </span>
          <ChevronDownIcon size="sm" className="shrink-0 fg-secondary" />
        </button>
      </Tooltip>
      <FloatingPickerMenu
        ref={setSurface}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        {...(ownerDocument ? { ownerDocument } : {})}
        placement="bottom-left"
        minimumWidth={SEARCHABLE_SELECT_MENU_WIDTH}
        initialFocusRef={searchRef}
        role="dialog"
        aria-label={placeholder}
        onClick={(event): void => event.stopPropagation()}
      >
        <PickList
          items={items}
          getKey={(option): string => option.id}
          getLabel={(option): string => option.label}
          filter={(option, query): boolean =>
            option.id !== '' && optionMatches(option, query)
          }
          selectedKey={value}
          searchLabel={searchPlaceholder}
          listLabel={placeholder}
          emptyLabel={emptyListMessage ?? 'No matches'}
          listMaxHeight="md"
          autoFocus={false}
          onPick={(option): void => {
            onChange(option.id);
            setOpen(false);
          }}
          renderItem={(option, state) => (
            <>
              {option.badge ? (
                <PickerMenuOptionLeading>
                  {option.badge}
                </PickerMenuOptionLeading>
              ) : null}
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>{option.label}</PickerMenuOptionLabel>
                {option.subtitle ? (
                  <PickerMenuOptionDescription>
                    {option.subtitle}
                  </PickerMenuOptionDescription>
                ) : null}
              </PickerMenuOptionContent>
              <PickerMenuOptionCheck selected={state.selected} />
            </>
          )}
        />
      </FloatingPickerMenu>
    </>
  );
}

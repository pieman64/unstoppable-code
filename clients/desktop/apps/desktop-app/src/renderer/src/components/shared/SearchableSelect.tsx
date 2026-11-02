// Anchored, searchable single-select used by the Automations form surfaces.
// Extracted from `pages/AutomationsPage.tsx` so
// `components/automations/AutomationChatTargetPicker.tsx` can reuse the exact
// same control without importing the page (which would be a module cycle).
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, MagnifyingGlassIcon } from '@canopy/ui-shared/icons';
import { Tooltip } from '@canopy/ui-shared';
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu';

const SEARCHABLE_SELECT_MENU_WIDTH = 320;

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
  ownerDocument,
}: SearchableSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const position = useAnchoredMenu(
    open,
    setOpen,
    anchorRef,
    menuRef,
    SEARCHABLE_SELECT_MENU_WIDTH,
  );

  useEffect(() => {
    if (open) {
      setQuery('');
      const handle = window.setTimeout(() => {
        searchRef.current?.focus();
      }, 0);
      return (): void => window.clearTimeout(handle);
    }
    return undefined;
  }, [open]);

  const selected = value
    ? (options.find((option) => option.id === value) ??
      (selectedFallback?.id === value ? selectedFallback : undefined))
    : undefined;
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) => {
      return (
        option.label.toLowerCase().includes(normalized) ||
        (option.subtitle ?? '').toLowerCase().includes(normalized)
      );
    });
  }, [options, query]);

  const showEmptyOption = emptyOption !== undefined && query.trim() === '';
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
          <ChevronDownIcon
            width={12}
            height={12}
            className="shrink-0 fg-secondary"
          />
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            onClick={(event): void => event.stopPropagation()}
            className="z-dropdown flex flex-col overflow-hidden rounded-lg bg-popover shadow-lg"
            style={{
              position: 'fixed',
              width: SEARCHABLE_SELECT_MENU_WIDTH,
              ...(position
                ? {
                    top: position.top,
                    left: position.left,
                    maxHeight: position.maxHeight,
                  }
                : { visibility: 'hidden' }),
            }}
          >
            <div className="flex items-center gap-2 border-b px-2 py-1.5">
              <MagnifyingGlassIcon
                width={14}
                height={14}
                className="shrink-0 fg-secondary"
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event): void => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-xs fg-primary outline-none placeholder:fg-secondary"
              />
            </div>
            <ul className="min-h-0 max-h-[40vh] flex-1 overflow-y-auto p-1">
              {showEmptyOption && emptyOption && (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === ''}
                    onClick={(): void => {
                      onChange('');
                      setOpen(false);
                    }}
                    className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary ${
                      value === '' ? 'bg-secondary' : ''
                    }`}
                  >
                    <span className="font-medium fg-primary">
                      {emptyOption.label}
                    </span>
                    {emptyOption.subtitle && (
                      <span className="text-2xs fg-secondary">
                        {emptyOption.subtitle}
                      </span>
                    )}
                  </button>
                </li>
              )}
              {filteredOptions.length === 0 ? (
                <li className="px-3 py-3 text-center text-xs fg-secondary">
                  {emptyListMessage ?? 'No matches'}
                </li>
              ) : (
                filteredOptions.map((option) => {
                  const isSelected = option.id === value;
                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={(): void => {
                          onChange(option.id);
                          setOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary ${
                          isSelected ? 'bg-secondary' : ''
                        }`}
                      >
                        {option.badge}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium fg-primary">
                            {option.label}
                          </span>
                          {option.subtitle && (
                            <span className="truncate text-2xs fg-secondary">
                              {option.subtitle}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>,
          (ownerDocument ?? anchorRef.current?.ownerDocument ?? document).body,
        )}
    </>
  );
}

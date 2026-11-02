import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { PrPickerOption } from '@/stores/navigationStore';
import type { PrState } from '@canopy/desktop-shared/types/github';
import {
  KeyHintFooter,
  PullRequestStateBadge,
} from '@canopy/ui-shared/components';
import { pickerKeyHints } from '@canopy/ui-shared/lib/shortcuts';
import { openUrlExternally } from './openUrlExternally';
import {
  getFilteredPrPickerOptions,
  getSelectedPrPickerOption,
} from './prPickerModel';

interface PrPickerProps {
  options: PrPickerOption[];
  onClose: () => void;
}

function StateTag({ state }: { state: PrState }): JSX.Element {
  return <PullRequestStateBadge state={state} />;
}

export function PrPicker({ options, onClose }: PrPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  const filteredOptions = useMemo(
    () => getFilteredPrPickerOptions(options, query),
    [options, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (filteredOptions.length === 0) {
      setSelectedIndex(-1);
      return;
    }
    setSelectedIndex((current) => {
      if (current < 0) {
        return 0;
      }
      if (current >= filteredOptions.length) {
        return filteredOptions.length - 1;
      }
      return current;
    });
  }, [filteredOptions]);

  useEffect(() => {
    if (selectedIndex < 0) {
      return;
    }
    const item = itemRefs.current.get(selectedIndex);
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  function chooseOption(option: PrPickerOption | undefined): void {
    if (!option) {
      return;
    }
    openUrlExternally(option.prUrl);
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filteredOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) =>
        current < 0 ? 0 : (current + 1) % filteredOptions.length,
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filteredOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) =>
        current <= 0 ? filteredOptions.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      chooseOption(getSelectedPrPickerOption(options, query, selectedIndex));
    }
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-overlay-scrim px-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Open pull request"
        data-testid="pr-picker"
        className="flex w-full max-w-160 flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="border-b px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Search pull requests…"
            data-testid="pr-picker-input"
            className="w-full bg-transparent text-m fg-primary outline-none placeholder:fg-secondary"
          />
        </div>
        <div className="max-h-88 overflow-y-auto">
          {filteredOptions.length === 0 ? (
            <div className="px-4 py-8 text-center text-s fg-secondary">
              No pull requests found
            </div>
          ) : (
            <ul role="listbox" aria-label="Pull requests" className="py-2">
              {filteredOptions.map((option, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <li
                    key={`${option.repoId}-${option.prNumber}`}
                    ref={(node): void => {
                      if (node) {
                        itemRefs.current.set(index, node);
                      } else {
                        itemRefs.current.delete(index);
                      }
                    }}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseMove={() => setSelectedIndex(index)}
                      onClick={() => chooseOption(option)}
                      className={`flex w-full items-start justify-between gap-4 px-4 py-3 text-left transition-colors ${
                        isSelected
                          ? 'bg-accent-subtle fg-accent'
                          : 'fg-primary hover:bg-secondary'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-s font-medium">
                          {option.repoName}
                          <span className="ml-2 fg-secondary">
                            #{option.prNumber}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-xs fg-secondary">
                          {option.prTitle}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <StateTag state={option.prState} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <KeyHintFooter hints={pickerKeyHints('open')} />
      </div>
    </div>
  );
}

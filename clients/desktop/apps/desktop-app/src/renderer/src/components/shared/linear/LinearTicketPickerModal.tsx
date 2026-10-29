import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { LinearTicketSearchResult } from '@canopy/desktop-shared/types';
import { WordBoundaryTruncatedText } from '@canopy/ui-shared/components';
import { LoadingSpinner } from '@/components/shared/loading';

const SEARCH_DEBOUNCE_MS = 300;

export interface LinearTicketPickerModalProps {
  onSelect: (ticket: LinearTicketSearchResult) => void;
  onClose: () => void;
  /** Document of a popped-out composer; defaults to the main window. */
  ownerDocument?: Document;
}

/**
 * Cmd+P-style Linear ticket picker: a debounced search box over
 * `window.api.searchLinearIssues`, cloned structurally from
 * `FileSearchPalette` (overlay, dialog, listbox, arrow-key wraparound,
 * Enter/Escape, loading/empty/error states) so both palettes share the same
 * look, feel, and keyboard conventions. Selecting a ticket (click or Enter)
 * calls `onSelect` and then `onClose`.
 */
export function LinearTicketPickerModal({
  onSelect,
  onClose,
  ownerDocument,
}: LinearTicketPickerModalProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LinearTicketSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const searchSeqRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      searchSeqRef.current += 1;
      setSearching(false);
      setResults([]);
      setError(null);
      return;
    }

    const seq = ++searchSeqRef.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const found = await window.api.searchLinearIssues(trimmed);
          if (searchSeqRef.current !== seq) return;
          setResults(found);
          setError(null);
        } catch {
          if (searchSeqRef.current !== seq) return;
          setResults([]);
          setError('Unable to search Linear right now.');
        } finally {
          if (searchSeqRef.current === seq) {
            setSearching(false);
          }
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return (): void => {
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    if (results.length === 0) {
      setSelectedIndex(-1);
      return;
    }
    setSelectedIndex((current) => {
      if (current < 0) return 0;
      if (current >= results.length) return results.length - 1;
      return current;
    });
  }, [results]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    const item = itemRefs.current.get(selectedIndex);
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  function handleSelect(ticket: LinearTicketSearchResult | undefined): void {
    if (!ticket) return;
    onSelect(ticket);
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
      if (results.length === 0) return;
      setSelectedIndex((current) =>
        current < 0 ? 0 : (current + 1) % results.length,
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      setSelectedIndex((current) =>
        current <= 0 ? results.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = selectedIndex >= 0 ? results[selectedIndex] : undefined;
      handleSelect(selected);
    }
  }

  const trimmedQuery = query.trim();
  const showPrompt = trimmedQuery.length === 0;
  const showEmpty = !showPrompt && !searching && !error && results.length === 0;

  // Portaled so a transformed host, such as the Home composer shell, cannot
  // trap the overlay in its stacking context under later page content.
  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-overlay-scrim px-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Attach Linear ticket"
        data-testid="linear-ticket-picker"
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
            placeholder="Search Linear by id or title…"
            data-testid="linear-ticket-picker-input"
            className="w-full bg-transparent text-m fg-primary outline-none placeholder:fg-secondary"
          />
        </div>
        <div className="max-h-88 overflow-y-auto">
          {showPrompt && (
            <div className="px-4 py-8 text-center text-s fg-secondary">
              Search Linear tickets by id or title
            </div>
          )}
          {!showPrompt && searching && (
            <div className="flex items-center justify-center px-4 py-8">
              <LoadingSpinner tone="secondary" />
            </div>
          )}
          {!showPrompt && !searching && error && (
            <div className="px-4 py-8 text-center text-s fg-destructive">
              {error}
            </div>
          )}
          {showEmpty && (
            <div className="px-4 py-8 text-center text-s fg-secondary">
              No matching tickets
            </div>
          )}
          {!showPrompt && !searching && !error && results.length > 0 && (
            <ul role="listbox" aria-label="Linear tickets" className="py-2">
              {results.map((ticket, index) => {
                const isSelected = index === selectedIndex;
                const description = ticket.description?.trim() ?? '';
                return (
                  <li
                    key={ticket.id}
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
                      data-testid={`linear-ticket-picker-result-${ticket.id}`}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => handleSelect(ticket)}
                      className={`flex w-full items-center justify-between gap-4 px-4 py-2 text-left transition-colors ${
                        isSelected
                          ? 'bg-accent-subtle fg-accent'
                          : 'fg-primary hover:bg-secondary'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 rounded bg-fg-primary/[0.08] px-1.5 py-0.5 font-mono text-2xs fg-primary">
                            {ticket.identifier}
                          </span>
                          <span className="min-w-0 flex-1 text-s font-medium">
                            <WordBoundaryTruncatedText
                              text={ticket.title}
                              hoverTitle
                              data-testid="linear-ticket-picker-result-title"
                              className="block"
                            />
                          </span>
                        </div>
                        {description.length > 0 && (
                          <div className="mt-0.5 truncate text-xs fg-secondary">
                            {description}
                          </div>
                        )}
                      </div>
                      <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-2xs fg-secondary">
                        {ticket.priorityLabel}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between border-t px-4 py-3 text-xs fg-secondary">
          <span>Enter to attach</span>
          <span>Esc to close</span>
          <span>↑↓ to navigate</span>
        </div>
      </div>
    </div>,
    (ownerDocument ?? document).body,
  );
}

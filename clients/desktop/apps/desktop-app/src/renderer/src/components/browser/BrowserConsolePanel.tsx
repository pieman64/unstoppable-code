import { useMemo, useState, type JSX } from 'react';
import type { BrowserConsoleEntry } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ChatIcon } from '@canopy/ui-shared/icons';
import { useBrowserStore } from '@/stores/browserStore';
import { stageBrowserConsoleEntry } from '@/lib/browserChatStaging';
import { Tooltip } from '@canopy/ui-shared';

interface BrowserConsolePanelProps {
  browserId: string;
}

type ConsoleFilter = 'all' | 'errors';

const EMPTY: BrowserConsoleEntry[] = [];

function levelClass(level: BrowserConsoleEntry['level']): string {
  switch (level) {
    case 'error':
      return 'fg-destructive';
    case 'warning':
      return 'fg-warning';
    case 'debug':
      return 'fg-secondary';
    default:
      return 'fg-primary';
  }
}

function sourceLocation(entry: BrowserConsoleEntry): string | null {
  if (entry.url === undefined) {
    return null;
  }
  if (entry.lineNumber === undefined) {
    return entry.url;
  }
  return `${entry.url}:${entry.lineNumber}${
    entry.columnNumber !== undefined ? `:${entry.columnNumber}` : ''
  }`;
}

export function BrowserConsolePanel({
  browserId,
}: BrowserConsolePanelProps): JSX.Element {
  const entries = useBrowserStore((s) => s.consoleEntries[browserId] ?? EMPTY);
  const clearConsole = useBrowserStore((s) => s.clearConsole);
  const [filter, setFilter] = useState<ConsoleFilter>('all');

  const visible = useMemo(() => {
    if (filter === 'errors') {
      return entries.filter((entry) => entry.level === 'error');
    }
    return entries;
  }, [entries, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <FilterButton
          active={filter === 'all'}
          onClick={(): void => setFilter('all')}
        >
          All
        </FilterButton>
        <FilterButton
          active={filter === 'errors'}
          onClick={(): void => setFilter('errors')}
        >
          Errors
        </FilterButton>
        <div className="flex-1" />
        <Tooltip label="Clear console">
          <button
            type="button"
            onClick={(): void => clearConsole(browserId)}
            aria-label="Clear console"
            className="rounded px-2 py-0.5 text-2xs fg-secondary hover:bg-muted/40 hover:fg-primary"
          >
            Clear
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-2xs">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs fg-secondary">
            No console output
          </div>
        ) : (
          <ul>
            {visible.map((entry) => {
              const location = sourceLocation(entry);
              return (
                <li key={entry.id} className="border-b px-2 py-1.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <span
                        className={`mr-2 uppercase ${levelClass(entry.level)}`}
                      >
                        {entry.level}
                      </span>
                      <span className="whitespace-pre-wrap break-words">
                        {entry.text}
                      </span>
                      {location !== null && (
                        <span className="ml-2 fg-secondary/70">{location}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(): void => {
                        void stageBrowserConsoleEntry(entry);
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded border bg-base/50 px-1.5 py-0.5 text-2xs fg-primary/80 hover:bg-base"
                    >
                      <ChatIcon width={12} height={12} />
                      <span>{CHAT_UNIT_LABEL}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

interface FilterButtonProps {
  active: boolean;
  onClick: () => void;
  children: string;
}

function FilterButton({
  active,
  onClick,
  children,
}: FilterButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-2xs transition ${
        active ? 'bg-muted/60 fg-primary' : 'fg-secondary hover:fg-primary'
      }`}
    >
      {children}
    </button>
  );
}

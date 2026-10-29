import { useMemo, useState, type JSX } from 'react';
import type { BrowserNetworkEntry } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ChatIcon } from '@canopy/ui-shared/icons';
import { useBrowserStore } from '@/stores/browserStore';
import { stageBrowserNetworkEntry } from '@/lib/browserChatStaging';
import { Tooltip } from '@canopy/ui-shared';

interface BrowserNetworkPanelProps {
  browserId: string;
}

type NetworkFilter = 'all' | 'failed';

const EMPTY: BrowserNetworkEntry[] = [];

function statusLabel(entry: BrowserNetworkEntry): string {
  if (entry.failed) {
    return 'failed';
  }
  if (entry.status !== undefined) {
    return String(entry.status);
  }
  return '—';
}

function statusClass(entry: BrowserNetworkEntry): string {
  if (entry.failed) {
    return 'bg-destructive-subtle fg-destructive';
  }
  if (entry.status !== undefined && entry.status >= 400) {
    return 'bg-warning-subtle fg-warning';
  }
  return 'bg-muted/50 fg-secondary';
}

function durationLabel(entry: BrowserNetworkEntry): string {
  if (entry.durationMs === undefined) {
    return '';
  }
  return `${Math.round(entry.durationMs)} ms`;
}

function displayUrl(url: string): {
  primary: string;
  secondary: string | null;
} {
  if (!url) {
    return { primary: '(unknown URL)', secondary: null };
  }
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return {
      primary: path.length > 0 ? path : '/',
      secondary: parsed.origin,
    };
  } catch {
    return { primary: url, secondary: null };
  }
}

function detailsLabel(
  entry: BrowserNetworkEntry,
  origin: string | null,
): string {
  return [
    entry.errorText,
    origin,
    entry.resourceType,
    entry.mimeType,
    entry.fromCache ? 'cache' : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' • ');
}

export function BrowserNetworkPanel({
  browserId,
}: BrowserNetworkPanelProps): JSX.Element {
  const entries = useBrowserStore((s) => s.networkEntries[browserId] ?? EMPTY);
  const clearNetwork = useBrowserStore((s) => s.clearNetwork);
  const [filter, setFilter] = useState<NetworkFilter>('all');

  const visible = useMemo(() => {
    if (filter === 'failed') {
      return entries.filter((entry) => entry.failed === true);
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
          active={filter === 'failed'}
          onClick={(): void => setFilter('failed')}
        >
          Failed
        </FilterButton>
        <div className="flex-1" />
        <Tooltip label="Clear network">
          <button
            type="button"
            onClick={(): void => clearNetwork(browserId)}
            aria-label="Clear network"
            className="rounded px-2 py-0.5 text-2xs fg-secondary hover:bg-muted/40 hover:fg-primary"
          >
            Clear
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto text-2xs">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs fg-secondary">
            No network activity
          </div>
        ) : (
          <ul className="font-mono">
            {visible.map((entry) => {
              const formattedUrl = displayUrl(entry.url);
              const details = detailsLabel(entry, formattedUrl.secondary);
              return (
                <li
                  key={entry.id}
                  className={`border-b px-2 py-1.5 ${
                    entry.failed ? 'bg-destructive/5' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="grid min-w-0 flex-1 grid-cols-[3.25rem_4.5rem_minmax(0,1fr)_3.75rem] gap-x-2 gap-y-0.5">
                      <span className="uppercase fg-secondary">
                        {entry.method || 'GET'}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-center text-3xs font-medium ${statusClass(
                          entry,
                        )}`}
                      >
                        {statusLabel(entry)}
                      </span>
                      <span
                        className="min-w-0 truncate fg-primary"
                        title={entry.url || undefined}
                      >
                        {formattedUrl.primary}
                      </span>
                      <span className="text-right fg-secondary/70">
                        {durationLabel(entry)}
                      </span>
                      {details.length > 0 && (
                        <span
                          className={`col-start-3 col-span-2 min-w-0 break-words fg-secondary/70 ${
                            entry.failed ? 'fg-destructive' : ''
                          }`}
                          title={details}
                        >
                          {details}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(): void => {
                        void stageBrowserNetworkEntry(entry);
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded border bg-base/50 px-1.5 py-0.5 font-sans text-2xs fg-primary/80 hover:bg-base"
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

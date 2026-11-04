import { type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  curatedMcpProviderOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type { McpServerIndexEntry } from '@canopy/desktop-shared/types/mcp-servers';
import { Button } from '@canopy/ui-shared';
import { DialogModal } from '../shared/DialogModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { McpServerLogo } from '../shared/McpServerLogo';
import {
  CuratedMcpDetail,
  type CuratedMcpDetailRoutes,
  type McpDetailEntry,
} from '@canopy/ui-app/capability';
import { SearchField, Heading } from '@canopy/ui-shared/components';

// ---------------------------------------------------------------------------
// Curated logo (remote CDN <img> with icon fallback)
// ---------------------------------------------------------------------------

interface CuratedLogoProps {
  curatedKey?: string;
  logoUrl?: string;
  name?: string;
  size: number;
  className?: string;
}

/**
 * Curated entry logo: the shared circular {@link McpServerLogo} with the
 * monogram fallback (entries are identified by name in this dialog).
 */
function CuratedLogo({
  curatedKey,
  logoUrl,
  name,
  size,
  className = '',
}: CuratedLogoProps): JSX.Element {
  return (
    <McpServerLogo
      curatedKey={curatedKey}
      logoUrl={logoUrl}
      size={size}
      fallback="monogram"
      name={name}
      className={className}
      imgTestId="mcp-curated-logo"
      fallbackTestId="mcp-curated-logo-fallback"
    />
  );
}

// ---------------------------------------------------------------------------
// Sorting / filtering helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Ascending by `sortOrder`, then by display name for stable ties. */
export function sortCuratedEntries(
  entries: CuratedMcpServerEntry[],
): CuratedMcpServerEntry[] {
  return entries
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * Case-insensitive filter over name, descriptions, and category slugs. An
 * empty/blank query matches everything.
 */
export function filterCuratedEntries(
  entries: CuratedMcpServerEntry[],
  query: string,
): CuratedMcpServerEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = [
      entry.name,
      entry.shortDescription,
      entry.longDescription ?? '',
      ...entry.categories,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

/**
 * Build a `curatedKey` → installed `serverId` map so the detail view can join a
 * catalog entry to an already-installed server and fetch its discovered tools.
 */
export function buildInstalledCuratedMap(
  installedServers: McpServerIndexEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const server of installedServers) {
    if (server.curatedKey) map.set(server.curatedKey, server.id);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

export interface CuratedDetailProps<
  T extends McpDetailEntry = CuratedMcpServerEntry,
> {
  entry: T;
  /** Installed server id when this curated entry is already added, else null. */
  installedServerId: string | null;
  onAdd?: (entry: T) => void;
  /** Open the installed server's configuration editor. */
  onConfigure?: () => void;
  actions?: ReactNode;
  connectionContent?: ReactNode;
  /** Other ways to reach the service, after this entry's own route. */
  routes?: CuratedMcpDetailRoutes;
  toolsRevision?: number;
}

/**
 * Read-only detail for one curated MCP catalog entry, with the Add affordance
 * the caller wires to `McpServerDialog`. Exported so the Plugins discovery
 * detail wrapper renders the same surface as the browse dialog instead of
 * forking it (API-2153, design section 4).
 */
export function CuratedDetail<T extends McpDetailEntry>({
  entry,
  installedServerId,
  onAdd,
  onConfigure,
  actions,
  connectionContent,
  routes,
  toolsRevision,
}: CuratedDetailProps<T>): JSX.Element {
  // Discovered tools are INSTALLED-ONLY: the catalog carries none, and
  // discovery needs a live endpoint + the user's credentials that do not exist
  // before the server is added. `null` = not installed (section omitted);
  // an array (possibly empty) = installed and resolved.
  const providerOnly = curatedMcpProviderOnly(entry);
  const [tools, setTools] = useState<string[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState('');

  useEffect(() => {
    if (!installedServerId || providerOnly) {
      setTools(null);
      setToolsLoading(false);
      setToolsError('');
      return;
    }
    let cancelled = false;
    setTools(null);
    setToolsLoading(true);
    setToolsError('');
    void window.mcpServers
      .getTools(installedServerId)
      .then((result) => {
        if (!cancelled) {
          setTools(result?.tools ?? []);
          setToolsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setToolsError('Unable to load tools.');
          setToolsLoading(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [installedServerId, toolsRevision, providerOnly]);

  return (
    <CuratedMcpDetail
      entry={entry}
      installedServerId={installedServerId}
      toolNames={tools}
      toolsLoading={toolsLoading}
      toolsError={toolsError}
      onAdd={onAdd}
      onConfigure={onConfigure}
      actions={actions}
      connectionContent={connectionContent}
      routes={routes}
      renderLogo={(catalogEntry) => (
        <CuratedLogo
          curatedKey={catalogEntry.key}
          logoUrl={catalogEntry.logoUrl}
          name={catalogEntry.name}
          size={40}
        />
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

interface CuratedCardProps {
  entry: CuratedMcpServerEntry;
  onOpen: (entry: CuratedMcpServerEntry) => void;
  onAdd: (entry: CuratedMcpServerEntry) => void;
}

function CuratedCard({ entry, onOpen, onAdd }: CuratedCardProps): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(entry);
        }
      }}
      data-testid="mcp-browse-card"
      className="focus-ring group flex cursor-pointer flex-col gap-2 rounded-lg border bg-secondary/20 p-3 text-left transition-colors hover:bg-secondary/40"
    >
      <div className="flex items-start gap-2.5">
        <CuratedLogo
          curatedKey={entry.key}
          logoUrl={entry.logoUrl}
          name={entry.name}
          size={28}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium fg-primary">
            {entry.name}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs fg-secondary">
            {entry.shortDescription}
          </p>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="compact"
          onClick={(event) => {
            event.stopPropagation();
            onAdd(entry);
          }}
          data-testid="mcp-browse-card-add"
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function CuratedSection({
  title,
  entries,
  onOpen,
  onAdd,
}: {
  title: string;
  entries: CuratedMcpServerEntry[];
  onOpen: (entry: CuratedMcpServerEntry) => void;
  onAdd: (entry: CuratedMcpServerEntry) => void;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-2">
      <Heading level={3} variant="label">
        {title}
      </Heading>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {entries.map((entry) => (
          <CuratedCard
            key={entry.key}
            entry={entry}
            onOpen={onOpen}
            onAdd={onAdd}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// McpBrowseDialog
// ---------------------------------------------------------------------------

export interface McpBrowseDialogProps {
  entries: CuratedMcpServerEntry[];
  /** Installed server index — used to join `curatedKey` for installed tools. */
  installedServers: McpServerIndexEntry[];
  onClose: () => void;
  /**
   * Called when the user chooses an entry to add. The parent closes this
   * dialog and opens `McpServerDialog` pre-filled from the entry.
   */
  onAdd: (entry: CuratedMcpServerEntry) => void;
}

/**
 * Claude-Connectors-style browse dialog for the curated MCP server catalog:
 * a Popular section, search over name/description/categories, a card grid, and
 * a drill-in detail view (logo, long description, author, external links, and —
 * for already-installed entries only — discovered-tool chips).
 */
export function McpBrowseDialog({
  entries,
  installedServers,
  onClose,
  onAdd,
}: McpBrowseDialogProps): JSX.Element {
  const browseTitle = useEarlyAccessTitle('Browse MCP Servers');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const installedByKey = useMemo(
    () => buildInstalledCuratedMap(installedServers),
    [installedServers],
  );

  const filtered = useMemo(
    () => filterCuratedEntries(entries, query),
    [entries, query],
  );

  const popular = useMemo(
    () => sortCuratedEntries(filtered.filter((entry) => entry.popular)),
    [filtered],
  );
  const rest = useMemo(
    () => sortCuratedEntries(filtered.filter((entry) => !entry.popular)),
    [filtered],
  );

  const selectedEntry =
    selectedKey !== null
      ? (entries.find((entry) => entry.key === selectedKey) ?? null)
      : null;

  useCurrentUiStateReporter('plugins.mcpBrowseModal', {
    open: true,
    view: selectedEntry ? 'detail' : 'catalog',
    resultCount: filtered.length,
    selectedEntry: selectedEntry
      ? {
          key: selectedEntry.key,
          name: selectedEntry.name,
          installed: installedByKey.has(selectedEntry.key),
        }
      : null,
  });

  const title = selectedEntry ? selectedEntry.name : browseTitle;

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={title}
      titleId="mcp-browse-dialog-title"
      maxWidth="2xl"
      headerBorder={false}
      closeOnBackdrop
      dataTestId="mcp-browse-dialog"
    >
      {selectedEntry ? (
        <CuratedDetail
          entry={selectedEntry}
          installedServerId={installedByKey.get(selectedEntry.key) ?? null}
          onAdd={onAdd}
        />
      ) : (
        <div className="flex flex-1 min-h-0 flex-col gap-4 px-6 pb-6">
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Search servers"
            aria-label="Search servers"
            data-testid="mcp-browse-search"
          />
          <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-sm fg-secondary">
                No servers match your search.
              </p>
            ) : (
              <>
                <CuratedSection
                  title="Popular"
                  entries={popular}
                  onOpen={(entry) => setSelectedKey(entry.key)}
                  onAdd={onAdd}
                />
                <CuratedSection
                  title={popular.length > 0 ? 'All servers' : 'Servers'}
                  entries={rest}
                  onOpen={(entry) => setSelectedKey(entry.key)}
                  onAdd={onAdd}
                />
              </>
            )}
          </div>
        </div>
      )}
    </DialogModal>
  );
}

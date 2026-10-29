import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import {
  MarketplaceSourceStatusNotice,
  MarketplaceSourceRemoveDialog,
  useMarketplaceSourceBulkInstall,
} from '@canopy/ui-app/marketplace-sources';
import {
  installedEntryStatusStates,
  Notice,
  pluginDisplayAuthor,
  pluginDisplayName,
  type PluginsEntryStatusBinding,
} from '@canopy/ui-shared';
import {
  Fragment,
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { CollectionsTab } from '../pages/CollectionsTab';
import { McpServersTab } from '../pages/McpServersTab';
import { PluginDetailView } from '../pages/PluginDetailView';
import { SkillsTab } from '../pages/SkillsTab';
import { ResourceTable } from '../pages/ResourceTable';
import {
  BulkInstallButton,
  MissingPluginsBadge,
  PluginInstallStatusCell,
} from '../pages/MarketplacePluginInstall';
import { PluginsDiscoveryList } from './PluginsDiscoveryList';
import { CapabilityRelatedSections } from './CapabilityRelatedSections';
import {
  applyPluginUpdateToMarketplaceCaches,
  marketplaceSourceOperations,
} from '../../hooks/useMarketplaceList';
import { parseGitHubRepo, formatDate } from '../../lib/format';
import {
  countPluginsNeedingInstall,
  pluginNeedsInstall,
} from '../../lib/pluginInstallStatus';
import type { UnifiedPluginEntry } from '../../lib/unifiedPluginEntries';
import { DialogModal, CloseButton } from '../shared';
import { ErrorBanner, LoadingPlaceholder, EmptyState } from '../shared';
import { RefreshSpinner } from '../shared/loading/spinners/RefreshSpinner';
import { ProviderSupportIcons } from '../shared/ProviderSupportIcons';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { PluginsManagementSectionId } from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import {
  formatMarketplaceRemoveBodyCopy,
  marketplaceSourceHref,
  toMarketplaceSource,
} from '@/client/marketplace-source-summary';
import type {
  MarketplaceInfo,
  MarketplaceRemovalResult,
  PluginInfo,
  PluginProviderSupport,
} from '@canopy/desktop-shared/types/plugins';
import {
  BundleIcon,
  McpServerIcon,
  PluginsIcon,
  SkillIcon,
  StorefrontIcon,
  DotIcon as AppCatalogDotIcon,
  CloseIcon as AppCatalogCloseIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
  FloatingMenu,
  isMenuOpenBodyFlagSet,
} from '@canopy/ui-shared';
import {
  ActionMenuRowStyle,
  useOverlayEscape,
} from '@canopy/ui-shared/components';
import { SidebarPageNav } from '@/components/sidebar/SidebarPageNav';
import { SidebarNavRow } from '@/components/sidebar/SidebarNavRow';
import { sidebarPageTransitionDelay } from '@/components/sidebar/sidebar-page-transition';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useSidebarPageHandoffStore } from '@/stores/sidebarPageHandoffStore';
import { BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE } from '@/lib/browserNativeOverlay';
import { PageContent } from '../shared/PageContent';
import { PageHeading } from '../shared/PageHeading';
import { Tooltip } from '@canopy/ui-shared';
import { useDesktopInstalledItemStatuses } from '@/hooks/useDesktopInstalledItemStatuses';

/**
 * "Your plugins" management view (API-2153).
 *
 * The Plugins page became a discovery surface; every management affordance the
 * old type-tabs owned moved here, unchanged. Sections 2–5 mount the original
 * tab components; section 1 lists the installed entries from the same unified
 * projection discovery uses.
 */
/**
 * Alias of the shared `PluginsManagementSectionId`. The canonical literal list
 * lives in `packages/desktop-shared/src/types.ts` because the App Advisor
 * action union (`plugins.open_management`) and the UI-state snapshot both
 * target a section; keeping one declaration stops the two from drifting.
 */
export type PluginsManagementSection = PluginsManagementSectionId;

interface ManagementSectionDescriptor {
  id: PluginsManagementSection;
  label: string;
  icon: JSX.Element;
}

const MANAGEMENT_SECTIONS: readonly ManagementSectionDescriptor[] = [
  {
    id: 'installed',
    label: 'Installed plugins',
    icon: <PluginsIcon size={16} />,
  },
  { id: 'skills', label: 'Skills', icon: <SkillIcon size={16} /> },
  {
    id: 'mcp',
    label: 'MCP servers',
    icon: <McpServerIcon size={16} />,
  },
  {
    id: 'collections',
    label: 'Collections',
    icon: <BundleIcon size={16} />,
  },
  {
    id: 'marketplaces',
    label: 'Marketplaces',
    icon: <StorefrontIcon size={16} />,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate a marketplace's per-provider status into the
 * `PluginProviderSupport` shape used by `ProviderSupportIcons`.
 *
 * A marketplace is `claude: 'native'` when Claude reports at least one plugin,
 * and `codex: 'native'` when Codex reports at least one plugin. If only Claude
 * is valid the Codex icon switches to the amber compatibility marker because
 * Claude-only marketplaces still get a Codex-compatibility view downstream.
 */
function marketplaceProviderSupport(
  marketplace: MarketplaceInfo,
): PluginProviderSupport {
  const claudeValid = marketplace.providerStatus.claude.state === 'valid';
  const codexValid = marketplace.providerStatus.codex.state === 'valid';
  return {
    claude: claudeValid ? 'native' : 'none',
    codex: codexValid ? 'native' : claudeValid ? 'compat' : 'none',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRepoForComparison(value: string): string {
  return (parseGitHubRepo(value) ?? value).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

interface RemoveConfirmDialogProps {
  marketplace: MarketplaceInfo;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

function RemoveConfirmDialog({
  marketplace,
  onCancel,
  onConfirm,
}: RemoveConfirmDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState('');

  const body = formatMarketplaceRemoveBodyCopy(marketplace.validProviders);

  useEffect(() => {
    if (typeof window.plugins.onMarketplaceOperationProgress !== 'function') {
      return undefined;
    }
    return window.plugins.onMarketplaceOperationProgress((progress) => {
      if (
        progress.operation === 'remove' &&
        progress.marketplaceId === marketplace.id &&
        progress.status === 'running'
      ) {
        setProgressMessage(progress.message);
      }
    });
  }, [marketplace.id]);

  const handleConfirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setProgressMessage('Removing marketplace from providers…');
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <MarketplaceSourceRemoveDialog
      title="Remove plugin marketplace?"
      message={
        <>
          <p>{body}</p>
          <p className="mt-3 text-xs fg-secondary">
            Marketplace:{' '}
            <span className="ph-mask fg-primary">{marketplace.name}</span>
          </p>
        </>
      }
      busy={busy}
      progress={progressMessage}
      error={error}
      confirmTestId="remove-marketplace-confirm-button"
      onCancel={onCancel}
      onConfirm={() => void handleConfirm()}
    />
  );
}

// ---------------------------------------------------------------------------
// Add Marketplace
// ---------------------------------------------------------------------------

export function AddMarketplaceModal({
  isOpen,
  onClose,
  existingRepos,
  onAdded,
  initialRepo,
}: {
  isOpen: boolean;
  onClose: () => void;
  existingRepos: string[];
  onAdded: (marketplace: MarketplaceInfo) => void;
  initialRepo?: string;
}): JSX.Element | null {
  const [repoInput, setRepoInput] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');

  const parsedRepo = parseGitHubRepo(repoInput);
  const isValid = parsedRepo !== null;

  useEffect(() => {
    if (!isOpen) {
      setRepoInput('');
      setError('');
      setIsSubmitting(false);
      setProgressMessage('');
    } else if (initialRepo) {
      setRepoInput(initialRepo);
    }
  }, [isOpen, initialRepo]);

  useEffect(() => {
    if (!isOpen) return undefined;
    if (typeof window.plugins.onMarketplaceOperationProgress !== 'function') {
      return undefined;
    }
    return window.plugins.onMarketplaceOperationProgress((progress) => {
      if (progress.operation === 'add' && progress.status === 'running') {
        setProgressMessage(progress.message);
      }
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAdd = async (): Promise<void> => {
    setError('');

    const repo = parseGitHubRepo(repoInput);
    if (!repo) {
      setError(
        'Invalid format. Use a GitHub URL or owner/repo (e.g. acme/plugins).',
      );
      return;
    }

    // Duplicate check (case-insensitive)
    const lower = normalizeRepoForComparison(repo);
    if (existingRepos.some((r) => normalizeRepoForComparison(r) === lower)) {
      setError('Marketplace has already been added.');
      return;
    }

    setIsSubmitting(true);
    setProgressMessage('Registering marketplace with Claude and Codex…');
    try {
      const result = await window.plugins.addMarketplace(repo);
      if (!result.success) {
        setError(result.error || 'Failed to add marketplace.');
        return;
      }
      if (result.data?.marketplace) {
        onAdded(result.data.marketplace);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DialogModal
      onClose={onClose}
      title="Add marketplace"
      titleId="add-marketplace-modal-title"
      maxWidth="md"
      headerBorder={false}
    >
      <div className="px-5 pb-5 space-y-4">
        <p className="text-xs fg-secondary">
          Add a GitHub-hosted plugin marketplace. Built-in marketplaces are
          managed by {brandText.appName}.
        </p>
        <p className="text-xs fg-secondary">
          {brandText.appName} will check this repository for both Claude and
          Codex plugin marketplaces.
        </p>
        <label className="block text-s">
          <span className="mb-1.5 block fg-secondary">GitHub repository</span>
          <input
            type="text"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isValid && !isSubmitting)
                void handleAdd();
            }}
            placeholder="owner/repo or https://github.com/owner/repo"
            className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s"
            autoFocus
          />
        </label>

        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={!isValid || isSubmitting}
          className="focus-ring inline-flex items-center rounded-lg bg-accent px-4 py-2 text-s font-medium fg-emphasis disabled:opacity-60"
        >
          {isSubmitting ? 'Adding…' : 'Add'}
        </button>

        {isSubmitting && (
          <div
            className="flex items-center gap-2 rounded-lg border bg-secondary/30 px-3 py-2 text-xs fg-secondary"
            role="status"
            data-testid="add-marketplace-progress"
          >
            <RefreshSpinner spinning />
            <span>{progressMessage || 'Adding marketplace…'}</span>
          </div>
        )}

        {error && <p className="mt-4 text-s fg-destructive">{error}</p>}
      </div>
    </DialogModal>
  );
}

// ---------------------------------------------------------------------------
// Marketplace plugins modal (with detail view)
// ---------------------------------------------------------------------------

export function MarketplacePluginsModal({
  marketplace,
  initialPluginName = null,
  onClose,
}: {
  marketplace: MarketplaceInfo | null;
  /** Plugin name to open directly in the detail view (palette deep link). */
  initialPluginName?: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const operationSnapshot = useSyncExternalStore(
    marketplaceSourceOperations.subscribe,
    marketplaceSourceOperations.getSnapshot,
    marketplaceSourceOperations.getSnapshot,
  );
  const sourceBusy =
    operationSnapshot.refreshing ||
    (marketplace !== null &&
      operationSnapshot.operations[marketplace.id] !== undefined);
  const [selectedPluginName, setSelectedPluginName] = useState<string | null>(
    initialPluginName,
  );
  const [pluginOverrides, setPluginOverrides] = useState<
    Record<string, PluginInfo>
  >({});
  const [nameQuery, setNameQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [installingNames, setInstallingNames] = useState<Set<string>>(
    new Set(),
  );
  const [installErrors, setInstallErrors] = useState<Record<string, string>>(
    {},
  );
  const installingNamesRef = useRef<Set<string>>(new Set());
  const modalEpochRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    modalEpochRef.current += 1;
    return (): void => {
      mountedRef.current = false;
      modalEpochRef.current += 1;
    };
  }, [marketplace?.id]);

  useEffect(() => {
    // Open the palette-requested plugin's detail view when provided, otherwise
    // land on the plugin list.
    setSelectedPluginName(initialPluginName ?? null);
    setPluginOverrides({});
    setNameQuery('');
    setCategoryFilter('');
    setAuthorFilter('');
    setInstallingNames(new Set());
    setInstallErrors({});
    installingNamesRef.current = new Set();
  }, [marketplace?.id, initialPluginName]);

  const plugins: PluginInfo[] = useMemo(
    () => (marketplace?.plugins ?? []).map((p) => pluginOverrides[p.name] || p),
    [marketplace, pluginOverrides],
  );

  const missingPlugins = useMemo(
    () => plugins.filter(pluginNeedsInstall),
    [plugins],
  );

  const { categoryOptions, authorOptions } = useMemo(() => {
    const collect = (
      values: ReadonlyArray<string | undefined>,
    ): { values: string[]; hasNone: boolean } => {
      const set = new Set<string>();
      let hasNone = false;
      for (const v of values) {
        const trimmed = v?.trim();
        if (trimmed) set.add(trimmed);
        else hasNone = true;
      }
      return {
        values: Array.from(set).sort((a, b) => a.localeCompare(b)),
        hasNone,
      };
    };
    return {
      categoryOptions: collect(plugins.map((p) => p.category)),
      // The same corrected attribution the rows below render, so filtering by
      // "Microsoft" matches the plugins the table actually credits to it.
      authorOptions: collect(
        plugins.map((p) => pluginDisplayAuthor(p.marketplaceId, p)),
      ),
    };
  }, [plugins]);

  const NONE_VALUE = '__none__';

  const filteredPlugins = useMemo(() => {
    const query = nameQuery.trim().toLowerCase();
    return plugins
      .filter((p) => {
        const searchableName =
          `${pluginDisplayName(p)} ${p.name}`.toLowerCase();
        if (query && !searchableName.includes(query)) return false;
        if (categoryFilter) {
          const value = p.category?.trim() ?? '';
          if (categoryFilter === NONE_VALUE) {
            if (value) return false;
          } else if (value !== categoryFilter) {
            return false;
          }
        }
        if (authorFilter) {
          const value = pluginDisplayAuthor(p.marketplaceId, p)?.trim() ?? '';
          if (authorFilter === NONE_VALUE) {
            if (value) return false;
          } else if (value !== authorFilter) {
            return false;
          }
        }
        return true;
      })
      .sort((left, right) => {
        if (
          marketplace?.curated === true &&
          left.recommended !== right.recommended
        ) {
          return left.recommended === true ? -1 : 1;
        }
        return pluginDisplayName(left).localeCompare(pluginDisplayName(right));
      });
  }, [plugins, nameQuery, categoryFilter, authorFilter, marketplace?.curated]);

  const recommendedPluginCount =
    marketplace?.curated === true
      ? filteredPlugins.filter((plugin) => plugin.recommended === true).length
      : 0;

  const selectedPlugin = selectedPluginName
    ? (pluginOverrides[selectedPluginName] ??
      plugins.find((p) => p.name === selectedPluginName) ??
      null)
    : null;

  const bulk = useMarketplaceSourceBulkInstall({
    sourceId: marketplace?.id ?? '',
    enabled: marketplace !== null && selectedPluginName === null,
    canStart: (): boolean =>
      installingNamesRef.current.size === 0 && !sourceBusy,
    formatSummary: (outcome, total) => {
      const base = `Installed ${outcome.installed} of ${total}`;
      const failures =
        outcome.failed > 0 ? `${base} — ${outcome.failed} failed` : base;
      return outcome.cancelled > 0 ? `${failures} (cancelled)` : failures;
    },
    stillNeedsInstall: (key): boolean => {
      const plugin = plugins.find((entry) => entry.name === key);
      return plugin !== undefined && pluginNeedsInstall(plugin);
    },
    installPlugin: (_sourceId, key) => {
      const plugin = plugins.find((entry) => entry.name === key);
      return plugin
        ? installOne(plugin, { allowDuringBulk: true })
        : Promise.resolve(false);
    },
  });
  const bulkInstalling = bulk.running;
  const bulkCancelRequested = bulk.cancelling;
  const bulkProgress = bulk.progress;
  const bulkSummary = bulk.summary;
  const handleBulkClick = (): void => {
    if (bulk.running) bulk.cancel();
    else
      bulk.start(
        filteredPlugins.filter(pluginNeedsInstall).map((plugin) => plugin.name),
      );
  };

  useCurrentUiStateReporter(
    'plugins.marketplaceModal',
    marketplace
      ? {
          open: true,
          marketplaceId: marketplace.id,
          marketplaceName: marketplace.name,
          pluginCount: plugins.length,
          filteredPluginCount: filteredPlugins.length,
          missingPluginCount: missingPlugins.length,
          installingCount: installingNames.size,
          errorCount: Object.keys(installErrors).length,
          filters: {
            ...(nameQuery.trim() ? { query: nameQuery.trim() } : {}),
            ...(categoryFilter ? { category: categoryFilter } : {}),
            ...(authorFilter ? { author: authorFilter } : {}),
          },
          bulkInstall: {
            installing: bulkInstalling,
            cancelling: bulkCancelRequested,
            ...(bulkProgress
              ? {
                  progress: {
                    done: bulkProgress.done,
                    total: bulkProgress.total,
                  },
                }
              : {}),
            ...(bulkSummary ? { summary: bulkSummary } : {}),
          },
          selectedPlugin: selectedPlugin
            ? {
                marketplacePluginName:
                  selectedPluginName ?? selectedPlugin.name,
                pluginName: selectedPlugin.name,
                needsInstall: pluginNeedsInstall(selectedPlugin),
                installing: installingNames.has(
                  selectedPluginName ?? selectedPlugin.name,
                ),
              }
            : null,
        }
      : null,
  );

  if (!marketplace) return null;

  const handlePluginUpdated = (
    updated: PluginInfo,
    marketplacePluginName = updated.name,
  ): void => {
    setPluginOverrides((prev) => ({
      ...prev,
      [marketplacePluginName]: updated,
    }));
    // Propagate into the shared marketplace cache so the list's uninstalled
    // counter updates and a reopened modal reflects the install (the modal's
    // local overrides are discarded on close).
    applyPluginUpdateToMarketplaceCaches(
      marketplace.id,
      marketplacePluginName,
      updated,
    );
  };

  const setPluginInstalling = (
    pluginName: string,
    installing: boolean,
  ): void => {
    const next = new Set(installingNamesRef.current);
    if (installing) {
      next.add(pluginName);
    } else {
      next.delete(pluginName);
    }
    installingNamesRef.current = next;
    setInstallingNames(next);
  };

  async function installOne(
    plugin: PluginInfo,
    options: { allowDuringBulk?: boolean } = {},
  ): Promise<boolean> {
    if (!marketplace) return false;
    const epoch = modalEpochRef.current;
    const current = (): boolean =>
      mountedRef.current && modalEpochRef.current === epoch;
    if (!pluginNeedsInstall(plugin)) {
      return true;
    }
    if (bulk.running && !options.allowDuringBulk) {
      return false;
    }
    if (installingNamesRef.current.size > 0) {
      return false;
    }
    const release = marketplaceSourceOperations.acquire(
      marketplace.id,
      'install',
    );
    if (!release) return false;
    const sourceUrl =
      typeof plugin.externalSource === 'string'
        ? plugin.externalSource
        : (plugin.externalSource?.url ?? '');
    setPluginInstalling(plugin.name, true);
    setInstallErrors((prev) => {
      const next = { ...prev };
      delete next[plugin.name];
      return next;
    });
    try {
      const result = await window.plugins.installPlugin(
        marketplace.id,
        plugin.name,
        sourceUrl,
      );
      if (result.success && result.data) {
        applyPluginUpdateToMarketplaceCaches(
          marketplace.id,
          plugin.name,
          result.data,
        );
        if (!current()) return !pluginNeedsInstall(result.data);
        setPluginOverrides((prev) => ({
          ...prev,
          [plugin.name]: result.data ?? plugin,
        }));
        // Treat the install as successful only when the returned plugin no
        // longer needs installing. A "succeeded" clone that yields no plugin
        // content must not be counted as installed.
        if (!pluginNeedsInstall(result.data)) {
          return true;
        }
        setInstallErrors((prev) => ({
          ...prev,
          [plugin.name]: 'Install did not produce any plugin content.',
        }));
        return false;
      }
      if (!current()) return false;
      setInstallErrors((prev) => ({
        ...prev,
        [plugin.name]: result.error || 'Failed to install plugin.',
      }));
      return false;
    } catch (err) {
      if (!current()) return false;
      setInstallErrors((prev) => ({
        ...prev,
        [plugin.name]: errorMessage(err),
      }));
      return false;
    } finally {
      release();
      if (current()) setPluginInstalling(plugin.name, false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={
          selectedPlugin
            ? 'plugin-detail-title'
            : 'marketplace-plugins-modal-title'
        }
        className="w-full max-w-5xl rounded-2xl bg-card p-5 shadow-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {!selectedPlugin && (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2
                id="marketplace-plugins-modal-title"
                className="text-lg font-semibold fg-primary"
              >
                {marketplace.name}
              </h2>
              {marketplace.description && (
                <p className="text-s fg-secondary mt-0.5">
                  {marketplace.description}
                </p>
              )}
            </div>
            <div className="shrink-0">
              <CloseButton onClick={onClose} />
            </div>
          </div>
        )}

        {!selectedPlugin &&
          (missingPlugins.length > 0 || bulkInstalling || bulkSummary) && (
            <div className="mt-3 flex items-center justify-end">
              <BulkInstallButton
                disabled={
                  !bulkInstalling && (installingNames.size > 0 || sourceBusy)
                }
                missingCount={filteredPlugins.filter(pluginNeedsInstall).length}
                installing={bulkInstalling}
                progress={bulkProgress ?? undefined}
                summary={bulkSummary || undefined}
                onClick={handleBulkClick}
              />
            </div>
          )}

        {!selectedPlugin && plugins.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-4 pt-1 pl-1">
            <input
              type="text"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="Search by name…"
              className="focus-ring flex-1 min-w-40 rounded-md border bg-base px-2.5 py-1.5 text-xs"
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="focus-ring rounded-md border bg-base px-2 py-1.5 text-xs fg-primary"
            >
              <option value="">All categories</option>
              {categoryOptions.hasNone && (
                <option value={NONE_VALUE}>None</option>
              )}
              {categoryOptions.values.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={authorFilter}
              onChange={(e) => setAuthorFilter(e.target.value)}
              className="focus-ring rounded-md border bg-base px-2 py-1.5 text-xs fg-primary"
            >
              <option value="">All authors</option>
              {authorOptions.hasNone && (
                <option value={NONE_VALUE}>None</option>
              )}
              {authorOptions.values.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        )}

        <div
          className={`flex flex-col flex-1 min-h-0 ${selectedPlugin ? '' : 'mt-3'}`}
        >
          {selectedPlugin ? (
            // The shared plugin detail content blocks the README and
            // component file text itself.
            <div className="overflow-auto min-h-0">
              <PluginDetailView
                plugin={selectedPlugin}
                marketplace={marketplace}
                onBack={() => setSelectedPluginName(null)}
                onPluginUpdated={(updated) =>
                  handlePluginUpdated(
                    updated,
                    selectedPluginName ?? selectedPlugin.name,
                  )
                }
                relatedContent={
                  <CapabilityRelatedSections
                    flush
                    subject={{
                      kind: 'plugin',
                      marketplaceId: marketplace.id,
                      pluginName: selectedPlugin.name,
                    }}
                    subjectEntryId={
                      marketplace.curated === true
                        ? `curated:${selectedPlugin.name}`
                        : `mkt:${marketplace.id}/${selectedPlugin.name}`
                    }
                    onBeforeNavigate={onClose}
                  />
                }
                headerActions={<CloseButton onClick={onClose} />}
              />
            </div>
          ) : (
            <>
              {plugins.length > 0 ? (
                <>
                  {filteredPlugins.length > 0 ? (
                    <div className="border rounded-lg overflow-auto min-h-0">
                      <table className="w-full text-s border-separate border-spacing-0">
                        <thead>
                          <tr>
                            <th className="sticky top-0 z-10 w-full bg-secondary text-left px-4 py-3 font-medium fg-secondary border-b rounded-tl-lg">
                              Name
                            </th>
                            <th className="sticky top-0 z-10 bg-secondary text-left px-4 py-3 font-medium fg-secondary border-b">
                              Providers
                            </th>
                            <th className="sticky top-0 z-10 bg-secondary text-left px-4 py-3 font-medium fg-secondary border-b">
                              Version
                            </th>
                            <th className="sticky top-0 z-10 bg-secondary text-left px-4 py-3 font-medium fg-secondary border-b">
                              Category
                            </th>
                            <th className="sticky top-0 z-10 bg-secondary text-left px-4 py-3 font-medium fg-secondary border-b">
                              Author
                            </th>
                            <th className="sticky top-0 z-10 bg-secondary text-center px-2 py-3 font-medium fg-secondary border-b rounded-tr-lg">
                              <span className="sr-only">Status</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredPlugins.map((p, index) => (
                            <Fragment key={p.name}>
                              {recommendedPluginCount > 0 && index === 0 && (
                                <tr
                                  data-testid="recommended-plugins-section"
                                  className="bg-accent/5"
                                >
                                  <td
                                    colSpan={6}
                                    className="px-4 py-2 text-xs font-semibold fg-accent border-b"
                                  >
                                    Recommended for you
                                  </td>
                                </tr>
                              )}
                              {recommendedPluginCount > 0 &&
                                index === recommendedPluginCount && (
                                  <tr className="bg-secondary/40">
                                    <td
                                      colSpan={6}
                                      className="px-4 py-2 text-xs font-semibold fg-secondary border-b"
                                    >
                                      More plugins
                                    </td>
                                  </tr>
                                )}
                              <tr
                                onClick={() => setSelectedPluginName(p.name)}
                                className="group [&>td]:border-b last:[&>td]:border-b-0 [&:hover>td]:bg-secondary/30 [&>td]:transition-colors cursor-pointer"
                                data-testid={`plugin-row-${p.name}`}
                              >
                                <td className="px-4 py-3 max-w-0">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="block min-w-0 truncate fg-primary font-medium group-hover:fg-accent transition-colors">
                                      {pluginDisplayName(p)}
                                    </span>
                                    {marketplace.curated === true &&
                                      p.recommended === true && (
                                        <span
                                          data-testid={`plugin-recommendation-badge-${p.name}`}
                                          className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-2xs font-medium fg-accent"
                                        >
                                          Recommended
                                        </span>
                                      )}
                                  </div>
                                  {p.description && (
                                    <p className="text-xs fg-secondary mt-0.5 truncate">
                                      {p.description}
                                    </p>
                                  )}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  <ProviderSupportIcons
                                    support={p.providerSupport}
                                    codexCompatDisabled={p.codexCompatDisabled}
                                  />
                                </td>
                                <td className="px-4 py-3 fg-secondary whitespace-nowrap">
                                  {p.version || '—'}
                                </td>
                                <td className="px-4 py-3 fg-secondary max-w-30">
                                  <span
                                    className="block truncate"
                                    title={p.category || undefined}
                                  >
                                    {p.category || '—'}
                                  </span>
                                </td>
                                <td className="px-4 py-3 fg-secondary max-w-37.5">
                                  <span
                                    className="block truncate"
                                    title={
                                      pluginDisplayAuthor(p.marketplaceId, p) ||
                                      undefined
                                    }
                                  >
                                    {pluginDisplayAuthor(p.marketplaceId, p) ||
                                      '—'}
                                  </span>
                                </td>
                                <td
                                  className="px-2 py-3 text-center"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <PluginInstallStatusCell
                                    pluginName={p.name}
                                    needsInstall={pluginNeedsInstall(p)}
                                    installing={installingNames.has(p.name)}
                                    disabled={bulkInstalling || sourceBusy}
                                    error={installErrors[p.name]}
                                    onInstall={() => void installOne(p)}
                                  />
                                </td>
                              </tr>
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <p className="text-s fg-secondary">
                        No plugins match the current filters
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-s fg-secondary">
                    No plugins found in this marketplace
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {!selectedPlugin && (
          <div className="mt-3 text-xs fg-secondary text-right">
            {filteredPlugins.length === plugins.length
              ? `${plugins.length} ${plugins.length === 1 ? 'plugin' : 'plugins'}`
              : `${filteredPlugins.length} of ${plugins.length} plugins`}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marketplace row actions (overflow menu)
// ---------------------------------------------------------------------------

interface RowActionsMenuProps {
  onRemove: () => void;
  disabled?: boolean;
}

function RowActionsMenu({
  onRemove,
  disabled = false,
}: RowActionsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <span className="inline-block">
      <Tooltip label="More actions">
        <button
          ref={triggerRef}
          type="button"
          onPointerDown={() => {
            // The open menu dismisses on pointerdown and consumes this press's
            // click. Open here when taking over from another row's menu.
            if (!open && isMenuOpenBodyFlagSet(document)) setOpen(true);
          }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          disabled={disabled}
          aria-label="More marketplace actions"
          aria-haspopup="menu"
          aria-expanded={open}
          className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <AppCatalogDotIcon width="14" height="14" />
        </button>
      </Tooltip>
      {/* Portaled so the table wrapper's overflow clipping can't cut off the
          menu on the last row. React still bubbles portal clicks to the row,
          so the surface stops propagation. */}
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        className="min-w-45"
        onClick={(e) => e.stopPropagation()}
      >
        <ActionMenuRowStyle>
          <DropdownMenuItem
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            tone="destructive"
            data-testid="remove-marketplace-action"
          >
            <DropdownMenuItemIcon>
              <TrashIcon />
            </DropdownMenuItemIcon>
            Remove marketplace
          </DropdownMenuItem>
        </ActionMenuRowStyle>
      </FloatingMenu>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Marketplace table
// ---------------------------------------------------------------------------

function MarketplaceTable({
  marketplaces,
  loading,
  error,
  progressMessage,
  lastRefreshed,
  onRefresh,
  onAddClick,
  onUpdate,
  onRowClick,
  onRequestRemove,
}: {
  marketplaces: MarketplaceInfo[];
  loading: boolean;
  error: string | null;
  progressMessage: string | null;
  lastRefreshed: string | null;
  onRefresh: () => Promise<void>;
  onAddClick: () => void;
  onUpdate: (id: string) => Promise<string | null>;
  onRowClick: (marketplace: MarketplaceInfo) => void;
  onRequestRemove: (marketplace: MarketplaceInfo) => void;
}): JSX.Element {
  const operationSnapshot = useSyncExternalStore(
    marketplaceSourceOperations.subscribe,
    marketplaceSourceOperations.getSnapshot,
    marketplaceSourceOperations.getSnapshot,
  );
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const handleUpdate = async (m: MarketplaceInfo): Promise<void> => {
    setUpdatingId(m.id);
    setUpdateError(null);
    try {
      const err = await onUpdate(m.id);
      if (err) setUpdateError(err);
    } catch (e) {
      setUpdateError(errorMessage(e));
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs fg-secondary">
          {lastRefreshed ? `Last refreshed ${formatDate(lastRefreshed)}` : ''}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void onRefresh()}
            disabled={
              loading ||
              operationSnapshot.refreshing ||
              Object.keys(operationSnapshot.operations).length > 0
            }
            data-testid="marketplaces-refresh"
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle transition-colors focus-ring disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            onClick={onAddClick}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent fg-emphasis hover:bg-accent/90 transition-colors focus-ring"
          >
            Add marketplace
          </button>
        </div>
      </div>

      {/* Error */}
      <ErrorBanner error={error} />
      <ErrorBanner error={updateError} />

      {loading && progressMessage && (
        <div
          className="mb-3 flex items-center gap-2 rounded-lg border bg-secondary/30 px-3 py-2 text-xs fg-secondary"
          role="status"
          data-testid="marketplace-list-progress"
        >
          <RefreshSpinner spinning />
          <span>{progressMessage}</span>
        </div>
      )}

      {/* Loading */}
      {loading && marketplaces.length === 0 && (
        <LoadingPlaceholder
          label={progressMessage || 'Loading marketplaces…'}
          space="page"
        />
      )}

      {/* Table */}
      {marketplaces.length > 0 && (
        <ResourceTable
          headers={[
            { label: 'Name', align: 'left' },
            { label: 'Providers', align: 'left' },
            { label: 'Plugins', align: 'right' },
            { label: 'Last updated', align: 'left' },
            { label: 'Source', align: 'left' },
            { label: '', align: 'right' },
          ]}
        >
          {marketplaces
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((m) => {
              const support = marketplaceProviderSupport(m);
              const isBuiltIn = m.builtIn === true;
              const isCurated = m.curated === true;
              // Managed marketplaces (built-in and curated) are provisioned by
              // Canopy itself and always usable, so neither renders the
              // destructive "broken on all providers" banner (which offers
              // removal).
              const isManaged = isBuiltIn || isCurated;
              const isBrokenForAllProviders =
                !isManaged && m.validProviders.length === 0;
              const sourceHref = isManaged ? null : marketplaceSourceHref(m);
              const sourceBadge = isBuiltIn
                ? 'Built-in'
                : isCurated
                  ? 'Curated'
                  : m.sourceType;
              const sourceLabel = isManaged
                ? brandText.appName
                : m.sourceType === 'github' && m.sourceUrl
                  ? (parseGitHubRepo(m.sourceUrl) ?? m.sourceUrl)
                  : m.sourceUrl;
              return (
                <tr
                  key={m.id}
                  onClick={() => onRowClick(m)}
                  className={`group border-b last:border-b-0 transition-colors cursor-pointer ${
                    isBrokenForAllProviders
                      ? 'bg-destructive/5 hover:bg-destructive-subtle'
                      : 'hover:bg-secondary/30'
                  }`}
                  data-testid={`marketplace-row-${m.id}`}
                >
                  <td className="px-4 py-3 fg-primary font-medium group-hover:fg-accent transition-colors">
                    {m.name}
                    {isBrokenForAllProviders && (
                      <InvalidMarketplaceBanner
                        marketplace={m}
                        updating={updatingId === m.id}
                        onRetry={() => handleUpdate(m)}
                        onRemove={() => onRequestRemove(m)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {isBrokenForAllProviders ? (
                      <span className="text-xs fg-destructive">
                        No providers
                      </span>
                    ) : (
                      <ProviderSupportIcons support={support} />
                    )}
                  </td>
                  <td className="px-4 py-3 text-right fg-primary tabular-nums">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {m.pluginCount}
                      <MissingPluginsBadge
                        count={countPluginsNeedingInstall(m)}
                        testId={`marketplace-missing-count-${m.id}`}
                      />
                    </span>
                  </td>
                  <td className="px-4 py-3 fg-secondary">
                    <span className="inline-flex items-center gap-1.5">
                      {m.lastUpdated ? formatDate(m.lastUpdated) : '—'}
                      {!isCurated && (
                        <Tooltip label="Check for updates">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleUpdate(m);
                            }}
                            disabled={
                              updatingId === m.id ||
                              operationSnapshot.refreshing ||
                              operationSnapshot.operations[m.id] !== undefined
                            }
                            aria-label="Check for updates"
                            data-testid={`marketplace-update-${m.id}`}
                            className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-50"
                          >
                            <RefreshSpinner spinning={updatingId === m.id} />
                          </button>
                        </Tooltip>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 fg-secondary">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-3xs bg-secondary px-1.5 py-0.5 rounded font-medium">
                        {sourceBadge}
                      </span>
                      {sourceHref ? (
                        <a
                          href={sourceHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline hover:fg-primary transition-colors"
                        >
                          {sourceLabel}
                        </a>
                      ) : (
                        sourceLabel
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isManaged && (
                      <RowActionsMenu
                        onRemove={() => onRequestRemove(m)}
                        disabled={
                          updatingId === m.id ||
                          operationSnapshot.refreshing ||
                          operationSnapshot.operations[m.id] !== undefined
                        }
                      />
                    )}
                  </td>
                </tr>
              );
            })}
        </ResourceTable>
      )}

      {/* Empty state */}
      {!loading && marketplaces.length === 0 && !error && (
        <EmptyState
          title="No plugin marketplaces"
          subtitle="No plugin marketplaces are installed yet."
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Invalid-marketplace inline banner
// ---------------------------------------------------------------------------

function InvalidMarketplaceBanner({
  marketplace,
  updating,
  onRetry,
  onRemove,
}: {
  marketplace: MarketplaceInfo;
  updating: boolean;
  onRetry: () => Promise<void>;
  onRemove: () => void;
}): JSX.Element {
  const source = toMarketplaceSource(marketplace);
  return (
    <MarketplaceSourceStatusNotice
      source={{
        ...source,
        status: {
          ...source.status,
          ...(source.status.note
            ? {
                note: source.status.note.replace(
                  'Use Update',
                  'Use Retry refresh',
                ),
              }
            : {}),
        },
      }}
      updating={updating}
      onUpdate={() => {
        void onRetry();
      }}
      onRemove={onRemove}
      legacy={{
        banner: `marketplace-error-banner-${marketplace.id}`,
        update: `marketplace-retry-${marketplace.id}`,
        remove: `marketplace-remove-${marketplace.id}`,
        note: `marketplace-codex-structural-note-${marketplace.id}`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Management view
// ---------------------------------------------------------------------------

interface RemovalToast {
  marketplaceId: string;
  message: string;
}

export interface PluginsManagementViewProps {
  open: boolean;
  /**
   * Section to show. The page keeps this in sync through `onSectionChange`, so
   * a deep link firing while the view is already open still re-targets it.
   */
  initialSection: PluginsManagementSection;
  /**
   * Keep the active section mounted (hidden and inert) while closed. The page
   * sets it while a detail opened from this view is showing, so Back returns
   * to the same list with its tab, filters and scroll intact (CAN-3483).
   */
  retainContent?: boolean;
  onClose: () => void;
  onSectionChange?: (section: PluginsManagementSection) => void;
  /** Installed shows only Active items while set (CAN-4255). */
  statusFilter?: 'active' | null;
  onClearStatusFilter?: () => void;
  /** Unified projection; the Installed section lists everything present locally. */
  entries: UnifiedPluginEntry[];
  selectedEntryId: string | null;
  onSelectEntry: (entry: UnifiedPluginEntry) => void;
  /**
   * Opens an installed skill's Marketplace detail page from the Skills list,
   * or with `edit` its edit page (CAN-3485).
   */
  onOpenSkill: (skill: {
    sourceId: string;
    name: string;
    filePath?: string;
    edit?: true;
  }) => void;
  /**
   * Marketplace cache state. Owned by the page's single `useMarketplaceList`
   * so this view does not trigger a second `loadMarketplaces` round-trip.
   */
  marketplaces: MarketplaceInfo[];
  marketplacesLoading: boolean;
  marketplacesError: string | null;
  marketplacesProgressMessage: string | null;
  marketplacesLastRefreshed: string | null;
  onRefreshMarketplaces: () => Promise<void>;
  onMarketplaceUpserted: (marketplace: MarketplaceInfo) => void;
  onMarketplaceRemoved: (
    marketplaceId: string,
    result: MarketplaceRemovalResult,
  ) => void;
  /** Opens the page-owned `MarketplacePluginsModal` for a marketplace row. */
  onOpenMarketplace: (marketplace: MarketplaceInfo) => void;
  /** Opens the page-owned `AddMarketplaceModal`. */
  onAddMarketplace: () => void;
  onAddMarketplaceFromSkills?: (repo: string) => void;
  onOpenAccountSettings?: () => void;
}

/** Milliseconds a partial-removal toast stays up before self-dismissing. */
const REMOVAL_TOAST_TIMEOUT_MS = 8000;

export function PluginsManagementView({
  open,
  initialSection,
  retainContent = false,
  onClose,
  onSectionChange,
  statusFilter = null,
  onClearStatusFilter,
  entries,
  selectedEntryId,
  onSelectEntry,
  onOpenSkill,
  marketplaces,
  marketplacesLoading,
  marketplacesError,
  marketplacesProgressMessage,
  marketplacesLastRefreshed,
  onRefreshMarketplaces,
  onMarketplaceUpserted,
  onMarketplaceRemoved,
  onOpenMarketplace,
  onAddMarketplace,
  onAddMarketplaceFromSkills,
  onOpenAccountSettings,
}: PluginsManagementViewProps): JSX.Element {
  const [activeSection, setActiveSection] =
    useState<PluginsManagementSection>(initialSection);
  const [syncedOpen, setSyncedOpen] = useState(open);
  const [syncedSection, setSyncedSection] =
    useState<PluginsManagementSection>(initialSection);
  const [removeTarget, setRemoveTarget] = useState<MarketplaceInfo | null>(
    null,
  );
  const [removalToast, setRemovalToast] = useState<RemovalToast | null>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarWidth = useSidebarStore((state) => state.width);
  const setSidebarWidth = useSidebarStore((state) => state.setWidth);
  // Keep the closed shell mounted like App Settings. Its invisible
  // `data-open=false` state is the transition's starting frame; remounting it
  // only after opening would place the sidebar at the animation endpoint.
  const [overlayVisible, setOverlayVisible] = useState(open);
  const setSidebarPageHandoffActive = useSidebarPageHandoffStore(
    (state) => state.setActive,
  );

  // The shared sidebar material is intentionally translucent on macOS. Match
  // App Settings' coordinated handoff so the persistent main navigation fades
  // away instead of showing through this page's sidebar.
  useLayoutEffect(() => {
    setSidebarPageHandoffActive(open);
    return (): void => setSidebarPageHandoffActive(false);
  }, [open, setSidebarPageHandoffActive]);

  // Escape joins the shared overlay stack, so a dialog opened on top of this
  // view (remove-confirm, skill viewer, collection editor…) consumes Escape
  // first and only the topmost surface closes. This view is a page, so it
  // stays beneath a dialog even when it opens while the dialog is up.
  useOverlayEscape(open, onClose, undefined, { layer: 'page' });

  // Section is reconciled DURING render, never in an effect. Child effects run
  // before parent effects, so an effect-based sync would commit one frame of
  // the *previous* session's section first — mounting a tab the user did not
  // ask for and firing its mount effects (`McpServersTab` immediately kicks a
  // `listStatus()` plus a sequential `checkHealth` sweep of every configured
  // server) only to unmount it on the next commit. React discards this render
  // pass and re-runs the component before any child renders.
  if (open !== syncedOpen || initialSection !== syncedSection) {
    setSyncedOpen(open);
    setSyncedSection(initialSection);
    if (open) {
      setActiveSection(initialSection);
    }
  }

  useEffect(() => {
    if (!open) {
      setRemoveTarget(null);
      setRemovalToast(null);
      return;
    }
    backButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open) {
      setOverlayVisible(true);
      return;
    }

    const delay = sidebarPageTransitionDelay();
    if (delay === 0) {
      setOverlayVisible(false);
      return;
    }
    const timeout = window.setTimeout(() => setOverlayVisible(false), delay);
    return (): void => window.clearTimeout(timeout);
  }, [open]);

  // Auto-dismiss partial-failure toasts. Persisting them forever would dam up
  // the section if a flaky provider keeps failing on subsequent removes.
  useEffect(() => {
    if (!removalToast) return undefined;
    const handle = window.setTimeout(
      () => setRemovalToast(null),
      REMOVAL_TOAST_TIMEOUT_MS,
    );
    return (): void => window.clearTimeout(handle);
  }, [removalToast]);

  const installedStatus = useDesktopInstalledItemStatuses(
    (open || retainContent) && activeSection === 'installed',
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const entryStatusStates = useMemo(
    () => installedEntryStatusStates(entries, installedStatus.state),
    [entries, installedStatus.state],
  );
  const installedEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (entry.state !== 'available') return true;
        const state = entryStatusStates[entry.id];
        return (
          state?.kind === 'ready' &&
          state.item.notices.some((notice) => notice.code === 'partial_removal')
        );
      }),
    [entries, entryStatusStates],
  );

  const { pendingKeys: statusPendingKeys, setStatus: setInstalledStatus } =
    installedStatus;
  const setEntryStatus = useCallback<
    NonNullable<PluginsEntryStatusBinding['onSetStatus']>
  >(
    (target, status) => {
      setStatusError(null);
      return setInstalledStatus(target, status);
    },
    [setInstalledStatus],
  );
  const entryStatus = useMemo(
    (): PluginsEntryStatusBinding => ({
      states: entryStatusStates,
      pendingKeys: statusPendingKeys,
      onSetStatus: setEntryStatus,
      onError: setStatusError,
    }),
    [entryStatusStates, statusPendingKeys, setEntryStatus],
  );
  const visibleInstalledEntries = useMemo(() => {
    if (statusFilter !== 'active') return installedEntries;
    return installedEntries.filter((entry) => {
      const state = entryStatusStates[entry.id];
      return state?.kind === 'ready' && state.item.status === 'active';
    });
  }, [installedEntries, entryStatusStates, statusFilter]);

  useCurrentUiStateReporter(
    'plugins.managementView',
    open
      ? {
          section: activeSection,
          installedCount: installedEntries.length,
          removeMarketplaceModal: removeTarget
            ? {
                marketplaceId: removeTarget.id,
                marketplaceName: removeTarget.name,
                validProviders: removeTarget.validProviders,
              }
            : null,
        }
      : null,
  );

  const handleNavigate = (section: PluginsManagementSection): void => {
    setActiveSection(section);
    onSectionChange?.(section);
  };

  const handleUpdateMarketplace = async (
    id: string,
  ): Promise<string | null> => {
    const release = marketplaceSourceOperations.acquire(id, 'update');
    if (!release)
      return 'This marketplace is busy. Try again when the current operation finishes.';
    try {
      const result = await window.plugins.updateMarketplace(id);
      if (result.success && result.data) {
        onMarketplaceUpserted(result.data);
        return null;
      }
      return result.error || 'Failed to update marketplace.';
    } finally {
      release();
    }
  };

  const handleConfirmRemove = async (): Promise<void> => {
    if (!removeTarget) return;
    const target = removeTarget;
    const release = marketplaceSourceOperations.acquire(target.id, 'remove');
    if (!release)
      throw new Error(
        'This marketplace is busy. Try again when the current operation finishes.',
      );
    try {
      const result = await window.plugins.removeMarketplace(target.id);
      if (!result.success) {
        throw new Error(result.error || 'Failed to remove marketplace.');
      }
      const data: MarketplaceRemovalResult | undefined = result.data;
      if (!data) {
        throw new Error('Removal succeeded but the response was empty.');
      }
      onMarketplaceRemoved(target.id, data);
      const claudeErr = data.providerOutcomes.claude.error;
      const codexErr = data.providerOutcomes.codex.error;
      if (data.marketplace !== null && (claudeErr || codexErr)) {
        const parts: string[] = [];
        if (claudeErr) parts.push(`Claude: ${claudeErr}`);
        if (codexErr) parts.push(`Codex: ${codexErr}`);
        setRemovalToast({
          marketplaceId: target.id,
          message: `Could not fully remove “${target.name}”. ${parts.join('; ')}`,
        });
      } else {
        setRemovalToast(null);
      }
      setRemoveTarget(null);
    } finally {
      release();
    }
  };

  return (
    <div
      {...(open
        ? { [BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE]: 'true' }
        : undefined)}
      inert={!open}
      aria-hidden={open ? undefined : 'true'}
      // Deliberately below the z-40 dialog layer: every dialog the moved tab
      // components own (`DialogModal` portals to `document.body`) must paint
      // above this surface without each of them needing an overlay-z override.
      className={`settings-page-overlay fixed inset-0 z-30 flex fg-primary ${
        open ? '' : 'pointer-events-none'
      } ${overlayVisible ? '' : 'invisible'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Your plugins"
      data-open={open ? 'true' : 'false'}
      data-testid="plugins-management-view"
    >
      <div className="flex h-full shrink-0" data-testid="settings-sidebar-page">
        <SidebarPageNav
          ariaLabel="Plugin settings"
          sidebarTestId="plugins-management-sidebar"
          backTestId="plugins-management-back"
          resizeHandleTestId="plugins-management-sidebar-resize-handle"
          scrollViewportTestId="plugins-management-nav-scroll-container"
          onBack={onClose}
          width={sidebarWidth}
          onResize={setSidebarWidth}
          backButtonRef={backButtonRef}
        >
          <nav
            aria-label="Plugin management sections"
            className="mt-3 flex flex-col gap-px"
          >
            {MANAGEMENT_SECTIONS.map((section) => (
              <SidebarNavRow
                key={section.id}
                onClick={() => handleNavigate(section.id)}
                aria-current={activeSection === section.id ? 'page' : undefined}
                data-testid={`plugins-management-nav-${section.id}`}
                className="text-left"
                selected={activeSection === section.id}
                icon={section.icon}
              >
                {section.label}
              </SidebarNavRow>
            ))}
          </nav>
        </SidebarPageNav>
      </div>

      <div
        className={`flex min-w-0 flex-1 flex-col bg-base ${
          open ? '' : 'invisible'
        }`}
        data-testid="plugins-management-content"
      >
        <div className="electron-drag h-10 shrink-0" />
        <div className="page-scroll-gutter flex-1 overflow-y-auto">
          {(open || retainContent) && (
            <PageContent
              bottomInset="spacious"
              data-testid={`plugins-management-section-${activeSection}`}
            >
              {activeSection === 'installed' && (
                <>
                  <PageHeading
                    title="Installed plugins"
                    subtitle="Everything currently installed for this app — plugins, apps, and skills. Open one to see its components and manage it."
                  />
                  {statusFilter === 'active' && (
                    <Notice
                      className="mt-6"
                      data-testid="plugins-installed-status-filter"
                      onDismiss={onClearStatusFilter}
                      dismissLabel="Show all installed items"
                      dismissTestId="plugins-installed-status-filter-clear"
                    >
                      Showing Active items
                    </Notice>
                  )}
                  {statusError && (
                    <Notice
                      intent="destructive"
                      role="alert"
                      className="mt-6"
                      data-testid="plugins-installed-status-error"
                      onDismiss={() => setStatusError(null)}
                    >
                      {statusError}
                    </Notice>
                  )}
                  <div className="mt-6">
                    <PluginsDiscoveryList
                      sections={[
                        {
                          id: 'installed',
                          // This surface already has its own "Installed plugins"
                          // heading above; an empty title suppresses the list's.
                          title: '',
                          entries: visibleInstalledEntries,
                        },
                      ]}
                      entryStatus={entryStatus}
                      selectedEntryId={selectedEntryId}
                      onSelectEntry={onSelectEntry}
                      onAddEntry={onSelectEntry}
                      // Needs-auth entries get the same Connect shortcut they have
                      // in discovery — the detail surface is what routes into the
                      // existing auth flow, so both entry points land identically.
                      onConnectEntry={onSelectEntry}
                      emptyMessage={
                        statusFilter === 'active'
                          ? 'Nothing is active yet.'
                          : `Nothing is installed yet. Browse ${CUSTOMIZE_LABEL} to get started.`
                      }
                    />
                  </div>
                </>
              )}

              {activeSection === 'skills' && (
                <>
                  <PageHeading
                    title="Skills"
                    subtitle={
                      <>
                        Install{' '}
                        <a
                          href="https://agentskills.io/home"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="fg-accent hover:underline"
                        >
                          Agent skills
                        </a>{' '}
                        to enhance agent capabilities.
                      </>
                    }
                  />
                  <div className="mt-6">
                    <SkillsTab
                      onOpenSkill={onOpenSkill}
                      onAddMarketplace={onAddMarketplaceFromSkills}
                      onOpenAccountSettings={onOpenAccountSettings}
                    />
                  </div>
                </>
              )}

              {activeSection === 'mcp' && (
                <>
                  <PageHeading
                    title="MCP servers"
                    subtitle="Register and configure MCP servers for use in chat sessions and collections."
                  />
                  <div className="mt-6">
                    <McpServersTab />
                  </div>
                </>
              )}

              {activeSection === 'collections' && (
                <>
                  <PageHeading
                    title="Collections"
                    subtitle="Reusable collections of skills, plugins, and MCP servers."
                  />
                  <div className="mt-6">
                    <CollectionsTab
                      onOpenAccountSettings={onOpenAccountSettings}
                    />
                  </div>
                </>
              )}

              {activeSection === 'marketplaces' && (
                <>
                  <PageHeading
                    title="Marketplaces"
                    subtitle={
                      <>
                        Marketplaces distribute plugins for supported agents.
                        Each plugin can include skills, commands, agents, MCP
                        servers and/or LSP servers. {brandText.appName} checks
                        supported providers when adding or refreshing a
                        repository.
                      </>
                    }
                  />
                  <div className="mt-3 mb-6 space-y-2 text-s fg-secondary">
                    <p>
                      {brandText.appName} includes a built-in marketplace and
                      can also add GitHub-hosted marketplaces. Built-in plugins
                      work inside {brandText.appName}; installing them to Claude
                      or Codex is optional.
                    </p>
                    <p>
                      Learn more:{' '}
                      <a
                        href="https://developers.openai.com/codex/plugins/build"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="fg-accent hover:underline"
                      >
                        Codex
                      </a>{' '}
                      |{' '}
                      <a
                        href="https://code.claude.com/docs/en/discover-plugins"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="fg-accent hover:underline"
                      >
                        Claude
                      </a>
                    </p>
                  </div>
                  <MarketplaceTable
                    marketplaces={marketplaces}
                    loading={marketplacesLoading}
                    error={marketplacesError}
                    progressMessage={marketplacesProgressMessage}
                    lastRefreshed={marketplacesLastRefreshed}
                    onRefresh={onRefreshMarketplaces}
                    onAddClick={onAddMarketplace}
                    onUpdate={handleUpdateMarketplace}
                    onRowClick={onOpenMarketplace}
                    onRequestRemove={setRemoveTarget}
                  />
                  {removalToast && (
                    <div
                      role="status"
                      className="fixed bottom-4 right-4 z-toast max-w-md rounded-lg bg-warning-subtle px-4 py-3 text-xs fg-warning shadow-lg"
                      data-testid="marketplace-removal-toast"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="leading-snug">{removalToast.message}</p>
                        <button
                          type="button"
                          onClick={() => setRemovalToast(null)}
                          className="-mt-1 -mr-1 rounded p-1 fg-warning hover:bg-warning-subtle"
                          aria-label="Dismiss"
                        >
                          <AppCatalogCloseIcon width="10" height="10" />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </PageContent>
          )}
        </div>
      </div>

      {removeTarget && (
        <RemoveConfirmDialog
          marketplace={removeTarget}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={handleConfirmRemove}
        />
      )}
    </div>
  );
}

import {
  type JSX,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import { useCollectionList } from '../../hooks/useCollectionList';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useSharedCollectionList } from '../../hooks/useSharedCollectionList';
import { useUnifiedTableData } from '../../hooks/useUnifiedTableData';
import type { UnifiedTableRow } from '../../hooks/useUnifiedTableData';
import { useSkillList } from '../../hooks/useSkillList';
import { useMarketplaceList } from '../../hooks/useMarketplaceList';
import { formatDate } from '../../lib/format';
import { ShareCollectionModal } from '../collections/ShareCollectionModal';
import { useNavigationStore } from '@/stores/navigationStore';
import { useShareAccess } from '@/hooks/useShareAccess';
import { SHARE_COLLECTION_GATE_CONTEXT } from '@/lib/share-gate-context';
import { EntityEditModalContent } from './EntityEditModalFooter';
import { DialogModal } from '../shared';
import {
  createEntityEditModalFooterProps,
  runCancellableModalLoad,
  runEntityEditOperation,
} from './entityEditModalUtils';
import {
  ErrorBanner,
  LoadingPlaceholder,
  EmptyState,
  DeleteConfirmModal,
} from '../shared';
import { UnifiedTable } from '../shared/UnifiedTable';
import { SECONDARY_ACTION_BUTTON_CLASS } from '@canopy/ui-shared/lib/row-chips';
import {
  CollectionReadDetail,
  MarketplaceDetailPageShell,
  type CollectionReadMemberRef,
  type CollectionReadResolvedMember,
} from '@canopy/ui-app/capability';
import type {
  CollectionConfig,
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionSkillRef,
  SharedCollectionDetail,
  SharedCollectionSummary,
} from '@canopy/desktop-shared/types/collections';
import type { DeepLinkShareOpenEvent } from '@canopy/desktop-shared/types';
import { sharedResourceInstallLink } from '@/lib/sharedResourceInstallLink';
import { UnifiedTableDetailOverlays } from './UnifiedTableDetailOverlays';
import { useUnifiedTableDetailView } from './unifiedTableDetailView';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { brandText } from '@/lib/brand';
import { InstalledEntryStatusSection } from '../plugins/InstalledEntryStatusSection';
import {
  buildSharedCollectionPayload,
  hydrateEditableSharedCollection,
  rehydrateAfterSave,
  type EditableSharedCollection,
  type HydrationWarning,
} from '@/lib/sharedCollections';
import {
  buildItemForCatalogRow,
  generateClientKey,
  mergeSharedItemsWithCatalog,
} from '@/lib/sharedCollectionTableMerge';
import { DESCRIPTION_MARKDOWN_HINT, Tooltip } from '@canopy/ui-shared';
import {
  DetailActionBar,
  DetailPageActions,
  ShareActionButton,
  BusyLabel,
  type DetailPageActionsProps,
} from '@canopy/ui-shared/components';
import {
  ShareIcon,
  TrashIcon as AppCatalogTrashIcon,
  DocumentPencilIcon as AppCatalogDocumentPencilIcon,
  Download as AppCatalogDownload,
} from '@canopy/ui-shared/icons/AppIcons';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skillKey(ref: CollectionSkillRef): string {
  return `${ref.sourceId}/${ref.skillName}`;
}

function pluginKey(ref: CollectionPluginRef): string {
  return `${ref.marketplaceId}/${ref.pluginName}`;
}

function resolvedCollectionMember(
  ref: CollectionReadMemberRef,
  row: UnifiedTableRow,
): CollectionReadResolvedMember {
  return {
    ref,
    entryKey: row.key,
    name: row.name,
    description: row.description,
    source: row.source,
  };
}

function toggleSetKey(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Local Collection editor. Renamed from `BundleModal` to `CollectionModal`;
 * all user-facing copy uses "Collection" wording per the Bundles→Collections
 * rename plan.
 */
export function CollectionModal({
  collectionId,
  onClose,
  onSaved,
  presentation = 'modal',
  readOnly = false,
  onNavigateBack,
  onEditorOpenChange,
  onDeleted,
  onShare,
}: {
  collectionId: string | null; // null = create mode, string = edit mode
  onClose: () => void;
  onSaved: () => Promise<void>;
  presentation?: 'modal' | 'page';
  readOnly?: boolean;
  onNavigateBack?: () => void;
  onEditorOpenChange?: (open: boolean) => void;
  onDeleted?: () => void;
  onShare?: () => void;
}): JSX.Element | null {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const descriptionHintId = useId();
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedPlugins, setSelectedPlugins] = useState<Set<string>>(
    new Set(),
  );
  const [selectedMcpKeys, setSelectedMcpKeys] = useState<Set<string>>(
    new Set(),
  );
  const [loadedCollection, setLoadedCollection] =
    useState<CollectionConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pageEditorOpen, setPageEditorOpen] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);

  useEffect(() => {
    onEditorOpenChange?.(pageEditorOpen);
    return (): void => onEditorOpenChange?.(false);
  }, [onEditorOpenChange, pageEditorOpen]);

  const detailView = useUnifiedTableDetailView();

  // Unified table data (skills + plugins, no collections)
  const {
    rows: tableRows,
    sourceOptions,
    loading: tableLoading,
  } = useUnifiedTableData({ includeCollections: false, includeMcp: true });

  // Combined selected keys for the table
  const selectedKeys = useMemo(
    () =>
      new Set([
        ...Array.from(selectedSkills),
        ...Array.from(selectedPlugins),
        ...Array.from(selectedMcpKeys),
      ]),
    [selectedSkills, selectedPlugins, selectedMcpKeys],
  );

  // Load collection config when editing
  useEffect(() => {
    if (!collectionId) {
      setName('');
      setDescription('');
      setSelectedSkills(new Set());
      setSelectedPlugins(new Set());
      setSelectedMcpKeys(new Set());
      setLoadedCollection(null);
      setError('');
      setConfirmDelete(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    void runCancellableModalLoad(
      async (): Promise<void> => {
        const config = await window.collections.loadCollection(collectionId);
        if (cancelled) return;
        if (!config) {
          setError('Collection not found.');
          return;
        }
        setLoadedCollection(config);
        setName(config.name);
        setDescription(config.description);
        setSelectedSkills(new Set(config.skills.map(skillKey)));
        setSelectedPlugins(new Set(config.plugins.map(pluginKey)));
        setSelectedMcpKeys(
          new Set(
            (config.mcpServers ?? []).map(
              (r: CollectionMcpRef) => `${r.serverId}/${r.configId}`,
            ),
          ),
        );
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [collectionId, reloadGeneration]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) return;
    await runEntityEditOperation(
      async (): Promise<void> => {
        const skillRefs: CollectionSkillRef[] = Array.from(selectedSkills).map(
          (key) => {
            const lastSlash = key.lastIndexOf('/');
            return {
              sourceId: key.slice(0, lastSlash),
              skillName: key.slice(lastSlash + 1),
            };
          },
        );
        const pluginRefs: CollectionPluginRef[] = Array.from(
          selectedPlugins,
        ).map((key) => {
          const lastSlash = key.lastIndexOf('/');
          return {
            marketplaceId: key.slice(0, lastSlash),
            pluginName: key.slice(lastSlash + 1),
          };
        });
        const mcpRefs: CollectionMcpRef[] = Array.from(selectedMcpKeys).map(
          (key) => {
            const slash = key.indexOf('/');
            return {
              serverId: key.slice(0, slash),
              configId: key.slice(slash + 1),
            };
          },
        );
        await window.collections.saveCollection({
          ...(loadedCollection ? { id: loadedCollection.id } : {}),
          name: name.trim(),
          description: description.trim(),
          skills: skillRefs,
          plugins: pluginRefs,
          mcpServers: mcpRefs,
          ...(loadedCollection?.createdAt
            ? { createdAt: loadedCollection.createdAt }
            : {}),
        });
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onCloseRef.current,
      },
    );
  };

  const handleDelete = async (): Promise<void> => {
    if (!loadedCollection) return;
    await runEntityEditOperation(
      async (): Promise<void> => {
        await window.collections.deleteCollection(loadedCollection.id);
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onDeleted ?? onCloseRef.current,
      },
    );
  };

  function handleToggle(key: string): void {
    // Determine if this is a skill or plugin by finding the row
    const row = tableRows.find((r) => r.key === key);
    if (!row) return;
    if (row.kind === 'skill') {
      setSelectedSkills((prev) => toggleSetKey(prev, key));
    } else if (row.kind === 'plugin') {
      setSelectedPlugins((prev) => toggleSetKey(prev, key));
    } else if (row.kind === 'mcp') {
      setSelectedMcpKeys((prev) => toggleSetKey(prev, key));
    }
  }

  const isCreate = collectionId === null;
  const canSave = name.trim().length > 0 && !saving;
  const footerProps = createEntityEditModalFooterProps(
    isCreate,
    saving,
    canSave,
    confirmDelete,
    setConfirmDelete,
    () => void handleDelete(),
    onClose,
    () => void handleSave(),
  );

  const readCollection = useMemo(() => {
    if (!loadedCollection) return null;
    return {
      name: loadedCollection.name,
      description: loadedCollection.description,
      memberRefs: [
        ...loadedCollection.skills.map((ref) => ({
          kind: 'skill' as const,
          ...ref,
        })),
        ...loadedCollection.plugins.map((ref) => ({
          kind: 'plugin' as const,
          ...ref,
        })),
        ...(loadedCollection.mcpServers ?? []).map((ref) => ({
          kind: 'mcp' as const,
          ...ref,
        })),
      ],
    };
  }, [loadedCollection]);
  const readResolvedMembers = useMemo(() => {
    if (!readCollection) return [];
    return readCollection.memberRefs.flatMap((ref) => {
      const key =
        ref.kind === 'skill'
          ? `${ref.sourceId}/${ref.skillName}`
          : ref.kind === 'plugin'
            ? `${ref.marketplaceId}/${ref.pluginName}`
            : `${ref.serverId}/${ref.configId}`;
      const row = tableRows.find((candidate) => candidate.key === key);
      return row ? [resolvedCollectionMember(ref, row)] : [];
    });
  }, [readCollection, tableRows]);

  if (presentation === 'page' && readOnly) {
    // The shared Marketplace detail chrome, as for a shared collection and on
    // the web Portal: one Back row with the action bar, clear of the host's
    // breadcrumb. The wider column fits the member table.
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-col">
        <MarketplaceDetailPageShell
          title={name}
          onNavigateBack={onNavigateBack}
          width="fluid"
          share={
            onShare ? (
              <ShareActionButton
                placement="detail"
                dataTestId="plugins-entry-detail-share"
                ariaLabel={`Share ${name}`}
                onClick={onShare}
                disabled={
                  loading ||
                  !loadedCollection ||
                  loadedCollection.mcpServers.length > 0
                }
                disabledReason={
                  loadedCollection && loadedCollection.mcpServers.length > 0
                    ? 'Collections containing MCP servers cannot be shared.'
                    : undefined
                }
              />
            ) : undefined
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={error} />
            {loading ? (
              <LoadingPlaceholder label="Loading collection…" />
            ) : readCollection ? (
              <CollectionReadDetail
                statusSection={
                  collectionId ? (
                    <InstalledEntryStatusSection
                      entry={{
                        state: 'installed',
                        name,
                        ref: { type: 'local-collection', collectionId },
                      }}
                      onUninstalled={onDeleted ?? onClose}
                    />
                  ) : undefined
                }
                collection={readCollection}
                resolvedMembers={readResolvedMembers}
                onOpenEntry={(member) => {
                  const row = tableRows.find(
                    (candidate) => candidate.key === member.entryKey,
                  );
                  if (row) detailView.openRowDetails(row);
                }}
                onEdit={() => setPageEditorOpen(true)}
              />
            ) : null}
          </div>
        </MarketplaceDetailPageShell>
        {pageEditorOpen && (
          <CollectionModal
            collectionId={collectionId}
            onClose={() => setPageEditorOpen(false)}
            onSaved={async (): Promise<void> => {
              setPageEditorOpen(false);
              setReloadGeneration((generation) => generation + 1);
              await onSaved();
            }}
            onDeleted={onDeleted ?? onClose}
          />
        )}
        <UnifiedTableDetailOverlays details={detailView} />
      </div>
    );
  }

  return (
    <>
      <DialogModal
        onClose={onClose}
        title={isCreate ? 'New collection' : 'Edit collection'}
        titleId="collection-modal-title"
        maxWidth="4xl"
        headerBorder={false}
        closeOnBackdrop
      >
        <EntityEditModalContent
          loading={loading}
          error={error}
          footerProps={footerProps}
        >
          {/* Name */}
          <label className="block text-s">
            <span className="mb-1.5 block fg-secondary">
              Name <span className="fg-destructive">*</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My collection"
              className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s"
              autoFocus
            />
          </label>

          {/* Description */}
          <div>
            <label className="block text-s">
              <span className="mb-1.5 block fg-secondary">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
                rows={2}
                aria-describedby={descriptionHintId}
                className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s resize-none"
              />
            </label>
            <p
              id={descriptionHintId}
              className="mt-1 text-xs fg-tertiary"
              data-testid="collection-description-hint"
            >
              {DESCRIPTION_MARKDOWN_HINT}
            </p>
          </div>

          {/* Unified skills & plugins table */}
          <UnifiedTable
            rows={tableRows}
            sourceOptions={sourceOptions}
            selectedKeys={selectedKeys}
            onToggle={handleToggle}
            onView={detailView.openRowDetails}
            showCollectionKind={false}
            loading={tableLoading}
          />
        </EntityEditModalContent>
      </DialogModal>

      <UnifiedTableDetailOverlays details={detailView} />
    </>
  );
}

// ---------------------------------------------------------------------------
// CollectionsTab
// ---------------------------------------------------------------------------

interface CollectionsTabProps {
  onOpenAccountSettings?: () => void;
}

export function CollectionsTab({
  onOpenAccountSettings = (): void => {},
}: CollectionsTabProps): JSX.Element {
  const { collections, loading, error, refresh } = useCollectionList();
  const sharedCollections = useSharedCollectionList();
  // null = modal closed, '' = create mode, string = edit by id
  const [modalCollectionId, setModalCollectionId] = useState<string | null>(
    null,
  );
  const [sharingCollection, setSharingCollection] =
    useState<CollectionConfig | null>(null);
  const { requestShare, shareGateModal } = useShareAccess();
  const [actionError, setActionError] = useState<string | null>(null);
  const [sharedFlash, setSharedFlash] = useState<string | null>(null);
  // The shared install review (CAN-3710) installs a collection; this tab
  // only reports that one is installing.
  const sharedImporting = useNavigationStore(
    (state) =>
      state.shareInstallBusy &&
      state.pendingShareInstall?.link.entity === 'collection',
  );
  const [sharedSearch, setSharedSearch] = useState('');
  const [sharedCreatedBy, setSharedCreatedBy] = useState<'me' | 'anyone'>(
    'anyone',
  );
  const [sharedCollectionModal, setSharedCollectionModal] = useState<{
    mode: 'view' | 'edit';
    summary: SharedCollectionSummary;
  } | null>(null);
  const [pendingLocalDelete, setPendingLocalDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [localDeleting, setLocalDeleting] = useState(false);
  const [localDeleteError, setLocalDeleteError] = useState<string | null>(null);
  const [pendingSharedDelete, setPendingSharedDelete] = useState<{
    summary: SharedCollectionSummary;
  } | null>(null);
  const [sharedDeleting, setSharedDeleting] = useState(false);
  const [sharedDeleteError, setSharedDeleteError] = useState<string | null>(
    null,
  );
  const [activeView, setActiveView] = useState<'local' | 'shared'>('local');
  const selectedLocalCollection = modalCollectionId
    ? collections.find((collection) => collection.id === modalCollectionId)
    : null;
  useCurrentUiStateReporter(
    'plugins.selectedRow',
    selectedLocalCollection
      ? {
          kind: 'collection',
          id: selectedLocalCollection.id,
          name: selectedLocalCollection.name,
        }
      : sharedCollectionModal
        ? {
            kind: 'collection',
            id: sharedCollectionModal.summary.id,
            name: sharedCollectionModal.summary.name,
          }
        : null,
  );
  useCurrentUiStateReporter('plugins.sharedCollections', {
    filters: {
      ...(sharedSearch.trim() ? { query: sharedSearch.trim() } : {}),
      createdBy: sharedCreatedBy,
    },
    shareModalOpen: sharingCollection !== null,
    importing: sharedImporting,
    detailModal: sharedCollectionModal
      ? {
          mode: sharedCollectionModal.mode,
          id: sharedCollectionModal.summary.id,
          name: sharedCollectionModal.summary.name,
        }
      : null,
  });

  useEffect(() => {
    sharedCollections.setFilters({
      ...(sharedSearch.trim() ? { q: sharedSearch.trim() } : {}),
      createdBy: sharedCreatedBy,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedSearch, sharedCreatedBy]);

  const cloudCollectionsReady =
    isCanopyCloudConnected(sharedCollections.cloudAccount) &&
    sharedCollections.cloudAccount?.capabilities.includes(
      'collections-crud-v1',
    ) === true;

  useEffect(() => {
    if (activeView !== 'shared') return;
    if (!cloudCollectionsReady) return;
    if (sharedCollections.loaded || sharedCollections.loading) return;
    void sharedCollections.refreshShared();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeView,
    cloudCollectionsReady,
    sharedCollections.loaded,
    sharedCollections.loading,
  ]);

  const handleShareCollection = async (collectionId: string): Promise<void> => {
    setActionError(null);
    try {
      const config = await window.collections.loadCollection(collectionId);
      if (!config) {
        setActionError('Collection not found.');
        return;
      }
      if (config.mcpServers.length > 0) {
        setActionError('Collections containing MCP servers cannot be shared.');
        return;
      }
      setSharingCollection(config);
    } catch (err: unknown) {
      setActionError(resolveSharedResourceErrorMessage(err));
    }
  };

  const handleSharedDelete = (
    summary: SharedCollectionSummary,
  ): Promise<void> => {
    setSharedDeleteError(null);
    setPendingSharedDelete({ summary });
    return Promise.resolve();
  };

  const confirmSharedDelete = async (): Promise<void> => {
    if (!pendingSharedDelete || sharedDeleting) return;
    const { summary } = pendingSharedDelete;
    setSharedDeleting(true);
    setSharedDeleteError(null);
    setActionError(null);
    setSharedFlash(null);
    try {
      await window.collections.deleteShared({
        collectionId: summary.id,
      });
      sharedCollections.removeSharedRow(summary.id);
      setSharedFlash('Shared collection deleted.');
      await sharedCollections.refreshShared();
      setPendingSharedDelete(null);
    } catch (err: unknown) {
      setSharedDeleteError(
        `Failed to delete shared collection. ${resolveSharedResourceErrorMessage(err)}`,
      );
    } finally {
      setSharedDeleting(false);
    }
  };

  const handleLocalDelete = (collection: {
    id: string;
    name: string;
  }): void => {
    setLocalDeleteError(null);
    setPendingLocalDelete({ id: collection.id, name: collection.name });
  };

  const confirmLocalDelete = async (): Promise<void> => {
    if (!pendingLocalDelete || localDeleting) return;
    setLocalDeleting(true);
    setLocalDeleteError(null);
    setActionError(null);
    try {
      await window.collections.deleteCollection(pendingLocalDelete.id);
      await refresh();
      setPendingLocalDelete(null);
    } catch (err: unknown) {
      setLocalDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalDeleting(false);
    }
  };

  const handleSharedUpdated = async (
    detail: SharedCollectionDetail,
  ): Promise<void> => {
    setSharedFlash('Shared collection updated.');
    await sharedCollections.refreshShared();
    void detail;
  };

  return (
    <>
      {/* Local / Shared view tabs */}
      <div
        className="canopy-tab-list mb-4 flex gap-1"
        role="tablist"
        data-testid="collections-view-tabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'local'}
          onClick={() => setActiveView('local')}
          data-testid="collections-view-tab-local"
          className={`canopy-tab-trigger px-4 py-2 text-s font-medium transition-colors ${
            activeView === 'local'
              ? 'fg-primary'
              : 'fg-secondary hover:fg-primary'
          }`}
        >
          Local
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'shared'}
          onClick={() => setActiveView('shared')}
          data-testid="collections-view-tab-shared"
          className={`canopy-tab-trigger px-4 py-2 text-s font-medium transition-colors ${
            activeView === 'shared'
              ? 'fg-primary'
              : 'fg-secondary hover:fg-primary'
          }`}
        >
          Shared
        </button>
      </div>

      {/* Toolbar — only the local view has its own create button. */}
      {activeView === 'local' && (
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs fg-secondary">
            {collections.length > 0
              ? `${collections.length} collection${collections.length !== 1 ? 's' : ''}`
              : ''}
          </p>
          <button
            type="button"
            onClick={() => setModalCollectionId('')}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent fg-emphasis hover:bg-accent/90 transition-colors focus-ring"
          >
            Add
          </button>
        </div>
      )}

      {/* Error */}
      <ErrorBanner error={error || actionError} />

      {/* Loading */}
      {activeView === 'local' && loading && collections.length === 0 && (
        <LoadingPlaceholder label="Loading collections…" space="page" />
      )}

      {/* Table */}
      {activeView === 'local' && collections.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-s">
            <thead>
              <tr className="bg-secondary/50 border-b">
                <th className="text-left px-4 py-3 font-medium fg-secondary">
                  Name
                </th>
                <th className="text-left px-4 py-3 font-medium fg-secondary">
                  Last updated
                </th>
                <th className="text-right px-4 py-3 font-medium fg-secondary">
                  Skills
                </th>
                <th className="text-right px-4 py-3 font-medium fg-secondary">
                  Plugins
                </th>
                <th className="text-right px-4 py-3 font-medium fg-secondary">
                  MCP
                </th>
                <th className="text-right px-4 py-3 font-medium fg-secondary">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {collections
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((collection) => {
                  const description = markdownDescriptionToPlainText(
                    collection.description,
                  );
                  return (
                    <tr
                      key={collection.id}
                      className="border-b last:border-b-0 hover:bg-secondary/30 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setModalCollectionId(collection.id)}
                          className="text-left group"
                        >
                          <span className="fg-primary font-medium group-hover:fg-accent transition-colors">
                            {collection.name}
                          </span>
                          {description && (
                            <p className="text-xs fg-secondary mt-0.5 line-clamp-1">
                              {description}
                            </p>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 fg-secondary">
                        {formatDate(collection.updatedAt)}
                      </td>
                      <td className="px-4 py-3 text-right fg-secondary">
                        {collection.skillCount}
                      </td>
                      <td className="px-4 py-3 text-right fg-secondary">
                        {collection.pluginCount}
                      </td>
                      <td className="px-4 py-3 text-right fg-secondary">
                        {collection.mcpServerCount}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center gap-1">
                          <Tooltip
                            label={
                              collection.mcpServerCount > 0
                                ? 'Collections containing MCP servers cannot be shared.'
                                : 'Share'
                            }
                          >
                            <button
                              type="button"
                              onClick={() =>
                                requestShare(
                                  SHARE_COLLECTION_GATE_CONTEXT,
                                  () =>
                                    void handleShareCollection(collection.id),
                                )
                              }
                              disabled={collection.mcpServerCount > 0}
                              aria-label="Share collection"
                              className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <ShareIcon width={14} height={14} aria-hidden />
                            </button>
                          </Tooltip>
                          <Tooltip label="Delete collection">
                            <button
                              type="button"
                              onClick={() =>
                                handleLocalDelete({
                                  id: collection.id,
                                  name: collection.name,
                                })
                              }
                              aria-label="Delete collection"
                              className="focus-ring rounded p-1 fg-secondary hover:fg-destructive hover:bg-secondary transition-colors"
                            >
                              <AppCatalogTrashIcon width="14" height="14" />
                            </button>
                          </Tooltip>
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {activeView === 'local' &&
        !loading &&
        collections.length === 0 &&
        !error && (
          <EmptyState
            title="No collections created"
            subtitle="Create a collection to group skills, plugins, and MCP servers together"
          />
        )}

      {/* Modal */}
      {modalCollectionId !== null && (
        <CollectionModal
          collectionId={modalCollectionId || null}
          onClose={() => setModalCollectionId(null)}
          onSaved={refresh}
        />
      )}

      {sharingCollection && (
        <ShareCollectionModal
          collection={sharingCollection}
          onClose={() => setSharingCollection(null)}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {
            // Sharing keeps the local collection; only the Shared list changes.
            void sharedCollections.refreshShared();
            setSharingCollection(null);
          }}
        />
      )}

      {shareGateModal}

      {activeView === 'shared' && (
        <SharedCollectionsSection
          sharedCollections={sharedCollections}
          search={sharedSearch}
          onSearchChange={setSharedSearch}
          createdBy={sharedCreatedBy}
          onCreatedByChange={setSharedCreatedBy}
          flash={sharedFlash}
          onView={(summary) =>
            setSharedCollectionModal({ mode: 'view', summary })
          }
          onEdit={(summary) =>
            setSharedCollectionModal({ mode: 'edit', summary })
          }
          onImport={(link) => {
            useNavigationStore.getState().openShareInstall(link, 'in-app');
          }}
          onDelete={handleSharedDelete}
          onOpenAccountSettings={onOpenAccountSettings}
        />
      )}

      {sharedCollectionModal && (
        <SharedCollectionDetailModal
          mode={sharedCollectionModal.mode}
          summary={sharedCollectionModal.summary}
          onClose={() => setSharedCollectionModal(null)}
          onUpdated={(detail) => void handleSharedUpdated(detail)}
          onSwitchToEdit={() =>
            setSharedCollectionModal({
              mode: 'edit',
              summary: sharedCollectionModal.summary,
            })
          }
        />
      )}

      {pendingLocalDelete && (
        <DeleteConfirmModal
          title={`Delete collection "${pendingLocalDelete.name}"?`}
          message="This collection will be removed permanently. Skills and plugins it referenced will remain installed."
          pending={localDeleting}
          error={localDeleteError}
          onCancel={() => {
            if (localDeleting) return;
            setPendingLocalDelete(null);
            setLocalDeleteError(null);
          }}
          onConfirm={() => void confirmLocalDelete()}
        />
      )}

      {pendingSharedDelete && (
        <DeleteConfirmModal
          title={`Delete shared collection "${pendingSharedDelete.summary.name}"?`}
          message="Linked custom skills will remain available as shared skills."
          pending={sharedDeleting}
          error={sharedDeleteError}
          onCancel={() => {
            if (sharedDeleting) return;
            setPendingSharedDelete(null);
            setSharedDeleteError(null);
          }}
          onConfirm={() => void confirmSharedDelete()}
        />
      )}
    </>
  );
}

function SharedCollectionDetailShell({
  title,
  presentation,
  onClose,
  closeOnBackdrop,
  actions,
  onNavigateBack,
  children,
}: {
  title: string;
  presentation: 'modal' | 'page';
  onClose: () => void;
  closeOnBackdrop: boolean;
  /** The standard action bar's slots: `[Unshare] [Edit] [Add]`. */
  actions?: DetailPageActionsProps;
  onNavigateBack?: () => void;
  children: JSX.Element;
}): JSX.Element {
  if (presentation === 'page') {
    // The shared Marketplace detail chrome, as on the web Portal: its top
    // inset keeps the Back row and actions clear of the host's pinned
    // titlebar, which a hand-rolled row here once tucked them under. The
    // wider column fits the member table.
    return (
      <div className="mx-auto w-full max-w-4xl">
        <MarketplaceDetailPageShell
          title={title}
          onNavigateBack={onNavigateBack}
          width="fluid"
        >
          {actions && <DetailPageActions {...actions} />}
          {children}
        </MarketplaceDetailPageShell>
      </div>
    );
  }
  return (
    <DialogModal
      onClose={onClose}
      title={title}
      titleId="shared-collection-detail-modal-title"
      maxWidth="4xl"
      headerBorder={false}
      closeOnBackdrop={closeOnBackdrop}
      topRightActions={actions ? <DetailActionBar {...actions} /> : undefined}
    >
      {children}
    </DialogModal>
  );
}

export function SharedCollectionDetailModal({
  mode,
  summary,
  onClose,
  onUpdated,
  onSwitchToEdit,
  presentation = 'modal',
  onNavigateBack,
  onAdd,
  renderUnshare,
}: {
  mode: 'view' | 'edit';
  summary: SharedCollectionSummary;
  onClose: () => void;
  onUpdated: (detail: SharedCollectionDetail) => void;
  /**
   * Opens the editor. Omitted where the host cannot edit shared collections
   * (`marketplace-shared-collection-edit`), which hides Edit.
   */
  onSwitchToEdit?: () => void;
  presentation?: 'modal' | 'page';
  onNavigateBack?: () => void;
  onAdd?: () => Promise<void>;
  /**
   * The owner's Unshare, first among the secondaries once the detail loads.
   * The host gates it on the loaded detail's own verdict; Edit stays gated
   * on `canUpdate` independently.
   */
  renderUnshare?: (detail: SharedCollectionDetail) => ReactNode;
}): JSX.Element {
  const [detail, setDetail] = useState<SharedCollectionDetail | null>(null);
  const descriptionHintId = useId();
  const [editable, setEditable] = useState<EditableSharedCollection | null>(
    null,
  );
  const [warnings, setWarnings] = useState<HydrationWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  const canUpdate =
    detail === null ? summary.canUpdate : detail.canUpdate === true;
  const isEdit = mode === 'edit' && canUpdate;
  const detailView = useUnifiedTableDetailView();

  const {
    rows: catalogRows,
    sourceOptions,
    loading: catalogLoading,
  } = useUnifiedTableData({ includeCollections: false, includeMcp: false });

  const { skills: installedSkills } = useSkillList();
  const { cache: marketplaceCache } = useMarketplaceList();
  const marketplaces = useMemo(
    () => marketplaceCache?.marketplaces ?? [],
    [marketplaceCache],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async (): Promise<void> => {
      try {
        const nextDetail = await window.collections.getShared(summary.id);
        if (cancelled) return;
        setDetail(nextDetail);
        const hydrated = hydrateEditableSharedCollection(nextDetail);
        setEditable(hydrated.editable);
        setWarnings(hydrated.warnings);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(resolveSharedResourceErrorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [mode, summary.canUpdate, summary.id]);

  const updateEditable = (
    updater: (current: EditableSharedCollection) => EditableSharedCollection,
  ): void => {
    setEditable((current) => (current ? updater(current) : current));
  };

  const merge = useMemo(() => {
    if (!editable) return null;
    return mergeSharedItemsWithCatalog({
      catalogRows,
      items: editable.items,
      installedSkills,
      marketplaces,
    });
  }, [catalogRows, editable, installedSkills, marketplaces]);

  const handleToggle = (key: string): void => {
    if (!isEdit || !editable || !merge) return;
    const existingIndex = merge.rowKeyToItemIndex.get(key);
    if (existingIndex !== undefined) {
      updateEditable((current) => ({
        ...current,
        items: current.items.filter(
          (_item, itemIndex) => itemIndex !== existingIndex,
        ),
      }));
      return;
    }
    const row = merge.rows.find((candidate) => candidate.key === key);
    if (!row) return;
    const newItem = buildItemForCatalogRow(row, {
      installedSkills,
      marketplaces,
      generateClientKey,
    });
    if (!newItem) return;
    updateEditable((current) => ({
      ...current,
      items: [...current.items, newItem],
    }));
  };

  const tableRows = useMemo(() => {
    if (!merge) return [];
    if (isEdit) return merge.rows;
    // In view mode, lock every row so users cannot toggle from the picker.
    return merge.rows.map((row) => ({
      ...row,
      toggleMode: 'disabled' as const,
    }));
  }, [merge, isEdit]);

  const selectedKeys = merge?.selectedKeys ?? new Set<string>();

  const sharedReadCollection = useMemo(() => {
    if (!editable) return null;
    const memberRefs: CollectionReadMemberRef[] = editable.items.map(
      (item): CollectionReadMemberRef => {
        if (item.kind === 'external_plugin') {
          return {
            kind: 'plugin',
            marketplaceId:
              item.marketplace.type === 'builtin'
                ? `builtin:${item.marketplace.id}`
                : `github:${item.marketplace.repo}`,
            pluginName: item.pluginName,
          };
        }
        if (item.kind === 'linked_custom_skill') {
          return {
            kind: 'skill',
            sourceId: `shared:${item.skillId}`,
            skillName: item.skillName,
          };
        }
        if (item.kind === 'draft_custom_skill') {
          return {
            kind: 'skill',
            sourceId: item.localSkillId,
            skillName: item.skillName,
          };
        }
        return {
          kind: 'skill',
          sourceId:
            item.source.type === 'builtin'
              ? `builtin:${item.source.id}`
              : `github:${item.source.repo}`,
          skillName: item.skillName,
        };
      },
    );
    return {
      name: editable.name,
      description: editable.description,
      memberRefs,
    };
  }, [editable]);

  const sharedReadResolvedMembers = useMemo(() => {
    if (!merge || !sharedReadCollection) return [];
    const rowByItemIndex = new Map<number, UnifiedTableRow>();
    merge.rowKeyToItemIndex.forEach((itemIndex, rowKey) => {
      const row = merge.rows.find((candidate) => candidate.key === rowKey);
      if (row?.rowOrigin === 'catalog' && !row.viewDisabled) {
        rowByItemIndex.set(itemIndex, row);
      }
    });
    return sharedReadCollection.memberRefs.flatMap((ref, index) => {
      const row = rowByItemIndex.get(index);
      return row ? [resolvedCollectionMember(ref, row)] : [];
    });
  }, [merge, sharedReadCollection]);

  const setItemRequired = (index: number, required: boolean): void => {
    updateEditable((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, required: required ? true : undefined }
          : item,
      ),
    }));
  };

  const handleSave = async (): Promise<void> => {
    if (!isEdit || !detail || !editable || saving || warnings.length > 0) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = await buildSharedCollectionPayload({
        name: editable.name,
        description: editable.description,
        items: editable.items,
        customSkillReader: (localSkillId) =>
          window.skills.readRawSkill(localSkillId),
      });
      const updated = unwrapShareOperationResult(
        await window.collections.updateShared({
          collectionId: detail.id,
          rawCollection: payload.rawCollection,
          expectedContentHash: detail.contentHash,
          ...(payload.customSkills.length > 0
            ? { customSkills: payload.customSkills }
            : {}),
        }),
      );
      setDetail(updated);
      setEditable(rehydrateAfterSave(updated));
      setWarnings([]);
      onUpdated(updated);
      onClose();
    } catch (err: unknown) {
      setError(
        `Failed to update shared collection. ${resolveSharedResourceErrorMessage(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  // The standard action bar: [Unshare] [Edit] [Add].
  const unshareAction = detail ? renderUnshare?.(detail) : null;
  const showEdit = canUpdate && onSwitchToEdit !== undefined;
  const pageActions: DetailPageActionsProps | undefined =
    !isEdit && !loading
      ? {
          secondary:
            unshareAction || showEdit ? (
              <>
                {unshareAction}
                {showEdit && (
                  <button
                    type="button"
                    onClick={onSwitchToEdit}
                    className={`${SECONDARY_ACTION_BUTTON_CLASS} gap-1.5`}
                  >
                    <AppCatalogDocumentPencilIcon width="12" height="12" />
                    Edit
                  </button>
                )}
              </>
            ) : undefined,
          primary: onAdd ? (
            <button
              type="button"
              data-testid="shared-collection-detail-add"
              disabled={adding}
              onClick={() => {
                setAdding(true);
                void onAdd()
                  .catch((err: unknown) => {
                    setError(
                      `Failed to import collection. ${resolveSharedResourceErrorMessage(err)}`,
                    );
                  })
                  .finally(() => setAdding(false));
              }}
              className="focus-ring inline-flex h-7 shrink-0 items-center rounded-md bg-accent px-2.5 text-xs font-medium fg-emphasis disabled:opacity-50"
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          ) : undefined,
        }
      : undefined;

  return (
    <>
      <SharedCollectionDetailShell
        onClose={saving ? (): void => {} : onClose}
        title={
          isEdit ? `Edit shared collection: ${summary.name}` : summary.name
        }
        presentation={presentation}
        closeOnBackdrop={!saving}
        actions={pageActions}
        onNavigateBack={onNavigateBack}
      >
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-5 pb-3 flex flex-col gap-4">
            <ErrorBanner error={error} />
            {loading || !editable ? (
              <LoadingPlaceholder label="Loading shared collection…" />
            ) : (
              <>
                {warnings.length > 0 && (
                  <div className="rounded-lg border border-line-destructive/30 bg-destructive-subtle p-3 text-s fg-destructive">
                    {warnings.map((warning) => (
                      <p key={`${warning.index}-${warning.message}`}>
                        {warning.message}
                      </p>
                    ))}
                  </div>
                )}

                {isEdit ? (
                  <>
                    <label className="block text-s">
                      <span className="mb-1.5 block fg-secondary">
                        Name <span className="fg-destructive">*</span>
                      </span>
                      <input
                        value={editable.name}
                        onChange={(event) =>
                          updateEditable((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s"
                      />
                    </label>

                    <div>
                      <label className="block text-s">
                        <span className="mb-1.5 block fg-secondary">
                          Description
                        </span>
                        <textarea
                          value={editable.description}
                          onChange={(event) =>
                            updateEditable((current) => ({
                              ...current,
                              description: event.target.value,
                            }))
                          }
                          placeholder="Optional description"
                          rows={2}
                          aria-describedby={descriptionHintId}
                          className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s resize-none"
                        />
                      </label>
                      <p
                        id={descriptionHintId}
                        className="mt-1 text-xs fg-tertiary"
                        data-testid="collection-description-hint"
                      >
                        {DESCRIPTION_MARKDOWN_HINT}
                      </p>
                    </div>

                    <UnifiedTable
                      rows={tableRows}
                      sourceOptions={sourceOptions}
                      selectedKeys={selectedKeys}
                      onToggle={handleToggle}
                      onView={detailView.openRowDetails}
                      showCollectionKind={false}
                      loading={catalogLoading}
                      defaultSelectedFilter="all"
                    />
                  </>
                ) : (
                  sharedReadCollection && (
                    <CollectionReadDetail
                      collection={sharedReadCollection}
                      resolvedMembers={sharedReadResolvedMembers}
                      onOpenEntry={(member) => {
                        const row = merge?.rows.find(
                          (candidate) => candidate.key === member.entryKey,
                        );
                        if (row) detailView.openRowDetails(row);
                      }}
                    />
                  )
                )}

                {isEdit && editable.items.length > 0 && (
                  <details className="rounded-lg border bg-secondary/20">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium fg-primary">
                      Required items (
                      {editable.items.filter((item) => item.required).length}/
                      {editable.items.length})
                    </summary>
                    <div className="divide-y border-t">
                      {editable.items.map((item, index) => {
                        const label =
                          item.kind === 'external_plugin'
                            ? item.pluginName
                            : item.skillName;
                        const kindLabel =
                          item.kind === 'external_plugin'
                            ? 'Plugin'
                            : item.kind === 'external_skill'
                              ? 'Skill'
                              : item.kind === 'linked_custom_skill'
                                ? 'Linked custom skill'
                                : 'New custom skill';
                        return (
                          <label
                            key={`required-${item.kind}-${index}`}
                            className="flex items-center gap-3 px-3 py-2 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked={item.required === true}
                              onChange={(event) =>
                                setItemRequired(index, event.target.checked)
                              }
                              className="rounded"
                            />
                            <span className="fg-secondary">{kindLabel}:</span>
                            <span className="fg-primary truncate">{label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
          {/* View mode has no footer: a Close would duplicate the X. */}
          {presentation === 'modal' && isEdit && (
            <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="focus-ring rounded-lg px-4 py-2 text-s font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={
                  loading ||
                  saving ||
                  !editable ||
                  editable.name.trim().length === 0 ||
                  warnings.length > 0
                }
                className="focus-ring inline-flex items-center rounded-lg bg-accent px-4 py-2 text-s font-medium fg-emphasis disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}
        </div>
      </SharedCollectionDetailShell>

      <UnifiedTableDetailOverlays details={detailView} />
    </>
  );
}

interface SharedCollectionsSectionProps {
  sharedCollections: ReturnType<typeof useSharedCollectionList>;
  search: string;
  onSearchChange: (next: string) => void;
  createdBy: 'me' | 'anyone';
  onCreatedByChange: (next: 'me' | 'anyone') => void;
  flash: string | null;
  onView: (summary: SharedCollectionSummary) => void;
  onEdit: (summary: SharedCollectionSummary) => void;
  onImport: (link: DeepLinkShareOpenEvent) => void;
  onDelete: (summary: SharedCollectionSummary) => Promise<void>;
  onOpenAccountSettings?: () => void;
}

function SharedCollectionsSection({
  sharedCollections,
  search,
  onSearchChange,
  createdBy,
  onCreatedByChange,
  flash,
  onView,
  onEdit,
  onImport,
  onDelete,
  onOpenAccountSettings,
}: SharedCollectionsSectionProps): JSX.Element {
  const {
    cloudAccount,
    cloudLoading,
    collections,
    loading,
    loadingMore,
    nextCursor,
    error,
    refreshShared,
    loadMoreShared,
  } = sharedCollections;

  if (cloudLoading) {
    return (
      <section>
        <LoadingPlaceholder
          label="Loading shared collections…"
          space="section"
        />
      </section>
    );
  }

  const cloudReady = isCanopyCloudConnected(cloudAccount);
  const hasCollectionsCapability =
    cloudAccount?.capabilities.includes('collections-crud-v1') === true;
  const accountUnavailableLabel =
    cloudReady && !hasCollectionsCapability
      ? `This ${brandText.appName} Cloud account does not support shared collections.`
      : `No ${brandText.appName} Cloud account configured.`;

  if (!cloudReady || !hasCollectionsCapability) {
    return (
      <section>
        <p className="text-s fg-secondary">{accountUnavailableLabel}</p>
        {onOpenAccountSettings && (
          <button
            type="button"
            onClick={onOpenAccountSettings}
            className="mt-2 rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-primary hover:bg-secondary focus-ring"
          >
            Open account settings
          </button>
        )}
      </section>
    );
  }

  return (
    <section data-testid="shared-collections-section">
      <div className="mb-3 flex items-center justify-end">
        <button
          type="button"
          onClick={() => void refreshShared()}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle transition-colors focus-ring disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search shared collections…"
          className="focus-ring min-w-50 flex-1 rounded-md border bg-base px-2.5 py-1.5 text-xs"
        />
        <select
          value={createdBy}
          onChange={(event) =>
            onCreatedByChange(event.target.value as 'me' | 'anyone')
          }
          className="focus-ring rounded-md border bg-base px-2 py-1.5 text-xs fg-primary"
        >
          <option value="anyone">Created by anyone</option>
          <option value="me">Created by me</option>
        </select>
      </div>

      {flash && <p className="mb-3 text-xs fg-success">{flash}</p>}

      {loading && collections.length === 0 && (
        <LoadingPlaceholder
          label="Loading shared collections…"
          space="section"
        />
      )}

      {error && (
        <div className="space-y-2">
          <ErrorBanner error={error} />
          <button
            type="button"
            onClick={() => void refreshShared()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle focus-ring"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && collections.length === 0 && (
        <EmptyState title="No shared collections found." subtitle="" />
      )}

      {collections.length > 0 && (
        <>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-s">
              <thead>
                <tr className="border-b bg-secondary/50">
                  <th className="px-4 py-3 text-left font-medium fg-secondary">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left font-medium fg-secondary">
                    Owner
                  </th>
                  <th className="px-4 py-3 text-left font-medium fg-secondary">
                    Updated
                  </th>
                  <th className="px-4 py-3 text-right font-medium fg-secondary">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {collections.map((summary) => {
                  const description = markdownDescriptionToPlainText(
                    summary.description,
                  );
                  const installLink = sharedResourceInstallLink({
                    entity: 'collection',
                    externalId: summary.id,
                    scope: summary.shareScope,
                  });
                  return (
                    <tr
                      key={summary.id}
                      className="border-b transition-colors last:border-b-0 hover:bg-secondary/30"
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => onView(summary)}
                          className="text-left group"
                        >
                          <span className="font-medium fg-primary group-hover:fg-accent transition-colors">
                            {summary.name}
                          </span>
                          {description && (
                            <p className="mt-0.5 line-clamp-1 text-xs fg-secondary">
                              {description}
                            </p>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 fg-secondary">
                        {('name' in summary.owner
                          ? summary.owner.name
                          : null) ?? summary.owner.type}
                      </td>
                      <td className="px-4 py-3 fg-secondary">
                        {formatDate(summary.updatedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center gap-1">
                          {summary.canUpdate && (
                            <Tooltip label="Edit shared collection">
                              <button
                                type="button"
                                onClick={() => onEdit(summary)}
                                aria-label="Edit shared collection"
                                className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <AppCatalogDocumentPencilIcon
                                  width="14"
                                  height="14"
                                />
                              </button>
                            </Tooltip>
                          )}
                          {/* A private collection resolves for its author
                              only, so it has nothing to import from here. */}
                          {installLink !== null && (
                            <Tooltip label="Import collection">
                              <button
                                type="button"
                                onClick={() => onImport(installLink)}
                                aria-label="Import collection"
                                className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <AppCatalogDownload width="14" height="14" />
                              </button>
                            </Tooltip>
                          )}
                          {summary.canDelete && (
                            <Tooltip label="Delete shared collection">
                              <button
                                type="button"
                                onClick={() => void onDelete(summary)}
                                aria-label="Delete shared collection"
                                className="focus-ring rounded p-1 fg-secondary hover:fg-destructive hover:bg-secondary transition-colors"
                              >
                                <AppCatalogTrashIcon width="14" height="14" />
                              </button>
                            </Tooltip>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {nextCursor && (
            <div className="mt-2 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMoreShared()}
                disabled={loadingMore}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle focus-ring disabled:opacity-50"
              >
                <BusyLabel busy={loadingMore} busyText="Loading…">
                  Load more
                </BusyLabel>
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

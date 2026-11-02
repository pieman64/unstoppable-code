import { Button } from '@canopy/ui-shared/components';
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
import { useUnifiedTableData } from '../../hooks/useUnifiedTableData';
import type { UnifiedTableRow } from '../../hooks/useUnifiedTableData';
import { useSkillList } from '../../hooks/useSkillList';
import { useMarketplaceList } from '../../hooks/useMarketplaceList';
import { EntityEditModalContent } from './EntityEditModalFooter';
import { DialogModal } from '../shared';
import {
  createEntityEditModalFooterProps,
  runCancellableModalLoad,
  runEntityEditOperation,
} from './entityEditModalUtils';
import { ErrorBanner, LoadingPlaceholder } from '../shared';
import { UnifiedTable } from '../shared/UnifiedTable';
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
import { UnifiedTableDetailOverlays } from './UnifiedTableDetailOverlays';
import { useUnifiedTableDetailView } from './unifiedTableDetailView';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
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
import { DESCRIPTION_MARKDOWN_HINT } from '@canopy/ui-shared';
import {
  DetailActionBar,
  DetailPageActions,
  ShareActionButton,
  type DetailPageActionsProps,
} from '@canopy/ui-shared/components';
import { DocumentPencilIcon as AppCatalogDocumentPencilIcon } from '@canopy/ui-shared/icons/AppIcons';

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
  onCreated,
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
  /** Names the collection a create-mode save added. */
  onCreated?: (collectionId: string) => void;
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
        const saved = await window.collections.saveCollection({
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
        if (!loadedCollection) onCreated?.(saved.id);
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
  renderSharedByYou,
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
  /**
   * The owner's "Shared by you" section for the loaded detail (CAN-4842),
   * with a re-read for after a public link is removed.
   */
  renderSharedByYou?: (
    detail: SharedCollectionDetail,
    refresh: () => Promise<void>,
  ) => ReactNode;
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

  // Re-reads the share after its public link changed; non-fatal.
  const refreshDetail = async (): Promise<void> => {
    try {
      const nextDetail = await window.collections.getShared(summary.id);
      setDetail(nextDetail);
      onUpdated(nextDetail);
    } catch {
      // The mutation already succeeded; the detail stays stale until reopened.
    }
  };

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
                  <Button size="compact" onClick={onSwitchToEdit}>
                    <AppCatalogDocumentPencilIcon width="12" height="12" />
                    Edit
                  </Button>
                )}
              </>
            ) : undefined,
          primary: onAdd ? (
            <Button
              variant="primary"
              size="compact"
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
            >
              {adding ? 'Adding…' : 'Add'}
            </Button>
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

                {!isEdit &&
                  detail &&
                  renderSharedByYou?.(detail, refreshDetail)}

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
              <Button size="compact" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="compact"
                onClick={() => void handleSave()}
                disabled={
                  loading ||
                  saving ||
                  !editable ||
                  editable.name.trim().length === 0 ||
                  warnings.length > 0
                }
              >
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          )}
        </div>
      </SharedCollectionDetailShell>

      <UnifiedTableDetailOverlays details={detailView} />
    </>
  );
}

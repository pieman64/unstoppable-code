import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
/**
 * Collapsible App Advisor-only navigation rail for the popout workspace.
 *
 * Contents (expanded): a drag-region header row that reserves height under
 * the persistent {@link AppAdvisorTitlebarCorner} overlay (which owns the
 * toggle/settings/new-entry controls at constant window coordinates — this
 * nav renders no control buttons of its own), then a scrollable Work Entry
 * list (shared {@link WorkEntryListItem} rows with select / pin / rename /
 * two-step delete; pinned entries lead), and the read-only legacy "Archived" subgroup sourced
 * from `loadLegacyArchivedChats('app-advisor')` (`global` pre-entry
 * archives).
 *
 * Collapsed: the nav animates to ZERO width and unmounts its contents; the
 * corner overlay stays put, and {@link AppAdvisorTopBar}'s corner spacer
 * provides the background beneath it — the main window's collapsed-sidebar
 * pattern. The main column is a sibling and never unmounts. The collapsed
 * state persists via `PreferencesData.appAdvisorNavCollapsed`; after the
 * width transition the nav dispatches
 * `dispatchBrowserViewBoundsInvalidated()` so hosted browser content
 * (native WebContentsViews) is resized to the new grid bounds.
 */
import {
  memo,
  useCallback,
  useMemo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { resolveArchiveRetentionDays } from '@canopy/desktop-shared/lib/archive-retention';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { orderWorkEntryRows } from '@/lib/sidebar-ordering';
import {
  EMPTY_ARCHIVED_CONTAINERS,
  EMPTY_PENDING_ARCHIVED_CONTAINERS,
  useArchivedContainersStore,
} from '@/stores/archivedContainersStore';
import { WorkEntryListItem } from '@/components/standalone-chat/WorkEntryListItem';
import {
  CodeSidebarItemGroups,
  buildSidebarItemGroupBlocks,
  type CodeSidebarItemGroupCommands,
} from '@canopy/ui-app/sidebar';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import type {
  SidebarItemGroup,
  SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import { ArchivedContainersNavLink, ThinkingSpinner } from '@canopy/ui-shared';
import { openArchivedOverviewSurface } from '@/lib/archivedContainerNavigation';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { dispatchBrowserViewBoundsInvalidated } from '@/lib/browserViewBounds';
import type { StandaloneChatMeta } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_SETTINGS_SAVED_EVENT } from '@/lib/appAdvisorSettingsEvents';

interface AppAdvisorSettingsSavedDetail {
  archiveRetentionDays?: number | null;
  autoArchiveDays?: number | null;
}

export function isAppAdvisorSettingsSavedDetail(
  value: unknown,
): value is AppAdvisorSettingsSavedDetail {
  if (typeof value !== 'object' || value === null) return false;
  const archiveRetentionDays =
    'archiveRetentionDays' in value ? value.archiveRetentionDays : undefined;
  const autoArchiveDays =
    'autoArchiveDays' in value ? value.autoArchiveDays : undefined;
  return (
    (archiveRetentionDays === undefined ||
      archiveRetentionDays === null ||
      typeof archiveRetentionDays === 'number') &&
    (autoArchiveDays === undefined ||
      autoArchiveDays === null ||
      typeof autoArchiveDays === 'number')
  );
}

const ADVISOR_SCOPE: SidebarItemGroupScope = { appAdvisor: true };
const EMPTY_GROUPS: SidebarItemGroup[] = [];

const EMPTY_LEGACY_ARCHIVED: StandaloneChatMeta[] = [];

export interface AppAdvisorNavProps {
  /** Persisted collapsed state. */
  collapsed: boolean;
}

export const AppAdvisorNav = memo(function AppAdvisorNav({
  collapsed,
}: AppAdvisorNavProps): JSX.Element {
  const workEntries = useStandaloneChatStore((s) => s.workEntries);
  const activeWorkEntryId = useStandaloneChatStore((s) => s.activeWorkEntryId);
  const archiveOverlayChatId = useStandaloneChatStore(
    (s) => s.archiveOverlayChatId,
  );
  const selectWorkEntry = useStandaloneChatStore((s) => s.selectWorkEntry);
  const renameWorkEntry = useStandaloneChatStore((s) => s.renameWorkEntry);
  const deleteWorkEntry = useStandaloneChatStore((s) => s.deleteWorkEntry);
  const setWorkEntryPinned = useStandaloneChatStore(
    (s) => s.setWorkEntryPinned,
  );
  // Pinned entries lead, as on the main sidebar; the rest keep the registry
  // order this list has always shown.
  const orderedWorkEntries = useMemo(
    () => orderWorkEntryRows(workEntries, 'manual'),
    [workEntries],
  );
  const loadLegacyArchivedChats = useStandaloneChatStore(
    (s) => s.loadLegacyArchivedChats,
  );
  const legacyArchivedLoaded = useStandaloneChatStore(
    (s) => s.legacyArchivedByProject[APP_ADVISOR_PROJECT_ID] !== undefined,
  );
  const legacyArchivedChats = useStandaloneChatStore(
    (s) =>
      s.legacyArchivedByProject[APP_ADVISOR_PROJECT_ID] ??
      EMPTY_LEGACY_ARCHIVED,
  );

  // Retained ("Archived" / "Deleted") work-entry containers, counted into
  // the "Archived and deleted" nav link alongside the legacy archived chats.
  const archivedEntries = useArchivedContainersStore(
    (s) => s.byWorkspace[APP_ADVISOR_PROJECT_ID] ?? EMPTY_ARCHIVED_CONTAINERS,
  );
  // Removals still being captured count immediately so the link reacts the
  // moment the entry leaves the list, not when main finishes cleanup.
  const pendingArchivedEntries = useArchivedContainersStore(
    (s) =>
      s.pendingByWorkspace[APP_ADVISOR_PROJECT_ID] ??
      EMPTY_PENDING_ARCHIVED_CONTAINERS,
  );
  const archivedContainersLoaded = useArchivedContainersStore(
    (s) => s.loadedWorkspaces[APP_ADVISOR_PROJECT_ID] === true,
  );
  // The archived container currently open in the viewer for this workspace
  // (primitive selector so unrelated viewer changes don't re-render the nav).
  const openContainerId = useArchivedContainersStore((s) =>
    s.viewer !== null && s.viewer.workspaceId === APP_ADVISOR_PROJECT_ID
      ? s.viewer.containerId
      : null,
  );
  const archivedOverviewOpen = useArchivedContainersStore(
    (s) => s.overview?.workspaceId === APP_ADVISOR_PROJECT_ID,
  );

  const [groupEditorId, setGroupEditorId] = useState<string | null>(null);
  useCurrentUiStateReporter('sidebar.itemGroupEditor.app-advisor', {
    groupId: groupEditorId,
  });
  const groups = useSidebarItemGroupsStore(
    (state) => state.byScope['app-advisor'] ?? EMPTY_GROUPS,
  );
  useEffect(() => {
    if (collapsed || !window.api?.sidebarItemGroups) return;
    const refresh = (): void => {
      void useSidebarItemGroupsStore
        .getState()
        .hydrate(ADVISOR_SCOPE)
        .catch(() => undefined);
    };
    refresh();
    return window.api.sidebarItemGroups.onChanged?.((scope) => {
      if (scope.appAdvisor) refresh();
    });
  }, [collapsed]);
  const blocks = useMemo(
    () =>
      buildSidebarItemGroupBlocks(
        orderedWorkEntries.map((entry) => ({
          rootId: entry.id,
          itemIds: [entry.id],
          pinned: entry.pinned === true,
        })),
        groups,
        'manual',
        activeWorkEntryId ?? undefined,
      ),
    [orderedWorkEntries, groups, activeWorkEntryId],
  );
  const reportGroupError = (error: unknown): void =>
    useGitHubStore
      .getState()
      .addToast(
        error instanceof Error
          ? error.message
          : 'Group changes could not be saved. Try again.',
        'error',
      );
  const groupStore = useSidebarItemGroupsStore.getState();
  const commands: CodeSidebarItemGroupCommands = {
    create: (itemId) => groupStore.create({ scope: ADVISOR_SCOPE, itemId }),
    update: (groupId, patch): Promise<void> =>
      groupStore
        .update({ scope: ADVISOR_SCOPE, groupId, ...patch })
        .catch(reportGroupError),
    ungroup: (groupId): void => {
      void groupStore
        .ungroup({ scope: ADVISOR_SCOPE, groupId })
        .catch(reportGroupError);
    },
    moveItem: (itemId, drop): void => {
      void groupStore
        .moveItem({
          scope: ADVISOR_SCOPE,
          itemId,
          groupId: drop.groupId,
          ...(drop.before
            ? { before: drop.before }
            : drop.after
              ? { after: drop.after }
              : {}),
        })
        .catch(reportGroupError);
    },
    moveGroup: (groupId, drop): void => {
      void groupStore
        .moveGroup({
          scope: ADVISOR_SCOPE,
          groupId,
          ...(drop.before
            ? { before: drop.before }
            : drop.after
              ? { after: drop.after }
              : {}),
        })
        .catch(reportGroupError);
    },
  };

  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);

  // Effective deletion-retention window drives the Delete tooltip copy. App
  // Advisor retention lives in its workspace settings file (no store holds
  // it), so load it best-effort once; the surface default (7 days) applies
  // while loading or when the bridge is unavailable.
  const [effectiveRetentionDays, setEffectiveRetentionDays] = useState<number>(
    () => resolveArchiveRetentionDays('app-advisor', undefined),
  );
  const applySettings = useCallback((settings: unknown): void => {
    if (!isAppAdvisorSettingsSavedDetail(settings)) return;
    setEffectiveRetentionDays(
      resolveArchiveRetentionDays('app-advisor', settings.archiveRetentionDays),
    );
  }, []);
  useEffect(() => {
    const handleSaved = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      applySettings(event.detail);
    };
    window.addEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, handleSaved);
    return (): void =>
      window.removeEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, handleSaved);
  }, [applySettings]);
  useEffect(() => {
    if (typeof window.api?.appAdvisor?.onSettingsChanged !== 'function') {
      return;
    }
    return window.api.appAdvisor.onSettingsChanged(applySettings);
  }, [applySettings]);
  useEffect(() => {
    if (typeof window.api?.appAdvisor?.settingsLoad !== 'function') {
      return;
    }
    let cancelled = false;
    void window.api.appAdvisor
      .settingsLoad()
      .then((settings) => {
        if (!cancelled) {
          setEffectiveRetentionDays(
            resolveArchiveRetentionDays(
              'app-advisor',
              settings.archiveRetentionDays,
            ),
          );
        }
      })
      .catch(() => {
        // Best-effort: keep the surface default.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Lazily load the legacy (`global`) archived subgroup once expanded.
  useEffect(() => {
    if (!collapsed && !legacyArchivedLoaded) {
      void loadLegacyArchivedChats(APP_ADVISOR_PROJECT_ID).catch(() => {
        // Legacy archive loads are best-effort; the subgroup stays hidden.
      });
    }
  }, [collapsed, legacyArchivedLoaded, loadLegacyArchivedChats]);

  // Lazily load archived containers once expanded (best-effort; errors are
  // swallowed in the store and the subgroup shows its empty state).
  useEffect(() => {
    if (!collapsed && !archivedContainersLoaded) {
      void useArchivedContainersStore
        .getState()
        .loadForWorkspace(APP_ADVISOR_PROJECT_ID);
    }
  }, [collapsed, archivedContainersLoaded]);

  // Browser bounds contract: native WebContentsViews do not track CSS width
  // transitions, so invalidate once the nav's width transition settles.
  const navRef = useRef<HTMLElement | null>(null);
  const handleTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLElement>): void => {
      if (event.target === navRef.current && event.propertyName === 'width') {
        dispatchBrowserViewBoundsInvalidated();
      }
    },
    [],
  );

  const handleSelectEntry = useCallback(
    (entryId: string): void => {
      // Explicit navigation to a live entry dismisses the page-like archived
      // viewer (programmatic activations must not).
      dismissPageLikeViewers();
      void selectWorkEntry(entryId);
    },
    [selectWorkEntry],
  );

  const handleRenameEntry = useCallback(
    (entryId: string, title: string | null): void => {
      void renameWorkEntry(entryId, title).catch(() => {
        // Rename failures should not break the nav.
      });
    },
    [renameWorkEntry],
  );

  const handleDeleteEntry = useCallback(
    (entryId: string, options: { mode: 'delete' | 'archive' }): void => {
      setDeletingEntryId(entryId);
      void deleteWorkEntry(entryId, undefined, {
        lockAfterArchive: options.mode === 'archive',
      })
        .catch(() => {
          // Delete failures should not break the nav.
        })
        .finally(() => {
          setDeletingEntryId(null);
        });
    },
    [deleteWorkEntry],
  );

  const handleSetEntryPinned = useCallback(
    (entryId: string, pinned: boolean): void => {
      void setWorkEntryPinned(entryId, pinned, APP_ADVISOR_PROJECT_ID).catch(
        () => {
          useGitHubStore
            .getState()
            .addToast(pinned ? 'Failed to pin' : 'Failed to unpin', 'error');
        },
      );
    },
    [setWorkEntryPinned],
  );

  const handleOpenArchivedOverview = useCallback((): void => {
    openArchivedOverviewSurface(APP_ADVISOR_PROJECT_ID);
  }, []);

  return (
    <nav
      ref={navRef}
      data-testid="app-advisor-nav"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="App Advisor navigation"
      onTransitionEnd={handleTransitionEnd}
      className={`flex h-full shrink-0 flex-col overflow-hidden bg-sidebar transition-[width] duration-150 ease-out ${
        collapsed ? 'w-0 border-r-0' : 'w-60 border-r '
      }`}
    >
      {/* Header: a drag-region row reserving height beneath the persistent
          AppAdvisorTitlebarCorner overlay (which owns the control buttons at
          constant window coordinates). */}
      {!collapsed && <div className="electron-drag h-10.75 shrink-0" />}

      {/* Entry list + legacy archives — unmounted while collapsed (the nav
          is zero-width; the corner overlay stays put above the top bar). */}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1.5 pb-2">
          {workEntries.length === 0 &&
          blocks.length === 0 &&
          legacyArchivedChats.length === 0 &&
          archivedEntries.length === 0 ? (
            <div className="px-2 py-2 text-xs fg-secondary">
              No work entries yet
            </div>
          ) : (
            <>
              <div className="pl-1.5">
                <CodeSidebarItemGroups
                  onEditorChange={setGroupEditorId}
                  blocks={blocks}
                  groups={groups}
                  mode="manual"
                  commands={commands}
                  unitLabel={{ singular: 'chat', plural: 'chats' }}
                  rowGap="hairline"
                  canDragRow={(): boolean => true}
                  onCreate={(groupId): void => {
                    void useStandaloneChatStore
                      .getState()
                      .createWorkEntry({ sidebarItemGroupId: groupId })
                      .catch(reportGroupError);
                  }}
                  onError={reportGroupError}
                  renderStatus={(block): ReactNode =>
                    block.units.some(
                      (unit) =>
                        workEntries.find((entry) => entry.id === unit.rootId)
                          ?.hasActiveChat,
                    ) ? (
                      <span aria-label="Active work in group">
                        <ThinkingSpinner tone="active" />
                      </span>
                    ) : block.units.some(
                        (unit) =>
                          (workEntries.find((entry) => entry.id === unit.rootId)
                            ?.unreadChats?.length ?? 0) > 0,
                      ) ? (
                      <span
                        aria-label="Unread work in group"
                        className="h-1.5 w-1.5 rounded-full bg-accent"
                      />
                    ) : null
                  }
                  renderPreview={(id): ReactNode => (
                    <div className="flex h-8 items-center px-1.5 text-s fg-primary">
                      {workEntries.find((entry) => entry.id === id)?.title}
                    </div>
                  )}
                  renderRow={(id, menu): ReactNode => {
                    const entry = workEntries.find((entry) => entry.id === id);
                    return entry ? (
                      <WorkEntryListItem
                        entry={entry}
                        groupMenu={menu}
                        selected={
                          entry.id === activeWorkEntryId &&
                          archiveOverlayChatId === null &&
                          openContainerId === null
                        }
                        onSelect={() => handleSelectEntry(entry.id)}
                        onRename={(title) => handleRenameEntry(entry.id, title)}
                        onDelete={(options) =>
                          handleDeleteEntry(entry.id, options)
                        }
                        onSetPinned={(pinned) =>
                          handleSetEntryPinned(entry.id, pinned)
                        }
                        deleting={entry.id === deletingEntryId}
                        testIdPrefix="app-advisor-nav-entry"
                        effectiveRetentionDays={effectiveRetentionDays}
                      />
                    ) : null;
                  }}
                />
              </div>
              <ArchivedContainersNavLink
                count={
                  legacyArchivedChats.length +
                  archivedEntries.length +
                  pendingArchivedEntries.length
                }
                selected={
                  archivedOverviewOpen ||
                  openContainerId !== null ||
                  archiveOverlayChatId !== null
                }
                onOpen={handleOpenArchivedOverview}
                testId="app-advisor-nav-archived-link"
              />
            </>
          )}
        </div>
      )}
    </nav>
  );
});

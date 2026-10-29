import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/shallow';
import {
  getOnlyQueuedHookPlaceholderQueueId,
  useChatStore,
  useChatTabStrip,
  useWorktreeChatRenderState,
  type ChatTabStripTab,
} from '@/stores/chatStore';
import {
  DELEGATES_BLOCK_CLOSE_TOOLTIP,
  getChatTabCloseBlocker,
} from '@/stores/chat/close-guard';
import {
  selectChatHasLiveDelegates,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  desktopFileSessionController,
  useDesktopFileSessionRevision,
} from '@/lib/file-viewer/desktop-file-session-controller';
import { resolveOverallDefault } from '@canopy/desktop-shared/types';
import { ThinkingSpinner } from '../shared/loading/spinners/ThinkingSpinner';
import { FileTypeIcon } from '../shared/file-icons';
import { AgentProviderIcon, resolveChatTabProvider } from '@/lib/providerUi';
import { copyTextToClipboard } from '@/lib/clipboard';
import { formatFileReferencePath } from '@/lib/file-reference-paths';
import { TabContextMenu, type TabContextMenuItem } from './TabContextMenu';
import { useChatTabRename } from './ChatTabRenameDialog';
import { chatTabStripLabel } from '@/lib/chatTabLabel';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { ChatIcon, PlanModeIcon } from '@canopy/ui-shared/icons';
import {
  Lock as AppCatalogLock,
  PlusIcon as AppCatalogPlusIcon,
  MoreVerticalIcon as AppCatalogMoreVerticalIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  PinIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ChatTab as SharedChatTab } from '@canopy/ui-shared/components';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ArchivedChatsControl } from './ArchivedChatsControl';
import { AnchoredMenu } from '@/components/shared/AnchoredMenu';
import { ShareSessionControl } from '@/components/shared/ShareSessionControl';
import { ShareRunModal } from '@/components/shared/ShareRunModal';
import { ExportSessionConfirmationModal } from '@/components/shared/ExportSessionConfirmationModal';
import { useShareRunAction } from '@/hooks/useShareRunAction';
import { useExportSessionAction } from '@/hooks/useExportSessionAction';
import { canTransferChatSession } from '@/lib/session-transfer-eligibility';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

interface ChatTabBarProps {
  /**
   * Optional scope override. When provided, the tab bar renders and mutates
   * tabs for this `(projectId, worktreeId)` instead of the globally selected
   * worktree. Used by the Plan Explore modal to host a plan-scoped chat without
   * changing the global selection. When omitted, behavior is unchanged.
   */
  scope?: { projectId: string; worktreeId: string };
  /**
   * Whether the bar background acts as an Electron window-drag region. True
   * for the title-bar-adjacent worktree chat; pass false for embedded surfaces
   * (e.g. the pipeline-editor drawer) so the strip is not a window-drag handle.
   */
  dragRegion?: boolean;
  /** Override the bar's root `data-testid` (defaults to `chat-tab-bar`). */
  dataTestId?: string;
}

function scrollTabIntoView(
  container: HTMLDivElement,
  tab: HTMLDivElement,
): void {
  const containerRect = container.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const tabLeft = tabRect.left - containerRect.left + container.scrollLeft;
  const tabRight = tabLeft + tabRect.width;
  const visibleLeft = container.scrollLeft;
  const visibleRight = visibleLeft + container.clientWidth;

  if (tabLeft < visibleLeft) {
    container.scrollLeft = tabLeft;
  } else if (tabRight > visibleRight) {
    container.scrollLeft = tabRight - container.clientWidth;
  }
}

export const ChatTabBar = memo(function ChatTabBar({
  scope,
  dragRegion = true,
  dataTestId = 'chat-tab-bar',
}: ChatTabBarProps = {}): JSX.Element {
  const worktreeKey = useChatStore((s) => {
    const sel = scope ?? s.selectedWorktree;
    if (!sel) return '';
    return `${sel.projectId}/${sel.worktreeId}`;
  });
  // The strip projection: it keeps its identity while only transcript state
  // (streamed content) changes, so a streaming reply does not re-render it.
  const tabs = useChatTabStrip(worktreeKey === '' ? null : worktreeKey);
  const activeTabId = useWorktreeChatRenderState(
    worktreeKey === '' ? null : worktreeKey,
    (chatState) => chatState?.activeTabId ?? '',
  );
  const {
    switchTab: switchTabAction,
    closeTab: closeTabAction,
    closeTabs: closeTabsAction,
    createTab: createTabAction,
    reorderTabs: reorderTabsAction,
    setTabPinned: setTabPinnedAction,
    selectedWorktree,
    pendingPlanExits,
    pendingApprovals,
    defaultWorktreeModel,
  } = useChatStore(
    useShallow((s) => ({
      switchTab: s.switchTab,
      closeTab: s.closeTab,
      closeTabs: s.closeTabs,
      createTab: s.createTab,
      reorderTabs: s.reorderTabs,
      setTabPinned: s.setTabPinned,
      selectedWorktree: s.selectedWorktree,
      pendingPlanExits: s.pendingPlanExits,
      pendingApprovals: s.pendingApprovals,
      defaultWorktreeModel: s.modelDefaults
        ? resolveOverallDefault(
            s.modelDefaults.worktreeModelByProvider,
            s.modelDefaults.worktreeProvider,
          ).model
        : undefined,
    })),
  );

  // Bind every tab mutation to `scope` when present so the modal-hosted tab bar
  // operates on the plan-explore worktree, not the global selection. Without
  // `scope`, these are exact passthroughs and behavior is unchanged.
  const switchTab = useCallback(
    (tabId: string): void => switchTabAction(tabId, scope),
    [switchTabAction, scope],
  );
  const closeTab = useCallback(
    (tabId: string): void =>
      closeTabAction(tabId, scope ? { ...scope } : undefined),
    [closeTabAction, scope],
  );
  const closeTabs = useCallback(
    (targetIds: string[]): void => closeTabsAction(targetIds, scope),
    [closeTabsAction, scope],
  );
  const createTab = useCallback(
    (): void => createTabAction(scope),
    [createTabAction, scope],
  );
  const reorderTabs = useCallback(
    (fromTabId: string, beforeTabId: string | null): void =>
      reorderTabsAction(fromTabId, beforeTabId, scope),
    [reorderTabsAction, scope],
  );
  const setTabPinned = useCallback(
    (tabId: string, pinned: boolean): void =>
      setTabPinnedAction(tabId, pinned, scope),
    [setTabPinnedAction, scope],
  );

  // Effective (projectId, worktreeId) the bar operates on. `scope` wins for the
  // modal-hosted tab bar; otherwise the globally selected worktree.
  const effectiveScope = scope ?? selectedWorktree ?? null;
  // Live managed delegates keep a chat active (spinner) and open (disabled ×)
  // even after its own turn ended. Never read from `tab.status`.
  const delegationState = useDelegationActivityStore((state) => state);
  const share = useShareRunAction(
    effectiveScope?.projectId ?? null,
    effectiveScope?.worktreeId ?? null,
  );
  const exportSession = useExportSessionAction(
    effectiveScope?.projectId ?? null,
    effectiveScope?.worktreeId ?? null,
  );

  // The store's own tabs array while it is empty. The strip projection keeps a
  // constant empty value, so this restores the retry below on each commit that
  // replaces an empty scope's tabs (for example after a failed starter-tab
  // creation), without re-rendering on streamed content once tabs exist.
  const emptyTabsRevision = useWorktreeChatRenderState(
    worktreeKey === '' ? null : worktreeKey,
    (chatState) =>
      chatState && chatState.tabs.length === 0 ? chatState.tabs : null,
  );

  // Self-heal: a selected worktree must always surface at least one chat tab.
  // If a hydration attempt failed (or never ran) before populating this
  // worktree's store entry, re-request it. loadTabs/loadTabsForTarget dedupe
  // in-flight and already-hydrated keys, so this is a no-op in steady state.
  useEffect(() => {
    if (!worktreeKey || tabs.length > 0) {
      return;
    }
    const state = useChatStore.getState();
    if (scope) {
      void state.loadTabsForTarget(scope.projectId, scope.worktreeId);
    } else {
      void state.loadTabs();
    }
  }, [worktreeKey, tabs, scope, emptyTabsRevision]);

  // Subscribe to the shared file-session controller revision so a file tab's
  // pill re-renders when its shared buffer flips between clean and dirty, then
  // derive the dirty ids by filtering the current file tabs through the
  // controller's shared dirty state.
  const controllerRevision = useDesktopFileSessionRevision();
  const dirtyTabIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of tabs) {
      if (tab.kind === 'file' && desktopFileSessionController.isDirty(tab.id)) {
        ids.add(tab.id);
      }
    }
    return ids;
    // `controllerRevision` bumps on any shared-session/registration change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, controllerRevision]);

  const pinnedListRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const prevTabCountRef = useRef(0);
  const prevWorktreeKeyRef = useRef<string | null>(null);

  // Pinned tabs render in a left-anchored container that may grow until it
  // hits 40% of the bar's width, after which it gains its own horizontal
  // scroll. Unpinned tabs always own the remaining space. Pre-splitting here
  // keeps the render below readable and lets us compute section-aware drag
  // indicators in one place.
  const pinnedTabs = useMemo(
    (): ChatTabStripTab[] => tabs.filter((t) => t.pinned === true),
    [tabs],
  );
  const unpinnedTabs = useMemo(
    (): ChatTabStripTab[] => tabs.filter((t) => t.pinned !== true),
    [tabs],
  );
  const tabIndexById = useMemo((): Map<string, number> => {
    const indexes = new Map<string, number>();
    tabs.forEach((tab, index) => {
      indexes.set(tab.id, index);
    });
    return indexes;
  }, [tabs]);
  const firstUnpinnedId: string | null = unpinnedTabs[0]?.id ?? null;
  const activeTabIndex = tabIndexById.get(activeTabId) ?? -1;
  const activeTabIsPinned = tabs[activeTabIndex]?.pinned === true;

  // Drag-and-drop reordering. `dropBeforeId` is the id of the tab that the
  // dragged tab will be inserted before; `null` means "drop at the end".
  // `undefined` means no active drop target (no indicator shown).
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null | undefined>(
    undefined,
  );
  const draggedIsPinned: boolean =
    draggingId !== null &&
    tabs.find((t) => t.id === draggingId)?.pinned === true;

  // Worktree root path for the bar's scope, resolved once per scope so file-tab
  // hover tooltips can show a path relative to the workspace root (falling back
  // to the absolute path for files outside it). `undefined` until resolved or
  // when there is no scope.
  const [worktreeRootPath, setWorktreeRootPath] = useState<string | undefined>(
    undefined,
  );
  const scopeProjectId = effectiveScope?.projectId;
  const scopeWorktreeId = effectiveScope?.worktreeId;
  useEffect(() => {
    setWorktreeRootPath(undefined);
    if (!scopeProjectId || !scopeWorktreeId) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const path = await window.api.getWorktreePath({
          projectId: scopeProjectId,
          worktreeId: scopeWorktreeId,
        });
        if (!cancelled) setWorktreeRootPath(path);
      } catch {
        if (!cancelled) setWorktreeRootPath(undefined);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [scopeProjectId, scopeWorktreeId]);

  // Right-click context menu state. `tabId` identifies which tab was clicked;
  // `x` / `y` are viewport coordinates for the menu anchor.
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
    ownerDocument: Document;
    anchor: HTMLElement;
  } | null>(null);

  const closeContextMenu = useCallback((): void => {
    setContextMenu(null);
  }, []);
  const chatTabRename = useChatTabRename();
  const readOnlyWorkspace = useWorkspaceIsReadOnly();

  // Visible "session actions" kebab for the active chat tab, giving worktree
  // chat the same discoverable share affordance as cowork.
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const sessionMenuButtonRef = useRef<HTMLButtonElement>(null);

  // Pinned-tab hover popover. The host owns popover positioning because the
  // popover content (provider icon / spinner / file icon plus title) is
  // assembled from the same source data used for the tab's leading slot.
  const [pinnedHover, setPinnedHover] = useState<{
    tabId: string;
    anchor: DOMRect;
  } | null>(null);
  const pinnedHoverRefs = useRef(new Map<string, HTMLDivElement>());
  const pinnedHoverOpenTimer = useRef<number | null>(null);
  const pinnedHoverCloseTimer = useRef<number | null>(null);

  const clearPinnedHoverOpenTimer = useCallback((): void => {
    if (pinnedHoverOpenTimer.current !== null) {
      window.clearTimeout(pinnedHoverOpenTimer.current);
      pinnedHoverOpenTimer.current = null;
    }
  }, []);

  const clearPinnedHoverCloseTimer = useCallback((): void => {
    if (pinnedHoverCloseTimer.current !== null) {
      window.clearTimeout(pinnedHoverCloseTimer.current);
      pinnedHoverCloseTimer.current = null;
    }
  }, []);

  const showPinnedHover = useCallback(
    (tabId: string): void => {
      clearPinnedHoverOpenTimer();
      clearPinnedHoverCloseTimer();
      pinnedHoverOpenTimer.current = window.setTimeout(() => {
        const el = pinnedHoverRefs.current.get(tabId);
        if (!el) return;
        setPinnedHover({ tabId, anchor: el.getBoundingClientRect() });
        pinnedHoverOpenTimer.current = null;
      }, 180);
    },
    [clearPinnedHoverCloseTimer, clearPinnedHoverOpenTimer],
  );

  const schedulePinnedHoverClose = useCallback((): void => {
    clearPinnedHoverOpenTimer();
    clearPinnedHoverCloseTimer();
    pinnedHoverCloseTimer.current = window.setTimeout(() => {
      setPinnedHover(null);
      pinnedHoverCloseTimer.current = null;
    }, 80);
  }, [clearPinnedHoverCloseTimer, clearPinnedHoverOpenTimer]);

  useEffect((): (() => void) => {
    return (): void => {
      if (pinnedHoverOpenTimer.current !== null) {
        window.clearTimeout(pinnedHoverOpenTimer.current);
        pinnedHoverOpenTimer.current = null;
      }
      if (pinnedHoverCloseTimer.current !== null) {
        window.clearTimeout(pinnedHoverCloseTimer.current);
        pinnedHoverCloseTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setContextMenu(null);
    setPinnedHover(null);
    clearPinnedHoverOpenTimer();
    clearPinnedHoverCloseTimer();
  }, [worktreeKey, clearPinnedHoverCloseTimer, clearPinnedHoverOpenTimer]);

  const handleTabDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, tabId: string): void => {
      setDraggingId(tabId);
      setDropBeforeId(undefined);
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require data on the transfer object for drag to start.
      e.dataTransfer.setData('text/plain', tabId);
    },
    [],
  );

  const handleTabDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>, tabId: string, tabIndex: number): void => {
      if (draggingId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const isLeftHalf = e.clientX < rect.left + rect.width / 2;
      let target: string | null | undefined;
      if (isLeftHalf) {
        target = tabId;
      } else {
        target = tabs[tabIndex + 1]?.id ?? null;
      }
      // Avoid showing an indicator that would be a no-op.
      if (target === draggingId) {
        target = undefined;
      }
      setDropBeforeId(target);
    },
    [draggingId, tabs],
  );

  const handlePinnedListDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      if (draggingId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Empty space inside the pinned strip implies "drop at end of pinned
      // section". The boundary id between pinned and unpinned tabs is the
      // first unpinned tab id, or `null` when there are no unpinned tabs.
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('[role="tab"]') !== null) return;
      if (!draggedIsPinned) return;
      setDropBeforeId(firstUnpinnedId);
    },
    [draggingId, draggedIsPinned, firstUnpinnedId],
  );

  const handleUnpinnedListDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      if (draggingId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Empty space inside the unpinned strip implies "drop at end of all
      // tabs". The store's section clamp guarantees a pinned tab dragged
      // into the unpinned strip just lands at the end of pinned, but we
      // still avoid drawing a misleading visual indicator for that case.
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('[role="tab"]') !== null) return;
      if (draggedIsPinned) return;
      setDropBeforeId(null);
    },
    [draggingId, draggedIsPinned],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      if (draggingId === null) return;
      e.preventDefault();
      const target = dropBeforeId;
      const dragged = draggingId;
      setDraggingId(null);
      setDropBeforeId(undefined);
      if (target === undefined) return;
      reorderTabs(dragged, target);
    },
    [draggingId, dropBeforeId, reorderTabs],
  );

  const handleDragEnd = useCallback((): void => {
    setDraggingId(null);
    setDropBeforeId(undefined);
  }, []);

  // Translate vertical wheel deltas into horizontal scrolling on either
  // tab strip so a regular mouse wheel can pan its tabs. React's synthetic
  // `onWheel` is passive, so the listener is attached manually with
  // `{ passive: false }` to allow `preventDefault`. Both strips share the
  // same handler logic.
  useEffect(() => {
    const targets: HTMLDivElement[] = [];
    if (pinnedListRef.current) targets.push(pinnedListRef.current);
    if (tabListRef.current) targets.push(tabListRef.current);
    if (targets.length === 0) return;
    const handlers = targets.map((el) => {
      const handleWheel = (e: WheelEvent): void => {
        if (el.scrollWidth <= el.clientWidth) return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        const maxScrollLeft = el.scrollWidth - el.clientWidth;
        const nextScrollLeft = Math.min(
          maxScrollLeft,
          Math.max(0, el.scrollLeft + e.deltaY),
        );
        if (nextScrollLeft === el.scrollLeft) return;
        e.preventDefault();
        el.scrollLeft = nextScrollLeft;
      };
      el.addEventListener('wheel', handleWheel, { passive: false });
      return { el, handleWheel };
    });
    return (): void => {
      for (const { el, handleWheel } of handlers) {
        el.removeEventListener('wheel', handleWheel);
      }
    };
  }, [pinnedTabs.length]);

  // Dismiss the pinned-tab hover popover whenever either strip scrolls so
  // the recorded anchor rect doesn't go stale and the popover doesn't
  // visually detach from its pill.
  useEffect(() => {
    const targets: HTMLDivElement[] = [];
    if (pinnedListRef.current) targets.push(pinnedListRef.current);
    if (tabListRef.current) targets.push(tabListRef.current);
    const handleScroll = (): void => {
      setPinnedHover(null);
      clearPinnedHoverCloseTimer();
    };
    for (const el of targets) {
      el.addEventListener('scroll', handleScroll);
    }
    window.addEventListener('resize', handleScroll);
    return (): void => {
      for (const el of targets) {
        el.removeEventListener('scroll', handleScroll);
      }
      window.removeEventListener('resize', handleScroll);
    };
  }, [clearPinnedHoverCloseTimer, pinnedTabs.length]);

  useLayoutEffect(() => {
    const activeTab = activeTabRef.current;
    const activeContainer = activeTabIsPinned
      ? pinnedListRef.current
      : tabListRef.current;
    const worktreeChanged = prevWorktreeKeyRef.current !== worktreeKey;

    if (worktreeChanged) {
      prevWorktreeKeyRef.current = worktreeKey;
      prevTabCountRef.current = tabs.length;
      if (activeContainer && activeTab) {
        scrollTabIntoView(activeContainer, activeTab);
      }
      return;
    }

    // New tabs can be appended via the "+" button or inserted near the source
    // tab by fork actions. Reveal the active tab itself so middle insertions
    // don't jump the strip to the end.
    if (activeContainer && activeTab) {
      scrollTabIntoView(activeContainer, activeTab);
    }

    prevTabCountRef.current = tabs.length;
  }, [
    activeTabId,
    activeTabIndex,
    activeTabIsPinned,
    pinnedTabs.length,
    tabs.length,
    worktreeKey,
  ]);

  const renderTab = (tab: ChatTabStripTab, tabIndex: number): JSX.Element => {
    const isActive = tab.id === activeTabId;
    const isFileTab = tab.kind === 'file';
    const isPinned = tab.pinned === true;
    const isFileTabDirty = isFileTab && dirtyTabIdSet.has(tab.id);
    const isDragging = draggingId === tab.id;
    // Drop indicators only show within the dragged tab's own section.
    // Cross-section drops are clamped in the store; suppressing the
    // visual indicator on opposite-section tabs avoids the misleading
    // "your drop will land here" hint that wouldn't be honored.
    const sameSection = draggingId === null || draggedIsPinned === isPinned;
    const isLastInSection = isPinned
      ? tab.id === pinnedTabs[pinnedTabs.length - 1]?.id
      : tab.id === unpinnedTabs[unpinnedTabs.length - 1]?.id;
    const showDropBefore = sameSection && dropBeforeId === tab.id;
    const showDropAfter =
      sameSection &&
      isLastInSection &&
      (isPinned ? dropBeforeId === firstUnpinnedId : dropBeforeId === null);
    const tabLabel = isFileTab ? tab.title : chatTabStripLabel(tab);
    const baseTooltip = isFileTab
      ? tab.filePath
        ? formatFileReferencePath(tab.filePath, worktreeRootPath)
        : (tab.description ?? tab.title)
      : chatTabStripLabel(tab);
    const tabTooltip = isFileTabDirty
      ? `${baseTooltip} (unsaved)`
      : baseTooltip;
    const awaitingApproval =
      !isFileTab &&
      (!!tab.pendingPlanExit ||
        Object.values(pendingPlanExits).some((pe) => pe.chatId === tab.id));
    // The sidebar row only says the worktree needs input; this marks WHICH
    // chat, so landing here does not start a hunt through the tab strip.
    const awaitingToolApproval =
      !isFileTab &&
      Object.values(pendingApprovals).some(
        (approval) => approval.chatId === tab.id,
      );
    const provider = isFileTab
      ? undefined
      : resolveChatTabProvider(tab, defaultWorktreeModel);
    const hasLiveDelegates =
      !isFileTab &&
      effectiveScope !== null &&
      selectChatHasLiveDelegates(
        delegationState,
        effectiveScope.projectId,
        effectiveScope.worktreeId,
        tab.id,
      );
    // Working: its own turn streams or its delegates still run.
    const isWorking =
      !isFileTab && (tab.status === 'streaming' || hasLiveDelegates);
    const closeBlocker =
      effectiveScope === null
        ? null
        : getChatTabCloseBlocker(
            tab,
            effectiveScope.projectId,
            effectiveScope.worktreeId,
            delegationState,
          );
    const leading = isFileTab ? (
      <FileTypeIcon
        filename={tab.title}
        size={20}
        boxSize={14}
        className="shrink-0"
      />
    ) : isWorking && !awaitingApproval && !awaitingToolApproval ? (
      <ThinkingSpinner
        // Matches the 12px provider/plan glyphs it alternates with, so the tab
        // neither reads narrower nor nudges its label while a turn runs.
        sizePx={12}
        // The accent, not the run-state info blue: the sidebar's WorktreeRow
        // paints its running spinner with the accent, and both mean the same
        // thing ("agent working here"), so the tab follows the theme's accent
        // instead of introducing a second hue for one signal. Unread keeps its
        // own colour — that is a different signal, shared with the unread dot.
        tone={tab.unread ? 'unread' : 'accent'}
        className="shrink-0"
      />
    ) : awaitingApproval ? (
      <PlanModeIcon
        width={12}
        height={12}
        className={`shrink-0 ${OPERATIONAL_STATUS_COLORS.unread.foreground}`}
      />
    ) : provider !== undefined ? (
      <AgentProviderIcon
        provider={provider}
        width={12}
        height={12}
        className={`shrink-0 ${tab.unread ? OPERATIONAL_STATUS_COLORS.unread.foreground : 'fg-secondary'}`}
      />
    ) : (
      <ChatIcon
        width={12}
        height={12}
        className={`shrink-0 ${tab.unread ? OPERATIONAL_STATUS_COLORS.unread.foreground : 'fg-secondary'}`}
      />
    );
    const trailing = (
      <>
        {awaitingToolApproval && (
          <span
            aria-label="Approval needed"
            title="Approval needed"
            data-testid={`chat-tab-tool-approval-${tab.id}`}
            className="ml-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-fg-warning"
          />
        )}
        {isFileTabDirty && (
          <span
            aria-label="Unsaved changes"
            title="Unsaved changes"
            className="ml-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          />
        )}
        {!isFileTab && tab.readOnly && (
          <AppCatalogLock
            width="11"
            height="11"
            className="shrink-0 fg-secondary"
            aria-hidden="true"
          />
        )}
      </>
    );
    return (
      <SharedChatTab
        key={tab.id}
        dataTestId={`chat-tab-${tab.id}`}
        label={tabLabel}
        maskLabel={!isFileTab}
        active={isActive}
        busy={isWorking}
        // A busy chat cannot close. Delegates are not visible from the tab,
        // so that reason is spelled out on an always-visible disabled ×; a
        // chat's own running turn already shows its spinner.
        closeDisabled={closeBlocker !== null}
        closeDisabledReason={
          closeBlocker === 'delegates'
            ? DELEGATES_BLOCK_CLOSE_TOOLTIP
            : undefined
        }
        unread={tab.kind === 'file' ? false : tab.unread}
        readOnly={tab.readOnly}
        tooltip={tabTooltip}
        leading={leading}
        trailing={trailing}
        dragging={isDragging}
        dropBefore={showDropBefore}
        dropAfter={showDropAfter}
        pinned={isPinned}
        draggable
        onDragStart={(e): void => handleTabDragStart(e, tab.id)}
        onDragOver={(e): void => handleTabDragOver(e, tab.id, tabIndex)}
        onDragEnd={handleDragEnd}
        onContextMenu={(e): void => {
          e.preventDefault();
          setPinnedHover(null);
          clearPinnedHoverCloseTimer();
          setContextMenu({
            tabId: tab.id,
            x: e.clientX,
            y: e.clientY,
            ownerDocument: e.currentTarget.ownerDocument,
            anchor: e.currentTarget,
          });
        }}
        onPointerEnter={
          isPinned ? (): void => showPinnedHover(tab.id) : undefined
        }
        onPointerLeave={
          isPinned ? (): void => schedulePinnedHoverClose() : undefined
        }
        onSelect={(): void => switchTab(tab.id)}
        onClose={(): void => closeTab(tab.id)}
        outerRef={(node): void => {
          if (isActive) {
            activeTabRef.current = node;
          }
          if (node) {
            pinnedHoverRefs.current.set(tab.id, node);
          } else {
            pinnedHoverRefs.current.delete(tab.id);
          }
        }}
      />
    );
  };

  return (
    <div
      data-testid={dataTestId}
      className={`${dragRegion ? 'electron-drag' : 'electron-no-drag'} flex items-center border-b bg-fg-primary/[0.02]`}
    >
      {pinnedTabs.length > 0 && (
        <div
          ref={pinnedListRef}
          className="electron-no-drag flex max-w-2/5 shrink-0 overflow-x-auto border-r"
          onDragOver={handlePinnedListDragOver}
          onDrop={handleDrop}
        >
          {pinnedTabs.map((tab) => {
            const tabIndex = tabIndexById.get(tab.id) ?? -1;
            return renderTab(tab, tabIndex);
          })}
        </div>
      )}
      <div
        ref={tabListRef}
        className="electron-no-drag flex min-w-0 flex-1 overflow-x-auto"
        onDragOver={handleUnpinnedListDragOver}
        onDrop={handleDrop}
      >
        {unpinnedTabs.map((tab) => {
          const tabIndex = tabIndexById.get(tab.id) ?? -1;
          return renderTab(tab, tabIndex);
        })}
      </div>
      <ArchivedChatsControl scope={scope} />
      <button
        type="button"
        data-testid="chat-tab-new"
        onClick={() => createTab()}
        className="electron-no-drag shrink-0 px-2.5 py-2 fg-secondary transition hover:fg-primary"
        aria-label={`New ${CHAT_UNIT_LABEL} tab`}
      >
        <AppCatalogPlusIcon width="13" height="13" />
      </button>
      {effectiveScope &&
        canTransferChatSession(effectiveScope.projectId) &&
        ((): JSX.Element | null => {
          const activeTab = tabs.find((t) => t.id === activeTabId);
          if (!activeTab || activeTab.kind === 'file') return null;
          const isChatTabBusy =
            activeTab.status === 'streaming' ||
            !!activeTab.pendingPlanExit ||
            (activeTab.queuedMessages.length > 0 &&
              getOnlyQueuedHookPlaceholderQueueId(activeTab) === null);
          return (
            <div className="relative shrink-0">
              <button
                ref={sessionMenuButtonRef}
                type="button"
                data-testid="chat-tab-session-menu"
                onClick={() => setSessionMenuOpen((open) => !open)}
                aria-label="Session actions"
                aria-haspopup="menu"
                aria-expanded={sessionMenuOpen}
                className="electron-no-drag relative px-1.5 py-2 fg-secondary transition hover:fg-primary"
              >
                <AppCatalogMoreVerticalIcon
                  width="13"
                  height="13"
                  aria-hidden="true"
                />
                {/* Unread shared-run comments (CAN-397): the menu hosts the
                    Comments entry, so the dot advertises it without opening. */}
                {(activeTab.sharedRun?.unreadCommentCount ?? 0) > 0 && (
                  <span
                    aria-hidden="true"
                    data-testid="chat-tab-session-menu-unread"
                    className="pointer-events-none absolute top-1 right-0.5 h-1.5 w-1.5 rounded-full bg-accent"
                  />
                )}
              </button>
              <AnchoredMenu
                open={sessionMenuOpen}
                onClose={() => setSessionMenuOpen(false)}
                anchorRef={sessionMenuButtonRef}
                placement="below-start"
                portal
                testId="chat-tab-session-menu-popover"
                className="w-44"
              >
                <ShareSessionControl
                  variant="menu-item"
                  projectId={effectiveScope.projectId}
                  worktreeId={effectiveScope.worktreeId}
                  chatId={activeTab.id}
                  title={activeTab.title}
                  hasMessages={activeTab.hasMessages}
                  busy={isChatTabBusy}
                  sharedRun={activeTab.sharedRun}
                  testId="chat-tab-session-menu-share"
                  onAfterSelect={() => setSessionMenuOpen(false)}
                  onOpenShare={(
                    chatId,
                    title,
                    ownerDocument,
                    existingShare,
                  ): void => {
                    share.open(chatId, title, ownerDocument, existingShare);
                  }}
                />
              </AnchoredMenu>
            </div>
          );
        })()}
      {contextMenu &&
        ((): JSX.Element | null => {
          const tab = tabs.find((t) => t.id === contextMenu.tabId);
          if (!tab) return null;
          const tabIndex = tabIndexById.get(tab.id) ?? -1;
          const isFileTab = tab.kind === 'file';
          // The same busy predicate `closeTab` enforces (active turn or live
          // delegates).
          const isChatTabBusy =
            effectiveScope !== null &&
            getChatTabCloseBlocker(
              tab,
              effectiveScope.projectId,
              effectiveScope.worktreeId,
              delegationState,
            ) !== null;
          // Chrome-like semantics: bulk "Close *" actions never touch pinned
          // tabs. Individual "Close" on the clicked tab itself still works
          // regardless of its pinned state.
          const idsToTheLeft = tabs
            .slice(0, tabIndex)
            .filter((t) => t.pinned !== true)
            .map((t) => t.id);
          const idsToTheRight = tabs
            .slice(tabIndex + 1)
            .filter((t) => t.pinned !== true)
            .map((t) => t.id);
          const idsExcept = tabs
            .filter((t) => t.id !== tab.id && t.pinned !== true)
            .map((t) => t.id);
          const idsAll = tabs.filter((t) => t.pinned !== true).map((t) => t.id);
          const isPinned = tab.pinned === true;
          // Close rows sit in the last group, in the same ink as the
          // sidebar menus' Archive and Delete.
          const closeTone: TabContextMenuItem['tone'] = 'default';
          const items: TabContextMenuItem[] = [
            {
              key: 'pin',
              label: isPinned ? 'Unpin tab' : 'Pin tab',
              icon: <PinIcon />,
              onSelect: () => setTabPinned(tab.id, !isPinned),
            },
          ];
          if (!isFileTab && !readOnlyWorkspace && effectiveScope) {
            items.push({
              key: 'rename',
              label: 'Rename…',
              icon: <PencilIcon />,
              testId: 'chat-tab-context-rename',
              onSelect: (): void =>
                chatTabRename.open({
                  projectId: effectiveScope.projectId,
                  worktreeId: effectiveScope.worktreeId,
                  tabId: tab.id,
                  ownerDocument: contextMenu.ownerDocument,
                  returnFocusElement: contextMenu.anchor,
                }),
            });
          }
          if (isFileTab) {
            const filePath = tab.filePath;
            items.push({
              key: 'copy-path',
              label: 'Copy path',
              icon: <CopyIcon />,
              separatorBefore: true,
              disabled: !filePath,
              onSelect: () => {
                if (!filePath) return;
                void copyTextToClipboard(filePath);
              },
            });
            items.push({
              key: 'copy-relative-path',
              label: 'Copy relative path',
              icon: <CopyIcon />,
              disabled: !filePath || !selectedWorktree,
              onSelect: () => {
                if (!filePath || !selectedWorktree) return;
                const sel = selectedWorktree;
                void (async (): Promise<void> => {
                  let worktreePath: string | undefined;
                  try {
                    worktreePath = await window.api.getWorktreePath({
                      projectId: sel.projectId,
                      worktreeId: sel.worktreeId,
                    });
                  } catch {
                    worktreePath = undefined;
                  }
                  const relative = formatFileReferencePath(
                    filePath,
                    worktreePath,
                  );
                  await copyTextToClipboard(relative);
                })();
              },
            });
          } else if (
            effectiveScope &&
            canTransferChatSession(effectiveScope.projectId)
          ) {
            // Chat tab: keep redacted sharing and importable snapshot export as
            // distinct actions.
            const hasMessages = tab.hasMessages;
            const shareVisible = share.entryVisible(tab.sharedRun);
            if (shareVisible) {
              items.push({
                key: 'share-session',
                label: 'Share session',
                icon: <ShareIcon />,
                separatorBefore: true,
                disabled: isChatTabBusy || !hasMessages,
                onSelect: (): void => {
                  share.open(
                    tab.id,
                    tab.title,
                    contextMenu.ownerDocument,
                    tab.sharedRun,
                  );
                },
              });
            }
            items.push({
              key: 'export-session',
              label: 'Export session',
              icon: <DownloadIcon />,
              separatorBefore: !shareVisible,
              testId: 'chat-session-export-menu-item',
              disabled: isChatTabBusy || !hasMessages,
              onSelect: (): void => {
                exportSession.open(tab.id, contextMenu.ownerDocument);
              },
            });
          }
          items.push(
            {
              key: 'close',
              label: 'Close',
              icon: <CloseIcon />,
              tone: closeTone,
              separatorBefore: true,
              disabled: isChatTabBusy,
              onSelect: () => closeTab(tab.id),
            },
            {
              key: 'close-others',
              label: 'Close others',
              icon: <CloseIcon />,
              tone: closeTone,
              disabled: idsExcept.length === 0,
              onSelect: () => closeTabs(idsExcept),
            },
            {
              key: 'close-right',
              label: 'Close to the right',
              icon: <CloseIcon />,
              tone: closeTone,
              disabled: idsToTheRight.length === 0,
              onSelect: () => closeTabs(idsToTheRight),
            },
            {
              key: 'close-left',
              label: 'Close to the left',
              icon: <CloseIcon />,
              tone: closeTone,
              disabled: idsToTheLeft.length === 0,
              onSelect: () => closeTabs(idsToTheLeft),
            },
            {
              key: 'close-all',
              label: 'Close all',
              icon: <CloseIcon />,
              tone: closeTone,
              onSelect: () => closeTabs(idsAll),
            },
          );
          return (
            <TabContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={items}
              onClose={closeContextMenu}
              ownerDocument={contextMenu.ownerDocument}
            />
          );
        })()}
      {share.target && (
        <ShareRunModal
          chatId={share.target.chatId}
          runTitle={share.target.title}
          ownerDocument={share.target.ownerDocument}
          existingShare={share.target.existingShare}
          onClose={share.close}
          onShare={share.submit}
          checkEligibility={share.checkEligibility}
          onShared={share.onShared}
        />
      )}
      {exportSession.target && (
        <ExportSessionConfirmationModal
          ownerDocument={exportSession.target.ownerDocument}
          onCancel={exportSession.close}
          onConfirm={exportSession.confirm}
        />
      )}
      {chatTabRename.dialog}
      {pinnedHover &&
        ((): JSX.Element | null => {
          const tab = tabs.find((t) => t.id === pinnedHover.tabId);
          if (!tab || tab.pinned !== true) return null;
          const isFileTab = tab.kind === 'file';
          const awaitingApproval =
            !isFileTab &&
            (!!tab.pendingPlanExit ||
              Object.values(pendingPlanExits).some(
                (pe) => pe.chatId === tab.id,
              ));
          const awaitingToolApproval =
            !isFileTab &&
            Object.values(pendingApprovals).some(
              (approval) => approval.chatId === tab.id,
            );
          const provider = isFileTab
            ? undefined
            : resolveChatTabProvider(tab, defaultWorktreeModel);
          const isWorking =
            !isFileTab &&
            (tab.status === 'streaming' ||
              (effectiveScope !== null &&
                selectChatHasLiveDelegates(
                  delegationState,
                  effectiveScope.projectId,
                  effectiveScope.worktreeId,
                  tab.id,
                )));
          const popoverLeading: ReactNode = isFileTab ? (
            <FileTypeIcon
              filename={tab.title}
              size={20}
              boxSize={16}
              className="shrink-0"
            />
          ) : isWorking && !awaitingApproval && !awaitingToolApproval ? (
            <ThinkingSpinner tone="accent" className="shrink-0" />
          ) : awaitingApproval ? (
            <PlanModeIcon
              width={14}
              height={14}
              className={`shrink-0 ${OPERATIONAL_STATUS_COLORS.unread.foreground}`}
            />
          ) : provider !== undefined ? (
            <AgentProviderIcon
              provider={provider}
              width={14}
              height={14}
              className="shrink-0 fg-secondary"
            />
          ) : (
            <ChatIcon
              width={14}
              height={14}
              className="shrink-0 fg-secondary"
            />
          );
          const popoverLabel = isFileTab
            ? tab.filePath
              ? formatFileReferencePath(tab.filePath, worktreeRootPath)
              : tab.title
            : chatTabStripLabel(tab);
          return (
            <PinnedTabPopover
              anchor={pinnedHover.anchor}
              onPointerEnter={(): void => {
                clearPinnedHoverCloseTimer();
              }}
              onPointerLeave={schedulePinnedHoverClose}
            >
              {popoverLeading}
              <span
                className={
                  isFileTab
                    ? 'truncate'
                    : `${POSTHOG_REPLAY_MASK_CLASS} truncate`
                }
              >
                {popoverLabel}
              </span>
            </PinnedTabPopover>
          );
        })()}
    </div>
  );
});

interface PinnedTabPopoverProps {
  anchor: DOMRect;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: ReactNode;
}

const PINNED_POPOVER_GAP = 6;
const PINNED_POPOVER_PADDING = 8;
const PINNED_POPOVER_MIN_WIDTH = 160;
const PINNED_POPOVER_MAX_WIDTH = 320;

function PinnedTabPopover({
  anchor,
  onPointerEnter,
  onPointerLeave,
  children,
}: PinnedTabPopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: anchor.bottom + PINNED_POPOVER_GAP,
    left: anchor.left,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const desiredLeft = anchor.left + anchor.width / 2 - rect.width / 2;
    const clampedLeft = Math.max(
      PINNED_POPOVER_PADDING,
      Math.min(
        desiredLeft,
        window.innerWidth - rect.width - PINNED_POPOVER_PADDING,
      ),
    );
    const fitsBelow =
      anchor.bottom + PINNED_POPOVER_GAP + rect.height <=
      window.innerHeight - PINNED_POPOVER_PADDING;
    const top = fitsBelow
      ? anchor.bottom + PINNED_POPOVER_GAP
      : Math.max(
          PINNED_POPOVER_PADDING,
          anchor.top - PINNED_POPOVER_GAP - rect.height,
        );
    setPosition({ top, left: clampedLeft });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        minWidth: PINNED_POPOVER_MIN_WIDTH,
        maxWidth: PINNED_POPOVER_MAX_WIDTH,
      }}
      className="z-tooltip flex items-center gap-1.5 rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-tooltip fg-primary"
    >
      {children}
    </div>,
    document.body,
  );
}

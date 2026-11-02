import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type JSX,
} from 'react';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';
import { useAutomationScope } from '@/hooks/useAutomationScope';
import type {
  ChatSearchCatalogEntry,
  ChatSearchResult,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  Kbd,
  KeyHintFooter,
  SearchEmptyState,
  SearchField,
  useOverlayEscape,
} from '@canopy/ui-shared/components';
import { pickerKeyHints, shortcutKeys } from '@canopy/ui-shared/lib/shortcuts';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useShallow } from 'zustand/shallow';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useActivityStore } from '@/stores/activityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import {
  makeWorktreePanelKey,
  usePanelLayoutViewModel,
} from '@/stores/panelLayoutStore';
import { usePipelineList } from '@/hooks/usePipelineList';
import { useMarketplaceList } from '@/hooks/useMarketplaceList';
import { useSkillList } from '@/hooks/useSkillList';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { getVisibleNavItems } from '@/components/settings/SettingsNav';
import { useHostedSettingsAvailable } from '@/components/settings/hosted/hosted-settings-availability';
import { useIsPageAvailable } from '@/lib/navigation/page-availability';
import { visibleAccountNavItems } from '@canopy/ui-app/settings/navigation';
import {
  buildBaseCommands,
  buildContextSwitchCommands,
  buildOrganizationPageCommands,
  buildPanelCommands,
  buildProjectCommands,
  comparePaletteCommands,
} from './paletteCommands';
import {
  buildAccountOrganizationPageItems,
  buildAgentItems,
  buildArchivedContainerItems,
  buildAutomationItems,
  buildChatContentItems,
  buildChatItems,
  buildCommandItems,
  buildPipelineItems,
  buildPlanItems,
  buildPluginItems,
  buildSettingItems,
  buildSkillItems,
  buildWatcherItems,
  buildWorktreeItems,
  buildWorktreeLabelIndex,
  type AccountOrganizationPageEntry,
  type SettingsSectionEntry,
  type WorktreeLabelResolver,
} from './paletteProviders';
import {
  parseQuery,
  rankPaletteItems,
  withChatContentSection,
  type PaletteFlatEntry,
} from './paletteRanking';
import type { PaletteItem } from './paletteItems';
import { PaletteResultRow } from './PaletteResultRow';
import { usePaletteAccountFacts } from './usePaletteAccountFacts';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';

interface CommandPaletteProps {
  initialQuery: string;
  onClose: () => void;
}

/** Debounce before firing the deferred tier-2 transcript query (ms). */
const TIER2_DEBOUNCE_MS = 200;
/** Minimum query length before hitting the transcript FTS index. */
const TIER2_MIN_QUERY_LENGTH = 2;

export function CommandPalette({
  initialQuery,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  const { commandsOnly } = parseQuery(query);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(),
  );
  const [catalogEntries, setCatalogEntries] = useState<
    ChatSearchCatalogEntry[]
  >([]);
  const [contentResults, setContentResults] = useState<ChatSearchResult[]>([]);
  // Bumped for every debounced `chatSearch.onUpdated` broadcast so the
  // query-independent tier-1 catalog cannot miss an update while the user is
  // typing.
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);
  // Bumped only when the query remains stable across the update debounce,
  // preserving settled tier-2 rows without reissuing stale query work.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const selectedItemIdRef = useRef<string | null>(null);
  const pendingExpandedSelectionRef = useRef<{
    sectionId: string;
    visibleItemCount: number;
  } | null>(null);
  // True once the user explicitly moved the selection (arrows/hover) for the
  // current query. Until then the default selection tracks the best-scoring
  // item, so late-arriving low-score sections (e.g. marketplace plugins
  // rendered above the pinned-last commands) cannot steal Enter.
  const userNavigatedRef = useRef(false);
  const queryTokenRef = useRef(0);
  const queryRef = useRef(query);
  const queryRevisionRef = useRef(0);
  useOverlayEscape(true, onClose);
  if (queryRef.current !== query) {
    queryRef.current = query;
    queryRevisionRef.current += 1;
  }

  // --- Tier-0 sources (renderer stores/hooks) ----------------------------
  const {
    workspaces: projects,
    linkedPersonalWorkspaceIds,
    isInContext,
  } = useContextScopedWorkspaces();
  const linkedPersonalWorkspaceKey = linkedPersonalWorkspaceIds.join('\n');
  const repoBranches = useProjectsStore((state) => state.repoBranches);
  const allWorktreeChats = useChatStore((state) => state.worktreeChats);
  const worktreeChats = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(allWorktreeChats).filter(([key]) =>
          isInContext(key.slice(0, key.indexOf('/'))),
        ),
      ),
    [allWorktreeChats, isInContext],
  );
  const scopedCatalogEntries = useMemo(
    () => catalogEntries.filter((entry) => isInContext(entry.projectId)),
    [catalogEntries, isInContext],
  );
  const scopedContentResults = useMemo(
    () => contentResults.filter((entry) => isInContext(entry.projectId)),
    [contentResults, isInContext],
  );
  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const allActivities = useAutomationsStore((state) => state.activities);
  const allWatchers = useAppAdvisorWatchersStore((state) => state.watchers);
  // Automations and watchers follow the selected context, like the
  // Automations page (CAN-3448).
  const automationScope = useAutomationScope();
  const activities = useMemo(
    () => allActivities.filter(automationScope.inContext),
    [allActivities, automationScope],
  );
  const watchers = useMemo(
    () => allWatchers.filter(automationScope.watcherInContext),
    [allWatchers, automationScope],
  );
  const agents = useAgentsStore((state) => state.agents);
  const worktreeSummaries = useActivityStore(
    (state) => state.worktreeSummaries,
  );
  const getBranchDisplayName = useBranchDisplayStore(
    (state) => state.getDisplayName,
  );
  const branchMappingsVersion = useBranchDisplayStore(
    (state) => state.mappingsVersion,
  );
  // Agent items open in the Marketplace Agents tab (CAN-4266), so they
  // follow the Agents flag and the Marketplace's availability.
  const sharedCustomAgentsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key),
  );
  const agentsAvailable =
    useIsPageAvailable('plugins') && sharedCustomAgentsEnabled;
  const overviewPageAvailable = useIsPageAvailable('overview');
  const auditPageAvailable = useIsPageAvailable('audit');
  const statisticsPageAvailable = useIsPageAvailable('statistics');
  const orgProjectsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const workspaceContext = useWorkspaceContextStore(
    useShallow((store) => ({
      context: store.state.context,
      organizations: store.state.organizations,
      setContext: store.setContext,
      hydrated: store.hydrated,
    })),
  );
  const workspaceContextKey =
    workspaceContext.context.kind === 'personal'
      ? 'personal'
      : `org:${workspaceContext.context.organizationId}`;
  const codeGraphEnabled = useCodeGraphExperimentEnabled();
  const { pipelines } = usePipelineList();
  const { cache: marketplaceCache } = useMarketplaceList();
  const { skills } = useSkillList();

  const panelWorktreeKey =
    selectedWorktree && !isCoworkChatTarget(selectedWorktree.projectId)
      ? makeWorktreePanelKey(
          selectedWorktree.projectId,
          selectedWorktree.worktreeId,
        )
      : null;
  const panelViewModel = usePanelLayoutViewModel(panelWorktreeKey);

  // Lazily hydrate the stores that don't self-fetch on mount so the palette is
  // populated even if the user never visited those pages this session.
  useEffect(() => {
    void useAutomationsStore.getState().hydrate();
    void useAppAdvisorWatchersStore.getState().hydrate();
    if (agentsAvailable) {
      void useAgentsStore.getState().load();
    }
  }, [agentsAvailable]);

  // Tier 1: fetch the chat catalog on open and again whenever the backend
  // signals an index change (`refreshNonce`).
  useEffect(() => {
    let cancelled = false;
    const request =
      linkedPersonalWorkspaceIds.length > 0
        ? window.api.chatSearch.catalog({
            linkedPersonalWorkspaceIds: [...linkedPersonalWorkspaceIds],
          })
        : window.api.chatSearch.catalog();
    void request
      .then((response) => {
        if (!cancelled) {
          setCatalogEntries(response.entries);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogEntries([]);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    catalogRefreshNonce,
    workspaceContextKey,
    linkedPersonalWorkspaceKey,
    linkedPersonalWorkspaceIds,
  ]);

  // Live refresh: subscribe to the payload-less `chatSearch.onUpdated`
  // broadcast on mount. Every debounced receipt refreshes the tier-1 catalog;
  // only an unchanged query also refreshes the settled tier-2 results. This
  // fills a palette opened mid initial-scan and reflects chats created/edited
  // while it stays open. Unsubscribes on close.
  useEffect(() => {
    if (typeof window.api.chatSearch.onUpdated !== 'function') {
      return undefined;
    }
    let handle: number | undefined;
    const unsubscribe = window.api.chatSearch.onUpdated(() => {
      const stableQuery = queryRef.current;
      const stableQueryRevision = queryRevisionRef.current;
      if (handle !== undefined) {
        window.clearTimeout(handle);
      }
      handle = window.setTimeout(() => {
        setCatalogRefreshNonce((nonce) => nonce + 1);
        if (
          queryRef.current === stableQuery &&
          queryRevisionRef.current === stableQueryRevision
        ) {
          setRefreshNonce((nonce) => nonce + 1);
        }
      }, TIER2_DEBOUNCE_MS);
    });
    return (): void => {
      if (handle !== undefined) {
        window.clearTimeout(handle);
      }
      unsubscribe();
    };
  }, []);

  const hostedLayout = useHostedSettingsAvailable();
  const accountFacts = usePaletteAccountFacts(hostedLayout);
  const billingEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key),
  );
  const digestsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.key),
  );

  // Page availability is subscribed above, so the command list rebuilds when
  // a page is switched on or off while the palette is open.
  const commands = useMemo(() => {
    const baseCommands = buildBaseCommands(selectedWorktree);
    const projectCommands = buildProjectCommands(projects);
    const panelCommands = buildPanelCommands(selectedWorktree, panelViewModel);
    const contextCommands = buildContextSwitchCommands(
      orgProjectsEnabled,
      workspaceContext,
      workspaceContext.setContext,
    );
    // The selected context's organization pages, once the context is known.
    const organizationPageCommands = buildOrganizationPageCommands(
      hostedLayout && workspaceContext.hydrated,
      workspaceContext,
      accountFacts.personalOrganizationId,
    );
    return [
      ...baseCommands,
      ...projectCommands,
      ...panelCommands,
      ...contextCommands,
      ...organizationPageCommands,
    ].sort(comparePaletteCommands);
    // The Labs page commands read the policy inside `buildBaseCommands`;
    // these are their invalidation keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    overviewPageAvailable,
    auditPageAvailable,
    statisticsPageAvailable,
    projects,
    selectedWorktree,
    panelViewModel,
    orgProjectsEnabled,
    workspaceContext,
    hostedLayout,
    accountFacts.personalOrganizationId,
  ]);

  const accountProxyAvailable = useAccountProxyStatus()?.available === true;
  const settingSections = useMemo(() => {
    const sections: SettingsSectionEntry[] = getVisibleNavItems(
      window.platform,
      true,
      codeGraphEnabled,
      accountProxyAvailable,
      false,
      { hostedLayout },
    ).map((item) => ({
      key: item.key,
      label: item.label,
    }));
    // The hosted rail has no Notifications row, but the entry stays: the
    // overlay redirects `openSettings('notifications')` to the hosted page.
    if (hostedLayout) {
      sections.push({ key: 'notifications', label: 'Notifications' });
    }
    return sections;
  }, [codeGraphEnabled, accountProxyAvailable, hostedLayout]);

  // The hosted account pages, with the rail's flag gating (Integrations is
  // always listed on desktop), and the Organizations list. A page whose name
  // a local section above already carries (Notifications) stays one entry.
  const accountPageEntries = useMemo((): AccountOrganizationPageEntry[] => {
    if (!hostedLayout) return [];
    const sectionLabels = new Set(
      settingSections.map((section) => section.label.toLowerCase()),
    );
    const accountPages: AccountOrganizationPageEntry[] = visibleAccountNavItems(
      {
        billingEnabled,
        digestsEnabled,
        integrationsEnabled: true,
        freeAccess: accountFacts.freeAccess,
      },
    ).flatMap((item) =>
      // External agents is a hosted web page, not a settings route.
      item.key === 'externalAgents'
        ? []
        : [{ route: { scope: 'account', page: item.key }, label: item.label }],
    );
    const organizationsPage: AccountOrganizationPageEntry = {
      route: { scope: 'organizations' },
      label: 'Organizations',
    };
    return [...accountPages, organizationsPage].filter(
      (entry) => !sectionLabels.has(entry.label.toLowerCase()),
    );
  }, [
    hostedLayout,
    settingSections,
    billingEnabled,
    digestsEnabled,
    accountFacts.freeAccess,
  ]);

  const resolveWorktreeLabel = useCallback<WorktreeLabelResolver>(
    (worktree, project): string => {
      if (worktree.label?.trim()) {
        return worktree.label.trim();
      }
      const worktreeRepoBranches = repoBranches[`${project.id}/${worktree.id}`];
      const uniqueBranches =
        worktreeRepoBranches && worktreeRepoBranches.length > 0
          ? new Set(worktreeRepoBranches.map((repoBranch) => repoBranch.branch))
          : null;
      const hasMultipleBranches =
        uniqueBranches !== null && uniqueBranches.size > 1;
      const rawBranch =
        project.type === 'multi-repo' &&
        uniqueBranches !== null &&
        worktreeRepoBranches
          ? hasMultipleBranches
            ? 'Multiple branches'
            : worktreeRepoBranches[0].branch
          : worktree.branchName;
      return getWorktreeBranchDisplayName({
        rawBranch,
        worktreeId: worktree.id,
        hasMultipleBranches,
        getBranchDisplayName,
      });
    },
    // getBranchDisplayName is stable, while the version invalidates its cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getBranchDisplayName, branchMappingsVersion, repoBranches],
  );

  const labelIndex = useMemo(
    () =>
      buildWorktreeLabelIndex(
        projects,
        scopedCatalogEntries,
        resolveWorktreeLabel,
      ),
    [projects, scopedCatalogEntries, resolveWorktreeLabel],
  );

  const plugins = useMemo(
    () => marketplaceCache?.marketplaces.flatMap((m) => m.plugins) ?? [],
    [marketplaceCache],
  );

  const items = useMemo<PaletteItem[]>(
    () => [
      ...buildChatItems(worktreeChats, scopedCatalogEntries, labelIndex),
      ...buildWorktreeItems(projects, worktreeSummaries, resolveWorktreeLabel),
      ...buildArchivedContainerItems(scopedCatalogEntries, labelIndex),
      ...buildPlanItems(scopedCatalogEntries, labelIndex),
      ...buildPipelineItems(pipelines),
      ...buildAutomationItems(activities),
      ...buildWatcherItems(watchers),
      ...(agentsAvailable ? buildAgentItems(agents) : []),
      ...buildPluginItems(plugins),
      ...buildSkillItems(skills),
      ...buildSettingItems(settingSections),
      ...buildAccountOrganizationPageItems(accountPageEntries),
      ...buildCommandItems(commands),
    ],
    [
      worktreeChats,
      scopedCatalogEntries,
      labelIndex,
      projects,
      worktreeSummaries,
      resolveWorktreeLabel,
      pipelines,
      activities,
      watchers,
      agentsAvailable,
      agents,
      plugins,
      skills,
      settingSections,
      accountPageEntries,
      commands,
    ],
  );

  const baseRanking = useMemo(
    () => rankPaletteItems(items, query, undefined, expandedSections),
    [items, query, expandedSections],
  );

  // Ids of visible chat/plan title rows — tier-2 content hits for the same
  // doc are dropped rather than shown twice.
  const titleRowIds = useMemo(
    () =>
      new Set(
        baseRanking.sections
          .flatMap((section) => section.items)
          .filter(
            ({ item }) =>
              item.kind === 'chat' ||
              item.kind === 'plan' ||
              item.kind === 'archive',
          )
          .map(({ item }) => item.id),
      ),
    [baseRanking],
  );

  const contentItems = useMemo(
    () => buildChatContentItems(scopedContentResults, labelIndex, titleRowIds),
    [scopedContentResults, labelIndex, titleRowIds],
  );

  const ranking = useMemo(
    () => withChatContentSection(baseRanking, contentItems),
    [baseRanking, contentItems],
  );

  const flatItems = ranking.flat;

  // Starting flat index of each section, so rows can map to a stable keyboard
  // selection index without mutating a counter during render.
  const sectionOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const section of ranking.sections) {
      offsets.push(acc);
      acc += section.items.length + (section.truncated > 0 ? 1 : 0);
    }
    return offsets;
  }, [ranking]);

  // Tier 2 query changes clear stale rows immediately, then debounce the new
  // request. Index refreshes use a separate effect below so settled rows stay
  // mounted while the unchanged query is refreshed.
  useEffect(() => {
    const { commandsOnly, query: parsed } = parseQuery(query);
    if (commandsOnly || parsed.length < TIER2_MIN_QUERY_LENGTH) {
      queryTokenRef.current += 1; // invalidate any in-flight response
      setContentResults([]);
      return;
    }
    const token = (queryTokenRef.current += 1);
    setContentResults([]);
    const handle = window.setTimeout(() => {
      void window.api.chatSearch
        .query({
          query: parsed,
          ...(linkedPersonalWorkspaceIds.length > 0
            ? {
                linkedPersonalWorkspaceIds: [...linkedPersonalWorkspaceIds],
              }
            : {}),
        })
        .then((response) => {
          if (token === queryTokenRef.current) {
            setContentResults(response.results);
          }
        })
        .catch(() => {
          if (token === queryTokenRef.current) {
            setContentResults([]);
          }
        });
    }, TIER2_DEBOUNCE_MS);
    return (): void => {
      window.clearTimeout(handle);
    };
  }, [
    query,
    workspaceContextKey,
    linkedPersonalWorkspaceKey,
    linkedPersonalWorkspaceIds,
  ]);

  useEffect(() => {
    if (refreshNonce === 0) return;
    const { commandsOnly, query: parsed } = parseQuery(queryRef.current);
    if (commandsOnly || parsed.length < TIER2_MIN_QUERY_LENGTH) return;
    const stableQuery = queryRef.current;
    const token = (queryTokenRef.current += 1);
    void window.api.chatSearch
      .query({
        query: parsed,
        ...(linkedPersonalWorkspaceIds.length > 0
          ? { linkedPersonalWorkspaceIds: [...linkedPersonalWorkspaceIds] }
          : {}),
      })
      .then((response) => {
        if (
          token === queryTokenRef.current &&
          queryRef.current === stableQuery
        ) {
          startTransition(() => setContentResults(response.results));
        }
      })
      .catch(() => {
        // A refresh failure keeps the last settled results visible. A later
        // update broadcast or user query retries from that stable state.
      });
  }, [
    refreshNonce,
    workspaceContextKey,
    linkedPersonalWorkspaceKey,
    linkedPersonalWorkspaceIds,
  ]);

  useEffect(() => {
    setQuery(initialQuery);
    setExpandedSections(new Set());
    setErrorMessage(null);
    selectedItemIdRef.current = null;
    setSelectedIndex(0);
  }, [initialQuery]);

  // Also covers palette open: the [initialQuery] effect above sets `query`,
  // which re-runs this effect on the next render.
  useEffect(() => {
    userNavigatedRef.current = false;
    setExpandedSections(new Set());
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const pending = pendingExpandedSelectionRef.current;
    if (pending) {
      const sectionIndex = ranking.sections.findIndex(
        (section) => section.id === pending.sectionId,
      );
      const item =
        ranking.sections[sectionIndex]?.items[pending.visibleItemCount];
      const expandedIndex = item
        ? flatItems.findIndex((entry) => entry.id === item.item.id)
        : -1;
      pendingExpandedSelectionRef.current = null;
      if (expandedIndex >= 0) {
        userNavigatedRef.current = true;
        selectedItemIdRef.current = item?.item.id ?? null;
        setSelectedIndex(expandedIndex);
        inputRef.current?.focus();
        return;
      }
    }
    if (flatItems.length === 0) {
      setSelectedIndex(-1);
      return;
    }
    setSelectedIndex((currentIndex) => {
      if (!userNavigatedRef.current) {
        let bestIndex = 0;
        for (let index = 1; index < flatItems.length; index += 1) {
          const entry = flatItems[index];
          const bestEntry = flatItems[bestIndex];
          if (
            entry?.type === 'item' &&
            (bestEntry?.type !== 'item' ||
              entry.ranked.score > bestEntry.ranked.score)
          ) {
            bestIndex = index;
          }
        }
        selectedItemIdRef.current = flatItems[bestIndex]?.id ?? null;
        return bestIndex;
      }
      const selectedId = selectedItemIdRef.current;
      if (selectedId !== null) {
        const refreshedIndex = flatItems.findIndex(
          (entry) => entry.id === selectedId,
        );
        if (refreshedIndex >= 0) {
          return refreshedIndex;
        }
      }
      if (currentIndex < 0) {
        selectedItemIdRef.current = flatItems[0]?.id ?? null;
        return 0;
      }
      if (currentIndex >= flatItems.length) {
        const clampedIndex = flatItems.length - 1;
        selectedItemIdRef.current = flatItems[clampedIndex]?.id ?? null;
        return clampedIndex;
      }
      selectedItemIdRef.current = flatItems[currentIndex]?.id ?? null;
      return currentIndex;
    });
  }, [flatItems, ranking.sections]);

  const selectedEntryId =
    selectedIndex >= 0 ? flatItems[selectedIndex]?.id : undefined;

  useEffect(() => {
    if (selectedIndex < 0) {
      return;
    }
    itemRefs.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, selectedEntryId]);

  const registerRef = useCallback(
    (index: number, node: HTMLLIElement | null): void => {
      if (node) {
        itemRefs.current.set(index, node);
      } else {
        itemRefs.current.delete(index);
      }
    },
    [],
  );

  const activateItem = useCallback(
    async (item: PaletteItem | undefined): Promise<void> => {
      if (!item) {
        return;
      }
      setErrorMessage(null);
      try {
        const result = await item.execute();
        if (result.error) {
          setErrorMessage(result.error);
        }
        if (result.closePalette) {
          onClose();
        }
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Command failed',
        );
      }
    },
    [onClose],
  );

  const activateEntry = useCallback(
    (entry: PaletteFlatEntry | undefined): void => {
      if (!entry) {
        return;
      }
      if (entry.type === 'show-more') {
        const { sectionId, visibleItemCount } = entry;
        pendingExpandedSelectionRef.current = {
          sectionId,
          visibleItemCount,
        };
        setExpandedSections((current) => {
          const next = new Set(current);
          next.add(sectionId);
          return next;
        });
        inputRef.current?.focus();
        return;
      }
      void activateItem(entry.ranked.item);
    },
    [activateItem],
  );

  const handleActivate = useCallback(
    (item: PaletteItem): void => {
      void activateItem(item);
    },
    [activateItem],
  );

  const handleHover = useCallback(
    (index: number): void => {
      userNavigatedRef.current = true;
      selectedItemIdRef.current = flatItems[index]?.id ?? null;
      setSelectedIndex(index);
    },
    [flatItems],
  );

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (flatItems.length === 0) {
        return;
      }
      userNavigatedRef.current = true;
      setSelectedIndex((currentIndex) => {
        const nextIndex =
          currentIndex < 0 ? 0 : (currentIndex + 1) % flatItems.length;
        selectedItemIdRef.current = flatItems[nextIndex]?.id ?? null;
        return nextIndex;
      });
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (flatItems.length === 0) {
        return;
      }
      userNavigatedRef.current = true;
      setSelectedIndex((currentIndex) => {
        const nextIndex =
          currentIndex <= 0 ? flatItems.length - 1 : currentIndex - 1;
        selectedItemIdRef.current = flatItems[nextIndex]?.id ?? null;
        return nextIndex;
      });
      return;
    }

    if (event.key === 'Enter') {
      // Enter on a focused control outside the results (Clear, the empty
      // state's action) presses that control. Anywhere else, including a
      // focused result row, Enter opens the highlighted result.
      if (
        event.target instanceof HTMLButtonElement &&
        !event.target.closest('[role="listbox"]')
      ) {
        return;
      }
      event.preventDefault();
      activateEntry(selectedIndex >= 0 ? flatItems[selectedIndex] : undefined);
    }
  }

  return (
    <div
      className="fixed inset-0 z-dropdown flex items-center justify-center bg-overlay-scrim px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        data-testid="command-palette"
        className="flex w-full max-w-160 flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="border-b">
          <SearchField
            ref={inputRef}
            size="lg"
            value={query}
            onValueChange={(next): void => {
              setQuery(next);
              setErrorMessage(null);
              selectedItemIdRef.current = null;
              setSelectedIndex(0);
            }}
            // Escape closes the palette at once (the dialog's handler); the
            // nested button clears the query.
            clearOnEscape={false}
            aria-label="Search"
            placeholder="Search chats, workspaces, plugins, settings, and more"
            data-testid="command-palette-input"
            clearTestId="command-palette-clear"
            // The scope hint names its key as a cap, in the same quiet ink
            // as the legend below; it never reads as a button.
            trailing={
              <span
                data-testid="command-palette-mode-hint"
                className="inline-flex shrink-0 items-center gap-1.25 text-xs whitespace-nowrap fg-quaternary"
                aria-live="polite"
                data-mode={commandsOnly ? 'commands' : 'all'}
              >
                {commandsOnly ? (
                  'Commands only'
                ) : (
                  <>
                    {/* The spaces keep the text "Type > for commands" for
                        screen readers; the flex gap sets the visual spacing. */}
                    Type{' '}
                    <Kbd
                      shortcut={shortcutKeys('palette-commands-prefix')}
                      data-testid="command-palette-mode-hint-key"
                    />{' '}
                    for commands
                  </>
                )}
              </span>
            }
          />
        </div>
        {/* Session replay records the results; a transcript or plan snippet
            row blocks its own snippet (`PaletteResultRow`). */}
        <div className="max-h-96 overflow-y-auto">
          {flatItems.length === 0 ? (
            <SearchEmptyState
              testId="command-palette-empty"
              title="Nothing matches your search."
              actionLabel={query === '' ? undefined : 'Clear search'}
              onAction={(): void => {
                setQuery('');
                setErrorMessage(null);
                selectedItemIdRef.current = null;
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              actionTestId="command-palette-empty-clear"
            />
          ) : (
            <ul role="listbox" aria-label="Results" className="py-1">
              {ranking.sections.map((section, sectionIdx) => (
                <li
                  key={section.id}
                  data-testid="command-palette-section"
                  data-palette-section={section.id}
                >
                  <div className="px-4 pb-1 pt-3 text-2xs font-semibold fg-secondary">
                    {section.label}
                  </div>
                  <ul role="group" aria-label={section.label}>
                    {section.items.map((ranked, itemIdx) => {
                      const index = sectionOffsets[sectionIdx] + itemIdx;
                      return (
                        <PaletteResultRow
                          key={ranked.item.id}
                          item={ranked.item}
                          titleIndices={ranked.titleIndices}
                          index={index}
                          isSelected={index === selectedIndex}
                          onHover={handleHover}
                          onActivate={handleActivate}
                          registerRef={registerRef}
                        />
                      );
                    })}
                    {section.truncated > 0 &&
                      ((): JSX.Element => {
                        const index =
                          sectionOffsets[sectionIdx] + section.items.length;
                        const entry = flatItems[index];
                        return (
                          <li
                            ref={(node): void => registerRef(index, node)}
                            key={`show-more:${section.id}`}
                          >
                            <button
                              type="button"
                              role="option"
                              aria-selected={index === selectedIndex}
                              data-testid="command-palette-show-more"
                              onMouseEnter={(): void => handleHover(index)}
                              onClick={(): void => activateEntry(entry)}
                              className={`w-full px-4 py-2 text-left text-s transition-colors ${
                                index === selectedIndex
                                  ? 'bg-accent-subtle fg-accent'
                                  : 'fg-secondary hover:bg-secondary'
                              }`}
                            >
                              Show {section.truncated} more
                            </button>
                          </li>
                        );
                      })()}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
        {errorMessage && (
          <div
            role="alert"
            className="border-t px-4 py-3 text-s fg-destructive"
          >
            {errorMessage}
          </div>
        )}
        <KeyHintFooter hints={pickerKeyHints('open')} />
      </div>
    </div>
  );
}

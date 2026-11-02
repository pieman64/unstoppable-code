/**
 * AutomationsPanel — the `automations` panel kind's surface: automations and
 * watchers scoped to the panel's workspace, in three sections:
 *
 * - **Upcoming** — automation occurrences firing within the next 10 minutes,
 *   padded out to at least 5 entries with the next later fires.
 * - **Overview** — a simplified table mixing the workspace's automations and
 *   watchers, with type filtering and text search.
 * - **Completed** — recently finished automation runs merged with completed
 *   watcher fires, newest first.
 *
 * One component serves all four variants (`instance.variant`): `full` renders
 * every section with collapsible headers; `upcoming` / `overview` /
 * `completed` render exactly one section with no expand/collapse chrome.
 * Every variant shares the same toolbar: a worktree-scope icon toggle (code
 * workspaces only, on by default) and an add button that opens the automation
 * creation modal prefilled to this workspace (and worktree for code).
 *
 * Entry clicks open the automation's runs in the Workflows edit shell
 * (CAN-4072), and the add button opens a new draft there, in the main window
 * even from a pop-out. Watcher clicks open the {@link WatcherManagementModal}
 * scoped to the clicked watcher.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  AppAdvisorWatcherSummary,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import {
  Button,
  Notice,
  NoticeButton,
  SegmentedControl,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  AutomationsIcon,
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HistoryIcon,
  PlusIcon,
  ScheduleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import { WatcherManagementModal } from '@/components/watchers/WatcherManagementModal';
import {
  triggerTitle,
  watcherStatusLabelWithFailure,
  watcherTargetDisplay,
} from '@/components/watchers/watcherDisplay';
import { visibleWatchers } from '@/components/watchers/watcherFilters';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useNowTick } from '@/components/automations/calendar/useNowTick';
import { type AutomationsPanelVariant } from '@/lib/panels/automations-variants';
import { bringMainWindowForward } from '@/lib/panels/main-window-focus';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  buildCompletedEntries,
  buildUpcomingEntries,
  filterActivitiesForScope,
  filterWatchersForScope,
  formatTimeUntil,
  getAutomationNextRun,
  type AutomationsPanelScope,
  type CompletedEntry,
  type UpcomingEntry,
} from './automations-panel-data';

type SectionId = 'upcoming' | 'overview' | 'completed';

type OverviewTypeFilter = 'all' | 'automations' | 'watchers';

type OverviewRow =
  | { kind: 'automation'; activity: ScheduledActivity }
  | { kind: 'watcher'; watcher: AppAdvisorWatcherSummary };

export interface AutomationsPanelProps {
  readonly panelId: string;
  readonly variant: AutomationsPanelVariant;
  readonly projectId: string;
  readonly worktreeId: string;
}

/** Collapsible header + body in the `full` variant; body-only in presets. */
function PanelSectionShell({
  id,
  title,
  icon,
  count,
  collapsible,
  collapsed,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  icon: ReactNode;
  count: number;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}): JSX.Element {
  if (!collapsible) {
    return <div className="flex min-h-0 flex-col">{children}</div>;
  }
  return (
    <div className="flex min-h-0 flex-col">
      <button
        type="button"
        onClick={(): void => onToggle(id)}
        aria-expanded={!collapsed}
        data-testid={`automations-panel-section-${id}`}
        className="focus-ring flex w-full shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium fg-secondary transition-colors hover:fg-primary"
      >
        {collapsed ? (
          <ChevronRightIcon width={12} height={12} aria-hidden="true" />
        ) : (
          <ChevronDownIcon width={12} height={12} aria-hidden="true" />
        )}
        {icon}
        <span>{title}</span>
        <span className="rounded-full bg-fg-primary/[0.06] px-1.5 py-0.5 text-2xs fg-secondary">
          {count}
        </span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function EmptyRow({ label }: { label: string }): JSX.Element {
  return (
    <div className="px-3 py-3 text-xs fg-secondary">
      <span>{label}</span>
    </div>
  );
}

function UpcomingSection({
  entries,
  now,
  onOpen,
}: {
  entries: UpcomingEntry[];
  now: Date;
  onOpen: (activity: ScheduledActivity) => void;
}): JSX.Element {
  if (entries.length === 0) {
    return <EmptyRow label="No upcoming automation triggers." />;
  }
  return (
    <ul
      className="flex flex-col divide-y"
      data-testid="automations-panel-upcoming-list"
    >
      {entries.map((entry) => (
        <li key={entry.key}>
          <button
            type="button"
            onClick={(): void => onOpen(entry.activity)}
            data-testid={`automations-panel-upcoming-${entry.key}`}
            className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-fg-primary/[0.04]"
          >
            <span
              className={`inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium ${
                entry.withinSoonWindow
                  ? 'bg-accent-subtle fg-accent'
                  : 'bg-fg-primary/[0.06] fg-secondary'
              }`}
            >
              {formatTimeUntil(now, entry.occursAt)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs fg-primary">
              {entry.activity.name || 'Untitled automation'}
            </span>
            <span className="shrink-0 text-2xs fg-secondary">
              {entry.occursAt.toLocaleString()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function OverviewSection({
  rows,
  typeFilter,
  onTypeFilterChange,
  search,
  onSearchChange,
  onOpenActivity,
  onOpenWatcher,
}: {
  rows: OverviewRow[];
  typeFilter: OverviewTypeFilter;
  onTypeFilterChange: (filter: OverviewTypeFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onOpenActivity: (activity: ScheduledActivity) => void;
  onOpenWatcher: (watcher: AppAdvisorWatcherSummary) => void;
}): JSX.Element {
  const filters: Array<{ value: OverviewTypeFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'automations', label: 'Automations' },
    { value: 'watchers', label: 'Watchers' },
  ];
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <SegmentedControl
          value={typeFilter}
          options={filters.map((filter) => ({
            value: filter.value,
            label: filter.label,
            dataTestId: `automations-panel-filter-${filter.value}`,
          }))}
          onChange={onTypeFilterChange}
          label="Overview type filter"
          shape="capsule"
          width="content"
        />
        <input
          type="text"
          value={search}
          onChange={(event): void => onSearchChange(event.target.value)}
          placeholder="Filter by name"
          data-testid="automations-panel-search"
          className="focus-ring min-w-0 flex-1 rounded-md border bg-base px-2 py-1 text-xs fg-primary"
        />
      </div>
      {rows.length === 0 ? (
        <EmptyRow label="No automations or watchers match." />
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <thead>
            <tr className="border-b text-left fg-secondary">
              <th className="w-9/20 px-3 py-1.5 font-medium">Name</th>
              <th className="w-3/20 px-1 py-1.5 font-medium">Type</th>
              <th className="w-1/5 px-1 py-1.5 font-medium">Trigger</th>
              <th className="w-1/5 px-1 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody data-testid="automations-panel-overview-body">
            {rows.map((row) => {
              if (row.kind === 'automation') {
                const activity = row.activity;
                const nextRun = getAutomationNextRun(activity, new Date());
                return (
                  <tr
                    key={`automation-${activity.id}`}
                    data-testid={`automations-panel-overview-automation-${activity.id}`}
                    onClick={(): void => onOpenActivity(activity)}
                    className="cursor-pointer border-b transition-colors hover:bg-fg-primary/[0.04]"
                  >
                    <td className="truncate px-3 py-1.5 fg-primary">
                      {activity.name || 'Untitled automation'}
                    </td>
                    <td className="px-1 py-1.5 fg-secondary">Automation</td>
                    <td className="truncate px-1 py-1.5 fg-secondary">
                      {getAutomationTriggerLabel(activity.schedule)}
                    </td>
                    <td
                      className={`truncate px-1 py-1.5 ${
                        activity.sharedPipelineReview
                          ? 'fg-warning'
                          : 'fg-secondary'
                      }`}
                    >
                      {activity.sharedPipelineReview
                        ? 'Review needed'
                        : !activity.enabled
                          ? 'Disabled'
                          : nextRun
                            ? nextRun.toLocaleString()
                            : 'Enabled'}
                    </td>
                  </tr>
                );
              }
              const watcher = row.watcher;
              const target = watcherTargetDisplay(watcher.target);
              return (
                <tr
                  key={`watcher-${watcher.id}`}
                  data-testid={`automations-panel-overview-watcher-${watcher.id}`}
                  onClick={(): void => onOpenWatcher(watcher)}
                  className="cursor-pointer border-b transition-colors hover:bg-fg-primary/[0.04]"
                >
                  <td
                    className="truncate px-3 py-1.5 fg-primary"
                    title={`${target.title} — ${target.subtitle}`}
                  >
                    {watcher.label}
                  </td>
                  <td className="px-1 py-1.5 fg-secondary">Watcher</td>
                  <td className="truncate px-1 py-1.5 fg-secondary">
                    {triggerTitle(watcher.trigger)}
                  </td>
                  <td className="truncate px-1 py-1.5 fg-secondary">
                    {watcherStatusLabelWithFailure(
                      watcher.status,
                      watcher.failureKind,
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CompletedSection({
  entries,
  onOpenActivity,
  onOpenWatcher,
}: {
  entries: CompletedEntry[];
  onOpenActivity: (activity: ScheduledActivity) => void;
  onOpenWatcher: (watcher: AppAdvisorWatcherSummary) => void;
}): JSX.Element {
  if (entries.length === 0) {
    return (
      <EmptyRow label="No completed automation runs or watcher fires yet." />
    );
  }
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <thead>
        <tr className="border-b text-left fg-secondary">
          <th className="w-9/20 px-3 py-1.5 font-medium">Name</th>
          <th className="w-3/20 px-1 py-1.5 font-medium">Type</th>
          <th className="w-3/20 px-1 py-1.5 font-medium">Result</th>
          <th className="w-1/4 px-1 py-1.5 font-medium">Completed</th>
        </tr>
      </thead>
      <tbody data-testid="automations-panel-completed-body">
        {entries.map((entry) => {
          const statusClasses =
            entry.status === 'failure'
              ? 'bg-destructive-subtle fg-destructive'
              : entry.status === 'skipped' || entry.status === 'canceled'
                ? 'bg-fg-primary/[0.06] fg-secondary'
                : 'bg-success-subtle fg-success';
          const statusLabel =
            entry.status === 'failure'
              ? 'Failed'
              : entry.status === 'skipped'
                ? 'Skipped'
                : entry.status === 'canceled'
                  ? 'Canceled'
                  : entry.kind === 'watcher-fire'
                    ? 'Fired'
                    : 'Success';
          return (
            <tr
              key={entry.key}
              data-testid={`automations-panel-completed-${entry.key}`}
              onClick={(): void => {
                if (entry.kind === 'automation-run') {
                  if (entry.activity) onOpenActivity(entry.activity);
                } else {
                  onOpenWatcher(entry.watcher);
                }
              }}
              className="cursor-pointer border-b transition-colors hover:bg-fg-primary/[0.04]"
            >
              <td className="truncate px-3 py-1.5 fg-primary">{entry.name}</td>
              <td className="px-1 py-1.5 fg-secondary">
                {entry.kind === 'automation-run' ? 'Automation' : 'Watcher'}
              </td>
              <td className="px-1 py-1.5">
                <span
                  className={`inline-flex rounded-full px-1.5 py-0.5 text-2xs font-medium ${statusClasses}`}
                >
                  {statusLabel}
                </span>
              </td>
              <td className="truncate px-1 py-1.5 fg-secondary">
                {entry.completedAt.toLocaleString()}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export const AutomationsPanel = memo(function AutomationsPanel({
  panelId,
  variant,
  projectId,
  worktreeId,
}: AutomationsPanelProps): JSX.Element {
  const {
    activities,
    recentRuns,
    loading: automationsLoading,
    hydrated: automationsHydrated,
    error: automationsError,
    clearMutationError,
  } = useAutomationsStore(
    useShallow((s) => ({
      activities: s.activities,
      recentRuns: s.recentRuns,
      loading: s.loading,
      hydrated: s.hydrated,
      error: s.error,
      clearMutationError: s.clearMutationError,
    })),
  );
  const {
    watchers,
    completedWatchers,
    loading: watchersLoading,
    hydrated: watchersHydrated,
    error: watchersError,
  } = useAppAdvisorWatchersStore(
    useShallow((s) => ({
      watchers: s.watchers,
      completedWatchers: s.completedWatchers,
      loading: s.loading,
      hydrated: s.hydrated,
      error: s.error,
    })),
  );
  const projects = useProjectsStore((s) => s.projects);

  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  const retryHydration = useCallback((): void => {
    const automationsStore = useAutomationsStore.getState();
    if (!automationsStore.hydrated || automationsStore.error) {
      void automationsStore.hydrate();
    }
    const watchersStore = useAppAdvisorWatchersStore.getState();
    if (!watchersStore.hydrated || watchersStore.error) {
      void watchersStore.hydrate();
    }
  }, []);

  const loadErrors = [automationsError, watchersError].filter(
    (message): message is string => Boolean(message),
  );
  const dataLoading =
    loadErrors.length === 0 &&
    (automationsLoading ||
      watchersLoading ||
      !automationsHydrated ||
      !watchersHydrated);
  useEffect(() => {
    const store = useAppAdvisorWatchersStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  const project = projects.find((entry) => entry.id === projectId);
  // Cowork-style surfaces (cowork workspaces, the standalone-chat sentinel,
  // and the App Advisor pseudo-workspace) have no git worktrees, so the
  // worktree-scope toggle is meaningless there. `isCoworkChatTarget` covers
  // the sentinels the projects store never lists.
  const isCowork = project?.type === 'cowork' || isCoworkChatTarget(projectId);
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((entry) => entry.id === worktreeId)
      : undefined;
  const worktreeLabel = worktree
    ? getWorktreeBranchDisplayName({
        rawBranch: worktree.branchName,
        worktreeId: worktree.id,
        hasMultipleBranches: false,
        getBranchDisplayName: (branchName) => branchName,
      })
    : worktreeId;

  const [worktreeOnly, setWorktreeOnly] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<SectionId, boolean>
  >({ upcoming: false, overview: false, completed: false });
  const [typeFilter, setTypeFilter] = useState<OverviewTypeFilter>('all');
  const [search, setSearch] = useState('');
  const [watcherDetailId, setWatcherDetailId] = useState<string | null>(null);
  const panelRootRef = useRef<HTMLDivElement | null>(null);

  const toggleSection = useCallback((id: SectionId): void => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const now = useNowTick();
  const scope = useMemo<AutomationsPanelScope>(
    () => ({
      projectId,
      worktreeId,
      worktreeOnly: isCowork ? false : worktreeOnly,
    }),
    [projectId, worktreeId, isCowork, worktreeOnly],
  );

  const scopedActivities = useMemo(
    () => filterActivitiesForScope(activities, scope),
    [activities, scope],
  );
  const scopedWatchers = useMemo(
    () => filterWatchersForScope(visibleWatchers(watchers), scope, activities),
    [watchers, scope, activities],
  );
  const scopedCompletedWatchers = useMemo(
    () => filterWatchersForScope(completedWatchers, scope, activities),
    [completedWatchers, scope, activities],
  );
  const watcherDetail = useMemo(
    () =>
      watcherDetailId === null
        ? null
        : ([...scopedWatchers, ...scopedCompletedWatchers].find(
            (watcher) => watcher.id === watcherDetailId,
          ) ?? null),
    [watcherDetailId, scopedWatchers, scopedCompletedWatchers],
  );
  useEffect(() => {
    if (watcherDetailId !== null && watcherDetail === null) {
      setWatcherDetailId(null);
    }
  }, [watcherDetailId, watcherDetail]);
  const upcomingEntries = useMemo(
    () => buildUpcomingEntries(scopedActivities, now),
    [scopedActivities, now],
  );
  const completedEntries = useMemo(
    () =>
      buildCompletedEntries(
        recentRuns,
        scopedActivities,
        scopedCompletedWatchers,
      ),
    [recentRuns, scopedActivities, scopedCompletedWatchers],
  );
  const overviewRows = useMemo<OverviewRow[]>(() => {
    const needle = search.trim().toLowerCase();
    const rows: OverviewRow[] = [];
    if (typeFilter !== 'watchers') {
      for (const activity of scopedActivities) {
        if (needle && !activity.name.toLowerCase().includes(needle)) continue;
        rows.push({ kind: 'automation', activity });
      }
    }
    if (typeFilter !== 'automations') {
      for (const watcher of scopedWatchers) {
        if (needle && !watcher.label.toLowerCase().includes(needle)) continue;
        rows.push({ kind: 'watcher', watcher });
      }
    }
    return rows;
  }, [scopedActivities, scopedWatchers, typeFilter, search]);

  // The edit shell lives in the main window, so a pop-out brings it forward.
  // When the shell holds unsaved edits on another item, its prompt asks
  // there; the panel has nothing to wait for.
  const openRuns = useCallback((activity: ScheduledActivity): void => {
    const ownerDocument = panelRootRef.current?.ownerDocument;
    useNavigationStore
      .getState()
      .openAutomationEdit({ activityId: activity.id, section: 'runs' });
    bringMainWindowForward(ownerDocument);
  }, []);

  const openCreate = useCallback((): void => {
    if (projectId === APP_ADVISOR_PROJECT_ID) return;
    const ownerDocument = panelRootRef.current?.ownerDocument;
    clearMutationError();
    // A code project's draft runs a new chat on this panel's worktree each
    // time, instead of provisioning a fresh one.
    useNavigationStore.getState().openAutomationDraft({
      projectId,
      isCowork,
      ...(!isCowork ? { existingWorktreeId: worktreeId } : {}),
    });
    bringMainWindowForward(ownerDocument);
  }, [clearMutationError, projectId, worktreeId, isCowork]);

  const openWatcherDetail = useCallback(
    (watcher: AppAdvisorWatcherSummary): void => {
      setWatcherDetailId(watcher.id);
    },
    [],
  );

  useCurrentUiStateReporter(`automations.panel.${panelId}`, {
    panelId,
    variant,
    projectId,
    worktreeId,
    // The panel opens no automation dialogs of its own any more: details,
    // the form and the review all open in the main window's edit shell.
    detailsModalOpen: false,
    sharedPipelineReviewModalOpen: false,
    watcherModalOpen: watcherDetail !== null,
    ...(watcherDetail ? { watcherModalWatcherId: watcherDetail.id } : {}),
    formOpen: false,
  });

  const showSection = useCallback(
    (id: SectionId): boolean => variant === 'full' || variant === id,
    [variant],
  );
  const collapsible = variant === 'full';

  const worktreeToggleLabel = worktreeOnly
    ? `Showing automations for this ${WORKTREE_UNIT_LABEL.toLowerCase()} only — click to show the whole project`
    : `Showing all project automations — click to show only this ${WORKTREE_UNIT_LABEL.toLowerCase()}`;

  return (
    <div
      ref={panelRootRef}
      data-testid="automations-panel"
      data-variant={variant}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0 truncate text-xs fg-secondary">
          {project ? getWorkspaceDisplayName(project) : projectId}
          {!isCowork && worktreeOnly ? (
            <span className="fg-secondary"> · {worktreeLabel}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isCowork && (
            <Tooltip label={worktreeToggleLabel}>
              <button
                type="button"
                aria-pressed={worktreeOnly}
                aria-label={worktreeToggleLabel}
                onClick={(): void => setWorktreeOnly((prev) => !prev)}
                data-testid="automations-panel-worktree-toggle"
                className={`focus-ring inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  worktreeOnly
                    ? 'bg-accent-subtle fg-accent'
                    : 'fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary'
                }`}
              >
                <BranchIcon width={14} height={14} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          {projectId !== APP_ADVISOR_PROJECT_ID && (
            <Tooltip label="New automation">
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                aria-label="New automation"
                onClick={openCreate}
                data-testid="automations-panel-add"
              >
                <PlusIcon width={14} height={14} aria-hidden="true" />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadErrors.length > 0 ? (
          <Notice
            intent="destructive"
            data-testid="automations-panel-load-error"
            className="m-3"
            title="Could not load automations."
            actions={
              <NoticeButton
                variant="primary"
                data-testid="automations-panel-retry"
                onClick={retryHydration}
              >
                Retry
              </NoticeButton>
            }
          >
            {loadErrors.join(' ')}
          </Notice>
        ) : dataLoading ? (
          <div
            data-testid="automations-panel-loading"
            className="flex h-full min-h-24 items-center justify-center px-3 py-6 text-xs fg-secondary"
          >
            Loading automations…
          </div>
        ) : (
          <div className="divide-y">
            {showSection('upcoming') && (
              <PanelSectionShell
                id="upcoming"
                title="Upcoming"
                icon={
                  <ScheduleIcon width={14} height={14} aria-hidden="true" />
                }
                count={upcomingEntries.length}
                collapsible={collapsible}
                collapsed={collapsedSections.upcoming}
                onToggle={toggleSection}
              >
                <UpcomingSection
                  entries={upcomingEntries}
                  now={now}
                  onOpen={openRuns}
                />
              </PanelSectionShell>
            )}
            {showSection('overview') && (
              <PanelSectionShell
                id="overview"
                title="Overview"
                icon={
                  <AutomationsIcon width={14} height={14} aria-hidden="true" />
                }
                count={overviewRows.length}
                collapsible={collapsible}
                collapsed={collapsedSections.overview}
                onToggle={toggleSection}
              >
                <OverviewSection
                  rows={overviewRows}
                  typeFilter={typeFilter}
                  onTypeFilterChange={setTypeFilter}
                  search={search}
                  onSearchChange={setSearch}
                  onOpenActivity={openRuns}
                  onOpenWatcher={openWatcherDetail}
                />
              </PanelSectionShell>
            )}
            {showSection('completed') && (
              <PanelSectionShell
                id="completed"
                title="Completed"
                icon={<HistoryIcon width={14} height={14} aria-hidden="true" />}
                count={completedEntries.length}
                collapsible={collapsible}
                collapsed={collapsedSections.completed}
                onToggle={toggleSection}
              >
                <CompletedSection
                  entries={completedEntries}
                  onOpenActivity={openRuns}
                  onOpenWatcher={openWatcherDetail}
                />
              </PanelSectionShell>
            )}
          </div>
        )}
      </div>
      {watcherDetail && (
        <WatcherManagementModal
          title="Watcher"
          emptyMessage="This watcher is no longer available."
          watchers={[watcherDetail]}
          onClose={(): void => setWatcherDetailId(null)}
          ownerDocument={panelRootRef.current?.ownerDocument}
        />
      )}
    </div>
  );
});

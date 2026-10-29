import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useCapabilities } from '@canopy/app-state';
import {
  availableWorkflowTriggerKinds,
  countLibraryFacets,
  EMPTY_WORKFLOW_RUN_FILTERS,
  filterLibraryRows,
  pageLibraryRows,
  sortLibraryRows,
  WORKFLOW_LIBRARY_PAGE_SIZE,
  WorkflowsLibraryEmptyState,
  WorkflowsLibraryPagination,
  WorkflowsLibraryTable,
  WorkflowsLibraryToolbar,
  type WorkflowLibraryAction,
  type WorkflowLibraryRow,
} from '@canopy/ui-app/workflows';
import { ConfirmDialog, Notice } from '@canopy/ui-shared/components';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { copyTextToClipboard } from '@/lib/clipboard';
import { resolveSharedPipelineUrl } from '@/lib/share-links';
import { pipelineShareLinkPath } from '@/lib/workflows/library-projection';
import { automationLibraryKey } from '@/lib/workflows/run-feed';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../pages/PipelinesPage';
import type {
  WorkflowLibraryData,
  WorkflowLibraryTarget,
} from './useWorkflowLibraryRows';
import { revealedPipelineRowKey } from './revealedPipelineRowKey';

/** Below this width Next run folds under the trigger. */
const COMPACT_WIDTH_PX = 880;

export interface WorkflowsLibraryTabProps {
  readonly data: WorkflowLibraryData;
  readonly pipelines: PipelinesPageListApi;
  readonly automations: AutomationsPageBodyApi;
  /** Epoch milliseconds the rows were projected at. */
  readonly now: number;
  /** Opens the dispatch dialog on one pipeline; omitted when it cannot run. */
  readonly onRunPipeline?: (pipelineId: string) => void;
  /** The New workflow control, for the filtered empty state. */
  readonly newWorkflow?: ReactNode;
}

interface PendingDelete {
  readonly row: WorkflowLibraryRow;
  readonly target: WorkflowLibraryTarget;
}

/**
 * Workflows → Library (CAN-3981): every automation and every pipeline in one
 * table, joined by the Trigger column. Row actions call the stores and
 * handlers the old Automations and Pipelines lists used.
 */
export function WorkflowsLibraryTab({
  data,
  pipelines,
  automations,
  now,
  onRunPipeline,
  newWorkflow,
}: WorkflowsLibraryTabProps): JSX.Element {
  const capabilities = useCapabilities();
  const filters = useWorkflowsViewStore((state) => state.libraryFilters);
  const sort = useWorkflowsViewStore((state) => state.librarySort);
  const pageNumber = useWorkflowsViewStore((state) => state.libraryPage);
  const setFilters = useWorkflowsViewStore((state) => state.setLibraryFilters);
  const setSort = useWorkflowsViewStore((state) => state.setLibrarySort);
  const setPage = useWorkflowsViewStore((state) => state.setLibraryPage);
  const clearFilters = useWorkflowsViewStore(
    (state) => state.clearLibraryFilters,
  );

  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setCompact(width < COMPACT_WIDTH_PX);
    });
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);

  const { rows, targets } = data;
  const counts = useMemo(() => countLibraryFacets(rows), [rows]);
  const sorted = useMemo(
    () => sortLibraryRows(filterLibraryRows(rows, filters), sort),
    [filters, rows, sort],
  );
  const page = useMemo(
    () => pageLibraryRows(sorted, pageNumber),
    [pageNumber, sorted],
  );
  const projectOptions = useMemo(
    () =>
      automations.scope.projectsInContext.map((project) => ({
        id: project.id,
        name: getWorkspaceDisplayName(project),
      })),
    [automations.scope.projectsInContext],
  );
  const triggers = useMemo(
    () => availableWorkflowTriggerKinds(capabilities),
    [capabilities],
  );

  // A pipeline install from a share (CAN-3710) lands here too. The request
  // is consumed into local state at once, so it can never fire on a later
  // visit, and the list is refreshed so the new pipeline is in it.
  const pendingPipelineReveal = useNavigationStore(
    (state) => state.pendingPipelineReveal,
  );
  const [revealedPipelineId, setRevealedPipelineId] = useState<string | null>(
    null,
  );
  const refreshPipelines = pipelines.refresh;
  useEffect(() => {
    if (!pendingPipelineReveal) return;
    useNavigationStore.getState().consumePipelineReveal();
    setRevealedPipelineId(pendingPipelineReveal.pipelineId);
    void refreshPipelines();
  }, [pendingPipelineReveal, refreshPipelines]);
  const revealedPipelineKey = useMemo(
    () =>
      revealedPipelineId === null
        ? null
        : revealedPipelineRowKey(targets, revealedPipelineId),
    [revealedPipelineId, targets],
  );

  // A finished install points at its row: filters that would hide it are
  // cleared, and the page that lists it is shown.
  const revealedKey =
    automations.revealedActivityId !== null
      ? automationLibraryKey(automations.revealedActivityId)
      : revealedPipelineKey;
  const revealAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (revealedKey === null) {
      revealAppliedRef.current = null;
      return;
    }
    if (revealAppliedRef.current === revealedKey) return;
    if (!rows.some((row) => row.key === revealedKey)) return;
    revealAppliedRef.current = revealedKey;
    clearFilters();
    const index = sortLibraryRows(rows, sort).findIndex(
      (row) => row.key === revealedKey,
    );
    if (index >= 0) setPage(Math.floor(index / WORKFLOW_LIBRARY_PAGE_SIZE) + 1);
  }, [clearFilters, revealedKey, rows, setPage, sort]);

  // Once its page is listed, the revealed row is scrolled to and focused, as
  // the Automations list did.
  const focusedRevealRef = useRef<string | null>(null);
  const revealedOnPage =
    revealedKey !== null && page.rows.some((row) => row.key === revealedKey);
  useEffect(() => {
    if (revealedKey === null) {
      focusedRevealRef.current = null;
      return undefined;
    }
    if (!revealedOnPage || focusedRevealRef.current === revealedKey) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const row = containerRef.current?.querySelector<HTMLElement>(
        '[data-highlighted="true"]',
      );
      if (!row) return;
      focusedRevealRef.current = revealedKey;
      row.scrollIntoView?.({ block: 'center' });
      row.focus({ preventScroll: true });
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [revealedKey, revealedOnPage]);

  const withBusy = useCallback(
    async (key: string, action: () => Promise<void>): Promise<void> => {
      setActionError(null);
      setBusyKeys((current) => new Set(current).add(key));
      try {
        await action();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [],
  );

  /** A share not added yet: its Marketplace entry holds Add and the detail. */
  const openShareInMarketplace = useCallback((name: string): void => {
    useNavigationStore.getState().openPluginsNavigation({
      kind: 'marketplace-browse',
      query: name,
      tab: 'workflow',
    });
  }, []);

  const openRow = useCallback(
    (row: WorkflowLibraryRow): void => {
      const target = targets.get(row.key);
      if (!target) return;
      automations.endReveal();
      switch (target.kind) {
        case 'automation':
          automations.beginEdit(target.activity);
          return;
        case 'pipeline':
          pipelines.edit(target.pipeline);
          return;
        case 'shared-automation':
          // Read-only in the edit shell, with Duplicate (CAN-4072). Add
          // still opens Marketplace.
          useNavigationStore.getState().openWorkflowEdit({
            kind: 'shared-automation',
            remoteId: target.share.id,
            name: target.share.name,
          });
          return;
      }
    },
    [automations, pipelines, targets],
  );

  const viewRuns = useCallback(
    (row: WorkflowLibraryRow, target: WorkflowLibraryTarget): void => {
      if (target.kind === 'automation') {
        automations.beginView(target.activity);
        return;
      }
      // A pipeline's runs are the Runs feed narrowed to its name: executions
      // carry no locator that tells same-named pipelines apart.
      const view = useWorkflowsViewStore.getState();
      view.setRunsScrollTop(0);
      view.setRunsQuery(row.name);
      view.setRunsFilters({ ...EMPTY_WORKFLOW_RUN_FILTERS, kind: 'pipeline' });
      useNavigationStore.getState().navigate('workflows');
    },
    [automations],
  );

  const handleAction = useCallback(
    (row: WorkflowLibraryRow, action: WorkflowLibraryAction): void => {
      const target = targets.get(row.key);
      if (!target) return;
      switch (action) {
        case 'edit':
          openRow(row);
          return;
        case 'add':
          if (target.kind === 'shared-automation') {
            openShareInMarketplace(target.share.name);
          }
          return;
        case 'view-runs':
          viewRuns(row, target);
          return;
        case 'toggle':
          if (target.kind === 'automation') {
            void withBusy(row.key, () =>
              automations.toggleEnabled(target.activity),
            );
          } else if (target.kind === 'pipeline') {
            void withBusy(row.key, () =>
              pipelines.setPipelineEnabled(
                target.pipeline.id,
                row.enabled === false,
              ),
            );
          }
          return;
        case 'run':
          if (target.kind === 'automation') {
            void withBusy(row.key, () => automations.runNow(target.activity));
          } else if (target.kind === 'pipeline') {
            onRunPipeline?.(target.pipeline.id);
          }
          return;
        case 'duplicate':
          if (target.kind === 'pipeline') {
            void withBusy(row.key, () => pipelines.duplicate(target.pipeline));
          }
          return;
        case 'share':
          if (target.kind === 'automation') automations.share(target.activity);
          else if (target.kind === 'pipeline') pipelines.share(target.pipeline);
          return;
        case 'copy-link': {
          if (target.kind !== 'pipeline') return;
          const sharePath = pipelineShareLinkPath(target.pipeline);
          if (sharePath === undefined) return;
          void withBusy(row.key, async () => {
            const url = await resolveSharedPipelineUrl(sharePath);
            if (!(await copyTextToClipboard(url ?? sharePath))) {
              throw new Error('The share link could not be copied.');
            }
            useGitHubStore.getState().addToast('Share link copied.', 'success');
          });
          return;
        }
        case 'delete':
          setDeleteError(null);
          setPendingDelete({ row, target });
          return;
      }
    },
    [
      automations,
      onRunPipeline,
      openRow,
      openShareInMarketplace,
      pipelines,
      targets,
      viewRuns,
      withBusy,
    ],
  );

  const confirmDelete = useCallback((): void => {
    if (!pendingDelete) return;
    const { target } = pendingDelete;
    setDeleteBusy(true);
    void (async (): Promise<void> => {
      try {
        if (target.kind === 'automation') {
          await automations.remove(target.activity);
        } else if (target.kind === 'pipeline') {
          await pipelines.remove(target.pipeline);
        }
        setPendingDelete(null);
      } catch (error) {
        setDeleteError(error instanceof Error ? error.message : String(error));
      } finally {
        setDeleteBusy(false);
      }
    })();
  }, [automations, pipelines, pendingDelete]);

  const deletingRunning =
    pendingDelete?.row.lastRun?.state === 'running' &&
    pendingDelete.target.kind === 'automation';
  const rowBusyKeys = useMemo(() => {
    const keys = new Set(busyKeys);
    if (automations.runningActivityId !== null) {
      keys.add(automationLibraryKey(automations.runningActivityId));
    }
    return keys;
  }, [automations.runningActivityId, busyKeys]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-4 pt-4"
      data-testid="workflows-library"
    >
      {(pipelines.error !== null || automations.error !== null) && (
        <Notice intent="destructive" data-testid="workflows-library-error">
          {automations.error !== null && pipelines.error !== null
            ? 'Automations and pipelines could not be loaded.'
            : automations.error !== null
              ? 'Automations could not be loaded. Pipelines are still listed.'
              : 'Pipelines could not be loaded. Automations are still listed.'}
        </Notice>
      )}
      {data.sharedLoadFailed && (
        <Notice intent="attention" data-testid="workflows-library-shared-error">
          Shared workflows could not be loaded. Yours are still listed.
        </Notice>
      )}
      {(automations.mutationError ?? pipelines.shareError ?? actionError) !==
        null && (
        <Notice
          intent="destructive"
          data-testid="workflows-library-action-error"
        >
          {automations.mutationError ?? pipelines.shareError ?? actionError}
        </Notice>
      )}
      {automations.revealNotice}
      <WorkflowsLibraryToolbar
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        counts={counts}
        triggers={triggers}
        projects={projectOptions}
        sharedCountUnknown={data.sharedLoadFailed}
        total={rows.length}
        matched={sorted.length}
      />
      {data.loading && rows.length === 0 ? (
        <p className="py-8 text-center text-s fg-secondary" role="status">
          Loading workflows…
        </p>
      ) : page.rows.length === 0 ? (
        <WorkflowsLibraryEmptyState
          filters={filters}
          onClearFilters={clearFilters}
          newWorkflow={newWorkflow}
        />
      ) : (
        <WorkflowsLibraryTable
          rows={page.rows}
          now={now}
          onOpen={openRow}
          onAction={handleAction}
          busyKeys={rowBusyKeys}
          highlightKey={revealedKey}
          compact={compact}
        />
      )}
      <WorkflowsLibraryPagination page={page} onPageChange={setPage} />
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.row.name}"?`}
          message={
            deletingRunning
              ? 'A run is in progress and will be stopped. This cannot be undone.'
              : 'This cannot be undone.'
          }
          confirmLabel="Delete"
          busyLabel="Deleting…"
          busy={deleteBusy}
          errorMessage={deleteError}
          destructive
          dataTestId="workflows-library-delete"
          onCancel={(): void => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

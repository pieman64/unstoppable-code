import { type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';
import type {
  PipelineInfo,
  PipelineExecutionScope,
  PipelineTriggerType,
} from '@canopy/desktop-shared/types/pipeline';
import { RefreshSpinner } from '../shared/loading/spinners/RefreshSpinner';
import { PageTitlebar } from '../shared/PageTitlebar';
import { WorkflowsPageHeader } from '../workflows/WorkflowsPageHeader';
import { WorkflowsTabPanel } from '../workflows/WorkflowsTabPanel';
import { PageContent } from '../shared/PageContent';
import { PipelineTableRow } from './PipelineTableRow';
import { CreatePipelineSplitButton } from './CreatePipelineSplitButton';
import { PIPELINE_SOURCE_META, PIPELINE_SOURCES } from './pipeline-source-meta';
import { TRIGGER_META, TRIGGER_TYPES } from './pipeline-trigger-meta';
import type { SharedCloudListState } from '../../hooks/usePipelineList';
import type { SharedListFilters } from '../../hooks/useSharedPipelineList';
import { fuzzyMatch } from '@/lib/fuzzySearch';
import { brandText } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { PIPELINE_EXECUTION_SCOPES } from '@canopy/protocol/pipelines';
import { PIPELINE_EXECUTION_SCOPE_META } from './pipeline-execution-scope-meta';
import { readPipelineInfoScopes } from '@/lib/pipelineExecutionScope';
import { PipelineTemplatesSection, Notice, Tooltip } from '@canopy/ui-shared';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';

import { useCuratedPipelines } from '../../hooks/useCuratedPipelines';
import {
  curatedPipelineId,
  type PipelineCatalogEntry,
} from './pipeline-catalog-entry';
import type { CuratedPipelineListQuery } from '@canopy/protocol/pipeline-catalog';
import { BusyLabel } from '@canopy/ui-shared/components';
import { filterCuratedPipelinesBySearch } from '@canopy/ui-shared/lib';
import { PipelineIcon as AppCatalogPipelineIcon } from '@canopy/ui-shared/icons/AppIcons';

interface PipelineListViewProps {
  pipelines: PipelineInfo[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  /** Opens the manual pipeline builder ("Build manually"). */
  onCreateNew: () => void;
  /**
   * Starts the AI pipeline interview in a new Cowork chat — the main
   * "New pipeline" action (CAN-3487).
   */
  onStartInterview: () => void;
  /** True while the interview chat is being created. */
  interviewPending?: boolean;
  onEdit: (pipeline: PipelineInfo) => void;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (pipeline: PipelineInfo) => Promise<void>;
  /** Raise a Share request for a row. Omitted when sharing is unavailable. */
  onShare?: (pipeline: PipelineInfo) => void;
  /** Source-qualified `<source>:<id>` of the row whose Share is in flight. */
  sharePendingId?: string | null;
  /**
   * Failure text for a row action that has no row-level place to report —
   * today, a Share whose definition could not be loaded.
   */
  actionError?: string | null;

  /** Pipeline ids the user has disabled (hidden from run pickers). */
  disabledPipelineIds: Set<string>;
  /** Enable or disable a pipeline. */
  onToggleEnabled: (id: string, enabled: boolean) => Promise<void>;

  /**
   * Singleton shared-pipeline state from the configured Canopy Cloud account.
   *
   * The desktop app is bound to exactly one Canopy Cloud backend, so this
   * view renders a single shared section (no tabs, no server names).
   */
  sharedState: SharedCloudListState;
  onSharedActivate: () => void;
  onSharedRefresh: () => Promise<void>;
  onLoadMoreShared: () => Promise<void>;
  onSharedFilterChange: (filters: SharedListFilters) => void;
  onSharedDelete: (remoteId: string) => Promise<void>;
  onOpenAccountSettings: () => void;
  headerAction?: ReactNode;
  onOpenImported?: (id: string) => void;
}

const SOURCE_RANK: Record<PipelineCatalogEntry['source'], number> = {
  user: 0,
  project: 1,
  bundled: 2,
  shared: 3,
  curated: 4,
};

function parseTriggerFilter(value: string): PipelineTriggerType | 'all' {
  switch (value) {
    case 'dispatch':
    case 'plan_ready':
    case 'task_ready':
      return value;
    default:
      return 'all';
  }
}

export function PipelineListView({
  pipelines,
  loading,
  error,
  onRefresh,
  onCreateNew,
  onStartInterview,
  interviewPending = false,
  onEdit,
  onDelete,
  onDuplicate,
  onShare,
  sharePendingId = null,
  actionError = null,
  disabledPipelineIds,
  onToggleEnabled,
  sharedState,
  onSharedActivate,
  onSharedRefresh,
  onLoadMoreShared,
  onSharedFilterChange,
  onSharedDelete,
  onOpenAccountSettings,
  headerAction,
  onOpenImported,
}: PipelineListViewProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [triggerFilter, setTriggerFilter] = useState<
    PipelineTriggerType | 'all'
  >('all');

  const [scopeFilter, setScopeFilter] = useState<
    PipelineExecutionScope | 'all'
  >('all');

  const cloudReady = isCanopyCloudConnected(sharedState.cloudAccount);
  const showShared = sourceFilter === 'all' || sourceFilter === 'shared';

  const [templateQuery, setTemplateQuery] = useState<CuratedPipelineListQuery>(
    {},
  );
  const curated = useCuratedPipelines({
    ...templateQuery,
    enabled: cloudReady,
    onImported: () => {
      void onRefresh();
    },
    onOpenImported,
  });
  // Templates keep the enable/disable preference the table rows used to own:
  // a disabled template stays hidden from launch pickers until re-enabled.
  const [templateToggling, setTemplateToggling] = useState(false);
  const selectedTemplateId = curated.selectedKey
    ? curatedPipelineId(curated.selectedKey)
    : null;
  const templateAvailability = selectedTemplateId
    ? {
        enabled: !disabledPipelineIds.has(selectedTemplateId),
        pending: templateToggling,
        onChange: (enabled: boolean): void => {
          setTemplateToggling(true);
          void onToggleEnabled(selectedTemplateId, enabled).finally(() =>
            setTemplateToggling(false),
          );
        },
      }
    : undefined;
  // The hook drops `q` from catalog requests and loads every page while a
  // search is set, so the search narrows those complete rows here.
  const templateRows = useMemo(
    () => filterCuratedPipelinesBySearch(curated.rows, templateQuery.q),
    [curated.rows, templateQuery.q],
  );
  useCurrentUiStateReporter(
    'pipelines.curatedPreview',
    curated.selectedKey
      ? {
          open: true,
          key: curated.selectedKey,
          loading: curated.detailLoading === true,
          errorVisible: Boolean(curated.detailError),
        }
      : null,
  );
  const pendingCuratedPipelinePreviewKey = useNavigationStore(
    (state) => state.pendingCuratedPipelinePreviewKey,
  );
  useEffect(() => {
    if (!pendingCuratedPipelinePreviewKey || !cloudReady) return;
    useNavigationStore.getState().consumeCuratedPipelinePreview();
    curated.onSelectKey(pendingCuratedPipelinePreviewKey);
  }, [cloudReady, curated, pendingCuratedPipelinePreviewKey]);

  // Lazy-load the first page the first time the shared rows would be shown.
  useEffect(() => {
    if (!cloudReady || !showShared) return;
    if (sharedState.loaded || sharedState.loading) return;
    onSharedActivate();
  }, [
    cloudReady,
    showShared,
    sharedState.loaded,
    sharedState.loading,
    onSharedActivate,
  ]);

  useEffect(() => {
    if (!showShared) return;
    onSharedFilterChange({
      q: search.trim() || undefined,
      triggerType: triggerFilter === 'all' ? undefined : triggerFilter,
    });
  }, [onSharedFilterChange, search, showShared, triggerFilter]);

  // Combine local pipelines with already-loaded shared rows so search and
  // filters apply uniformly across every source.
  const allPipelines = useMemo<PipelineCatalogEntry[]>(
    () => [
      ...pipelines.filter((pipeline) => pipeline.source !== 'curated'),
      ...sharedState.rows,
    ],
    [pipelines, sharedState.rows],
  );

  const filtered = useMemo<PipelineCatalogEntry[]>(() => {
    const query = search.trim();
    return allPipelines
      .filter((p) => {
        if (sourceFilter !== 'all' && p.source !== sourceFilter) return false;
        if (
          scopeFilter !== 'all' &&
          !readPipelineInfoScopes(p).includes(scopeFilter)
        )
          return false;
        if (
          triggerFilter !== 'all' &&
          p.triggerTypes !== undefined &&
          !p.triggerTypes.some((t) => t === triggerFilter)
        ) {
          return false;
        }
        if (query) {
          const nameMatch = fuzzyMatch(query, p.name) !== null;
          const descMatch = p.description
            ? fuzzyMatch(query, p.description) !== null
            : false;
          if (!nameMatch && !descMatch) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
          a.name.localeCompare(b.name),
      );
  }, [allPipelines, search, sourceFilter, triggerFilter, scopeFilter]);

  function handleRowDelete(pipeline: PipelineInfo): Promise<void> {
    if (pipeline.source === 'shared') {
      return pipeline.remoteId
        ? onSharedDelete(pipeline.remoteId)
        : Promise.resolve();
    }
    return onDelete(pipeline.id);
  }

  const hasActiveFilters =
    search.trim() !== '' ||
    sourceFilter !== 'all' ||
    triggerFilter !== 'all' ||
    scopeFilter !== 'all';
  // The first page of shared rows is still in flight, so "no pipelines" would
  // be premature.
  const sharedInitialLoading =
    cloudReady && sharedState.loading && sharedState.rows.length === 0;

  return (
    <div
      className="page-scroll-gutter h-full overflow-auto"
      data-testid="page-pipelines"
    >
      <PageTitlebar />
      <PageContent>
        <WorkflowsPageHeader
          actions={
            <div className="flex items-center gap-2">
              {headerAction}
              <Tooltip label="Refresh pipelines">
                <button
                  onClick={() => {
                    void onRefresh();
                    void onSharedRefresh();
                    if (cloudReady) curated.onRefresh();
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-lg border bg-secondary fg-secondary transition-colors hover:bg-accent-subtle hover:fg-primary focus-ring"
                  aria-label="Refresh pipelines"
                >
                  <RefreshSpinner spinning={loading} />
                </button>
              </Tooltip>
              <CreatePipelineSplitButton
                onStartInterview={onStartInterview}
                onBuildManually={onCreateNew}
                interviewPending={interviewPending}
                testIdPrefix="pipeline-create-new"
              />
            </div>
          }
        />

        <WorkflowsTabPanel>
          {/* Toolbar: search + filters */}
          <div className="mb-4 mt-4 flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pipelines…"
              data-testid="pipeline-search"
              className="focus-ring flex-1 min-w-45 rounded-lg border bg-base px-3 py-2 text-s fg-primary placeholder:fg-secondary"
            />
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              data-testid="pipeline-source-filter"
              aria-label="Filter by source"
              className="focus-ring rounded-lg ring-1 ring-inset ring-line-base bg-base px-2.5 py-2 text-s fg-primary"
            >
              <option value="all">All sources</option>
              {PIPELINE_SOURCES.filter((source) => source !== 'curated').map(
                (source) => (
                  <option key={source} value={source}>
                    {PIPELINE_SOURCE_META[source].label}
                  </option>
                ),
              )}
            </select>
            <select
              value={triggerFilter}
              onChange={(e) =>
                setTriggerFilter(parseTriggerFilter(e.target.value))
              }
              data-testid="pipeline-trigger-filter"
              aria-label="Filter by trigger type"
              className="focus-ring rounded-lg border bg-base px-2.5 py-2 text-s fg-primary"
            >
              <option value="all">All triggers</option>
              {TRIGGER_TYPES.map((trigger) => (
                <option key={trigger} value={trigger}>
                  {TRIGGER_META[trigger].label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-4">
            <select
              data-testid="pipeline-scope-filter"
              aria-label="Filter by execution scope"
              value={scopeFilter}
              onChange={(event) =>
                setScopeFilter(
                  PIPELINE_EXECUTION_SCOPES.find(
                    (scope) => scope === event.target.value,
                  ) ?? 'all',
                )
              }
              className="focus-ring rounded-lg ring-1 ring-inset ring-line-base bg-base px-2.5 py-2 text-s fg-primary"
            >
              <option value="all">All execution scopes</option>
              {PIPELINE_EXECUTION_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {PIPELINE_EXECUTION_SCOPE_META[scope].label}
                </option>
              ))}
            </select>
          </div>
          {/* Loading */}
          {loading && filtered.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <p className="text-s fg-secondary">Loading pipelines…</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-destructive-subtle border border-line-destructive/20 px-4 py-3 mb-6">
              <p className="text-s fg-destructive">{error}</p>
            </div>
          )}

          {actionError && (
            <div className="mb-6" data-testid="pipeline-list-action-error">
              <Notice intent="destructive">{actionError}</Notice>
            </div>
          )}

          {(!loading || filtered.length > 0) && (
            <>
              {/* Table */}
              {filtered.length > 0 && (
                <div
                  className="overflow-hidden overflow-x-auto rounded-lg border"
                  data-testid="pipelines-table"
                >
                  <table className="w-full min-w-225 table-fixed text-s">
                    <colgroup>
                      <col />
                      <col className="w-32" />
                      <col className="w-32" />
                      <col className="w-28" />
                      {/* Fits the widest row: 6 actions (toggle, share link,
                        edit/view, share, duplicate, delete) on a shared row
                        with delete rights =
                        6*26px + 5*2px gap + 24px cell padding = 190px. */}
                      <col className="w-52" />
                    </colgroup>
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="text-left px-3 py-2 font-medium fg-secondary">
                          Pipeline
                        </th>
                        <th className="text-left px-3 py-2 font-medium fg-secondary">
                          Source
                        </th>
                        <th className="text-left px-3 py-2 font-medium fg-secondary">
                          Scope
                        </th>
                        <th className="text-left px-3 py-2 font-medium fg-secondary">
                          Triggers
                        </th>
                        <th className="px-3 py-2 text-right whitespace-nowrap font-medium fg-secondary">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((p) => (
                        <PipelineTableRow
                          key={`${p.source}:${p.id}`}
                          pipeline={p}
                          enabled={!disabledPipelineIds.has(p.id)}
                          onToggleEnabled={(enabled) =>
                            onToggleEnabled(p.id, enabled)
                          }
                          onEdit={onEdit}
                          onDelete={() => handleRowDelete(p)}
                          onDuplicate={onDuplicate}
                          onShare={onShare}
                          sharePending={
                            sharePendingId === `${p.source}:${p.id}`
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div
                className="mt-4 flex flex-wrap items-center gap-3 text-xs fg-secondary"
                data-testid="pipeline-list-status"
              >
                <span>
                  {filtered.length} loaded{' '}
                  {filtered.length === 1 ? 'pipeline' : 'pipelines'}
                </span>
              </div>
              {/* No results from active filters */}
              {filtered.length === 0 &&
                allPipelines.length > 0 &&
                hasActiveFilters &&
                !sharedInitialLoading && (
                  <p className="py-12 text-center text-s fg-secondary">
                    No pipelines match the current filters.
                  </p>
                )}

              {/* Shared-cloud status + affordances */}
              {showShared && (
                <div className="mt-4" data-testid="shared-pipelines-section">
                  {cloudReady && showShared && (
                    <div className="flex items-center justify-between gap-2">
                      {sharedState.error ? (
                        <p className="text-xs fg-destructive">
                          {sharedState.error}
                        </p>
                      ) : sharedState.loading &&
                        sharedState.rows.length === 0 ? (
                        <p className="text-xs fg-secondary">
                          Loading shared pipelines…
                        </p>
                      ) : (
                        <span />
                      )}
                      <div className="flex items-center gap-3">
                        {sharedState.nextCursor && (
                          <button
                            type="button"
                            onClick={() => void onLoadMoreShared()}
                            disabled={sharedState.loadingMore}
                            className="rounded-lg border bg-secondary px-3 py-1.5 text-xs font-medium fg-secondary transition-colors hover:bg-accent-subtle hover:fg-primary disabled:opacity-50"
                          >
                            <BusyLabel busy={sharedState.loadingMore}>
                              Load more shared
                            </BusyLabel>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void onSharedRefresh()}
                          className="text-xs fg-secondary hover:fg-primary transition-colors"
                        >
                          Refresh shared
                        </button>
                      </div>
                    </div>
                  )}
                  {!cloudReady && !sharedState.cloudLoading && (
                    <div className="flex items-center gap-3">
                      <p className="text-xs fg-secondary">
                        No {brandText.appName} Cloud account configured — shared
                        and curated pipelines are unavailable.
                      </p>
                      <button
                        type="button"
                        onClick={onOpenAccountSettings}
                        className="rounded-md border bg-secondary px-3 py-1 text-xs font-medium fg-primary hover:bg-accent-subtle hover:fg-accent"
                      >
                        Open account settings
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Empty state: no pipelines from any source (and the shared
                first page isn't still loading). */}
              {filtered.length === 0 &&
                allPipelines.length === 0 &&
                !error &&
                !sharedInitialLoading && (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4">
                      <AppCatalogPipelineIcon
                        width="24"
                        height="24"
                        className="fg-secondary"
                      />
                    </div>
                    <h3 className="text-s font-medium fg-primary mb-1">
                      No pipelines yet
                    </h3>
                    <p className="text-xs fg-secondary mb-4">
                      Create your first pipeline to get started
                    </p>
                    <CreatePipelineSplitButton
                      onStartInterview={onStartInterview}
                      onBuildManually={onCreateNew}
                      interviewPending={interviewPending}
                      testIdPrefix="pipeline-empty-create-new"
                    />
                  </div>
                )}
            </>
          )}
          <PipelineTemplatesSection
            catalog={{
              ...curated,
              // The search box shows the text as typed; the hook requests and
              // filters with the trimmed text.
              query: { ...curated.query, q: templateQuery.q },
              rows: templateRows,
              cloudDisplayName: `${brandText.appName} Cloud`,
              launchAvailability: templateAvailability,
              onQueryChange: setTemplateQuery,
            }}
          />
        </WorkflowsTabPanel>
      </PageContent>
    </div>
  );
}

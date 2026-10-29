// ---------------------------------------------------------------------------
// Helpers for composing the row list rendered inside the Pipeline Trigger
// Modal's `select` step.
//
// The modal blends local definitions and remote catalog metadata:
//   - local `PipelineData` entries (fully hydrated, with `info` + `content`)
//   - shared `PipelineInfo` summaries (pulled from the Canopy Cloud singleton
//     list in `useSharedPipelineList`; not hydrated until the user selects
//     one)
//   - curated `PipelineInfo` metadata (managed content resolves on selection)
//
// Pulling the row construction into a pure helper keeps the rendering branch
// in `PipelineTriggerModal` thin and lets us unit-test the filter/ordering
// rules without spinning up the full modal (which depends on `window.api` and
// `window.pipelines`).
// ---------------------------------------------------------------------------
import type {
  PipelineData,
  PipelineExecutionScope,
  PipelineInfo,
  PipelineTriggerType,
} from '@canopy/desktop-shared/types/pipeline';
import { pipelineSupportsExecutionScope } from './pipelineExecutionScope';

export type PipelineTriggerSourceFilter =
  | 'all'
  | 'bundled'
  | 'user'
  | 'project'
  | 'shared'
  | 'curated';

/**
 * Discriminated row shape consumed by the unified list renderer.
 *
 * `local` rows carry the full `PipelineData` because the modal already
 * hydrated them up-front. `shared` rows carry only summary `PipelineInfo` —
 * hydration is deferred until selection so we don't waterfall N
 * `getShared` calls just to render the list. Curated rows also remain
 * metadata-only until the selected managed definition is requested.
 */
export type PipelineTriggerRow =
  | { kind: 'local'; info: PipelineInfo; data: PipelineData }
  | { kind: 'curated'; info: PipelineInfo }
  | {
      kind: 'shared';
      info: PipelineInfo;
      remoteId: string;
    };

/**
 * Whether the active `sourceFilter` should display shared rows alongside
 * locals. `all` blends; `shared` is shared-only; the others are local-only.
 */
export function shouldIncludeSharedRows(
  sourceFilter: PipelineTriggerSourceFilter,
): boolean {
  return sourceFilter === 'all' || sourceFilter === 'shared';
}

function matchesSearch(info: PipelineInfo, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = info.name.toLowerCase();
  const desc = (info.description ?? '').toLowerCase();
  return name.includes(q) || desc.includes(q);
}

/**
 * Build the unified row list for the modal's flat selector.
 *
 * Rules (per the Phase T8 spec, updated for the single Canopy Cloud
 * backend):
 *   - `all`: local rows first, then shared rows from the configured Canopy
 *     Cloud account. Local rows are filtered in-memory by `searchQuery`;
 *     shared rows are rendered from the singleton list state. The hook applies
 *     query and trigger filters server-side, and this helper defensively
 *     re-checks trigger metadata before rendering.
 *   - `bundled` / `user` / `project`: only local rows whose
 *     `info.source` matches, with the in-memory search applied.
 *   - `shared`: returns an empty array — the Shared filter is rendered
 *     through the dedicated `SharedPipelineSelector` rather than the unified
 *     flat list.
 *
 * The discriminator `kind` lets the renderer choose between the local and
 * shared click-handlers without re-deriving identity.
 */
export function buildCombinedTriggerRows(args: {
  localPipelines: readonly PipelineData[];
  sharedRows: readonly PipelineInfo[];
  curatedRows?: readonly PipelineInfo[];
  sourceFilter: PipelineTriggerSourceFilter;
  searchQuery: string;
  triggerType: PipelineTriggerType;
  /**
   * Pipeline ids the user has disabled. Disabled pipelines are excluded from
   * the picker entirely. Defaults to an empty set (nothing disabled).
   */
  disabledIds?: ReadonlySet<string>;
}): PipelineTriggerRow[] {
  const {
    localPipelines,
    sharedRows,
    curatedRows = [],
    sourceFilter,
    searchQuery,
    triggerType,
    disabledIds,
  } = args;

  if (sourceFilter === 'shared') {
    // The Shared filter is rendered by the dedicated selector, not by the
    // unified flat list. Returning [] keeps the unified renderer's empty
    // state out of the way when the user is on Shared.
    return [];
  }

  const trimmedQuery = searchQuery.trim();
  const isDisabled = (id: string): boolean => disabledIds?.has(id) ?? false;

  const localRows: PipelineTriggerRow[] = localPipelines
    .filter((p) => {
      if (isDisabled(p.info.id)) return false;
      if (sourceFilter !== 'all' && p.info.source !== sourceFilter) {
        return false;
      }
      return matchesSearch(p.info, trimmedQuery);
    })
    .map((data) => ({ kind: 'local', info: data.info, data }));

  const curatedTriggerRows: PipelineTriggerRow[] = curatedRows
    .filter(
      (info) =>
        !isDisabled(info.id) &&
        (sourceFilter === 'all' || sourceFilter === 'curated') &&
        info.triggerTypes?.includes(triggerType) &&
        matchesSearch(info, trimmedQuery),
    )
    .map((info) => ({ kind: 'curated', info }));

  if (!shouldIncludeSharedRows(sourceFilter)) {
    return [...localRows, ...curatedTriggerRows];
  }

  const sharedTriggerRows: PipelineTriggerRow[] = [];
  for (const info of sharedRows) {
    if (!info.remoteId) continue;
    if (isDisabled(info.id)) continue;
    if (info.triggerTypes && !info.triggerTypes.includes(triggerType)) {
      continue;
    }
    sharedTriggerRows.push({
      kind: 'shared',
      info,
      remoteId: info.remoteId,
    });
  }

  return [...localRows, ...sharedTriggerRows, ...curatedTriggerRows];
}

/**
 * Filter trigger rows down to those compatible with the surface's execution
 * scope, using the SAME capability relation as the runtime gate
 * (`pipelineSupportsExecutionScope` → `executionContextSatisfies`).
 *
 * This deliberately does NOT use strict `info.scopes.includes(scope)`: a
 * `worktree` surface keeps showing `directory`-only and legacy no-`scope`
 * pipelines (a worktree provides a directory cwd), while a pure
 * `directory`/`global` surface hides `worktree`-only pipelines. Rows whose
 * `info.scopes` is missing are treated as `['directory']`.
 */
export function filterTriggerRowsByExecutionScope(
  rows: readonly PipelineTriggerRow[],
  executionScope: PipelineExecutionScope,
): PipelineTriggerRow[] {
  return rows.filter((row) =>
    pipelineSupportsExecutionScope(row.info, executionScope),
  );
}

/**
 * Filter raw shared `PipelineInfo` summaries (the dedicated Shared tab renders
 * these directly, not as `PipelineTriggerRow`s) by execution scope using the
 * same capability relation as {@link filterTriggerRowsByExecutionScope}.
 */
export function filterPipelineInfosByExecutionScope(
  infos: readonly PipelineInfo[],
  executionScope: PipelineExecutionScope,
): PipelineInfo[] {
  return infos.filter((info) =>
    pipelineSupportsExecutionScope(info, executionScope),
  );
}

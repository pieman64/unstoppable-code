import type {
  CuratedPipelineListQuery,
  CuratedPipelineSummary,
} from '@canopy/protocol/pipeline-catalog';

/**
 * Narrows already-loaded catalog metadata by a search text, the way the
 * catalog service matches `q`: a case-insensitive substring of the name, the
 * short description, or the key. An empty search keeps every row in order.
 */
export function filterCuratedPipelinesBySearch(
  rows: readonly CuratedPipelineSummary[],
  search: string | undefined,
): CuratedPipelineSummary[] {
  const needle = search?.trim().toLowerCase() ?? '';
  if (needle === '') return [...rows];
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      row.shortDescription.toLowerCase().includes(needle) ||
      row.key.toLowerCase().includes(needle),
  );
}

/**
 * Applies every catalog query filter to already-loaded metadata: the search
 * text plus category, trigger and scope. Used where the host holds the rows
 * locally instead of asking the catalog service for a filtered page.
 */
export function filterCuratedPipelines(
  rows: readonly CuratedPipelineSummary[],
  query: CuratedPipelineListQuery,
): CuratedPipelineSummary[] {
  return filterCuratedPipelinesBySearch(rows, query.q).filter(
    (row) =>
      (!query.category || row.categories.includes(query.category)) &&
      (!query.triggerType || row.triggerTypes.includes(query.triggerType)) &&
      (!query.scope || row.scopes.includes(query.scope)),
  );
}

/** Whether a catalog query narrows the list beyond its default first page. */
export function curatedPipelineFiltersActive(
  query: CuratedPipelineListQuery,
): boolean {
  return Boolean(
    query.q?.trim() || query.category || query.triggerType || query.scope,
  );
}

/**
 * Whether two catalog queries list the same rows, ignoring the page size and
 * cursor, so a host can skip refetching an unchanged query.
 */
export function sameCuratedPipelineFilters(
  a: CuratedPipelineListQuery,
  b: CuratedPipelineListQuery,
): boolean {
  return (
    (a.q?.trim() ?? '') === (b.q?.trim() ?? '') &&
    (a.category ?? '') === (b.category ?? '') &&
    a.triggerType === b.triggerType &&
    a.scope === b.scope
  );
}

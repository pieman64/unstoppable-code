import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { CuratedPipelineCatalogProps } from '@canopy/ui-shared';
import type {
  CuratedPipelineDetail,
  CuratedPipelineListQuery,
  CuratedPipelineSummary,
} from '@canopy/protocol/pipeline-catalog';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';

interface UseCuratedPipelinesOptions extends CuratedPipelineListQuery {
  enabled?: boolean;
  onImported?: () => void;
  onOpenImported?: (id: string) => void;
}

export interface CuratedPipelinesController extends Omit<
  CuratedPipelineCatalogProps,
  'cloudDisplayName'
> {
  onSelectKey: (key: string) => void;
}

/** Metadata pages are independent of runnable pipelines. Content is selected explicitly. */
export function useCuratedPipelines({
  q,
  category,
  triggerType,
  scope,
  enabled = true,
  onImported,
  onOpenImported,
}: UseCuratedPipelinesOptions = {}): CuratedPipelinesController {
  const query = useMemo<CuratedPipelineListQuery>(
    () => ({
      limit: 25,
      q: q?.trim() || undefined,
      category,
      triggerType,
      scope,
    }),
    [q, category, triggerType, scope],
  );
  const [rows, setRows] = useState<CuratedPipelineSummary[]>([]);
  const [loading, setLoading] = useState(false);
  // A changed query is a pending read from the render that changed it, not
  // only once the fetching effect runs: until then its rows are the previous
  // query's, and an empty list would read as an empty catalog.
  const [requestedQuery, setRequestedQuery] = useState(query);
  if (requestedQuery !== query) {
    setRequestedQuery(query);
    if (enabled) setLoading(true);
  }
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<CuratedPipelineDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedPipelineId, setImportedPipelineId] = useState<string | null>(
    null,
  );
  const [accountEpoch, setAccountEpoch] = useState(0);
  const ownershipSequence = useRef(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const importSequence = useRef(0);

  const clearDetail = useCallback((): void => {
    detailSequence.current += 1;
    importSequence.current += 1;
    setSelectedKey(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    setImportError(null);
    setImportedPipelineId(null);
    setImporting(false);
  }, []);

  useEffect(() => {
    const changed = (): void => {
      ownershipSequence.current += 1;
      listSequence.current += 1;
      setRows([]);
      setNextCursor(null);
      setError(null);
      setStale(false);
      clearDetail();
      setAccountEpoch((value) => value + 1);
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    return (): void => {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
      ownershipSequence.current += 1;
      listSequence.current += 1;
      detailSequence.current += 1;
      importSequence.current += 1;
    };
  }, [clearDetail]);

  const fetchPage = useCallback(
    async (cursor?: string, forceRefresh = false): Promise<void> => {
      const sequence = ++listSequence.current;
      setLoading(true);
      setError(null);
      try {
        const clientSearch = Boolean(query.q) && cursor === undefined;
        const requestQuery = clientSearch
          ? { ...query, q: undefined, limit: 100 }
          : query;
        const pages: CuratedPipelineSummary[] = [];
        const seenCursors = new Set<string>();
        let requestCursor: string | null | undefined = cursor;
        let nextPageCursor: string | null = null;
        let pageIsStale = false;
        while (requestCursor !== null) {
          const result = await window.pipelines.listCurated({
            ...requestQuery,
            cursor: requestCursor,
            forceRefresh,
          });
          if (listSequence.current !== sequence) return;
          if (!result.success || !result.data)
            throw new Error(
              result.error ?? 'Unable to load curated pipelines.',
            );
          pages.push(...result.data.data);
          pageIsStale ||= result.data.stale;
          nextPageCursor = result.data.nextCursor;
          if (!clientSearch || !nextPageCursor) {
            requestCursor = null;
            continue;
          }
          if (seenCursors.has(nextPageCursor))
            throw new Error('Invalid curated pipeline pagination response.');
          seenCursors.add(nextPageCursor);
          requestCursor = nextPageCursor;
        }
        setRows((previous) =>
          cursor
            ? [
                ...previous.filter(
                  (row) => !pages.some((next) => next.key === row.key),
                ),
                ...pages,
              ]
            : pages,
        );
        setNextCursor(clientSearch ? null : nextPageCursor);
        setStale(pageIsStale);
      } catch (failure) {
        if (listSequence.current === sequence) {
          // Keep already loaded rows if a later page or refresh fails.
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      } finally {
        if (listSequence.current === sequence) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    listSequence.current += 1;
    setRows([]);
    setNextCursor(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timeout = setTimeout(() => {
      void fetchPage();
    }, 200);
    return (): void => {
      clearTimeout(timeout);
      listSequence.current += 1;
    };
  }, [fetchPage, accountEpoch, enabled]);

  const selectKey = useCallback(
    async (key: string): Promise<void> => {
      clearDetail();
      setSelectedKey(key);
      setDetailLoading(true);
      const sequence = ++detailSequence.current;
      try {
        const result = await window.pipelines.getCurated(key);
        if (detailSequence.current !== sequence) return;
        if (!result.success || !result.data)
          throw new Error(result.error ?? 'Unable to preview this pipeline.');
        setDetail(result.data);
      } catch (failure) {
        if (detailSequence.current === sequence)
          setDetailError(
            failure instanceof Error ? failure.message : String(failure),
          );
      } finally {
        if (detailSequence.current === sequence) setDetailLoading(false);
      }
    },
    [clearDetail],
  );

  const add = async (selected: CuratedPipelineDetail): Promise<void> => {
    const sequence = ++importSequence.current;
    const owner = ownershipSequence.current;
    setImporting(true);
    setImportError(null);
    try {
      const result = await window.pipelines.importCurated({
        key: selected.key,
        expectedContentHash: selected.contentHash,
      });
      if (ownershipSequence.current !== owner) return;
      if (result.success && result.data) onImported?.();
      if (importSequence.current !== sequence) return;
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Unable to add this pipeline.');
      setImportedPipelineId(result.data.id);
    } catch (failure) {
      if (importSequence.current === sequence)
        setImportError(
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      if (importSequence.current === sequence) setImporting(false);
    }
  };

  const download = (selected: CuratedPipelineDetail): void => {
    const url = URL.createObjectURL(
      new Blob([selected.rawPipeline], {
        type: 'application/yaml;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${selected.key}.yaml`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return {
    rows,
    query,
    onQueryChange: () => undefined,
    loading,
    error,
    stale,
    nextCursor,
    onRefresh: (): void => {
      if (!enabled) return;
      clearDetail();
      void fetchPage(undefined, true);
    },
    onLoadMore: (): void => {
      if (nextCursor && !loading) void fetchPage(nextCursor);
    },
    selectedKey,
    detail,
    detailLoading,
    detailError,
    onSelect: (row): void => {
      void selectKey(row.key);
    },
    onSelectKey: (key): void => {
      void selectKey(key);
    },
    onDownload: download,
    onBack: clearDetail,
    onImport: (selected): void => {
      void add(selected);
    },
    importing,
    importError,
    importedPipelineId,
    onOpenImported,
  };
}

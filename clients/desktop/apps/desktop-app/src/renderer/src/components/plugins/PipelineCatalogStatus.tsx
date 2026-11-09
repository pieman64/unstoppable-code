import type { JSX } from 'react';
import { CuratedCatalogNotice } from '@canopy/ui-shared';
import { brandText } from '@/lib/brand';
import type { CuratedPipelinesController } from '../../hooks/useCuratedPipelines';
import { BusyLabel, Button } from '@canopy/ui-shared/components';

interface PipelineCatalogStatusProps {
  /** Undefined while the Source filter excludes curated pipelines. */
  readonly curated: CuratedPipelinesController | undefined;
  readonly sharedNextCursor: string | null;
  readonly sharedLoadingMore: boolean;
  readonly onLoadMoreShared: () => void;
}

/**
 * What the Pipelines tab says under its list: a saved-catalog or load-failure
 * notice when one applies, and one control for the next page of every catalog
 * that has one. Pages load on their own; nothing here asks the user to count
 * rows or refresh by hand.
 */
export function PipelineCatalogStatus({
  curated,
  sharedNextCursor,
  sharedLoadingMore,
  onLoadMoreShared,
}: PipelineCatalogStatusProps): JSX.Element | null {
  const curatedHasMore = Boolean(curated?.nextCursor) && !curated?.error;
  const hasMore = curatedHasMore || sharedNextCursor !== null;
  const loadingMore = sharedLoadingMore || (curatedHasMore && curated?.loading);
  const hasNotice = Boolean(curated?.error) || curated?.stale === true;

  if (!hasNotice && !hasMore) return null;
  return (
    <div
      data-testid="pipeline-catalog-status"
      className="flex flex-col items-start gap-4"
    >
      {hasMore && (
        <Button
          size="compact"
          data-testid="curated-pipeline-load-more"
          disabled={loadingMore}
          onClick={() => {
            if (curatedHasMore) curated?.onLoadMore();
            if (sharedNextCursor !== null) onLoadMoreShared();
          }}
        >
          <BusyLabel busy={loadingMore === true}>Show more workflows</BusyLabel>
        </Button>
      )}
      {curated && (
        <CuratedCatalogNotice
          error={curated.error ?? null}
          stale={curated.stale === true}
          onRetry={curated.onRefresh}
          cloudDisplayName={`${brandText.appName} Cloud`}
        />
      )}
    </div>
  );
}

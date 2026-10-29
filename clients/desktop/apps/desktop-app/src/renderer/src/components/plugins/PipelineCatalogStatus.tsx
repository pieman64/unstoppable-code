import type { JSX } from 'react';
import {
  Notice,
  NoticeButton,
  curatedPipelineStaleMessage,
} from '@canopy/ui-shared';
import { SECONDARY_ACTION_BUTTON_CLASS } from '@canopy/ui-shared/lib/row-chips';
import { brandText } from '@/lib/brand';
import type { CuratedPipelinesController } from '../../hooks/useCuratedPipelines';
import { BusyLabel } from '@canopy/ui-shared/components';

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
  const notice = curated?.error ? (
    <Notice
      intent="destructive"
      role="none"
      title="Couldn't load curated pipelines."
      data-testid="plugins-curated-pipelines-error"
      actions={<NoticeButton onClick={curated.onRefresh}>Retry</NoticeButton>}
    >
      {curated.error}
    </Notice>
  ) : curated?.stale ? (
    <Notice
      intent="neutral"
      role="none"
      data-testid="plugins-curated-pipelines-stale"
    >
      {curatedPipelineStaleMessage(`${brandText.appName} Cloud`)}
    </Notice>
  ) : null;

  if (!notice && !hasMore) return null;
  return (
    <div
      data-testid="pipeline-catalog-status"
      className="mt-6 flex flex-col items-start gap-4"
    >
      {hasMore && (
        <button
          type="button"
          data-testid="curated-pipeline-load-more"
          disabled={loadingMore}
          onClick={() => {
            if (curatedHasMore) curated?.onLoadMore();
            if (sharedNextCursor !== null) onLoadMoreShared();
          }}
          className={SECONDARY_ACTION_BUTTON_CLASS}
        >
          <BusyLabel busy={loadingMore === true}>Show more pipelines</BusyLabel>
        </button>
      )}
      {notice}
    </div>
  );
}

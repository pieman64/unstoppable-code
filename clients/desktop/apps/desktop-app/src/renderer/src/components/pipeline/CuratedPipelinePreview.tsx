import type { JSX, ReactNode } from 'react';
import {
  CuratedPipelineCatalog,
  DialogModal,
  type CuratedPipelineCatalogProps,
} from '@canopy/ui-shared';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';

export interface CuratedPipelinePreviewProps {
  catalog: Omit<CuratedPipelineCatalogProps, 'cloudDisplayName'>;
  breadcrumbs?: ReactNode;
}

/** Only selected content is mounted; discovery stays in the host's unified list. */
export function CuratedPipelinePreview({
  catalog,
  breadcrumbs,
}: CuratedPipelinePreviewProps): JSX.Element | null {
  useCurrentUiStateReporter(
    'pipelines.curatedPreview',
    catalog.selectedKey
      ? {
          open: true,
          key: catalog.selectedKey,
          loading: catalog.detailLoading === true,
          errorVisible: Boolean(catalog.detailError),
        }
      : null,
  );
  if (!catalog.selectedKey) return null;
  return (
    <DialogModal
      title="Preview pipeline"
      onClose={catalog.onBack}
      maxWidth="3xl"
      dataTestId="curated-pipeline-preview-dialog"
    >
      {breadcrumbs}
      <CuratedPipelineCatalog
        {...catalog}
        cloudDisplayName={`${brandText.appName} Cloud`}
        rows={[]}
      />
    </DialogModal>
  );
}

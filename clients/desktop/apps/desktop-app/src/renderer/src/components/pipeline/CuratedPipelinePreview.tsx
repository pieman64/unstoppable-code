import type { JSX, ReactNode } from 'react';
import {
  CuratedPipelinePreviewDialog,
  type CuratedPipelineCatalogProps,
  type SpaceRole,
} from '@canopy/ui-shared';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';

export interface CuratedPipelinePreviewProps {
  catalog: Omit<CuratedPipelineCatalogProps, 'cloudDisplayName'>;
  breadcrumbs?: ReactNode;
  breadcrumbsGap?: SpaceRole;
}

/** The shared preview dialog, reporting its state to the desktop's UI state. */
export function CuratedPipelinePreview({
  catalog,
  breadcrumbs,
  breadcrumbsGap,
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
  return (
    <CuratedPipelinePreviewDialog
      catalog={{ ...catalog, cloudDisplayName: `${brandText.appName} Cloud` }}
      breadcrumbs={breadcrumbs}
      breadcrumbsGap={breadcrumbsGap}
    />
  );
}

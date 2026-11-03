'use client';

import type { JSX, ReactNode } from 'react';
import {
  CuratedPipelineCatalog,
  type CuratedPipelineCatalogProps,
} from './CuratedPipelineCatalog';
import { DialogModal } from './DialogModal';

export interface CuratedPipelinePreviewDialogProps {
  catalog: CuratedPipelineCatalogProps;
  breadcrumbs?: ReactNode;
}

/**
 * The preview a curated pipeline row opens from a Browse list. Only the
 * selected template mounts; discovery stays in the host's unified list.
 */
export function CuratedPipelinePreviewDialog({
  catalog,
  breadcrumbs,
}: CuratedPipelinePreviewDialogProps): JSX.Element | null {
  if (!catalog.selectedKey) return null;
  return (
    <DialogModal
      title="Preview workflow"
      onClose={catalog.onBack}
      maxWidth="3xl"
      dataTestId="curated-pipeline-preview-dialog"
    >
      <div className="">
        {breadcrumbs}
        <CuratedPipelineCatalog {...catalog} rows={[]} />
      </div>
    </DialogModal>
  );
}

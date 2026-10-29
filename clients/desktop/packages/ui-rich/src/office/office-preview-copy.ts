/** Hosts supply complete recovery sentences. */
export interface OfficePreviewCopy {
  readonly banner: string;
  readonly truncationRecovery: string;
}

export type OfficePreviewRenderFailure = 'parse-failed';

export const DEFAULT_OFFICE_PREVIEW_COPY: OfficePreviewCopy = {
  banner:
    'Semantic preview: formatting may differ; download for the exact document.',
  truncationRecovery: 'Download the workbook to see everything.',
};

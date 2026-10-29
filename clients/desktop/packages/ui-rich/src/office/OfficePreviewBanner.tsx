import type { JSX } from 'react';

import { DEFAULT_OFFICE_PREVIEW_COPY } from './office-preview-copy';

export const OFFICE_PREVIEW_BANNER_TEXT = DEFAULT_OFFICE_PREVIEW_COPY.banner;

export interface OfficePreviewBannerProps {
  readonly text: string;
}

export function OfficePreviewBanner({
  text,
}: OfficePreviewBannerProps): JSX.Element {
  return (
    <div
      role="note"
      className="shrink-0 border-b px-3 py-1.5 text-xs fg-secondary"
      data-testid="office-preview-banner"
    >
      {text}
    </div>
  );
}

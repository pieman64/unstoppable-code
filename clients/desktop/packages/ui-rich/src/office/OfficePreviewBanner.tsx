import type { JSX } from 'react';

import { DEFAULT_OFFICE_PREVIEW_COPY } from './office-preview-copy';
import { Surface } from '@canopy/ui-shared/components';

export const OFFICE_PREVIEW_BANNER_TEXT = DEFAULT_OFFICE_PREVIEW_COPY.banner;

export interface OfficePreviewBannerProps {
  readonly text: string;
}

export function OfficePreviewBanner({
  text,
}: OfficePreviewBannerProps): JSX.Element {
  return (
    <Surface variant="section" boundary="bottom" className="shrink-0">
      <div
        role="note"
        className="shrink-0 px-3 py-1.5 text-xs fg-secondary"
        data-testid="office-preview-banner"
      >
        {text}
      </div>
    </Surface>
  );
}

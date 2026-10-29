import type { JSX, SVGProps } from 'react';
import { CircleStopIcon as AppCatalogCircleStopIcon } from './AppIcons';

/** Circle-and-square glyph used for stopping an active chat generation. */
export function StopGenerationIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return (
    <AppCatalogCircleStopIcon
      width="16"
      height="16"
      aria-hidden="true"
      {...props}
    />
  );
}

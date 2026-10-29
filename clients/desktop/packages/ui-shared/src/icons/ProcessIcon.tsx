import type { JSX, SVGProps } from 'react';
import { ProcessIcon as AppCatalogProcessIcon } from './AppIcons';

/**
 * Agent background-processes glyph. SVG paths mirror the desktop
 * `BackgroundProcessesSection`'s embedded `ProcessIcon` exactly (a bordered
 * console with three log lines), rendered at 14×14 over the source
 * `0 0 24 24` viewBox so the shared activity rail matches the desktop header.
 */
export function ProcessIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogProcessIcon width="14" height="14" {...props} />;
}

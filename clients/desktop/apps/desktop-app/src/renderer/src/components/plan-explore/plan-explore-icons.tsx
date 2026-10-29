import type { JSX, SVGProps } from 'react';
import {
  MapIcon as AppCatalogMapIcon,
  ChangeDiagramIcon as AppCatalogChangeDiagramIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * Shared Explore-modal glyphs. `MapIcon` doubles as the "search plan" toggle
 * and the document-source comment indicator; `DiagramIcon` doubles as the
 * "search diagram" toggle and the diagram-source comment indicator.
 */

/** Folded-map glyph for the plan document (no shared map icon exists). */
export function MapIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogMapIcon width="14" height="14" {...props} />;
}

/** Three connected nodes glyph for the diagram. */
export function DiagramIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogChangeDiagramIcon width="14" height="14" {...props} />;
}

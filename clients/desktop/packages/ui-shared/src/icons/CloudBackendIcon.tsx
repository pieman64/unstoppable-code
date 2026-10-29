import type { JSX, SVGProps } from 'react';
import { Cloud as AppCatalogCloud } from './AppIcons';

/**
 * Backend pip glyph for rows that execute remotely: a plain cloud outline.
 *
 * Counterpart to {@link DeviceBackendIcon}, and brand-neutral for the same
 * reason — it depicts WHERE work runs, not the hosted product's identity.
 */
export function CloudBackendIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogCloud width="14" height="14" aria-hidden="true" {...props} />
  );
}

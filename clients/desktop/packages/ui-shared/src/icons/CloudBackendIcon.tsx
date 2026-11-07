import type { JSX } from 'react';
import { Cloud as AppCatalogCloud, type AppIconProps } from './AppIcons';

/**
 * Backend pip glyph for rows that execute remotely: a plain cloud outline.
 *
 * Counterpart to {@link DeviceBackendIcon}, and brand-neutral for the same
 * reason — it depicts WHERE work runs, not the hosted product's identity.
 */
export function CloudBackendIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogCloud size="sm" aria-hidden="true" {...props} />;
}

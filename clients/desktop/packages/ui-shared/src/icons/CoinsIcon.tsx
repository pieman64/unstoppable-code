import type { JSX, SVGProps } from 'react';
import { CoinsIcon as AppCatalogCoinsIcon } from './AppIcons';

/**
 * Stacked-coins glyph for AI credit balances and grants.
 *
 * Drawn in the 24×24 / `fill="none"` / 2px `currentColor` stroke family shared
 * by `ArchiveIcon` and `GlobeIcon`, because it sits beside
 * them in the cloud sign-in benefit list — a filled Material glyph on a
 * `-960 960` viewBox would put two icon languages in one four-line list.
 */
export function CoinsIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogCoinsIcon width="14" height="14" aria-hidden="true" {...props} />
  );
}

import type { JSX, SVGProps } from 'react';
import { ThumbsDownIcon as AppCatalogThumbsDownIcon } from './AppIcons';

/**
 * Thumbs-down glyph for turn-level feedback (CAN-1521).
 *
 * `{...props}` is spread last so a caller can override `fill` — the selected
 * state renders `fill="currentColor"` while the resting state stays outlined.
 */
export function ThumbsDownIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogThumbsDownIcon width="14" height="14" {...props} />;
}

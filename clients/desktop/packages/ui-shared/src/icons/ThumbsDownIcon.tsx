import type { JSX } from 'react';
import {
  ThumbsDownIcon as AppCatalogThumbsDownIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Thumbs-down glyph for turn-level feedback (CAN-1521).
 *
 * `{...props}` is spread last so a caller can override `fill` — the selected
 * state renders `fill="currentColor"` while the resting state stays outlined.
 */
export function ThumbsDownIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogThumbsDownIcon size="sm" {...props} />;
}

import type { JSX } from 'react';
import {
  ThumbsUpIcon as AppCatalogThumbsUpIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Thumbs-up glyph for turn-level feedback (CAN-1521).
 *
 * `{...props}` is spread last so a caller can override `fill` — the selected
 * state renders `fill="currentColor"` while the resting state stays outlined.
 */
export function ThumbsUpIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogThumbsUpIcon size="sm" {...props} />;
}

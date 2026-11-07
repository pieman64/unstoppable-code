import type { JSX } from 'react';
import {
  MentionIcon as AppCatalogMentionIcon,
  type AppIconProps,
} from './AppIcons';

/** The shared desktop and web @-mention glyph. */
export function MentionIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMentionIcon size="sm" aria-hidden="true" {...props} />;
}

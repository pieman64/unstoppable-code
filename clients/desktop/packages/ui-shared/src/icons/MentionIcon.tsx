import type { JSX, SVGProps } from 'react';
import { MentionIcon as AppCatalogMentionIcon } from './AppIcons';

/** The shared desktop and web @-mention glyph. */
export function MentionIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogMentionIcon
      width="12"
      height="12"
      aria-hidden="true"
      {...props}
    />
  );
}

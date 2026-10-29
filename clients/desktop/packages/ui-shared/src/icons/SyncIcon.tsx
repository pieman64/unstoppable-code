import type { JSX, SVGProps } from 'react';
import { SyncIcon as AppCatalogSyncIcon } from './AppIcons';

/**
 * The classic two-arrow circular "sync" glyph. Used to represent cloud
 * synchronization state (e.g. the sidebar sync status pill).
 */
export function SyncIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogSyncIcon width="14" height="14" {...props} />;
}

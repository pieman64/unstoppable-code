// The row's appearance now lives in `@canopy/ui-shared`, so the desktop
// sidebar and the shared `SidebarSurface` the web portal renders cannot drift
// apart again. Re-exported rather than re-pointed at every call site, which
// keeps this module the one place desktop sidebar styling is named.
export {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
  SIDEBAR_LIST_ITEM_CLASSNAME,
  SIDEBAR_LIST_ICON_CLASSNAME,
  SIDEBAR_NAV_ITEM_CLASSNAME,
  SIDEBAR_NAV_ICON_CLASSNAME,
} from '@canopy/ui-shared/components';

import {
  SIDEBAR_LIST_ICON_CLASSNAME as LIST_ICON,
  SIDEBAR_LIST_ITEM_CLASSNAME as LIST_ITEM,
} from '@canopy/ui-shared/components';

export const SIDEBAR_FOOTER_ITEM_CLASSNAME = `${LIST_ITEM} fg-secondary`;
export const SIDEBAR_FOOTER_ICON_CLASSNAME = `${LIST_ICON} fg-quaternary`;

export const APP_STATUS_ITEM_CLASSNAME =
  'focus-ring group flex h-7 min-w-0 items-center justify-start gap-1.5 whitespace-nowrap rounded-md text-left text-2xs font-normal';
export const APP_STATUS_ICON_CLASSNAME =
  'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center fg-secondary';
export const APP_STATUS_LABEL_CLASSNAME =
  'fg-secondary transition-colors duration-150 group-hover:fg-primary';

/** Shared visual treatment for interactive controls in the sidebar titlebar. */
export const TITLEBAR_CONTROL_FOREGROUND_CLASSNAME = 'titlebar-control-fg';
export const TITLEBAR_BUTTON_BASE_CLASSNAME = `electron-no-drag focus-ring inline-flex h-7 shrink-0 items-center justify-center rounded-md px-1.5 ${TITLEBAR_CONTROL_FOREGROUND_CLASSNAME} transition-colors`;
export const TITLEBAR_BUTTON_CLASSNAME = `${TITLEBAR_BUTTON_BASE_CLASSNAME} hover:bg-subtle`;

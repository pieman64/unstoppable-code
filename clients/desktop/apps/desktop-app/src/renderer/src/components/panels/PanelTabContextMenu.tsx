import { type JSX } from 'react';
import {
  PanelTabContextMenu as SharedPanelTabContextMenu,
  type PanelTabContextMenuProps as SharedPanelTabContextMenuProps,
} from '@canopy/ui-app/panel-tab-context-menu';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';

export type PanelTabContextMenuProps = SharedPanelTabContextMenuProps;
export type { PanelTabContextMenuTarget } from '@canopy/ui-app/panel-tab-context-menu';

export function PanelTabContextMenu(
  props: PanelTabContextMenuProps,
): JSX.Element | null {
  return (
    <SharedPanelTabContextMenu
      {...props}
      openInFileManagerLabel={
        props.openInFileManagerLabel ?? pt(uiText.fileManager.openItem)
      }
    />
  );
}

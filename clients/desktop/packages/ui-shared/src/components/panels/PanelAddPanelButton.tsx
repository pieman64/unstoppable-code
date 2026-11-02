import type { JSX } from 'react';
import type { PanelTabBarAddTab } from './PanelTabBar';
import { ListAddIcon } from '../../icons/AppIcons';
import { TitlebarIconButton } from '../TitlebarIconButton';

export interface PanelAddPanelButtonProps {
  groupId: string;
  addPanel: NonNullable<PanelTabBarAddTab['addPanel']>;
}

/**
 * The `Add panel` affordance: opens the app-supplied panel catalog. Rendered
 * in the title bar's RIGHT cluster (beside the group chrome), unlike the `+`
 * add-tab button which hugs the last tab.
 */
export function PanelAddPanelButton({
  groupId,
  addPanel,
}: PanelAddPanelButtonProps): JSX.Element {
  return (
    <div className="canopy-panel-add-tab-root">
      <TitlebarIconButton
        surface="panelTabStrip"
        data-testid={`panel-add-panel-${groupId}`}
        icon={ListAddIcon}
        aria-label={addPanel.label}
        title={addPanel.label}
        aria-haspopup="menu"
        aria-expanded={addPanel.menu !== undefined}
        onClick={(): void => {
          addPanel.onAddPanel(groupId);
        }}
      />
      {addPanel.menu}
    </div>
  );
}

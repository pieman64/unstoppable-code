import type { JSX } from 'react';
import type { PanelTabBarAddTab } from './PanelTabBar';
import { PlusMediumIcon, SquarePlusIcon } from '../../icons/AppIcons';
import { TitlebarIconButton } from '../TitlebarIconButton';

export interface PanelAddTabButtonProps {
  groupId: string;
  addTab: PanelTabBarAddTab;
}

/**
 * The `+` add-tab affordance: a button plus the app-supplied open menu node,
 * anchored in a `position: relative` wrapper. Shared by the expanded tab bar
 * ({@link PanelTabBar}) and the collapsed bar ({@link PanelCollapsedBar}) so
 * the `panel-add-tab-${groupId}` control renders identically in both states.
 */
export function PanelAddTabButton({
  groupId,
  addTab,
}: PanelAddTabButtonProps): JSX.Element {
  const direct = addTab.addChat;
  return (
    <div className="canopy-panel-add-tab-root">
      {/* Same shared 28px icon-button as the header's ••• / resource controls;
          the tab-strip surface adds the alignment and hover-target hooks the
          strip relies on. */}
      {!addTab.hidePrimary ? (
        <TitlebarIconButton
          surface="panelTabStrip"
          data-testid={`panel-add-tab-${groupId}`}
          icon={PlusMediumIcon}
          aria-label={direct?.label ?? addTab.label}
          title={direct?.label ?? addTab.label}
          // Menu semantics only when the `+` actually owns the catalog menu;
          // in direct New Chat mode the menu belongs to the separate Add panel
          // button and announcing a popup here would mislead assistive tech.
          {...(addTab.addPanel === undefined && direct === undefined
            ? {
                'aria-haspopup': 'menu' as const,
                'aria-expanded': addTab.menu !== undefined,
              }
            : {})}
          onClick={(): void => {
            (direct?.onAddChat ?? addTab.onAddTab)(groupId);
          }}
        />
      ) : null}
      {addTab.quickAdd ? (
        <TitlebarIconButton
          surface="panelTabStrip"
          data-testid={`panel-quick-add-${groupId}`}
          icon={SquarePlusIcon}
          aria-label={addTab.quickAdd.label}
          title={addTab.quickAdd.label}
          onClick={(): void => addTab.quickAdd?.onQuickAdd(groupId)}
        />
      ) : null}
      {addTab.menu}
    </div>
  );
}

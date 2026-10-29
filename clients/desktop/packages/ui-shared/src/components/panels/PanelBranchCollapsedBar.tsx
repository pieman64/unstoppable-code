import type { JSX, ReactNode } from 'react';
import type {
  PanelCollapseEdge,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelTabModel,
} from '../../panels/registry-types';
import { Tooltip } from '../Tooltip';
import {
  ChevronRightMediumIcon,
  ChevronDownMediumIcon,
  ChevronLeftMediumIcon,
  ChevronTopMediumIcon,
} from '../../icons/AppIcons';
import { clearPanelTabDrag, readPanelTabDrag } from './panel-dnd';

export interface PanelBranchCollapsedBarProps {
  groups: readonly PanelGroupModel[];
  edge: PanelCollapseEdge;
  callbacks: PanelIntentCallbacks;
  renderTabIcon?: (tab: PanelTabModel) => ReactNode;
  getTabTitle?: (tab: PanelTabModel) => string;
  renderTabTooltip?: (tab: PanelTabModel) => ReactNode | null;
}

/** A compact subtree retains separate, addressable groups in depth-first order. */
export function PanelBranchCollapsedBar({
  groups,
  edge,
  callbacks,
  renderTabIcon,
  getTabTitle,
  renderTabTooltip,
}: PanelBranchCollapsedBarProps): JSX.Element {
  const vertical = edge === 'left' || edge === 'right';
  const ExpandIcon =
    edge === 'left'
      ? ChevronRightMediumIcon
      : edge === 'right'
        ? ChevronLeftMediumIcon
        : edge === 'top'
          ? ChevronDownMediumIcon
          : ChevronTopMediumIcon;
  return (
    <div
      className={`canopy-panel-collapsed-bar canopy-panel-collapsed-bar-${vertical ? 'vertical' : 'horizontal'}`}
      style={{
        overflow: 'auto',
        alignItems: 'center',
        justifyContent: 'flex-start',
      }}
      data-testid={`panel-branch-bar-${groups[0]?.groupId}`}
      data-edge={edge}
    >
      {groups.map((group) => {
        const tabTitles = group.tabs
          .map((tab) => getTabTitle?.(tab) ?? tab.title)
          .join(', ');
        const label = tabTitles || 'Empty panel group';
        return (
          <div
            key={group.groupId}
            role="group"
            aria-label={label}
            className="ring-[length:var(--border-hairline)] ring-inset ring-line-base"
            style={{
              display: 'flex',
              flexDirection: vertical ? 'column' : 'row',
              alignItems: 'center',
              flexShrink: 0,
              padding: 4,
              gap: 2,
            }}
            onDragOver={(event) => {
              const dragged = readPanelTabDrag();
              // A move the layout owner would refuse is not a drop target.
              if (
                dragged !== null &&
                callbacks.canDropPanel?.(
                  dragged.panelId,
                  group.groupId,
                  'center',
                ) !== false
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onDrop={(event) => {
              const dragged = readPanelTabDrag();
              if (dragged === null) return;
              if (
                callbacks.canDropPanel?.(
                  dragged.panelId,
                  group.groupId,
                  'center',
                ) === false
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              clearPanelTabDrag();
              // The expand is incidental: it makes room for the dropped tab,
              // which then becomes active. The user never asked to see what
              // this group already contained, so layout owners must not treat
              // it as a reveal gesture.
              callbacks.onCollapseGroup?.(group.groupId, false, {
                gesture: 'move',
              });
              callbacks.onMovePanel(dragged.panelId, group.groupId, 'center');
            }}
          >
            <Tooltip label={`Expand ${label}`}>
              <button
                type="button"
                className="canopy-panel-collapsed-expand"
                data-testid={`panel-branch-expand-${group.groupId}`}
                aria-label={`Expand ${label}`}
                onClick={() =>
                  callbacks.onCollapseGroup?.(group.groupId, false)
                }
              >
                <ExpandIcon size={16} />
              </button>
            </Tooltip>
            {group.tabs.map((tab) => (
              <Tooltip
                key={tab.panelId}
                label={
                  renderTabTooltip?.(tab) ?? getTabTitle?.(tab) ?? tab.title
                }
              >
                <button
                  type="button"
                  className="canopy-panel-collapsed-tab"
                  data-testid={`panel-branch-tab-${tab.panelId}`}
                  aria-label={getTabTitle?.(tab) ?? tab.title}
                  onClick={() =>
                    callbacks.onExpandGroupToTab?.(group.groupId, tab.panelId)
                  }
                >
                  {renderTabIcon?.(tab) ?? tab.title.slice(0, 1)}
                </button>
              </Tooltip>
            ))}
          </div>
        );
      })}
    </div>
  );
}

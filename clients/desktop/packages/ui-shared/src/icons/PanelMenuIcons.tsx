import type { JSX } from 'react';
import {
  ArrowUpIcon,
  BackIcon,
  CloseIcon,
  ExternalIcon,
  ForwardIcon,
  MaximizeIcon,
} from './AppIcons';
import type { PanelSplitDirection } from '../panels/registry-types';

/**
 * Leading icons for the panel menus (a tab's right-click menu and a group's
 * "…" menu), so the same action reads the same in both.
 */
export function PanelSplitDirectionIcon({
  direction,
}: {
  direction: PanelSplitDirection;
}): JSX.Element {
  switch (direction) {
    case 'up':
      return <ArrowUpIcon />;
    case 'down':
      return <ArrowUpIcon className="rotate-180" />;
    case 'left':
      return <BackIcon />;
    case 'right':
      return <ForwardIcon />;
  }
}

export const PanelNewWindowIcon = ExternalIcon;
export const PanelFullScreenIcon = MaximizeIcon;
export const PanelCloseIcon = CloseIcon;

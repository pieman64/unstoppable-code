import {
  ChangeDiagramIcon,
  type AppIconProps,
} from '@canopy/ui-shared/icons/AppIcons';
import type { JSX } from 'react';

/**
 * The icon for diagrams (the change diagram, plan diagrams). Early access
 * draws connected nodes; off keeps the vibe-coding glyph. Resolved at render
 * time so static definitions (the panel registry) follow the switch.
 */
export function DiagramIcon(props: AppIconProps): JSX.Element {
  return <ChangeDiagramIcon {...props} />;
}

import { memo, type JSX } from 'react';
import {
  TerminalPanelSurface,
  type TerminalPanelHost,
} from '@canopy/ui-app/terminal';
import { brandText } from '@/lib/brand';
import {
  ensureTerminalPanelVisible,
  findTerminalPanelSource,
  getTerminalPanelBinding,
} from '@/lib/panels/terminal-panel-activation';
import { ensureLegacyTerminalPanelsMaterialized } from './terminalPanelMaterialization';
import { useDesktopTerminalHostCallbacks } from './useDesktopTerminalHostCallbacks';

export interface TerminalPanelSurfaceProps {
  projectId: string;
  worktreeId: string;
  panelId: string;
  terminalId?: string;
  /** Only the active terminal panel consumes worktree shortcut requests. */
  active?: boolean;
}

const host: TerminalPanelHost = {
  getBinding: getTerminalPanelBinding,
  bindTerminal: (worktreeKey, panelId, session): boolean => {
    const source = findTerminalPanelSource(worktreeKey, panelId);
    return (
      ensureTerminalPanelVisible(worktreeKey, source ?? undefined, {
        terminalId: session.id,
        title: session.title?.trim() || 'Terminal',
        focus: true,
      }) !== null
    );
  },
  prepareWorktree: ensureLegacyTerminalPanelsMaterialized,
};

const DesktopTerminalPanelSurface = memo(function DesktopTerminalPanelSurface(
  props: TerminalPanelSurfaceProps,
): JSX.Element {
  const callbacks = useDesktopTerminalHostCallbacks(
    props.projectId,
    props.worktreeId,
  );
  return (
    <TerminalPanelSurface
      {...props}
      {...callbacks}
      host={host}
      appName={brandText.appName}
    />
  );
});

export { DesktopTerminalPanelSurface as TerminalPanelSurface };

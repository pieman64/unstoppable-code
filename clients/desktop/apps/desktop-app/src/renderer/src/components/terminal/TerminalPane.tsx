'use client';

import { memo, type JSX } from 'react';
import {
  TerminalPane as SharedTerminalPane,
  type TerminalPaneProps as SharedTerminalPaneProps,
} from '@canopy/ui-app/terminal';
import { useDesktopTerminalHostCallbacks } from './useDesktopTerminalHostCallbacks';

export interface TerminalPaneProps extends Omit<
  SharedTerminalPaneProps,
  'onSendToChat' | 'getPathsForFiles'
> {
  /** Worktree whose editable chat should receive terminal selections. */
  projectId?: string;
  worktreeId?: string;
}

function DesktopTerminalPane({
  projectId,
  worktreeId,
  ...props
}: TerminalPaneProps): JSX.Element {
  const hostCallbacks = useDesktopTerminalHostCallbacks(projectId, worktreeId);
  return <SharedTerminalPane {...props} {...hostCallbacks} />;
}

export const TerminalPane = memo(DesktopTerminalPane);

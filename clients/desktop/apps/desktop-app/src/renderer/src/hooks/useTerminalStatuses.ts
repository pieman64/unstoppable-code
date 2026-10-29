import { useEffect, useState } from 'react';
import type { TerminalRunningChangedEvent } from '@canopy/desktop-shared/types';

export interface TerminalStatus {
  running: boolean;
  /** Foreground process name when running; `null` otherwise. */
  processName: string | null;
}

/**
 * Subscribe to `terminalRunningChanged` events scoped to one worktree and
 * return a `Map<terminalId, TerminalStatus>` capturing the latest known
 * running/process-name status per terminal.
 *
 * The hook also pings `terminal.list()` on mount so the main process re-emits
 * the current snapshot for every live terminal — otherwise we would not
 * receive any events until the next transition.
 */
export function useTerminalStatuses(
  projectId: string | null | undefined,
  worktreeId: string | null | undefined,
): Map<string, TerminalStatus> {
  const [statuses, setStatuses] = useState<Map<string, TerminalStatus>>(
    () => new Map(),
  );

  useEffect(() => {
    setStatuses(new Map());

    if (!projectId || !worktreeId) {
      return undefined;
    }

    const current = new Map<string, TerminalStatus>();
    const applyEvent = (event: TerminalRunningChangedEvent): void => {
      if (event.projectId !== projectId || event.worktreeId !== worktreeId) {
        return;
      }
      current.set(event.terminalId, {
        running: event.running,
        processName: event.processName,
      });
      setStatuses(new Map(current));
    };

    const unsubRunning = window.api.terminal.onRunningChanged(applyEvent);
    const unsubExit = window.api.terminal.onExit((event) => {
      if (event.projectId !== projectId || event.worktreeId !== worktreeId) {
        return;
      }
      if (current.delete(event.terminalId)) {
        setStatuses(new Map(current));
      }
    });
    void window.api.terminal.list().catch(() => {
      // Backend may be unavailable during early bootstrap; treat as a no-op.
    });

    return (): void => {
      unsubRunning();
      unsubExit();
    };
  }, [projectId, worktreeId]);

  return statuses;
}

import { useEffect, useState } from 'react';
import type { TerminalRunningChangedEvent } from '@canopy/desktop-shared/types';

/**
 * Subscribe to `terminalRunningChanged` events scoped to one worktree and
 * return whether any of that worktree's terminals currently has a running
 * foreground process.
 *
 * The underlying running-detector emits one event per transition per terminal;
 * this hook maintains an in-memory `Set<terminalId>` and returns `set.size > 0`.
 */
export function useTerminalRunning(
  projectId: string | null | undefined,
  worktreeId: string | null | undefined,
  terminalId?: string,
): boolean {
  const [anyRunning, setAnyRunning] = useState(false);

  useEffect(() => {
    setAnyRunning(false);

    if (!projectId || !worktreeId) {
      return undefined;
    }

    const running = new Set<string>();
    const applyEvent = (event: TerminalRunningChangedEvent): void => {
      if (event.projectId !== projectId || event.worktreeId !== worktreeId) {
        return;
      }
      if (terminalId !== undefined && event.terminalId !== terminalId) return;
      if (event.running) {
        running.add(event.terminalId);
      } else {
        running.delete(event.terminalId);
      }
      setAnyRunning(running.size > 0);
    };

    const unsubRunning = window.api.terminal.onRunningChanged(applyEvent);
    const unsubExit = window.api.terminal.onExit((event) => {
      if (event.projectId !== projectId || event.worktreeId !== worktreeId) {
        return;
      }
      if (terminalId !== undefined && event.terminalId !== terminalId) return;
      if (running.delete(event.terminalId)) {
        setAnyRunning(running.size > 0);
      }
    });
    void window.api.terminal.list().catch(() => {
      // Backend may be unavailable during early bootstrap; treat as a no-op.
    });

    return (): void => {
      unsubRunning();
      unsubExit();
    };
  }, [projectId, terminalId, worktreeId]);

  return anyRunning;
}

'use client';

import { useEffect, useRef } from 'react';
import {
  useTerminalActivityStore,
  isEnvironmentTerminalShutdown,
  isIntentionalTerminalShutdown,
  normalizeTerminalExitSignal,
  isShellProcessName,
  registerTerminalClientLifecycle,
  TOAST_THRESHOLD_MS,
} from '@canopy/app-state/terminal';
import type { TerminalKind } from '@canopy/protocol/terminal';

export interface TerminalCompletionNotice {
  terminalId: string;
  projectId: string;
  worktreeId: string;
  type: 'success' | 'error';
  message: string;
}
export interface TerminalCompletionNoticesOptions {
  isClaudeCodeTerminal: (event: {
    terminalId: string;
    kind?: TerminalKind;
  }) => boolean;
  onNotice: (notice: TerminalCompletionNotice) => void;
}

interface RunningTerminalSnapshot {
  processName: string | null;
  processStartedAt: number;
}

/**
 * Copy for an eligible command end. `exitCode` is the reported status, or
 * undefined for legacy producers (desktop), which keep the completion copy.
 */
function describeCommandEnd(
  processName: string | null,
  exitCode: number | undefined,
): Pick<TerminalCompletionNotice, 'type' | 'message'> {
  const subject = processName ? `Command "${processName}"` : 'Command';
  if (exitCode !== undefined && exitCode !== 0) {
    return {
      type: 'error',
      message: `${subject} failed (exit ${String(exitCode)})`,
    };
  }
  return { type: 'success', message: `${subject} completed` };
}

/** Completion eligibility and copy, independent of host notification/navigation UI. */
export function useTerminalCompletionNotices(
  options: TerminalCompletionNoticesOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(
    () =>
      registerTerminalClientLifecycle(({ client, isCurrent }): (() => void) => {
        const runningTerminals = new Map<string, RunningTerminalSnapshot>();
        const releases: Array<() => void> = [];
        const release = (): void => {
          const errors: unknown[] = [];
          for (const unsubscribe of releases.splice(0)) {
            try {
              unsubscribe();
            } catch (error: unknown) {
              errors.push(error);
            }
          }
          runningTerminals.clear();
          if (errors.length > 0) throw errors[0];
        };
        try {
          releases.push(
            client.subscribe('terminal.running-changed', (event): void => {
              if (!isCurrent()) return;
              if (event.kind === 'script') {
                runningTerminals.delete(event.terminalId);
                return;
              }
              if (optionsRef.current.isClaudeCodeTerminal(event)) {
                if (!event.running) {
                  runningTerminals.delete(event.terminalId);
                }
                return;
              }

              if (event.running) {
                const existingEntry = runningTerminals.get(event.terminalId);
                runningTerminals.set(event.terminalId, {
                  processName: event.processName,
                  processStartedAt:
                    existingEntry?.processStartedAt ?? Date.now(),
                });
                return;
              }

              // Forget the snapshot before any suppression so the next command
              // always starts a fresh timer.
              const previousEntry = runningTerminals.get(event.terminalId);
              runningTerminals.delete(event.terminalId);

              // User-initiated close suppression: skip the toast if the terminal id
              // was marked as a UI-driven close. (The store also clears this marker
              // in handleExit, but we read it here to keep both code paths defensive.)
              const activity = useTerminalActivityStore.getState();
              if (
                activity.userInitiatedCloseTerminalIds.has(event.terminalId)
              ) {
                return;
              }

              if (event.interruptedByUser === true) {
                return;
              }

              // Use the hook-local running snapshot so completion toasts do not
              // depend on the activity-store listener registration order.
              if (!previousEntry) {
                return;
              }
              const ranMs = Date.now() - previousEntry.processStartedAt;
              if (ranMs < TOAST_THRESHOLD_MS) return;

              const processName = previousEntry.processName;
              // Explicit commands can have shell names; only legacy foreground
              // observations need the idle-shell filter.
              if (
                event.exitCode === undefined &&
                isShellProcessName(processName)
              ) {
                return;
              }

              // An explicit null status is an unknown outcome (for example a
              // command that ended without a status mark), never a success.
              if (event.exitCode === null) {
                return;
              }

              optionsRef.current.onNotice({
                terminalId: event.terminalId,
                projectId: event.projectId,
                worktreeId: event.worktreeId,
                ...describeCommandEnd(processName, event.exitCode),
              });
            }),
          );

          releases.push(
            client.subscribe('terminal.exit', (event): void => {
              if (!isCurrent()) return;
              // The shell is gone: forget its command snapshot before any
              // suppression, so a restart under the same id cannot inherit the
              // old timer and a late idle event cannot report a command too.
              runningTerminals.delete(event.terminalId);
              if (event.kind === 'script') return;
              const signal = normalizeTerminalExitSignal(event.signal);
              // Intentional cleanup signals are filtered everywhere as defense-in-depth.
              if (isIntentionalTerminalShutdown(signal)) return;
              // Environment shutdowns (connection lost, project asleep) are
              // explained in the terminal panel, never notified.
              if (isEnvironmentTerminalShutdown(signal)) return;

              if (
                optionsRef.current.isClaudeCodeTerminal(event) &&
                signal === null &&
                event.exitCode === 0
              ) {
                return;
              }

              // User-initiated close suppression. We have to check this BEFORE the
              // store's handleExit clears the marker. Both this hook and the store
              // hook subscribe to the same event independently, so the order is not
              // guaranteed; we additionally guard via "missing entry plus signal" as
              // a fallback proxy for "already cleaned up by the close path".
              const activity = useTerminalActivityStore.getState();
              if (
                activity.userInitiatedCloseTerminalIds.has(event.terminalId)
              ) {
                return;
              }
              const worktreeKey = `${event.projectId}/${event.worktreeId}`;
              const existingEntry =
                activity.entriesByWorktree[worktreeKey]?.[event.terminalId];
              if (!existingEntry && signal !== null) {
                return;
              }

              let message: string;
              let type: 'success' | 'error';
              if (signal === null && event.exitCode === 0) {
                message = 'Terminal exited cleanly';
                type = 'success';
              } else if (signal !== null) {
                message = `Terminal killed (${signal})`;
                type = 'error';
              } else if (event.exitCode !== null && event.exitCode !== 0) {
                message = `Terminal exited with code ${String(event.exitCode)}`;
                type = 'error';
              } else {
                // Fall through: ambiguous (no signal, null exit code) — skip.
                return;
              }

              optionsRef.current.onNotice({
                terminalId: event.terminalId,
                projectId: event.projectId,
                worktreeId: event.worktreeId,
                type,
                message,
              });
            }),
          );
        } catch (error: unknown) {
          try {
            release();
          } catch {
            /* Preserve the acquisition failure. */
          }
          throw error;
        }
        return release;
      }),
    [],
  );
}

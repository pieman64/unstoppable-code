import { useCallback, useRef, useState } from 'react';
import type { SlashCommandOption } from '../types';

export interface PendingSlashCommandGate {
  /** The selection whose preparation is in flight; drives busy-row UI. */
  pendingCommand: SlashCommandOption | null;
  /**
   * Run one selection through the gate. Rows that need no preparation (no
   * gate configured, or not `section: 'available'`) insert synchronously.
   */
  selectCommand: (
    cmd: SlashCommandOption,
    insert: (cmd: SlashCommandOption) => void,
    isStale?: () => boolean,
  ) => void;
}

/**
 * Shared enable-before-insert gate for the two slash selection surfaces (the
 * inline `/` typeahead menu and the Commands popup). An `available` row must
 * be enabled on the host before its invocation text may enter the composer,
 * so selection runs `prepare` first and inserts only on success:
 *
 * - ONE selection may be pending per surface at a time; selections made while
 *   pending are ignored (single re-entrancy guard).
 * - `prepare` returning `false`, rejecting, or throwing synchronously means
 *   no insert; the host owns any error surface.
 * - `isStale` is sampled after `prepare` resolves; a surface whose context
 *   moved on (e.g. the slash trigger was retargeted or dismissed) reports
 *   stale and the insert is dropped.
 */
export function usePendingSlashCommand(
  prepare?: (cmd: SlashCommandOption) => boolean | Promise<boolean>,
): PendingSlashCommandGate {
  // Token identity (not a boolean) so a stray late resolution can never clear
  // a newer selection's pending state.
  const pendingRef = useRef<symbol | null>(null);
  const [pendingCommand, setPendingCommand] =
    useState<SlashCommandOption | null>(null);

  const selectCommand = useCallback(
    (
      cmd: SlashCommandOption,
      insert: (cmd: SlashCommandOption) => void,
      isStale?: () => boolean,
    ): void => {
      if (prepare === undefined || cmd.section !== 'available') {
        insert(cmd);
        return;
      }
      if (pendingRef.current !== null) return;
      const token = Symbol('pending-slash-command');
      pendingRef.current = token;
      setPendingCommand(cmd);
      void Promise.resolve()
        .then(() => prepare(cmd))
        .catch(() => false)
        .then((ready) => {
          if (ready && !(isStale?.() ?? false)) {
            insert(cmd);
          }
        })
        .finally(() => {
          if (pendingRef.current === token) {
            pendingRef.current = null;
            setPendingCommand(null);
          }
        });
    },
    [prepare],
  );

  return { pendingCommand, selectCommand };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlashCommandOption, SlashCommandPreparation } from '../types';

export interface PendingSlashCommandGate {
  /** The selection whose preparation is in flight; drives busy-row UI. */
  pendingCommand: SlashCommandOption | null;
  /**
   * Run one selection through the gate. Only rows with neither
   * `section: 'available'` nor `requiresResolution` insert synchronously.
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
 * - `prepare` returning `{ insertText }` inserts that host text instead of the
 *   row's own. A `requiresResolution` row inserts only valid host text: a
 *   missing gate, `true`, or a malformed result never inserts its fallback.
 * - `isStale` is sampled after `prepare` resolves; a surface whose context
 *   moved on (e.g. the slash trigger was retargeted or dismissed) reports
 *   stale and the insert is dropped.
 */
function preparedCommand(
  cmd: SlashCommandOption,
  ready: unknown,
): SlashCommandOption | null {
  if (
    typeof ready === 'object' &&
    ready !== null &&
    'insertText' in ready &&
    typeof ready.insertText === 'string' &&
    ready.insertText.trim().length > 0
  ) {
    return { ...cmd, insertText: ready.insertText };
  }
  return ready === true && cmd.requiresResolution !== true ? cmd : null;
}

export function usePendingSlashCommand(
  prepare?: (
    cmd: SlashCommandOption,
  ) => SlashCommandPreparation | Promise<SlashCommandPreparation>,
): PendingSlashCommandGate {
  // Token identity (not a boolean) so a stray late resolution can never clear
  // a newer selection's pending state.
  const pendingRef = useRef<symbol | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      pendingRef.current = null;
    };
  }, []);
  const [pendingCommand, setPendingCommand] =
    useState<SlashCommandOption | null>(null);

  const selectCommand = useCallback(
    (
      cmd: SlashCommandOption,
      insert: (cmd: SlashCommandOption) => void,
      isStale?: () => boolean,
    ): void => {
      if (!mounted.current || pendingRef.current !== null) return;
      if (cmd.section !== 'available' && cmd.requiresResolution !== true) {
        insert(cmd);
        return;
      }
      if (prepare === undefined) return;
      const token = Symbol('pending-slash-command');
      pendingRef.current = token;
      setPendingCommand(cmd);
      void Promise.resolve()
        .then(() => prepare(cmd))
        .catch(() => false)
        .then((ready) => {
          const prepared = preparedCommand(cmd, ready);
          if (
            mounted.current &&
            pendingRef.current === token &&
            prepared &&
            !(isStale?.() ?? false)
          ) {
            insert(prepared);
          }
        })
        .finally(() => {
          if (mounted.current && pendingRef.current === token) {
            pendingRef.current = null;
            setPendingCommand(null);
          }
        });
    },
    [prepare],
  );

  return { pendingCommand, selectCommand };
}

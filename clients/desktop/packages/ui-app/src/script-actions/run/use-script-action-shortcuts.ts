'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import type { ShortcutPlatform } from '@canopy/protocol/shortcuts';
import {
  buildScriptActionShortcutBindings,
  matchScriptActionShortcut,
  reservedScriptActionChords,
  type ReservedScriptActionChord,
} from './script-action-shortcuts';

export interface UseScriptActionShortcutDispatcherOptions {
  /** Mount gate: the runner is enabled for an active, writable worktree. */
  readonly enabled: boolean;
  readonly actions: readonly ScriptAction[] | null | undefined;
  /** The executing host's platform. */
  readonly platform: ShortcutPlatform;
  /** Host chords beyond the shared reservations (global focus shortcut). Keep it referentially stable. */
  readonly reserved?: readonly ReservedScriptActionChord[];
  /** Runs the matched action; the caller reports failures. */
  readonly onRun: (action: ScriptAction) => void;
  /** Where to listen. Defaults to `window`. */
  readonly target?: Pick<
    Window,
    'addEventListener' | 'removeEventListener'
  > | null;
}

/**
 * The one script-shortcut listener for the active worktree. Mount it once per
 * host window, not per tab or panel. It listens in the bubble phase on the
 * window, after focused surfaces and the app's own shortcut router have had
 * the event, and claims a chord only when exactly one eligible binding owns
 * it.
 */
export function useScriptActionShortcutDispatcher({
  enabled,
  actions,
  platform,
  reserved,
  onRun,
  target,
}: UseScriptActionShortcutDispatcherOptions): ReadonlyMap<
  string,
  ScriptAction
> {
  const reservedChords = useMemo(
    () => reservedScriptActionChords(platform, reserved),
    [platform, reserved],
  );
  const bindings = useMemo(
    () =>
      enabled && actions
        ? buildScriptActionShortcutBindings(actions, platform, reservedChords)
        : new Map<string, ScriptAction>(),
    [actions, enabled, platform, reservedChords],
  );
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    if (bindings.size === 0) return undefined;
    const listenTarget =
      target === undefined
        ? typeof window === 'undefined'
          ? null
          : window
        : target;
    if (listenTarget === null) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      const action = matchScriptActionShortcut(event, bindings, platform);
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      onRunRef.current(action);
    };
    listenTarget.addEventListener('keydown', handleKeyDown);
    return (): void =>
      listenTarget.removeEventListener('keydown', handleKeyDown);
  }, [bindings, platform, target]);

  return bindings;
}

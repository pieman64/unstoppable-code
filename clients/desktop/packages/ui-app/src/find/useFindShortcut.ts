'use client';

import { useEffect } from 'react';
import { isTerminalTarget } from '../code/terminal/terminal-dom';
import { resolveFallbackFindTarget, runFindShortcut } from './find-shortcut';

/**
 * Window-level Cmd/Ctrl+F for a host without its own shortcut dispatcher (the
 * web shell). The surface under the key press picks the bar's mode and
 * scope; with focus on page chrome, the only visible registered surface does.
 * A terminal with a registered find controller opens its own bar (its xterm
 * lets the chord through only then). Any other terminal keeps the chord and
 * never resolves to the bar of a chat or file beside it, as on desktop.
 */
export function useFindShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      runFindShortcut(event, () =>
        isTerminalTarget(event.target)
          ? null
          : resolveFallbackFindTarget(event.view?.document ?? document, null),
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

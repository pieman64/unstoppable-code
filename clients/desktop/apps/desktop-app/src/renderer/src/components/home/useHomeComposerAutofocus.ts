import { useEffect } from 'react';
import { focusEditor } from '@canopy/ui-rich/editor';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { useNavigationStore } from '@/stores/navigationStore';

function hasVisibleModal(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
  ).some((modal) => modal.getClientRects().length > 0);
}

function hasExistingFocusTarget(): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement !== null &&
    activeElement !== document.body &&
    activeElement !== document.documentElement
  );
}

/**
 * Focuses the visible New Task composer after it mounts and after every Home
 * navigation request. The page-only gate prevents an always-mounted embedded
 * Home surface from competing for focus.
 */
export function useHomeComposerAutofocus(
  editor: ChatEditor,
  enabled: boolean,
): void {
  const focusRequest = useNavigationStore(
    (state) => state.homeComposerFocusRequest,
  );

  useEffect(() => {
    if (!enabled) return;

    let frame: number | undefined;
    const requestFocus = (preserveExistingFocus = false): void => {
      frame = window.requestAnimationFrame(() => {
        // A dialog can open after this frame is scheduled but before it runs.
        // Let the modal keep the focus its trap assigned instead of moving
        // keyboard input back into the obscured Home composer.
        if (hasVisibleModal()) return;
        // When startup mounted while the app window was inactive, a user or
        // automation can focus another control before the window-focus event
        // arrives. That interaction supersedes the queued startup autofocus.
        if (preserveExistingFocus && hasExistingFocusTarget()) return;
        focusEditor(editor);
      });
    };

    const handleWindowFocus = (): void => requestFocus(true);

    if (document.hasFocus()) {
      requestFocus();
    } else {
      window.addEventListener('focus', handleWindowFocus, { once: true });
    }

    return (): void => {
      window.removeEventListener('focus', handleWindowFocus);
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [editor, enabled, focusRequest]);
}

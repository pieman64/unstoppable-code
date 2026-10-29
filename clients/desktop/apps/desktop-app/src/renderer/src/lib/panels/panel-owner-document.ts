/**
 * The document that currently shows a panel, and whether that document is
 * visible.
 *
 * Panel content renders once in the opener realm and its container is ADOPTED
 * by whichever grid hosts the panel (`PanelContentRoot`), so a pulled-out
 * panel lives in an auxiliary window's child document without remounting.
 * `document` in panel code is therefore the main window's document even when
 * the panel is on screen somewhere else. These hooks resolve the owning
 * document from the panel's placement (its layout key), so listeners bind to
 * the right window and rebind when the panel moves between windows.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { usePanelPlacement } from './panel-placement-context';

function rendererDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

/**
 * The document of the window currently showing this panel: the auxiliary
 * window's child document when the panel's layout is popped out, otherwise
 * the renderer document. Re-renders when the panel moves to another window.
 * Outside a panel (no placement) it is the renderer document.
 */
export function usePanelOwnerDocument(): Document | undefined {
  const placement = usePanelPlacement();
  const layoutKey = placement?.layoutKey ?? null;
  return usePanelWindowsStore((state) => {
    if (layoutKey === null) return rendererDocument();
    const auxWindow = Object.values(state.auxWindows).find(
      (record) => record.layoutKey === layoutKey,
    );
    // A window mid-teardown can stay in the store for a render or two, and
    // reading `.document` off it yields a blank document a listener would
    // then bind to. Fall back to the renderer document instead.
    if (auxWindow === undefined || auxWindow.childWindow.closed) {
      return rendererDocument();
    }
    return auxWindow.childWindow.document ?? rendererDocument();
  });
}

function alwaysVisible(): boolean {
  return true;
}

function noopSubscribe(): () => void {
  return (): void => {};
}

/**
 * Whether `ownerDocument` is visible (`visibilityState !== 'hidden'`), kept
 * current through that document's own `visibilitychange`. Electron reports a
 * minimized or hidden `BrowserWindow` (auxiliary windows included) as a hidden
 * document, and on macOS a fully occluded one too; losing keyboard focus alone
 * never hides it. Passing a different document moves the listener to it.
 */
export function useDocumentVisible(
  ownerDocument: Document | undefined,
): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      if (ownerDocument === undefined) return noopSubscribe();
      ownerDocument.addEventListener('visibilitychange', onChange);
      return (): void => {
        ownerDocument.removeEventListener('visibilitychange', onChange);
      };
    },
    [ownerDocument],
  );
  const getSnapshot = useCallback(
    (): boolean =>
      ownerDocument === undefined
        ? true
        : ownerDocument.visibilityState !== 'hidden',
    [ownerDocument],
  );
  return useSyncExternalStore(subscribe, getSnapshot, alwaysVisible);
}

import type { WebContents } from 'electron';
import { redirectIpcSends } from './web-contents-send';

/**
 * A renderer page the main process talks to: an app window, or a view that
 * hosts one (the early access App Advisor panel, whose page moves between
 * the main window and the full App Advisor window). Every `BrowserWindow`
 * is one.
 */
export interface RendererSurfaceWindow {
  isDestroyed(): boolean;
  readonly webContents: WebContents;
}

const hostedRenderers = new WeakMap<object, () => WebContents | null>();

/**
 * Records that the renderer a window stands for lives in a view it hosts
 * (the early access App Advisor). Sends to the window's own page reach
 * `renderer()` instead, and {@link rendererContentsOf} answers with it, so
 * code that matches a window to its renderer (subscriptions, approval
 * owners, IPC callers) keeps working. Returns the removal.
 */
export function hostRendererInView(
  windowContents: WebContents,
  renderer: () => WebContents | null,
): () => void {
  hostedRenderers.set(windowContents, renderer);
  const removeRedirect = redirectIpcSends(windowContents, renderer);
  return (): void => {
    removeRedirect();
    if (hostedRenderers.get(windowContents) === renderer) {
      hostedRenderers.delete(windowContents);
    }
  };
}

/** The renderer a window's page stands for: itself, or the view it hosts. */
export function rendererContentsOf<Contents extends object>(
  contents: Contents,
): Contents | WebContents {
  return hostedRenderers.get(contents)?.() ?? contents;
}

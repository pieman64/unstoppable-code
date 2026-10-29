import type { BrowserJavaScriptDialog } from '@canopy/desktop-shared/types/browser';
import type { NodeIdentity, RegisteredFrame } from '../frames/frame-registry';

/** Two URLs of the same document: equal but for the fragment. */
export function sameDocumentUrl(a: string, b: string): boolean {
  const strip = (url: string): string => {
    const hash = url.indexOf('#');
    return hash < 0 ? url : url.slice(0, hash);
  };
  return strip(a) === strip(b);
}

/**
 * Whether a dialog came from a child-frame target's document: the
 * target's frame (by its CDP frame id), still showing the document the
 * action resolved in (same session, loader and URL). The dialog's URL may
 * differ from the frame's only by its fragment, which CDP frame URLs omit.
 */
export function dialogFromTargetDocument(
  dialog: Pick<BrowserJavaScriptDialog, 'url'> & { frameId?: string },
  target: NodeIdentity,
  frameUrl: string | undefined,
  current: RegisteredFrame | undefined,
): boolean {
  return (
    frameUrl !== undefined &&
    dialog.frameId === target.frameId &&
    current?.sessionId === target.sessionId &&
    current.loaderId === target.loaderId &&
    current.url === frameUrl &&
    sameDocumentUrl(dialog.url, frameUrl)
  );
}

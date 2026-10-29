/** The parts of Electron's `will-frame-navigate` details the guard reads. */
export interface SubframeNavigationDetails {
  url: string;
  isMainFrame: boolean;
  frame: { origin: string; url: string; detached: boolean } | null;
}

/**
 * Whether a main-window frame navigation may proceed. A frame with an opaque
 * origin, or one showing a `srcdoc` document (an agent visual, its wrapper,
 * or an HTML preview), may only load `about:srcdoc`: it can never reach the
 * dev server or any other URL, whatever the target. Other subframes keep the
 * existing renderer policy. Main-frame navigation is decided elsewhere.
 */
export function isAllowedMainWindowFrameNavigation(
  details: SubframeNavigationDetails,
  isAllowedRendererFrameUrl: (url: string) => boolean,
): boolean {
  if (details.isMainFrame) return true;
  const { frame } = details;
  if (!frame || frame.detached) return false;
  if (frame.origin === 'null' || frame.url === 'about:srcdoc')
    return details.url === 'about:srcdoc';
  return isAllowedRendererFrameUrl(details.url);
}

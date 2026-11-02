/** Clipboard writes belong only to a live, top-level application document. */
export function allowsRendererClipboardWrite(
  sender: { isDestroyed(): boolean; getURL(): string },
  details: { isMainFrame: boolean; requestingUrl: string },
  trustedPageUrls: readonly string[],
  devServerUrl?: string,
  trustedPanelAuxiliary = false,
): boolean {
  if (sender.isDestroyed() || !details.isMainFrame) return false;
  const current = sender.getURL();
  if (current !== details.requestingUrl) return false;
  if (current === 'about:blank') return trustedPanelAuxiliary;
  try {
    const actual = new URL(current);
    const pages = devServerUrl
      ? [...trustedPageUrls, devServerUrl]
      : trustedPageUrls;
    return pages.some((page) => {
      const expected = new URL(page);
      return (
        actual.protocol === expected.protocol &&
        actual.host === expected.host &&
        actual.pathname === expected.pathname
      );
    });
  } catch {
    return false;
  }
}

/** Long enough for the browser to start reading the URL after the click. */
const DOWNLOAD_URL_LIFETIME_MS = 30_000;

/**
 * Starts a browser download of `blob`. Completion and location are unknown,
 * so callers report that the download started, never that it was saved.
 *
 * `ownerDocument` is the document of the element the download came from, so a
 * pulled-out window downloads through its own document.
 */
export function downloadBlob(
  blob: Blob,
  filename: string,
  ownerDocument: Document = globalThis.document,
): void {
  const view = ownerDocument.defaultView ?? window;
  const url = view.URL.createObjectURL(blob);
  const anchor = ownerDocument.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  view.setTimeout(
    (): void => view.URL.revokeObjectURL(url),
    DOWNLOAD_URL_LIFETIME_MS,
  );
}

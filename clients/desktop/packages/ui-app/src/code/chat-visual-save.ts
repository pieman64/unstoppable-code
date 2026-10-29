import {
  buildAgentVisualExportDocument,
  type AgentVisualTheme,
} from '@canopy/ui-shared/lib';

/** A file name from a visual's title, safe on every platform. */
export function chatVisualFilename(title: string): string {
  const safe = title
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100);
  return `${safe || 'visual'}.html`;
}

/**
 * Download a visual as a standalone HTML file in the current theme. The
 * browser's own download does the saving, so both hosts behave the same.
 */
export function saveChatVisualAsHtml({
  document: visual,
  theme,
  title,
  ownerDocument,
}: {
  document: string;
  theme: AgentVisualTheme;
  title: string;
  ownerDocument?: Document;
}): void {
  const targetDocument = ownerDocument ?? globalThis.document;
  const view = targetDocument.defaultView ?? window;
  const blob = new Blob(
    [buildAgentVisualExportDocument(visual, theme, title)],
    {
      type: 'text/html;charset=utf-8',
    },
  );
  const url = URL.createObjectURL(blob);
  const anchor = targetDocument.createElement('a');
  anchor.href = url;
  anchor.download = chatVisualFilename(title);
  anchor.click();
  view.setTimeout((): void => URL.revokeObjectURL(url), 0);
}

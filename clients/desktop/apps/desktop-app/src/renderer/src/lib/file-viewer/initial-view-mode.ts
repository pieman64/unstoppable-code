import type { FileTabViewMode } from '@canopy/desktop-shared/types';

/**
 * Extensions that the shared `FileViewer` can render instead of showing source.
 * They mirror `classifyExtension()` in `main/ipc/file-preview.ts` (markdown +
 * HTML) and the viewer's own `.csv` table check, which are what decide whether
 * the Raw/Preview toggle appears at all.
 */
const RENDERED_VIEW_MODE_BY_EXTENSION: Record<string, FileTabViewMode> = {
  '.md': 'preview',
  '.markdown': 'preview',
  '.mdx': 'preview',
  '.html': 'preview',
  '.htm': 'preview',
  '.csv': 'table',
};

/**
 * The view mode a *newly opened* file tab should start in, or `undefined` when
 * the file type has no rendered view and should stay on the raw default.
 *
 * Links in chats and file previews open documents to be read, so supported file
 * types start rendered. Only new tabs use this: reopening a file the user already
 * has open keeps whatever mode they last chose for it.
 */
export function initialFileTabViewMode(
  filename: string,
): FileTabViewMode | undefined {
  const name = filename.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return RENDERED_VIEW_MODE_BY_EXTENSION[name.slice(dot).toLowerCase()];
}

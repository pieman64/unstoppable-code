/**
 * Retrieval-preview query shaping, shared by the memory explorer's preview
 * UI, the preview-search route, and the `organization.memory.previewSearch`
 * operation entry. Pure and browser-safe.
 */

// The preview API rejects longer queries with HTTP 400, and the desktop turn
// path truncates at the same limit (`buildMemoryQuery` in
// apps/desktop-app/src/main/memory/memory-context.ts). The preview must
// truncate rather than fail so it keeps reflecting real turn behavior.
export const MAX_PREVIEW_QUERY_LENGTH = 2_000;

export interface PreviewQueryContext {
  repo: string;
  worktree: string;
}

// Real agent turns prefix the query as "{repoLabel} — {worktreeName} — {userText}"
// (desktop memory-context), so the optional context inputs mirror that shape.
export function buildPreviewQuery(
  query: string,
  context?: PreviewQueryContext,
): string {
  const parts =
    context === undefined
      ? [query.trim()]
      : [context.repo.trim(), context.worktree.trim(), query.trim()];
  return parts
    .filter((part) => part.length > 0)
    .join(' — ')
    .slice(0, MAX_PREVIEW_QUERY_LENGTH);
}

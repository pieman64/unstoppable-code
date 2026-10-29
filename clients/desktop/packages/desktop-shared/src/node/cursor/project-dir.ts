/**
 * Project-storage directory name the pinned Cursor CLI derives from a working
 * directory when it looks for `<profile>/projects/<encoded>/.cursor/hooks.json`.
 *
 * This is a version-specific workaround for the CLI's hook-discovery behavior
 * (see docs/cursor-chat.md). The chat provider and the approval-check
 * diagnostic must use this one implementation: a drift between them would
 * silently stop the approval hook from being discovered on one path.
 */
export function encodeCursorProjectDir(cwd: string): string {
  return cwd
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

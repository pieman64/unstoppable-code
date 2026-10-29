import type { ShellType } from '@canopy/desktop-shared/types/pipeline';

/**
 * Resolve the default shell for renderer-side pipeline normalization.
 *
 * The renderer doesn't have direct access to `process.platform`, so we rely on
 * the `window.platform` value exposed by the preload bridge. The Node-side of
 * the app supplies its own equivalent (see `normalizePipeline` consumers in
 * the main process) — this helper covers any renderer call site that needs to
 * pass `defaultShell` to `normalizePipeline`.
 *
 * Falls back to `'bash'` when `window` is not available (e.g. in Node-based
 * unit tests that import renderer helpers without a DOM).
 */
export function getDefaultShellForRenderer(): ShellType {
  if (typeof window === 'undefined') {
    return 'bash';
  }
  return window.platform === 'win32' ? 'powershell' : 'bash';
}

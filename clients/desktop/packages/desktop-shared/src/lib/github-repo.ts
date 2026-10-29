/**
 * Re-export of the shared GitHub repo-ref parser.
 *
 * The implementation moved to `@canopy/plugin-interop/github-repo` so the web
 * portal's add-marketplace form can validate with the SAME parser as the
 * desktop UI and the `portal.marketplace.add` adapter (`apps/web` may not
 * import `@canopy/desktop-shared`). This module stays as the desktop-facing
 * specifier so existing importers — the renderer's `lib/format.ts` and the
 * main-process plugin catalog service — need no change.
 */
export { parseGitHubRepo } from '@canopy/plugin-interop/github-repo';

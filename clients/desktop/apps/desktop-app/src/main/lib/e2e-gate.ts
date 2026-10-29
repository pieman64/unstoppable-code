/**
 * Build-time gate for UI-automation/E2E-only behavior.
 *
 * `__CANOPY_E2E__` is a Vite `define` constant injected by
 * `electron.vite.config.ts`. It is `false` in every normal/production build (so
 * the gated branches are dead-code-eliminated) and `true` only in an explicit
 * `CANOPY_E2E_BUILD=1` build used by the Playwright Electron suite. See
 * `docs/ui-automation-coverage/11-build-time-gating-principle.md`.
 *
 * Exposed as a function so call sites read a single, mockable seam instead of
 * referencing the global directly, and so production builds never honor a
 * runtime environment variable for any of the gated behavior.
 */
export function isE2eBuild(): boolean {
  return __CANOPY_E2E__;
}

/**
 * Cmd/Ctrl+F routing for the floating find bar (CAN-3048) is shared with the
 * web shell through `@canopy/ui-app/find`; this module keeps the renderer's
 * import path.
 */
export {
  readFindSurfaceElement,
  resolveFallbackFindTarget,
  resolveFindTarget,
  runFindShortcut,
  type FindShortcutEvent,
  type FindTarget,
} from '@canopy/ui-app/find';

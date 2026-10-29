/**
 * The floating find bar's store (CAN-3048) lives in `@canopy/ui-app/find` so
 * desktop and web share it; this module keeps the renderer's import path.
 */
export {
  EMPTY_FIND_CONTROLLER_STATE,
  SURFACE_FIND_BAR_SELECTOR,
  findControllerKey,
  getActiveFindController,
  getAvailableFindModes,
  getFindScopes,
  isHtmlElementInAnyRealm,
  isInsideSurfaceFindBar,
  useSurfaceFindStore,
  type FindController,
  type FindControllerState,
  type FindScopeOption,
  type FindSurfaceMode,
  type SurfaceFindState,
} from '@canopy/ui-app/find';

/**
 * The Activity States reference is available in unpackaged development and
 * deterministic E2E builds, and never appears in packaged builds.
 */
export function isActivityStatesPageEnabled(): boolean {
  if (__CANOPY_E2E__) return true;
  return window.devInfo?.isDev === true;
}

import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';

/**
 * Window surfaces the App Advisor portal adapter needs to drive the desktop's
 * App Advisor session (CAN-2565). Registered by `registerCanopyPortalHandlers`
 * at IPC setup; `null` means this desktop build never wired the App Advisor
 * windows, so App Advisor portal commands must fail rather than dispatch into
 * a windowless runtime.
 */
let portalAppAdvisorSurfaces: AppAdvisorToolRuntimeSurfaces | null = null;

export function setPortalAppAdvisorSurfaces(
  surfaces: AppAdvisorToolRuntimeSurfaces | null,
): void {
  portalAppAdvisorSurfaces = surfaces;
}

export function getPortalAppAdvisorSurfaces(): AppAdvisorToolRuntimeSurfaces | null {
  return portalAppAdvisorSurfaces;
}

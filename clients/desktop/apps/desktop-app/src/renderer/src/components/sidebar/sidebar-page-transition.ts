import { prefersReducedMotion } from '@canopy/ui-shared/lib';

export const SIDEBAR_PAGE_TRANSITION_MS = 250;

/** Delay paired with the shared sidebar page transition, or zero for reduced motion. */
export function sidebarPageTransitionDelay(): number {
  return prefersReducedMotion() ? 0 : SIDEBAR_PAGE_TRANSITION_MS;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Has the user asked for reduced motion? Guarded for hosts without
 * `matchMedia` (jsdom, SSR), where the honest answer is "no preference
 * expressed" rather than a thrown error.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

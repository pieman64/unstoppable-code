/**
 * Fixtures the composer lab's Vite config aliases in from outside the
 * renderer source tree (composer-status-lab.vite.mts). Parsed at runtime, so
 * typed as unknown.
 */
declare module 'composer-lab/gateway-catalog' {
  const catalog: unknown;
  export default catalog;
}

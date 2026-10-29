/**
 * The renderer's effective interface-scale zoom.
 *
 * The scale is a page zoom applied by the main process
 * (`main/lib/ui-zoom.ts`); preload exposes the live factor synchronously via
 * `webFrame`. This is its own leaf module because two unrelated consumers
 * need it — `lib/theme.ts`, which republishes it as `--ui-zoom` and derives
 * the one-device-pixel hairline, and `stores/sidebarStore.ts`, whose width
 * floor has to convert the titlebar corner's physical traffic-light reserve
 * into CSS px — and neither should have to import the other.
 *
 * Returns 1 when the bridge is unavailable (jsdom tests, the web portal's
 * shared components), which is the correct unzoomed default.
 */
export function readUiZoomFactor(): number {
  const read = window.api?.getUiZoomFactor;
  if (typeof read !== 'function') return 1;
  const factor = read();
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

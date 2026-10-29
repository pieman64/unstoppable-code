import type { PostHog } from 'posthog-js/dist/module.full.no-external';
import {
  buildPostHogRouteProperties,
  type PostHogRoute,
} from '../posthog-routes';

/** The SDK's batched heatmap event. */
export const POSTHOG_HEATMAP_EVENT = '$$heatmap';

/** Maps a page URL to that page's click and mouse samples. */
export const POSTHOG_HEATMAP_DATA_PROPERTY = '$heatmap_data';

/**
 * The SDK buffers samples under `window.location.href`, which does not change
 * when the app changes screens. Sending the buffer stamped with the screen
 * being left keeps its samples off the next screen's heatmap.
 */
export function flushPostHogHeatmaps(
  sdk: Pick<PostHog, 'heatmaps' | 'capture'>,
  route: PostHogRoute,
): void {
  const heatmaps = sdk.heatmaps;
  if (!heatmaps) return;
  // posthog-js 1.434.8 holds a resting mouse position in a 500 ms timer
  // outside the buffer; cancel it so it cannot land on the next screen. Do not
  // restart collection instead: that stops the dead-click observer while its
  // pending checks still run, so the navigating click would be reported dead.
  clearTimeout(heatmaps._mouseMoveTimeout);
  heatmaps._mouseMoveTimeout = undefined;
  const buffer = heatmaps.getAndClearBuffer();
  if (buffer && Object.keys(buffer).length > 0) {
    sdk.capture(POSTHOG_HEATMAP_EVENT, {
      [POSTHOG_HEATMAP_DATA_PROPERTY]: buffer,
      ...buildPostHogRouteProperties(route),
    });
  }
}

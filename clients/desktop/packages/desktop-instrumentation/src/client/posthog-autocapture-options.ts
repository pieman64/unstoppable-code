import type { PostHogConfig } from 'posthog-js';

/** Events the SDK emits from clicks while autocapture is on. */
export const POSTHOG_CLICK_EVENTS: ReadonlySet<string> = new Set([
  '$autocapture',
  '$rageclick',
  '$dead_click',
]);

/** Copied, cut, or pasted text. Never sent, even if copy capture turns on. */
export const POSTHOG_COPY_EVENT = '$copy_autocapture';

/**
 * Click events record element text and attributes as the replay already
 * does: `ph-no-capture` subtrees produce no click events, the SDK never
 * collects input values, and `before_send` runs the outbound sanitizer.
 * Copied text stays off because copy events send the selection even when
 * text is masked. Read once when the click listeners install.
 */
export const POSTHOG_AUTOCAPTURE_OPTIONS = Object.freeze({
  capture_copied_text: false,
} as const satisfies Exclude<PostHogConfig['autocapture'], boolean>);

/**
 * Init-time click settings. Click capture starts off; the runtime controller
 * turns autocapture, dead clicks, and heatmaps on from the autocapture flag,
 * and rage clicks follow autocapture.
 */
export const POSTHOG_CLICK_INIT_OPTIONS = Object.freeze({
  autocapture: false,
  rageclick: true,
  capture_dead_clicks: false,
  capture_heatmaps: false,
  mask_all_text: false,
  mask_all_element_attributes: false,
} as const satisfies Partial<PostHogConfig>);

/** Swipes are touch gestures; the desktop app has no swipe affordances. */
export const POSTHOG_DEAD_CLICK_OPTIONS = Object.freeze({
  capture_dead_swipes: false,
} as const satisfies Exclude<PostHogConfig['capture_dead_clicks'], boolean>);

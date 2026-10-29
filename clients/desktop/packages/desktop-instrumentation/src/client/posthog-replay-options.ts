import { redactUrl } from '../privacy';
import {
  maskReplayAttribute,
  recordReplayText,
} from './posthog-replay-masking';
import type { PostHogConfig } from 'posthog-js';
import {
  isPostHogRoute,
  POSTHOG_MAIN_ROUTE,
  type PostHogRoute,
} from '../posthog-routes';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '../posthog-replay-privacy';
import { isRendererSchemeUrl } from '@canopy/desktop-shared/lib/renderer-scheme';

function isLocalRendererRequest(url: string): boolean {
  return url.startsWith('file:') || isRendererSchemeUrl(url);
}

/** The recorder reads these options after init and after every rate update. */
export type PostHogSessionRecordingOptions = Readonly<
  NonNullable<PostHogConfig['session_recording']>
>;

export function buildPostHogSessionRecordingOptions(
  getRoute: () => PostHogRoute | undefined,
): PostHogSessionRecordingOptions {
  return Object.freeze({
    maskAllInputs: true,
    maskInputFn: (): string => '********',
    // Route every text node through recordReplayText, which redacts
    // credentials and otherwise records the text.
    maskTextSelector: '*',
    maskTextFn: recordReplayText,
    maskAllElementAttributes: false,
    maskAttributeFn: maskReplayAttribute,
    slimDOMOptions: Object.freeze({ comment: true }),
    // Pinned so renderer markers and the recorder cannot drift apart.
    blockClass: POSTHOG_REPLAY_BLOCK_CLASS,
    blockSelector:
      'webview, iframe, canvas, video, input[type="file"], input[type="hidden"], .monaco-aria-container',
    recordCrossOriginIframes: false,
    captureCanvas: Object.freeze({ recordCanvas: false }),
    recordHeaders: false,
    recordBody: false,
    maskCapturedNetworkRequestFn: <T extends { name?: string; url?: string }>(
      request: T,
    ): T | null => {
      try {
        if (
          Object.keys(request).length === 1 &&
          typeof request.name === 'string'
        ) {
          const route = getRoute();
          return {
            ...request,
            name: isPostHogRoute(route) ? route : POSTHOG_MAIN_ROUTE,
          };
        }
        // Local renderer files, whether loaded from file:// or from the
        // renderer scheme, are not network requests worth recording.
        if (
          (typeof request.name === 'string' &&
            isLocalRendererRequest(request.name)) ||
          (typeof request.url === 'string' &&
            isLocalRendererRequest(request.url))
        ) {
          return null;
        }
        return {
          ...request,
          ...(typeof request.name === 'string' && {
            name: redactUrl(request.name),
          }),
          ...(typeof request.url === 'string' && {
            url: redactUrl(request.url),
          }),
        };
      } catch {
        return null;
      }
    },
  });
}

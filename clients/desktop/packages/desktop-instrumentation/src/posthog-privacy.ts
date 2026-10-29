import { SECRET_ASSIGNMENT_KEYS_SOURCE } from '@canopy/desktop-shared/lib/redaction';
import { redactText, redactUrl } from './privacy';
import { normalizePostHogEmailDomain } from './posthog-account';
import { POSTHOG_CLICK_EVENTS } from './client/posthog-autocapture-options';
import { POSTHOG_HEATMAP_DATA_PROPERTY } from './client/posthog-heatmaps';
import {
  maskReplayAttribute,
  recordReplayText,
} from './client/posthog-replay-masking';
import {
  buildPostHogRouteProperties,
  isPostHogRoute,
  POSTHOG_APP_ADVISOR_ROUTE,
  POSTHOG_MAIN_ROUTE,
} from './posthog-routes';

/** Exact names for the SDK's property_denylist; the sanitizer also checks
 * spelling variants and nested properties. Content must be dropped, since
 * arbitrary private prose need not match a secret or PII pattern. */
export const POSTHOG_PROPERTY_DENYLIST: readonly string[] = Object.freeze([
  'prompt',
  'prompt_text',
  'messages',
  'message',
  'chat_excerpt',
  'transcript',
  'transcript_content',
  'file_content',
  'file_contents',
  'terminal_output',
  'stdout',
  'stderr',
  'command',
  'command_line',
  'git_remote',
  'remote_url',
  'workspace_id',
  'workspace_path',
  'worktree_path',
  'absolute_path',
  'install_path',
  'email',
  'usr',
  'usr.email',
  'usr.id',
  'dd_session_id',
  'dd_view_id',
  'username',
  'authorization',
  'cookie',
  'set-cookie',
  '$ip',
  'ip',
  // Click events also send `$elements` as one unstructured string, where an
  // href would escape URL redaction. `$elements` is sanitized field by field
  // and PostHog derives the chain from it when this copy is absent.
  '$elements_chain',
]);

function normalizePropertyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const DENIED_PROPERTIES = new Set(
  POSTHOG_PROPERTY_DENYLIST.map(normalizePropertyName),
);
const SECRET_PROPERTY = new RegExp(
  `^(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})$`,
  'i',
);
const LOCATION_PROPERTIES = new Set([
  '$current_url',
  '$pathname',
  '$host',
  '$referrer',
  '$referring_domain',
  '$initial_current_url',
  '$initial_pathname',
  '$initial_host',
  '$initial_referrer',
  '$initial_referring_domain',
  '$session_entry_url',
  '$session_entry_pathname',
  '$session_entry_referrer',
  '$session_entry_referring_domain',
  '$prev_pageview_pathname',
  '$prev_pageview_url',
]);
const URL_ATTRIBUTES = new Set(['attr__href', 'attr__src', 'attr__action']);

function isDeniedProperty(key: string): boolean {
  const normalized = normalizePropertyName(key);
  return (
    DENIED_PROPERTIES.has(normalized) ||
    SECRET_PROPERTY.test(normalized) ||
    normalized.startsWith('geoip') ||
    normalized.startsWith('initialgeoip')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeValue(
  value: unknown,
  key: string,
  location: string,
  ancestors: WeakSet<object>,
  depth: number,
  maskClickContent: boolean,
): unknown {
  if (normalizePropertyName(key) === 'emaildomain') {
    return key === 'email_domain'
      ? normalizePostHogEmailDomain(value)
      : undefined;
  }
  if (LOCATION_PROPERTIES.has(key)) return location;
  if (key === POSTHOG_HEATMAP_DATA_PROPERTY) {
    return sanitizeHeatmapData(value, location);
  }
  if (typeof value === 'string') {
    const maskedValue = maskClickContent
      ? key === '$el_text'
        ? recordReplayText(value)
        : key.startsWith('attr__')
          ? maskReplayAttribute(key.slice('attr__'.length), value)
          : value
      : value;
    if (key.endsWith('_url') || URL_ATTRIBUTES.has(key)) {
      // Normalize URLs after text redaction as well, so URL-encoded redaction
      // markers are stable on a second pass. No provider-specific patterns.
      return redactUrl(redactText(redactUrl(maskedValue)));
    }
    return redactText(maskedValue);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value !== 'object' || depth >= 32 || ancestors.has(value))
    return undefined;

  // Only JSON data is supported. Never retain an object's toJSON hook, which
  // could serialize unsanitized data after this pass.
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return undefined;
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map(
      (entry) =>
        sanitizeValue(
          entry,
          key,
          location,
          ancestors,
          depth + 1,
          maskClickContent,
        ) ?? null,
    );
  } else {
    result = Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !isDeniedProperty(name))
        .map(([name, entry]) => [
          name,
          sanitizeValue(
            entry,
            name,
            location,
            ancestors,
            depth + 1,
            maskClickContent,
          ),
        ])
        .filter(([, entry]) => entry !== undefined),
    );
  }
  ancestors.delete(value);
  return result;
}

const HEATMAP_SAMPLE_TYPES = new Set([
  'click',
  'rageclick',
  'deadclick',
  'mousemove',
]);

interface HeatmapSample {
  x: number;
  y: number;
  target_fixed: boolean;
  type: string;
}

function toHeatmapSample(value: unknown): HeatmapSample | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, target_fixed: targetFixed, type } = value;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof targetFixed !== 'boolean' ||
    typeof type !== 'string' ||
    !HEATMAP_SAMPLE_TYPES.has(type)
  )
    return undefined;
  return { x, y, target_fixed: targetFixed, type };
}

/** The SDK keys heatmap samples by `window.location.href`, which names the
 * local install. Every sample moves under the synthetic route and keeps only
 * its coordinates and type. */
function sanitizeHeatmapData(
  value: unknown,
  location: string,
): Record<string, HeatmapSample[]> | undefined {
  if (!isRecord(value)) return undefined;
  const samples = Object.values(value).flatMap((entries) =>
    Array.isArray(entries)
      ? entries.map(toHeatmapSample).filter((sample) => sample !== undefined)
      : [],
  );
  return samples.length > 0 ? { [location]: samples } : undefined;
}

function sanitizeProperties(
  properties: Record<string, unknown>,
  location: string,
  preserveProjectToken = false,
  maskClickContent = false,
): Record<string, unknown> {
  const sanitized = sanitizeValue(
    properties,
    '',
    location,
    new WeakSet(),
    0,
    maskClickContent,
  );
  if (!isRecord(sanitized)) return {};
  if ('screen_route' in sanitized && !isPostHogRoute(sanitized.screen_route)) {
    Reflect.deleteProperty(sanitized, 'screen_route');
  }
  return preserveProjectToken && typeof properties.token === 'string'
    ? { ...sanitized, token: properties.token }
    : sanitized;
}

interface SanitizePostHogEventOptions {
  preserveBrowserProjectToken?: boolean;
  /** Recorder payloads are already masked and may contain gzip latin1 bytes. */
  passthroughProperties?: readonly string[];
  /** Current renderer route. Runtime validation is intentional: callers may
   * cross an untyped SDK boundary before reaching this pure sanitizer. */
  screenRoute?: unknown;
}

/** Pure outbound property sanitizer shared by the future browser and Node
 * adapters. Event-envelope fields (including timestamp) are preserved. This
 * does not enable capture or replace replay/DOM masking. */
export function sanitizePostHogEvent<
  T extends {
    properties?: Record<string, unknown>;
    $set?: Record<string, unknown>;
    $set_once?: Record<string, unknown>;
  },
>(event: T | null, options: SanitizePostHogEventOptions = {}): T | null {
  if (event === null) return null;
  const surface =
    event.properties?.surface === 'app-advisor' ? 'app-advisor' : 'main';
  const fallbackLocation =
    surface === 'app-advisor' ? POSTHOG_APP_ADVISOR_ROUTE : POSTHOG_MAIN_ROUTE;
  // Resolution order is the capture-time event route, then the caller's
  // current route, then the existing safe-surface fallback. Keeping a valid
  // event route first makes retries and session-buffer replays idempotent.
  const incomingRoute = event.properties?.screen_route;
  const eventRoute = isPostHogRoute(incomingRoute) ? incomingRoute : undefined;
  const optionRoute = isPostHogRoute(options.screenRoute)
    ? options.screenRoute
    : undefined;
  const rendererRoute = eventRoute ?? optionRoute;
  const location = rendererRoute ?? fallbackLocation;
  const passthroughKeys = options.passthroughProperties ?? [];
  let propertiesToSanitize: Record<string, unknown> | undefined =
    event.properties;
  if (propertiesToSanitize && passthroughKeys.length > 0) {
    propertiesToSanitize = { ...propertiesToSanitize };
    for (const key of passthroughKeys) {
      Reflect.deleteProperty(propertiesToSanitize, key);
    }
  }
  const sanitizedProperties = propertiesToSanitize
    ? sanitizeProperties(
        propertiesToSanitize,
        location,
        options.preserveBrowserProjectToken,
        'event' in event &&
          typeof event.event === 'string' &&
          POSTHOG_CLICK_EVENTS.has(event.event),
      )
    : undefined;
  if (sanitizedProperties && event.properties) {
    for (const key of passthroughKeys) {
      if (Object.prototype.hasOwnProperty.call(event.properties, key)) {
        sanitizedProperties[key] = event.properties[key];
      }
    }
  }
  const sanitizedEvent = {
    ...event,
    ...((sanitizedProperties || rendererRoute) && {
      properties: {
        ...sanitizedProperties,
        ...(rendererRoute && buildPostHogRouteProperties(rendererRoute)),
      },
    }),
    ...(event.$set && {
      $set: sanitizeProperties(event.$set, location),
    }),
    ...(event.$set_once && {
      $set_once: sanitizeProperties(event.$set_once, location),
    }),
  };
  Reflect.deleteProperty(sanitizedEvent, 'toJSON');
  return sanitizedEvent;
}

import { redactSecrets } from '@canopy/desktop-shared/lib/redaction';
import { RENDERER_SCHEME_ORIGIN } from '@canopy/desktop-shared/lib/renderer-scheme';
import type { DesktopInstrumentationContext } from './types';
import { getDesktopInstrumentationConfig } from './config';

export const DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX =
  'https://canopy.local/renderer/assets';

const HOME_PATH_PATTERNS: RegExp[] = [
  /\/Users\/[^/\s)]+/g,
  /\/home\/[^/\s)]+/g,
  /[A-Za-z]:\\Users\\[^\\\s)]+/g,
];

const RENDERER_ASSET_FILE_URL_PATTERN =
  /file:\/\/\/[^\s'"`)]*\/out\/renderer\/assets\/([^:\s'"`)?#]+?\.(?:js|css))(?=[:\s'"`)?#]|$)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The same assets served from the renderer scheme (Settings → Labs →
 * "Open windows faster"): `app-renderer://bundle/assets/<name>.js|css`. Only
 * the exact origin matches, so look-alike hosts are not rewritten.
 */
const RENDERER_ASSET_SCHEME_URL_PATTERN = new RegExp(
  `(?<![A-Za-z0-9+.-])${escapeRegExp(RENDERER_SCHEME_ORIGIN)}\\/assets\\/([^:\\s'"\`)?#]+?\\.(?:js|css))(?=[:\\s'"\`)?#]|$)`,
  'g',
);

const SOURCEMAP_MINIFIED_PATH_PREFIX =
  getDesktopInstrumentationConfig().datadog.sourcemapMinifiedPathPrefix;

export function normalizeRendererAssetReferences(value: string): string {
  const toSourcemapPath = (_match: string, assetName: string): string =>
    `${SOURCEMAP_MINIFIED_PATH_PREFIX}/${assetName}`;
  return value
    .replace(RENDERER_ASSET_FILE_URL_PATTERN, toSourcemapPath)
    .replace(RENDERER_ASSET_SCHEME_URL_PATTERN, toSourcemapPath);
}

function redactLocalPaths(value: string): string {
  return HOME_PATH_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '<user-home>'),
    value,
  );
}

export function redactUrl(value: string): string {
  const normalized = normalizeRendererAssetReferences(value);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'file:') {
      return 'file:///<redacted>';
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return redactLocalPaths(parsed.toString());
  } catch {
    return redactLocalPaths(normalized);
  }
}

export function redactText(value: string): string {
  // URL/home-path normalization stays here; the secret/PII vocabulary is
  // delegated to the shared scrubber so there is a single source of truth.
  return redactSecrets(
    redactLocalPaths(normalizeRendererAssetReferences(value)),
  );
}

function getMutableRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value[key];
  return typeof candidate === 'object' && candidate !== null
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function redactRecordText(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (typeof value === 'string') {
    record[key] = redactText(value);
  }
}

function redactRecordUrl(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (typeof value === 'string') {
    record[key] = redactUrl(value);
  }
}

export function redactRumEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) {
    return true;
  }

  const record = event as Record<string, unknown>;
  const view = getMutableRecord(record, 'view');
  if (view) {
    redactRecordUrl(view, 'url');
    redactRecordUrl(view, 'referrer');
  }

  const resource = getMutableRecord(record, 'resource');
  if (resource) {
    redactRecordUrl(resource, 'url');
  }

  const error = getMutableRecord(record, 'error');
  if (error) {
    redactRecordText(error, 'message');
    redactRecordText(error, 'stack');
    const errorResource = getMutableRecord(error, 'resource');
    if (errorResource) {
      redactRecordUrl(errorResource, 'url');
    }
  }

  const longTask = getMutableRecord(record, 'long_task');
  const longTaskScripts = longTask?.['scripts'];
  if (Array.isArray(longTaskScripts)) {
    for (const script of longTaskScripts) {
      if (typeof script === 'object' && script !== null) {
        redactRecordUrl(script as Record<string, unknown>, 'source_url');
      }
    }
  } else if (typeof longTaskScripts === 'object' && longTaskScripts !== null) {
    redactRecordUrl(longTaskScripts as Record<string, unknown>, 'source_url');
  }

  const action = getMutableRecord(record, 'action');
  if (action) {
    redactRecordText(action, 'target');
    const actionTarget = getMutableRecord(action, 'target');
    if (actionTarget) {
      redactRecordText(actionTarget, 'name');
    }
  }

  return true;
}

export function sanitizeInstrumentationContext(
  context: DesktopInstrumentationContext | undefined,
): DesktopInstrumentationContext | undefined {
  if (!context) {
    return undefined;
  }

  const sanitized: DesktopInstrumentationContext = {};
  for (const [key, value] of Object.entries(context)) {
    sanitized[key] = typeof value === 'string' ? redactText(value) : value;
  }
  return sanitized;
}

const POSTHOG_IDENTITY_PROPERTY_NAMES = new Set([
  'distinctid',
  'posthogdistinctid',
  'sessionid',
  'posthogsessionid',
]);

function normalizeInstrumentationPropertyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Datadog contexts must never contain PostHog's person or session identity.
 * Keep this provider-specific so PostHog's own outbound adapter can stamp its
 * canonical `distinct_id` and `$session_id` after generic redaction.
 */
export function sanitizeDatadogInstrumentationContext(
  context: DesktopInstrumentationContext | undefined,
): DesktopInstrumentationContext | undefined {
  const sanitized = sanitizeInstrumentationContext(context);
  if (!sanitized) return undefined;
  return Object.fromEntries(
    Object.entries(sanitized).filter(
      ([key]) =>
        !POSTHOG_IDENTITY_PROPERTY_NAMES.has(
          normalizeInstrumentationPropertyName(key),
        ),
    ),
  );
}

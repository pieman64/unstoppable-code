/**
 * The privileged custom scheme the desktop renderer can load from when the
 * Settings → Labs "Open windows faster" row is on
 * (`PreferencesData.rendererCodeCacheSchemeEnabled`). Chromium keeps a V8
 * code cache only for standard schemes, so serving the renderer from
 * `app-renderer://bundle/` instead of `file://` lets a repeat launch reuse
 * compiled code.
 *
 * The name is brand-neutral on purpose: it is an origin, persisted
 * implicitly in Chromium's per-origin storage, and must not change with the
 * brand. Browser-safe; shared by main, the instrumentation privacy filters
 * and tests.
 */
export const RENDERER_SCHEME = 'app-renderer';

/** The only host the scheme serves. Every other host is refused. */
export const RENDERER_SCHEME_HOST = 'bundle';

/** `app-renderer://bundle`, the renderer's origin while the scheme is on. */
export const RENDERER_SCHEME_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_SCHEME_HOST}`;

/**
 * Whether `value` is a URL on exactly the renderer scheme's origin: the
 * scheme, the `bundle` host, and no port or credentials. Look-alike hosts
 * (`bundle.evil`), ports and user-info are not the renderer.
 */
export function isRendererSchemeUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${RENDERER_SCHEME}:` &&
    parsed.hostname === RENDERER_SCHEME_HOST &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

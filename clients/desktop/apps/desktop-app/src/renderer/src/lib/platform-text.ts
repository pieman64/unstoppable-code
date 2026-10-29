/**
 * Platform-aware text resolution for the renderer.
 *
 * Visible copy that differs across platforms (e.g. "Show in Finder" on macOS
 * vs. "Show in File Explorer" on Windows) is expressed as a typed
 * `PlatformText<T>` value: either a plain `T`, or an object with a `default`
 * key plus optional per-platform overrides. `resolvePlatformText` picks the
 * platform-specific value when one is defined, falling back to the default.
 *
 * Callers should pass complete, ready-to-display strings per platform. Never
 * assemble user-facing sentences from fragments.
 */

type Platform = NodeJS.Platform;

export type PlatformText<T = string> =
  | T
  | ({ default: T } & Partial<Record<'darwin' | 'win32' | 'linux', T>>);

function isPlatformTextObject<T>(
  value: PlatformText<T>,
): value is { default: T } & Partial<Record<'darwin' | 'win32' | 'linux', T>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'default' in (value as Record<string, unknown>)
  );
}

/**
 * Resolve a platform-aware text value to the string (or value of `T`) to
 * display.
 *
 * - If `value` is a plain `T`, it is returned unchanged.
 * - If `value` has an entry for `platform`, that entry wins.
 * - Otherwise `value.default` is returned.
 *
 * The input is never mutated. If `platform` is `undefined` (e.g. preload
 * hasn't populated `window.platform` yet), the default is used.
 */
export function resolvePlatformText<T>(
  value: PlatformText<T>,
  platform: Platform | undefined = typeof window !== 'undefined'
    ? window.platform
    : undefined,
): T {
  if (!isPlatformTextObject(value)) {
    return value;
  }

  if (platform === 'darwin' && value.darwin !== undefined) {
    return value.darwin;
  }
  if (platform === 'win32' && value.win32 !== undefined) {
    return value.win32;
  }
  if (platform === 'linux' && value.linux !== undefined) {
    return value.linux;
  }

  return value.default;
}

/**
 * Shorthand for `resolvePlatformText(value)` that uses `window.platform`.
 *
 * Prefer this in component bodies — it keeps call sites concise:
 *
 * ```tsx
 * <button>{pt(uiText.shellIntegration.addButton)}</button>
 * ```
 */
export function pt<T>(value: PlatformText<T>): T {
  return resolvePlatformText(value);
}

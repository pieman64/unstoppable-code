/**
 * The OS window's corner radius, so content nested inside the window can keep
 * its corners concentric with it (inner radius = window radius - inset).
 *
 * No OS exposes this through Electron. The values come from the platform:
 * - macOS 26 and later: 16pt, read from AppKit's `NSWindow._cornerRadius`
 *   for a titled, full-size-content window on macOS 27.2.
 * - macOS 11-15: 10pt.
 * - Windows 11: 8px, the fixed DWM rounding. Windows 10 windows are square.
 * - Anything else (Linux window managers): unknown.
 *
 * Chromium reports the real OS version through `navigator.userAgentData`
 * (the user agent string itself is frozen), and Windows 11 reports a
 * platform version of 13 or later.
 *
 * Published as `--window-corner-radius` on `<html>` in window points (DIPs).
 * CSS divides it by `--ui-zoom` to get CSS px at the current interface scale.
 */

const WINDOW_CORNER_RADIUS_PROPERTY = '--window-corner-radius';

export interface PlatformVersionInfo {
  readonly platform: string;
  readonly platformVersion: string;
}

/** The window corner radius in window points, or `null` when unknown. */
export function windowCornerRadiusPoints({
  platform,
  platformVersion,
}: PlatformVersionInfo): number | null {
  const major = Number.parseInt(platformVersion.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) return null;
  if (platform === 'macOS') {
    if (major >= 26) return 16;
    if (major >= 11) return 10;
    return null;
  }
  if (platform === 'Windows') {
    return major >= 13 ? 8 : 0;
  }
  return null;
}

interface HighEntropyUserAgentData {
  getHighEntropyValues(
    hints: readonly string[],
  ): Promise<{ platform?: string; platformVersion?: string }>;
}

function readUserAgentData(): HighEntropyUserAgentData | null {
  if (typeof navigator === 'undefined') return null;
  const data: unknown = Reflect.get(navigator, 'userAgentData');
  if (typeof data !== 'object' || data === null) return null;
  const getHighEntropyValues: unknown = Reflect.get(
    data,
    'getHighEntropyValues',
  );
  if (typeof getHighEntropyValues !== 'function') return null;
  return {
    getHighEntropyValues: async (
      hints,
    ): Promise<{ platform?: string; platformVersion?: string }> => {
      const result: unknown = await Reflect.apply(getHighEntropyValues, data, [
        hints,
      ]);
      if (typeof result !== 'object' || result === null) return {};
      const platform: unknown = Reflect.get(result, 'platform');
      const platformVersion: unknown = Reflect.get(result, 'platformVersion');
      return {
        ...(typeof platform === 'string' ? { platform } : {}),
        ...(typeof platformVersion === 'string' ? { platformVersion } : {}),
      };
    },
  };
}

/**
 * Reads the OS version once and publishes the window corner radius. Leaves
 * the property unset when the radius is unknown, so CSS keeps its fallback.
 */
export async function installWindowCornerRadius(): Promise<void> {
  const userAgentData = readUserAgentData();
  if (!userAgentData || typeof document === 'undefined') return;
  try {
    const { platform, platformVersion } =
      await userAgentData.getHighEntropyValues(['platformVersion']);
    const radius = windowCornerRadiusPoints({
      platform: platform ?? '',
      platformVersion: platformVersion ?? '',
    });
    if (radius === null) return;
    document.documentElement.style.setProperty(
      WINDOW_CORNER_RADIUS_PROPERTY,
      `${radius}px`,
    );
  } catch {
    // The CSS fallback radius stays in place.
  }
}

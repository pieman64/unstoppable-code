/**
 * Chromium keeps the last value of a repeated switch, so a feature is added
 * to the existing `enable-features` list rather than appended on its own.
 */
export function mergeEnabledFeatures(
  existing: string,
  feature: string,
): string {
  const features = existing
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!features.includes(feature)) features.push(feature);
  return features.join(',');
}

/** The command-line surface of `app.commandLine` this module uses. */
export interface EnableFeaturesCommandLine {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value?: string): void;
}

/**
 * Pins out-of-process sandboxed iframes, so a busy agent visual runs in its own
 * renderer process instead of the app's. Must run before the app is ready.
 */
export function pinIsolateSandboxedIframes(
  commandLine: EnableFeaturesCommandLine,
): void {
  commandLine.appendSwitch(
    'enable-features',
    mergeEnabledFeatures(
      commandLine.getSwitchValue('enable-features'),
      'IsolateSandboxedIframes',
    ),
  );
}

export interface DesktopTelemetryBuildIdentity {
  env: string;
  variant: string;
}

/**
 * Derive Datadog's release identity from the same flavor and brand inputs that
 * define the packaged desktop app. Non-production bundles stay untagged so
 * local development cannot pollute release telemetry.
 */
export function getDesktopTelemetryBuildIdentity(input: {
  mode: string;
  releaseFlavor: string;
  brandId: string;
}): DesktopTelemetryBuildIdentity {
  if (input.mode !== 'production') {
    return { env: '', variant: '' };
  }

  const flavor =
    input.releaseFlavor === 'internal' || input.releaseFlavor === 'rc'
      ? input.releaseFlavor
      : 'stable';
  return {
    env: flavor === 'stable' ? 'production' : 'staging',
    variant: `${flavor}-${input.brandId}`,
  };
}

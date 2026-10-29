import { getDesktopTelemetryBuildIdentity } from '../build/desktop-telemetry-build-identity';

describe('getDesktopTelemetryBuildIdentity', () => {
  it.each([
    ['internal', 'staging', 'internal-canopy'],
    ['rc', 'staging', 'rc-canopy'],
    ['stable', 'production', 'stable-canopy'],
  ])(
    'maps %s releases to the expected Datadog environment and variant',
    (releaseFlavor, env, variant) => {
      expect(
        getDesktopTelemetryBuildIdentity({
          mode: 'production',
          releaseFlavor,
          brandId: 'canopy',
        }),
      ).toEqual({ env, variant });
    },
  );

  it('normalizes unknown production flavors to stable', () => {
    expect(
      getDesktopTelemetryBuildIdentity({
        mode: 'production',
        releaseFlavor: 'preview',
        brandId: 'partner',
      }),
    ).toEqual({
      env: 'production',
      variant: 'stable-partner',
    });
  });

  it('leaves local development builds untagged', () => {
    expect(
      getDesktopTelemetryBuildIdentity({
        mode: 'development',
        releaseFlavor: 'internal',
        brandId: 'canopy',
      }),
    ).toEqual({ env: '', variant: '' });
  });
});

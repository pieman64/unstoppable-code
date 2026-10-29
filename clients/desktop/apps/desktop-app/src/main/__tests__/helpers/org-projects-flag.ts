import {
  CLIENT_FEATURE_FLAGS,
  type ClientFeatureFlagKey,
} from '@canopy/protocol/feature-flags';
import { FeatureFlagService } from '../../feature-flags';

/**
 * Organization projects default on when LaunchDarkly is not configured. Suites
 * that cover the legacy (context-free) paths call this from `beforeEach` to keep
 * that flag off while every other flag keeps its real value.
 */
export function pinOrgProjectsFlagOff(): void {
  const spy = jest.spyOn(FeatureFlagService.prototype, 'isEnabled');
  spy.mockImplementation(function (
    this: FeatureFlagService,
    key: ClientFeatureFlagKey,
  ): boolean {
    return (
      key !== CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key &&
      this.getSnapshot().values[key] === true
    );
  });
}

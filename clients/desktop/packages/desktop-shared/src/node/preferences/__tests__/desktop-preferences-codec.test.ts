import type { PreferencesLoadError } from '@canopy/core-runtime/node/preferences';
import type { PreferencesLoadErrorDetails } from '../../../types';
import { inspectPreferencesPayload } from '../desktop-preferences-codec';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

it('inspect reports the GitHub star prompt when both records are invalid', () => {
  expect(
    inspectPreferencesPayload({
      githubStarPrompt: { version: 99 },
      planModeHint: { version: 99 },
    }),
  ).toBe(
    'GitHub star prompt preferences contain an invalid or unsupported record.',
  );
});

it('the engine load error shape matches the desktop type', () => {
  const equal: Equal<PreferencesLoadError, PreferencesLoadErrorDetails> = true;
  expect(equal).toBe(true);
});

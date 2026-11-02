import {
  resolveModelPickerRowCue,
  type ModelPickerRowCueInput,
} from '../modelPickerRowCue';

/** A guest whose credits route is unfunded with daily credits off. */
const DRIP_OFF: ModelPickerRowCueInput = {
  rowKind: 'model',
  viewerAccess: 'needs_sign_in',
  hardDisabled: false,
  libraryLocked: false,
  usableNow: 'no',
  creditsRoute: 'yes',
  creditsSufficient: 'no',
  dailyCreditsOn: 'no',
  dailyCreditsRecoverySupported: true,
};

describe('resolveModelPickerRowCue', () => {
  it('asks a drip-off viewer on an unfunded credits route for daily credits', () => {
    expect(resolveModelPickerRowCue(DRIP_OFF)).toEqual({
      kind: 'needs-daily-credits',
    });
  });

  it('marks a settled usable row Available for a locked viewer', () => {
    expect(
      resolveModelPickerRowCue({
        ...DRIP_OFF,
        usableNow: 'yes',
        creditsSufficient: 'yes',
      }),
    ).toEqual({ kind: 'available' });
  });

  it('lets spendable credits make a row Available with daily credits off', () => {
    expect(
      resolveModelPickerRowCue({
        ...DRIP_OFF,
        usableNow: 'yes',
        creditsSufficient: 'yes',
        dailyCreditsOn: 'no',
      }),
    ).toEqual({ kind: 'available' });
  });

  it.each(['needs_sign_in_then_purchase', 'needs_purchase'] as const)(
    'applies to a %s viewer',
    (viewerAccess) => {
      expect(resolveModelPickerRowCue({ ...DRIP_OFF, viewerAccess })).toEqual({
        kind: 'needs-daily-credits',
      });
    },
  );

  it.each([
    ['an unlocked viewer', { viewerAccess: 'unlocked' }],
    ['an unknown viewer', { viewerAccess: undefined }],
    ['an Agent row', { rowKind: 'agent' }],
    ['the Auto row', { rowKind: 'auto' }],
    ['a hard-disabled row', { hardDisabled: true }],
    ['an existing library lock', { libraryLocked: true }],
  ] as const)('adds nothing for %s', (_name, patch) => {
    expect(resolveModelPickerRowCue({ ...DRIP_OFF, ...patch })).toBeUndefined();
    expect(
      resolveModelPickerRowCue({ ...DRIP_OFF, ...patch, usableNow: 'yes' }),
    ).toBeUndefined();
  });

  it.each([
    ['daily credits on but spent', { dailyCreditsOn: 'yes' }],
    ['an unknown preference', { dailyCreditsOn: 'unknown' }],
    ['unknown credits', { creditsSufficient: 'unknown' }],
    ['unknown usability', { usableNow: 'unknown' }],
    ['a native route', { creditsRoute: 'no' }],
    ['an unknown route', { creditsRoute: 'unknown' }],
    ['unsupported recovery', { dailyCreditsRecoverySupported: false }],
  ] as const)('makes no availability claim for %s', (_name, patch) => {
    expect(resolveModelPickerRowCue({ ...DRIP_OFF, ...patch })).toBeUndefined();
  });

  describe('a row only a provider sign-in can run', () => {
    /** A native-only model: credits cannot pay, the provider is signed out. */
    const SIGN_IN: ModelPickerRowCueInput = {
      ...DRIP_OFF,
      creditsRoute: 'no',
      providerSignInLabel: 'Codex',
    };

    it('names the provider sign-in', () => {
      expect(resolveModelPickerRowCue(SIGN_IN)).toEqual({
        kind: 'needs-provider-sign-in',
        providerLabel: 'Codex',
      });
    });

    it('names it whatever the credits state', () => {
      expect(
        resolveModelPickerRowCue({
          ...SIGN_IN,
          creditsSufficient: 'yes',
          dailyCreditsOn: 'yes',
        }),
      ).toEqual({ kind: 'needs-provider-sign-in', providerLabel: 'Codex' });
    });

    it.each([
      ['an unlocked viewer', { viewerAccess: 'unlocked' }],
      ['a hard-disabled row', { hardDisabled: true }],
      ['an existing library lock', { libraryLocked: true }],
      ['unknown usability', { usableNow: 'unknown' }],
      ['an unknown route', { creditsRoute: 'unknown' }],
      ['a credits route', { creditsRoute: 'yes', dailyCreditsOn: 'yes' }],
      ['no sign-in recovery', { providerSignInLabel: undefined }],
    ] as const)('adds nothing for %s', (_name, patch) => {
      expect(
        resolveModelPickerRowCue({ ...SIGN_IN, ...patch }),
      ).toBeUndefined();
    });
  });

  it('never calls an unsettled row Available', () => {
    expect(
      resolveModelPickerRowCue({
        ...DRIP_OFF,
        usableNow: 'unknown',
        creditsSufficient: 'unknown',
        dailyCreditsOn: 'unknown',
      }),
    ).toBeUndefined();
  });
});

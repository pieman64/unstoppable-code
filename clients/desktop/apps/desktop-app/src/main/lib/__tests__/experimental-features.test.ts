import {
  isExperimentalFeaturesEnabled,
  onExperimentalFeaturesChanged,
  setExperimentalFeaturesEnabled,
} from '../experimental-features';

describe('experimental features switch', () => {
  afterEach(() => {
    setExperimentalFeaturesEnabled(false);
  });

  it('tells listeners when the switch changes, and only then', () => {
    const seen: boolean[] = [];
    const unsubscribe = onExperimentalFeaturesChanged((enabled) => {
      seen.push(enabled);
    });

    setExperimentalFeaturesEnabled(true);
    setExperimentalFeaturesEnabled(true);
    setExperimentalFeaturesEnabled(false);
    unsubscribe();
    setExperimentalFeaturesEnabled(true);

    expect(seen).toEqual([true, false]);
    expect(isExperimentalFeaturesEnabled()).toBe(true);
  });
});

import {
  isSkillSuggestionScanEnabled,
  isSkillSuggestionsEnabled,
  onSkillSuggestionsGateChanged,
  resetSkillSuggestionsGateForTests,
  setSkillSuggestionsPreference,
  startSkillSuggestionsGate,
  type SkillSuggestionGateChange,
} from '../feature-gate';

let flagEnabled = true;
let snapshotListener: (() => void) | null = null;
let e2eBuild = false;

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({
    isEnabled: (key: string): boolean =>
      key === 'canopy-desktop-skill-suggestions' && flagEnabled,
    onSnapshotChanged: (listener: () => void): (() => void) => {
      snapshotListener = listener;
      return () => {
        snapshotListener = null;
      };
    },
  }),
}));
jest.mock('../../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => e2eBuild,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

describe('skill suggestion feature gate', () => {
  let changes: SkillSuggestionGateChange[];
  beforeEach(() => {
    resetSkillSuggestionsGateForTests();
    flagEnabled = true;
    e2eBuild = false;
    changes = [];
    onSkillSuggestionsGateChanged((change) => changes.push(change));
  });

  it('requires both the flag and the preference', () => {
    expect(isSkillSuggestionsEnabled()).toBe(true);
    setSkillSuggestionsPreference(false);
    expect(isSkillSuggestionsEnabled()).toBe(false);
    setSkillSuggestionsPreference(true);
    flagEnabled = false;
    expect(isSkillSuggestionsEnabled()).toBe(false);
  });

  it('closes only the scan gate in E2E builds', () => {
    e2eBuild = true;
    expect(isSkillSuggestionsEnabled()).toBe(true);
    expect(isSkillSuggestionScanEnabled()).toBe(false);
  });

  it('announces live flag flips without a restart', () => {
    startSkillSuggestionsGate();
    flagEnabled = false;
    snapshotListener?.();
    snapshotListener?.();
    flagEnabled = true;
    snapshotListener?.();
    expect(changes).toEqual([
      { enabled: false, cause: 'flag' },
      { enabled: true, cause: 'flag' },
    ]);
  });

  it('announces a preference-off even while the flag is off', () => {
    flagEnabled = false;
    setSkillSuggestionsPreference(false);
    expect(changes).toEqual([{ enabled: false, cause: 'preference' }]);
    setSkillSuggestionsPreference(true);
    expect(changes).toHaveLength(1);
  });

  it('ignores flag flips while the preference is off', () => {
    startSkillSuggestionsGate();
    setSkillSuggestionsPreference(false);
    changes = [];
    flagEnabled = false;
    snapshotListener?.();
    expect(changes).toEqual([]);
  });
});

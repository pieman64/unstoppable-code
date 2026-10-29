import { DATA_SHARING_OPT_IN_SCOPES } from '../data-sharing-features';
import {
  DATA_SHARING_FEATURES,
  DATA_SHARING_PREREQUISITE_SCOPE,
  DATA_SHARING_SCOPE_DESCRIPTIONS,
  DATA_SHARING_SCOPE_LABELS,
  DATA_SHARING_SCOPE_ORDER,
  dataSharingDependencyNote,
  dataSharingFeatureCaption,
  getDataSharingFeatures,
  type DataSharingFeatureId,
} from '../data-sharing-features';

/**
 * The closed vocabulary, restated here rather than imported, so this spec fails
 * when a call site invents a capability-phrased label instead of silently
 * agreeing with whatever the module happens to export.
 */
const ALLOWED_FEATURE_IDS: readonly DataSharingFeatureId[] = [
  'feed-activity',
  'feed-search',
  'statistics',
  'member-profiles',
  'leaderboards',
  'cost-and-savings',
  'push-notifications',
  'implemented-plans',
  'shared-runs',
  'organization-memory',
];

describe('data-sharing feature map', () => {
  it('covers every scope, in least-invasive → most-invasive order', () => {
    expect(DATA_SHARING_SCOPE_ORDER).toEqual([
      'metadata',
      'plans',
      'summaries',
      'transcripts',
    ]);
    for (const scope of DATA_SHARING_SCOPE_ORDER) {
      expect(DATA_SHARING_FEATURES[scope].length).toBeGreaterThan(0);
      expect(DATA_SHARING_SCOPE_LABELS[scope]).toBeTruthy();
      expect(DATA_SHARING_SCOPE_DESCRIPTIONS[scope]).toBeTruthy();
    }
  });

  it('only ever names features from the closed vocabulary', () => {
    for (const scope of DATA_SHARING_SCOPE_ORDER) {
      for (const entry of DATA_SHARING_FEATURES[scope]) {
        expect(ALLOWED_FEATURE_IDS).toContain(entry.id);
        expect(entry.label).toBeTruthy();
      }
    }
  });

  it('gives each scope a unique feature list without duplicates within a row', () => {
    for (const scope of DATA_SHARING_SCOPE_ORDER) {
      const ids = DATA_SHARING_FEATURES[scope].map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('keeps Transcripts off the Feed and Statistics rows', () => {
    // Both surfaces are built entirely from plaintext columns, so an org can
    // turn Transcripts off and lose no dashboard or feed content at all. Copy
    // implying otherwise would undersell the whole zero-data-retention story.
    const transcriptIds = DATA_SHARING_FEATURES.transcripts.map(
      (entry) => entry.id,
    );
    expect(transcriptIds).not.toContain('feed-activity');
    expect(transcriptIds).not.toContain('statistics');
  });

  it('attributes Organization memory to Transcripts and its prerequisite to Usage metadata', () => {
    expect(
      DATA_SHARING_FEATURES.transcripts.map((entry) => entry.id),
    ).toContain('organization-memory');
    expect(DATA_SHARING_PREREQUISITE_SCOPE).toBe('metadata');
  });
});

describe('getDataSharingFeatures', () => {
  it('includes enforcement-only features by default (the admin view)', () => {
    const ids = getDataSharingFeatures('transcripts').map((entry) => entry.id);
    expect(ids).toContain('shared-runs');
  });

  it('filters enforcement-only features for the member view', () => {
    // A member's own Transcripts-off does not stop them sharing a run —
    // `shareRun` bypasses the ambient sharing gate — so claiming `Shared runs`
    // turns off would be a straightforwardly false promise on the desktop.
    const ids = getDataSharingFeatures('transcripts', {
      includeEnforcementOnly: false,
    }).map((entry) => entry.id);
    expect(ids).not.toContain('shared-runs');
    expect(ids).toContain('organization-memory');
  });

  it('leaves rows without enforcement-only entries unchanged for both views', () => {
    for (const scope of DATA_SHARING_SCOPE_ORDER) {
      if (scope === 'transcripts') {
        continue;
      }
      expect(
        getDataSharingFeatures(scope, { includeEnforcementOnly: false }),
      ).toEqual(getDataSharingFeatures(scope));
    }
  });
});

describe('disclosure copy', () => {
  it('flips the caption on the sharing state', () => {
    expect(dataSharingFeatureCaption(true)).toBe('Powers');
    expect(dataSharingFeatureCaption(false)).toBe('Enables');
  });

  it('names Usage metadata in every dependency note', () => {
    for (const scope of DATA_SHARING_SCOPE_ORDER) {
      expect(dataSharingDependencyNote(scope)).toContain('Usage metadata');
    }
  });

  it('calls out Organization memory on the Transcripts dependency note', () => {
    // Memory episodes are only enqueued for organization-owned turn rows, so
    // Usage metadata off kills memory even with Transcripts on. That is a
    // silent failure anyone configuring for zero data retention hits at once.
    expect(dataSharingDependencyNote('transcripts')).toContain(
      'Organization memory',
    );
  });
});

it('pins the exact opt-in consent scope map', () => {
  expect(DATA_SHARING_OPT_IN_SCOPES).toEqual({
    'feed-activity': ['metadata', 'plans', 'summaries'],
    statistics: ['metadata', 'plans'],
    'member-profiles': ['metadata', 'plans'],
    leaderboards: ['metadata', 'plans'],
    'implemented-plans': ['metadata', 'plans'],
    'organization-memory': ['metadata', 'transcripts'],
    'shared-projects': ['metadata'],
  });
});

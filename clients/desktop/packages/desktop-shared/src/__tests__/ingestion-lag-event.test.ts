import {
  INGESTION_LAG_EVENT_TYPE,
  isChatIngestionLagEventData,
} from '@canopy/desktop-shared/types';

const SAMPLE = {
  lagMs: 7_200,
  source: 'receipt',
  sampledAtMs: 1_750_000_000_000,
  catchingUp: true,
};

describe('ingestion lag event guard', () => {
  it('accepts a sample and a clear', () => {
    expect(
      isChatIngestionLagEventData({
        type: INGESTION_LAG_EVENT_TYPE,
        lag: SAMPLE,
      }),
    ).toBe(true);
    expect(
      isChatIngestionLagEventData({
        type: INGESTION_LAG_EVENT_TYPE,
        lag: null,
      }),
    ).toBe(true);
  });

  it.each([
    ['another event type', { type: 'canopy_transient_retry_state', lag: null }],
    ['a missing lag', { lag: undefined }],
    ['a negative lag', { lag: { ...SAMPLE, lagMs: -1 } }],
    [
      'a non-finite lag',
      { lag: { ...SAMPLE, lagMs: Number.POSITIVE_INFINITY } },
    ],
    ['an unknown source', { lag: { ...SAMPLE, source: 'episode' } }],
    ['a missing sample time', { lag: { ...SAMPLE, sampledAtMs: undefined } }],
    ['a non-boolean catch-up flag', { lag: { ...SAMPLE, catchingUp: 'yes' } }],
  ])('rejects %s', (_label, overrides) => {
    const event = Object.assign(
      { type: INGESTION_LAG_EVENT_TYPE, lag: SAMPLE },
      overrides,
    );
    expect(isChatIngestionLagEventData(event)).toBe(false);
  });
});

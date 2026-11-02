import {
  isProviderEventDeliverable,
  normalizeProviderEventIngestResult,
} from '../provider-event-admission';

describe('normalizeProviderEventIngestResult', () => {
  it('reads legacy hook answers as before', () => {
    expect(normalizeProviderEventIngestResult(false)).toEqual({
      outcome: 'not-applied',
    });
    expect(normalizeProviderEventIngestResult(true)).toEqual({
      outcome: 'applied',
    });
    expect(normalizeProviderEventIngestResult(undefined)).toEqual({
      outcome: 'applied',
    });
  });

  it('never treats a not-applied result as deliverable', () => {
    const notApplied = normalizeProviderEventIngestResult({
      outcome: 'not-applied',
    });
    expect(isProviderEventDeliverable(notApplied)).toBe(false);
    expect(isProviderEventDeliverable({ outcome: 'activity-only' })).toBe(true);
    expect(isProviderEventDeliverable({ outcome: 'applied' })).toBe(true);
  });
});

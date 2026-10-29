import {
  DEFAULT_CLOUD_AUTH_BENEFITS,
  GUEST_CLOUD_AUTH_BENEFITS,
} from '../CloudAuthPanel';

describe('cloud auth benefit rows', () => {
  it('does not promise daily free credits on either list', () => {
    // The daily free AI Credits are opt-in, so signing in alone does not
    // deliver them. Neither the signed-out nor the guest list may claim it.
    for (const benefits of [
      DEFAULT_CLOUD_AUTH_BENEFITS,
      GUEST_CLOUD_AUTH_BENEFITS,
    ]) {
      expect(benefits.map((b) => b.id)).not.toContain('daily-credits');
      for (const benefit of benefits) {
        expect(benefit.label).not.toMatch(/credit/i);
        expect(benefit.label).not.toMatch(/every day/i);
      }
    }
  });

  it('lists the sync, reach, and share benefits in order', () => {
    expect(DEFAULT_CLOUD_AUTH_BENEFITS.map((b) => b.id)).toEqual([
      'keep-work',
      'reach-agents',
      'share-team',
    ]);
  });

  it('keeps the guest list identical apart from the guest-specific first row', () => {
    expect(GUEST_CLOUD_AUTH_BENEFITS.map((b) => b.id)).toEqual(
      DEFAULT_CLOUD_AUTH_BENEFITS.map((b) => b.id),
    );
    expect(
      GUEST_CLOUD_AUTH_BENEFITS.find((b) => b.id === 'keep-work')?.label,
    ).toBe("Keep the work you've done as a guest");
  });

  it('gives every row a distinct id so the testids stay unambiguous', () => {
    const ids = DEFAULT_CLOUD_AUTH_BENEFITS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

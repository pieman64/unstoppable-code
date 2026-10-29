import {
  DEFAULT_DIGEST_PREFERENCES,
  parseDigestPreferences,
  parseDigestPreferencesPatch,
} from '..';

describe('digest preference wire contract', () => {
  describe('parseDigestPreferences (READ path)', () => {
    it('defaults anchors for already-shipped clients that send only cadences', () => {
      expect(
        parseDigestPreferences({
          daily: false,
          weekly: true,
          monthly: false,
        }),
      ).toEqual(DEFAULT_DIGEST_PREFERENCES);
    });

    it('accepts supported anchor bounds', () => {
      expect(
        parseDigestPreferences({
          daily: true,
          weekly: false,
          monthly: true,
          weeklyAnchorDay: 7,
          monthlyAnchorDay: 31,
        }),
      ).toEqual({
        daily: true,
        weekly: false,
        monthly: true,
        weeklyAnchorDay: 7,
        monthlyAnchorDay: 31,
      });
    });

    it.each([
      ['weeklyAnchorDay', 0],
      ['weeklyAnchorDay', 8],
      ['monthlyAnchorDay', 0],
      ['monthlyAnchorDay', 32],
    ])('rejects an invalid %s', (field, value) => {
      expect(
        parseDigestPreferences({
          ...DEFAULT_DIGEST_PREFERENCES,
          [field]: value,
        }),
      ).toBeNull();
    });
  });

  describe('parseDigestPreferencesPatch (WRITE path)', () => {
    it('leaves an omitted anchor undefined instead of defaulting it', () => {
      // The regression this exists for: an already-shipped desktop build PATCHes
      // only the three cadence booleans. If the write path substituted the
      // default here, toggling a cadence from that client would silently reset a
      // Friday/28th anchor the user had chosen on the web.
      const patch = parseDigestPreferencesPatch({
        daily: false,
        weekly: true,
        monthly: false,
      });

      expect(patch).toEqual({ daily: false, weekly: true, monthly: false });
      expect(patch).not.toHaveProperty('weeklyAnchorDay');
      expect(patch).not.toHaveProperty('monthlyAnchorDay');
    });

    it('keeps an anchor the client did send', () => {
      expect(
        parseDigestPreferencesPatch({
          daily: false,
          weekly: true,
          monthly: true,
          weeklyAnchorDay: 5,
        }),
      ).toEqual({
        daily: false,
        weekly: true,
        monthly: true,
        weeklyAnchorDay: 5,
      });
    });

    it('still requires all three cadence booleans', () => {
      expect(
        parseDigestPreferencesPatch({ daily: false, weekly: true }),
      ).toBeNull();
    });

    it.each([
      ['weeklyAnchorDay', 0],
      ['weeklyAnchorDay', 8],
      ['weeklyAnchorDay', 1.5],
      ['monthlyAnchorDay', 0],
      ['monthlyAnchorDay', 32],
      ['monthlyAnchorDay', 'first'],
    ])('range-validates a supplied %s (%p)', (field, value) => {
      expect(
        parseDigestPreferencesPatch({
          daily: false,
          weekly: true,
          monthly: false,
          [field]: value,
        }),
      ).toBeNull();
    });

    it('rejects a non-object body', () => {
      expect(parseDigestPreferencesPatch(null)).toBeNull();
      expect(parseDigestPreferencesPatch([])).toBeNull();
      expect(parseDigestPreferencesPatch('weekly')).toBeNull();
    });
  });
});

import { CardStateV2Schema } from '../core/chat/transcript';

describe('12a S1 canonical omission contract', () => {
  it('admits backend canonical omission independently of an absent draft', () => {
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 0,
        canonical: {
          status: 'completed',
          resultIndex: 1,
          detailOmitted: true,
          finalText: 'preview',
        },
      }).success,
    ).toBe(true);
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 0,
        canonical: {
          status: 'completed',
          resultIndex: 1,
          detailOmitted: false,
        },
      }).success,
    ).toBe(false);
  });
});

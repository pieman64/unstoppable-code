import {
  BILLING_CHARGE_KIND_LABELS,
  BILLING_CHARGE_STATUS_LABELS,
  billingChargeStatusTone,
  humanizeBillingChargeKind,
  humanizeBillingChargeStatus,
  humanizeEnumToken,
  resolveBillingChargeDisplayStatus,
} from '../billing-charge-display';

describe('billing-charge-display', () => {
  it('maps every known charge kind to a curated label', () => {
    expect(humanizeBillingChargeKind('SUBSCRIPTION_RENEWAL')).toBe(
      'Subscription renewal',
    );
    expect(humanizeBillingChargeKind('CREDIT_TOP_UP')).toBe('Credit purchase');
    expect(humanizeBillingChargeKind('ONE_TIME')).toBe('One-time charge');
    // Curated labels cover the full known set.
    for (const label of Object.values(BILLING_CHARGE_KIND_LABELS)) {
      expect(label).not.toMatch(/[_A-Z]{2,}/);
    }
  });

  it('maps every known charge status to a curated label', () => {
    expect(humanizeBillingChargeStatus('PENDING')).toBe('Pending');
    expect(humanizeBillingChargeStatus('SUCCEEDED')).toBe('Succeeded');
    expect(humanizeBillingChargeStatus('FAILED')).toBe('Failed');
    expect(humanizeBillingChargeStatus('REFUNDED')).toBe('Refunded');
    for (const label of Object.values(BILLING_CHARGE_STATUS_LABELS)) {
      expect(label).not.toMatch(/[_A-Z]{2,}/);
    }
  });

  it('prettifies unknown/future enum tokens to sentence case', () => {
    expect(humanizeBillingChargeKind('SOME_FUTURE_KIND')).toBe(
      'Some future kind',
    );
    expect(humanizeBillingChargeStatus('PARTIALLY_REFUNDED')).toBe(
      'Partially refunded',
    );
    expect(humanizeEnumToken('charge-back')).toBe('Charge back');
    expect(humanizeEnumToken('')).toBe('');
    expect(humanizeEnumToken('   ')).toBe('');
  });

  it('never returns an inherited prototype-chain member for colliding tokens', () => {
    // A raw value that collides with an Object.prototype key must not resolve to
    // the inherited function/object — it falls through to the sentence-case
    // fallback and always returns a plain string.
    for (const token of [
      '__proto__',
      'toString',
      'constructor',
      'hasOwnProperty',
    ]) {
      expect(typeof humanizeBillingChargeKind(token)).toBe('string');
      expect(typeof humanizeBillingChargeStatus(token)).toBe('string');
    }
    expect(humanizeBillingChargeStatus('toString')).toBe('Tostring');
  });
});

describe('resolveBillingChargeDisplayStatus', () => {
  it('derives PARTIALLY_REFUNDED, which has no Prisma enum member', () => {
    // The whole reason this helper exists: a charge only flips to REFUNDED once
    // reversals cover the full amount, so a half-refunded charge arrives as
    // SUCCEEDED and a status-only mapping would call it plainly succeeded.
    expect(resolveBillingChargeDisplayStatus('SUCCEEDED', 20, 5)).toBe(
      'PARTIALLY_REFUNDED',
    );
    expect(humanizeBillingChargeStatus('PARTIALLY_REFUNDED')).toBe(
      'Partially refunded',
    );
    expect(billingChargeStatusTone('PARTIALLY_REFUNDED')).toBe('info');
  });

  it('reports a fully covered charge as REFUNDED even while status lags', () => {
    // The reversal aggregate and the status flip are separate writes, so the UI
    // must agree with the money rather than depend on having seen both.
    expect(resolveBillingChargeDisplayStatus('SUCCEEDED', 20, 20)).toBe(
      'REFUNDED',
    );
    expect(resolveBillingChargeDisplayStatus('SUCCEEDED', 20, 999)).toBe(
      'REFUNDED',
    );
    expect(resolveBillingChargeDisplayStatus('REFUNDED', 20, 20)).toBe(
      'REFUNDED',
    );
  });

  it('leaves an unreversed charge on its raw status', () => {
    for (const refunded of [undefined, null, 0, -1, Number.NaN]) {
      expect(resolveBillingChargeDisplayStatus('SUCCEEDED', 20, refunded)).toBe(
        'SUCCEEDED',
      );
    }
  });

  it('never re-labels a status that collected no money to reverse', () => {
    // A reversed amount on PENDING/FAILED is a server-side anomaly. Re-labelling
    // it would invent a refund for money that was never captured.
    expect(resolveBillingChargeDisplayStatus('FAILED', 20, 20)).toBe('FAILED');
    expect(resolveBillingChargeDisplayStatus('PENDING', 20, 5)).toBe('PENDING');
    // Unknown/future statuses pass through untouched too.
    expect(resolveBillingChargeDisplayStatus('SOME_FUTURE', 20, 5)).toBe(
      'SOME_FUTURE',
    );
  });

  it('keeps BILLING_CHARGE_STATUS_LABELS an exact Prisma mirror', () => {
    // `charge-history-service.ts` compile-asserts this union equals the Prisma
    // enum, so the derived status must live in the separate display map only.
    expect(Object.keys(BILLING_CHARGE_STATUS_LABELS)).not.toContain(
      'PARTIALLY_REFUNDED',
    );
  });
});

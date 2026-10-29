import {
  buildBillingPaymentModalIntentPath,
  parseBillingPaymentModalIntent,
  stripBillingPaymentModalIntentParams,
} from '../payment-intent';
import { accountBillingPath, organizationBillingPath } from '../index';
import { parseBillingTopUpIntent } from '../top-up-intent';

function parse(
  query: string,
): ReturnType<typeof parseBillingPaymentModalIntent> {
  return parseBillingPaymentModalIntent(new URLSearchParams(query));
}

describe('parseBillingPaymentModalIntent', () => {
  it('parses each modal', () => {
    expect(parse('paymentModal=payment-method&paymentRequestId=r1')).toEqual({
      modal: 'payment-method',
      requestId: 'r1',
    });
    expect(parse('paymentModal=auto-top-up&paymentRequestId=r2')).toEqual({
      modal: 'auto-top-up',
      requestId: 'r2',
    });
    expect(parse('paymentModal=subscription&paymentRequestId=r3')).toEqual({
      modal: 'subscription',
      requestId: 'r3',
    });
    expect(
      parse('paymentModal=subscription&paymentRequestId=r4&plan=business'),
    ).toEqual({ modal: 'subscription', requestId: 'r4', plan: 'business' });
  });

  it('returns null when no intent is present', () => {
    expect(parse('')).toBeNull();
    expect(parse('tab=billing&plan=business')).toBeNull();
  });

  it('rejects duplicate parameters', () => {
    expect(
      parse(
        'paymentModal=payment-method&paymentModal=auto-top-up&paymentRequestId=r1',
      ),
    ).toBeNull();
    expect(
      parse(
        'paymentModal=payment-method&paymentRequestId=r1&paymentRequestId=r2',
      ),
    ).toBeNull();
    expect(
      parse(
        'paymentModal=subscription&paymentRequestId=r1&plan=business&plan=individual',
      ),
    ).toBeNull();
  });

  it('rejects unknown modals and invalid request ids', () => {
    expect(parse('paymentModal=checkout&paymentRequestId=r1')).toBeNull();
    expect(parse('paymentModal=payment-method')).toBeNull();
    expect(
      parse('paymentModal=payment-method&paymentRequestId=bad%20id'),
    ).toBeNull();
    expect(
      parse(`paymentModal=payment-method&paymentRequestId=${'a'.repeat(129)}`),
    ).toBeNull();
  });

  it('rejects a top-up intent alongside a modal intent', () => {
    expect(
      parse(
        'paymentModal=payment-method&paymentRequestId=r1&topUp=1&reason=credits&source=desktop',
      ),
    ).toBeNull();
  });

  it('rejects a plan on the wrong modal and unpaid plans', () => {
    expect(
      parse('paymentModal=payment-method&paymentRequestId=r1&plan=business'),
    ).toBeNull();
    expect(
      parse('paymentModal=auto-top-up&paymentRequestId=r1&plan=business'),
    ).toBeNull();
    expect(
      parse('paymentModal=subscription&paymentRequestId=r1&plan=free'),
    ).toBeNull();
    expect(
      parse('paymentModal=subscription&paymentRequestId=r1&plan=legacy-pro'),
    ).toBeNull();
  });
});

describe('buildBillingPaymentModalIntentPath', () => {
  it('targets the personal wallet path', () => {
    expect(
      buildBillingPaymentModalIntentPath(accountBillingPath(), {
        modal: 'payment-method',
        requestId: 'r1',
      }),
    ).toBe('/account/billing?paymentModal=payment-method&paymentRequestId=r1');
  });

  it('keeps the organization Settings billing subtab', () => {
    expect(
      buildBillingPaymentModalIntentPath(organizationBillingPath('org_1'), {
        modal: 'subscription',
        requestId: 'r2',
        plan: 'business',
      }),
    ).toBe(
      '/organization/org_1/settings?tab=billing&paymentModal=subscription&paymentRequestId=r2&plan=business',
    );
  });

  it('preserves unrelated query parameters and the hash', () => {
    const path = buildBillingPaymentModalIntentPath(
      '/account/billing?utm=desktop#invoices',
      { modal: 'auto-top-up', requestId: 'r3' },
    );
    expect(path).toBe(
      '/account/billing?utm=desktop&paymentModal=auto-top-up&paymentRequestId=r3#invoices',
    );
    expect(
      parseBillingPaymentModalIntent(
        new URL(path, 'https://x.invalid').searchParams,
      ),
    ).toEqual({ modal: 'auto-top-up', requestId: 'r3' });
  });

  it('replaces a previous modal intent instead of duplicating it', () => {
    expect(
      buildBillingPaymentModalIntentPath(
        '/account/billing?paymentModal=auto-top-up&paymentRequestId=old',
        { modal: 'payment-method', requestId: 'new' },
      ),
    ).toBe('/account/billing?paymentModal=payment-method&paymentRequestId=new');
  });

  it('throws for conflicting or unsafe paths', () => {
    expect(() =>
      buildBillingPaymentModalIntentPath(
        '/account/billing?topUp=1&reason=credits&source=desktop',
        { modal: 'payment-method', requestId: 'r1' },
      ),
    ).toThrow();
    expect(() =>
      buildBillingPaymentModalIntentPath(
        accountBillingPath({ plan: 'business' }),
        {
          modal: 'payment-method',
          requestId: 'r1',
        },
      ),
    ).toThrow();
    expect(() =>
      buildBillingPaymentModalIntentPath('https://evil.example/account', {
        modal: 'payment-method',
        requestId: 'r1',
      }),
    ).toThrow();
    expect(() =>
      buildBillingPaymentModalIntentPath(accountBillingPath(), {
        modal: 'payment-method',
        requestId: 'not valid',
      }),
    ).toThrow();
  });

  it('leaves existing top-up links unchanged', () => {
    const params = new URLSearchParams('topUp=1&reason=credits&source=desktop');
    expect(parseBillingTopUpIntent(params)).toEqual({
      reason: 'credits',
      source: 'desktop',
    });
    expect(parseBillingPaymentModalIntent(params)).toBeNull();
  });
});

describe('stripBillingPaymentModalIntentParams', () => {
  it('removes only the intent parameters', () => {
    expect(
      stripBillingPaymentModalIntentParams(
        '/organization/o/settings?tab=billing&paymentModal=subscription&paymentRequestId=r&plan=business&utm=x#top',
      ),
    ).toBe('/organization/o/settings?tab=billing&utm=x#top');
  });
});

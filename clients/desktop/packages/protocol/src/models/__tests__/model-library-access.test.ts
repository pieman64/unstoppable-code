import {
  decideModelLibraryAccess,
  isModelLibraryAccess,
  MODEL_LIBRARY_ACCESS_VALUES,
} from '../model-library-access';
import {
  buildBillingTopUpIntentPath,
  parseBillingTopUpIntent,
  buildDesktopBillingDeepLink,
  parseDesktopBillingDeepLink,
} from '../../billing/top-up-intent';
import {
  parseCanopyProxyError,
  AI_CREDITS_PROXY_ERROR_MARKER,
} from '../../llm-gateway';
describe('model library contract', () => {
  it.each([
    [true, false, false, 'needs_sign_in'],
    [true, true, false, 'needs_sign_in_then_purchase'],
    [true, true, true, 'needs_sign_in_then_purchase'],
    [false, false, false, 'unlocked'],
    [false, true, false, 'needs_purchase'],
    [false, true, true, 'unlocked'],
  ] as const)(
    'decides principal=%s gate=%s paid=%s',
    (isGuest, requiresPurchase, hasQualifyingPurchaseOrCoverage, expected) => {
      expect(
        decideModelLibraryAccess({
          isGuest,
          requiresPurchase,
          hasQualifyingPurchaseOrCoverage,
        }),
      ).toBe(expected);
    },
  );
  it('validates only known wire access states', () => {
    for (const value of MODEL_LIBRARY_ACCESS_VALUES)
      expect(isModelLibraryAccess(value)).toBe(true);
    for (const value of [null, undefined, {}, 'paid', true])
      expect(isModelLibraryAccess(value)).toBe(false);
  });
  it('retains owner query and separate web/chat return intent', () => {
    const path = buildBillingTopUpIntentPath(
      '/organization/org/settings?tab=billing&keep=1',
      {
        reason: 'unlock_models',
        source: 'picker',
        amountUsd: 20,
        chatId: 'chat-1',
        modelId: 'openai/model',
        requestId: 'req-1',
        webReturnPath: '/chat?keep=1',
      },
    );
    const url = new URL(path, 'https://local.invalid');
    expect(url.searchParams.get('tab')).toBe('billing');
    expect(url.searchParams.get('keep')).toBe('1');
    expect(parseBillingTopUpIntent(url.searchParams)).toMatchObject({
      chatId: 'chat-1',
      webReturnPath: '/chat?keep=1',
      amountUsd: 20,
    });
  });
  it.each([
    'amountUsd=NaN',
    'amountUsd=4',
    'amountUsd=1001',
    'amountUsd=5.001',
    'source=picker&source=banner',
    'requestId=' + 'x'.repeat(129),
    'webReturnPath=https://evil.invalid',
    'webReturnPath=//evil.invalid',
    'webReturnPath=/\\evil.invalid',
  ])('refuses malformed query %s', (query) => {
    const params = new URLSearchParams(
      'topUp=1&reason=unlock_models&source=picker',
    );
    for (const [key, value] of new URLSearchParams(query))
      params.append(String(key), String(value));
    expect(parseBillingTopUpIntent(params)).toBeNull();
  });
  it('round-trips bounded desktop links without navigation authority', () => {
    const intent = {
      requestId: 'req-1',
      modelId: 'openai/model',
      chatId: 'chat-1',
    };
    expect(
      parseDesktopBillingDeepLink(
        buildDesktopBillingDeepLink(intent, 'canopy'),
        'canopy',
      ),
    ).toEqual(intent);
    for (const suffix of [
      '&requestId=req-2',
      '&webReturnPath=/chat',
      '#fragment',
      '&modelId=' + 'x'.repeat(200),
    ])
      expect(
        parseDesktopBillingDeepLink(
          'canopy://billing/unlocked?requestId=req-1' + suffix,
          'canopy',
        ),
      ).toBeNull();
  });
  it('accepts validated proxy recovery and preserves unknown-code compatibility', () => {
    const error = (code: string, recovery: string): string =>
      JSON.stringify({
        error: { canopy_proxy: AI_CREDITS_PROXY_ERROR_MARKER, code, recovery },
      });
    expect(
      parseCanopyProxyError(error('model_locked', 'add_credits')),
    ).toMatchObject({ code: 'model_locked', recovery: 'add_credits' });
    expect(
      parseCanopyProxyError(error('model_locked', 'redirect')),
    ).not.toHaveProperty('recovery');
    expect(
      parseCanopyProxyError(error('future_code', 'add_credits'))?.code,
    ).toBe('proxy_internal_error');
  });
});

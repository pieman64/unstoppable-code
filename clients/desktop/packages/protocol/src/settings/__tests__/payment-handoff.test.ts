import {
  settingsPaymentHandoffRequestSchema,
  settingsPaymentHandoffResultSchema,
} from '../payment-handoff';

describe('payment handoff contract', () => {
  const request = {
    owner: { kind: 'personal' },
    intent: { kind: 'top-up', reason: 'unlock_models' },
  };

  it('accepts legacy requests and successes', () => {
    expect(settingsPaymentHandoffRequestSchema.parse(request)).toEqual(request);
    expect(settingsPaymentHandoffResultSchema.parse({ ok: true })).toEqual({
      ok: true,
    });
  });

  it('preserves validated unlock attribution', () => {
    const attributed = {
      ...request,
      intent: {
        ...request.intent,
        source: 'picker',
        modelId: 'provider/model:1',
        chatId: 'chat-1',
      },
    };
    expect(settingsPaymentHandoffRequestSchema.safeParse(attributed)).toEqual({
      success: true,
      data: attributed,
    });
  });

  it('accepts a main-generated correlation id on success', () => {
    const result = { ok: true, requestId: 'request-1' };
    expect(settingsPaymentHandoffResultSchema.safeParse(result)).toEqual({
      success: true,
      data: result,
    });
  });

  it.each([
    { source: 'unknown' },
    { modelId: '' },
    { chatId: 'has spaces' },
    { modelId: 'x'.repeat(193) },
    { requestId: 'caller-supplied' },
    { extra: true },
    { amountUsd: 4 },
    { amountUsd: 1001 },
  ])('rejects invalid attribution and caller fields: %j', (fields) => {
    expect(
      settingsPaymentHandoffRequestSchema.safeParse({
        ...request,
        intent: { ...request.intent, ...fields },
      }).success,
    ).toBe(false);
  });

  it.each([
    { ok: true, requestId: '' },
    { ok: true, requestId: 'has spaces' },
    { ok: true, requestId: 'x'.repeat(129) },
    { ok: false, reason: 'failed', requestId: 'request-1' },
    { ok: true, extra: true },
  ])('rejects malformed results: %j', (result) => {
    expect(settingsPaymentHandoffResultSchema.safeParse(result).success).toBe(
      false,
    );
  });

  it('keeps modal intents strict', () => {
    expect(
      settingsPaymentHandoffRequestSchema.safeParse({
        owner: request.owner,
        intent: { kind: 'modal', modal: 'payment-method', source: 'picker' },
      }).success,
    ).toBe(false);
    expect(
      settingsPaymentHandoffRequestSchema.safeParse({
        owner: request.owner,
        intent: { kind: 'modal', modal: 'auto-top-up', plan: 'business' },
      }).success,
    ).toBe(false);
  });
});

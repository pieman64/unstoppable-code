import {
  AI_CREDITS_CONCURRENCY_GUARD,
  AI_CREDITS_GATEWAY_DELIVERY,
  AI_CREDITS_PROXY_ERROR_MARKER,
  AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE,
  parseCanopyProxyError,
  type AiCreditsBalance,
  type AiCreditsSource,
  type AiCreditsSubscription,
} from '../index';
import { CANOPY_SERVER_CAPABILITIES } from '../../canopy-server';

describe('gateway contracts', () => {
  it('advertises the llm-proxy-v1 capability', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('llm-proxy-v1');
  });

  it('requires a source on the AI Credits balance/subscription contracts', () => {
    const sources: AiCreditsSource[] = ['unstoppable', 'canopy'];
    for (const source of sources) {
      const balance: AiCreditsBalance = {
        email: 'u@example.com',
        credits: 5,
        eligible: true,
        source,
        orgPool: null,
      };
      const subscription: AiCreditsSubscription = {
        email: 'u@example.com',
        active: true,
        source,
      };
      expect(balance.source).toBe(source);
      expect(subscription.source).toBe(source);
    }
  });

  it('reserves a distinct, non-429 status for the AI Credits concurrency guard', () => {
    // The desktop on-quota fallback (CAN-838) treats a 429 as a provider usage
    // limit, so the proxy's own concurrency guard must never use 429.
    expect(AI_CREDITS_CONCURRENCY_GUARD.httpStatus).not.toBe(429);
    expect(AI_CREDITS_CONCURRENCY_GUARD.retryAfterMinSeconds).toBeGreaterThan(
      0,
    );
    expect(AI_CREDITS_CONCURRENCY_GUARD.markerHeader).toMatch(/^x-/);
    expect(AI_CREDITS_CONCURRENCY_GUARD.markerValue.length).toBeGreaterThan(0);
    expect(AI_CREDITS_CONCURRENCY_GUARD.bodyCode.length).toBeGreaterThan(0);
  });

  it('pins the guard fields that installed desktops read from their own bundled copy', () => {
    // Hosted and desktop deploy independently. A desktop identifies a guard
    // rejection by these three values alone, so they must never move.
    expect(AI_CREDITS_CONCURRENCY_GUARD.httpStatus).toBe(503);
    expect(AI_CREDITS_CONCURRENCY_GUARD.markerHeader).toBe(
      'x-canopy-ai-credits-guard',
    );
    expect(AI_CREDITS_CONCURRENCY_GUARD.markerValue).toBe(
      'concurrent-request-in-progress',
    );
  });

  it('bounds the jittered guard Retry-After with positive integers', () => {
    const { retryAfterMinSeconds, retryAfterMaxSeconds } =
      AI_CREDITS_CONCURRENCY_GUARD;
    expect(Number.isInteger(retryAfterMinSeconds)).toBe(true);
    expect(Number.isInteger(retryAfterMaxSeconds)).toBe(true);
    expect(retryAfterMinSeconds).toBeGreaterThan(0);
    expect(retryAfterMaxSeconds).toBeGreaterThanOrEqual(retryAfterMinSeconds);
  });

  it('carries distinguishable delivery provenance for synthesized gateway failures', () => {
    // The desktop proxy replays a billed, non-idempotent POST on status alone,
    // so the two values must be distinct and non-empty: collapsing them would
    // silently restore the double-charge this contract exists to prevent.
    expect(AI_CREDITS_GATEWAY_DELIVERY.header).toMatch(/^x-/);
    expect(AI_CREDITS_GATEWAY_DELIVERY.notSent).not.toBe(
      AI_CREDITS_GATEWAY_DELIVERY.ambiguous,
    );
    expect(AI_CREDITS_GATEWAY_DELIVERY.notSent.length).toBeGreaterThan(0);
    expect(AI_CREDITS_GATEWAY_DELIVERY.ambiguous.length).toBeGreaterThan(0);
  });

  it('parses a marked no-billing-source failure from a complete body', () => {
    expect(
      parseCanopyProxyError(
        `unexpected status 402: {"error":{"canopy_proxy":"${AI_CREDITS_PROXY_ERROR_MARKER}","code":"no_billing_source","correlation_id":"request-402","message":"AI Credits are unavailable."}}`,
      ),
    ).toEqual({
      code: 'no_billing_source',
      message: 'AI Credits are unavailable.',
      correlationId: 'request-402',
    });
  });

  it('preserves the structured owner-funding refusal reason', () => {
    expect(
      parseCanopyProxyError(
        `unexpected status 402: {"error":{"canopy_proxy":"${AI_CREDITS_PROXY_ERROR_MARKER}","code":"no_billing_source","reason":"organization_pool_unavailable","message":"AI Credits are unavailable."}}`,
      ),
    ).toEqual({
      code: 'no_billing_source',
      reason: 'organization_pool_unavailable',
      message: 'AI Credits are unavailable.',
      correlationId: null,
    });
  });

  it('parses a truncated no-billing-source body before its correlation id', () => {
    expect(
      parseCanopyProxyError(
        `unexpected status 402: {"error":{"canopy_proxy":"${AI_CREDITS_PROXY_ERROR_MARKER}","code":"no_billing_source"`,
      ),
    ).toEqual({
      code: 'no_billing_source',
      message: null,
      correlationId: null,
    });
  });

  it('parses a session-budget-exhausted proxy failure', () => {
    expect(
      parseCanopyProxyError(
        `unexpected status 402: {"error":{"canopy_proxy":"${AI_CREDITS_PROXY_ERROR_MARKER}","code":"session_budget_exhausted","correlation_id":"request-budget","message":"Session budget exhausted."}}`,
      ),
    ).toEqual({
      code: 'session_budget_exhausted',
      message: 'Session budget exhausted.',
      correlationId: 'request-budget',
    });
  });

  it('parses a work-owner refusal from a complete body', () => {
    expect(
      parseCanopyProxyError(
        `unexpected status 403: {"error":{"canopy_proxy":"${AI_CREDITS_PROXY_ERROR_MARKER}","code":"work_owner_not_member","correlation_id":"request-403","message":"${AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE.replace("'", '\\u0027')}"}}`,
      ),
    ).toEqual({
      code: 'work_owner_not_member',
      message: AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE,
      correlationId: 'request-403',
    });
  });

  it('parses a truncated work-owner refusal before its correlation id', () => {
    expect(
      parseCanopyProxyError(
        `unexpected status 403: {"error":{"canopy_proxy":"${AI_CREDITS_PROXY_ERROR_MARKER}","code":"work_owner_not_member"`,
      ),
    ).toEqual({
      code: 'work_owner_not_member',
      message: null,
      correlationId: null,
    });
  });

  it('keeps the work-owner refusal message free of em dashes', () => {
    expect(AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE).not.toMatch(/\u2014/);
  });
});

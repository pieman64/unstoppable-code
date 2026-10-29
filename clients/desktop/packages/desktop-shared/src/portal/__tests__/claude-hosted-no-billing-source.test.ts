import { detectClaudeHostedNoBillingSource } from '../provider-usage-limit';
import {
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE as message,
  AI_CREDITS_PROXY_ERROR_MARKER as marker,
} from '@canopy/protocol';

const expected = { code: 'no_billing_source', message, correlationId: null };
const failure = {
  type: 'result',
  is_error: true,
  api_error_status: 402,
  result: message,
};

describe('detectClaudeHostedNoBillingSource', () => {
  it.each([
    failure,
    { type: 'result', is_error: true, result: `API Error: 402 ${message}` },
    { ...failure, result: `  ${message}  ` },
    { ...failure, result: '', error: { message } },
    { ...failure, result: '', message },
    { ...failure, result: '', error: message },
    { type: 'error', api_error_status: 402, error: message },
    {
      type: 'assistant',
      api_error_status: 402,
      error: 'billing_error',
      message: {
        content: [{ type: 'text', text: `API Error: 402 ${message}` }],
      },
    },
    // SDK-faithful synthetic error frame: the harness never emits
    // `api_error_status` on assistant frames, only on the terminal result.
    {
      type: 'assistant',
      error: 'billing_error',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: `API Error: 402 ${message}` }],
      },
    },
  ])('accepts a narrow refusal in supported shape %j', (event) => {
    expect(detectClaudeHostedNoBillingSource(event)).toEqual(expected);
  });
  it.each([
    null,
    [],
    {},
    { ...failure, is_error: false },
    { type: 'assistant', api_error_status: 402, message },
    // Without a status field, an assistant frame needs the exact 402 prefix.
    {
      type: 'assistant',
      error: 'billing_error',
      message: { content: [{ type: 'text', text: message }] },
    },
    {
      type: 'assistant',
      error: 'billing_error',
      message: {
        content: [{ type: 'text', text: `API Error: 403 ${message}` }],
      },
    },
    // A present status field still wins over the rendered prefix.
    {
      type: 'assistant',
      api_error_status: 401,
      error: 'billing_error',
      message: {
        content: [{ type: 'text', text: `API Error: 402 ${message}` }],
      },
    },
    { ...failure, result: `${message} Extra text` },
    { ...failure, result: `quoted ${message}` },
    { ...failure, result: message.toLowerCase() },
    { ...failure, result: `API Error: 403 ${message}` },
    { ...failure, api_error_status: 401, result: `API Error: 402 ${message}` },
    { ...failure, api_error_status: '402' },
    { ...failure, result: '', errors: [message] },
    { ...failure, result: 'different result', error: { message } },
    { ...failure, result: '', error: { message: 'different error' }, message },
    {
      ...failure,
      result: '',
      message: {
        content: [
          { type: 'text', text: message },
          { type: 'text', text: 'extra' },
        ],
      },
    },
    { ...failure, code: 'session_budget_exhausted' },
    { ...failure, code: 'no_billing_source' },
    { ...failure, error_code: 'ECONNRESET' },
    { ...failure, error: { code: 'credentials_unavailable', message } },
    { ...failure, error: 'rate_limit' },
    { ...failure, error: 'authentication_failed' },
    { ...failure, canopy_ai_credits_no_billing_source: true },
    { ...failure, error: { canopy_proxy: marker, code: 'unknown_code' } },
  ])('leaves nonqualifying events unchanged %j', (event) => {
    expect(detectClaudeHostedNoBillingSource(event)).toBeNull();
  });
  it.each([
    'no_billing_source',
    'session_budget_exhausted',
    'unknown_code',
    'credentials_unavailable',
  ])('preserves a surviving marked %s body in any relevant field', (code) => {
    const body = JSON.stringify({
      error: {
        canopy_proxy: marker,
        code,
        correlation_id: 'original-id',
        message,
      },
    });
    expect(
      detectClaudeHostedNoBillingSource({ ...failure, errors: [body] }),
    ).toBeNull();
  });
  it('blocks inference from malformed marked bodies', () => {
    expect(
      detectClaudeHostedNoBillingSource({
        ...failure,
        errors: [`${marker} broken body`],
      }),
    ).toBeNull();
  });

  it.each([
    'oauth_org_not_allowed',
    'account_on_hold',
    'verification_required',
    'overloaded',
    'invalid_request',
    'model_not_found',
    'max_output_tokens',
    'cloud_credential_error',
  ])('preserves the SDK conflicting error code %s', (error) => {
    expect(detectClaudeHostedNoBillingSource({ ...failure, error })).toBeNull();
  });
});

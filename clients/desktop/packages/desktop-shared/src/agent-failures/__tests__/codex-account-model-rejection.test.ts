import { classifyCodexAccountModelRejection } from '../codex-account-model-rejection';

const REJECTION =
  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";

describe('classifyCodexAccountModelRejection (CAN-4716)', () => {
  it('captures the refused model from plain text', () => {
    expect(classifyCodexAccountModelRejection(REJECTION)).toEqual({
      kind: 'model_unsupported',
      model: 'gpt-6.1-sol',
    });
  });

  it('reads the message out of a JSON error body, after a status prefix', () => {
    const body = JSON.stringify({
      error: { message: REJECTION, type: 'invalid_request_error' },
      status: 400,
    });
    expect(
      classifyCodexAccountModelRejection(
        `unexpected status 400 Bad Request: ${body}`,
        'badRequest',
      ),
    ).toEqual({ kind: 'model_unsupported', model: 'gpt-6.1-sol' });
    expect(
      classifyCodexAccountModelRejection(JSON.stringify({ detail: REJECTION })),
    ).toMatchObject({ model: 'gpt-6.1-sol' });
  });

  it('tolerates the badRequest and other variants and an absent one', () => {
    for (const info of [undefined, 'badRequest', 'other']) {
      expect(
        classifyCodexAccountModelRejection(REJECTION, info),
      ).not.toBeNull();
    }
  });

  it.each([
    { httpConnectionFailed: { httpStatusCode: 400 } },
    { responseStreamConnectionFailed: { httpStatusCode: 400 } },
    { httpConnectionFailed: { httpStatusCode: null } },
  ])('tolerates the HTTP 400 connection variant %j', (info) => {
    expect(classifyCodexAccountModelRejection(REJECTION, info)).not.toBeNull();
  });

  it.each([
    'unauthorized',
    'usageLimitExceeded',
    { httpConnectionFailed: { httpStatusCode: 401 } },
    { responseStreamDisconnected: { httpStatusCode: 400 } },
  ])('rejects the definitive %j variant', (info) => {
    expect(classifyCodexAccountModelRejection(REJECTION, info)).toBeNull();
  });

  it.each([
    undefined,
    '',
    'Codex turn failed',
    "The 'gpt-6.1-sol' model is not supported.",
    'model is not supported when using Codex with a ChatGPT account',
    '{"error":{"message":"rate limited"}}',
  ])('returns null for %j', (error) => {
    expect(classifyCodexAccountModelRejection(error)).toBeNull();
  });
});

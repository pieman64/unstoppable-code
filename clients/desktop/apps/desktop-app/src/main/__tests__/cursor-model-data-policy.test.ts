const mockToken = jest.fn<Promise<string | null>, [unknown, AbortSignal]>();
jest.mock('../cursor/account-credentials', () => ({
  readCursorAccessToken: (
    env: unknown,
    signal: AbortSignal,
  ): Promise<string | null> => mockToken(env, signal),
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({
  getMockLlmOrigin: (): null => null,
  getMockApiKey: (): string => 'mock',
}));

import { cursorDataPolicyMessage } from '../cursor/model-data-policy';

function requestUrl(value: RequestInfo | URL): string {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.href
      : value.url;
}

const fable = {
  name: 'claude-fable-5-1',
  clientDisplayName: 'Claude Fable 5.1',
  requiresDataRetention: true,
  reasonForZdrConsentBlock: 'individual_settings_blocked',
};
const listing = (models: unknown[]): Response =>
  new Response(JSON.stringify({ models }), { status: 200 });
const env = { HOME: '/private', NO_OPEN_BROWSER: '1' };
const variant = 'claude-fable-5-1[thinking=true,effort=high]';

describe('Cursor model data policy lookup', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn<
    Promise<Response>,
    [RequestInfo | URL, RequestInit?]
  >();
  beforeEach(() => {
    jest.clearAllMocks();
    mockToken.mockResolvedValue('private-test-access-token');
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        listing([
          { name: 'gpt-6-luna', clientDisplayName: 'GPT-6 Luna' },
          fable,
        ]),
      ),
    );
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('names the policy the account itself must accept, in the catalog style', async () => {
    await expect(
      cursorDataPolicyMessage(variant, env, new AbortController().signal),
    ).resolves.toBe(
      'To use Fable 5.1, accept its data retention policy in your Cursor dashboard, then try again, or choose another model.',
    );
  });

  it('points at the team admin for any other consent block', async () => {
    fetchMock.mockResolvedValue(
      listing([{ ...fable, reasonForZdrConsentBlock: 'team_admin_blocked' }]),
    );
    await expect(
      cursorDataPolicyMessage(variant, env, new AbortController().signal),
    ).resolves.toBe(
      "Ask your Cursor team admin to accept Fable 5.1's data retention policy, or choose another model.",
    );
  });

  it.each([
    ['is missing', undefined],
    ['is empty', ''],
    ['is too long', 'X'.repeat(101)],
    ['has control characters', 'Claude\u0007Fable'],
  ])(
    'falls back to a generic name when the display name %s',
    async (_, name) => {
      fetchMock.mockResolvedValue(
        listing([{ ...fable, clientDisplayName: name }]),
      );
      await expect(
        cursorDataPolicyMessage(variant, env, new AbortController().signal),
      ).resolves.toBe(
        'To use this model, accept its data retention policy in your Cursor dashboard, then try again, or choose another model.',
      );
    },
  );

  it.each([
    ['the model is not flagged', [{ ...fable, requiresDataRetention: false }]],
    [
      'the model is flagged without a reason',
      [{ ...fable, reasonForZdrConsentBlock: undefined }],
    ],
    ['the reason is empty', [{ ...fable, reasonForZdrConsentBlock: '' }]],
    ['the model is absent', [{ ...fable, name: 'claude-fable-5' }]],
    ['the listing is empty', []],
  ])('keeps the generic copy when %s', async (_, models) => {
    fetchMock.mockResolvedValue(listing(models));
    await expect(
      cursorDataPolicyMessage(variant, env, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('keeps the generic copy for Auto', async () => {
    await expect(
      cursorDataPolicyMessage('default[]', env, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('does no network work without a token', async () => {
    mockToken.mockResolvedValue(null);
    await expect(
      cursorDataPolicyMessage(variant, env, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])(
    'keeps the generic copy on HTTP %i without exposing the body',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response('private-test-access-token sensitive-body', { status }),
      );
      await expect(
        cursorDataPolicyMessage(variant, env, new AbortController().signal),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    ['malformed JSON', 'not json'],
    ['a non-object payload', '[]'],
    ['a listing without models', '{"models":{}}'],
    [
      'an oversized body',
      `{"models":[${JSON.stringify(fable)}],"pad":"${' '.repeat(4 * 1024 * 1024)}"}`,
    ],
  ])('keeps the generic copy for %s', async (_, payload) => {
    fetchMock.mockResolvedValue(new Response(payload, { status: 200 }));
    await expect(
      cursorDataPolicyMessage(variant, env, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('keeps the generic copy when the request times out or is aborted', async () => {
    // Like fetch: reject at once on an aborted signal, otherwise on abort.
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          if (options?.signal?.aborted) reject(error());
          options?.signal?.addEventListener('abort', () => reject(error()), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = cursorDataPolicyMessage(variant, env, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A signal aborted before the token read stops there.
    mockToken.mockRejectedValue(error());
    await expect(
      cursorDataPolicyMessage(variant, env, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('sends one bounded read-only AvailableModels request with the CLI identity', async () => {
    const signal = new AbortController().signal;
    await cursorDataPolicyMessage(variant, env, signal);
    expect(mockToken).toHaveBeenCalledWith(env, expect.any(AbortSignal));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(requestUrl(url)).toBe(
      'https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels',
    );
    const clientVersion: unknown = expect.stringMatching(/^cli-\d/);
    expect(options).toEqual(
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ useModelParameters: true }),
        headers: {
          Authorization: 'Bearer private-test-access-token',
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-cursor-client-type': 'cli',
          'x-cursor-client-version': clientVersion,
        },
      }),
    );
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    // The lookup carries its own deadline, so it never hands the turn's
    // signal through unchanged.
    expect(options?.signal).not.toBe(signal);
  });
});

function error(): Error {
  const failure = new Error('Timeout');
  failure.name = 'TimeoutError';
  return failure;
}

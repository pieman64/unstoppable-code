import type { CanopyCloudAuthenticatedRequestInit } from '../canopy-cloud/client';

const getCanopyCloudCredentialsMock = jest.fn<Promise<unknown>, []>();
const requestCanopyCloudJsonMock = jest.fn<
  Promise<unknown>,
  [string, CanopyCloudAuthenticatedRequestInit | undefined]
>();

jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): Promise<unknown> =>
    getCanopyCloudCredentialsMock(),
}));

jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (
    path: string,
    init: CanopyCloudAuthenticatedRequestInit | undefined,
  ): Promise<unknown> => requestCanopyCloudJsonMock(path, init),
}));

// Per-org billing gate (CAN-2311). Keyed by org id so a lapsed org can be
// asserted alongside a healthy one in the same run.
const isOrganizationTeamsLapsedMock = jest.fn<Promise<boolean>, [string]>();
jest.mock('../lib/org-billing-state', () => ({
  isOrganizationTeamsLapsed: (organizationId: string): Promise<boolean> =>
    isOrganizationTeamsLapsedMock(organizationId),
}));

// Asserting the body is a JSON string keeps the mock/production request-shape
// contract enforced at runtime instead of assumed by a type assertion.
function parseRequestBody(
  init: CanopyCloudAuthenticatedRequestInit | undefined,
): unknown {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error(`expected a JSON string request body, got ${typeof body}`);
  }
  return JSON.parse(body);
}

import {
  ACK_RETRY_BASE_DELAY_MS,
  ACK_RETRY_JITTER_MS,
  CLIENT_FETCH_TIMEOUT_MS,
  FEEDBACK_FETCH_TIMEOUT_MS,
  MEMORY_BREAKER_COOLDOWN_MS,
  MEMORY_BREAKER_THRESHOLD,
  ackOrgMemoryDelivered,
  fetchOrgMemory,
  fetchOrgMemoryAttempt,
  getOrgMemoryFeedback,
  resetOrgMemoryBreakerForTest,
  submitOrgMemoryFeedback,
} from '../memory/memory-client';

// Organization-memory calls carry the org explicitly (CAN-3457): the org that
// owns the work for a search, or the org a search was made in for its ack and
// feedback. The account's deprecated single-org field is never read.
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('organization memory client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetOrgMemoryBreakerForTest();
    isOrganizationTeamsLapsedMock.mockResolvedValue(false);
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: ['memorySearch'],
      memorySearchOrganizationExternalId: ORG,
      memorySearchOrganizationExternalIds: [ORG, OTHER_ORG],
    });
    requestCanopyCloudJsonMock.mockResolvedValue({
      searchId: 'search-1',
      facts: [{ factText: 'fact', validAt: null, sourceTurnIds: ['turn-1'] }],
      renderedBlock: '<org_memory>fact</org_memory>',
      diagnostics: {
        laneCounts: { vector: 1, fts: 1, trigram: 0 },
        rerankUsed: true,
        topRerankScore: 0.9,
        topCosineScore: 0.8,
        gatePassed: true,
        latencyMs: 25,
      },
    });
  });

  it('does no network request without the capability', async () => {
    getCanopyCloudCredentialsMock.mockResolvedValue({
      apiKey: 'key',
      capabilities: [],
    });
    await expect(fetchOrgMemory(ORG, 'query')).resolves.toBeNull();
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
  });

  it('posts the protocol request with the explicit 1500ms timeout', async () => {
    await expect(fetchOrgMemory(ORG, 'query')).resolves.toEqual({
      renderedBlock: '<org_memory>fact</org_memory>',
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/memory\/search$/),
      expect.objectContaining({
        method: 'POST',
        timeoutMs: CLIENT_FETCH_TIMEOUT_MS,
        body: JSON.stringify({
          organizationExternalId: ORG,
          query: 'query',
        }),
      }),
    );
  });

  it('returns the fetched facts with an injected block', async () => {
    await expect(
      fetchOrgMemoryAttempt(ORG, 'query', false),
    ).resolves.toMatchObject({
      result: {
        organizationExternalId: ORG,
        searchId: 'search-1',
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [
          {
            factText: 'fact',
            validAt: null,
            sourceTurnIds: ['turn-1'],
          },
        ],
      },
    });
  });

  it('carries the trimmed lexicalQuery alongside the enriched query', async () => {
    await fetchOrgMemoryAttempt(
      ORG,
      'repo — worktree — deploy the proxy\nEarlier requests: staging',
      false,
      '  deploy the proxy  ',
    );
    const parsed = parseRequestBody(
      requestCanopyCloudJsonMock.mock.calls[0]?.[1],
    );
    expect(parsed).toEqual({
      organizationExternalId: ORG,
      query: 'repo — worktree — deploy the proxy\nEarlier requests: staging',
      lexicalQuery: 'deploy the proxy',
    });
  });

  it('omits lexicalQuery when absent or blank after trimming', async () => {
    await fetchOrgMemoryAttempt(ORG, 'query', false);
    await fetchOrgMemoryAttempt(ORG, 'query', false, '   \n  ');
    for (const call of requestCanopyCloudJsonMock.mock.calls) {
      const parsed = parseRequestBody(call[1]);
      expect(parsed).toEqual({
        organizationExternalId: ORG,
        query: 'query',
      });
    }
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
  });

  it('sets debug only for the enriched single request', async () => {
    await fetchOrgMemoryAttempt(ORG, 'query', true);
    const parsed = parseRequestBody(
      requestCanopyCloudJsonMock.mock.calls[0]?.[1],
    );
    expect(parsed).toEqual({
      organizationExternalId: ORG,
      query: 'query',
      debug: true,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
  });

  it('returns gate-silent diagnostics and fails open on errors', async () => {
    requestCanopyCloudJsonMock.mockResolvedValueOnce({
      facts: [],
      renderedBlock: null,
      diagnostics: {
        laneCounts: { vector: 2, fts: 0, trigram: 0 },
        rerankUsed: true,
        topRerankScore: 0.2,
        topCosineScore: 0.4,
        gatePassed: false,
        latencyMs: 20,
      },
    });
    await expect(fetchOrgMemoryAttempt(ORG, 'query', true)).resolves.toEqual(
      expect.objectContaining({
        result: null,
        factCount: 0,
        responseReceived: true,
      }),
    );

    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchOrgMemory(ORG, 'query')).resolves.toBeNull();
  });

  it('posts fact feedback to the feedback endpoint', async () => {
    requestCanopyCloudJsonMock.mockResolvedValueOnce({ recorded: true });
    await expect(
      submitOrgMemoryFeedback({
        organizationExternalId: ORG,
        searchId: 'search-1',
        factId: 'fact-1',
        rating: 'dislike',
        comment: 'Stale value.',
      }),
    ).resolves.toEqual({ recorded: true });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/memory\/feedback$/),
      expect.objectContaining({
        method: 'POST',
        timeoutMs: FEEDBACK_FETCH_TIMEOUT_MS,
        body: JSON.stringify({
          organizationExternalId: ORG,
          searchId: 'search-1',
          factId: 'fact-1',
          rating: 'dislike',
          comment: 'Stale value.',
        }),
      }),
    );
  });

  it('retrieves prior feedback for an injected occurrence', async () => {
    requestCanopyCloudJsonMock.mockResolvedValueOnce({
      feedback: {
        rating: 'like',
        createdAt: '2026-07-31T10:00:00.000Z',
      },
      canSubmit: false,
    });
    await expect(
      getOrgMemoryFeedback({
        organizationExternalId: ORG,
        searchId: 'search-1',
        factId: 'fact-1',
      }),
    ).resolves.toEqual({
      feedback: {
        rating: 'like',
        createdAt: '2026-07-31T10:00:00.000Z',
      },
      canSubmit: false,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `/memory/feedback?organizationExternalId=${ORG}&searchId=search-1&factId=fact-1`,
      ),
      expect.objectContaining({
        method: 'GET',
        timeoutMs: FEEDBACK_FETCH_TIMEOUT_MS,
      }),
    );
  });

  it('fails closed on feedback without capability and open on errors', async () => {
    getCanopyCloudCredentialsMock.mockResolvedValueOnce({
      apiKey: 'key',
      capabilities: [],
    });
    await expect(
      submitOrgMemoryFeedback({
        organizationExternalId: ORG,
        searchId: 'search-1',
        factId: 'fact-1',
        rating: 'like',
      }),
    ).resolves.toEqual({ recorded: false });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
    await expect(
      submitOrgMemoryFeedback({
        organizationExternalId: ORG,
        searchId: 'search-1',
        factId: 'fact-1',
        rating: 'like',
      }),
    ).resolves.toEqual({ recorded: false });
  });

  it('searches the org it is given, never the account’s advertised org', async () => {
    await fetchOrgMemoryAttempt(OTHER_ORG, 'query', false);
    expect(
      parseRequestBody(requestCanopyCloudJsonMock.mock.calls[0]?.[1]),
    ).toEqual({ organizationExternalId: OTHER_ORG, query: 'query' });
  });

  it('sends explicit orgs on feedback reads and writes', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({
      recorded: true,
      feedback: null,
      canSubmit: true,
    });
    await submitOrgMemoryFeedback({
      organizationExternalId: OTHER_ORG,
      searchId: 'search-1',
      factId: 'fact-1',
      rating: 'like',
    });
    await getOrgMemoryFeedback({
      organizationExternalId: OTHER_ORG,
      searchId: 'search-1',
      factId: 'fact-1',
    });
    expect(
      parseRequestBody(requestCanopyCloudJsonMock.mock.calls[0]?.[1]),
    ).toMatchObject({ organizationExternalId: OTHER_ORG });
    expect(requestCanopyCloudJsonMock.mock.calls[1]?.[0]).toContain(
      `organizationExternalId=${OTHER_ORG}`,
    );
  });

  it('makes no request for a malformed org id', async () => {
    await expect(
      fetchOrgMemoryAttempt('org-1', 'query', false),
    ).resolves.toEqual({ result: null, factCount: 0, responseReceived: false });
    await ackOrgMemoryDelivered('', 'search-1');
    await expect(
      submitOrgMemoryFeedback({
        organizationExternalId: ORG.toUpperCase(),
        searchId: 'search-1',
        factId: 'fact-1',
        rating: 'like',
      }),
    ).resolves.toEqual({ recorded: false });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
  });

  it('makes no request for an org the account can no longer search', async () => {
    const formerOrg = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await expect(
      fetchOrgMemoryAttempt(formerOrg, 'query', false),
    ).resolves.toEqual({ result: null, factCount: 0, responseReceived: false });
    await ackOrgMemoryDelivered(formerOrg, 'search-1');
    await expect(
      submitOrgMemoryFeedback({
        organizationExternalId: formerOrg,
        searchId: 'search-1',
        factId: 'fact-1',
        rating: 'like',
      }),
    ).resolves.toEqual({ recorded: false });
    await expect(
      getOrgMemoryFeedback({
        organizationExternalId: formerOrg,
        searchId: 'search-1',
        factId: 'fact-1',
      }),
    ).resolves.toEqual({ feedback: null, canSubmit: false });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
  });

  describe('delivery ack', () => {
    it('posts the delivered ack with the feedback timeout', async () => {
      requestCanopyCloudJsonMock.mockResolvedValueOnce({ recorded: true });
      await expect(
        ackOrgMemoryDelivered(ORG, 'search-1'),
      ).resolves.toBeUndefined();
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/memory\/delivered$/),
        expect.objectContaining({
          method: 'POST',
          timeoutMs: FEEDBACK_FETCH_TIMEOUT_MS,
          body: JSON.stringify({
            organizationExternalId: ORG,
            searchId: 'search-1',
          }),
        }),
      );
    });

    it('does no network request without capability and swallows failures', async () => {
      getCanopyCloudCredentialsMock.mockResolvedValueOnce({
        apiKey: 'key',
        capabilities: [],
      });
      await expect(
        ackOrgMemoryDelivered(ORG, 'search-1'),
      ).resolves.toBeUndefined();
      expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

      requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
      await expect(
        ackOrgMemoryDelivered(ORG, 'search-1'),
      ).resolves.toBeUndefined();
    });

    it('carries the delivery attribution fields when provided', async () => {
      requestCanopyCloudJsonMock.mockResolvedValueOnce({ recorded: true });
      await ackOrgMemoryDelivered(ORG, 'search-1', {
        outcome: 'dropped',
        dropReason: 'race_timeout',
        clientElapsedMs: 4_321,
        clientChatId: 'chat-1',
      });
      expect(
        parseRequestBody(requestCanopyCloudJsonMock.mock.calls[0]?.[1]),
      ).toEqual({
        organizationExternalId: ORG,
        searchId: 'search-1',
        outcome: 'dropped',
        dropReason: 'race_timeout',
        clientElapsedMs: 4_321,
        clientChatId: 'chat-1',
      });
    });

    it('retries a failed ack POST exactly once, ~30s later', async () => {
      jest.useFakeTimers();
      try {
        requestCanopyCloudJsonMock.mockRejectedValue(new Error('offline'));
        await expect(
          ackOrgMemoryDelivered(ORG, 'search-1', {
            outcome: 'delivered',
            clientElapsedMs: 100,
          }),
        ).resolves.toBeUndefined();
        expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(
          ACK_RETRY_BASE_DELAY_MS + ACK_RETRY_JITTER_MS,
        );
        expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
        // The retry reposts the identical ack body, to the same org.
        expect(
          parseRequestBody(requestCanopyCloudJsonMock.mock.calls[1]?.[1]),
        ).toEqual(
          parseRequestBody(requestCanopyCloudJsonMock.mock.calls[0]?.[1]),
        );
        expect(
          parseRequestBody(requestCanopyCloudJsonMock.mock.calls[1]?.[1]),
        ).toMatchObject({ organizationExternalId: ORG });

        // A failed retry does not earn a third attempt.
        await jest.advanceTimersByTimeAsync(
          (ACK_RETRY_BASE_DELAY_MS + ACK_RETRY_JITTER_MS) * 2,
        );
        expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not schedule a retry on success or when gated before the POST', async () => {
      jest.useFakeTimers();
      try {
        requestCanopyCloudJsonMock.mockResolvedValueOnce({ recorded: true });
        await ackOrgMemoryDelivered(ORG, 'search-1');
        await jest.advanceTimersByTimeAsync(
          ACK_RETRY_BASE_DELAY_MS + ACK_RETRY_JITTER_MS,
        );
        expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

        // A credentials failure happens before any network work: no retry.
        getCanopyCloudCredentialsMock.mockRejectedValueOnce(
          new Error('no credentials'),
        );
        await ackOrgMemoryDelivered(ORG, 'search-2');
        await jest.advanceTimersByTimeAsync(
          ACK_RETRY_BASE_DELAY_MS + ACK_RETRY_JITTER_MS,
        );
        expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('search circuit breaker', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    async function failSearchTimes(count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
        // toEqual (not toMatchObject) also proves real attempts never carry
        // the breakerOpen flag.
        await expect(
          fetchOrgMemoryAttempt(ORG, 'query', false),
        ).resolves.toEqual({
          result: null,
          factCount: 0,
          responseReceived: false,
        });
      }
    }

    it('trips after exactly three consecutive network failures and then short-circuits', async () => {
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD - 1);
      // Two failures: still closed, the next attempt performs a real fetch.
      requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
      await fetchOrgMemoryAttempt(ORG, 'query', false);
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD,
      );

      await expect(fetchOrgMemoryAttempt(ORG, 'query', false)).resolves.toEqual(
        {
          result: null,
          factCount: 0,
          responseReceived: false,
          breakerOpen: true,
        },
      );
      // Neither the credential store nor the network is consulted while open.
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD,
      );
      expect(getCanopyCloudCredentialsMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD,
      );
    });

    it('stays open through the cooldown and allows a single half-open probe after it', async () => {
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD);
      jest.advanceTimersByTime(MEMORY_BREAKER_COOLDOWN_MS - 1);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ breakerOpen: true });
      jest.advanceTimersByTime(1);

      // Hold the probe's fetch open; a concurrent call must short-circuit as
      // open instead of launching a second probe.
      let resolveProbe: (value: unknown) => void = () => undefined;
      requestCanopyCloudJsonMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveProbe = resolve;
          }),
      );
      const probe = fetchOrgMemoryAttempt(ORG, 'query', false);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ breakerOpen: true });
      // Let the probe reach its held network call before resolving it.
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
      resolveProbe({
        facts: [],
        renderedBlock: null,
      });
      await expect(probe).resolves.toMatchObject({ responseReceived: true });
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD + 1,
      );

      // Probe success closed the breaker: the next call fetches normally.
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ responseReceived: true });
    });

    it('re-opens for another full cooldown when the probe fails', async () => {
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD);
      jest.advanceTimersByTime(MEMORY_BREAKER_COOLDOWN_MS);
      requestCanopyCloudJsonMock.mockRejectedValueOnce(
        new Error('still offline'),
      );
      await expect(fetchOrgMemoryAttempt(ORG, 'query', false)).resolves.toEqual(
        {
          result: null,
          factCount: 0,
          responseReceived: false,
        },
      );
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD + 1,
      );

      jest.advanceTimersByTime(MEMORY_BREAKER_COOLDOWN_MS - 1);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ breakerOpen: true });
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD + 1,
      );

      jest.advanceTimersByTime(1);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ responseReceived: true });
    });

    it('resets the failure streak after a successful probe', async () => {
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD);
      jest.advanceTimersByTime(MEMORY_BREAKER_COOLDOWN_MS);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ responseReceived: true });

      // Closed with a clean streak: one new failure must not re-open.
      requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
      await fetchOrgMemoryAttempt(ORG, 'query', false);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ responseReceived: true });
    });

    it('resets the consecutive-failure counter on a mid-sequence success', async () => {
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD - 1);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ responseReceived: true });
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD - 1);

      // Still closed: the reset streak needs three fresh failures to trip.
      requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
      await fetchOrgMemoryAttempt(ORG, 'query', false);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ breakerOpen: true });
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        2 * MEMORY_BREAKER_THRESHOLD,
      );
    });

    it('ignores credential-gated early returns for both counting and resetting', async () => {
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD - 1);
      getCanopyCloudCredentialsMock.mockResolvedValueOnce({
        apiKey: 'key',
        capabilities: [],
      });
      await expect(fetchOrgMemoryAttempt(ORG, 'query', false)).resolves.toEqual(
        {
          result: null,
          factCount: 0,
          responseReceived: false,
        },
      );
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD - 1,
      );

      // The streak survived the gated return: one more real failure trips it.
      requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
      await fetchOrgMemoryAttempt(ORG, 'query', false);
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ breakerOpen: true });
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
        MEMORY_BREAKER_THRESHOLD,
      );
    });

    it('leaves the ack path unaffected by an open breaker', async () => {
      await failSearchTimes(MEMORY_BREAKER_THRESHOLD);
      requestCanopyCloudJsonMock.mockResolvedValueOnce({ recorded: true });
      await expect(
        ackOrgMemoryDelivered(ORG, 'search-1'),
      ).resolves.toBeUndefined();
      expect(requestCanopyCloudJsonMock).toHaveBeenLastCalledWith(
        expect.stringMatching(/\/memory\/delivered$/),
        expect.objectContaining({ method: 'POST' }),
      );

      // The ack neither consulted nor closed the search breaker.
      await expect(
        fetchOrgMemoryAttempt(ORG, 'query', false),
      ).resolves.toMatchObject({ breakerOpen: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Per-org billing gate (CAN-2311). Every call is keyed by the org it is given
// (CAN-3457), so a lapsed org is refused while a member's healthy org keeps
// memory.
// ---------------------------------------------------------------------------
describe('organization memory client — lapsed org gate', () => {
  const LAPSED_ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const HEALTHY_ORG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  beforeEach(() => {
    jest.clearAllMocks();
    resetOrgMemoryBreakerForTest();
    // Only the lapsed org is gated; every other org stays entitled.
    isOrganizationTeamsLapsedMock.mockImplementation(
      (organizationId: string): Promise<boolean> =>
        Promise.resolve(organizationId === LAPSED_ORG),
    );
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: ['memorySearch'],
      memorySearchOrganizationExternalIds: [LAPSED_ORG, HEALTHY_ORG],
    });
    requestCanopyCloudJsonMock.mockResolvedValue({
      searchId: 'search-1',
      facts: [],
      renderedBlock: null,
      recorded: true,
      feedback: null,
      canSubmit: true,
    });
  });

  it('blocks all four call sites when the passed org has lapsed', async () => {
    await expect(
      fetchOrgMemoryAttempt(LAPSED_ORG, 'query', false),
    ).resolves.toEqual({
      result: null,
      factCount: 0,
      responseReceived: false,
    });
    await ackOrgMemoryDelivered(LAPSED_ORG, 'search-1');
    await expect(
      submitOrgMemoryFeedback({
        organizationExternalId: LAPSED_ORG,
        searchId: 'search-1',
        factId: 'fact-1',
      }),
    ).resolves.toEqual({ recorded: false });
    await expect(
      getOrgMemoryFeedback({
        organizationExternalId: LAPSED_ORG,
        searchId: 'search-1',
        factId: 'fact-1',
      }),
    ).resolves.toEqual({ feedback: null, canSubmit: false });

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
  });

  // The load-bearing invariant: per-org, never a global kill switch.
  it('leaves a healthy org fully functional while another org is lapsed', async () => {
    const attempt = await fetchOrgMemoryAttempt(HEALTHY_ORG, 'query', false);
    expect(attempt.responseReceived).toBe(true);
    await expect(
      submitOrgMemoryFeedback({
        organizationExternalId: HEALTHY_ORG,
        searchId: 'search-1',
        factId: 'fact-1',
      }),
    ).resolves.toEqual({ recorded: true });
    await expect(
      getOrgMemoryFeedback({
        organizationExternalId: HEALTHY_ORG,
        searchId: 'search-1',
        factId: 'fact-1',
      }),
    ).resolves.toEqual({ feedback: null, canSubmit: true });

    expect(requestCanopyCloudJsonMock).toHaveBeenCalled();
  });

  it('never reads billing state when an earlier gate already blocked the call', async () => {
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      memorySearchOrganizationExternalIds: [LAPSED_ORG],
    });

    await fetchOrgMemoryAttempt(LAPSED_ORG, 'query', false);
    expect(isOrganizationTeamsLapsedMock).not.toHaveBeenCalled();
  });
});

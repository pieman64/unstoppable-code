import {
  CANOPY_SERVER_CAPABILITIES,
  MEMORY_DELIVERY_CLIENT_CHAT_ID_MAX_CHARS,
  MEMORY_DELIVERY_CLIENT_ELAPSED_MAX_MS,
  MEMORY_DELIVERY_OUTCOMES,
  MEMORY_DROP_REASONS,
  MEMORY_SEARCH_CAPABILITY,
  type MemoryDeliveredRequest,
  type MemoryDeliveredResponse,
  type MemorySearchRequest,
  type MemorySearchResponse,
} from '../../index';

describe('memory search protocol', () => {
  it('advertises the canonical capability and preserves the wire contract', () => {
    const request: MemorySearchRequest = {
      organizationExternalId: '00000000-0000-4000-8000-000000000000',
      query: 'repo — worktree — database proxy\nEarlier requests: staging',
      lexicalQuery: 'database proxy',
      limit: 4,
      debug: true,
    };
    const response: MemorySearchResponse = {
      facts: [],
      renderedBlock: null,
      diagnostics: {
        laneCounts: { vector: 0, fts: 0, trigram: 0 },
        rerankUsed: false,
        topRerankScore: null,
        topCosineScore: null,
        gatePassed: false,
        latencyMs: 1,
      },
    };

    expect(request.limit).toBe(4);
    expect(request.lexicalQuery).toBe('database proxy');
    expect(response.diagnostics?.gatePassed).toBe(false);
    expect(CANOPY_SERVER_CAPABILITIES).toContain(MEMORY_SEARCH_CAPABILITY);
  });

  it('preserves the delivery-ack wire contract', () => {
    // Legacy shape: no outcome means the ack is treated as delivered.
    const legacyRequest: MemoryDeliveredRequest = {
      organizationExternalId: '00000000-0000-4000-8000-000000000000',
      searchId: 'search-1',
    };
    const response: MemoryDeliveredResponse = { recorded: true };

    expect(legacyRequest.searchId).toBe('search-1');
    expect(legacyRequest.outcome).toBeUndefined();
    expect(response.recorded).toBe(true);
  });

  it('preserves the delivery attribution contract', () => {
    const droppedRequest: MemoryDeliveredRequest = {
      organizationExternalId: '00000000-0000-4000-8000-000000000000',
      searchId: 'search-1',
      outcome: 'dropped',
      dropReason: 'race_timeout',
      clientElapsedMs: 4_100,
      clientChatId: 'chat-1',
    };

    expect(MEMORY_DELIVERY_OUTCOMES).toEqual(['delivered', 'dropped']);
    // breaker_open is deliberately absent: with the breaker open no search
    // ran, so there is no searchId to ack.
    expect(MEMORY_DROP_REASONS).toEqual([
      'race_timeout',
      'turn_aborted',
      'send_failed',
    ]);
    expect(MEMORY_DELIVERY_CLIENT_ELAPSED_MAX_MS).toBe(60_000);
    expect(MEMORY_DELIVERY_CLIENT_CHAT_ID_MAX_CHARS).toBe(128);
    expect(droppedRequest.dropReason).toBe('race_timeout');
  });
});

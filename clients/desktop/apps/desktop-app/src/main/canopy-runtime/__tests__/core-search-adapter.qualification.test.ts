import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  CORE_SEARCH_QUERY_DEFINITIONS,
  CoreSearchQueryResultSchema,
  type CoreSearchQueryParams,
} from '@canopy/protocol/canopy-core';
import type {
  ChatSearchQueryRequest,
  ChatSearchResult,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  createCoreSearchAdapter,
  type CoreSearchIndex,
} from '../core-search-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

const mockSearchService = {
  ensureInitialScan: jest.fn(),
  getIndexRevision: jest.fn((): number => 0),
  queryResponsive: jest.fn(
    (): Promise<ChatSearchResult[]> => Promise.resolve([]),
  ),
};

jest.mock('../../chat-search/service', () => ({
  getChatSearchService: (): typeof mockSearchService => mockSearchService,
}));

class FakeSearchIndex implements CoreSearchIndex {
  revision = 0;
  results: ChatSearchResult[] = [];
  onQuery: () => void = () => {};
  readonly calls: Array<{
    request: ChatSearchQueryRequest;
    context: WorkspaceContext | undefined;
    linked: readonly string[] | undefined;
  }> = [];

  getIndexRevision(): number {
    return this.revision;
  }

  queryResponsive(
    request: ChatSearchQueryRequest,
    context?: WorkspaceContext,
    linked?: readonly string[],
  ): Promise<ChatSearchResult[]> {
    this.calls.push({ request, context, linked });
    this.onQuery();
    return Promise.resolve(this.results);
  }
}

function entry(overrides: Partial<ChatSearchResult> = {}): ChatSearchResult {
  return {
    docId: 'doc-1',
    projectId: 'w1',
    worktreeId: 't1',
    chatId: 'chat-1',
    source: 'live',
    documentKind: 'chat',
    title: 'Fix the login flow',
    description: null,
    providerType: 'claude',
    updatedAt: Date.UTC(2026, 10, 5, 12),
    archivedAt: null,
    messageCount: 4,
    reviewStatus: null,
    snippet: 'the login flow fails',
    matchRanges: [{ start: 4, end: 9 }],
    ...overrides,
  };
}

function params(
  overrides: Partial<CoreSearchQueryParams> = {},
): CoreSearchQueryParams {
  return {
    query: 'login',
    scope: {},
    sources: [
      'live_chat',
      'chat_archive',
      'cowork_archive',
      'archived_container',
      'plan',
    ],
    cursor: null,
    limit: 20,
    ...overrides,
  };
}

describe('core search query (CAN-4114)', () => {
  const dispatchers: Array<{ shutdown(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(dispatchers.splice(0).map((d) => d.shutdown()));
  });

  function query(
    index: FakeSearchIndex,
    request: CoreSearchQueryParams,
  ): Promise<unknown> {
    const adapter = createCoreSearchAdapter(() => Promise.resolve(index));
    const dispatcher = createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: CORE_SEARCH_QUERY_DEFINITIONS,
        instructions: {},
        streams: {},
      },
      handlers: {
        queries: {
          'core.search.query': adapter.queries?.['core.search.query'],
        },
        instructions: {},
        streams: {},
      },
    });
    dispatchers.push(dispatcher);
    return dispatcher.query('core.search.query', request, {
      caller: {
        principalId: 'portal:abc',
        clientInstanceId: 'client',
        authorityId: 'desktop',
        interfaceKind: 'test',
        grants: ['core.search.read'],
      },
      metadata: {},
      signal: new AbortController().signal,
    });
  }

  it('reports the index revision the hits come from', async () => {
    const index = new FakeSearchIndex();
    index.revision = 12;
    index.results = [entry()];
    index.onQuery = (): void => {
      index.revision = 13;
    };
    const result = CoreSearchQueryResultSchema.parse(
      await query(index, params()),
    );
    expect(result.indexRevision).toBe(12);
    expect(result.hits).toHaveLength(1);
  });

  it('maps chat, archive and plan documents to the catalog shapes', async () => {
    const index = new FakeSearchIndex();
    const archivedAt = Date.UTC(2026, 10, 1);
    index.results = [
      entry({ docId: 'live-1', source: 'live' }),
      entry({
        docId: 'archive-1',
        source: 'worktree-archive',
        archivedAt,
      }),
      entry({
        docId: 'container-1',
        worktreeId: 'container-a',
        chatId: '__container__',
        source: 'archived-container',
        documentKind: 'archived-container',
        archivedAt,
      }),
      entry({
        docId: 'plan-1',
        source: 'plan',
        documentKind: 'plan',
        reviewStatus: 'pending',
      }),
    ];
    const result = CoreSearchQueryResultSchema.parse(
      await query(index, params()),
    );
    expect(result.hits.map((hit) => hit.document.ref.kind)).toEqual([
      'chat',
      'chat',
      'archive',
      'plan',
    ]);
    expect(result.hits.map((hit) => hit.document.source)).toEqual([
      'live_chat',
      'chat_archive',
      'archived_container',
      'plan',
    ]);
    expect(result.hits[0]?.document).toMatchObject({
      ref: { kind: 'chat', id: 'chat-1' },
      updatedAt: '2026-11-05T12:00:00.000Z',
      archivedAt: null,
      provider: 'claude',
      messageCount: 4,
    });
    expect(result.hits[2]?.document.ref).toEqual({
      kind: 'archive',
      id: 'container-a',
    });
    expect(result.hits[1]?.document.archivedAt).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(result.hits[3]?.document.reviewStatus).toBe('in_review');
    expect(result.hits.map((hit) => hit.score)).toEqual([
      1,
      1 / 2,
      1 / 3,
      1 / 4,
    ]);
  });

  it("searches in the caller's organization and narrows by scope and source", async () => {
    const index = new FakeSearchIndex();
    index.results = [
      entry({ docId: 'a', projectId: 'w1' }),
      entry({ docId: 'b', projectId: 'w2' }),
      entry({ docId: 'c', projectId: 'w1', source: 'plan' }),
      entry({ docId: 'd', projectId: 'w1' }),
      entry({ docId: 'e', projectId: 'w1' }),
    ];
    const result = CoreSearchQueryResultSchema.parse(
      await query(
        index,
        params({
          scope: { organizationId: 'ORG-1', workspaceId: 'w1' },
          sources: ['live_chat'],
          limit: 2,
        }),
      ),
    );
    expect(index.calls).toEqual([
      {
        request: { query: 'login', limit: 100 },
        context: { kind: 'organization', organizationId: 'org-1' },
        linked: [],
      },
    ]);
    expect(result.hits.map((hit) => hit.document.documentId)).toEqual([
      'a',
      'd',
    ]);
    expect(
      result.hits.every((hit) => hit.document.source === 'live_chat'),
    ).toBe(true);
  });

  it("keeps every hit within the contract's bounds", async () => {
    const index = new FakeSearchIndex();
    index.results = [
      entry({
        docId: 'bounded',
        title: 't'.repeat(2_000),
        snippet: 's'.repeat(10_000),
        matchRanges: [
          { start: 0, end: 5 },
          { start: 8_190, end: 8_200 },
        ],
      }),
      entry({ docId: 'x'.repeat(600) }),
    ];
    const result = CoreSearchQueryResultSchema.parse(
      await query(index, params()),
    );
    expect(result.hits).toHaveLength(1);
    const [hit] = result.hits;
    expect(hit?.document.documentId).toBe('bounded');
    expect(hit?.document.title).toHaveLength(1_024);
    expect(hit?.snippet).toHaveLength(8_192);
    expect(hit?.matches).toEqual([{ start: 0, end: 5 }]);
  });

  it('answers one page', async () => {
    const index = new FakeSearchIndex();
    index.results = [entry()];
    await expect(query(index, params({ cursor: 'x' }))).rejects.toMatchObject({
      payload: { kind: 'invalid_argument' },
    });
    expect(index.calls).toEqual([]);
    const result = CoreSearchQueryResultSchema.parse(
      await query(index, params()),
    );
    expect(result.nextCursor).toBeNull();
  });

  it('refuses another authority or target', async () => {
    const index = new FakeSearchIndex();
    await expect(
      query(index, params({ scope: { targetId: 't2' } })),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(index.calls).toEqual([]);
  });

  it('starts the index scan before serving the default index', async () => {
    const runtime = createDesktopRuntime({});
    try {
      await runtime.query('core.search.query', params(), {
        caller: {
          principalId: 'portal:abc',
          clientInstanceId: 'client',
          authorityId: 'local-desktop',
          interfaceKind: 'test',
          grants: ['core.search.read'],
        },
      });
      expect(mockSearchService.ensureInitialScan).toHaveBeenCalledTimes(1);
      expect(mockSearchService.queryResponsive).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
    }
  });
});

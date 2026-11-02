import {
  isLinearApiError,
  LinearApiError,
  readLinearIssueAttachments,
  readLinearIssuePreview,
  readLinearTeamKeys,
  readLinearViewer,
  searchLinearIssues,
} from '../linear-api';

const API_KEY = 'lin_test_key';
const DEFAULT_VIEWER = { name: 'Rowan', displayName: 'Rowan Doe' };
const DEFAULT_ISSUE = {
  id: 'iss_default_1',
  identifier: 'CAN-7',
  title: 'Preview tickets',
  description: 'A plain description',
  url: 'https://linear.app/acme/issue/CAN-7/preview-tickets',
  priority: 2,
  priorityLabel: 'High',
  branchName: 'can-7-preview-tickets',
};

const VIEWER_DOCUMENT = `query viewer {
  viewer { name displayName }
}`;
const SEARCH_ISSUES_DOCUMENT = `query searchIssues($term: String!) {
  searchIssues(term: $term) {
    nodes { id identifier title description url priority priorityLabel branchName }
  }
}`;
const ISSUE_ATTACHMENTS_DOCUMENT = `query issue_attachments($id: String!, $first: Int!) {
  issue(id: $id) {
    attachments(first: $first) {
      nodes { url sourceType title }
      pageInfo { hasNextPage }
    }
  }
}`;
const ISSUE_PREVIEW_DOCUMENT = `query referencePreviewIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    updatedAt
    state { name }
    assignee { displayName name }
    project { name }
  }
}`;
const TEAM_KEYS_DOCUMENT = `query referencePreviewTeams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { key }
    pageInfo { hasNextPage endCursor }
  }
}`;

let fetchSpy: jest.SpyInstance<
  Promise<Response>,
  Parameters<typeof globalThis.fetch>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function requestInit(index = 0): RequestInit {
  const call = fetchSpy.mock.calls[index];
  if (!call || !call[1]) throw new Error('Expected a fetch request');
  return call[1];
}

function requestUrl(index = 0): RequestInfo | URL {
  const call = fetchSpy.mock.calls[index];
  if (!call) throw new Error('Expected a fetch request');
  return call[0];
}

function requestBody(index = 0): Record<string, unknown> {
  const body = requestInit(index).body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error('Expected an object request body');
  return parsed;
}

async function expectApiError(
  promise: Promise<unknown>,
): Promise<LinearApiError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (isLinearApiError(error)) return error;
    throw error;
  }
  throw new Error('Expected a LinearApiError');
}

function expectError(
  error: LinearApiError,
  operation: string,
  type: string,
  status: number | null,
  retryAfterMs: number | null = null,
  notFound = false,
): void {
  expect(error).toBeInstanceOf(LinearApiError);
  expect(error.name).toBe('LinearApiError');
  expect(error.operation).toBe(operation);
  expect(error.type).toBe(type);
  expect(error.status).toBe(status);
  expect(error.retryAfterMs).toBe(retryAfterMs);
  expect(error.notFound).toBe(notFound);
  expect(error.message).toBe(`Linear ${operation} request failed (${type})`);
}

beforeEach(() => {
  Reflect.set(globalThis, '__CANOPY_E2E__', false);
  Reflect.set(globalThis, '__CANOPY_LINEAR_API_BASE_URL__', undefined);
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: { viewer: DEFAULT_VIEWER } })),
    );
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  Reflect.set(globalThis, '__CANOPY_E2E__', false);
  Reflect.set(globalThis, '__CANOPY_LINEAR_API_BASE_URL__', undefined);
});

describe('Linear fetch transport', () => {
  it('sends POST JSON with the raw key and fixed transport headers', async () => {
    await readLinearViewer(API_KEY);

    const init = requestInit();
    expect(requestUrl()).toBe('https://api.linear.app/graphql');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      authorization: API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(requestBody()).toEqual({ query: VIEWER_DOCUMENT, variables: {} });
  });

  it('resolves the gated E2E endpoint on each request', async () => {
    Reflect.set(globalThis, '__CANOPY_E2E__', true);
    Reflect.set(
      globalThis,
      '__CANOPY_LINEAR_API_BASE_URL__',
      'http://mock-a/graphql',
    );
    await readLinearViewer(API_KEY);
    expect(requestUrl(0)).toBe('http://mock-a/graphql');

    Reflect.set(globalThis, '__CANOPY_E2E__', false);
    Reflect.set(
      globalThis,
      '__CANOPY_LINEAR_API_BASE_URL__',
      'http://mock-b/graphql',
    );
    await readLinearViewer(API_KEY);
    expect(requestUrl(1)).toBe('https://api.linear.app/graphql');
  });

  it('looks up globalThis.fetch at request time', async () => {
    await readLinearViewer(API_KEY);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
    const lateFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { viewer: DEFAULT_VIEWER } }));
    await readLinearViewer(API_KEY);

    expect(lateFetch).toHaveBeenCalledTimes(1);
  });

  it('fails safely when fetch rejects, including redirect refusal', async () => {
    fetchSpy.mockRejectedValue(new Error('redirect carried private data'));

    const error = await expectApiError(readLinearViewer(API_KEY));
    expectError(error, 'viewer', 'network', null);
    expect(requestInit().redirect).toBe('error');
    expect(JSON.stringify(error)).not.toContain('private data');
  });

  it('times out after 20 seconds while a streamed body is stalled', async () => {
    const timeout = new AbortController();
    const timeoutSpy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    const stalled = new ReadableStream<Uint8Array>({
      start: (): void => undefined,
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(stalled, {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const pending = readLinearViewer(API_KEY);
    const caught = expectApiError(pending);
    await Promise.resolve();
    await Promise.resolve();
    timeout.abort();

    const error = await caught;
    expectError(error, 'viewer', 'network', 200);
    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
    timeoutSpy.mockRestore();
  });

  it('honors caller cancellation while reading a streamed body', async () => {
    const cancelled = jest.fn();
    const stalled = new ReadableStream<Uint8Array>({
      cancel: cancelled,
      start: (): void => undefined,
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(stalled, {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const controller = new AbortController();
    const pending = readLinearViewer(API_KEY, { signal: controller.signal });
    const caught = expectApiError(pending);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    const error = await caught;
    expectError(error, 'viewer', 'network', 200);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('cancels a chunked body that exceeds 4 MiB without trusting Content-Length', async () => {
    const cancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel: cancelled,
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    );

    const error = await expectApiError(readLinearViewer(API_KEY));
    expectError(error, 'viewer', 'unknown', 200);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(requestUrl()).toBe('https://api.linear.app/graphql');
  });

  it('ignores a dishonest Content-Length when enforcing the streamed cap', async () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller): void =>
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)),
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(body, {
        status: 400,
        headers: {
          'content-type': 'application/json',
          'content-length': '1',
        },
      }),
    );

    const error = await expectApiError(readLinearViewer(API_KEY));
    expectError(error, 'viewer', 'unknown', 400);
  });

  it('fails closed for non-JSON content types and invalid UTF-8', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response('{"data":{"viewer":{"name":"Rowan"}}}', {
          headers: { 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0xfe]), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );

    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      'unknown',
      200,
    );
    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      'unknown',
      200,
    );
  });

  it('accepts JSON content types with parameters', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { viewer: DEFAULT_VIEWER } }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
    expect(await readLinearViewer(API_KEY)).toEqual(DEFAULT_VIEWER);
  });

  it('maps a streamed body-read failure to network', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller): void =>
        controller.error(new Error('private stream error')),
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    );

    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      'network',
      200,
    );
  });
});

describe('Linear request documents and parsing', () => {
  it('uses the exact fixed document for every operation', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ data: { viewer: DEFAULT_VIEWER } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { searchIssues: { nodes: [DEFAULT_ISSUE] } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              attachments: {
                nodes: [
                  {
                    url: 'https://github.com/o/r',
                    sourceType: 'github',
                    title: 'PR',
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { issue: { identifier: 'CAN-7' } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { teams: { nodes: [], pageInfo: { hasNextPage: false } } },
        }),
      );

    await readLinearViewer(API_KEY);
    await searchLinearIssues(API_KEY, 'CAN-7');
    await readLinearIssueAttachments(API_KEY, 'iss_default_1');
    await readLinearIssuePreview(API_KEY, 'CAN-7');
    await readLinearTeamKeys(API_KEY);

    expect(requestBody(0)).toEqual({ query: VIEWER_DOCUMENT, variables: {} });
    expect(requestBody(1)).toEqual({
      query: SEARCH_ISSUES_DOCUMENT,
      variables: { term: 'CAN-7' },
    });
    expect(requestBody(2)).toEqual({
      query: ISSUE_ATTACHMENTS_DOCUMENT,
      variables: { id: 'iss_default_1', first: 50 },
    });
    expect(requestBody(3)).toEqual({
      query: ISSUE_PREVIEW_DOCUMENT,
      variables: { id: 'CAN-7' },
    });
    expect(requestBody(4)).toEqual({
      query: TEAM_KEYS_DOCUMENT,
      variables: { first: 250, after: null },
    });
    for (let index = 0; index < 5; index += 1) {
      const body = requestInit(index).body;
      expect(typeof body).toBe('string');
      if (typeof body === 'string') {
        const parsed: unknown = JSON.parse(body);
        if (!isRecord(parsed))
          throw new Error('Expected a JSON request object');
        expect(Object.keys(parsed)).toEqual(['query', 'variables']);
      }
    }
  });

  it('passes hostile search text unchanged only in variables', async () => {
    const term = 'CAN-7") { viewer { name } } # closing selection';
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: { searchIssues: { nodes: [DEFAULT_ISSUE] } } }),
    );
    await searchLinearIssues(API_KEY, term);

    const body = requestBody();
    expect(body.query).toBe(SEARCH_ISSUES_DOCUMENT);
    expect(body.variables).toEqual({ term });
    expect(requestInit().body).toBe(
      JSON.stringify({ query: SEARCH_ISSUES_DOCUMENT, variables: { term } }),
    );
  });

  it('parses viewer and rejects a malformed viewer result', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: { viewer: { name: 'Rowan', displayName: null } } }),
    );
    expect(await readLinearViewer(API_KEY)).toEqual({
      name: 'Rowan',
      displayName: null,
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: { viewer: { name: 7 } } }),
    );
    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      'unknown',
      200,
    );
  });

  it('parses issue search and rejects the whole response for a malformed node', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: { searchIssues: { nodes: [DEFAULT_ISSUE] } } }),
    );
    expect(await searchLinearIssues(API_KEY, 'CAN-7')).toEqual([
      { ...DEFAULT_ISSUE, description: 'A plain description' },
    ]);

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: {
          searchIssues: {
            nodes: [DEFAULT_ISSUE, { ...DEFAULT_ISSUE, id: 'bad/id' }],
          },
        },
      }),
    );
    expectError(
      await expectApiError(searchLinearIssues(API_KEY, 'CAN-7')),
      'searchIssues',
      'unknown',
      200,
    );
  });

  it('returns only the first 50 attachments and preserves completeness evidence', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: {
          issue: {
            attachments: {
              nodes: [
                {
                  url: 'https://github.com/o/r',
                  sourceType: null,
                  title: null,
                },
                { url: 'https://linear.app/a', sourceType: 'linear' },
                ...Array.from({ length: 48 }, (_, index) => ({
                  url: `https://github.com/o/${index}`,
                })),
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      }),
    );
    const result = await readLinearIssueAttachments(API_KEY, 'iss_default_1');
    expect(result.attachments).toHaveLength(50);
    expect(result.attachments[0]).toEqual({
      url: 'https://github.com/o/r',
      sourceType: null,
      title: null,
    });
    expect(result.attachments[1]).toEqual({
      url: 'https://linear.app/a',
      sourceType: 'linear',
    });
    expect(result.complete).toBe(true);
  });

  it('marks absent pageInfo and more than 50 nodes incomplete', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              attachments: { nodes: [{ url: 'https://github.com/o/r' }] },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              attachments: {
                nodes: Array.from({ length: 51 }, (_, index) => ({
                  url: `https://github.com/o/${index}`,
                })),
                pageInfo: { hasNextPage: false },
              },
            },
          },
        }),
      );

    expect(await readLinearIssueAttachments(API_KEY, 'iss_default_1')).toEqual({
      attachments: [{ url: 'https://github.com/o/r' }],
      complete: false,
    });
    const oversized = await readLinearIssueAttachments(
      API_KEY,
      'iss_default_1',
    );
    expect(oversized.attachments).toHaveLength(50);
    expect(oversized.complete).toBe(false);
  });

  it('marks an attachment connection with a next page incomplete', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: {
          issue: {
            attachments: {
              nodes: [{ url: 'https://github.com/o/r' }],
              pageInfo: { hasNextPage: true },
            },
          },
        },
      }),
    );
    expect(await readLinearIssueAttachments(API_KEY, 'iss_default_1')).toEqual({
      attachments: [{ url: 'https://github.com/o/r' }],
      complete: false,
    });
  });

  it('rejects malformed attachment nodes or page metadata', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              attachments: {
                nodes: [{ url: 7 }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { issue: { attachments: { nodes: [], pageInfo: null } } },
        }),
      );

    expectError(
      await expectApiError(
        readLinearIssueAttachments(API_KEY, 'iss_default_1'),
      ),
      'issue_attachments',
      'unknown',
      200,
    );
    expectError(
      await expectApiError(
        readLinearIssueAttachments(API_KEY, 'iss_default_1'),
      ),
      'issue_attachments',
      'unknown',
      200,
    );
  });

  it('parses issue previews leniently and returns null for a non-object issue', async () => {
    const issue = {
      identifier: 'CAN-7',
      title: 'Preview',
      description: null,
      url: 'https://linear.app/acme/issue/CAN-7',
      updatedAt: '2026-10-23T12:00:00.000Z',
      state: { name: 'Todo' },
      assignee: { displayName: 'Rowan', name: null },
      project: { name: 'Canopy' },
    };
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ data: { issue } }))
      .mockResolvedValueOnce(jsonResponse({ data: { issue: null } }))
      .mockResolvedValueOnce(jsonResponse({ data: null }));

    expect(await readLinearIssuePreview(API_KEY, 'CAN-7')).toEqual(issue);
    expect(await readLinearIssuePreview(API_KEY, 'CAN-7')).toBeNull();
    expectError(
      await expectApiError(readLinearIssuePreview(API_KEY, 'CAN-7')),
      'referencePreviewIssue',
      'unknown',
      200,
    );
  });

  it('maps non-string preview scalars and malformed nested objects to null', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: {
          issue: {
            identifier: 7,
            title: false,
            description: {},
            url: 9,
            updatedAt: null,
            state: { name: 5 },
            assignee: { displayName: 8, name: false },
            project: { name: [] },
          },
        },
      }),
    );
    expect(await readLinearIssuePreview(API_KEY, 'CAN-7')).toEqual({
      identifier: null,
      title: null,
      description: null,
      url: null,
      updatedAt: null,
      state: { name: null },
      assignee: { displayName: null, name: null },
      project: { name: null },
    });
  });

  it('pages through raw team keys, skipping non-string keys', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            teams: {
              nodes: [{ key: 'CAN' }, { key: null }, { key: 7 }],
              pageInfo: { hasNextPage: true, endCursor: 'page-2' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            teams: {
              nodes: [{ key: 'ECW' }],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      );

    expect(await readLinearTeamKeys(API_KEY)).toEqual(['CAN', 'ECW']);
    expect(requestBody(0)).toEqual({
      query: TEAM_KEYS_DOCUMENT,
      variables: { first: 250, after: null },
    });
    expect(requestBody(1)).toEqual({
      query: TEAM_KEYS_DOCUMENT,
      variables: { first: 250, after: 'page-2' },
    });
  });

  it('fails closed on a missing or invalid next cursor', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            teams: { nodes: [{ key: 'CAN' }], pageInfo: { hasNextPage: true } },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            teams: {
              nodes: [{ key: 'CAN' }],
              pageInfo: { hasNextPage: true, endCursor: `bad\u0000cursor` },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            teams: {
              nodes: [{ key: 'CAN' }],
              pageInfo: { hasNextPage: true, endCursor: 'x'.repeat(513) },
            },
          },
        }),
      );

    for (let index = 0; index < 3; index += 1) {
      expectError(
        await expectApiError(readLinearTeamKeys(API_KEY)),
        'referencePreviewTeams',
        'unknown',
        200,
      );
    }
  });

  it('fails closed if a later team page is malformed instead of returning a prefix', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            teams: {
              nodes: [{ key: 'CAN' }],
              pageInfo: { hasNextPage: true, endCursor: 'next' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { teams: { nodes: null } } }),
      );

    expectError(
      await expectApiError(readLinearTeamKeys(API_KEY)),
      'referencePreviewTeams',
      'unknown',
      200,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fails closed at the 20-page limit', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: {
            teams: {
              nodes: [{ key: 'CAN' }],
              pageInfo: { hasNextPage: true, endCursor: 'next' },
            },
          },
        }),
      ),
    );

    expectError(
      await expectApiError(readLinearTeamKeys(API_KEY)),
      'referencePreviewTeams',
      'unknown',
      200,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(20);
  });
});

describe('Linear input validation', () => {
  it('rejects a key newline, term newline, bad identifier and bad issue id before fetch', async () => {
    const errors = [
      await expectApiError(readLinearViewer('lin_test_key\n')),
      await expectApiError(searchLinearIssues(API_KEY, 'CAN-7\n')),
      await expectApiError(readLinearIssuePreview(API_KEY, 'CAN-7\n')),
      await expectApiError(
        readLinearIssueAttachments(API_KEY, 'iss_default_1\n'),
      ),
    ];
    expect(errors.map((error) => [error.type, error.status])).toEqual([
      ['invalid_input', null],
      ['invalid_input', null],
      ['invalid_input', null],
      ['invalid_input', null],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects search input that is not already protocol-trimmed', async () => {
    const error = await expectApiError(searchLinearIssues(API_KEY, ' CAN-7 '));
    expectError(error, 'searchIssues', 'invalid_input', null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Linear error classification', () => {
  it.each([
    [401, 'authentication'],
    [400, 'authentication'],
    [403, 'forbidden'],
    [429, 'ratelimited'],
    [500, 'internal'],
    [502, 'network'],
    [599, 'network'],
    [302, 'unknown'],
  ])('maps HTTP %s with no GraphQL errors to %s', async (status, type) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ errors: [] }, status));
    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      type,
      status,
    );
  });

  it.each([
    [401, undefined],
    [401, 'unknown provider type'],
    [403, undefined],
    [403, 'unknown provider type'],
    [429, undefined],
    [429, 'unknown provider type'],
    [500, undefined],
    [500, 'unknown provider type'],
  ])(
    'keeps a missing or unknown GraphQL type unknown at HTTP %s',
    async (status, type) => {
      const extensions: Record<string, unknown> = {};
      if (type !== undefined) extensions.type = type;
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { errors: [{ message: 'provider failure', extensions }] },
          status,
        ),
      );
      expectError(
        await expectApiError(readLinearViewer(API_KEY)),
        'viewer',
        'unknown',
        status,
      );
    },
  );

  it.each([
    ['authentication error', 'authentication'],
    ['forbidden', 'forbidden'],
    ['feature not accessible', 'feature_not_accessible'],
    ['invalid input', 'invalid_input'],
    ['ratelimited', 'ratelimited'],
    ['network error', 'network'],
    ['internal error', 'internal'],
  ])('maps GraphQL type %s', async (graphqlType, type) => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          errors: [
            { message: 'provider failure', extensions: { type: graphqlType } },
          ],
        },
        200,
      ),
    );
    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      type,
      200,
    );
  });

  it('maps HTTP 400 RATELIMITED and gives the code priority over the type', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          errors: [
            {
              message: 'rate limit',
              extensions: { code: 'RATELIMITED', type: 'authentication error' },
            },
          ],
        },
        400,
        { 'retry-after': '2.5' },
      ),
    );
    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      'ratelimited',
      400,
      2_500,
    );
  });

  it('uses the first GraphQL error type while scanning all errors for notFound', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        errors: [
          { message: 'first error', extensions: { type: 'invalid input' } },
          { extensions: { userPresentableMessage: 'Entity not found: Issue' } },
        ],
      }),
    );
    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      'invalid_input',
      200,
      null,
      true,
    );
  });

  it('treats errors: [] as no errors and an errors array at 200 as failure', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ errors: [], data: { viewer: DEFAULT_VIEWER } }, 200),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            errors: [
              {
                message: 'provider failure',
                extensions: { type: 'forbidden' },
              },
            ],
          },
          200,
        ),
      );

    expect(await readLinearViewer(API_KEY)).toEqual(DEFAULT_VIEWER);
    expectError(
      await expectApiError(readLinearViewer(API_KEY)),
      'viewer',
      'forbidden',
      200,
    );
  });

  it('detects notFound in a message or userPresentableMessage', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [
            { message: 'ENTITY NOT FOUND', extensions: { type: 'unknown' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [
            {
              message: 'other',
              extensions: { userPresentableMessage: 'Entity not found' },
            },
          ],
        }),
      );
    expect((await expectApiError(readLinearViewer(API_KEY))).notFound).toBe(
      true,
    );
    expect((await expectApiError(readLinearViewer(API_KEY))).notFound).toBe(
      true,
    );
  });

  it('uses only positive finite retry-after seconds', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'rate limit' }] }, 429, {
          'retry-after': '4',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'rate limit' }] }, 429, {
          'retry-after': '0',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'rate limit' }] }, 429, {
          'retry-after': '1e309',
        }),
      );
    expect((await expectApiError(readLinearViewer(API_KEY))).retryAfterMs).toBe(
      4_000,
    );
    expect(
      (await expectApiError(readLinearViewer(API_KEY))).retryAfterMs,
    ).toBeNull();
    expect(
      (await expectApiError(readLinearViewer(API_KEY))).retryAfterMs,
    ).toBeNull();
  });
});

describe('Linear error privacy', () => {
  it('keeps echoed keys, variables and cursors out of errors and their own properties', async () => {
    const key = 'lin_private_key_17';
    const term = 'CAN-17 { viewer }';
    const identifier = 'CAN-18';
    const issueId = 'iss_private_17';
    const cursor = 'opaque-private-cursor';
    const providerEcho = `${key} ${term} ${identifier} ${issueId} ${cursor}`;
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          errors: [
            {
              message: providerEcho,
              extensions: { type: 'authentication error' },
            },
          ],
        }),
      ),
    );
    const operations: Array<() => Promise<unknown>> = [
      (): Promise<unknown> => readLinearViewer(key),
      (): Promise<unknown> => searchLinearIssues(key, term),
      (): Promise<unknown> => readLinearIssueAttachments(key, issueId),
      (): Promise<unknown> => readLinearIssuePreview(key, identifier),
      async (): Promise<unknown> => {
        fetchSpy
          .mockResolvedValueOnce(
            jsonResponse({
              data: {
                teams: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: cursor },
                },
              },
            }),
          )
          .mockResolvedValueOnce(
            jsonResponse({ errors: [{ message: providerEcho }] }),
          );
        return readLinearTeamKeys(key);
      },
    ];

    for (const operation of operations) {
      const error = await expectApiError(operation());
      const ownValues = Object.getOwnPropertyNames(error).map(
        (property): unknown => {
          const value: unknown = Reflect.get(error, property);
          return value;
        },
      );
      const allText = `${JSON.stringify(error)} ${String(error)} ${JSON.stringify(ownValues)}`;
      expect(isLinearApiError(error)).toBe(true);
      expect(error.message).toBe(
        `Linear ${error.operation} request failed (${error.type})`,
      );
      expect(error).not.toHaveProperty('cause');
      expect(allText).not.toContain(key);
      expect(allText).not.toContain(term);
      expect(allText).not.toContain(identifier);
      expect(allText).not.toContain(issueId);
      expect(allText).not.toContain(cursor);
    }
  });
});

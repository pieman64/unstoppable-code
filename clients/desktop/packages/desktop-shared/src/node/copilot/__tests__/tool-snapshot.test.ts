import type { CurrentToolMetadata } from '@github/copilot-sdk';
import {
  assertCopilotMcpServersConnected,
  collectCopilotMcpSecretValues,
  describeCopilotMcpServerError,
  readCopilotToolSnapshot,
  type CopilotToolMetadataRpc,
} from '../tool-snapshot';

const tool: CurrentToolMetadata = {
  name: 'selected-read',
  namespacedName: 'selected/read',
  mcpServerName: 'selected',
  mcpToolName: 'read',
  description: 'Read selected evidence',
  input_schema: { type: 'object', properties: { value: { type: 'string' } } },
};
function fixture(
  tools: CurrentToolMetadata[] | null = [tool],
): CopilotToolMetadataRpc {
  return {
    tools: {
      initializeAndValidate: () => Promise.resolve({}),
      getCurrentMetadata: () => Promise.resolve({ tools }),
    },
    mcp: {
      list: () =>
        Promise.resolve({
          servers: [{ name: 'selected', status: 'connected' }],
        }),
    },
  };
}
const signal = (): AbortSignal => new AbortController().signal;

test('publishes only complete owning-session tool counts, including zero tools', async () => {
  const observed = jest.fn();
  await readCopilotToolSnapshot(fixture(), ['selected'], signal(), observed);
  expect(observed).toHaveBeenLastCalledWith([
    { name: 'selected', status: 'connected', toolCount: 1 },
  ]);
  await readCopilotToolSnapshot(fixture([]), ['selected'], signal(), observed);
  expect(observed).toHaveBeenLastCalledWith([
    { name: 'selected', status: 'connected', toolCount: 0 },
  ]);
  observed.mockClear();
  await expect(
    readCopilotToolSnapshot(
      fixture([tool, tool]),
      ['selected'],
      signal(),
      observed,
    ),
  ).rejects.toThrow(/identity/);
  expect(observed).not.toHaveBeenCalled();
});

test('schema, description and membership changes alter the native digest', async () => {
  const read = (
    tools: CurrentToolMetadata[],
  ): ReturnType<typeof readCopilotToolSnapshot> =>
    readCopilotToolSnapshot(fixture(tools), ['selected'], signal());
  const original = (await read([tool])).snapshot;
  for (const changed of [
    [],
    [{ ...tool, description: 'Changed purpose' }],
    [
      {
        ...tool,
        input_schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
        },
      },
    ],
  ])
    expect((await read(changed)).snapshot).not.toEqual(original);
  expect(JSON.stringify(original)).not.toContain('selected');
  expect(JSON.stringify(original)).not.toContain('evidence');
});

test('native tool order and schema key order do not change the digest', async () => {
  const second = { ...tool, name: 'selected-second', mcpToolName: 'second' };
  const initial = (
    await readCopilotToolSnapshot(
      fixture([tool, second]),
      ['selected'],
      signal(),
    )
  ).snapshot;
  const reordered = {
    ...tool,
    input_schema: { properties: { value: { type: 'string' } }, type: 'object' },
  };
  expect(
    (
      await readCopilotToolSnapshot(
        fixture([second, reordered]),
        ['selected'],
        signal(),
      )
    ).snapshot,
  ).toEqual(initial);
});

test.each([
  'failed',
  'needs-auth',
  'disabled',
  'stopped',
  'not_configured',
] as const)(
  'continues without a selected MCP server in status %s and reports it',
  async (status) => {
    const rpc = fixture([]);
    rpc.mcp.list = (): ReturnType<CopilotToolMetadataRpc['mcp']['list']> =>
      Promise.resolve({
        servers: [{ name: 'selected', status, error: 'Connection refused' }],
      });
    const nothingSelected = await readCopilotToolSnapshot(
      fixture([]),
      [],
      signal(),
    );
    await expect(
      readCopilotToolSnapshot(rpc, ['selected'], signal()),
    ).resolves.toEqual({
      snapshot: nothingSelected.snapshot,
      servers: [{ name: 'selected', status, error: 'Connection refused' }],
    });
  },
);

test('keeps a connected server in the snapshot beside an unavailable one', async () => {
  const rpc = fixture([tool]);
  rpc.mcp.list = (): ReturnType<CopilotToolMetadataRpc['mcp']['list']> =>
    Promise.resolve({
      servers: [
        { name: 'selected', status: 'connected' },
        { name: 'slack', status: 'needs-auth' },
      ],
    });
  const alone = await readCopilotToolSnapshot(
    fixture([tool]),
    ['selected'],
    signal(),
  );
  const result = await readCopilotToolSnapshot(
    rpc,
    ['selected', 'slack'],
    signal(),
  );
  expect(result.snapshot).toEqual(alone.snapshot);
  expect(result.servers).toEqual([
    { name: 'selected', status: 'connected' },
    { name: 'slack', status: 'needs-auth' },
  ]);
});

test('still rejects a selected server left pending, naming it', async () => {
  const rpc = fixture([]);
  rpc.mcp.list = (): ReturnType<CopilotToolMetadataRpc['mcp']['list']> =>
    Promise.resolve({ servers: [{ name: 'slow', status: 'pending' }] });
  await expect(
    readCopilotToolSnapshot(rpc, ['slow'], signal()),
  ).rejects.toThrow(/connect.*"slow"/);
});

test('rejects a tool from a selected server that did not connect, naming it', async () => {
  const rpc = fixture([tool]);
  rpc.mcp.list = (): ReturnType<CopilotToolMetadataRpc['mcp']['list']> =>
    Promise.resolve({ servers: [{ name: 'selected', status: 'failed' }] });
  await expect(
    readCopilotToolSnapshot(rpc, ['selected'], signal()),
  ).rejects.toThrow(
    'Copilot returned tools for the MCP server "selected" before it connected. Retry after checking the connection.',
  );
});

test('rejects a missing selected server and an uninitialized table', async () => {
  await expect(
    readCopilotToolSnapshot(fixture(), ['missing'], signal()),
  ).rejects.toThrow(/connect.*"missing"/);
  await expect(
    readCopilotToolSnapshot(fixture(null), ['selected'], signal()),
  ).rejects.toThrow(/initialized/);
});

test.each([
  { tools: [{ ...tool, mcpServerName: 'unexpected' }] },
  { tools: [{ ...tool, mcpToolName: undefined }] },
  { tools: [tool, tool] },
])(
  'rejects unknown, incomplete or duplicated MCP identities',
  async ({ tools }) => {
    await expect(
      readCopilotToolSnapshot(fixture(tools), ['selected'], signal()),
    ).rejects.toThrow(/identity/);
  },
);

test('limits the number and total size of model-facing definitions', async () => {
  await expect(
    readCopilotToolSnapshot(
      fixture(Array.from({ length: 10_001 }, () => tool)),
      ['selected'],
      signal(),
    ),
  ).rejects.toThrow(/tool list/);
  await expect(
    readCopilotToolSnapshot(
      fixture([{ ...tool, description: 'x'.repeat(8 * 1024 * 1024) }]),
      ['selected'],
      signal(),
    ),
  ).rejects.toThrow(/size/);
});

test('does not read more native metadata after cancellation', async () => {
  const abort = new AbortController();
  const rpc = fixture();
  rpc.tools.initializeAndValidate = (): ReturnType<
    CopilotToolMetadataRpc['tools']['initializeAndValidate']
  > => {
    abort.abort(new Error('Stopped'));
    return Promise.resolve({});
  };
  rpc.mcp.list = jest.fn(rpc.mcp.list);
  await expect(
    readCopilotToolSnapshot(rpc, ['selected'], abort.signal),
  ).rejects.toThrow('Stopped');
  expect(jest.mocked(rpc.mcp.list).mock.calls).toHaveLength(0);
});

test('a non-interactive run fails by name when a selected server sat out', () => {
  expect(() =>
    assertCopilotMcpServersConnected([
      { name: 'selected', status: 'connected' },
    ]),
  ).not.toThrow();
  expect(() =>
    assertCopilotMcpServersConnected([
      { name: 'selected', status: 'connected' },
      { name: 'slack', status: 'needs-auth' },
      { name: 'broken', status: 'failed', error: 'Connection refused' },
    ]),
  ).toThrow(
    'Copilot could not connect to the MCP servers "slack" (needs-auth), "broken" (failed: Connection refused). Connect or deselect them, then run again.',
  );
});

describe('describeCopilotMcpServerError', () => {
  it('reduces URLs to their origin, strips bearer tokens and redacts secrets', () => {
    expect(
      describeCopilotMcpServerError(
        'fetch failed for https://mcp.example.com/mcp?api_key=sk-live-123 with Authorization: Bearer ghu_abc.def (token ghu_abc.def)',
        ['ghu_abc.def'],
      ),
    ).toBe(
      'fetch failed for https://mcp.example.com with Authorization: Bearer [redacted] (token [redacted])',
    );
  });

  it('masks only token-shaped values and keeps benign words', () => {
    expect(
      describeCopilotMcpServerError(
        'token expired; Basic authentication required; Token endpoint unreachable; invalid bearer authentication',
      ),
    ).toBe(
      'token expired; Basic authentication required; Token endpoint unreachable; invalid bearer authentication',
    );
    expect(
      describeCopilotMcpServerError(
        'token=ghu_abcdefghijklmnop token: xyz12345678 access_token=AbCdEf0123456789 "token": "QmFzZTY0VmFsdWU="',
      ),
    ).toBe(
      'token=[redacted] token: [redacted] access_token=[redacted] "token": "[redacted]"',
    );
  });

  it('masks other credential keywords and other URL schemes, and trims URLs tidily', () => {
    expect(
      describeCopilotMcpServerError(
        'api_key=sk-ABC123456 password: Hunter2Hunter2 x-api-key: abcdefghijklmnopqrstuvwxyz secret=plainword',
      ),
    ).toBe(
      'api_key=[redacted] password: [redacted] x-api-key: [redacted] secret=plainword',
    );
    expect(
      describeCopilotMcpServerError(
        'wss://host.example/ws?token=abc123456 then {"url":"https://x.com/a?k=1"} done, https://a.com/mcp, failed',
      ),
    ).toBe(
      'wss://host.example then {"url":"https://x.com"} done, https://a.com, failed',
    );
  });

  it('reduces a URL with a comma inside it to its origin and keeps single capitalized words', () => {
    expect(
      describeCopilotMcpServerError(
        'GET https://host.example/a,b?sig=AbCdEf123xyz failed; see https://h.example/mcp?fields=a,b&key=SECRET9.',
      ),
    ).toBe('GET https://host.example failed; see https://h.example.');
    expect(
      describeCopilotMcpServerError(
        'Basic Authentication Required and Password Required by server',
      ),
    ).toBe('Basic Authentication Required and Password Required by server');
    expect(
      describeCopilotMcpServerError(
        'password: hunter2!longpass token: abc!defghijk123',
      ),
    ).toBe('password: [redacted] token: [redacted]');
  });

  it('reduces a URL through a parenthesis or apostrophe and keeps closers outside it', () => {
    expect(
      describeCopilotMcpServerError(
        "fetch https://h.example/a(b)?sig=AbCdEf123xyz failed; https://x.com/it's?k=1 too",
      ),
    ).toBe('fetch https://h.example failed; https://x.com too');
    expect(
      describeCopilotMcpServerError(
        '[https://h.example/a?key=1] <https://h.example/mcp?key=X> (see https://x.example/y) {"url":"https://x.com/a","name":"srv"}',
      ),
    ).toBe(
      '[https://h.example] <https://h.example> (see https://x.example) {"url":"https://x.com","name":"srv"}',
    );
    expect(
      describeCopilotMcpServerError(
        '(see https://x.example/y(z)). Then https://h.example/mcp?token=ghu_abcdefghijklmnop',
        ['ghu_abcdefghijklmnop'],
      ),
    ).toBe('(see https://x.example). Then https://h.example');
  });

  it('relaxes the mixed-case test only after whitespace', () => {
    expect(
      describeCopilotMcpServerError(
        'password=Correcthorse and Password Required by server',
      ),
    ).toBe('password=[redacted] and Password Required by server');
  });

  it('strips a long run of closers in linear time and keeps a backtick outside the URL', () => {
    const started = Date.now();
    expect(
      describeCopilotMcpServerError(`https://x/${')'.repeat(50_000)}`),
    ).toBe(`https://x${')'.repeat(150)}…`);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(
      describeCopilotMcpServerError(
        'see `https://h.example/a?k=1` for details',
      ),
    ).toBe('see `https://h.example` for details');
  });

  it('keeps a capitalized reason word after a bare colon', () => {
    expect(
      describeCopilotMcpServerError(
        'Failed to refresh token: Unauthorized; token: Forbidden (401); "token":"Abcdefghij"; token=Abcdefghij',
      ),
    ).toBe(
      'Failed to refresh token: Unauthorized; token: Forbidden (401); "token":"[redacted]"; token=[redacted]',
    );
  });

  it('redacts longer secrets first so a shorter one cannot expose the rest', () => {
    expect(
      describeCopilotMcpServerError('login acme:s3cretvalue failed', [
        'acme',
        'acme:s3cretvalue',
      ]),
    ).toBe('login [redacted] failed');
  });

  it('truncates without splitting a surrogate pair', () => {
    const described = describeCopilotMcpServerError(
      `${'x'.repeat(158)}😀 tail`,
    );
    expect(described).toBe(`${'x'.repeat(158)}…`);
  });

  it('collects header values, their bare credentials, and credential-named env values', () => {
    expect(
      collectCopilotMcpSecretValues({
        main: {
          type: 'http',
          url: 'http://127.0.0.1:1/main',
          headers: {
            Authorization: 'Bearer app-token-1234',
            'X-Short': 'abc',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          tools: ['*'],
        },
        local: {
          type: 'stdio',
          command: '/bin/true',
          env: {
            API_KEY: 'sk-live-5678',
            GITHUB_TOKEN: 'ghp_abcdefgh',
            NODE_ENV: 'production',
            HOST: 'localhost',
            EMPTY: '',
          },
          tools: ['*'],
        },
      }),
    ).toEqual([
      'Bearer app-token-1234',
      'app-token-1234',
      'sk-live-5678',
      'ghp_abcdefgh',
    ]);
    expect(collectCopilotMcpSecretValues(undefined)).toEqual([]);
  });

  it('redacts a bare credential echoed without its header scheme', () => {
    expect(
      describeCopilotMcpServerError(
        'Unauthorized: app-token-1234',
        collectCopilotMcpSecretValues({
          main: {
            type: 'http',
            url: 'http://127.0.0.1:1/main',
            headers: { Authorization: 'Bearer app-token-1234' },
            tools: ['*'],
          },
        }),
      ),
    ).toBe('Unauthorized: [redacted]');
  });

  it('collapses whitespace and truncates long text', () => {
    const long = `boom   ${'x'.repeat(400)}`;
    const described = describeCopilotMcpServerError(long);
    expect(described.startsWith('boom x')).toBe(true);
    expect(described.length).toBeLessThanOrEqual(160);
    expect(describeCopilotMcpServerError('  ')).toBeUndefined();
    expect(describeCopilotMcpServerError(undefined)).toBeUndefined();
  });

  it('is applied to the fail-by-name message', () => {
    expect(() =>
      assertCopilotMcpServersConnected(
        [
          {
            name: 'broken',
            status: 'failed',
            error: 'ECONNREFUSED https://host.example/mcp?token=secret-1',
          },
        ],
        ['secret-1'],
      ),
    ).toThrow(
      'Copilot could not connect to the MCP server "broken" (failed: ECONNREFUSED https://host.example). Connect or deselect it, then run again.',
    );
  });
});

test('fail-closed messages show the friendly part of a managed server name', async () => {
  const managed = 'appdyn-unreachable--0123456789abcdef';
  await expect(
    readCopilotToolSnapshot(fixture([]), [managed], signal()),
  ).rejects.toThrow(
    'Copilot could not connect to the MCP server "unreachable". Retry after checking the connection.',
  );
  expect(() =>
    assertCopilotMcpServersConnected([{ name: managed, status: 'failed' }]),
  ).toThrow(
    'Copilot could not connect to the MCP server "unreachable" (failed). Connect or deselect it, then run again.',
  );
});

test('waits for native pending startup to finish before reading the tool table', async () => {
  const rpc = fixture();
  const list = jest
    .fn()
    .mockResolvedValueOnce({
      servers: [{ name: 'selected', status: 'pending' }],
    })
    .mockResolvedValue({
      servers: [{ name: 'selected', status: 'connected' }],
    });
  rpc.mcp.list = list;
  await expect(
    readCopilotToolSnapshot(rpc, ['selected'], signal(), jest.fn()),
  ).resolves.toBeDefined();
  expect(list).toHaveBeenCalledTimes(2);
});

test('keeps an optional pending server unavailable when its startup deadline expires', async () => {
  const rpc = fixture([]);
  rpc.mcp.list = (): ReturnType<CopilotToolMetadataRpc['mcp']['list']> =>
    Promise.resolve({ servers: [{ name: 'selected', status: 'pending' }] });
  const timeout = new AbortController();
  const timeoutSpy = jest
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(timeout.signal);
  const observed = jest.fn();
  try {
    const result = readCopilotToolSnapshot(
      rpc,
      ['selected'],
      signal(),
      observed,
    );
    setImmediate(() =>
      timeout.abort(new DOMException('Startup expired', 'TimeoutError')),
    );
    await expect(result).resolves.toBeDefined();
    expect(observed).toHaveBeenCalledWith([
      { name: 'selected', status: 'unavailable' },
    ]);
  } finally {
    timeoutSpy.mockRestore();
  }
});

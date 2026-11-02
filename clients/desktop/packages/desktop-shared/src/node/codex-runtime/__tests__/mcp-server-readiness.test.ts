import type { ListMcpServerStatusResponse } from '../generated/v2/ListMcpServerStatusResponse';
import type { Tool } from '../generated/Tool';
import {
  waitForCodexMcpServers,
  readCodexMcpToolEvidence,
} from '../mcp-server-readiness';

describe('waitForCodexMcpServers', () => {
  it('waits for delayed healthy tools after another selected server fails', async () => {
    let healthyChecks = 0;
    const result = await waitForCodexMcpServers({
      threadId: 'thread-1',
      serverNames: ['broken', 'healthy'],
      request: jest.fn(),
      pollIntervalMs: 0,
      getStartupState: (name) =>
        name === 'broken'
          ? { status: 'failed', error: 'HTTP 503' }
          : { status: ++healthyChecks < 3 ? 'starting' : 'ready' },
    });
    expect(healthyChecks).toBe(3);
    expect(result).toEqual({
      readyServerNames: ['healthy'],
      unavailableServers: [{ name: 'broken', reason: 'failed' }],
    });
  });

  it('cancels a pending readiness delay immediately', async () => {
    const controller = new AbortController();
    const pending = waitForCodexMcpServers({
      threadId: 'thread-1',
      serverNames: ['selected'],
      request: jest.fn(),
      getStartupState: () => ({ status: 'starting' }),
      signal: controller.signal,
      pollIntervalMs: 10_000,
    });
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
  });

  it('returns sanitized unavailability without logging transport errors', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await waitForCodexMcpServers({
        threadId: 'thread-1',
        serverNames: ['selected'],
        request: jest.fn(),
        getStartupState: () => ({
          status: 'failed',
          error: 'HTTP 503 https://example.test?token=sentinel-secret',
        }),
      });
      expect(result).toEqual({
        readyServerNames: [],
        unavailableServers: [{ name: 'selected', reason: 'failed' }],
      });
      expect(JSON.stringify(result)).not.toContain('sentinel-secret');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('waits until every selected server has completed initialization', async () => {
    const responses: ListMcpServerStatusResponse[] = [
      {
        data: [],
        nextCursor: null,
      },
      {
        data: [
          {
            name: 'selected',
            runtimeStatus: null,
            pluginId: null,
            httpOrigin: null,
            // Some app-server/MCP protocol combinations publish the tool
            // inventory without preserving serverInfo. The verifier's
            // durability boundary is the selected tool inventory itself.
            serverInfo: null,
            serverCapabilities: null,
            tools: {
              secret_echo: {} as never,
            },
            toolListMeta: null,
            toolsError: null,
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
          },
        ],
        nextCursor: null,
      },
    ];
    const request = jest.fn(() => {
      const response = responses.shift();
      if (!response) {
        throw new Error('Unexpected extra MCP readiness request');
      }
      return Promise.resolve(response);
    });

    await waitForCodexMcpServers({
      threadId: 'thread-1',
      serverNames: ['selected'],
      request,
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      detail: 'toolsAndAuthOnly',
      cursor: null,
    });
  });

  it.each([
    [
      'HTTP 503: MCP authorization is temporarily unavailable. Try again shortly.',
      'serverInitializationFailed',
    ],
    ['Connection refused', undefined],
    ['Invalid MCP protocol response', undefined],
    ['MCP handshake exited with code 23', undefined],
    ['MCP server authorization required', 'reauthenticationRequired'],
    [undefined, 'serverInitializationFailed'],
  ])('continues without a failed server: %s', async (error, failureReason) => {
    const request = jest.fn();
    await expect(
      waitForCodexMcpServers({
        threadId: 'thread-1',
        serverNames: ['broken', 'healthy'],
        request,
        getStartupState: (name) =>
          name === 'healthy'
            ? { status: 'ready' }
            : { status: 'failed', error, failureReason },
      }),
    ).resolves.toEqual({
      readyServerNames: ['healthy'],
      unavailableServers: [{ name: 'broken', reason: 'failed' }],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('continues without a legacy startup failure while still waiting for healthy tools', async () => {
    let checks = 0;
    const request = jest.fn().mockResolvedValue({
      data: [{ name: 'healthy', serverInfo: null, tools: { echo: {} } }],
      nextCursor: null,
    });
    await expect(
      waitForCodexMcpServers({
        threadId: 'thread-1',
        serverNames: ['broken', 'healthy'],
        getStartupFailure: (name) =>
          name === 'broken' ? 'Connection refused' : undefined,
        request,
        now: () => checks++,
      }),
    ).resolves.toEqual({
      readyServerNames: ['healthy'],
      unavailableServers: [{ name: 'broken', reason: 'failed' }],
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled, missing, and cancelled servers without dropping a healthy server', async () => {
    let now = 0;
    await expect(
      waitForCodexMcpServers({
        threadId: 'thread-1',
        serverNames: ['healthy', 'stalled', 'missing', 'cancelled'],
        request: jest.fn(),
        getStartupState: (name) =>
          name === 'healthy'
            ? { status: 'ready' }
            : name === 'stalled'
              ? { status: 'starting' }
              : name === 'cancelled'
                ? { status: 'cancelled' }
                : undefined,
        timeoutMs: 10,
        pollIntervalMs: 0,
        now: () => (now += 10),
      }),
    ).resolves.toEqual({
      readyServerNames: ['healthy'],
      unavailableServers: ['stalled', 'missing', 'cancelled'].map((name) => ({
        name,
        reason: 'timeout',
      })),
    });
  });

  it('does not turn cancellation or an app-server RPC failure into MCP unavailability', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    await expect(
      waitForCodexMcpServers({
        threadId: 'thread-1',
        serverNames: ['selected'],
        request: jest.fn(),
        signal: controller.signal,
      }),
    ).rejects.toThrow('user cancelled');
    await expect(
      waitForCodexMcpServers({
        threadId: 'thread-1',
        serverNames: ['selected'],
        request: jest
          .fn()
          .mockRejectedValue(new Error('app-server disconnected')),
      }),
    ).rejects.toThrow('app-server disconnected');
  });

  it('allows a previously unavailable server to become ready on the next startup round', async () => {
    const getStartupState = jest
      .fn()
      .mockReturnValue({ status: 'failed', error: 'HTTP 503' });
    const options = {
      threadId: 'thread-1',
      serverNames: ['selected'],
      request: jest.fn(),
      getStartupState,
    };
    await expect(waitForCodexMcpServers(options)).resolves.toMatchObject({
      unavailableServers: [{ name: 'selected', reason: 'failed' }],
    });
    getStartupState.mockReturnValue({ status: 'ready' });
    await expect(waitForCodexMcpServers(options)).resolves.toEqual({
      readyServerNames: ['selected'],
      unavailableServers: [],
    });
  });

  it('waits for the owning thread startup event instead of a separate inventory connection', async () => {
    const linearGetIssueTool: Tool = {
      name: 'linear_get_issue',
      description: 'Get a Linear issue',
      inputSchema: { type: 'object' },
    };
    const request = jest.fn(() =>
      Promise.resolve({
        data: [
          {
            name: 'selected',
            runtimeStatus: null,
            pluginId: null,
            httpOrigin: null,
            serverInfo: {
              name: 'inventory-probe',
              title: null,
              version: '1',
              description: null,
              icons: null,
              websiteUrl: null,
            },
            serverCapabilities: null,
            tools: {
              linear_get_issue: linearGetIssueTool,
            },
            toolListMeta: null,
            toolsError: null,
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported' as const,
          },
        ],
        nextCursor: null,
      }),
    );
    let checks = 0;

    await waitForCodexMcpServers({
      threadId: 'thread-1',
      serverNames: ['selected'],
      request,
      getStartupState: () => ({
        status: checks++ > 0 ? 'ready' : 'starting',
      }),
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(request).not.toHaveBeenCalled();
  });

  it('waits through an interrupted startup round for the replacement round to become ready', async () => {
    const request = jest.fn(() =>
      Promise.resolve({
        data: [],
        nextCursor: null,
      }),
    );
    let checks = 0;

    await waitForCodexMcpServers({
      threadId: 'thread-1',
      serverNames: ['selected'],
      request,
      getStartupState: () => {
        checks += 1;
        if (checks <= 2) {
          return { status: 'cancelled' };
        }
        if (checks <= 4) {
          return { status: 'starting' };
        }
        return { status: 'ready' };
      },
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(request).not.toHaveBeenCalled();
  });
});

describe('owning Codex MCP tool evidence', () => {
  function response(
    overrides: Partial<ListMcpServerStatusResponse['data'][number]> = {},
    nextCursor: string | null = null,
  ): ListMcpServerStatusResponse {
    return {
      data: [
        {
          name: 'calendar',
          runtimeStatus: 'connected',
          pluginId: null,
          httpOrigin: null,
          serverInfo: null,
          serverCapabilities: { tools: {} },
          tools: {
            events: { name: 'events', inputSchema: { type: 'object' } },
          },
          toolListMeta: null,
          toolsError: null,
          resources: [],
          resourceTemplates: [],
          authStatus: 'unsupported',
          ...overrides,
        },
      ],
      nextCursor,
    };
  }

  it('requires both owning thread and exact server selectors and a complete catalog', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(response({}, 'page2'))
      .mockResolvedValueOnce(response());
    await expect(
      readCodexMcpToolEvidence({
        threadId: 'owned-thread',
        serverNames: ['calendar'],
        request,
      }),
    ).resolves.toEqual([{ name: 'calendar', kind: 'tools', toolCount: 1 }]);
    expect(request.mock.calls.map(([params]): unknown => params)).toEqual([
      {
        threadId: 'owned-thread',
        serverName: 'calendar',
        detail: 'toolsAndAuthOnly',
        cursor: null,
      },
      {
        threadId: 'owned-thread',
        serverName: 'calendar',
        detail: 'toolsAndAuthOnly',
        cursor: 'page2',
      },
    ]);
  });

  it.each([
    response({ runtimeStatus: null }),
    response({ toolsError: 'catalog failed' }),
    response({ name: 'another-chat-server' }),
  ])('refuses inventory-only, failed or unrelated evidence', async (value) => {
    await expect(
      readCodexMcpToolEvidence({
        threadId: 'thread',
        serverNames: ['calendar'],
        request: jest.fn().mockResolvedValue(value),
      }),
    ).resolves.toEqual([expect.objectContaining({ kind: 'unavailable' })]);
  });

  it('reports auth and an empty catalog distinctly without using resources', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        response({ runtimeStatus: 'authenticationRequired' }),
      )
      .mockResolvedValueOnce(response({ tools: {} }));
    await expect(
      readCodexMcpToolEvidence({
        threadId: 'thread',
        serverNames: ['calendar'],
        request,
      }),
    ).resolves.toEqual([{ name: 'calendar', kind: 'auth_required' }]);
    await expect(
      readCodexMcpToolEvidence({
        threadId: 'thread',
        serverNames: ['calendar'],
        request,
      }),
    ).resolves.toEqual([{ name: 'calendar', kind: 'tools', toolCount: 0 }]);
  });

  it('bounds repeated pagination and rejects cancellation', async () => {
    const request = jest.fn().mockResolvedValue(response({}, 'same-page'));
    await expect(
      readCodexMcpToolEvidence({
        threadId: 'thread',
        serverNames: ['calendar'],
        request,
      }),
    ).resolves.toEqual([
      { name: 'calendar', kind: 'unavailable', reason: 'timeout' },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(
      readCodexMcpToolEvidence({
        threadId: 'thread',
        serverNames: ['calendar'],
        request,
        signal: controller.signal,
      }),
    ).rejects.toThrow('stopped');
  });

  it('isolates an optional server probe failure from another ready server', async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error('RPC failed'))
      .mockResolvedValueOnce(response());
    await expect(
      readCodexMcpToolEvidence({
        threadId: 'thread',
        serverNames: ['optional', 'calendar'],
        request,
      }),
    ).resolves.toEqual([
      { name: 'optional', kind: 'unavailable', reason: 'startup_failed' },
      { name: 'calendar', kind: 'tools', toolCount: 1 },
    ]);
  });
});

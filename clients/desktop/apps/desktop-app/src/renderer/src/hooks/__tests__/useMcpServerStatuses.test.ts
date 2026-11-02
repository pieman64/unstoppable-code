/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { McpServerIndexEntry } from '@canopy/desktop-shared/types/mcp-servers';
import { useMcpServerStatuses } from '../useMcpServerStatuses';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const servers: McpServerIndexEntry[] = [
  {
    id: 'server-1',
    name: 'Server',
    description: '',
    type: 'http',
    configs: [{ id: 'default', name: 'Default', enabled: true }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

it('reads cached status on mount, expiry, auth changes, and refresh without probing servers', async () => {
  jest.useFakeTimers();
  const checkHealth = jest.fn().mockResolvedValue({ status: 'healthy' });
  const listStatus = jest.fn().mockResolvedValue([
    {
      serverId: 'server-1',
      connectionStatus: 'connected',
      configs: [
        {
          configId: 'default',
          authStatus: 'connected',
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      ],
    },
  ]);
  let authChanged: (() => void) | undefined;
  const unsubscribe = jest.fn();
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      checkHealth,
      listStatus,
      onAuthChanged: (listener: () => void) => {
        authChanged = listener;
        return unsubscribe;
      },
    },
  });
  let refresh: (() => void) | undefined;
  function Harness(): ReturnType<typeof createElement> {
    const result = useMcpServerStatuses(servers);
    refresh = result.refresh;
    return createElement(
      'span',
      null,
      result.statuses.get('server-1')?.connectionStatus,
    );
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });
    expect(container.textContent).toBe('connected');
    expect(checkHealth).not.toHaveBeenCalled();
    listStatus.mockResolvedValue([
      {
        serverId: 'server-1',
        connectionStatus: 'unknown',
        configs: [
          { configId: 'default', authStatus: 'expired', canRefresh: true },
        ],
      },
    ]);
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(container.textContent).toBe('unknown');
    listStatus.mockResolvedValue([
      { serverId: 'server-1', connectionStatus: 'auth_required', configs: [] },
    ]);
    await act(async () => {
      authChanged?.();
      await Promise.resolve();
    });
    expect(container.textContent).toBe('auth_required');
    await act(async () => {
      refresh?.();
      await Promise.resolve();
    });
    expect(checkHealth).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    jest.useRealTimers();
  }
  expect(unsubscribe).toHaveBeenCalled();
});

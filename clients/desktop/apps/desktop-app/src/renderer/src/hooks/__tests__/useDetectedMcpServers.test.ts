/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DetectedMcpServerInfo,
  StartMcpOAuthLoginResponse,
} from '@canopy/desktop-shared/types/mcp-servers';
import { getOAuthFailureMessage } from '../useDetectedMcpServers';
import {
  useDetectedMcpServers,
  type UseDetectedMcpServersResult,
} from '../useDetectedMcpServers';

type RevisionedServer = DetectedMcpServerInfo & {
  authErrorRevision?: string;
};

function errorServer(authErrorRevision: string): RevisionedServer {
  return {
    key: 'standalone:server-1:config-1',
    source: 'standalone',
    serverName: 'server-1',
    displayName: 'Server',
    type: 'http',
    enabled: true,
    authStatus: 'error',
    authStatusLabel: 'Error',
    canConnect: true,
    lastError: 'Previous refresh failed',
    authErrorRevision,
  };
}

describe('getOAuthFailureMessage', () => {
  it('ignores only the error revision that preceded the current login attempt', () => {
    expect(
      getOAuthFailureMessage(errorServer('revision-1'), 'revision-1'),
    ).toBeNull();
    expect(
      getOAuthFailureMessage(errorServer('revision-2'), 'revision-1'),
    ).toBe('Previous refresh failed');
  });
});

describe('local sign-in observation', () => {
  let model: UseDetectedMcpServersResult | undefined;
  const selected = { collectionIds: [], skillRefs: [], pluginRefs: [] };
  const server: DetectedMcpServerInfo = {
    ...errorServer('old'),
    authStatus: 'not_connected',
    serverId: 'server-1',
    configId: 'config-1',
    httpAuthHandler: 'canopy',
  };
  let inventory = [server];
  const start = jest.fn<Promise<StartMcpOAuthLoginResponse>, []>();
  const cancel = jest.fn(() => Promise.resolve());
  let original: PropertyDescriptor | undefined;
  const container = document.createElement('div');
  let root: Root;
  function Probe({
    owner,
    cleared = false,
  }: {
    owner: string;
    cleared?: boolean;
  }): null {
    model = useDetectedMcpServers(cleared ? null : selected, {
      ownerKey: owner,
    });
    return null;
  }
  beforeEach(async () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    jest.useFakeTimers();
    inventory = [server];
    start.mockReset();
    cancel.mockClear();
    original = Object.getOwnPropertyDescriptor(window, 'mcpServers');
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listDetected: jest.fn(() =>
          Promise.resolve({
            servers: inventory,
            warnings: [],
          }),
        ),
        startOAuthLogin: start,
        cancelOAuthLogin: cancel,
      },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { owner: 'one' }));
      await Promise.resolve();
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    if (original) Object.defineProperty(window, 'mcpServers', original);
    else Reflect.deleteProperty(window, 'mcpServers');
    jest.useRealTimers();
  });
  it('cancels a flow whose ID arrives late, without clearing a newer attempt', async () => {
    let finish: (response: StartMcpOAuthLoginResponse) => void = (): void =>
      undefined;
    start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    start.mockResolvedValue({
      status: 'started',
      flowId: 'new',
      authorizationUrl: 'https://auth.example.test/new',
    });
    let old: Promise<void> | undefined;
    await act(async () => {
      old = model?.connect(server);
      await Promise.resolve();
    });
    act(() => model?.cancelConnect());
    await act(async () => {
      void model?.connect(server);
      await Promise.resolve();
    });
    await act(async () => {
      finish({ status: 'started', flowId: 'old' });
      await old;
    });
    expect(cancel).toHaveBeenCalledWith('old');
    expect(model?.connectingKey).toBe(server.key);
    expect(model?.signInUrl).toBe('https://auth.example.test/new');
  });
  it('requires authoritative inventory after a completed launch acknowledgement', async () => {
    start.mockResolvedValue({ status: 'completed' });
    await act(async () => {
      void model?.connect(server);
      await Promise.resolve();
    });
    expect(model?.connectingKey).toBe(server.key);
    expect(model?.servers[0]?.authStatus).toBe('not_connected');
    inventory = [{ ...server, authStatus: 'connected' }];
    await act(async () => jest.advanceTimersByTimeAsync(1500));
    expect(model?.connectingKey).toBeNull();
    expect(model?.servers[0]?.authStatus).toBe('connected');
  });
  it('ends a pending sign-in when the selections are cleared', async () => {
    start.mockResolvedValue({
      status: 'started',
      flowId: 'old',
      authorizationUrl: 'https://auth.example.test/old',
    });
    await act(async () => {
      void model?.connect(server);
      await Promise.resolve();
    });
    expect(model?.connectingKey).toBe(server.key);
    await act(async () => {
      root.render(createElement(Probe, { owner: 'one', cleared: true }));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(createElement(Probe, { owner: 'one' }));
      await Promise.resolve();
    });
    expect(model?.connectingKey).toBeNull();
    expect(model?.signInUrl).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });
  it('stops polling when its captured owner changes', async () => {
    start.mockResolvedValue({ status: 'started', flowId: 'old' });
    await act(async () => {
      void model?.connect(server);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(createElement(Probe, { owner: 'two' }));
      await Promise.resolve();
    });
    await act(async () => jest.advanceTimersByTimeAsync(120000));
    expect(model?.connectingKey).toBeNull();
    expect(model?.error).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });
});

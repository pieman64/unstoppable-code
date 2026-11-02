/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountMcpClientSetup } from '@canopy/protocol/mcp-servers';
import { mcpConnectErrorMessage } from '@canopy/ui-shared/lib';
import {
  useAccountMcpActions,
  type AccountMcpActions,
  type AccountMcpConnectOptions,
} from '../useAccountMcpActions';

const clientSetup: AccountMcpClientSetup = {
  redirectUri:
    'https://app.example.test/api/mcp-connections/callback/issuer-key',
  issuer: 'https://accounts.example.test',
  clientSecretRequired: false,
  clientSecretAccepted: false,
};
const refresh = jest.fn((): Promise<void> => Promise.resolve());
let actions: AccountMcpActions | undefined;

function Probe(): JSX.Element {
  actions = useAccountMcpActions(refresh);
  return <></>;
}

let container: HTMLDivElement;
let root: Root;
let originalMcpServers: PropertyDescriptor | undefined;
let originalApi: PropertyDescriptor | undefined;

beforeEach((): void => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  originalMcpServers = Object.getOwnPropertyDescriptor(window, 'mcpServers');
  originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      startAccountConnection: jest.fn().mockResolvedValue({
        error: { code: 'oauth-client-required', clientSetup },
      }),
    },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: jest
        .fn()
        .mockResolvedValue({ hasApiKey: true, account: { id: 'acct-1' } }),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act((): void => root.render(<Probe />));
});

afterEach((): void => {
  act((): void => root.unmount());
  container.remove();
  if (originalMcpServers)
    Object.defineProperty(window, 'mcpServers', originalMcpServers);
  else Reflect.deleteProperty(window, 'mcpServers');
  if (originalApi) Object.defineProperty(window, 'api', originalApi);
  else Reflect.deleteProperty(window, 'api');
});

async function connect(
  options: AccountMcpConnectOptions,
): Promise<string | undefined> {
  let code: string | undefined;
  await act(async (): Promise<void> => {
    code = await actions?.connect('spotify', 'default', options);
  });
  return code;
}

it('shows why a server needs its own OAuth app when no caller collects one', async (): Promise<void> => {
  const onFailure = jest.fn();
  expect(await connect({ onFailure })).toBe('oauth-client-required');
  const message =
    'This server needs its own OAuth app. Enter its client ID to connect.';
  expect(actions?.error).toBe(message);
  expect(actions?.errorCode).toBe('client_credentials_required');
  expect(onFailure).toHaveBeenCalledWith(message);
});

it('hands the client setup to a caller that collects the app, without an error', async (): Promise<void> => {
  const onFailure = jest.fn();
  const onOAuthClientRequired = jest.fn();
  expect(await connect({ onFailure, onOAuthClientRequired })).toBe(
    'oauth-client-required',
  );
  expect(onOAuthClientRequired).toHaveBeenCalledWith(clientSetup);
  expect(actions?.error).toBeNull();
  expect(onFailure).not.toHaveBeenCalled();
});

describe('a start the cloud refuses for want of an endpoint', () => {
  beforeEach((): void => {
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        startAccountConnection: jest.fn().mockResolvedValue({
          error: { code: 'connect-refused', serverCode: 'endpoint_required' },
        }),
      },
    });
  });

  it('hands the choice to a caller that asks for an endpoint, without an error', async (): Promise<void> => {
    const onFailure = jest.fn();
    const onEndpointRequired = jest.fn();
    expect(await connect({ onFailure, onEndpointRequired })).toBe(
      'connect-refused',
    );
    expect(onEndpointRequired).toHaveBeenCalledTimes(1);
    expect(actions?.error).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports the refusal when no caller asks for an endpoint', async (): Promise<void> => {
    expect(await connect({})).toBe('connect-refused');
    expect(actions?.error).toBe(
      'Choose an endpoint for this server, then sign in again.',
    );
    expect(actions?.errorCode).toBe('endpoint_required');
  });
});

describe('a start that settles (REG-3052)', () => {
  const pending = {
    id: 'conn-spotify',
    serverKey: 'spotify',
    configId: 'default',
    displayName: 'Spotify',
    status: 'PENDING',
    kind: 'CURATED',
  } as const;
  let awaitAccountConnection: jest.Mock;

  beforeEach((): void => {
    awaitAccountConnection = jest.fn();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        startAccountConnection: jest
          .fn()
          .mockResolvedValue({ connection: pending }),
        awaitAccountConnection,
      },
    });
  });

  it('runs onConnected once the browser sign-in connects', async (): Promise<void> => {
    const connected = {
      ...pending,
      status: 'CONNECTED',
      routeId: 'route',
      enabledTools: null,
    };
    awaitAccountConnection.mockResolvedValue(connected);
    const onConnected = jest.fn((): Promise<void> => Promise.resolve());
    expect(await connect({ onConnected })).toBeUndefined();
    expect(awaitAccountConnection).toHaveBeenCalledWith('conn-spotify');
    expect(onConnected).toHaveBeenCalledWith(connected);
    expect(actions?.error).toBeNull();
  });

  it('skips onConnected when the connection still needs attention', async (): Promise<void> => {
    awaitAccountConnection.mockResolvedValue({
      ...pending,
      status: 'REAUTH_REQUIRED',
      routeId: 'route',
      enabledTools: null,
    });
    const onConnected = jest.fn((): Promise<void> => Promise.resolve());
    await connect({ onConnected });
    expect(onConnected).not.toHaveBeenCalled();
    expect(actions?.error).toBe('Connection needs attention. Connect again.');
  });
});

describe('a catalog server the account can’t sign in to (REG-3048)', () => {
  function refuseWith(error: Record<string, unknown>): void {
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        startAccountConnection: jest.fn().mockResolvedValue({
          error: {
            code: 'connect-refused',
            serverCode: 'sign_in_unavailable',
            ...error,
          },
        }),
      },
    });
  }

  it.each<[Record<string, unknown>, string]>([
    [
      { desktopSignIn: true },
      "Your account can't sign in to this server. Add it to this device instead.",
    ],
    [
      { desktopSignIn: false },
      "This server only lets approved apps sign in, so your account can't connect it yet.",
    ],
    // A main process that forwards no flag reads as no device sign-in.
    [
      {},
      "This server only lets approved apps sign in, so your account can't connect it yet.",
    ],
  ])(
    'says why for %j instead of asking for an OAuth app',
    async (error, message): Promise<void> => {
      refuseWith(error);
      const onFailure = jest.fn();
      const onOAuthClientRequired = jest.fn();
      const onEndpointRequired = jest.fn();
      expect(
        await connect({ onFailure, onOAuthClientRequired, onEndpointRequired }),
      ).toBe('connect-refused');
      expect(onOAuthClientRequired).not.toHaveBeenCalled();
      expect(onEndpointRequired).not.toHaveBeenCalled();
      expect(actions?.error).toBe(message);
      expect(actions?.errorCode).toBe('sign_in_unavailable');
      expect(onFailure).toHaveBeenCalledWith(message);
    },
  );
});

it('reads a refusal code it has no sentence for as a generic connect failure', async (): Promise<void> => {
  // A cloud newer than this app can refuse with a code the app doesn't know.
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      startAccountConnection: jest.fn().mockResolvedValue({
        error: { code: 'connect-refused', serverCode: 'some_future_refusal' },
      }),
    },
  });
  const onOAuthClientRequired = jest.fn();
  expect(await connect({ onOAuthClientRequired })).toBe('connect-refused');
  expect(onOAuthClientRequired).not.toHaveBeenCalled();
  expect(actions?.error).toBe('Couldn’t connect. Try again.');
  expect(actions?.errorCode).toBe('some_future_refusal');
});

describe('an embedded Try it sign-in (CAN-4451)', () => {
  const pending = {
    id: 'conn-linear',
    serverKey: 'linear',
    configId: 'default',
    displayName: 'Linear',
    status: 'PENDING',
    kind: 'CURATED',
  } as const;
  let startAccountConnection: jest.Mock;
  let awaitAccountConnection: jest.Mock;

  beforeEach((): void => {
    startAccountConnection = jest.fn().mockResolvedValue({
      authorizationUrl: 'https://provider.example.test/authorize',
      embeddedUrl: 'https://app.example.test/consume/one-shot',
    });
    awaitAccountConnection = jest.fn();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        startAccountConnection,
        awaitAccountConnection,
        loadIndex: jest.fn().mockResolvedValue({
          servers: [{ accountConnection: pending }],
        }),
        disconnectAccountConnection: jest.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('asks for the embedded page, reports it, then reports connected once', async (): Promise<void> => {
    awaitAccountConnection.mockResolvedValue({
      ...pending,
      status: 'CONNECTED',
    });
    const onAuthorizing = jest.fn();
    const onOutcome = jest.fn();
    await act(async (): Promise<void> => {
      await actions?.connect('linear', 'default', {
        browser: 'embedded',
        onAuthorizing,
        onOutcome,
      });
    });
    expect(startAccountConnection).toHaveBeenCalledWith(
      expect.objectContaining({ serverKey: 'linear', browser: 'embedded' }),
    );
    expect(onAuthorizing).toHaveBeenCalledWith(
      'https://app.example.test/consume/one-shot',
    );
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connected' }),
    );
  });

  it('omits the browser key for an external start', async (): Promise<void> => {
    awaitAccountConnection.mockResolvedValue({
      ...pending,
      status: 'CONNECTED',
    });
    await act(async (): Promise<void> => {
      await actions?.connect('linear', 'default', {});
    });
    expect(startAccountConnection).toHaveBeenCalledWith(
      expect.not.objectContaining({ browser: 'embedded' }),
    );
  });

  it('reports a timeout as one failure', async (): Promise<void> => {
    awaitAccountConnection.mockResolvedValue({
      error: { code: 'connection-timeout' },
    });
    const onOutcome = jest.fn();
    await act(async (): Promise<void> => {
      await actions?.connect('linear', 'default', { onOutcome });
    });
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failed' }),
    );
  });

  it('words a refused browser sign-in by the cloud code it carries', async (): Promise<void> => {
    awaitAccountConnection.mockResolvedValue({
      error: { code: 'connect-refused', serverCode: 'access_denied' },
    });
    const onOutcome = jest.fn();
    await act(async (): Promise<void> => {
      await actions?.connect('linear', 'default', { onOutcome });
    });
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({
      kind: 'failed',
      message: mcpConnectErrorMessage('access_denied'),
    });
  });

  it('reports a cancellation, never a late success', async (): Promise<void> => {
    let settle: (value: unknown) => void = () => undefined;
    awaitAccountConnection.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const onOutcome = jest.fn();
    const onConnected = jest.fn((): Promise<void> => Promise.resolve());
    let running: Promise<unknown> = Promise.resolve();
    await act(async (): Promise<void> => {
      running =
        actions?.connect('linear', 'default', {
          onOutcome,
          onConnected,
        }) ?? Promise.resolve();
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      await actions?.cancel('linear');
      settle({ ...pending, status: 'CONNECTED' });
      await running;
    });
    expect(onConnected).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({ kind: 'cancelled' });
  });

  it('queues Retry behind cancellation cleanup without reporting a duplicate failure', async () => {
    let settle: (value: unknown) => void = () => undefined;
    awaitAccountConnection
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      )
      .mockResolvedValue({ ...pending, status: 'CONNECTED' });
    let first: Promise<unknown> | undefined;
    await act(async () => {
      first = actions?.connect('linear', 'default');
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    await act(async () => {
      await actions?.cancel('linear');
    });
    const outcome = jest.fn();
    let retry: Promise<unknown> | undefined;
    await act(async () => {
      retry = actions?.connect('linear', 'default', { onOutcome: outcome });
      await Promise.resolve();
    });
    expect(outcome).not.toHaveBeenCalled();
    expect(startAccountConnection).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle({ ...pending, status: 'DISCONNECTED' });
      await first;
      await retry;
    });
    expect(startAccountConnection).toHaveBeenCalledTimes(2);
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connected' }),
    );
  });

  it('keeps Retry queued when polling settles before the disconnect finishes', async () => {
    let settle: (value: unknown) => void = () => undefined;
    let releaseDisconnect: () => void = () => undefined;
    awaitAccountConnection
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      )
      .mockResolvedValue({ ...pending, status: 'CONNECTED' });
    const disconnect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDisconnect = resolve;
        }),
    );
    window.mcpServers.disconnectAccountConnection = disconnect;
    let first: Promise<unknown> | undefined;
    let cancellation: Promise<void> | undefined;
    let retry: Promise<unknown> | undefined;
    const outcome = jest.fn();
    await act(async () => {
      first = actions?.connect('linear', 'default');
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      cancellation = actions?.cancel('linear');
      settle({ ...pending, status: 'DISCONNECTED' });
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      retry = actions?.connect('linear', 'default', { onOutcome: outcome });
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    try {
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(startAccountConnection).toHaveBeenCalledTimes(1);
      expect(outcome).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        releaseDisconnect();
        await cancellation;
        await first;
        await retry;
      });
    }
    expect(startAccountConnection).toHaveBeenCalledTimes(2);
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connected' }),
    );
  });

  it('reports a duplicate start as a failure without starting it', async (): Promise<void> => {
    awaitAccountConnection.mockReturnValue(new Promise(() => undefined));
    const second = jest.fn();
    await act(async (): Promise<void> => {
      void actions?.connect('linear', 'default', {});
      await actions?.connect('linear', 'default', { onOutcome: second });
    });
    expect(startAccountConnection).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ kind: 'failed', message: null });
  });
});

it('abandons an obsolete owner’s pending start without disconnecting or reporting its result', async (): Promise<void> => {
  let finish: (value: {
    error: { code: 'connect-refused' };
  }) => void = (): void => undefined;
  const start = jest.fn(
    () =>
      new Promise<{ error: { code: 'connect-refused' } }>((resolve) => {
        finish = resolve;
      }),
  );
  const disconnect = jest.fn();
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      startAccountConnection: start,
      disconnectAccountConnection: disconnect,
    },
  });
  const onOutcome = jest.fn();
  let pending: Promise<unknown> | undefined;
  await act(async () => {
    pending = actions?.connect('spotify', 'default', { onOutcome });
    await Promise.resolve();
  });
  act(() => actions?.stopObserving());
  await act(async () => {
    finish({ error: { code: 'connect-refused' } });
    await pending;
  });
  expect(disconnect).not.toHaveBeenCalled();
  expect(onOutcome).not.toHaveBeenCalled();
  expect(actions?.error).toBeNull();
  expect(actions?.pending.size).toBe(0);
});

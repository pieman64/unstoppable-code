/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  McpServerAuthStatus,
  McpServerStatusEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  MCP_AUTH_RECOVERY_POLL_INTERVAL_MS,
  MCP_AUTH_RECOVERY_POLL_TIMEOUT_MS,
  useMcpAuthRecovery,
  type McpAuthRecoveryTarget,
  type UseMcpAuthRecoveryResult,
} from '../useMcpAuthRecovery';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TARGET: McpAuthRecoveryTarget = {
  serverId: 'srv-1',
  configId: 'cfg-1',
};

interface Probe {
  current: UseMcpAuthRecoveryResult | null;
}

function Harness({
  probe,
  target,
}: {
  probe: Probe;
  target: McpAuthRecoveryTarget | null;
}): JSX.Element {
  probe.current = useMcpAuthRecovery(target);
  return <></>;
}

function statusEntry(authStatus: McpServerAuthStatus): McpServerStatusEntry {
  return {
    serverId: TARGET.serverId,
    transport: 'http',
    connectionStatus:
      authStatus === 'connected' ? 'connected' : 'auth_required',
    reachability: 'reachable',
    configs: [{ configId: TARGET.configId, authStatus }],
  };
}

function readProbe(probe: Probe): UseMcpAuthRecoveryResult {
  const value = probe.current;
  if (!value) throw new Error('hook never rendered');
  return value;
}

describe('useMcpAuthRecovery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: Probe;
  let startOAuthLogin: jest.Mock;
  let checkHealth: jest.Mock;
  let listStatus: jest.Mock;
  let unmounted: boolean;
  const originalMcpServers = window.mcpServers;

  /** Flush the microtask queue inside `act` so hook state settles. */
  async function flush(): Promise<void> {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /** Advance one poll interval and let the resulting probe settle. */
  async function tickPoll(): Promise<void> {
    await act(async (): Promise<void> => {
      jest.advanceTimersByTime(MCP_AUTH_RECOVERY_POLL_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function mount(target: McpAuthRecoveryTarget | null = TARGET): void {
    act((): void => {
      root.render(<Harness probe={probe} target={target} />);
    });
  }

  /**
   * Unmount once, whoever gets there first. A test that unmounts mid-poll
   * still has to leave `afterEach` a valid teardown.
   */
  function unmountRoot(): void {
    if (unmounted) return;
    unmounted = true;
    act((): void => root.unmount());
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    unmounted = false;
    startOAuthLogin = jest.fn().mockResolvedValue({ status: 'completed' });
    checkHealth = jest.fn().mockResolvedValue({
      serverId: TARGET.serverId,
      status: 'healthy',
      message: 'ok',
      checkedAt: '2026-09-01T12:00:00.000Z',
    });
    listStatus = jest.fn().mockResolvedValue([statusEntry('not_connected')]);
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { startOAuthLogin, checkHealth, listStatus },
    });
  });

  afterEach(() => {
    unmountRoot();
    container.remove();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: originalMcpServers,
    });
    jest.useRealTimers();
  });

  it('refreshes cached auth on token changes without launching OAuth', async () => {
    let authChanged: (() => void) | undefined;
    window.mcpServers.onAuthChanged = (listener): (() => void) => {
      authChanged = listener;
      return () => {
        authChanged = undefined;
      };
    };
    mount();
    await flush();
    listStatus.mockResolvedValue([statusEntry('connected')]);
    act(() => authChanged?.());
    await flush();
    expect(readProbe(probe).status).toBe('connected');
    listStatus.mockResolvedValue([statusEntry('expired')]);
    act(() => authChanged?.());
    await flush();
    expect(readProbe(probe).status).toBe('idle');
    expect(startOAuthLogin).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('reads connected status on mount without starting OAuth or probing the server', async () => {
    listStatus.mockResolvedValue([statusEntry('connected')]);
    mount();
    await flush();
    expect(readProbe(probe).status).toBe('connected');
    expect(startOAuthLogin).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
    unmountRoot();
    root = createRoot(container);
    unmounted = false;
    mount();
    await flush();
    expect(readProbe(probe).status).toBe('connected');
  });

  it('starts idle and does nothing without a target', async () => {
    mount(null);
    expect(readProbe(probe).status).toBe('idle');

    act((): void => readProbe(probe).start());
    await flush();

    expect(startOAuthLogin).not.toHaveBeenCalled();
    expect(readProbe(probe).status).toBe('idle');
  });

  it('goes straight to verifying when the login was already complete', async () => {
    listStatus.mockResolvedValue([statusEntry('connected')]);
    mount();

    act((): void => readProbe(probe).start());
    expect(readProbe(probe).status).toBe('starting');

    await flush();

    expect(startOAuthLogin).toHaveBeenCalledWith({
      serverId: 'srv-1',
      configId: 'cfg-1',
    });
    expect(readProbe(probe).status).toBe('connected');
    expect(checkHealth).toHaveBeenCalledWith('srv-1', 'cfg-1');
  });

  it('awaits the browser and surfaces the authorization URL when one is opened', async () => {
    startOAuthLogin.mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://example.test/authorize?state=abc',
    });
    mount();

    act((): void => readProbe(probe).start());
    await flush();

    expect(readProbe(probe).status).toBe('awaiting-browser');
    expect(readProbe(probe).authorizationUrl).toBe(
      'https://example.test/authorize?state=abc',
    );
  });

  it('reaches connected once the polled server reports a usable auth status', async () => {
    startOAuthLogin.mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://example.test/authorize',
    });
    mount();

    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('awaiting-browser');

    listStatus.mockResolvedValue([statusEntry('connected')]);
    await tickPoll();

    expect(readProbe(probe).status).toBe('connected');
    expect(readProbe(probe).authorizationUrl).toBeNull();
  });

  it('keeps polling only the affected server', async () => {
    mount();
    act((): void => readProbe(probe).start());
    await flush();
    await tickPoll();

    expect(readProbe(probe).status).toBe('verifying');
    for (const call of checkHealth.mock.calls) {
      expect(call).toEqual(['srv-1', 'cfg-1']);
    }
    expect(checkHealth.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats an expired token as still unusable', async () => {
    listStatus.mockResolvedValue([statusEntry('expired')]);
    mount();

    act((): void => readProbe(probe).start());
    await flush();

    expect(readProbe(probe).status).toBe('verifying');
  });

  it('fails with the error message when the login cannot be started', async () => {
    startOAuthLogin.mockRejectedValue(new Error('OAuth is only for HTTP'));
    mount();

    act((): void => readProbe(probe).start());
    await flush();

    const state = readProbe(probe);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('OAuth is only for HTTP');
    expect(state.timedOut).toBe(false);
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('gives up at the poll cap instead of spinning forever, and can retry', async () => {
    mount();
    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('verifying');

    const ticks =
      MCP_AUTH_RECOVERY_POLL_TIMEOUT_MS / MCP_AUTH_RECOVERY_POLL_INTERVAL_MS;
    for (let index = 0; index < ticks; index += 1) {
      await tickPoll();
    }

    const state = readProbe(probe);
    expect(state.status).toBe('failed');
    expect(state.timedOut).toBe(true);

    // No timer survives the cap: further time passing probes nothing more.
    const callsAtCap = checkHealth.mock.calls.length;
    await tickPoll();
    await tickPoll();
    expect(checkHealth.mock.calls.length).toBe(callsAtCap);

    // The retry affordance restarts the same flow.
    listStatus.mockResolvedValue([statusEntry('connected')]);
    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('connected');
  });

  it('reset cancels an in-flight poll and returns to idle', async () => {
    mount();
    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('verifying');

    act((): void => readProbe(probe).reset());
    expect(readProbe(probe).status).toBe('idle');

    const callsAtReset = checkHealth.mock.calls.length;
    await tickPoll();
    await tickPoll();
    expect(checkHealth.mock.calls.length).toBe(callsAtReset);
  });

  it.each(['unsupported', 'not_configured'] as const)(
    'does not read %s as a successful reconnect',
    async (authStatus) => {
      // The usability predicate is an ALLOWLIST (CAN-1814 review). As a
      // denylist of the three obviously-bad statuses, either of these read as
      // success on the very first tick — which fires immediately, before the
      // user has touched the browser — and rendered the green "is reconnected"
      // card for a server that never connected.
      startOAuthLogin.mockResolvedValue({
        status: 'started',
        authorizationUrl: 'https://example.test/authorize',
      });
      listStatus.mockResolvedValue([statusEntry(authStatus)]);
      mount();

      act((): void => readProbe(probe).start());
      await flush();

      expect(readProbe(probe).status).toBe('awaiting-browser');
    },
  );

  it('resets when the target switches to a different server mid-poll', async () => {
    // `start` closes over the target it captured, but the card renders its copy
    // from the CURRENT failure prop, so a `connected` result for server A would
    // otherwise be announced as "B is reconnected" (CAN-1814 review).
    mount();
    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('verifying');

    mount({ serverId: 'srv-2', configId: 'cfg-2' });
    expect(readProbe(probe).status).toBe('idle');

    const callsAtSwitch = checkHealth.mock.calls.length;
    listStatus.mockResolvedValue([statusEntry('connected')]);
    await tickPoll();
    await tickPoll();
    expect(checkHealth.mock.calls.length).toBe(callsAtSwitch);
    expect(readProbe(probe).status).toBe('idle');
  });

  it('survives a re-render that rebuilds the target object', async () => {
    // The card builds `{ serverId, configId }` inline from `recovery`, so the
    // object identity changes every render. Keying the reset effect on the
    // object rather than the id strings would cancel the poll forever.
    mount();
    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('verifying');

    mount({ serverId: TARGET.serverId, configId: TARGET.configId });
    expect(readProbe(probe).status).toBe('verifying');

    listStatus.mockResolvedValue([statusEntry('connected')]);
    await tickPoll();
    expect(readProbe(probe).status).toBe('connected');
  });

  it('cancels an in-flight poll when the card unmounts mid-login', async () => {
    // `ChatMessageList` virtualizes at 80 turn groups, so scrolling away
    // during a browser login really does unmount the card. The cancellation
    // exists (`runIdRef` plus the cleanup `clearTimeout`); this is what pins
    // it (CAN-1814 review).
    startOAuthLogin.mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://example.test/authorize',
    });
    mount();
    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('awaiting-browser');
    const callsBeforePoll = checkHealth.mock.calls.length;

    // Hang the next probe so the unmount lands mid-request, which is the case
    // `runIdRef` exists for: a resolution that arrives after teardown.
    let releaseProbe: (
      entries: McpServerStatusEntry[],
    ) => void = (): void => {};
    const pendingProbe = new Promise<McpServerStatusEntry[]>(
      (resolve): void => {
        releaseProbe = resolve;
      },
    );
    listStatus.mockImplementationOnce(
      async (): Promise<McpServerStatusEntry[]> => pendingProbe,
    );
    await tickPoll();
    const statusAtUnmount = readProbe(probe).status;
    const callsAtUnmount = checkHealth.mock.calls.length;
    const readsAtUnmount = listStatus.mock.calls.length;
    // The poll loop is genuinely live, so the teardown below has something to
    // cancel rather than passing vacuously.
    expect(callsAtUnmount).toBeGreaterThan(callsBeforePoll);

    unmountRoot();

    // The in-flight probe now resolves with a SUCCESS. Nothing may write state
    // from it — an unmounted card has no "is reconnected" line to show.
    await act(async (): Promise<void> => {
      releaseProbe([statusEntry('connected')]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readProbe(probe).status).toBe(statusAtUnmount);

    // And no timer outlived the unmount to schedule another probe. Asserted on
    // probe activity rather than `jest.getTimerCount()`, which also counts
    // React's and jsdom's own scheduler timers under fake timers.
    jest.advanceTimersByTime(MCP_AUTH_RECOVERY_POLL_INTERVAL_MS * 3);
    expect(checkHealth.mock.calls.length).toBe(callsAtUnmount);
    expect(listStatus.mock.calls.length).toBe(readsAtUnmount);
  });

  it('keeps polling through a transient probe failure', async () => {
    listStatus.mockRejectedValueOnce(new Error('no handler'));
    mount();

    act((): void => readProbe(probe).start());
    await flush();
    expect(readProbe(probe).status).toBe('verifying');

    listStatus.mockResolvedValue([statusEntry('connected')]);
    await tickPoll();

    expect(readProbe(probe).status).toBe('connected');
  });
});

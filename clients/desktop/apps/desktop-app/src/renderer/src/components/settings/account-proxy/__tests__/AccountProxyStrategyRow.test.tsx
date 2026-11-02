/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import { AccountProxyStrategyRow } from '../AccountProxyStrategyRow';
import { useAccountProxyStore } from '@/stores/accountProxyStore';
import {
  chooseSettingsOptionSync,
  settingsSelectOptionLabels,
  settingsSelectOptionValues,
  settingsSelectTrigger,
  settingsSelectValue,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

function statusWith(
  extra: Partial<AccountProxyStatus> = {},
): AccountProxyStatus {
  return {
    available: true,
    connection: {
      id: 'server-1',
      kind: 'server',
      url: 'https://proxy.example.com',
    },
    state: 'connected',
    error: null,
    version: '8.0.28',
    accounts: [],
    routing: { strategy: 'round-robin', sessionAffinity: true },
    keepChatOnOneAccount: true,
    routeClaude: true,
    routeCodex: true,
    refreshedAt: 1,
    local: {
      phase: 'not-installed',
      version: '8.0.28',
      install: null,
      port: null,
      startWithApp: true,
      message: null,
    },
    signIn: null,
    ...extra,
  };
}

const setRoutingStrategy = jest.fn();

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setRoutingStrategy.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { accountProxy: { setRoutingStrategy } },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(status: AccountProxyStatus): void {
  act(() => root.render(<AccountProxyStrategyRow status={status} />));
}

function select(): HTMLButtonElement {
  return settingsSelectTrigger(
    document,
    '[data-testid="account-proxy-strategy-select"]',
  );
}

function row(): string {
  return (
    document.querySelector('[data-testid="account-proxy-strategy"]')
      ?.textContent ?? ''
  );
}

function choose(value: string): void {
  chooseSettingsOptionSync(select(), value);
}

describe('account order', () => {
  it("offers the three strategies and shows the server's own", () => {
    render(
      statusWith({
        routing: { strategy: 'weighted-round-robin', sessionAffinity: true },
      }),
    );
    const values = settingsSelectOptionValues(select());
    const labels = settingsSelectOptionLabels(select());
    expect(values.map((value, index) => [value, labels[index]])).toEqual([
      ['round-robin', 'Round robin'],
      ['weighted-round-robin', 'Weighted round robin'],
      ['fill-first', 'Fill first'],
    ]);
    expect(settingsSelectValue(select())).toBe('weighted-round-robin');
    expect(select().disabled).toBe(false);
    expect(row()).toContain(
      "Round robin sends each request to the next ready account. Weighted round robin spreads requests by each account's weight. Fill first uses one account until it reaches a limit.",
    );
    expect(row()).toContain('Applies to everyone who uses this server.');
  });

  it('changes the strategy on the proxy and shows the status it returns', async () => {
    let resolve: ((status: AccountProxyStatus) => void) | undefined;
    setRoutingStrategy.mockReturnValue(
      new Promise<AccountProxyStatus>((done) => {
        resolve = done;
      }),
    );
    render(statusWith());
    choose('fill-first');
    expect(setRoutingStrategy).toHaveBeenCalledWith({ strategy: 'fill-first' });
    // Disabled on the chosen value while the proxy saves it.
    expect(settingsSelectValue(select())).toBe('fill-first');
    expect(select().disabled).toBe(true);
    const saved = statusWith({
      routing: { strategy: 'fill-first', sessionAffinity: true },
    });
    await act(async () => {
      resolve?.(saved);
      await Promise.resolve();
    });
    expect(useAccountProxyStore.getState().status).toEqual(saved);
    expect(select().disabled).toBe(false);
  });

  it('goes back to the current strategy and says so when the change fails', async () => {
    setRoutingStrategy.mockRejectedValue(new Error('unreachable'));
    render(statusWith());
    choose('fill-first');
    await act(async () => {
      await Promise.resolve();
    });
    expect(settingsSelectValue(select())).toBe('round-robin');
    expect(
      document.querySelector('[data-testid="account-proxy-strategy-error"]')
        ?.textContent,
    ).toBe("Couldn't change the account order. Try again.");
  });

  it('cannot be changed with a key the server rejected', () => {
    render(
      statusWith({
        state: 'error',
        error: { code: 'unauthorized', message: 'unauthorized' },
      }),
    );
    expect(select().disabled).toBe(true);
    expect(row()).toContain(
      'Enter the current management key to change the account order.',
    );
  });

  it('cannot be changed while the proxy on this device is stopped', () => {
    const local = statusWith().local;
    render(
      statusWith({
        connection: {
          id: 'local-1',
          kind: 'local',
          url: 'http://127.0.0.1:21455',
        },
        local: { ...local, phase: 'stopped' },
      }),
    );
    expect(select().disabled).toBe(true);
    expect(row()).toContain('Start the proxy to change the account order.');
    expect(row()).not.toContain('everyone');
  });

  it('is hidden when the server does not report its routing', () => {
    render(statusWith({ routing: null }));
    expect(
      document.querySelector('[data-testid="account-proxy-strategy"]'),
    ).toBeNull();
  });
});

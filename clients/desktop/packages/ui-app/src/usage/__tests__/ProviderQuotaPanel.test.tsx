/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PortalProviderUsageEntry,
  PortalProviderUsageProjection,
} from '@canopy/protocol/portal';
import { ProviderQuotaPanel } from '../ProviderQuotaPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const mockCommand = jest.fn<Promise<void>, [string, unknown]>(() =>
  Promise.resolve(),
);
const mockCapabilities = jest.fn<{ providerQuotas?: boolean }, [string]>(
  () => ({ providerQuotas: true }),
);
jest.mock('@canopy/app-state', () => ({
  useCanopyClient: (): { command: typeof mockCommand } => ({
    command: mockCommand,
  }),
  useWorkspaceCapabilities: (id: string): { providerQuotas?: boolean } =>
    mockCapabilities(id),
}));

let container: HTMLDivElement;
let root: Root;
const entry = (
  overrides: Partial<PortalProviderUsageEntry> = {},
): PortalProviderUsageEntry => ({
  provider: 'copilot',
  authState: 'authenticated',
  accountLabel: 'octocat',
  windows: [{ id: 'premium', label: 'Premium requests', usedPercent: 0 }],
  ...overrides,
});
function render(
  value = entry(),
  props: {
    workspaceLocalId?: string;
    disabled?: boolean;
    isVisible?: boolean;
  } = {},
): void {
  const projection: PortalProviderUsageProjection = {
    updatedAt: '2026-10-12T12:00:00Z',
    providers: [value],
  };
  act(() =>
    root.render(
      <ProviderQuotaPanel
        workspaceLocalId="workspace-a"
        projection={projection}
        isVisible
        {...props}
      />,
    ),
  );
}
function refreshButton(): HTMLButtonElement {
  const button = container.querySelector(
    '[aria-label="Refresh GitHub Copilot usage"]',
  );
  if (!(button instanceof HTMLButtonElement))
    throw new Error('Missing refresh button');
  return button;
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
beforeEach(() => {
  mockCommand.mockReset().mockResolvedValue(undefined);
  mockCapabilities.mockReset().mockReturnValue({ providerQuotas: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('renders reported zero with a determinate meter and hides account identity from replay', () => {
  render();
  expect(container.textContent).toContain('0.0%');
  expect(
    container
      .querySelector('[role="progressbar"]')
      ?.getAttribute('aria-valuenow'),
  ).toBe('0');
  expect(container.textContent).toContain('octocat');
  expect(
    container.querySelector('.ph-no-capture, .ph-mask, .canopy-replay-block'),
  ).not.toBeNull();
});
it('does not ask a connected account to reconnect when its label is missing', () => {
  render(entry({ accountLabel: undefined, accountEmail: undefined }));
  expect(container.textContent).toContain('Account name unavailable');
  expect(container.textContent).not.toContain('Connect in the desktop app');
  expect(container.textContent).toContain('Premium requests');
});
it('distinguishes an unlimited plan from an unreported limit', () => {
  render(entry({ windows: [{ id: 'chat', label: 'Chat', unlimited: true }] }));
  expect(container.textContent).toContain('Unlimited');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  render(entry({ windows: [{ id: 'chat', label: 'Chat' }] }));
  expect(container.textContent).toContain('Usage unavailable');
  expect(container.textContent).not.toContain('Unlimited');
});
it.each([false, undefined])(
  'does not expose account data without an affirmative capability (%s)',
  (providerQuotas) => {
    mockCapabilities.mockReturnValue({ providerQuotas });
    render();
    expect(container.textContent).toContain(
      'Usage is unavailable for this project.',
    );
    expect(container.textContent).not.toContain('octocat');
    expect(container.querySelector('button')).toBeNull();
  },
);
it('does not mount hidden cards', () => {
  render(entry(), { isVisible: false });
  expect(container.firstChild).toBeNull();
});
it('refreshes the selected workspace and prevents duplicate requests', async () => {
  let finish: (() => void) | undefined;
  mockCommand.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(entry(), { workspaceLocalId: 'workspace-b' });
  act(() => refreshButton().click());
  expect(mockCommand).toHaveBeenCalledWith('providerUsage.refresh', {
    workspaceLocalId: 'workspace-b',
    provider: 'copilot',
  });
  expect(refreshButton().disabled).toBe(true);
  act(() => refreshButton().click());
  expect(mockCommand).toHaveBeenCalledTimes(1);
  finish?.();
  await flush();
  expect(refreshButton().disabled).toBe(false);
});
it('prevents refresh when disconnected from the host', () => {
  render(entry(), { disabled: true });
  expect(refreshButton().disabled).toBe(true);
  act(() => refreshButton().click());
  expect(mockCommand).not.toHaveBeenCalled();
});
it('shows a safe retry message without exposing transport error details', async () => {
  mockCommand.mockRejectedValue(new Error('Bearer private-value'));
  render();
  act(() => refreshButton().click());
  await flush();
  expect(container.textContent).toContain(
    'Could not refresh usage. Try again.',
  );
  expect(container.textContent).not.toContain('private-value');
});
it('does not carry an old account refresh failure into the next account', async () => {
  let fail: ((error: Error) => void) | undefined;
  mockCommand.mockImplementation(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  render();
  act(() => refreshButton().click());
  render(entry({ accountLabel: 'new-account' }));
  expect(refreshButton().disabled).toBe(false);
  fail?.(new Error('old account expired'));
  await flush();
  expect(container.textContent).toContain('new-account');
  expect(container.textContent).not.toContain('octocat');
  expect(container.textContent).not.toContain('Could not refresh');
});
it('clears quota windows and account identity when the account disconnects', () => {
  render();
  render(
    entry({ authState: 'unauthenticated', accountLabel: 'stale-account' }),
  );
  expect(container.textContent).not.toContain('stale-account');
  expect(container.textContent).not.toContain('Premium requests');
  expect(container.textContent).toContain('Connect in the desktop app');
});

it('explains an empty authoritative provider list', () => {
  act(() =>
    root.render(
      <ProviderQuotaPanel
        workspaceLocalId="workspace-a"
        isVisible
        projection={{ updatedAt: '2026-10-12T12:00:00Z', providers: [] }}
      />,
    ),
  );
  expect(container.textContent).toContain('Usage unavailable');
  expect(container.querySelector('button')).toBeNull();
});

it('shows OpenCode accounts without quota entries and refreshes the selected desktop', async () => {
  const projection = {
    updatedAt: '2026-10-21T23:00:00Z',
    providers: [],
    openCodeAccounts: {
      status: 'ready' as const,
      updatedAt: '2026-10-21T23:00:00Z',
      providers: [
        {
          id: 'fixture',
          name: 'Fixture',
          accounts: [
            {
              label: 'Work account',
              method: 'oauth' as const,
              selected: true,
              needsSignIn: false,
            },
          ],
        },
      ],
    },
  };
  act(() =>
    root.render(
      <ProviderQuotaPanel
        workspaceLocalId="workspace-b"
        projection={projection}
        isVisible
      />,
    ),
  );
  expect(container.textContent).toContain('Work account');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  const button = container.querySelector(
    '[aria-label="Refresh OpenCode accounts"]',
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement))
    throw new Error('Missing account refresh');
  await act(() => {
    button.click();
    return Promise.resolve();
  });
  expect(mockCommand).toHaveBeenCalledWith('providerUsage.refresh', {
    workspaceLocalId: 'workspace-b',
    provider: 'opencode',
  });
  act(() =>
    root.render(
      <ProviderQuotaPanel
        workspaceLocalId="workspace-b"
        projection={{ ...projection, openCodeAccounts: undefined }}
        isVisible
      />,
    ),
  );
  expect(container.textContent).not.toContain('Work account');
});

it('uses proxy accounts instead of native provider usage and retains cached windows on error', () => {
  const proxyEntry = {
    ...entry({
      provider: 'claude',
      accountLabel: 'native-account@example.com',
      windows: [
        {
          id: 'native-window',
          label: 'Native provider window',
          usedPercent: 0,
        },
      ],
    }),
    accounts: [
      {
        id: 'proxy-claude-1',
        label: 'proxy-account@example.com',
        planLabel: 'Claude Max 20x',
        status: 'error' as const,
        usageSource: 'passive' as const,
        lastUpdatedAt: '2026-10-20T14:30:00.000Z',
        error: {
          kind: 'network' as const,
          message: 'Check your connection, then try reaching Claude again.',
        },
        windows: [
          {
            id: 'seven_day_opus-primary',
            label: '7-day Opus',
            usedPercent: 42,
            resetsAt: '2026-10-20T18:00:00.000Z',
          },
        ],
      },
    ],
  };

  render(proxyEntry);

  expect(
    container.querySelectorAll('[data-testid="provider-account-usage"]'),
  ).toHaveLength(1);
  expect(container.textContent).toContain('via account proxy');
  expect(container.textContent).toContain('proxy-account@example.com');
  expect(container.textContent).toContain("Can't be used right now");
  expect(container.textContent).toContain('7-day Opus');
  expect(container.textContent).toContain('Usage: 42.0%');
  expect(container.textContent).not.toContain('native-account@example.com');
  expect(container.textContent).not.toContain('Native provider window');
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Check your connection, then try reaching Claude again.',
  );
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Showing last known usage.',
  );
  const blockedAccountLabel = Array.from(
    container.querySelectorAll('.ph-no-capture'),
  ).find((element) => element.textContent === 'proxy-account@example.com');
  expect(blockedAccountLabel).not.toBeUndefined();
});

it('shows the provider-specific add-account notice for an empty proxy account list', () => {
  const proxyEntry = {
    ...entry({
      provider: 'claude',
      accountLabel: 'native-account@example.com',
    }),
    accounts: [],
  };

  render(proxyEntry);

  expect(container.textContent).toContain(
    'Add a Claude account to the account proxy.',
  );
  expect(container.textContent).not.toContain('native-account@example.com');
  expect(
    container.querySelector('[data-testid="provider-account-usage"]'),
  ).toBeNull();
});

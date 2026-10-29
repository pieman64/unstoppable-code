/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { makeTestPreferences } from '@/test-utils/preferences';
import { MemoryTab } from '../MemoryTab';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/components/memory/MemoryExplorer', () => ({
  MemoryExplorer: ({ scope }: { scope: string }): JSX.Element => (
    <div data-memory-scope={scope} />
  ),
}));

const originalApi = Object.getOwnPropertyDescriptor(window, 'api');

afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi);
  else Reflect.deleteProperty(window, 'api');
});

test('moves local and eligible organization controls beside only user memories', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest.fn().mockResolvedValue(makeTestPreferences()),
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({ capabilities: [] }),
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    await Promise.resolve();
    root.render(<MemoryTab />);
  });
  expect(
    container.querySelector('[data-testid="local-memory-settings"]'),
  ).not.toBeNull();
  expect(container.querySelector('[data-memory-scope="user"]')).not.toBeNull();
  expect(container.querySelector('[data-memory-scope="workspace"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="org-memory-settings"]'),
  ).not.toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="org-memory-enabled-toggle"]',
  );
  expect(toggle?.disabled).toBe(true);
  expect(toggle?.getAttribute('aria-checked')).toBe('true');
  await act(async () => {
    await Promise.resolve();
    root.unmount();
  });
});

test('keeps organization opt-out and capability gating when account loading fails', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest
        .fn()
        .mockResolvedValue(
          makeTestPreferences({ orgMemoryInjectionEnabled: false }),
        ),
      loadCanopyCloudAccount: jest.fn().mockRejectedValue(new Error('offline')),
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    await Promise.resolve();
    root.render(<MemoryTab />);
  });
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="org-memory-enabled-toggle"]',
  );
  expect(toggle?.disabled).toBe(true);
  expect(toggle?.getAttribute('aria-checked')).toBe('false');
  await act(async () => {
    await Promise.resolve();
    root.unmount();
  });
});

describe('organization memory copy names the eligible organizations (CAN-3457)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ORG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const organizations = [
    { id: ORG_A, name: 'Acme' },
    { id: ORG_B, name: 'Beta' },
    { id: ORG_C, name: 'Lapsed Co' },
  ];

  async function renderDescription(
    account: Record<string, unknown>,
  ): Promise<string | null | undefined> {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue(makeTestPreferences()),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue(account),
        onPreferencesChanged: jest.fn((): (() => void) => (): void => {}),
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      await Promise.resolve();
      root.render(<MemoryTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const text = container.querySelector(
      '[data-testid="org-memory-organization-names"]',
    )?.textContent;
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });
    return text;
  }

  test('names a single eligible organization', async () => {
    await expect(
      renderDescription({
        capabilities: ['memorySearch'],
        memorySearchOrganizationExternalIds: [ORG_A],
        organizations,
      }),
    ).resolves.toBe(
      "Add relevant knowledge from past sessions to chats in Acme's projects",
    );
  });

  test('joins several eligible organizations and skips ineligible ones', async () => {
    const text = await renderDescription({
      capabilities: ['memorySearch'],
      memorySearchOrganizationExternalIds: [ORG_A, ORG_B],
      organizations,
    });
    expect(text).toContain('projects owned by Acme and Beta');
    expect(text).not.toContain('Lapsed Co');
  });

  test('reads the deprecated single-org field from an older account state', async () => {
    await expect(
      renderDescription({
        capabilities: ['memorySearch'],
        memorySearchOrganizationExternalId: ORG_B,
        organizations,
      }),
    ).resolves.toBe(
      "Add relevant knowledge from past sessions to chats in Beta's projects",
    );
  });

  test('keeps generic copy when memory is unavailable', async () => {
    await expect(
      renderDescription({
        capabilities: [],
        memorySearchOrganizationExternalIds: [ORG_A],
        organizations,
      }),
    ).resolves.toBe(
      'Add relevant knowledge from past sessions to chats in organization projects',
    );
  });
});

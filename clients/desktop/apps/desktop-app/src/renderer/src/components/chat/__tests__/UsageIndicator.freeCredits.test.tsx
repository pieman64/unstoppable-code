/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import type { ChatTabUsage } from '@canopy/desktop-shared/types';
import { initCodexModels } from '@canopy/desktop-shared/types';
import { UsageIndicator } from '../UsageIndicator';
import { useObservabilityStore } from '@/stores/observabilityStore';
import type { ComposerAiCreditsBalance } from '@/hooks/useComposerAiCreditsBalance';

let mockBalance: number | null = null;
let mockPending = false;
jest.mock('@/hooks/useComposerAiCreditsBalance', () => ({
  useComposerAiCreditsBalance: (): ComposerAiCreditsBalance => ({
    credits: mockBalance,
    pending: mockPending,
  }),
}));

let mockAccess: ModelLibraryAccess | undefined;
const mockAccessCalls: Array<{ scope: unknown; enabled: boolean }> = [];
jest.mock('@/hooks/useModelLibraryAccess', () => ({
  useWorkModelLibraryAccess: (
    scope: unknown,
    enabled = true,
  ): ModelLibraryAccess | undefined => {
    mockAccessCalls.push({ scope, enabled });
    return enabled ? mockAccess : undefined;
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const USAGE: ChatTabUsage = {
  contextTokens: 64_000,
  contextWindow: 200_000,
  maxOutputTokens: 0,
  totalCostUsd: 0,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 0,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 1,
  model: 'gpt-6-sol',
};

const TARGET = { projectId: 'p1', worktreeId: 'w1', chatId: 'c1' };

describe('UsageIndicator Free AI Credits label (CAN-5028)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    initCodexModels([
      { id: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 400_000 },
    ]);
  });

  beforeEach(() => {
    mockBalance = null;
    mockPending = false;
    mockAccess = undefined;
    mockAccessCalls.length = 0;
    useObservabilityStore.setState({
      initialized: true,
      usage: { updatedAt: '2026-10-27T00:00:00Z', providers: [] },
      refreshingProviders: new Set(),
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    creditTarget: typeof TARGET | undefined = TARGET,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <UsageIndicator
          usage={USAGE}
          isCodex
          model="gpt-6-sol"
          creditTarget={creditTarget}
          aiCreditsBilled
        />,
      );
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  function triggerName(): string | null | undefined {
    return container
      .querySelector('[data-testid="usage-indicator"]')
      ?.getAttribute('aria-label');
  }

  it('reads the chat work owner and labels a pre-purchase balance', async () => {
    mockBalance = 3.2;
    mockAccess = 'needs_purchase';
    await render();
    expect(triggerName()).toBe('Usage indicator, 3.2 Free AI Credits');
    expect(mockAccessCalls.at(-1)).toEqual({
      scope: { kind: 'work', projectId: 'p1', worktreeId: 'w1', chatId: 'c1' },
      enabled: true,
    });
  });

  it('switches to the plain label once access unlocks', async () => {
    mockBalance = 3.2;
    mockAccess = 'needs_purchase';
    await render();
    mockAccess = 'unlocked';
    await render();
    expect(triggerName()).toBe('Usage indicator, 3.2 AI Credits');
  });

  it('keeps the plain label while access is unknown', async () => {
    mockBalance = 0;
    await render();
    expect(triggerName()).toBe('Usage indicator, 0 AI Credits');
  });

  it('issues no access read without a balance to label', async () => {
    mockAccess = 'needs_purchase';
    await render(undefined);
    expect(triggerName()).toBe('Usage indicator');
    expect(mockAccessCalls.every((call) => !call.enabled)).toBe(true);
  });

  it('keeps access enabled through a pending refresh and restores the label', async () => {
    mockBalance = 3.2;
    mockAccess = 'needs_purchase';
    await render();
    expect(triggerName()).toBe('Usage indicator, 3.2 Free AI Credits');

    mockBalance = null;
    mockPending = true;
    await render();
    expect(triggerName()).toBe('Usage indicator');
    expect(mockAccessCalls.at(-1)?.enabled).toBe(true);
    expect(
      container
        .querySelector('[data-testid="usage-indicator"]')
        ?.getAttribute('aria-busy'),
    ).toBe('true');

    mockBalance = 1200;
    mockPending = false;
    await render();
    expect(triggerName()).toBe('Usage indicator, 1,200 Free AI Credits');
  });
});

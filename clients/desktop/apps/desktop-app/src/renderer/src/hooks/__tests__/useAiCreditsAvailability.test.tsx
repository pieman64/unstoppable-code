/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  invalidateAiCreditsAvailabilityCache,
  useAiCreditsAvailability,
} from '../useAiCreditsAvailability';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const loadNativeAiCreditsAvailability = jest.fn();

function Probe(): JSX.Element {
  const availability = useAiCreditsAvailability();
  return <span data-testid="probe">{String(availability.inconclusive)}</span>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountProbe(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(<Probe />);
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  loadNativeAiCreditsAvailability.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { loadNativeAiCreditsAvailability },
  });
  invalidateAiCreditsAvailabilityCache();
});

afterEach(() => {
  const mounted = root;
  const mountedContainer = container;
  if (mounted) act(() => mounted.unmount());
  if (mountedContainer) mountedContainer.remove();
  root = null;
  container = null;
  invalidateAiCreditsAvailabilityCache();
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** Advance timers and flush the microtask queue the read resolves through. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('useAiCreditsAvailability inconclusive recovery (round-2 finding 14)', () => {
  it('backs the retry off instead of polling forever at 10s', async () => {
    // A permanently offline but signed-in user otherwise generated a balance
    // call plus one call per organization every ten seconds for the whole
    // session, with no backoff and no ceiling.
    loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));

    await mountProbe();
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(1);

    // First retry at 10s.
    await advance(10_000);
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);

    // Second retry has backed off to 30s: 10s more is not enough.
    await advance(10_000);
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);
    await advance(20_000);
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(3);

    // Third and every subsequent retry is capped at the ordinary cache TTL.
    await advance(30_000);
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(3);
    await advance(30_000);
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(4);
  });

  it('restores the fast cadence after a conclusive read', async () => {
    loadNativeAiCreditsAvailability.mockRejectedValueOnce(new Error('offline'));
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
    });

    await mountProbe();
    await advance(10_000);
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);

    // The conclusive read resets the counter, so a LATER inconclusive read
    // starts again at 10s rather than inheriting the previous backoff.
    loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));
    invalidateAiCreditsAvailabilityCache();
    await advance(0);
    const afterInvalidate = loadNativeAiCreditsAvailability.mock.calls.length;
    await advance(10_000);
    expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(
      afterInvalidate + 1,
    );
  });
});

describe('useAiCreditsAvailability owner scoping (CAN-3463)', () => {
  const SCOPE_A: AiCreditsScopeRequest = {
    kind: 'work',
    projectId: 'proj-a',
    worktreeId: 'wt-a',
    chatId: 'chat-a',
  };
  const SCOPE_B: AiCreditsScopeRequest = {
    kind: 'work',
    projectId: 'proj-b',
    worktreeId: 'wt-b',
    chatId: 'chat-b',
  };

  function ScopedProbe({
    scope,
  }: {
    scope: AiCreditsScopeRequest;
  }): JSX.Element {
    const availability = useAiCreditsAvailability(scope);
    return (
      <span data-testid="probe">
        {availability.loading ? 'loading' : String(availability.eligible)}
      </span>
    );
  }

  async function renderScoped(scope: AiCreditsScopeRequest): Promise<void> {
    if (!root) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    const mounted = root;
    await act(async () => {
      mounted.render(<ScopedProbe scope={scope} />);
      await Promise.resolve();
    });
  }

  function probeText(): string | null | undefined {
    return container?.querySelector('[data-testid="probe"]')?.textContent;
  }

  afterEach(() => {
    useWorkspaceContextStore.setState((store) => ({
      state: { ...store.state, context: { kind: 'personal' } },
    }));
  });

  it('asks main about the owner scope it was given', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: false,
      orgSpendable: true,
    });

    await renderScoped(SCOPE_A);

    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledWith(SCOPE_A);
    expect(probeText()).toBe('true');
  });

  it('never shows one owner’s answer for another', async () => {
    // Org A funds chat A; org B is empty, so chat B cannot pay.
    loadNativeAiCreditsAvailability.mockImplementation(
      (scope?: AiCreditsScopeRequest) => {
        const funded = scope?.kind === 'work' && scope.projectId === 'proj-a';
        return Promise.resolve({
          personalEligible: false,
          orgSpendable: funded,
        });
      },
    );

    await renderScoped(SCOPE_A);
    expect(probeText()).toBe('true');

    let pendingResolve: ((value: unknown) => void) | undefined;
    loadNativeAiCreditsAvailability.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pendingResolve = resolve;
        }),
    );
    await renderScoped(SCOPE_B);
    // B's read is still in flight: A's `true` must not stand in for it.
    expect(probeText()).toBe('loading');

    await act(async () => {
      pendingResolve?.({ personalEligible: false, orgSpendable: false });
      await Promise.resolve();
    });
    expect(probeText()).toBe('false');

    // Switching back reuses A's cached answer without another read.
    const calls = loadNativeAiCreditsAvailability.mock.calls.length;
    await renderScoped(SCOPE_A);
    expect(probeText()).toBe('true');
    expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(calls);
  });

  it('re-reads when the navigation context changes', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      personalEligible: true,
      orgSpendable: false,
    });
    await renderScoped(SCOPE_A);
    const calls = loadNativeAiCreditsAvailability.mock.calls.length;

    await act(async () => {
      useWorkspaceContextStore.setState((store) => ({
        state: {
          ...store.state,
          context: {
            kind: 'organization',
            organizationId: '11111111-1111-4111-8111-111111111111',
          },
        },
      }));
      await Promise.resolve();
    });

    expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(calls + 1);
  });
});

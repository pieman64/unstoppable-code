/**
 * @jest-environment jsdom
 *
 * Composer AI Credits balance (CAN-4921): shown only for a credit-routed chat
 * whose work is explicitly Personal, including a chat outside any project,
 * and re-read after each charged turn so the figure follows the wallet.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCloudAiCreditsState } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  cancelAiCreditsSettlementRefreshForTests,
  invalidateAiCreditsUsageCache,
} from '@/hooks/useAiCreditsUsage';
import {
  personalWalletCredits,
  useComposerAiCreditsBalance,
  type ComposerAiCreditsTarget,
} from '@/hooks/useComposerAiCreditsBalance';

interface MockProject {
  id: string;
  owner?: { organizationId: string };
}

let mockProjects: MockProject[] = [];
let mockContext: { hydrated: boolean; state: { context: WorkspaceContext } } = {
  hydrated: true,
  state: { context: { kind: 'personal' } },
};

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: <T,>(
    selector: (state: { projects: MockProject[] }) => T,
  ): T => selector({ projects: mockProjects }),
}));

jest.mock('@/stores/workspaceContextStore', () => {
  const useWorkspaceContextStore = <T,>(
    selector: (state: typeof mockContext) => T,
  ): T => selector(mockContext);
  useWorkspaceContextStore.getState = (): typeof mockContext => mockContext;
  return { useWorkspaceContextStore };
});

const loadCanopyCloudAiCredits = jest.fn<
  Promise<CanopyCloudAiCreditsState>,
  [unknown]
>();

function walletState(
  credits: number,
  overrides: Partial<CanopyCloudAiCreditsState> = {},
): CanopyCloudAiCreditsState {
  return {
    connected: true,
    email: 'guest@example.test',
    subscription: null,
    balance: {
      email: 'guest@example.test',
      credits,
      eligible: credits > 0,
      source: 'canopy',
    },
    noUdAccount: false,
    error: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const results = new Map<string, number | null>();
const pendings = new Map<string, boolean>();
/** Every pending/credits pair each probe rendered, in order. */
const history = new Map<string, Array<[number | null, boolean]>>();

function Probe({
  id,
  target,
  routed,
  billed,
  turnActive,
}: {
  id: string;
  target: ComposerAiCreditsTarget;
  routed: boolean;
  billed: boolean;
  turnActive: boolean;
}): JSX.Element | null {
  const balance = useComposerAiCreditsBalance({
    target,
    aiCreditsRouted: routed,
    aiCreditsBilled: billed,
    turnActive,
  });
  results.set(id, balance.credits);
  pendings.set(id, balance.pending);
  history.set(id, [
    ...(history.get(id) ?? []),
    [balance.credits, balance.pending],
  ]);
  return null;
}

interface ProbeProps {
  target?: ComposerAiCreditsTarget;
  routed?: boolean;
  billed?: boolean;
  turnActive?: boolean;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(
  probes: Record<string, ProbeProps> = { a: {} },
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        Object.entries(probes).map(([id, props]) =>
          createElement(Probe, {
            key: id,
            id,
            target: props.target ?? { chatId: 'chat-1' },
            routed: props.routed ?? true,
            billed: props.billed ?? props.routed ?? true,
            turnActive: props.turnActive ?? false,
          }),
        ),
      ),
    );
    await Promise.resolve();
  });
  await flush();
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockProjects = [];
  mockContext = { hydrated: true, state: { context: { kind: 'personal' } } };
  results.clear();
  pendings.clear();
  history.clear();
  loadCanopyCloudAiCredits.mockReset();
  loadCanopyCloudAiCredits.mockResolvedValue(walletState(10));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAiCredits,
      loadPreferences: jest.fn(() =>
        Promise.resolve({ aiCreditsRoutingMode: 'off' }),
      ),
    },
  });
  invalidateAiCreditsUsageCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  cancelAiCreditsSettlementRefreshForTests();
  jest.useRealTimers();
});

describe('useComposerAiCreditsBalance', () => {
  it('hides the balance once the selected model bills a provider subscription', async () => {
    // The session's last turn ran on AI Credits, but the chat now bills its
    // next turn to the user's own subscription.
    await render({ a: { routed: true, billed: false } });
    expect(results.get('a')).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();

    // Switching back to a credit-billed model shows it again.
    await render({ a: { routed: true, billed: true } });
    expect(results.get('a')).toBe(10);
  });

  it('shows a no-project Personal chat its balance and follows two charged turns', async () => {
    loadCanopyCloudAiCredits
      .mockResolvedValueOnce(walletState(10))
      .mockResolvedValue(walletState(7.5));
    await render({ a: {} });
    expect(results.get('a')).toBe(10);
    // Read through the navigation scope: no project or worktree is needed.
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledWith(undefined);

    await render({ a: { turnActive: true } });
    await render({ a: { turnActive: false } });
    await advance(4_000);
    expect(results.get('a')).toBe(7.5);

    loadCanopyCloudAiCredits.mockResolvedValue(walletState(0));
    await render({ a: { turnActive: true } });
    await render({ a: { turnActive: false } });
    await advance(4_000);
    // Zero is a known balance and still shows.
    expect(results.get('a')).toBe(0);
  });

  it('hides the old wallet immediately on account change while the next read is pending', async () => {
    await render();
    expect(results.get('a')).toBe(10);
    let resolveRead: (value: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(results.get('a')).toBeNull();
    await act(async () => {
      resolveRead(walletState(3));
      await Promise.resolve();
    });
    await flush();
    expect(results.get('a')).toBe(3);
  });

  it('rejects a late wallet response from the previous account', async () => {
    let resolveOld: (value: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    await render();
    expect(results.get('a')).toBeNull();
    loadCanopyCloudAiCredits.mockResolvedValue(walletState(3));
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(results.get('a')).toBe(3);
    await act(async () => {
      resolveOld(walletState(99));
      await Promise.resolve();
    });
    await flush();
    expect(results.get('a')).toBe(3);
  });

  it('deduplicates reads for different chats sharing the personal wallet', async () => {
    mockProjects = [{ id: 'personal-project' }];
    await render({
      a: {},
      b: {
        target: {
          projectId: 'personal-project',
          worktreeId: 'w',
          chatId: 'other',
        },
      },
    });
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
  });

  it('catches a charge that settles after the turn ends', async () => {
    await render({ a: {} });
    expect(results.get('a')).toBe(10);
    await render({ a: { turnActive: true } });
    await render({ a: { turnActive: false } });
    // The first read still sees the unsettled wallet.
    expect(results.get('a')).toBe(10);
    loadCanopyCloudAiCredits.mockResolvedValue(walletState(8));
    await advance(1_500);
    expect(results.get('a')).toBe(8);
  });

  it('counts a turn that fell back to AI Credits after it started', async () => {
    await render({ a: { routed: false } });
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
    await render({ a: { routed: false, turnActive: true } });
    await render({ a: { routed: true, turnActive: true } });
    loadCanopyCloudAiCredits.mockClear();
    await render({ a: { routed: true, turnActive: false } });
    await advance(4_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalled();
  });

  it('shares one read schedule between composers of the same chat', async () => {
    await render({ a: {}, b: {} });
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
    loadCanopyCloudAiCredits.mockClear();
    await render({ a: { turnActive: true }, b: { turnActive: true } });
    await render({ a: { turnActive: false }, b: { turnActive: false } });
    await advance(0);
    await advance(1_500);
    await advance(2_500);
    // One read per scheduled refresh, not one per composer or completion.
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(3);
    expect(results.get('a')).toBe(results.get('b'));
  });

  it('shows nothing for a subscription-routed chat and reads nothing', async () => {
    await render({ a: { routed: false } });
    expect(results.get('a')).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });

  it('shows nothing for a no-project chat in an organization context', async () => {
    mockContext = {
      hydrated: true,
      state: {
        context: {
          kind: 'organization',
          organizationId: '11111111-1111-4111-8111-111111111111',
        },
      },
    };
    await render({ a: {} });
    expect(results.get('a')).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });

  it('shows nothing before the navigation context is known', async () => {
    mockContext = { hydrated: false, state: { context: { kind: 'personal' } } };
    await render({ a: {} });
    expect(results.get('a')).toBeNull();
  });

  it('shows a Personal project its balance but not an organization project', async () => {
    mockProjects = [
      { id: 'personal-project' },
      {
        id: 'org-project',
        owner: { organizationId: '11111111-1111-4111-8111-111111111111' },
      },
    ];
    await render({
      personal: {
        target: { projectId: 'personal-project', worktreeId: 'w', chatId: 'c' },
      },
      org: {
        target: { projectId: 'org-project', worktreeId: 'w', chatId: 'c' },
      },
      unknown: {
        target: { projectId: 'not-listed', worktreeId: 'w', chatId: 'c' },
      },
    });
    expect(results.get('personal')).toBe(10);
    expect(results.get('org')).toBeNull();
    expect(results.get('unknown')).toBeNull();
  });

  it('suppresses a balance the server attributes to an organization pool', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...walletState(0),
      balance: {
        email: 'guest@example.test',
        credits: 0,
        eligible: false,
        source: 'canopy',
        orgPool: {
          orgId: '11111111-1111-4111-8111-111111111111',
          orgName: 'Acme',
        },
      },
    });
    await render({ a: {} });
    expect(results.get('a')).toBeNull();
  });

  it('hides an unverifiable balance after a failed refresh, then recovers', async () => {
    await render({ a: {} });
    expect(results.get('a')).toBe(10);
    loadCanopyCloudAiCredits.mockResolvedValue(
      walletState(10, { error: 'network', balance: null }),
    );
    await render({ a: { turnActive: true } });
    await render({ a: { turnActive: false } });
    await advance(0);
    expect(results.get('a')).toBeNull();
    loadCanopyCloudAiCredits.mockResolvedValue(walletState(6));
    await advance(4_000);
    expect(results.get('a')).toBe(6);
  });
});

describe('a balance withdrawn by a same-account re-read (CAN-5026)', () => {
  function sameAccountRefresh(): void {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
          detail: { reason: 'same-account-refresh' },
        }),
      );
    });
  }

  function identityChange(): void {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
          detail: { reason: 'identity' },
        }),
      );
    });
  }

  /** The next read waits for the test to answer it. */
  function deferRead(): (value: CanopyCloudAiCreditsState) => Promise<void> {
    let resolveRead: (value: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    return async (value): Promise<void> => {
      await act(async () => {
        resolveRead(value);
        await Promise.resolve();
      });
      await flush();
    };
  }

  it('holds the slot from 3.2 until the re-read reports 1,200', async () => {
    loadCanopyCloudAiCredits.mockResolvedValueOnce(walletState(3.2));
    await render();
    expect(results.get('a')).toBe(3.2);
    expect(pendings.get('a')).toBe(false);

    const answer = deferRead();
    sameAccountRefresh();
    await flush();
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(true);

    await answer(walletState(1200));
    expect(results.get('a')).toBe(1200);
    expect(pendings.get('a')).toBe(false);
    // The withdrawn figure never came back while the read ran.
    const seen = history.get('a') ?? [];
    const firstPending = seen.findIndex(([, pending]) => pending);
    expect(seen.slice(firstPending).some(([credits]) => credits === 3.2)).toBe(
      false,
    );
  });

  it('shows no placeholder on a first load', async () => {
    const answer = deferRead();
    await render();
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);
    await answer(walletState(4));
    expect(results.get('a')).toBe(4);
    expect(history.get('a')?.some(([, pending]) => pending)).toBe(false);
  });

  it('keeps the figure through a post-turn settlement', async () => {
    await render();
    loadCanopyCloudAiCredits.mockResolvedValue(walletState(8));
    await render({ a: { turnActive: true } });
    await render({ a: { turnActive: false } });
    await advance(4_000);
    expect(results.get('a')).toBe(8);
    expect(history.get('a')?.some(([, pending]) => pending)).toBe(false);
  });

  it('counts a zero balance as shown', async () => {
    loadCanopyCloudAiCredits.mockResolvedValueOnce(walletState(0));
    await render();
    expect(results.get('a')).toBe(0);
    const answer = deferRead();
    sameAccountRefresh();
    await flush();
    expect(pendings.get('a')).toBe(true);
    await answer(walletState(1200));
    expect(results.get('a')).toBe(1200);
  });

  it('holds no slot after an identity change with the same chat', async () => {
    await render();
    deferRead();
    identityChange();
    await flush();
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);
  });

  it('drops the slot when an identity change lands mid-refresh', async () => {
    await render();
    deferRead();
    sameAccountRefresh();
    await flush();
    expect(pendings.get('a')).toBe(true);
    deferRead();
    identityChange();
    await flush();
    expect(pendings.get('a')).toBe(false);
  });

  it('holds no slot for another chat', async () => {
    await render();
    deferRead();
    sameAccountRefresh();
    await render({ a: { target: { chatId: 'chat-2' } } });
    expect(pendings.get('a')).toBe(false);
  });

  it('does not reuse a withdrawn wallet read from the previous chat', async () => {
    await render();
    const oldChat = deferRead();
    sameAccountRefresh();
    await flush();
    const newChat = deferRead();
    await render({ a: { target: { chatId: 'chat-2' } } });
    await oldChat(walletState(3.2));
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);
    await newChat(walletState(1200));
    expect(results.get('a')).toBe(1200);
  });

  it('ends the slot when the work stops being eligible mid-refresh', async () => {
    await render();
    deferRead();
    sameAccountRefresh();
    await flush();
    expect(pendings.get('a')).toBe(true);
    mockContext = {
      hydrated: true,
      state: { context: { kind: 'organization', organizationId: 'org-1' } },
    };
    await render();
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);
    // Back to Personal: the earlier figure no longer holds a slot.
    mockContext = { hydrated: true, state: { context: { kind: 'personal' } } };
    deferRead();
    sameAccountRefresh();
    await render();
    expect(pendings.get('a')).toBe(false);
  });

  it('ends the slot when billing moves to a subscription mid-refresh', async () => {
    await render();
    deferRead();
    sameAccountRefresh();
    await flush();
    await render({ a: { billed: false } });
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);
  });

  it('ends the slot on sign-out', async () => {
    await render();
    deferRead();
    sameAccountRefresh();
    await flush();
    expect(pendings.get('a')).toBe(true);
    loadCanopyCloudAiCredits.mockResolvedValue(
      walletState(0, { connected: false, balance: null, email: null }),
    );
    identityChange();
    await flush();
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);
  });

  it('ends the slot on a failed or empty read, then recovers', async () => {
    await render();
    const failed = deferRead();
    sameAccountRefresh();
    await flush();
    await failed(walletState(0, { error: 'network', balance: null }));
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);

    const empty = deferRead();
    sameAccountRefresh();
    await flush();
    expect(pendings.get('a')).toBe(true);
    await empty(walletState(0, { noUdAccount: true }));
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);

    loadCanopyCloudAiCredits.mockResolvedValue(walletState(1200));
    sameAccountRefresh();
    await flush();
    expect(results.get('a')).toBe(1200);
  });

  it('ignores an older re-read that answers after a newer one', async () => {
    await render();
    const older = deferRead();
    sameAccountRefresh();
    await flush();
    const newer = deferRead();
    sameAccountRefresh();
    await flush();
    expect(pendings.get('a')).toBe(true);

    await newer(walletState(1200));
    expect(results.get('a')).toBe(1200);
    await older(walletState(3.2));
    expect(results.get('a')).toBe(1200);
    expect(pendings.get('a')).toBe(false);
  });

  it('ends pending after a rejected IPC read and can recover', async () => {
    await render();
    loadCanopyCloudAiCredits.mockRejectedValueOnce(new Error('disconnected'));
    sameAccountRefresh();
    await flush();
    expect(results.get('a')).toBeNull();
    expect(pendings.get('a')).toBe(false);
    loadCanopyCloudAiCredits.mockResolvedValueOnce(walletState(1200));
    sameAccountRefresh();
    await flush();
    expect(results.get('a')).toBe(1200);
  });

  it('ignores the old account response after the new account resolves in the same chat', async () => {
    await render();
    const oldAccount = deferRead();
    sameAccountRefresh();
    await flush();
    const newAccount = deferRead();
    identityChange();
    await flush();
    expect(pendings.get('a')).toBe(false);
    await newAccount(walletState(1200, { email: 'new@example.com' }));
    await oldAccount(walletState(3.2));
    expect(results.get('a')).toBe(1200);
    expect(pendings.get('a')).toBe(false);
  });
});

describe('personalWalletCredits', () => {
  it.each<[string, CanopyCloudAiCreditsState | null, number | null]>([
    ['no read', null, null],
    ['disconnected', walletState(5, { connected: false }), null],
    ['no wallet', walletState(5, { noUdAccount: true }), null],
    ['a failed read', walletState(5, { error: 'offline' }), null],
    ['a fractional balance', walletState(0.4), 0.4],
    ['a zero balance', walletState(0), 0],
  ])('reads %s', (_label, state, expected) => {
    expect(personalWalletCredits(state)).toBe(expected);
  });
});

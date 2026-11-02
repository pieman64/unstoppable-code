/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import type { ChatRenderTarget, ChatTab } from '@/stores/chatStore';
import type * as TurnConfirmationModule from '@/stores/chat/turn-confirmation';
import type { CanonicalTurnConfirmation } from '@/stores/chat/turn-confirmation';
import {
  useComposerTurnActivity,
  type ComposerTurnActivityState,
} from '../useComposerTurnActivity';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface StoreEntry {
  tab: Pick<ChatTab, 'sendingLease'> | undefined;
  runtime: ChatRuntimeState | undefined;
}

let storeEntry: StoreEntry = { tab: undefined, runtime: undefined };

jest.mock('@/stores/chatStore', () => ({
  useChatTabRenderState: <U,>(
    target: ChatRenderTarget | null,
    selector: (entry: StoreEntry) => U,
  ): U =>
    selector(target ? storeEntry : { tab: undefined, runtime: undefined }),
}));

const mockConfirmCanonicalTurn = jest.fn<
  Promise<CanonicalTurnConfirmation>,
  [ChatRenderTarget]
>();

jest.mock('@/stores/chat/turn-confirmation', () => {
  const actual = jest.requireActual<typeof TurnConfirmationModule>(
    '@/stores/chat/turn-confirmation',
  );
  return {
    ...actual,
    confirmCanonicalTurn: (
      target: ChatRenderTarget,
    ): Promise<CanonicalTurnConfirmation> => mockConfirmCanonicalTurn(target),
  };
});

const TARGET: ChatRenderTarget = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

function runtime(
  status: ChatRuntimeState['status'],
  activeTurnId?: string,
): ChatRuntimeState {
  return {
    status,
    queuedMessageIds: [],
    ...(activeTurnId
      ? { activeTurn: { userMessageId: activeTurnId, startedAt: 1 } }
      : {}),
  };
}

interface Probe {
  current: ComposerTurnActivityState | null;
}

function Harness({
  probe,
  status,
}: {
  probe: Probe;
  status: ChatTab['status'] | undefined;
}): JSX.Element {
  probe.current = useComposerTurnActivity(TARGET, status);
  return <></>;
}

function mount(status: ChatTab['status'] | undefined): {
  probe: Probe;
  root: Root;
  rerender: (next: ChatTab['status'] | undefined) => void;
} {
  const probe: Probe = { current: null };
  const root = createRoot(document.createElement('div'));
  const rerender = (next: ChatTab['status'] | undefined): void => {
    act(() => root.render(<Harness probe={probe} status={next} />));
  };
  rerender(status);
  return { probe, root, rerender };
}

function current(probe: Probe): ComposerTurnActivityState {
  if (!probe.current) throw new Error('hook did not render');
  return probe.current;
}

describe('useComposerTurnActivity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
    storeEntry = { tab: undefined, runtime: undefined };
    mockConfirmCanonicalTurn.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('follows canonical runtime over the tab status', () => {
    storeEntry = { tab: {}, runtime: runtime('completed') };
    const completed = mount('streaming');
    expect(current(completed.probe).activity).toBe('idle');
    act(() => completed.root.unmount());

    storeEntry = { tab: {}, runtime: runtime('streaming', 'user-1') };
    const streaming = mount('idle');
    expect(current(streaming.probe).activity).toBe('active');
    act(() => streaming.root.unmount());
  });

  it('falls back to the tab status when the chat has no runtime entry', () => {
    storeEntry = { tab: {}, runtime: undefined };
    const { probe, root, rerender } = mount('streaming');
    expect(current(probe).activity).toBe('active');
    rerender('idle');
    expect(current(probe).activity).toBe('idle');
    act(() => root.unmount());
  });

  it('shows a pending sending lease until its deadline, then re-renders idle', () => {
    const now = Date.now();
    storeEntry = {
      tab: {
        sendingLease: {
          userMessageId: 'user-1',
          kind: 'send',
          issuedAt: now,
          deadline: now + 15_000,
          state: 'pending',
        },
      },
      runtime: runtime('idle'),
    };
    const { probe, root } = mount('idle');
    expect(current(probe).activity).toBe('sending');

    act(() => {
      jest.advanceTimersByTime(14_999);
    });
    expect(current(probe).activity).toBe('sending');

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(current(probe).activity).toBe('idle');
    act(() => root.unmount());
  });

  it('ignores an acknowledged or expired lease', () => {
    const now = Date.now();
    storeEntry = {
      tab: {
        sendingLease: {
          userMessageId: 'user-1',
          kind: 'send',
          issuedAt: now,
          deadline: now + 15_000,
          state: 'acknowledged',
        },
      },
      runtime: runtime('completed'),
    };
    const { probe, root } = mount('idle');
    expect(current(probe).activity).toBe('idle');
    act(() => root.unmount());
  });

  it('confirms the turn with an awaited canonical read for this chat', async () => {
    storeEntry = { tab: {}, runtime: runtime('streaming', 'user-1') };
    mockConfirmCanonicalTurn.mockResolvedValue({ state: 'inactive' });
    const { probe, root } = mount('streaming');

    await expect(current(probe).confirmTurn()).resolves.toEqual({
      state: 'inactive',
    });
    expect(mockConfirmCanonicalTurn).toHaveBeenCalledWith(TARGET);
    act(() => root.unmount());
  });

  describe('confirmStuckTurn', () => {
    it.each<[string, CanonicalTurnConfirmation, boolean]>([
      [
        'active for the same turn',
        { state: 'active', userMessageId: 'user-1', revision: 3 },
        true,
      ],
      ['active without a turn id', { state: 'active', revision: 3 }, true],
      [
        'active for another turn',
        { state: 'active', userMessageId: 'user-2', revision: 3 },
        false,
      ],
      ['inactive', { state: 'inactive', revision: 3 }, false],
      ['unknown', { state: 'unknown' }, false],
    ])('answers %s', async (_label, confirmation, expected) => {
      storeEntry = { tab: {}, runtime: runtime('streaming', 'user-1') };
      mockConfirmCanonicalTurn.mockResolvedValue(confirmation);
      const { probe, root } = mount('streaming');

      await expect(current(probe).confirmStuckTurn()).resolves.toBe(expected);
      act(() => root.unmount());
    });

    it('accepts any active turn when the renderer knows none', async () => {
      storeEntry = { tab: {}, runtime: undefined };
      mockConfirmCanonicalTurn.mockResolvedValue({
        state: 'active',
        userMessageId: 'user-9',
        revision: 1,
      });
      const { probe, root } = mount('streaming');

      await expect(current(probe).confirmStuckTurn()).resolves.toBe(true);
      act(() => root.unmount());
    });

    it('answers false when the read rejects', async () => {
      storeEntry = { tab: {}, runtime: runtime('streaming', 'user-1') };
      mockConfirmCanonicalTurn.mockRejectedValue(new Error('read failed'));
      const { probe, root } = mount('streaming');

      await expect(current(probe).confirmStuckTurn()).resolves.toBe(false);
      act(() => root.unmount());
    });
  });
});

import { useTransientRetryBannerStore } from '../transientRetryBannerStore';
import { chatBannerKey, type ChatBannerTarget } from '../aiCreditsBannerStore';
import {
  TRANSIENT_RETRY_STATE_EVENT_TYPE,
  type TransientRetryStateEventData,
} from '@canopy/desktop-shared/types';

const TARGET: ChatBannerTarget = {
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
};

const OTHER_TARGET: ChatBannerTarget = {
  projectId: 'p2',
  worktreeId: 'w2',
  chatId: 'c2',
};

function event(
  overrides: Partial<TransientRetryStateEventData> = {},
): TransientRetryStateEventData {
  return {
    type: TRANSIENT_RETRY_STATE_EVENT_TYPE,
    provider: 'claude',
    active: true,
    attempt: 1,
    maxAttempts: 5,
    nextRetryAt: 1000,
    exhausted: false,
    ...overrides,
  };
}

describe('transientRetryBannerStore', () => {
  beforeEach(() => {
    useTransientRetryBannerStore.setState({ stateByChat: {} });
  });

  it('stores an active retry state keyed by the full chat target', () => {
    useTransientRetryBannerStore
      .getState()
      .setState(TARGET, event({ attempt: 2, nextRetryAt: 4000 }));
    expect(
      useTransientRetryBannerStore.getState().stateByChat['p/w/c'],
    ).toEqual({
      provider: 'claude',
      attempt: 2,
      maxAttempts: 5,
      nextRetryAt: 4000,
      exhausted: false,
    });
  });

  it('replaces the stored state on a newer push', () => {
    useTransientRetryBannerStore.getState().setState(TARGET, event());
    useTransientRetryBannerStore
      .getState()
      .setState(
        TARGET,
        event({ attempt: 3, nextRetryAt: null, exhausted: true }),
      );
    expect(
      useTransientRetryBannerStore.getState().stateByChat['p/w/c'],
    ).toEqual({
      provider: 'claude',
      attempt: 3,
      maxAttempts: 5,
      nextRetryAt: null,
      exhausted: true,
    });
  });

  it('deletes the entry when a push is inactive', () => {
    useTransientRetryBannerStore.getState().setState(TARGET, event());
    useTransientRetryBannerStore
      .getState()
      .setState(TARGET, event({ active: false }));
    expect('p/w/c' in useTransientRetryBannerStore.getState().stateByChat).toBe(
      false,
    );
  });

  it('drops the entry on clearForChat', () => {
    useTransientRetryBannerStore.getState().setState(TARGET, event());
    useTransientRetryBannerStore.getState().clearForChat(TARGET);
    expect(
      chatBannerKey(TARGET) in
        useTransientRetryBannerStore.getState().stateByChat,
    ).toBe(false);
  });

  it('keeps targets independent', () => {
    useTransientRetryBannerStore.getState().setState(TARGET, event());
    useTransientRetryBannerStore
      .getState()
      .setState(OTHER_TARGET, event({ active: false }));
    expect(
      useTransientRetryBannerStore.getState().stateByChat['p/w/c'],
    ).toBeDefined();

    useTransientRetryBannerStore.getState().clearForChat(OTHER_TARGET);
    expect(
      useTransientRetryBannerStore.getState().stateByChat['p/w/c'],
    ).toBeDefined();
  });
});

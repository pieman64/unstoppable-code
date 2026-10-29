import { ChatStateSubscriptions } from '../ipc/chat-state-delivery';
import { installChatInterestE2eHook } from '../ipc/chat-interest-e2e';

function setE2eBuild(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value,
  });
}

describe('chat interest E2E inspection', () => {
  afterEach(() => {
    setE2eBuild(false);
    delete globalThis.__CANOPY_E2E_CHAT_INTEREST__;
  });

  it('is absent outside E2E builds', () => {
    setE2eBuild(false);
    const subscriptions = new ChatStateSubscriptions<{
      id: number;
      isDestroyed(): boolean;
    }>();
    const remove = installChatInterestE2eHook(subscriptions);
    expect(globalThis.__CANOPY_E2E_CHAT_INTEREST__).toBeUndefined();
    remove();
  });

  it('lists only live subscribers with interest, and removes the hook on cleanup', () => {
    setE2eBuild(true);
    const subscriptions = new ChatStateSubscriptions<{
      id: number;
      isDestroyed(): boolean;
    }>();
    const live = { id: 11, isDestroyed: (): boolean => false };
    const destroyed = { id: 12, isDestroyed: (): boolean => true };
    const undeclared = { id: 13, isDestroyed: (): boolean => false };
    const interest = {
      focused: [{ projectId: 'p', worktreeId: 'w', chatId: 'a' }],
      warm: [],
    };
    subscriptions.declareInterest(live, interest);
    subscriptions.declareInterest(destroyed, interest);
    subscriptions.declare(undeclared, 'all');
    const remove = installChatInterestE2eHook(subscriptions);
    expect(globalThis.__CANOPY_E2E_CHAT_INTEREST__?.list()).toEqual([
      { webContentsId: 11, interest },
    ]);
    subscriptions.reset(live);
    expect(globalThis.__CANOPY_E2E_CHAT_INTEREST__?.list()).toEqual([]);
    remove();
    expect(globalThis.__CANOPY_E2E_CHAT_INTEREST__).toBeUndefined();
  });
});

import type { CanonicalTurnConfirmation } from '@/stores/chat/turn-confirmation';
import { checkChatStatus } from '../check-chat-status';

function deps(confirmation: CanonicalTurnConfirmation | Error): {
  confirmTurn: jest.Mock<Promise<CanonicalTurnConfirmation>, []>;
  verifyStreamingTabs: jest.Mock<Promise<void>, []>;
} {
  return {
    confirmTurn: jest.fn(() =>
      confirmation instanceof Error
        ? Promise.reject(confirmation)
        : Promise.resolve(confirmation),
    ),
    verifyStreamingTabs: jest.fn(() => Promise.resolve()),
  };
}

describe('checkChatStatus', () => {
  it('reports running from a fresh active read', async () => {
    const check = deps({
      state: 'active',
      userMessageId: 'user-1',
      revision: 4,
    });

    await expect(checkChatStatus(check)).resolves.toBe('running');
    expect(check.confirmTurn).toHaveBeenCalledTimes(1);
    expect(check.verifyStreamingTabs).not.toHaveBeenCalled();
  });

  // The renderer may still show the turn streaming; the fresh read decides,
  // and verification then settles the tab.
  it('reports settled from a fresh inactive read and settles the tab', async () => {
    const check = deps({ state: 'inactive', revision: 4 });

    await expect(checkChatStatus(check)).resolves.toBe('settled');
    expect(check.verifyStreamingTabs).toHaveBeenCalledTimes(1);
  });

  it('still reports settled when the follow-up verification fails', async () => {
    const check = deps({ state: 'inactive', revision: 4 });
    check.verifyStreamingTabs.mockRejectedValue(new Error('offline'));

    await expect(checkChatStatus(check)).resolves.toBe('settled');
  });

  // A rejection makes the notice show "Couldn't check the agent's status."
  it('rejects when the read cannot answer', async () => {
    const check = deps({ state: 'unknown' });

    await expect(checkChatStatus(check)).rejects.toThrow();
    expect(check.verifyStreamingTabs).not.toHaveBeenCalled();
  });

  it('rejects when the read itself fails', async () => {
    const check = deps(new Error('ipc failed'));

    await expect(checkChatStatus(check)).rejects.toThrow('ipc failed');
  });
});

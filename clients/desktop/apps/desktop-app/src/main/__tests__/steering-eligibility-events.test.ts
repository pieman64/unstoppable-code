const mockLogMainProcessWarn = jest.fn();

jest.mock('../lib/main-process-logging', () => ({
  get logMainProcessWarn(): typeof mockLogMainProcessWarn {
    return mockLogMainProcessWarn;
  },
}));

import {
  notifySteeringEligibilityChanged,
  subscribeSteeringEligibility,
} from '../agents/steering-eligibility-events';

describe('steering eligibility events', () => {
  beforeEach(() => {
    mockLogMainProcessWarn.mockClear();
  });

  it('delivers the session key and stops delivery after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSteeringEligibility(listener);

    try {
      notifySteeringEligibilityChanged('project/worktree/chat');
      unsubscribe();
      notifySteeringEligibilityChanged('project/worktree/other-chat');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('project/worktree/chat');
    } finally {
      unsubscribe();
    }
  });

  it('isolates listener failures and continues dispatch', () => {
    const error = new Error('listener failed');
    const failingListener = jest.fn(() => {
      throw error;
    });
    const succeedingListener = jest.fn();
    const unsubscribeFailing = subscribeSteeringEligibility(failingListener);
    const unsubscribeSucceeding =
      subscribeSteeringEligibility(succeedingListener);

    try {
      expect(() =>
        notifySteeringEligibilityChanged('project/worktree/chat'),
      ).not.toThrow();
      expect(succeedingListener).toHaveBeenCalledWith('project/worktree/chat');
      expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
        '[steering-eligibility] A listener failed for a chat session:',
        error,
      );
    } finally {
      unsubscribeFailing();
      unsubscribeSucceeding();
    }
  });

  it('finishes the current dispatch when a listener unsubscribes another listener', () => {
    let unsubscribeSecond = (): void => undefined;
    const firstListener = jest.fn(() => unsubscribeSecond());
    const secondListener = jest.fn();
    const unsubscribeFirst = subscribeSteeringEligibility(firstListener);
    unsubscribeSecond = subscribeSteeringEligibility(secondListener);

    try {
      notifySteeringEligibilityChanged('project/worktree/chat');
      notifySteeringEligibilityChanged('project/worktree/chat');

      expect(firstListener).toHaveBeenCalledTimes(2);
      expect(secondListener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  it('does not redeliver to a listener that unsubscribes itself during dispatch', () => {
    let unsubscribe = (): void => undefined;
    const listener = jest.fn(() => unsubscribe());
    unsubscribe = subscribeSteeringEligibility(listener);

    try {
      notifySteeringEligibilityChanged('project/worktree/chat');
      notifySteeringEligibilityChanged('project/worktree/chat');

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});

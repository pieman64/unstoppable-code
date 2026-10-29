import type { ChatEvent } from '@canopy/desktop-shared/types';
import { subscribeToChatEvents } from '../chatEventFanout';

function installChatApi(): {
  onChatEvent: jest.Mock<() => void, [(event: ChatEvent) => void]>;
  emit: (event: ChatEvent) => void;
  unsubscribe: jest.Mock;
} {
  const unsubscribe = jest.fn();
  let listener: ((event: ChatEvent) => void) | undefined;
  const onChatEvent = jest.fn((next: (event: ChatEvent) => void) => {
    listener = next;
    return unsubscribe;
  });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { api: { chat: { onChatEvent } } },
  });
  return {
    onChatEvent,
    emit: (event) => listener?.(event),
    unsubscribe,
  };
}

const event: ChatEvent = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  data: { type: 'system' },
};

describe('subscribeToChatEvents', () => {
  it('crosses the preload bridge once for every page subscriber', () => {
    const api = installChatApi();
    const first = jest.fn();
    const second = jest.fn();
    const third = jest.fn();
    const unsubscribeFirst = subscribeToChatEvents(first);
    const unsubscribeSecond = subscribeToChatEvents(second);
    const unsubscribeThird = subscribeToChatEvents(third);
    expect(api.onChatEvent).toHaveBeenCalledTimes(1);

    api.emit(event);
    unsubscribeSecond();
    api.emit(event);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledWith(event);

    unsubscribeFirst();
    expect(api.unsubscribe).not.toHaveBeenCalled();
    unsubscribeThird();
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribes to a replaced bridge on its own', () => {
    const before = installChatApi();
    const unsubscribeBefore = subscribeToChatEvents(jest.fn());
    const after = installChatApi();
    const listener = jest.fn();
    const unsubscribeAfter = subscribeToChatEvents(listener);
    after.emit(event);
    expect(before.onChatEvent).toHaveBeenCalledTimes(1);
    expect(after.onChatEvent).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribeBefore();
    unsubscribeAfter();
    expect(before.unsubscribe).toHaveBeenCalledTimes(1);
    expect(after.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

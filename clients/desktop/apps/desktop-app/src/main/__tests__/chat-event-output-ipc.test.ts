jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import {
  ChatEventOutputDelivery,
  registerChatEventOutputHandlers,
} from '../ipc/chat-event-output';

type ResetHandler = (event: unknown, epoch: unknown) => unknown;

function resetHandler(): ResetHandler {
  const calls = jest.mocked(registerIpcHandler).mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.[0] === IPC_CHANNELS.chatEventOutputReset) {
      const handler = call[1];
      return (event, epoch) => handler(event as never, epoch);
    }
  }
  throw new Error('No chat event output reset handler was registered');
}

describe('chat event output reset handler', () => {
  it('accepts a reset only from a live main frame', () => {
    const reset = jest.spyOn(ChatEventOutputDelivery.prototype, 'reset');
    const removeEncoder = registerChatEventOutputHandlers();
    try {
      const handler = resetHandler();
      const mainFrame = { id: 'main-frame' };
      const sender = { mainFrame };
      const epoch = 'a'.repeat(32);

      handler({ sender, senderFrame: mainFrame }, epoch);
      expect(reset).toHaveBeenCalledTimes(1);
      expect(reset).toHaveBeenLastCalledWith(sender, epoch);

      // A frame that navigated or was destroyed (`senderFrame` is null), and
      // a subframe, cannot reset the page's output state.
      handler({ sender, senderFrame: null }, epoch);
      handler({ sender, senderFrame: { id: 'child-frame' } }, epoch);
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      removeEncoder();
      reset.mockRestore();
    }
  });
});

import { IPC_CHANNELS, type ChatEvent } from '@canopy/desktop-shared/types';
import { recordIpcSend } from '@canopy/desktop-shared/node/work-counters';
import {
  ChatEventOutputDecoder,
  type ChatEventMessage,
} from '@canopy/desktop-shared/lib/chat-event-output';
import { ChatEventOutputDelivery } from '../ipc/chat-event-output';
import {
  addRendererDeliveryBarrier,
  observeWebContentsSends,
  redirectIpcSends,
  sendToWebContents,
  sendWrappedToWebContents,
  setRendererDeliveryFilter,
  setRendererMessageEncoder,
} from '../lib/web-contents-send';

const channel = IPC_CHANNELS.chatEvent;
jest.mock('@canopy/desktop-shared/node/work-counters', () => ({
  recordIpcSend: jest.fn(),
}));
const updated = (output: string): ChatEvent => ({
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
  data: {
    type: 'codex',
    event: {
      type: 'item.updated',
      item: {
        id: 'command',
        type: 'command_execution',
        aggregated_output: output,
      },
    },
  },
});

function isChatEventMessage(value: unknown): value is ChatEventMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    'worktreeId' in value &&
    'chatId' in value &&
    'data' in value
  );
}

describe('web contents delivery filters', () => {
  it('omits barriers, encoders, counters and page sends but retains publication observers', () => {
    const target = { send: jest.fn() };
    const barrier = jest.fn();
    const encode = jest.fn(
      (_target: object, message: unknown): unknown => message,
    );
    const observe = jest.fn();
    const removeBarrier = addRendererDeliveryBarrier(barrier);
    const removeEncoder = setRendererMessageEncoder(channel, {
      encode,
      discard: jest.fn(),
    });
    const removeObserver = observeWebContentsSends(observe);
    const removeFilter = setRendererDeliveryFilter(channel, () => true);
    const message = updated('one');
    try {
      jest.mocked(recordIpcSend).mockClear();
      sendToWebContents(target, channel, message);
      expect(target.send).not.toHaveBeenCalled();
      expect(barrier).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
      expect(recordIpcSend).not.toHaveBeenCalled();
      expect(observe).toHaveBeenCalledWith(target, channel, [message]);
    } finally {
      removeFilter();
      removeObserver();
      removeEncoder();
      removeBarrier();
    }
  });

  it('uses the final redirected target and leaves off-mode sends unchanged', () => {
    const addressed = { send: jest.fn() };
    const final = { send: jest.fn() };
    const filter = jest.fn(() => false);
    const removeRedirect = redirectIpcSends(addressed, () => final);
    const removeFilter = setRendererDeliveryFilter(channel, filter);
    const message = updated('one');
    try {
      sendToWebContents(addressed, channel, message);
      expect(filter).toHaveBeenCalledWith(final, [message]);
      expect(addressed.send).not.toHaveBeenCalled();
      expect(final.send).toHaveBeenCalledWith(channel, message);
    } finally {
      removeFilter();
      removeRedirect();
    }
  });

  it('skips wrapped sends before encoding and resumes from the last delivered output', () => {
    const sent: unknown[][] = [];
    const target = {
      send: jest.fn((_channel: string, ...args: unknown[]): void => {
        sent.push(args);
      }),
    };
    const encoder = new ChatEventOutputDelivery();
    const decoder = new ChatEventOutputDecoder({
      newEpoch: (): string => 'epoch',
      requestReset: (): Promise<void> => Promise.resolve(),
    });
    const removeEncoder = setRendererMessageEncoder(channel, {
      encode: (recipient, message) => encoder.encode(recipient, message),
      discard: (recipient, message) => encoder.discard(recipient, message),
    });
    let drop = false;
    const removeFilter = setRendererDeliveryFilter(channel, () => drop);
    try {
      sendWrappedToWebContents(target, 'envelope', channel, [updated('a')]);
      drop = true;
      sendWrappedToWebContents(target, 'envelope', channel, [updated('ab')]);
      sendWrappedToWebContents(target, 'envelope', channel, [updated('abc')]);
      drop = false;
      sendWrappedToWebContents(target, 'envelope', channel, [updated('abcd')]);
      expect(target.send).toHaveBeenCalledTimes(2);
      const first = sent[0]?.[1];
      const last = sent[1]?.[1];
      if (!Array.isArray(first) || !Array.isArray(last)) {
        throw new Error('wrapped chat event missing');
      }
      const firstMessage: unknown = first[0];
      const lastMessage: unknown = last[0];
      if (
        !isChatEventMessage(firstMessage) ||
        !isChatEventMessage(lastMessage)
      ) {
        throw new Error('invalid wrapped chat event');
      }
      expect(decoder.decode(firstMessage)).toEqual(updated('a'));
      expect(decoder.decode(lastMessage)).toEqual(updated('abcd'));
    } finally {
      removeFilter();
      removeEncoder();
    }
  });
});

import { toQueuedDispatchOptions } from '../tab-utils';
import type { SendMessageDispatchOptions } from '../types';

describe('toQueuedDispatchOptions', () => {
  it('retains the accepted input identity and public sender display metadata', () => {
    const agentSent: NonNullable<SendMessageDispatchOptions['agentSent']> = {
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'sender-project',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      },
      chatTitle: 'Sender chat',
      projectLabel: 'Sender project',
    };
    const options: SendMessageDispatchOptions = {
      acceptedInputId: 'accepted-input-42',
      hiddenContext: {
        kind: 'agent-sender-context',
        text: 'Hidden sender instructions',
      },
      agentSent,
    };

    expect(toQueuedDispatchOptions(options, false)).toEqual({
      acceptedInputId: 'accepted-input-42',
      userMessageId: 'accepted-input-42',
      hiddenContext: options.hiddenContext,
      agentSent,
    });
  });

  it('keeps the canonical message id only for main-accepted input', () => {
    // A drained queue replays these options; main matches the commit or a
    // native send to its retained request by this id.
    expect(
      toQueuedDispatchOptions(
        { acceptedInputId: 'accepted-input-7', userMessageId: 'other' },
        false,
      ),
    ).toMatchObject({
      acceptedInputId: 'accepted-input-7',
      userMessageId: 'accepted-input-7',
    });
    expect(
      toQueuedDispatchOptions({ userMessageId: 'typed-1' }, false)
        ?.userMessageId,
    ).toBeUndefined();
  });
});

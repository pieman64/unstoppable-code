import {
  clearSetupQueueScope,
  confirmSetupQueueCommittedDispatch,
  confirmSetupQueueInputDispatch,
  forgetSetupQueueInputDispatch,
  observeSetupQueueInputDispatch,
  subscribeSetupQueueDispatch,
} from '../setup-queue-dispatch';
import type { ChatStateChangedEvent } from '@canopy/desktop-shared/types';

const target = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

describe('setup input dispatch identity', () => {
  it('lets deletion in the acceptance commit win over sending', () => {
    const stop = subscribeSetupQueueDispatch(jest.fn(), target);
    const started = jest.fn();
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'cancelled',
      occurredAt: new Date(0).toISOString(),
      projectId: 'p',
      worktreeId: 'w',
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          type: 'tab.metadata_patched',
          tabId: 'c',
          patch: { lastAcceptedUserMessageId: 'input' },
        },
        { type: 'message.removed', chatId: 'c', messageId: 'input' },
      ],
    };
    try {
      observeSetupQueueInputDispatch(target, 'input', started);
      confirmSetupQueueCommittedDispatch(event, {});
      expect(started).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it.each(['streaming', 'cancelled', 'failed'] as const)(
    'uses committed acceptance identity and suppresses %s failures',
    (status) => {
      const stop = subscribeSetupQueueDispatch(jest.fn(), target);
      const started = jest.fn();
      const event: ChatStateChangedEvent = {
        schemaVersion: 1,
        eventId: 'accepted',
        occurredAt: new Date(0).toISOString(),
        projectId: 'p',
        worktreeId: 'w',
        baseRevision: 1,
        revision: 2,
        changes: [
          {
            type: 'tab.metadata_patched',
            tabId: 'c',
            patch: { lastAcceptedUserMessageId: 'input' },
          },
          {
            type: 'runtime.patched',
            chatId: 'c',
            runtime: { status, queuedMessageIds: [] },
          },
        ],
      };
      try {
        observeSetupQueueInputDispatch(target, 'input', started);
        confirmSetupQueueCommittedDispatch(event, {});
        confirmSetupQueueCommittedDispatch(event, {});
        expect(started).toHaveBeenCalledTimes(status === 'streaming' ? 1 : 0);
      } finally {
        stop();
      }
    },
  );
  it('waits for this exact input to be accepted, once', () => {
    const stop = subscribeSetupQueueDispatch(jest.fn(), target);
    const started = jest.fn();
    try {
      observeSetupQueueInputDispatch(target, 'input', started);
      expect(started).not.toHaveBeenCalled();
      confirmSetupQueueInputDispatch(target, 'other-input');
      confirmSetupQueueInputDispatch({ ...target, chatId: 'other' }, 'input');
      expect(started).not.toHaveBeenCalled();
      confirmSetupQueueInputDispatch(target, 'input');
      confirmSetupQueueInputDispatch(target, 'input');
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('forgets cancellation, failed admission and resync identities', () => {
    const stop = subscribeSetupQueueDispatch(jest.fn(), target);
    const started = jest.fn();
    try {
      observeSetupQueueInputDispatch(target, 'cancelled', started);
      forgetSetupQueueInputDispatch(target, 'cancelled');
      confirmSetupQueueInputDispatch(target, 'cancelled');
      observeSetupQueueInputDispatch(target, 'hydrated', started);
      clearSetupQueueScope('p', 'w');
      confirmSetupQueueInputDispatch(target, 'hydrated');
      expect(started).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('drops pending identities on navigation and ignores unobserved chats', () => {
    const stop = subscribeSetupQueueDispatch(jest.fn(), target);
    const started = jest.fn();
    observeSetupQueueInputDispatch(target, 'leaving', started);
    observeSetupQueueInputDispatch(
      { ...target, chatId: 'unobserved' },
      'input',
      started,
    );
    stop();
    confirmSetupQueueInputDispatch(target, 'leaving');
    confirmSetupQueueInputDispatch(
      { ...target, chatId: 'unobserved' },
      'input',
    );
    expect(started).not.toHaveBeenCalled();
  });
});

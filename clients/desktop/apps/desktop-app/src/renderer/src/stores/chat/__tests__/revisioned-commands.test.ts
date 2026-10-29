// Frontend plan Phase 4 coverage: per-command optimistic reconciliation and
// rollback, conflict classification (never auto-retried), transport-failure
// rollback, and the approved recovery copy.
import type { ChatCommandResult } from '@canopy/desktop-shared/types';
import {
  classifyChatCommandResult,
  createChatCommandEnvelope,
  mintChatCommandId,
  OptimisticCommandTracker,
} from '../revisioned-commands';
import {
  CHAT_STATE_COMMAND_FAILED_NOTICE,
  CHAT_STATE_CONFLICT_NOTICE,
  CHAT_STATE_REFRESH_ERROR_HEADING,
  CHAT_STATE_REFRESH_ERROR_HELPER,
  CHAT_STATE_REFRESH_RETRY_LABEL,
  CHAT_STATE_REFRESHING_TOAST,
} from '../revisioned-copy';

const scope = { projectId: 'proj', worktreeId: 'wt' };

function result(
  commandId: string,
  outcome: ChatCommandResult['outcome'],
): ChatCommandResult {
  return { commandId, revision: 7, outcome };
}

describe('createChatCommandEnvelope', () => {
  it('mints a fresh command id per envelope and carries the expected revision', () => {
    const first = createChatCommandEnvelope(
      scope,
      { type: 'chat.mark_read', chatId: 'c1' },
      { expectedRevision: 4 },
    );
    const second = createChatCommandEnvelope(scope, {
      type: 'chat.mark_read',
      chatId: 'c1',
    });
    expect(first.schemaVersion).toBe(1);
    expect(first.projectId).toBe('proj');
    expect(first.expectedRevision).toBe(4);
    expect(second.expectedRevision).toBeUndefined();
    expect(first.commandId).not.toBe(second.commandId);
  });

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintChatCommandId()));
    expect(ids.size).toBe(100);
  });
});

describe('classifyChatCommandResult', () => {
  it('maps outcomes onto renderer dispositions', () => {
    expect(classifyChatCommandResult(result('c', 'applied'))).toBe('accepted');
    expect(classifyChatCommandResult(result('c', 'already_applied'))).toBe(
      'accepted',
    );
    expect(classifyChatCommandResult(result('c', 'conflict'))).toBe('conflict');
    expect(classifyChatCommandResult(result('c', 'not_found'))).toBe(
      'conflict',
    );
    expect(classifyChatCommandResult(result('c', 'rejected'))).toBe('rejected');
  });
});

describe('OptimisticCommandTracker', () => {
  function entry(commandId: string): {
    commandId: string;
    projectId: string;
    worktreeId: string;
    rollback: jest.Mock;
    reconcile: jest.Mock;
  } {
    return {
      commandId,
      projectId: 'proj',
      worktreeId: 'wt',
      rollback: jest.fn(),
      reconcile: jest.fn(),
    };
  }

  it('reconciles accepted commands and clears the overlay', () => {
    const tracker = new OptimisticCommandTracker();
    const first = entry('cmd-1');
    tracker.register(first);
    const settled = tracker.settleResult(result('cmd-1', 'applied'));
    expect(settled?.disposition).toBe('accepted');
    expect(first.reconcile).toHaveBeenCalledTimes(1);
    expect(first.rollback).not.toHaveBeenCalled();
    expect(tracker.has('cmd-1')).toBe(false);
  });

  it('rolls back only the failing command overlay', () => {
    const tracker = new OptimisticCommandTracker();
    const failing = entry('cmd-fail');
    const other = entry('cmd-ok');
    tracker.register(failing);
    tracker.register(other);

    const settled = tracker.settleResult(result('cmd-fail', 'rejected'));
    expect(settled?.disposition).toBe('rejected');
    expect(failing.rollback).toHaveBeenCalledTimes(1);
    expect(other.rollback).not.toHaveBeenCalled();
    expect(tracker.has('cmd-ok')).toBe(true);
  });

  it('classifies stale destructive commands as conflicts to refresh, never retry', () => {
    const tracker = new OptimisticCommandTracker();
    const stale = entry('cmd-stale');
    tracker.register(stale);
    const settled = tracker.settleResult(result('cmd-stale', 'conflict'));
    expect(settled?.disposition).toBe('conflict');
    expect(stale.rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back on transport failure without a durable outcome', () => {
    const tracker = new OptimisticCommandTracker();
    const pending = entry('cmd-net');
    tracker.register(pending);
    const settled = tracker.settleTransportFailure('cmd-net');
    expect(settled?.disposition).toBe('transport_failed');
    expect(pending.rollback).toHaveBeenCalledTimes(1);
    expect(pending.reconcile).not.toHaveBeenCalled();
  });

  it('drops a scope wholesale (snapshot superseded) without executing rollbacks', () => {
    const tracker = new OptimisticCommandTracker();
    const mine = entry('cmd-mine');
    const other = { ...entry('cmd-other'), worktreeId: 'other-wt' };
    tracker.register(mine);
    tracker.register(other);
    tracker.dropScope('proj', 'wt');
    expect(mine.rollback).not.toHaveBeenCalled();
    expect(tracker.has('cmd-mine')).toBe(false);
    expect(tracker.has('cmd-other')).toBe(true);
  });
});

describe('recovery copy', () => {
  it('matches the approved user-facing strings exactly', () => {
    expect(CHAT_STATE_REFRESHING_TOAST).toBe('Chat state changed. Refreshing…');
    expect(CHAT_STATE_REFRESH_ERROR_HEADING).toBe(
      'Chat state couldn’t be refreshed',
    );
    expect(CHAT_STATE_REFRESH_ERROR_HELPER).toBe(
      'Your last loaded transcript is still shown. Retry to load the latest state.',
    );
    expect(CHAT_STATE_REFRESH_RETRY_LABEL).toBe('Retry');
    expect(CHAT_STATE_CONFLICT_NOTICE).toBe('Your view has been refreshed.');
    expect(CHAT_STATE_COMMAND_FAILED_NOTICE).toBe('Try again.');
  });
});

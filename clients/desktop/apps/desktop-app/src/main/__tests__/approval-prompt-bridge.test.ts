import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  ApprovalPromptDecision,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import type { WindowSendResult } from '../lib/window-send';
import type { SendableBrowserWindow } from '../lib/window-send';

jest.mock('../observability', () => ({
  getObservabilityService: (): {
    pauseChatTurn: jest.Mock;
    resumeChatTurn: jest.Mock;
  } => ({
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  }),
}));

const attentionMark = jest.fn();
const attentionClear = jest.fn();
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: attentionMark,
    clear: attentionClear,
  }),
}));

const sendDetailed = jest.fn<
  WindowSendResult,
  [unknown, string, ApprovalRequestEvent]
>(() => ({ delivered: true }));
jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: (
    window: unknown,
    channel: string,
    payload: ApprovalRequestEvent,
  ): WindowSendResult => sendDetailed(window, channel, payload),
}));

import { requestApprovalFromRenderer } from '../approvals/prompt-bridge';
import {
  pendingApprovalRequests,
  resolveApproval,
  resolveApprovalFromMain,
  rejectAllApprovalsForSession,
} from '../approvals/pending-approvals';
import { EventEmitter } from 'node:events';

function baseEvent(): Omit<ApprovalRequestEvent, 'requestId'> {
  return {
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    provider: 'claude',
    title: 'Run command',
    details: { kind: 'command', command: 'rm foo' },
  };
}

describe('requestApprovalFromRenderer', () => {
  const ownerWebContents = Object.assign(new EventEmitter(), {
    isCrashed: (): boolean => false,
    isDestroyed: (): boolean => false,
    send: jest.fn(),
    mainFrame: {
      detached: false,
      isDestroyed: (): boolean => false,
    },
  });
  const ownerWindow: SendableBrowserWindow = {
    isDestroyed: (): boolean => false,
    webContents: ownerWebContents,
  };

  beforeEach(() => {
    ownerWebContents.removeAllListeners();
    sendDetailed.mockClear();
    sendDetailed.mockReturnValue({ delivered: true });
    attentionMark.mockClear();
    attentionClear.mockClear();
  });

  it('resolves the promise with the decision payload when approvalRespond resolves the pending request', async () => {
    const promise = requestApprovalFromRenderer({
      sessionKey: 's1',
      event: baseEvent(),
      getWindow: () => ownerWindow,
    });

    expect(sendDetailed).toHaveBeenCalledTimes(1);
    const [, channel, payload] = sendDetailed.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.approvalRequest);

    const decision: ApprovalPromptDecision = {
      behavior: 'allow',
      scope: 'once',
    };
    expect(pendingApprovalRequests(ownerWebContents)).toEqual([payload]);
    expect(attentionMark).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      state: 'needs_input',
      reason: 'tool_approval',
      sourceId: `approval:${payload.requestId}`,
      detail: 'Run command',
    });
    expect(ownerWebContents.listenerCount('destroyed')).toBe(1);
    expect(
      resolveApproval(
        payload.requestId,
        decision,
        {},
        {
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
        },
      ),
    ).toBe(false);
    expect(
      resolveApproval(payload.requestId, decision, ownerWebContents, {
        projectId: 'other',
        worktreeId: 'w',
        chatId: 'c',
      }),
    ).toBe(false);
    expect(
      resolveApproval(payload.requestId, decision, ownerWebContents, {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
      }),
    ).toBe(true);
    expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
    expect(ownerWebContents.listenerCount('destroyed')).toBe(0);

    await expect(promise).resolves.toEqual(decision);
    expect(attentionClear).toHaveBeenCalledWith(
      'p',
      'w',
      'c',
      `approval:${payload.requestId}`,
    );
  });

  it('rejects with session_destroyed when rejectAllApprovalsForSession is called for the session', async () => {
    const promise = requestApprovalFromRenderer({
      sessionKey: 's2',
      event: baseEvent(),
      getWindow: () => ownerWindow,
    });

    rejectAllApprovalsForSession('s2');

    await expect(promise).rejects.toThrow('session_destroyed');
    expect(ownerWebContents.listenerCount('destroyed')).toBe(0);
    const [, channel, payload] = sendDetailed.mock.calls[1] as [
      unknown,
      string,
      { requestId?: unknown },
    ];
    expect(channel).toBe(IPC_CHANNELS.approvalCancelled);
    expect(typeof payload.requestId).toBe('string');
  });

  it('rejects and cleans up when the owning renderer is destroyed', async () => {
    const promise = requestApprovalFromRenderer({
      sessionKey: 's-renderer',
      event: baseEvent(),
      getWindow: () => ownerWindow,
    });
    const [, , payload] = sendDetailed.mock.calls[0];

    expect(ownerWebContents.listenerCount('destroyed')).toBe(1);
    ownerWebContents.emit('destroyed');

    await expect(promise).rejects.toThrow('renderer_destroyed');
    expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
    expect(ownerWebContents.listenerCount('destroyed')).toBe(0);
    expect(
      resolveApproval(
        payload.requestId,
        { behavior: 'deny', scope: 'once' },
        ownerWebContents,
        {
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
        },
      ),
    ).toBe(false);
  });

  it('throws Window not available when the request cannot be delivered', async () => {
    sendDetailed.mockReturnValue({ delivered: false, reason: 'no_window' });

    await expect(
      requestApprovalFromRenderer({
        sessionKey: 's3',
        event: baseEvent(),
        getWindow: () => null,
      }),
    ).rejects.toThrow('Window not available');
  });

  it('cancels and rejects before a caller-provided outer deadline', async () => {
    jest.useFakeTimers();
    try {
      const promise = requestApprovalFromRenderer({
        sessionKey: 's4',
        event: baseEvent(),
        getWindow: () => ownerWindow,
        timeoutMs: 590_000,
      });

      jest.advanceTimersByTime(590_000);
      await expect(promise).rejects.toThrow('approval_timeout');
      const lastCall =
        sendDetailed.mock.calls[sendDetailed.mock.calls.length - 1];
      const [, channel, payload] = lastCall as [
        unknown,
        string,
        { requestId?: unknown },
      ];
      expect(channel).toBe(IPC_CHANNELS.approvalCancelled);
      expect(typeof payload.requestId).toBe('string');
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * CAN-3083: the bridge hands the caller the requestId of the prompt it just
 * registered, and main can settle that prompt itself when a mode widening
 * releases it.
 */
describe('main-initiated approval resolution', () => {
  const ownerWebContents = Object.assign(new EventEmitter(), {
    isCrashed: (): boolean => false,
    isDestroyed: (): boolean => false,
    send: jest.fn(),
    mainFrame: { detached: false, isDestroyed: (): boolean => false },
  });
  const ownerWindow: SendableBrowserWindow = {
    isDestroyed: (): boolean => false,
    webContents: ownerWebContents,
  };

  beforeEach(() => {
    ownerWebContents.removeAllListeners();
    sendDetailed.mockClear();
    sendDetailed.mockReturnValue({ delivered: true });
    attentionMark.mockClear();
    attentionClear.mockClear();
  });

  it('reports the delivered payload requestId exactly once', async () => {
    const registered: string[] = [];
    const pending = requestApprovalFromRenderer({
      sessionKey: 'session-1',
      event: baseEvent(),
      getWindow: () => ownerWindow,
      onRegistered: (requestId) => registered.push(requestId),
    });

    const deliveredPayload = sendDetailed.mock.calls[0]?.[2];
    expect(registered).toEqual([deliveredPayload?.requestId]);

    resolveApproval(
      registered[0] ?? '',
      { behavior: 'allow', scope: 'once' },
      ownerWebContents,
      { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    );
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      scope: 'once',
    });
  });

  it('does not report a requestId when delivery fails', async () => {
    // A handle must never hold a requestId for a card the user never saw.
    sendDetailed.mockReturnValue({ delivered: false, reason: 'no_window' });
    const registered: string[] = [];

    await expect(
      requestApprovalFromRenderer({
        sessionKey: 'session-1',
        event: baseEvent(),
        getWindow: () => ownerWindow,
        onRegistered: (requestId) => registered.push(requestId),
      }),
    ).rejects.toThrow('Window not available');
    expect(registered).toEqual([]);
  });

  it('resolves the bridge promise from main when the session key matches', async () => {
    let requestId = '';
    const pending = requestApprovalFromRenderer({
      sessionKey: 'session-1',
      event: baseEvent(),
      getWindow: () => ownerWindow,
      onRegistered: (id) => {
        requestId = id;
      },
    });

    expect(
      resolveApprovalFromMain(requestId, 'session-1', {
        behavior: 'allow',
        scope: 'once',
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      scope: 'once',
    });
    // Resolving through the bridge promise is what clears the attention
    // signal; a private outcome channel would leak it.
    expect(attentionClear).toHaveBeenCalled();
  });

  it('refuses a mismatched session key', async () => {
    let requestId = '';
    const pending = requestApprovalFromRenderer({
      sessionKey: 'session-1',
      event: baseEvent(),
      getWindow: () => ownerWindow,
      onRegistered: (id) => {
        requestId = id;
      },
    });

    expect(
      resolveApprovalFromMain(requestId, 'someone-elses-session', {
        behavior: 'allow',
        scope: 'once',
      }),
    ).toBe(false);
    expect(pendingApprovalRequests(ownerWebContents)).toHaveLength(1);

    rejectAllApprovalsForSession('session-1');
    await expect(pending).rejects.toThrow('session_destroyed');
  });

  it('returns false and does not double-settle after the renderer already won', async () => {
    let requestId = '';
    const pending = requestApprovalFromRenderer({
      sessionKey: 'session-1',
      event: baseEvent(),
      getWindow: () => ownerWindow,
      onRegistered: (id) => {
        requestId = id;
      },
    });

    resolveApproval(
      requestId,
      { behavior: 'deny', scope: 'once', message: 'no thanks' },
      ownerWebContents,
      { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    );

    expect(
      resolveApprovalFromMain(requestId, 'session-1', {
        behavior: 'allow',
        scope: 'once',
      }),
    ).toBe(false);
    // The user's explicit decision stands.
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      scope: 'once',
      message: 'no thanks',
    });
  });

  it('returns false for an unknown requestId', () => {
    expect(
      resolveApprovalFromMain('never-registered', 'session-1', {
        behavior: 'allow',
        scope: 'once',
      }),
    ).toBe(false);
  });
});

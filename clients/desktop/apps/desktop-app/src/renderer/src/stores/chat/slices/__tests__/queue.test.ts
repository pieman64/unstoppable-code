import { createQueueSlice } from '../queue';
import type { ChatState } from '../../state';
import type { ChatTab, QueuedChatMessage } from '../../types';

jest.mock('../../../projectsStore', (): unknown => ({
  useProjectsStore: {
    getState: (): { projects: never[] } => ({ projects: [] }),
  },
}));
jest.mock('../../../pipelineRunsStore', (): unknown => ({
  usePipelineRunsStore: {
    getState: (): { summaries: never[] } => ({ summaries: [] }),
  },
}));
jest.mock('@/stores/claudeTerminalStore', (): unknown => ({
  useClaudeTerminalStore: {
    getState: (): Record<string, never> => ({}),
  },
}));

const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
const chatId = 'chat-1';
const key = `${scope.projectId}/${scope.worktreeId}`;
const target = { ...scope, chatId };

const agentSent: NonNullable<QueuedChatMessage['agentSent']> = {
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

function makeHarness(message: QueuedChatMessage): {
  getState: () => ChatState;
  slice: ReturnType<typeof createQueueSlice>;
  forceQueuedMessage: jest.Mock;
} {
  const tab = {
    id: chatId,
    status: 'idle',
    queuedMessages: [message],
    editingQueuedMessageIndex: 0,
  } as unknown as ChatTab;
  const forceQueuedMessage = jest.fn();
  let state = {
    selectedWorktree: scope,
    worktreeChats: {
      [key]: { activeTabId: chatId, tabs: [tab] },
    },
    forceQueuedMessage,
  } as unknown as ChatState;
  const setState: Parameters<typeof createQueueSlice>[0] = (update) => {
    const partial = typeof update === 'function' ? update(state) : update;
    state = { ...state, ...partial };
  };
  const getState: Parameters<typeof createQueueSlice>[1] = () => state;
  const slice = createQueueSlice(
    setState,
    getState,
    {} as Parameters<typeof createQueueSlice>[2],
  );
  state = { ...state, ...slice, forceQueuedMessage };
  return { getState, slice, forceQueuedMessage };
}

function queuedMessage(
  dispatchOptions: QueuedChatMessage['dispatchOptions'],
  hostQueueEntryId?: string,
): QueuedChatMessage {
  return {
    text: 'Original prompt',
    ...(hostQueueEntryId ? { hostQueueEntryId } : {}),
    ...(dispatchOptions ? { dispatchOptions } : {}),
    ...(dispatchOptions?.agentSent
      ? { agentSent: dispatchOptions.agentSent }
      : {}),
  };
}

describe('saveEditedQueuedMessage', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'window',
  );
  let editQueuedMessage: jest.Mock;

  beforeEach(() => {
    editQueuedMessage = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          chat: {
            editQueuedMessage,
            setQueuedMessageEditLock: jest.fn().mockResolvedValue(undefined),
          },
        },
      },
    });
  });

  afterAll(() => {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('updates accepted input in main before local edit and drain, preserving sender attribution', async () => {
    const order: string[] = [];
    let resolveEdit: () => void = () => undefined;
    const editReply = new Promise<void>((resolve) => {
      resolveEdit = resolve;
    });
    editQueuedMessage.mockImplementation(() => {
      order.push('ipc');
      return editReply;
    });
    const { getState, slice, forceQueuedMessage } = makeHarness(
      queuedMessage({ acceptedInputId: 'accepted-input-5', agentSent }),
    );
    forceQueuedMessage.mockImplementation(() => {
      order.push('drain');
      const updated = getState().worktreeChats[key]?.tabs[0]?.queuedMessages[0];
      expect(updated?.text).toBe('Edited prompt');
      expect(updated?.agentSent).toEqual(agentSent);
    });

    slice.saveEditedQueuedMessage(
      0,
      'Edited prompt',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      target,
    );

    expect(editQueuedMessage).toHaveBeenCalledWith({
      ...scope,
      chatId,
      entryId: 'accepted-input-5',
      text: 'Edited prompt',
    });
    expect(order).toEqual(['ipc']);
    expect(
      getState().worktreeChats[key]?.tabs[0]?.queuedMessages[0]?.text,
    ).toBe('Original prompt');
    expect(
      getState().worktreeChats[key]?.tabs[0]?.editingQueuedMessageIndex,
    ).toBe(0);
    expect(forceQueuedMessage).not.toHaveBeenCalled();

    resolveEdit();
    await editReply;
    await Promise.resolve();

    expect(order).toEqual(['ipc', 'drain']);
    expect(
      getState().worktreeChats[key]?.tabs[0]?.queuedMessages[0],
    ).toMatchObject({
      text: 'Edited prompt',
      agentSent,
      dispatchOptions: { acceptedInputId: 'accepted-input-5', agentSent },
    });
    expect(
      getState().worktreeChats[key]?.tabs[0]?.editingQueuedMessageIndex,
    ).toBeUndefined();
  });

  it('closes the accepted-input editor and keeps old text when main rejects the edit', async () => {
    editQueuedMessage.mockRejectedValue(new Error('edit denied'));
    const { getState, slice } = makeHarness(
      queuedMessage({ acceptedInputId: 'accepted-input-6', agentSent }),
    );

    slice.saveEditedQueuedMessage(
      0,
      'Rejected edit',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      target,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(
      getState().worktreeChats[key]?.tabs[0]?.queuedMessages[0],
    ).toMatchObject({
      text: 'Original prompt',
      agentSent,
    });
    expect(
      getState().worktreeChats[key]?.tabs[0]?.editingQueuedMessageIndex,
    ).toBeUndefined();
  });

  it('keeps ordinary local and host queue edit behavior unchanged', () => {
    const local = makeHarness(queuedMessage(undefined));
    local.slice.saveEditedQueuedMessage(
      0,
      'Local edit',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      target,
    );
    expect(
      local.getState().worktreeChats[key]?.tabs[0]?.queuedMessages[0]?.text,
    ).toBe('Local edit');
    expect(editQueuedMessage).not.toHaveBeenCalled();
    expect(local.forceQueuedMessage).toHaveBeenCalledWith(0, target);

    editQueuedMessage.mockClear();
    const host = makeHarness(queuedMessage(undefined, 'host-entry-5'));
    host.slice.saveEditedQueuedMessage(
      0,
      'Host edit',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      target,
    );

    expect(editQueuedMessage).toHaveBeenCalledWith({
      ...scope,
      chatId,
      entryId: 'host-entry-5',
      text: 'Host edit',
    });
    expect(
      host.getState().worktreeChats[key]?.tabs[0]?.queuedMessages[0]?.text,
    ).toBe('Original prompt');
    expect(
      host.getState().worktreeChats[key]?.tabs[0]?.editingQueuedMessageIndex,
    ).toBeUndefined();
  });
});

describe('clearQueuedMessage', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'window',
  );
  let cancelQueuedMessage: jest.Mock;

  beforeEach(() => {
    cancelQueuedMessage = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { chat: { cancelQueuedMessage } } },
    });
  });

  afterAll(() => {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  const queued = (getState: () => ChatState): QueuedChatMessage[] =>
    getState().worktreeChats[key]?.tabs[0]?.queuedMessages ?? [];

  it('settles accepted agent input in main before removing the local copy', async () => {
    let resolveCancel: () => void = () => undefined;
    cancelQueuedMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    );
    const { getState, slice } = makeHarness(
      queuedMessage({ acceptedInputId: 'accepted-1', agentSent }),
    );

    slice.clearQueuedMessage(0, target);

    expect(cancelQueuedMessage).toHaveBeenCalledWith({
      ...target,
      entryId: 'accepted-1',
    });
    expect(queued(getState)).toHaveLength(1);
    resolveCancel();
    await Promise.resolve();
    await Promise.resolve();
    expect(queued(getState)).toHaveLength(0);
  });

  it('keeps accepted agent input queued when main refuses the cancel', async () => {
    cancelQueuedMessage.mockRejectedValue(new Error('busy'));
    const { getState, slice } = makeHarness(
      queuedMessage({ acceptedInputId: 'accepted-2', agentSent }),
    );

    slice.clearQueuedMessage(0, target);
    await Promise.resolve();
    await Promise.resolve();

    expect(queued(getState)).toHaveLength(1);
  });

  it('removes an ordinary local entry without calling main', () => {
    const { getState, slice } = makeHarness(queuedMessage(undefined));

    slice.clearQueuedMessage(0, target);

    expect(cancelQueuedMessage).not.toHaveBeenCalled();
    expect(queued(getState)).toHaveLength(0);
  });
});

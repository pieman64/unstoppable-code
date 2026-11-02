/**
 * @jest-environment jsdom
 */

import type { CapabilityPackageRepairLaunch } from '@canopy/ui-app/sharing';
import {
  openShareRepairChat,
  pipelineShareRepairEligibility,
  resetShareRepairChatsForTests,
  shareRepairBinding,
  skillShareRepairEligibility,
} from '../fixShareDependenciesWithAI';
import { projectPipelineRelativePath } from '../pipelineDocument';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: jest.fn() },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: { getState: jest.fn() },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: { getState: jest.fn() },
}));

type StandaloneChatCreateInput = Parameters<
  ReturnType<
    typeof useStandaloneChatStore.getState
  >['createStandaloneChatWithMessage']
>[0];

const chatGetState = jest.mocked(useChatStore.getState);
const navigationGetState = jest.mocked(useNavigationStore.getState);
const standaloneGetState = jest.mocked(useStandaloneChatStore.getState);

function launchFor(
  subject: CapabilityPackageRepairLaunch['request']['subject'],
): CapabilityPackageRepairLaunch {
  return {
    request: {
      subject,
      displayName: 'Item',
      audience: { scope: null, selected: null },
      analysis: {
        state: 'blocked',
        blockers: [],
        resolvedResources: [],
        environmentRequirements: [],
        dismissedInvocations: [],
        unpackageableSelectionLabels: [],
        omitted: {
          blockers: 0,
          resolvedResources: 0,
          environmentRequirements: 0,
          dismissedInvocations: 0,
          unpackageableSelectionLabels: 0,
        },
        truncated: false,
      },
    },
    prompt: 'Fix it',
  };
}

beforeEach(() => {
  resetShareRepairChatsForTests();
  jest.clearAllMocks();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getWorktreePath: jest.fn().mockResolvedValue('/repo') },
  });
});

describe('share repair eligibility', () => {
  it('offers repair for custom skills only', () => {
    expect(
      skillShareRepairEligibility({ sourceId: 'custom:app', name: 'mine' }),
    ).toEqual({
      status: 'eligible',
      subject: { kind: 'skill', sourceId: 'custom:app', skillName: 'mine' },
      chat: { kind: 'cowork' },
    });
    expect(
      skillShareRepairEligibility({ sourceId: 'builtin', name: 'pdf' }),
    ).toEqual({ status: 'ineligible', reason: 'read-only-skill' });
  });

  it.each([
    ['bundled', 'bundled-pipeline'],
    ['curated', 'curated-pipeline'],
    ['shared', 'shared-pipeline'],
  ] as const)('hides repair for %s pipelines', (source, reason) => {
    expect(pipelineShareRepairEligibility({ id: 'p', source })).toEqual({
      status: 'ineligible',
      reason,
    });
  });

  it('repairs saved pipelines in Cowork and project pipelines in their worktree', () => {
    expect(pipelineShareRepairEligibility({ id: 'p', source: 'user' })).toEqual(
      {
        status: 'eligible',
        subject: { kind: 'user-pipeline', pipelineId: 'p' },
        chat: { kind: 'cowork' },
      },
    );
    expect(
      pipelineShareRepairEligibility(
        { id: 'project--ci.yaml', source: 'project' },
        {
          projectId: 'proj',
          worktreeId: 'wt',
          repoId: 'repo',
          relativePath: '.canopy/pipelines/ci.yaml',
        },
      ),
    ).toEqual({
      status: 'eligible',
      subject: {
        kind: 'project-pipeline',
        pipelineId: 'project--ci.yaml',
        worktreeId: 'wt',
        relativePath: '.canopy/pipelines/ci.yaml',
        repoId: 'repo',
      },
      chat: {
        kind: 'worktree',
        projectId: 'proj',
        worktreeId: 'wt',
        repoId: 'repo',
      },
    });
  });

  it('treats a project pipeline without a worktree or path as unavailable', () => {
    expect(
      pipelineShareRepairEligibility({ id: 'p', source: 'project' }),
    ).toEqual({ status: 'ineligible', reason: 'project-source-unavailable' });
    expect(
      pipelineShareRepairEligibility(
        { id: 'p', source: 'project' },
        { projectId: 'proj', worktreeId: 'wt', relativePath: null },
      ),
    ).toEqual({ status: 'ineligible', reason: 'project-source-unavailable' });
    expect(
      shareRepairBinding(
        { status: 'ineligible', reason: 'bundled-pipeline' },
        'x',
      ),
    ).toBeUndefined();
  });

  it('passes the worktree locator as analysis context', () => {
    const binding = shareRepairBinding(
      pipelineShareRepairEligibility(
        { id: 'project--ci.yaml', source: 'project' },
        {
          projectId: 'proj',
          worktreeId: 'wt',
          relativePath: '.canopy/pipelines/ci.yaml',
        },
      ),
      'CI',
    );
    expect(binding?.context).toEqual({ worktree: { worktreeId: 'wt' } });
  });
});

describe('projectPipelineRelativePath', () => {
  it.each([
    ['/repo', '/repo/.canopy/pipelines/ci.yaml', '.canopy/pipelines/ci.yaml'],
    [
      'C:\\repo\\',
      'C:\\repo\\.canopy\\pipelines\\ci.yaml',
      '.canopy/pipelines/ci.yaml',
    ],
    [
      '\\\\host\\share\\repo',
      '\\\\host\\share\\repo\\.canopy\\pipelines\\a.yml',
      '.canopy/pipelines/a.yml',
    ],
    ['/repo', '/repository/.canopy/pipelines/ci.yaml', null],
    ['/repo', '/repo/../etc/passwd', null],
    ['/repo', '/repo', null],
  ])('resolves %s + %s', (cwd, file, expected) => {
    expect(projectPipelineRelativePath(cwd, file)).toBe(expected);
  });
});

describe('openShareRepairChat', () => {
  it('opens one Cowork chat for concurrent clicks and sends the prompt', async () => {
    const createStandaloneChatWithMessage = jest
      .fn()
      .mockResolvedValue('chat-1');
    const navigate = jest.fn();
    standaloneGetState.mockReturnValue({
      createStandaloneChatWithMessage,
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    navigationGetState.mockReturnValue({
      navigate,
    } as unknown as ReturnType<typeof useNavigationStore.getState>);
    const launch = launchFor({ kind: 'user-pipeline', pipelineId: 'p' });

    await Promise.all([
      openShareRepairChat({ kind: 'cowork' }, launch),
      openShareRepairChat({ kind: 'cowork' }, launch),
    ]);

    expect(createStandaloneChatWithMessage).toHaveBeenCalledTimes(1);
    expect(createStandaloneChatWithMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Fix it' }),
    );
    expect(navigate).toHaveBeenCalledWith('chat');
  });

  it('rejects when the Cowork chat cannot be created, and a retry starts over', async () => {
    const createStandaloneChatWithMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce('chat-2');
    standaloneGetState.mockReturnValue({
      createStandaloneChatWithMessage,
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    navigationGetState.mockReturnValue({
      navigate: jest.fn(),
    } as unknown as ReturnType<typeof useNavigationStore.getState>);
    const launch = launchFor({
      kind: 'skill',
      sourceId: 'custom:app',
      skillName: 'mine',
    });

    await expect(
      openShareRepairChat({ kind: 'cowork' }, launch),
    ).rejects.toThrow('down');
    await openShareRepairChat({ kind: 'cowork' }, launch);
    expect(createStandaloneChatWithMessage).toHaveBeenCalledTimes(2);
  });

  it('recovers the worktree chat it created when the send failed', async () => {
    const worktreeChats: Record<
      string,
      { activeTabId: string; tabs: Array<{ id: string }> }
    > = {};
    const createTab = jest.fn(() => {
      worktreeChats['proj/wt'] = {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      };
    });
    const sendMessage = jest
      .fn<
        Promise<void>,
        Parameters<ReturnType<typeof useChatStore.getState>['sendMessage']>
      >()
      .mockRejectedValueOnce(new Error('send failed'))
      .mockImplementationOnce((_text, _refs, _target, _mode, options) => {
        options?.onDispatchAccepted?.();
        return Promise.resolve();
      });
    const state = {
      worktreeChats,
      selectWorktree: jest.fn(),
      createTab,
      switchTab: jest.fn(),
      ensureWorktreeHasChatTab: jest.fn().mockResolvedValue(undefined),
      sendMessage,
    };
    chatGetState.mockReturnValue(
      state as unknown as ReturnType<typeof useChatStore.getState>,
    );
    const navigate = jest.fn();
    navigationGetState.mockReturnValue({
      navigate,
    } as unknown as ReturnType<typeof useNavigationStore.getState>);
    const chat = {
      kind: 'worktree' as const,
      projectId: 'proj',
      worktreeId: 'wt',
      repoId: 'repo',
    };
    const launch = launchFor({
      kind: 'project-pipeline',
      pipelineId: 'project--ci.yaml',
      worktreeId: 'wt',
      relativePath: '.canopy/pipelines/ci.yaml',
      repoId: 'repo',
    });

    await expect(openShareRepairChat(chat, launch)).rejects.toThrow(
      'send failed',
    );
    expect(navigate).not.toHaveBeenCalled();
    await openShareRepairChat(chat, launch);

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      selectedRepoId: 'repo',
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const firstMessageId = sendMessage.mock.calls[0]?.[4]?.userMessageId;
    expect(firstMessageId).toBeDefined();
    expect(sendMessage.mock.calls[1]?.[4]?.userMessageId).toBe(firstMessageId);
    expect(sendMessage).toHaveBeenLastCalledWith(
      'Fix it',
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'tab-1',
      },
      undefined,
      expect.objectContaining({ throwOnDispatchFailure: true }),
    );
    expect(navigate).toHaveBeenCalledWith('main');
  });
});

it('recovers the exact submitted Cowork chat after navigation failure without resending', async () => {
  const create = jest.fn((params: StandaloneChatCreateInput) => {
    if (!params.recovery) throw new Error('Expected recovery callbacks');
    params.recovery.onCreated({
      projectId: 'p',
      worktreeId: 'entry',
      chatId: 'created',
    });
    params.recovery.onSubmitted();
    return Promise.resolve('created');
  });
  const selectChat = jest.fn().mockResolvedValue(true);
  standaloneGetState.mockReturnValue({
    activeChatProjectId: 'p',
    createStandaloneChatWithMessage: create,
    selectChat,
  } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
  const sendMessage = jest.fn();
  chatGetState.mockReturnValue({
    ensureWorktreeHasChatTab: jest.fn().mockResolvedValue(undefined),
    sendMessage,
  } as unknown as ReturnType<typeof useChatStore.getState>);
  const navigate = jest.fn().mockImplementationOnce(() => {
    throw new Error('navigation');
  });
  navigationGetState.mockReturnValue({ navigate } as unknown as ReturnType<
    typeof useNavigationStore.getState
  >);
  const launch = launchFor({ kind: 'user-pipeline', pipelineId: 'saved' });
  await expect(openShareRepairChat({ kind: 'cowork' }, launch)).rejects.toThrow(
    'navigation',
  );
  await openShareRepairChat({ kind: 'cowork' }, launch);
  expect(create).toHaveBeenCalledTimes(1);
  expect(selectChat).toHaveBeenCalledWith('created');
  expect(sendMessage).not.toHaveBeenCalled();
});

it('retains a Cowork chat when sending fails and retries that chat', async () => {
  const create = jest.fn((params: StandaloneChatCreateInput) => {
    if (!params.recovery) throw new Error('Expected recovery callbacks');
    params.recovery.onCreated({
      projectId: 'p',
      worktreeId: 'entry',
      chatId: 'created',
    });
    return Promise.reject(new Error('send'));
  });
  const selectChat = jest.fn().mockResolvedValue(true);
  standaloneGetState.mockReturnValue({
    activeChatProjectId: 'p',
    createStandaloneChatWithMessage: create,
    selectChat,
  } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
  const sendMessage = jest.fn((...args: unknown[]) => {
    const options = args[4] as { onDispatchAccepted?: () => void };
    options.onDispatchAccepted?.();
    return Promise.resolve();
  });
  chatGetState.mockReturnValue({
    ensureWorktreeHasChatTab: jest.fn().mockResolvedValue(undefined),
    sendMessage,
  } as unknown as ReturnType<typeof useChatStore.getState>);
  navigationGetState.mockReturnValue({
    navigate: jest.fn(),
  } as unknown as ReturnType<typeof useNavigationStore.getState>);
  const launch = launchFor({
    kind: 'skill',
    sourceId: 'custom:app',
    skillName: 'broken',
  });
  await expect(openShareRepairChat({ kind: 'cowork' }, launch)).rejects.toThrow(
    'send',
  );
  await openShareRepairChat({ kind: 'cowork' }, launch);
  expect(create).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledWith(
    'Fix it',
    undefined,
    expect.objectContaining({ chatId: 'created' }),
    undefined,
    expect.objectContaining({
      throwOnDispatchFailure: true,
      userMessageId: create.mock.calls[0]?.[0].recovery?.userMessageId,
    }),
  );
});

it('selects the broken custom skill while retaining inspection and repair startup', async () => {
  const create = jest
    .fn<Promise<string>, [StandaloneChatCreateInput]>()
    .mockResolvedValue('created');
  standaloneGetState.mockReturnValue({
    createStandaloneChatWithMessage: create,
  } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
  navigationGetState.mockReturnValue({
    navigate: jest.fn(),
  } as unknown as ReturnType<typeof useNavigationStore.getState>);
  await openShareRepairChat(
    { kind: 'cowork' },
    launchFor({ kind: 'skill', sourceId: 'custom:app', skillName: 'broken' }),
  );
  expect(create.mock.calls[0]?.[0].config?.pluginSelections?.skillRefs).toEqual(
    [{ sourceId: 'custom:app', skillName: 'broken' }],
  );
});

it('does not reuse an in-flight chat for a newer audience snapshot', async () => {
  let finish: (id: string) => void = () => {};
  const create = jest.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  standaloneGetState.mockReturnValue({
    createStandaloneChatWithMessage: create,
  } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
  navigationGetState.mockReturnValue({
    navigate: jest.fn(),
  } as unknown as ReturnType<typeof useNavigationStore.getState>);
  const launch = launchFor({ kind: 'user-pipeline', pipelineId: 'saved' });
  const original = openShareRepairChat({ kind: 'cowork' }, launch);
  const newer = openShareRepairChat(
    { kind: 'cowork' },
    { ...launch, prompt: 'A different audience snapshot' },
  );
  const rejected = expect(newer).rejects.toThrow('different context');
  finish('created');
  await original;
  await rejected;
  expect(create).toHaveBeenCalledTimes(1);
});

it.each(['worktree', 'cowork'] as const)(
  'retains the %s repair chat and message after resolved rejection',
  async (kind) => {
    const worktreeChats = {
      'proj/wt': { activeTabId: 'created', tabs: [{ id: 'created' }] },
    };
    const createTab = jest.fn();
    const sendMessage = jest.fn((...args: unknown[]) => {
      const options = args[4] as {
        onPreDispatchRejected?: () => void;
        onDispatchAccepted?: () => void;
      };
      options.onDispatchAccepted?.();
      return Promise.resolve();
    });
    sendMessage.mockImplementationOnce((...args: unknown[]) => {
      const options = args[4] as { onPreDispatchRejected?: () => void };
      options.onPreDispatchRejected?.();
      return Promise.resolve();
    });
    chatGetState.mockReturnValue({
      worktreeChats,
      createTab,
      selectWorktree: jest.fn(),
      switchTab: jest.fn(),
      ensureWorktreeHasChatTab: jest.fn().mockResolvedValue(undefined),
      sendMessage,
    } as unknown as ReturnType<typeof useChatStore.getState>);
    const create = jest.fn((params: StandaloneChatCreateInput) => {
      params.recovery?.onCreated({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'created',
      });
      return Promise.reject(new Error('initial failure'));
    });
    standaloneGetState.mockReturnValue({
      activeChatProjectId: 'proj',
      createStandaloneChatWithMessage: create,
      selectChat: jest.fn().mockResolvedValue(true),
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    const navigate = jest.fn();
    navigationGetState.mockReturnValue({ navigate } as unknown as ReturnType<
      typeof useNavigationStore.getState
    >);
    const target =
      kind === 'worktree'
        ? { kind, projectId: 'proj', worktreeId: 'wt' }
        : { kind };
    const launch = launchFor({ kind: 'user-pipeline', pipelineId: 'saved' });
    if (kind === 'cowork') {
      await expect(openShareRepairChat(target, launch)).rejects.toThrow(
        'initial failure',
      );
    }
    await expect(openShareRepairChat(target, launch)).rejects.toThrow(
      'not accepted',
    );
    expect(navigate).not.toHaveBeenCalled();
    await openShareRepairChat(target, launch);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[4]).toEqual(
      expect.objectContaining({
        userMessageId: (
          sendMessage.mock.calls[0]?.[4] as
            | { userMessageId: string }
            | undefined
        )?.userMessageId,
      }),
    );
    expect(createTab).toHaveBeenCalledTimes(kind === 'worktree' ? 1 : 0);
    expect(create).toHaveBeenCalledTimes(kind === 'cowork' ? 1 : 0);
    expect(navigate).toHaveBeenCalledTimes(1);
  },
);

it.each(['cowork', 'worktree'] as const)(
  'delivers changed repair context to the same %s chat after an accepted send and navigation failure',
  async (kind) => {
    const worktreeChats = {
      'proj/wt': { activeTabId: 'created', tabs: [{ id: 'created' }] },
    };
    const createTab = jest.fn();
    const sendMessage = jest.fn((...args: unknown[]) => {
      const options = args[4] as { onDispatchAccepted?: () => void };
      options.onDispatchAccepted?.();
      return Promise.resolve();
    });
    chatGetState.mockReturnValue({
      worktreeChats,
      createTab,
      sendMessage,
      selectWorktree: jest.fn(),
      switchTab: jest.fn(),
      ensureWorktreeHasChatTab: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useChatStore.getState>);
    const create = jest.fn((params: StandaloneChatCreateInput) => {
      params.recovery?.onCreated({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'created',
      });
      params.recovery?.onSubmitted();
      return Promise.resolve('created');
    });
    standaloneGetState.mockReturnValue({
      activeChatProjectId: 'proj',
      createStandaloneChatWithMessage: create,
      selectChat: jest.fn().mockResolvedValue(true),
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    const navigate = jest.fn().mockImplementationOnce(() => {
      throw new Error('navigation');
    });
    navigationGetState.mockReturnValue({ navigate } as unknown as ReturnType<
      typeof useNavigationStore.getState
    >);
    const target =
      kind === 'worktree'
        ? { kind, projectId: 'proj', worktreeId: 'wt' }
        : { kind };
    const launch = launchFor({ kind: 'user-pipeline', pipelineId: 'saved' });
    await expect(openShareRepairChat(target, launch)).rejects.toThrow(
      'navigation',
    );
    const firstId =
      kind === 'cowork'
        ? create.mock.calls[0]?.[0].recovery?.userMessageId
        : (
            sendMessage.mock.calls[0]?.[4] as
              | { userMessageId: string }
              | undefined
          )?.userMessageId;
    const newer = {
      ...launch,
      prompt: 'A different selected team and analysis snapshot',
    };
    navigate.mockImplementationOnce(() => {
      throw new Error('navigation again');
    });
    await expect(openShareRepairChat(target, newer)).rejects.toThrow(
      'navigation again',
    );
    expect(sendMessage).toHaveBeenLastCalledWith(
      newer.prompt,
      undefined,
      expect.objectContaining({ chatId: 'created' }),
      undefined,
      expect.objectContaining({ throwOnDispatchFailure: true }),
    );
    const secondId = (
      sendMessage.mock.calls.at(-1)?.[4] as
        | { userMessageId: string }
        | undefined
    )?.userMessageId;
    expect(typeof secondId).toBe('string');
    expect(secondId).not.toBe(firstId);
    const sentCount = sendMessage.mock.calls.length;
    await openShareRepairChat(target, newer);
    expect(sendMessage).toHaveBeenCalledTimes(sentCount);
    expect(createTab).toHaveBeenCalledTimes(kind === 'worktree' ? 1 : 0);
    expect(create).toHaveBeenCalledTimes(kind === 'cowork' ? 1 : 0);
  },
);

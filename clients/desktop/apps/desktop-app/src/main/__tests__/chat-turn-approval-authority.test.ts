import type {
  ApprovalMode,
  ApprovalRule,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

const mockReadChatTabsFile = jest.fn<Promise<ChatTabsFile>, [string, string]>();
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (
    projectId: string,
    worktreeId: string,
  ): Promise<ChatTabsFile> => mockReadChatTabsFile(projectId, worktreeId),
}));
const mockDefaultMode = jest.fn<ApprovalMode, []>(() => 'full-access');
jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: (
    _projectId: string,
    _worktreeId: string,
    tabMode?: ApprovalMode,
  ): Promise<ApprovalMode> => Promise.resolve(tabMode ?? mockDefaultMode()),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import {
  beginApprovalModeTransition,
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';
import {
  markApprovalDefaultsChanged,
  markChatApprovalStateChanged,
} from '../approvals/rule-revisions';
import {
  ChatSendAdmissionRefusedError,
  withChatSendAdmission,
} from '../services/chat-send-admission';
import {
  readSteeringApproval,
  resolveChatTurnApprovalAuthority,
  steeringTurnApproval,
} from '../lib/chat-turn-approval-authority';

const TARGET = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  userMessageId: 'message-1',
};
const GRANT: ApprovalRule = {
  id: 'grant',
  behavior: 'allow',
  target: { kind: 'command', pattern: 'npm test' },
  createdAt: '2026-10-23T00:00:00.000Z',
  origin: 'prompt',
};
const DENY: ApprovalRule = {
  ...GRANT,
  id: 'deny',
  behavior: 'deny',
  target: { kind: 'command', pattern: 'rm -rf *' },
};

function savedTab(fields: {
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
}): ChatTabsFile {
  return {
    version: 1,
    activeTabId: 'chat-1',
    tabs: [
      {
        id: 'chat-1',
        title: 'Chat',
        createdAt: '2026-10-23T00:00:00.000Z',
        messages: [],
        ...fields,
      },
    ],
  };
}

beforeEach(() => {
  mockReadChatTabsFile.mockReset();
  mockDefaultMode.mockReset().mockReturnValue('full-access');
  clearLiveApprovalMode(TARGET.projectId, TARGET.worktreeId, TARGET.chatId);
});

describe('resolveChatTurnApprovalAuthority', () => {
  it('uses the workspace default for a chat without a saved mode, narrowed by the send', async () => {
    mockReadChatTabsFile.mockResolvedValue(savedTab({}));
    mockDefaultMode.mockReturnValue('auto');
    await expect(
      resolveChatTurnApprovalAuthority({
        ...TARGET,
        approvalMode: 'full-access',
      }),
    ).resolves.toEqual({
      approvalMode: 'auto',
      chatApprovalMode: 'auto',
      sessionApprovalRules: [],
    });
    await expect(
      resolveChatTurnApprovalAuthority({ ...TARGET, approvalMode: 'ask' }),
    ).resolves.toEqual({
      approvalMode: 'ask',
      chatApprovalMode: 'ask',
      sessionApprovalRules: [],
    });
  });

  it('fails closed when the saved tab cannot be read: Ask and only the send deny rules', async () => {
    mockReadChatTabsFile.mockRejectedValue(new Error('journal unreadable'));
    await expect(
      resolveChatTurnApprovalAuthority({
        ...TARGET,
        approvalMode: 'full-access',
        sessionApprovalRules: [GRANT, DENY],
      }),
    ).resolves.toEqual({
      approvalMode: 'ask',
      chatApprovalMode: 'ask',
      sessionApprovalRules: [DENY],
    });
  });

  it('applies the live mode and a pending restriction', async () => {
    mockReadChatTabsFile.mockResolvedValue(
      savedTab({ approvalMode: 'full-access', sessionApprovalRules: [GRANT] }),
    );
    setLiveApprovalMode(
      TARGET.projectId,
      TARGET.worktreeId,
      TARGET.chatId,
      'auto',
    );
    await expect(resolveChatTurnApprovalAuthority(TARGET)).resolves.toEqual({
      approvalMode: 'auto',
      chatApprovalMode: 'auto',
      sessionApprovalRules: [GRANT],
    });
    beginApprovalModeTransition(
      TARGET.projectId,
      TARGET.worktreeId,
      TARGET.chatId,
      'ask',
    );
    await expect(resolveChatTurnApprovalAuthority(TARGET)).resolves.toEqual({
      approvalMode: 'ask',
      chatApprovalMode: 'ask',
      sessionApprovalRules: [GRANT],
    });
  });

  it('keeps an admitted agent send within what it was admitted against, and lets the chat narrow it further', async () => {
    const laterGrant: ApprovalRule = {
      ...GRANT,
      id: 'later-grant',
      target: { kind: 'command', pattern: 'npm run lint' },
    };
    const admitted = {
      ...TARGET,
      admittedApproval: {
        approvalMode: 'auto' as const,
        // The same grant, under another id.
        sessionApprovalRules: [{ ...GRANT, id: 'grant-as-admitted' }, DENY],
      },
    };
    // Widened after admission: a wider mode and a new grant.
    mockReadChatTabsFile.mockResolvedValueOnce(
      savedTab({
        approvalMode: 'full-access',
        sessionApprovalRules: [GRANT, laterGrant],
      }),
    );
    await expect(resolveChatTurnApprovalAuthority(admitted)).resolves.toEqual({
      approvalMode: 'auto',
      // The chat's own mode, for what outlasts this turn.
      chatApprovalMode: 'full-access',
      sessionApprovalRules: [GRANT, DENY],
    });
    // Narrowed after admission: the chat's own state wins, but removing the
    // deny rule it was admitted with would widen it.
    mockReadChatTabsFile.mockResolvedValueOnce(
      savedTab({ approvalMode: 'ask', sessionApprovalRules: [] }),
    );
    await expect(resolveChatTurnApprovalAuthority(admitted)).resolves.toEqual({
      approvalMode: 'ask',
      chatApprovalMode: 'ask',
      sessionApprovalRules: [DENY],
    });
  });
});

describe('steeringTurnApproval', () => {
  const tabWith = (fields: {
    approvalMode?: ApprovalMode;
    sessionApprovalRules?: ApprovalRule[];
  }): PersistedChatTab => savedTab(fields).tabs[0];

  it('computes the turn a message would start, with the default read beforehand', async () => {
    mockDefaultMode.mockReturnValue('auto');
    const tab = tabWith({ sessionApprovalRules: [GRANT] });
    const read = await readSteeringApproval(TARGET, tab);
    expect(read.defaultMode).toBe('auto');
    expect(
      steeringTurnApproval(
        { ...TARGET, sessionApprovalRules: [DENY] },
        tab,
        read,
      ),
    ).toEqual({
      approvalMode: 'auto',
      chatApprovalMode: 'auto',
      sessionApprovalRules: [GRANT, DENY],
    });
    // Bounded by the chat's live mode, as the turn is.
    setLiveApprovalMode(
      TARGET.projectId,
      TARGET.worktreeId,
      TARGET.chatId,
      'ask',
    );
    expect(steeringTurnApproval(TARGET, tab, read)?.approvalMode).toBe('ask');
  });

  it('does not read the default for a tab with a saved mode, and refuses if the mode is later missing', async () => {
    const read = await readSteeringApproval(
      TARGET,
      tabWith({ approvalMode: 'auto' }),
    );
    expect(mockDefaultMode).not.toHaveBeenCalled();
    expect(read.defaultMode).toBeUndefined();
    expect(
      steeringTurnApproval(TARGET, tabWith({ approvalMode: 'auto' }), read)
        ?.approvalMode,
    ).toBe('auto');
    expect(steeringTurnApproval(TARGET, tabWith({}), read)).toBeUndefined();
  });

  it.each([
    ['an approval setting changed', (): void => markApprovalDefaultsChanged()],
    [
      "the chat's approval state changed",
      (): void => markChatApprovalStateChanged(TARGET),
    ],
  ])('refuses once %s since the read', async (_label, change) => {
    const tab = tabWith({});
    const read = await readSteeringApproval(TARGET, tab);
    expect(steeringTurnApproval(TARGET, tab, read)).toBeDefined();
    change();
    expect(steeringTurnApproval(TARGET, tab, read)).toBeUndefined();
  });

  it('refuses when the default cannot be read', async () => {
    mockDefaultMode.mockImplementation(() => {
      throw new Error('preferences unreadable');
    });
    const tab = tabWith({});
    const read = await readSteeringApproval(TARGET, tab);
    expect(read.defaultMode).toBeUndefined();
    expect(steeringTurnApproval(TARGET, tab, read)).toBeUndefined();
  });

  it('falls back when an admission check throws a typed refusal', async () => {
    const tab = tabWith({ approvalMode: 'ask' });
    const read = await readSteeringApproval(TARGET, tab);
    await withChatSendAdmission(
      TARGET,
      () => {
        throw new ChatSendAdmissionRefusedError('revoked');
      },
      () => {
        expect(steeringTurnApproval(TARGET, tab, read)).toBeUndefined();
        return Promise.resolve();
      },
    );
  });

  it("refuses when the message's admission check refuses the tab", async () => {
    const tab = tabWith({ approvalMode: 'ask' });
    const read = await readSteeringApproval(TARGET, tab);
    await withChatSendAdmission(
      TARGET,
      () => 'refused',
      () => {
        expect(steeringTurnApproval(TARGET, tab, read)).toBeUndefined();
        return Promise.resolve();
      },
    );
    expect(steeringTurnApproval(TARGET, tab, read)).toBeDefined();
  });
});

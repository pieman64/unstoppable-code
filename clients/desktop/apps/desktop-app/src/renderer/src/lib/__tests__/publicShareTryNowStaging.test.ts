/**
 * @jest-environment jsdom
 */

import { stageSkillStarterPrompt } from '../publicShareTryNowStaging';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';

jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: jest.fn() },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: { getState: jest.fn() },
}));

const chatGetStateMock = jest.mocked(useChatStore.getState);
const navigationGetStateMock = jest.mocked(useNavigationStore.getState);

type ChatStateStub = {
  selectedWorktree: { projectId: string; worktreeId: string } | null;
  worktreeChats: Record<string, { activeTabId: string | null } | undefined>;
  createTab: jest.Mock;
  saveTabDraft: jest.Mock;
};

function installChatState(stub: ChatStateStub): void {
  chatGetStateMock.mockReturnValue(
    stub as unknown as ReturnType<typeof useChatStore.getState>,
  );
}

describe('stageSkillStarterPrompt', () => {
  const navigate = jest.fn();
  const requestHomeComposerText = jest.fn();
  const createTab = jest.fn();
  const saveTabDraft = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    navigationGetStateMock.mockReturnValue({
      navigate,
      requestHomeComposerText,
    } as unknown as ReturnType<typeof useNavigationStore.getState>);
  });

  it('drafts into the tab created by createTab, not the pre-createTab snapshot', () => {
    // Regression guard for the CAN-2361 review finding: Zustand set() replaces
    // the state object, so the snapshot captured before createTab still holds
    // the previously-active tab id. Model that exactly: the first snapshot
    // says 'tab-old'; only a fresh getState() after createTab sees 'tab-new'.
    const preCreate: ChatStateStub = {
      selectedWorktree: { projectId: 'p1', worktreeId: 'w1' },
      worktreeChats: { 'p1/w1': { activeTabId: 'tab-old' } },
      createTab,
      saveTabDraft,
    };
    const postCreate: ChatStateStub = {
      ...preCreate,
      worktreeChats: { 'p1/w1': { activeTabId: 'tab-new' } },
    };
    installChatState(preCreate);
    createTab.mockImplementationOnce((): void => {
      installChatState(postCreate);
    });

    stageSkillStarterPrompt('Use the "helper" skill.');

    expect(createTab).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
    });
    expect(saveTabDraft).toHaveBeenCalledWith('tab-new', [
      { type: 'paragraph', children: [{ text: 'Use the "helper" skill.' }] },
    ]);
    expect(navigate).toHaveBeenCalledWith('main');
    expect(requestHomeComposerText).not.toHaveBeenCalled();
  });

  it('seeds the Home composer when no worktree is selected', () => {
    installChatState({
      selectedWorktree: null,
      worktreeChats: {},
      createTab,
      saveTabDraft,
    });

    stageSkillStarterPrompt('Try the shared skill.');

    expect(requestHomeComposerText).toHaveBeenCalledWith(
      'Try the shared skill.',
    );
    expect(createTab).not.toHaveBeenCalled();
    expect(saveTabDraft).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('skips the draft but still navigates when no new tab id is readable', () => {
    const state: ChatStateStub = {
      selectedWorktree: { projectId: 'p1', worktreeId: 'w1' },
      worktreeChats: {},
      createTab,
      saveTabDraft,
    };
    installChatState(state);

    stageSkillStarterPrompt('Use the "helper" skill.');

    expect(createTab).toHaveBeenCalled();
    expect(saveTabDraft).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('main');
  });
});

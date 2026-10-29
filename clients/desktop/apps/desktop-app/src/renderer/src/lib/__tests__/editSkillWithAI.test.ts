/**
 * @jest-environment jsdom
 */

import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import {
  buildEditSkillWithAIPrompt,
  editSkillWithAIUnavailableReason,
  openEditSkillWithAIChat,
  skillDetailEditWithAIState,
} from '../editSkillWithAI';
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

const chatGetState = jest.mocked(useChatStore.getState);
const navigationGetState = jest.mocked(useNavigationStore.getState);
const standaloneGetState = jest.mocked(useStandaloneChatStore.getState);

function installed(overrides: Partial<InstalledSkillInfo>): InstalledSkillInfo {
  return {
    name: 'example',
    sourceId: 'local:example',
    description: '',
    source: 'owner/repo',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    ...overrides,
  };
}

describe('buildEditSkillWithAIPrompt', () => {
  it('asks the agent to use the skill-editing tools and confirm first', () => {
    expect(buildEditSkillWithAIPrompt('release-notes')).toBe(
      'Help me edit release-notes. Ask what I want to change, use the available skill-editing tools to propose the changes, and save them after I confirm.',
    );
  });
});

describe('editSkillWithAIUnavailableReason', () => {
  it('allows custom skills', () => {
    expect(
      editSkillWithAIUnavailableReason(
        installed({ sourceId: 'custom:app', custom: true }),
      ),
    ).toBeNull();
  });

  it('points built-in skills at a custom copy', () => {
    expect(
      editSkillWithAIUnavailableReason(
        installed({ sourceId: 'builtin:app', builtIn: true }),
      ),
    ).toBe(
      'Built-in skills are read-only. Create a custom skill to make your own version.',
    );
  });

  it('points GitHub skills at their repository', () => {
    expect(
      editSkillWithAIUnavailableReason(
        installed({
          sourceId: 'github:owner:repo',
          shareableSource: { type: 'github', repo: 'owner/repo' },
        }),
      ),
    ).toBe(
      'This skill is managed in its GitHub repository. Change it there, then update it here.',
    );
  });

  it('points other installed skills at their source', () => {
    expect(editSkillWithAIUnavailableReason(installed({}))).toBe(
      'This skill is read-only here. Change it where it was installed from.',
    );
  });
});

describe('skillDetailEditWithAIState', () => {
  const action = { onSelect: jest.fn(), pending: false };

  it('offers custom skills before their record resolves', () => {
    expect(
      skillDetailEditWithAIState({ sourceId: 'custom:app' }, undefined, action),
    ).toEqual({ available: true, onSelect: action.onSelect, pending: false });
  });

  it('hides it for other skills until their record resolves', () => {
    expect(
      skillDetailEditWithAIState(
        { sourceId: 'builtin:app' },
        undefined,
        action,
      ),
    ).toBeUndefined();
  });

  it('explains a resolved read-only skill', () => {
    expect(
      skillDetailEditWithAIState(
        { sourceId: 'builtin:app' },
        installed({ sourceId: 'builtin:app', builtIn: true }),
        action,
      ),
    ).toEqual({
      available: false,
      reason:
        'Built-in skills are read-only. Create a custom skill to make your own version.',
    });
  });
});

describe('openEditSkillWithAIChat', () => {
  const createStandaloneChatWithMessage = jest.fn();
  const saveTabDraft = jest.fn();
  const navigate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    standaloneGetState.mockReturnValue({
      createStandaloneChatWithMessage,
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    chatGetState.mockReturnValue({
      saveTabDraft,
    } as unknown as ReturnType<typeof useChatStore.getState>);
    navigationGetState.mockReturnValue({
      navigate,
    } as unknown as ReturnType<typeof useNavigationStore.getState>);
  });

  it('opens a new Cowork chat with the skill attached and the prompt drafted, not sent', async () => {
    createStandaloneChatWithMessage.mockResolvedValue('chat-new');

    await openEditSkillWithAIChat({
      sourceId: 'custom:app',
      name: 'release-notes',
    });

    expect(createStandaloneChatWithMessage).toHaveBeenCalledWith({
      message: '',
      config: {
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'custom:app', skillName: 'release-notes' }],
          pluginRefs: [],
        },
      },
    });
    expect(saveTabDraft).toHaveBeenCalledWith('chat-new', [
      {
        type: 'paragraph',
        children: [{ text: buildEditSkillWithAIPrompt('release-notes') }],
      },
    ]);
    expect(navigate).toHaveBeenCalledWith('chat');
    expect(saveTabDraft.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0],
    );
  });

  it('stays on the page when the chat cannot be created', async () => {
    createStandaloneChatWithMessage.mockRejectedValue(new Error('unavailable'));

    await expect(
      openEditSkillWithAIChat({ sourceId: 'custom:app', name: 'x' }),
    ).rejects.toThrow('unavailable');
    expect(saveTabDraft).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

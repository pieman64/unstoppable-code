/**
 * @jest-environment jsdom
 */

import type { SkillSuggestion } from '@canopy/desktop-shared/lib/skill-suggestions';
import {
  buildCreateSkillFromSuggestionPrompt,
  openCreateSkillFromSuggestionChat,
  skillSuggestionWorkspaceId,
} from '../createSkillFromSuggestion';
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
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: jest.fn() },
}));

const chatGetState = jest.mocked(useChatStore.getState);
const navigationGetState = jest.mocked(useNavigationStore.getState);
const standaloneGetState = jest.mocked(useStandaloneChatStore.getState);

function suggestion(overrides: Partial<SkillSuggestion> = {}): SkillSuggestion {
  return {
    id: 'sug-1',
    kind: 'prompt',
    title: 'Summarize review comments',
    occurrenceCount: 4,
    summary: 'Collects open review threads and drafts replies.',
    proposedSkillName: 'review-replies',
    proposedDescription: 'Draft replies to open review threads.',
    parameters: ['pull request'],
    chainSkills: [],
    examples: ['summarize the comments on <url>', 'draft replies for\n<url>'],
    owner: { kind: 'personal' },
    ownerLabel: 'Personal',
    isPrivate: false,
    lastSeenAt: 1,
    state: 'confirmed',
    ...overrides,
  };
}

describe('skillSuggestionWorkspaceId', () => {
  it("drafts in the owner's default Cowork workspace", () => {
    expect(skillSuggestionWorkspaceId({ kind: 'personal' })).toBe(
      'cowork-default',
    );
    expect(
      skillSuggestionWorkspaceId({
        kind: 'organization',
        organizationId: 'org-1',
      }),
    ).toBe('cowork-org-org-1');
  });
});

describe('buildCreateSkillFromSuggestionPrompt', () => {
  it('includes the task, parameters and quoted examples', () => {
    const prompt = buildCreateSkillFromSuggestionPrompt(suggestion());
    expect(prompt).toContain('Task: Summarize review comments');
    expect(prompt).toContain('Suggested name: review-replies');
    expect(prompt).toContain('Inputs that change each time: pull request');
    expect(prompt).toContain('> summarize the comments on <url>');
    expect(prompt).toContain('> draft replies for <url>');
    expect(prompt).toContain('skills.create_custom');
    expect(prompt).not.toContain('sharing.open_dialog');
    expect(prompt).not.toContain('—');
  });

  it('never carries examples from a private workspace', () => {
    const prompt = buildCreateSkillFromSuggestionPrompt(
      suggestion({ isPrivate: true }),
    );
    expect(prompt).not.toContain('How I usually ask');
    expect(prompt).not.toContain('summarize the comments');
    expect(prompt).toContain('What it does:');
  });

  it('lists chain skills in order and names missing ones', () => {
    const prompt = buildCreateSkillFromSuggestionPrompt(
      suggestion({
        kind: 'chain',
        chainSkills: ['review', 'push-branch', 'open-pr'],
        parameters: [],
      }),
      { missingSkills: ['push-branch'] },
    );
    expect(prompt).toContain('review → push-branch → open-pr');
    expect(prompt).toContain("Don't copy the skills' contents.");
    expect(prompt).toContain(
      "These skills aren't installed anymore: push-branch.",
    );
  });

  it('names the organization and offers to share with it', () => {
    const prompt = buildCreateSkillFromSuggestionPrompt(
      suggestion({
        owner: { kind: 'organization', organizationId: 'org-1' },
        ownerLabel: 'Acme',
      }),
    );
    expect(prompt).toContain('This came from my work in Acme.');
    expect(prompt).toContain(
      "Once it's saved, offer to share it with Acme using sharing.open_dialog.",
    );
  });
});

describe('private organization suggestions', () => {
  it('never offers to share a skill drafted from a private workspace', () => {
    const prompt = buildCreateSkillFromSuggestionPrompt(
      suggestion({
        owner: { kind: 'organization', organizationId: 'org-1' },
        ownerLabel: 'Acme · Private workspace',
        isPrivate: true,
      }),
    );
    expect(prompt).not.toContain('sharing.open_dialog');
  });
});

describe('openCreateSkillFromSuggestionChat', () => {
  const create = jest.fn();
  const saveTabDraft = jest.fn();
  const navigate = jest.fn();
  const closeSettings = jest.fn();

  beforeEach(() => {
    create.mockReset();
    saveTabDraft.mockReset();
    navigate.mockReset();
    closeSettings.mockReset();
    standaloneGetState.mockReturnValue({
      createStandaloneChatWithMessage: create,
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    chatGetState.mockReturnValue({
      saveTabDraft,
    } as unknown as ReturnType<typeof useChatStore.getState>);
    navigationGetState.mockReturnValue({
      navigate,
      closeSettings,
    } as unknown as ReturnType<typeof useNavigationStore.getState>);
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        loadSkills: jest.fn().mockResolvedValue({
          success: true,
          data: [{ name: 'review', sourceId: 'custom:app' }],
        }),
      },
    });
  });

  it("opens the owner's workspace, drafts the prompt and navigates", async () => {
    create.mockResolvedValue('chat-9');
    await expect(
      openCreateSkillFromSuggestionChat(
        suggestion({
          owner: { kind: 'organization', organizationId: 'org-1' },
          ownerLabel: 'Acme',
        }),
      ),
    ).resolves.toBe('chat-9');
    expect(create).toHaveBeenCalledWith({
      message: '',
      chatProjectId: 'cowork-org-org-1',
      config: {
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      },
    });
    expect(saveTabDraft).toHaveBeenCalledWith('chat-9', expect.any(Array));
    expect(closeSettings).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('chat');
  });

  it('selects installed chain skills and names the rest as missing', async () => {
    create.mockResolvedValue('chat-9');
    await openCreateSkillFromSuggestionChat(
      suggestion({ kind: 'chain', chainSkills: ['review', 'open-pr'] }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          pluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'custom:app', skillName: 'review' }],
            pluginRefs: [],
          },
        },
      }),
    );
    const draft = (
      saveTabDraft.mock.calls as Array<
        [string, Array<{ children: Array<{ text: string }> }>]
      >
    )[0][1];
    const text = draft.map((node) => node.children[0].text).join('\n');
    expect(text).toContain("These skills aren't installed anymore: open-pr.");
  });

  it('matches namespaced and differently cased chain skills', async () => {
    window.skills.loadSkills = jest.fn().mockResolvedValue({
      success: true,
      data: [
        { name: 'review', sourceId: 'plugin:acme' },
        { name: 'Deploy', sourceId: 'custom:app' },
      ],
    });
    create.mockResolvedValue('chat-9');
    await openCreateSkillFromSuggestionChat(
      suggestion({ kind: 'chain', chainSkills: ['acme:review', 'deploy'] }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          pluginSelections: {
            collectionIds: [],
            skillRefs: [
              { sourceId: 'plugin:acme', skillName: 'review' },
              { sourceId: 'custom:app', skillName: 'Deploy' },
            ],
            pluginRefs: [],
          },
        },
      }),
    );
    const draft = (
      saveTabDraft.mock.calls as Array<
        [string, Array<{ children: Array<{ text: string }> }>]
      >
    )[0][1];
    const text = draft.map((node) => node.children[0].text).join('\n');
    expect(text).not.toContain("aren't installed anymore");
  });

  it('fails closed without drafting or navigating', async () => {
    create.mockRejectedValue(new Error('org chats unavailable'));
    await expect(
      openCreateSkillFromSuggestionChat(suggestion()),
    ).rejects.toThrow('org chats unavailable');
    expect(saveTabDraft).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

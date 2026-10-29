import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { pipelineAssistantHasConversation } from '../pipelineAssistantConversation';

const KEY = `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`;

function seedTabs(
  tabs: ReadonlyArray<{ kind?: string; messages: unknown[] }>,
): void {
  const loadTabsForTarget = jest.fn(() => Promise.resolve());
  useChatStore.setState(
    (state) =>
      ({
        loadTabsForTarget,
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: { ...state.worktreeChats[KEY], tabs },
        },
      }) as unknown as Partial<ReturnType<typeof useChatStore.getState>>,
  );
}

describe('pipelineAssistantHasConversation', () => {
  it('is false for an assistant with only empty tabs', async () => {
    seedTabs([{ messages: [] }]);

    await expect(pipelineAssistantHasConversation()).resolves.toBe(false);
  });

  it('is true once any chat tab has a message', async () => {
    seedTabs([{ messages: [] }, { messages: [{ id: 'm1' }] }]);

    await expect(pipelineAssistantHasConversation()).resolves.toBe(true);
  });

  it('ignores file tabs', async () => {
    seedTabs([{ kind: 'file', messages: [{ id: 'm1' }] }]);

    await expect(pipelineAssistantHasConversation()).resolves.toBe(false);
  });

  it('loads the assistant tabs with the saved plugin selections', async () => {
    seedTabs([]);
    const selections = { plugins: [] };

    await pipelineAssistantHasConversation(
      selections as unknown as Parameters<
        typeof pipelineAssistantHasConversation
      >[0],
    );

    expect(useChatStore.getState().loadTabsForTarget).toHaveBeenCalledWith(
      PIPELINE_EDITOR_PROJECT_ID,
      PIPELINE_EDITOR_WORKTREE_ID,
      { pluginSelections: selections },
    );
  });
});

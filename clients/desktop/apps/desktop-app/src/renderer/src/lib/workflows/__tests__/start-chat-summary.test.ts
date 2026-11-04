import { startChatSummaryView } from '../start-chat-summary';

const projectName = (id: string): string | undefined =>
  id === 'storefront' ? 'Storefront' : undefined;

// CAN-4551: what a converted chat automation's Definition summarizes.
describe('startChatSummaryView', () => {
  it('names a new worktree chat’s project and its three steps', () => {
    expect(
      startChatSummaryView(
        'Nightly',
        { type: 'worktree_prompt', workspaceId: 'storefront', prompt: 'x' },
        projectName,
      ),
    ).toEqual({
      destination: 'Storefront',
      steps: ['Create a worktree', 'Send the prompt', 'Wait for the reply'],
    });
  });

  it('starts an Orchestrator chat without waiting for its reply', () => {
    expect(
      startChatSummaryView(
        'Check',
        { type: 'app_advisor_prompt', prompt: 'x' },
        projectName,
      ),
    ).toEqual({
      destination: 'Orchestrator',
      steps: ['Create an Orchestrator task', 'Send the prompt'],
    });
  });

  it('sends into an existing chat, in a project it can’t name', () => {
    expect(
      startChatSummaryView(
        'Follow-up',
        {
          type: 'worktree_session_prompt',
          workspaceId: 'other',
          worktreeId: 'w',
          chatId: 'c',
          prompt: 'x',
        },
        projectName,
      ),
    ).toEqual({
      destination: 'a project',
      steps: ['Send the prompt', 'Wait for the reply'],
    });
  });

  it('has nothing to show for an action that stays native', () => {
    expect(
      startChatSummaryView(
        'Home task',
        {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'x',
          purpose: 'scheduled_task',
        },
        projectName,
      ),
    ).toBeNull();
  });
});

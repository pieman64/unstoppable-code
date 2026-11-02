import type { AgentSentSender } from '@canopy/ui-shared';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  appAdvisorWindowSenderOpener,
  mainWindowSenderOpener,
  openSender,
} from '../agent-sent-sender-opener';

const mockIsArchivedChat = jest.fn<
  Promise<boolean>,
  [{ projectId: string; worktreeId: string }, string]
>();
const mockNavigate = jest.fn<Promise<void>, [object]>();

jest.mock('@/lib/chat-archive-status', () => ({
  isArchivedChat: (
    scope: { projectId: string; worktreeId: string },
    chatId: string,
  ): Promise<boolean> => mockIsArchivedChat(scope, chatId),
}));
jest.mock('@/stores/chat/notifications', () => ({
  navigateToUnreadChat: (target: object): Promise<void> => mockNavigate(target),
}));

const projectSender: AgentSentSender = {
  kind: 'project',
  projectType: 'code',
  projectId: 'project-1',
  taskId: 'task-1',
  chatId: 'chat-1',
};

describe('agent-sent sender opener', () => {
  beforeEach(() => {
    mockIsArchivedChat.mockReset();
    mockNavigate.mockReset();
    mockNavigate.mockResolvedValue(undefined);
  });

  it('opens a live project sender as its chat', async () => {
    mockIsArchivedChat.mockResolvedValue(false);
    await openSender(projectSender);
    expect(mockNavigate).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'task-1',
      chatId: 'chat-1',
    });
  });

  it("opens an archived project sender's transcript read-only", async () => {
    mockIsArchivedChat.mockResolvedValue(true);
    await openSender(projectSender);
    expect(mockIsArchivedChat).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', worktreeId: 'task-1' }),
      'chat-1',
    );
    expect(mockNavigate).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'task-1',
      chatId: 'chat-1',
      openArchivedTranscript: true,
    });
  });

  it('opens an App Advisor sender in its window without an archive check', async () => {
    await openSender({
      kind: 'bot',
      botId: 'app_advisor',
      taskId: 'entry-1',
      chatId: 'advisor-chat',
    });
    expect(mockIsArchivedChat).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'advisor-chat',
    });
  });

  it('never opens a pipeline sender from either window', async () => {
    const pipelineSender: AgentSentSender = {
      kind: 'pipeline',
      executionId: 'exec-1',
      pipelineId: 'pipeline-1',
      stepId: 'notify',
      automationId: 'automation-1',
    };
    expect(mainWindowSenderOpener.canOpen(pipelineSender)).toBe(false);
    expect(appAdvisorWindowSenderOpener.canOpen(pipelineSender)).toBe(false);
    await openSender(pipelineSender);
    expect(mockIsArchivedChat).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

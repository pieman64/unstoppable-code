import type * as SendOrchestrationModule from '../send-orchestration';
import type * as SenderContextModule from '../sender-context';
import type { AgentScheduledSend } from '@canopy/desktop-shared/types';
import type { ProjectsScheduleMessageAction } from '@canopy/desktop-shared/lib/chat-send-actions';
import { dispatchAgentChatSchedule } from '../schedule-orchestration';
import { AgentSenderContextError } from '../sender-context';
import { DiscoveryError } from '../../project-discovery/errors';
import {
  AgentChatSendError,
  type TrustedSendCaller,
} from '../send-orchestration';

jest.mock('../send-orchestration', () => ({
  ...jest.requireActual<typeof SendOrchestrationModule>(
    '../send-orchestration',
  ),
  canonicalSource: jest.fn(
    (source: unknown): Promise<unknown> => Promise.resolve(source),
  ),
}));
const mockResolve = jest.fn();
const mockCreate = jest.fn();
const mockBuild = jest.fn();
jest.mock('../../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (...args: unknown[]): unknown => mockResolve(...args),
}));
jest.mock('../../automations/service', () => ({
  getAutomationsService: (): object => ({ create: mockCreate }),
}));
jest.mock('../sender-context', () => ({
  ...jest.requireActual<typeof SenderContextModule>('../sender-context'),
  buildAgentSenderRequest: (...args: unknown[]): unknown => mockBuild(...args),
}));
const source = {
  projectId: 'source-project',
  worktreeId: 'source-task',
  chatId: 'source-chat',
};
const address = {
  projectId: 'target-project',
  taskId: 'target-task',
  chatId: 'target-chat',
};
const caller: TrustedSendCaller = { kind: 'project_root', source };
const action: ProjectsScheduleMessageAction = {
  type: 'projects.schedule_message',
  ...address,
  text: '  Hello  ',
  runAt: '2099-01-01T12:00:00+02:00',
};
const captured: AgentScheduledSend = {
  version: 1,
  agentSent: {
    sender: {
      kind: 'project',
      projectType: 'code',
      projectId: source.projectId,
      taskId: source.worktreeId,
      chatId: source.chatId,
    },
    chatTitle: 'Source',
    projectLabel: 'Source project',
  },
  provenance: {
    version: 1,
    acceptedInputId: 'capture',
    capturedAt: '2026-10-17T00:00:00.000Z',
    sender: {
      kind: 'project',
      projectType: 'code',
      projectId: source.projectId,
      taskId: source.worktreeId,
      chatId: source.chatId,
    },
    owner: { kind: 'personal' },
  },
};
function target(tab: object = {}): object {
  return {
    address,
    projectType: 'code',
    scope: {
      workspaceId: address.projectId,
      worktreeId: address.taskId,
      chatId: address.chatId,
    },
    tab: { id: address.chatId, title: 'Destination', kind: 'chat', ...tab },
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue(target());
  mockBuild.mockResolvedValue({
    agentSent: captured.agentSent,
    agentSenderProvenance: captured.provenance,
    hiddenContext: { kind: 'agent-sender-context', text: 'hidden' },
  });
  mockCreate.mockImplementation(
    (
      request: object,
      trusted: { agentScheduledSend: AgentScheduledSend },
    ): Promise<object> =>
      Promise.resolve({
        ok: true,
        activity: {
          ...request,
          version: 1,
          id: 'automation',
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
          failureCount: 0,
          ...trusted,
        },
      }),
  );
});
it('creates through the trusted parameter and returns the resolved instant and saved activity', async () => {
  const result = await dispatchAgentChatSchedule(
    { ...action, name: '  Reminder  ' },
    { caller },
  );
  expect(result.receipt).toEqual({
    address,
    automationId: 'automation',
    name: 'Reminder',
    runAt: '2099-01-01T10:00:00.000Z',
    timezone: 'local',
    createdAt: '2026-10-17T00:00:00.000Z',
  });
  expect(result.activity.agentScheduledSend).toEqual(captured);
  expect(mockResolve).toHaveBeenCalledWith(address, {
    kind: 'project_agent',
    ...source,
  });
  expect(mockBuild).toHaveBeenCalledWith(
    source,
    expect.any(String),
    address.projectId,
  );
  expect(mockCreate).toHaveBeenCalledWith(
    {
      name: 'Reminder',
      enabled: true,
      schedule: { kind: 'one_time', runAt: action.runAt, timezone: 'local' },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: address.projectId,
        worktreeId: address.taskId,
        chatId: address.chatId,
        chatTitle: 'Destination',
        prompt: action.text,
        purpose: 'scheduled_send',
        inputMode: 'typed',
      },
    },
    { agentScheduledSend: captured },
  );
});
it('maps typed attachments and voice mode without changing the visible text', async () => {
  const attachments: NonNullable<ProjectsScheduleMessageAction['attachments']> =
    {
      fileReferences: [
        {
          displayPath: 'file.ts',
          absolutePath: '/repo/file.ts',
          repoName: 'repo',
        },
      ],
      attachmentPaths: ['attachments/a.png'],
      attachmentPromptContexts: [
        {
          attachmentPath: 'attachments/a.png',
          promptKind: 'in-app-browser-resource',
        },
      ],
    };
  const result = await dispatchAgentChatSchedule(
    { ...action, inputMode: 'voice', attachments },
    { caller },
  );
  expect(result.activity.action).toMatchObject({
    ...attachments,
    prompt: action.text,
    inputMode: 'voice',
  });
  expect(result.receipt.name).toBe('Scheduled message');
});
it.each(['2099-01-01T12:00:00', 'invalid', '2000-01-01T00:00:00Z'])(
  'refuses invalid or past runAt %s',
  async (runAt) => {
    await expect(
      dispatchAgentChatSchedule({ ...action, runAt }, { caller }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockBuild).not.toHaveBeenCalled();
  },
);
it('refuses recursive self schedules', async () => {
  mockResolve.mockResolvedValue({
    ...target(),
    scope: {
      workspaceId: source.projectId,
      worktreeId: source.worktreeId,
      chatId: source.chatId,
    },
  });
  await expect(
    dispatchAgentChatSchedule(action, { caller }),
  ).rejects.toMatchObject({
    code: 'unsupported_action',
    message: 'A chat cannot schedule a message to itself.',
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it.each([
  new AgentSenderContextError('owner_boundary', 'private owner'),
  new AgentSenderContextError('authorization_conflict', 'private identity'),
  new DiscoveryError('not_found', 'private target'),
])('hides authorization failures: %s', async (error) => {
  mockResolve.mockRejectedValueOnce(error);
  await expect(
    dispatchAgentChatSchedule(action, { caller }),
  ).rejects.toMatchObject({
    code: 'not_found',
    message: 'The target chat is not available.',
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it.each([
  { readOnly: true },
  { staleSessionDetected: false },
  { kind: 'file' },
])('refuses an unavailable tab %j', async (tab) => {
  mockResolve.mockResolvedValue(target(tab));
  await expect(
    dispatchAgentChatSchedule(action, { caller }),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(mockCreate).not.toHaveBeenCalled();
});
it('refuses inconsistent trusted caller identity', async () => {
  await expect(
    dispatchAgentChatSchedule(action, {
      caller: { kind: 'app_advisor', source },
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(mockResolve).not.toHaveBeenCalled();
});
it('maps a refused automation create to validation_failed', async () => {
  mockCreate.mockResolvedValueOnce({
    ok: false,
    error: 'Cannot save schedule',
  });
  await expect(
    dispatchAgentChatSchedule(action, { caller }),
  ).rejects.toMatchObject({
    code: 'validation_failed',
    message: 'Cannot save schedule',
  });
});

it('refuses an incomplete captured sender instead of scheduling an unattributed message', async () => {
  mockBuild.mockResolvedValueOnce({
    hiddenContext: { kind: 'agent-sender-context', text: 'incomplete' },
  });
  await expect(
    dispatchAgentChatSchedule(action, { caller }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(mockCreate).not.toHaveBeenCalled();
});
it('reads the root admission for the resolved target and stores nothing when it refuses', async () => {
  const admission = jest
    .fn()
    .mockRejectedValue(
      new AgentChatSendError('authorization_conflict', 'Broader approvals.'),
    );
  await expect(
    dispatchAgentChatSchedule(action, { caller, admission }),
  ).rejects.toMatchObject({
    code: 'authorization_conflict',
    message: 'Broader approvals.',
  });
  expect(admission).toHaveBeenCalledWith({
    workspaceId: address.projectId,
    worktreeId: address.taskId,
    chatId: address.chatId,
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it('refuses a pipeline caller before resolving a target', async () => {
  await expect(
    dispatchAgentChatSchedule(action, {
      caller: {
        kind: 'pipeline',
        source: {
          executionId: 'exec-1',
          pipelineId: 'pipeline-1',
          pipelineName: 'Pipeline',
          stepId: 'schedule',
          owner: { kind: 'personal' },
        },
      },
    }),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

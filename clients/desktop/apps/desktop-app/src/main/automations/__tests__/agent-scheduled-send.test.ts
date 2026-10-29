import type * as PathsModule from '../../lib/paths';
import type * as BackgroundContextModule from '../../services/background-execution-context';
import type * as SenderContextModule from '../../agent-messaging/sender-context';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentScheduledSend,
  AutomationCreateRequest,
  ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';
import { AutomationsService } from '../service';
import * as automationServices from '../service';
import { registerAutomationsHandlers } from '../../ipc/automations';
import { registerIpcHandler } from '../../ipc/register';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
import {
  revalidateAgentSenderRequest,
  AgentSenderContextError,
} from '../../agent-messaging/sender-context';

let mockDir = '';
const mockDelivered = jest.fn<void, [ChatSendMessageRequest]>();
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getDataDir: (): string => mockDir,
  getAutomationsFilePath: (): string => join(mockDir, 'automations.json'),
}));
jest.mock('../../lib/resource-context', () => ({
  resourceContextEnabled: (): boolean => false,
}));
jest.mock('../../services/background-execution-context', () => ({
  ...jest.requireActual<typeof BackgroundContextModule>(
    '../../services/background-execution-context',
  ),
  backgroundExecutionContextEnabled: (): boolean => false,
  captureBackgroundExecutionContext: (): Promise<undefined> =>
    Promise.resolve(undefined),
  automationContextRefusal: (): Promise<null> => Promise.resolve(null),
  describeAutomationContextMismatch: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<object> =>
    Promise.resolve({
      items: [
        {
          type: 'single-repo',
          id: 'target-project',
          repoPath: '/repo',
          worktrees: [{ id: 'target-task' }],
        },
      ],
    }),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (): Promise<object> =>
    Promise.resolve({
      version: 1,
      tabs: [{ id: 'target-chat', kind: 'chat' }],
      activeTabId: 'target-chat',
    }),
}));
jest.mock('../../services/chat-service', () => ({
  buildExistingTabDispatchOptions: (): Promise<object> =>
    Promise.resolve({ selectedRepoId: 'repo-a' }),
  sendWorktreeChatMessage: async (
    request: ChatSendMessageRequest,
  ): Promise<object> => {
    await revalidateAgentSenderRequest(request);
    mockDelivered(request);
    return { ok: true, chatId: request.chatId };
  },
}));
jest.mock('../../agent-messaging/sender-context', () => ({
  ...jest.requireActual<typeof SenderContextModule>(
    '../../agent-messaging/sender-context',
  ),
  revalidateAgentSenderRequest: jest.fn(),
}));
const mockAdmit = jest.fn<Promise<void>, [object, object, object]>();
jest.mock('../../agent-actions/desktop-project-bot-port', () => ({
  admitScheduledProjectMessage: (
    ...args: [object, object, object]
  ): Promise<void> => mockAdmit(...args),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): object => ({
    handleAutomationRunEvent: jest.fn(),
  }),
}));
const captured: AgentScheduledSend = {
  version: 1,
  agentSent: {
    sender: {
      kind: 'project',
      projectType: 'code',
      projectId: 'source-project',
      taskId: 'source-task',
      chatId: 'source-chat',
    },
    chatTitle: 'Origin',
    projectLabel: 'Source',
  },
  provenance: {
    version: 1,
    capturedAt: '2026-10-17T00:00:00.000Z',
    acceptedInputId: 'capture-id',
    sender: {
      kind: 'project',
      projectType: 'code',
      projectId: 'source-project',
      taskId: 'source-task',
      chatId: 'source-chat',
    },
    owner: { kind: 'personal' },
  },
};
const request: AutomationCreateRequest = {
  name: 'Scheduled message',
  enabled: false,
  schedule: {
    kind: 'one_time',
    runAt: '2099-01-01T00:00:00.000Z',
    timezone: 'local',
  },
  action: {
    type: 'worktree_session_prompt',
    workspaceId: 'target-project',
    worktreeId: 'target-task',
    chatId: 'target-chat',
    prompt: 'Hello',
    purpose: 'scheduled_send',
  },
};
function service(): AutomationsService {
  const result = new AutomationsService();
  result.configure({
    getMainWindow: () => null,
    ensureAppAdvisorWindow: jest.fn(),
    sendAppAdvisorWindowCommand: jest.fn(),
  });
  return result;
}
async function createTrusted(instance: AutomationsService): Promise<string> {
  const result = await instance.create(request, {
    agentScheduledSend: captured,
  });
  if (!result.ok || !result.activity) throw new Error(JSON.stringify(result));
  return result.activity.id;
}
beforeEach(async () => {
  mockDir = await mkdtemp(join(tmpdir(), 'agent-scheduled-send-'));
  jest.clearAllMocks();
  jest.mocked(revalidateAgentSenderRequest).mockResolvedValue(undefined);
  mockAdmit.mockResolvedValue(undefined);
});
afterEach(async () => {
  await rm(mockDir, { recursive: true, force: true });
});
it('persists trusted attribution and rebinds marker, provenance and hidden context to each run input', async () => {
  const instance = service();
  const id = await createTrusted(instance);
  expect((await instance.list()).activities[0].agentScheduledSend).toEqual(
    captured,
  );
  const run = await instance.runNow({ id });
  expect(run).toMatchObject({ ok: true, run: { status: 'success' } });
  expect(mockDelivered).toHaveBeenCalledTimes(1);
  const delivered: ChatSendMessageRequest = mockDelivered.mock.calls[0][0];
  expect(delivered.agentSent).toEqual(captured.agentSent);
  expect(delivered.agentSenderProvenance).toEqual({
    ...captured.provenance,
    acceptedInputId: delivered.userMessageId,
  });
  expect(delivered.userMessageId).not.toBe(captured.provenance.acceptedInputId);
  expect(delivered.hiddenContext).toMatchObject({
    kind: 'agent-sender-context',
    text: containing(delivered.userMessageId ?? ''),
  });
});
it('fails a run and delivers nothing when sender/target ownership revalidation refuses', async () => {
  const instance = service();
  const id = await createTrusted(instance);
  jest.mocked(revalidateAgentSenderRequest).mockImplementation((input) => {
    if (input.agentSenderProvenance)
      return Promise.reject(
        new AgentSenderContextError(
          'owner_boundary',
          'The saved owner changed.',
        ),
      );
    return Promise.resolve();
  });
  expect(await instance.runNow({ id })).toMatchObject({
    ok: true,
    run: { status: 'failure', error: containing('owner changed') },
  });
  expect(mockDelivered).not.toHaveBeenCalled();
});
it("rechecks the scheduling chat's approval admission at delivery and delivers nothing when it refuses", async () => {
  const instance = service();
  const id = await createTrusted(instance);
  mockAdmit.mockRejectedValue(
    new Error('Chat target-chat runs with broader tool approvals.'),
  );
  expect(await instance.runNow({ id })).toMatchObject({
    ok: true,
    run: { status: 'failure', error: containing('broader tool approvals') },
  });
  expect(mockAdmit).toHaveBeenCalledWith(
    {
      workspaceId: 'source-project',
      worktreeId: 'source-task',
      chatId: 'source-chat',
    },
    {
      workspaceId: 'target-project',
      worktreeId: 'target-task',
      chatId: 'target-chat',
    },
    // The settings the send carries, not a fresh read of the chat.
    { kind: 'chat', selectedRepoId: 'repo-a' },
  );
  expect(mockDelivered).not.toHaveBeenCalled();
});
it('keeps attribution through user action replacement and ignores update forgery', async () => {
  const instance = service();
  const id = await createTrusted(instance);
  const patch = {
    id,
    name: 'Edited',
    action: { ...request.action, prompt: 'Updated' },
    agentScheduledSend: { ...captured, version: 999 },
  };
  expect(await instance.update(patch)).toMatchObject({
    ok: true,
    activity: { agentScheduledSend: captured, action: { prompt: 'Updated' } },
  });
});
it('refuses converting an agent-scheduled send to another action type', async () => {
  const instance = service();
  const id = await createTrusted(instance);
  const result = await instance.update({
    id,
    action: {
      type: 'worktree_prompt',
      workspaceId: 'target-project',
      prompt: 'Hello',
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: containing("can't become another kind of automation"),
  });
  expect((await instance.list()).activities[0]).toMatchObject({
    agentScheduledSend: captured,
    action: { type: 'worktree_session_prompt' },
  });
});
it('ignores a supplied main-only field in a generic one-argument create', async () => {
  const instance = service();
  const supplied = { ...request, agentScheduledSend: captured };
  const result = await instance.create(supplied);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  expect(result.activity?.agentScheduledSend).toBeUndefined();
});
it('reads the additive field in a persisted file and keeps it through an action update (old-validator tolerance)', async () => {
  const first = service();
  const result = await first.create(request);
  if (!result.ok || !result.activity) throw new Error('create failed');
  const activity = { ...result.activity, agentScheduledSend: captured };
  await writeFile(
    join(mockDir, 'automations.json'),
    JSON.stringify({
      version: 1,
      updatedAt: activity.updatedAt,
      activities: [activity],
      recentRuns: [],
    }),
  );
  const reloaded = service();
  expect((await reloaded.list()).activities[0].agentScheduledSend).toEqual(
    captured,
  );
  expect(
    await reloaded.update({
      id: activity.id,
      action: { ...request.action, prompt: 'Edited after reload' },
    }),
  ).toMatchObject({ ok: true, activity: { agentScheduledSend: captured } });
  expect(
    JSON.parse(await readFile(join(mockDir, 'automations.json'), 'utf8')),
  ).toMatchObject({ activities: [{ agentScheduledSend: captured }] });
});

it('IPC create cannot inject agentScheduledSend into the trusted create parameter', async () => {
  const instance = service();
  const getService = jest
    .spyOn(automationServices, 'getAutomationsService')
    .mockReturnValue(instance);
  const create = jest.spyOn(instance, 'create');
  try {
    registerAutomationsHandlers({
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
      closeAppAdvisorWindow: jest.fn(),
      toggleAppAdvisorWindow: jest.fn(),
      getAppAdvisorWindowState: jest.fn(),
      markAppAdvisorWindowRendererReady: jest.fn(),
      setAppAdvisorFloatingSize: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
      sendChatWindowCommand: jest.fn(),
      notifyStartupUnlocked: jest.fn(),
    });
    const entry = jest
      .mocked(registerIpcHandler)
      .mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.automationsCreate,
      );
    if (!entry) throw new Error('Missing automation create handler');
    const supplied = { ...request, agentScheduledSend: captured };
    const result: unknown = await Reflect.apply(entry[1], undefined, [
      undefined,
      supplied,
    ]);
    expect(result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledWith(supplied, { agentAuthor: null });
    expect(
      (await instance.list()).activities[0].agentScheduledSend,
    ).toBeUndefined();
  } finally {
    getService.mockRestore();
    create.mockRestore();
  }
});

function containing(value: string): unknown {
  return expect.stringContaining(value);
}

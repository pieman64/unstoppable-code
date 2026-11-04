const mockRequireAuthorizedProject = jest.fn();
jest.mock('../../project-discovery/owner-policy', () => ({
  requireAuthorizedProject: (...args: unknown[]): unknown =>
    mockRequireAuthorizedProject(...args),
}));
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';
import {
  buildPipelineSenderRequest,
  parseAgentSenderProvenance,
  pipelineSenderIdentity,
  revalidateAgentSenderRequest,
  revalidateAgentSteeringActor,
  type AutomationSenderSource,
  type PipelineSenderSource,
  type PipelineStepSenderSource,
} from '../sender-context';

const mockListWorkEntryIds = jest.fn();
const mockResolveWorkEntryForChat = jest.fn();
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntryIds: (...args: unknown[]): unknown =>
    mockListWorkEntryIds(...args),
  resolveWorkEntryForChat: (...args: unknown[]): unknown =>
    mockResolveWorkEntryForChat(...args),
}));

const mockReadChatTabsFile = jest.fn();
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (...args: unknown[]): unknown =>
    mockReadChatTabsFile(...args),
}));

const mockResolveProjectSavedOwner = jest.fn();
jest.mock('../../lib/project-owner', () => ({
  resolveProjectSavedOwner: (...args: unknown[]): unknown =>
    mockResolveProjectSavedOwner(...args),
}));

const mockResolveBackgroundWorkspaceTarget = jest.fn();
jest.mock('../../services/background-execution-context', () => ({
  resolveBackgroundWorkspaceTarget: (...args: unknown[]): unknown =>
    mockResolveBackgroundWorkspaceTarget(...args),
}));

const mockReadWorkspaceWorktreesDetailed = jest.fn();
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceWorktreesDetailed: (...args: unknown[]): unknown =>
    mockReadWorkspaceWorktreesDetailed(...args),
}));

const mockReadWorkspaceIndexEntry = jest.fn();
jest.mock('../../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (...args: unknown[]): unknown =>
    mockReadWorkspaceIndexEntry(...args),
}));

const mockDecideAppAdvisorAccessForCaller = jest.fn();
jest.mock('../../lib/app-advisor-project-agent-access', () => ({
  decideAppAdvisorAccessForCaller: (...args: unknown[]): unknown =>
    mockDecideAppAdvisorAccessForCaller(...args),
}));

const mockReadmitQueuedProjectMessage = jest.fn();
jest.mock('../../agent-actions/desktop-project-bot-port', () => ({
  readmitQueuedProjectMessage: (...args: unknown[]): unknown =>
    mockReadmitQueuedProjectMessage(...args),
}));

const agentOrigin = {
  projectId: 'agent-project',
  worktreeId: 'agent-task',
  chatId: 'agent-chat',
};

function source(
  overrides: Partial<PipelineStepSenderSource> = {},
): PipelineStepSenderSource {
  return {
    executionId: 'exec-1',
    pipelineId: 'nightly-triage',
    stepId: 'notify_owner',
    pipelineName: 'Nightly triage pipeline',
    owner: { kind: 'personal' },
    ...overrides,
  };
}

function tabsFor(worktreeId: string): object {
  return {
    version: 1,
    tabs: [
      {
        id: worktreeId === 'agent-task' ? 'agent-chat' : 'target-chat',
        kind: 'chat',
        title: 'A chat',
        messages: [],
        createdAt: '2026-10-26T00:00:00.000Z',
      },
    ],
  };
}

async function pipelineRequest(
  sender: PipelineSenderSource,
  targetProjectId = 'target-project',
): Promise<ChatSendMessageRequest> {
  const fields = await buildPipelineSenderRequest(
    sender,
    'accepted-input',
    targetProjectId,
  );
  return {
    projectId: targetProjectId,
    worktreeId: 'target-task',
    chatId: 'target-chat',
    userMessageId: 'accepted-input',
    text: 'Run the checks',
    ...fields,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAuthorizedProject.mockResolvedValue({});
  mockListWorkEntryIds.mockResolvedValue(['target-task']);
  mockResolveWorkEntryForChat.mockResolvedValue({
    entryId: 'target-task',
    archivedInEntryId: null,
  });
  mockReadChatTabsFile.mockImplementation(
    (_projectId: string, worktreeId: string) =>
      Promise.resolve(tabsFor(worktreeId)),
  );
  mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
  mockResolveBackgroundWorkspaceTarget.mockResolvedValue({
    workspaceType: 'single-repo',
    workspaceOwner: { kind: 'personal' },
  });
  mockReadWorkspaceWorktreesDetailed.mockResolvedValue({
    authority: 'ok',
    worktrees: [{ id: 'agent-task' }, { id: 'target-task' }],
  });
  mockReadWorkspaceIndexEntry.mockResolvedValue({
    id: 'agent-project',
    name: 'Agent project',
  });
  mockDecideAppAdvisorAccessForCaller.mockResolvedValue({ allowed: true });
  mockReadmitQueuedProjectMessage.mockResolvedValue(undefined);
});

describe('buildPipelineSenderRequest', () => {
  it('captures the pipeline sender, the run owner and an ID-only hidden note', async () => {
    const fields = await buildPipelineSenderRequest(
      source(),
      'accepted-input',
      'target-project',
    );

    expect(fields.agentSent).toEqual({
      sender: {
        kind: 'pipeline',
        executionId: 'exec-1',
        pipelineId: 'nightly-triage',
        stepId: 'notify_owner',
      },
      chatTitle: 'Nightly triage pipeline',
      projectLabel: '',
    });
    const { capturedAt, ...provenance } = fields.agentSenderProvenance ?? {
      capturedAt: '',
    };
    expect(capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(provenance).toEqual({
      version: 1,
      acceptedInputId: 'accepted-input',
      sender: fields.agentSent?.sender,
      owner: { kind: 'personal' },
    });
    const note = fields.hiddenContext?.text ?? '';
    expect(fields.hiddenContext?.kind).toBe('agent-sender-context');
    expect(note).toContain('sent by a pipeline or automation step');
    expect(note).toContain('"owner":{"kind":"personal"}');
    expect(note).toContain('"executionId":"exec-1"');
    expect(note).not.toContain('Nightly triage pipeline');
    expect(note).not.toContain('Retain the sender’s origin ownership boundary');
    // A user-originated run resolves no agent.
    expect(mockReadChatTabsFile).not.toHaveBeenCalled();
  });

  it('titles an automation-started run with the automation name, never in the note', async () => {
    const fields = await buildPipelineSenderRequest(
      source({
        automation: {
          automationId: 'automation-1',
          automationName: 'Morning report',
        },
      }),
      'accepted-input',
      'target-project',
    );

    expect(fields.agentSent?.chatTitle).toBe('Morning report');
    expect(fields.agentSent?.sender).toMatchObject({
      automationId: 'automation-1',
    });
    expect(fields.hiddenContext?.text).toContain(
      '"automationId":"automation-1"',
    );
    expect(fields.hiddenContext?.text).not.toContain('Morning report');
  });

  it('normalizes captured names like chat titles', async () => {
    const fields = await buildPipelineSenderRequest(
      source({ pipelineName: `  Line\u0000one\n${'x'.repeat(300)}` }),
      'accepted-input',
      'target-project',
    );
    expect(fields.agentSent?.chatTitle).toBe(
      `Line one ${'x'.repeat(300)}`.slice(0, 256),
    );

    const blank = await buildPipelineSenderRequest(
      source({ pipelineName: ' \u0007 ' }),
      'accepted-input',
      'target-project',
    );
    expect(blank.agentSent?.chatTitle).toBe('nightly-triage');
  });

  it('adds the ownership reminder for an Orchestrator target', async () => {
    const fields = await buildPipelineSenderRequest(
      source({ owner: { kind: 'organization', organizationId: 'org-1' } }),
      'accepted-input',
      APP_ADVISOR_PROJECT_ID,
    );
    expect(fields.hiddenContext?.text).toContain(
      'Retain the sender’s origin ownership boundary',
    );
    expect(fields.hiddenContext?.text).toContain(
      '"owner":{"kind":"organization","organizationId":"org-1"}',
    );
  });

  it('records a current, same-owner agent origin (D11)', async () => {
    const fields = await buildPipelineSenderRequest(
      source({ agentOrigin }),
      'accepted-input',
      'target-project',
    );
    expect(fields.agentSenderProvenance).toMatchObject({ agentOrigin });
    expect(fields.hiddenContext?.text).toContain(
      '"agentOrigin":{"projectId":"agent-project","taskId":"agent-task","chatId":"agent-chat"}',
    );
  });

  it('refuses an agent origin whose chat is gone or whose owner changed', async () => {
    mockReadChatTabsFile.mockResolvedValue({ version: 1, tabs: [] });
    await expect(
      buildPipelineSenderRequest(
        source({ agentOrigin }),
        'accepted-input',
        'target-project',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    mockReadChatTabsFile.mockImplementation(
      (_projectId: string, worktreeId: string) =>
        Promise.resolve(tabsFor(worktreeId)),
    );
    mockResolveProjectSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-2',
    });
    await expect(
      buildPipelineSenderRequest(
        source({ agentOrigin }),
        'accepted-input',
        'target-project',
      ),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
  });

  it("checks an agent's Orchestrator access for an Orchestrator target", async () => {
    mockDecideAppAdvisorAccessForCaller.mockResolvedValue({
      allowed: false,
      reason: 'advisor_access_disabled',
    });
    await expect(
      buildPipelineSenderRequest(
        source({ agentOrigin }),
        'accepted-input',
        APP_ADVISOR_PROJECT_ID,
      ),
    ).rejects.toMatchObject({ code: 'advisor_access_disabled' });
    expect(mockDecideAppAdvisorAccessForCaller).toHaveBeenCalledWith(
      { projectId: 'agent-project', worktreeId: 'agent-task' },
      { kind: 'personal' },
    );
  });

  it('refuses malformed sender IDs and owners', async () => {
    await expect(
      buildPipelineSenderRequest(
        source({ stepId: ' ' }),
        'accepted-input',
        'target-project',
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      buildPipelineSenderRequest(
        source({ owner: { kind: 'organization', organizationId: '' } }),
        'accepted-input',
        'target-project',
      ),
    ).rejects.toMatchObject({ code: 'owner_context_unavailable' });
  });
});

describe('pipelineSenderIdentity', () => {
  it('builds the steering actor without I/O', () => {
    expect(
      pipelineSenderIdentity(
        source({
          automation: { automationId: 'automation-1', automationName: 'A' },
        }),
      ),
    ).toEqual({
      kind: 'pipeline',
      executionId: 'exec-1',
      pipelineId: 'nightly-triage',
      stepId: 'notify_owner',
      automationId: 'automation-1',
    });
    expect(mockReadChatTabsFile).not.toHaveBeenCalled();
  });
});

describe('parseAgentSenderProvenance (cloud chat)', () => {
  // A cloud chat's sender is the hosted server's; desktop never accepts one
  // as provenance for a send it revalidates.
  it('refuses a cloud chat sender', () => {
    expect(
      parseAgentSenderProvenance({
        version: 1,
        capturedAt: '2026-10-26T00:00:00.000Z',
        acceptedInputId: 'accepted-input',
        sender: {
          kind: 'cloud_chat',
          projectId: 'workspace-1',
          taskId: 'task-1',
          chatId: 'chat-1',
        },
        owner: { kind: 'personal' },
      }),
    ).toBeNull();
  });
});

describe('parseAgentSenderProvenance (pipeline)', () => {
  const base = {
    version: 1,
    capturedAt: '2026-10-26T00:00:00.000Z',
    acceptedInputId: 'accepted-input',
    sender: {
      kind: 'pipeline',
      executionId: 'exec-1',
      pipelineId: 'nightly-triage',
      stepId: 'notify_owner',
    },
    owner: { kind: 'personal' },
  };

  it('parses an owner and an optional agent origin', () => {
    expect(parseAgentSenderProvenance(base)).toEqual(base);
    expect(parseAgentSenderProvenance({ ...base, agentOrigin })).toEqual({
      ...base,
      agentOrigin,
    });
  });

  it('refuses a missing owner or a partial agent origin', () => {
    expect(
      parseAgentSenderProvenance({ ...base, owner: { kind: 'none' } }),
    ).toBeNull();
    expect(
      parseAgentSenderProvenance({
        ...base,
        agentOrigin: { projectId: 'agent-project', chatId: 'agent-chat' },
      }),
    ).toBeNull();
  });
});

describe('revalidateAgentSenderRequest (pipeline)', () => {
  it('passes with the run owner alone; nothing reads the execution', async () => {
    const request = await pipelineRequest(source());
    await expect(revalidateAgentSenderRequest(request)).resolves.toBe(
      undefined,
    );
    expect(mockRequireAuthorizedProject).toHaveBeenCalledWith(
      'target-project',
      { kind: 'pipeline', owner: { kind: 'personal' } },
    );
    // No agent origin, no readmission.
    expect(mockReadmitQueuedProjectMessage).not.toHaveBeenCalled();
  });

  it('refuses a target whose saved owner changed since acceptance', async () => {
    const request = await pipelineRequest(source());
    mockResolveProjectSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-1',
    });
    await expect(revalidateAgentSenderRequest(request)).rejects.toMatchObject({
      code: 'owner_boundary',
    });
  });

  it('readmits an agent-originated message as its agent (D11)', async () => {
    const request = await pipelineRequest(source({ agentOrigin }));
    await revalidateAgentSenderRequest(request);
    expect(mockRequireAuthorizedProject).toHaveBeenCalledWith(
      'target-project',
      { kind: 'pipeline', owner: { kind: 'personal' }, agentOrigin },
    );
    expect(mockReadmitQueuedProjectMessage).toHaveBeenCalledWith(
      {
        workspaceId: 'agent-project',
        worktreeId: 'agent-task',
        chatId: 'agent-chat',
      },
      {
        workspaceId: 'target-project',
        worktreeId: 'target-task',
        chatId: 'target-chat',
      },
      false,
    );
  });

  it('refuses when the agent chat was archived while the message waited', async () => {
    const request = await pipelineRequest(source({ agentOrigin }));
    mockReadChatTabsFile.mockImplementation(
      (_projectId: string, worktreeId: string) =>
        Promise.resolve(
          worktreeId === 'agent-task'
            ? { version: 1, tabs: [] }
            : tabsFor(worktreeId),
        ),
    );
    await expect(revalidateAgentSenderRequest(request)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it("refuses when the agent's project changed owner while the message waited", async () => {
    const request = await pipelineRequest(source({ agentOrigin }));
    mockResolveProjectSavedOwner.mockImplementation(
      (target: { projectId: string }) =>
        Promise.resolve(
          target.projectId === 'agent-project'
            ? { kind: 'organization', organizationId: 'org-2' }
            : { kind: 'personal' },
        ),
    );
    await expect(revalidateAgentSenderRequest(request)).rejects.toMatchObject({
      code: 'authorization_conflict',
    });
  });

  it('refuses a hidden note that does not match its provenance', async () => {
    const request = await pipelineRequest(source());
    await expect(
      revalidateAgentSenderRequest({
        ...request,
        hiddenContext: {
          kind: 'agent-sender-context',
          text: `${request.hiddenContext?.text ?? ''} extra`,
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses an agent origin missing one of its IDs', async () => {
    const request = await pipelineRequest(source({ agentOrigin }));
    await expect(
      revalidateAgentSenderRequest({
        ...request,
        agentSenderProvenance: {
          version: 1,
          capturedAt: '2026-10-26T00:00:00.000Z',
          acceptedInputId: 'accepted-input',
          sender: pipelineSenderIdentity(source()),
          owner: { kind: 'personal' },
          agentOrigin: { ...agentOrigin, chatId: '' },
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('revalidateAgentSteeringActor (pipeline)', () => {
  const actor = pipelineSenderIdentity(source());

  it("refuses without the steered row's matching provenance", async () => {
    await expect(
      revalidateAgentSteeringActor(actor, 'target-project'),
    ).rejects.toMatchObject({ code: 'not_found' });
    for (const other of [
      source({ stepId: 'other_step' }),
      source({ executionId: 'exec-2' }),
      source({ pipelineId: 'other-pipeline' }),
    ]) {
      const row = await pipelineRequest(other);
      await expect(
        revalidateAgentSteeringActor(
          actor,
          'target-project',
          row.agentSenderProvenance,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(mockRequireAuthorizedProject).not.toHaveBeenCalled();
  });

  it("authorizes with the row's owner", async () => {
    const row = await pipelineRequest(
      source({ owner: { kind: 'organization', organizationId: 'org-1' } }),
    );
    await revalidateAgentSteeringActor(
      actor,
      'target-project',
      row.agentSenderProvenance,
    );
    expect(mockRequireAuthorizedProject).toHaveBeenCalledWith(
      'target-project',
      {
        kind: 'pipeline',
        owner: { kind: 'organization', organizationId: 'org-1' },
      },
    );
  });
});

describe('an automation’s own send (CAN-4549)', () => {
  function automation(
    overrides: Partial<AutomationSenderSource> = {},
  ): AutomationSenderSource {
    return {
      kind: 'automation',
      automationId: 'automation-1',
      automationName: 'Morning report',
      owner: { kind: 'personal' },
      ...overrides,
    };
  }

  it('names only the automation, with no run or step', () => {
    expect(pipelineSenderIdentity(automation())).toStrictEqual({
      kind: 'pipeline',
      automationId: 'automation-1',
    });
    for (const automationId of ['', ' ', 'a\u0000b', 'x'.repeat(257)])
      expect(() =>
        pipelineSenderIdentity(automation({ automationId })),
      ).toThrow('Invalid automationId for sender context.');
  });

  it('titles the message with the automation name, never in the note', async () => {
    const fields = await buildPipelineSenderRequest(
      automation(),
      'accepted-input',
      'target-project',
    );
    expect(fields.agentSent).toStrictEqual({
      sender: { kind: 'pipeline', automationId: 'automation-1' },
      chatTitle: 'Morning report',
      projectLabel: '',
    });
    expect(
      parseAgentSenderProvenance(fields.agentSenderProvenance),
    ).toMatchObject({
      sender: { kind: 'pipeline', automationId: 'automation-1' },
      owner: { kind: 'personal' },
    });
    const note = fields.hiddenContext?.text ?? '';
    expect(note).toContain(
      '"sender":{"kind":"pipeline","automationId":"automation-1"}',
    );
    expect(note).toContain('"targetProjectId":"target-project"');
    expect(note).not.toContain('executionId');
    expect(note).not.toContain('Morning report');
    expect(note).not.toContain('Retain the sender’s origin ownership boundary');
  });

  it('normalizes the name like a chat title and falls back to the ID', async () => {
    const long = await buildPipelineSenderRequest(
      automation({ automationName: 'y'.repeat(300) }),
      'accepted-input',
      'target-project',
    );
    expect(long.agentSent?.chatTitle).toBe('y'.repeat(256));
    const blank = await buildPipelineSenderRequest(
      automation({ automationName: ' \u0007 ' }),
      'accepted-input',
      'target-project',
    );
    expect(blank.agentSent?.chatTitle).toBe('automation-1');
  });

  it('adds the ownership reminder for an Orchestrator target', async () => {
    const fields = await buildPipelineSenderRequest(
      automation(),
      'accepted-input',
      APP_ADVISOR_PROJECT_ID,
    );
    expect(fields.hiddenContext?.text).toContain(
      'Retain the sender’s origin ownership boundary',
    );
  });

  it('revalidates with its owner alone and refuses an owner change', async () => {
    const request = await pipelineRequest(automation());
    await expect(revalidateAgentSenderRequest(request)).resolves.toBe(
      undefined,
    );
    expect(mockRequireAuthorizedProject).toHaveBeenCalledWith(
      'target-project',
      { kind: 'pipeline', owner: { kind: 'personal' } },
    );
    mockResolveProjectSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-1',
    });
    await expect(revalidateAgentSenderRequest(request)).rejects.toMatchObject({
      code: 'owner_boundary',
    });
  });

  it('steers only its own row, never a step its automation started', async () => {
    const actor = pipelineSenderIdentity(automation());
    const stepRow = await pipelineRequest(
      source({
        automation: {
          automationId: 'automation-1',
          automationName: 'Morning report',
        },
      }),
    );
    await expect(
      revalidateAgentSteeringActor(
        actor,
        'target-project',
        stepRow.agentSenderProvenance,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const ownRow = await pipelineRequest(automation());
    await expect(
      revalidateAgentSteeringActor(
        actor,
        'target-project',
        ownRow.agentSenderProvenance,
      ),
    ).resolves.toBe(undefined);
  });
});

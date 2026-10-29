/**
 * @jest-environment jsdom
 *
 * CAN-3734: renderer resolution of the facts the shared automation target
 * policy needs. Unknown or unreadable facts must never read as compatible.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type AutomationAction,
  type WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import {
  pipelineResolutionFromRaw,
  projectTypeToSessionTargetKind,
  resolveAutomationPipelineScopes,
  resolveSessionTargetKind,
  resolveAutomationProjectCreationContexts,
} from '../automationTargets';

const loadProjects = jest.fn();
const creationContext = jest.fn<Promise<WorkspaceContextState>, []>();
const coworkEligibility = jest.fn<
  Promise<'eligible' | 'ineligible'>,
  [string]
>();
const codeEligibility = jest.fn<Promise<'eligible' | 'ineligible'>, [string]>();
const getPipeline = jest.fn();
const resolveSharedPipelineInstallPin = jest.fn();

beforeEach(() => {
  loadProjects.mockReset();
  creationContext.mockReset();
  creationContext.mockResolvedValue({
    context: { kind: 'personal' },
    revision: 0,
    organizations: [],
  });
  coworkEligibility.mockReset().mockResolvedValue('eligible');
  codeEligibility.mockReset().mockResolvedValue('eligible');
  getPipeline.mockReset();
  resolveSharedPipelineInstallPin.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadProjects,
      workspaceContext: { get: creationContext },
      chatProject: { getOrgDefaultCoworkEligibility: coworkEligibility },
      orgProjects: { getMemberCodeEligibility: codeEligibility },
      automations: { resolveSharedPipelineInstallPin },
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: { get: getPipeline },
  });
});

function session(
  workspaceId: string,
): Extract<AutomationAction, { type: 'worktree_session_prompt' }> {
  return {
    type: 'worktree_session_prompt',
    workspaceId,
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    prompt: 'Continue.',
  };
}

function pipeline(
  overrides: Partial<
    Extract<AutomationAction, { type: 'worktree_pipeline' }>
  > = {},
): Extract<AutomationAction, { type: 'worktree_pipeline' }> {
  return {
    type: 'worktree_pipeline',
    workspaceId: 'ws-1',
    pipelineId: 'code-review',
    pipelineSource: 'bundled',
    ...overrides,
  };
}

describe('projectTypeToSessionTargetKind', () => {
  it('maps known project types and rejects anything else', () => {
    expect(projectTypeToSessionTargetKind('cowork')).toBe('cowork');
    expect(projectTypeToSessionTargetKind('single-repo')).toBe('single-repo');
    expect(projectTypeToSessionTargetKind('multi-repo')).toBe('multi-repo');
    expect(projectTypeToSessionTargetKind('mystery')).toBeUndefined();
    expect(projectTypeToSessionTargetKind(undefined)).toBeUndefined();
  });
});

describe('resolveSessionTargetKind', () => {
  it('handles App Advisor and standalone chats without a project lookup', async () => {
    await expect(
      resolveSessionTargetKind(session(APP_ADVISOR_PROJECT_ID)),
    ).resolves.toBe('app_advisor');
    await expect(
      resolveSessionTargetKind(session(STANDALONE_CHAT_PROJECT_ID)),
    ).resolves.toBe('cowork');
    expect(loadProjects).not.toHaveBeenCalled();
  });

  it('reads the bound project kind', async () => {
    loadProjects.mockResolvedValue({
      items: [
        { id: 'cowork-1', type: 'cowork' },
        { id: 'ws-1', type: 'multi-repo' },
      ],
    });
    await expect(resolveSessionTargetKind(session('cowork-1'))).resolves.toBe(
      'cowork',
    );
    await expect(resolveSessionTargetKind(session('ws-1'))).resolves.toBe(
      'multi-repo',
    );
  });

  it('returns undefined for missing projects and failed lookups', async () => {
    loadProjects.mockResolvedValueOnce({ items: [] });
    await expect(
      resolveSessionTargetKind(session('gone')),
    ).resolves.toBeUndefined();
    loadProjects.mockRejectedValueOnce(new Error('ipc down'));
    await expect(
      resolveSessionTargetKind(session('ws-1')),
    ).resolves.toBeUndefined();
  });
});

describe('pipelineResolutionFromRaw', () => {
  it('resolves parsed scopes and reports parse failures as errors', () => {
    expect(
      pipelineResolutionFromRaw(
        'name: Review\non: dispatch\nscope: worktree\njobs: {}\n',
      ),
    ).toEqual({ status: 'resolved', scopes: 'worktree' });
    expect(pipelineResolutionFromRaw('not: a pipeline\n').status).toBe('error');
  });
});

describe('resolveAutomationPipelineScopes', () => {
  it('reads stored pipeline scopes by source', async () => {
    getPipeline.mockResolvedValue({
      success: true,
      data: {
        info: { id: 'code-review' },
        content: { name: 'Review', on: 'dispatch', scope: 'directory' },
      },
    });
    await expect(resolveAutomationPipelineScopes(pipeline())).resolves.toEqual({
      status: 'resolved',
      scopes: 'directory',
    });
    expect(getPipeline).toHaveBeenCalledWith({
      id: 'code-review',
      source: 'bundled',
    });
  });

  it('treats unreadable pipelines as errors, never compatibility', async () => {
    getPipeline.mockResolvedValue({ success: false, error: 'not found' });
    await expect(resolveAutomationPipelineScopes(pipeline())).resolves.toEqual({
      status: 'error',
      error: 'not found',
    });
  });

  it('reads shared pipelines from their current pinned definition', async () => {
    resolveSharedPipelineInstallPin.mockResolvedValue({
      rawPipeline: 'name: Team\non: dispatch\nscope: worktree\njobs: {}\n',
    });
    await expect(
      resolveAutomationPipelineScopes(
        pipeline({
          pipelineSource: 'shared',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
        }),
      ),
    ).resolves.toEqual({ status: 'resolved', scopes: 'worktree' });
    await expect(
      resolveAutomationPipelineScopes(pipeline({ pipelineSource: 'shared' })),
    ).resolves.toMatchObject({ status: 'error' });
  });
});

describe('resolveAutomationProjectCreationContexts', () => {
  it('supports both project kinds in Personal', async () => {
    await expect(resolveAutomationProjectCreationContexts()).resolves.toEqual([
      'cowork',
      'worktree',
    ]);
  });
  it.each([
    ['eligible', 'eligible', ['cowork', 'worktree']],
    ['eligible', 'ineligible', ['cowork']],
    ['ineligible', 'eligible', []],
  ])(
    'requires organization eligibility for each project kind (%s, %s)',
    async (cowork, code, expected) => {
      creationContext.mockResolvedValue({
        context: { kind: 'organization', organizationId: 'org-1' },
        revision: 1,
        organizations: [],
      });
      coworkEligibility.mockResolvedValue(
        cowork === 'eligible' ? 'eligible' : 'ineligible',
      );
      codeEligibility.mockResolvedValue(
        code === 'eligible' ? 'eligible' : 'ineligible',
      );
      await expect(resolveAutomationProjectCreationContexts()).resolves.toEqual(
        expected,
      );
      expect(codeEligibility).toHaveBeenCalledWith('org-1');
    },
  );
  it('retains Cowork creation when the code capability lookup fails', async () => {
    creationContext.mockResolvedValue({
      context: { kind: 'organization', organizationId: 'org-1' },
      revision: 1,
      organizations: [],
    });
    codeEligibility.mockRejectedValue(new Error('offline'));
    await expect(resolveAutomationProjectCreationContexts()).resolves.toEqual([
      'cowork',
    ]);
  });
});

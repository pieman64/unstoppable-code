import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type { AgentModelRegistryEntry } from '@canopy/desktop-shared/types/agent-models';
import {
  requireLaneAwareDefaultSelection,
  resolveAppAdvisorDefaultModel,
} from '../../lib/default-model-lane-resolver';
import { readPreferencesFile } from '../../lib/preferences-store';
import { isCoworkWorkspace } from '../../lib/workspace-registry';
import {
  refreshCatalogAgentDefaults,
  resetCatalogAgentDefaultModelsForTests,
  resolveAgentDestinationDefaultModel,
  resolveCatalogAgentDefaultModel,
  resolveSendModelPin,
} from '../agent-default-model';

jest.mock('../../lib/default-model-lane-resolver', () => ({
  requireLaneAwareDefaultSelection: jest.fn(),
  resolveAppAdvisorDefaultModel: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(),
}));
const mockNotifyCatalogChanged = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalModelCatalogChanged: (): Promise<void> =>
    mockNotifyCatalogChanged(),
}));

const mockLaneDefault = jest.mocked(requireLaneAwareDefaultSelection);
const mockAppAdvisorDefault = jest.mocked(resolveAppAdvisorDefaultModel);
const mockPreferences = jest.mocked(readPreferencesFile);
const mockIsCowork = jest.mocked(isCoworkWorkspace);

beforeEach(() => {
  jest.clearAllMocks();
  mockPreferences.mockResolvedValue(
    {} as Awaited<ReturnType<typeof readPreferencesFile>>,
  );
  mockIsCowork.mockReturnValue(false);
  mockLaneDefault.mockResolvedValue({
    providerType: 'codex',
    model: 'gpt-5.5',
    thinkingLevel: 'high',
  });
});

describe('resolveAgentDestinationDefaultModel', () => {
  it('uses the model a new App Advisor chat starts on', async () => {
    mockAppAdvisorDefault.mockResolvedValue('claude-sonnet-4-6');

    await expect(
      resolveAgentDestinationDefaultModel(APP_ADVISOR_PROJECT_ID),
    ).resolves.toBe('claude-sonnet-4-6');
    expect(mockLaneDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['a Cowork workspace', 'cowork-1', true, 'chat'],
    ['the Pipeline Assistant', PIPELINE_EDITOR_PROJECT_ID, false, 'chat'],
    ['a worktree project', 'project-1', false, 'worktree'],
  ])(
    'uses the lane %s chats start on',
    async (_destination, projectId, cowork, lane) => {
      mockIsCowork.mockReturnValue(cowork);

      await expect(
        resolveAgentDestinationDefaultModel(projectId),
      ).resolves.toBe('gpt-5.5');
      expect(mockLaneDefault).toHaveBeenCalledWith(
        expect.anything(),
        lane,
        { workspaceId: projectId },
        undefined,
        false,
      );
    },
  );
});

describe('resolveSendModelPin', () => {
  function agent(id: string, baseModel: string): AgentModelRegistryEntry {
    return {
      id,
      name: id,
      baseModel,
      instructions: '',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z',
      available: true,
    };
  }

  beforeAll(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT-5.5' }]);
  });

  beforeEach(() => {
    initAgentModels([
      agent('agent_model_inherit', 'default'),
      agent('agent_model_pinned', 'gpt-5.5'),
    ]);
  });

  afterEach(() => {
    initAgentModels([]);
  });

  it.each([
    ['the request names it', undefined, 'agent_model_inherit'],
    ['only the chat stores it', 'agent_model_inherit', undefined],
  ])(
    'pins an Agent on the default model when %s',
    async (_case, stored, requested) => {
      await expect(
        resolveSendModelPin('project-1', stored, requested),
      ).resolves.toBe('agent_model_inherit@gpt-5.5');
    },
  );

  it('keeps the route a chat already holds without reading Settings', async () => {
    await expect(
      resolveSendModelPin(
        'project-1',
        'agent_model_inherit@claude-sonnet-4-6',
        'agent_model_inherit',
      ),
    ).resolves.toBe('agent_model_inherit@claude-sonnet-4-6');
    expect(mockLaneDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['a provider model', undefined, 'gpt-5.5'],
    ['a pinned Agent', 'agent_model_pinned', undefined],
    [
      'a stored route whose Agent now has its own base',
      'agent_model_pinned@gpt-5.5',
      undefined,
    ],
    ['no model at all', undefined, undefined],
  ])('leaves %s alone', async (_case, stored, requested) => {
    await expect(
      resolveSendModelPin('project-1', stored, requested),
    ).resolves.toBeUndefined();
    expect(mockLaneDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['requested', undefined, 'agent_model_inherit@removed-model'],
    ['stored', 'agent_model_inherit@removed-model', undefined],
  ])(
    'refuses a %s route whose model is no longer available',
    async (_case, stored, requested) => {
      await expect(
        resolveSendModelPin('project-1', stored, requested),
      ).rejects.toThrow(
        'Agent "agent_model_inherit" is set to unavailable model "removed-model".',
      );
    },
  );

  it('refuses a route the chat keeps once its model is no longer available', async () => {
    await expect(
      resolveSendModelPin(
        'project-1',
        'agent_model_inherit@removed-model',
        'agent_model_inherit',
      ),
    ).rejects.toThrow('is set to unavailable model "removed-model"');
    expect(mockLaneDefault).not.toHaveBeenCalled();
  });

  it('refuses a route pinned to a default an Agent cannot run on', async () => {
    mockLaneDefault.mockResolvedValue({
      providerType: 'codex',
      model: 'removed-default',
      thinkingLevel: 'high',
    });
    await expect(
      resolveSendModelPin('project-1', undefined, 'agent_model_inherit'),
    ).rejects.toThrow('is set to unavailable model "removed-default"');
  });

  it('refuses a supplied route for an Agent with its own base', async () => {
    await expect(
      resolveSendModelPin('project-1', undefined, 'agent_model_pinned@gpt-5.5'),
    ).rejects.toThrow('has its own base model');
  });

  it('refuses a default that is itself an Agent', async () => {
    mockLaneDefault.mockResolvedValue({
      providerType: 'claude',
      model: 'agent_model_pinned',
      thinkingLevel: 'high',
    });
    await expect(
      resolveSendModelPin('project-1', 'agent_model_inherit', undefined),
    ).rejects.toThrow('the default model is an Agent');
  });
});

describe('resolveCatalogAgentDefaultModel', () => {
  beforeEach(() => {
    resetCatalogAgentDefaultModelsForTests();
    initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T00:00:00.000Z',
        available: true,
      },
    ]);
  });

  afterEach(() => {
    initAgentModels([]);
  });

  it('resolves no default while no Agent uses one', async () => {
    initAgentModels([]);
    await expect(
      resolveCatalogAgentDefaultModel('project-1'),
    ).resolves.toBeUndefined();
    expect(mockLaneDefault).not.toHaveBeenCalled();
  });

  it('answers each destination with its own default', async () => {
    mockIsCowork.mockImplementation((projectId) => projectId === 'cowork-1');
    mockLaneDefault.mockImplementation((_preferences, lane) =>
      Promise.resolve({
        providerType: lane === 'chat' ? 'claude' : 'codex',
        model: lane === 'chat' ? 'claude-sonnet-4-6' : 'gpt-5.5',
        thinkingLevel: 'high',
      }),
    );
    mockAppAdvisorDefault.mockResolvedValue('claude-haiku-4-5');

    await expect(resolveCatalogAgentDefaultModel('cowork-1')).resolves.toBe(
      'claude-sonnet-4-6',
    );
    await expect(resolveCatalogAgentDefaultModel('project-1')).resolves.toBe(
      'gpt-5.5',
    );
    await expect(
      resolveCatalogAgentDefaultModel(APP_ADVISOR_PROJECT_ID),
    ).resolves.toBe('claude-haiku-4-5');
  });

  it('follows a default-model setting change at once', async () => {
    mockLaneDefault.mockResolvedValueOnce({
      providerType: 'codex',
      model: 'gpt-5.5',
      thinkingLevel: 'high',
    });
    await expect(resolveCatalogAgentDefaultModel('project-1')).resolves.toBe(
      'gpt-5.5',
    );
    mockLaneDefault.mockResolvedValueOnce({
      providerType: 'claude',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'high',
    });

    await refreshCatalogAgentDefaults({ defaultWorktreeProvider: 'claude' });

    expect(mockNotifyCatalogChanged).toHaveBeenCalledTimes(1);
    await expect(resolveCatalogAgentDefaultModel('project-1')).resolves.toBe(
      'claude-sonnet-4-6',
    );
  });

  it('leaves catalogs alone for an unrelated setting change', async () => {
    await refreshCatalogAgentDefaults({ closeToTray: true });
    expect(mockNotifyCatalogChanged).not.toHaveBeenCalled();
  });

  it('describes no default when the destination has none it can use', async () => {
    mockLaneDefault.mockRejectedValue(new Error('No dispatchable model'));
    await expect(
      resolveCatalogAgentDefaultModel('project-1'),
    ).resolves.toBeUndefined();
  });
});

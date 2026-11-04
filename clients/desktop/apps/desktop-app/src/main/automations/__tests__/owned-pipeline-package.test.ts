const mockFindActivity = jest.fn();
jest.mock('../service', () => ({
  getAutomationsService: (): unknown => ({
    findActivityForBackgroundAuthorization: mockFindActivity,
  }),
}));
jest.mock('../owned-pipeline', () => ({
  ownedPipelineId: jest.fn(),
}));
jest.mock('../owned-chat-projection', () => ({
  projectOwnedChatAutomation: jest.fn(),
}));
jest.mock('../../pipelines/pipeline-package-service', () => ({
  resolveInstalledAutomationPackageOverlay: jest.fn(),
  repinAutomationCapabilityPackageContent: jest.fn(),
}));
jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    loadExecutionState: jest.fn(),
  }),
);
jest.mock('../../lib/paths', () => ({
  getDataDir: (): string => '/data',
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { createHash } from 'node:crypto';
import {
  CHAT_AUTOMATION_JOB,
  chatAutomationToPipeline,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { loadExecutionState } from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { projectOwnedChatAutomation } from '../owned-chat-projection';
import { ownedPipelineId } from '../owned-pipeline';
import {
  CHAT_AUTOMATION_SEND_STEP,
  ownedPipelineSendPackageOverlay,
  repinConvertedPackageInstall,
  verifyOwnedPipelinePackage,
  type OwnedPipelineSendCaller,
} from '../owned-pipeline-package';
import {
  repinAutomationCapabilityPackageContent,
  resolveInstalledAutomationPackageOverlay,
} from '../../pipelines/pipeline-package-service';

const capabilityPackage = {
  version: 1 as const,
  digest: `pp:v1:${'A'.repeat(43)}`,
};
const overlay = { packageDigest: capabilityPackage.digest, resources: [] };
const chatAction: AutomationAction = {
  type: 'standalone_prompt',
  chatProjectId: 'cowork-1',
  prompt: 'Organize notes',
};
const pipelineAction: AutomationAction = {
  type: 'worktree_pipeline',
  target: { kind: 'global' },
  pipelineId: 'owned-1',
  pipelineSource: 'user',
  inputs: { project_id: 'cowork-1' },
};

function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'auto-1',
    name: 'Morning check',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: pipelineAction,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    failureCount: 0,
    installedFrom: {
      remoteId: 'share-1',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-10-30T00:00:00.000Z',
      capabilityPackage,
    },
    ...overrides,
  };
}

function sendCaller(
  overrides: Partial<OwnedPipelineSendCaller> = {},
): OwnedPipelineSendCaller {
  return {
    executionId: 'exec-1',
    pipelineId: 'owned-1',
    jobId: CHAT_AUTOMATION_JOB,
    stepId: CHAT_AUTOMATION_SEND_STEP,
    initiator: { kind: 'automation', automationId: 'auto-1' },
    ...overrides,
  };
}

function state(parentExecutionId?: string): ExecutionState {
  return {
    id: 'exec-1',
    ...(parentExecutionId !== undefined
      ? { parent_execution_id: parentExecutionId }
      : {}),
  } as unknown as ExecutionState;
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

beforeEach(() => {
  jest.resetAllMocks();
  mockFindActivity.mockResolvedValue(activity());
  jest
    .mocked(ownedPipelineId)
    .mockImplementation((entry) =>
      entry.action.type === 'worktree_pipeline'
        ? entry.action.pipelineId
        : undefined,
    );
  jest.mocked(loadExecutionState).mockResolvedValue(state());
  jest
    .mocked(resolveInstalledAutomationPackageOverlay)
    .mockResolvedValue(overlay);
});

describe('the converted send step', () => {
  it('is the step the converter generates', () => {
    const { pipeline } = chatAutomationToPipeline({
      name: 'Morning check',
      action: chatAction,
    });
    expect(
      pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps.find(
        (step) => step.id === CHAT_AUTOMATION_SEND_STEP,
      )?.uses,
    ).toBe('builtin/send-agent-message');
  });
});

describe('ownedPipelineSendPackageOverlay (CAN-5479)', () => {
  it('resolves the install’s package for its generated send in a top-level run', async () => {
    await expect(ownedPipelineSendPackageOverlay(sendCaller())).resolves.toBe(
      overlay,
    );
    expect(mockFindActivity).toHaveBeenCalledWith('auto-1');
    expect(loadExecutionState).toHaveBeenCalledWith(
      'exec-1',
      '/data/pipeline-executions',
    );
    expect(resolveInstalledAutomationPackageOverlay).toHaveBeenCalledWith(
      'auto-1',
      capabilityPackage,
    );
  });

  it.each<[string, Partial<OwnedPipelineSendCaller>]>([
    ['a person', { initiator: { kind: 'user' } }],
    ['another step', { stepId: 'reply' }],
    ['another job', { jobId: 'build' }],
    ['a matrix child', { childId: 'child-1' }],
    ['another pipeline', { pipelineId: 'other' }],
  ])('applies none to a run of %s', async (_label, overrides) => {
    await expect(
      ownedPipelineSendPackageOverlay(sendCaller(overrides)),
    ).resolves.toBeUndefined();
    expect(resolveInstalledAutomationPackageOverlay).not.toHaveBeenCalled();
  });

  it.each<[string, ScheduledActivity | undefined]>([
    ['a deleted automation', undefined],
    ['an automation with no package', activity({ installedFrom: undefined })],
    [
      'a session prompt',
      activity({
        action: {
          ...pipelineAction,
          inputs: { project_id: 'p', task_id: 't', chat_id: 'c' },
        },
      }),
    ],
  ])('applies none for %s', async (_label, found) => {
    mockFindActivity.mockResolvedValue(found);
    await expect(
      ownedPipelineSendPackageOverlay(sendCaller()),
    ).resolves.toBeUndefined();
    expect(resolveInstalledAutomationPackageOverlay).not.toHaveBeenCalled();
  });

  it('applies none to a nested run', async () => {
    jest.mocked(loadExecutionState).mockResolvedValue(state('parent-1'));
    await expect(
      ownedPipelineSendPackageOverlay(sendCaller()),
    ).resolves.toBeUndefined();
    expect(resolveInstalledAutomationPackageOverlay).not.toHaveBeenCalled();
  });

  it('refuses a run whose state it can’t read, rather than send without the package', async () => {
    jest.mocked(loadExecutionState).mockResolvedValue(null);
    await expect(ownedPipelineSendPackageOverlay(sendCaller())).rejects.toThrow(
      'could not be read',
    );
  });

  it('fails as the native prompt did when the package isn’t intact', async () => {
    jest
      .mocked(resolveInstalledAutomationPackageOverlay)
      .mockRejectedValue(new Error('Reinstall the automation.'));
    await expect(ownedPipelineSendPackageOverlay(sendCaller())).rejects.toThrow(
      'Reinstall the automation.',
    );
  });
});

describe('verifyOwnedPipelinePackage (CAN-5479)', () => {
  it('verifies a converted install’s package', async () => {
    jest
      .mocked(resolveInstalledAutomationPackageOverlay)
      .mockRejectedValue(new Error('Reinstall the automation.'));
    await expect(verifyOwnedPipelinePackage(activity())).rejects.toThrow(
      'Reinstall the automation.',
    );
  });

  it('checks nothing for a pipeline the automation doesn’t own', async () => {
    jest.mocked(ownedPipelineId).mockReturnValue(undefined);
    await verifyOwnedPipelinePackage(activity());
    expect(resolveInstalledAutomationPackageOverlay).not.toHaveBeenCalled();
  });
});

describe('repinConvertedPackageInstall (CAN-5479)', () => {
  const native = activity({ action: chatAction });
  const converted = activity();
  const shown = {
    ...converted,
    action: { ...chatAction, chatProjectId: 'cowork-1' },
  };

  it('repins the install from the native action to the one it shows', async () => {
    // The projection builds the action anew, in its own key order.
    const reordered: AutomationAction = {
      type: 'standalone_prompt',
      prompt: 'Organize notes',
      chatProjectId: 'cowork-1',
    };
    jest
      .mocked(projectOwnedChatAutomation)
      .mockReturnValue({ ...shown, action: reordered });
    await repinConvertedPackageInstall(native, converted);
    expect(repinAutomationCapabilityPackageContent).toHaveBeenCalledWith(
      'auto-1',
      sha256(JSON.stringify({ name: 'Morning check', action: chatAction })),
      sha256(JSON.stringify({ name: 'Morning check', action: reordered })),
    );
  });

  it('leaves the pin of an install without a package, or one it can’t show as a chat', async () => {
    jest.mocked(projectOwnedChatAutomation).mockReturnValue(converted);
    await repinConvertedPackageInstall(native, converted);
    await repinConvertedPackageInstall(
      { ...native, installedFrom: undefined },
      converted,
    );
    expect(repinAutomationCapabilityPackageContent).not.toHaveBeenCalled();
  });

  it('keeps the automation converted when the pin can’t move', async () => {
    jest.mocked(projectOwnedChatAutomation).mockImplementation(() => {
      throw new Error('unreadable');
    });
    await expect(
      repinConvertedPackageInstall(native, converted),
    ).resolves.toBeUndefined();
  });
});

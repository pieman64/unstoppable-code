import type { PipelineDefinition } from '@canopy/protocol/canopy-core';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';

const mockInstruction = jest.fn();
jest.mock('../desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({ instruction: mockInstruction }),
}));
const mockStored = jest.fn();
jest.mock('../../pipelines/pipeline-service', () => ({
  getStoredPipelineBySource: (...args: unknown[]): unknown =>
    mockStored(...args),
}));

// CAN-4551: a saved pipeline an automation owns republishes automations.
const mockOwnerAutomationId = jest.fn((): string | undefined => undefined);
jest.mock('../../pipelines/pipeline-local-metadata-store', () => ({
  readPipelineLocalMetadata: (): { ownerAutomationId?: string } => {
    const ownerAutomationId = mockOwnerAutomationId();
    return ownerAutomationId === undefined ? {} : { ownerAutomationId };
  },
}));
const mockRepublish = jest.fn(() => Promise.resolve());
jest.mock('../../automations/service', () => ({
  getAutomationsService: (): object => ({ republish: mockRepublish }),
}));

import { saveUserPipeline } from '../pipeline-definition-dispatch';

const content = {
  name: 'Mine',
  on: 'dispatch' as const,
  jobs: { build: { steps: [{ run: 'echo a' }, { run: 'echo b' }] } },
};

function definition(revision: number): PipelineDefinition {
  return {
    definitionId: 'pipe-1',
    scope: {},
    source: 'user',
    owner: 'personal',
    name: 'Mine',
    description: '',
    icon: '',
    enabled: true,
    readonly: false,
    format: 'yaml',
    revision,
    checksum: 'sha256:x',
    triggerTypes: ['dispatch'],
    executionScopes: ['directory'],
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T01:00:00.000Z',
    document: 'pipeline: {}',
    normalized: null,
    diagnostics: [],
  };
}

it('answers with the revision core saved, even if another writer saved after it', async () => {
  mockInstruction.mockResolvedValue({ definition: definition(2) });
  const newer: PipelineData = {
    info: {
      id: 'pipe-1',
      name: 'Theirs',
      filename: 'pipe-1.yaml',
      description: 'other edit',
      icon: '',
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T02:00:00.000Z',
      revision: 3,
      source: 'user',
      readonly: false,
    },
    content: { ...content, name: 'Theirs' },
  };
  mockStored.mockReturnValue({ success: true, data: newer });

  const result = await saveUserPipeline({
    id: 'pipe-1',
    expectedRevision: 1,
    name: 'Mine',
    description: '',
    icon: '',
    content,
  });

  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({
    id: 'pipe-1',
    filename: 'pipe-1.yaml',
    name: 'Mine',
    revision: 2,
    updatedAt: '2026-10-28T01:00:00.000Z',
    stepCount: 2,
    source: 'user',
    readonly: false,
  });
});

describe('a saved pipeline an automation owns (CAN-4551)', () => {
  const write = {
    id: 'pipe-1',
    name: 'Mine',
    description: '',
    icon: '',
    content,
  };
  const flush = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    mockInstruction.mockResolvedValue({ definition: definition(2) });
    mockStored.mockReturnValue({ success: false });
    mockRepublish.mockClear();
  });

  it('sends the automations snapshot again, so an open editor sees it', async () => {
    mockOwnerAutomationId.mockReturnValueOnce('activity-1');
    await saveUserPipeline(write);
    await flush();
    expect(mockRepublish).toHaveBeenCalledTimes(1);
  });

  it('leaves automations alone for a pipeline no automation owns', async () => {
    await saveUserPipeline(write);
    await flush();
    expect(mockRepublish).not.toHaveBeenCalled();
  });
});

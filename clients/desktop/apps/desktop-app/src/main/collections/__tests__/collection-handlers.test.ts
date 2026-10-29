import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';

jest.mock('electron', () => ({ BrowserWindow: {} }));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import {
  inspectSharedCollectionImport,
  resolveCollectionMcpRequirements,
} from '../collection-handlers';

const MCP_REQUIREMENT: PipelinePackageEnvironmentRequirement = {
  id: 'linear',
  kind: 'mcp',
  displayName: 'linear',
  required: true,
  affectedSteps: [],
  setupHint: 'Connect Linear.',
};

describe('resolveCollectionMcpRequirements', () => {
  it('falls back to name matching and leaves missing setup non-blocking', async () => {
    const byCatalogId = jest.fn().mockResolvedValue(null);
    const byName = jest
      .fn()
      .mockResolvedValueOnce({
        serverId: 'server-linear',
        configs: [{ configId: 'config-linear' }],
      })
      .mockResolvedValueOnce(null);
    const missing = { ...MCP_REQUIREMENT, id: 'other', displayName: 'Other' };

    await expect(
      resolveCollectionMcpRequirements([MCP_REQUIREMENT, missing], {
        byCatalogId,
        byName,
      }),
    ).resolves.toEqual({
      mcpServerRefs: [{ serverId: 'server-linear', configId: 'config-linear' }],
      unmetRequirements: [missing],
    });
    expect(byCatalogId).toHaveBeenCalledTimes(2);
    expect(byName).toHaveBeenCalledTimes(2);
  });
});

describe('inspectSharedCollectionImport', () => {
  it('probes every package requirement before the install review', async () => {
    const collection = {
      id: 'collection-1',
      package: {
        digest: `pp:v1:${'A'.repeat(43)}`,
        version: 1 as const,
        resources: [],
        environmentRequirements: [MCP_REQUIREMENT],
        totalFiles: 0,
        totalBytes: 0,
      },
    };
    const getCollection = jest.fn().mockResolvedValue(collection);
    const probeRequirement = jest.fn().mockResolvedValue({
      ...MCP_REQUIREMENT,
      status: 'missing',
      detail: 'Connect Linear.',
    });

    await expect(
      inspectSharedCollectionImport('collection-1', {
        getCollection,
        probeRequirement,
      }),
    ).resolves.toEqual({
      collection,
      requirements: [
        expect.objectContaining({ id: 'linear', status: 'missing' }),
      ],
    });
    expect(getCollection).toHaveBeenCalledWith('collection-1');
    expect(probeRequirement).toHaveBeenCalledWith(MCP_REQUIREMENT);
  });
});

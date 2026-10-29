import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { isLocalMemoryModelBlockedByPolicy } from '../memory/local/model-policy';
import { resolveHelperWorkOwner } from '../ollama/helper-invocation';

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: jest.fn(),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn(() => false),
}));

describe('local memory model policy owner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves the owner from the workspace when none is given', async () => {
    const personal: WorkOwner = { kind: 'personal' };
    jest.mocked(resolveHelperWorkOwner).mockResolvedValue(personal);
    await isLocalMemoryModelBlockedByPolicy('opus', 'workspace-1');
    expect(resolveHelperWorkOwner).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
    });
    expect(isModelBlockedByStoredPolicy).toHaveBeenCalledWith('opus', personal);
  });

  it('passes an explicit owner through to owner resolution', async () => {
    const org: WorkOwner = { kind: 'organization', organizationId: 'org-1' };
    jest.mocked(resolveHelperWorkOwner).mockResolvedValue(org);
    await isLocalMemoryModelBlockedByPolicy('opus', 'workspace-1', {
      workOwner: org,
    });
    expect(resolveHelperWorkOwner).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      workOwner: org,
    });
  });
});

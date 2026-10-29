import {
  decideResourceContext,
  type ResourceContextDecision,
  type ResourceContextInput,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { assertAgentContext } from '../agents/resource-lanes';
import { assertPipelineContext } from '../pipelines/resource-lanes';
import { assertSkillContext } from '../skills/resource-lanes';
import { resolveWorkspaceTarget } from '../services/workspace-target';

const org: WorkspaceContext = {
  kind: 'organization',
  organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};
const mockDecide = jest.fn<
  Promise<ResourceContextDecision>,
  [ResourceContextInput]
>((input) => Promise.resolve(decideResourceContext(input)));

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({ isEnabled: (): boolean => true }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    getState: (): unknown => ({ context: org }),
  }),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({
      items: [
        {
          id: 'personal',
          type: 'single-repo',
          name: 'Personal',
          repoPath: '/repo',
          worktrees: [],
        },
      ],
    }),
}));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: (): unknown => ({ decide: mockDecide }),
}));
jest.mock('../services/workspace-target', () => ({
  resolveWorkspaceTarget: jest.fn(() =>
    Promise.resolve({
      workspaceOwner: { kind: 'personal' },
      linkedOrganizationIds: [org.organizationId],
    }),
  ),
}));

beforeEach((): void => {
  jest.clearAllMocks();
});

it.each([
  ['pipeline', assertPipelineContext],
  ['skill', assertSkillContext],
  ['agent', assertAgentContext],
] as const)(
  'authorizes a linked Personal target for the %s family',
  async (_family, assertContext): Promise<void> => {
    await expect(
      assertContext({ owner: { type: 'system' } }, 'personal'),
    ).resolves.toBeUndefined();
    expect(resolveWorkspaceTarget).toHaveBeenCalledWith('personal', {
      organizationId: org.organizationId,
    });
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          workspaceOwner: { kind: 'personal' },
          linkedOrganizationIds: [org.organizationId],
        },
      }),
    );
  },
);

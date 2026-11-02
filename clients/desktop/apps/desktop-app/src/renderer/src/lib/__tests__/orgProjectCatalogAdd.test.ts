import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import {
  addOrgProjectToComputer,
  type OrgProjectAddStore,
} from '@/lib/orgProjectCatalogAdd';
import { startOrgProjectSetupWithGitHubOffer } from '@/lib/orgProjectConnectOffer';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';

jest.mock('@/lib/orgProjectConnectOffer', () => ({
  startOrgProjectSetupWithGitHubOffer: jest.fn(() => Promise.resolve()),
}));

const startWithOffer = jest.mocked(startOrgProjectSetupWithGitHubOffer);

function store(): OrgProjectAddStore & { startSetup: jest.Mock } {
  const startSetup = jest.fn(() => Promise.resolve());
  const state = {
    setPreference: jest.fn(),
    requestSetup: jest.fn(),
    startSetup,
    setupProgress: {},
    accountEpoch: 0,
  };
  return { getState: () => state, subscribe: () => () => {}, startSetup };
}

const project: OrgProjectSummary = {
  id: 'project-a',
  organizationId: 'org-a',
  name: 'Project A',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: null,
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { administer: false, manageCloud: false, use: true },
  instance: null,
};

describe('addOrgProjectToComputer GitHub sign-in (CAN-4466)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], 'org-a');
    (globalThis as { window?: unknown }).window = {
      api: {
        orgProjects: {
          linksList: jest.fn(() =>
            Promise.resolve({ status: 'resolved', links: [] }),
          ),
        },
      },
    };
  });

  async function add(
    target: OrgProjectAddStore,
    offerGitHubConnect?: boolean,
  ): Promise<string> {
    const outcome = await addOrgProjectToComputer(target, {
      context: { kind: 'organization', organizationId: 'org-a' },
      project,
      destination: '/repos',
      ...(offerGitHubConnect === undefined ? {} : { offerGitHubConnect }),
    });
    return outcome.kind;
  }

  it('starts through the sign-in offer when asked', async () => {
    const target = store();
    await expect(add(target, true)).resolves.toBe('setup-started');
    expect(startWithOffer).toHaveBeenCalledWith(target, 'project-a', '/repos');
    expect(target.startSetup).not.toHaveBeenCalled();
  });

  it('starts setup directly otherwise', async () => {
    const target = store();
    await expect(add(target)).resolves.toBe('setup-started');
    expect(target.startSetup).toHaveBeenCalledWith('project-a', '/repos');
    expect(startWithOffer).not.toHaveBeenCalled();
  });

  it('reports a refused start through the offer as a failed setup', async () => {
    startWithOffer.mockRejectedValueOnce(new Error('claim refused'));
    await expect(add(store(), true)).resolves.toBe('setup-failed');
  });
});

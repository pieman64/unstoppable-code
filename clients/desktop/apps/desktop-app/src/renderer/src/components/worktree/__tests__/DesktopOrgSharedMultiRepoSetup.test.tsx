/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import { createFakeClient } from '../../../../../../../../packages/app-state/src/__tests__/fake-org-projects-client';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useSharedMultiRepoRequired } from '../DesktopOrgSharedMultiRepoSetup';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const owner = {
  type: 'organization' as const,
  organizationId: 'org',
  projectId: 'definition',
  instanceId: 'instance',
  bindingGeneration: 0,
};
const project: OrgProjectSummary = {
  id: owner.projectId,
  organizationId: owner.organizationId,
  name: 'Source',
  description: null,
  kind: 'CODE',
  location: 'LOCAL',
  purpose: 'project',
  visibility: 'private',
  memberOwned: true,
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'ADDED',
  listed: true,
  capabilities: { use: true, administer: false, manageCloud: false },
  instance: null,
  topology: 'single-repo',
  repository: {
    provider: 'github',
    host: 'github.com',
    owner: 'org',
    name: 'source',
    providerRepoId: '1',
    defaultBranch: 'main',
    verification: 'VERIFIED',
  },
};
function Probe(): JSX.Element {
  return (
    <span data-testid="mode">
      {useSharedMultiRepoRequired(['source']) ? 'shared' : 'legacy'}
    </span>
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useProjectsStore.setState({
    projects: [
      {
        id: 'source',
        name: 'Source',
        color: '#000000',
        type: 'single-repo',
        repoPath: '/source',
        worktrees: [],
        collapsed: false,
        order: 0,
        owner,
      },
    ],
  });
  useWorkspaceContextStore.setState({
    state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function mount(row: OrgProjectSummary, stale = false): Promise<void> {
  const { client } = createFakeClient();
  act(() =>
    root.render(
      <CanopyClientProvider
        client={{
          ...client,
          sharedMultiRepo: {
            catalog: jest.fn().mockResolvedValue({
              context: 'org:org',
              revision: '1',
              fetchedAt: '2026-10-26T00:00:00.000Z',
              projects: [row],
              stale,
            }),
            prepare: jest.fn(),
            create: jest.fn(),
            getCreation: jest.fn(),
            listCreations: jest.fn(),
            cancelSetup: jest.fn(),
          },
        }}
      >
        <Probe />
      </CanopyClientProvider>,
    ),
  );
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}
test('confirmed private-member sources keep the legacy client path', async () => {
  await mount(project);
  expect(container.textContent).toBe('legacy');
});
test('organization-shared and stale private projections cannot authorize consumption', async () => {
  await mount({ ...project, visibility: 'organization', memberOwned: false });
  expect(container.textContent).toBe('shared');
});
test('a stale catalog does not authorize the private-member path', async () => {
  await mount(project, true);
  expect(container.textContent).toBe('shared');
});

test('Personal-only conversion stays local unless an organization context was explicitly selected', async () => {
  const source = useProjectsStore.getState().projects[0];
  if (!source) throw new Error('Source fixture missing');
  useProjectsStore.setState({ projects: [{ ...source, owner: undefined }] });
  await mount(project);
  expect(container.textContent).toBe('legacy');
  act(() =>
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: 'org' },
        revision: 1,
        organizations: [],
      },
    }),
  );
  expect(container.textContent).toBe('shared');
});

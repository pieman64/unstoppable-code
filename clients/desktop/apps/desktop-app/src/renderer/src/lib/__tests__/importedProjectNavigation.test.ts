import {
  captureProjectImportSubmission,
  openImportedProject,
} from '../importedProjectNavigation';
import { navigateAfterRepositoryWorkspaceCreated } from '../postWorkspaceCreateNavigation';

let context = {
  accountEpoch: 1,
  state: {
    revision: 1,
    context: { kind: 'personal', organizationId: 'org-a' },
  },
  setContext: jest.fn(),
};
jest.mock('@/stores/workspaceContextStore', () => ({
  useWorkspaceContextStore: { getState: (): typeof context => context },
}));
jest.mock('@/components/sidebar/useSidebarScopingContext', () => ({
  getSidebarScopingContext: (): { kind: string } => context.state.context,
}));
jest.mock('@/lib/postWorkspaceCreateNavigation', () => ({
  navigateAfterRepositoryWorkspaceCreated: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  context = {
    accountEpoch: 1,
    state: {
      revision: 1,
      context: { kind: 'personal', organizationId: 'org-a' },
    },
    setContext: jest.fn().mockResolvedValue(undefined),
  };
});

it('navigates to a current import', async () => {
  await openImportedProject(captureProjectImportSubmission(), 'project');
  expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
    'project',
  );
});

it.each(['account', 'revision', 'context'])(
  'does not navigate after %s replacement',
  async (change) => {
    const submission = captureProjectImportSubmission();
    if (change === 'account') context.accountEpoch += 1;
    if (change === 'revision') context.state.revision += 2;
    if (change === 'context')
      context.state.context = { kind: 'organization', organizationId: 'org-b' };
    await openImportedProject(submission, 'side-quest');
    expect(navigateAfterRepositoryWorkspaceCreated).not.toHaveBeenCalled();
  },
);

it('switches an organization import to Personal before navigating', async () => {
  context.state.context = { kind: 'organization', organizationId: 'org-a' };
  await openImportedProject(captureProjectImportSubmission(), 'side-quest');
  expect(context.setContext).toHaveBeenCalledWith({ kind: 'personal' });
  expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
    'side-quest',
  );
});

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

it('threads first-run provenance through current navigation', async () => {
  await openImportedProject(
    captureProjectImportSubmission(),
    'side-quest',
    'most-recent-import',
  );
  expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
    'side-quest',
    'most-recent-import',
  );
});

it('ordinary import callers add no provenance', async () => {
  await openImportedProject(captureProjectImportSubmission(), 'project');
  expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
    'project',
    undefined,
  );
});

it.each(['account', 'revision', 'context'])(
  'does not navigate or label an import after %s replacement',
  async (change) => {
    const submission = captureProjectImportSubmission();
    if (change === 'account') context.accountEpoch += 1;
    if (change === 'revision') context.state.revision += 2;
    if (change === 'context')
      context.state.context = { kind: 'organization', organizationId: 'org-b' };
    await openImportedProject(submission, 'side-quest', 'most-recent-import');
    expect(navigateAfterRepositoryWorkspaceCreated).not.toHaveBeenCalled();
  },
);

it('switches an organization import to Personal before applying the landing reason', async () => {
  context.state.context = { kind: 'organization', organizationId: 'org-a' };
  await openImportedProject(
    captureProjectImportSubmission(),
    'side-quest',
    'most-recent-import',
  );
  expect(context.setContext).toHaveBeenCalledWith({ kind: 'personal' });
  expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
    'side-quest',
    'most-recent-import',
  );
});

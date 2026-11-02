import {
  navigateAfterRepositoryWorkspaceCreated,
  openCreatedMultiRepoWorkspaceSettings,
} from '../postWorkspaceCreateNavigation';
import { recordAutomationCreatedProject } from '@/stores/automationInstallContinuationStore';

const mockClearPendingReference = jest.fn();
const mockOpenWorkspaceSettings = jest.fn();
const mockSelectWorkspace = jest.fn();

jest.mock('@/stores/automationInstallContinuationStore', () => ({
  recordAutomationCreatedProject: jest.fn(),
}));
jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: {
    getState: (): {
      setPendingCreateFromReference: typeof mockClearPendingReference;
      selectWorkspace: typeof mockSelectWorkspace;
      pendingCreateFromReference: null;
    } => ({
      setPendingCreateFromReference: mockClearPendingReference,
      selectWorkspace: mockSelectWorkspace,
      pendingCreateFromReference: null,
    }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): {
      openWorkspaceSettings: typeof mockOpenWorkspaceSettings;
    } => ({ openWorkspaceSettings: mockOpenWorkspaceSettings }),
  },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: { getState: (): { projects: [] } => ({ projects: [] }) },
}));

beforeEach(() => {
  mockSelectWorkspace.mockClear();
});

it('selects the created workspace with no reason by default', (): void => {
  navigateAfterRepositoryWorkspaceCreated('new-project');
  expect(mockSelectWorkspace).toHaveBeenCalledWith('new-project');
});

it('passes a landing reason through to the Home selection (CAN-4674)', (): void => {
  navigateAfterRepositoryWorkspaceCreated('new-project', 'most-recent-import');
  expect(mockSelectWorkspace).toHaveBeenCalledWith('new-project', {
    reason: 'most-recent-import',
  });
});

it('records the automation project and clears its pending reference before opening Repositories', (): void => {
  const effects: string[] = [];
  jest.mocked(recordAutomationCreatedProject).mockImplementation((): void => {
    effects.push('record');
  });
  mockClearPendingReference.mockImplementation((): void => {
    effects.push('clear');
  });
  mockOpenWorkspaceSettings.mockImplementation((): void => {
    effects.push('settings');
  });

  openCreatedMultiRepoWorkspaceSettings('new-project');

  expect(recordAutomationCreatedProject).toHaveBeenCalledWith('new-project');
  expect(mockClearPendingReference).toHaveBeenCalledWith(null);
  expect(mockOpenWorkspaceSettings).toHaveBeenCalledWith({
    workspaceId: 'new-project',
    initialTab: 'repositories',
  });
  expect(effects).toEqual(['record', 'clear', 'settings']);
});

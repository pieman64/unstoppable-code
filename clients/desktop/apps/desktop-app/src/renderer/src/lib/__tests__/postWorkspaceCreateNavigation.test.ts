import { openCreatedMultiRepoWorkspaceSettings } from '../postWorkspaceCreateNavigation';
import { recordAutomationCreatedProject } from '@/stores/automationInstallContinuationStore';

const mockClearPendingReference = jest.fn();
const mockOpenWorkspaceSettings = jest.fn();

jest.mock('@/stores/automationInstallContinuationStore', () => ({
  recordAutomationCreatedProject: jest.fn(),
}));
jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: {
    getState: (): {
      setPendingCreateFromReference: typeof mockClearPendingReference;
    } => ({
      setPendingCreateFromReference: mockClearPendingReference,
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
jest.mock('@/stores/projectsStore', () => ({ useProjectsStore: {} }));

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

/* eslint-disable @typescript-eslint/explicit-function-return-type */
const mockCreateWorkEntryInProject = jest.fn(() => Promise.resolve());
const mockDismissColdStart = jest.fn();
let mockChatProjects: Array<{ id: string }> = [];
const mockSelectWorkspace = jest.fn();
const mockSetMode = jest.fn();
const mockNavigate = jest.fn();

jest.mock('@/lib/dismissPageLikeViewers', () => ({
  dismissPageLikeViewers: jest.fn(),
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: () => ({ addToast: jest.fn() }),
  },
}));
jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: {
    getState: () => ({
      selectWorkspace: mockSelectWorkspace,
      setMode: mockSetMode,
    }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({ navigate: mockNavigate }),
  },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: () => ({
      chatProjects: mockChatProjects,
      createWorkEntryInProject: mockCreateWorkEntryInProject,
      dismissColdStart: mockDismissColdStart,
    }),
  },
}));

import { openNewCoworkTaskFromSidebar } from '../openNewCoworkTaskFromSidebar';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgDefaultId = `cowork-org-${organizationId}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockChatProjects = [];
});

it('passes the requested group to the existing Cowork creation owner', () => {
  openNewCoworkTaskFromSidebar('team-notes', {
    sidebarItemGroupId: 'grp-notes',
  });
  expect(mockCreateWorkEntryInProject).toHaveBeenCalledWith('team-notes', {
    sidebarItemGroupId: 'grp-notes',
  });
});

it('opens the Home composer immediately while an organization default is pending', () => {
  mockChatProjects = [{ id: orgDefaultId }];

  openNewCoworkTaskFromSidebar(orgDefaultId, { pending: true });

  expect(mockSelectWorkspace).toHaveBeenCalledWith(orgDefaultId);
  expect(mockSetMode).toHaveBeenCalledWith('chat');
  expect(mockNavigate).toHaveBeenCalledWith('home');
  expect(mockCreateWorkEntryInProject).not.toHaveBeenCalled();
});

it.each([
  ['an already materialized organization default', orgDefaultId],
  ['an ordinary Cowork workspace', 'team-notes'],
])('uses the ordinary Work Entry flow for %s', (_label, projectId) => {
  mockChatProjects = [{ id: projectId }];

  openNewCoworkTaskFromSidebar(projectId);

  expect(mockCreateWorkEntryInProject).toHaveBeenCalledWith(projectId);
  expect(mockNavigate).toHaveBeenCalledWith('chat');
  expect(mockSelectWorkspace).not.toHaveBeenCalled();
});

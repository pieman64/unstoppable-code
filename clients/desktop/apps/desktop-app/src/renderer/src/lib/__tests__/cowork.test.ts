import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type CoworkSidebarItem,
  type SidebarItem,
  type SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { isCoworkChatTarget, isCoworkWorkspaceId } from '../cowork';
import { registerCoworkWorkspaceIds } from '../cowork-registry';

function makeCoworkItem(id: string): CoworkSidebarItem {
  return {
    type: 'cowork',
    id,
    name: 'Cowork',
    color: '#000000',
    collapsed: false,
    order: 0,
  };
}

function makeSingleRepoItem(id: string): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id,
    name: 'Project',
    repoPath: '/workspace',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
  };
}

describe('isCoworkChatTarget', () => {
  afterEach(() => {
    registerCoworkWorkspaceIds([]);
  });

  it('returns true for the standalone chat sentinel', () => {
    expect(isCoworkChatTarget(STANDALONE_CHAT_PROJECT_ID)).toBe(true);
  });

  it('returns true for a registered cowork project id', () => {
    registerCoworkWorkspaceIds(['cowork-workspace-1']);
    expect(isCoworkChatTarget('cowork-workspace-1')).toBe(true);
  });

  it('returns true for a pending organization default before registration', () => {
    expect(
      isCoworkChatTarget('cowork-org-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).toBe(true);
  });

  it('returns true for App Advisor without consulting the registry', () => {
    // The registry is cleared during projectsStore synchronization, so App
    // Advisor must match against the constant directly.
    registerCoworkWorkspaceIds([]);
    expect(isCoworkChatTarget(APP_ADVISOR_PROJECT_ID)).toBe(true);
  });

  it('returns false for a regular project id', () => {
    expect(isCoworkChatTarget('project')).toBe(false);
  });

  it('returns false for a single/multi-repo id that is not registered', () => {
    registerCoworkWorkspaceIds(['cowork-workspace-1']);
    expect(isCoworkChatTarget('single-repo-project')).toBe(false);
  });
});

describe('isCoworkWorkspaceId', () => {
  it('returns true when the project id matches a cowork sidebar item', () => {
    const projects: SidebarItem[] = [
      makeCoworkItem('cowork-workspace-1'),
      makeSingleRepoItem('project'),
    ];
    expect(isCoworkWorkspaceId('cowork-workspace-1', projects)).toBe(true);
  });

  it('returns false for a single/multi-repo id', () => {
    const projects: SidebarItem[] = [
      makeCoworkItem('cowork-workspace-1'),
      makeSingleRepoItem('project'),
    ];
    expect(isCoworkWorkspaceId('project', projects)).toBe(false);
  });

  it('returns false for an id absent from the list', () => {
    expect(isCoworkWorkspaceId('missing', [])).toBe(false);
  });
});

import {
  APP_ADVISOR_PROJECT_ID,
  type CoworkSidebarItem,
  type CoworkWorkEntryMeta,
  type SingleRepoSidebarItem,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  describeLedgerScope,
  ledgerFeedAddableScopes,
  type LedgerFeedScopeSources,
} from '../ledger-feed-scopes';

function worktree(
  id: string,
  branchName: string,
  label?: string,
): WorktreeData {
  return {
    id,
    branchName,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...(label === undefined ? {} : { label }),
  };
}

const CODE: SingleRepoSidebarItem = {
  type: 'single-repo',
  id: 'project-1',
  name: 'Canopy',
  repoPath: '/workspace',
  color: '#000000',
  collapsed: false,
  order: 0,
  worktrees: [
    worktree('wt-1', 'fix-parser'),
    worktree('wt-2', 'tirish/cache', 'Cache rework'),
  ],
};

const COWORK: CoworkSidebarItem = {
  type: 'cowork',
  id: 'cowork-1',
  name: 'Research',
  color: '#000000',
  collapsed: false,
  order: 1,
};

function entry(id: string, title: string): CoworkWorkEntryMeta {
  return { id, title, createdAt: '2026-10-01T10:00:00.000Z', chatCount: 1 };
}

const SOURCES: LedgerFeedScopeSources = {
  projects: [CODE, COWORK],
  coworkEntries: { 'cowork-1': [entry('entry-1', 'Vendor survey')] },
};

describe('describeLedgerScope', () => {
  it('names a worktree or task under its project, as the sidebar does', () => {
    expect(
      describeLedgerScope(
        { projectId: 'project-1', worktreeId: 'wt-1' },
        SOURCES,
      ),
    ).toBe('Canopy · fix-parser');
    expect(
      describeLedgerScope(
        { projectId: 'project-1', worktreeId: 'wt-2' },
        SOURCES,
      ),
    ).toBe('Canopy · Cache rework');
    expect(
      describeLedgerScope(
        { projectId: 'cowork-1', worktreeId: 'entry-1' },
        SOURCES,
      ),
    ).toBe('Research · Vendor survey');
  });

  it('falls back to the project, or nothing, when this device does not list it', () => {
    expect(
      describeLedgerScope(
        { projectId: 'project-1', worktreeId: 'gone' },
        SOURCES,
      ),
    ).toBe('Canopy');
    expect(
      describeLedgerScope(
        { projectId: 'unknown', worktreeId: 'wt-1' },
        SOURCES,
      ),
    ).toBeNull();
    expect(
      describeLedgerScope(
        { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry-9' },
        SOURCES,
      ),
    ).toBe('Advisor');
  });
});

describe('ledgerFeedAddableScopes', () => {
  it('offers every worktree and task, in sidebar order', () => {
    expect(ledgerFeedAddableScopes(SOURCES)).toEqual([
      {
        scope: { projectId: 'project-1', worktreeId: 'wt-1' },
        label: 'fix-parser',
        project: 'Canopy',
      },
      {
        scope: { projectId: 'project-1', worktreeId: 'wt-2' },
        label: 'Cache rework',
        project: 'Canopy',
      },
      {
        scope: { projectId: 'cowork-1', worktreeId: 'entry-1' },
        label: 'Vendor survey',
        project: 'Research',
      },
    ]);
  });
});

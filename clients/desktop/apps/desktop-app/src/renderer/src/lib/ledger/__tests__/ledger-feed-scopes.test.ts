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

const ORG_ID = '7f0c1d2e-3b4a-4c5d-8e6f-901234567890';

const SOURCES: LedgerFeedScopeSources = {
  projects: [CODE, COWORK],
  coworkEntries: { 'cowork-1': [entry('entry-1', 'Vendor survey')] },
  organizations: [{ id: ORG_ID, name: 'Acme Robotics', role: 'MEMBER' }],
};

const LEDGER_ID = '0b9d7c5a-1e2f-4a3b-9c8d-7e6f5a4b3c2d';

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
    ).toBe('Orchestrator');
  });
});

describe('describeLedgerScope for global (workflow) scopes', () => {
  it('names a Personal workflow scope', () => {
    expect(
      describeLedgerScope(
        { kind: 'global', owner: { kind: 'personal' }, ledgerId: LEDGER_ID },
        SOURCES,
      ),
    ).toBe('Workflows · Personal');
  });

  it("names an organization's workflow scope from the account's organizations", () => {
    expect(
      describeLedgerScope(
        {
          kind: 'global',
          owner: { kind: 'organization', organizationId: ORG_ID },
          ledgerId: LEDGER_ID,
        },
        SOURCES,
      ),
    ).toBe('Workflows · Acme Robotics');
  });

  it('reads as Workflows alone for an organization the account no longer has', () => {
    expect(
      describeLedgerScope(
        {
          kind: 'global',
          owner: {
            kind: 'organization',
            organizationId: '11111111-2222-4333-8444-555555555555',
          },
          ledgerId: LEDGER_ID,
        },
        SOURCES,
      ),
    ).toBe('Workflows');
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

import {
  APP_ADVISOR_PROJECT_ID,
  type AutomationAction,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  automationRunsInLabel,
  indexProjectsById,
  isAutomationInContext,
  isSharedAutomationInContext,
  isWatcherInContext,
  isWorkspaceInContext,
  workspaceContextLabel,
  workspaceOwnerContext,
} from '../automationContextScope';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSONAL: WorkspaceContext = { kind: 'personal' };
const ORG_A_CONTEXT: WorkspaceContext = {
  kind: 'organization',
  organizationId: ORG_A,
};

function orgOwner(organizationId: string): {
  type: 'organization';
  organizationId: string;
  projectId: string;
  instanceId: string;
  bindingGeneration: number;
} {
  return {
    type: 'organization',
    organizationId,
    projectId: '11111111-1111-4111-8111-111111111111',
    instanceId: '22222222-2222-4222-8222-222222222222',
    bindingGeneration: 0,
  };
}

const projects = [
  { id: 'chats', owner: undefined },
  { id: 'linked', owner: undefined },
  { id: 'org-a', owner: orgOwner(ORG_A) },
  { id: 'org-b', owner: orgOwner(ORG_B) },
];
const byId = indexProjectsById(projects);
const linked = new Set(['linked']);
const noLinks = new Set<string>();

function coworkAction(chatProjectId: string): AutomationAction {
  return { type: 'standalone_prompt', chatProjectId, prompt: 'hi' };
}

function worktreeAction(workspaceId: string): AutomationAction {
  return { type: 'worktree_pipeline', workspaceId, pipelineId: 'pipeline' };
}

const appAdvisorAction: AutomationAction = {
  type: 'app_advisor_prompt',
  prompt: 'hi',
};

describe('isWorkspaceInContext', () => {
  it('matches owners to the selected context', () => {
    expect(isWorkspaceInContext(projects[0], PERSONAL, noLinks)).toBe(true);
    expect(isWorkspaceInContext(projects[2], PERSONAL, noLinks)).toBe(false);
    expect(isWorkspaceInContext(projects[2], ORG_A_CONTEXT, noLinks)).toBe(
      true,
    );
    expect(isWorkspaceInContext(projects[3], ORG_A_CONTEXT, noLinks)).toBe(
      false,
    );
    expect(isWorkspaceInContext(projects[0], ORG_A_CONTEXT, noLinks)).toBe(
      false,
    );
  });

  it('admits linked Personal checkouts in the organization and under Personal', () => {
    expect(isWorkspaceInContext(projects[1], ORG_A_CONTEXT, linked)).toBe(true);
    expect(isWorkspaceInContext(projects[1], PERSONAL, linked)).toBe(true);
  });

  it('does not scope without a context', () => {
    expect(isWorkspaceInContext(projects[3], undefined, noLinks)).toBe(true);
  });
});

describe('isAutomationInContext', () => {
  it('hides a Personal Chats automation in an organization', () => {
    expect(
      isAutomationInContext(
        { action: coworkAction('chats') },
        byId,
        ORG_A_CONTEXT,
        noLinks,
      ),
    ).toBe(false);
    expect(
      isAutomationInContext(
        { action: coworkAction('chats') },
        byId,
        PERSONAL,
        noLinks,
      ),
    ).toBe(true);
  });

  it('shows organization automations only in that organization', () => {
    const activity = { action: worktreeAction('org-a') };
    expect(isAutomationInContext(activity, byId, ORG_A_CONTEXT, noLinks)).toBe(
      true,
    );
    expect(isAutomationInContext(activity, byId, PERSONAL, noLinks)).toBe(
      false,
    );
  });

  it('shows linked checkouts in the organization', () => {
    expect(
      isAutomationInContext(
        { action: worktreeAction('linked') },
        byId,
        ORG_A_CONTEXT,
        linked,
      ),
    ).toBe(true);
  });

  it('shows App Advisor and missing targets everywhere', () => {
    expect(
      isAutomationInContext(
        { action: appAdvisorAction },
        byId,
        ORG_A_CONTEXT,
        noLinks,
      ),
    ).toBe(true);
    expect(
      isAutomationInContext(
        { action: worktreeAction('deleted') },
        byId,
        ORG_A_CONTEXT,
        noLinks,
      ),
    ).toBe(true);
  });

  it('does not scope while the context is unavailable', () => {
    expect(
      isAutomationInContext(
        { action: worktreeAction('org-b') },
        byId,
        undefined,
        noLinks,
      ),
    ).toBe(true);
  });
});

describe('isWatcherInContext', () => {
  function watcher(projectId: string): {
    destination: { projectId: string; worktreeId: string; chatId: string };
  } {
    return { destination: { projectId, worktreeId: 'wt', chatId: 'chat' } };
  }

  it('scopes by destination project', () => {
    expect(
      isWatcherInContext(watcher('org-a'), byId, ORG_A_CONTEXT, noLinks),
    ).toBe(true);
    expect(isWatcherInContext(watcher('org-a'), byId, PERSONAL, noLinks)).toBe(
      false,
    );
    expect(
      isWatcherInContext(watcher('chats'), byId, ORG_A_CONTEXT, noLinks),
    ).toBe(false);
  });

  it('shows App Advisor and unknown destinations everywhere', () => {
    expect(
      isWatcherInContext(
        watcher(APP_ADVISOR_PROJECT_ID),
        byId,
        ORG_A_CONTEXT,
        noLinks,
      ),
    ).toBe(true);
    expect(
      isWatcherInContext(watcher('gone'), byId, ORG_A_CONTEXT, noLinks),
    ).toBe(true);
  });
});

describe('isSharedAutomationInContext', () => {
  const system = { owner: { type: 'system' as const } };
  const user = {
    owner: { type: 'user' as const, id: 'user-1', name: 'Ada' },
  };
  const org = {
    owner: { type: 'organization' as const, id: ORG_A, name: 'Acme' },
  };
  const team = {
    owner: {
      type: 'team' as const,
      id: 'team-1',
      name: 'Core',
      organization: { id: ORG_B, name: 'Zen' },
    },
  };

  it('keeps system shares everywhere', () => {
    expect(isSharedAutomationInContext(system, PERSONAL)).toBe(true);
    expect(isSharedAutomationInContext(system, ORG_A_CONTEXT)).toBe(true);
  });

  it('keeps personal shares under Personal', () => {
    expect(isSharedAutomationInContext(user, PERSONAL)).toBe(true);
    expect(isSharedAutomationInContext(user, ORG_A_CONTEXT)).toBe(true);
  });

  it('keeps organization and team shares under their organization', () => {
    expect(isSharedAutomationInContext(org, ORG_A_CONTEXT)).toBe(true);
    expect(isSharedAutomationInContext(org, PERSONAL)).toBe(false);
    expect(isSharedAutomationInContext(team, ORG_A_CONTEXT)).toBe(false);
    expect(
      isSharedAutomationInContext(team, {
        kind: 'organization',
        organizationId: ORG_B,
      }),
    ).toBe(true);
  });

  it('does not scope without a context', () => {
    expect(isSharedAutomationInContext(team, undefined)).toBe(true);
  });
});

describe('context labels', () => {
  const organizations = [{ id: ORG_A, name: 'Acme' }];

  it('names Personal and organizations', () => {
    expect(workspaceContextLabel(PERSONAL, organizations)).toBe('Personal');
    expect(workspaceContextLabel(ORG_A_CONTEXT, organizations)).toBe('Acme');
    expect(
      workspaceContextLabel(
        { kind: 'organization', organizationId: ORG_B },
        organizations,
      ),
    ).toBe('your organization');
    expect(
      workspaceContextLabel(
        { kind: 'organization', organizationId: ORG_B },
        organizations,
        'Organization',
      ),
    ).toBe('Organization');
  });

  it('resolves a workspace owner to its context', () => {
    expect(workspaceOwnerContext(projects[0])).toEqual(PERSONAL);
    expect(workspaceOwnerContext(projects[2])).toEqual(ORG_A_CONTEXT);
  });

  it('names where an automation runs from its binding (CAN-3543)', () => {
    expect(
      automationRunsInLabel(
        { enabled: true, executionContext: `org:${ORG_A}` },
        organizations,
      ),
    ).toBe('Runs in Acme');
    expect(
      automationRunsInLabel(
        { enabled: false, executionContext: 'personal' },
        organizations,
      ),
    ).toBe('Runs in Personal');
    // On without a binding: an older automation, which runs as Personal.
    expect(automationRunsInLabel({ enabled: true }, organizations)).toBe(
      'Runs in Personal',
    );
    // Off and never bound: turning it on decides where it runs.
    expect(automationRunsInLabel({ enabled: false }, organizations)).toBeNull();
    expect(
      automationRunsInLabel(
        { enabled: true, executionContext: 'not-a-context' },
        organizations,
      ),
    ).toBeNull();
  });
});

it('keeps Personal-org shares in Personal and USER shares available across contexts after promotion', () => {
  const summary = {
    owner: { type: 'organization' as const, id: ORG_A, name: 'Personal' },
  };
  expect(isSharedAutomationInContext(summary, PERSONAL, ORG_A)).toBe(true);
  expect(isSharedAutomationInContext(summary, ORG_A_CONTEXT, ORG_A)).toBe(
    false,
  );
  expect(isSharedAutomationInContext(summary, PERSONAL, ORG_B)).toBe(false);
  expect(isSharedAutomationInContext(summary, ORG_A_CONTEXT, ORG_B)).toBe(true);
  expect(
    isSharedAutomationInContext(
      { owner: { type: 'user', id: 'user', name: null } },
      ORG_A_CONTEXT,
      ORG_B,
    ),
  ).toBe(true);
});

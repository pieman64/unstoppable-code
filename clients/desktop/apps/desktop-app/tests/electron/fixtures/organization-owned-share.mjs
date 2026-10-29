import {
  seedAutomations,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_WORKSPACE,
} from '../seeders/index.mjs';

export const ORGANIZATION_SHARE_AUTOMATION_ID = 'can3844-organization-review';
export const ORGANIZATION_SHARE_TEAM = {
  id: '55555555-5555-4555-8555-555555555551',
  name: 'Platform',
  organization: {
    id: ORG_CONTEXT_A,
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export function seedOrganizationShareAutomation(userDataDir) {
  seedOrgContextScoping(userDataDir);
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: ORGANIZATION_SHARE_AUTOMATION_ID,
        name: 'Organization review',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: ORG_CONTEXT_WORKSPACE,
          worktreeId: 'home',
          chatId: 'organization-review-chat',
          prompt: 'Review the project changes.',
        },
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
}

export async function readOrganizationShareAutomation(page) {
  return page.evaluate(async (id) => {
    const local = (await window.api.automations.list()).activities.find(
      (activity) => activity.id === id,
    );
    if (!local?.remote) return null;
    return window.api.automations.getShared(local.remote.remoteId);
  }, ORGANIZATION_SHARE_AUTOMATION_ID);
}

/**
 * CAN-3460 durable context-aware share and invite coverage.
 *
 * The fixture is deterministic: local workspace/plan/chat data plus the
 * repository's keyed Cloud mock. It exercises the real account-menu context
 * switch, worktree Invite flow, shared skill dialog, and Personal-context
 * plan/run entry-point policy without live agents or external network.
 *
 * Run: pnpm run test:electron:built org-context-share-defaults.spec.mjs --reporter=line
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { cleanupDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedObservabilityAudit,
  seedTrackedPlans,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { ORG_CONTEXT_ENV } from './seeders/seedOrgContextScoping.mjs';
import {
  OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
  SHARED_CONTAINERS_CLOUD_API_KEY,
  SHARED_CONTAINERS_ORGANIZATION_ID,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
  seedCodeSharedContainer,
} from './sharedContainerInviteFixture.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

const ORGANIZATIONS = [
  {
    id: SHARED_CONTAINERS_ORGANIZATION_ID,
    name: 'Acme',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    name: 'Beta',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const TEAMS = ORGANIZATIONS.map((organization, index) => ({
  id: `99999999-9999-4999-8999-99999999999${index}`,
  name: index === 0 ? 'Acme Platform' : 'Beta Platform',
  organization,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}));

const PLAN_ID = 'can-3460-context-plan';
const CHAT_ID = 'can-3460-context-run';
const ORG_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ORG_INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG_PROJECT_ID = '55555555-5555-4555-8555-555555555555';

function mergedContextEnv() {
  return {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS:
      ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
    CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
  };
}

function seedPlanAndRun(userDataDir, projectId, worktreeId) {
  const timestamp = '2026-09-01T12:00:00.000Z';
  seedTrackedPlans({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    plans: [
      {
        id: PLAN_ID,
        projectId,
        worktreeId,
        source: 'claude',
        title: 'Context-aware sharing plan',
        content: '# Context-aware sharing plan',
        reviewStatus: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        latestRevisionNumber: 1,
        revisions: [
          {
            revisionNumber: 1,
            content: '# Context-aware sharing plan',
            source: 'claude',
            reviewStatus: 'pending',
            createdAt: timestamp,
          },
        ],
        linkedExecutionIds: [],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Context-aware sharing run',
        providerType: 'claude',
        messages: [
          {
            id: 'can-3460-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Check this context.' }],
            timestamp: Date.parse(timestamp),
          },
          {
            id: 'can-3460-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Context checked.' }],
            timestamp: Date.parse(timestamp) + 1_000,
          },
          {
            id: 'can-3460-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: Date.parse(timestamp),
                completedAt: Date.parse(timestamp) + 30_000,
              },
            ],
            timestamp: Date.parse(timestamp) + 2_000,
          },
        ],
      },
    ],
  });
  seedObservabilityAudit({
    userDataDir,
    entries: [
      {
        id: 'can-3460-audit',
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'claude',
        label: 'Context-aware sharing run',
        startedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
        durationMs: 60_000,
        model: 'claude-sonnet-4-6',
        tokens: {
          input: 100,
          output: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 2,
        assistantMessageCount: 1,
        toolUseCount: 0,
        subAgentCount: 0,
        toolCounts: {},
        projectId,
        worktreeId,
        chatId: CHAT_ID,
        hasTranscript: false,
      },
    ],
  });
}

function assignWorkspaceToOrganization(userDataDir, workspaceId) {
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        owner: {
          type: 'organization',
          organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
          projectId: ORG_PROJECT_ID,
          instanceId: ORG_INSTANCE_ID,
          bindingGeneration: 0,
        },
        ownershipTransfer: {
          version: 1,
          previousOwner: { type: 'personal' },
          organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
          projectId: ORG_PROJECT_ID,
          convertedAt: '2026-09-01T12:00:00.000Z',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function installTargetFixtures(
  electronApp,
  organizations = ORGANIZATIONS,
  teams = TEAMS,
) {
  await electronApp.evaluate(
    ({ ipcMain }, { organizations, teams }) => {
      for (const [channel, targets] of [
        ['pipelines:shared-organizations-list', organizations],
        ['pipelines:shared-teams-list', teams],
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => ({
          success: true,
          data: { serverId: 'can-3460', data: targets },
        }));
      }
      ipcMain.removeHandler('shared-containers:eligibility');
      ipcMain.handle('shared-containers:eligibility', () => ({
        eligible: true,
        serverWorktreeExternalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }));
      ipcMain.removeHandler('shared-containers:search-members');
      ipcMain.handle('shared-containers:search-members', () => ({
        members: [{ userId: 'member-1', name: 'Ada' }],
      }));
      ipcMain.removeHandler('shared-containers:list-recipients');
      ipcMain.handle('shared-containers:list-recipients', () => ({
        recipients: [],
        nextCursor: null,
      }));
      ipcMain.removeHandler('shared-containers:list-by-me');
      ipcMain.handle('shared-containers:list-by-me', () => ({
        containers: [],
        nextCursor: null,
      }));
    },
    { organizations, teams },
  );
}

async function registerContextScenario(organizations = ORGANIZATIONS) {
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      sharedContainers: {},
      cloud: {
        organizations,
        teams: TEAMS.filter((team) =>
          organizations.some(
            (organization) => organization.id === team.organization.id,
          ),
        ),
        orgBillingStates: organizations.map((organization) => ({
          organizationId: organization.id,
          organizationName: organization.name,
          teamsEntitled: true,
        })),
        orgProjects: Object.fromEntries(
          organizations.map((organization) => {
            const primary =
              organization.id === SHARED_CONTAINERS_ORGANIZATION_ID;
            return [
              `org:${organization.id}`,
              [
                {
                  id: primary ? ORG_PROJECT_ID : OTHER_ORG_PROJECT_ID,
                  organizationId: organization.id,
                  name: 'Context-aware sharing project',
                  description: null,
                  kind: 'CODE',
                  purpose: 'project',
                  visibility: 'organization',
                  memberOwned: false,
                  location: 'LOCAL',
                  repository: {
                    provider: 'github',
                    host: 'github.com',
                    owner: 'acme',
                    name: 'app',
                    providerRepoId: '1',
                    defaultBranch: 'main',
                    verification: 'VERIFIED',
                  },
                  state: 'ACTIVE',
                  revision: 1,
                  authorizationVersion: 1,
                  defaultListed: true,
                  preference: 'FOLLOW_DEFAULTS',
                  listed: true,
                  capabilities: {
                    administer: false,
                    manageCloud: false,
                    use: true,
                  },
                  instance: primary
                    ? { id: ORG_INSTANCE_ID, state: 'READY' }
                    : null,
                },
              ],
            ];
          }),
        ),
      },
    },
  );
}

async function switchContextWhileDialogOpen(window, contextId) {
  await window.evaluate(async (nextContextId) => {
    const current = await window.api.workspaceContext.get();
    await window.api.workspaceContext.set({
      context:
        nextContextId === 'personal'
          ? { kind: 'personal' }
          : { kind: 'organization', organizationId: nextContextId },
      expectedRevision: current.revision,
    });
  }, contextId);
}

/**
 * Opens Share for the first bundled skill from its detail page (CAN-4267:
 * the Skills list and its row Share icon are gone). The detail hosts the
 * installed-skill actions whose share dialog a context switch dismisses.
 */
async function openBundledSkillShare(window) {
  await window
    .getByTestId('customize-section-installed')
    .locator('[data-testid^="customize-row-skill:builtin:"]')
    .first()
    .click();
  await expect(window.getByTestId('plugins-entry-detail-page')).toBeVisible();
  await window.getByTestId('skill-read-detail-share').click();
}

async function openWorktreeInvite(window, app, worktreeId) {
  await app.openMainPage();
  await app.selectWorktree(worktreeId);
  const row = window.locator(
    `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
  );
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-invite').click();
}

test('defaults and rebinds share surfaces to the selected context', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-context-share-defaults-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  assignWorkspaceToOrganization(userDataDir, fixture.projectId);
  seedPlanAndRun(userDataDir, fixture.projectId, fixture.worktreeId);
  await registerContextScenario();

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, mergedContextEnv()),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await installTargetFixtures(electronApp);

    await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
    await openWorktreeInvite(window, app, fixture.worktreeId);
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-organization-option-${SHARED_CONTAINERS_ORGANIZATION_ID}`,
      ),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window.getByTestId('shared-container-invite-scope-team'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-team-option-${TEAMS[0].id}`,
      ),
    ).toBeVisible();
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-team-option-${TEAMS[1].id}`,
      ),
    ).toHaveCount(0);
    await expect(
      window.getByText('Choose a team.', { exact: true }),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-submit'),
    ).toBeDisabled();

    await window
      .getByTestId('shared-container-invite-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await openBundledSkillShare(window);
    const skillModal = window.getByTestId('share-skill-modal');
    await expect(skillModal).toBeVisible();
    await expect(
      skillModal.getByTestId(`share-skill-team-picker-option-${TEAMS[0].id}`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      skillModal.getByTestId(`share-skill-team-picker-option-${TEAMS[1].id}`),
    ).toHaveCount(0);
    await expect(
      skillModal
        .getByTestId('share-skill-team-picker')
        .locator('[aria-pressed="true"]'),
    ).toHaveCount(0);

    await switchContextWhileDialogOpen(
      window,
      OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    );
    // PR #4165 resets Skills page selection on a context change; Customize
    // closes the skill detail and its dialog the same way. Reopen the dialog
    // and verify it binds to the new organization. A Share dialog opened from
    // a Customize row menu closes on the same switch (PluginsPage test
    // "closes a row Share dialog when the context changes").
    await expect(skillModal).toHaveCount(0);
    await openBundledSkillShare(window);
    await expect(skillModal).toBeVisible();
    await expect(
      skillModal.getByTestId(`share-skill-team-picker-option-${TEAMS[1].id}`),
    ).toBeVisible();
    await expect(
      skillModal.getByTestId(`share-skill-team-picker-option-${TEAMS[0].id}`),
    ).toHaveCount(0);
    await skillModal.getByTestId('share-skill-scope-organization').click();
    await expect(
      skillModal.getByTestId(
        `share-skill-organization-picker-option-${OTHER_SHARED_CONTAINERS_ORGANIZATION_ID}`,
      ),
    ).toHaveAttribute('aria-pressed', 'true');

    const movedToPersonal = await window.evaluate(
      (workspaceId) =>
        window.api.orgProjects.moveBackToPersonal({ workspaceId }),
      fixture.projectId,
    );
    if (!movedToPersonal.ok) {
      throw new Error(`Move back failed: ${movedToPersonal.code}`);
    }
    await switchContextWhileDialogOpen(window, 'personal');
    await expect(skillModal).toHaveCount(0);
    await openBundledSkillShare(window);
    await expect(skillModal).toBeVisible();
    // Personal context: Team and Organization stay offered but disabled.
    await expect(
      skillModal.getByTestId('share-skill-scope-team'),
    ).toBeDisabled();
    await expect(
      skillModal.getByTestId('share-skill-scope-organization'),
    ).toBeDisabled();
    await skillModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    await app.openMainPage();
    await selectWorkspaceContext(
      window,
      OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    );
    await window.evaluate(
      (organizationId) =>
        window.api.orgProjects.refresh({
          context: { kind: 'organization', organizationId },
          force: true,
        }),
      OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    );
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const result = await window.api.orgProjects.linksList();
          return result.status === 'resolved' ? result.links : [];
        }),
      )
      .toContainEqual({
        projectId: OTHER_ORG_PROJECT_ID,
        personalWorkspaceId: fixture.projectId,
      });
    await selectWorkspaceContext(window, 'personal');
    await expectWorkspaceContext(window, 'personal');
    await openWorktreeInvite(window, app, fixture.worktreeId);
    await expect(
      window.getByTestId('shared-container-invite-choose-organization'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-submit'),
    ).toBeDisabled();

    await switchContextWhileDialogOpen(
      window,
      OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    );
    await expect(
      window.getByTestId('shared-container-invite-context-changed'),
    ).toContainText('Switched to Beta.');
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-organization-option-${OTHER_SHARED_CONTAINERS_ORGANIZATION_ID}`,
      ),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-team-option-${TEAMS[1].id}`,
      ),
    ).toBeVisible();
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-team-option-${TEAMS[0].id}`,
      ),
    ).toHaveCount(0);

    await switchContextWhileDialogOpen(window, 'personal');
    await expect(
      window.getByTestId('shared-container-invite-context-changed'),
    ).toContainText('Switched to Personal.');
    await expect(
      window.getByTestId('shared-container-invite-choose-organization'),
    ).toBeVisible();
    await window
      .getByTestId('shared-container-invite-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    await app.openMainPage();
    await app.selectWorktree(fixture.worktreeId);
    await expect(
      window.getByTestId(`activity-plan-row-${PLAN_ID}`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId(`activity-plan-${PLAN_ID}-share`),
    ).toHaveCount(0);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByTestId('turn-share-session')).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('shows the single eligible organization name in Invite', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-context-single-invite-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  assignWorkspaceToOrganization(userDataDir, fixture.projectId);
  await registerContextScenario([ORGANIZATIONS[0]]);

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, mergedContextEnv()),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await installTargetFixtures(electronApp, [ORGANIZATIONS[0]], [TEAMS[0]]);

    await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
    await openWorktreeInvite(window, app, fixture.worktreeId);
    await expect(
      window.getByTestId('shared-container-invite-modal-organization-name'),
    ).toHaveText('Acme');
    await expect(
      window.getByTestId('shared-container-invite-modal-organization'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

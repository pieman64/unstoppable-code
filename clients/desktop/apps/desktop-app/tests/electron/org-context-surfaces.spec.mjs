import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  injectChatEvent,
  registerScenario,
  seedObservabilityAudit,
  seedPipelineExecution,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_B_WORKSPACE,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  PERSONAL_CONTEXT_WORKSPACE,
  ORG_CONTEXT_WORKSPACE,
  seedWorktreeChat,
  seedUsageLimitedChats,
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';
import {
  IMPORT_FIXTURE_GIT_PROJECT,
  seedExternalProjectImportFixture,
} from './seeders/seedExternalProjectImportFixture.mjs';

// CAN-3461: Home, Cmd+K, and the Audit Trail follow the selected
// Personal/organization context. The two-org fixture seeds a Personal
// project, an Org A (Acme) project, and an Org B (Beta) project, each with a
// worktree, so every context has something to list and something to hide.

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
const WORKTREE = 'feature';
const LINKED_PROJECT_ID = '33333333-3333-4333-8333-333333333399';
const LINKED_REMOTE = 'https://github.com/acme/context-linked.git';

function seedSyntheticAuditOrigins(userDataDir) {
  const registries = [
    {
      path: path.join(userDataDir, 'plan-explore-chats', 'registry.json'),
      targets: {
        'audit-plan': {
          projectId: ORG_CONTEXT_WORKSPACE,
          worktreeId: `acme-${WORKTREE}`,
        },
      },
    },
    {
      path: path.join(
        userDataDir,
        'app-workspaces',
        'code-review-chat',
        'chats',
        'registry.json',
      ),
      targets: {
        'audit-review-scope': {
          projectId: ORG_CONTEXT_WORKSPACE,
          worktreeId: `acme-${WORKTREE}`,
        },
      },
    },
  ];
  for (const registry of registries) {
    mkdirSync(path.dirname(registry.path), { recursive: true });
    writeFileSync(
      registry.path,
      JSON.stringify({ version: 1, targets: registry.targets }),
      'utf8',
    );
  }
}

const linkedCatalogProject = {
  id: LINKED_PROJECT_ID,
  organizationId: ORG_CONTEXT_A,
  name: 'Linked Personal project',
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
    name: 'context-linked',
    providerRepoId: 'context-linked',
    defaultBranch: 'main',
    verification: 'VERIFIED',
  },
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { administer: false, manageCloud: false, use: true },
  instance: null,
};

function seedTwoOrgFixture(userDataDir, linkedPersonal = false) {
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: [`personal-${WORKTREE}`],
    ...(linkedPersonal ? { personalRemoteUrl: LINKED_REMOTE } : {}),
    organizationB: true,
    organizationWorktreeIds: [`acme-${WORKTREE}`],
  });
  for (const chat of [
    {
      workspaceId: PERSONAL_CONTEXT_WORKSPACE,
      worktreeId: `personal-${WORKTREE}`,
      chatId: 'personal-overview-chat',
      title: 'Personal overview chat',
    },
    {
      workspaceId: ORG_CONTEXT_WORKSPACE,
      worktreeId: `acme-${WORKTREE}`,
      chatId: 'acme-overview-chat',
      title: 'Acme overview chat',
    },
    {
      workspaceId: ORG_CONTEXT_B_WORKSPACE,
      worktreeId: `beta-acme-${WORKTREE}`,
      chatId: 'beta-overview-chat',
      title: 'Beta overview chat',
    },
  ]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: chat.workspaceId,
      worktreeId: chat.worktreeId,
      providerType: 'codex',
      tabs: [{ id: chat.chatId, title: chat.title, messages: [] }],
    });
  }
}

async function launchTwoOrg(apiKey, prefix, seed, linkedPersonal = false) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      ...(linkedPersonal
        ? {
            orgProjects: { [`org:${ORG_CONTEXT_A}`]: [linkedCatalogProject] },
          }
        : {}),
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedTwoOrgFixture(userDataDir, linkedPersonal);
  const seeded = seed?.(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...ORG_CONTEXT_ENV, ...(seeded?.env ?? {}) },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  await expectWorkspaceContext(window, 'personal');
  return { electronApp, userDataDir, window, app, seeded };
}

async function currentContext(window) {
  return window.evaluate(
    async () => (await window.api.workspaceContext.get()).context,
  );
}

async function setContextFromAnotherSurface(window, context) {
  await window.evaluate(async (next) => {
    const current = await window.api.workspaceContext.get();
    await window.api.workspaceContext.set({
      context: next,
      expectedRevision: current.revision,
    });
  }, context);
}

async function expectLinkedPersonalCheckout(window) {
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const result = await window.api.orgProjects.linksList();
        return result.status === 'resolved' ? result.links : [];
      }),
    )
    .toContainEqual({
      projectId: LINKED_PROJECT_ID,
      personalWorkspaceId: PERSONAL_CONTEXT_WORKSPACE,
    });
}

test('Home composer offers only the selected context and rebinds without a notice on a switch', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3461_home_scope';
  const { electronApp, userDataDir, window, app } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-home-',
    undefined,
    true,
  );
  try {
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home').getByTestId('home-surface');
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute('data-workspace-selected', 'true');

    // Personal lists the Personal project and nothing from either org.
    await home.getByTestId('home-workspace-select').click();
    const popover = window.getByTestId('home-workspace-popover');
    await expect(
      popover.getByTestId(
        `home-workspace-option-${PERSONAL_CONTEXT_WORKSPACE}`,
      ),
    ).toBeVisible();
    await expect(
      popover.getByTestId(`home-workspace-option-${ORG_CONTEXT_WORKSPACE}`),
    ).toHaveCount(0);
    await expect(
      popover.getByTestId(`home-workspace-option-${ORG_CONTEXT_B_WORKSPACE}`),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(home.getByTestId('home-composer-context-changed')).toHaveCount(
      0,
    );

    // Org A admits its linked Personal checkout. Once that relationship has
    // settled, switching to Org B must not consume Org A's stale linked ids.
    const notice = home.getByTestId('home-composer-context-changed');
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expectLinkedPersonalCheckout(window);
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Acme repository',
    );
    await expect(notice).toHaveCount(0);
    await expect(home).toHaveAttribute('data-workspace-selected', 'true');
    await home.getByTestId('home-workspace-select').click();
    await expect(
      popover.getByTestId(
        `home-workspace-option-${PERSONAL_CONTEXT_WORKSPACE}`,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      popover.getByTestId(`home-workspace-option-${ORG_CONTEXT_WORKSPACE}`),
    ).toBeVisible();
    await popover
      .getByTestId(`home-workspace-option-${PERSONAL_CONTEXT_WORKSPACE}`)
      .click();
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Personal repository',
    );
    // PR #4159 gives Org A its own Chats destination. Clearing the project
    // now keeps the chat in this context instead of returning to Personal.
    await home.getByTestId('home-workspace-clear').click();
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Choose project',
    );
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
    await home.getByTestId('home-workspace-select').click();
    await popover
      .getByTestId(`home-workspace-option-${PERSONAL_CONTEXT_WORKSPACE}`)
      .click();
    await expect(
      window.getByTestId('home-composer-context-changed'),
    ).toHaveCount(0);

    // Revoking a linked checkout without changing the selected organization
    // must rebind Home instead of retaining a now-hidden Personal workspace.
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: [] },
      },
    });
    await window.evaluate(async (organizationId) => {
      await window.api.orgProjects.refresh({
        context: { kind: 'organization', organizationId },
        force: true,
      });
    }, ORG_CONTEXT_A);
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Acme repository',
    );
    await expect(notice).toHaveCount(0);
    await expect(
      window.getByTestId('toast-card').filter({ hasText: 'Acme repository' }),
    ).toHaveCount(0);
    await expect(home).toHaveAttribute('data-workspace-selected', 'true');

    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Beta repository',
    );
    await expect(notice).toHaveCount(0);
    await expect(home).toHaveAttribute('data-workspace-selected', 'true');

    await selectWorkspaceContext(window, 'personal');
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Personal repository',
    );
    await expect(notice).toHaveCount(0);

    // A context switch can happen while Home is unmounted. Reopening must
    // clear the hidden composer-store draft as well as the fresh Slate view,
    // and select a project in the new context without a notice.
    const editor = home.getByTestId('home-composer-editor');
    const send = home.getByTestId('home-send-button');
    await editor.fill('Stale Personal draft must not cross contexts');
    await app.openOverviewPage();
    await setContextFromAnotherSurface(window, {
      kind: 'organization',
      organizationId: ORG_CONTEXT_A,
    });
    await window.getByTestId('sidebar-create-task').click();
    await expect(home).toBeVisible();
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Acme repository',
    );
    await expect(notice).toHaveCount(0);
    await expect(editor).not.toContainText(
      'Stale Personal draft must not cross contexts',
    );
    await send.click();
    await expect(home).toHaveCount(0, { timeout: 30_000 });
    await expect(
      window
        .locator('[data-testid="panel-content-chat"]:visible')
        .getByText('Stale Personal draft must not cross contexts', {
          exact: true,
        }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

const PERSONAL_COWORK_PROJECT = 'context-dip-finder';
const ORG_A_CHATS = `cowork-org-${ORG_CONTEXT_A}`;

/**
 * The shape real installs have and the two-org fixture does not: each
 * context's Chats sorts ahead of its projects, and Personal holds a Cowork
 * project next to its repository.
 */
function seedChatsFirstWithPersonalCowork(userDataDir) {
  const cowork = {
    createdAt: '2026-07-01T10:00:00.000Z',
    archiveRetentionDays: null,
  };
  const workspacesDir = path.join(userDataDir, 'workspaces');
  for (const [id, owner] of [
    [PERSONAL_COWORK_PROJECT, undefined],
    [
      ORG_A_CHATS,
      {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: '77777777-7777-4777-8777-777777777777',
        instanceId: '88888888-8888-4888-8888-888888888888',
        bindingGeneration: 0,
      },
    ],
  ]) {
    mkdirSync(path.join(workspacesDir, id), { recursive: true });
    writeFileSync(
      path.join(workspacesDir, id, 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        cowork,
        alwaysShow: true,
        ...(owner ? { owner } : {}),
      }),
      'utf8',
    );
  }
  const entry = (id, name, type) => ({
    id,
    name,
    type,
    color: '#7C9B6D',
    collapsed: false,
  });
  writeFileSync(
    path.join(workspacesDir, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        { ...entry('cowork-default', 'Chats', 'cowork'), cowork },
        entry(PERSONAL_COWORK_PROJECT, 'Dip finder', 'cowork'),
        entry(ORG_A_CHATS, 'Chats', 'cowork'),
        entry(ORG_CONTEXT_WORKSPACE, 'Acme repository', 'single-repo'),
        entry(PERSONAL_CONTEXT_WORKSPACE, 'Personal repository', 'single-repo'),
        entry(ORG_CONTEXT_B_WORKSPACE, 'Beta repository', 'single-repo'),
      ].map((workspace, order) => ({ ...workspace, order })),
    }),
    'utf8',
  );
}

test('Home composer rebinds without a notice from a Personal Cowork project when Chats sorts first', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3461_home_cowork_scope';
  const { electronApp, userDataDir, window } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-home-cowork-',
    seedChatsFirstWithPersonalCowork,
  );
  try {
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home').getByTestId('home-surface');
    await expect(home).toBeVisible();
    const picker = home.getByTestId('home-workspace-select');
    const popover = window.getByTestId('home-workspace-popover');
    const notice = home.getByTestId('home-composer-context-changed');

    await picker.click();
    await popover
      .getByTestId(`home-workspace-option-${PERSONAL_COWORK_PROJECT}`)
      .click();
    await expect(picker).toContainText('Dip finder');
    await expect(notice).toHaveCount(0);

    // Org A's Chats sorts ahead of its repository. The composer lands on the
    // repository, the first project the picker lists, without a notice.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(picker).toContainText('Acme repository');
    await expect(notice).toHaveCount(0);

    // Back in Personal, Chats sorts first again and is skipped the same way.
    await selectWorkspaceContext(window, 'personal');
    await expect(picker).toContainText('Dip finder');
    await expect(notice).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Home Continue lists and resumes interrupted sessions only in the selected context', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3461_continue_scope';
  const interrupted = [
    {
      context: 'personal',
      projectId: PERSONAL_CONTEXT_WORKSPACE,
      worktreeId: `personal-${WORKTREE}`,
      chatId: 'personal-overview-chat',
      title: 'Personal overview chat',
      workspaceName: 'Personal repository',
    },
    {
      context: ORG_CONTEXT_A,
      projectId: ORG_CONTEXT_WORKSPACE,
      worktreeId: `acme-${WORKTREE}`,
      chatId: 'acme-overview-chat',
      title: 'Acme overview chat',
      workspaceName: 'Acme repository',
    },
    {
      context: ORG_CONTEXT_B,
      projectId: ORG_CONTEXT_B_WORKSPACE,
      worktreeId: `beta-acme-${WORKTREE}`,
      chatId: 'beta-overview-chat',
      title: 'Beta overview chat',
      workspaceName: 'Beta repository',
    },
  ];
  const { electronApp, userDataDir, window } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-continue-',
    (dir) =>
      seedUsageLimitedChats({
        userDataDir: dir,
        entries: interrupted.map((item) => ({
          projectId: item.projectId,
          worktreeId: item.worktreeId,
          chatId: item.chatId,
          provider: 'codex',
          detectedAt: Date.parse('2026-09-28T12:00:00.000Z'),
          workspaceName: item.workspaceName,
          chatTitle: item.title,
        })),
      }),
  );
  try {
    await window.getByTestId('sidebar-create-task').click();
    for (const [index, item] of interrupted.entries()) {
      if (index > 0) await selectWorkspaceContext(window, item.context);
      const banner = window.getByTestId('home-interrupted-sessions-banner');
      // A single interrupted entry is named by its chat (CAN-4895).
      await expect(banner).toContainText(`Resume ${item.title}`);
      await banner.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${item.chatId}`),
      ).toBeVisible();
      for (const other of interrupted.filter(
        (candidate) => candidate !== item,
      )) {
        await expect(
          modal.getByTestId(`usage-limit-resume-chat-${other.chatId}`),
        ).toHaveCount(0);
      }
      await modal.getByTestId('usage-limit-resume-cancel').click();
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Create Task lists and defaults within context, then resets visibly on an external switch', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3461_create_task_scope';
  const { electronApp, userDataDir, window, app } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-create-task-',
  );
  try {
    await app.openMainPage();
    await app.selectWorktree(`personal-${WORKTREE}`);
    await app.openKanbanPage();
    await window.getByTestId('sidebar-toggle').click();
    await expect(window.getByTestId('app-sidebar')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await window
      .getByRole('button', { name: 'Create task', exact: true })
      .click();

    const modal = window.getByTestId('create-task-modal');
    const trigger = modal.getByTestId('create-task-workspace-select');
    await expect(trigger).toContainText('Personal repository');

    const expectations = [
      {
        context: { kind: 'organization', organizationId: ORG_CONTEXT_A },
        ownId: ORG_CONTEXT_WORKSPACE,
        ownName: 'Acme repository',
      },
      {
        context: { kind: 'organization', organizationId: ORG_CONTEXT_B },
        ownId: ORG_CONTEXT_B_WORKSPACE,
        ownName: 'Beta repository',
      },
      {
        context: { kind: 'personal' },
        ownId: PERSONAL_CONTEXT_WORKSPACE,
        ownName: 'Personal repository',
      },
    ];
    for (const item of expectations) {
      await setContextFromAnotherSurface(window, item.context);
      await expect(
        modal.getByTestId('create-task-context-changed'),
      ).toBeVisible();
      await expect(trigger).toContainText(item.ownName);
      await trigger.click();
      const popover = window.getByTestId('create-task-workspace-popover');
      await expect(
        popover.getByTestId(`create-task-workspace-option-${item.ownId}`),
      ).toBeVisible();
      await expect(popover.getByRole('option')).toHaveCount(1);
      await window.keyboard.press('Escape');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Import from an organization lands in Personal and selects the imported project', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3461_import_scope';
  const { electronApp, userDataDir, window, app, seeded } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-import-',
    (dir) => seedExternalProjectImportFixture({ userDataDir: dir }),
  );
  try {
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-canopy-import-projects-open').click();
    const modal = window.getByTestId('import-projects-modal');
    await expect(modal.getByTestId('import-projects-list')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      modal.getByTestId('import-projects-personal-notice'),
    ).toContainText('Imported projects are Personal');
    await setContextFromAnotherSurface(window, {
      kind: 'organization',
      organizationId: ORG_CONTEXT_B,
    });
    await expect(
      modal.getByTestId('import-projects-personal-notice'),
    ).toContainText('Imported projects are Personal');
    await modal.getByTestId('import-projects-submit').click();
    await expect(modal.getByTestId('import-projects-results')).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(() => currentContext(window))
      .toEqual({ kind: 'personal' });
    await modal.getByTestId('import-projects-done').click();
    await app.closeSettings();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('page-home').getByTestId('home-workspace-select'),
    ).toContainText(IMPORT_FIXTURE_GIT_PROJECT);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    seeded?.cleanup?.();
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Cmd+K returns only the selected context and keeps the switch commands', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3461_palette_scope';
  const { electronApp, userDataDir, window } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-palette-',
    undefined,
    true,
  );
  const palette = window.getByTestId('command-palette');
  const results = palette.getByTestId('command-palette-result');

  async function search(query) {
    await window.keyboard.press(PALETTE_SHORTCUT);
    await expect(palette).toBeVisible();
    await window.getByTestId('command-palette-input').fill(query);
  }

  async function close() {
    await window.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  }

  try {
    // Worktree rows read "New Task" with their project as the subtitle, so
    // project names identify which context each row came from.
    const visibleProjectNames = {
      personal: ['Personal repository'],
      [ORG_CONTEXT_A]: ['Personal repository', 'Acme repository'],
      [ORG_CONTEXT_B]: ['Beta repository'],
    };
    const personalChat = 'Personal overview chat';
    for (const context of ['personal', ORG_CONTEXT_A, ORG_CONTEXT_B]) {
      if (context !== 'personal') await selectWorkspaceContext(window, context);
      if (context === ORG_CONTEXT_A) await expectLinkedPersonalCheckout(window);
      const own = visibleProjectNames[context];
      const foreign = [
        'Personal repository',
        'Acme repository',
        'Beta repository',
      ].filter((name) => !own.includes(name));
      // Project commands ("New Worktree in …") and worktree rows.
      for (const query of ['repository', WORKTREE]) {
        await search(query);
        for (const name of own) {
          await expect(results.filter({ hasText: name }).first()).toBeVisible();
        }
        for (const name of foreign) {
          await expect(results.filter({ hasText: name })).toHaveCount(0);
        }
        await close();
      }
      // Chat titles come from main-side chat search, scoped there too.
      await search('Personal overview');
      if (context === 'personal' || context === ORG_CONTEXT_A) {
        await expect(
          results.filter({ hasText: personalChat }).first(),
        ).toBeVisible();
      } else {
        await expect(results.filter({ hasText: personalChat })).toHaveCount(0);
      }
      await close();
    }

    // Explicit switch commands stay available from inside an organization.
    await search('Personal');
    await expect(
      results.filter({ hasText: /Switch to Personal/ }).first(),
    ).toBeVisible();
    await close();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Overview and notifications default to the selected context and cross-context opens switch first', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3461_overview_scope';
  const { electronApp, userDataDir, window, app } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-overview-',
    (dir) =>
      seedPipelineExecution({
        userDataDir: dir,
        workspaceId: ORG_CONTEXT_WORKSPACE,
        worktreeId: `acme-${WORKTREE}`,
        execution: {
          id: 'acme-overview-pipeline',
          pipelineName: 'Acme context pipeline',
          status: 'running',
        },
      }),
  );
  const cases = [
    {
      context: 'personal',
      workspaceId: PERSONAL_CONTEXT_WORKSPACE,
      worktreeId: `personal-${WORKTREE}`,
      chatId: 'personal-overview-chat',
      title: 'Personal overview chat',
    },
    {
      context: ORG_CONTEXT_A,
      workspaceId: ORG_CONTEXT_WORKSPACE,
      worktreeId: `acme-${WORKTREE}`,
      chatId: 'acme-overview-chat',
      title: 'Acme overview chat',
    },
    {
      context: ORG_CONTEXT_B,
      workspaceId: ORG_CONTEXT_B_WORKSPACE,
      worktreeId: `beta-acme-${WORKTREE}`,
      chatId: 'beta-overview-chat',
      title: 'Beta overview chat',
    },
  ];
  try {
    await app.openOverviewPage();
    const cards = window.getByTestId('overview-unread-chat-card');
    const notifications = window.getByTestId('overview-notification-card');

    for (const [index, item] of cases.entries()) {
      if (index > 0) await selectWorkspaceContext(window, item.context);
      await injectChatEvent(electronApp, {
        projectId: item.workspaceId,
        worktreeId: item.worktreeId,
        chatId: item.chatId,
        data: { type: 'result', is_error: false, result: `${item.title} done` },
      });
      await expect(cards.filter({ hasText: item.title })).toBeVisible({
        timeout: 15_000,
      });
      for (const other of cases.filter((candidate) => candidate !== item)) {
        await expect(cards.filter({ hasText: other.title })).toHaveCount(0);
      }
      await expect(
        window.locator(
          `[data-testid="overview-notification-card"][data-project-id="${item.workspaceId}"]`,
        ),
      ).toBeVisible();
      await expect(notifications).toHaveCount(1);
    }

    // The optional all-context view preserves the selected-context default,
    // while still providing a route to a foreign notification. Its click
    // must land the owning context before opening the hidden worktree.
    await chooseSettingsOption(
      window.getByTestId('overview-context-filter'),
      'all',
    );
    await expect(cards).toHaveCount(3);
    const acmeNotification = window.locator(
      `[data-testid="overview-notification-card"][data-project-id="${ORG_CONTEXT_WORKSPACE}"]`,
    );
    await acmeNotification.click();
    await expect
      .poll(() => currentContext(window))
      .toEqual({ kind: 'organization', organizationId: ORG_CONTEXT_A });
    await expect(
      window
        .locator('[data-sidebar-selected-item]')
        .getByTestId('worktree-row'),
    ).toHaveAttribute('data-project-id', ORG_CONTEXT_WORKSPACE);

    // Job dots are independently clickable inside the pipeline card. They
    // must switch to the owning context just like the surrounding card.
    await app.openOverviewPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await chooseSettingsOption(
      window.getByTestId('overview-context-filter'),
      'all',
    );
    const acmePipeline = window
      .getByTestId('overview-in-progress-pipeline-card')
      .filter({ hasText: 'Acme context pipeline' });
    await expect(acmePipeline).toBeVisible();
    await acmePipeline.locator('[data-job-id="build"]').click();
    await expect
      .poll(() => currentContext(window))
      .toEqual({ kind: 'organization', organizationId: ORG_CONTEXT_A });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

function auditEntry(id, projectId, worktreeId, label, startedAt) {
  return {
    id,
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label,
    startedAt,
    completedAt: startedAt,
    durationMs: 1_000,
    tokens: {
      input: 10,
      output: 5,
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
    linkTarget: { page: 'main', kind: 'worktree-chat', projectId, worktreeId },
  };
}

test('Audit Trail shows the selected context and switches context to open another entry', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3461_audit_scope';
  const now = Date.now();
  const foreignEntries = Array.from({ length: 100 }, (_, index) =>
    auditEntry(
      `audit-beta-page-${index}`,
      ORG_CONTEXT_B_WORKSPACE,
      `beta-acme-${WORKTREE}`,
      `Beta audit page ${index}`,
      new Date(now - (index + 1) * 1_000).toISOString(),
    ),
  );
  const { electronApp, userDataDir, window, app } = await launchTwoOrg(
    apiKey,
    'canopy-can3461-audit-',
    (dir) => {
      seedSyntheticAuditOrigins(dir);
      seedObservabilityAudit({
        userDataDir: dir,
        entries: [
          ...foreignEntries,
          auditEntry(
            'audit-personal',
            PERSONAL_CONTEXT_WORKSPACE,
            `personal-${WORKTREE}`,
            'Personal audit run',
            new Date(now - 180_000).toISOString(),
          ),
          auditEntry(
            'audit-acme',
            ORG_CONTEXT_WORKSPACE,
            `acme-${WORKTREE}`,
            'Acme audit run',
            new Date(now - 30_000).toISOString(),
          ),
          auditEntry(
            'audit-beta',
            ORG_CONTEXT_B_WORKSPACE,
            `beta-acme-${WORKTREE}`,
            'Beta audit run',
            new Date(now - 15_000).toISOString(),
          ),
          {
            ...auditEntry(
              'audit-plan-explore',
              'plan-explore-chat',
              'audit-plan',
              'Acme Plan Explore run',
              new Date(now - 12_000).toISOString(),
            ),
            eventType: 'worktree_plan_chat',
            linkTarget: undefined,
          },
          auditEntry(
            'audit-code-review',
            'code-review-chat',
            'audit-review-scope',
            'Acme Code Review run',
            new Date(now - 11_000).toISOString(),
          ),
          {
            ...auditEntry(
              'audit-pipeline-editor',
              'pipeline-editor',
              'pipeline-editor',
              'Global Pipeline Editor run',
              new Date(now - 10_000).toISOString(),
            ),
            eventType: 'pipeline_editor',
            linkTarget: {
              page: 'main',
              kind: 'pipeline-editor',
              chatId: 'pipeline-editor-chat',
            },
          },
        ],
      });
    },
  );
  try {
    await app.openAuditPage();
    // With a selected context the page has four filters, more than fit
    // inline: Scope joins Provider, Status and Event behind one Filter
    // dropdown, which counts the selected context as on.
    const auditFilter = window.getByTestId('audit-trail-filter');
    await expect(auditFilter).toHaveText('Filter · 1');
    await auditFilter.click();
    await expect(
      window
        .getByTestId('audit-trail-filter-menu')
        .getByTestId('audit-trail-context-filter'),
    ).toHaveText('Scope');
    await window.keyboard.press('Escape');
    const personalEntry = window.getByTestId('audit-entry-audit-personal');
    const acmeEntry = window.getByTestId('audit-entry-audit-acme');
    const betaEntry = window.getByTestId('audit-entry-audit-beta');
    const planExploreEntry = window.getByTestId(
      'audit-entry-audit-plan-explore',
    );
    const codeReviewEntry = window.getByTestId('audit-entry-audit-code-review');
    const pipelineEditorEntry = window.getByTestId(
      'audit-entry-audit-pipeline-editor',
    );
    await expect(personalEntry).toBeVisible();
    await expect(acmeEntry).toHaveCount(0);
    await expect(betaEntry).toHaveCount(0);
    await expect(planExploreEntry).toHaveCount(0);
    await expect(codeReviewEntry).toHaveCount(0);
    await expect(pipelineEditorEntry).toBeVisible();

    // Every context stays one choice away; opening a foreign entry switches
    // to its context before it navigates.
    await app.chooseAuditTrailFilter('context', 'all');
    await expect(acmeEntry).toBeVisible();
    await expect(betaEntry).toBeVisible();
    await window.getByTestId('audit-inspect-button-audit-acme').click();
    await expect
      .poll(() => currentContext(window))
      .toEqual({ kind: 'organization', organizationId: ORG_CONTEXT_A });
    await expect(
      window
        .locator('[data-sidebar-selected-item]')
        .getByTestId('worktree-row'),
    ).toHaveAttribute('data-project-id', ORG_CONTEXT_WORKSPACE);

    await app.openAuditPage();
    await app.chooseAuditTrailFilter('context', 'context');
    await expect(window.getByTestId('audit-entry-audit-acme')).toBeVisible();
    await expect(planExploreEntry).toBeVisible();
    await expect(codeReviewEntry).toBeVisible();
    await expect(pipelineEditorEntry).toBeVisible();
    await expect(window.getByTestId('audit-entry-audit-personal')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('audit-entry-audit-beta')).toHaveCount(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(window.getByTestId('audit-entry-audit-beta')).toBeVisible();
    await expect(window.getByTestId('audit-entry-audit-acme')).toHaveCount(0);
    await expect(planExploreEntry).toHaveCount(0);
    await expect(codeReviewEntry).toHaveCount(0);
    await expect(pipelineEditorEntry).toBeVisible();
    await expect(window.getByTestId('audit-entry-audit-personal')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

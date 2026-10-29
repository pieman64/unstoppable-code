/**
 * CAN-3448: Automations follow the Personal/organization context selected in
 * the sidebar. The automations on Workflows › Library, the watchers on
 * Workflows › Runs (CAN-3981), the
 * Marketplace's shared automations (including its "Shared by me" filter,
 * which replaced the Automations Shared tab in CAN-3980) and the Project
 * picker show only what belongs to the selected context (App Advisor shows
 * everywhere). Turning on an automation whose target is in another context
 * binds it to the target's context (CAN-3598).
 * The shared list is paged by the server across owners, so the Marketplace
 * pages past pages that hold nothing for the selected context.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  workflowEditMenuItem,
} from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedAutomations,
  seedOrgContextScoping,
  seedWatchers,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  ORG_CONTEXT_WORKSPACE,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

const CHATS_WORKSPACE = 'cowork-default';
const PERSONAL_ACTIVITY = 'personal-digest';
const ORG_ACTIVITY = 'acme-release-check';
const ADVISOR_ACTIVITY = 'advisor-summary';

function activity(id, name, action) {
  return {
    version: 1,
    id,
    name,
    // Disabled so nothing is scheduled while the spec runs.
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    failureCount: 0,
  };
}

// The mock cloud account's id: `createdBy` this id is a share "Shared by
// me" lists.
const VIEWER_ID = 'account-e2e';

function sharedAutomation(id, name, owner, createdById = 'can3448-author') {
  return {
    id,
    name,
    description: '',
    triggerKind: 'cron',
    actionType: 'app_advisor_prompt',
    contentHash: `${id}-hash`,
    shareScope: owner.type === 'user' ? 'private' : owner.type,
    owner,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: { id: createdById, name: 'Author', email: null },
    canUpdate: false,
    canDelete: false,
    publicShare: null,
  };
}

// Shares published by each kind of owner, one per page. Main lists the
// Personal lane plus the selected organization's lane; the page keeps what
// belongs to the selected context. A person's own shares belong to every
// context (CAN-3597). The first two pages only ever hold another
// organization's shares, so the Marketplace has to keep paging before
// anything in the selected context appears. The viewer created the personal
// (public-link-only) share, the Acme share and one other organization's
// share; "Shared by me" lists only those, in context.
const SHARED_AUTOMATIONS = [
  sharedAutomation('share-other-org', 'Other organization share', {
    type: 'organization',
    id: ORG_CONTEXT_B,
    name: 'Empty organization',
  }),
  sharedAutomation(
    'share-other-org-2',
    'Another other organization share',
    {
      type: 'organization',
      id: ORG_CONTEXT_B,
      name: 'Empty organization',
    },
    VIEWER_ID,
  ),
  sharedAutomation(
    'share-personal',
    'Personal share',
    {
      type: 'user',
      id: VIEWER_ID,
      name: 'Author',
    },
    VIEWER_ID,
  ),
  sharedAutomation(
    'share-acme',
    'Acme share',
    {
      type: 'organization',
      id: ORG_CONTEXT_A,
      name: 'Acme',
    },
    VIEWER_ID,
  ),
  sharedAutomation('share-acme-team', 'Acme team share', {
    type: 'team',
    id: 'acme-team',
    name: 'Platform',
    organization: { id: ORG_CONTEXT_A, name: 'Acme' },
  }),
  sharedAutomation('share-system', 'Built-in share', { type: 'system' }),
];

function watcher(id, label, destinationProjectId) {
  return {
    id,
    label,
    trigger: 'worktree_chat_completion',
    target: {
      kind: 'worktree_chat',
      projectId: ORG_CONTEXT_WORKSPACE,
      worktreeId: 'watched-worktree',
      chatId: `watched-${id}`,
    },
    destination: {
      projectId: destinationProjectId,
      worktreeId: `destination-${id}`,
      chatId: `destination-chat-${id}`,
    },
  };
}

test('automations follow the selected context and bind an out-of-context target to its owner', async () => {
  test.setTimeout(150_000);
  const apiKey = 'csk_can3448_automation_context';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedAutomations: SHARED_AUTOMATIONS,
      sharedAutomationsPageSize: 1,
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3448-'));
  seedOrgContextScoping(userDataDir);
  seedAutomations({
    userDataDir,
    activities: [
      activity(PERSONAL_ACTIVITY, 'Personal digest', {
        type: 'standalone_prompt',
        chatProjectId: CHATS_WORKSPACE,
        prompt: 'Digest my notes.',
      }),
      activity(ORG_ACTIVITY, 'Acme release check', {
        type: 'worktree_prompt',
        workspaceId: ORG_CONTEXT_WORKSPACE,
        prompt: 'Check the release.',
      }),
      activity(ADVISOR_ACTIVITY, 'Advisor summary', {
        type: 'app_advisor_prompt',
        prompt: 'Summarize the day.',
      }),
    ],
  });
  seedWatchers({
    userDataDir,
    watchers: [
      watcher('personal-watcher', 'Personal watcher', CHATS_WORKSPACE),
      watcher('acme-watcher', 'Acme watcher', ORG_CONTEXT_WORKSPACE),
      watcher('advisor-watcher', 'Advisor watcher', 'app-advisor'),
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const row = (id) => app.workflowsLibraryAutomationRow(id);
    const watcherRow = (id) => app.workflowsWatcherRunRow(id);
    let sharedSection = 'customize-section-browse';
    const sharedRow = (id) =>
      window
        .getByTestId(sharedSection)
        .getByTestId(
          sharedSection === 'customize-section-shared-by-me'
            ? `customize-row-automation:shared:${id}`
            : `plugins-entry-automation:shared:${id}`,
        );
    const loadMore = window.getByTestId('automation-catalog-load-more');
    const showSharedByMe = async () => {
      sharedSection = 'customize-section-shared-by-me';
      await window.getByTestId(sharedSection).scrollIntoViewIfNeeded();
    };
    // Load the remaining pages the way a person would, one click at a time.
    const loadRemainingShared = async () => {
      await expect
        .poll(async () => {
          if ((await loadMore.isVisible()) && (await loadMore.isEnabled()))
            await loadMore.click({ timeout: 1_000 }).catch(() => undefined);
          return loadMore.isVisible();
        })
        .toBe(false);
    };

    // 1. In the organization, only its automations and App Advisor's show.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openAutomationsPage();
    await expect(row(ORG_ACTIVITY)).toBeVisible();
    await expect(row(ADVISOR_ACTIVITY)).toBeVisible();
    await expect(row(PERSONAL_ACTIVITY)).toHaveCount(0);

    await app.openWatchersPage();
    await expect(watcherRow('acme-watcher')).toBeVisible();
    await expect(watcherRow('advisor-watcher')).toBeVisible();
    await expect(watcherRow('personal-watcher')).toHaveCount(0);

    // Marketplace › Automations lists the organization's (and its teams')
    // shares and built-in ones, never another organization's. The first two
    // pages hold nothing for Acme, so the list pages past them.
    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-workflow').click();
    sharedSection = 'customize-section-browse';
    await loadRemainingShared();
    await expect(sharedRow('share-acme')).toBeVisible();
    await expect(sharedRow('share-acme-team')).toBeVisible();
    await expect(sharedRow('share-system')).toBeVisible();
    // A public-link-only share is not a share with anyone, so it only lists
    // under "Shared by me".
    await expect(sharedRow('share-personal')).toBeVisible();
    await expect(sharedRow('share-other-org')).toHaveCount(0);
    await expect(sharedRow('share-other-org-2')).toHaveCount(0);

    // "Shared by me" (CAN-3980, replacing the Automations Shared tab) lists
    // the viewer's own shares in this context: their personal one, which
    // follows them across contexts, and Acme's, never another organization's
    // or someone else's.
    await showSharedByMe();
    await loadRemainingShared();
    await expect(sharedRow('share-personal')).toBeVisible();
    await expect(sharedRow('share-acme')).toBeVisible();
    await expect(sharedRow('share-acme-team')).toHaveCount(0);
    await expect(sharedRow('share-system')).toHaveCount(0);
    await expect(sharedRow('share-other-org')).toHaveCount(0);
    await expect(sharedRow('share-other-org-2')).toHaveCount(0);
    await app.openAutomationsPage();

    // 2. The Project picker offers no Personal project.
    await app.startNewWorkflow('schedule');
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await window.getByTestId('automations-form-action-type-workspace').click();
    await window.getByTestId('automations-form-workspace').click();
    const options = window.getByRole('option');
    await expect(
      options.filter({ hasText: 'Acme repository' }).first(),
    ).toBeVisible();
    // Each organization has its own default Chats workspace (#4159), so the
    // picker offers exactly one Chats: the organization's. Personal Chats
    // carries the same label and must not appear beside it.
    await expect(options.filter({ hasText: /^Chats$/ })).toHaveCount(1);
    await expect(
      options.filter({ hasText: 'Personal repository' }),
    ).toHaveCount(0);
    await window.getByTestId('automations-form-workspace').click();
    await expect(window.getByRole('listbox')).toHaveCount(0);
    // Choosing the workspace action edited the draft, so Back asks.
    await backFromWorkflowEdit(window, { discard: true });
    await expect(window.getByTestId('workflow-edit-shell')).toBeHidden();

    // 3. A deep link still opens the Personal automation, and a note
    //    explains where it runs.
    await window.evaluate((activityId) => {
      window.__canopyNavigationTestApi?.openAutomationEdit(activityId);
    }, PERSONAL_ACTIVITY);
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await expect(
      window.getByTestId('automations-form-workspace'),
    ).toContainText('Chats');
    await expect(
      window.getByTestId('automations-form-context-note'),
    ).toHaveText(
      'Chats is in Personal, so turning this automation on runs it there.',
    );

    // 4. Turning it on with Acme selected binds it to Personal. The edit
    //    shell's ⋯ menu saves `enabled` on its own (CAN-4072).
    const offState = window.getByTestId('workflow-edit-enabled-state');
    await expect(offState).toHaveText('Off');
    const turnOn = await workflowEditMenuItem(
      window,
      'automations-form-enabled',
    );
    await expect(turnOn).toHaveText('Turn on');
    await turnOn.click();
    await expect(offState).toHaveCount(0);
    const savedPersonalActivity = () =>
      window.evaluate(async (activityId) => {
        const { activities } = await window.api.automations.list();
        const saved = activities.find((entry) => entry.id === activityId);
        return saved
          ? { enabled: saved.enabled, executionContext: saved.executionContext }
          : null;
      }, PERSONAL_ACTIVITY);
    await expect
      .poll(savedPersonalActivity)
      .toEqual({ enabled: true, executionContext: 'personal' });
    await backFromWorkflowEdit(window);
    // Off again so nothing is scheduled while the spec runs.
    await window.evaluate(
      (id) => window.api.automations.update({ id, enabled: false }),
      PERSONAL_ACTIVITY,
    );
    await expect
      .poll(savedPersonalActivity)
      .toEqual({ enabled: false, executionContext: 'personal' });

    // 5. Switching to Personal flips the list.
    await selectWorkspaceContext(window, 'personal');
    await app.openAutomationsPage();
    await expect(row(PERSONAL_ACTIVITY)).toBeVisible();
    await expect(row(ADVISOR_ACTIVITY)).toBeVisible();
    await expect(row(ORG_ACTIVITY)).toHaveCount(0);

    await app.openWatchersPage();
    await expect(watcherRow('personal-watcher')).toBeVisible();
    await expect(watcherRow('advisor-watcher')).toBeVisible();
    await expect(watcherRow('acme-watcher')).toHaveCount(0);

    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-workflow').click();
    sharedSection = 'customize-section-browse';
    await loadRemainingShared();
    await expect(sharedRow('share-system')).toBeVisible();
    await expect(sharedRow('share-personal')).toBeVisible();
    await expect(sharedRow('share-acme')).toHaveCount(0);
    await expect(sharedRow('share-acme-team')).toHaveCount(0);
    await expect(sharedRow('share-other-org')).toHaveCount(0);
    await expect(sharedRow('share-other-org-2')).toHaveCount(0);

    await showSharedByMe();
    await loadRemainingShared();
    await expect(sharedRow('share-personal')).toBeVisible();
    await expect(sharedRow('share-acme')).toHaveCount(0);
    await expect(sharedRow('share-acme-team')).toHaveCount(0);
    await expect(sharedRow('share-system')).toHaveCount(0);
    await expect(sharedRow('share-other-org-2')).toHaveCount(0);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

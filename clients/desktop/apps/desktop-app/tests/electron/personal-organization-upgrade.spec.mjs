import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  closeUpgradeDialog,
  expectProjectOutcome,
  openPersonalOrganizationUpgrade,
} from './fixtures/personal-organization-upgrade.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  getScenarioActivity,
  DEFAULT_MOCK_BASE_URL,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  registerScenario,
  seedOrgContextScoping,
  seedWorktreeChat,
  seedStoredPipeline,
} from './seeders/index.mjs';

const SELECTED = 'context-personal';
const UNTICKED = 'upgrade-unticked';
const WORKTREE = 'upgrade-history';
const CHAT = 'upgrade-preserved-chat';

function seedSelection(userDataDir) {
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: [WORKTREE],
    extraPersonalWorkspaces: [{ id: UNTICKED, name: 'Keep Personal' }],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: SELECTED,
    worktreeId: WORKTREE,
    tabs: [
      {
        id: CHAT,
        title: 'Preserved history',
        blocks: [{ type: 'text', text: 'History survives team conversion.' }],
      },
    ],
  });
}

function workspace(fixture, id) {
  return JSON.parse(
    readFileSync(
      path.join(fixture.userDataDir, 'workspaces', id, 'workspace.json'),
      'utf8',
    ),
  );
}

async function history(page) {
  return page.evaluate(
    async ({ projectId, worktreeId, chatId }) => {
      await window.api.chat.flushScope({ projectId, worktreeId });
      const file = await window.api.chat.loadTabs({ projectId, worktreeId });
      const tab = file.tabs.find((entry) => entry.id === chatId);
      return tab
        ? { id: tab.id, title: tab.title, messages: tab.messages }
        : null;
    },
    { projectId: SELECTED, worktreeId: WORKTREE, chatId: CHAT },
  );
}

for (const sharingFails of [false, true]) {
  test(`preserves selected history and unticked ownership${sharingFails ? ' through a private sharing retry' : ''}`, async () => {
    test.setTimeout(180_000);
    const fixture = await openPersonalOrganizationUpgrade({
      seed: seedSelection,
      cloud: sharingFails ? { memberProjectShareStatus: 503 } : {},
    });
    try {
      const page = fixture.window;
      await page.evaluate(
        ({ projectId, worktreeId }) =>
          window.api.chat.loadTabs({ projectId, worktreeId }),
        { projectId: SELECTED, worktreeId: WORKTREE },
      );
      const originalHistory = await history(page);
      expect(originalHistory?.messages[0]?.blocks).toEqual([
        { type: 'text', text: 'History survives team conversion.' },
      ]);
      const unticked = workspace(fixture, UNTICKED);
      const selected = workspace(fixture, SELECTED);
      await page
        .getByTestId('invite-to-organization-team-name')
        .fill('History team');
      await expect(
        page.getByTestId(`invite-to-organization-project-${SELECTED}-input`),
      ).toBeChecked();
      await page
        .getByTestId(`invite-to-organization-project-${UNTICKED}-input`)
        .uncheck();
      await page.getByTestId('invite-to-organization-submit').click();
      await expectProjectOutcome(
        page,
        SELECTED,
        sharingFails ? 'converted-private' : 'moved',
        { timeout: 60_000 },
      );
      const owner = workspace(fixture, SELECTED).owner;
      expect(owner).toMatchObject({
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
      });
      expect(workspace(fixture, SELECTED).repoPath).toBe(selected.repoPath);
      expect(workspace(fixture, UNTICKED)).toEqual(unticked);
      expect(await history(page)).toEqual(originalHistory);
      expect(
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity
          .orgMemberProjectCreate,
      ).toBe(1);
      if (sharingFails) {
        const response = await fetch(
          `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(fixture.key)}`,
        );
        expect(response.ok).toBe(true);
        const { scenario } = await response.json();
        delete scenario.cloud.memberProjectShareStatus;
        await registerScenario(DEFAULT_MOCK_BASE_URL, fixture.key, scenario);
        await page.getByTestId('invite-to-organization-retry-projects').click();
        await expectProjectOutcome(page, SELECTED, 'moved', {
          timeout: 60_000,
        });
        expect(workspace(fixture, SELECTED).owner.projectId).toBe(
          owner.projectId,
        );
        expect(
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key))
            .activity.orgMemberProjectCreate ?? 0,
        ).toBe(0);
        expect(await history(page)).toEqual(originalHistory);
        expect(workspace(fixture, UNTICKED)).toEqual(unticked);
      }
    } finally {
      await fixture.close();
    }
  });
}

test('creates a team in place without moving unticked projects and keeps a replacement Personal', async () => {
  test.setTimeout(120_000);
  const fixture = await openPersonalOrganizationUpgrade();
  try {
    const page = fixture.window;
    await page
      .getByTestId('invite-to-organization-team-name')
      .fill('Audit team');
    await expect(
      page.getByTestId('invite-to-organization-projects-loading'),
    ).toHaveCount(0);
    const boxes = page.locator(
      '[data-testid^="invite-to-organization-project-"] input[type="checkbox"]',
    );
    for (const box of await boxes.all()) await box.uncheck();
    await page.getByTestId('invite-to-organization-submit').click();
    await expect(
      page.getByTestId('invite-to-organization-team-created'),
    ).toContainText('Audit team');
    const account = await page.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    expect(
      account.organizations.find((org) => org.id === ORG_CONTEXT_A),
    ).toMatchObject({
      name: 'Audit team',
      automaticPersonalProjectConversionExcluded: true,
    });
    expect(account.personalOrganizationId).not.toBe(ORG_CONTEXT_A);
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      fixture.key,
    );
    expect(activity.personalOrganizationPromotion).toBe(1);
    expect(activity.orgMemberProjectCreate ?? 0).toBe(0);
  } catch (error) {
    console.error(
      'Upgrade flow state:',
      await fixture.window.evaluate(() => document.body.innerText),
    );
    console.error(
      'Upgrade flow activity:',
      await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key),
    );
    throw error;
  } finally {
    await fixture.close();
  }
});

for (const delivery of [
  'sent',
  'resent',
  'deferred-for-payment',
  'email-suppressed',
]) {
  test(`reports the confirmed invitation outcome ${delivery}`, async () => {
    test.setTimeout(120_000);
    const fixture = await openPersonalOrganizationUpgrade({ delivery });
    try {
      const page = fixture.window;
      await page
        .getByTestId('invite-to-organization-team-name')
        .fill('Inviting team');
      await expect(
        page.getByTestId('invite-to-organization-projects-loading'),
      ).toHaveCount(0);
      for (const box of await page
        .locator(
          '[data-testid^="invite-to-organization-project-"] input[type="checkbox"]',
        )
        .all())
        await box.uncheck();
      await page
        .getByTestId('invite-to-organization-email')
        .fill('pat@example.com');
      await page.getByTestId('invite-to-organization-submit').click();
      await expect(
        page.getByTestId('invite-to-organization-invite-outcome'),
      ).toHaveAttribute('data-status', delivery);
      expect(
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity
          .organizationInvitation,
      ).toBe(1);
    } catch (error) {
      console.error(
        'Invite flow state:',
        await fixture.window.evaluate(() => document.body.innerText),
      );
      console.error(
        'Invite flow activity:',
        await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key),
      );
      throw error;
    } finally {
      await fixture.close();
    }
  });
}

test('recovers a lost invitation reply as a definite failure and retries only on request', async () => {
  test.setTimeout(120_000);
  const fixture = await openPersonalOrganizationUpgrade({
    cloud: {
      organizationInvitationReplyLostOnce: true,
      organizationInvitationReconcileRefused: true,
    },
  });
  try {
    const page = fixture.window;
    await page
      .getByTestId('invite-to-organization-team-name')
      .fill('Recovery team');
    await expect(
      page.getByTestId('invite-to-organization-projects-loading'),
    ).toHaveCount(0);
    for (const box of await page
      .locator(
        '[data-testid^="invite-to-organization-project-"] input[type="checkbox"]',
      )
      .all())
      await box.uncheck();
    await page
      .getByTestId('invite-to-organization-email')
      .fill('pat@example.com');
    await page.getByTestId('invite-to-organization-submit').click();
    const failure = page.getByTestId('invite-to-organization-invite-failed');
    await expect(failure).toBeVisible();
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity
        .organizationInvitation,
    ).toBe(1);
    await failure
      .getByRole('button', { name: 'Try the invite again', exact: true })
      .click();
    await expect(
      page.getByTestId('invite-to-organization-invite-outcome'),
    ).toHaveAttribute('data-status', 'resent');
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity
        .organizationInvitation,
    ).toBe(2);
  } finally {
    await fixture.close();
  }
});

test('resumes a never-sent invitation after closing during project conversion', async () => {
  test.setTimeout(180_000);
  const fixture = await openPersonalOrganizationUpgrade({
    seed: seedSelection,
    cloud: { orgMemberProjectCreateDelayMs: 8000 },
  });
  try {
    const page = fixture.window;
    await page
      .getByTestId('invite-to-organization-team-name')
      .fill('Recovered invite team');
    await page
      .getByTestId(`invite-to-organization-project-${UNTICKED}-input`)
      .uncheck();
    await page
      .getByTestId('invite-to-organization-email')
      .fill('pat@example.com');
    await page.getByTestId('invite-to-organization-submit').click();
    await expect(
      page.getByTestId('invite-to-organization-projects-moving'),
    ).toBeVisible();
    await closeUpgradeDialog(page);
    await expect(
      page.getByTestId('invite-to-organization-outcome'),
    ).toHaveCount(0);
    await expect
      .poll(() => workspace(fixture, SELECTED).owner?.type, { timeout: 60_000 })
      .toBe('organization');
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity
        .organizationInvitation ?? 0,
    ).toBe(0);
    await page.getByTestId('sidebar-context-row').click();
    await page.getByTestId('sidebar-context-option-personal').click();
    await page.getByTestId('sidebar-context-row').click();
    await page.getByTestId('account-create-team-row').click();
    await expect(
      page.getByTestId('invite-to-organization-invite-outcome'),
    ).toHaveAttribute('data-status', 'sent');
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      fixture.key,
    );
    expect(activity.personalOrganizationPromotion).toBe(1);
    expect(activity.orgMemberProjectCreate).toBe(1);
    expect(activity.organizationInvitation).toBe(1);
    expect(workspace(fixture, UNTICKED).owner).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test('returns to the original pipeline share dialog with the promoted organization selected', async () => {
  test.setTimeout(180_000);
  const pipelineId = 'upgrade-share-return';
  const title = 'Original Personal pipeline';
  const fixture = await openPersonalOrganizationUpgrade({
    seed: (userDataDir) => {
      seedSelection(userDataDir);
      seedStoredPipeline({
        userDataDir,
        id: pipelineId,
        name: title,
        yaml: [
          'name: Original Personal pipeline',
          'on: dispatch',
          'jobs:',
          '  main:',
          '    steps:',
          '      - run: echo original',
          '',
        ].join('\n'),
      });
    },
  });
  try {
    const page = fixture.window;
    await page.keyboard.press('Escape');
    const app = new CanopyAppDriver(page);
    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(pipelineId),
    );
    await page.getByTestId('pipeline-share').click();
    await expect(page.getByTestId('share-pipeline-modal')).toContainText(title);
    // Create a team lives in the disabled Team pill's tooltip.
    await page.getByTestId('share-pipeline-scope-team').hover();
    await page.getByTestId('share-pipeline-set-up-organization').click();
    await page
      .getByTestId('invite-to-organization-team-name')
      .fill('Pipeline sharing team');
    await expect(
      page.getByTestId('invite-to-organization-projects-loading'),
    ).toHaveCount(0);
    for (const box of await page
      .locator(
        '[data-testid^="invite-to-organization-project-"] input[type="checkbox"]',
      )
      .all())
      await box.uncheck();
    await page.getByTestId('invite-to-organization-submit').click();
    await expect(
      page.getByTestId('invite-to-organization-team-created'),
    ).toContainText('Pipeline sharing team');
    await page.getByTestId('invite-to-organization-done').click();
    const modal = page.getByTestId('share-pipeline-modal');
    await expect(modal).toContainText(title);
    await expect(
      modal.getByRole('radio', { name: 'Organization', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      page
        .getByTestId(
          `share-pipeline-organization-picker-option-${ORG_CONTEXT_A}`,
        )
        .locator('[data-selected=true]'),
    ).toBeVisible();
    expect(workspace(fixture, SELECTED).owner).toBeUndefined();
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity
        .orgMemberProjectCreate ?? 0,
    ).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('reopens a conversion that failed before journaling and retries only selected projects', async () => {
  test.setTimeout(180_000);
  const fixture = await openPersonalOrganizationUpgrade({
    seed: seedSelection,
    cloud: { personalUpgradeDestinationUnavailable: true },
  });
  try {
    const page = fixture.window;
    await page
      .getByTestId('invite-to-organization-team-name')
      .fill('Destination retry team');
    await page
      .getByTestId(`invite-to-organization-project-${UNTICKED}-input`)
      .uncheck();
    await page.getByTestId('invite-to-organization-submit').click();
    await expect(
      page.getByTestId('invite-to-organization-projects-failed'),
    ).toBeVisible();
    expect(
      existsSync(
        path.join(fixture.userDataDir, 'personal-organization-upgrade.json'),
      ),
    ).toBe(false);
    const initial = (
      await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)
    ).activity;
    expect(initial.personalOrganizationPromotion).toBe(1);
    expect(initial.orgMemberProjectCreate ?? 0).toBe(0);
    await closeUpgradeDialog(page);
    const response = await fetch(
      `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(fixture.key)}`,
    );
    expect(response.ok).toBe(true);
    const { scenario } = await response.json();
    scenario.cloud.personalUpgradeDestinationUnavailable = false;
    scenario.cloud.organizations.push({
      id: ORG_CONTEXT_A,
      name: 'Destination retry team',
      role: 'OWNER',
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
      automaticPersonalProjectConversionExcluded: true,
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, fixture.key, scenario);
    await page.getByTestId('sidebar-context-row').click();
    await page.getByTestId('account-create-team-row').click();
    await expect(
      page.getByTestId('invite-to-organization-projects-failed'),
    ).toBeVisible();
    await page
      .getByTestId('invite-to-organization-projects-failed')
      .getByRole('button', { name: 'Try projects again', exact: true })
      .click();
    await expectProjectOutcome(page, SELECTED, 'moved');
    expect(workspace(fixture, UNTICKED).owner).toBeUndefined();
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      fixture.key,
    );
    expect(activity.orgMemberProjectCreate).toBe(1);
    expect(activity.personalOrganizationPromotion ?? 0).toBe(0);
    const finalResponse = await fetch(
      `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(fixture.key)}`,
    );
    const finalState = await finalResponse.json();
    expect(
      Object.keys(finalState.scenario.cloud.promotionReceipts),
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('reopens a project-limit refusal and retries after capacity is freed', async () => {
  test.setTimeout(180_000);
  const fixture = await openPersonalOrganizationUpgrade({
    seed: seedSelection,
    cloud: { orgMemberProjectCreateStatus: 409 },
  });
  try {
    const page = fixture.window;
    await page
      .getByTestId('invite-to-organization-team-name')
      .fill('Capacity retry team');
    await page
      .getByTestId(`invite-to-organization-project-${UNTICKED}-input`)
      .uncheck();
    await page.getByTestId('invite-to-organization-submit').click();
    await expectProjectOutcome(page, SELECTED, 'limit-reached');
    expect(workspace(fixture, SELECTED).owner).toBeUndefined();
    const original = JSON.parse(
      readFileSync(
        path.join(fixture.userDataDir, 'personal-organization-upgrade.json'),
        'utf8',
      ),
    );
    await closeUpgradeDialog(page);
    const response = await fetch(
      `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(fixture.key)}`,
    );
    const { scenario } = await response.json();
    delete scenario.cloud.orgMemberProjectCreateStatus;
    await registerScenario(DEFAULT_MOCK_BASE_URL, fixture.key, scenario);
    await page.getByTestId('sidebar-context-row').click();
    await page.getByTestId('sidebar-context-option-personal').click();
    await page.getByTestId('sidebar-context-row').click();
    await page.getByTestId('account-create-team-row').click();
    await expectProjectOutcome(page, SELECTED, 'limit-reached');
    await page.getByTestId('invite-to-organization-retry-projects').click();
    await expectProjectOutcome(page, SELECTED, 'moved');
    expect(workspace(fixture, UNTICKED).owner).toBeUndefined();
    const final = JSON.parse(
      readFileSync(
        path.join(fixture.userDataDir, 'personal-organization-upgrade.json'),
        'utf8',
      ),
    );
    expect(final.operations[0].operationId).toBe(
      original.operations[0].operationId,
    );
    expect(final.operations[0].selection).toEqual(
      original.operations[0].selection,
    );
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      fixture.key,
    );
    expect(activity.orgMemberProjectCreate).toBe(1);
    expect(activity.personalOrganizationPromotion ?? 0).toBe(0);
  } finally {
    await fixture.close();
  }
});

/** Local receiver standing in for the host browser (see legal-consent-links). */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('checks off the team and each invite, invites more, then opens the team settings with Manage', async () => {
  test.setTimeout(120_000);
  const externalOpen = await startExternalOpenCapture();
  const fixture = await openPersonalOrganizationUpgrade({
    env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url },
  });
  try {
    const page = fixture.window;
    await expect(
      page.getByTestId('invite-to-organization-modal'),
    ).toContainText('Work together in one shared place.');
    await expect(
      page.getByTestId('invite-to-organization-consent'),
    ).toHaveCount(0);
    await page
      .getByTestId('invite-to-organization-team-name')
      .fill('Checklist team');
    await expect(
      page.getByTestId('invite-to-organization-projects-loading'),
    ).toHaveCount(0);
    for (const box of await page
      .locator(
        '[data-testid^="invite-to-organization-project-"] input[type="checkbox"]',
      )
      .all())
      await box.uncheck();
    await page
      .getByTestId('invite-to-organization-email')
      .fill('pat@example.com');
    await page.getByTestId('invite-to-organization-submit').click();
    await expect(
      page.getByTestId('invite-to-organization-team-created'),
    ).toHaveAttribute('data-step-status', 'completed');
    await expect(
      page.getByTestId('invite-to-organization-invite-outcome'),
    ).toHaveAttribute('data-step-status', 'completed');
    await expect(page.getByTestId('invite-to-organization-done')).toHaveCount(
      0,
    );

    await page
      .getByTestId('invite-to-organization-invite-more-email')
      .fill('sam@example.com');
    await page.getByTestId('invite-to-organization-invite-more-submit').click();
    const more = page.getByTestId('invite-to-organization-more-invite-0');
    await expect(more).toHaveAttribute('data-status', 'sent');
    await expect(more).toContainText('Invited sam@example.com');
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity
        .organizationInvitation,
    ).toBe(2);

    await page.getByTestId('invite-to-organization-manage').click();
    await expect(page.getByTestId('invite-to-organization-modal')).toHaveCount(
      0,
    );
    // Manage opens the team's Settings inside the desktop Settings overlay
    // (hosted organization settings, CAN-4386) instead of the browser.
    // This scenario seeds no hosted settings data, so the hosted frame shows
    // its own state; the point is that Settings opened in the app.
    await expect(page.getByTestId('settings-overlay')).toBeVisible();
    await expect(
      page
        .getByTestId('settings-content')
        .locator('[data-testid^="hosted-settings-"]')
        .first(),
    ).toBeVisible();
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, fixture.key)).activity[
        `authLinkMint:/organization/${ORG_CONTEXT_A}/settings`
      ] ?? 0,
    ).toBe(0);
    expect(externalOpen.opened).toHaveLength(0);
  } finally {
    await fixture.close();
    await externalOpen.close();
  }
});

test('invites more people into the selected organization from the context switcher, then Manage', async () => {
  test.setTimeout(120_000);
  const key = `csk_can3706_org_${Date.now()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      personalOrganizationUpgrade: true,
      personalOrganizationId: ORG_CONTEXT_A,
      organizations: [
        {
          id: ORG_CONTEXT_B,
          name: 'Scope invite team',
          role: 'ADMIN',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      teams: [],
    },
  });
  const externalOpen = await startExternalOpenCapture();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3706-org-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
    },
  });
  try {
    const page = await electronApp.firstWindow();
    await new CanopyAppDriver(page).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(page, key, {
      expectedAccount: { personalOrganizationId: ORG_CONTEXT_A },
    });
    await selectWorkspaceContext(page, ORG_CONTEXT_B);
    // The personal account menu has no team actions any more (CAN-4054).
    await page.getByTestId('sidebar-account-row').click();
    await expect(page.getByTestId('account-invite-team-row')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('sidebar-context-row').click();
    await expect(page.getByTestId('account-create-team-row')).toHaveCount(0);
    const row = page.getByTestId('account-invite-team-row');
    await expect(row).toHaveText('Invite your team');
    await row.click();
    await expect(
      page.getByTestId('invite-to-organization-modal'),
    ).toContainText('Invite your team');
    await expect(
      page.getByTestId('invite-to-organization-create-team'),
    ).toHaveCount(0);
    for (const [index, email] of [
      'sam@example.com',
      'lee@example.com',
    ].entries()) {
      await page
        .getByTestId('invite-to-organization-invite-more-email')
        .fill(email);
      await page
        .getByTestId('invite-to-organization-invite-more-submit')
        .click();
      await expect(
        page.getByTestId(`invite-to-organization-more-invite-${index}`),
      ).toHaveAttribute('data-status', 'sent');
    }
    const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
    expect(activity.organizationInvitation).toBe(2);
    expect(activity.personalOrganizationPromotion ?? 0).toBe(0);
    await page.getByTestId('invite-to-organization-manage').click();
    await expect(page.getByTestId('invite-to-organization-modal')).toHaveCount(
      0,
    );
    // Manage opens the organization's Settings in the desktop overlay.
    // This scenario seeds no hosted settings data, so the hosted frame shows
    // its own state; the point is that Settings opened in the app.
    await expect(page.getByTestId('settings-overlay')).toBeVisible();
    await expect(
      page
        .getByTestId('settings-content')
        .locator('[data-testid^="hosted-settings-"]')
        .first(),
    ).toBeVisible();
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity[
        `authLinkMint:/organization/${ORG_CONTEXT_B}/settings`
      ] ?? 0,
    ).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    await externalOpen.close();
  }
});

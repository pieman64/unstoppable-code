import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { acceptSharedContainerInvitation } from './sharedContainerRecipientActions.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
  seedSharedContainerRecipientReplicas,
  sharedContainerRecipientScenario,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  PERSONAL_CONTEXT_WORKSPACE,
  ORG_CONTEXT_WORKSPACE,
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

test('workspace context scopes Personal and per-organization Chats and survives restart', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2954_context_scoping';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2954-'));
  seedOrgContextScoping(userDataDir);
  let { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    let window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const chats = window.getByTestId('sidebar-section-chats');
    const personalChat = window.locator(
      '[data-standalone-chat-id="context-personal-chat"]',
    );
    const personal = window.locator(
      `[data-sidebar-workspace-id="${PERSONAL_CONTEXT_WORKSPACE}"]`,
    );
    const organization = window.locator(
      `[data-sidebar-workspace-id="${ORG_CONTEXT_WORKSPACE}"]`,
    );
    await expectWorkspaceContext(window, 'personal');
    await expect(personal).toBeVisible();
    await expect(chats).toBeVisible();
    await expect(personalChat).toBeVisible();
    await expect(personalChat).toContainText('Personal planning chat');
    await expect(organization).toHaveCount(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(organization).toBeVisible();
    await expect(personal).toHaveCount(0);
    await expect(chats).toBeVisible();
    await expect(personalChat).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-section-chats-settings'),
    ).toBeEnabled({ timeout: 15_000 });
    await chats.hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();
    await expect(window.getByTestId('page-chat')).toBeVisible();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.locator('[data-standalone-chat-id]')).toHaveCount(1);

    // The alignment reference: where a real project's name starts, and how
    // far under the Projects header its row sits. The rail is not resized or
    // moved between this and the empty organization.
    const projectsHeader = window.getByTestId('sidebar-section-code-toggle');
    const projectNameBox = await window
      .getByTestId(`sidebar-project-header-${ORG_CONTEXT_WORKSPACE}`)
      .getByText('Acme repository', { exact: true })
      .boundingBox();
    const listedHeaderBox = await projectsHeader.boundingBox();
    if (projectNameBox === null || listedHeaderBox === null) {
      throw new Error(
        'the seeded organization project name or the Projects header has no layout box',
      );
    }
    // With a project listed, the Projects "+" waits for a hover. Playwright
    // counts a transparent control as visible, so read its opacity.
    const addProject = window.getByTestId('sidebar-section-code-add');
    const newChat = window.getByTestId('sidebar-section-chats-new-chat');
    await window.mouse.move(900, 500);
    await expect(addProject).toHaveCSS('opacity', '0');

    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    // An empty Projects list is one `None found` row, also under a listed
    // Chats section (CAN-3550). The row carries no action of its own.
    const empty = window.getByTestId('sidebar-context-empty-state');
    await expect(empty).toHaveText('None found');
    await expect(
      window.getByTestId('sidebar-context-empty-state-add'),
    ).toHaveCount(0);
    await expect(empty.getByRole('button')).toHaveCount(0);
    // The empty Chats section lists the same row, inside its rows block.
    const chatsEmpty = window
      .getByTestId('sidebar-section-chats-content')
      .getByTestId(`sidebar-cowork-project-cowork-org-${ORG_CONTEXT_B}-empty`);
    await expect(chatsEmpty).toHaveText('None found');
    // Both headers keep their "+" on screen with the pointer elsewhere:
    // nothing else adds to an empty section.
    await window.mouse.move(900, 500);
    await expect(addProject).toHaveCSS('opacity', '1');
    await expect(newChat).toHaveCSS('opacity', '1');
    await expect(
      window.getByTestId('sidebar-context-empty-state-back'),
    ).toHaveCount(0);
    await expect(personal).toHaveCount(0);
    await expect(chats).toBeVisible();
    // Its label starts where a project name does, and the row sits under the
    // Projects header where the first project row would.
    const emptyLabelBox = await empty
      .getByTestId('sidebar-context-empty-state-label')
      .boundingBox();
    const emptyHeaderBox = await projectsHeader.boundingBox();
    const chatsEmptyLabelBox = await chatsEmpty
      .getByTestId(
        `sidebar-cowork-project-cowork-org-${ORG_CONTEXT_B}-empty-label`,
      )
      .boundingBox();
    const addProjectBox = await addProject.boundingBox();
    const newChatBox = await newChat.boundingBox();
    if (
      emptyLabelBox === null ||
      emptyHeaderBox === null ||
      chatsEmptyLabelBox === null ||
      addProjectBox === null ||
      newChatBox === null
    ) {
      throw new Error(
        'an empty section row, its header, or a header "+" has no layout box',
      );
    }
    expect(Math.abs(emptyLabelBox.x - projectNameBox.x)).toBeLessThanOrEqual(1);
    // The two sections line up: the same label edge, and the "+" of each on
    // one right edge.
    expect(
      Math.abs(chatsEmptyLabelBox.x - emptyLabelBox.x),
    ).toBeLessThanOrEqual(1);
    expect(chatsEmptyLabelBox.y).toBeLessThan(emptyHeaderBox.y);
    expect(Math.abs(addProjectBox.x - newChatBox.x)).toBeLessThanOrEqual(1);
    // Classic (space-taking) scrollbars widen the Chats header's trailing
    // inset to keep its "+" clear of the rail. The Projects header follows
    // it, so the two stay on one edge whichever scrollbars the host shows.
    // The preference attribute is written directly, as the scrollbar specs
    // do: the app observes it and republishes `data-scrollbars`.
    const hostScrollbars = await window.evaluate(() => ({
      behavior: document.documentElement.dataset.scrollbarBehavior ?? null,
      mode: document.documentElement.dataset.scrollbars ?? null,
    }));
    const addOffsetWithScrollbars = async (behavior, mode) => {
      await window.evaluate((value) => {
        if (value === null) {
          delete document.documentElement.dataset.scrollbarBehavior;
        } else {
          document.documentElement.dataset.scrollbarBehavior = value;
        }
      }, behavior);
      await expect
        .poll(() =>
          window.evaluate(
            () => document.documentElement.dataset.scrollbars ?? null,
          ),
        )
        .toBe(mode);
      const projectsAdd = await addProject.boundingBox();
      const chatsAdd = await newChat.boundingBox();
      if (projectsAdd === null || chatsAdd === null) {
        throw new Error('a header "+" has no layout box');
      }
      return Math.abs(projectsAdd.x - chatsAdd.x);
    };
    expect(
      await addOffsetWithScrollbars('always', 'always'),
    ).toBeLessThanOrEqual(1);
    expect(
      await addOffsetWithScrollbars('scroll', 'overlay'),
    ).toBeLessThanOrEqual(1);
    // Back on the host's own setting, and settled, before the flow goes on.
    expect(
      await addOffsetWithScrollbars(
        hostScrollbars.behavior,
        hostScrollbars.mode,
      ),
    ).toBeLessThanOrEqual(1);
    expect(emptyLabelBox.y).toBeGreaterThanOrEqual(
      emptyHeaderBox.y + emptyHeaderBox.height,
    );
    expect(
      Math.abs(
        emptyLabelBox.y -
          emptyHeaderBox.y -
          (projectNameBox.y - listedHeaderBox.y),
      ),
    ).toBeLessThanOrEqual(8);
    await expect(personalChat).toHaveCount(0);
    await expect(window.locator('[data-standalone-chat-id]')).toHaveCount(0);
    await expect(organization).toHaveCount(0);
    await selectWorkspaceContext(window, 'personal');
    await expectWorkspaceContext(window, 'personal');
    await expect(personal).toBeVisible();
    await expect(chats).toBeVisible();
    await expect(personalChat).toBeVisible();
    await expect(personalChat).toContainText('Personal planning chat');
    await expect(organization).toHaveCount(0);
    await expect(empty).toHaveCount(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(organization).toBeVisible();
    await expect(window.locator('[data-standalone-chat-id]')).toHaveCount(1);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
      preserveProviderState: true,
    }));
    window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(
      window.locator(`[data-sidebar-workspace-id="${ORG_CONTEXT_WORKSPACE}"]`),
    ).toBeVisible();
    await expect(
      window.locator(
        `[data-sidebar-workspace-id="${PERSONAL_CONTEXT_WORKSPACE}"]`,
      ),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('first-use organization Chats keeps its geometry while binding and opens the composer immediately', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_org_default_chats_delayed';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgDefaultChatsEnsureDelayMs: 2_000,
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-default-chats-delayed-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const chats = window.locator(
      '[data-testid="sidebar-section-chats"]:visible',
    );
    const settings = window.locator(
      '[data-testid="sidebar-section-chats-settings"]:visible',
    );
    const organization = window.locator(
      `[data-sidebar-workspace-id="${ORG_CONTEXT_WORKSPACE}"]`,
    );
    await expect(chats).toBeVisible({ timeout: 500 });
    await expect(settings).toBeDisabled();
    const pendingHeaderBox = await chats.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const pendingProjectBox = await organization.boundingBox();
    expect(pendingProjectBox).not.toBeNull();

    await expect(settings).toBeEnabled({ timeout: 15_000 });
    expect(
      await chats.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      }),
    ).toEqual(pendingHeaderBox);
    expect(await organization.boundingBox()).toEqual(pendingProjectBox);

    await selectWorkspaceContext(window, 'personal');
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(chats).toBeVisible({ timeout: 500 });
    await expect(settings).toBeDisabled();
    await chats.hover();
    const clickedAt = Date.now();
    await window.getByTestId('sidebar-section-chats-new-chat').click();
    const homePage = window.getByTestId('page-home');
    const pendingEditor = homePage.getByTestId('home-composer-editor');
    await expect(pendingEditor).toBeVisible({ timeout: 500 });
    expect(Date.now() - clickedAt).toBeLessThan(1_000);
    await expect(homePage).toBeVisible();
    await pendingEditor.fill('Create this after organization Chats is ready');
    await homePage.getByTestId('home-send-button').click();
    await expect(window.getByTestId('page-chat')).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('a transient first-use failure keeps org Chats and shows an inline retry without exposing Personal', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_org_default_chats_transient_failure';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgDefaultChatsEnsureStatus: 503,
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-default-chats-failure-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const chats = window.getByTestId('sidebar-section-chats');
    await expect(chats).toBeVisible();
    await chats.hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();
    const homePage = window.getByTestId('page-home');
    const editor = homePage.getByTestId('home-composer-editor');
    await expect(editor).toBeVisible();
    await editor.fill('Keep this draft while binding is unavailable');
    await homePage.getByTestId('home-send-button').click();
    const provisioningNotice = homePage.getByTestId('home-composer-error');
    await expect(provisioningNotice).toBeVisible({
      timeout: 15_000,
    });
    await expect(provisioningNotice).toHaveAttribute(
      'data-notice-intent',
      'destructive',
    );
    await expect(homePage.getByTestId('home-composer-retry')).toBeVisible();
    await expect(editor).toHaveText(
      'Keep this draft while binding is unavailable',
    );
    await expect(
      window.locator(
        `[data-sidebar-workspace-id="${PERSONAL_CONTEXT_WORKSPACE}"]`,
      ),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-work-entry-context-personal-chat'),
    ).toHaveCount(0);
    await expect(chats).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('a permanent organization Chats rejection removes the placeholder for the session', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_org_default_chats_permanent_failure';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgDefaultChatsEnsureStatus: 404,
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-default-chats-permanent-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(window.getByTestId('sidebar-section-chats')).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('organization Chats appears once the account refresh delivers the org-projects capability', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_org_default_chats_capability_arrives';
  // The desktop flag is on (ORG_CONTEXT_ENV) but the server has not minted
  // org-projects-v1 for this account yet, as mid-rollout.
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      withholdOrgProjectsCapability: true,
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-default-chats-capability-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    // Main has answered the sidebar's first eligibility read (IPC replies are
    // ordered), so Chats is hidden because of the refusal, not merely because
    // the read is still in flight.
    await expect
      .poll(() =>
        window.evaluate(
          (organizationId) =>
            window.api.chatProject.getOrgDefaultCoworkEligibility(
              organizationId,
            ),
          ORG_CONTEXT_A,
        ),
      )
      .toBe('ineligible');
    await expect(window.getByTestId('sidebar-section-chats')).toHaveCount(0, {
      timeout: 15_000,
    });

    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
    });
    // The same re-read the periodic account refresh performs.
    await window.evaluate(async () => {
      await window.api.refreshCanopyCloudEnforcedSettings();
    });

    await expect(window.getByTestId('sidebar-section-chats')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Home offers and preselects only projects in the selected organization', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_home_picker_org_scope';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-picker-org-scope-'),
  );
  const secondPersonal = 'context-personal-second';
  seedOrgContextScoping(userDataDir, {
    extraPersonalWorkspaces: [
      { id: secondPersonal, name: 'Second personal repository' },
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    // Pick a Personal project on Home; the switch below must move off it.
    await window.getByTestId('sidebar-create-task').click();
    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    await homePage.getByTestId('home-workspace-select').click();
    await window
      .getByTestId(`home-workspace-option-${PERSONAL_CONTEXT_WORKSPACE}`)
      .click();
    await expect(homePage.getByTestId('home-workspace-select')).toContainText(
      'Personal repository',
    );

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-create-task').click();
    await expect(homePage).toBeVisible();
    const trigger = homePage.getByTestId('home-workspace-select');
    await expect(trigger).not.toContainText('Personal repository', {
      timeout: 15_000,
    });
    await trigger.click();
    await expect(
      window.getByTestId(`home-workspace-option-${ORG_CONTEXT_WORKSPACE}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`home-workspace-option-${PERSONAL_CONTEXT_WORKSPACE}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`home-workspace-option-${secondPersonal}`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test("Home names the organization's Chats when it has no projects", async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_home_picker_empty_org';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-picker-empty-org-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    // The organization's Chats is provisioned in the background.
    await expect(window.getByTestId('sidebar-section-chats')).toBeVisible({
      timeout: 15_000,
    });
    await window.getByTestId('sidebar-create-task').click();
    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();

    // No empty band: the picker names Chats as the destination.
    const trigger = homePage.getByTestId('home-workspace-select');
    await expect(trigger).toContainText('Chats', { timeout: 15_000 });
    await trigger.click();
    await expect(window.getByTestId('home-workspace-add')).toBeVisible();
    await expect(window.getByTestId('home-workspace-empty')).toHaveCount(0);
    await expect(
      window.locator('[data-testid^="home-workspace-option-"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

for (const role of ['OWNER', 'MEMBER']) {
  test(`an organization with no active plan explains itself to an ${role.toLowerCase()}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_org_without_plan_${role.toLowerCase()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS.map((organization) =>
          organization.id === ORG_CONTEXT_B
            ? { ...organization, role }
            : organization,
        ),
        orgBillingStates: [
          {
            organizationId: ORG_CONTEXT_B,
            organizationName: 'Empty organization',
            teamsEntitled: false,
          },
        ],
      },
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-org-without-plan-${role.toLowerCase()}-`),
    );
    seedOrgContextScoping(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, apiKey);
      await selectWorkspaceContext(window, ORG_CONTEXT_B);

      const empty = window.getByTestId('sidebar-context-empty-state');
      await expect(empty).toContainText(
        'Empty organization has no active plan',
        { timeout: 15_000 },
      );
      await expect(window.getByTestId('sidebar-section-chats')).toHaveCount(0);
      const choosePlan = window.getByTestId(
        'sidebar-context-empty-state-choose-plan',
      );
      if (role === 'OWNER') {
        await expect(empty).toContainText(
          'Choose a plan to use projects and chats here.',
        );
        await expect(choosePlan).toHaveText('Choose a plan');
      } else {
        await expect(empty).toContainText(
          'Ask an owner of Empty organization to choose a plan.',
        );
        await expect(choosePlan).toHaveCount(0);
      }
      // The explanation replaces the `None found` row, and the sidebar offers
      // no way back to Personal (CAN-3550): the Home notice below still does.
      await expect(
        window.getByTestId('sidebar-context-empty-state-label'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-context-empty-state-back'),
      ).toHaveCount(0);
      await expect(empty).not.toContainText('Back to Personal');

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      const notice = homePage.getByTestId('home-composer-org-without-plan');
      await expect(notice).toContainText(
        'Empty organization has no active plan',
      );
      await expect(homePage.getByTestId('home-send-button')).toBeDisabled();
      // The notice sits above the composer, not inside it.
      const noticeBox = await notice.boundingBox();
      const composerBox = await homePage
        .getByTestId('home-composer')
        .boundingBox();
      if (!noticeBox || !composerBox) throw new Error('home layout missing');
      expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(composerBox.y);
      await expect(homePage.getByTestId('home-workspace-picker')).toHaveCount(
        0,
      );
      if (role === 'OWNER') {
        await expect(
          notice.getByTestId('home-composer-choose-plan'),
        ).toHaveText('Choose a plan');
      } else {
        await notice.getByTestId('home-composer-back-to-personal').click();
        await expectWorkspaceContext(window, 'personal');
        await expect(notice).toHaveCount(0);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

test('workspace context clears the open Personal worktree and restores it after each organization', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2954_context_selection_restore';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2954-selection-'),
  );
  // Two rows distinguish remembered selection from selecting the first row.
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: ['context-first', 'context-restore'],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const personalRows = window
      .getByTestId('worktree-row')
      .and(window.locator(`[data-project-id="${PERSONAL_CONTEXT_WORKSPACE}"]`));
    const selectedRow = window
      .locator('[data-sidebar-selected-item]')
      .getByTestId('worktree-row');
    const main = window.getByTestId('page-main');
    const topBar = main.getByTestId('worktree-top-bar');
    const home = main.getByTestId('home-surface');

    await expectWorkspaceContext(window, 'personal');
    await expect(personalRows).toHaveCount(2);
    // Choose the actual second row so sort-order changes cannot make this a
    // first-row fallback test. Match its stable identity on both restores.
    const personalRow = personalRows.nth(1);
    await expect(personalRow).toBeVisible();
    const worktreeId = await personalRow.getAttribute('data-worktree-id');
    expect(worktreeId).toBeTruthy();
    await personalRow.click();
    await expect(selectedRow).toHaveCount(1);
    await expect(selectedRow).toHaveAttribute('data-worktree-id', worktreeId);
    await expect(selectedRow).toHaveAttribute(
      'data-project-id',
      PERSONAL_CONTEXT_WORKSPACE,
    );
    await expect(topBar).toBeVisible();
    await expect(home).toHaveCount(0);

    for (const organizationId of [ORG_CONTEXT_A, ORG_CONTEXT_B]) {
      await selectWorkspaceContext(window, organizationId);
      await expect(personalRows).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-work-entry-context-personal-chat'),
      ).toHaveCount(0);
      await expect(selectedRow).toHaveCount(0);
      // Both organizations have no worktrees: the main pane must clear too,
      // not merely hide the Personal sidebar row while leaving it open.
      await expect(topBar).toHaveCount(0);
      await expect(home).toBeVisible();
      if (organizationId === ORG_CONTEXT_A) {
        await expect(
          window.locator(
            `[data-sidebar-workspace-id="${ORG_CONTEXT_WORKSPACE}"]`,
          ),
        ).toBeVisible();
        await expect(window.getByTestId('sidebar-section-chats')).toBeVisible();
      } else {
        await expect(window.getByTestId('sidebar-section-chats')).toBeVisible();
        await expect(
          window.getByTestId('sidebar-context-empty-state'),
        ).toHaveText('None found');
      }

      await selectWorkspaceContext(window, 'personal');
      await expect(personalRows).toHaveCount(2);
      await expect(selectedRow).toHaveCount(1);
      await expect(selectedRow).toHaveAttribute('data-worktree-id', worktreeId);
      await expect(selectedRow).toHaveAttribute(
        'data-project-id',
        PERSONAL_CONTEXT_WORKSPACE,
      );
      await expect(selectedRow).toBeVisible();
      await expect(topBar).toBeVisible();
      await expect(home).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-context-empty-state'),
      ).toHaveCount(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('workspace context clears the open Personal Cowork task and restores it on the way back', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2954_context_cowork_restore';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2954-cowork-'),
  );
  // One Personal Code worktree: the walk is Code -> Cowork -> organization, so
  // the Cowork page's unmount restore has a Personal worktree to resurrect.
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: ['context-before-cowork'],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const workEntry = window.getByTestId(
      'sidebar-work-entry-context-personal-chat',
    );
    const chat = window.getByTestId('page-chat');
    const main = window.getByTestId('page-main');

    await expectWorkspaceContext(window, 'personal');
    await window
      .getByTestId('worktree-row')
      .and(
        window.locator(
          '[data-project-id="' + PERSONAL_CONTEXT_WORKSPACE + '"]',
        ),
      )
      .first()
      .click();
    await expect(main).toBeVisible();
    await expect(main.getByTestId('worktree-top-bar')).toBeVisible();
    await workEntry.click();
    await expect(chat).toBeVisible();
    await expect(main).toBeHidden();

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(chat).toHaveCount(0);
    await expect(main).toBeVisible();
    await expect(main.getByTestId('worktree-top-bar')).toHaveCount(0);
    await expect(
      window
        .locator('[data-sidebar-selected-item]')
        .getByTestId('worktree-row'),
    ).toHaveCount(0);
    await expect(main.getByTestId('home-surface')).toBeVisible();
    await expect(workEntry).toHaveCount(0);

    await selectWorkspaceContext(window, 'personal');
    await expect(chat).toBeVisible();
    await expect(main).toBeHidden();
    await expect(workEntry).toBeVisible();
    await expect(workEntry).toHaveAttribute('data-sidebar-selected-item', '');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('workspace context scopes the shared-with-me section', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2954_context_shared_scope';
  const recipientScenario = sharedContainerRecipientScenario();
  // The recipient seeder has fixed Code/Cowork IDs. Keep their materialized
  // paths and assign one listing entry (and replica below) to each context.
  const containers = recipientScenario.sharedContainersState.containers.map(
    (container, index) => ({
      ...container,
      organizationId: index === 0 ? ORG_CONTEXT_A : ORG_CONTEXT_B,
    }),
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    ...recipientScenario,
    cloud: {
      ...recipientScenario.cloud,
      organizations: ORG_CONTEXT_ORGANIZATIONS,
    },
    sharedContainersState: {
      ...recipientScenario.sharedContainersState,
      containers,
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2954-shared-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        ...JSON.parse(ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS),
        'canopy-desktop-shared-containers': true,
      }),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    const section = window.getByTestId('sidebar-section-shared-with-me');
    const acmeRow = window.getByTestId(
      `shared-container-row-${containers[0].id}`,
    );
    const zenRow = window.getByTestId(
      `shared-container-row-${containers[1].id}`,
    );
    await expectWorkspaceContext(window, 'personal');
    await expect(acmeRow).toHaveCount(0);
    await expect(zenRow).toHaveCount(0);

    // As in shared-container-recipient.spec.mjs, seed AFTER sign-in purges
    // recipient plaintext. The running manager cannot observe this new index,
    // so stub open/list only; acceptance and sidebar filtering stay production.
    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    const indexPath = path.join(userDataDir, 'shared-containers', 'index.json');
    const replicaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    for (const container of containers) {
      replicaIndex.containers[container.id].organizationId =
        container.organizationId;
    }
    writeFileSync(indexPath, JSON.stringify(replicaIndex), 'utf8');
    await electronApp.evaluate(
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler('shared-containers:open');
        ipcMain.handle(
          'shared-containers:open',
          (_event, request) => fixture.replicas[request.containerId],
        );
        ipcMain.removeHandler('shared-containers:list-with-me');
        ipcMain.handle('shared-containers:list-with-me', (_event, request) => ({
          containers: fixture.containers.filter(
            (container) => container.organizationId === request.organizationId,
          ),
          nextCursor: null,
        }));
      },
      { containers, replicas: replicaIndex.containers },
    );
    // The sign-in listing ran before the stub existed and the mock cloud lists
    // nothing for this key, so the section is absent until a listing goes
    // through the stub.
    await signalSharedWithMeInbox(electronApp);

    // Accept each invitation through the real UI first. Personal deliberately
    // has no section to wait on; each organization supplies a positive load
    // barrier, and both accepted rows are proven present before the scope walk.
    for (const container of containers) {
      await selectWorkspaceContext(window, container.organizationId);
      await expect(section).toBeVisible({ timeout: 30_000 });
      await acceptSharedContainerInvitation(window, container.id);
      await expect(
        window.getByTestId(`shared-container-row-${container.id}`),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByTestId('shared-container-surface'),
      ).toBeVisible();
    }
    await selectWorkspaceContext(window, 'personal');
    await expect(acmeRow).toHaveCount(0);
    await expect(zenRow).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(section).toBeVisible();
    await expect(acmeRow).toBeVisible();
    await expect(zenRow).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(section).toBeVisible();
    await expect(zenRow).toBeVisible();
    await expect(acmeRow).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);

    await selectWorkspaceContext(window, 'personal');
    await expect(acmeRow).toHaveCount(0);
    await expect(zenRow).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

/** Main-process global the partially failed listing stub counts its calls on. */
const SHARE_HOME_LISTING_CALLS = '__canopyE2eShareHomeListingCalls';

/** Stub `shared-containers:open` with the seeded replica states. */
async function stubSharedContainerOpen(electronApp, replicas) {
  await electronApp.evaluate(({ ipcMain }, fixture) => {
    ipcMain.removeHandler('shared-containers:open');
    ipcMain.handle(
      'shared-containers:open',
      (_event, request) => fixture[request.containerId],
    );
  }, replicas);
}

/**
 * Model a partially failed listing round (CAN-3554): the organization that
 * shared the container rejects its listing, while the organization-free
 * listing still returns the container, so the round classifies the share as
 * direct. An EMPTY organization listing would be the wrong model: in
 * production that purges the replica.
 */
async function stubPartiallyFailedListing(
  electronApp,
  { containers, organizationId },
) {
  await electronApp.evaluate(
    ({ ipcMain }, fixture) => {
      const calls = { rejected: 0, direct: 0 };
      globalThis[fixture.callsKey] = calls;
      ipcMain.removeHandler('shared-containers:list-with-me');
      ipcMain.handle('shared-containers:list-with-me', (_event, request) => {
        if (request.organizationId === fixture.organizationId) {
          calls.rejected += 1;
          throw new Error('Shared-container authorization changed');
        }
        if (request.organizationId === undefined) {
          calls.direct += 1;
          return {
            containers: fixture.containers.filter(
              (container) =>
                container.organizationId === fixture.organizationId,
            ),
            nextCursor: null,
          };
        }
        return {
          containers: fixture.containers.filter(
            (container) => container.organizationId === request.organizationId,
          ),
          nextCursor: null,
        };
      });
    },
    { containers, organizationId, callsKey: SHARE_HOME_LISTING_CALLS },
  );
}

/**
 * Send main's inbox signal, which makes the renderer relist shared-with-me in
 * the background. Specs use it to list through a stub installed after sign-in.
 */
async function signalSharedWithMeInbox(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.webContents.getURL().includes('surface=app-advisor'),
    );
    mainWindow?.webContents.send('shared-containers:inbox-changed', {
      reason: 'poll',
    });
  });
}

/**
 * Run listing rounds through the inbox signal and return once a round that
 * started after this call has been applied. A background round never overlaps
 * another: it starts only after the previous one stored its result. So when
 * the requests of a second round are observed, the first round's rows are in
 * the store, and an assertion that the row did NOT move cannot pass merely
 * because no relist happened.
 */
async function relistSharedWithMe(electronApp) {
  const readCalls = () =>
    electronApp.evaluate(
      (_electron, callsKey) => ({ ...globalThis[callsKey] }),
      SHARE_HOME_LISTING_CALLS,
    );
  const start = await readCalls();
  for (const round of [1, 2]) {
    await signalSharedWithMeInbox(electronApp);
    await expect
      .poll(async () => {
        const calls = await readCalls();
        return (
          calls.rejected >= start.rejected + round &&
          calls.direct >= start.direct + round
        );
      })
      .toBe(true);
  }
}

test('an accepted organization share stays in its organization when a listing round classifies it as direct', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3554_share_home_context';
  const recipientScenario = sharedContainerRecipientScenario();
  const containers = recipientScenario.sharedContainersState.containers.map(
    (container, index) => ({
      ...container,
      organizationId: index === 0 ? ORG_CONTEXT_A : ORG_CONTEXT_B,
      organizationName: index === 0 ? 'Acme' : 'Empty organization',
      owner: { userId: container.ownerUserId, name: 'Dana Publisher' },
    }),
  );
  const shared = containers[0];
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    ...recipientScenario,
    cloud: {
      ...recipientScenario.cloud,
      organizations: ORG_CONTEXT_ORGANIZATIONS,
    },
    sharedContainersState: {
      ...recipientScenario.sharedContainersState,
      containers,
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3554-share-home-'),
  );
  seedOrgContextScoping(userDataDir);
  const env = {
    ...ORG_CONTEXT_ENV,
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      ...JSON.parse(ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS),
      'canopy-desktop-shared-containers': true,
      // The organization-free listing yields no rows without it.
      'canopy-shared-container-external-sharing': true,
    }),
  };
  let { electronApp } = await launchCanopy({ userDataDir, env });
  try {
    let window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await expectWorkspaceContext(window, 'personal');

    // Seed after sign-in purges recipient plaintext, as the test above does.
    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    const indexPath = path.join(userDataDir, 'shared-containers', 'index.json');
    const replicaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    for (const container of containers) {
      replicaIndex.containers[container.id].organizationId =
        container.organizationId;
    }
    writeFileSync(indexPath, JSON.stringify(replicaIndex), 'utf8');
    await stubSharedContainerOpen(electronApp, replicaIndex.containers);
    await electronApp.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('shared-containers:list-with-me');
      ipcMain.handle('shared-containers:list-with-me', (_event, request) => ({
        containers: fixture.filter(
          (container) => container.organizationId === request.organizationId,
        ),
        nextCursor: null,
      }));
    }, containers);
    // List through the stub; the sign-in listing found nothing.
    await signalSharedWithMeInbox(electronApp);

    // Accept in the organization context through the real UI, so the
    // acceptance record names the organization.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toBeVisible({ timeout: 30_000 });
    await acceptSharedContainerInvitation(window, shared.id);
    await expect(
      window.getByTestId(`shared-container-row-${shared.id}`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('shared-container-surface')).toBeVisible();

    // The next rounds reject the organization listing and return the
    // container from the direct listing only.
    await stubPartiallyFailedListing(electronApp, {
      containers,
      organizationId: ORG_CONTEXT_A,
    });
    await relistSharedWithMe(electronApp);

    // The share stays where it was accepted, still reads as an organization
    // share, and reopening it keeps the viewer in this context.
    await expect(
      window.getByTestId(`shared-container-row-${shared.id}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`shared-container-owner-${shared.id}`),
    ).toHaveText('Shared by Dana Publisher');
    await window.getByTestId(`shared-container-row-${shared.id}`).click();
    await expect(
      window.getByTestId(`shared-container-row-${shared.id}`),
    ).toHaveAttribute('aria-current', 'true');
    await expect(window.getByTestId('shared-container-surface')).toBeVisible();

    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.getByTestId(`shared-container-row-${shared.id}`),
    ).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);

    // Restart: the record read from disk, not this session's accept, has to
    // place the row. Handlers are per process, so the stubs are reinstalled.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(
      window.getByTestId(`shared-container-row-${shared.id}`),
    ).toBeVisible();
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env,
      preserveProviderState: true,
    }));
    window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
    await stubSharedContainerOpen(electronApp, replicaIndex.containers);
    await stubPartiallyFailedListing(electronApp, {
      containers,
      organizationId: ORG_CONTEXT_A,
    });
    await relistSharedWithMe(electronApp);
    await expect(
      window.getByTestId(`shared-container-row-${shared.id}`),
    ).toBeVisible();
    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.getByTestId(`shared-container-row-${shared.id}`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('the add-project dialog follows the sidebar scope: organization-owned options in an organization, local options in Personal', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2954_context_add_dialog';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2954-add-dialog-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const addProject = window.getByTestId('sidebar-section-code-add');
    // The "+" reveals on hover of the Projects header row; hover it first so
    // the wrapper stops intercepting the pointer, then click.
    const openAddProject = async () => {
      await addProject.hover({ force: true });
      await addProject.click({ force: true });
    };
    const dialog = window.getByTestId('add-workspace-modal');
    const notice = window.getByTestId('add-workspace-personal-notice');
    const personalMode = window.getByTestId('add-workspace-personal-mode');
    const catalog = window.getByTestId('add-workspace-org-catalog');

    await expectWorkspaceContext(window, 'personal');
    await openAddProject();
    await expect(dialog).toBeVisible();
    await expect(personalMode).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await openAddProject();
    await expect(dialog).toBeVisible();
    // CAN-3984: this known member's organization catalog is confirmed empty,
    // so the dialog hides the catalog and starts on Existing folder. New
    // Personal projects still come from the Personal scope's +, below.
    await expect(
      window.getByTestId('add-workspace-mode-existing'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('add-workspace-mode-catalog')).toHaveCount(
      0,
    );
    await expect(catalog).toHaveCount(0);
    await expect(personalMode).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    const createNew = window.getByTestId('add-workspace-mode-create');
    await expect(createNew).toBeVisible();
    await expect(
      dialog.locator('[data-testid^="add-workspace-org-catalog-dismiss-"]'),
    ).toHaveCount(0);
    await createNew.click();
    await expect(catalog).toHaveCount(0);
    // Create new is the Personal panel, making a project the organization
    // owns. With the catalog withheld, Remote sits beside it: its clone is
    // added through the organization too, never as a Personal project.
    await expect(
      window.getByRole('heading', { name: 'Add project to Acme' }),
    ).toBeVisible();
    await expect(window.getByTestId('add-workspace-name-input')).toBeVisible();
    await expect(window.getByTestId('add-workspace-mode-remote')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await selectWorkspaceContext(window, 'personal');
    await openAddProject();
    await expect(dialog).toBeVisible();
    await expect(personalMode).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect(catalog).toHaveCount(0);
    await expect(
      window.getByTestId('add-workspace-mode-existing'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

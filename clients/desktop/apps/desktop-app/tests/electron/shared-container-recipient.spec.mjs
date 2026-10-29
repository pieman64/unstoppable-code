/**
 * CAN-2550 durable recipient UI coverage. After the authenticated-account
 * transition, the fixture writes a materialized replica tree and matching
 * index, while the shared mock server supplies listing metadata. No live
 * provider, git host, decrypt, or agent is involved.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  acceptSharedContainerInvitation,
  openSharedContainerInvitation,
  removeSharedContainerInvitation,
} from './sharedContainerRecipientActions.mjs';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedSharedContainerRecipientCoworkRevision,
  seedSharedContainerRecipientReplicas,
  sharedContainerRecipientScenario,
  SHARED_CONTAINER_BACKSLASH_TRACKING_IMAGE_URL,
  SHARED_CONTAINER_RECIPIENT_CODE_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_NOTE,
  SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID,
  SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
  SHARED_CONTAINER_TRACKING_IMAGE_URL,
} from './seeders/index.mjs';
import {
  SHARED_CONTAINERS_CLOUD_API_KEY,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
} from './sharedContainerInviteFixture.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

const NOW = '2026-09-01T14:00:00.000Z';
const SHARED_CONTAINER_RECIPIENT_FLAGS_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-shared-containers': true,
    'canopy-desktop-start-page': true,
  }),
};

test.describe.configure({ mode: 'serial' });

/**
 * Reveal the standard activity rail. The default layout collapses it; a
 * publisher layout may already show it, so expansion is conditional.
 */
async function expandRecipientActivity(surface) {
  const expand = surface.getByTestId('panel-group-expand-group-activity');
  if ((await expand.count()) > 0 && (await expand.isVisible())) {
    await expand.click();
  }
}

/**
 * CAN-3551. The Shared with me status row sits on the project-row grid: its
 * copy starts where a project's name starts, and its trailing mark (the retry
 * icon, or the reconnecting spinner's slot) occupies the column a project
 * row's trailing action does. Measured against a real project row in the same
 * rail rather than against pixel constants, so a deliberate change to the
 * project grid moves both sides together and an accidental one fails here.
 */
async function expectStatusRowOnProjectGrid(window, row, trailing) {
  const rect = (locator) =>
    locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    });

  const projectHeader = window
    .locator('[data-testid^="sidebar-project-header-"]')
    .filter({ visible: true })
    .first();
  await expect(projectHeader).toBeVisible();
  // The name is the titled label inside the header's primary button.
  const projectName = projectHeader.locator('button span[title]').first();
  await expect(projectName).toBeVisible();
  // A project's trailing actions are hover-revealed on a fine pointer.
  await projectHeader.hover();
  const projectAction = projectHeader
    .locator('[data-workspace-header-actions="true"] button')
    .filter({ visible: true })
    .last();
  await expect(projectAction).toBeVisible();

  const message = row.getByTestId('shared-container-list-message');
  await expect(message).toBeVisible();
  await expect(trailing).toBeVisible();

  const [headerBox, nameBox, actionBox, rowBox, messageBox, trailingBox] =
    await Promise.all(
      [projectHeader, projectName, projectAction, row, message, trailing].map(
        rect,
      ),
    );

  // Both rows span the same rail column, so the offsets below are comparable.
  expect(Math.abs(rowBox.left - headerBox.left)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(rowBox.right - headerBox.right)).toBeLessThanOrEqual(0.5);
  // The copy takes the project name's position.
  expect(Math.abs(messageBox.left - nameBox.left)).toBeLessThanOrEqual(0.5);
  // The trailing mark takes the project row's action column.
  expect(Math.abs(trailingBox.right - actionBox.right)).toBeLessThanOrEqual(
    0.5,
  );
  expect(Math.abs(trailingBox.width - actionBox.width)).toBeLessThanOrEqual(
    0.5,
  );
  expect(Math.abs(trailingBox.height - actionBox.height)).toBeLessThanOrEqual(
    0.5,
  );
  // It is centered on its row, as the action is on the project row.
  const centerOffset = (inner, outer) =>
    (inner.top + inner.bottom) / 2 - (outer.top + outer.bottom) / 2;
  expect(Math.abs(centerOffset(trailingBox, rowBox))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(rowBox.height - headerBox.height)).toBeLessThanOrEqual(0.5);
  // The copy stops short of the trailing column instead of running under it.
  expect(messageBox.right).toBeLessThanOrEqual(trailingBox.left);
}

async function installRecipientListing(electronApp, window, scenario) {
  await electronApp.evaluate(({ ipcMain }, listing) => {
    ipcMain.removeHandler('shared-containers:list-with-me');
    ipcMain.handle('shared-containers:list-with-me', () => listing);
  }, scenario.sharedContainersState);
  await window.evaluate(() => {
    window.dispatchEvent(new Event('canopy:cloud-account-changed'));
  });
  const expectedOrganizationIds = scenario.cloud.organizations.map(
    (organization) => organization.id,
  );
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const account = await window.api.loadCanopyCloudAccount();
          return account.organizations?.map((organization) => organization.id);
        }),
      { timeout: 30_000 },
    )
    .toEqual(expectedOrganizationIds);
  // The account save and the app's boot hydration can overlap. Re-broadcast
  // after the persisted snapshot is authoritative so the recipient store's
  // organization subscription performs its listing fan-out deterministically.
  await window.evaluate(() => {
    window.dispatchEvent(new Event('canopy:cloud-account-changed'));
  });
}

const EXTERNAL_SHARING_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-shared-containers': true,
    'canopy-shared-container-external-sharing': true,
    'canopy-shared-org-projects-enabled': true,
  }),
};

async function getAdvisorUiState(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const requestId = `shared-container-recipient-ui-state-${Date.now()}`;
    const responseChannel = 'app-advisor:tool-response';
    const requestChannel = 'app-advisor:tool-request';
    const mainWindow = BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!mainWindow) throw new Error('Main window not found');

    ipcMain.removeHandler(responseChannel);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for App Advisor tool')),
        5_000,
      );
      ipcMain.handle(responseChannel, (_event, candidate) => {
        if (candidate?.requestId !== requestId) return;
        clearTimeout(timer);
        resolve(candidate);
      });
      mainWindow.webContents.send(requestChannel, {
        kind: 'get_current_ui_state',
        requestId,
      });
    });
  });
}

test('lists a direct share under Personal and retains its replica across an organization snapshot', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-direct-recipient-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
  });
  recipientScenario.sharedContainersState.containers =
    recipientScenario.sharedContainersState.containers.map((container) => ({
      ...container,
      access: 'direct',
      owner: {
        userId: '11111111-1111-4111-8111-111111111111',
        name: 'Ada Lovelace',
      },
      organizationName: 'Shared Containers E2E',
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, EXTERNAL_SHARING_ENV),
    }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await selectWorkspaceContext(
      window,
      SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
    );

    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          SHARED_CONTAINERS_CLOUD_API_KEY,
        );
        return (
          (activity.sharedContainersListDirectWithMe ?? 0) > 0 &&
          (activity[
            `sharedContainersListed:${SHARED_CONTAINER_RECIPIENT_CODE_ID}`
          ] ?? 0) > 0
        );
      })
      .toBe(true);

    const { activity: listingActivity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(listingActivity.sharedContainersListDirectWithMe).toBeGreaterThan(0);
    expect(
      listingActivity[
        `sharedContainersListed:${SHARED_CONTAINER_RECIPIENT_CODE_ID}`
      ],
    ).toBeGreaterThan(0);
    // A direct share belongs to no organization context (CAN-2954), so the
    // organization selected above does not list it and Personal does.
    await expectWorkspaceContext(
      window,
      SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
    );
    await selectWorkspaceContext(window, 'personal');

    // Keep the seam assertion on the sanitized Advisor payload so a direct
    // row cannot be present visually while being unusable by app actions.
    await expect
      .poll(
        async () => {
          const response = await getAdvisorUiState(electronApp);
          return (
            response.uiState?.snapshot?.sharedContainersRecipientSurface
              ?.listedContainers ?? []
          ).map((container) => `${container.containerId}:${container.access}`);
        },
        { timeout: 30_000 },
      )
      .toContain(`${SHARED_CONTAINER_RECIPIENT_CODE_ID}:direct`);

    const invitation = window.getByTestId(
      `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(invitation).toBeVisible({ timeout: 30_000 });
    await expect(invitation).toContainText(
      'From Ada Lovelace · Shared Containers E2E',
    );
    await selectWorkspaceContext(
      window,
      SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
    );
    await expect(invitation).toHaveCount(0);

    // Connecting the account purges pre-existing plaintext. Stop the app
    // before writing the deterministic materialized replica so the production
    // store observes the seeded root and its identity marker together on the
    // next launch, just as it would after completing a real sync.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    const indexPath = path.join(userDataDir, 'shared-containers', 'index.json');
    const replicaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    replicaIndex.containers[SHARED_CONTAINER_RECIPIENT_CODE_ID].access =
      'direct';
    writeFileSync(indexPath, `${JSON.stringify(replicaIndex, null, 2)}\n`);

    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, EXTERNAL_SHARING_ENV),
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await selectWorkspaceContext(window, 'personal');

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const acceptedRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(acceptedRow).toBeVisible({ timeout: 30_000 });

    // Refresh to a conclusive empty membership snapshot. Organization-scoped
    // replicas are purged here; this direct replica must remain account-scoped.
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      {
        ...recipientScenario,
        cloud: { organizations: [], teams: [], orgBillingStates: [] },
      },
    );
    await window.evaluate(async () => {
      await window.api.refreshCanopyCloudEnforcedSettings();
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await expect(acceptedRow).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => {
        const index = JSON.parse(readFileSync(indexPath, 'utf8'));
        return index.containers[SHARED_CONTAINER_RECIPIENT_CODE_ID]?.access;
      })
      .toBe('direct');
    expect(
      existsSync(
        path.join(
          userDataDir,
          'shared-containers',
          SHARED_CONTAINER_RECIPIENT_CODE_ID,
        ),
      ),
    ).toBe(true);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

const LINK_TOKEN = `${'L'.repeat(42)}A`;

/** Delivers a macOS-style `open-url`, as the web lander's Open button does. */
function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

/**
 * The code share reachable only through its link: not listed as shared with
 * this account until the link is claimed. An outsider claiming an "Anyone
 * with the link" link holds a direct grant.
 */
function linkRecipientScenario(overrides = {}) {
  const scenario = sharedContainerRecipientScenario({ includeCowork: false });
  scenario.sharedContainersState.containers =
    scenario.sharedContainersState.containers.map((container) => ({
      ...container,
      access: 'direct',
      owner: {
        userId: '11111111-1111-4111-8111-111111111111',
        name: 'Ada Lovelace',
      },
      organizationName: 'Shared Containers E2E',
      linkOnly: true,
    }));
  scenario.sharedContainersState.links = [
    {
      containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
      token: LINK_TOKEN,
      audience: 'ANYONE',
    },
  ];
  scenario.sharedContainers = { ...scenario.sharedContainers, ...overrides };
  return scenario;
}

test('opens a shared-container link: landing summary, then Open claims, consents, opens, and lists it', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-link-recipient-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    linkRecipientScenario(),
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, EXTERNAL_SHARING_ENV),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await selectWorkspaceContext(window, 'personal');

    // Nothing is listed until the link is claimed.
    await expect(
      window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
      ),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
      ),
    ).toHaveCount(0);

    await emitOpenUrl(
      electronApp,
      `canopy://share/shared-container/${LINK_TOKEN}`,
    );
    const landing = window.getByTestId('shared-container-link-landing');
    await expect(landing).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('shared-container-link-landing-summary'),
    ).toBeVisible();
    await expect(landing).toContainText('Recipient feature branch');
    await expect(landing).toContainText('Shared by Ada Lovelace');
    await expect(
      window.getByTestId('shared-container-link-landing-contents'),
    ).toContainText('1 repository: app');
    await expect(
      window.getByTestId('shared-container-link-landing-consent'),
    ).toBeVisible();
    // The capability never renders.
    await expect(landing).not.toContainText(LINK_TOKEN);

    // Nothing ran before the click.
    let { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(activity.sharedContainersLinkClaim ?? 0).toBe(0);

    // Materializing a replica is covered by the tests below. Here `open`
    // records what the landing asked the viewer to open and resolves a stable
    // empty replica so the landing can close only after the viewer is ready.
    await electronApp.evaluate(({ ipcMain }, updatedAt) => {
      globalThis.__linkOpenRequests = [];
      ipcMain.removeHandler('shared-containers:open');
      ipcMain.handle('shared-containers:open', (_event, request) => {
        globalThis.__linkOpenRequests.push(request);
        return {
          status: 'nothing-published',
          containerId: request.containerId,
          access: 'direct',
          containerType: 'CODE_WORKTREE',
          updatedAt,
        };
      });
    }, NOW);

    await window.getByTestId('shared-container-link-landing-open').click();
    await expect(landing).toHaveCount(0);
    await expectWorkspaceContext(window, 'personal');
    await expect(window.getByTestId('shared-container-surface')).toBeVisible();
    await expect(
      window.getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
      ),
    ).toBeVisible({ timeout: 30_000 });

    ({ activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    ));
    expect(activity.sharedContainersLinkClaim).toBe(1);
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__linkOpenRequests))
      .toEqual([
        expect.objectContaining({
          containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
          access: 'direct',
        }),
      ]);
    // Claiming from the modal is this device's consent.
    const accepted = await window.evaluate(() =>
      window.api.sharedContainers.listAccepted(),
    );
    expect(JSON.stringify(accepted)).toContain(
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('asks a signed-out recipient to sign in, then refuses an org-only link without revealing it', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-link-ineligible-'),
  );
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    linkRecipientScenario({ linkLanding: { state: 'not-eligible' } }),
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, EXTERNAL_SHARING_ENV),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await emitOpenUrl(
      electronApp,
      `canopy://share/shared-container/${LINK_TOKEN}`,
    );
    const landing = window.getByTestId('shared-container-link-landing');
    await expect(landing).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('shared-container-link-landing-sign-in'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-link-landing-sign-in-action'),
    ).toHaveText('Sign in');
    await expect(
      window.getByTestId('shared-container-link-landing-summary'),
    ).toHaveCount(0);

    // Signing in re-asks the server, which redacts an org-only link for a
    // non-member: no name, owner, organization, or contents.
    await connectSharedContainersAccount(window);
    await expect(
      window.getByTestId('shared-container-link-landing-not-eligible'),
    ).toHaveText(
      "You don't have access to this link. Ask the person who shared it to invite you.",
      { timeout: 15_000 },
    );
    await expect(landing).not.toContainText('Recipient feature branch');
    await expect(landing).not.toContainText('Shared Containers E2E');
    await expect(landing).not.toContainText('Ada Lovelace');
    await expect(
      window.getByTestId('shared-container-link-landing-open'),
    ).toHaveCount(0);
    await window.getByTestId('shared-container-link-landing-close').click();
    await expect(landing).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('renders code and cowork shares, retries a block, and purges retry-time revocation', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-recipient-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario({
    includeRun: true,
  });
  // The pinned mock server names an unseeded owner "Mock Owner"; seed the
  // owner the assertions below expect, as the direct-share test does.
  recipientScenario.sharedContainersState.containers =
    recipientScenario.sharedContainersState.containers.map((container) => ({
      ...container,
      owner: {
        userId: '11111111-1111-4111-8111-111111111111',
        name: 'Ada Lovelace',
      },
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    let trackingImageRequests = 0;
    window.on('request', (request) => {
      if (
        request.url() === SHARED_CONTAINER_TRACKING_IMAGE_URL ||
        request.url() === SHARED_CONTAINER_BACKSLASH_TRACKING_IMAGE_URL
      ) {
        trackingImageRequests += 1;
      }
    });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();

    const section = window.getByTestId('sidebar-section-shared-with-me');
    await expect(section).toBeVisible({ timeout: 30_000 });
    // Until this device accepts, a share is an invitation: titled and
    // attributed, but with no way to open it, because opening is what clones
    // the publisher's repositories onto this machine.
    const codeInvitation = window.getByTestId(
      `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    const coworkInvitation = window.getByTestId(
      `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(codeInvitation).toContainText('Recipient feature branch');
    await expect(codeInvitation).toContainText('Shared by Ada Lovelace');
    // A Cowork invitation names the publisher's own sidebar Work Entry, so the
    // recipient can tell what they are being asked to accept. The full title
    // stays reachable on hover even when the row truncates it.
    await expect(coworkInvitation).toContainText('Customer follow-up');
    await expect(
      coworkInvitation.locator('[title="Customer follow-up"]'),
    ).toHaveCount(1);
    await expect(coworkInvitation).toContainText('Shared by Ada Lovelace');
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    const coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(codeRow).toHaveCount(0);
    await expect(coworkRow).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);

    // Connecting a different Cloud identity correctly purges all recipient
    // plaintext. Seed only after that security transition has completed.
    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeRun: true,
    });
    // The fixture writes the aggregate compatibility files that a real
    // replica promotion projects before the renderer sees the revision. This
    // test stubs `open` below, so ask the real chat service to perform that
    // one-time canonical migration before the revisioned renderer feed reads
    // the recipient scopes.
    await window.evaluate(
      async ({ projectId, containerIds }) => {
        await Promise.all(
          containerIds.map((worktreeId) =>
            window.api.chat.loadTabs({ projectId, worktreeId }),
          ),
        );
      },
      {
        projectId: 'shared-container-viewer',
        containerIds: [
          SHARED_CONTAINER_RECIPIENT_CODE_ID,
          SHARED_CONTAINER_RECIPIENT_COWORK_ID,
        ],
      },
    );

    // The replica store is initialized before the identity transition above,
    // so it cannot observe an index written afterward. Stub only the open
    // result to expose the deterministic materialized fixture; all content
    // reads still use the production main-process reader IPC.
    await electronApp.evaluate(
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler('shared-containers:open');
        ipcMain.handle('shared-containers:open', (_event, request) => ({
          status: 'available',
          containerId: request.containerId,
          organizationId: request.organizationId,
          containerType:
            request.containerId === '55555555-5555-4555-8555-555555555552'
              ? 'COWORK_WORK_ENTRY'
              : 'CODE_WORKTREE',
          updatedAt: fixture.now,
          revisionId:
            request.containerId === '55555555-5555-4555-8555-555555555552'
              ? 'cowork-revision-1'
              : 'code-revision-1',
          revision: 1,
          revisionCreatedAt: fixture.now,
          // Cowork carries the singular case and `symlink-escaping`, the
          // reason the renderer's old switch had no case for; code carries
          // the plural, two-reason case. Both match the seeded index state.
          withheldFileCount:
            request.containerId === '55555555-5555-4555-8555-555555555552'
              ? 1
              : 2,
          withheldFileReasons:
            request.containerId === '55555555-5555-4555-8555-555555555552'
              ? ['symlink-escaping']
              : ['credential-shaped', 'oversized'],
        }));
        // The plaintext fixture is intentionally seeded after the account purge,
        // outside the running replica manager. Keep later flag-driven reloads
        // deterministic without asking the manager to authorize that externally
        // created root; the initial listing above still exercised the real path.
        ipcMain.removeHandler('shared-containers:list-with-me');
        ipcMain.handle('shared-containers:list-with-me', () => fixture.listing);
      },
      {
        now: NOW,
        listing: {
          containers: recipientScenario.sharedContainersState.containers,
          nextCursor: null,
        },
      },
    );

    // Accepting is the consent that authorizes materialization, and it turns
    // the invitation into an ordinary view-only row. CAN-4052: the row opens
    // a dialog that asks, with Accept and Remove share in it; cancelling
    // leaves the invitation exactly where it was.
    await expect(
      window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-pending`,
      ),
    ).toBeVisible();
    const invitationDialog = await openSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    await expect(invitationDialog).toContainText('Customer follow-up');
    await expect(
      invitationDialog.getByRole('button', { name: 'Accept and open' }),
    ).toBeVisible();
    await expect(
      invitationDialog.getByRole('button', { name: 'Remove share' }),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invitation-dialog-consent'),
    ).toBeVisible();
    // No Cancel (CAN-3710): the X dismisses the invitation.
    await expect(
      window.getByTestId('shared-container-invitation-dialog-cancel'),
    ).toHaveCount(0);
    await invitationDialog
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(invitationDialog).toHaveCount(0);
    await expect(coworkInvitation).toBeVisible();
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await expect(codeInvitation).toHaveCount(0);
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });

    // CAN-2551: an accepted row carries the same hover-revealed "…" menu the
    // archived rows use, and "Remove share" confirms before deleting the local
    // copy. Cancelling here keeps the share for the rest of this spec.
    await coworkRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove`,
      )
      .click();
    const removeConfirm = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove-confirmation`,
    );
    await expect(removeConfirm).toBeVisible();
    await expect(removeConfirm).toContainText('deletes the local copy');
    await removeConfirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(removeConfirm).toHaveCount(0);
    await expect(coworkRow).toBeVisible();

    // Recipient rows are global sidebar navigation. Opening one from another
    // page must reveal the main-hosted recipient surface, not mount it behind
    // the current page.
    await app.openPipelinesPage();
    await codeRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(
      surface.getByTestId('shared-container-read-only-badge'),
    ).toHaveText('View only');
    await expect(
      surface.getByTestId('shared-container-surface-header'),
    ).toContainText('Shared by Ada Lovelace');
    // The recipient-side withheld-file banner is gone: it sat above every
    // shared container for the life of the share, and the owner already sees
    // the withheld list in the share dialog before publishing.
    await expect(
      surface.getByTestId('shared-container-withheld-disclosure'),
    ).toHaveCount(0);
    // The recipient view is the publisher's standard surface, read only: the
    // standard chat tab strip and transcript with no composer, the standard
    // activity rail, and the standard top bar with no "Open in".
    await expect(surface.getByTestId('worktree-top-bar')).toBeVisible();
    await expect(surface.getByTestId('worktree-top-open')).toHaveCount(0);
    // The shared bar keeps the standard 46px frame with 9px insets instead of
    // collapsing onto its title, and ends on the same "…" layout menu as a
    // publisher's worktree: there is no close button (navigation leaves).
    const topBarFrame = await surface
      .getByTestId('worktree-top-bar')
      .evaluate((bar) => {
        const status = bar.querySelector(
          '[data-testid="shared-container-top-status"]',
        );
        const menu = bar.querySelector(
          '[data-testid="worktree-top-save-layout-default"]',
        );
        const barRect = bar.getBoundingClientRect();
        const statusRect = status?.getBoundingClientRect();
        const menuRect = menu?.getBoundingClientRect();
        const lastButton = Array.from(bar.querySelectorAll('button')).at(-1);
        return {
          height: Math.round(barRect.height),
          statusLeftInset: statusRect
            ? Math.round(statusRect.left - barRect.left)
            : null,
          menuRightInset: menuRect
            ? Math.round(barRect.right - menuRect.right)
            : null,
          lastButtonIsMenu: lastButton === menu,
        };
      });
    expect(topBarFrame.height).toBe(46);
    expect(topBarFrame.statusLeftInset).toBeGreaterThanOrEqual(9);
    expect(topBarFrame.menuRightInset).toBe(9);
    expect(topBarFrame.lastButtonIsMenu).toBe(true);
    await expect(surface.getByTestId('shared-container-close')).toHaveCount(0);
    const codeChatTab = surface
      .locator('[data-testid="panel-tab-panel-chat-code-chat"]:visible')
      .first();
    await expect(codeChatTab).toContainText('Review implementation', {
      timeout: 30_000,
    });
    const chatPanel = surface
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(chatPanel).toContainText(
      'Please review the shared implementation.',
      { timeout: 30_000 },
    );
    const resolvedHtmlFiles = await window.evaluate(
      async ({ projectId, worktreeId }) => {
        const target = { projectId, worktreeId };
        const { roots } = await window.api.getFileTreeRoots(target);
        const candidates = await Promise.all(
          roots.map((root) =>
            window.api.resolveFileReference({
              ...target,
              baseFilePath: `${root.absolutePath}/.chat-link`,
              href: 'blog/index.html',
            }),
          ),
        );
        return candidates.filter((candidate) => candidate !== null);
      },
      {
        projectId: 'shared-container-viewer',
        worktreeId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
      },
    );
    expect(resolvedHtmlFiles).toHaveLength(1);
    expect(resolvedHtmlFiles[0]?.filename).toBe('index.html');
    // A chat link to a page opens it rendered in the browser beside the chat,
    // through the replica-confined `file:` path, with its stylesheet applied.
    await chatPanel
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'Open the styled page' })
      .click();
    await expect(
      surface.locator('[data-testid="panel-content-browser"]:visible'),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(chatPanel).toBeVisible();
    await expect(
      surface
        .locator('[data-testid="panel-content-file-diff"]:visible')
        .filter({ hasText: 'index.html' }),
    ).toHaveCount(0);
    const recipientStyleProof = () =>
      electronApp.evaluate(async ({ webContents }) => {
        const contents = webContents
          .getAllWebContents()
          .find(
            (candidate) => candidate.getTitle() === 'Recipient styled page',
          );
        if (!contents) return null;
        return contents.executeJavaScript(
          "getComputedStyle(document.querySelector('#recipient-style-proof')).color",
        );
      });
    await expect
      .poll(recipientStyleProof, { timeout: 30_000 })
      .toBe('rgb(12, 110, 74)');
    await expect(chatPanel.locator('[data-slate-editor="true"]')).toHaveCount(
      0,
    );
    await expect(chatPanel.getByTestId('turn-share-session')).toHaveCount(0);
    await expect(
      surface.getByTestId('panel-tab-close-panel-chat-code-chat'),
    ).toHaveCount(0);
    await expandRecipientActivity(surface);
    await expect(
      surface
        .getByTestId('workspace-attachments-item')
        .filter({ hasText: 'large-preview.txt' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      surface.getByTestId('workspace-attachments-import'),
    ).toHaveCount(0);

    // `+` offers the read-safe panels without any consent step: the file
    // explorer and the browser only read the replica. It never starts a chat.
    await surface.getByTestId('panel-add-tab-group-chat').click();
    const addMenu = window.getByTestId('panel-add-menu');
    await expect(addMenu).toBeVisible();
    await expect(
      addMenu.getByTestId('panel-add-menu-item-browser'),
    ).toBeVisible();
    await expect(
      addMenu.getByTestId('panel-add-menu-terminal-submenu'),
    ).toHaveCount(0);
    await addMenu.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(window.getByTestId('shared-container-run-panel')).toHaveCount(
      0,
    );
    const explorer = surface.getByTestId('panel-content-file-explorer');
    await expect(explorer).toBeVisible({ timeout: 30_000 });
    // One read-only root per published repository, from the sealed replica.
    await expect(explorer).toContainText('recipient-fixture', {
      timeout: 30_000,
    });
    await expect(explorer).toContainText('recipient-secondary');

    // The file explorer still opens a page as source, and the viewer's
    // Open in browser action loads it rendered in another browser tab.
    await explorer
      .locator('[data-testid="files-tree-folder"]')
      .filter({ hasText: 'recipient-fixture' })
      .first()
      .click();
    await explorer
      .locator('[data-testid="files-tree-folder"][data-path="blog"]')
      .first()
      .click();
    await explorer
      .locator('[data-testid="files-tree-row"][data-path="blog/index.html"]')
      .first()
      .click();
    const htmlViewer = surface
      .locator('[data-testid="panel-content-file-diff"]:visible')
      .filter({ hasText: 'index.html' });
    await expect(htmlViewer).toBeVisible({ timeout: 30_000 });
    const browserTabs = surface.locator(
      '[role="tab"][data-panel-kind="browser"]',
    );
    const browserTabsBefore = await browserTabs.count();
    await htmlViewer.getByTestId('file-viewer-open-in-browser').click();
    await expect(browserTabs).toHaveCount(browserTabsBefore + 1, {
      timeout: 30_000,
    });

    // A recipient share is a page-like overlay, so explicit navigation to a
    // live worktree must dismiss it instead of changing the workspace behind
    // an opaque z-40 surface.
    await app.selectWorktree('demo-main');
    await expect(surface).toHaveCount(0);
    // CAN-2551: closing the viewer is ordinary navigation, so the decrypted
    // replica stays on disk. It used to be `rm -rf`'d here, which made every
    // reopen a cold start — two round trips, a full artifact re-download, and
    // a fresh `git clone` — under one indeterminate spinner. Retention now
    // ends only at Remove, revocation, or account change.
    const retainedCheckout = path.join(
      userDataDir,
      'shared-containers',
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
      'revisions',
      'code-revision-1',
      'repos',
      'repo-1',
    );
    expect(existsSync(retainedCheckout)).toBe(true);
    await codeRow.click();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    expect(existsSync(retainedCheckout)).toBe(true);

    // The header's copy entry point speaks the same word as the dialog it
    // opens ("Make a copy of this share"), rather than the internal "fork".
    await expect(
      surface.getByTestId('shared-container-fork-open-modal'),
    ).toHaveText('Make a copy');

    // CAN-2831: running is a second, explicit consent after accepting the
    // share. Values start absent, are created only as recipient-owned
    // placeholders, and the published command runs inside the writable copy.
    const runOpen = surface.getByTestId('shared-container-run-open');
    await expect(runOpen).toBeVisible();
    await runOpen.click();
    const runPanel = window.getByTestId('shared-container-run-panel');
    await expect(runPanel).toBeVisible();
    // The pre-consent sheet is the decision itself: what would run, and the
    // warning. Environment editing is a post-consent control, so the declared
    // names are asserted after the grant rather than before it.
    await expect(
      runPanel.getByTestId('shared-container-run-environment'),
    ).toHaveCount(0);
    // A command leads with its name; the shell string and the folder it runs
    // in are one click away rather than on the face of the row. Both are still
    // verbatim once revealed, and the folder is named rather than shown as its
    // wire repo id.
    const launchRow = runPanel.getByTestId(
      'shared-container-run-command-launch',
    );
    await expect(launchRow).toContainText('Launch');
    await expect(launchRow).not.toContainText('SHARED_GREETING');
    await expect(
      runPanel.getByTestId('shared-container-run-command-details-body-launch'),
    ).toHaveCount(0);
    await runPanel
      .getByTestId('shared-container-run-command-details-launch')
      .click();
    const launchDetails = runPanel.getByTestId(
      'shared-container-run-command-details-body-launch',
    );
    await expect(launchDetails).toContainText('shared-container-run:%s:%s');
    await expect(launchDetails).toContainText('Runs in recipient-fixture');
    await runPanel.getByTestId('shared-container-run-allow').click();
    await window.getByTestId('shared-container-run-allow-confirm').click();
    await expect(
      runPanel.getByTestId('shared-container-run-allow'),
    ).toHaveCount(0);
    await expect(
      runPanel.getByTestId('shared-container-run-env-unset'),
    ).toContainText('DATABASE_URL, SHARED_GREETING');
    await runPanel.getByTestId('shared-container-run-env-placeholders').click();
    await runPanel.getByTestId('environment-editor-mode-bulk').click();
    const runEnvironment = runPanel.getByTestId(
      'environment-editor-bulk-textarea',
    );
    await expect(runEnvironment).toHaveValue(/DATABASE_URL=/);
    await expect(runEnvironment).toHaveValue(/SHARED_GREETING=/);
    await runEnvironment.fill(
      'DATABASE_URL=postgres://recipient.invalid/app\nSHARED_GREETING=hello-recipient',
    );
    await runPanel.getByTestId('shared-container-run-env-save').click();
    await expect(
      runPanel.getByTestId('shared-container-run-env-set'),
    ).toContainText('DATABASE_URL, SHARED_GREETING');
    await runPanel
      .getByTestId('shared-container-run-command-start-launch')
      .click();
    // Starting a command dismisses the sheet: the terminal it just opened is
    // what the recipient should be looking at.
    await expect(runPanel).toHaveCount(0);
    await expect(window.getByTestId('terminal-pane')).toHaveCount(1);
    const runTerminal = await window.evaluate(async () => {
      const sessions = await window.api.terminal.list();
      return sessions.find(
        (session) =>
          session.projectId === 'shared-container-viewer' &&
          session.worktreeId === '55555555-5555-4555-8555-555555555551',
      );
    });
    expect(runTerminal?.cwd).toContain(
      path.join(
        'app-workspaces',
        'shared-container-viewer',
        'worktree-data',
        SHARED_CONTAINER_RECIPIENT_CODE_ID,
        'run',
        'repo-1',
      ),
    );
    expect(runTerminal?.cwd).not.toContain(`${path.sep}.git${path.sep}`);
    // The sheet no longer mirrors command output: Run opens a terminal pane in
    // the run copy, so the live terminal is the assertion surface.
    await expect
      .poll(
        async () =>
          (await window.getByTestId('terminal-pane').innerText()).replace(
            /\s+/g,
            '',
          ),
        { timeout: 30_000 },
      )
      .toContain(
        'shared-container-run:hello-recipient:postgres://recipient.invalid/app',
      );

    // A renderer reload remounts the recipient view while main still owns the
    // live PTY. Mount-time stale-layout cleanup must preserve that binding;
    // explicit navigation away is different because close intentionally stops
    // every recipient process before releasing the share subscription.
    await electronApp.evaluate(({ ipcMain }, containerId) => {
      const handlers = ipcMain._invokeHandlers;
      const original = handlers?.get('terminal:load-worktree-state');
      if (!original) {
        throw new Error('terminal:load-worktree-state handler not found');
      }
      ipcMain.removeHandler('terminal:load-worktree-state');
      ipcMain.__sharedRecipientTerminalListAttempts = 0;
      ipcMain.handle('terminal:load-worktree-state', async (...args) => {
        const request = args[1];
        const isRecipientHydration =
          request?.projectId === 'shared-container-viewer' &&
          request?.worktreeId === containerId;
        if (isRecipientHydration) {
          ipcMain.__sharedRecipientTerminalListAttempts += 1;
        }
        if (
          isRecipientHydration &&
          ipcMain.__sharedRecipientTerminalListAttempts === 1
        ) {
          throw new Error('Injected terminal list failure');
        }
        return original(...args);
      });
    }, SHARED_CONTAINER_RECIPIENT_CODE_ID);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('terminal-pane')).toHaveCount(1);
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ ipcMain }) => ipcMain.__sharedRecipientTerminalListAttempts,
        ),
      )
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() =>
        window.evaluate(async (containerId) => {
          const sessions = await window.api.terminal.list();
          return sessions.some(
            (session) =>
              session.projectId === 'shared-container-viewer' &&
              session.worktreeId === containerId,
          );
        }, SHARED_CONTAINER_RECIPIENT_CODE_ID),
      )
      .toBe(true);

    // Revocation is immediate: it removes the terminal-capable layout and
    // makes the run affordance consent-gated again without dismissing files.
    await surface.getByTestId('shared-container-run-open').click();
    await expect(runPanel).toBeVisible();
    await runPanel.getByTestId('shared-container-run-revoke').click();
    await window.getByTestId('shared-container-run-revoke-confirm').click();
    await expect(window.getByTestId('terminal-pane')).toHaveCount(0);
    await expect
      .poll(() =>
        window.evaluate(async (containerId) => {
          const sessions = await window.api.terminal.list();
          return sessions.some(
            (session) =>
              session.projectId === 'shared-container-viewer' &&
              session.worktreeId === containerId,
          );
        }, SHARED_CONTAINER_RECIPIENT_CODE_ID),
      )
      .toBe(false);
    await expect(
      runPanel.getByTestId('shared-container-run-allow'),
    ).toBeVisible();
    await runPanel.getByText('Close', { exact: true }).click();
    await expect(surface).toBeVisible();

    const repositoryRead = await window.evaluate(
      async (request) => {
        try {
          return await window.api.sharedContainers.listRepositories(request);
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
        revisionId: 'code-revision-1',
      },
    );
    // CAN-2551: the summary now carries the publisher's base commit and branch
    // so an empty share can name what it is empty relative to. Both repos are
    // seeded from real two-commit repositories, so each SHA is whatever git
    // produced rather than a hard-coded placeholder. CAN-2552 gave `repo-2` a
    // real history too, because forking clones each repository at its exact
    // base commit and a synthetic SHA has nothing to check out.
    expect(repositoryRead).toEqual([
      {
        repoId: 'repo-1',
        repoName: 'recipient-fixture',
        baseCommitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
        baseBranch: 'main',
      },
      {
        repoId: 'repo-2',
        repoName: 'recipient-secondary',
        baseCommitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    ]);
    // Changes is the standard Changed Files section: both repositories, both
    // the committed and uncommitted halves, and the standard diff panel.
    await expandRecipientActivity(surface);
    const changes = surface.getByTestId('changed-files-section');
    await expect(changes).toBeVisible({ timeout: 30_000 });
    const changedFile = (name) =>
      changes.getByTestId('activity-changed-file').filter({ hasText: name });
    await expect(changedFile('recipient.ts')).toBeVisible({ timeout: 30_000 });
    await expect(changedFile('committed-change.ts')).toBeVisible();
    await expect(changedFile('secondary.ts')).toBeVisible();
    await expect(changes.getByTestId('view-change-diagram-button')).toHaveCount(
      0,
    );
    await changedFile('recipient.ts').click({ button: 'right' });
    await expect(window.getByTestId('files-tree-action-menu')).toHaveCount(0);

    const recipientPlan = surface.getByTestId(
      'activity-plan-row-recipient-plan',
    );
    await expect(recipientPlan).toBeVisible({ timeout: 30_000 });
    await expect(
      recipientPlan.getByTestId('activity-plan-toggle-hidden-recipient-plan'),
    ).toHaveCount(0);
    await expect(
      recipientPlan.getByTestId('activity-plan-recipient-plan-execute'),
    ).toHaveCount(0);
    await expect(
      recipientPlan.getByTestId('activity-plan-recipient-plan-share'),
    ).toHaveCount(0);
    // The recipient's plan opens as a read-only Plan panel on the shared
    // surface: no diagram, split, follow-up actions, share, or Submit.
    await recipientPlan.click();
    const recipientPlanPanel = surface.locator(
      '[data-testid="panel-content-plan"][data-panel-id="panel-plan-recipient-plan"]',
    );
    await expect(recipientPlanPanel).toBeVisible();
    await expect(
      recipientPlanPanel.getByTestId('plan-explore-plan-panel'),
    ).toContainText('Verify the shared read-only surface.');
    for (const testId of [
      'plan-panel-tab-diagram',
      'plan-panel-split',
      'plan-panel-execute',
      'plan-panel-share',
      'plan-comments-submit',
    ]) {
      await expect(recipientPlanPanel.getByTestId(testId)).toHaveCount(0);
    }
    await closePanelTab(window, 'panel-plan-recipient-plan');
    await expect(recipientPlanPanel).toHaveCount(0);
    // Placing the plan beside the chat can collapse the activity rail; bring
    // it back for the changed files.
    await expandRecipientActivity(surface);
    await changedFile('committed-change.ts').click();
    await expect(
      surface.getByTestId('file-panel-diff').filter({
        hasText: 'export const committed = true;',
      }),
    ).toBeVisible({ timeout: 30_000 });
    await changedFile('recipient.ts').click();
    await expect(
      surface.getByTestId('file-panel-diff').filter({
        hasText: 'export const recipient = true;',
      }),
    ).toBeVisible({ timeout: 30_000 });

    // A live capability-gate change invokes the recipient initializer's React
    // disposer. It must close the main-process lifetime and clear decrypted
    // renderer state before the gated sidebar entry disappears.
    const enabledFeatureSnapshot = await window.evaluate(() =>
      window.api.featureFlags.getSnapshot(),
    );
    const broadcastFeatureSnapshot = async (snapshot) => {
      await electronApp.evaluate(({ BrowserWindow }, nextSnapshot) => {
        for (const candidate of BrowserWindow.getAllWindows()) {
          candidate.webContents.send(
            'feature-flags:snapshot-changed',
            nextSnapshot,
          );
        }
      }, snapshot);
    };
    await broadcastFeatureSnapshot({
      ...enabledFeatureSnapshot,
      values: {
        ...enabledFeatureSnapshot.values,
        'canopy-desktop-shared-containers': false,
      },
      updatedAt: new Date(Date.parse(NOW) + 1_000).toISOString(),
    });
    await expect(surface).toHaveCount(0);
    await expect(section).toHaveCount(0);

    await broadcastFeatureSnapshot(enabledFeatureSnapshot);
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await surface.getByTestId('panel-tab-panel-chat-code-chat').click();
    await expect(
      surface.getByTestId('panel-tab-panel-chat-code-chat'),
    ).toContainText('Review implementation');
    await expect(
      window.getByText('Please review the shared implementation.'),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      window.getByTestId('chat-external-image-hidden').first(),
    ).toContainText('Shared tracking image');
    await expect(
      window.getByTestId('chat-external-image-hidden').nth(1),
    ).toContainText('Shared backslash tracking image');
    await expect(
      window.locator(`img[src="${SHARED_CONTAINER_TRACKING_IMAGE_URL}"]`),
    ).toHaveCount(0);
    await expect(
      window.locator(
        `img[src="${SHARED_CONTAINER_BACKSLASH_TRACKING_IMAGE_URL}"]`,
      ),
    ).toHaveCount(0);
    expect(trackingImageRequests).toBe(0);

    // Drive the real renderer subscription into a blocked gate state, then
    // replace only the main retry handler so the click deterministically
    // returns to the already-materialized revision without transport/decrypt.
    const availableCodeState = {
      status: 'available',
      containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
      organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      containerType: 'CODE_WORKTREE',
      updatedAt: NOW,
      revisionId: 'code-revision-1',
      revision: 1,
      revisionCreatedAt: NOW,
      withheldFileCount: 2,
      withheldFileReasons: ['credential-shaped', 'oversized'],
    };
    await electronApp.evaluate(
      ({ BrowserWindow, ipcMain }, state) => {
        ipcMain.removeHandler('shared-containers:retry');
        ipcMain.handle('shared-containers:retry', () => state.available);
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        mainWindow?.webContents.send('shared-containers:replica-changed', {
          status: 'blocked',
          containerId: state.available.containerId,
          organizationId: state.available.organizationId,
          containerType: 'CODE_WORKTREE',
          updatedAt: state.available.updatedAt,
          reason: 'repository-access-missing',
          message: 'Repository access is missing.',
        });
      },
      { available: availableCodeState },
    );
    await expect(
      surface.getByTestId('shared-container-blocked-repository-access-missing'),
    ).toBeVisible();
    await surface.getByTestId('shared-container-retry').click();
    await expect(
      surface.getByTestId('panel-tab-panel-chat-code-chat'),
    ).toBeVisible({ timeout: 30_000 });

    // A retry retains the existing replica while its request is in flight.
    // A revocation broadcast during that loading state must still purge the
    // decrypted recipient surface; only a purge naming some OTHER container
    // may be ignored.
    const coworkOnlyScenario = sharedContainerRecipientScenario({
      includeCode: false,
    });
    await electronApp.evaluate(
      ({ BrowserWindow, ipcMain }, state) => {
        ipcMain.removeHandler('shared-containers:list-with-me');
        ipcMain.handle('shared-containers:list-with-me', () => state.listing);
        ipcMain.removeHandler('shared-containers:retry');
        ipcMain.handle('shared-containers:retry', () => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (candidate) =>
              !candidate.webContents.getURL().includes('surface=app-advisor'),
          );
          // A purge naming the container being retried. The retry keeps the
          // existing replica mounted while it is in flight, so this must
          // still tear the decrypted surface down.
          mainWindow?.webContents.send('shared-containers:replica-changed', {
            purged: 'container',
            containerId: state.available.containerId,
          });
          throw new Error('Shared-container access was revoked.');
        });
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        mainWindow?.webContents.send('shared-containers:replica-changed', {
          status: 'blocked',
          containerId: state.available.containerId,
          organizationId: state.available.organizationId,
          containerType: state.available.containerType,
          updatedAt: state.available.updatedAt,
          reason: 'repository-access-missing',
          message: 'Repository access is missing.',
        });
      },
      {
        available: availableCodeState,
        listing: {
          containers: coworkOnlyScenario.sharedContainersState.containers,
          nextCursor: null,
        },
      },
    );
    await expect(
      surface.getByTestId('shared-container-blocked-repository-access-missing'),
    ).toBeVisible();
    await surface.getByTestId('shared-container-retry').click();
    await expect(surface).toHaveCount(0);
    await expect(codeRow).toHaveCount(0, { timeout: 30_000 });

    await coworkRow.click();
    await expect(
      surface.getByTestId('shared-container-surface-header'),
    ).toContainText('Customer follow-up');
    await expect(
      surface.getByTestId('shared-container-withheld-disclosure'),
    ).toHaveCount(0);
    await expect(coworkRow).toContainText('Customer follow-up');
    // Cowork shares get the same parity: the standard chat tab strip and the
    // standard Cowork activity cards, with no git-only sections.
    await expect(
      surface.getByTestId('panel-tab-panel-chat-cowork-chat'),
    ).toContainText('Customer notes', { timeout: 30_000 });
    await expect(surface.getByTestId('cowork-top-bar')).toBeVisible();
    await expect(surface.getByTestId('worktree-top-bar')).toHaveCount(0);
    await expandRecipientActivity(surface);
    await expect(surface.getByTestId('changed-files-section')).toHaveCount(0);
    await expect(surface.getByTestId('activity-plans-import')).toHaveCount(0);
    await expect(
      surface.getByTestId('workspace-notes-item').filter({
        hasText: 'Follow-up note',
      }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      surface.getByTestId('workspace-prompts-item').filter({
        hasText: 'Response prompt',
      }),
    ).toBeVisible();
    await expect(surface.getByTestId('workspace-notes-add')).toHaveCount(0);
    await expect(
      surface.getByTestId('workspace-attachments-dropzone'),
    ).toHaveCount(0);
    await expect(
      surface.getByTestId('workspace-attachments-import'),
    ).toHaveCount(0);

    // Cowork files open from the standard file explorer, rooted at the
    // replica's content folder, into the standard read-only file viewer.
    await surface.getByTestId('panel-add-tab-group-chat').click();
    await window
      .getByTestId('panel-add-menu')
      .getByTestId('panel-add-menu-item-file-explorer')
      .click();
    const coworkExplorer = surface.getByTestId('panel-content-file-explorer');
    await coworkExplorer
      .locator('[data-testid="files-tree-folder"][data-path="exports"]')
      .click();
    await coworkExplorer
      .locator(
        '[data-testid="files-tree-row"][data-path="exports/customer-summary.txt"]',
      )
      .click();
    await expect(
      surface.getByTestId('panel-content-file-diff').last(),
    ).toContainText('Customer follow-up details.', { timeout: 30_000 });

    // Remove the recipient grant from the authoritative listing before the
    // purge event. The active surface closes immediately and the subsequent
    // refresh cannot resurrect its sidebar row.
    const revokedRecipientScenario = sharedContainerRecipientScenario({
      includeCowork: false,
    });
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      revokedRecipientScenario,
    );
    await electronApp.evaluate(
      ({ BrowserWindow, ipcMain }, listing) => {
        ipcMain.removeHandler('shared-containers:list-with-me');
        ipcMain.handle('shared-containers:list-with-me', () => ({
          containers: listing.containers,
          nextCursor: listing.nextCursor,
        }));
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        // A purge naming the container on screen. The scope is what makes
        // this a teardown rather than a no-op: an untargeted broadcast used
        // to close whatever share happened to be mounted.
        mainWindow?.webContents.send('shared-containers:replica-changed', {
          purged: 'container',
          containerId: listing.coworkContainerId,
        });
      },
      {
        containers: revokedRecipientScenario.sharedContainersState.containers,
        nextCursor: null,
        coworkContainerId: SHARED_CONTAINER_RECIPIENT_COWORK_ID,
      },
    );
    await expect(surface).toHaveCount(0);
    await expect(coworkRow).toHaveCount(0, { timeout: 30_000 });
  } finally {
    try {
      // The seeded Launch command is long-lived. Revocation stops it on the
      // happy path; stop it here too when the test failed before revoking.
      if (electronApp) {
        const recipientWindow = await electronApp
          .firstWindow()
          .catch(() => undefined);
        const cleanup = recipientWindow
          ?.evaluate(async (containerId) => {
            const sessions = await window.api.terminal.list();
            await Promise.all(
              sessions
                .filter(
                  (session) =>
                    session.projectId === 'shared-container-viewer' &&
                    session.worktreeId === containerId,
                )
                .map((session) =>
                  window.api.terminal.kill({ terminalId: session.id }),
                ),
            );
          }, SHARED_CONTAINER_RECIPIENT_CODE_ID)
          .catch(() => undefined);
        // A wedged renderer must not hold teardown; closing the app reaps
        // the process tree either way.
        let cleanupTimer;
        await Promise.race([
          cleanup,
          new Promise((resolve) => {
            cleanupTimer = setTimeout(resolve, 5_000);
          }),
        ]);
        clearTimeout(cleanupTimer);
      }
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-3658: a missing-repository-access block names the canonical repository
 * from the structured `repository` field, explains that sharing a project in
 * the app does not grant GitHub access, and points the recipient at the person
 * who shared it. A retry that blocks on a second repository must not leave the
 * first name visible; a legacy state without a name gets generic copy; and a
 * successful retry opens the files.
 */
test('names the blocking repository and asks the sharer for access', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-repository-access-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario();
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toBeVisible({ timeout: 30_000 });

    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    await window.evaluate(
      async ({ projectId, worktreeId }) => {
        await window.api.chat.loadTabs({ projectId, worktreeId });
      },
      {
        projectId: 'shared-container-viewer',
        worktreeId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
      },
    );
    const availableCodeState = {
      status: 'available',
      containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
      organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      containerType: 'CODE_WORKTREE',
      updatedAt: NOW,
      revisionId: 'code-revision-1',
      revision: 1,
      revisionCreatedAt: NOW,
      withheldFileCount: 2,
      withheldFileReasons: ['credential-shaped', 'oversized'],
    };
    const blockedCodeState = (repository) => ({
      status: 'blocked',
      containerId: availableCodeState.containerId,
      organizationId: availableCodeState.organizationId,
      containerType: 'CODE_WORKTREE',
      updatedAt: availableCodeState.updatedAt,
      reason: 'repository-access-missing',
      message: 'Repository access is missing.',
      ...(repository === undefined ? {} : { repository }),
    });
    // Opening blocks on the first repository; the first retry blocks on a
    // second one; the last retry succeeds against the seeded revision.
    await electronApp.evaluate(
      ({ ipcMain }, state) => {
        ipcMain.removeHandler('shared-containers:open');
        ipcMain.handle('shared-containers:open', () => state.firstBlocked);
        const responses = [state.secondBlocked, state.available];
        ipcMain.removeHandler('shared-containers:retry');
        ipcMain.handle(
          'shared-containers:retry',
          () => responses.shift() ?? state.available,
        );
        ipcMain.removeHandler('shared-containers:list-with-me');
        ipcMain.handle('shared-containers:list-with-me', () => state.listing);
      },
      {
        available: availableCodeState,
        firstBlocked: blockedCodeState(undefined),
        secondBlocked: blockedCodeState('acme/tower-assets'),
        listing: {
          containers: recipientScenario.sharedContainersState.containers,
          nextCursor: null,
        },
      },
    );

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface).toBeVisible({ timeout: 30_000 });

    const notice = surface.getByTestId(
      'shared-container-blocked-repository-access-missing',
    );
    await expect(notice).toContainText(
      'GitHub access to this repository is required',
    );
    // The name must survive the real main → preload → renderer subscription,
    // independently of the open/retry response path.
    await electronApp.evaluate(({ BrowserWindow }, namedBlocked) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      mainWindow?.webContents.send(
        'shared-containers:replica-changed',
        namedBlocked,
      );
    }, blockedCodeState('acme/tower-defense'));
    await expect(notice).toContainText(
      'GitHub access to acme/tower-defense is required',
      { timeout: 30_000 },
    );
    await expect(notice).toContainText(
      /This project was shared with you in .+, but its files are in the private GitHub repository acme\/tower-defense\./,
    );
    await expect(notice).toContainText(
      'Ask the person who shared this project with you for access to that repository, then re-check access.',
    );
    // Diagnostics are never user-facing copy.
    await expect(notice).not.toContainText('Repository access is missing.');
    const retry = surface.getByTestId('shared-container-retry');
    await expect(retry).toHaveText('Re-check access');

    await retry.click();
    await expect(notice).toContainText(
      'GitHub access to acme/tower-assets is required',
    );
    await expect(notice).not.toContainText('acme/tower-defense');

    // A legacy state from before the field existed arrives through the real
    // renderer subscription and falls back to generic, actionable copy.
    await electronApp.evaluate(({ BrowserWindow }, legacyBlocked) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      mainWindow?.webContents.send(
        'shared-containers:replica-changed',
        legacyBlocked,
      );
    }, blockedCodeState(undefined));
    await expect(notice).toContainText(
      'GitHub access to this repository is required',
    );
    await expect(notice).toContainText(
      /This project was shared with you in .+, but its files are in a private GitHub repository\. Ask the person who shared this project with you for access to that repository, then re-check access\./,
    );
    await expect(notice).not.toContainText('acme/');

    await retry.click();
    await expect(notice).toHaveCount(0);
    await expect(
      surface.getByTestId('panel-tab-panel-chat-code-chat'),
    ).toBeVisible({ timeout: 30_000 });
    // Success must restore production file reads, not just the chat chrome.
    await surface.getByTestId('panel-add-tab-group-chat').click();
    await window
      .getByTestId('panel-add-menu')
      .getByTestId('panel-add-menu-item-file-explorer')
      .click();
    const explorer = surface.getByTestId('panel-content-file-explorer');
    await explorer
      .locator('[data-testid="files-tree-folder"]')
      .filter({ hasText: 'recipient-fixture' })
      .first()
      .click();
    await explorer
      .locator('[data-testid="files-tree-folder"][data-path="blog"]')
      .first()
      .click();
    await explorer
      .locator('[data-testid="files-tree-row"][data-path="blog/index.html"]')
      .first()
      .click();
    await expect(
      surface.locator('[data-testid="panel-content-file-diff"]:visible'),
    ).toContainText('recipient-style-proof', { timeout: 30_000 });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/** Adds a recipient-local file explorer panel and lets its save reach main. */
async function addRecipientFileExplorer(window, surface) {
  await surface.locator('[data-testid^="panel-add-tab-"]').first().click();
  await window
    .getByTestId('panel-add-menu')
    .getByTestId('panel-add-menu-item-file-explorer')
    .click();
  await expect(surface.getByTestId('panel-content-file-explorer')).toBeVisible({
    timeout: 30_000,
  });
  // Panel layout persistence is intentionally debounced. Let the recipient's
  // change reach main, so a reset is what removes it rather than a lost save;
  // Electron's forceful test shutdown does not await the unload flush.
  await window.waitForTimeout(750);
}

/** Adds a recipient-local browser panel and lets its session reach main. */
async function addRecipientBrowser(window, surface) {
  const browserTabs = surface.locator(
    '[role="tab"][data-panel-kind="browser"]',
  );
  // The seeded publisher layout has no browser, so any browser tab that
  // survives a reopen is the recipient's own.
  await expect(browserTabs).toHaveCount(0);
  await surface.locator('[data-testid^="panel-add-tab-"]').first().click();
  await window
    .getByTestId('panel-add-menu')
    .getByTestId('panel-add-menu-item-browser')
    .click();
  await expect(browserTabs).toHaveCount(1, { timeout: 30_000 });
  await window.waitForTimeout(750);
}

/** The seeded publisher layout is back and the recipient's explorer is gone. */
async function expectPublisherLayoutWithoutRecipientPanel(surface) {
  await expect(surface.getByTestId('panel-grid-root')).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    surface.locator('[role="tab"][data-panel-kind="chat"]').filter({
      hasText: 'Review implementation',
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    surface.locator('[role="tab"][data-panel-kind="file-diff"]').filter({
      hasText: 'index.html',
    }),
  ).toBeVisible();
  await expect(
    surface.locator('[role="tab"]').filter({ hasText: 'unchanged-guide.md' }),
  ).toHaveCount(1);
  await expect(surface.getByTestId('panel-content-file-explorer')).toHaveCount(
    0,
  );
  await expect(
    surface.locator('[role="tab"][data-panel-kind="file-explorer"]'),
  ).toHaveCount(0);
  await expect(
    surface.locator('[role="tab"][data-panel-kind="browser"]'),
  ).toHaveCount(0);
}

test('opens to the publisher layout and resets recipient changes on reopen and after restart', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-layout-recipient-'),
  );
  // A live worktree to navigate to, which is how a recipient leaves a share.
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // The revision carries a start page too: on open the layout wins over it.
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeLayout: true,
    includeStartPage: true,
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeLayout: true,
      includeStartPage: true,
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    await expect
      .poll(() =>
        window.evaluate(
          (containerId) =>
            window.api.sharedContainers.getReplicaState({ containerId }),
          SHARED_CONTAINER_RECIPIENT_CODE_ID,
        ),
      )
      .toMatchObject({ status: 'available', revision: 1 });
    await window.evaluate(
      ({ containerId, organizationId }) =>
        window.api.sharedContainers.accept({ containerId, organizationId }),
      {
        containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      },
    );
    await window.reload();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    let surface = window.getByTestId('shared-container-surface');
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          SHARED_CONTAINERS_CLOUD_API_KEY,
        );
        return activity.sharedContainersResolveLatest ?? 0;
      })
      .toBeGreaterThan(0);
    await expect(surface.getByTestId('panel-grid-root')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      surface.locator('[role="tab"][data-panel-kind="chat"]').filter({
        hasText: 'Review implementation',
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      surface.locator('[role="tab"][data-panel-kind="file-diff"]').filter({
        hasText: 'index.html',
      }),
    ).toBeVisible();
    // A publisher tab on an unchanged tracked file opens too: the replica is
    // a full checkout, so the file is readable though no revision lists it.
    await expect(
      surface.locator('[role="tab"]').filter({
        hasText: 'unchanged-guide.md',
      }),
    ).toHaveCount(1);
    // Each published file opens once, as a file tab. It used to open twice:
    // also as a stray chat tab titled with the replica's absolute path.
    await expect(
      surface.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toHaveCount(1);
    await expect(surface).not.toContainText('missing-chat');
    await expect(surface).not.toContainText('private/not-published.txt');
    // The layout decided the open, not the start page, which would have
    // opened index.html in a browser panel.
    await expect(
      surface.locator('[role="tab"][data-panel-kind="browser"]'),
    ).toHaveCount(0);

    // Add a recipient-local panel, leave the share, and come back in the same
    // session: the open resets the viewer to the publisher's layout.
    await addRecipientFileExplorer(window, surface);
    await addRecipientBrowser(window, surface);
    await app.selectWorktree('demo-main');
    await expect(surface).toHaveCount(0);
    await window
      .getByTestId(`shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`)
      .click();
    await expectPublisherLayoutWithoutRecipientPanel(surface);

    // The same holds across a full restart.
    await addRecipientFileExplorer(window, surface);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    await window
      .getByTestId(`shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`)
      .click();
    surface = window.getByTestId('shared-container-surface');
    await expectPublisherLayoutWithoutRecipientPanel(surface);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('opens a localhost web page from the publisher layout', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-web-page-recipient-'),
  );
  // A loopback address, the case a publisher sharing a dev server needs. The
  // mock server answers it, so the page loads like a real local app.
  const webPageUrl = new URL('/healthz', DEFAULT_MOCK_BASE_URL).href;
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeLayout: true,
    includeLayoutWebPage: true,
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeLayout: true,
      layoutWebPageUrl: webPageUrl,
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    await window.evaluate(
      ({ containerId, organizationId }) =>
        window.api.sharedContainers.accept({ containerId, organizationId }),
      {
        containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface.getByTestId('panel-grid-root')).toBeVisible({
      timeout: 30_000,
    });

    // The web page opens as a browser tab beside the published chat and files.
    const webPageTab = surface.locator(
      '[role="tab"][data-panel-kind="browser"]',
    );
    await expect(webPageTab).toHaveCount(1, { timeout: 30_000 });
    await webPageTab.click();
    await expect(surface.getByTestId('browser-url-input')).toHaveValue(
      webPageUrl,
      { timeout: 30_000 },
    );
    await expect(
      surface.locator('[role="tab"][data-panel-kind="chat"]').filter({
        hasText: 'Review implementation',
      }),
    ).toBeVisible();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('keeps a returning recipient arrangement when the revision ships no layout', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-no-layout-recipient-'),
  );
  // A live worktree to navigate to, which is how a recipient leaves a share.
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // No `layout` in the revision is what a publisher who turned "Open to my
  // layout" off ships.
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    await window.evaluate(
      ({ containerId, organizationId }) =>
        window.api.sharedContainers.accept({ containerId, organizationId }),
      {
        containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface.getByTestId('panel-grid-root')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      surface.locator('[role="tab"][data-panel-kind="chat"]').filter({
        hasText: 'Review implementation',
      }),
    ).toBeVisible({ timeout: 30_000 });

    // With no publisher layout to reset to, the recipient's own panel is
    // still there after leaving the share and opening it again.
    await addRecipientFileExplorer(window, surface);
    await app.selectWorktree('demo-main');
    await expect(surface).toHaveCount(0);
    await codeRow.click();
    await expect(
      surface.getByTestId('panel-content-file-explorer'),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('opens a v4 HTML start page first with the published chat beside it', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-start-page-recipient-'),
  );
  // No layout: a revision carrying both opens to the layout, so the start
  // page decides the open only for a share whose publisher ships no layout.
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeStartPage: true,
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeStartPage: true,
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    await window.evaluate(
      ({ containerId, organizationId }) =>
        window.api.sharedContainers.accept({ containerId, organizationId }),
      {
        containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface.getByTestId('panel-grid-root')).toBeVisible({
      timeout: 30_000,
    });

    // The tab is named for the file only until the page loads and supplies
    // its own title, so identify the start page by its address instead.
    const startPageTab = surface.locator(
      '[role="tab"][data-panel-kind="browser"]',
    );
    await expect(startPageTab).toBeVisible({ timeout: 30_000 });
    await expect(startPageTab).toHaveAttribute('data-active', 'true');
    await expect(surface.getByTestId('browser-url-input')).toHaveValue(
      /\/index\.html$/,
    );
    await expect(
      surface.locator('[role="tab"][data-panel-kind="chat"]').filter({
        hasText: 'Review implementation',
      }),
    ).toBeVisible();
    await expect(
      surface.locator('[role="tab"][data-panel-kind="file-diff"]'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * Record every browser failure state the page shows from now on, even one
 * that later recovers by itself, so a transient failure cannot slip past a
 * point-in-time assertion.
 */
async function recordBrowserFailures(window) {
  await window.evaluate(() => {
    const failures = [];
    globalThis.__recordedBrowserFailures = failures;
    const scan = () => {
      for (const element of document.querySelectorAll(
        '[data-testid="browser-pane-failed"]',
      )) {
        const text = element.textContent ?? '';
        if (!failures.includes(text)) failures.push(text);
      }
    };
    scan();
    new MutationObserver(scan).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/** Waits out the settle window, then asserts no failure was ever shown. */
async function expectNoBrowserFailures(window) {
  await window.waitForTimeout(3_000);
  expect(
    await window.evaluate(() => globalThis.__recordedBrowserFailures ?? []),
  ).toEqual([]);
}

test('opens a Cowork share on the publisher layout, active browser and file diff', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-cowork-layout-'),
  );
  const recipientScenario = sharedContainerRecipientScenario({
    includeCode: false,
    includeCoworkLayout: true,
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeCoworkLayout: true,
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    await window.evaluate(
      ({ containerId, organizationId }) =>
        window.api.sharedContainers.accept({ containerId, organizationId }),
      {
        containerId: SHARED_CONTAINER_RECIPIENT_COWORK_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    let coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });
    await recordBrowserFailures(window);
    await coworkRow.click();
    let surface = window.getByTestId('shared-container-surface');
    await expect(surface.getByTestId('panel-grid-root')).toBeVisible({
      timeout: 30_000,
    });

    // The publisher's split survives: the chat group sits beside the group
    // holding the browser and file tabs. The publisher left a browser tab
    // active there, so that group opens on it. Both publisher browser tabs
    // survive even though they show the same file.
    await expect(
      surface.locator('[role="tab"][data-panel-kind="browser"]'),
    ).toHaveCount(2, { timeout: 30_000 });
    const activeBrowser = surface.locator(
      '[data-testid="panel-content-browser"]:visible',
    );
    await expect(activeBrowser).toHaveCount(1, { timeout: 30_000 });
    await expect(
      surface.locator('[data-testid="panel-content-chat"]:visible'),
    ).toHaveCount(1);
    await expect(
      surface.locator('[data-testid="panel-content-file-diff"]:visible'),
    ).toHaveCount(0);
    await expect(activeBrowser.getByTestId('browser-url-input')).toHaveValue(
      /\/content\/exports\/customer-summary\.txt$/,
      {
        timeout: 30_000,
      },
    );
    // The page must load on first open without a transient failure state.
    await expectNoBrowserFailures(window);

    // The publisher's Cowork file tab arrives in diff mode against the Cowork
    // file root. It must read through the same root the explorer uses rather
    // than fail with "Shared-container repository is not declared".
    const diffTab = surface
      .locator('[role="tab"][data-panel-kind="file-diff"]')
      .filter({ hasText: 'customer-summary.txt' });
    await expect(diffTab).toBeVisible({ timeout: 30_000 });
    await diffTab.click();
    const diffPanel = surface.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await expect(
      diffPanel.locator('[data-testid="file-viewer-view-diff"]:visible'),
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await expect(diffPanel).toContainText('Customer follow-up details.', {
      timeout: 30_000,
    });
    await expect(diffPanel).not.toContainText('not declared');

    // Reopening the share after a restart restores the same browser without
    // flashing a failure either.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installRecipientListing(electronApp, window, recipientScenario);
    await app.openMainPage();
    coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });
    await recordBrowserFailures(window);
    await coworkRow.click();
    surface = window.getByTestId('shared-container-surface');
    await surface
      .locator('[role="tab"][data-panel-kind="browser"]')
      .first()
      .click();
    await expect(
      surface
        .locator('[data-testid="panel-content-browser"]:visible')
        .getByTestId('browser-url-input'),
    ).toHaveValue(/\/content\/exports\/customer-summary\.txt$/, {
      timeout: 30_000,
    });
    await expectNoBrowserFailures(window);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('opens and diffs a materialized schema-v2 code snapshot', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-snapshot-recipient-'),
  );
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    codeSource: 'snapshot',
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      codeSource: 'snapshot',
    });
    const layoutPath = path.join(
      userDataDir,
      'shared-containers',
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
      'revisions',
      'code-revision-1',
      'artifacts',
      'container.json',
    );
    const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
    expect(layout.schemaVersion).toBe(2);
    expect(layout.repositories[0].source).toBe('snapshot');

    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface).toBeVisible({ timeout: 30_000 });

    const repositories = await window.evaluate(
      (request) => window.api.sharedContainers.listRepositories(request),
      {
        containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
        revisionId: 'code-revision-1',
      },
    );
    expect(repositories[0]).toEqual({
      repoId: 'repo-1',
      repoName: 'recipient-fixture',
      baseCommitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });

    await expandRecipientActivity(surface);
    const snapshotFile = surface
      .getByTestId('changed-files-section')
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'recipient.ts' });
    await expect(snapshotFile).toBeVisible({ timeout: 30_000 });
    await snapshotFile.click();
    await expect(surface.getByTestId('file-panel-diff')).toContainText(
      'export const recipient = true;',
      { timeout: 30_000 },
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-2551. The account's only organization is billing-lapsed. The desktop
 * still asks the server — that 403 is what drives the replica purge — and the
 * typed refusal it comes back as must keep the section absent. Before this
 * change the 403 was rendered as "Could not load shared containers."
 *
 * Both scenario overrides are load-bearing. `cloud.orgBillingStates` flips the
 * fixture's hardcoded `teamsEntitled: true`, and `sharedWithMeError` makes the
 * mock answer the lapsed org the way the real server does; without the latter
 * the mock would 200 and the spec would assert against a listing that never
 * got refused.
 */
test('hides the Shared with me section when every organization is billing-lapsed', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-recipient-lapsed-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario();
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...recipientScenario,
      cloud: {
        ...recipientScenario.cloud,
        orgBillingStates: [
          {
            organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
            organizationName: 'Shared Containers E2E',
            teamsEntitled: false,
          },
        ],
      },
      sharedContainers: {
        ...recipientScenario.sharedContainers,
        sharedWithMeError: 'blocked-by-org-billing',
      },
    },
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    // Prove the sidebar itself rendered before asserting an absence, so this
    // cannot pass on a blank shell.
    await expect(window.getByTestId('sidebar-section-code')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toHaveCount(0);
    // A benign block is not a load failure: no error row, no Retry.
    await expect(window.getByTestId('shared-container-list-error')).toHaveCount(
      0,
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-2551. The complement of the spec above, and the one that would have
 * caught the original collapse: a GENUINE transport failure must stay visible
 * and retryable, and clearing the fault must let Retry recover the listing.
 */
test('offers a retry when the shared-container listing genuinely fails', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-recipient-retry-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario();
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...recipientScenario,
      sharedContainers: {
        ...recipientScenario.sharedContainers,
        sharedWithMeError: { status: 500 },
      },
    },
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    await expect(window.getByTestId('shared-container-list-error')).toBeVisible(
      { timeout: 30_000 },
    );
    const retry = window.getByTestId('shared-container-list-retry');
    await expect(retry).toBeVisible();
    // CAN-3551: Retry is an icon in the row's trailing column, named for
    // assistive tech because it carries no text, and the copy is unchanged.
    await expect(retry).toHaveAccessibleName('Retry');
    await expect(retry).toHaveText('');
    await expect(
      window.getByTestId('shared-container-list-message'),
    ).toHaveText('Could not load shared containers.');
    await expectStatusRowOnProjectGrid(
      window,
      window.getByTestId('shared-container-list-error'),
      retry,
    );

    // Clear the fault, then retry. The button must survive its own click:
    // `loadSharedWithMe` sets `listStatus: 'loading'`, which would otherwise
    // unmount the section mid-retry.
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      recipientScenario,
    );
    await window.getByTestId('shared-container-list-retry').click();

    await expect(
      window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('shared-container-list-error')).toHaveCount(
      0,
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * Database-blip resilience. A retryable server condition is not a failure the
 * user should have to act on: the Cloud API now answers a database outage with
 * a 503 (`database_unavailable`) instead of a bare 500, and the section reports
 * that it is reconnecting and heals itself on a backoff ladder.
 *
 * The two assertions that matter are the absence of the Retry button while
 * unavailable, and the recovery happening with NO interaction at all — the
 * spec clears the fault and then only waits.
 */
test('reports a transient outage as reconnecting and recovers without user input', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-recipient-unavailable-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario();
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...recipientScenario,
      sharedContainers: {
        ...recipientScenario.sharedContainers,
        // Exactly what `makeInstrumentedRoute` now returns when Prisma hands
        // out a dead pooled connection: the flat `{ error, code }` envelope
        // the `/api/v1` family uses, which is what the desktop cloud client's
        // `readResponseErrorDetail` parses.
        sharedWithMeError: {
          status: 503,
          body: {
            error: { code: 'database_unavailable' },
          },
        },
      },
    },
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    const unavailableRow = window.getByTestId(
      'shared-container-list-unavailable',
    );
    await expect(unavailableRow).toBeVisible({ timeout: 30_000 });
    await expect(unavailableRow).toContainText('Reconnecting');
    // Not the genuine-failure row, and no button to press: the store is
    // already retrying.
    await expect(window.getByTestId('shared-container-list-error')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('shared-container-list-retry')).toHaveCount(
      0,
    );
    // CAN-3551: the reconnecting copy shares the retryable row's position,
    // and its spinner sits in the column the retry icon would.
    await expectStatusRowOnProjectGrid(
      window,
      unavailableRow,
      unavailableRow.getByTestId('shared-container-list-trailing'),
    );

    // The database comes back. Nothing below clicks anything.
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      recipientScenario,
    );

    await expect(
      window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(unavailableRow).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * A publisher revision landing under a settled reader must not move them.
 *
 * The reported symptom: the recipient selects the 3rd chat, the publisher
 * types, the revision syncs, and the selection jumps back to chat 1. Two
 * independent unmount sources caused it — the store cleared `selectedChat`
 * with the rest of the working set (and the panel auto-selects `items[0]`
 * whenever nothing is selected, in artifact-filename order), and the chat
 * list going back to `loading` tore the transcript down on its own.
 *
 * Revision 2 is already on disk; promoting it is a real index rewrite, and
 * every content read below goes through the production reader IPC.
 */
test('keeps the recipient on their selected chat when a publisher revision lands', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-revision-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario({});
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toBeVisible({ timeout: 30_000 });
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );

    // Seed after the authenticated organization snapshot has settled, then
    // restart so the replica store establishes its root identity from those
    // bytes. This lets the test use production reconciliation instead of an
    // open-handler stub while preserving the normal account-change purge.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });
    await coworkRow.click();
    await expect(window.getByTestId('shared-container-surface')).toBeVisible({
      timeout: 30_000,
    });
    const surface = window.getByTestId('shared-container-surface');

    // Keep standard activity and file-tree caches live across the promotion.
    // The revision event must refresh these stores without remounting chat.
    await expandRecipientActivity(surface);
    await expect(
      surface.getByTestId('workspace-notes-item').filter({
        hasText: 'Follow-up note',
      }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      surface.getByTestId('workspace-notes-item').filter({
        hasText: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_NOTE,
      }),
    ).toHaveCount(0);
    await surface.getByTestId('panel-add-tab-group-chat').click();
    await window
      .getByTestId('panel-add-menu')
      .getByTestId('panel-add-menu-item-file-explorer')
      .click();
    const coworkExplorer = surface.getByTestId('panel-content-file-explorer');
    const fileExplorerPanelId = await coworkExplorer.evaluate((element) =>
      element.closest('[data-panel-id]')?.getAttribute('data-panel-id'),
    );
    expect(fileExplorerPanelId).toBeTruthy();
    await coworkExplorer
      .locator('[data-testid="files-tree-folder"][data-path="exports"]')
      .click();
    await expect(
      coworkExplorer.locator(
        `[data-testid="files-tree-row"][data-path="${SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE}"]`,
      ),
    ).toHaveCount(0);

    // Deliberately select the SECOND chat: chat 1 is what a lost selection
    // falls back to, so a test sitting on chat 1 could not tell the two apart.
    // Chats are the standard chat tab strip over the read-only chat scope.
    const firstChatRow = window.getByTestId('panel-tab-panel-chat-cowork-chat');
    const secondChatRow = window.getByTestId(
      `panel-tab-panel-chat-${SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID}`,
    );
    await expect(secondChatRow).toBeVisible({ timeout: 30_000 });
    await secondChatRow.click();
    await expect(secondChatRow).toHaveAttribute('aria-selected', 'true');
    const transcript = window.getByTestId('chat-message-list-scroll');
    await expect(transcript).toBeVisible({ timeout: 30_000 });
    await expect(transcript).toContainText('Track the follow-up thread.');

    // Watch the transcript's parent for the scroll node being removed. A
    // remount is what destroys scroll position, and it would be invisible in
    // a final-state assertion because the replacement looks identical.
    await window.evaluate(() => {
      const node = document.querySelector(
        '[data-testid="chat-message-list-scroll"]',
      );
      window.__transcriptDetached = false;
      window.__transcriptObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (removed === node || removed.contains?.(node) === true) {
              window.__transcriptDetached = true;
            }
          }
        }
      });
      window.__transcriptObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });

    // Promote revision 2 by rewriting the authoritative index and advancing
    // the server checkpoint, then reconcile through main's real open path.
    // That path projects the published chats into canonical chat state before
    // it emits replica-changed; fabricating the renderer broadcast alone would
    // skip the backend half of the revision seam and cannot represent a
    // completed sync.
    // The verified revision-1 open prunes every unindexed revision, as it
    // should in production. Recreate the staged fixture bytes immediately
    // before promoting revision 2 so this models their arrival after open.
    seedSharedContainerRecipientCoworkRevision(userDataDir, {
      revisionId: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
      secondChatExtraMessage:
        SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
      includeRevisionTwoContent: true,
    });
    const indexPath = path.join(userDataDir, 'shared-containers', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.containers[SHARED_CONTAINER_RECIPIENT_COWORK_ID].revisionId =
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID;
    index.containers[SHARED_CONTAINER_RECIPIENT_COWORK_ID].revision = 2;
    writeFileSync(indexPath, JSON.stringify(index), 'utf8');

    const revision2Scenario = sharedContainerRecipientScenario({});
    revision2Scenario.sharedContainersState.containers =
      revision2Scenario.sharedContainersState.containers.map((container) =>
        container.id === SHARED_CONTAINER_RECIPIENT_COWORK_ID
          ? {
              ...container,
              revision: 2,
              updatedAt: NOW,
              latestRevision: {
                ...container.latestRevision,
                id: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
                revision: 2,
              },
            }
          : container,
      );
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      revision2Scenario,
    );
    await window.evaluate(
      async ({ containerId, organizationId }) => {
        await window.api.sharedContainers.open({ containerId, organizationId });
      },
      {
        containerId: SHARED_CONTAINER_RECIPIENT_COWORK_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
      },
    );

    // The publisher's new message arrives in the chat the recipient was
    // already reading...
    await expect(transcript).toContainText(
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
      { timeout: 30_000 },
    );
    // ...in place, with the selection untouched.
    await expect(secondChatRow).toHaveAttribute('aria-selected', 'true');
    await expect(firstChatRow).toHaveAttribute('aria-selected', 'false');
    expect(await window.evaluate(() => window.__transcriptDetached)).toBe(
      false,
    );
    await expect(
      surface.getByTestId('workspace-notes-item').filter({
        hasText: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_NOTE,
      }),
    ).toHaveCount(1, { timeout: 30_000 });
    await surface.getByTestId(`panel-tab-${fileExplorerPanelId}`).click();
    await expect(
      coworkExplorer.locator(
        `[data-testid="files-tree-row"][data-path="${SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE}"]`,
      ),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * Launch with the Cowork share accepted and its revision-1 replica on disk,
 * through the same accept → restart → seed sequence as the revision test
 * above, so every open below runs main's production reconciliation.
 *
 * `track` receives each launched app (and `undefined` across the restart) so
 * the caller's `finally` can always close whichever one is running.
 */
async function launchAcceptedCoworkShare(userDataDir, track) {
  const env = buildSharedContainerE2eEnv(
    userDataDir,
    SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
  );
  let { electronApp } = await launchCanopy({ userDataDir, env });
  track(electronApp);
  let window = await electronApp.firstWindow();
  let app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectSharedContainersAccount(window);
  await app.openMainPage();
  await expect(
    window.getByTestId('sidebar-section-shared-with-me'),
  ).toBeVisible({ timeout: 30_000 });
  await acceptSharedContainerInvitation(
    window,
    SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  );

  await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  track(undefined);
  seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
  ({ electronApp } = await launchCanopy({ userDataDir, env }));
  track(electronApp);
  window = await electronApp.firstWindow();
  app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  return { electronApp, window, app };
}

/** Select the chat that revision 2 appends to, and wait for its transcript. */
async function selectCoworkSecondChat(window) {
  const secondChatRow = window.getByTestId(
    `panel-tab-panel-chat-${SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID}`,
  );
  await expect(secondChatRow).toBeVisible({ timeout: 30_000 });
  await secondChatRow.click();
  await expect(secondChatRow).toHaveAttribute('aria-selected', 'true');
  const transcript = window.getByTestId('chat-message-list-scroll');
  await expect(transcript).toBeVisible({ timeout: 30_000 });
  await expect(transcript).toContainText('Track the follow-up thread.');
  return transcript;
}

/**
 * Publish revision 2 the way the revision test above does (staged bytes, an
 * index rewrite, an advanced server checkpoint), but stop there. Nothing here
 * calls `sharedContainers.open` or sends `replica-changed`: whether the open
 * viewer notices is exactly what the callers assert.
 */
async function publishCoworkRevisionTwo(userDataDir) {
  seedSharedContainerRecipientCoworkRevision(userDataDir, {
    revisionId: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
    secondChatExtraMessage:
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
    includeRevisionTwoContent: true,
  });
  const indexPath = path.join(userDataDir, 'shared-containers', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.containers[SHARED_CONTAINER_RECIPIENT_COWORK_ID].revisionId =
    SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID;
  index.containers[SHARED_CONTAINER_RECIPIENT_COWORK_ID].revision = 2;
  writeFileSync(indexPath, JSON.stringify(index), 'utf8');

  const revision2Scenario = sharedContainerRecipientScenario({});
  revision2Scenario.sharedContainersState.containers =
    revision2Scenario.sharedContainersState.containers.map((container) =>
      container.id === SHARED_CONTAINER_RECIPIENT_COWORK_ID
        ? {
            ...container,
            revision: 2,
            updatedAt: NOW,
            latestRevision: {
              ...container.latestRevision,
              id: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
              revision: 2,
            },
          }
        : container,
    );
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    revision2Scenario,
  );
}

/**
 * CAN-3559 control: an open share picks up a publisher revision by itself.
 *
 * Main arms a realtime subscription and a 30s fallback pull when an open
 * completes. No other spec lets that pull deliver an update on its own (the
 * revision test above forces a reconcile with a second `open`), so without
 * this control the race spec below could pass or fail for reasons unrelated to
 * tracking. The wait is the production timer; there is no test seam for it.
 */
test('delivers a publisher revision to an open share through the fallback pull', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-fallback-pull-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    sharedContainerRecipientScenario({}),
  );

  let electronApp;
  try {
    const { window } = await launchAcceptedCoworkShare(
      userDataDir,
      (launched) => {
        electronApp = launched;
      },
    );
    const coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });
    await coworkRow.click();
    await expect(window.getByTestId('shared-container-surface')).toBeVisible({
      timeout: 30_000,
    });
    const transcript = await selectCoworkSecondChat(window);

    await publishCoworkRevisionTwo(userDataDir);

    await expect(transcript).toContainText(
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
      { timeout: 60_000 },
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-3559: leaving a share and coming straight back must not strand it.
 *
 * The reported symptom: the publisher's new message never appeared in the open
 * transcript until the recipient selected another worktree and came back. The
 * `shared-containers:close` from the earlier visit can land after the `open`
 * of the next one (it waits on the per-container lifecycle lock and on the
 * renderer's serialized close chain; the open waits on neither). Main used to
 * treat that late close as "the viewer left" and released the subscription and
 * the fallback pull of the visit now on screen.
 *
 * The real close handler is held, not stubbed, so the late arrival is forced
 * deterministically and everything it does on release is production code. The
 * open count, not the transcript, proves the second open finished before the
 * close is released: revision-1 text can render from retained state before
 * main has armed anything.
 */
test('keeps receiving publisher revisions after an away-and-back whose close lands late', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-late-close-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    sharedContainerRecipientScenario({}),
  );

  let electronApp;
  try {
    const { window, app } = await launchAcceptedCoworkShare(
      userDataDir,
      (launched) => {
        electronApp = launched;
      },
    );
    const coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });

    // Count completed opens through the real handler.
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('shared-containers:open');
      globalThis.sharedContainerOpenSettled = 0;
      ipcMain.removeHandler('shared-containers:open');
      ipcMain.handle('shared-containers:open', async (event, request) => {
        try {
          return await original(event, request);
        } finally {
          globalThis.sharedContainerOpenSettled += 1;
        }
      });
    });
    const openSettledCount = () =>
      electronApp.evaluate(() => globalThis.sharedContainerOpenSettled);

    await coworkRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await selectCoworkSecondChat(window);
    await expect.poll(openSettledCount, { timeout: 30_000 }).toBe(1);

    // Hold the real close response: the first visit's close must still be
    // outstanding when the second visit's open completes.
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('shared-containers:close');
      globalThis.sharedContainerCloseEntered = false;
      globalThis.sharedContainerCloseSettled = false;
      const gate = new Promise((resolve) => {
        globalThis.releaseSharedContainerClose = resolve;
      });
      ipcMain.removeHandler('shared-containers:close');
      ipcMain.handle('shared-containers:close', async (event, request) => {
        globalThis.sharedContainerCloseEntered = true;
        await gate;
        try {
          return await original(event, request);
        } finally {
          globalThis.sharedContainerCloseSettled = true;
        }
      });
    });

    await app.selectWorktree('demo-main');
    await expect(surface).toHaveCount(0);
    await expect
      .poll(
        () =>
          electronApp.evaluate(() => globalThis.sharedContainerCloseEntered),
        { timeout: 30_000 },
      )
      .toBe(true);

    await coworkRow.click();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect.poll(openSettledCount, { timeout: 30_000 }).toBe(2);

    // Only now does the first visit's close reach main.
    await electronApp.evaluate(() => globalThis.releaseSharedContainerClose());
    await expect
      .poll(
        () =>
          electronApp.evaluate(() => globalThis.sharedContainerCloseSettled),
        { timeout: 30_000 },
      )
      .toBe(true);

    const transcript = await selectCoworkSecondChat(window);
    await publishCoworkRevisionTwo(userDataDir);

    await expect(transcript).toContainText(
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
      { timeout: 60_000 },
    );
  } finally {
    try {
      // A failure before the release above would otherwise leave the held
      // close pending and block the shutdown below.
      await electronApp
        ?.evaluate(() => globalThis.releaseSharedContainerClose?.())
        .catch(() => undefined);
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * Removing one share must not close a different one.
 *
 * The purge broadcast used to be a bare `null` with no container identity, so
 * the renderer read *any* teardown as "the mounted container is gone". Removing
 * a second share — or a routine organization re-probe emitting one purge per
 * unauthorized container — therefore closed whatever share the recipient
 * happened to be reading, revealing the local workspace behind the overlay.
 *
 * What this spec proves: the renderer's reaction to an UNRELATED container's
 * scoped purge, driven through the real sidebar Remove flow and the real
 * preload guard -- the open viewer stays mounted, keeps its chat selection,
 * and its transcript node is never detached.
 *
 * What it delegates: main's production purge EMISSION (`dismiss` ->
 * `purgeReplica` -> `emitPurge`) is covered by the reconciliation unit tests,
 * and the real local-purge mechanics by
 * `can-2552-shared-container-fork.spec.mjs`. `shared-containers:dismiss` is
 * stubbed here (see the rationale at the stub), so the purge payload is
 * hand-written in this file and a drift in `emitPurge`'s real shape would NOT
 * fail this spec.
 */
test('keeps an open share mounted when a different share is removed', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-unrelated-purge-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario({});
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toBeVisible({ timeout: 30_000 });
    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    // Same stubbing rationale as the tests above: the plaintext fixture is
    // seeded after the identity transition, outside the running replica
    // manager. Every content read stays production. `open`, the listing, and
    // -- unlike the other tests here -- `dismiss` are stubbed; see the comment
    // at the dismiss stub for why a replica MUTATION cannot run against this
    // fixture.
    await electronApp.evaluate(
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler('shared-containers:open');
        ipcMain.handle('shared-containers:open', (_event, request) => ({
          status: 'available',
          containerId: request.containerId,
          organizationId: request.organizationId,
          containerType:
            request.containerId === fixture.coworkContainerId
              ? 'COWORK_WORK_ENTRY'
              : 'CODE_WORKTREE',
          updatedAt: fixture.now,
          revisionId:
            request.containerId === fixture.coworkContainerId
              ? 'cowork-revision-1'
              : 'code-revision-1',
          revision: 1,
          revisionCreatedAt: fixture.now,
          withheldFileCount: 1,
          withheldFileReasons: ['symlink-escaping'],
        }));
        ipcMain.removeHandler('shared-containers:list-with-me');
        ipcMain.handle('shared-containers:list-with-me', () => fixture.listing);
        // `dismiss` is stubbed for the SAME reason `open` is: the replica
        // store was initialized before the identity transition above, so it
        // cannot observe an index seeded afterward. A read tolerates that, but
        // a replica MUTATION does not -- the production dismiss path fails the
        // fail-closed root-identity guard with "Shared-container replica root
        // identity changed", the renderer rolls the row back, and the share
        // never leaves the sidebar. That is this fixture's limitation, not the
        // behavior under test.
        //
        // What IS under test is the renderer's reaction to an unrelated
        // container's purge, so the stub emits exactly the broadcast
        // `purgeReplica` emits on the production path
        // (`{ purged: 'container', containerId }` over
        // `shared-containers:replica-changed`) and nothing else. The real
        // local-purge mechanics are covered by
        // `can-2552-shared-container-fork.spec.mjs`, which removes a share
        // against a replica the manager materialized itself.
        ipcMain.removeHandler('shared-containers:dismiss');
        ipcMain.handle('shared-containers:dismiss', (event, request) => {
          event.sender.send('shared-containers:replica-changed', {
            purged: 'container',
            containerId: request.containerId,
          });
          return { dismissed: true };
        });
      },
      {
        now: NOW,
        coworkContainerId: SHARED_CONTAINER_RECIPIENT_COWORK_ID,
        listing: {
          containers: recipientScenario.sharedContainersState.containers,
          nextCursor: null,
        },
      },
    );

    // Both shares accepted: the one being read, and the unrelated one whose
    // removal used to take it down with it.
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    const coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });

    await coworkRow.click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface).toBeVisible({ timeout: 30_000 });
    // The second chat again: a lost selection falls back to chat 1, so sitting
    // on chat 1 could not tell a preserved selection from a reset one.
    const secondChatRow = window.getByTestId(
      `panel-tab-panel-chat-${SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID}`,
    );
    await expect(secondChatRow).toBeVisible({ timeout: 30_000 });
    await secondChatRow.click();
    await expect(secondChatRow).toHaveAttribute('aria-selected', 'true');
    const transcript = window.getByTestId('chat-message-list-scroll');
    await expect(transcript).toContainText('Track the follow-up thread.');

    // The transcript node must survive the unrelated purge untouched. A
    // remount is invisible in a final-state assertion because the replacement
    // renders identically, but it is what destroys the reader's scroll place.
    await window.evaluate(() => {
      const node = document.querySelector(
        '[data-testid="chat-message-list-scroll"]',
      );
      window.__unrelatedPurgeDetached = false;
      window.__unrelatedPurgeObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (removed === node || removed.contains?.(node) === true) {
              window.__unrelatedPurgeDetached = true;
            }
          }
        }
      });
      window.__unrelatedPurgeObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });

    // Remove the OTHER share through the real menu. The menu, the confirm
    // dialog, the renderer store, and the preload guard are all production;
    // only the main-side `dismiss` handler is stubbed, and it emits the same
    // scoped purge broadcast the production path emits.
    await codeRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-remove`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-remove-confirm`,
      )
      .click();
    await expect(codeRow).toHaveCount(0, { timeout: 30_000 });

    // The share being read is untouched: still mounted, still on chat 2, still
    // showing the same transcript, and never remounted.
    await expect(surface).toBeVisible();
    await expect(coworkRow).toBeVisible();
    await expect(secondChatRow).toHaveAttribute('aria-selected', 'true');
    await expect(transcript).toContainText('Track the follow-up thread.');
    expect(await window.evaluate(() => window.__unrelatedPurgeDetached)).toBe(
      false,
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-4052. Removing a share is recoverable: it moves to Past shares, and
 * restoring it returns it to the inbox as a pending invitation. Nothing here
 * is stubbed. An invitation has no replica, so the production listing,
 * dismiss, removed listing and restore all run against the mock server.
 */
test('removes an invitation from its dialog and restores it from Past shares', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-past-shares-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    sharedContainerRecipientScenario({}),
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    const section = window.getByTestId('sidebar-section-shared-with-me');
    await expect(section).toBeVisible({ timeout: 30_000 });
    const pendingCount = window.getByTestId(
      'sidebar-shared-with-me-pending-count',
    );
    const invitation = window.getByTestId(
      `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    const pastShares = window.getByTestId('sidebar-shared-with-me-past-shares');
    await expect(invitation).toBeVisible({ timeout: 30_000 });
    const pendingBefore = Number(await pendingCount.textContent());
    // Nothing accepted or removed yet, so there is no Past shares row.
    await expect(pastShares).toHaveCount(0);

    await removeSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    await expect(invitation).toHaveCount(0);
    await expect(
      window.getByText(
        'Removed Customer follow-up. You can restore it from Past shares.',
      ),
    ).toBeVisible();
    await expect(pastShares).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId('sidebar-shared-with-me-past-shares-count'),
    ).toHaveText('1');
    if (pendingBefore > 1) {
      await expect(pendingCount).toHaveText(String(pendingBefore - 1));
    } else {
      await expect(pendingCount).toHaveCount(0);
    }

    await pastShares.click();
    const page = window.getByTestId('shared-container-past-shares-page');
    await expect(page).toBeVisible();
    await expect(pastShares).toHaveAttribute('aria-current', 'page');
    const removedRow = page.getByTestId(
      `shared-container-past-shares-removed-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(removedRow).toContainText('Customer follow-up');

    await page
      .getByTestId(
        `shared-container-past-shares-restore-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
      )
      .click();
    await expect(removedRow).toHaveCount(0, { timeout: 30_000 });
    // Back in the inbox as a pending invitation, not as an accepted share.
    await expect(invitation).toBeVisible({ timeout: 30_000 });
    await expect(pendingCount).toHaveText(String(pendingBefore));
    await expect(
      page.getByTestId('shared-container-past-shares-empty'),
    ).toBeVisible();

    await page.getByTestId('shared-container-past-shares-page-back').click();
    await expect(page).toHaveCount(0);
    // Nothing is accepted or removed any more, and the section is still here.
    await expect(pastShares).toHaveCount(0);
    await expect(section).toBeVisible();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-4052. A Canopy Cloud deployed before recoverable removal does not
 * advertise the capability, so the desktop must not promise a restore it
 * cannot perform: no Past shares row and no Restore toast.
 */
test('offers no Past shares against a server that cannot restore', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-no-dismissals-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const scenario = sharedContainerRecipientScenario({});
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...scenario,
      cloud: {
        ...scenario.cloud,
        withholdSharedContainerDismissalsCapability: true,
      },
    },
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    const invitation = window.getByTestId(
      `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(invitation).toBeVisible({ timeout: 30_000 });

    await removeSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    await expect(invitation).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-shared-with-me-past-shares'),
    ).toHaveCount(0);
    await expect(
      window.getByText('You can restore it from Past shares.'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-4052. Past shares lists what is accepted on this computer beside what
 * was removed. An accepted share opens from its row, moves to Removed when it
 * is removed from its menu, and can no longer be restored once the owner has
 * revoked the removed recipient. The owner's revoke sends the recipient
 * nothing, so the refusal is discovered on Restore. Nothing is stubbed.
 */
test('moves an accepted share to Removed and refuses a restore the owner revoked', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-past-shares-accepted-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    sharedContainerRecipientScenario({}),
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    const section = window.getByTestId('sidebar-section-shared-with-me');
    await expect(section).toBeVisible({ timeout: 30_000 });
    const pastShares = window.getByTestId('sidebar-shared-with-me-past-shares');
    const pastSharesCount = window.getByTestId(
      'sidebar-shared-with-me-past-shares-count',
    );
    const page = window.getByTestId('shared-container-past-shares-page');
    const acceptedRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    const pastAcceptedRow = page.getByTestId(
      `shared-container-past-shares-accepted-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    const pastRemovedRow = page.getByTestId(
      `shared-container-past-shares-removed-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    await expect(acceptedRow).toBeVisible({ timeout: 30_000 });
    // An accepted share counts as a past share on this computer.
    await expect(pastSharesCount).toHaveText('1');

    await pastShares.click();
    await expect(page).toBeVisible();
    await expect(pastAcceptedRow).toContainText('Customer follow-up');
    await expect(pastRemovedRow).toHaveCount(0);
    // Opening an accepted share closes the page: the viewer takes its slot.
    await page
      .getByTestId(
        `shared-container-past-shares-accepted-open-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
      )
      .click();
    await expect(page).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toBeVisible({
      timeout: 30_000,
    });

    // Removing an accepted share confirms once, and says it can be restored.
    await acceptedRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove`,
      )
      .click();
    const removeConfirm = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove-confirmation`,
    );
    await expect(removeConfirm).toContainText(
      'You can restore the share from Past shares and accept it again.',
    );
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove-confirm`,
      )
      .click();
    await expect(acceptedRow).toHaveCount(0, { timeout: 30_000 });
    await expect(pastSharesCount).toHaveText('1');

    // The same share, now under Removed instead of Accepted.
    await pastShares.click();
    await expect(page).toBeVisible();
    await expect(pastRemovedRow).toContainText('Customer follow-up', {
      timeout: 30_000,
    });
    await expect(pastAcceptedRow).toHaveCount(0);

    // The owner revokes the removed recipient. The mock's by-user revoke
    // drops the removed share for the container, as the real revoke deletes
    // what the recipient could restore from.
    const revoked = await fetch(
      `${DEFAULT_MOCK_BASE_URL}/api/v1/shared-containers/${SHARED_CONTAINER_RECIPIENT_COWORK_ID}/recipients/recipient`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SHARED_CONTAINERS_CLOUD_API_KEY}` },
      },
    );
    expect(revoked.status).toBe(204);

    await page
      .getByTestId(
        `shared-container-past-shares-restore-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
      )
      .click();
    await expect(
      window.getByText(
        "Couldn't restore Customer follow-up. It's no longer shared with you.",
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(pastRemovedRow).toHaveCount(0);
    await expect(
      window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
      ),
    ).toHaveCount(0);
    await expect(section).toBeVisible();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-3612. Shared with me rows sit on the standard sidebar row grid: the
 * title of an invitation and of an accepted share starts on the same column
 * as an ordinary worktree row's title, with the leading icon column reserved
 * even though a share has no status glyph. Measured against a real worktree
 * row in the same rail rather than a pixel constant, because the section's
 * container inset is part of what has to agree.
 */
test('aligns shared row titles with the standard worktree title column', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-row-grid-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const recipientScenario = sharedContainerRecipientScenario({});
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();

    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toBeVisible({ timeout: 30_000 });
    seedSharedContainerRecipientReplicas(userDataDir, { preferences: false });
    // Same stubbing rationale as the tests above: the plaintext fixture is
    // seeded after the identity transition, outside the running replica
    // manager, so `open` and the listing are pinned to the fixture.
    await electronApp.evaluate(
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler('shared-containers:open');
        ipcMain.handle('shared-containers:open', (_event, request) => ({
          status: 'available',
          containerId: request.containerId,
          organizationId: request.organizationId,
          containerType: 'CODE_WORKTREE',
          updatedAt: fixture.now,
          revisionId: 'code-revision-1',
          revision: 1,
          revisionCreatedAt: fixture.now,
          withheldFileCount: 0,
          withheldFileReasons: [],
        }));
        ipcMain.removeHandler('shared-containers:list-with-me');
        ipcMain.handle('shared-containers:list-with-me', () => fixture.listing);
      },
      {
        now: NOW,
        listing: {
          containers: recipientScenario.sharedContainersState.containers,
          nextCursor: null,
        },
      },
    );

    // One accepted share and one pending invitation, beside the seeded
    // worktree, so all three row kinds are on screen at once.
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const acceptedRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    const invitationRow = window.getByTestId(
      `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(acceptedRow).toBeVisible({ timeout: 30_000 });
    await expect(invitationRow).toBeVisible({ timeout: 30_000 });

    const acceptedTitle = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-title`,
    );
    const invitationTitle = window.getByTestId(
      `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-title`,
    );
    // Scoped to one worktree row in the sidebar, so the strict title lookup
    // also fails if a row ever carries a second title id. The sidebar keeps a
    // hidden selected-row pin host; a `display: none` duplicate has no box,
    // so only a visible row is measured.
    const worktreeTitle = window
      .getByTestId('app-sidebar')
      .locator('[data-worktree-id]')
      .filter({ has: window.getByTestId('worktree-row-title') })
      .filter({ visible: true })
      .first()
      .getByTestId('worktree-row-title');
    await expect(acceptedTitle).toBeVisible();
    await expect(invitationTitle).toBeVisible();
    await expect(worktreeTitle).toBeVisible({ timeout: 30_000 });

    const rect = (locator) =>
      locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
        };
      });
    const [worktreeBox, acceptedBox, invitationBox, invitationRowBox] =
      await Promise.all(
        [worktreeTitle, acceptedTitle, invitationTitle, invitationRow].map(
          rect,
        ),
      );

    expect(
      Math.abs(acceptedBox.left - worktreeBox.left),
      `accepted title x ${acceptedBox.left} vs worktree title x ${worktreeBox.left}`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(invitationBox.left - worktreeBox.left),
      `invitation title x ${invitationBox.left} vs worktree title x ${worktreeBox.left}`,
    ).toBeLessThanOrEqual(0.5);

    // The leading column carries the pending dot and must not squeeze the
    // invitation out: its title does not collapse to nothing, the dot sits
    // left of the title, and both stay inside the row.
    expect(invitationBox.width).toBeGreaterThan(0);
    const pendingBox = await rect(
      window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-pending`,
      ),
    );
    expect(pendingBox.right).toBeLessThanOrEqual(invitationBox.left);
    expect(pendingBox.left).toBeGreaterThanOrEqual(invitationRowBox.left);
    expect(invitationBox.right).toBeLessThanOrEqual(invitationRowBox.right);
    expect(pendingBox.top).toBeGreaterThanOrEqual(invitationRowBox.top);
    expect(pendingBox.bottom).toBeLessThanOrEqual(invitationRowBox.bottom);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

/**
 * CAN-3552. The "Shared with me" header must disclose the same way the
 * Projects and Hidden headers do: the expanded chevron is hidden at rest and
 * revealed by pointer hover or keyboard focus, both with the Projects hover
 * color; the collapsed chevron stays visible and points right. Hover and
 * keyboard focus run as separate cases, so a failure in one interaction cannot
 * prevent the other from running.
 */
for (const interaction of ['hover', 'keyboard focus']) {
  test(`reveals the Shared with me chevron on ${interaction} like Projects`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-shared-container-recipient-header-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      sharedContainerRecipientScenario(),
    );
    // Both fixture shares start unaccepted, so both are pending invitations.
    const invitationIds = [
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    ];

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: buildSharedContainerE2eEnv(
          userDataDir,
          SHARED_CONTAINER_RECIPIENT_FLAGS_ENV,
        ),
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectSharedContainersAccount(window);
      await app.openMainPage();

      const section = window.getByTestId('sidebar-section-shared-with-me');
      await expect(section).toBeVisible({ timeout: 30_000 });
      const toggle = window.getByTestId(
        'sidebar-section-shared-with-me-toggle',
      );
      const chevron = window.getByTestId('sidebar-shared-with-me-chevron');
      const label = toggle.getByText('Shared with you', { exact: true });
      const badge = window.getByTestId('sidebar-shared-with-me-pending-count');
      const invitations = invitationIds.map((id) =>
        window.getByTestId(`shared-container-invitation-${id}`),
      );
      const projectsToggle = window.getByTestId('sidebar-section-code-toggle');
      const projectsChevron = projectsToggle.getByTestId(
        'portal-workspaces-chevron',
      );
      const projectsLabel = projectsToggle
        .locator('span.whitespace-nowrap')
        .first();
      await expect(projectsToggle).toBeVisible();
      for (const invitation of invitations) {
        await expect(invitation).toBeVisible();
      }

      const style = (locator, property) =>
        locator.evaluate(
          (element, name) => getComputedStyle(element).getPropertyValue(name),
          property,
        );
      // A point right of the sidebar rail, derived from the section itself so
      // it does not depend on a viewport size Electron may not report.
      const parkPointer = async () => {
        const box = await section.boundingBox();
        if (!box) throw new Error('Shared with me section has no layout box');
        await window.mouse.move(
          box.x + box.width + 300,
          box.y + box.height / 2,
        );
      };
      const blurSection = () =>
        window.evaluate(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
        });
      const resetInteraction = async () => {
        await parkPointer();
        await blurSection();
        await expect
          .poll(() =>
            section.evaluate((element) =>
              element.contains(document.activeElement),
            ),
          )
          .toBe(false);
      };
      const expectExpandedRotation = () =>
        expect.poll(() => style(chevron, 'rotate')).toMatch(/^(none|0deg)$/);

      // Settled Projects hover colors are the reference. The color transition
      // finishes alongside the opacity one, so wait for full opacity first.
      await resetInteraction();
      await projectsLabel.hover();
      await expect.poll(() => style(projectsChevron, 'opacity')).toBe('1');
      const referenceChevronColor = await style(projectsChevron, 'color');
      const referenceLabelColor = await style(projectsLabel, 'color');
      await resetInteraction();

      await test.step('expanded at rest hides the chevron', async () => {
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(badge).toHaveText(String(invitationIds.length));
        // CAN-4052: the count is the sidebar's plain counter, not a filled
        // pill. It follows the chevron and ends at the header's right edge.
        await expect(badge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const [badgeBox, chevronBox, toggleBox] = await Promise.all(
          [badge, chevron, toggle].map((locator) => locator.boundingBox()),
        );
        if (!badgeBox || !chevronBox || !toggleBox) {
          throw new Error('Shared with you header has no layout box');
        }
        expect(badgeBox.x).toBeGreaterThanOrEqual(
          chevronBox.x + chevronBox.width,
        );
        expect(
          Math.abs(
            badgeBox.x + badgeBox.width - (toggleBox.x + toggleBox.width),
          ),
        ).toBeLessThanOrEqual(8);
        await expect.poll(() => style(chevron, 'opacity')).toBe('0');
      });

      if (interaction === 'hover') {
        await test.step('hover reveals the chevron in the Projects color', async () => {
          await toggle.hover();
          await expect(chevron).toHaveCSS('opacity', '1');
          await expectExpandedRotation();
          await expect
            .poll(() => style(chevron, 'color'))
            .toBe(referenceChevronColor);
          await expect
            .poll(() => style(label, 'color'))
            .toBe(referenceLabelColor);
          await parkPointer();
          await expect.poll(() => style(chevron, 'opacity')).toBe('0');
        });
      }

      if (interaction === 'keyboard focus') {
        await test.step('keyboard focus reveals the chevron in the Projects color', async () => {
          await resetInteraction();
          // Start from the Projects header and Tab forward until the Shared with
          // me toggle is focused; bounded so a broken tab order fails, not hangs.
          await projectsToggle.focus();
          let reached = false;
          for (let presses = 0; presses < 200 && !reached; presses += 1) {
            await window.keyboard.press('Tab');
            reached = await toggle.evaluate(
              (element) => element === document.activeElement,
            );
          }
          expect(reached).toBe(true);
          await expect(toggle).toBeFocused();
          await expect(chevron).toHaveCSS('opacity', '1');
          await expectExpandedRotation();
          await expect
            .poll(() => style(chevron, 'color'))
            .toBe(referenceChevronColor);
          await expect
            .poll(() => style(label, 'color'))
            .toBe(referenceLabelColor);
          await blurSection();
          await expect.poll(() => style(chevron, 'opacity')).toBe('0');
        });
      }

      await test.step('Enter collapses and Space expands', async () => {
        await toggle.focus();
        await window.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        for (const invitation of invitations) {
          await expect(invitation).not.toBeVisible();
        }
        await window.keyboard.press('Space');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        for (const invitation of invitations) {
          await expect(invitation).toBeVisible();
        }
      });

      await test.step('collapsed at rest keeps the chevron visible', async () => {
        await toggle.focus();
        await window.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        // Neither hover nor focus may be what makes it visible.
        await resetInteraction();
        await expect.poll(() => style(chevron, 'opacity')).toBe('1');
        await expect.poll(() => style(chevron, 'rotate')).toBe('-90deg');
        for (const invitation of invitations) {
          await expect(invitation).not.toBeVisible();
        }
        await expect(badge).toHaveText(String(invitationIds.length));
        await expect(badge).toHaveAttribute('role', 'status');
      });

      await test.step('clicking still toggles the section', async () => {
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        for (const invitation of invitations) {
          await expect(invitation).toBeVisible();
        }
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        for (const invitation of invitations) {
          await expect(invitation).toBeVisible();
        }
        await resetInteraction();
        await expect.poll(() => style(chevron, 'opacity')).toBe('0');
      });
    } finally {
      try {
        if (electronApp) await closeCanopy(electronApp, userDataDir);
      } finally {
        await clearScenario(
          DEFAULT_MOCK_BASE_URL,
          SHARED_CONTAINERS_CLOUD_API_KEY,
        ).catch(() => undefined);
      }
    }
  });
}

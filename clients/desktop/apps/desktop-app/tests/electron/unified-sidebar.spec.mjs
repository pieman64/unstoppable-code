import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { CanopyAppDriver, waitForStableBoundingBox } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setUiScale } from './uiScale.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedSidebarProjectList } from './seeders/seedSidebarProjectList.mjs';
import { seedChatsSectionFixture } from './seeders/seedChatsSectionFixture.mjs';
import {
  prepareWorkspaceBoundary,
  sampleWorkspaceBoundary,
} from './sticky-workspace-boundary.helpers.mjs';
import {
  expectBandOccludes,
  readBandMaterials,
} from './sidebar-band-material.helpers.mjs';

const STICKY_WORKSPACE_SLOT = '[data-testid="sidebar-sticky-workspace-slot"]';

// Coverage for the unified left sidebar introduced by the left-panel rework
// (T1–T8) and later blended with Cowork workspaces (Plan 5 Task 4): AppSidebar
// renders ONE unified workspace-list section — git workspaces via
// `ProjectSection` and Cowork workspaces via `SidebarCoworkWorkspaceRow` — plus
// the "More" popover, the account-row popover, the hide/show toggle, and the
// resize handle. Deterministic + offline (no live agents), following the
// seeded-state spec pattern from docs/ui-automation.md.

const WORKTREE_BRANCH = 'demo-main';

/**
 * The production default for the Labs page experiments (off until switched
 * on, CAN-3678). E2E builds pin them on; compact-viewport geometry tests use
 * the production nav height instead.
 */
const LABS_PAGES_OFFERED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-labs-overview-page': 'offered',
    'canopy-desktop-labs-kanban-page': 'offered',
    'canopy-desktop-labs-statistics-page': 'offered',
    'canopy-desktop-labs-audit-trail-page': 'offered',
  }),
};
const FIRST_CODE_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const SECOND_CODE_WORKSPACE_ID = 'demo-ts-npm-next';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Append a named, empty Cowork workspace to an already-seeded data dir.
 *
 * CAN-2363 moved the auto-created DEFAULT cowork workspace out of the Projects
 * list and into the top-level Chats section, so it is no longer available as a
 * header-only row for the sticky-projection scenarios below. A named cowork
 * workspace still renders in the list and reproduces exactly that shape.
 */
function seedListedCoworkWorkspace(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const indexPath = path.join(workspacesRoot, 'index.json');
  const createdAt = '2026-07-01T10:00:00.000Z';
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id: 'cowork-scratch',
    name: 'Scratch',
    type: 'cowork',
    color: '#7C9B6D',
    collapsed: false,
    order: index.workspaces.length,
  });
  writeJson(indexPath, index);
  writeJson(path.join(workspacesRoot, 'cowork-scratch', 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: { createdAt, archiveRetentionDays: null },
  });
}

function seedDefaultCoworkWorkspace(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const createdAt = '2026-07-01T10:00:00.000Z';

  writeJson(path.join(workspacesRoot, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'cowork-default',
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 6,
      },
    ],
  });
  writeJson(path.join(workspacesRoot, 'cowork-default', 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt,
      archiveRetentionDays: 7,
    },
    alwaysShow: true,
  });
}

function seedStickyCollapsedCoworkWorkspaces(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const createdAt = '2026-09-04T10:00:00.000Z';
  // CAN-2363: the default cowork workspace renders header-less inside the
  // Chats section, so this sticky-header fixture uses a named workspace.
  const firstWorkspaceId = 'cowork-aviary';
  const secondWorkspaceId = 'cowork-support';
  const entryId = 'entry-parrot';
  const trailingWorkspaceIds = Array.from(
    { length: 12 },
    (_, index) => `cowork-filler-${index + 1}`,
  );

  writeJson(path.join(workspacesRoot, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: firstWorkspaceId,
        name: 'Aviary',
        type: 'cowork',
        color: '#6750A4',
        collapsed: false,
        order: 0,
      },
      {
        id: secondWorkspaceId,
        name: 'Support',
        type: 'cowork',
        color: '#467A64',
        collapsed: true,
        order: 1,
      },
      ...trailingWorkspaceIds.map((id, index) => ({
        id,
        name: `Filler ${index + 1}`,
        type: 'cowork',
        color: '#62748A',
        collapsed: true,
        order: index + 2,
      })),
    ],
  });

  for (const workspaceId of [
    firstWorkspaceId,
    secondWorkspaceId,
    ...trailingWorkspaceIds,
  ]) {
    writeJson(path.join(workspacesRoot, workspaceId, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: {
        createdAt,
        archiveRetentionDays: null,
      },
    });
  }

  writeJson(path.join(workspacesRoot, firstWorkspaceId, 'work-entries.json'), {
    version: 1,
    entries: [{ id: entryId, createdAt }],
  });
  writeJson(
    path.join(workspacesRoot, firstWorkspaceId, 'chats', `${entryId}.json`),
    {
      version: 1,
      activeTabId: 'chat-parrot',
      tabs: [
        {
          id: 'chat-parrot',
          title: 'Parrot triage',
          description: 'Selected entry retained below a collapsed project',
          createdAt,
          kind: 'chat',
          messages: [
            buildMessage(
              'parrot-user-1',
              'user',
              'Investigate the sidebar collision.',
              Date.parse(createdAt),
            ),
          ],
        },
      ],
    },
  );

  return { firstWorkspaceId, secondWorkspaceId, entryId };
}

function buildMessage(id, role, text, timestamp) {
  return { id, role, blocks: [{ type: 'text', text }], timestamp };
}

async function installWorktreeScrollRecorder(window) {
  await window.evaluate(() => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    window.__canopyWorktreeScrollTargets = [];
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      const worktreeId = this.getAttribute?.('data-worktree-id');
      if (worktreeId) {
        window.__canopyWorktreeScrollTargets.push({
          projectId: this.getAttribute('data-project-id'),
          worktreeId,
          options,
        });
      }
      return originalScrollIntoView.call(this, options);
    };
  });
}

async function resetWorktreeScrollRecorder(window) {
  await window.evaluate(() => {
    window.__canopyWorktreeScrollTargets.length = 0;
  });
}

async function expectLastWorktreeScroll(window, projectId, options) {
  await expect
    .poll(() =>
      window.evaluate(() => window.__canopyWorktreeScrollTargets.at(-1)),
    )
    .toEqual({
      projectId,
      worktreeId: WORKTREE_BRANCH,
      options,
    });
}

async function normalizeSidebarScrollAfterStartup(viewport) {
  await viewport.evaluate(async (element) => {
    let previousScrollTop = element.scrollTop;
    let stableSince = performance.now();
    const deadline = stableSince + 5_000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const nextScrollTop = element.scrollTop;
      if (Math.abs(nextScrollTop - previousScrollTop) > 0.01) {
        stableSince = performance.now();
      }
      previousScrollTop = nextScrollTop;
      if (performance.now() - stableSince >= 1_000) {
        break;
      }
    }
    if (performance.now() - stableSince < 1_000) {
      throw new Error('Startup sidebar scroll did not settle');
    }
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

/**
 * Seeds two Cowork workspaces directly as unified `workspaces/index.json`
 * entries (`type: 'cowork'`), matching the post-migration layout: chat CRUD
 * now operates on the workspace index/config rather than the legacy
 * `standalone-chat/projects.json` tree (Plan 5 Task 1). The always-present
 * `cowork-default` home workspace is auto-provisioned by the app on first
 * `chatProjectList()` call, so it is NOT seeded here and shows up alongside
 * these two. Neither seeded workspace is the active one, so both sidebar rows
 * come from the persisted history via `standaloneChat.list` /
 * `sidebarChatsByProject`. Primary holds an active + an archived chat;
 * Secondary holds one active chat.
 */
function seedCoworkProjects(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const createdAt = '2026-05-01T12:00:00.000Z';

  writeJson(path.join(workspacesRoot, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'primary',
        name: 'Primary Project',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: true,
        order: 0,
      },
      {
        id: 'secondary',
        name: 'Secondary Project',
        type: 'cowork',
        color: '#6D8B9B',
        collapsed: true,
        order: 1,
      },
    ],
  });

  // Primary workspace (non-active) — one active chat + one archived chat.
  const primaryDir = path.join(workspacesRoot, 'primary');
  writeJson(path.join(primaryDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt,
      defaultModel: 'gpt-6-luna',
      searchIndexingEnabled: true,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(primaryDir, 'chats', 'home.json'), {
    version: 1,
    activeTabId: 'primary-active',
    tabs: [
      {
        id: 'primary-active',
        title: 'Primary Active Chat',
        description: 'Primary active conversation',
        createdAt,
        providerType: 'codex',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: [
          buildMessage(
            'p-user-1',
            'user',
            'Hello from the primary chat.',
            Date.parse('2026-05-01T12:01:00.000Z'),
          ),
        ],
      },
    ],
  });
  writeJson(
    path.join(primaryDir, 'chat-history', 'primary-active', 'meta.json'),
    {
      version: 1,
      id: 'primary-active',
      title: 'Primary Active Chat',
      description: 'Primary active conversation',
      createdAt,
      messageCount: 1,
      lastMessageAt: createdAt,
      providerType: 'codex',
      archived: false,
    },
  );
  writeJson(
    path.join(primaryDir, 'chat-history', 'primary-archived', 'meta.json'),
    {
      version: 1,
      id: 'primary-archived',
      title: 'Primary Archived Chat',
      description: 'Primary archived conversation',
      createdAt: '2026-04-30T12:00:00.000Z',
      messageCount: 1,
      lastMessageAt: '2026-04-30T12:05:00.000Z',
      providerType: 'claude',
      archived: true,
      archivedAt: '2026-04-30T12:10:00.000Z',
    },
  );

  // Secondary workspace (non-active) — one active chat, sourced from the
  // persisted history so the sidebar can list it without switching projects.
  const secondaryDir = path.join(workspacesRoot, 'secondary');
  writeJson(path.join(secondaryDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt,
      defaultModel: 'gpt-6-luna',
      searchIndexingEnabled: true,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(secondaryDir, 'chats', 'home.json'), {
    version: 1,
    activeTabId: 'secondary-active',
    tabs: [
      {
        id: 'secondary-active',
        title: 'Secondary Active Chat',
        description: 'Secondary active conversation',
        createdAt,
        providerType: 'codex',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: [
          buildMessage(
            's-user-1',
            'user',
            'Hello from the secondary chat.',
            Date.parse('2026-05-01T12:02:00.000Z'),
          ),
        ],
      },
    ],
  });
  writeJson(
    path.join(secondaryDir, 'chat-history', 'secondary-active', 'meta.json'),
    {
      version: 1,
      id: 'secondary-active',
      title: 'Secondary Active Chat',
      description: 'Secondary active conversation',
      createdAt,
      messageCount: 1,
      lastMessageAt: createdAt,
      providerType: 'codex',
      archived: false,
    },
  );
}

test.describe('unified sidebar', () => {
  for (const shared of [false, true]) {
    async function openLongProjectList(chatProjectNumber = 25) {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'sidebar-project-list-'),
      );
      const seeded = seedSidebarProjectList(userDataDir, 25, chatProjectNumber);
      const launch = await launchCanopy({ userDataDir });
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (shared) {
        await window.evaluate(() =>
          localStorage.setItem('canopy.desktop.sharedSidebar', '1'),
        );
        await window.reload();
        await app.waitForShell();
      }
      await app.openChatPage();
      await expect(
        window.getByTestId(
          shared ? 'portal-workspaces-header' : 'sidebar-section-code-toggle',
        ),
      ).toBeVisible();
      return { ...launch, window, app, ...seeded };
    }

    test(`newly created project stays visible beyond the project list limit (${shared ? 'shared' : 'desktop'})`, async () => {
      const launch = await openLongProjectList();
      try {
        const { window } = launch;
        const name = `Added project ${shared ? 'shared' : 'desktop'}`;
        await window
          .getByTestId(
            shared ? 'portal-workspaces-header' : 'sidebar-section-code-toggle',
          )
          .hover();
        const addProject = window.getByTestId('sidebar-section-code-add');
        await addProject.focus();
        await addProject.press('Enter');
        await window.getByTestId('add-workspace-mode-create').click();
        await window.getByTestId('add-workspace-type-single-repo').click();
        await window.getByLabel('Project name').fill(name);
        await window.getByTestId('add-workspace-create-submit').click();
        await expect(
          window.locator('[data-testid="home-surface"]:visible'),
        ).toContainText(name);
        // Creating a Code project selects the Home composer, not a worktree.
        // The new row must be mounted without expanding the intervening pages.
        await expect(
          window
            .getByTestId('app-sidebar')
            .getByText(name, { exact: true })
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
        await expect(
          window.getByTestId('sidebar-projects-show-more'),
        ).toContainText('15');
        // Exercise the real four-second highlight expiry while Home still
        // targets this project; retention must outlive the transient pulse.
        await window.waitForTimeout(4500);
        await expect(
          window
            .getByTestId('app-sidebar')
            .getByText(name, { exact: true })
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
        await expect(
          window.getByTestId('sidebar-projects-show-more'),
        ).toContainText('15');
      } finally {
        await closeCanopy(launch.electronApp, launch.userDataDir);
      }
    });

    test(`show more reveals ten omitted projects with a retained row in the next batch (${shared ? 'shared' : 'desktop'})`, async () => {
      const launch = await openLongProjectList(15);
      try {
        const { window, chatProjectId, entryId } = launch;
        const more = window.getByTestId('sidebar-projects-show-more');
        await more.click();
        await window
          .getByTestId(`sidebar-cowork-project-${chatProjectId}-toggle`)
          .click();
        await window.locator(`[data-standalone-chat-id="${entryId}"]`).click();
        await expect(
          window.getByText('Notes from the last project.', { exact: true }),
        ).toBeVisible();
        await window.getByTestId('sidebar-projects-show-less').click();
        const headers = window.locator(
          '[data-testid^="sidebar-cowork-project-project-list-"][data-testid$="-header"]',
        );
        await expect(headers).toHaveCount(11);
        await expect(more).toContainText('14');
        await more.click();
        await expect(headers).toHaveCount(21);
        await expect(more).toContainText('4');
        await more.click();
        await expect(headers).toHaveCount(25);
      } finally {
        await closeCanopy(launch.electronApp, launch.userDataDir);
      }
    });

    test(`long project list keeps distant chats reachable (${shared ? 'shared' : 'desktop'})`, async () => {
      const launch = await openLongProjectList();
      try {
        const { window, app, lastProjectId, entryId } = launch;
        // This workflow also runs on the unchanged implementation to establish
        // navigation coverage before changing how many rows are mounted.
        const more = window.getByTestId('sidebar-projects-show-more');
        while (await more.count()) await more.click();
        await window
          .getByTestId(`sidebar-cowork-project-${lastProjectId}-toggle`)
          .click();
        await window.locator(`[data-standalone-chat-id="${entryId}"]`).click();
        await app.expectChatPage();
        await expect(
          window.getByText('Notes from the last project.', { exact: true }),
        ).toBeVisible();
      } finally {
        await closeCanopy(launch.electronApp, launch.userDataDir);
      }
    });

    test(`project list reveals batches and retains the selection when shortened (${shared ? 'shared' : 'desktop'})`, async () => {
      const launch = await openLongProjectList();
      try {
        const { window, lastProjectId, entryId } = launch;
        const headers = window.locator(
          '[data-testid^="sidebar-cowork-project-project-list-"][data-testid$="-header"]',
        );
        await expect(headers).toHaveCount(10);
        const more = window.getByTestId('sidebar-projects-show-more');
        const less = window.getByTestId('sidebar-projects-show-less');
        await expect(more).toContainText('15');
        await more.focus();
        await window.keyboard.press('Enter');
        await expect(headers).toHaveCount(20);
        await expect(more).toContainText('5');
        await more.click();
        await expect(headers).toHaveCount(25);
        await expect(more).toHaveCount(0);
        await expect(less).toBeFocused();
        await window
          .getByTestId(`sidebar-cowork-project-${lastProjectId}-toggle`)
          .click();
        await window.locator(`[data-standalone-chat-id="${entryId}"]`).click();
        await expect(
          window.getByText('Notes from the last project.', { exact: true }),
        ).toBeVisible();
        await less.click();
        await expect(headers).toHaveCount(11);
        await expect(
          window.getByTestId(`sidebar-cowork-project-${lastProjectId}`),
        ).toBeVisible();
        await expect(more).toContainText('14');
        await expect(more).toBeFocused();
        await expect(
          window.getByText('Notes from the last project.', { exact: true }),
        ).toBeVisible();
      } finally {
        await closeCanopy(launch.electronApp, launch.userDataDir);
      }
    });
  }
  // 1) Toggle: hide (content goes full width), show again, and persistence.
  test('hides and shows the sidebar and persists the hidden state', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-unified-toggle-'),
    );

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const sidebar = window.getByTestId('app-sidebar');
      await expect(sidebar).toBeVisible();
      const shownWidth = (await sidebar.boundingBox())?.width ?? 0;
      expect(shownWidth).toBeGreaterThan(0);

      // Exactly one sidebar-toggle exists app-wide: it lives in the
      // persistent titlebar corner (the app root's LAST child, so its
      // no-drag rect wins the -webkit-app-region paint-order accumulation),
      // which is rendered in BOTH states at constant window coordinates.
      await expect(window.getByTestId('sidebar-toggle')).toHaveCount(1);
      const corner = window.getByTestId('app-titlebar-corner');
      await expect(corner).toBeVisible();
      const expandedCornerBox = await corner.boundingBox();
      expect(expandedCornerBox.x).toBe(0);
      expect(expandedCornerBox.y).toBe(0);

      // Record the toggle's position while expanded — the same corner element
      // holds it while hidden, so it stays truly stationary throughout the
      // width transition.
      const toggle = window.getByTestId('sidebar-toggle');
      const expandedToggleBox = await toggle.boundingBox();
      expect(expandedToggleBox).not.toBeNull();

      // The main content region should widen when the sidebar is hidden, and
      // the page content's top must NOT move (the inline corner shares the top
      // bar row rather than pushing content down).
      const main = window.locator('main').first();
      const widthWithSidebar = (await main.boundingBox())?.width ?? 0;
      // A fresh unseeded launch lands on the Home page now (startup MRU
      // routing), so measure the Home page root instead of the old Overview
      // default.
      const pageContent = window.getByTestId('page-home');
      const contentTopWithSidebar = (await pageContent.boundingBox())?.y ?? 0;

      // Hide via the sidebar toggle. The aside stays mounted and animates
      // to width 0 (~200ms), so assert invisibility (empty bounding box),
      // not absence from the DOM.
      await toggle.click();
      await expect(sidebar).toBeHidden();
      await expect
        .poll(async () => (await main.boundingBox())?.width ?? 0)
        .toBeGreaterThan(widthWithSidebar);

      // Still exactly one sidebar-toggle, at pixel-identical coordinates
      // (±1px) to the expanded state (locked position).
      await expect(window.getByTestId('sidebar-toggle')).toHaveCount(1);
      const hiddenToggleBox = await toggle.boundingBox();
      expect(hiddenToggleBox).not.toBeNull();
      expect(
        Math.abs(hiddenToggleBox.x - expandedToggleBox.x),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(hiddenToggleBox.y - expandedToggleBox.y),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(hiddenToggleBox.width - expandedToggleBox.width),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(hiddenToggleBox.height - expandedToggleBox.height),
      ).toBeLessThanOrEqual(1);

      // The persistent corner stays anchored at the window origin, is only
      // as wide as the corner (not a full-width strip), and did not move
      // relative to the expanded state. While hidden it grows by exactly one
      // control footprint (28px, TITLEBAR_TOGGLE_FOOTPRINT_PX) for the
      // icon-only New Task button plus the 4px gap that separates it from the
      // history-arrow control group.
      await expect(corner).toBeVisible();
      await expect
        .poll(
          async () =>
            Math.abs(
              ((await corner.boundingBox())?.width ?? 0) -
                (expandedCornerBox.width + 32),
            ),
          { timeout: 5_000 },
        )
        .toBeLessThanOrEqual(1);
      const hiddenCornerBox = await corner.boundingBox();
      expect(hiddenCornerBox.x).toBe(0);
      expect(hiddenCornerBox.y).toBe(0);
      expect(hiddenCornerBox.width).toBeLessThan(
        (await window.viewportSize())?.width ?? 0,
      );

      // The page content's top position is unchanged — the corner overlays
      // the top-left and the PageTitlebar spacer insets the page's top bar,
      // so nothing is pushed down.
      const contentTopHidden = (await pageContent.boundingBox())?.y ?? 0;
      expect(
        Math.abs(contentTopHidden - contentTopWithSidebar),
      ).toBeLessThanOrEqual(1);

      // Nothing inside the width-0 aside is keyboard-reachable: the inner
      // wrapper is `inert`, so its focusable controls are excluded from
      // the tab order while hidden.
      const asideHasFocusableReachable = await window.evaluate(() => {
        const aside = document.querySelector('[data-testid="app-sidebar"]');
        if (!aside) return false;
        for (const button of aside.querySelectorAll('button')) {
          button.focus();
          if (document.activeElement === button) return true;
        }
        return false;
      });
      expect(asideHasFocusableReachable).toBe(false);

      // Show it again — the persistent corner (and its toggle) remains.
      await window.getByTestId('sidebar-toggle').click();
      await expect(sidebar).toBeVisible();
      await expect(corner).toBeVisible();
      await expect(window.getByTestId('sidebar-toggle')).toHaveCount(1);

      // Hide once more, then relaunch and assert the hidden state persisted.
      await window.getByTestId('sidebar-toggle').click();
      await expect(sidebar).toBeHidden();
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = null;

      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window2 = await electronApp.firstWindow();
      await window2.waitForLoadState('domcontentloaded');
      // The inline corner toggle is present, but the aside stays hidden.
      await expect(window2.getByTestId('sidebar-toggle')).toHaveCount(1);
      await expect(window2.getByTestId('app-titlebar-corner')).toBeVisible();
      await expect(window2.getByTestId('app-sidebar')).toBeHidden();
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  // At a narrow sidebar, the docked titlebar's control at the end of the row
  // (Resources, or the activity bell) sits in the same seat as the collapsed
  // corner's New Task. Hiding and showing the sidebar must hand that seat over
  // at the sidebar's moving edge: never both icons drawn on top of each other,
  // never an empty seat while one waits for the other.
  for (const shared of [false, true]) {
    test(`hands the titlebar seat between the sidebar and New Task at the sidebar edge (${shared ? 'shared' : 'legacy'})`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-titlebar-seat-'),
      );
      let electronApp;
      try {
        ({ electronApp } = await launchCanopy({ userDataDir }));
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await window.evaluate(
          (value) =>
            localStorage.setItem('canopy.desktop.sharedSidebar', value),
          shared ? '1' : '0',
        );
        await window.reload();
        await app.waitForShell();

        const handle = window.getByTestId('sidebar-resize-handle');
        const handleBox = await handle.boundingBox();
        expect(handleBox).not.toBeNull();
        await window.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2,
        );
        await window.mouse.down();
        await window.mouse.move(0, handleBox.y + handleBox.height / 2);
        await window.mouse.up();
        await expect
          .poll(
            async () =>
              (await window.getByTestId('app-sidebar').boundingBox())?.width ??
              0,
          )
          .toBe(220);
        // Off the toggle, so no hover preview opens.
        await window.mouse.move(700, 500);

        const sampleToggle = () =>
          window.evaluate(
            () =>
              new Promise((resolve) => {
                const aside = document.querySelector(
                  '[data-testid="app-sidebar"]',
                );
                const seat = document.querySelector(
                  '[data-testid="titlebar-create-task-fade"]',
                );
                const row = document.querySelector(
                  '[data-testid="sidebar-titlebar"]',
                );
                const seatBox = seat.getBoundingClientRect();
                // The sidebar control sharing New Task's seat: whichever
                // titlebar button overlaps it most.
                let occupant = null;
                let best = 0;
                for (const button of row.querySelectorAll('button')) {
                  const b = button.getBoundingClientRect();
                  const overlap =
                    Math.min(b.right, seatBox.right) -
                    Math.max(b.left, seatBox.left);
                  if (overlap > best) {
                    best = overlap;
                    occupant = button;
                  }
                }
                const opacityChain = (element) => {
                  let value = 1;
                  for (let el = element; el; el = el.parentElement) {
                    value *= Number(getComputedStyle(el).opacity);
                  }
                  return value;
                };
                const sample = () => {
                  const edge = aside.getBoundingClientRect().right;
                  const s = seat.getBoundingClientRect();
                  const clip = getComputedStyle(seat).clipPath;
                  const inset = /^inset\(\S+ \S+ \S+ (-?[\d.]+)px/.exec(clip);
                  const seatClipLeft = inset ? Number(inset[1]) : 0;
                  const o = occupant.getBoundingClientRect();
                  return {
                    occupant: {
                      left: o.left,
                      right: Math.min(o.right, edge),
                      opacity: opacityChain(occupant),
                    },
                    seat: {
                      left: Math.max(s.left, s.left + seatClipLeft),
                      right: s.right,
                      opacity: opacityChain(seat),
                    },
                  };
                };
                const samples = [];
                const start = performance.now();
                document
                  .querySelector('[data-testid="sidebar-toggle"]')
                  .click();
                const frame = () => {
                  samples.push(sample());
                  if (performance.now() - start < 400) {
                    requestAnimationFrame(frame);
                  } else {
                    resolve({ overlapPx: best, samples });
                  }
                };
                requestAnimationFrame(frame);
              }),
          );

        const expectCleanHandover = ({ overlapPx, samples }, label) => {
          // Precondition: at the minimum width the two really share a seat.
          expect(overlapPx, `${label}: shared seat`).toBeGreaterThan(14);
          expect(samples.length, `${label}: sampled frames`).toBeGreaterThan(
            10,
          );
          const visible = (part) =>
            part.opacity > 0.5 && part.right - part.left > 0.5
              ? [part.left, part.right]
              : null;
          samples.forEach((sampleAt, index) => {
            const occupant = visible(sampleAt.occupant);
            const seat = visible(sampleAt.seat);
            // Drawn on top of each other: both visible over the same pixels.
            const doubled =
              occupant && seat
                ? Math.max(
                    0,
                    Math.min(occupant[1], seat[1]) -
                      Math.max(occupant[0], seat[0]),
                  )
                : 0;
            expect(
              doubled,
              `${label} frame ${index}: icons overlap`,
            ).toBeLessThanOrEqual(4);
            // An empty seat: neither icon is drawn.
            expect(
              occupant !== null || seat !== null,
              `${label} frame ${index}: seat is empty`,
            ).toBe(true);
          });
        };

        expectCleanHandover(await sampleToggle(), 'hide');
        await expect(window.getByTestId('app-sidebar')).toBeHidden();

        // Uncovered, the seat's clip must leave room for the shared focus
        // ring (2px outline at a 2px offset) on every side, so keyboard focus
        // on New Task stays visible.
        const createTask = window.getByTestId('titlebar-create-task');
        await createTask.focus();
        await expect(createTask).toBeFocused();
        await expect
          .poll(() =>
            createTask.evaluate((button) => {
              const seat = button.closest(
                '[data-testid="titlebar-create-task-fade"]',
              );
              return getComputedStyle(seat).clipPath;
            }),
          )
          .toBe('inset(-4px)');
        await window.mouse.move(700, 500);
        expectCleanHandover(await sampleToggle(), 'show');
        await expect(window.getByTestId('app-sidebar')).toBeVisible();
      } finally {
        if (electronApp) {
          await closeCanopy(electronApp, userDataDir);
        } else {
          rmSync(userDataDir, { recursive: true, force: true });
        }
      }
    });
  }

  // 2) Resize: drag the handle, assert width change + persistence across relaunch.
  test('resizes the sidebar via the drag handle and persists the width', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-unified-resize-'),
    );

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const sidebar = window.getByTestId('app-sidebar');
      const startWidth = (await sidebar.boundingBox())?.width ?? 0;
      // The clean test profile has no sidebarWidth preference, so the unified
      // sidebar must start at the 280px default. That default is deliberately
      // clear of the 220px minimum: it used to alias it, which opened every
      // new install at the narrowest supported width.
      expect(Math.abs(startWidth - 280)).toBeLessThanOrEqual(1);

      const handle = window.getByTestId('sidebar-resize-handle');
      const handleBox = await handle.boundingBox();
      expect(handleBox).not.toBeNull();

      // Drag the handle rightward to widen the sidebar.
      const targetX = 420;
      await window.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2,
      );
      await window.mouse.down();
      await window.mouse.move(targetX, handleBox.y + handleBox.height / 2, {
        steps: 12,
      });
      await window.mouse.up();

      await expect
        .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
        .toBeGreaterThan(startWidth + 40);
      const widenedWidth = (await sidebar.boundingBox())?.width ?? 0;

      // Persistence is debounced (~300ms); allow it to flush, then relaunch.
      await window.waitForTimeout(600);
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = null;

      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window2 = await electronApp.firstWindow();
      const app2 = new CanopyAppDriver(window2);
      await app2.waitForShell();
      const restoredWidth =
        (await window2.getByTestId('app-sidebar').boundingBox())?.width ?? 0;
      // Restored close to the widened width (allow a few px layout tolerance).
      expect(Math.abs(restoredWidth - widenedWidth)).toBeLessThanOrEqual(6);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  for (const shared of [false, true]) {
    for (const scale of [100, 125]) {
      test(`CAN-4402 navigation rolls up before Projects with expanded Chats (${shared ? 'shared' : 'legacy'}, ${scale}%)`, async () => {
        const userDataDir = mkdtempSync(
          path.join(os.tmpdir(), 'can-4402-more-'),
        );
        seedChatsSectionFixture(userDataDir, {
          chatEntryCount: 24,
          worktreeCount: 12,
        });
        const { electronApp } = await launchCanopy({
          userDataDir,
          env: LABS_PAGES_OFFERED_ENV,
          viewportSize: { width: 900, height: 560 },
        });
        try {
          const window = await electronApp.firstWindow();
          const app = new CanopyAppDriver(window);
          await app.waitForShell();
          await window.evaluate(async (shared) => {
            localStorage.setItem(
              'canopy.desktop.sharedSidebar',
              shared ? '1' : '0',
            );
            const prefs = await window.api.loadPreferences();
            await window.api.savePreferences({
              sidebarNavLayout: {
                order: prefs.sidebarNavLayout.order,
                moreStartIndex: prefs.sidebarNavLayout.order.length,
              },
            });
          }, shared);
          await window.reload();
          await app.waitForShell();
          if (scale !== 100) await setUiScale(window, scale);
          const viewport = window.getByTestId('sidebar-scroll-container');
          const more = window.getByTestId('sidebar-more');
          const menu = window.getByTestId('sidebar-more-menu');
          // locator.click() asks Chromium to scroll a sticky trigger into its
          // normal-flow position before pointerdown. Click its painted box to
          // reproduce a user's pointer without that automation-only scroll.
          const clickMore = async () => {
            const box = await more.boundingBox();
            if (!box) throw new Error('Missing painted More trigger');
            await window.mouse.click(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
          };

          await expect(more).toBeVisible();
          await clickMore();
          await expect(menu.locator('[role="menuitem"]')).toHaveText([
            'Dev pages',
            'Customize sidebar',
          ]);
          await window.keyboard.press('Escape');
          await expect(more).toBeFocused();
          await window
            .getByTestId('sidebar-cowork-project-cowork-default-show-all')
            .click();
          const geometry = await viewport.evaluate((element) => {
            const sentinel = element.querySelector(
              '[data-testid="sidebar-sticky-workspace-sentinel"]',
            );
            const chats = element.querySelector('[data-sidebar-chats-mask]');
            if (!sentinel || !chats)
              throw new Error('Missing navigation/Chats geometry');
            const boundary =
              sentinel.getBoundingClientRect().bottom -
              element.getBoundingClientRect().top +
              element.scrollTop -
              element.clientTop -
              1;
            return {
              boundary,
              chatsHeight: chats.getBoundingClientRect().height,
              maxScroll: element.scrollHeight - element.clientHeight,
              keys: Array.from(
                element.querySelectorAll('[data-testid^="sidebar-nav-"]'),
              ).map((row) => row.dataset.testid.replace('sidebar-nav-', '')),
            };
          });
          expect(geometry.chatsHeight).toBeGreaterThan(200);
          const intermediate = Math.ceil(geometry.boundary + 40);
          expect(geometry.maxScroll).toBeGreaterThan(
            intermediate + geometry.chatsHeight,
          );
          const scrollTo = async (top) => {
            await viewport.evaluate(async (element, top) => {
              element.scrollTop = top;
              element.dispatchEvent(new Event('scroll', { bubbles: true }));
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
            }, top);
          };
          await scrollTo(intermediate);
          await clickMore();
          await expect(menu).toBeVisible();
          const rolledKeys = await menu
            .locator('[data-testid^="sidebar-more-item-"]')
            .evaluateAll((items) =>
              items.map((item) =>
                item.dataset.testid.replace('sidebar-more-item-', ''),
              ),
            );
          expect(rolledKeys).toEqual([
            ...geometry.keys,
            'dev-pages',
            'customize',
          ]);
          expect(
            await viewport.evaluate((element) => element.scrollTop),
          ).toBeCloseTo(intermediate, 0);
          await window.keyboard.press('Escape');
          await expect(more).toBeFocused();
          // Every native-button and floating-menu keyboard opening path
          // snapshots the same current geometry without moving the rail.
          for (const key of ['Enter', 'Space', 'ArrowUp', 'ArrowDown']) {
            await more.press(key);
            await expect(menu).toBeVisible();
            await expect(
              window.getByTestId('sidebar-more-item-plugins'),
            ).toBeVisible();
            expect(
              Math.abs(
                (await viewport.evaluate((element) => element.scrollTop)) -
                  intermediate,
              ),
            ).toBeLessThanOrEqual(1);
            await window.keyboard.press('Escape');
            await expect(more).toBeFocused();
          }
          await more.press('ArrowDown');
          await expect(menu).toBeVisible();
          await scrollTo(
            Math.min(geometry.maxScroll, intermediate + geometry.chatsHeight),
          );
          await expect(menu).toBeVisible(); // Only the Projects boundary crossed.
          await scrollTo(Math.max(0, geometry.boundary - 2));
          await expect(menu).toBeHidden();
          await clickMore();
          await expect(menu.locator('[role="menuitem"]')).toHaveText([
            'Dev pages',
            'Customize sidebar',
          ]);
          await scrollTo(intermediate);
          await expect(menu).toBeHidden();
          await clickMore();
          const customizeScroll = await viewport.evaluate(
            (element) => element.scrollTop,
          );
          await window.getByTestId('sidebar-more-item-customize').click();
          await expect(
            window.getByTestId('customize-sidebar-modal'),
          ).toBeVisible();
          expect(
            Math.abs(
              (await viewport.evaluate((element) => element.scrollTop)) -
                customizeScroll,
            ),
          ).toBeLessThanOrEqual(1);
          await window.keyboard.press('Escape');
          await expect(
            window.getByTestId('customize-sidebar-modal'),
          ).toBeHidden();
          await expect(more).toBeFocused();
          expect(
            Math.abs(
              (await viewport.evaluate((element) => element.scrollTop)) -
                customizeScroll,
            ),
          ).toBeLessThanOrEqual(1);
          await clickMore();
          const before = await viewport.evaluate((element) => {
            element.dataset.can4402Mounted = 'yes';
            return element.scrollTop;
          });
          await window.getByTestId('sidebar-more-item-plugins').click();
          await app.expectPluginsPage();
          await expect(menu).toBeHidden();
          await expect(viewport).toHaveAttribute('data-can4402-mounted', 'yes');
          // Chromium can round a restored CSS scroll coordinate by one pixel.
          expect(
            Math.abs(
              (await viewport.evaluate((element) => element.scrollTop)) -
                before,
            ),
          ).toBeLessThanOrEqual(1);
          await scrollTo(0);
          await clickMore();
          await expect(menu.locator('[role="menuitem"]')).toHaveText([
            'Dev pages',
            'Customize sidebar',
          ]);
          // A live eligibility update closes a keyboard-focused menu. Keep focus
          // on the mounted trigger instead of dropping it to the document.
          await menu.getByRole('menuitem').first().focus();
          await window.evaluate(async () => {
            await window.api.experiments.setChoice({
              experimentId: 'overview-page',
              enabled: true,
            });
          });
          await expect(menu).toBeHidden();
          await expect(more).toBeFocused();
        } finally {
          await closeCanopy(electronApp, userDataDir);
        }
      });
    }

    test(`CAN-4402 production Customize-only More (${shared ? 'shared' : 'legacy'})`, async ({}, testInfo) => {
      // Leave room for production startup and the launcher's owned teardown;
      // the regular 60s case budget can interrupt bootstrap cleanup.
      test.setTimeout(120_000);
      test.skip(
        process.env.CAN4402_PRODUCTION !== '1',
        'Explicit production runner: see docs/ui-automation.md, CAN-4402.',
      );
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'can-4402-production-'),
      );
      seedChatsSectionFixture(userDataDir);
      const { electronApp } = await launchCanopy({
        userDataDir,
        buildKind: 'production',
        productionWindowMode: 'headless',
        // Launch diagnostics belong to this test run, alongside other artifacts.
        productionAdapterArchivePath: testInfo.outputPath(
          'production.adapter.cjs',
        ),
      });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await window.evaluate(async (shared) => {
          localStorage.setItem(
            'canopy.desktop.sharedSidebar',
            shared ? '1' : '0',
          );
          const prefs = await window.api.loadPreferences();
          await window.api.savePreferences({
            sidebarNavLayout: {
              order: prefs.sidebarNavLayout.order,
              moreStartIndex: prefs.sidebarNavLayout.order.length,
            },
          });
        }, shared);
        await window.reload();
        await app.waitForShell();
        await window.getByTestId('sidebar-more').click();
        const menu = window.getByTestId('sidebar-more-menu');
        await expect(
          window.getByTestId('sidebar-more-item-dev-pages'),
        ).toHaveCount(0);
        await expect(menu.locator('[role="menuitem"]')).toHaveText([
          'Customize sidebar',
        ]);
        await expect(menu.locator('[role="separator"]')).toHaveCount(0);
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  // 3) More menu: Environments absent, the Labs pages in main nav (CAN-3678);
  //    Kanban opens alongside the unified sidebar;
  //    explicit sidebar toggles still work; and visiting Kanban does not alter
  //    the persisted sidebar preference.
  test('More menu lists items, opens Kanban beside the sidebar, and preserves sidebar preference', async () => {
    const launched = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });
    const { userDataDir } = launched;
    let electronApp = launched.electronApp;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // E2E builds pin the Labs page experiments on, so their rows sit in
      // main nav; Dev pages and Customize remain in the default More menu.
      for (const item of ['overview', 'kanban', 'statistics']) {
        await expect(window.getByTestId(`sidebar-nav-${item}`)).toBeVisible();
      }
      await window.getByTestId('sidebar-more').click();
      const moreMenu = window.getByTestId('sidebar-more-menu');
      await expect(moreMenu).toBeVisible();
      // CAN-4269: Environments moved into Settings → Environments.
      await expect(
        window.getByTestId('sidebar-more-item-environments'),
      ).toHaveCount(0);
      // CAN-3659: Remote Control opens from the account menu, so neither the
      // More menu nor the nav lists it.
      await expect(
        window.getByTestId('sidebar-more-item-remote-control'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-nav-remote-control'),
      ).toHaveCount(0);

      // Kanban opens beside the unified sidebar.
      await window.keyboard.press('Escape');
      await window.getByTestId('sidebar-nav-kanban').click();
      await expect(window.getByTestId('worktree-panel')).toBeVisible();
      await expect(window.getByTestId('worktree-kanban-board')).toBeVisible();
      await expect(window.getByTestId('app-sidebar')).toBeVisible();

      // Explicitly hiding and showing the sidebar still works on Kanban.
      await window.getByTestId('sidebar-toggle').click();
      await expect(window.getByTestId('app-sidebar')).toBeHidden();
      await window.getByTestId('sidebar-toggle').click();
      await expect(window.getByTestId('app-sidebar')).toBeVisible();

      // Clicking a sidebar nav item exits Kanban and keeps the sidebar visible.
      await app.openPipelinesPage();
      await expect(window.getByTestId('worktree-kanban-board')).toHaveCount(0);
      await expect(window.getByTestId('app-sidebar')).toBeVisible();

      // Re-enter and exit via the global main-page shortcut.
      await app.openKanbanPage();
      await expect(window.getByTestId('app-sidebar')).toBeVisible();
      await app.openMainPage();
      await expect(window.getByTestId('worktree-kanban-board')).toHaveCount(0);
      await expect(window.getByTestId('app-sidebar')).toBeVisible();

      // Quit while Kanban is open. A relaunch must retain the visible sidebar
      // preference; page navigation must not mutate it.
      await app.openKanbanPage();
      await expect(window.getByTestId('app-sidebar')).toBeVisible();
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = null;

      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window2 = await electronApp.firstWindow();
      const app2 = new CanopyAppDriver(window2);
      await app2.waitForShell({ timeout: 30_000 });
      await expect(window2.getByTestId('app-sidebar')).toBeVisible();
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  // CAN-4269: a saved layout that pinned Environments in the main region
  // renders without it and keeps the other items in order and on their side
  // of the More divider.
  test('drops a saved Environments nav item and keeps the rest of the layout', async () => {
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.evaluate(async () => {
        await window.api.savePreferences({
          sidebarNavLayout: {
            order: [
              'app-advisor',
              'workflows',
              'environments',
              'overview',
              'plugins',
              'feed',
              'remote-control',
              'kanban',
              'agents',
              'statistics',
              'audit',
              'workers',
            ],
            moreStartIndex: 4,
          },
        });
      });
      await window.reload();
      await app.waitForShell();

      await expect(window.getByTestId('sidebar-nav-environments')).toHaveCount(
        0,
      );
      const workflows = window.getByTestId('sidebar-nav-workflows');
      const overview = window.getByTestId('sidebar-nav-overview');
      await expect(workflows).toBeVisible();
      await expect(overview).toBeVisible();
      const workflowsBox = await workflows.boundingBox();
      const overviewBox = await overview.boundingBox();
      expect(workflowsBox).not.toBeNull();
      expect(overviewBox).not.toBeNull();
      expect(overviewBox.y).toBeGreaterThan(workflowsBox.y);

      await window.getByTestId('sidebar-more').click();
      await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
      await expect(
        window.getByTestId('sidebar-more-item-plugins'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-more-item-environments'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-more-item-overview'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // 4) Section header: the unified workspace-list header hover reveals add +
  //    the one overflow menu; section collapse persists. (Cowork projects blend into this
  //    same section as of Plan 5 Task 4 — there is no separate Cowork header
  //    anymore; per-project hover actions for Cowork rows live on
  //    `SidebarCoworkWorkspaceRow` itself, covered by test 6 below.)
  test('section header reveals hover actions and persists collapse state', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-unified-sections-'),
    );

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        seedDemoWorkspaces: true,
        demoWorkspaceApps: ['ts-pnpm-vite'],
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const codeSection = window.getByTestId('sidebar-section-code');
      await expect(codeSection).toBeVisible();

      // Hovering the Code Workspaces header reveals the add-workspace control
      // and the single overflow menu that carries ordering and project
      // visibility (the second "…" beside it is gone).
      await window.getByTestId('sidebar-section-code-toggle').hover();
      const addWorkspace = window.getByTestId('sidebar-section-code-add');
      await expect(addWorkspace).toBeVisible();
      await expect(
        window.getByTestId('sidebar-section-code-more'),
      ).toBeVisible();
      await expect(window.getByTestId('worktree-filter-trigger')).toHaveCount(
        0,
      );

      // The unified add-workspace control is also the reachable entry point
      // for creating a new Cowork project (Plan 5's sidebar blend removed
      // the old dedicated "sidebar-section-cowork-add" control). Open the
      // modal, switch to "Create new" mode, and confirm the Cowork type
      // option is present, then close without submitting.
      //
      // Keep the hover assertion above focused on the reveal contract, then
      // use the same control's keyboard path to open the modal. Late sidebar
      // hydration can move the sticky header while Playwright is positioning
      // a second pointer action, making the CSS-revealed wrapper briefly stop
      // receiving pointer events even though the control already proved
      // visible. Focus-within is an intentional reveal path for this control
      // and Enter exercises the same onClick handler without that pointer race.
      await addWorkspace.focus();
      await expect(addWorkspace).toBeFocused();
      await addWorkspace.press('Enter');
      await window.getByTestId('add-workspace-mode-create').click();
      await window.getByTestId('add-workspace-type-cowork').click();
      await expect(
        window.getByTestId('add-workspace-create-submit'),
      ).toBeVisible();
      await expect(
        window.getByTestId('add-workspace-create-submit'),
      ).toContainText(/Create Cowork project/i);
      await window.getByRole('button', { name: 'Close' }).click();

      // Right-clicking a project row opens its actions. Every command row in
      // that menu leads with a glyph; the ordering radios below the "Sort
      // tasks by" label use the selection check on that same rail instead.
      const projectHeader = window.locator(
        `[data-sidebar-workspace-id="${FIRST_CODE_WORKSPACE_ID}"] [data-testid^="sidebar-project-header-"]`,
      );
      await projectHeader.click({ button: 'right' });
      const projectMenu = window
        .getByTestId('workspace-session-context-menu')
        .first();
      await expect(projectMenu).toBeVisible();
      const commandRows = projectMenu.locator('[role="menuitem"]');
      const commandRowCount = await commandRows.count();
      expect(commandRowCount).toBeGreaterThan(0);
      // Pin leads every sidebar item menu, with one wording across row types.
      await expect(commandRows.first()).toHaveAttribute(
        'data-testid',
        'workspace-toggle-pin-menu-item',
      );
      await expect(commandRows.first()).toContainText('Pin to top');
      for (let index = 0; index < commandRowCount; index += 1) {
        await expect(commandRows.nth(index).locator('svg')).not.toHaveCount(0);
      }
      await window.keyboard.press('Escape');
      await expect(projectMenu).toHaveCount(0);

      // Collapse the unified workspace-list section; the rows disappear.
      const codeToggle = window.getByTestId('sidebar-section-code-toggle');
      await expect(codeToggle).toHaveAttribute('aria-expanded', 'true');
      await codeToggle.click();
      await expect(codeToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        ),
      ).toHaveCount(0);

      // Persistence: relaunch and confirm the section is still collapsed.
      await window.waitForTimeout(300);
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = null;

      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window2 = await electronApp.firstWindow();
      const app2 = new CanopyAppDriver(window2);
      await app2.waitForShell({ timeout: 30_000 });
      await expect(
        window2.getByTestId('sidebar-section-code-toggle'),
      ).toHaveAttribute('aria-expanded', 'false');
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  test('keeps task, search, and contextual More reachable while projects scroll', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-sidebar-reachable-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: [
        'ts-pnpm-vite',
        'ts-npm-next',
        'ts-bun-api',
        'ts-yarn-cli',
        'go-cli',
      ],
    });
    seedListedCoworkWorkspace(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 900, height: 340 },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Put the fresh empty Cowork workspace immediately before the final
      // seeded workspace, matching the reported Scratch -> canopy ordering
      // while keeping enough preceding content to reproduce deep scrolling.
      await window.evaluate(async () => {
        const loaded = await window.api.loadProjects();
        const ordered = [...loaded.items].sort((a, b) => a.order - b.order);
        const defaultIndex = ordered.findIndex(
          (item) => item.type === 'cowork' && item.name === 'Scratch',
        );
        if (defaultIndex < 0 || ordered.length < 2) {
          throw new Error('Expected Scratch and a seeded project');
        }
        const [defaultWorkspace] = ordered.splice(defaultIndex, 1);
        // Place it immediately before the last LISTED project. The default
        // cowork workspace is also in this data but renders in the Chats
        // section (CAN-2363), so splicing before the last item overall would
        // leave no following project to hand the sticky seat to.
        const lastListedIndex = ordered.reduce(
          (last, item, index) => (item.type === 'cowork' ? last : index),
          -1,
        );
        if (lastListedIndex < 0) {
          throw new Error('Expected a listed project');
        }
        ordered.splice(lastListedIndex, 0, defaultWorkspace);
        await window.api.saveProjects(
          ordered.map((item, order) => ({ ...item, order })),
          { replaceWorkspaceOrder: true },
        );
      });
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });

      const viewport = window.getByTestId('sidebar-scroll-container');
      const scrollbarThumb = window.locator(
        '[data-testid="app-sidebar"] [data-sidebar-scrollbar-thumb]',
      );
      const stickyHeader = viewport.locator('.sidebar-sticky-header');
      const stickyMore = viewport.getByTestId('sidebar-more-sticky-container');
      const firstWorkspace = viewport
        .locator('[data-workspace-expanded]')
        .first();
      const emptyDefaultWorkspace = viewport
        .locator('[data-workspace-expanded]')
        .filter({ hasText: 'Scratch' })
        .first();
      const emptyDefaultHeader = emptyDefaultWorkspace.locator(
        '.sidebar-workspace-sticky-header',
      );
      // The last row overall is the default Cowork workspace inside the Chats
      // section, which has no in-flow header (CAN-2363); the "following"
      // workspace here must be the last one in the Projects list.
      const followingWorkspace = viewport
        .locator(
          '[data-testid="sidebar-workspaces-list"] [data-workspace-expanded]',
        )
        .last();
      const followingWorkspaceHeader = followingWorkspace.locator(
        '.sidebar-workspace-sticky-header',
      );
      await expect(stickyHeader).toBeVisible();
      // Five seeded projects plus the listed Cowork workspace. The default
      // Cowork workspace renders in the Chats section above the list and is
      // deliberately not a workspace row (CAN-2363).
      await expect(viewport.locator('[data-workspace-expanded]')).toHaveCount(
        6,
      );
      await expect(viewport.getByTestId('worktree-row')).toHaveCount(5);
      await expect(firstWorkspace).toBeVisible();
      await expect(emptyDefaultWorkspace).toHaveAttribute(
        'data-workspace-expanded',
        'true',
      );
      await expect(
        emptyDefaultWorkspace.locator(
          '[data-sidebar-folder-content="cowork-workspace"]',
        ),
      ).toHaveCount(0);
      await expect(followingWorkspaceHeader).toHaveCount(1);
      await expect(
        viewport.locator('.sidebar-workspaces-rows-clip'),
      ).toBeAttached();

      // Workspace selection restoration may initially scroll the compact
      // sidebar to the selected row. Normalize to the real unscrolled layout
      // before checking the ordinary More menu.
      await normalizeSidebarScrollAfterStartup(viewport);
      const normalWorkspaceGap = await viewport.evaluate((element) => {
        const label = element.querySelector(
          '[data-onboarding-anchor="sidebar-workspaces"] > span',
        );
        const firstWorkspace = element.querySelector(
          '[data-workspace-expanded]',
        );
        if (
          !(label instanceof HTMLElement) ||
          !(firstWorkspace instanceof HTMLElement)
        ) {
          throw new Error('Expected Projects label and first project');
        }
        return (
          firstWorkspace.getBoundingClientRect().top -
          label.getBoundingClientRect().bottom
        );
      });
      expect(Math.abs(normalWorkspaceGap - 4)).toBeLessThanOrEqual(0.01);
      // The ordinary, unscrolled menu stays unchanged.
      await window.getByTestId('sidebar-more').click();
      await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
      await expect(
        window.getByTestId('sidebar-more-workspace-divider'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('sidebar-more-menu')).toBeHidden();

      // CAN-2675: expanded Scratch now has only its header, with no body
      // rows. Pin that short workspace at the sticky line while the following
      // workspace approaches; the slot/divider occlusion checks still apply.
      await emptyDefaultHeader.evaluate(async (header) => {
        const viewportElement = header.closest(
          '[data-testid="sidebar-scroll-container"]',
        );
        if (!(viewportElement instanceof HTMLElement)) {
          throw new Error('Expected sidebar scroll container');
        }
        const workspaceHeaderTop = Number.parseFloat(
          viewportElement.style.getPropertyValue(
            '--sidebar-workspace-header-top',
          ),
        );
        if (!Number.isFinite(workspaceHeaderTop)) {
          throw new Error('Expected measured workspace-header sticky offset');
        }
        const stickyLine =
          viewportElement.getBoundingClientRect().top + workspaceHeaderTop;
        viewportElement.scrollTop +=
          header.getBoundingClientRect().top - stickyLine;
        viewportElement.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      await expect(window.getByTestId('sidebar-create-task')).toBeVisible();
      await expect(window.getByTestId('sidebar-search')).toBeVisible();
      await expect
        .poll(() =>
          viewport.evaluate((element) => {
            const group = element.querySelector(
              '[data-testid="sidebar-more-sticky-container"]',
            );
            const slot = element.querySelector(
              '[data-testid="sidebar-sticky-workspace-slot"]',
            );
            const activeRow = slot?.querySelector(
              '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
            );
            if (
              !(group instanceof HTMLElement) ||
              !(slot instanceof HTMLElement) ||
              !(activeRow instanceof HTMLElement)
            ) {
              return {
                activeDefault: false,
                groupTopAligned: false,
              };
            }
            return {
              activeDefault:
                activeRow.textContent?.includes('Scratch') ?? false,
              // Header-only Scratch hands directly to the following
              // workspace. The rule must not be drawn THROUGH either
              // projected copy while it is visible; it used to satisfy that
              // by fading out, because it sat 8px below the band and landed
              // inside the approaching header. It is drawn on the band's own
              // bottom edge now, so the headers simply pass beneath it.
              groupTopAligned:
                Math.abs(
                  group.getBoundingClientRect().top -
                    element.getBoundingClientRect().top -
                    1 -
                    (Number.parseFloat(
                      getComputedStyle(element).getPropertyValue(
                        '--sidebar-more-height',
                      ),
                    ) || 0) -
                    (Number.parseFloat(
                      getComputedStyle(element).getPropertyValue(
                        '--sidebar-chats-header-height',
                      ),
                    ) || 0),
                ) <= 1,
            };
          }),
        )
        .toEqual({
          activeDefault: true,
          groupTopAligned: true,
        });

      const moreBox = await stickyMore.boundingBox();
      const headerBox = await stickyHeader.boundingBox();
      const viewportBox = await viewport.boundingBox();
      expect(moreBox).not.toBeNull();
      expect(headerBox).not.toBeNull();
      expect(viewportBox).not.toBeNull();
      // CAN-2363: the band stacks directly beneath the pinned Chats header,
      // which itself sits under the pinned More row. Measure that contract
      // live rather than recomputing it from the published vars.
      await expect
        .poll(() =>
          viewport.evaluate((element) => {
            const band = element.querySelector(
              '[data-testid="sidebar-more-sticky-container"]',
            );
            const chats = element.querySelector('[data-sidebar-chats-header]');
            if (!(band instanceof HTMLElement)) return null;
            if (!(chats instanceof HTMLElement)) {
              return Math.round(
                Math.abs(
                  band.getBoundingClientRect().top -
                    element.getBoundingClientRect().top -
                    1,
                ),
              );
            }
            return Math.round(
              Math.abs(
                band.getBoundingClientRect().top -
                  chats.getBoundingClientRect().bottom,
              ),
            );
          }),
        )
        .toBeLessThanOrEqual(1);
      // CAN-2363: More is pinned above the band rather than inside it, so the
      // Projects header now sits just the 12px gap below the band's top.
      expect(Math.abs(headerBox.y - moreBox.y - 12)).toBeLessThanOrEqual(1);
      const occlusionState = await viewport.evaluate((element) => {
        const group = element.querySelector(
          '[data-testid="sidebar-more-sticky-container"]',
        );
        const label = element.querySelector(
          '[data-onboarding-anchor="sidebar-workspaces"] > span',
        );
        const slot = element.querySelector(
          '[data-testid="sidebar-sticky-workspace-slot"]',
        );
        const flow = element.querySelector('.sidebar-workspaces-rows-clip');
        const activeWorkspaceId =
          slot instanceof HTMLElement
            ? slot.dataset.activeWorkspaceId
            : undefined;
        const activeWorkspace = Array.from(
          element.querySelectorAll('[data-sidebar-workspace-id]'),
        ).find(
          (candidate) =>
            candidate instanceof HTMLElement &&
            candidate.dataset.sidebarWorkspaceId === activeWorkspaceId,
        );
        const activeWorkspaceHeader = activeWorkspace?.querySelector(
          '.sidebar-workspace-sticky-header',
        );
        const activeWorkspaceRows = activeWorkspaceHeader?.nextElementSibling;
        const activeSlotRow = slot?.querySelector(
          '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
        );
        if (
          !(group instanceof HTMLElement) ||
          !(label instanceof HTMLElement) ||
          !(slot instanceof HTMLElement) ||
          !(flow instanceof HTMLElement) ||
          !(activeSlotRow instanceof HTMLElement) ||
          !(activeWorkspaceHeader instanceof HTMLElement)
        ) {
          throw new Error(
            'Expected fixed project slot, structural flow, and active project header',
          );
        }
        const groupRect = group.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const slotRect = slot.getBoundingClientRect();
        const flowRect = flow.getBoundingClientRect();
        const flowClipInset = Number.parseFloat(
          getComputedStyle(flow).clipPath.match(/^inset\(([-\d.]+)px/)?.[1] ??
            '0',
        );
        return {
          activeWorkspaceId,
          activeSlotRowCount: slot.querySelectorAll(
            '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
          ).length,
          maskBoundary: flowRect.top + flowClipInset,
          groupBottom: groupRect.bottom,
          activeWorkspaceBodyHeight:
            activeWorkspaceRows?.getBoundingClientRect().height ?? 0,
          activeWorkspaceBodyCount: activeWorkspace.querySelectorAll(
            '[data-sidebar-folder-content="cowork-workspace"]',
          ).length,
          activeWorkspaceText: activeSlotRow.textContent ?? '',
          slotPosition: getComputedStyle(slot).position,
          slotTransform: getComputedStyle(slot).transform,
          slotHeight: slotRect.height,
          workspaceGap: slotRect.top - labelRect.bottom,
        };
      });
      expect(
        Math.abs(occlusionState.workspaceGap - normalWorkspaceGap),
      ).toBeLessThanOrEqual(0.01);
      expect(occlusionState.activeWorkspaceText).toContain('Scratch');
      expect(occlusionState.activeWorkspaceBodyCount).toBe(0);
      expect(occlusionState.activeWorkspaceBodyHeight).toBe(0);
      expect(occlusionState.activeSlotRowCount).toBe(2);
      // CAN-3126: the band occludes rather than inheriting the window
      // material, so rows pass UNDER it instead of rendering through it and
      // depending on the clip alone. Read on the shared rail (the default)
      // with every appearance pinned, so the result is not the host's.
      await expect(
        window.getByTestId('portal-workspaces-header'),
      ).toBeVisible();
      expectBandOccludes(
        await readBandMaterials(window, STICKY_WORKSPACE_SLOT),
      );
      expect(occlusionState.slotPosition).toBe('absolute');
      expect(occlusionState.slotTransform).toBe('none');
      expect(Math.abs(occlusionState.slotHeight - 32)).toBeLessThanOrEqual(
        0.01,
      );

      // Dedicated-slot threshold, adjacent-frame, and large-delta coverage
      // lives in the focused structural-flow regression immediately below.

      // Both sticky controls stay fixed while the real workspace rows move.
      const beforeMoreTop = moreBox.y;
      const beforeHeaderTop = headerBox.y;
      const beforeRowTop = await firstWorkspace.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await viewport.evaluate((element) => {
        element.scrollTop += 8;
      });
      const whileStickyMoreTop = await stickyMore.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      const whileStickyHeaderTop = await stickyHeader.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      const whileScrollingRowTop = await firstWorkspace.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      expect(Math.abs(whileStickyMoreTop - beforeMoreTop)).toBeLessThanOrEqual(
        1,
      );
      expect(
        Math.abs(whileStickyHeaderTop - beforeHeaderTop),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(whileScrollingRowTop - beforeRowTop + 8),
      ).toBeLessThanOrEqual(1);

      // Opening the menu and returning focus on Escape can scroll the rail,
      // which hands the sticky seat to another project. The steps after the
      // menu are written for the seat this scroll position holds (Scratch is
      // body-less while empty), so record it here and restore it afterwards.
      const seatSlot = viewport.getByTestId('sidebar-sticky-workspace-slot');
      const scrollTopBeforeMenu = await viewport.evaluate(
        (element) => element.scrollTop,
      );
      const seatBeforeMenu = await seatSlot.getAttribute(
        'data-active-workspace-id',
      );
      expect(seatBeforeMenu).not.toBeNull();

      // Sticky More exposes primary workspace destinations first, then the
      // divider and the regular/default More actions.
      await window.getByTestId('sidebar-more').click();
      const stickyMenu = window.getByTestId('sidebar-more-menu');
      // `evaluateAll` does not retry, so gate the one-shot row-order read on
      // the menu being mounted with its contextual rows: wait for the menu
      // AND the workspace divider (the last contextual row group) before
      // reading, or an immediate read can catch the popover mid-mount and
      // see no rows at all.
      await expect(stickyMenu).toBeVisible();
      await expect(
        stickyMenu.getByTestId('sidebar-more-workspace-divider'),
      ).toBeAttached();
      // FloatingMenu keeps rows inside OverlayScrollArea's content wrapper;
      // inspect that real content instead of the viewport's wrapper itself.
      const menuTestIds = await stickyMenu
        .locator(
          '[data-floating-menu-scroll-viewport="true"] [data-overlay-scroll-content] > *',
        )
        .evaluateAll((children) =>
          children.map((child) => child.dataset.testid ?? null),
        );
      const dividerIndex = menuTestIds.indexOf(
        'sidebar-more-workspace-divider',
      );
      expect(dividerIndex).toBeGreaterThan(0);
      expect(
        menuTestIds.indexOf('sidebar-more-item-customize'),
      ).toBeGreaterThan(dividerIndex);
      // CAN-3980 merged Automations and Pipelines into one Workflows item,
      // and CAN-3659 moved Remote Control to the account menu, so the sticky
      // More menu starts with these three primary destinations. It mirrors
      // every main-nav row before the divider, including the Labs pages E2E
      // builds pin on (CAN-3678).
      const primaryTestIds = [
        'sidebar-more-item-app-advisor',
        'sidebar-more-item-workflows',
        'sidebar-more-item-plugins',
      ];
      expect(
        primaryTestIds.map((testId) => menuTestIds.indexOf(testId)),
      ).toEqual([0, 1, 2]);
      expect(menuTestIds).not.toContain('sidebar-more-item-remote-control');
      expect(menuTestIds).not.toContain('sidebar-more-item-automations');
      expect(menuTestIds).not.toContain('sidebar-more-item-pipelines');
      expect(dividerIndex).toBe(
        await window
          .locator('[data-testid="sidebar-main-nav"] [data-sidebar-nav-row]')
          .count(),
      );
      await window.keyboard.press('Escape');
      await expect(stickyMenu).toBeHidden();
      await viewport.evaluate((element, scrollTop) => {
        element.scrollTop = scrollTop;
      }, scrollTopBeforeMenu);
      await expect
        .poll(async () =>
          Math.abs(
            (await viewport.evaluate((element) => element.scrollTop)) -
              scrollTopBeforeMenu,
          ),
        )
        .toBeLessThanOrEqual(1);
      await expect(seatSlot).toHaveAttribute(
        'data-active-workspace-id',
        seatBeforeMenu,
      );

      // The dedicated copy preserves the active workspace's actions. Clicking
      // its disclosure updates the real in-flow workspace on the first press.
      const activeSlot = viewport.getByTestId('sidebar-sticky-workspace-slot');
      const activeWorkspaceId = await activeSlot.getAttribute(
        'data-active-workspace-id',
      );
      expect(activeWorkspaceId).not.toBeNull();
      const activeFlowWorkspace = viewport.locator(
        `[data-sidebar-workspace-id="${activeWorkspaceId}"]`,
      );
      const activeSlotRow = activeSlot.locator(
        `[data-sidebar-sticky-slot-workspace-id="${activeWorkspaceId}"]:not([hidden])`,
      );
      // CAN-2363: the projected workspace is whichever one is stuck, so
      // address its disclosure structurally rather than by a fixed name.
      const slotDisclosure = activeSlotRow.locator(
        'button[data-workspace-drag-activator="label"]',
      );
      await expect(slotDisclosure).toHaveAttribute('aria-expanded', 'true');

      // The hard-clipped rows wrapper must not contain dnd-kit's fixed drag
      // preview. Activate a real pointer drag while sticky and confirm the
      // overlay is portaled to the document surface before dropping.
      const dragHandle = activeSlotRow.getByRole('button', {
        name: /^(Reorder|Collapse workspace|Expand workspace) /,
      });
      // The sidebar's compact-viewport collapse-into-"More" is an async
      // measurement pass that can land after this point. Press the pointer
      // only on geometry that has stopped moving, or the drag starts from a
      // stale point inside dnd-kit's auto-scroll band (CAN-2583).
      const dragHandleBox = await waitForStableBoundingBox(dragHandle);
      const dragStartX = dragHandleBox.x + dragHandleBox.width / 2;
      const dragStartY = dragHandleBox.y + dragHandleBox.height / 2;
      const workspaceHeights = await viewport
        .locator('[data-sidebar-workspace-id]')
        .evaluateAll((sections) =>
          Object.fromEntries(
            sections.map((section) => [
              section.getAttribute('data-sidebar-workspace-id'),
              section.offsetHeight,
            ]),
          ),
        );
      const draggedWorkspaceId = await activeSlot.getAttribute(
        'data-active-workspace-id',
      );
      expect(draggedWorkspaceId).not.toBeNull();
      const draggedFlowWorkspace = viewport.locator(
        `[data-sidebar-workspace-id="${draggedWorkspaceId}"]`,
      );
      const draggedStickyHeader = activeSlot.locator(
        `[data-sidebar-workspace-sortable-header="${draggedWorkspaceId}"]`,
      );
      const draggedFlowGeometry = await draggedFlowWorkspace.boundingBox();
      expect(draggedFlowGeometry).not.toBeNull();
      const expectDraggedWorkspaceFootprintToBeStable = async () => {
        const flowGeometry = await draggedFlowWorkspace.boundingBox();
        expect(flowGeometry).not.toBeNull();
        expect({
          height: flowGeometry.height,
          width: flowGeometry.width,
        }).toEqual({
          height: draggedFlowGeometry.height,
          width: draggedFlowGeometry.width,
        });
      };
      await window.mouse.move(dragStartX, dragStartY);
      await window.mouse.down();
      try {
        await window.mouse.move(dragStartX, dragStartY + 12, { steps: 4 });
        const workspaceDragOverlay = window.getByTestId(
          'workspace-drag-overlay',
        );
        await expect(workspaceDragOverlay).toBeVisible();
        expect(
          await workspaceDragOverlay.evaluate(
            (element) =>
              element.closest('.sidebar-workspaces-rows-clip') === null,
          ),
        ).toBe(true);
        expect(
          await activeSlot.evaluate(
            (element) => getComputedStyle(element).visibility,
          ),
        ).toBe('visible');
        expect(
          await draggedStickyHeader.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ).toBe('0.6');
        const draggedFlowState = await draggedFlowWorkspace.evaluate(
          (element) => ({
            className: element.className,
            opacity: getComputedStyle(element).opacity,
          }),
        );
        expect(
          draggedFlowState.opacity,
          `dragged flow state: ${JSON.stringify(draggedFlowState)}`,
        ).toBe('1');
        expect(
          await draggedFlowWorkspace.evaluate(
            (element) => element.offsetHeight,
          ),
        ).toBe(workspaceHeights[draggedWorkspaceId]);
        await expectDraggedWorkspaceFootprintToBeStable();
      } finally {
        await window.mouse.up();
      }
      await expect(window.getByTestId('workspace-drag-overlay')).toHaveCount(0);
      // dnd-kit's pointer sensor intentionally owns clicks for 50 ms after
      // release. Exercise the first deliberate click immediately beyond that
      // library boundary, without waiting for a paint frame or the former
      // 150-ms safety delay. Toggle twice so the geometry assertions continue
      // from the expanded state.
      await window.waitForTimeout(60);
      await slotDisclosure.click();
      await expect(activeFlowWorkspace).toHaveAttribute(
        'data-workspace-expanded',
        'false',
      );
      // Collapsed headers retain their projected copy; the covered flow copy
      // is inert. Reopen through the same user-visible disclosure.
      await slotDisclosure.click();
      await expect(activeFlowWorkspace).toHaveAttribute(
        'data-workspace-expanded',
        'true',
      );
      expect(
        await activeSlot.evaluate(
          (element) => getComputedStyle(element).visibility,
        ),
      ).toBe('visible');
      expect(
        await draggedFlowWorkspace.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
      ).toBe('1');
      expect(
        await draggedStickyHeader.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
      ).toBe('1');
      await expectDraggedWorkspaceFootprintToBeStable();

      await slotDisclosure.click();
      await expect(activeFlowWorkspace).toHaveAttribute(
        'data-workspace-expanded',
        'false',
      );
      // Scratch is intentionally body-less while empty, so collapsing it has
      // no child footprint to remove. The disclosure state and fixed sticky
      // controls are the observable contracts for this fixture.

      const afterCollapseStickyPositions = await viewport.evaluate(
        (element) => {
          const more = element.querySelector(
            '[data-testid="sidebar-more-sticky-container"]',
          );
          const header = element.querySelector('.sidebar-sticky-header');
          if (
            !(more instanceof HTMLElement) ||
            !(header instanceof HTMLElement)
          ) {
            throw new Error('Expected sticky sidebar controls');
          }
          return {
            headerTop: header.getBoundingClientRect().top,
            moreTop: more.getBoundingClientRect().top,
          };
        },
      );
      expect(
        Math.abs(afterCollapseStickyPositions.moreTop - beforeMoreTop),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(afterCollapseStickyPositions.headerTop - beforeHeaderTop),
      ).toBeLessThanOrEqual(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // 4b) The fixed slot is a separate render surface. Real headers remain in
  // flow beneath one compositor-owned structural clip, so even the first
  // paint after a large delta cannot expose flow content in the protected
  // title/slot/divider band.
  test('keeps a constant dedicated project slot above a structurally clipped flow layer', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-unified-sticky-slot-'),
    );
    // Include the default Cowork workspace in the first project-hydration
    // baseline so it cannot trigger a late recently-added auto-scroll.
    seedDefaultCoworkWorkspace(userDataDir);

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        seedDemoWorkspaces: true,
        demoWorkspaceApps: [
          'ts-pnpm-vite',
          'ts-npm-next',
          'ts-bun-api',
          'ts-yarn-cli',
          'go-cli',
        ],
        viewportSize: { width: 900, height: 500 },
        env: LABS_PAGES_OFFERED_ENV,
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const viewport = window.getByTestId('sidebar-scroll-container');
      const scrollbar = window.locator(
        '[data-testid="app-sidebar"] [data-sidebar-scrollbar]',
      );
      const slot = viewport.getByTestId('sidebar-sticky-workspace-slot');
      // The default Cowork workspace is not a workspace row any more; it
      // renders in the Chats section above the list (CAN-2363).
      await expect(viewport.locator('[data-workspace-expanded]')).toHaveCount(
        5,
      );
      await expect(viewport.getByTestId('worktree-row')).toHaveCount(5);

      // The compact viewport makes the list scrollable. In overlay mode the
      // scrollbar stays hidden until direct wheel input, while macOS's
      // always-visible mode intentionally pins the rail whenever content
      // overflows. Assert the mode the app detected and published instead of
      // assuming every CI runner uses overlay scrollbars.
      // Workspace selection restoration can still be smoothly scrolling the
      // compact sidebar after all workspace rows have mounted. Wait for that
      // startup motion to finish before normalizing the structural-flow test
      // to its intended unscrolled state.
      await normalizeSidebarScrollAfterStartup(viewport);
      const scrollbarMode = await window.evaluate(
        () => document.documentElement.dataset.scrollbars,
      );
      expect(scrollbarMode).toMatch(/^(always|overlay)$/);
      if (scrollbarMode === 'always') {
        await expect(scrollbar).toHaveClass(/opacity-100/);
        await expect(scrollbar).toHaveClass(/pointer-events-auto/);
      } else {
        await expect(scrollbar).toHaveClass(/opacity-0/);
        await expect(scrollbar).toHaveClass(/pointer-events-none/);
      }

      const transitionState = await viewport.evaluate((element) => {
        const group = element.querySelector(
          '[data-testid="sidebar-more-sticky-container"]',
        );
        const slot = element.querySelector(
          '[data-testid="sidebar-sticky-workspace-slot"]',
        );
        const flow = element.querySelector('.sidebar-workspaces-rows-clip');
        const sections = Array.from(
          element.querySelectorAll('[data-sidebar-workspace-id]'),
        );
        const firstSectionWithRow = sections.find((section) =>
          section.querySelector('[data-testid="worktree-row"]'),
        );
        const firstHeader = firstSectionWithRow?.querySelector(
          '.sidebar-workspace-sticky-header',
        );
        const firstRow = firstSectionWithRow?.querySelector(
          '[data-testid="worktree-row"]',
        );
        if (
          !(group instanceof HTMLElement) ||
          !(slot instanceof HTMLElement) ||
          !(flow instanceof HTMLElement) ||
          !(firstSectionWithRow instanceof HTMLElement) ||
          !(firstHeader instanceof HTMLElement) ||
          !(firstRow instanceof HTMLElement) ||
          sections.length < 2
        ) {
          throw new Error(
            'Expected fixed slot, first project row, and multiple flow projects',
          );
        }

        const topVar = Number.parseFloat(
          getComputedStyle(element).getPropertyValue(
            '--sidebar-workspace-header-top',
          ),
        );
        const getLayoutOffsetTop = (node) => {
          let offsetTop = 0;
          let current = node;
          while (current) {
            offsetTop += current.offsetTop;
            current = current.offsetParent;
          }
          return offsetTop;
        };
        // The Chats row is a workspace row without an in-flow header
        // (CAN-2363); sticky seats only apply to headed workspaces.
        const thresholds = sections
          .filter((section) =>
            section.querySelector('.sidebar-workspace-sticky-header'),
          )
          .map((section) => {
            const header = section.querySelector(
              '.sidebar-workspace-sticky-header',
            );
            if (!(header instanceof HTMLElement)) {
              throw new Error('Expected in-flow project header');
            }
            return {
              id: section.getAttribute('data-sidebar-workspace-id'),
              scrollTop:
                getLayoutOffsetTop(header) -
                getLayoutOffsetTop(element) -
                topVar,
            };
          });

        const read = () => {
          const flowRect = flow.getBoundingClientRect();
          const slotRect = slot.getBoundingClientRect();
          const firstHeaderRect = firstHeader.getBoundingClientRect();
          const firstRowRect = firstRow.getBoundingClientRect();
          const flowStyle = getComputedStyle(flow);
          const firstRowStyle = getComputedStyle(firstRow);
          const clipPath = flowStyle.clipPath;
          const clipMatch = clipPath.match(/^inset\(([-\d.]+)px/);
          const clipInset = clipMatch ? Number.parseFloat(clipMatch[1]) : null;
          const activeRow = slot.querySelector(
            '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
          );
          return {
            activeId: slot.dataset.activeWorkspaceId,
            activeText: activeRow?.textContent?.trim() ?? '',
            clipPath,
            clipBoundary: clipInset === null ? null : flowRect.top + clipInset,
            firstHeaderBottom: firstHeaderRect.bottom,
            firstRowTop: firstRowRect.top,
            firstRowPaintedTop:
              clipInset === null
                ? firstRowRect.top
                : Math.max(firstRowRect.top, flowRect.top + clipInset),
            firstRowRadii: [
              firstRowStyle.borderTopLeftRadius,
              firstRowStyle.borderTopRightRadius,
              firstRowStyle.borderBottomRightRadius,
              firstRowStyle.borderBottomLeftRadius,
            ],
            slotHidden: slot.hidden,
            slotTop: slotRect.top,
            slotHeight: slotRect.height,
            visibleSlotRows: slot.querySelectorAll(
              '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
            ).length,
          };
        };

        return {
          groupBottom: group.getBoundingClientRect().bottom,
          flowAnimationTimeline: getComputedStyle(flow).animationTimeline,
          flowBackground: getComputedStyle(flow).backgroundColor,
          flowTransform: getComputedStyle(flow).transform,
          slotPosition: getComputedStyle(slot).position,
          firstWorkspaceId:
            firstSectionWithRow.dataset.sidebarWorkspaceId ?? null,
          thresholds,
          initial: read(),
        };
      });

      expect(transitionState.flowAnimationTimeline).toContain('scroll');
      expect(transitionState.flowBackground).toBe('rgba(0, 0, 0, 0)');
      expect(transitionState.flowTransform).toBe('none');
      // CAN-3126: the band occludes rather than inheriting the window
      // material, so rows pass UNDER it instead of rendering through it and
      // depending on the clip alone. Read on the shared rail (the default)
      // with every appearance pinned, so the result is not the host's.
      await expect(
        window.getByTestId('portal-workspaces-header'),
      ).toBeVisible();
      expectBandOccludes(
        await readBandMaterials(window, STICKY_WORKSPACE_SLOT),
      );
      expect(transitionState.slotPosition).toBe('absolute');
      expect(transitionState.initial.slotHidden).toBe(true);
      expect(transitionState.initial.visibleSlotRows).toBe(0);
      expect(transitionState.initial.activeText).toBe('');
      // The scroll-driven occlusion clip is always animating (a pure function
      // of the scroll offset, so composited flings can never outrun it). At
      // rest it holds an inert negative inset whose boundary sits above every
      // painted row, clipping nothing.
      expect(transitionState.initial.clipPath).toMatch(/^inset\(-[\d.]+px/);
      expect(transitionState.initial.clipBoundary).not.toBeNull();
      expect(transitionState.initial.clipBoundary).toBeLessThan(
        transitionState.initial.firstHeaderBottom - 31,
      );
      expect(
        transitionState.initial.firstRowTop -
          transitionState.initial.firstHeaderBottom,
      ).toBeCloseTo(1, 2);
      expect(transitionState.initial.firstRowPaintedTop).toBe(
        transitionState.initial.firstRowTop,
      );
      expect(transitionState.initial.firstRowRadii).toEqual([
        '10px',
        '10px',
        '10px',
        '10px',
      ]);

      const firstThreshold = transitionState.thresholds[0];
      const secondThreshold = transitionState.thresholds[1];
      expect(firstThreshold.id).not.toBeNull();
      expect(secondThreshold.id).not.toBeNull();

      // At rest the in-flow workspace is the sole authoritative header copy.
      // During a cancelled drag, only that header dims; the outer section and
      // its expanded children keep their layout and paint while the
      // document-level DragOverlay follows the pointer.
      const restWorkspace = viewport.locator(
        `[data-sidebar-workspace-id="${transitionState.firstWorkspaceId}"]`,
      );
      const restSourceHeader = restWorkspace.locator(
        '[data-sidebar-workspace-sortable-header]:not([data-testid$="-sticky-slot"])',
      );
      const restChildRow = restWorkspace
        .locator('[data-testid="worktree-row"]')
        .first();
      const restTypography = await restWorkspace.evaluate((element) => {
        const header = element.querySelector(
          '[data-testid^="sidebar-project-header-"]:not([data-testid$="-sticky-slot"])',
        );
        const label = header?.querySelector('span[title]');
        const counter = header?.querySelector(
          '[data-testid="workspace-section-counter"]',
        );
        if (
          !(label instanceof HTMLElement) ||
          !(counter instanceof HTMLElement)
        ) {
          throw new Error('Expected flow project label and counter');
        }
        const labelStyle = getComputedStyle(label);
        const counterStyle = getComputedStyle(counter);
        return {
          label: {
            fontFamily: labelStyle.fontFamily,
            fontSize: labelStyle.fontSize,
            fontWeight: labelStyle.fontWeight,
            lineHeight: labelStyle.lineHeight,
            color: labelStyle.color,
          },
          counter: {
            fontFamily: counterStyle.fontFamily,
            fontSize: counterStyle.fontSize,
            fontWeight: counterStyle.fontWeight,
            lineHeight: counterStyle.lineHeight,
            color: counterStyle.color,
            opacity: counterStyle.opacity,
          },
        };
      });
      const restDragHandle = restWorkspace.getByRole('button', {
        name: /^(Reorder|Collapse workspace|Expand workspace) /,
      });
      // The sidebar's compact-viewport collapse-into-"More" is an async
      // measurement pass that can land after this point. Press the pointer
      // only on geometry that has stopped moving, or the drag starts from a
      // stale point inside dnd-kit's auto-scroll band (CAN-2583).
      const restDragHandleBox = await waitForStableBoundingBox(restDragHandle);
      const restWorkspaceHeight = await restWorkspace.evaluate(
        (element) => element.offsetHeight,
      );
      const restDragX = restDragHandleBox.x + restDragHandleBox.width / 2;
      const restDragY = restDragHandleBox.y + restDragHandleBox.height / 2;
      await window.mouse.move(restDragX, restDragY);
      await window.mouse.down();
      try {
        await window.mouse.move(restDragX, restDragY + 12, { steps: 4 });
        await expect(
          window.getByTestId('workspace-drag-overlay'),
        ).toBeVisible();
        expect(
          await restWorkspace.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ).toBe('1');
        expect(
          await restSourceHeader.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ).toBe('0.6');
        expect(
          await restChildRow.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ).toBe('1');
        expect(
          await restWorkspace.evaluate((element) => element.offsetHeight),
        ).toBe(restWorkspaceHeight);
        // DragOverlay mounting feeds the sticky host's rAF-scheduled layout
        // pass, so poll across the transient recompute frame.
        await expect
          .poll(() => slot.evaluate((element) => element.hidden))
          .toBe(true);
        await window.keyboard.press('Escape');
        await expect(window.getByTestId('workspace-drag-overlay')).toHaveCount(
          0,
        );
      } finally {
        await window.mouse.up();
      }
      expect(
        await restWorkspace.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
      ).toBe('1');
      expect(
        await restSourceHeader.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
      ).toBe('1');
      // Releasing the drag near the compact viewport edge can legitimately
      // trigger DnD auto-scroll and activate the sticky slot. Return to the
      // test's at-rest origin before asserting the slot is hidden.
      await normalizeSidebarScrollAfterStartup(viewport);
      await expect
        .poll(() => slot.evaluate((element) => element.hidden))
        .toBe(true);

      const activationSamples = await viewport.evaluate(
        async (element, threshold) => {
          const slot = element.querySelector(
            '[data-testid="sidebar-sticky-workspace-slot"]',
          );
          const flow = element.querySelector('.sidebar-workspaces-rows-clip');
          if (
            !(slot instanceof HTMLElement) ||
            !(flow instanceof HTMLElement)
          ) {
            throw new Error('Expected slot and flow');
          }
          const read = () => {
            const clipPath = getComputedStyle(flow).clipPath;
            const clipMatch = clipPath.match(/^inset\(([-\d.]+)px/);
            const clipInset = clipMatch
              ? Number.parseFloat(clipMatch[1])
              : null;
            return {
              clipPath,
              clipInset,
              // How deep the band actually is, measured in the same frame the
              // clip inset is expressed in. The band is derived from the
              // sticky stack rather than a flat 40px, so the inset has to be
              // read against this rather than against a constant.
              bandDepth:
                slot.getBoundingClientRect().bottom -
                flow.getBoundingClientRect().top,
              slotHidden: slot.hidden,
              slotTop: slot.getBoundingClientRect().top,
              visibleSlotRows: slot.querySelectorAll(
                '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
              ).length,
            };
          };
          // Chromium exposes integer scrollTop values for this viewport, so
          // choose realizable samples on either side of the threshold. The
          // slot copy activates 40px early — where the always-on scroll clip
          // starts biting the in-flow header — so sample both sides of that
          // pre-roll boundary as well as the sticky threshold itself.
          const beforePreroll = Math.max(0, Math.floor(threshold) - 41);
          const beforeThreshold = Math.max(0, Math.floor(threshold) - 1);
          const atThreshold = Math.ceil(threshold);
          const samples = [];
          for (const requestedScrollTop of [
            beforePreroll,
            beforeThreshold,
            atThreshold,
            atThreshold + 1,
            beforePreroll,
          ]) {
            element.scrollTop = requestedScrollTop;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
            const immediate = read();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            samples.push({
              requestedScrollTop,
              actualScrollTop: element.scrollTop,
              immediate,
              painted: read(),
            });
          }
          return samples;
        },
        firstThreshold.scrollTop,
      );
      expect(
        activationSamples.map(({ immediate }) => immediate.slotHidden),
      ).toEqual([true, false, false, false, true]);
      expect(
        activationSamples.map(({ immediate }) => immediate.visibleSlotRows),
      ).toEqual([0, 1, 1, 1, 0]);
      // The clip is always animating; painted insets are the authoritative
      // per-frame values (immediate reads can lag one frame behind a
      // same-task programmatic scroll). Outside the pre-roll band the inset
      // is negative (clips nothing); inside it tracks the fixed boundary.
      const bandDepth = activationSamples[2].painted.bandDepth;
      expect(activationSamples[0].painted.clipInset).toBeLessThanOrEqual(0);
      // Just inside the pre-roll band the clip has almost reached the band's
      // bottom edge; at and past the threshold it sits on it. These used to
      // be hard-coded 38/40/41.5 windows around a flat 40px band, which
      // stopped describing the geometry once the band became derived.
      expect(activationSamples[1].painted.clipInset).toBeGreaterThanOrEqual(
        bandDepth - 2,
      );
      expect(activationSamples[1].painted.clipInset).toBeLessThanOrEqual(
        bandDepth,
      );
      expect(activationSamples[2].painted.clipInset).toBeGreaterThanOrEqual(
        bandDepth - 0.5,
      );
      expect(activationSamples[2].painted.clipInset).toBeLessThanOrEqual(
        bandDepth + 0.5,
      );
      expect(activationSamples[3].painted.clipInset).toBeGreaterThanOrEqual(
        bandDepth,
      );
      expect(activationSamples[3].painted.clipInset).toBeLessThanOrEqual(
        bandDepth + 1.5,
      );
      expect(activationSamples[4].painted.clipInset).toBeLessThanOrEqual(0);
      for (const [index, sample] of activationSamples.entries()) {
        expect(
          {
            slotHidden: sample.immediate.slotHidden,
            slotTop: sample.immediate.slotTop,
            visibleSlotRows: sample.immediate.visibleSlotRows,
          },
          `threshold sample ${index}: ${JSON.stringify(sample)}`,
        ).toEqual({
          slotHidden: sample.painted.slotHidden,
          slotTop: sample.painted.slotTop,
          visibleSlotRows: sample.painted.visibleSlotRows,
        });
      }
      expect(
        Math.max(
          ...activationSamples
            .slice(2, 4)
            .map(({ painted }) => painted.slotTop),
        ) -
          Math.min(
            ...activationSamples
              .slice(2, 4)
              .map(({ painted }) => painted.slotTop),
          ),
      ).toBeLessThanOrEqual(0.01);

      await viewport.evaluate((element, threshold) => {
        element.scrollTop = threshold;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, firstThreshold.scrollTop);
      const stickyTypography = await slot.evaluate((element) => {
        const activeRow = element.querySelector(
          '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
        );
        const label = activeRow?.querySelector('span[title]');
        // The slot copy suffixes its inner ids (CAN-3127).
        const counter = activeRow?.querySelector(
          '[data-testid="workspace-section-counter-sticky-slot"]',
        );
        if (
          !(label instanceof HTMLElement) ||
          !(counter instanceof HTMLElement)
        ) {
          throw new Error('Expected sticky project label and counter');
        }
        const labelStyle = getComputedStyle(label);
        const counterStyle = getComputedStyle(counter);
        return {
          label: {
            fontFamily: labelStyle.fontFamily,
            fontSize: labelStyle.fontSize,
            fontWeight: labelStyle.fontWeight,
            lineHeight: labelStyle.lineHeight,
            color: labelStyle.color,
          },
          counter: {
            fontFamily: counterStyle.fontFamily,
            fontSize: counterStyle.fontSize,
            fontWeight: counterStyle.fontWeight,
            lineHeight: counterStyle.lineHeight,
            color: counterStyle.color,
            opacity: counterStyle.opacity,
          },
        };
      });
      expect(stickyTypography).toEqual(restTypography);

      const adjacentSamples = await viewport.evaluate(
        async (element, threshold) => {
          const slot = element.querySelector(
            '[data-testid="sidebar-sticky-workspace-slot"]',
          );
          const flow = element.querySelector('.sidebar-workspaces-rows-clip');
          if (
            !(slot instanceof HTMLElement) ||
            !(flow instanceof HTMLElement)
          ) {
            throw new Error('Expected slot and flow');
          }
          const read = () => {
            const flowRect = flow.getBoundingClientRect();
            const clipInset = Number.parseFloat(
              getComputedStyle(flow).clipPath.match(
                /^inset\(([-\d.]+)px/,
              )?.[1] ?? 'NaN',
            );
            return {
              activeId: slot.dataset.activeWorkspaceId,
              clipBoundary: flowRect.top + clipInset,
              bandBottom: slot.getBoundingClientRect().bottom,
              slotTop: slot.getBoundingClientRect().top,
              visibleSlotRows: slot.querySelectorAll(
                '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
              ).length,
            };
          };
          const samples = [];
          const before = Math.max(0, Math.floor(threshold) - 1);
          const atThreshold = Math.ceil(threshold);
          for (const scrollTop of [before, atThreshold, atThreshold + 1]) {
            element.scrollTop = scrollTop;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
            // Synthetic scroll assignment updates the synchronous sticky slot
            // immediately, but Chromium can expose the previous computed
            // scroll-timeline value for one rAF under suite load. Wait for the
            // compositor-backed clip to acknowledge this exact scroll offset;
            // a persistently stale/too-shallow clip still fails below.
            let painted = read();
            for (let frame = 0; frame < 4; frame += 1) {
              await new Promise((resolve) => requestAnimationFrame(resolve));
              painted = read();
              if (painted.clipBoundary >= painted.bandBottom - 1) break;
            }
            samples.push({
              requestedScrollTop: scrollTop,
              actualScrollTop: element.scrollTop,
              painted,
            });
          }
          return samples;
        },
        secondThreshold.scrollTop,
      );
      for (const [index, { painted }] of adjacentSamples.entries()) {
        expect(
          painted.clipBoundary,
          `adjacent painted sample ${index}: ${JSON.stringify(painted)}`,
        ).toBeGreaterThanOrEqual(painted.bandBottom - 1);
      }
      expect(
        adjacentSamples.map(({ painted }) => painted.visibleSlotRows),
      ).toEqual([2, 1, 1]);
      const adjacentIdentitySamples = adjacentSamples.map(
        ({ requestedScrollTop, actualScrollTop, painted }) => ({
          requestedScrollTop,
          actualScrollTop,
          activeId: painted.activeId,
        }),
      );
      expect(
        adjacentIdentitySamples.map(({ activeId }) => activeId),
        `adjacent identity samples: ${JSON.stringify(adjacentIdentitySamples)}`,
      ).toEqual([firstThreshold.id, secondThreshold.id, secondThreshold.id]);
      expect(
        Math.max(...adjacentSamples.map(({ painted }) => painted.slotTop)) -
          Math.min(...adjacentSamples.map(({ painted }) => painted.slotTop)),
      ).toBeLessThanOrEqual(0.01);

      const fastSamples = await viewport.evaluate(
        async (element, lowScrollTop) => {
          const slot = element.querySelector(
            '[data-testid="sidebar-sticky-workspace-slot"]',
          );
          const flow = element.querySelector('.sidebar-workspaces-rows-clip');
          if (
            !(slot instanceof HTMLElement) ||
            !(flow instanceof HTMLElement)
          ) {
            throw new Error('Expected slot and flow');
          }
          const high = element.scrollHeight - element.clientHeight;
          const low = Math.min(high, lowScrollTop);
          const samples = [];
          for (let index = 0; index < 24; index += 1) {
            const requestedScrollTop = index % 2 === 0 ? high : low;
            element.scrollTop = requestedScrollTop;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const flowRect = flow.getBoundingClientRect();
            const clipInset = Number.parseFloat(
              getComputedStyle(flow).clipPath.match(
                /^inset\(([-\d.]+)px/,
              )?.[1] ?? 'NaN',
            );
            const paintedBand = {
              clipBoundary: flowRect.top + clipInset,
              bandBottom: slot.getBoundingClientRect().bottom,
            };
            samples.push({
              requestedScrollTop,
              actualScrollTop: element.scrollTop,
              paintedBand,
              activeId: slot.dataset.activeWorkspaceId,
              activeText:
                slot
                  .querySelector(
                    '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
                  )
                  ?.textContent?.trim() ?? '',
              slotTop: slot.getBoundingClientRect().top,
              visibleSlotRows: slot.querySelectorAll(
                '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
              ).length,
            });
          }
          return samples;
        },
        secondThreshold.scrollTop + 0.5,
      );
      for (const [index, sample] of fastSamples.entries()) {
        expect(
          sample.paintedBand.clipBoundary,
          `fast painted sample ${index}: ${JSON.stringify(sample)}`,
        ).toBeGreaterThanOrEqual(sample.paintedBand.bandBottom - 1);
      }
      expect(fastSamples.map((sample) => sample.visibleSlotRows)).toEqual(
        Array.from({ length: fastSamples.length }, (_, index) =>
          index % 2 === 0 ? 2 : 1,
        ),
      );
      expect(
        fastSamples.map((sample) => sample.activeText.length > 0),
        `fast identity samples: ${JSON.stringify(fastSamples)}`,
      ).toEqual(Array.from({ length: fastSamples.length }, () => true));
      const fastIdentitySamples = fastSamples.map((sample) => {
        const expectedId =
          transitionState.thresholds
            .filter(
              (threshold) => threshold.scrollTop <= sample.actualScrollTop,
            )
            .at(-1)?.id ?? firstThreshold.id;
        return {
          actualScrollTop: sample.actualScrollTop,
          activeId: sample.activeId,
          expectedId,
        };
      });
      expect(
        fastIdentitySamples.map(({ activeId }) => activeId),
        `fast identity samples: ${JSON.stringify(fastIdentitySamples)}`,
      ).toEqual(fastIdentitySamples.map(({ expectedId }) => expectedId));
      expect(
        new Set(fastIdentitySamples.map(({ activeId }) => activeId)).size,
      ).toBe(2);
      expect(
        Math.max(...fastSamples.map((sample) => sample.slotTop)) -
          Math.min(...fastSamples.map((sample) => sample.slotTop)),
      ).toBeLessThanOrEqual(0.01);

      const activeWorkspaceId = await slot.getAttribute(
        'data-active-workspace-id',
      );
      expect(activeWorkspaceId).not.toBeNull();
      const activeWorkspace = viewport.locator(
        `[data-sidebar-workspace-id="${activeWorkspaceId}"]`,
      );
      // Exclude the icon slot's 'Collapse workspace <name>' toggle: this
      // assertion targets the primary name toggle specifically.
      const slotToggle = slot.getByRole('button', {
        name: /^Collapse (?!workspace )/,
      });
      await slotToggle.click();
      await expect(activeWorkspace).toHaveAttribute(
        'data-workspace-expanded',
        'false',
      );

      // The programmatic scroll positioning above never reveals the
      // auto-hiding scrollbar (only direct wheel input does): it stays
      // faded with a pointer-inert rail. Always-visible mode is instead
      // overflow-driven, and the collapse above may remove that overflow.
      if (scrollbarMode !== 'always') {
        await expect(scrollbar).toHaveClass(/opacity-0/);
        await expect(scrollbar).toHaveClass(/pointer-events-none/);
      }
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  // 5) Worktree selection from the sidebar navigates to main + shows chat panel.
  test('selecting a sidebar worktree navigates to main and shows the chat panel', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Start on a non-main page so the navigation is observable.
      await app.openPipelinesPage();
      await app.expectPipelinesPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();
      await app.selectWorktree(WORKTREE_BRANCH);

      await app.expectMainPage();
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('scrolls the matching project row and kanban card when worktree IDs collide', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite', 'ts-npm-next'],
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await installWorktreeScrollRecorder(window);

      const sidebar = window.getByTestId('app-sidebar');
      const secondSidebarRow = sidebar.locator(
        `[data-project-id="${SECOND_CODE_WORKSPACE_ID}"]` +
          `[data-worktree-id="${WORKTREE_BRANCH}"]`,
      );
      await expect(secondSidebarRow).toBeVisible();

      await app.openPipelinesPage();
      await resetWorktreeScrollRecorder(window);
      await secondSidebarRow.click();
      await app.expectMainPage();
      await expectLastWorktreeScroll(window, SECOND_CODE_WORKSPACE_ID, {
        block: 'nearest',
        behavior: 'smooth',
      });

      await app.openKanbanPage();
      const board = window.getByTestId('worktree-kanban-board');
      const firstCard = board.locator(
        `[data-project-id="${FIRST_CODE_WORKSPACE_ID}"]` +
          `[data-worktree-id="${WORKTREE_BRANCH}"]`,
      );
      const secondCard = board.locator(
        `[data-project-id="${SECOND_CODE_WORKSPACE_ID}"]` +
          `[data-worktree-id="${WORKTREE_BRANCH}"]`,
      );
      await expect(firstCard).toBeVisible();
      await expect(secondCard).toBeVisible();

      await firstCard.click();
      await expectLastWorktreeScroll(window, FIRST_CODE_WORKSPACE_ID, {
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      });

      await resetWorktreeScrollRecorder(window);
      await secondCard.click();
      await expectLastWorktreeScroll(window, SECOND_CODE_WORKSPACE_ID, {
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // 6) Cowork: blended rows in the unified list expand, chats listed; select
  //    a chat in a non-active workspace → chat page shows it; archived group
  //    opens the archived overview. Row testids
  //    (`sidebar-cowork-project-<id>-*`) are unchanged from the retired
  //    `SidebarCoworkSection` so this coverage carries over.
  test('Cowork rows in the unified list expand, open non-active-workspace chats, and open archives', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-unified-cowork-'),
    );
    seedCoworkProjects(userDataDir);

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openChatPage();

      // Both seeded Cowork workspaces render as rows in the unified list.
      const primaryToggle = window.getByTestId(
        'sidebar-cowork-project-primary-toggle',
      );
      const secondaryToggle = window.getByTestId(
        'sidebar-cowork-project-secondary-toggle',
      );
      await expect(primaryToggle).toBeVisible();
      await expect(secondaryToggle).toBeVisible();
      await expect(primaryToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(secondaryToggle).toHaveAttribute('aria-expanded', 'false');

      // Expand the primary project → its active chat row lists.
      await primaryToggle.click();
      await expect(primaryToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(
        window.locator('[data-standalone-chat-id="primary-active"]'),
      ).toBeVisible();

      // The archive link opens the workspace-scoped overview and reveals the
      // legacy archived chat there.
      const archivedLink = window.getByTestId(
        'sidebar-cowork-project-primary-archived-link',
      );
      await expect(archivedLink).toBeVisible();
      await archivedLink.click();
      await expect(window.getByTestId('archived-overview-page')).toBeVisible();
      await expect(
        window.getByTestId('archived-overview-legacy-row-primary-archived'),
      ).toBeVisible();

      // Expand and select a chat in the NON-active secondary project. Selecting
      // it switches the active project and shows the chat on the chat page.
      await secondaryToggle.click();
      const secondaryChat = window.locator(
        '[data-standalone-chat-id="secondary-active"]',
      );
      await expect(secondaryChat).toBeVisible();
      await secondaryChat.click();
      await app.expectChatPage();
      await expect(
        window.getByText('Hello from the secondary chat.'),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  // 6b) Cowork rows match the code-workspace disclosure contract: the hover
  //     chevron inside the toggle owns collapse, and the trailing
  //     preferences/new-task region never falls through to it — including the
  //     gap between the two controls and the strips above/below them.
  test('Cowork row disclosure lives on the hover chevron, not the trailing actions', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cowork-disclosure-'),
    );
    seedCoworkProjects(userDataDir);

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openChatPage();

      const header = window.getByTestId(
        'sidebar-cowork-project-primary-header',
      );
      const toggle = window.getByTestId(
        'sidebar-cowork-project-primary-toggle',
      );
      const chevron = header.getByTestId('workspace-section-collapse-chevron');
      const settings = window.getByTestId(
        'sidebar-cowork-project-primary-settings',
      );
      const newTask = window.getByTestId(
        'sidebar-cowork-project-primary-new-chat',
      );
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');

      // The chevron overlays the leading icon slot (the drag handle), stays
      // hidden at rest even while the row is collapsed (no chevron in the
      // default state), and pre-rotates for the hover reveal.
      expect(
        await chevron.evaluate((node) =>
          node.closest('button')?.getAttribute('data-testid'),
        ),
      ).toBe('sidebar-cowork-project-primary-drag-handle');
      expect(await chevron.getAttribute('class')).toContain('-rotate-90');
      await expect
        .poll(() => chevron.evaluate((node) => getComputedStyle(node).opacity))
        .toBe('0');

      const headerBox = await header.boundingBox();
      expect(headerBox).not.toBeNull();
      await window.mouse.move(
        headerBox.x + 20,
        headerBox.y + headerBox.height / 2,
      );
      await expect(settings).toBeVisible();
      await expect(newTask).toBeVisible();
      const settingsBox = await settings.boundingBox();
      const newTaskBox = await newTask.boundingBox();
      expect(settingsBox).not.toBeNull();
      expect(newTaskBox).not.toBeNull();

      for (const point of [
        {
          label: 'gap between preferences and new task',
          x: (settingsBox.x + settingsBox.width + newTaskBox.x) / 2,
          y: headerBox.y + headerBox.height / 2,
        },
        {
          label: 'strip above the new task button',
          x: newTaskBox.x + newTaskBox.width / 2,
          y: headerBox.y + 2,
        },
        {
          label: 'strip right of the new task button',
          x: headerBox.x + headerBox.width - 1,
          y: headerBox.y + headerBox.height / 2,
        },
      ]) {
        await window.mouse.move(headerBox.x + 600, headerBox.y + 600);
        await window.mouse.move(point.x, point.y);
        await window.mouse.down();
        await window.mouse.up();
        await expect(toggle, point.label).toHaveAttribute(
          'aria-expanded',
          'false',
        );
      }

      // The swapped icon slot still toggles: hovering it reveals the chevron
      // in place of the icon, and clicking it expands the row.
      const dragHandle = window.getByTestId(
        'sidebar-cowork-project-primary-drag-handle',
      );
      await dragHandle.hover();
      await expect
        .poll(() => chevron.evaluate((node) => getComputedStyle(node).opacity))
        .toBe('1');
      await dragHandle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(
        window.locator('[data-standalone-chat-id="primary-active"]'),
      ).toBeVisible();

      // The whole row container is the disclosure hitbox: a click on the row
      // background (the padding corner above the icon, outside every control)
      // toggles collapse and back. Collapsing can scroll-adjust the sidebar,
      // so each click re-derives the point from the header's live geometry.
      const clickHeaderBackground = async () => {
        const box = await header.boundingBox();
        expect(box).not.toBeNull();
        await window.mouse.click(box.x + 4, box.y + 3);
      };
      await clickHeaderBackground();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');

      // The header itself is click-focusable (tabIndex={-1}), so a
      // background-click collapse must clear pointer-acquired focus: once the
      // pointer leaves, the hover reveal reverts instead of staying lit
      // through :focus-within.
      await window.mouse.move(700, 500);
      await expect
        .poll(() => chevron.evaluate((node) => getComputedStyle(node).opacity))
        .toBe('0');

      await clickHeaderBackground();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      // Collapsing with a pointer click must not leave the row lit by
      // retained button focus: once the pointer leaves, the hover reveal
      // (swapped chevron, trailing actions) reverts to the default state.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await window.mouse.move(700, 500);
      await expect
        .poll(() => chevron.evaluate((node) => getComputedStyle(node).opacity))
        .toBe('0');
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  for (const neighborExpanded of [false, true]) {
    test(`collapsing the first cowork project restores its projected disclosure (neighbor expanded: ${neighborExpanded})`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-inactive-cowork-sticky-collapse-'),
      );
      const { firstWorkspaceId, secondWorkspaceId } =
        seedStickyCollapsedCoworkWorkspaces(userDataDir);

      let electronApp;
      try {
        ({ electronApp } = await launchCanopy({
          userDataDir,
          viewportSize: { width: 900, height: 360 },
        }));
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await window.evaluate(async () => {
          const prefs = await window.api.loadPreferences();
          await window.api.savePreferences({
            sidebarNavLayout: {
              order: prefs.sidebarNavLayout.order,
              moreStartIndex: 0,
            },
          });
        });
        await window.reload();
        await app.waitForShell();
        const flowToggle = window.getByTestId(
          `sidebar-cowork-project-${firstWorkspaceId}-toggle`,
        );
        await expect(flowToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(
          window.getByTestId('sidebar-work-entry-entry-parrot'),
        ).toBeVisible();
        if (neighborExpanded) {
          const neighborToggle = window.getByTestId(
            `sidebar-cowork-project-${secondWorkspaceId}-toggle`,
          );
          // The docked Chats header owns the viewport's bottom band, so a row
          // beneath it must be scrolled clear first (CAN-2363).
          await neighborToggle.scrollIntoViewIfNeeded();
          await neighborToggle.click();
        }
        const flowHeader = window.getByTestId(
          `sidebar-cowork-project-${firstWorkspaceId}-header`,
        );
        await waitForStableBoundingBox(flowHeader);
        await normalizeSidebarScrollAfterStartup(
          window.getByTestId('sidebar-scroll-container'),
        );
        await window.evaluate(async (workspaceId) => {
          const scrollContainer = document.querySelector(
            '[data-testid="sidebar-scroll-container"]',
          );
          if (!(scrollContainer instanceof HTMLElement)) {
            throw new Error('Expected sidebar scroll container');
          }
          const workspaceHeaderTop = Number.parseFloat(
            scrollContainer.style.getPropertyValue(
              '--sidebar-workspace-header-top',
            ),
          );
          const sentinel = scrollContainer.querySelector(
            '[data-testid="sidebar-sticky-workspace-sentinel"]',
          );
          if (!(sentinel instanceof HTMLElement)) {
            throw new Error('Expected sticky project sentinel');
          }
          scrollContainer.scrollTop = sentinel.offsetTop + 1;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const header = scrollContainer.querySelector(
            `[data-testid="sidebar-cowork-project-${workspaceId}-header"]`,
          );
          if (!(header instanceof HTMLElement))
            throw new Error('Expected live project header');
          const stickyLine =
            scrollContainer.getBoundingClientRect().top + workspaceHeaderTop;
          scrollContainer.scrollTop +=
            header.getBoundingClientRect().top - stickyLine + 1;
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }, firstWorkspaceId);

        const stickySlot = window.getByTestId('sidebar-sticky-workspace-slot');
        await expect(stickySlot).toHaveAttribute(
          'data-active-workspace-id',
          firstWorkspaceId,
        );
        const stickyToggle = window.getByTestId(
          `sidebar-cowork-project-${firstWorkspaceId}-toggle-sticky-slot`,
        );
        await stickyToggle.click();
        await expect(stickyToggle).toHaveAttribute('aria-expanded', 'false');
        // Finish the collapse layout/scroll correction before starting the
        // separate scroll gesture represented by the screenshot sequence.
        await window.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );

        await expect(stickySlot).toHaveAttribute(
          'data-active-workspace-id',
          firstWorkspaceId,
        );
        const primaryToggleAfterCollapse = window.getByTestId(
          `sidebar-cowork-project-${firstWorkspaceId}-toggle-sticky-slot`,
        );
        await expect(primaryToggleAfterCollapse).toBeVisible();
        const primaryToggleBox = await primaryToggleAfterCollapse.boundingBox();
        expect(primaryToggleBox).not.toBeNull();
        const hitTestId = await window.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest('[data-testid]')
              ?.getAttribute('data-testid'),
          {
            x: primaryToggleBox.x + primaryToggleBox.width / 2,
            y: primaryToggleBox.y + primaryToggleBox.height / 2,
          },
        );
        expect(hitTestId).toBe(
          `sidebar-cowork-project-${firstWorkspaceId}-toggle-sticky-slot`,
        );

        const slotAndNeighborGeometry = await window.evaluate(
          ({ secondWorkspaceId }) => {
            const slot = document.querySelector(
              '[data-testid="sidebar-sticky-workspace-slot"]',
            );
            const second = document.querySelector(
              `[data-testid="sidebar-cowork-project-${secondWorkspaceId}-header"]`,
            );
            if (
              !(slot instanceof HTMLElement) ||
              !(second instanceof HTMLElement)
            ) {
              throw new Error(
                'Expected sticky slot and adjacent cowork header',
              );
            }
            return {
              slotBottom: slot.getBoundingClientRect().bottom,
              secondTop: second.getBoundingClientRect().top,
            };
          },
          { secondWorkspaceId },
        );
        expect(slotAndNeighborGeometry.secondTop).toBeGreaterThanOrEqual(
          slotAndNeighborGeometry.slotBottom - 0.5,
        );
        // Walk the collapsed headers through the sticky seat in both directions.
        // Each projected disclosure must own its hit target, and its flow copy
        // must be hidden even though collapsing removed the entries container.
        const viewport = window.getByTestId('sidebar-scroll-container');
        const origin = await viewport.evaluate((element) => element.scrollTop);
        const seenWorkspaces = new Set();
        for (const delta of [0, 8, 16, 24, 32, 40, 48, 40, 32, 24, 16, 8, 0]) {
          const sample = await viewport.evaluate(async (element, offset) => {
            element.scrollTop = offset;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const slot = element.querySelector(
              '[data-sidebar-sticky-workspace-slot]',
            );
            const activeId = slot?.getAttribute('data-active-workspace-id');
            const slotRect = slot.getBoundingClientRect();
            // During push-off, the old disclosure can be wholly above the
            // seat before its last few header pixels leave. Hit the larger
            // visible disclosure portion from either projected copy.
            const toggle = Array.from(
              slot.querySelectorAll(
                '[data-sidebar-sticky-slot-workspace-id]:not([hidden]) [data-testid$="-toggle-sticky-slot"]',
              ),
            ).sort((a, b) => {
              const visibleHeight = (node) => {
                const rect = node.getBoundingClientRect();
                return (
                  Math.min(rect.bottom, slotRect.bottom + 40) -
                  Math.max(rect.top, slotRect.top)
                );
              };
              return visibleHeight(b) - visibleHeight(a);
            })[0];
            if (!(toggle instanceof HTMLElement))
              throw new Error('Missing projected disclosure');
            const rect = toggle.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              (Math.max(rect.top, slotRect.top) +
                Math.min(rect.bottom, slotRect.bottom + 40)) /
                2,
            );
            const flowHeader = element.querySelector(
              `[data-sidebar-workspace-id="${activeId}"] .sidebar-workspace-sticky-header`,
            );
            return {
              activeId,
              scrollTop: element.scrollTop,
              requestedScrollTop: offset,
              ownsHit: toggle.contains(hit),
              hitTestId: hit
                ?.closest('[data-testid]')
                ?.getAttribute('data-testid'),
              flowHidden: flowHeader?.getAttribute(
                'data-sidebar-sticky-flow-hidden',
              ),
            };
          }, origin + delta);
          seenWorkspaces.add(sample.activeId);
          expect(sample, JSON.stringify(sample)).toMatchObject({
            ownsHit: true,
            flowHidden: 'true',
          });
        }
        expect(seenWorkspaces.has(firstWorkspaceId)).toBe(true);
        expect(seenWorkspaces.has(secondWorkspaceId)).toBe(true);
        await window.mouse.click(
          primaryToggleBox.x + primaryToggleBox.width / 2,
          primaryToggleBox.y + primaryToggleBox.height / 2,
        );
        await expect(primaryToggleAfterCollapse).toHaveAttribute(
          'aria-expanded',
          'true',
        );
      } finally {
        if (electronApp) {
          await closeCanopy(electronApp, userDataDir);
        } else {
          rmSync(userDataDir, { recursive: true, force: true });
        }
      }
    });
  }

  for (const firstCollapsed of [true, false]) {
    test(`incoming project scrolls into the sticky seat (first collapsed: ${firstCollapsed})`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-workspace-handoff-'),
      );
      const { firstWorkspaceId, secondWorkspaceId } =
        seedStickyCollapsedCoworkWorkspaces(userDataDir);
      let electronApp;
      try {
        ({ electronApp } = await launchCanopy({
          userDataDir,
          viewportSize: { width: 900, height: 360 },
        }));
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        if (firstCollapsed) {
          await window
            .getByTestId(`sidebar-cowork-project-${firstWorkspaceId}-toggle`)
            .click();
        }
        await window.evaluate(async () => {
          const prefs = await window.api.loadPreferences();
          await window.api.savePreferences({
            sidebarNavLayout: {
              order: prefs.sidebarNavLayout.order,
              moreStartIndex: 0,
            },
          });
        });
        await window.reload();
        await app.waitForShell();
        await waitForStableBoundingBox(
          window.getByTestId(
            `sidebar-cowork-project-${secondWorkspaceId}-header`,
          ),
        );
        const viewport = window.getByTestId('sidebar-scroll-container');
        // Approach, complete, then reverse the handoff. The incoming copy must
        // follow its natural flow position, not disappear under the old label.
        await normalizeSidebarScrollAfterStartup(viewport);
        for (const distance of [24, 16, 8, 0, 8, 16, 24]) {
          const sample = await viewport.evaluate(
            async (
              element,
              { firstWorkspaceId, secondWorkspaceId, distance },
            ) => {
              const flow = element.querySelector(
                `[data-testid="sidebar-cowork-project-${secondWorkspaceId}-header"]`,
              );
              const slot = element.querySelector(
                '[data-sidebar-sticky-workspace-slot]',
              );
              const line =
                element.getBoundingClientRect().top +
                Number.parseFloat(
                  element.style.getPropertyValue(
                    '--sidebar-workspace-header-top',
                  ),
                );
              element.scrollTop +=
                flow.getBoundingClientRect().top - line - distance;
              element.dispatchEvent(new Event('scroll', { bubbles: true }));
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              const incoming = slot.querySelector(
                `[data-sidebar-sticky-slot-workspace-id="${secondWorkspaceId}"]`,
              );
              const outgoing = slot.querySelector(
                `[data-sidebar-sticky-slot-workspace-id="${firstWorkspaceId}"]`,
              );
              const incomingRect = incoming.getBoundingClientRect();
              const slotRect = slot.getBoundingClientRect();
              const hit = document.elementFromPoint(
                incomingRect.left + 40,
                Math.min(incomingRect.bottom, slotRect.bottom) - 2,
              );
              return {
                incomingVisible: !incoming.hidden,
                incomingTop: incomingRect.top,
                flowTop: flow.getBoundingClientRect().top,
                slotTop: slotRect.top,
                outgoingBottom: outgoing.hidden
                  ? slotRect.top
                  : outgoing.getBoundingClientRect().bottom,
                outgoingInert: outgoing.inert,
                outgoingAriaHidden: outgoing.getAttribute('aria-hidden'),
                ownsHit: incoming.contains(hit),
                flowHidden: flow
                  .closest('.sidebar-workspace-sticky-header')
                  ?.getAttribute('data-sidebar-sticky-flow-hidden'),
              };
            },
            { firstWorkspaceId, secondWorkspaceId, distance },
          );
          expect(
            sample.incomingVisible,
            JSON.stringify({ distance, ...sample }),
          ).toBe(true);
          expect(Math.abs(sample.incomingTop - sample.flowTop)).toBeLessThan(1);
          expect(
            Math.abs(sample.incomingTop - sample.slotTop - distance),
          ).toBeLessThan(1);
          expect(sample.outgoingBottom).toBeLessThanOrEqual(
            sample.incomingTop + 0.5,
          );
          const outgoingIsFullyClipped =
            sample.outgoingBottom <= sample.slotTop + 0.5;
          expect(
            sample.outgoingInert,
            JSON.stringify({ distance, ...sample }),
          ).toBe(outgoingIsFullyClipped);
          expect(sample.outgoingAriaHidden).toBe(
            outgoingIsFullyClipped ? 'true' : null,
          );
          expect(sample.ownsHit).toBe(true);
          expect(sample.flowHidden).toBe('true');
        }
      } finally {
        if (electronApp) await closeCanopy(electronApp, userDataDir);
        else rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  }

  for (const collapsed of [false, true]) {
    test(`project boundary stays clear through the selected Code handoff (collapsed: ${collapsed})`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-boundary-'),
      );
      seedDefaultCoworkWorkspace(userDataDir);
      const { electronApp } = await launchCanopy({
        userDataDir,
        seedDemoWorkspaces: true,
        demoWorkspaceApps: [
          'ts-pnpm-vite',
          'ts-npm-next',
          'ts-bun-api',
          'go-cli',
        ],
        viewportSize: { width: 900, height: 360 },
      });
      try {
        const window = await electronApp.firstWindow();
        const codeId = await prepareWorkspaceBoundary(
          window,
          new CanopyAppDriver(window),
          collapsed,
        );
        const viewport = window.getByTestId('sidebar-scroll-container');
        for (const distance of [
          48, 40, 32, 24, 16, 8, 4, 0, -1, -4, -8, 0, 8, 24, 40, 48,
        ]) {
          const sample = await sampleWorkspaceBoundary(
            viewport,
            codeId,
            distance,
          );
          for (let index = 1; index < sample.headers.length; index += 1) {
            const previous = sample.headers[index - 1];
            const current = sample.headers[index];
            // Adjacent projected headers preserve the natural 1px section
            // boundary. Expanded content creates larger spacing only when it
            // exists in flow; short/empty sections legitimately do not.
            const handoffGap =
              previous.source === 'slot' && current.source === 'slot' ? 1 : 0;
            expect(current.top, JSON.stringify(sample)).toBeGreaterThanOrEqual(
              previous.bottom + handoffGap - 0.1,
            );
          }
          // A row is either fully shown or fully hidden. The clip cutting
          // through one strands its subtitle directly under the pinned
          // header, with no title above it (CAN-3126).
          expect(sample.straddling, JSON.stringify(sample)).toEqual([]);
          // The clip must never cut above the band's own bottom edge, or a
          // strip between the two shows neither band nor row.
          expect(sample.clipTop, JSON.stringify(sample)).toBeGreaterThanOrEqual(
            sample.controlsBottom - 0.1,
          );
        }
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  // 7) Account menu holds the personal rows (Usage, Sign in/out); Settings and
  //    Send feedback live on the account row's rail (CAN-4055); Audit moved
  //    into "More"; Cloud Sync moved into Settings › Privacy.
  test('account menu shows personal rows; Settings is on the rail; Audit lives in More', async () => {
    const launched = await launchCanopy();
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      // The account popover contains account-scoped actions plus Usage.
      await window.getByTestId('sidebar-account-row').click();
      await expect(window.getByTestId('sidebar-account-menu')).toBeVisible();
      await expect(
        window.getByTestId('sidebar-account-menu-item-usage'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-account-menu-item-sign-in-out'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-account-action-settings'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-account-action-feedback'),
      ).toBeVisible();
      // Items that moved elsewhere are gone from the account menu.
      for (const removed of [
        'audit',
        'workers',
        'cloud-sync',
        'settings',
        'feedback',
      ]) {
        await expect(
          window.getByTestId(`sidebar-account-menu-item-${removed}`),
        ).toHaveCount(0);
      }
      await window.keyboard.press('Escape');

      // Usage navigates from the account menu; Audit from the "More" menu.
      await app.openUsagePage();
      await app.openAuditPage();

      // Settings opens the overlay from the rail. The Canopy Cloud connect
      // block is the hosted Account page's device card (CAN-4421; the old
      // sidebar Cloud Sync modal is gone, and Privacy keeps Activity sharing).
      await app.openSettings();
      await app.openSettingsSection('privacy');
      await expect(window.getByTestId('settings-tab-privacy')).toBeVisible();
      await expect(
        window.getByRole('heading', { name: 'Cloud Sync' }),
      ).toHaveCount(0);
      await app.openAccountSettingsPage('account');
      await expect(
        window.getByTestId('account-device-card-cloud-account'),
      ).toBeVisible();
      await app.closeSettings();
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
  });

  // 8) Resource monitor placement in the new compact titlebar.
  test('first project header stays covered at rest when all nav items live in More', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite', 'ts-npm-next', 'ts-bun-api'],
      viewportSize: { width: 900, height: 500 },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Move every nav item into More: the sticky threshold (main-nav height
      // inside the scroll area) then sits inside the always-on clip's 40px
      // band, so the clip bites the first workspace header at scrollTop 0.
      await window.evaluate(async () => {
        const prefs = await window.api.loadPreferences();
        await window.api.savePreferences({
          sidebarNavLayout: {
            order: prefs.sidebarNavLayout.order,
            moreStartIndex: 0,
          },
        });
      });
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });

      const viewport = window.getByTestId('sidebar-scroll-container');
      await viewport.evaluate(async (element) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      const state = await viewport.evaluate((element) => {
        const sentinel = element.querySelector(
          '[data-testid="sidebar-sticky-workspace-sentinel"]',
        );
        const rowsClip = element.querySelector('.sidebar-workspaces-rows-clip');
        const slot = element.querySelector(
          '[data-testid="sidebar-sticky-workspace-slot"]',
        );
        const flowHeader = element.querySelector(
          '.sidebar-workspace-sticky-header',
        );
        if (!sentinel || !rowsClip || !slot || !flowHeader) {
          throw new Error('Expected sticky sidebar surfaces');
        }
        const clipMatch = /^inset\((-?[\d.]+)px/.exec(
          getComputedStyle(rowsClip).clipPath,
        );
        return {
          scrollTop: element.scrollTop,
          // The band's activation offset is the sentinel plus anything
          // rendered between it and the project rows (the Chats section,
          // CAN-2363). Read the published contract rather than recomputing.
          threshold: Number.parseFloat(
            getComputedStyle(rowsClip).getPropertyValue(
              '--sidebar-workspaces-clip-start',
            ),
          ),
          clipInset: clipMatch ? Number.parseFloat(clipMatch[1]) : null,
          // Where the clip actually cuts, and where the band actually ends.
          // The band's depth is derived from the sticky stack now (header
          // seat, any externally rendered Projects header, the selected-row
          // pin, the slot), so a flat 40px no longer describes it.
          clipBoundary: clipMatch
            ? rowsClip.getBoundingClientRect().top +
              Number.parseFloat(clipMatch[1])
            : null,
          slotBottom: slot.getBoundingClientRect().bottom,
          slotHidden: slot.hidden,
          activeWorkspaceId: slot.dataset.activeWorkspaceId ?? null,
          visibleSlotRows: slot.querySelectorAll(
            '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
          ).length,
          flowHeaderCovered:
            flowHeader.getAttribute('data-sidebar-sticky-flow-hidden') ===
            'true',
        };
      });

      // Precondition: this layout really does put the threshold inside the
      // clip band — otherwise the scenario silently stops testing the
      // rest-state coverage.
      expect(state.scrollTop).toBe(0);
      expect(state.threshold).toBeLessThan(40);
      // The clip already bites at rest…
      expect(state.clipInset).not.toBeNull();
      expect(state.clipInset).toBeGreaterThan(0);
      // …and it saturates exactly where the band ends, so nothing is ever
      // left showing in the strip between the two (CAN-3126). At rest it is
      // short of that line by the threshold, which has not been scrolled
      // through yet. Asserting a flat `40 - threshold` instead described a
      // band depth the CSS no longer uses: it is derived from the sticky
      // stack now, so the slot's own bottom edge is the reference.
      expect(state.clipBoundary).toBeCloseTo(
        state.slotBottom - state.threshold,
        0,
      );
      // …and the pinned slot stands in from rest (pixel-coincident with the
      // covered in-flow header), so the first workspace header never vanishes.
      expect(state.slotHidden).toBe(false);
      expect(state.activeWorkspaceId).not.toBeNull();
      expect(state.visibleSlotRows).toBe(1);
      expect(state.flowHeaderCovered).toBe(true);
      await expect(
        viewport
          .getByTestId('sidebar-sticky-workspace-slot')
          .locator('[data-sidebar-sticky-slot-workspace-id]:not([hidden])'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('bottom scroll fade paints only while a footer banner is present', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-unified-footer-fade-'),
    );

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const viewport = window.getByTestId('sidebar-scroll-container');
      const readFadeState = () =>
        viewport.evaluate((element) => {
          const stack = document.querySelector('[data-sidebar-footer-banners]');
          if (!(stack instanceof HTMLElement)) {
            throw new Error('Expected the footer banner stack');
          }
          const style = getComputedStyle(element);
          return {
            bannerCount: stack.children.length,
            maskImage: style.webkitMaskImage ?? style.maskImage,
          };
        });

      // `launchCanopy` seeds a dismissed onboarding checklist by default, so
      // this test isolates the footer stack's empty/non-empty fade behavior.
      const withoutBanner = await readFadeState();
      expect(withoutBanner.bannerCount).toBe(0);
      expect(withoutBanner.maskImage).toBe('none');

      // The fade is keyed structurally off the stack's contents, so any
      // banner source (dev branch banner, update prompt, guest credits CTA)
      // enables it and an emptied stack disables it again.
      const withBanner = await viewport.evaluate((element) => {
        const stack = document.querySelector('[data-sidebar-footer-banners]');
        const banner = document.createElement('div');
        banner.setAttribute('data-testid', 'synthetic-footer-banner');
        stack.append(banner);
        const style = getComputedStyle(element);
        const maskImage = style.webkitMaskImage ?? style.maskImage;
        banner.remove();
        return { maskImage };
      });
      expect(withBanner.maskImage).toContain('linear-gradient');
      const cleared = await readFadeState();
      expect(cleared.bannerCount).toBe(0);
      expect(cleared.maskImage).toBe('none');
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('resource monitor is pinned in the titlebar above the account row', async () => {
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      // The resource-diagnostics pill moved from the footer cluster into the
      // responsive titlebar. Values collapse gradually, but the icon control
      // remains visible at every supported sidebar width.
      const pill = window.getByTestId('sidebar-resource-diagnostics-pill');
      await expect(pill).toBeVisible();
      const titlebar = window.getByTestId('sidebar-titlebar-resource-monitor');
      await expect(titlebar).toBeVisible();
      const accountRow = window.getByTestId('sidebar-account-row');
      await expect(accountRow).toBeVisible();

      const titlebarBox = await titlebar.boundingBox();
      const accountBox = await accountRow.boundingBox();
      expect(titlebarBox).not.toBeNull();
      expect(accountBox).not.toBeNull();
      expect(titlebarBox.y).toBeLessThan(accountBox.y);

      // UI scale changes rem-sized content, but the shared titlebar controls
      // keep their documented 28px chrome geometry. At maximum supported
      // scale and minimum sidebar width, the icon-only resource control still
      // preserves the documented 4px control-group gap after Forward.
      const resizeHandle = window.getByTestId('sidebar-resize-handle');
      const resizeHandleBox = await resizeHandle.boundingBox();
      expect(resizeHandleBox).not.toBeNull();
      await window.mouse.move(
        resizeHandleBox.x + resizeHandleBox.width / 2,
        resizeHandleBox.y + resizeHandleBox.height / 2,
      );
      await window.mouse.down();
      await window.mouse.move(
        0,
        resizeHandleBox.y + resizeHandleBox.height / 2,
      );
      await window.mouse.up();
      await expect
        .poll(
          async () =>
            (await window.getByTestId('app-sidebar').boundingBox())?.width ?? 0,
        )
        .toBe(220);

      await setUiScale(window, 150);
      await expect(pill).toHaveAttribute('data-compact-layout', 'icon');
      const forwardBox = await window
        .getByTestId('nav-history-forward')
        .boundingBox();
      const scaledPillBox = await pill.boundingBox();
      expect(forwardBox).not.toBeNull();
      expect(scaledPillBox).not.toBeNull();
      expect(forwardBox.width).toBe(28);
      expect(
        scaledPillBox.x - (forwardBox.x + forwardBox.width),
      ).toBeGreaterThanOrEqual(4);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-2829 slice E: the bottom-left account control is the shared
  // SidebarAccountFooter from @canopy/ui-app (the row the web portal renders).
  // The harness is signed out, so the row names the action ("Sign in", not
  // "Not signed in"); its menu opens upward, a row selection closes it and
  // returns keyboard focus to the trigger (FloatingMenu only restores focus on
  // Escape and on its own close-on-select path, which the shared row disables),
  // and Escape still returns focus.
  test('account footer: shared row labels the action, its menu navigates, and focus returns to the trigger', async () => {
    const launched = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });
    const { userDataDir } = launched;
    let electronApp = launched.electronApp;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const row = window.getByTestId('sidebar-account-row');
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('aria-label', 'Sign in');
      await expect(window.getByTestId('sidebar-account-identity')).toHaveText(
        'Sign in',
      );
      await expect(window.getByTestId('sidebar-account-icon')).toBeVisible();
      // The desktop rail actions sit beside the shared row.
      await expect(
        window.getByTestId('sidebar-account-action-feedback'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-account-action-settings'),
      ).toBeVisible();

      // Open the menu: the desktop rows render inside the shared popover.
      await row.click();
      const menu = window.getByTestId('sidebar-account-menu');
      await expect(menu).toBeVisible();
      await expect(row).toHaveAttribute('aria-expanded', 'true');
      for (const item of ['usage', 'sign-in-out']) {
        await expect(
          window.getByTestId(`sidebar-account-menu-item-${item}`),
        ).toBeVisible();
      }
      // Settings and Send feedback live only on the rail (CAN-4056).
      for (const item of ['settings', 'feedback']) {
        await expect(
          window.getByTestId(`sidebar-account-menu-item-${item}`),
        ).toHaveCount(0);
      }
      await expect(
        window.getByTestId('sidebar-account-menu-item-sign-in-out'),
      ).toHaveText('Sign in');

      // Selecting Usage navigates, closes the menu, and hands focus back.
      await window.getByTestId('sidebar-account-menu-item-usage').click();
      await expect(window.getByTestId('page-usage')).toBeVisible();
      await expect(menu).toHaveCount(0);
      await expect(row).toHaveAttribute('aria-expanded', 'false');
      await expect
        .poll(() =>
          window.evaluate(() =>
            document.activeElement?.getAttribute('data-testid'),
          ),
        )
        .toBe('sidebar-account-row');

      // Escape from the reopened menu also returns focus.
      await row.click();
      await expect(menu).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect
        .poll(() =>
          window.evaluate(() =>
            document.activeElement?.getAttribute('data-testid'),
          ),
        )
        .toBe('sidebar-account-row');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

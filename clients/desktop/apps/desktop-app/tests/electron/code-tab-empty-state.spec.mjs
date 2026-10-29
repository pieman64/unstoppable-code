import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * CAN-337 (Home surface follow-up) — With no workspaces, the Code tab
 * replaces the whole split layout (toolbar, list placeholder, chat panel)
 * with the embedded Home surface's zero-workspace CTA instead of a dedicated
 * empty-state component. Launches WITHOUT seedDemoWorkspaces so the app
 * starts empty; onboarding is suppressed by default.
 */
test('empty Code tab shows the embedded Home surface with an Add-a-workspace CTA', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();

    // The centered Home surface (embedded variant) is visible with its CTA.
    const mainPage = window.getByTestId('page-main');
    const homeSurface = mainPage.locator(
      '[data-testid="home-surface"][data-variant="embedded"]',
    );
    await expect(homeSurface).toBeVisible({ timeout: 15_000 });

    await expect(homeSurface.getByTestId('home-composer')).toBeVisible();
    // The embedded empty state shares the same Home surface as the
    // standalone Home page (one shared HomeSurface owns the whole look —
    // heading + gradient background — for every host). The text is picked
    // at random per mount, so assert the stable testid + non-empty text.
    const heading = homeSurface.getByTestId('home-heading');
    await expect(heading).toBeVisible();
    await expect(heading).not.toHaveText('');

    // Split-gate pinning: this "no projects" launch is really the
    // cowork-only fresh-install state (the default "Personal" Cowork
    // workspace is auto-created on sidebar hydration). The Home surface no
    // longer renders a standalone Add-a-workspace CTA — adding a workspace is
    // done via the sidebar Workspaces "+" — while the composer stays fully
    // ENABLED, because cowork is a valid send target. A readOnly Slate
    // editor renders `contenteditable="false"`, so contenteditable=true is
    // the enabled signal; the pipeline switch inherits the same disabled gate.
    await expect(
      homeSurface.getByTestId('home-composer-editor'),
    ).toHaveAttribute('contenteditable', 'true');
    await homeSurface.getByTestId('home-composer-plus-button').click();
    const pipelineRow = window.getByTestId('home-pipeline-mode-button');
    await expect(pipelineRow).toBeEnabled();
    await expect(pipelineRow).toHaveAttribute('aria-pressed', 'false');
    await window.keyboard.press('Escape');
    // When Chats is the only target, the project picker names it instead of
    // hiding, so the destination stays visible (#4159).
    const workspaceSelect = homeSurface.getByTestId('home-workspace-select');
    await expect(workspaceSelect).toBeVisible();
    await expect(workspaceSelect).toContainText('Chats');

    // CAN-2672/CAN-2675: an empty sole Cowork workspace has neither a useful
    // header nor child rows, so its structural container remains hidden.
    await expect(
      window.getByTestId('sidebar-cowork-project-cowork-default'),
    ).toBeHidden();
    await expect(
      window.getByTestId('sidebar-cowork-project-cowork-default-header'),
    ).toHaveCount(0);

    // The sidebar Workspaces "+" carries the onboarding anchor for the
    // workspace tour (it lives in the always-present sidebar now, not on a
    // Home-surface CTA).
    await expect(
      window.locator('[data-onboarding-anchor="workspace-add"]'),
    ).toHaveCount(1);

    // None of the regular chrome renders in the empty state. The kanban
    // `worktree-panel` is only mounted on the kanban page, so it stays absent
    // on the empty main page. The old in-page view toggle was removed with the
    // aside in the unified-sidebar rework, so it no longer exists at all.
    await expect(window.getByTestId('worktree-panel')).toHaveCount(0);
    // The `task-create` anchor now lives permanently on the sidebar's New
    // Task item, so scope this to the main-page content (the empty state must
    // not render its own Create Task chrome — only the kanban header did,
    // and that in-panel button was removed along with the Create Task modal).
    await expect(
      mainPage.locator('[data-onboarding-anchor="task-create"]'),
    ).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('code-tab-empty-state.png'),
    });

    // Clicking the sidebar Workspaces "+" opens the Add Workspace modal.
    await window.getByTestId('sidebar-section-code-toggle').hover();
    await window.getByTestId('sidebar-section-code-add').click();
    await expect(
      window.getByRole('heading', { name: 'Add project' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Task E1 fix round 2 — the embedded empty-state `HomeSurface` (inside the
 * always-mounted-but-hidden `MainPage`) and the standalone "New Task"
 * `HomeSurface` (`HomePage`) must show the SAME heading phrase across a
 * Code<->New Task navigation, because `MainPage` never actually unmounts —
 * it only gets a `hidden` class — so the embedded instance stays alive the
 * whole time and the shared held heading must not reroll. See
 * `useHomeHeading.ts` for the ref-counted module state this pins.
 */
test('heading stays identical navigating from the Code empty state to the New Task page', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();

    const mainPage = window.getByTestId('page-main');
    const embeddedHeading = mainPage
      .locator('[data-testid="home-surface"][data-variant="embedded"]')
      .getByTestId('home-heading');
    await expect(embeddedHeading).toBeVisible({ timeout: 15_000 });
    const embeddedHeadingText = await embeddedHeading.textContent();
    expect(embeddedHeadingText).toBeTruthy();

    await window.getByTestId('sidebar-create-task').click();
    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    const pageHeading = homePage.getByTestId('home-heading');
    await expect(pageHeading).toBeVisible();
    await expect(pageHeading).toHaveText(embeddedHeadingText ?? '');

    // Navigate back to the Code empty state — the embedded instance (which
    // never unmounted) must still show the same held phrase.
    await app.openMainPage();
    await expect(embeddedHeading).toHaveText(embeddedHeadingText ?? '');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

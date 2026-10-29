import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Reworked for the unified sidebar (left-panel rework, T1–T8).
//
// PR 774 originally guaranteed the in-page worktree `<aside>` kept a
// `min-w-70` floor and that its workspace header truncated with a native
// `title` tooltip. The unified-sidebar rework REMOVED the in-page aside and the
// list↔chat resize divider entirely (see task-5-report.md): the worktree list
// now lives in the always-visible left sidebar (`sidebar-section-code`), whose
// width is user-resizable/clamped by `SidebarResizeHandle`, and the `min-w`
// floor no longer applies.
//
// The workspace/branch header truncation contract that PR 774 shipped lives on
// in the sidebar via the shared `WorkspaceSectionHeader`
// (packages/ui-shared/src/components/WorkspaceSectionHeader.tsx) rendered
// through the sidebar's `ProjectSection`/`ProjectHeader`. This spec now pins
// that successor: on a narrow viewport the sidebar workspace header still
// truncates instead of wrapping and exposes the full name via `title`.

const NARROW_VIEWPORT = { width: 768, height: 900 };
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

test('sidebar project header fills its flex header slot', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    viewportSize: NARROW_VIEWPORT,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });

    const projectHeader = app.workspaceHeader(WORKSPACE_NAME);
    await expect(projectHeader).toBeVisible();

    // The sidebar can still be completing its docked-width transition when
    // the header first becomes visible. Wait for the settled layout contract
    // instead of sampling the zero-width entrance frame once.
    await expect
      .poll(async () => {
        const widths = await projectHeader.evaluate((element) => ({
          header: element.getBoundingClientRect().width,
          slot: element.parentElement?.getBoundingClientRect().width ?? 0,
        }));
        return widths.header > 0 && Math.abs(widths.header - widths.slot) <= 1;
      })
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('sidebar project header truncates with a title tooltip', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    viewportSize: NARROW_VIEWPORT,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });

    // The Code Workspaces section is always present in the sidebar.
    const codeSection = window.getByTestId('sidebar-section-code');
    await expect(codeSection).toBeVisible();

    // The header name span exposes the full workspace name through `title`. We
    // target it via the title tooltip (getByTitle) which is the same hook a user
    // would hover to read a truncated name.
    const headerName = app
      .workspaceHeader(WORKSPACE_NAME)
      .getByTitle(WORKSPACE_NAME, { exact: true });
    await expect(headerName).toBeVisible();

    // The visible text equals the `title` value — i.e. `title={displayName}` and
    // the rendered child are the same string (structural truncation contract).
    await expect(headerName).toHaveText(WORKSPACE_NAME);

    // The span carries the shared `truncate` + `min-w-0` classes so long names
    // ellipsize instead of wrapping/overflowing. The demo seed names are short,
    // so we cannot force a *visual* clip deterministically here; instead we
    // assert the truncation machinery (class + title hook) is wired up, which is
    // the structural guarantee PR 774 shipped and the sidebar preserves.
    const className = await headerName.evaluate((el) => el.className);
    expect(className).toContain('truncate');
    expect(className).toContain('min-w-0');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('sidebar resize handle clamps the sidebar to its minimum width', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    viewportSize: NARROW_VIEWPORT,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });

    const sidebar = window.getByTestId('app-sidebar');
    await expect(sidebar).toBeVisible();

    const handle = window.getByTestId('sidebar-resize-handle');
    await expect(handle).toBeVisible();

    // Drag the handle far to the left, past the minimum. The store clamps the
    // width to SIDEBAR_MIN_WIDTH (220px), so the aside never collapses below a
    // usable floor — the successor to PR 774's `min-w` guarantee.
    const handleBox = await handle.boundingBox();
    expect(handleBox, 'resize handle bounding box').not.toBeNull();
    await window.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(10, handleBox.y + handleBox.height / 2, {
      steps: 10,
    });
    await window.mouse.up();

    const box = await sidebar.boundingBox();
    expect(box, 'sidebar must have a bounding box').not.toBeNull();
    // Clamped to the 220px minimum (SIDEBAR_MIN_WIDTH); allow a 1px rounding
    // tolerance for sub-pixel layout. Two-sided on purpose: a lower bound
    // alone would also pass if clamping broke entirely and left the sidebar
    // at its 280px default, which is now a reachable wrong answer.
    expect(Math.abs(box.width - 220)).toBeLessThanOrEqual(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

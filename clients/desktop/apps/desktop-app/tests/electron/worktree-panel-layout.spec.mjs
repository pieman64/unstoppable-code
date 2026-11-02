import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    // width to the 220px minimum, so the aside never collapses below a
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
    // Clamped to the platform minimum; allow a 1px rounding
    // tolerance for sub-pixel layout. Two-sided on purpose: a lower bound
    // alone would also pass if clamping broke entirely and left the sidebar
    // at its 280px default, which is now a reachable wrong answer.
    const minimumWidth = 220;
    expect(Math.abs(box.width - minimumWidth)).toBeLessThanOrEqual(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('guest sidebar controls remain separate and clickable at 220px', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-guest-sidebar-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { sidebarWidth: 220, showDiagnosticsPill: true },
    }),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const sidebar = window.getByTestId('app-sidebar');
    const resources = window.getByTestId('sidebar-resource-diagnostics-pill');
    const forward = window.getByTestId('nav-history-forward');
    const activity = window.getByTestId('sidebar-activity-toggle');
    await expect(resources).toBeVisible();
    await expect(activity).toBeVisible();
    await expect
      .poll(async () => {
        const [rail, history, resource, bell] = await Promise.all([
          sidebar.boundingBox(),
          forward.boundingBox(),
          resources.boundingBox(),
          activity.boundingBox(),
        ]);
        return (
          rail !== null &&
          history !== null &&
          resource !== null &&
          bell !== null &&
          Math.abs(rail.width - 220) <= 1 &&
          resource.x >= history.x + history.width &&
          resource.x + resource.width <= rail.x + rail.width &&
          bell.y >= history.y + history.height
        );
      })
      .toBe(true);
    await resources.click();
    await expect(
      window.getByTestId('resource-diagnostics-popover'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await activity.click();
    await expect(activity).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('sidebar open and close preserve visible size animation', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(window.getByTestId('app-sidebar')).toBeVisible();
    for (let toggle = 0; toggle < 2; toggle += 1) {
      // A loaded CI renderer can present no frame inside the 200ms transition,
      // so sampling widths per frame can see only the endpoints. Seek the
      // aside's own transitions to their midpoint instead: the visible width
      // there must lie strictly between where it started and where it ends.
      const { first, middle, last } = await window.evaluate(async () => {
        const sidebar = document.querySelector('[data-testid="app-sidebar"]');
        const button = document.querySelector('[data-testid="sidebar-toggle"]');
        if (
          !(sidebar instanceof HTMLElement) ||
          !(button instanceof HTMLElement)
        )
          throw new Error('Missing sidebar controls');
        const first = sidebar.getBoundingClientRect().width;
        button.click();
        const transitions = () =>
          sidebar
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.playState === 'running',
            );
        const deadline = performance.now() + 5_000;
        let running = transitions();
        while (
          !running.some((animation) => animation.transitionProperty === 'width')
        ) {
          if (performance.now() > deadline)
            throw new Error('The sidebar width did not transition');
          await new Promise((resolve) => setTimeout(resolve, 0));
          running = transitions();
        }
        for (const animation of running) {
          animation.pause();
          animation.currentTime =
            Number(animation.effect?.getTiming().duration ?? 0) / 2;
        }
        const middle = sidebar.getBoundingClientRect().width;
        for (const animation of running) animation.finish();
        return { first, middle, last: sidebar.getBoundingClientRect().width };
      });
      expect(Math.abs(first - last)).toBeGreaterThan(100);
      expect(middle).toBeGreaterThan(Math.min(first, last) + 1);
      expect(middle).toBeLessThan(Math.max(first, last) - 1);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('sidebar drag coalesces same-frame moves and keeps the release position', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30000 });
    const handle = window.getByTestId('sidebar-resize-handle');
    await handle.hover();
    await window.mouse.down();
    await expect(handle).toHaveAttribute('data-resizing', 'true');
    const samples = await window
      .getByTestId('app-sidebar')
      .evaluate(async (sidebar) => {
        const widths = [sidebar.getBoundingClientRect().width];
        for (let x = 300; x < 400; x++) {
          window.dispatchEvent(
            new MouseEvent('mousemove', { clientX: x, buttons: 1 }),
          );
          await Promise.resolve();
          widths.push(sidebar.getBoundingClientRect().width);
        }
        return [...new Set(widths.map(Math.round))];
      });
    expect(samples).toHaveLength(1);
    await window.evaluate(() =>
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 365 })),
    );
    await expect(handle).not.toHaveAttribute('data-resizing', 'true');
    await expect
      .poll(async () =>
        Math.round(
          (await window.getByTestId('app-sidebar').boundingBox()).width,
        ),
      )
      .toBe(365);
    await window.waitForTimeout(100);
    expect(
      Math.round((await window.getByTestId('app-sidebar').boundingBox()).width),
    ).toBe(365);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  expectBandOccludes,
  readBandMaterials,
} from './sidebar-band-material.helpers.mjs';

async function settleSidebar(viewport) {
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
      if (performance.now() - stableSince >= 1_200) break;
    }
  });
}

test('retargeting the selected worktree clears a premature sticky copy', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [
      'ts-pnpm-vite',
      'ts-npm-next',
      'ts-bun-api',
      'ts-yarn-cli',
      'go-cli',
    ],
    viewportSize: { width: 900, height: 500 },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const sidebar = window.getByTestId('app-sidebar');
    const viewport = window.getByTestId('sidebar-scroll-container');
    const rows = viewport.locator('[data-testid="worktree-row"]');
    await expect(rows).toHaveCount(5);
    await settleSidebar(viewport);

    const firstRow = rows.nth(0);
    const secondRow = rows.nth(1);
    await firstRow.click();
    await settleSidebar(viewport);
    // Let the host observe one real content-size change after the selection's
    // portal copies mount. This mirrors workspace-list growth and guarantees
    // the cache starts with the first selected row before retargeting it.
    await viewport.evaluate(async (element) => {
      const content = element.firstElementChild;
      if (!(content instanceof HTMLElement)) {
        throw new Error('Expected sidebar scroll content');
      }
      const spacer = document.createElement('div');
      spacer.style.height = '1px';
      content.append(spacer);
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      spacer.remove();
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });

    // Cross the first selection's exact top-pin threshold while leaving the
    // next worktree naturally visible below it. This builds the sticky cache
    // around the first row before the selection is retargeted.
    const pinScrollTop = await viewport.evaluate((element) => {
      const selected = element.querySelector('[data-sidebar-selected-item]');
      const header = selected
        ?.closest('[data-sidebar-workspace-id]')
        ?.querySelector('.sidebar-workspace-sticky-header');
      const stickyBandTop = Number.parseFloat(
        element.style.getPropertyValue('--sidebar-workspace-header-top'),
      );
      if (
        !(selected instanceof HTMLElement) ||
        !(header instanceof HTMLElement)
      ) {
        throw new Error('Expected the selected flow row and project header');
      }
      if (!Number.isFinite(stickyBandTop)) {
        throw new Error('Expected the sticky workspace-header offset');
      }
      const viewportTop = element.getBoundingClientRect().top;
      const selectedViewportTop =
        selected.getBoundingClientRect().top - viewportTop;
      return Math.ceil(
        element.scrollTop +
          selectedViewportTop -
          stickyBandTop -
          header.offsetHeight +
          20,
      );
    });

    const topPin = sidebar.getByTestId('sidebar-selected-pin-top');
    await expect(async () => {
      await viewport.evaluate(async (element, scrollTop) => {
        element.scrollTop = scrollTop;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }, pinScrollTop);
      await expect(topPin).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(secondRow).toBeVisible();

    // The pinned header copy suffixes its inner test ids the way the pinned
    // row does, so the bare ids resolve only to in-flow headers and a spec
    // aiming at either is never strict-mode ambiguous (CAN-3127).
    // The disclosure chevron sits in the header's own drag-handle slot, so it
    // is checked alongside the action cluster.
    for (const id of [
      'workspace-section-actions',
      'workspace-section-collapse-chevron',
      'workspace-kind-badge',
    ]) {
      await expect(topPin.getByTestId(`${id}-pin-top`), id).toHaveCount(1);
      await expect(topPin.getByTestId(id), id).toHaveCount(0);
      const bareOutsideFlow = await sidebar.evaluate(
        (root, testId) =>
          [...root.querySelectorAll(`[data-testid="${testId}"]`)]
            .map((el) =>
              el
                .closest('[data-testid^="sidebar-project-header-"]')
                ?.getAttribute('data-testid'),
            )
            .filter(
              (headerId) =>
                !headerId ||
                /-(pin-top|pin-bottom|sticky-slot)$/.test(headerId),
            ),
        id,
      );
      expect(bareOutsideFlow, id).toEqual([]);
    }

    // The second row is below the pin threshold, so selecting it must retire
    // the pinned copy immediately. A stale cache used the first row's offset
    // with the second row's portaled content, producing two visible copies.
    const secondProjectId = await secondRow.getAttribute('data-project-id');
    expect(secondProjectId).not.toBeNull();
    await secondRow.click();
    await expect(
      viewport.locator(
        '[data-sidebar-selected-item] [data-testid="worktree-row"]',
      ),
    ).toHaveAttribute('data-project-id', secondProjectId);
    await viewport.evaluate(async (element, scrollTop) => {
      // Selection also queues the app's ordinary reveal scroll. Let the
      // selection/portal commits settle, then restore the exact comparison
      // offset so only the sticky retarget decision differs.
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      element.scrollTop = scrollTop;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }, pinScrollTop);
    await expect(topPin).toBeHidden();
    await expect(secondRow).toBeVisible();
    await expect(viewport.locator('[data-sidebar-selected-item]')).toHaveCSS(
      'opacity',
      '1',
    );
    await expect(
      sidebar.locator('[data-testid^="worktree-row-pin-"]:visible'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the bottom-pinned project and selection occlude scrolling rows', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [
      'ts-pnpm-vite',
      'ts-npm-next',
      'ts-bun-api',
      'ts-yarn-cli',
      'go-cli',
    ],
    viewportSize: { width: 900, height: 500 },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const sidebar = window.getByTestId('app-sidebar');
    const viewport = window.getByTestId('sidebar-scroll-container');
    const rows = viewport.locator('[data-testid="worktree-row"]');
    await expect(rows).toHaveCount(5);
    await settleSidebar(viewport);

    // The default manual order keeps the fixture order stable while the
    // selected row records activity; Last updated would move that project to
    // the front.
    await rows.last().click();
    await settleSidebar(viewport);
    await viewport.evaluate(async (element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const bottomPin = sidebar.getByTestId('sidebar-selected-pin-bottom');
    await expect(bottomPin).toBeVisible();
    await expect(
      bottomPin.getByTestId('worktree-row-pin-bottom'),
    ).toBeVisible();
    const clipBoundary = await viewport.evaluate((element) => {
      const flow = element.querySelector('.sidebar-workspaces-rows-clip');
      const pin = element
        .closest('[data-testid="app-sidebar"]')
        ?.querySelector('[data-sidebar-selected-pin-bottom]');
      if (!(flow instanceof HTMLElement) || !(pin instanceof HTMLElement)) {
        throw new Error('Expected the project flow and bottom pin');
      }
      const insetValues = getComputedStyle(flow)
        .clipPath.match(/-?\d+(?:\.\d+)?px/g)
        ?.map((value) => Number.parseFloat(value));
      if (!insetValues || insetValues.length < 3) {
        throw new Error(
          `Expected an inset flow clip, got ${getComputedStyle(flow).clipPath}`,
        );
      }
      return {
        clippedBottom: flow.getBoundingClientRect().bottom - insetValues[2],
        pinTop: pin.getBoundingClientRect().top,
        pinHeight: pin.getBoundingClientRect().height,
        viewportTop: element.getBoundingClientRect().top,
        viewportBottom: element.getBoundingClientRect().bottom,
        scrollTop: element.scrollTop,
        morePresent:
          element.querySelector('[data-testid="sidebar-more"]') !== null,
        moreHeight:
          element
            .querySelector('[data-sidebar-more-lead]')
            ?.getBoundingClientRect().height ?? 0,
        flowStyle: flow.style.cssText,
        railStyle: element.style.cssText,
      };
    });
    expect(
      Math.abs(clipBoundary.clippedBottom - clipBoundary.pinTop),
      JSON.stringify(clipBoundary),
    ).toBeLessThanOrEqual(1);
    // CAN-3126: both pin bands occlude in every appearance. Read on the
    // shared rail (the default) with the platform, appearance, and reduced
    // transparency all pinned, so the result is not the host's: GitHub's
    // macOS runners turn Reduce transparency on, a developer Mac usually not.
    await expect(sidebar.getByTestId('portal-workspaces-header')).toBeVisible();
    expectBandOccludes(
      await readBandMaterials(
        window,
        '[data-testid="sidebar-selected-pin-bottom"]',
      ),
    );
    expectBandOccludes(
      await readBandMaterials(
        window,
        '[data-testid="sidebar-selected-pin-top"]',
      ),
    );
    const materialColors = await bottomPin.evaluate((element) => {
      const root = document.documentElement;
      const material = element.closest('.app-sidebar-material');
      if (!(material instanceof HTMLElement)) {
        throw new Error('Expected the sidebar material');
      }
      const originalPlatform = root.getAttribute('data-platform');
      const originalAppearance = root.getAttribute('data-sidebar-appearance');
      root.setAttribute('data-platform', 'darwin');
      root.setAttribute('data-sidebar-appearance', 'translucent');
      const translucentSurface = getComputedStyle(material).backgroundColor;

      const preview = document.createElement('div');
      preview.className = 'app-sidebar-material app-sidebar-preview-surface';
      const previewPin = document.createElement('div');
      previewPin.className = 'sidebar-selected-pin-bottom';
      preview.append(previewPin);
      document.body.append(preview);
      const previewSurface = getComputedStyle(preview).backgroundColor;
      const previewPinSurface = getComputedStyle(previewPin).backgroundColor;
      preview.remove();

      if (originalPlatform === null) root.removeAttribute('data-platform');
      else root.setAttribute('data-platform', originalPlatform);
      if (originalAppearance === null) {
        root.removeAttribute('data-sidebar-appearance');
      } else {
        root.setAttribute('data-sidebar-appearance', originalAppearance);
      }

      return { translucentSurface, previewSurface, previewPinSurface };
    });
    expect(materialColors.translucentSurface).toBe('rgba(0, 0, 0, 0)');
    expect(materialColors.previewPinSurface).toBe(
      materialColors.previewSurface,
    );
    await expect(viewport.locator('[data-sidebar-selected-item]')).toHaveCSS(
      'opacity',
      '0',
    );

    // CAN-1074's portalled pin and sticky workspace copies may cover the
    // canonical in-flow row while setup code retargets navigation by stable
    // worktree identity. The shared driver must still be able to select it;
    // performance scenarios use this same path after seeding long sidebars.
    await app.selectWorktree('demo-main');
    await expect(
      viewport.locator(
        '[data-sidebar-selected-item] [data-testid="worktree-row"]',
      ),
    ).toHaveAttribute('data-project-id', 'demo-ts-pnpm-vite');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

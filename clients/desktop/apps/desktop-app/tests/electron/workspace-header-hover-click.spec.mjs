import { expect, test } from '@playwright/test';
import { CanopyAppDriver, waitForStableLocator } from './canopyApp.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  createReadyWorktree,
  exerciseSidebarOrderWrite,
} from './seeders/sidebar-order-writes.mjs';

async function scrollStableLocatorIntoView(locator) {
  await expect(async () => {
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 });
  }).toPass({ timeout: 10_000 });
}

async function expectTruncatedLabelBefore(label, trailingControls) {
  await expect(async () => {
    const labelState = await label.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        clientWidth: element.clientWidth,
        overflow: style.overflow,
        right: rect.right,
        scrollWidth: element.scrollWidth,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    const trailingLeft = await trailingControls.evaluateAll((elements) =>
      Math.min(
        ...elements.map((element) => element.getBoundingClientRect().left),
      ),
    );

    expect(labelState.overflow).toBe('hidden');
    expect(labelState.whiteSpace).toBe('nowrap');
    expect(labelState.textOverflow).toBe('ellipsis');
    expect(labelState.scrollWidth).toBeGreaterThan(labelState.clientWidth);
    expect(labelState.right).toBeLessThanOrEqual(trailingLeft + 0.5);
  }).toPass({ timeout: 15_000 });
}

test('project header driver keeps canonical headers whose ids end in portal suffixes', async () => {
  const launched = await launchCanopyWithLabsPagesOffered();
  const { electronApp, userDataDir } = launched;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await window.evaluate(() => {
      const workspace = document.createElement('div');
      workspace.dataset.sidebarWorkspaceId = 'pin-top';
      const header = document.createElement('div');
      header.dataset.testid = 'sidebar-project-header-pin-top';
      header.textContent = 'Pin Top Project';
      workspace.append(header);
      document.body.append(workspace);
    });

    await expect(app.workspaceHeaderLabel('Pin Top Project')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('trailing action region never toggles, the hover chevron does, and hiding restores the counter', async () => {
  const launched = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-npm-next', 'ts-pnpm-vite', 'ts-bun-api'],
    viewportSize: { width: 1000, height: 460 },
  });
  const { electronApp, userDataDir } = launched;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const header = window.getByTestId('sidebar-project-header-demo-ts-bun-api');
    await scrollStableLocatorIntoView(header);

    // Exercise a real scrolled sidebar while this lower workspace row is
    // brought into view.
    const scrollContainer = window.getByTestId('sidebar-scroll-container');
    await expect
      .poll(() => scrollContainer.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await waitForStableLocator(window, header);
    const toggle = header.getByRole('button', {
      name: 'Collapse TypeScript Bun API',
    });
    const counter = header.getByTestId('workspace-section-counter');
    const chevron = header.getByTestId('workspace-section-collapse-chevron');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // The chevron overlays the leading icon slot (the drag handle button),
    // stays hidden at rest so the default state shows only the icon, and is
    // revealed in place of the icon on hover without reflowing the row.
    expect(
      await chevron.evaluate((node) =>
        node.closest('button')?.getAttribute('aria-label'),
      ),
    ).toBe('Reorder TypeScript Bun API');
    await window.mouse.move(900, 560);
    await expect
      .poll(() => chevron.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('0');

    // The whole row container is the disclosure hitbox: a click on the row
    // background — here the padding corner above the icon, outside every
    // control — toggles collapse and back. Collapsing can scroll-adjust the
    // sidebar, so each click re-derives the point from the header's live
    // geometry instead of reusing stale viewport coordinates.
    const clickHeaderBackground = async () => {
      await waitForStableLocator(window, header);
      // Raw mouse coordinates do not auto-scroll the way `locator.click`
      // does, and the Chats section above the project list (CAN-2363) can
      // push this header past the fold, so bring it on screen first.
      await header.scrollIntoViewIfNeeded();
      await waitForStableLocator(window, header);
      const box = await header.boundingBox();
      expect(box).not.toBeNull();
      await window.mouse.click(box.x + 4, box.y + 3);
    };
    await clickHeaderBackground();
    await expect(
      header.getByRole('button', { name: 'Expand TypeScript Bun API' }),
    ).toHaveAttribute('aria-expanded', 'false');
    await clickHeaderBackground();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await waitForStableLocator(window, header);
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();

    // Enter the row directly at a trailing coordinate that is inside the
    // revealed action overlay but NOT on a control: the gap between settings
    // and add, and the strip above them. Neither may reach the collapse
    // toggle underneath.
    await window.mouse.move(
      headerBox.x + 20,
      headerBox.y + headerBox.height / 2,
    );
    const settings = app.workspaceSettingsButton('TypeScript Bun API');
    const add = header.getByRole('button', {
      name: 'Create worktree for TypeScript Bun API',
    });
    await expect(settings).toBeVisible();
    await expect(add).toBeVisible();
    const actionOverlay = header.getByTestId('workspace-section-actions');
    const actionOverlayBox = await actionOverlay.boundingBox();
    expect(actionOverlayBox).not.toBeNull();
    expect(actionOverlayBox.y).toBeLessThanOrEqual(headerBox.y);
    expect(actionOverlayBox.y + actionOverlayBox.height).toBeGreaterThanOrEqual(
      headerBox.y + headerBox.height,
    );
    const settingsBoxForGap = await settings.boundingBox();
    const addBoxForGap = await add.boundingBox();
    expect(settingsBoxForGap).not.toBeNull();
    expect(addBoxForGap).not.toBeNull();
    const deadPoints = [
      {
        label: 'gap between settings and add',
        x: (settingsBoxForGap.x + settingsBoxForGap.width + addBoxForGap.x) / 2,
        y: headerBox.y + headerBox.height / 2,
      },
      {
        label: 'strip above the add button',
        x: addBoxForGap.x + addBoxForGap.width / 2,
        y: headerBox.y + 2,
      },
    ];
    for (const point of deadPoints) {
      await window.mouse.move(900, 560);
      await window.mouse.move(point.x, point.y);
      await window.mouse.down();
      await window.mouse.up();
      await expect(toggle, point.label).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    }

    // Hovering the icon slot swaps the icon for the chevron, and clicking the
    // swapped slot toggles collapse.
    await window.mouse.move(900, 560);
    const iconSlot = header.getByRole('button', {
      name: 'Reorder TypeScript Bun API',
    });
    const iconSlotBox = await iconSlot.boundingBox();
    expect(iconSlotBox).not.toBeNull();
    await window.mouse.move(
      iconSlotBox.x + iconSlotBox.width / 2,
      iconSlotBox.y + iconSlotBox.height / 2,
    );
    await expect
      .poll(() => chevron.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('1');

    // The rotation is an intentional exception to the sidebar's
    // instant-interaction rule (which zeroes descendant transitions): the
    // chevron must keep a real `rotate` transition so toggling a hovered row
    // turns it smoothly instead of snapping.
    const chevronTransition = await chevron.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        property: style.transitionProperty,
        duration: style.transitionDuration,
      };
    });
    expect(chevronTransition.property).toContain('rotate');
    expect(chevronTransition.duration).toBe('0.15s');

    // Reduced-motion users must not get the rotation animation: the
    // prefers-reduced-motion override matches the exception rule's
    // !important priority and zeroes it.
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() =>
        chevron.evaluate((node) => getComputedStyle(node).transitionDuration),
      )
      .toBe('0s');
    // Restore the test's explicit animated state rather than the host OS
    // preference. GitHub macOS runners can default to reduced motion, so
    // clearing the override with null makes this assertion host-dependent.
    await window.emulateMedia({ reducedMotion: 'no-preference' });
    await expect
      .poll(() =>
        chevron.evaluate((node) => getComputedStyle(node).transitionDuration),
      )
      .toBe('0.15s');

    await iconSlot.click();

    await expect(
      header.getByRole('button', {
        name: 'Expand TypeScript Bun API',
      }),
    ).toHaveAttribute('aria-expanded', 'false');

    // Moving away leaves the collapsed row in its counter-only default state
    // with NO visible chevron — the icon returns and the chevron stays
    // hover-only, pre-rotated for the next reveal.
    await window.mouse.move(900, 560);
    await expect(counter).toBeVisible();
    await expect
      .poll(() => chevron.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('0');
    expect(await chevron.getAttribute('class')).toContain('-rotate-90');

    // Moving within the row expresses intent to use a revealed action, so
    // settings remains reachable normally on the same stable row.
    await waitForStableLocator(window, header);
    const headerPoint = await window.evaluate(() => {
      const element = document.querySelector(
        '[data-testid="sidebar-project-header-demo-ts-bun-api"]',
      );
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 20, y: rect.top + rect.height / 2 };
    });
    expect(headerPoint).not.toBeNull();
    await window.mouse.move(headerPoint.x, headerPoint.y);
    const settingsBox = await settings.boundingBox();
    expect(settingsBox).not.toBeNull();
    const settingsPoint = {
      x: settingsBox.x + settingsBox.width / 2,
      y: settingsBox.y + settingsBox.height / 2,
    };
    await window.mouse.click(settingsPoint.x, settingsPoint.y);

    const alwaysShow = window.getByRole('switch', {
      name: 'Always show project',
    });
    await expect(alwaysShow).toHaveAttribute('aria-checked', 'true');
    await alwaysShow.click();
    await expect(alwaysShow).toHaveAttribute('aria-checked', 'false');
    await window.getByRole('button', { name: 'Save local' }).click();
    await expect(alwaysShow).toBeHidden();

    // The pointer is now outside the sidebar row. Saving the hide preference
    // must not leave pointer-acquired focus revealing stale actions.
    await expect(header.getByTestId('workspace-section-counter')).toBeVisible();
    await expect(settings).toBeHidden();
    await expect(
      header.getByRole('button', {
        name: 'Create worktree for TypeScript Bun API',
      }),
    ).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('long project labels stay clear of counters and hover actions in flow and sticky rows', async () => {
  const workspaceId = 'demo-ts-npm-next';
  const workspaceName = 'unstoppable-domains-website';
  const launched = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [
      'ts-pnpm-vite',
      'ts-npm-next',
      'ts-bun-api',
      'ts-yarn-cli',
      'go-cli',
    ],
    viewportSize: { width: 900, height: 520 },
  });
  const { electronApp, userDataDir } = launched;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await window.evaluate(
      async ({ targetId, targetName }) => {
        const loaded = await window.api.loadProjects();
        const ordered = [...loaded.items].sort((a, b) => a.order - b.order);
        const targetIndex = ordered.findIndex((item) => item.id === targetId);
        if (targetIndex < 0) {
          throw new Error(`Expected seeded project ${targetId}`);
        }
        const [target] = ordered.splice(targetIndex, 1);
        ordered.unshift({ ...target, name: targetName });
        await window.api.saveProjects(
          ordered.map((item, order) => ({ ...item, order })),
          { replaceWorkspaceOrder: true },
        );
      },
      { targetId: workspaceId, targetName: workspaceName },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });

    const sidebar = window.getByTestId('app-sidebar');
    const resizeHandle = window.getByTestId('sidebar-resize-handle');
    const resizeBox = await resizeHandle.boundingBox();
    expect(resizeBox).not.toBeNull();
    await window.mouse.move(
      resizeBox.x + resizeBox.width / 2,
      resizeBox.y + resizeBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(100, resizeBox.y + resizeBox.height / 2);
    await window.mouse.up();
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
      .toBe(220);

    const sidebarScrollContainer = sidebar.getByTestId(
      'sidebar-scroll-container',
    );
    const flowHeader = sidebarScrollContainer.getByTestId(
      `sidebar-project-header-${workspaceId}`,
    );
    const flowStickyWrapper = flowHeader.locator(
      'xpath=ancestor::div[contains(@class,"sidebar-workspace-sticky-header")][1]',
    );
    // The renamed target is first in workspace order and fits in the taller
    // viewport without scrolling. Exercise that deterministic flow state at
    // the top of the rail: geometry-based repositioning can cross the sticky
    // handoff band on CI and legitimately replace this row with the slot copy.
    await sidebarScrollContainer.evaluate(async (scrollContainer) => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await waitForStableLocator(window, flowHeader);
    await expect(flowStickyWrapper).not.toHaveAttribute(
      'data-sidebar-sticky-flow-hidden',
      'true',
    );
    const flowLabel = flowHeader.locator(`span[title="${workspaceName}"]`);
    const flowCounter = flowHeader.getByTestId('workspace-section-counter');
    await expect(flowHeader).toBeVisible();
    await expect(flowCounter).toBeVisible();
    await expectTruncatedLabelBefore(flowLabel, flowCounter);

    const flowToggle = flowHeader.getByRole('button', {
      name: `Collapse ${workspaceName}`,
    });
    const flowSettings = flowHeader.getByRole('button', {
      name: `Settings for ${workspaceName}`,
    });
    const flowAdd = flowHeader.getByRole('button', {
      name: `Create worktree for ${workspaceName}`,
    });
    const flowActions = flowHeader.locator(
      `button[aria-label="Settings for ${workspaceName}"], button[aria-label="Create worktree for ${workspaceName}"]`,
    );

    const flowLabelBox = await flowLabel.boundingBox();
    expect(flowLabelBox).not.toBeNull();
    await window.mouse.move(
      flowLabelBox.x + flowLabelBox.width / 2,
      flowLabelBox.y + flowLabelBox.height / 2,
    );
    await expect(flowSettings).toBeVisible();
    await expect(flowAdd).toBeVisible();
    await expectTruncatedLabelBefore(flowLabel, flowActions);

    await expect(flowHeader).toBeVisible();
    await window.mouse.move(700, 300);
    await flowToggle.evaluate((element) =>
      element.focus({ preventScroll: true }),
    );
    await expect(flowSettings).toBeVisible();
    await expect(flowAdd).toBeVisible();
    await expectTruncatedLabelBefore(flowLabel, flowActions);
    await flowToggle.blur();

    // Constrain the rail before exercising the pinned copy. At the taller
    // flow geometry the target row is genuinely visible above the account
    // footer; the short geometry below forces the same row into the sticky
    // slot instead of asking an offscreen flow row to expose hover actions.
    await window.setViewportSize({ width: 900, height: 340 });
    await waitForStableLocator(window, flowHeader);

    await flowHeader.evaluate(async (header) => {
      const scrollContainer = header.closest(
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
      if (!Number.isFinite(workspaceHeaderTop)) {
        throw new Error('Expected measured project header offset');
      }
      const stickyLine =
        scrollContainer.getBoundingClientRect().top + workspaceHeaderTop;
      scrollContainer.scrollTop +=
        header.getBoundingClientRect().top - stickyLine + 1;
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const stickySlot = window.getByTestId('sidebar-sticky-workspace-slot');
    await expect(stickySlot).toHaveAttribute(
      'data-active-workspace-id',
      workspaceId,
    );
    await expect(flowStickyWrapper).toHaveAttribute(
      'data-sidebar-sticky-flow-hidden',
      'true',
    );

    const stickyHeader = window.getByTestId(
      `sidebar-project-header-${workspaceId}-sticky-slot`,
    );
    const stickyLabel = stickyHeader.locator(`span[title="${workspaceName}"]`);
    // The slot copy suffixes its inner ids (CAN-3127).
    const stickyCounter = stickyHeader.getByTestId(
      'workspace-section-counter-sticky-slot',
    );
    await expect(stickyHeader).toBeVisible();
    await expect(stickyCounter).toBeVisible();
    await expectTruncatedLabelBefore(stickyLabel, stickyCounter);

    const stickySettings = stickyHeader.locator(
      `button[aria-label="Settings for ${workspaceName}"]`,
    );
    const stickyAdd = stickyHeader.locator(
      `button[aria-label="Create worktree for ${workspaceName}"]`,
    );
    const stickyActions = stickyHeader.locator(
      `button[aria-label="Settings for ${workspaceName}"], button[aria-label="Create worktree for ${workspaceName}"]`,
    );
    const stickyLabelBox = await stickyLabel.boundingBox();
    expect(stickyLabelBox).not.toBeNull();
    await window.mouse.move(
      stickyLabelBox.x + stickyLabelBox.width / 2,
      stickyLabelBox.y + stickyLabelBox.height / 2,
    );
    await expect(stickySettings).toBeVisible();
    await expect(stickyAdd).toBeVisible();
    await expectTruncatedLabelBefore(stickyLabel, stickyActions);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('project drag matches expanded child-row geometry in rest and sticky states', async () => {
  const sourceId = 'demo-ts-pnpm-vite';
  const targetId = 'demo-ts-npm-next';
  const launched = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [
      'ts-pnpm-vite',
      'ts-npm-next',
      'ts-bun-api',
      'ts-yarn-cli',
      'go-cli',
    ],
    viewportSize: { width: 900, height: 620 },
  });
  const { electronApp, userDataDir } = launched;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await window.evaluate(
      async ({ sourceId }) => {
        const loaded = await window.api.loadProjects();
        const source = loaded.items.find((item) => item.id === sourceId);
        if (
          !source ||
          source.type === 'cowork' ||
          source.worktrees.length === 0
        ) {
          throw new Error(`Expected seeded code project ${sourceId}`);
        }
        source.collapsed = false;
        source.itemSortMode = 'manual';
        await window.api.saveProjects(loaded.items, {
          replaceWorkspaceOrder: true,
        });
      },
      { sourceId },
    );
    await createReadyWorktree(window, sourceId, 'feature/drag-parity-second');
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });

    const sidebar = window.getByTestId('app-sidebar');
    const resizeHandle = window.getByTestId('sidebar-resize-handle');
    const resizeBox = await resizeHandle.boundingBox();
    expect(resizeBox).not.toBeNull();
    await window.mouse.move(
      resizeBox.x + resizeBox.width / 2,
      resizeBox.y + resizeBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(100, resizeBox.y + resizeBox.height / 2);
    await window.mouse.up();
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
      .toBe(220);

    const viewport = window.getByTestId('sidebar-scroll-container');
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const sourceWorkspace = window.locator(
      `[data-sidebar-workspace-id="${sourceId}"]`,
    );
    const targetWorkspace = window.locator(
      `[data-sidebar-workspace-id="${targetId}"]`,
    );
    const sourceHeader = window.getByTestId(
      `sidebar-project-sortable-header-${sourceId}`,
    );
    const targetHeader = window.getByTestId(
      `sidebar-project-sortable-header-${targetId}`,
    );
    const sourceLabel = sourceHeader.locator(
      'button[data-workspace-drag-activator="label"]',
    );
    const sourceIcon = sourceHeader.getByRole('button', {
      name: 'Reorder TypeScript pnpm Vite',
    });
    const sourceSettings = sourceHeader.locator(
      'button[aria-label="Settings for TypeScript pnpm Vite"]',
    );
    const sourceAdd = sourceHeader.locator(
      'button[aria-label="Create worktree for TypeScript pnpm Vite"]',
    );
    const sourceChildren = sourceWorkspace.locator(
      '[data-sidebar-folder-content="code-workspace"]',
    );
    const sourceChildRow = sourceChildren
      .locator('[data-testid="worktree-row"]')
      .first();
    const targetChildRow = sourceChildren
      .locator('[data-testid="worktree-row"]')
      .nth(1);
    // The shared rail renders from its first session snapshot, which can land
    // after the resize above; measure only once both projects are on screen.
    await expect(sourceHeader).toBeVisible();
    await expect(targetHeader).toBeVisible();

    const restGeometry = await window.evaluate(
      ({ sourceId, targetId }) => {
        const sourceWorkspace = document.querySelector(
          `[data-sidebar-workspace-id="${sourceId}"]`,
        );
        const sourceHeader = document.querySelector(
          `[data-testid="sidebar-project-sortable-header-${sourceId}"]`,
        );
        const targetWorkspace = document.querySelector(
          `[data-sidebar-workspace-id="${targetId}"]`,
        );
        const targetHeader = document.querySelector(
          `[data-testid="sidebar-project-sortable-header-${targetId}"]`,
        );
        if (
          !(sourceWorkspace instanceof HTMLElement) ||
          !(sourceHeader instanceof HTMLElement) ||
          !(targetWorkspace instanceof HTMLElement) ||
          !(targetHeader instanceof HTMLElement)
        ) {
          throw new Error('Expected project drag geometry');
        }
        return {
          sourceHeader: sourceHeader.getBoundingClientRect().toJSON(),
          sourceWorkspace: sourceWorkspace.getBoundingClientRect().toJSON(),
          targetHeader: targetHeader.getBoundingClientRect().toJSON(),
          targetWorkspace: targetWorkspace.getBoundingClientRect().toJSON(),
        };
      },
      { sourceId, targetId },
    );
    expect(restGeometry.sourceHeader.height).toBe(32);
    expect(restGeometry.targetHeader.height).toBe(32);
    expect(restGeometry.sourceWorkspace.height).toBeGreaterThan(32);
    expect(restGeometry.targetWorkspace.height).toBeGreaterThan(32);
    await expect(sourceChildren).toBeVisible();
    await expect(sourceIcon).toHaveAttribute(
      'data-workspace-drag-activator',
      'icon',
    );
    await expect(sourceLabel).toHaveAttribute(
      'data-workspace-drag-activator',
      'label',
    );
    await expect(sourceSettings).not.toHaveAttribute(
      'data-workspace-drag-activator',
      /.+/,
    );
    await expect(sourceAdd).not.toHaveAttribute(
      'data-workspace-drag-activator',
      /.+/,
    );
    await expect
      .poll(() => sourceLabel.evaluate((node) => getComputedStyle(node).cursor))
      .toBe('default');
    await expect
      .poll(() => sourceIcon.evaluate((node) => getComputedStyle(node).cursor))
      .toBe('default');
    await expect
      .poll(() =>
        sourceChildRow.evaluate((node) => getComputedStyle(node).cursor),
      )
      .toBe('default');
    await expect(sourceSettings).toBeEnabled();
    await expect(sourceAdd).toBeEnabled();

    const startLabelDrag = async () => {
      await waitForStableLocator(window, sourceHeader);
      await expect(sourceLabel).toBeVisible();
      const labelBox = await sourceLabel.boundingBox();
      expect(labelBox).not.toBeNull();
      const start = {
        x: labelBox.x + labelBox.width / 2,
        y: labelBox.y + labelBox.height / 2,
      };
      await window.mouse.move(start.x, start.y);
      await window.mouse.down();
      await window.mouse.move(start.x, start.y + 7);
      await expect(window.getByTestId('workspace-drag-overlay')).toBeVisible();
      return start;
    };

    const labelStart = await startLabelDrag();
    const activationFrame = await window.evaluate(
      ({ sourceId, targetId, pointer }) => {
        const sourceWorkspace = document.querySelector(
          `[data-sidebar-workspace-id="${sourceId}"]`,
        );
        const sourceHeader = document.querySelector(
          `[data-testid="sidebar-project-sortable-header-${sourceId}"]`,
        );
        const targetWorkspace = document.querySelector(
          `[data-sidebar-workspace-id="${targetId}"]`,
        );
        const overlay = document.querySelector(
          '[data-testid="workspace-drag-overlay"]',
        );
        const child = sourceWorkspace?.querySelector(
          '[data-testid="worktree-row"]',
        );
        if (
          !(sourceWorkspace instanceof HTMLElement) ||
          !(sourceHeader instanceof HTMLElement) ||
          !(targetWorkspace instanceof HTMLElement) ||
          !(overlay instanceof HTMLElement) ||
          !(child instanceof HTMLElement)
        ) {
          throw new Error('Expected active project drag frame');
        }
        const headerRect = sourceHeader.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        const overlayStyle = getComputedStyle(overlay);
        return {
          childOpacity: getComputedStyle(child).opacity,
          overlay: {
            backgroundColor: overlayStyle.backgroundColor,
            borderRadius: overlayStyle.borderRadius,
            boxShadow: overlayStyle.boxShadow,
            cursor: overlayStyle.cursor,
            opacity: overlayStyle.opacity,
            rect: overlayRect.toJSON(),
            scale: overlayStyle.scale,
          },
          pointerOffset: {
            x: pointer.x - overlayRect.left,
            y: pointer.y + 7 - overlayRect.top,
          },
          sourceHeader: {
            iconCursor: getComputedStyle(
              sourceHeader.querySelector(
                '[data-workspace-drag-activator="icon"]',
              ),
            ).cursor,
            labelCursor: getComputedStyle(
              sourceHeader.querySelector(
                '[data-workspace-drag-activator="label"]',
              ),
            ).cursor,
            opacity: getComputedStyle(sourceHeader).opacity,
            rect: headerRect.toJSON(),
            transform: getComputedStyle(sourceHeader).transform,
          },
          sourceWorkspace: {
            opacity: getComputedStyle(sourceWorkspace).opacity,
            transform: getComputedStyle(sourceWorkspace).transform,
          },
          targetTransform: getComputedStyle(targetWorkspace).transform,
        };
      },
      { sourceId, targetId, pointer: labelStart },
    );
    expect(activationFrame.sourceHeader.opacity).toBe('0.6');
    expect(activationFrame.sourceHeader.rect.height).toBe(32);
    expect(activationFrame.sourceWorkspace.opacity).toBe('1');
    expect(activationFrame.sourceWorkspace.transform).toBe('none');
    expect(activationFrame.targetTransform).toBe('none');
    expect(activationFrame.childOpacity).toBe('1');
    expect(activationFrame.overlay.rect.height).toBe(32);
    expect(activationFrame.overlay.rect.width).toBeCloseTo(
      activationFrame.sourceHeader.rect.width,
      1,
    );
    expect(activationFrame.overlay.rect.x).toBeCloseTo(
      activationFrame.sourceHeader.rect.x + 4,
      1,
    );
    expect(activationFrame.overlay.borderRadius).toBe('10px');
    expect(activationFrame.overlay.cursor).toBe('default');
    expect(activationFrame.overlay.opacity).toBe('1');
    expect(activationFrame.overlay.scale).toBe('none');
    expect(activationFrame.overlay.backgroundColor).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(activationFrame.overlay.boxShadow).not.toBe('none');
    expect(activationFrame.sourceHeader.iconCursor).toBe('default');
    expect(activationFrame.sourceHeader.labelCursor).toBe('default');

    const targetBox = await targetHeader.boundingBox();
    expect(targetBox).not.toBeNull();
    await window.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + targetBox.height / 2,
    );
    const previewFrame = await window.evaluate(
      async ({ sourceId, targetId }) => {
        for (let frame = 0; frame < 20; frame += 1) {
          const sourceWorkspace = document.querySelector(
            `[data-sidebar-workspace-id="${sourceId}"]`,
          );
          const targetWorkspace = document.querySelector(
            `[data-sidebar-workspace-id="${targetId}"]`,
          );
          const indicator = targetWorkspace?.querySelector(
            '[data-testid="workspace-drop-indicator"]',
          );
          const overlay = document.querySelector(
            '[data-testid="workspace-drag-overlay"]',
          );
          if (
            sourceWorkspace instanceof HTMLElement &&
            targetWorkspace instanceof HTMLElement &&
            indicator instanceof HTMLElement &&
            overlay instanceof HTMLElement
          ) {
            return {
              indicator: indicator.getBoundingClientRect().toJSON(),
              position: indicator.dataset.dropPosition,
              sourceTransform: getComputedStyle(sourceWorkspace).transform,
              targetTransform: getComputedStyle(targetWorkspace).transform,
              target: targetWorkspace.getBoundingClientRect().toJSON(),
            };
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        throw new Error('Expected static project reorder preview');
      },
      { sourceId, targetId },
    );
    expect(previewFrame.sourceTransform).toBe('none');
    expect(previewFrame.targetTransform).toBe('none');
    expect(previewFrame.position).toBe('after');
    expect(previewFrame.indicator.height).toBe(2);
    expect(previewFrame.indicator.bottom).toBeCloseTo(
      previewFrame.target.bottom + 1,
      1,
    );

    await window.keyboard.press('Escape');
    await window.mouse.up();
    await expect(window.getByTestId('workspace-drag-overlay')).toHaveCount(0);
    await expect(window.getByTestId('workspace-drop-indicator')).toHaveCount(0);
    await expect(sourceHeader).not.toHaveClass(/opacity-60/);
    await expect(sourceChildren).toBeVisible();
    expect(
      await sourceLabel.evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('default');
    expect(
      await sourceIcon.evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('default');
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );

    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    await sourceLabel.click();
    await expect(sourceLabel).toHaveAttribute('aria-expanded', 'false');
    const collapsedGeometry = await window.evaluate((sourceId) => {
      const workspace = document.querySelector(
        `[data-sidebar-workspace-id="${sourceId}"]`,
      );
      const header = document.querySelector(
        `[data-testid="sidebar-project-sortable-header-${sourceId}"]`,
      );
      if (
        !(workspace instanceof HTMLElement) ||
        !(header instanceof HTMLElement)
      ) {
        throw new Error('Expected collapsed project geometry');
      }
      return {
        header: header.getBoundingClientRect().toJSON(),
        workspace: workspace.getBoundingClientRect().toJSON(),
      };
    }, sourceId);
    expect(collapsedGeometry.header.height).toBe(32);
    expect(collapsedGeometry.workspace.height).toBe(32);
    await sourceLabel.click();
    await expect(sourceLabel).toHaveAttribute('aria-expanded', 'true');

    const flowHeader = window.getByTestId(`sidebar-project-header-${sourceId}`);
    await flowHeader.evaluate(async (header) => {
      const scrollContainer = header.closest(
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
      if (!Number.isFinite(workspaceHeaderTop)) {
        throw new Error('Expected measured project header offset');
      }
      const stickyLine =
        scrollContainer.getBoundingClientRect().top + workspaceHeaderTop;
      scrollContainer.scrollTop +=
        header.getBoundingClientRect().top - stickyLine + 1;
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const stickySlot = window.getByTestId('sidebar-sticky-workspace-slot');
    await expect(stickySlot).toHaveAttribute(
      'data-active-workspace-id',
      sourceId,
    );
    const stickyHeader = window.getByTestId(
      `sidebar-project-sortable-header-${sourceId}-sticky-slot`,
    );
    const stickyLabel = stickyHeader.getByRole('button', {
      name: 'Collapse TypeScript pnpm Vite',
    });
    // The band must not shift while a sticky header is dragged. The slot IS
    // the band's own surface, and is a stabler reference than the rule that
    // used to sit under it (removed: the painted band is its own edge).
    const slotBefore = await stickySlot.boundingBox();
    expect(slotBefore).not.toBeNull();
    expect(
      await stickyLabel.evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('default');

    const stickyLabelBox = await stickyLabel.boundingBox();
    expect(stickyLabelBox).not.toBeNull();
    await window.mouse.move(
      stickyLabelBox.x + stickyLabelBox.width / 2,
      stickyLabelBox.y + stickyLabelBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      stickyLabelBox.x + stickyLabelBox.width / 2,
      stickyLabelBox.y + stickyLabelBox.height / 2 + 7,
    );
    await expect(window.getByTestId('workspace-drag-overlay')).toBeVisible();
    await expect(stickySlot).toBeVisible();
    await expect(stickyHeader).toHaveClass(/opacity-60/);
    await expect(sourceWorkspace).not.toHaveClass(/opacity-0/);
    await expect(sourceChildren).toBeVisible();
    const stickyDragFrame = await window.evaluate(
      ({ sourceId }) => {
        const slot = document.querySelector(
          '[data-testid="sidebar-sticky-workspace-slot"]',
        );
        const overlay = document.querySelector(
          '[data-testid="workspace-drag-overlay"]',
        );
        const source = document.querySelector(
          `[data-testid="sidebar-project-sortable-header-${sourceId}-sticky-slot"] [data-workspace-drag-activator="label"]`,
        );
        if (
          !(slot instanceof HTMLElement) ||
          !(overlay instanceof HTMLElement) ||
          !(source instanceof HTMLElement)
        ) {
          throw new Error('Expected sticky project drag geometry');
        }
        return {
          slotRect: slot.getBoundingClientRect().toJSON(),
          overlayCursor: getComputedStyle(overlay).cursor,
          sourceCursor: getComputedStyle(source).cursor,
          slotVisibility: getComputedStyle(slot).visibility,
        };
      },
      { sourceId },
    );
    expect(stickyDragFrame.slotVisibility).toBe('visible');
    expect(stickyDragFrame.overlayCursor).toBe('default');
    expect(stickyDragFrame.sourceCursor).toBe('default');
    for (const dimension of ['x', 'y', 'width', 'height']) {
      expect(stickyDragFrame.slotRect[dimension]).toBeCloseTo(
        slotBefore[dimension],
        1,
      );
    }
    await window.keyboard.press('Escape');
    await window.mouse.up();
    await expect(window.getByTestId('workspace-drag-overlay')).toHaveCount(0);
    await expect(stickyHeader).not.toHaveClass(/opacity-60/);
    await expect(stickySlot).toBeVisible();
    expect(
      await stickyLabel.evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('default');

    await window.emulateMedia({ reducedMotion: 'reduce' });
    await stickyHeader
      .getByRole('button', { name: 'Reorder TypeScript pnpm Vite' })
      .focus();
    await window.keyboard.press('Space');
    await expect(window.getByTestId('workspace-drag-overlay')).toBeVisible();
    const reducedMotionFrame = await window.evaluate(
      ({ sourceId, targetId }) => {
        const source = document.querySelector(
          `[data-testid="sidebar-project-sortable-header-${sourceId}-sticky-slot"]`,
        );
        const target = document.querySelector(
          `[data-sidebar-workspace-id="${targetId}"]`,
        );
        if (
          !(source instanceof HTMLElement) ||
          !(target instanceof HTMLElement)
        ) {
          throw new Error('Expected reduced-motion drag nodes');
        }
        return {
          sourceTransition: getComputedStyle(source).transitionDuration,
          targetTransform: getComputedStyle(target).transform,
        };
      },
      { sourceId, targetId },
    );
    expect(reducedMotionFrame.sourceTransition).toBe('0s');
    expect(reducedMotionFrame.targetTransform).toBe('none');
    expect(
      await window
        .getByTestId('workspace-drag-overlay')
        .evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('default');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('workspace-drag-overlay')).toHaveCount(0);

    // A keyboard drag never produces the synthetic click that consumes the
    // post-drag click guard, so the guard must not swallow the next keyboard
    // activation: the FIRST Enter on the collapse toggle has to toggle.
    await stickyHeader
      .getByRole('button', { name: 'Collapse TypeScript pnpm Vite' })
      .focus();
    await window.keyboard.press('Enter');
    await expect(sourceLabel).toHaveAttribute('aria-expanded', 'false');
    // Collapsing can switch the active sticky header. Bring the canonical
    // header back into view before reopening it for the final drag.
    await sourceHeader.scrollIntoViewIfNeeded();
    await waitForStableLocator(window, sourceHeader);
    await sourceLabel.focus();
    await window.keyboard.press('Enter');
    await expect(sourceLabel).toHaveAttribute('aria-expanded', 'true');

    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const finalStart = await startLabelDrag();
    const finalTargetBox = await targetHeader.boundingBox();
    expect(finalTargetBox).not.toBeNull();
    await window.mouse.move(
      finalTargetBox.x + finalTargetBox.width / 2,
      finalTargetBox.y + finalTargetBox.height / 2,
    );
    await expect(
      targetWorkspace.getByTestId('workspace-drop-indicator'),
    ).toBeVisible();
    await window.mouse.up();
    const finalFrame = await window.evaluate(
      ({ sourceId, targetId, finalStart }) => {
        return {
          finalStart,
          indicatorCount: document.querySelectorAll(
            '[data-testid="workspace-drop-indicator"]',
          ).length,
          overlayCount: document.querySelectorAll(
            '[data-testid="workspace-drag-overlay"]',
          ).length,
          sourceDraggingCount: document.querySelectorAll(
            `[data-sidebar-workspace-sortable-header="${sourceId}"][data-sidebar-workspace-source-dragging="true"]`,
          ).length,
          targetId,
        };
      },
      { sourceId, targetId, finalStart },
    );
    expect(finalFrame.overlayCount).toBe(0);
    expect(finalFrame.indicatorCount).toBe(0);
    expect(finalFrame.sourceDraggingCount).toBe(0);
    expect(
      await sourceLabel.evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('default');
    // The drop reorders the renderer's store at once, but main applies the
    // save asynchronously, in its project-write queue, and a load is not
    // ordered after it; the shared rail re-renders from the next session
    // snapshot. Read both until they settle: a single read right after the
    // drop can still see the old order, and an icon measured before the rail
    // moves the source is pressed at its old position.
    await expect
      .poll(() =>
        window.evaluate(
          async ({ sourceId, targetId }) => {
            const loaded = await window.api.loadProjects();
            const order = [...loaded.items]
              .sort((a, b) => a.order - b.order)
              .map((item) => item.id);
            return order.indexOf(sourceId) - order.indexOf(targetId);
          },
          { sourceId, targetId },
        ),
      )
      .toBe(1);
    await expect
      .poll(() =>
        window.evaluate(
          ({ sourceId, targetId }) => {
            const order = Array.from(
              document.querySelectorAll('[data-sidebar-workspace-id]'),
              (node) => node.getAttribute('data-sidebar-workspace-id'),
            );
            return order.indexOf(sourceId) - order.indexOf(targetId);
          },
          { sourceId, targetId },
        ),
      )
      .toBe(1);
    await waitForStableLocator(window, sourceHeader);

    await sourceHeader.scrollIntoViewIfNeeded();
    await waitForStableLocator(window, sourceHeader);
    await expect(sourceLabel).toHaveAttribute('aria-expanded', 'true');
    const iconBox = await sourceIcon.boundingBox();
    expect(iconBox).not.toBeNull();
    await window.mouse.move(
      iconBox.x + iconBox.width / 2,
      iconBox.y + iconBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      iconBox.x + iconBox.width / 2,
      iconBox.y + iconBox.height / 2 + 7,
    );
    await expect(window.getByTestId('workspace-drag-overlay')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('workspace-drag-overlay')).toHaveCount(0);
    // Release the way a person does, well after the cancel: past dnd-kit's
    // 50 ms post-drag click blocker. The release's click lands on the icon it
    // pressed and must not collapse the project whose drag was cancelled.
    await window.waitForTimeout(150);
    await window.mouse.up();
    await expect(sourceLabel).toHaveAttribute('aria-expanded', 'true');
    await expect(sourceChildren).toBeVisible();

    const childLabel = sourceChildRow.getByTestId('worktree-row-title');
    // Centre the drop target. `scrollIntoViewIfNeeded` leaves a row that is
    // already fully visible where it is, which can be flush with the bottom
    // of the list: the drag then ends in the auto-scroll zone, the list
    // scrolls away under the pointer, and no drop indicator shows.
    await targetChildRow.evaluate((node) =>
      node.scrollIntoView({ block: 'center' }),
    );
    await waitForStableLocator(window, targetChildRow);
    await waitForStableLocator(window, childLabel);
    const childLabelBox = await childLabel.boundingBox();
    const targetChildBox = await targetChildRow.boundingBox();
    expect(childLabelBox).not.toBeNull();
    expect(targetChildBox).not.toBeNull();
    const sourceWorktreeId =
      await sourceChildRow.getAttribute('data-worktree-id');
    const targetWorktreeId =
      await targetChildRow.getAttribute('data-worktree-id');
    expect(sourceWorktreeId).toBeTruthy();
    expect(targetWorktreeId).toBeTruthy();
    await window.mouse.move(
      childLabelBox.x + childLabelBox.width / 2,
      childLabelBox.y + childLabelBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      childLabelBox.x + childLabelBox.width / 2 + 12,
      childLabelBox.y + childLabelBox.height / 2,
      { steps: 4 },
    );
    const childOverlay = window.getByTestId('sidebar-item-group-drag-overlay');
    await expect(childOverlay).toBeVisible();
    // A worktree row keeps the arrow cursor at rest and switches to the
    // grabbing cursor only while its own drag is in progress (CAN-3053,
    // #4127); the project header drag above stays on the arrow cursor.
    expect(
      await sourceChildRow.evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('grabbing');
    expect(
      await childOverlay.evaluate((node) => getComputedStyle(node).cursor),
    ).toBe('default');
    await window.mouse.move(
      targetChildBox.x + targetChildBox.width / 2,
      targetChildBox.y + targetChildBox.height * 0.75,
      { steps: 12 },
    );
    await expect(
      window.getByTestId('sidebar-item-group-drop-indicator'),
    ).toBeVisible();
    await window.mouse.up();
    await expect(childOverlay).toHaveCount(0);
    await expect
      .poll(() =>
        window.evaluate(
          async ({ sourceId }) => {
            const loaded = await window.api.loadProjects();
            return loaded.items
              .find((item) => item.id === sourceId)
              ?.worktrees.map((worktree) => worktree.id);
          },
          { sourceId },
        ),
      )
      .toEqual([targetWorktreeId, sourceWorktreeId]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const snapshotFirst of [false, true]) {
  test(`worktree drag survives an unrelated snapshot save ${snapshotFirst ? 'before' : 'after'} reorder and reload`, async () => {
    const launched = await launchCanopyWithLabsPagesOffered({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
      viewportSize: { width: 1000, height: 700 },
    });
    try {
      const window = await launched.electronApp.firstWindow();
      const result = await exerciseSidebarOrderWrite(window, snapshotFirst);
      expect(result.finalIds).toEqual(result.reorderedIds);
      await expect(
        result.workspace.locator('[data-testid="worktree-row"]'),
      ).toHaveCount(2);
      await expect(
        result.workspace.locator('[data-testid="worktree-row"]').first(),
      ).toHaveAttribute('data-worktree-id', result.reorderedIds[0]);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
  });
}

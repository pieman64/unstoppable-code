import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const DEMO_APPS = [
  'ts-pnpm-vite',
  'ts-npm-next',
  'ts-bun-api',
  'ts-yarn-cli',
  'go-cli',
];

async function settleStartupScroll(viewport) {
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
      if (performance.now() - stableSince >= 1_000) break;
    }
    if (performance.now() - stableSince < 1_000) {
      throw new Error('Startup sidebar scroll did not settle');
    }
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

async function useScrollOnlyScrollbarBehavior(window) {
  await window.evaluate(() => {
    document.documentElement.dataset.scrollbarBehavior = 'scroll';
  });
  await expect
    .poll(() =>
      window.evaluate(() => document.documentElement.dataset.scrollbarBehavior),
    )
    .toBe('scroll');
}

async function readRailState(scrollbar) {
  return scrollbar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const style = getComputedStyle(element);
    return {
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
      railReceivesHit: hit === element || element.contains(hit),
    };
  });
}

async function dispatchWheelAndObserveReveal(viewport) {
  return viewport.evaluate((element) => {
    const rail = element.parentElement?.querySelector(
      '[data-sidebar-scrollbar]',
    );
    if (!(rail instanceof HTMLElement)) {
      throw new Error('Expected sidebar scrollbar rail');
    }

    return new Promise((resolve) => {
      let timeoutId;
      const finish = (revealed) => {
        mutationObserver.disconnect();
        window.clearTimeout(timeoutId);
        resolve(revealed);
      };
      const observeReveal = () => {
        if (rail.classList.contains('opacity-100')) finish(true);
      };
      const mutationObserver = new MutationObserver(observeReveal);
      mutationObserver.observe(rail, {
        attributes: true,
        attributeFilter: ['class'],
      });
      timeoutId = window.setTimeout(() => finish(false), 2_000);
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 60,
        }),
      );
      observeReveal();
    });
  });
}

test('sidebar scrollbar is inert while idle, reveals on wheel input, and stays pinned while hovered', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: DEMO_APPS,
    viewportSize: { width: 900, height: 500 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const viewport = window.getByTestId('sidebar-scroll-container');
    const scrollbar = window.locator(
      '[data-testid="app-sidebar"] [data-sidebar-scrollbar]',
    );
    await useScrollOnlyScrollbarBehavior(window);
    // The rail only has something to scroll once the seeded projects load;
    // until then "Loading projects" fits and a wheel has nothing to reveal.
    await expect(window.locator('[data-sidebar-workspace-id]')).toHaveCount(
      DEMO_APPS.length,
      { timeout: 30_000 },
    );
    await expect
      .poll(() =>
        viewport.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await settleStartupScroll(viewport);

    await expect
      .poll(() => readRailState(scrollbar))
      .toEqual({
        opacity: 0,
        pointerEvents: 'none',
        railReceivesHit: false,
      });

    const viewportBox = await viewport.boundingBox();
    if (!viewportBox) throw new Error('Expected sidebar viewport geometry');
    await window.mouse.move(
      viewportBox.x + viewportBox.width / 2,
      viewportBox.y + viewportBox.height / 2,
    );
    await window.mouse.wheel(0, 120);
    await expect
      .poll(async () => (await readRailState(scrollbar)).opacity)
      .toBe(1);

    const railBox = await scrollbar.boundingBox();
    if (!railBox) throw new Error('Expected sidebar scrollbar geometry');
    await window.mouse.wheel(0, 20);
    await window.mouse.move(
      railBox.x + railBox.width / 2,
      railBox.y + railBox.height / 2,
    );
    await window.waitForTimeout(1_200);
    expect(await readRailState(scrollbar)).toEqual({
      opacity: 1,
      pointerEvents: 'auto',
      railReceivesHit: true,
    });

    await window.mouse.move(railBox.x - 200, railBox.y + railBox.height / 2);
    await expect
      .poll(() => readRailState(scrollbar))
      .toEqual({
        opacity: 0,
        pointerEvents: 'none',
        railReceivesHit: false,
      });
    await window.mouse.move(
      railBox.x + railBox.width / 2,
      railBox.y + railBox.height / 2,
    );
    await window.waitForTimeout(400);
    expect(await readRailState(scrollbar)).toEqual({
      opacity: 0,
      pointerEvents: 'none',
      railReceivesHit: false,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('creating sidebar overflow stays silent until direct wheel input', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: DEMO_APPS,
    viewportSize: { width: 900, height: 520 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const viewport = window.getByTestId('sidebar-scroll-container');
    const scrollbar = window.locator(
      '[data-testid="app-sidebar"] [data-sidebar-scrollbar]',
    );
    await useScrollOnlyScrollbarBehavior(window);
    await settleStartupScroll(viewport);

    const workspaces = viewport.locator('[data-workspace-expanded]');
    // Only the demo projects: the default cowork workspace renders in the
    // Chats section and carries no `data-workspace-expanded` (CAN-2363).
    await expect(workspaces).toHaveCount(DEMO_APPS.length);
    await expect(viewport.getByTestId('worktree-row')).toHaveCount(
      DEMO_APPS.length,
    );

    const expanded = viewport.locator('[data-workspace-expanded="true"]');
    while ((await expanded.count()) > 0) {
      const expandedCount = await expanded.count();
      await expanded
        .first()
        .locator('button[aria-expanded="true"]')
        .first()
        .click();
      await expect(expanded).toHaveCount(expandedCount - 1);
    }

    const readMetrics = () =>
      viewport.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
    let metrics = await readMetrics();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (metrics.scrollHeight <= metrics.clientHeight + 1) break;
      const size = window.viewportSize();
      if (!size) throw new Error('Expected an emulated viewport size');
      await window.setViewportSize({
        width: size.width,
        height: size.height + metrics.scrollHeight - metrics.clientHeight + 40,
      });
      await window.waitForTimeout(200);
      metrics = await readMetrics();
    }
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);

    const collapsed = viewport.locator('[data-workspace-expanded="false"]');
    await expect(collapsed).toHaveCount(DEMO_APPS.length);
    await collapsed
      .first()
      .locator('button[aria-expanded="false"]')
      .first()
      .click();
    await expect(expanded).toHaveCount(1);
    await expect
      .poll(async () => {
        const current = await readMetrics();
        return current.scrollHeight > current.clientHeight + 1;
      })
      .toBe(true);

    // Point-in-time probes catch a reintroduced overflow flash instead of
    // allowing a retrying assertion to wait for that flash to disappear.
    await window.waitForTimeout(250);
    expect(await readRailState(scrollbar)).toEqual({
      opacity: 0,
      pointerEvents: 'none',
      railReceivesHit: false,
    });
    await window.waitForTimeout(250);
    expect(await readRailState(scrollbar)).toEqual({
      opacity: 0,
      pointerEvents: 'none',
      railReceivesHit: false,
    });

    // Observe the real class transition in the renderer event loop. A driver-
    // side poll can miss the 600ms reveal window when a contended CI runner
    // takes longer than that to service its first evaluate request.
    expect(await dispatchWheelAndObserveReveal(viewport)).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3451: with classic (space-taking) scrollbars the "Always" geometry makes
// the thumb wider than the content's right gutter, so any opaque sticky layer
// stacked above the rail (the Chats header is `z-40 bg-sidebar`) painted over
// the thumb's inner columns and left a notch. Probe every thumb pixel column
// that shares rows with the Chats header and require the thumb to be on top.
test('sidebar scrollbar thumb stays on top of the Chats header with classic scrollbars', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: DEMO_APPS,
    viewportSize: { width: 900, height: 500 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const viewport = window.getByTestId('sidebar-scroll-container');
    await window.evaluate(() => {
      document.documentElement.dataset.scrollbarBehavior = 'always';
    });
    await expect
      .poll(() =>
        window.evaluate(() => document.documentElement.dataset.scrollbars),
      )
      .toBe('always');
    await settleStartupScroll(viewport);
    await expect(
      viewport.locator('[data-sidebar-chats-header]').first(),
    ).toBeVisible();

    const probe = await viewport.evaluate(async (element) => {
      const frame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const header = element.querySelector('[data-sidebar-chats-header]');
      const scrollArea = element.parentElement;
      const thumb = scrollArea?.querySelector('[data-sidebar-scrollbar-thumb]');
      if (
        !(header instanceof HTMLElement) ||
        !(scrollArea instanceof HTMLElement) ||
        !(thumb instanceof HTMLElement)
      ) {
        throw new Error('Expected the Chats header and the scrollbar thumb');
      }
      const maxScrollTop = element.scrollHeight - element.clientHeight;
      let sampled = 0;
      let headerOverlapSamples = 0;
      const covered = [];
      for (let top = 0; top <= maxScrollTop; top += 8) {
        element.scrollTop = top;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        await frame();
        await frame();
        if (document.documentElement.dataset.scrollbars !== 'always') {
          throw new Error(
            'Classic scrollbar geometry changed during the probe',
          );
        }
        const headerRect = header.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        // Skip the rounded caps, where the pill is legitimately transparent.
        const yStart = Math.max(headerRect.top, thumbRect.top + 6) + 0.5;
        const yEnd = Math.min(headerRect.bottom, thumbRect.bottom - 6);
        for (let y = yStart; y < yEnd; y += 4) {
          for (let x = thumbRect.left + 0.5; x < thumbRect.right; x += 1) {
            sampled += 1;
            if (x >= headerRect.left && x < headerRect.right) {
              headerOverlapSamples += 1;
            }
            const hit = document.elementFromPoint(x, y);
            // Only content INSIDE the scroll area can paint over the thumb
            // (the notch was the sticky header). Ignore external hit targets;
            // this probe checks the rail against its own scroll-area content.
            if (
              hit !== thumb &&
              hit !== null &&
              scrollArea.contains(hit) &&
              covered.length < 5
            ) {
              covered.push({
                scrollTop: top,
                x: Math.round(x),
                y: Math.round(y),
                hit: hit?.getAttribute('data-testid') ?? hit?.tagName ?? null,
              });
            }
          }
        }
      }
      element.scrollTop = 0;
      return { sampled, headerOverlapSamples, covered };
    });

    // Guard against a vacuous pass: the thumb must actually have crossed the
    // header's rows at some scroll position.
    expect(probe.sampled).toBeGreaterThan(0);
    // Sharing rows alone is insufficient: overlay thumbs stay in the gutter.
    expect(probe.headerOverlapSamples).toBeGreaterThan(0);
    expect(probe.covered).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3451 follow-up: the raised rail must not steal the trailing edge of
// the Chats header's create action when classic scrollbars are visible.
test('classic sidebar scrollbar leaves the new chat button fully clickable', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: DEMO_APPS,
    viewportSize: { width: 900, height: 500 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const viewport = window.getByTestId('sidebar-scroll-container');
    await window.evaluate(() => {
      document.documentElement.dataset.scrollbarBehavior = 'always';
    });
    await expect
      .poll(() =>
        window.evaluate(() => document.documentElement.dataset.scrollbars),
      )
      .toBe('always');
    await settleStartupScroll(viewport);
    const button = window.getByTestId('sidebar-section-chats-new-chat');
    await viewport.locator('[data-sidebar-chats-header]').first().hover();
    await expect(button).toHaveCSS('opacity', '1');
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    // A real pointer click avoids Playwright retrying until the rail disappears.
    await window.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

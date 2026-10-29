import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-2415: previewing the collapsed left sidebar from the titlebar expand
// button. Hovering (or keyboard-focusing) the toggle while the sidebar is
// hidden reveals the full sidebar as a temporary overlay: the main content
// neither moves nor resizes, the persisted `sidebarCollapsed` preference is
// untouched, Escape (or leaving the preview) closes it, and clicking the
// toggle still pins the sidebar open. Deterministic + offline (no live
// agents): a fresh unseeded launch plus pointer/keyboard interaction only.
//
// Follow-up: the same overlay also opens from the window's own left edge, so
// the sidebar can be consulted by running the pointer left rather than aiming
// for the toggle (last test in this file).

function seedSecondCoworkWorkspace() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-hover-preview-'),
  );
  const workspaceId = 'hover-preview-secondary';
  const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'workspaces', 'index.json'),
    `${JSON.stringify(
      {
        version: 1,
        workspaces: [
          {
            id: workspaceId,
            name: 'Hover Preview Project',
            type: 'cowork',
            color: '#6D8B9B',
            collapsed: false,
            order: 1,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(workspaceDir, 'workspace.json'),
    `${JSON.stringify(
      {
        version: 1,
        type: 'cowork',
        repos: [],
        cowork: {
          createdAt: '2026-09-05T10:00:00.000Z',
          archiveRetentionDays: 7,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return userDataDir;
}

/**
 * The reveal is a slide, so the `<aside>` stays 0-wide throughout and its
 * visibility says nothing about whether the sidebar is on screen. These read
 * the sliding panel's own transform instead: revealed sits at translateX(0),
 * closed is parked one full width to the left.
 */
async function readPanelOffset(window) {
  return window.evaluate(() => {
    const panel = document.querySelector('[data-testid="sidebar-panel"]');
    if (!panel) return null;
    const transform = getComputedStyle(panel).transform;
    // Docked/released panels carry no transform at all. Returning 0 here would
    // be indistinguishable from "slid fully in", so a waiter could pass before
    // the preview had even opened.
    if (transform === 'none') return null;
    return Math.round(new DOMMatrixReadOnly(transform).m41);
  });
}

async function expectPanelSlidIn(window) {
  // Both halves matter: the preview must be open AND the panel finished
  // travelling. Offset alone cannot tell "not presented" from "arrived".
  await expect(window.getByTestId('app-sidebar')).toHaveAttribute(
    'data-sidebar-preview',
    'true',
  );
  await expect.poll(() => readPanelOffset(window)).toBe(0);
}

async function expectPreviewClosed(window) {
  await expect(window.getByTestId('app-sidebar')).not.toHaveAttribute(
    'data-sidebar-preview',
    'true',
  );
  // Parked off to the left, or fully released back to the docked rendering
  // where no transform applies. Strictly negative on purpose: the panel's
  // transform is only ever 0 (revealed) or the negative travel offset, so
  // `<= 0` would also accept the fully-revealed state and the assertion could
  // never fail.
  await expect
    .poll(async () => {
      const offset = await readPanelOffset(window);
      return offset === null || offset < 0;
    })
    .toBe(true);
}

/** Polls the persisted preference through the renderer's preload API. */
async function readSidebarCollapsed(window) {
  return window.evaluate(async () => {
    const prefs = await window.api.loadPreferences();
    return prefs.sidebarCollapsed;
  });
}

async function collapseAndPark(window) {
  const sidebar = window.getByTestId('app-sidebar');
  if (!(await readSidebarCollapsed(window))) {
    await window.getByTestId('sidebar-toggle').click();
  }
  await expect(sidebar).toBeHidden();
  await window.mouse.move(900, 600);
  await expectPreviewClosed(window);
  await expect.poll(() => readSidebarCollapsed(window)).toBe(true);
}

/**
 * Puts keyboard focus on the titlebar sidebar toggle with `:focus-visible`
 * semantics (which gate the focus-opened preview). A Tab press first puts
 * Chromium in keyboard modality, so the subsequent focus() call — like focus
 * arriving via continued Tab traversal — matches `:focus-visible`; walking
 * the real tab order to the toggle would be hostage to every focusable the
 * active page happens to render.
 */
async function focusToggleViaKeyboard(window) {
  await window.keyboard.press('Tab');
  await window.getByTestId('sidebar-toggle').focus();
  expect(
    await window.evaluate(
      () =>
        document.activeElement?.getAttribute('data-testid') ===
          'sidebar-toggle' && document.activeElement.matches(':focus-visible'),
    ),
  ).toBe(true);
}

let bareSidebarHarness;

async function resetBareSidebarHarness() {
  const { app, window } = bareSidebarHarness;
  await window.keyboard.press('Escape');
  await app.openMainPage();
  const sidebar = window.getByTestId('app-sidebar');
  const toggle = window.getByTestId('sidebar-toggle');
  await window.mouse.move(900, 600);
  await expectPreviewClosed(window);
  if (await readSidebarCollapsed(window)) {
    await toggle.click();
  }
  await expect(sidebar).toBeVisible();
  await expect.poll(() => readSidebarCollapsed(window)).toBe(false);
}

async function getBareSidebarHarness() {
  if (!bareSidebarHarness) {
    const launched = await launchCanopy();
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    bareSidebarHarness = { ...launched, window, app };
  }
  await resetBareSidebarHarness();
  return bareSidebarHarness;
}

async function closeSidebarFixture(electronApp, userDataDir) {
  if (bareSidebarHarness?.electronApp === electronApp) {
    await resetBareSidebarHarness();
    return;
  }
  await closeCanopy(electronApp, userDataDir);
}

test.afterAll(async () => {
  if (bareSidebarHarness) {
    await closeCanopy(
      bareSidebarHarness.electronApp,
      bareSidebarHarness.userDataDir,
    );
  }
});

test('hover and keyboard focus preview the hidden sidebar without changing the saved state', async () => {
  const userDataDir = seedSecondCoworkWorkspace();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');
    const main = window.locator('main').first();
    await expect(sidebar).toBeVisible();

    // Collapse the sidebar and park the pointer away from the corner so the
    // next hover is a real pointer-enter on the toggle.
    await toggle.click();
    await expect(sidebar).toBeHidden();
    await window.mouse.move(500, 400);
    await expect.poll(() => readSidebarCollapsed(window)).toBe(true);
    const hiddenMainBox = await main.boundingBox();
    expect(hiddenMainBox).not.toBeNull();

    // Collapsed and idle, the titlebar's icon-only New Task stand-in is fully
    // faded in — the baseline the preview fades back out.
    const titlebarCreateTask = window.getByTestId('titlebar-create-task');
    const createTaskOpacity = async () =>
      titlebarCreateTask.evaluate(
        (node) =>
          getComputedStyle(
            node.closest('[data-testid="titlebar-create-task-fade"]'),
          ).opacity,
      );
    await expect.poll(createTaskOpacity).toBe('1');

    // 1) Hover the toggle: the sidebar appears as an overlay after the dwell
    // delay, flagged with data-sidebar-preview, and the main content keeps
    // its exact geometry (the overlay floats above it).
    await toggle.hover();
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');
    await expectPanelSlidIn(window);
    const mainBoxDuringPreview = await main.boundingBox();
    expect(mainBoxDuringPreview.x).toBe(hiddenMainBox.x);
    expect(mainBoxDuringPreview.width).toBe(hiddenMainBox.width);
    // Still reads as the collapsed state: the toggle keeps its expand label
    // and the persisted preference is untouched.
    await expect(toggle).toHaveAttribute('aria-label', 'Show sidebar');
    expect(await readSidebarCollapsed(window)).toBe(true);

    // The preview is an ELEVATED surface, not the docked window material:
    // an opaque background on the inner surface (docked, it is transparent so
    // the window material shows through) plus a drop shadow on the OUTER
    // aside. The shadow must not live on the inner surface: its wrapper is
    // `overflow-hidden` and the surface fills it exactly, so a shadow set
    // there is clipped away entirely and never reaches the screen.
    const previewSurface = window.getByTestId('sidebar-panel');
    const surfaceBackground = await previewSurface.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    expect(surfaceBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(surfaceBackground).not.toBe('transparent');

    const panelStyles = await previewSurface.evaluate((node) => {
      const computed = getComputedStyle(node);
      // Split on commas that are not inside a colour function.
      const layers = computed.boxShadow.split(/,(?![^()]*\))/);
      return {
        boxShadow: computed.boxShadow,
        // `box-shadow` can be set yet paint nothing if every layer's colour is
        // fully transparent, so count the layers that actually render.
        opaqueLayerCount: layers.filter(
          (layer) =>
            !/rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*0\s*\)/.test(layer),
        ).length,
        position: computed.position,
        clipOverflow: getComputedStyle(node.parentElement).overflow,
      };
    });
    // A shadow set on a clipped element is invisible, so the wrapper must not
    // be clipping while the panel is revealed.
    expect(panelStyles.boxShadow).not.toBe('none');
    expect(panelStyles.opaqueLayerCount).toBeGreaterThan(0);
    expect(panelStyles.position).toBe('absolute');
    expect(panelStyles.clipOverflow).not.toBe('hidden');

    // The reveal is a SLIDE: the panel is at its full width the whole time and
    // translates in, rather than the aside growing from 0. The aside itself
    // keeps zero width so the flex row never changes.
    expect(
      await previewSurface.evaluate(
        (node) => Math.round(node.getBoundingClientRect().width) > 100,
      ),
    ).toBe(true);
    expect(
      await sidebar.evaluate((node) =>
        Math.round(node.getBoundingClientRect().width),
      ),
    ).toBe(0);

    // Revealed, the panel is fully opaque; it fades 0 -> 1 with the slide.
    await expect
      .poll(async () =>
        previewSurface.evaluate((node) => getComputedStyle(node).opacity),
      )
      .toBe('1');

    // The resource pill waits for the panel to land before fading in, rather
    // than riding the slide across the window.
    const resourcePill = window.getByTestId(
      'sidebar-titlebar-resource-monitor',
    );
    if ((await resourcePill.count()) > 0) {
      await expect
        .poll(async () =>
          resourcePill.evaluate((node) => getComputedStyle(node).opacity),
        )
        .toBe('1');
    }

    // Workspace headers carry `.bg-sidebar`, which paints `--bg-depth` unless
    // neutralized. On the opaque preview surface that renders as dark blocks
    // floating on the panel, so they must stay transparent and inherit it.
    const workspaceHeaders = sidebar.locator('.bg-sidebar');
    // Guard the guard: if the fixture ever stops rendering a sticky workspace
    // header, this check would silently pass while covering nothing.
    expect(await workspaceHeaders.count()).toBeGreaterThan(0);
    const headerBackgrounds = await workspaceHeaders.evaluateAll((nodes) => [
      ...new Set(nodes.map((node) => getComputedStyle(node).backgroundColor)),
    ]);
    expect(headerBackgrounds).toEqual(['rgba(0, 0, 0, 0)']);

    // The titlebar's icon-only New Task stand-in fades out while the preview
    // shows the sidebar's own New Task button, and stops being focusable.
    await expect.poll(createTaskOpacity).toBe('0');
    await expect(titlebarCreateTask).toHaveAttribute('tabindex', '-1');

    // 2) Move into the preview: it stays open and its navigation is usable.
    const workflowsNav = window.getByTestId('sidebar-nav-workflows');
    await workflowsNav.hover();
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');
    await workflowsNav.click();
    await expect(window.getByTestId('page-workflows-runs')).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');

    // 3) Escape closes the preview and leaves the saved state collapsed. The
    // titlebar New Task stand-in fades back in with the sidebar gone again.
    await window.keyboard.press('Escape');
    await expectPreviewClosed(window);
    expect(await readSidebarCollapsed(window)).toBe(true);
    await expect.poll(createTaskOpacity).toBe('1');

    // 4) Leaving the preview with the pointer closes it after the grace
    // period.
    await window.mouse.move(500, 400);
    await toggle.hover();
    await expectPanelSlidIn(window);
    await window.mouse.move(600, 450);
    // Promptly, not after a grace period: the reveal must be reversible the
    // moment the pointer leaves, so the close is not allowed to sit behind a
    // delay. A generous-but-bounded budget keeps this robust without letting a
    // reintroduced 300ms grace slip through.
    await expect(sidebar).not.toHaveAttribute('data-sidebar-preview', 'true', {
      timeout: 150,
    });
    await expectPreviewClosed(window);

    // 5) Keyboard: real focus traversal opens the preview without a pointer,
    // and Escape returns focus to the toggle. Park focus on the body first —
    // Shift+Tab then wraps to the titlebar corner at the end of the DOM.
    await window.mouse.move(500, 400);
    await window.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await focusToggleViaKeyboard(window);
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');
    await expectPanelSlidIn(window);
    await window.keyboard.press('Escape');
    await expectPreviewClosed(window);
    expect(
      await window.evaluate(
        () =>
          document.activeElement?.getAttribute('data-testid') ===
          'sidebar-toggle',
      ),
    ).toBe(true);

    // 6) Clicking the toggle still pins the sidebar open: the preview flag
    // clears, the aside rejoins the layout (main narrows), and the
    // preference persists as expanded.
    await toggle.click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).not.toHaveAttribute('data-sidebar-preview', 'true');
    await expect
      .poll(async () => (await main.boundingBox())?.width ?? 0)
      .toBeLessThan(hiddenMainBox.width);
    await expect.poll(() => readSidebarCollapsed(window)).toBe(false);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('opening and closing the preview never shifts the main content', async () => {
  const { electronApp, userDataDir } = await getBareSidebarHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');

    // Collapse, then settle with the pointer well away from the corner.
    await collapseAndPark(window);

    const baseline = await window.evaluate(() => {
      const rect = document.querySelector('main').getBoundingClientRect();
      return { x: Math.round(rect.x), width: Math.round(rect.width) };
    });

    // Record main's geometry every frame across BOTH the open and the close.
    // A per-frame recorder is used deliberately: the shift this guards against
    // lasts only as long as the 200ms width animation, so sampling over IPC
    // would step right over it.
    const startRecorder = async (minMs = 700) => {
      await window.evaluate((minMs) => {
        // Each recording claims a generation. `startRecorder` is called three
        // times and the mid-flight re-entry pass is deliberately read before
        // it settles, so an older recorder's queued frame is still scheduled
        // when the next one starts. Without this guard that stale callback
        // would push into the new sample array and, worse, set the shared
        // done flag — letting the close pass stop sampling mid-transition,
        // which is exactly the flake this change exists to remove.
        const generation = (window.__mainSamplesGeneration ?? 0) + 1;
        window.__mainSamplesGeneration = generation;
        window.__mainSamples = [];
        window.__mainSamplesDone = false;
        let stableFrames = 0;
        let lastSignature = null;
        const main = document.querySelector('main');
        const aside = document.querySelector('[data-testid="app-sidebar"]');
        const panel = document.querySelector('[data-testid="sidebar-panel"]');
        const pill = document.querySelector(
          '[data-testid="sidebar-titlebar-resource-monitor"]',
        );
        const t0 = performance.now();
        const record = () => {
          // A superseded recorder stops dead: it must not append samples to
          // its successor's array or mark that recording complete.
          if (window.__mainSamplesGeneration !== generation) return;
          const rect = main.getBoundingClientRect();
          const matrix = new DOMMatrixReadOnly(
            getComputedStyle(panel).transform,
          );
          const sample = {
            t: Math.round(performance.now() - t0),
            x: Math.round(rect.x),
            width: Math.round(rect.width),
            asideWidth: Math.round(aside.getBoundingClientRect().width),
            // How far the sliding panel has travelled this frame, and how
            // far through its fade it is.
            panelOffset: Math.round(matrix.m41),
            panelOpacity: Number(getComputedStyle(panel).opacity).toFixed(2),
            pillOpacity: pill
              ? Number(getComputedStyle(pill).opacity).toFixed(2)
              : null,
          };
          window.__mainSamples.push(sample);
          // Stop when the scene has actually settled rather than after a
          // fixed wall-clock budget. A loaded CI runner starves rAF, so a
          // 1400ms window could end mid-transition: the close assertions saw
          // only two distinct offsets and opacities of 1.00/0.64/0.05 — the
          // animation was running fine, the recorder just stopped before it
          // finished. `minMs` keeps short-window scenarios (the mid-flight
          // re-entry below) sampling through their whole interaction.
          const signature = `${sample.x}:${sample.width}:${sample.asideWidth}:${sample.panelOffset}:${sample.panelOpacity}:${sample.pillOpacity}`;
          if (signature === lastSignature) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
            lastSignature = signature;
          }
          const elapsed = performance.now() - t0;
          if ((stableFrames < 10 || elapsed < minMs) && elapsed < 8000) {
            requestAnimationFrame(record);
          } else {
            window.__mainSamplesDone = true;
          }
        };
        requestAnimationFrame(record);
      }, minMs);
    };
    const readSamples = () => window.evaluate(() => window.__mainSamples);
    /** Wait for the recorder to observe the scene come to rest. */
    const waitForRecorderToSettle = async () => {
      await expect
        .poll(() => window.evaluate(() => window.__mainSamplesDone === true), {
          timeout: 20_000,
        })
        .toBe(true);
    };
    const summarize = (samples) => ({
      widths: [...new Set(samples.map((s) => s.width))],
      xs: [...new Set(samples.map((s) => s.x))],
      asideWidths: [...new Set(samples.map((s) => s.asideWidth))],
      panelOffsets: [...new Set(samples.map((s) => s.panelOffset))],
      panelOpacities: [...new Set(samples.map((s) => s.panelOpacity))],
      pillOpacities: [...new Set(samples.map((s) => s.pillOpacity))],
    });

    // --- Open: hover the toggle and record while the panel slides in. The
    // panel must be caught at intermediate offsets in BOTH directions; an
    // earlier revision animated only on the way out, because the opening
    // frame transitioned `none` -> `translateX(-100%)` before it could
    // transition back in.
    await startRecorder();
    await toggle.hover();
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');
    await waitForRecorderToSettle();
    const openSummary = summarize(await readSamples());
    // It really animated: the panel was caught at several offsets on its way
    // in, ending flush at 0.
    expect(openSummary.panelOffsets.length).toBeGreaterThan(2);
    expect(Math.max(...openSummary.panelOffsets)).toBe(0);
    // Genuinely mid-flight frames, not just the two endpoints.
    expect(
      openSummary.panelOffsets.filter(
        (offset) => offset < -1 && offset > -baseline.width,
      ).length,
    ).toBeGreaterThan(0);
    // ...and it slid rather than grew: the aside never left zero width.
    expect(openSummary.asideWidths).toEqual([0]);
    // The fade animates alongside the slide: partial values, ending opaque.
    expect(openSummary.panelOpacities.length).toBeGreaterThan(2);
    expect(openSummary.panelOpacities).toContain('1.00');
    // The resource pill must be genuinely hidden while the panel travels and
    // only then fade up. Asserting the end state alone would pass even if it
    // rode the slide in at full opacity the whole way.
    if (openSummary.pillOpacities.some((value) => value !== null)) {
      expect(
        openSummary.pillOpacities.filter(
          (value) => value !== null && Number(value) < 0.05,
        ).length,
      ).toBeGreaterThan(0);
      expect(openSummary.pillOpacities).toContain('1.00');
    }
    expect(openSummary.widths).toEqual([baseline.width]);
    expect(openSummary.xs).toEqual([baseline.x]);

    // --- Re-enter mid slide-out: the panel is already presented, so it must
    // reverse continuously from wherever it is. Pinning transitions off here
    // (the entry-frame treatment) would snap it to the hidden offset first.
    await startRecorder();
    await window.mouse.move(900, 600);
    await window.waitForTimeout(60);
    await toggle.hover();
    await expectPanelSlidIn(window);
    await window.waitForTimeout(600);
    const reentrySummary = summarize(await readSamples());
    // A snap would show only the endpoints; a continuous reversal is caught
    // at intermediate offsets.
    expect(
      reentrySummary.panelOffsets.filter(
        (offset) => offset < -1 && offset > -baseline.width,
      ).length,
    ).toBeGreaterThan(0);
    expect(reentrySummary.widths).toEqual([baseline.width]);

    // --- Close: move the pointer away and record through the grace period
    // and the slide-out that follows it.
    await startRecorder();
    await window.mouse.move(900, 600);
    await expectPreviewClosed(window);
    await waitForRecorderToSettle();
    const closeSummary = summarize(await readSamples());
    expect(closeSummary.panelOffsets.length).toBeGreaterThan(2);
    expect(closeSummary.asideWidths).toEqual([0]);
    // ...and fades back out on the way, ending fully transparent.
    expect(closeSummary.panelOpacities.length).toBeGreaterThan(2);
    expect(closeSummary.panelOpacities).toContain('0.00');
    expect(closeSummary.widths).toEqual([baseline.width]);
    expect(closeSummary.xs).toEqual([baseline.x]);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('crossing the titlebar corner controls keeps the preview revealed', async () => {
  const { electronApp, userDataDir } = await getBareSidebarHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');

    await collapseAndPark(window);

    await toggle.hover();
    await expectPanelSlidIn(window);

    const geometry = await window.evaluate(() => {
      const button = document.querySelector('[data-testid="sidebar-toggle"]');
      const panel = document.querySelector('[data-testid="sidebar-panel"]');
      const corner = document.querySelector(
        '[data-testid="app-titlebar-corner"]',
      );
      const buttonRect = button.getBoundingClientRect();
      const cornerRect = corner.getBoundingClientRect();
      return {
        toggleX: Math.round(buttonRect.x + buttonRect.width / 2),
        toggleY: Math.round(buttonRect.y + buttonRect.height / 2),
        // Past the toggle, over its neighbours (history arrows / New Task).
        neighbourX: Math.round(cornerRect.right - 24),
        cornerBottom: Math.round(cornerRect.bottom),
        panelInsideX: Math.round(panel.getBoundingClientRect().right * 0.6),
      };
    });

    // Drift sideways across the corner's OTHER controls on the way down into
    // the panel. Each is its own pointer-events island, so leaving the toggle
    // reports them as the related target — not the sidebar. Treating that as
    // "left the preview" closed it mid-journey.
    await window.mouse.move(geometry.neighbourX, geometry.toggleY);
    await window.waitForTimeout(80);
    await window.mouse.move(geometry.panelInsideX, geometry.cornerBottom + 20);
    await window.waitForTimeout(80);
    await window.mouse.move(geometry.panelInsideX, geometry.cornerBottom + 120);
    await window.waitForTimeout(300);

    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');
    await expectPanelSlidIn(window);

    // Leaving the panel sideways still closes it.
    await window.mouse.move(900, 300);
    await expectPreviewClosed(window);

    // ...and so does leaving the corner THROUGH a sibling control. The toggle
    // hands off to its neighbours without closing, so the corner itself has to
    // notice the pointer finally departing — otherwise the preview stays open
    // over the workspace with nothing to dismiss it.
    await window.mouse.move(900, 600);
    await window.waitForTimeout(200);
    await toggle.hover();
    await expectPanelSlidIn(window);
    const cornerBox = await window
      .getByTestId('app-titlebar-corner')
      .boundingBox();
    await window.mouse.move(
      cornerBox.x + cornerBox.width - 12,
      cornerBox.y + cornerBox.height / 2,
    );
    await window.waitForTimeout(120);
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');
    await window.mouse.move(900, 400);
    await expectPreviewClosed(window);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('opening the sidebar More menu keeps the preview revealed', async () => {
  const { electronApp, userDataDir } = await getBareSidebarHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');

    await collapseAndPark(window);

    // Reveal, then open the More menu from inside the preview.
    await toggle.hover();
    await expectPanelSlidIn(window);
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();

    // The menu portals OUTSIDE the sidebar, so opening it fires a pointer
    // leave on the panel. That must not be read as leaving the preview.
    await window.waitForTimeout(900);
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');
    await expectPanelSlidIn(window);

    // Menu items stay usable from the preview. Customize sidebar is the
    // entry the default More menu always holds (CAN-3678, CAN-4269).
    await window.getByTestId('sidebar-more-item-customize').click();
    await expect(window.getByTestId('customize-sidebar-modal')).toBeVisible();
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('the revealed sidebar paints above page content', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');

    await collapseAndPark(window);

    await toggle.hover();
    await expectPanelSlidIn(window);

    // The toggle carries no tooltip, so nothing portalled floats over the
    // revealed panel and even its topmost region is probe-able while the
    // pointer is still on the toggle.
    await expect(window.getByRole('tooltip')).toHaveCount(0);

    // Hit-test the panel's own area rather than comparing z-index numbers:
    // whatever the stacking rules, the topmost element at these points must
    // belong to the panel. The chat composer is `relative z-30` and sits at
    // the bottom of the content area — the same tier the panel used to use,
    // so it won on DOM order and painted straight over the sidebar.
    const hits = await window.evaluate(() => {
      const panel = document.querySelector('[data-testid="sidebar-panel"]');
      const rect = panel.getBoundingClientRect();
      // Starts below the titlebar corner: that 40px strip is SUPPOSED to
      // paint above the panel (it holds the toggle), so probing it would be
      // testing the boundary between two intentional layers.
      const probes = [0.15, 0.5, 0.85, 0.97].map((fraction) => ({
        fraction,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height * fraction),
      }));
      return probes.map((probe) => ({
        fraction: probe.fraction,
        insidePanel: panel.contains(
          document.elementFromPoint(probe.x, probe.y),
        ),
      }));
    });
    for (const hit of hits) {
      expect(hit).toEqual({ fraction: hit.fraction, insidePanel: true });
    }

    // ...and the toggle stays on top OF the panel, or it would be buried
    // under the very thing it controls.
    const toggleOnTop = await window.evaluate(() => {
      const button = document.querySelector('[data-testid="sidebar-toggle"]');
      const rect = button.getBoundingClientRect();
      const topmost = document.elementFromPoint(
        Math.round(rect.x + rect.width / 2),
        Math.round(rect.y + rect.height / 2),
      );
      return button.contains(topmost) || topmost === button;
    });
    expect(toggleOnTop).toBe(true);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('pinning a revealed preview hands over without re-animating', async () => {
  const { electronApp, userDataDir } = await getBareSidebarHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');

    await collapseAndPark(window);

    await toggle.hover();
    await expectPanelSlidIn(window);

    // Record the aside's width across the pin. The sidebar is already fully
    // on screen as a preview, so committing it must be a handover, not a
    // replay of the docked 0 -> width animation.
    await window.evaluate(() => {
      window.__pinSamples = [];
      const aside = document.querySelector('[data-testid="app-sidebar"]');
      const start = performance.now();
      const record = () => {
        window.__pinSamples.push(
          Math.round(aside.getBoundingClientRect().width),
        );
        if (performance.now() - start < 700) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });

    await toggle.click();
    await expect(sidebar).toBeVisible();
    await window.waitForTimeout(800);

    const widths = await window.evaluate(() => [
      ...new Set(window.__pinSamples),
    ]);
    // 0 (still previewing) and the docked width; an animated handover would
    // stack many intermediate widths in between.
    const intermediate = widths.filter(
      (value) => value > 0 && value < Math.max(...widths),
    );
    expect(intermediate).toEqual([]);
    expect(Math.max(...widths)).toBeGreaterThan(100);

    // The preview state is fully released once pinned.
    await expect(sidebar).not.toHaveAttribute('data-sidebar-preview', 'true');
    await expect.poll(() => readSidebarCollapsed(window)).toBe(false);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

/**
 * The hover-open sidebar has to be genuinely USABLE, not merely visible: every
 * left-nav surface must keep it open while the pointer works through it,
 * including surfaces that portal their popovers outside the sidebar (which
 * fires a pointer-leave on the panel) and drag interactions that move the
 * pointer far across the window.
 */
test('the hover-open sidebar stays open across every left-nav surface', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');

    const reveal = async () => {
      if ((await sidebar.getAttribute('data-sidebar-preview')) === 'true') {
        return;
      }
      await window.mouse.move(900, 600);
      await window.waitForTimeout(150);
      await toggle.hover();
      await expectPanelSlidIn(window);
    };
    const expectStillRevealed = async (surface) => {
      await expect(
        sidebar,
        `preview closed while using: ${surface}`,
      ).toHaveAttribute('data-sidebar-preview', 'true');
    };

    await collapseAndPark(window);

    // 1) The "More" dropdown.
    await reveal();
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
    await window.waitForTimeout(400);
    await expectStillRevealed('More dropdown');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('sidebar-more-menu')).toBeHidden();
    await expectStillRevealed('More dropdown dismissed');

    // 2) The worktree row's ••• menu, including a nested submenu hover.
    await reveal();
    // The ••• control is `opacity-0` until its row is hovered, so hover the
    // row first — which is itself part of what must keep the preview open.
    const worktreeRow = window.locator('[data-worktree-id]').first();
    await worktreeRow.hover();
    await window.waitForTimeout(200);
    await expectStillRevealed('worktree row hover');
    const rowMenuButton = window
      .getByTestId('worktree-actions-menu-button')
      .first();
    await rowMenuButton.click();
    await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
    await window.waitForTimeout(400);
    await expectStillRevealed('worktree ••• menu');
    // Poke around inside the portalled menu — it lives outside the sidebar, so
    // hovering it reports a leave from the panel.
    const menuItem = window.getByTestId('worktree-actions-menu-info');
    if ((await menuItem.count()) > 0) {
      await menuItem.hover();
      await window.waitForTimeout(300);
      await expectStillRevealed('worktree ••• menu item hover');
    }
    await window.keyboard.press('Escape');
    await expectStillRevealed('worktree ••• menu dismissed');

    // 3) The lower-left account menu.
    await reveal();
    await window.getByTestId('sidebar-account-row').click();
    await expect(window.getByTestId('sidebar-account-menu')).toBeVisible();
    await window.waitForTimeout(400);
    await expectStillRevealed('account menu');
    await window.keyboard.press('Escape');
    await expectStillRevealed('account menu dismissed');

    // 4) Expanding and collapsing a nav section.
    await reveal();
    const sectionToggle = window.getByTestId('sidebar-section-code-toggle');
    await sectionToggle.click();
    await window.waitForTimeout(300);
    await expectStillRevealed('section collapse');
    await sectionToggle.click();
    await window.waitForTimeout(300);
    await expectStillRevealed('section expand');

    // 5) Dragging a workspace row. The pointer travels a long way with a
    // button held down, and HTML5 drag suppresses ordinary pointer events.
    await reveal();
    const rows = window.locator('[data-worktree-id]');
    if ((await rows.count()) > 1) {
      const source = await rows.nth(0).boundingBox();
      const destination = await rows.nth(1).boundingBox();
      await window.mouse.move(
        source.x + source.width / 2,
        source.y + source.height / 2,
      );
      await window.mouse.down();
      await window.mouse.move(
        destination.x + destination.width / 2,
        destination.y + destination.height / 2,
        { steps: 12 },
      );
      await window.waitForTimeout(250);
      await expectStillRevealed('worktree drag in flight');
      await window.mouse.up();
      await window.waitForTimeout(300);
      await expectStillRevealed('worktree drag released');
    }

    // The preview still ends when the pointer genuinely leaves.
    await window.mouse.move(900, 500);
    await expectPreviewClosed(window);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('opening settings from a preview releases it', async () => {
  const { electronApp, userDataDir } = await getBareSidebarHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');

    await collapseAndPark(window);

    await toggle.hover();
    await expectPanelSlidIn(window);

    // Settings owns the whole window and expects a static sidebar beneath it.
    // A preview left running underneath keeps the panel presented and the
    // titlebar corner elevated, so the two interleave on screen.
    // Uses the driver's own route into settings (account action, falling back
    // to the account menu) rather than assuming a single control.
    await app.openSettings();
    await expectPreviewClosed(window);
    expect(
      await window.evaluate(() => {
        const panel = document.querySelector('[data-testid="sidebar-panel"]');
        return getComputedStyle(panel).position;
      }),
    ).toBe('relative');

    // The saved collapsed state is still untouched by the preview.
    expect(await readSidebarCollapsed(window)).toBe(true);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('running the pointer into the left edge reveals the hidden sidebar', async () => {
  const { electronApp, userDataDir } = await getBareSidebarHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');
    const main = window.locator('main').first();
    await expect(sidebar).toBeVisible();

    // Collapse and park the pointer well inside the page, so the next move to
    // the edge is the only thing that could explain a reveal.
    await toggle.click();
    await expect(sidebar).toBeHidden();
    await window.mouse.move(500, 400);
    await expect.poll(() => readSidebarCollapsed(window)).toBe(true);
    const hiddenMainBox = await main.boundingBox();
    expect(hiddenMainBox).not.toBeNull();

    // 1) Run the pointer into the left edge, below the titlebar: the same
    // overlay the toggle's hover opens, without aiming for the toggle.
    await window.mouse.move(0, 400);
    await expectPanelSlidIn(window);
    // Still an overlay: the main content neither moves nor resizes.
    const mainBoxDuringPreview = await main.boundingBox();
    expect(mainBoxDuringPreview.x).toBe(hiddenMainBox.x);
    expect(mainBoxDuringPreview.width).toBe(hiddenMainBox.width);

    // 2) The revealed sidebar is usable, not merely visible.
    const workflowsNav = window.getByTestId('sidebar-nav-workflows');
    await workflowsNav.hover();
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');

    // 3) Leaving closes it, and the saved state was never touched.
    await window.mouse.move(700, 450);
    await expectPreviewClosed(window);
    expect(await readSidebarCollapsed(window)).toBe(true);

    // 4) A brush PAST the edge must not leave the preview stranded. The panel
    // mounts a frame after the reveal is requested, so a pointer that has
    // already moved on never enters it — and an overlay waiting on its own
    // pointer-leave would then stay open with nothing able to dismiss it.
    await window.mouse.move(0, 400);
    await window.mouse.move(900, 500);
    await expectPreviewClosed(window);

    // 5) The titlebar corner reaches the very same edge and owns its own
    // hover behaviour, including the macOS window controls: travelling there
    // must not fling the sidebar out. Skipped when the corner reserves no
    // room to the left of the toggle (no traffic lights to make way for),
    // since then x=1 IS the toggle and revealing is the correct outcome.
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox).not.toBeNull();
    if (toggleBox.x > 8) {
      await window.mouse.move(1, 20);
      // Give a reveal every chance to appear before declaring it absent.
      await window.waitForTimeout(250);
      await expectPreviewClosed(window);
    }

    // 6) The edge is inert once the sidebar is pinned open: nothing to preview.
    await toggle.click();
    await expect(sidebar).toBeVisible();
    await window.mouse.move(0, 400);
    await expect(sidebar).not.toHaveAttribute('data-sidebar-preview', 'true');
    await expect.poll(() => readSidebarCollapsed(window)).toBe(false);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

test('pointer travel does not collapse a keyboard-opened preview', async () => {
  const { electronApp, userDataDir } = await getBareSidebarHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const sidebar = window.getByTestId('app-sidebar');
    const toggle = window.getByTestId('sidebar-toggle');
    await expect(sidebar).toBeVisible();

    await toggle.click();
    await expect(sidebar).toBeHidden();
    await window.mouse.move(500, 400);
    await expect.poll(() => readSidebarCollapsed(window)).toBe(true);

    // Open it with the keyboard, pointer parked well away from the sidebar.
    await window.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await focusToggleViaKeyboard(window);
    await expectPanelSlidIn(window);

    // A preview opened by the keyboard belongs to the keyboard. Incidental
    // pointer travel — a nudged trackpad, a hand brushing the mouse — must not
    // collapse a sidebar the user is navigating by tab, which is exactly when
    // re-opening it is most expensive.
    await window.mouse.move(700, 500);
    await window.mouse.move(900, 300);
    await window.waitForTimeout(300);
    await expect(sidebar).toHaveAttribute('data-sidebar-preview', 'true');

    // Guard the guard: once keyboard focus leaves, ordinary pointer travel
    // closes it again, so the hold cannot strand the overlay.
    await window.keyboard.press('Escape');
    await expectPreviewClosed(window);
    expect(await readSidebarCollapsed(window)).toBe(true);
  } finally {
    await closeSidebarFixture(electronApp, userDataDir);
  }
});

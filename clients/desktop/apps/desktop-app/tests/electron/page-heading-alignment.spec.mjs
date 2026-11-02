import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

async function readHeadingMetrics(window, pageTestId, title) {
  const page = window.getByTestId(pageTestId);
  const heading = page.getByRole('heading', { name: title, exact: true });
  // The shared PageHeader: the title row, then its one-line description.
  const header = heading.locator('xpath=ancestor::header[1]');
  const subtitle = header.getByTestId('page-header-description');

  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute('data-testid', 'page-header-title');
  await expect(subtitle).toBeVisible();

  return heading.evaluate((element, rootTestId) => {
    const sharedHeading = element.closest('[data-testid="page-header"]');
    if (!(sharedHeading instanceof HTMLElement)) {
      throw new Error('Expected the heading inside the shared page header');
    }
    const subtitleElement = sharedHeading.querySelector(
      ':scope > [data-testid="page-header-description"]',
    );
    if (!(subtitleElement instanceof HTMLElement)) {
      throw new Error('Expected the page description under the title row');
    }

    const pageElement = document.querySelector(`[data-testid="${rootTestId}"]`);
    if (!(pageElement instanceof HTMLElement)) {
      throw new Error('Expected the heading to be inside a page root');
    }

    const pageRect = pageElement.getBoundingClientRect();
    const headingRect = element.getBoundingClientRect();
    const subtitleRect = subtitleElement.getBoundingClientRect();
    const headingStyle = getComputedStyle(element);
    const subtitleStyle = getComputedStyle(subtitleElement);
    const contentElement = sharedHeading.parentElement;
    if (!(contentElement instanceof HTMLElement)) {
      throw new Error('Expected the heading to be inside a page container');
    }
    const contentRect = contentElement.getBoundingClientRect();

    return {
      top: Math.round(headingRect.top - pageRect.top),
      left: Math.round(headingRect.left - pageRect.left),
      containerWidthDelta: Math.round(pageRect.width - contentRect.width),
      containerCenterOffset: Math.round(
        contentRect.left +
          contentRect.width / 2 -
          (pageRect.left + pageRect.width / 2),
      ),
      scrollbarWidth: pageElement.offsetWidth - pageElement.clientWidth,
      titleFontSize: headingStyle.fontSize,
      titleFontWeight: headingStyle.fontWeight,
      subtitleFontSize: subtitleStyle.fontSize,
      subtitleColor: subtitleStyle.color,
      titleSubtitleGap: Math.round(subtitleRect.top - headingRect.bottom),
    };
  }, pageTestId);
}

function headingRhythm({
  left,
  containerWidthDelta,
  containerCenterOffset,
  scrollbarWidth,
  ...rhythm
}) {
  void left;
  void containerWidthDelta;
  void containerCenterOffset;
  void scrollbarWidth;
  return rhythm;
}

test('top-level utility pages share one page-heading rhythm', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-page-heading-alignment-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 2200, height: 1000 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // Workflows › Runs (CAN-3981): the tabs share one "Workflows" heading,
    // rendered inside each tab's own scroll area. Runs has no Pipeline
    // Assistant drawer, so it is the full-width reference the old Automations
    // tab was.
    await app.openWorkflowsTab('runs');
    const automations = await readHeadingMetrics(
      window,
      'page-workflows-runs',
      'Workflows',
    );

    // The page's actions sit at the end of the title row, centred on it.
    const runsHeader = window
      .getByTestId('page-workflows-runs')
      .getByTestId('page-header');
    const [titleBox, actionsBox] = await Promise.all([
      runsHeader.getByTestId('page-header-title').boundingBox(),
      runsHeader.getByTestId('page-header-actions').boundingBox(),
    ]);
    expect(actionsBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
    expect(
      Math.abs(
        actionsBox.y +
          actionsBox.height / 2 -
          (titleBox.y + titleBox.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    await expect(runsHeader.getByTestId('workflows-new-manual')).toHaveCSS(
      'height',
      '28px',
    );

    await app.openPluginsPage();
    const marketplace = await readHeadingMetrics(
      window,
      'page-plugins',
      'Customize',
    );
    // The search row (the field and its status filter) spans the header.
    const marketplaceWidthDelta = await window
      .getByTestId('customize-search-row')
      .evaluate((searchElement) => {
        const headingElement = document.querySelector(
          '[data-testid="page-plugins"] [data-testid="page-header"]',
        );
        if (!(headingElement instanceof HTMLElement)) {
          throw new Error('Expected the Marketplace page heading');
        }
        return Math.round(
          headingElement.getBoundingClientRect().right -
            searchElement.getBoundingClientRect().right,
        );
      });

    await app.openPipelinesPage();
    const pipelines = await readHeadingMetrics(
      window,
      'page-workflows-library',
      'Workflows',
    );
    // Same vertical rhythm on both Workflows tabs. Left is not compared: the
    // Library tab hosts the Pipeline Assistant drawer, which narrows the
    // page and recenters its column.
    expect(pipelines.top).toBe(automations.top);

    await app.openOverviewPage();
    const overview = await readHeadingMetrics(
      window,
      'overview-page',
      'Overview',
    );

    await app.openStatisticsPage();
    const statistics = await readHeadingMetrics(
      window,
      'page-statistics',
      'Statistics',
    );

    await app.openAuditPage();
    const audit = await readHeadingMetrics(window, 'page-audit', 'Audit trail');

    await app.openUsagePage();
    const usage = await readHeadingMetrics(window, 'page-usage', 'Usage');

    // CAN-4266 retired the Agents page; agents are a Marketplace tab, so the
    // Marketplace measurement above covers them.

    // A settings page's title sits at the same window height as a page's,
    // so opening Settings from a page never moves the title.
    const usageTitleTop = await window
      .getByTestId('page-usage')
      .getByTestId('page-header-title')
      .evaluate((element) => Math.round(element.getBoundingClientRect().top));
    await app.openSettings();
    const settingsTitle = window
      .getByTestId('settings-overlay')
      .getByTestId('page-header-title')
      .first();
    await expect(settingsTitle).toBeVisible();
    expect(
      await settingsTitle.evaluate((element) =>
        Math.round(element.getBoundingClientRect().top),
      ),
    ).toBe(usageTitleTop);
    await app.closeSettings();

    const centeredPages = [
      ['Customize', marketplace],
      ['Workflows › Library', pipelines],
      ['Overview', overview],
      ['Statistics', statistics],
      ['Audit trail', audit],
      ['Usage', usage],
    ];
    for (const [pageName, metrics] of centeredPages) {
      expect(
        headingRhythm(metrics),
        `${pageName} should use the shared page-heading rhythm`,
      ).toEqual(headingRhythm(automations));
      expect(Math.abs(metrics.containerCenterOffset)).toBeLessThanOrEqual(8);
      expect(metrics.scrollbarWidth).toBe(automations.scrollbarWidth);
    }
    expect(automations.titleFontSize).toBe('20px');
    // One top offset: the 40px title bar, then the header's page inset, which
    // the inset window layout (the default) keeps at 16px because its card
    // already starts below the window's empty top row. The settings check
    // above holds the title at a settings page's title height.
    expect(automations.top).toBe(56);
    expect(Math.abs(automations.containerCenterOffset)).toBeLessThanOrEqual(8);
    expect(marketplace.left).toBe(automations.left);
    expect(marketplace.containerWidthDelta).toBe(
      automations.containerWidthDelta,
    );
    expect(marketplaceWidthDelta).toBe(0);

    await window.setViewportSize({ width: 1200, height: 800 });
    await app.openWorkflowsTab('runs');
    const mediumAutomations = await readHeadingMetrics(
      window,
      'page-workflows-runs',
      'Workflows',
    );
    await app.openPluginsPage();
    const mediumMarketplace = await readHeadingMetrics(
      window,
      'page-plugins',
      'Customize',
    );
    expect(mediumMarketplace.left).toBe(mediumAutomations.left);
    expect(mediumMarketplace.containerWidthDelta).toBe(
      mediumAutomations.containerWidthDelta,
    );
    expect(mediumMarketplace.scrollbarWidth).toBe(
      mediumAutomations.scrollbarWidth,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

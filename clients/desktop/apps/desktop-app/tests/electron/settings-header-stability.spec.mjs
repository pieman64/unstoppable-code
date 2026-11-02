import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  registerHostedSettingsScenario,
} from './seeders/index.mjs';
import { openOrganizationsList } from './hostedSettingsLocators.mjs';

/**
 * Settings headers hold still (CAN-4558).
 *
 * Once a settings page's header shows, it never moves while that page's
 * content loads, and it keeps its position when the viewer clicks between
 * sibling pages. The header is the page title and description, plus, on
 * organization pages, the switcher, logo, name, role, counts and header
 * actions. Every page and host frame shares one column
 * (`SettingsPageColumn`), so the title's left edge also matches between
 * account and organization pages, and its top matches between sibling pages.
 *
 * The title and description elements' widths are not compared: `PageHeader`'s
 * title column is `flex-1` beside the actions slot, so on a tab with header
 * actions (Add member, New team, Digest settings) both elements are narrower
 * by the actions' width while their text sits in the same place. (The
 * description's `max-w-prose` measure only caps it; in a 1024px window the
 * column is narrower than that measure.) Within one tab the drawn title and
 * description text (a Range over each) and the elements' position and height
 * (the description's height is its wrapping) must hold still from first
 * appearance until the next click, including the swap from the loading
 * placeholder (which reserves the actions slot without actions) to the page.
 * Every page description fits on one line at both widths, so it wraps the
 * same with or without actions.
 *
 * Page data is delayed so each page spends time loading. A MutationObserver
 * plus ResizeObserver probe on `settings-content` records the header boxes on
 * every DOM or size change; requestAnimationFrame would be throttled in the
 * hidden E2E window. Fonts are loaded before the first measurement so a font
 * swap is not mistaken for a shift.
 *
 * The organization-page walk asserts a page header never disappears between
 * pages: the previous page stays in place while the next loads, then the
 * placeholder's page header takes over until the page arrives. The settings
 * rail's scope picker names the organization throughout. Memory is in the
 * walk (CAN-4558 item D). Timeline, Statistics and Memory use the wide
 * column, the other pages the 640px settings column, so titles share their
 * top edge everywhere and their left edge within one column.
 */

const PAGE_DATA_DELAY_MS = 400;
const SETTLE_MS = 300;
const TOLERANCE_PX = 0.5;

const VIEWPORTS = [
  { width: 1440, height: 900 },
  // Narrow enough that long descriptions wrap: wrapping must not depend on
  // whether a page has header actions.
  { width: 1024, height: 900 },
];

/** Organization rail rows, by the page they open. */
const ORG_TABS = [
  ['feed', 'organization-feed', 'wide'],
  ['statistics', 'organization-statistics', 'wide'],
  ['digests', 'organization-digests', 'settings'],
  ['members', 'organization-members', 'settings'],
  ['groups', 'organization-groups', 'settings'],
  ['projects', 'organization-projects', 'settings'],
  ['memory', 'organization-memory', 'wide'],
  ['settings', 'organization-settings-general', 'settings'],
];

const ACCOUNT_PAGES = [
  'account',
  'profile',
  'digests',
  'notifications',
  'integrations',
  'security',
  'billing',
];

/** The header parts the probe follows, by test id. */
const TRACKED = ['page-header', 'page-header-title', 'page-header-description'];

/** The probe's keys for the drawn title and description text. */
const TITLE_TEXT = 'page-header-title-text';
const DESCRIPTION_TEXT = 'page-header-description-text';
/** Element test id → probe key for the Range over its text. */
const TEXT_RANGES = {
  'page-header-title': TITLE_TEXT,
  'page-header-description': DESCRIPTION_TEXT,
};

const ALL_KEYS = ['x', 'y', 'width', 'height'];

/**
 * What must hold still within one tab, per tracked part. The title and
 * description elements' widths follow the actions slot (see above), so their
 * drawn text carries the width check; the description's height is its
 * wrapping.
 */
const STILL_KEYS = {
  'page-header': ALL_KEYS,
  'page-header-title': ['x', 'y', 'height'],
  [TITLE_TEXT]: ALL_KEYS,
  'page-header-description': ['x', 'y', 'height'],
  [DESCRIPTION_TEXT]: ALL_KEYS,
};

async function launchSignedIn(apiKey, viewportSize) {
  // A Timeline long enough to scroll, so the walk crosses a scrolling page.
  await registerHostedSettingsScenario(
    apiKey,
    'hosted-settings-long-timeline',
    {
      overrides: {
        operationDelaysMs: { 'settings.pageData': PAGE_DATA_DELAY_MS },
      },
    },
  );
  const { electronApp, userDataDir } = await launchCanopy({ viewportSize });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await connectMockCloudAccount(window, apiKey);
  await window.evaluate(() => document.fonts.ready.then(() => undefined));
  return { app, electronApp, userDataDir, window };
}

/** Starts recording header boxes inside `settings-content`. */
async function installProbe(window) {
  await window.evaluate(
    ({ tracked, textRanges }) => {
      const content = document.querySelector(
        '[data-testid="settings-content"]',
      );
      if (content === null) throw new Error('Settings content is not open');
      const state = { step: '', records: [] };
      const sizes = new ResizeObserver(() => record());
      const observed = new Set();
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const record = () => {
        const boxes = {};
        for (const testId of tracked) {
          const element = content.querySelector(`[data-testid="${testId}"]`);
          if (element === null || element.getClientRects().length === 0) {
            boxes[testId] = null;
            continue;
          }
          if (!observed.has(element)) {
            observed.add(element);
            sizes.observe(element);
          }
          boxes[testId] = box(element);
        }
        for (const [testId, textKey] of Object.entries(textRanges)) {
          const element = content.querySelector(`[data-testid="${testId}"]`);
          if (element === null || element.getClientRects().length === 0) {
            boxes[textKey] = null;
            continue;
          }
          const range = document.createRange();
          range.selectNodeContents(element);
          boxes[textKey] = box(range);
        }
        const title = content.querySelector(
          '[data-testid="page-header-title"]',
        );
        state.records.push({
          step: state.step,
          title: title?.textContent?.trim() ?? null,
          boxes,
        });
      };
      const mutations = new MutationObserver(() => record());
      mutations.observe(content, {
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style'],
        childList: true,
        subtree: true,
      });
      globalThis.__settingsHeaderProbe = {
        state,
        record,
        stop: () => {
          mutations.disconnect();
          sizes.disconnect();
        },
      };
      record();
    },
    { tracked: TRACKED, textRanges: TEXT_RANGES },
  );
}

/** Names the step the next records belong to (one per click). */
async function beginStep(window, step) {
  await window.evaluate((name) => {
    const probe = globalThis.__settingsHeaderProbe;
    probe.state.step = name;
    probe.record();
  }, step);
}

async function stepRecords(window, step) {
  return window.evaluate(
    (name) =>
      globalThis.__settingsHeaderProbe.state.records.filter(
        (entry) => entry.step === name,
      ),
    step,
  );
}

async function stopProbe(window) {
  await window.evaluate(() => {
    globalThis.__settingsHeaderProbe?.stop();
    delete globalThis.__settingsHeaderProbe;
  });
}

function hostedPage(window, pageKey) {
  return window.locator(
    `[data-testid="hosted-settings-content"][data-hosted-settings-page="${pageKey}"]`,
  );
}

function expectSameBox(actual, expected, label, keys) {
  for (const key of keys) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${label}: ${key} moved from ${expected[key]} to ${actual[key]}`,
    ).toBeLessThanOrEqual(TOLERANCE_PX);
  }
}

/**
 * Within one step, once a tracked part first shows for the page being opened
 * (its title reads the rail label), its box never changes (and it never
 * disappears) until the next click.
 */
function expectStillAfterFirstShown(records, testId, step, title) {
  const shown = records.findIndex(
    (entry) => entry.title === title && entry.boxes[testId] !== null,
  );
  expect(shown, `${testId} never showed on ${step}`).toBeGreaterThanOrEqual(0);
  const first = records[shown].boxes[testId];
  for (const entry of records.slice(shown)) {
    const current = entry.boxes[testId];
    expect(current, `${testId} disappeared on ${step}`).not.toBeNull();
    expectSameBox(current, first, `${testId} on ${step}`, STILL_KEYS[testId]);
  }
}

async function finalTitleBox(window) {
  const box = await window
    .getByTestId('settings-content')
    .getByTestId('page-header-title')
    .boundingBox();
  expect(box).not.toBeNull();
  return box;
}

/** The rail row's label, which the page header repeats as its title. */
async function railLabel(window, rowTestId) {
  return (await window.getByTestId(rowTestId).innerText()).trim();
}

/** Walks the account pages; returns each page's settled title box. */
async function walkAccountPages(window) {
  const titles = {};
  for (const page of ACCOUNT_PAGES) {
    const step = `account/${page}`;
    const row = `settings-nav-account-${page}`;
    const label = await railLabel(window, row);
    await beginStep(window, step);
    await window.getByTestId(row).click();
    await expect(hostedPage(window, step)).toBeVisible();
    await expect(
      hostedPage(window, step).getByTestId('page-header-title'),
    ).toHaveText(label);
    await window.waitForTimeout(PAGE_DATA_DELAY_MS + SETTLE_MS);
    const records = await stepRecords(window, step);
    for (const testId of [
      'page-header',
      'page-header-title',
      TITLE_TEXT,
      'page-header-description',
      DESCRIPTION_TEXT,
    ])
      expectStillAfterFirstShown(records, testId, step, label);
    titles[page] = await finalTitleBox(window);
  }
  return titles;
}

async function openOwnedOrganization(window) {
  await openOrganizationsList(window);
  const list = hostedPage(window, 'organizations/list');
  await expect(list).toBeVisible();
  await list
    .getByTestId('team-panel-org')
    .filter({ hasText: 'Northwind Labs' })
    .first()
    .click();
  await expect(hostedPage(window, 'organization/feed')).toBeVisible();
  await expect(window.getByTestId('settings-nav-scope-title')).toHaveText(
    'Northwind Labs',
  );
  await window.waitForTimeout(PAGE_DATA_DELAY_MS + SETTLE_MS);
}

for (const viewportSize of VIEWPORTS) {
  const size = `${viewportSize.width}x${viewportSize.height}`;

  test(`account page headers hold still and share one column (${size})`, async () => {
    test.setTimeout(180_000);
    const { app, electronApp, userDataDir, window } = await launchSignedIn(
      `csk_settings_header_stability_account_${viewportSize.width}`,
      viewportSize,
    );
    try {
      await app.openSettings();
      await app.openAccountSettingsPage('account');
      await installProbe(window);

      const titles = await walkAccountPages(window);
      const reference = titles.account;
      for (const [page, box] of Object.entries(titles)) {
        expectSameBox(box, reference, `account/${page} title`, ['x', 'y']);
      }

      // An organization Settings page's title sits exactly where the
      // account pages' titles do: one structure for both scopes.
      await openOwnedOrganization(window);
      await window
        .getByTestId('settings-nav-organization-settings-general')
        .click();
      await expect(
        hostedPage(window, 'organization/settings').getByTestId(
          'page-header-title',
        ),
      ).toHaveText('General');
      await window.waitForTimeout(PAGE_DATA_DELAY_MS + SETTLE_MS);
      const organizationTitle = await finalTitleBox(window);
      expectSameBox(
        organizationTitle,
        reference,
        'organization/settings title',
        ['x', 'y'],
      );
    } finally {
      await stopProbe(window).catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test(`organization pages keep their header in place (${size})`, async () => {
    test.setTimeout(180_000);
    const { app, electronApp, userDataDir, window } = await launchSignedIn(
      `csk_settings_header_stability_org_${viewportSize.width}`,
      viewportSize,
    );
    try {
      await app.openSettings();
      await openOwnedOrganization(window);
      await installProbe(window);

      const titles = {};
      for (const [tab, rowKey] of ORG_TABS) {
        const step = `organization/${tab}`;
        const row = `settings-nav-${rowKey}`;
        const label = await railLabel(window, row);
        await beginStep(window, step);
        await window.getByTestId(row).click();
        await expect(hostedPage(window, step)).toBeVisible();
        await expect(
          hostedPage(window, step).getByTestId('page-header-title'),
        ).toHaveText(label);
        await window.waitForTimeout(PAGE_DATA_DELAY_MS + SETTLE_MS);

        const records = await stepRecords(window, step);
        // A page header never leaves the screen between pages.
        for (const entry of records) {
          expect(
            entry.boxes['page-header'],
            `the page header disappeared while opening ${tab}`,
          ).not.toBeNull();
        }
        for (const testId of [...TRACKED, TITLE_TEXT, DESCRIPTION_TEXT]) {
          expectStillAfterFirstShown(records, testId, step, label);
        }
        titles[tab] = await finalTitleBox(window);
      }

      const firstOf = (width) =>
        ORG_TABS.find(([, , column]) => column === width)?.[0];
      for (const [tab, , column] of ORG_TABS) {
        expectSameBox(titles[tab], titles.feed, `organization/${tab} title`, [
          'y',
        ]);
        expectSameBox(
          titles[tab],
          titles[firstOf(column)],
          `organization/${tab} title in its column`,
          ['x'],
        );
      }
    } finally {
      await stopProbe(window).catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

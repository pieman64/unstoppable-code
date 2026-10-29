/**
 * CAN-3053 slice 6 — the shared sidebar surface renders desktop's Chats
 * section: shared header, desktop's Work Entry rows.
 *
 * Two regressions this pins, both found by capturing the flag path next to the
 * shipping one:
 *
 * 1. The shared surface treated `renderCoworkWorkspace` as a whole-section
 *    replacement for the hoisted Chats slot, so supplying it deleted the
 *    shared header. The seam is now the ROWS only.
 * 2. Cowork chat hydration lived in `SidebarWorkspacesSection`, which the flag
 *    path does not mount — so the rows had nothing to render. It now lives in
 *    `useSidebarWorkspaces`, which both paths use.
 *
 * Deterministic: workspaces, worktrees and chat transcripts are seeded on disk
 * before launch. No live agents, no network.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, waitForStableLocator } from './canopyApp.mjs';
import { stubGitHubAvatars } from './githubAvatarStub.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  seedChatsSectionFixture,
  seedWorktreeChat,
} from './seeders/index.mjs';

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

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
      if (performance.now() - stableSince >= 800) break;
    }
  });
}

async function launchSharedRail(
  { originUrl, ...seedOptions } = {},
  { onWindow, beforeLaunch } = {},
) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3053-rail-'),
  );
  seedChatsSectionFixture(userDataDir, seedOptions);
  beforeLaunch?.(userDataDir);
  if (originUrl) {
    // The seeder is a pinned harness source, so the remote is added here.
    // It is only read for display (`git remote get-url`), never fetched.
    execFileSync('git', [
      '-C',
      path.join(userDataDir, 'chats-section-repo'),
      'remote',
      'add',
      'origin',
      originUrl,
    ]);
  }
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 700 },
  });
  const window = await electronApp.firstWindow();
  await onWindow?.(window);
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await window.evaluate((key) => {
    window.localStorage.setItem(key, '1');
  }, SHARED_SIDEBAR_STORAGE_KEY);
  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
  return { electronApp, window, userDataDir };
}

test('the shared rail shows loading projects during initial snapshot hydration', async () => {
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSharedRail();
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'desktop:session-snapshot';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Session snapshot handler is unavailable');
      const barrier = new Promise((resolve) => {
        globalThis.__releaseSidebarSnapshot = resolve;
      });
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        await barrier;
        return original(...args);
      });
    });
    await window.reload();
    await expect(window.getByTestId('sidebar-section-code-loading')).toHaveText(
      'Loading projects',
    );
    await electronApp.evaluate(() => globalThis.__releaseSidebarSnapshot());
    await expect(window.getByTestId('sidebar-section-chats')).toBeVisible();
    await expect(
      window.getByTestId('sidebar-section-code-loading'),
    ).toHaveCount(0);
    await window.getByTestId('sidebar-section-chats-toggle').click();
    await expect(
      window.getByTestId('sidebar-section-chats-toggle'),
    ).toBeVisible();
  } finally {
    await electronApp
      .evaluate(() => globalThis.__releaseSidebarSnapshot?.())
      .catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the shared rail renders the Chats header over desktop Work Entry rows', async () => {
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir } = await launchSharedRail();
  try {
    // The shared section, not the legacy desktop one.
    const section = window.getByTestId('sidebar-section-chats');
    await expect(section).toBeVisible({ timeout: 30_000 });
    // The shared section carries the desktop's own section id and names the
    // workspace it renders; the legacy section carried neither.
    await expect(section).toHaveAttribute('data-workspace-id', /.+/);

    // The header is the shared one, and it is named by the workspace.
    await expect(
      section.getByTestId('sidebar-section-chats-toggle'),
    ).toHaveText('Chats');

    // The rows underneath are DESKTOP's Work Entries — not the portal's flat
    // chats — and they live inside the block the rail's sticky sync measures.
    const mask = section.locator('[data-sidebar-chats-mask]');
    await expect(mask).toHaveCount(1);
    await expect(
      mask.locator('[data-testid^="sidebar-work-entry-"]').first(),
    ).toBeVisible({ timeout: 30_000 });
    // Capped to the section's visible count, with the rest behind "Show all".
    // Asserted by the titles the user actually reads: the row testid prefix
    // also matches the section's hidden pin/drag copies, so counting elements
    // would pin an implementation detail rather than the cap.
    for (const title of [
      'Chat topic 1',
      'Chat topic 2',
      'Chat topic 3',
      'Chat topic 4',
      'Chat topic 5',
    ]) {
      await expect(mask.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(mask.getByText('Chat topic 6', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      mask.getByTestId('sidebar-cowork-project-cowork-default-show-all'),
    ).toBeVisible();

    // The header's full desktop action cluster, not just the gear: the "+"
    // that creates a chat, and the overflow menu carrying template sharing,
    // session import and the sort mode.
    await expect(
      section.getByTestId('sidebar-section-chats-new-chat'),
    ).toBeAttached();
    // The header's controls reveal on hover, as a pointer reaching for them
    // would reveal them.
    await section.getByTestId('sidebar-section-chats-toggle').hover();
    await section.getByTestId('sidebar-section-chats-more').click();
    const menu = window.getByTestId('workspace-session-context-menu');
    await expect(
      menu.getByTestId('workspace-share-template-menu-item'),
    ).toBeVisible();
    await expect(
      menu.getByTestId('workspace-import-session-menu-item'),
    ).toBeVisible();
    await expect(
      menu.getByTestId('workspace-item-sort-last-updated'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the stuck shared Chats header returns to the rows instead of collapsing', async () => {
  // The behaviour PR #3487 added to the desktop header. The shared header is
  // a different component, so the flag path needs its own proof: without it,
  // clicking a stuck header collapses the very rows the user is reaching for.
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir } = await launchSharedRail({
    chatEntryCount: 60,
  });
  try {
    const viewport = window.getByTestId('sidebar-scroll-container');
    await settleSidebar(viewport);
    await window
      .getByTestId('sidebar-cowork-project-cowork-default-show-all')
      .click();
    await settleSidebar(viewport);

    const pin = window.getByTestId('sidebar-projects-pin-bottom');
    await expect(pin).toBeVisible();
    await pin.click();
    await settleSidebar(viewport);
    expect(await viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(
      0,
    );

    const header = window.locator('[data-sidebar-chats-header]');
    const toggle = window.getByTestId('sidebar-section-chats-toggle');
    // The rail advertises the state that changes what the click means, and
    // the shared header now reflects it.
    await expect(header).toHaveAttribute('data-sidebar-chats-stuck', 'true');
    await expect(toggle).not.toHaveAttribute('aria-expanded', /.*/);
    await expect(toggle).toHaveAttribute('aria-label', /^Back to /);

    // Driven through the real mouse: `locator.click()` scrolls its target
    // into view first, which would move the rail past the boundary under
    // test. Tailwind v4 emits `rotate-*` as the standalone `rotate`
    // property, so `transform` stays `none`.
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    // The HEADER is the sticky box; the toggle is a plain button inside it.
    // Without this the header flows away with its own rows and the state
    // above could never be reached.
    expect(
      await header.evaluate((node) => getComputedStyle(node).position),
    ).toBe('sticky');
    await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await settleSidebar(viewport);

    // Back at the rows, still expanded — and a disclosure control again.
    expect(
      await viewport.evaluate((node) => node.scrollTop),
    ).toBeLessThanOrEqual(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).not.toHaveAttribute('aria-label', /.*/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Hiding a project is the only sidebar state the rows themselves cannot
// report: the row simply stops existing. Without the Projects header's
// overflow menu there is nothing left to aim at, and the filter persists
// across restarts — so the project is gone for good (CAN-3133).
// A project header must never be cut in half by the band while it is still
// painted (CAN-3053). It was: with several collapsed projects the header
// approaching the band was sliced at the clip line before the handoff had
// started standing in for it, so the lower half of its name printed directly
// beneath the pinned header above — two project names on top of each other.
// The handoff measured its distance to the pin's bottom, but on the shared
// rail the band also holds a Projects header the legacy rail renders INSIDE
// the band, so the clip sat one header deeper than the handoff thought.
test('the shared rail never slices a project header while another is pinned', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3053-headers-'),
  );
  // Nine collapsed projects: mostly headers, so a header is approaching the
  // band for most of the scroll range. Four projects with one expanded barely
  // exercises the handoff at all.
  const { electronApp } = await launchCanopy({
    userDataDir,
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [
      'ts-pnpm-vite',
      'ts-npm-next',
      'ts-bun-api',
      'go-cli',
      'ts-yarn-cli',
      'ts-npm-nest-monorepo',
      'python-fastapi-uv',
      'python-fastapi-venv',
      'rust-tauri-lite',
    ],
    viewportSize: { width: 900, height: 420 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(async (key) => {
      window.localStorage.setItem(key, '1');
      const prefs = await window.api.loadPreferences();
      await window.api.savePreferences({
        sidebarNavLayout: {
          order: prefs.sidebarNavLayout.order,
          moreStartIndex: 0,
        },
      });
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window
      .locator('[data-testid="worktree-row"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    // The legacy rail also reports zero slices, so prove the shared surface
    // actually mounted before the sweep can mean anything: only it renders
    // the Projects header outside the band.
    await window
      .locator('[data-sidebar-projects-header]')
      .waitFor({ state: 'attached', timeout: 30_000 });
    // A selection pins the selected row into the band, which is the deeper
    // band the report was made against.
    await window.locator('[data-testid="worktree-row"]').first().click();
    await window.waitForTimeout(800);
    const chatsToggle = window.getByTestId('sidebar-section-chats-toggle');
    if (
      (await chatsToggle.count()) > 0 &&
      (await chatsToggle.getAttribute('aria-expanded')) === 'true'
    ) {
      await chatsToggle.click();
      await window.waitForTimeout(250);
    }

    const viewport = window.getByTestId('sidebar-scroll-container');
    const range = await viewport.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    // A rail that does not overflow sweeps nothing and proves nothing.
    expect(range).toBeGreaterThan(200);

    const sliced = [];
    for (let offset = 0; offset <= range; offset += 4) {
      const hits = await viewport.evaluate(async (el, target) => {
        el.scrollTop = target;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const flow = el.querySelector('.sidebar-workspaces-rows-clip');
        if (!flow) return ['no flow layer'];
        const match =
          getComputedStyle(flow).clipPath.match(/^inset\(([-\d.]+)px/);
        if (!match) return [];
        const line = flow.getBoundingClientRect().top + Number(match[1]);
        const out = [];
        for (const header of flow.querySelectorAll(
          '.sidebar-workspace-sticky-header',
        )) {
          const cs = getComputedStyle(header);
          if (cs.opacity === '0' || cs.visibility === 'hidden') continue;
          const contents = header.firstElementChild;
          if (!contents) continue;
          const rect = contents.getBoundingClientRect();
          if (rect.height < 0.5) continue;
          if (!(rect.top < line - 1 && rect.bottom > line + 1)) continue;
          if (Number.parseFloat(getComputedStyle(contents).opacity) <= 0.1)
            continue;
          out.push(
            `scrollTop ${Math.round(el.scrollTop)}: header cut at ${Math.round(line)} (${Math.round(rect.top)}-${Math.round(rect.bottom)})`,
          );
        }
        return out;
      }, offset);
      sliced.push(...hits);
    }
    expect(sliced, sliced.join('\n')).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The Projects group collapses as a whole, the way the legacy rail's does.
// The shared surface could always do this; the desktop host simply never
// asked for it, so the shared rail had no way to put the list away (CAN-3133).
test('the shared rail can collapse the whole Projects group', async () => {
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir } = await launchSharedRail();
  try {
    const toggle = window.getByTestId('sidebar-section-code-toggle');
    const projectRow = window
      .locator(
        `[data-sidebar-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`,
      )
      .first();

    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(projectRow).toHaveCount(0, { timeout: 10_000 });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(projectRow).toBeVisible({ timeout: 10_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the shared rail can hide a project and get it back', async () => {
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir } = await launchSharedRail();
  try {
    const menuButton = window.getByTestId('sidebar-section-code-more');
    // Address the row by the id the fixture seeds, not by a display name.
    // This locator used to look for "Chats fixture project", which the fixture
    // never creates (it seeds "Chats Section Code"), so it matched nothing —
    // which is how the assertions below came to be written as tautologies.
    const projectRow = window
      .locator(
        `[data-sidebar-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`,
      )
      .first();

    // Establish the project is on screen before hiding it, or "hidden" below
    // proves nothing. Assert on the ROW: an earlier version of this test read
    // `evaluate(() => true)`, which resolves to true whatever the sidebar is
    // doing, so it passed while the toggle changed nothing but the dot.
    await expect(menuButton).toHaveCount(1, { timeout: 30_000 });
    await expect(projectRow).toBeVisible({ timeout: 30_000 });

    // Revealed by hovering its header, as a pointer reaching for it would.
    await window.getByTestId('sidebar-section-code-toggle').hover();
    await menuButton.click();
    const menu = window.getByTestId('sidebar-section-code-menu');
    await expect(menu).toBeVisible({ timeout: 10_000 });

    // The visibility checkboxes are the recovery path. Toggle the first
    // project off.
    // Toggle the option belonging to the SAME workspace the assertions below
    // check. Clicking whichever option happens to be first only worked because
    // the fixture pins this workspace to order 0 — reorder the fixture and the
    // test would hide one project while asserting about another.
    const firstOption = menu
      .locator(
        `[data-testid="sidebar-projects-show-${CHATS_SECTION_CODE_WORKSPACE_ID}"]`,
      )
      .first();
    await expect(firstOption).toBeVisible({ timeout: 10_000 });
    const optionLabel = (await firstOption.textContent())?.trim() ?? '';
    expect(optionLabel.length).toBeGreaterThan(0);
    await firstOption.click();

    // With a filter active the control stops hiding behind a hover and marks
    // itself, which is the whole reason a user can find their way back.
    await expect(
      window.getByTestId('sidebar-section-code-more-active-dot'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(menuButton).toHaveAttribute('data-active', 'true');
    // …and the row is actually GONE. This is the assertion the feature is
    // for; the dot only reports that the preference changed.
    await expect(projectRow).toHaveCount(0, { timeout: 10_000 });

    // Put it back through the same menu.
    await firstOption.click();
    await expect(
      window.getByTestId('sidebar-section-code-more-active-dot'),
    ).toHaveCount(0, { timeout: 10_000 });
    // `expect(locator).toBeDefined()` was the old check here — true of any
    // Playwright locator, resolved or not, so recovery was never tested.
    await expect(projectRow).toBeVisible({ timeout: 10_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// At rest the first project must stay in the list. It did not: with the nav
// expanded and Chats open, the Projects label starts far below its seat, and
// the stand-in slot was activated from scrollTop 0 anyway — the in-flow header
// hidden, its copy painted rows lower, the first project "shifted down" until
// the scroll caught up with it (CAN-3053). Nothing may stand in for a header
// while the label it belongs under is still travelling.
test('the shared rail leaves the first project in flow until the Projects label seats', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3053-rest-'),
  );
  seedChatsSectionFixture(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 520 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(async (key) => {
      window.localStorage.setItem(key, '1');
      const prefs = await window.api.loadPreferences();
      // Every nav item in flow, so the label has a long way to travel.
      await window.api.savePreferences({
        sidebarNavLayout: {
          order: prefs.sidebarNavLayout.order,
          moreStartIndex: prefs.sidebarNavLayout.order.length,
        },
      });
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window
      .locator('[data-testid="worktree-row"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await window
      .locator('[data-sidebar-projects-header]')
      .waitFor({ state: 'attached', timeout: 30_000 });
    const chatsToggle = window.getByTestId('sidebar-section-chats-toggle');
    if (
      (await chatsToggle.count()) > 0 &&
      (await chatsToggle.getAttribute('aria-expanded')) !== 'true'
    ) {
      await chatsToggle.click();
      await window.waitForTimeout(250);
    }
    const viewport = window.getByTestId('sidebar-scroll-container');
    await settleSidebar(viewport);

    const probe = (target) =>
      viewport.evaluate(async (el, t) => {
        el.scrollTop = t;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const viewportTop = el.getBoundingClientRect().top;
        const label = el.querySelector('[data-sidebar-projects-header]');
        const labelRect = label.getBoundingClientRect();
        const seat =
          Number.parseFloat(
            getComputedStyle(el).getPropertyValue(
              '--sidebar-workspace-header-top',
            ),
          ) || 0;
        const first = el.querySelector(
          '.sidebar-workspaces-rows-clip .sidebar-workspace-sticky-header',
        );
        const projected = [
          ...el.querySelectorAll(
            '[data-sidebar-sticky-slot-workspace-id]:not([hidden]), [data-sidebar-selected-pin-top]',
          ),
        ]
          .filter(
            (p) =>
              getComputedStyle(p).opacity !== '0' &&
              p.getBoundingClientRect().height > 0.5,
          )
          .map((p) => Math.round(p.getBoundingClientRect().top - viewportTop));
        return {
          scrollTop: Math.round(el.scrollTop),
          labelTop: labelRect.top - viewportTop,
          seat,
          flowHidden:
            first?.hasAttribute('data-sidebar-sticky-flow-hidden') ?? null,
          firstOpacity: first ? getComputedStyle(first).opacity : null,
          projected,
        };
      }, target);

    // The label must genuinely be travelling, or this proves nothing.
    const rest = await probe(0);
    expect(rest.labelTop, JSON.stringify(rest)).toBeGreaterThan(rest.seat + 80);

    const failures = [];
    for (let offset = 0; offset <= 2000; offset += 8) {
      const s = await probe(offset);
      // Inside the handoff window the slot legitimately starts standing in.
      if (s.labelTop <= s.seat + 48) break;
      const away = Math.round(s.labelTop - s.seat);
      if (s.flowHidden || s.firstOpacity === '0') {
        failures.push(
          `scrollTop ${s.scrollTop}: first project header hidden while the label is still ${away}px from its seat`,
        );
      }
      if (s.projected.length > 0) {
        failures.push(
          `scrollTop ${s.scrollTop}: stand-in painted at ${s.projected.join(',')} while the label is still ${away}px from its seat`,
        );
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// A long project name must truncate before the hover controls, on the in-flow
// header and on its pinned copy alike. It ran under the settings cog: the name
// yielded two controls' width on hover while the shared rail reveals three —
// settings, add, and the collapse chevron (CAN-3053).
test('the shared rail truncates a long project name under its hover controls', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3053-name-'),
  );
  seedChatsSectionFixture(userDataDir);
  // Long enough to overflow the rail at any width the harness uses.
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  let renamed = false;
  for (const entry of index.workspaces ?? []) {
    if (entry.id === CHATS_SECTION_CODE_WORKSPACE_ID) {
      entry.name = 'unstoppable-domains-website-2-with-a-much-longer-name';
      renamed = true;
    }
  }
  expect(renamed, 'fixture workspace index entry not found').toBe(true);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 700 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(async (key) => {
      window.localStorage.setItem(key, '1');
      const prefs = await window.api.loadPreferences();
      await window.api.savePreferences({
        sidebarNavLayout: {
          order: prefs.sidebarNavLayout.order,
          moreStartIndex: 0,
        },
      });
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window
      .locator('[data-testid="worktree-row"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await window
      .locator('[data-sidebar-projects-header]')
      .waitFor({ state: 'attached', timeout: 30_000 });

    const measure = async (label, selector) => {
      const header = window.locator(selector).first();
      await expect(header, label).toBeVisible();
      await header.hover();
      await window.waitForTimeout(200);
      return header.evaluate((root, tag) => {
        const button = root.querySelector(
          'button[aria-label^="Select"], button[aria-label^="Collapse"], button[aria-label^="Expand"]',
        );
        const name = button?.querySelector('.truncate');
        const actions = root.querySelector('[data-workspace-header-actions]');
        if (!name || !actions) return `${tag}: name or controls missing`;
        if (getComputedStyle(actions).visibility !== 'visible')
          return `${tag}: controls not revealed on hover`;
        const nameRect = name.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        return nameRect.right > actionsRect.left + 0.5
          ? `${tag}: name ends at ${Math.round(nameRect.right)} but the controls start at ${Math.round(actionsRect.left)}`
          : null;
      }, label);
    };
    const failures = [];
    const flow = await measure(
      'in-flow header',
      '[data-testid^="sidebar-project-header-"]:not([data-testid$="-sticky-slot"]):not([data-testid$="-pin-top"]):not([data-testid$="-pin-bottom"])',
    );
    if (flow) failures.push(flow);

    // Scroll until the header is pinned and measure its copy in the slot.
    const viewport = window.getByTestId('sidebar-scroll-container');
    await viewport.evaluate(async (el) => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await window.waitForTimeout(300);
    const pinned = await measure(
      'pinned header',
      `[data-sidebar-sticky-slot-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]:not([hidden])`,
    );
    if (pinned) failures.push(pinned);
    expect(failures, failures.join('\n')).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

const GITHUB_ORIGIN = 'https://github.com/example-org/example-repo.git';
const OWNER_AVATAR_URL = 'https://github.com/example-org.png?size=32';

/** Launch the shared rail over a GitHub-backed project, avatars stubbed. */
async function launchWithStubbedAvatars(mode) {
  let requested = [];
  const launched = await launchSharedRail(
    { originUrl: GITHUB_ORIGIN },
    {
      // Before the first render, so no avatar request reaches github.com.
      onWindow: async (window) => {
        requested = await stubGitHubAvatars(window, mode);
      },
    },
  );
  return { ...launched, avatarRequests: () => requested };
}

// Tommy's report: every GitHub-backed project header went from the owner's
// avatar to the plain kind badge once the shared rail became the default.
// The legacy rail drew desktop's `ProjectIcon`; the shared rail only drew the
// kind badge. The avatar now rides on the session snapshot's workspace row and
// the shared header draws it in flow and on every pinned copy. The avatar
// request is answered by a local stub, so this holds offline.
test('the shared rail shows the GitHub owner avatar on a GitHub-backed project header', async () => {
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir } =
    await launchWithStubbedAvatars('png');
  try {
    const header = window.getByTestId(
      `sidebar-project-header-${CHATS_SECTION_CODE_WORKSPACE_ID}`,
    );
    await expect(header).toBeVisible({ timeout: 30_000 });
    const avatar = header.locator('img[data-testid="workspace-owner-avatar"]');
    await expect(avatar).toHaveAttribute('src', OWNER_AVATAR_URL, {
      timeout: 30_000,
    });
    await expect(avatar).toHaveAttribute('referrerpolicy', 'no-referrer');
    // Loaded: the avatar paints and the kind badge under it is hidden, not
    // removed, so the footprint never changes.
    await expect(avatar).toBeVisible();
    const badge = header.getByTestId('workspace-kind-badge');
    await expect(badge).toHaveCount(1);
    await expect(badge).toBeHidden();
    // The glyph is the whole icon: nothing between it and the drag handle
    // paints a background, which drew a 2px project-color ring around it.
    const tintedAncestors = await avatar.evaluate((image) => {
      const tinted = [];
      const handle = image.closest('[data-workspace-drag-activator]');
      if (!handle) return ['no drag handle around the avatar'];
      for (
        let element = image.parentElement;
        element && element !== handle;
        element = element.parentElement
      ) {
        const { backgroundColor } = getComputedStyle(element);
        if (backgroundColor !== 'rgba(0, 0, 0, 0)') {
          tinted.push(`${element.className}: ${backgroundColor}`);
        }
      }
      return tinted;
    });
    expect(tintedAncestors).toEqual([]);

    // Cowork projects keep their kind badge.
    await expect(
      window
        .locator(`[data-workspace-id="${CHATS_SECTION_NAMED_COWORK_ID}"]`)
        .locator('img[data-testid^="workspace-owner-avatar"]'),
    ).toHaveCount(0);

    // Every copy of the header matches: scroll the header under the band so
    // the sticky slot's copy mounts, and it wears the avatar too.
    await window
      .locator('[data-sidebar-projects-header]')
      .waitFor({ state: 'attached', timeout: 30_000 });
    await window.locator('[data-testid="worktree-row"]').first().click();
    await window.waitForTimeout(500);
    const viewport = window.getByTestId('sidebar-scroll-container');
    await viewport.evaluate(async (el) => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const slotCopy = window.locator(
      `[data-sidebar-sticky-slot-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`,
    );
    await expect(slotCopy).toHaveCount(1);
    await expect(
      slotCopy.locator('img[data-testid="workspace-owner-avatar-sticky-slot"]'),
    ).toHaveAttribute('src', OWNER_AVATAR_URL);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The avatar is decoration over the kind badge: when it fails (GitHub down,
// an offline machine, a deleted account) the header must fall back to the
// badge, never keep a broken image.
test('the shared rail falls back to the kind badge when the owner avatar fails to load', async () => {
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir, avatarRequests } =
    await launchWithStubbedAvatars('error');
  try {
    const header = window.getByTestId(
      `sidebar-project-header-${CHATS_SECTION_CODE_WORKSPACE_ID}`,
    );
    await expect(header).toBeVisible({ timeout: 30_000 });
    // The avatar was attempted (the row carries the URL)...
    await expect
      .poll(() => avatarRequests().includes(OWNER_AVATAR_URL), {
        timeout: 30_000,
      })
      .toBe(true);
    // ...and after the error no image is left behind and the badge shows.
    await expect(header.locator('img')).toHaveCount(0);
    await expect(header.getByTestId('workspace-kind-badge')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// A header is rendered up to four times at once — in flow, in the sticky slot
// and in both pin bands — and every copy carried the same fixed test ids, so
// `getByTestId('workspace-section-actions')` was strict-mode ambiguous the
// moment a pin mounted (CAN-3127). Pinned copies now suffix their ids the way
// pinned rows already do; the bare id still resolves to the in-flow header.
test('the shared rail gives pinned header copies suffixed test ids', async () => {
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir } = await launchSharedRail();
  try {
    await window
      .locator('[data-testid="worktree-row"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await window
      .locator('[data-sidebar-projects-header]')
      .waitFor({ state: 'attached', timeout: 30_000 });
    // Select a worktree so both pin bands can mount, then scroll the header
    // and its selected row under the band.
    await window.locator('[data-testid="worktree-row"]').first().click();
    await window.waitForTimeout(500);
    const viewport = window.getByTestId('sidebar-scroll-container');
    await viewport.evaluate(async (el) => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await window.waitForTimeout(300);
    // The seat row itself may be hidden here: with the selected row's pin up
    // over this workspace, the rail (like the legacy section) stands the pin
    // in rather than the slot. The id invariant is about the copy that is
    // portaled into the seat, not about which stand-in the rail shows.
    const slotCopy = window.locator(
      `[data-sidebar-sticky-slot-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`,
    );
    await expect(slotCopy).toHaveCount(1);
    // The copy is addressable on its own…
    await expect(
      slotCopy.getByTestId('workspace-section-actions-sticky-slot'),
    ).toHaveCount(1);
    // …and the bare id resolves to exactly one element: the in-flow header.
    const bare = window.getByTestId('workspace-section-actions');
    await expect(bare).toHaveCount(1);
    await expect(
      bare.locator(
        'xpath=ancestor::*[starts-with(@data-testid, "sidebar-project-header-")]',
      ),
    ).toHaveCount(1);
    // The kind badge lives in the host's drag-handle slot rather than in the
    // header's own badge, and cowork rows render badges in flow too, so the
    // invariant is: suffixed inside the copy, never bare inside any pinned
    // host.
    await expect(
      slotCopy.getByTestId('workspace-kind-badge-sticky-slot'),
    ).toHaveCount(1);
    await expect(slotCopy.getByTestId('workspace-kind-badge')).toHaveCount(0);
    const bareInPinnedHosts = await window.evaluate(
      () =>
        [...document.querySelectorAll('[data-testid="workspace-kind-badge"]')]
          .map((el) =>
            el.closest(
              '[data-sidebar-sticky-workspace-slot], [data-sidebar-selected-pin-top], [data-sidebar-selected-pin-bottom]',
            ),
          )
          .filter((host) => host !== null).length,
    );
    expect(bareInPinnedHosts).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3751 moved two things into the shared rail: a project without a usable
// stored color gets its derived color on every badge (the header's own badge
// used to paint the stored value alone), and a project's rows keep one rhythm
// whichever list renders them. Desktop's index requires a color string, so its
// colorless project is one whose string is not a hex color. Desktop draws every
// header badge through its drag handle; this pins what it shows: the derived
// color on the in-flow and pinned copies alike, the same color a stored one of
// that hex paints, and rows flush.
const DERIVED_CODE_PROJECT_COLOR = '#479FFA';

test('the shared rail colors a colorless project alike on every header copy and keeps its rows flush', async () => {
  test.setTimeout(180_000);
  const { electronApp, window, userDataDir } = await launchSharedRail(
    {},
    {
      beforeLaunch: (dir) => {
        const indexPath = path.join(dir, 'workspaces', 'index.json');
        const index = JSON.parse(readFileSync(indexPath, 'utf8'));
        for (const workspace of index.workspaces) {
          if (workspace.id === CHATS_SECTION_CODE_WORKSPACE_ID) {
            workspace.color = '';
          }
          if (workspace.id === CHATS_SECTION_NAMED_COWORK_ID) {
            workspace.color = DERIVED_CODE_PROJECT_COLOR;
          }
        }
        writeFileSync(indexPath, JSON.stringify(index, null, 2));
      },
    },
  );
  try {
    const background = (locator) =>
      locator.evaluate((el) => getComputedStyle(el).backgroundColor);
    const header = window.getByTestId(
      `sidebar-project-header-${CHATS_SECTION_CODE_WORKSPACE_ID}`,
    );
    await expect(header).toBeVisible({ timeout: 30_000 });
    const flowBadge = header.getByTestId('workspace-kind-badge');
    await expect(flowBadge).toBeVisible();
    const flowColor = await background(flowBadge);
    const storedBadge = window
      .locator(`[data-workspace-id="${CHATS_SECTION_NAMED_COWORK_ID}"]`)
      .getByTestId('workspace-kind-badge')
      .first();
    await expect(storedBadge).toBeVisible();
    expect(flowColor).toBe(await background(storedBadge));

    // Adjacent rows of the project sit flush, one pitch apart.
    const rowBoxes = await window
      .locator(
        `[data-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"] [data-testid="worktree-row"]`,
      )
      .evaluateAll((rows) =>
        rows.slice(0, 4).map((row) => {
          const rect = row.getBoundingClientRect();
          return { top: rect.top, height: rect.height };
        }),
      );
    expect(rowBoxes).toHaveLength(4);
    const pitches = rowBoxes
      .slice(1)
      .map((box, index) => Math.round(box.top - rowBoxes[index].top));
    expect(new Set(pitches).size).toBe(1);
    expect(pitches[0]).toBe(Math.round(rowBoxes[0].height));

    // Scroll the header under the band: its pinned copy wears the same color.
    await window
      .locator('[data-sidebar-projects-header]')
      .waitFor({ state: 'attached', timeout: 30_000 });
    await window.locator('[data-testid="worktree-row"]').first().click();
    await window.waitForTimeout(500);
    const viewport = window.getByTestId('sidebar-scroll-container');
    await viewport.evaluate(async (el) => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const slotBadge = window
      .locator(
        `[data-sidebar-sticky-slot-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`,
      )
      .getByTestId('workspace-kind-badge-sticky-slot');
    await expect(slotBadge).toHaveCount(1);
    expect(await background(slotBadge)).toBe(flowColor);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Tommy's report: hovering any worktree row on the shared rail showed the
// hand/grab cursor, which made every row look draggable-only instead of
// clickable. `WorktreeRowDragCursorProvider` unconditionally enabled the
// drag cursor for every sortable row, regardless of whether a drag was
// actually happening. The row must keep the plain arrow cursor at rest and
// on hover, matching the legacy desktop rail, and only switch to the
// grabbing cursor once a drag is actually in progress.
test('a worktree row keeps the arrow cursor at rest and on hover, and grabs only during an active drag', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await expect(row).toBeVisible();
    await waitForStableLocator(window, row);

    const cursorOf = () =>
      row.evaluate((node) => getComputedStyle(node).cursor);

    // At rest, before the pointer ever reaches the row.
    expect(await cursorOf()).toBe('default');

    await row.hover();
    // Hovering alone must not switch to a grab cursor — that is the bug.
    expect(await cursorOf()).toBe('default');

    // Only an ACTIVE drag may show the grabbing cursor.
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    // Grouped rails (#4573) drag a row through its group drag source, which
    // carries the same `data-dragging` contract the sortable wrapper did.
    const wrapper = window.locator('[data-sidebar-group-drag-source]', {
      has: row,
    });
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(
      box.x + box.width / 2,
      box.y + box.height / 2 + 20,
      { steps: 5 },
    );
    await expect(wrapper).toHaveAttribute('data-dragging', 'true');
    expect(await cursorOf()).toBe('grabbing');
    await window.mouse.up();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Tommy's report: a diagonal drag on a worktree row carried the row sideways
// with the pointer ("into the void") instead of only reordering it
// vertically. Restricted to the vertical axis (`restrictToVerticalAxis`), a
// diagonal pointer drag must only move the row up/down; its horizontal
// position stays put.
test('dragging a worktree row with horizontal and vertical pointer movement only moves it vertically', async () => {
  const { electronApp, userDataDir, demoSeed } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });
  try {
    const workspace = demoSeed.workspaces[0];
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // A second worktree so the row has somewhere to reorder against, and so
    // the drag is exercised against a real sortable list, not a lone item.
    await window.evaluate((request) => window.api.createWorktree(request), {
      projectId: workspace.id,
      repoPath: workspace.repoPath,
      existingWorktreeIds: ['demo-main'],
      branchName: 'feature/can-3053-drag-axis',
    });

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await expect(row).toBeVisible({ timeout: 30_000 });
    await waitForStableLocator(window, row);
    // Grouped rails (#4573) drag a row through its group drag source, which
    // carries the same `data-dragging` contract the sortable wrapper did.
    const wrapper = window.locator('[data-sidebar-group-drag-source]', {
      has: row,
    });

    const startBox = await row.boundingBox();
    expect(startBox).not.toBeNull();
    const startX = startBox.x;
    const centerX = startBox.x + startBox.width / 2;
    const centerY = startBox.y + startBox.height / 2;

    await window.mouse.move(centerX, centerY);
    await window.mouse.down();
    // A deliberately diagonal drag: mostly horizontal, some vertical, in
    // several steps so a horizontal escape would be visible throughout.
    for (const [dx, dy] of [
      [40, 8],
      [90, 16],
      [140, 24],
    ]) {
      await window.mouse.move(centerX + dx, centerY + dy, { steps: 4 });
      await expect(wrapper).toHaveAttribute('data-dragging', 'true');
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      // Legacy tolerance for sub-pixel layout rounding; the row must not
      // visibly travel sideways with the pointer.
      expect(Math.abs(box.x - startX)).toBeLessThanOrEqual(1);
    }
    await window.mouse.up();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Give the fixture's code project a long-running launch script, so a launch
 * stays up until the test stops it.
 */
function seedLongRunningLaunchScript(userDataDir) {
  const configPath = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scripts = { ...config.scripts, launch: 'sleep 120' };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

// The shared rail's worktree menu lost Launch, and its row lost the stop
// control a running launch folds into the worktree id (CAN-3053). Both are
// back: Launch starts the script and greys out while it runs, and the row's
// id stops it.
for (const earlyAccess of [false, true]) {
  test(`the shared rail launches a worktree and its id stops the launch (early access ${earlyAccess})`, async () => {
    test.setTimeout(180_000);
    const { electronApp, window, userDataDir } = await launchSharedRail(
      {},
      { beforeLaunch: seedLongRunningLaunchScript },
    );
    try {
      await window.evaluate(
        (enabled) =>
          window.api.experiments.setChoice({
            experimentId: 'early-access',
            enabled,
          }),
        earlyAccess,
      );
      const row = window.locator(
        '[data-testid="worktree-row"][data-worktree-id="feature-01"]',
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Select it first: the scripts store follows runs of loaded worktrees.
      await row.click();

      const openMenu = async () => {
        await row.click({ button: 'right' });
        await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
      };
      await openMenu();
      const launch = window.getByTestId('worktree-actions-menu-launch');
      await expect(launch).toBeEnabled();
      await launch.click();

      const stop = row.getByTestId('worktree-row-stop-launch');
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await expect(stop).toHaveAccessibleName('Stop launch script');
      await expect(stop).toContainText('feature-01');
      if (earlyAccess) {
        await expect(stop).toHaveAttribute('data-launch-status', 'shimmer');
      } else {
        await expect(stop).not.toHaveAttribute('data-launch-status', 'shimmer');
      }
      // A nested percentage max-width used to collapse the ID to a few pixels
      // despite the subtitle having enough room for the whole identifier.
      const idTextFits = await stop.evaluate((button) => {
        const text = button.lastElementChild;
        return text !== null && text.scrollWidth <= text.clientWidth + 1;
      });
      expect(idTextFits).toBe(true);

      await openMenu();
      await expect(
        window.getByTestId('worktree-actions-menu-launch'),
      ).toBeDisabled();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('worktree-actions-menu')).toHaveCount(0);

      await stop.click();
      await expect(stop).toHaveCount(0, { timeout: 30_000 });
      await expect(row).toContainText('feature-01');
      await openMenu();
      await expect(
        window.getByTestId('worktree-actions-menu-launch'),
      ).toBeEnabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

// A clean worktree that is not done still offers the hover Delete chip, and
// the row reserves hover space for every chip it shows so the trailing status
// (here the unread dot) slides out from under them. The reserve used to count
// only done rows' removal, so on a clean row the unread dot painted over the
// Delete chip (CAN-3053).
test('the shared rail keeps the unread dot clear of a clean row Delete chip', async () => {
  test.setTimeout(180_000);
  const worktreeId = 'feature-03';
  const { electronApp, window, userDataDir } = await launchSharedRail(
    {},
    {
      beforeLaunch: (dataDir) =>
        seedWorktreeChat({
          userDataDir: dataDir,
          workspaceId: CHATS_SECTION_CODE_WORKSPACE_ID,
          worktreeId,
          providerType: 'claude',
          tabs: [{ id: 'unread-chat', title: 'Unread chat', unread: true }],
        }),
    },
  );
  try {
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 30_000 });
    // The row paints the unread dot only while it is not done.
    const unread = row.getByTestId('worktree-row-unread');
    await expect(unread).toBeVisible({ timeout: 30_000 });
    // Clean once its diff stats load, so Delete is offered anyway.
    const remove = row.getByTestId('worktree-archive-button');
    await expect(remove).toBeAttached({ timeout: 30_000 });

    await row.hover();
    await expect(remove).toBeVisible();
    await expect(row.getByTestId('worktree-actions-menu-button')).toBeVisible();
    await expect
      .poll(
        async () => {
          const dot = await unread.boundingBox();
          const chip = await remove.boundingBox();
          if (!dot || !chip) return 'unmeasured';
          const overlaps =
            dot.x < chip.x + chip.width &&
            chip.x < dot.x + dot.width &&
            dot.y < chip.y + chip.height &&
            chip.y < dot.y + dot.height;
          return overlaps
            ? `unread dot [${Math.round(dot.x)}, ${Math.round(dot.x + dot.width)}] overlaps Delete chip [${Math.round(chip.x)}, ${Math.round(chip.x + chip.width)}]`
            : 'clear';
        },
        { timeout: 5_000 },
      )
      .toBe('clear');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

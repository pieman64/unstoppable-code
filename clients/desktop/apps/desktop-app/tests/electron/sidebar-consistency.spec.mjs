// The sidebar's controls share one geometry, read back from the rendered app.
//
// A clean design lint does not catch two row types that each picked their own
// values: it checks that every class exists, not that siblings agree. These
// checks read computed geometry, so a hand-rolled control that drifts from its
// neighbours fails here even when every one of its classes is valid.
//
// - A section header's More (…) button and the rail buttons beside it are one
//   family: same 24px box, same corner radius.
// - Every ••• (section header, Chats row, worktree row) is the same control:
//   box, corner, 16px glyph, and hover square.
// - Every nav row draws its glyph at the same size, the More row included.
// - The Projects stand-in pinned to the rail's foot starts its label on the
//   same line as the real Projects header it stands in for.
// - Every small trailing age and count (row ages, project counts, Show all
//   counts) shares one type style, ink and right edge.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/index.mjs';

test('collapsing sidebar headers immediately retires their hover actions', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-collapse-rest-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2, chatEntryCount: 2 });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    for (const [toggleId, actionId] of [
      ['sidebar-section-chats-toggle', 'sidebar-section-chats-more'],
      ['sidebar-section-code-toggle', 'sidebar-section-code-more'],
    ]) {
      const toggle = window.getByTestId(toggleId);
      const action = window.getByTestId(actionId);
      await toggle.hover();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect
        .poll(() =>
          action.evaluate((node) => {
            for (let current = node; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (
                style.visibility === 'hidden' ||
                style.display === 'none' ||
                style.opacity === '0'
              )
                return false;
            }
            return true;
          }),
        )
        .toBe(false);
      // A fresh hover and keyboard navigation still expose the controls.
      await window.mouse.move(600, 400);
      await toggle.hover();
      await expect
        .poll(() => action.evaluate((node) => getComputedStyle(node).opacity))
        .toBe('1');
      await toggle.click();
    }
    const project = window.getByTestId(
      'sidebar-project-header-chats-section-code',
    );
    const toggle = project.getByRole('button', {
      name: 'Collapse Chats Section Code',
      exact: true,
    });
    await toggle.click();
    await expect(
      project.getByTestId('workspace-section-counter'),
    ).toBeVisible();
    await expect(project.getByTestId('workspace-section-actions')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** The box and corner a control renders with. */
async function controlShape(locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radius: style.borderTopLeftRadius,
    };
  });
}

test('empty Chats keeps its create control visible after mouse and keyboard collapse', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-empty-collapse-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2, chatEntryCount: 0 });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    const toggle = window.getByTestId('sidebar-section-chats-toggle');
    const create = window.getByTestId('sidebar-section-chats-new-chat');
    await expect(create).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(create).toBeVisible();
    await toggle.click();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(create).toBeVisible();
    await create.click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** A ••• button's box, corner, glyph size, and hover surface, read while hovered. */
async function moreUnderPointer(locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const glyph = el.querySelector('svg')?.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radius: style.borderTopLeftRadius,
      glyph: glyph ? Math.round(glyph.width) : null,
      hoverBackground: style.backgroundColor,
    };
  });
}

/** Left edge of the first text run inside an element, in viewport pixels. */
async function textLeft(locator) {
  return locator.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent && node.textContent.trim() !== ''
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const node = walker.nextNode();
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    return Math.round(range.getBoundingClientRect().left);
  });
}

test.describe('sidebar consistency', () => {
  test('header buttons, nav glyphs, and the Projects stand-in share one geometry', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-sidebar-consistency-'),
    );
    seedChatsSectionFixture(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 900, height: 560 },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.addStyleTag({
        content: '*, *::before, *::after { transition: none !important; }',
      });

      // 1. Chats header: hover reveals More beside the rail's "+" button.
      const chatsHeader = window.getByTestId('sidebar-section-chats-toggle');
      await chatsHeader.scrollIntoViewIfNeeded();
      await chatsHeader.hover();
      const chatsMore = window.getByTestId('sidebar-section-chats-more');
      const chatsNew = window.getByTestId('sidebar-section-chats-new-chat');
      await expect(chatsMore).toBeVisible();
      await expect(chatsNew).toBeVisible();
      const chatsMoreShape = await controlShape(chatsMore);
      expect(chatsMoreShape).toEqual(await controlShape(chatsNew));
      expect(chatsMoreShape).toMatchObject({ width: 24, height: 24 });

      // 1b. Every ••• is one control. A Chats row's and a worktree row's
      //     ••• match the header's: same box and corner, the same 16px glyph,
      //     and the same hover square under the pointer.
      await chatsMore.hover();
      const headerMore = await moreUnderPointer(chatsMore);
      for (const [section, label] of [
        ['sidebar-section-chats-content', 'Chats row'],
        ['sidebar-section-code', 'worktree row'],
      ]) {
        const rowMore = window
          .getByTestId(section)
          .locator('button[aria-label="More actions"]')
          .first();
        await rowMore.scrollIntoViewIfNeeded();
        await rowMore
          .locator('xpath=ancestor::*[@role="button" or @role="listitem"][1]')
          .first()
          .hover();
        await rowMore.hover();
        expect(await moreUnderPointer(rowMore), label).toEqual(headerMore);
      }

      // 1c. Section menus lead with their sort choice, then their actions.
      await chatsHeader.hover();
      await chatsMore.click();
      const chatsMenu = window.getByTestId('workspace-session-context-menu');
      await expect(chatsMenu).toBeVisible();
      const menuOrder = await chatsMenu.evaluate((menu) =>
        Array.from(
          menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'),
        ).map((item) => item.getAttribute('role')),
      );
      expect(menuOrder.slice(0, 2)).toEqual(['menuitemradio', 'menuitemradio']);
      expect(menuOrder).toContain('menuitem');
      // Menu entry uses a scale animation, which transition: none does not
      // disable. Assert the intended final width instead of sampling a frame.
      await expect
        .poll(() =>
          chatsMenu.evaluate((menu) =>
            Math.round(menu.getBoundingClientRect().width),
          ),
        )
        .toBe(180);
      await window.keyboard.press('Escape');
      await expect(chatsMenu).toBeHidden();

      // 2. Projects header: the same pair.
      const projectsHeader = window.getByTestId('sidebar-section-code-toggle');
      await projectsHeader.scrollIntoViewIfNeeded();
      await projectsHeader.hover();
      const projectsMore = window.getByTestId('sidebar-section-code-more');
      const projectsAdd = window.getByTestId('sidebar-section-code-add');
      await expect(projectsMore).toBeVisible();
      // Its menu settles at the same 180px width; project names truncate
      // rather than widening it.
      await projectsMore.click();
      const projectsMenu = window.getByTestId('sidebar-section-code-menu');
      await expect(projectsMenu).toBeVisible();
      await expect
        .poll(() =>
          projectsMenu.evaluate((menu) =>
            Math.round(menu.getBoundingClientRect().width),
          ),
        )
        .toBe(180);
      await window.keyboard.press('Escape');
      await expect(projectsMenu).toBeHidden();
      await projectsHeader.hover();
      expect(await controlShape(projectsMore)).toEqual(
        await controlShape(projectsAdd),
      );

      // 3. Nav rows: every leading catalog glyph renders at the compact Lucide
      //    size, More included. Brand marks keep their own artwork size.
      const navGlyphSizes = await window
        .locator(
          '[data-sidebar-nav-row] > span:first-child svg[data-icon-family="lucide"]',
        )
        .evaluateAll((svgs) =>
          svgs
            .filter((svg) => svg.getBoundingClientRect().width > 0)
            .map((svg) => Math.round(svg.getBoundingClientRect().width)),
        );
      expect(navGlyphSizes.length).toBeGreaterThan(2);
      expect(new Set(navGlyphSizes)).toEqual(new Set([14]));

      // 4. With the Chats list pushing the real Projects header below the
      //    fold, the stand-in at the rail's foot starts its label on the
      //    header's line.
      const viewport = window.getByTestId('sidebar-scroll-container');
      await viewport.evaluate((el) => {
        el.scrollTop = 0;
      });
      const standIn = window.getByTestId('sidebar-projects-pin-bottom');
      await expect(standIn).toBeVisible();
      const standInLeft = await textLeft(standIn);
      const headerLeft = await textLeft(projectsHeader);
      expect(standInLeft).not.toBeNull();
      expect(standInLeft).toBe(headerLeft);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('trailing ages and counts share one style and one right edge', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-sidebar-trailing-labels-'),
    );
    seedChatsSectionFixture(userDataDir, {
      worktreeCount: 4,
      chatEntryCount: 8,
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1100, height: 900 },
    });
    // The rendered look of one trailing label, and where its text ends.
    const readLabel = (node) => {
      const style = getComputedStyle(node);
      const range = document.createRange();
      range.selectNodeContents(node);
      return {
        testId: node.getAttribute('data-testid'),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        color: style.color,
        fontVariantNumeric: style.fontVariantNumeric,
        textRight: Math.round(range.getBoundingClientRect().right),
      };
    };
    const setCompactSidebar = (window, enabled) =>
      window.evaluate(
        (value) =>
          window.api.experiments.setChoice({
            experimentId: 'sidebar',
            enabled: value,
          }),
        enabled,
      );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.mouse.move(1000, 800);

      // Compact rows carry ages.
      await setCompactSidebar(window, true);
      const worktreeAge = window.getByTestId('worktree-row-age').first();
      await expect(worktreeAge).toBeVisible();
      const chatAge = window
        .getByTestId('sidebar-section-chats-content')
        .locator('[data-testid^="sidebar-work-entry-"][data-testid$="-age"]')
        .first();
      await expect(chatAge).toBeVisible();
      const ages = [
        await worktreeAge.evaluate(readLabel),
        await chatAge.evaluate(readLabel),
      ];

      // Advanced headers carry counts; the sidebar keeps its width.
      await setCompactSidebar(window, false);
      await expect(window.getByTestId('worktree-row-age')).toHaveCount(0);
      const projectCount = window
        .getByTestId('workspace-section-counter')
        .first();
      const showAllCount = window
        .locator('[data-testid$="-show-all-count"]')
        .first();
      await expect(projectCount).toBeVisible();
      await expect(showAllCount).toBeVisible();
      const counts = [
        await projectCount.evaluate(readLabel),
        await showAllCount.evaluate(readLabel),
      ];

      const [reference] = ages;
      for (const label of [...ages, ...counts]) {
        expect(
          {
            fontSize: label.fontSize,
            lineHeight: label.lineHeight,
            fontWeight: label.fontWeight,
            color: label.color,
            fontVariantNumeric: label.fontVariantNumeric,
          },
          label.testId ?? 'trailing label',
        ).toEqual({
          fontSize: reference.fontSize,
          lineHeight: reference.lineHeight,
          fontWeight: reference.fontWeight,
          color: reference.color,
          // Right-aligned labels, not a column of digits.
          fontVariantNumeric: 'normal',
        });
        expect(
          Math.abs(label.textRight - reference.textRight),
          `${label.testId ?? 'trailing label'} right edge`,
        ).toBeLessThanOrEqual(0.5);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

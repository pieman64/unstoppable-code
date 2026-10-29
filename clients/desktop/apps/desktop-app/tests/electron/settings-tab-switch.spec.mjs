import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Switching Settings pages keeps a page on screen.
 *
 * Every page except General loads its code on first visit. That load used to
 * render behind a blank Suspense fallback, and React holds a revealed fallback
 * for at least 300ms, so each first visit emptied the content area before the
 * new page appeared. The current page now stays until the next one is ready.
 *
 * Every page renders its title, including while its preferences load, so a
 * displayed `h1` means a page is on screen. A MutationObserver checks that
 * after every DOM change; requestAnimationFrame would be throttled in the
 * hidden E2E window.
 */
const FIRST_VISIT_SECTIONS = ['display', 'terminal', 'shortcuts', 'legal'];

test('switching settings pages never empties the content area', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.expectSettingsSection('canopy');

    for (const section of FIRST_VISIT_SECTIONS) {
      await window.evaluate(() => {
        const content = document.querySelector(
          '[data-testid="settings-content"]',
        );
        const record = { blankChanges: 0 };
        const observer = new MutationObserver(() => {
          const pageShown = Array.from(content.querySelectorAll('h1')).some(
            (title) => title.getClientRects().length > 0,
          );
          if (!pageShown) {
            record.blankChanges += 1;
          }
        });
        observer.observe(content, {
          attributes: true,
          attributeFilter: ['class', 'hidden', 'style'],
          childList: true,
          subtree: true,
        });
        globalThis.__settingsSwitchProbe = { observer, record };
      });

      await window.getByTestId(`settings-nav-${section}`).click();
      await app.expectSettingsSection(section);

      const blankChanges = await window.evaluate(() => {
        const probe = globalThis.__settingsSwitchProbe;
        probe.observer.disconnect();
        delete globalThis.__settingsSwitchProbe;
        return probe.record.blankChanges;
      });
      expect(
        blankChanges,
        `the content area went blank while opening ${section}`,
      ).toBe(0);
    }

    const sidebar = window.getByTestId('settings-sidebar');
    expect(
      (await window.getByTestId('settings-nav-back').boundingBox())?.height,
    ).toBe(32);
    const headings = await sidebar
      .locator('section[aria-labelledby]')
      .evaluateAll((sections) =>
        sections.map((section) => ({
          id: section.getAttribute('aria-labelledby'),
          label: document.getElementById(
            section.getAttribute('aria-labelledby'),
          )?.textContent,
        })),
      );
    expect(headings.length).toBeGreaterThan(0);
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(
      headings.length,
    );
    expect(headings.every((heading) => heading.label?.trim())).toBe(true);
    const initialWidth = (await sidebar.boundingBox()).width;
    const resize = await window
      .getByTestId('settings-sidebar-resize-handle')
      .boundingBox();
    await window.mouse.move(
      resize.x + resize.width / 2,
      resize.y + resize.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      resize.x + resize.width / 2 + 24,
      resize.y + resize.height / 2,
    );
    await window.mouse.up();
    await expect
      .poll(async () => (await sidebar.boundingBox()).width)
      .toBeGreaterThan(initialWidth);

    await app.closeSettings();
    await app.expectMainPage();
    await app.openSettings();
    await window.keyboard.press('Escape');
    await app.expectMainPage();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

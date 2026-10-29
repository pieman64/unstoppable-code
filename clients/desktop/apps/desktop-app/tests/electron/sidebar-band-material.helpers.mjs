import { expect } from '@playwright/test';

const REDUCED_TRANSPARENCY = 'prefers-reduced-transparency';

/**
 * CAN-3126: reads the sidebar's sticky band material deterministically.
 *
 * The band paints its surface on the opaque sidebar, frosts its backdrop on the
 * macOS translucent material, and paints the surface again when the OS asks
 * for reduced transparency. Which of those a spec observes used to depend on
 * the host: GitHub's macOS runner images turn Reduce transparency on
 * (`defaults write com.apple.universalaccess reduceTransparency -bool true` in
 * actions/runner-images `configure-system.sh`), so Chromium matched
 * `prefers-reduced-transparency: reduce` in CI and the solid fill failed a
 * frost assertion that passed on a developer Mac.
 *
 * Every combination is therefore pinned here: the platform and appearance
 * attributes on the root, and the media feature through the DevTools
 * protocol, since Playwright's `emulateMedia` has no reduced-transparency
 * option. The attributes are restored after each read and the emulation is
 * cleared before returning.
 */
export async function readBandMaterials(window, selector) {
  const cdp = await window.context().newCDPSession(window);
  const setReducedTransparency = (value) =>
    cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: REDUCED_TRANSPARENCY, value }],
    });
  const read = (appearance) =>
    window.evaluate(
      ({ selector, appearance }) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`Expected the sidebar band ${selector}`);
        }
        const root = document.documentElement;
        const originalPlatform = root.getAttribute('data-platform');
        const originalAppearance = root.getAttribute('data-sidebar-appearance');
        root.setAttribute('data-platform', 'darwin');
        root.setAttribute('data-sidebar-appearance', appearance);
        try {
          // Resolve the band's own surface token where the band lives, so the
          // expectation is the CSS contract rather than a hard-coded colour
          // that changes with theme and colour mode.
          const probe = document.createElement('div');
          probe.style.backgroundColor = 'var(--sidebar-selected-pin-surface)';
          element.parentElement?.append(probe);
          const surface = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            backdrop: style.backdropFilter,
            surface,
            // The media query as the page resolved it, so a failure names
            // the environment instead of only a colour.
            reducedTransparency: matchMedia(
              '(prefers-reduced-transparency: reduce)',
            ).matches,
          };
        } finally {
          if (originalPlatform === null) root.removeAttribute('data-platform');
          else root.setAttribute('data-platform', originalPlatform);
          if (originalAppearance === null) {
            root.removeAttribute('data-sidebar-appearance');
          } else {
            root.setAttribute('data-sidebar-appearance', originalAppearance);
          }
        }
      },
      { selector, appearance },
    );

  try {
    await setReducedTransparency('no-preference');
    const opaque = await read('opaque');
    const translucent = await read('translucent');
    await setReducedTransparency('reduce');
    const reducedTransparency = await read('translucent');
    return { opaque, translucent, reducedTransparency };
  } finally {
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
  }
}

/**
 * The band occludes in every appearance, so a row never renders straight
 * through it and the scroll-driven clip is not the only thing hiding it. The
 * opaque sidebar paints its surface. On the 56% translucent material that
 * same fill read as a black block, so the band frosts its backdrop there
 * instead: invisible over the uniform material, blurring out any row that
 * passes underneath. Reduced transparency makes the material opaque, so the
 * band paints its surface again.
 */
export function expectBandOccludes(materials) {
  expect(materials.opaque.reducedTransparency).toBe(false);
  expect(materials.opaque.background).toBe(materials.opaque.surface);
  expect(materials.opaque.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(materials.opaque.backdrop).toBe('none');

  expect(materials.translucent.reducedTransparency).toBe(false);
  expect(materials.translucent.background).toBe('rgba(0, 0, 0, 0)');
  expect(materials.translucent.backdrop).toBe('blur(24px)');

  expect(materials.reducedTransparency.reducedTransparency).toBe(true);
  expect(materials.reducedTransparency.background).toBe(
    materials.reducedTransparency.surface,
  );
  expect(materials.reducedTransparency.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(materials.reducedTransparency.backdrop).toBe('none');
}

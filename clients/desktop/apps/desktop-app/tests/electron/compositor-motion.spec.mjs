// Shared controls move with compositor transforms, never by animating layout
// (`width`, `left`, ...), so their motion stays smooth while the renderer's
// main thread is busy: the segmented picker's surface slides with a
// translate and stretch, the effort slider's knob and fill move with
// `translate`, and the scrollbar thumb grows with `scale`.
//
// Run: pnpm run test:electron:built compositor-motion.spec.mjs --reporter=line
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  CHAT_EFFORT_TRIGGER_TEST_ID,
  closeEffortPanel,
  openEffortSlider,
  stepEffortAway,
} from './effortPanel.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

/** A computed transition list that names a layout property. */
const LAYOUT_PROPERTY =
  /(^|[\s,])(all|width|height|left|right|top|bottom|margin[a-z-]*|padding[a-z-]*|inset|max-width|max-height)(,|$)/;

function prepareUserData() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-compositor-motion-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'compositor-motion-chat', title: 'Compositor motion' }],
  });
  return userDataDir;
}

test('shared controls move by transform, not by layout', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // Effort slider: the knob and the fill move with `translate`.
    const trigger = window.getByTestId(CHAT_EFFORT_TRIGGER_TEST_ID);
    const slider = await openEffortSlider(window, trigger);
    // Every part of the slider that transitions at all, by property list.
    const sliderMotion = () =>
      slider.evaluate((element) =>
        Array.from(element.querySelectorAll('span'))
          .map((part) => getComputedStyle(part))
          .filter((style) =>
            style.transitionDuration.split(',').some((d) => parseFloat(d) > 0),
          )
          .map((style) => style.transitionProperty),
      );
    const before = await sliderMotion();
    expect(before).toContain('translate');
    for (const property of before) {
      expect(property).not.toMatch(LAYOUT_PROPERTY);
    }
    await stepEffortAway(slider);
    for (const property of await sliderMotion()) {
      expect(property).not.toMatch(LAYOUT_PROPERTY);
    }
    await closeEffortPanel(window);

    // Scrollbar thumbs grow on hover by `scale`.
    const thumbTransition = await window.evaluate(() => {
      const probe = document.createElement('div');
      probe.setAttribute('data-sidebar-scrollbar-thumb', '');
      document.body.append(probe);
      const transition = getComputedStyle(probe).transitionProperty;
      probe.remove();
      return transition;
    });
    expect(thumbTransition).toBe('scale, background-color');

    // Segmented picker: picking a segment starts one slide whose keyframes
    // touch `transform` alone, and the surface lands under the segment.
    await app.openSettings();
    await app.openSettingsSection('display');
    const group = window.getByRole('group', { name: 'Project layout' });
    await expect(group).toBeVisible();
    const surface = group.locator(':scope > span[aria-hidden="true"]');
    // No CSS transition at all (the default is `all` over 0s): the slide
    // below is a Web Animation.
    expect(
      await surface.evaluate((element) =>
        getComputedStyle(element)
          .transitionDuration.split(',')
          .every((duration) => parseFloat(duration) === 0),
      ),
    ).toBe(true);
    const segments = group.getByRole('button');
    const pressed = await segments.evaluateAll((buttons) =>
      buttons.findIndex((button) => button.ariaPressed === 'true'),
    );
    const target = segments.nth(pressed === 0 ? 1 : 0);
    const slide = await target.evaluate(async (button) => {
      const track = button.closest('[role="group"]');
      button.click();
      // React commits the pick and its re-measure before the next task.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const moving = track?.querySelector(':scope > span[aria-hidden="true"]');
      return (moving?.getAnimations() ?? []).map((animation) =>
        animation.effect instanceof KeyframeEffect
          ? animation.effect
              .getKeyframes()
              .flatMap((frame) =>
                Object.keys(frame).filter(
                  (key) =>
                    ![
                      'offset',
                      'computedOffset',
                      'easing',
                      'composite',
                    ].includes(key),
                ),
              )
          : [],
      );
    });
    expect(slide).toHaveLength(1);
    expect(new Set(slide[0])).toEqual(new Set(['transform']));
    await expect(target).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => {
        const [under, segment] = await Promise.all([
          surface.boundingBox(),
          target.boundingBox(),
        ]);
        return (
          Math.abs(under.x - segment.x) + Math.abs(under.width - segment.width)
        );
      })
      .toBeLessThan(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

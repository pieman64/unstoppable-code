import { test } from '@playwright/test';
import { seedPanelWorktree } from './panelHarness.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  buildAnimationFixture,
  exerciseAnimationPerformance,
} from '../../../../scripts/test-support/animation-performance.mjs';
for (const mode of ['light', 'dark'])
  test(`visible status and composer shape transitions animate on desktop (${mode})`, async () => {
    const app = await seedPanelWorktree();
    try {
      await app.window.setViewportSize({ width: 1440, height: 1000 });
      await app.window.goto(await buildAnimationFixture('desktop', mode));
      await exerciseAnimationPerformance(app.window);
    } finally {
      await closeCanopy(app.electronApp, app.userDataDir);
    }
  });

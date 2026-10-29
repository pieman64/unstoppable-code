import { setEarlyAccess } from './helpers/earlyAccess.mjs';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Stacked notifications swaps the toast list for the shared notification stack
 * (`ToastStack` in @canopy/ui-shared, built on Base UI). Toasts rest as a
 * deck with the newest in front, spread out while hovered, keep the newest
 * three on screen, and dismiss from their own button. The stack is standard for everyone and defaults to the top-right corner.
 *
 * Toasts come from many unrelated flows, so the spec raises them through the
 * E2E-only `window.__canopyToastTestApi`, which calls the store's `addToast`
 * exactly as a feature does.
 */

function seed(inAppNotifications) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-toast-stack-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { inAppNotifications },
    }),
  );
  seedEarlyAccess({ userDataDir });
  return { userDataDir };
}

test('an old saved default corner migrates when stacked notifications are on', async () => {
  const { userDataDir } = seed({ enabled: true, placement: 'bottom-right' });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: 'Migration toast',
      type: 'success',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    await expect(card).toBeVisible();
    const viewportHeight = await window.evaluate(() => window.innerHeight);
    await expect
      .poll(async () => (await card.boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(48);
    const box = await card.boundingBox();
    expect(box?.y ?? viewportHeight).toBeLessThan(viewportHeight / 3);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

function raiseToast(window, input) {
  return window.evaluate((toast) => {
    const api = window.__canopyToastTestApi;
    if (!api) throw new Error('toast test API is not installed');
    api.addToast(toast);
  }, input);
}

test('stacked notifications stacks toasts, spreads them on hover, and remains standard when the legacy preference changes', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const region = window.getByTestId('toast-live-region');
    await expect(region).toHaveAttribute('role', 'region');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    // Cards slide in from, and leave to, the side of the screen the stack is on.
    await expect(region).toHaveAttribute('data-side', 'right');

    for (const message of ['First toast', 'Second toast', 'Third toast']) {
      await raiseToast(window, {
        message,
        type: 'success',
        meta: {
          persistent: true,
          ...(message === 'Third toast'
            ? { link: { url: 'https://example.test/pr/1' } }
            : {}),
        },
      });
    }
    const stackCards = region.getByTestId('toast-stack-card');
    await expect(stackCards).toHaveCount(3);
    // Newest in front, older cards peeking behind it.
    await expect(stackCards.first()).toContainText('Third toast');
    await expect(stackCards.first()).not.toHaveAttribute('data-expanded', '');

    // With stacked notifications, the stack defaults to the top-right corner, below
    // the header.
    const viewport = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    // Polled: the front card slides in from the side, so it has landed once
    // it stops moving.
    await expect
      .poll(async () => {
        const before = await stackCards.first().boundingBox();
        await window.waitForTimeout(50);
        const after = await stackCards.first().boundingBox();
        return before !== null && after !== null && before.x === after.x
          ? after.y
          : -1;
      })
      .toBeGreaterThanOrEqual(48);
    const frontBox = await stackCards.first().boundingBox();
    expect(frontBox?.y ?? 0).toBeLessThan(viewport.height / 3);
    expect(
      viewport.width - ((frontBox?.x ?? 0) + (frontBox?.width ?? 0)),
    ).toBeLessThan(40);

    // Toast actions are the 32px pill, each label lined up with the copy.
    const copyLink = stackCards.first().getByTestId('toast-copy-link');
    const copyBox = await copyLink.boundingBox();
    expect(copyBox?.height ?? 0).toBeCloseTo(32, 1);
    const copyLabelX = await copyLink.evaluate(
      (button) =>
        button.getBoundingClientRect().left +
        Number.parseFloat(getComputedStyle(button).paddingLeft),
    );
    const messageBox = await stackCards
      .first()
      .getByText('Third toast')
      .boundingBox();
    expect(Math.abs(copyLabelX - (messageBox?.x ?? 0))).toBeLessThanOrEqual(1);

    // Hovering spreads the deck so every card can be read.
    await stackCards.first().hover();
    await expect(stackCards.nth(2)).toHaveAttribute('data-expanded', '');
    for (const index of [0, 1, 2]) {
      await expect(
        stackCards.nth(index).getByTestId('toast-card'),
      ).toBeVisible();
    }

    // Dismiss removes only that toast.
    await stackCards.first().getByTestId('toast-dismiss').click();
    await expect(stackCards).toHaveCount(2);
    await expect(stackCards.first()).toContainText('Second toast');

    // Past three, the oldest steps back until there is room.
    await raiseToast(window, {
      message: 'Fourth toast',
      type: 'error',
      meta: { persistent: true, title: 'Push failed' },
    });
    await raiseToast(window, {
      message: 'Fifth toast',
      type: 'warning',
      meta: { persistent: true },
    });
    await expect(stackCards).toHaveCount(4);
    await expect(
      window.locator('[data-testid="toast-stack-card"][data-limited]'),
    ).toHaveCount(1);
    await expect(
      window.locator('[data-testid="toast-stack-card"][data-limited]'),
    ).toContainText('First toast');
    await expect(
      stackCards.filter({ hasText: 'Fourth toast' }),
    ).toHaveAttribute('data-toast-intent', 'destructive');

    await setEarlyAccess(window, false);
    await expect(region).toHaveAttribute('role', 'region');
    await expect(stackCards).toHaveCount(4);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('a long toast without a destination can be swiped away', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: `Long message ${'x'.repeat(400)}`,
      type: 'warning',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    await expect(card).toBeVisible();
    await expect
      .poll(async () => {
        const before = await card.boundingBox();
        await window.waitForTimeout(50);
        const after = await card.boundingBox();
        return before !== null && after !== null && before.x === after.x
          ? after.x
          : -1;
      })
      .toBeGreaterThan(0);
    const message = card
      .getByTestId('toast-card')
      .locator('span.whitespace-pre-wrap');
    const box = await message.boundingBox();
    expect(box).not.toBeNull();
    const x = box.x + 20;
    const y = box.y + box.height / 2;
    await window.mouse.move(x, y);
    await window.mouse.down();
    await window.mouse.move(x + 15, y, { steps: 2 });
    await window.mouse.move(x + 150, y, { steps: 8 });
    await window.mouse.up();
    await expect(card).toHaveCount(0);
    await expect(window.getByRole('dialog')).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('keyboard opens a long toast message and Escape leaves the toast', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: `Long message ${'x'.repeat(400)}`,
      type: 'warning',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    const read = card.getByRole('button', { name: 'Read full notification' });
    await read.focus();
    await read.press('Enter');
    await expect(window.getByRole('dialog')).toHaveCount(2);
    await window.keyboard.press('Escape');
    await expect(card).toHaveCount(1);
    await expect(window.getByRole('dialog')).toHaveCount(1);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('clicking a long toast opens its full message without dismissing it', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: `Long message ${'x'.repeat(400)}`,
      type: 'warning',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    await expect(card).toBeVisible();
    await expect
      .poll(async () => {
        const before = await card.boundingBox();
        await window.waitForTimeout(50);
        const after = await card.boundingBox();
        return before !== null && after !== null && before.x === after.x
          ? after.x
          : -1;
      })
      .toBeGreaterThan(0);
    await card.locator('span.whitespace-pre-wrap').click();
    await expect(
      window.locator(
        '[role="dialog"][aria-labelledby="toast-detail-modal-title"]',
      ),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(card).toHaveCount(1);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('stacked notifications ignore old false choices and stay standard after restart', async () => {
  const { userDataDir } = seed();
  const file = path.join(userDataDir, 'labs-experiments', 'choices.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.accounts.local = {
    'early-access': false,
    'stacked-notifications': false,
  };
  writeFileSync(file, JSON.stringify(saved));
  let launched = await launchCanopy({ userDataDir });
  try {
    let window = await launched.electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(
      window.getByTestId('labs-experiment-toggle-stacked-notifications'),
    ).toHaveCount(0);
    await app.closeSettings();
    await raiseToast(window, {
      message: 'Standard despite old opt-out',
      type: 'success',
      meta: { persistent: true },
    });
    await expect(window.getByTestId('toast-stack-card')).toBeVisible();
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({ userDataDir });
    window = await launched.electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await raiseToast(window, {
      message: 'Standard after restart',
      type: 'success',
      meta: { persistent: true },
    });
    await expect(window.getByTestId('toast-stack-card')).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a new profile receives stacked notifications without an opt-in', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await raiseToast(window, {
      message: 'New user notification',
      type: 'success',
      meta: { persistent: true },
    });
    await expect(window.getByTestId('toast-stack-card')).toBeVisible();
    await expect(window.getByTestId('toast-live-region')).toHaveAttribute(
      'role',
      'region',
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

/**
 * Sends one horizontal wheel event per animation frame on the card under
 * `point`, as a two-finger trackpad swipe does. Negative deltas move the
 * fingers toward the right edge. The events are dispatched in the page:
 * round trips from the test can stall past the swipe's idle gap on a loaded
 * host, which reads as the fingers lifting.
 */
function trackpadSwipe(window, point, deltas) {
  return window.evaluate(
    ({ x, y, deltas: frames }) =>
      new Promise((resolve) => {
        let index = 0;
        const step = () => {
          const target = document.elementFromPoint(x, y);
          if (index >= frames.length || target === null) {
            resolve(undefined);
            return;
          }
          target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              deltaX: frames[index],
              deltaY: 0,
            }),
          );
          index += 1;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { x: point.x, y: point.y, deltas },
  );
}

test('a trackpad swipe moves the toast with the fingers, then throws it out or springs it back', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: 'Swipe me with two fingers',
      type: 'success',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    await expect(card).toBeVisible();
    // Measure once the card has finished sliding in from the edge.
    await window.waitForTimeout(800);
    const box = await card.boundingBox();
    const point = {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
    await window.mouse.move(point.x, point.y);
    // Hovering spreads the deck; let it settle under the pointer.
    await window.waitForTimeout(500);

    // Tally the swipe the page receives.
    await window.evaluate(() => {
      const swipe = { fingers: 0 };
      window.__toastSwipe = swipe;
      window.addEventListener(
        'wheel',
        (event) => {
          swipe.fingers -= event.deltaX;
        },
        { capture: true, passive: true },
      );
    });
    const reading = () =>
      window.evaluate(() => {
        const el = document.querySelector('[data-testid="toast-stack-card"]');
        return {
          fingers: window.__toastSwipe.fingers,
          wheelX: Number.parseFloat(
            el?.style.getPropertyValue('--toast-wheel-x') || '0',
          ),
          swiping: el?.hasAttribute('data-wheel-swiping') ?? false,
        };
      });

    // A small nudge springs back to its place.
    await trackpadSwipe(window, point, [-2, -2, -2, -2]);
    const nudged = await reading();
    expect(nudged.wheelX).toBeGreaterThan(0);
    expect(nudged.wheelX).toBe(nudged.fingers);
    await expect.poll(async () => (await reading()).wheelX).toBe(0);
    await expect(card).not.toHaveAttribute('data-wheel-swiping', '');
    await expect(card).toBeVisible();

    // A slow swipe far past the dismiss line: the card stays under the
    // fingers 1:1 the whole way, and leaves only once the swipe ends.
    await window.evaluate(() => {
      window.__toastSwipe.fingers = 0;
    });
    // Past half the card's width, so it slides out from under the pointer
    // and the rest of the swipe lands elsewhere.
    await trackpadSwipe(window, point, Array(70).fill(-3));
    const mid = await reading();
    expect(mid.fingers).toBeGreaterThan(box.width / 2);
    expect(mid.swiping).toBe(true);
    expect(mid.wheelX).toBe(mid.fingers);
    await expect(card).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

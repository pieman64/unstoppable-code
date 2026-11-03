import { setEarlyAccess } from './helpers/earlyAccess.mjs';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';
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
    // As wide as a macOS notification banner: 344px.
    expect(frontBox?.width ?? 0).toBeCloseTo(344, 0);

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

/** Waits until the card has stopped sliding in, and returns its box. */
async function settledBox(window, card) {
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute('data-starting-style', '');
  const viewportWidth = await window.evaluate(
    () => document.documentElement.clientWidth,
  );
  await expect
    .poll(async () => {
      const before = await card.boundingBox();
      await window.waitForTimeout(80);
      const after = await card.boundingBox();
      return before !== null &&
        after !== null &&
        after.x >= 0 &&
        after.x + after.width <= viewportWidth &&
        before.x === after.x &&
        before.y === after.y
        ? after.x
        : -1;
    })
    .toBeGreaterThan(0);
  const box = await card.boundingBox();
  if (box === null) throw new Error('toast card has no box');
  return box;
}

test('a toast is as wide as a macOS notification banner, wraps a long title and message, and fits its actions', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const region = window.getByTestId('toast-live-region');
    const stackCards = region.getByTestId('toast-stack-card');

    await raiseToast(window, {
      message: 'Older toast behind the long one',
      type: 'success',
      meta: { persistent: true },
    });
    await raiseToast(window, {
      message:
        'Two steps wrote files outside the worktree, so review them before you share the branch with anyone else on the team.',
      type: 'warning',
      meta: {
        persistent: true,
        title: 'Workflow finished with changes outside the worktree',
        link: { url: 'https://example.test/pr/1' },
      },
      actionLabel: 'Review files',
    });
    await expect(stackCards).toHaveCount(2);
    const front = stackCards.first();
    const box = await settledBox(window, front);
    const viewportWidth = await window.evaluate(() => window.innerWidth);
    expect(box.width).toBeCloseTo(344, 0);
    expect(viewportWidth - (box.x + box.width)).toBeCloseTo(16, 0);

    // The stacked title and message wrap without a one-word last line.
    const copy = front.locator('[data-notice-title-layout="stacked"]');
    expect(
      await copy.evaluate((element) => getComputedStyle(element).textWrapStyle),
    ).toBe('pretty');
    const titleBox = await copy.locator(':scope > div').first().boundingBox();
    const lineHeight = await copy.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    );
    // The long title takes two lines inside the column.
    expect(titleBox?.height ?? 0).toBeGreaterThan(lineHeight * 1.5);
    expect((titleBox?.x ?? 0) + (titleBox?.width ?? Infinity)).toBeLessThan(
      box.x + box.width,
    );

    // Every action fits inside the card. Copy link and Open share the first
    // row; a button that does not fit beside them wraps under them rather
    // than overflowing the card.
    const buttons = front.locator('[data-notice-actions="below"] button');
    await expect(buttons).toHaveCount(3);
    const buttonBoxes = [];
    for (let index = 0; index < 3; index += 1) {
      const buttonBox = await buttons.nth(index).boundingBox();
      if (buttonBox === null) throw new Error('no action box');
      expect(buttonBox.x).toBeGreaterThanOrEqual(box.x);
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
        box.x + box.width - 8,
      );
      expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(
        box.y + box.height,
      );
      buttonBoxes.push(buttonBox);
    }
    const [copyBox, openBox] = buttonBoxes;
    expect(Math.abs(copyBox.y - openBox.y)).toBeLessThanOrEqual(1);
    await expect(buttons.nth(0)).toHaveAttribute(
      'data-testid',
      'toast-copy-link',
    );
    await expect(buttons.nth(2)).toHaveAttribute('data-testid', 'toast-action');

    // Hovered, the pair spreads into two banner-wide cards, 8px apart.
    await front.hover();
    await expect(stackCards.nth(1)).toHaveAttribute('data-expanded', '');
    const backBox = await settledBox(window, stackCards.nth(1));
    expect(backBox.width).toBeCloseTo(344, 0);
    expect(backBox.x).toBeCloseTo(box.x, 0);
    expect(backBox.y).toBeGreaterThanOrEqual(box.y + box.height + 7);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('a worktree toast with no click handler names its worktree and opens it', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openPipelinesPage();
    // A failed setup script toasts this way: worktree meta, no onClick.
    await raiseToast(window, {
      message: 'Setup failed — exit 1',
      type: 'error',
      meta: {
        category: 'Script',
        workspaceName: 'TypeScript pnpm Vite',
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        persistent: true,
      },
    });
    const card = window.getByTestId('toast-card');
    await expect(card.getByTestId('toast-meta-title')).toHaveText(
      'TypeScript pnpm Vite · demo-main',
    );
    await card.getByText('Setup failed — exit 1').click();
    await app.expectMainPage();
    await expect(
      window.locator('[data-sidebar-selected-item]').filter({
        has: window.locator(
          '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
        ),
      }),
    ).toHaveCount(1);
    await expect(card).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('a Cowork toast names its entry after the project, truncating a long name', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-toast-stack-cowork-'),
  );
  const entryName =
    'Draft the quarterly planning report for every regional team and partner';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'toast-cowork',
    name: 'Toast Cowork',
    collapsed: false,
    chatTitle: entryName,
  });
  seedEarlyAccess({ userDataDir });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // The seeded chat becomes the project's one entry, named after it.
    let entryId;
    let entryTitle;
    await expect
      .poll(async () => {
        const { entries } = await window.evaluate(() =>
          window.api.workEntries.list({ projectId: 'toast-cowork' }),
        );
        entryId = entries[0]?.id;
        entryTitle = entries[0]?.title;
        return entryTitle?.startsWith('Draft the quarterly') === true;
      })
      .toBe(true);
    // The sidebar row is the headline's source; wait for it to list.
    await expect(
      window.getByText('Draft the quarterly', { exact: false }).first(),
    ).toBeVisible();
    await raiseToast(window, {
      message: 'Report drafted.',
      type: 'info',
      clickable: true,
      meta: {
        category: 'Chat',
        projectId: 'toast-cowork',
        worktreeId: entryId,
        persistent: true,
      },
    });
    const card = window.getByTestId('toast-card');
    await expect(card.getByTestId('toast-meta-title')).toHaveText(
      `Toast Cowork · ${entryTitle}`,
    );
    const entry = card.getByTestId('toast-meta-worktree');
    expect(
      await entry.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
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
 * Sends one horizontal wheel event per display frame on the card under
 * `point`, as a two-finger trackpad swipe does. Negative deltas move the
 * fingers toward the right edge. The whole swipe plays in one page task, with
 * `performance.now()` stepping a frame per event and ending at the real time:
 * on a loaded host any real gap over the swipe's idle wait reads as the
 * fingers lifting, mid-swipe.
 */
function trackpadSwipe(window, point, deltas) {
  return window.evaluate(
    ({ x, y, deltas: frames }) => {
      const realNow = performance.now.bind(performance);
      const end = realNow();
      let frame = 0;
      performance.now = () => end - (frames.length - frame) * 16;
      try {
        for (; frame < frames.length; frame += 1) {
          const target = document.elementFromPoint(x, y);
          if (target === null) break;
          target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              deltaX: frames[frame],
              deltaY: 0,
            }),
          );
        }
      } finally {
        delete performance.now;
      }
      const card = document.querySelector('[data-testid="toast-stack-card"]');
      return {
        fingers: window.__toastSwipe.fingers,
        wheelX: Number.parseFloat(
          card?.style.getPropertyValue('--toast-swipe-x') || '0',
        ),
        swiping: card?.hasAttribute('data-swipe-dragging') ?? false,
      };
    },
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
            el?.style.getPropertyValue('--toast-swipe-x') || '0',
          ),
          swiping: el?.hasAttribute('data-swipe-dragging') ?? false,
        };
      });

    // A small nudge springs back to its place.
    const nudged = await trackpadSwipe(window, point, [-2, -2, -2, -2]);
    expect(nudged.wheelX).toBeGreaterThan(0);
    expect(nudged.wheelX).toBe(nudged.fingers);
    await expect.poll(async () => (await reading()).wheelX).toBe(0);
    await expect(card).not.toHaveAttribute('data-swipe-dragging', '');
    // Back in its place before the next swipe (a swipe picks a returning
    // card up where it is drawn).
    await expect(card).not.toHaveAttribute('data-swipe-settling', '');
    await expect(card).toBeVisible();

    // A slow swipe past the dismiss line (a quarter of the card): the card
    // stays under the fingers 1:1 the whole way, and leaves only once the
    // swipe ends.
    await window.evaluate(() => {
      window.__toastSwipe.fingers = 0;
    });
    const mid = await trackpadSwipe(window, point, Array(40).fill(-3));
    expect(mid.fingers).toBeGreaterThan(box.width / 4);
    expect(mid.fingers).toBeLessThan(box.width / 2);
    expect(mid.swiping).toBe(true);
    expect(mid.wheelX).toBe(mid.fingers);
    await expect(card).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

/**
 * A quick flick played in the page in one task, so its speed depends on
 * neither test round trips nor frame length on a loaded host: the release
 * speed is read over the last 80ms, and one long frame there reads as still.
 */
function flickInPage(window, point, offsets) {
  return window.evaluate(
    ({ x, y, steps }) => {
      const target = document.elementFromPoint(x, y);
      const fire = (type, [dx, dy]) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x + dx,
            clientY: y + dy,
            pointerId: 7,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
          }),
        );
      fire('pointerdown', [0, 0]);
      for (const offset of steps) fire('pointermove', offset);
      fire('pointerup', steps[steps.length - 1]);
    },
    { x: point.x, y: point.y, steps: offsets },
  );
}

/** A mouse drag on the card, one move per 16ms frame. */
async function mouseDrag(window, from, offsets, { holdMs = 0 } = {}) {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  for (const [dx, dy] of offsets) {
    await window.mouse.move(from.x + dx, from.y + dy);
    await window.waitForTimeout(16);
  }
  if (holdMs > 0) await window.waitForTimeout(holdMs);
  await window.mouse.up();
}

test('a mouse drag follows the pointer, a quick flick throws the toast out and a slow short drag springs back', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: 'Drag me with the mouse',
      type: 'success',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    await expect(card).toBeVisible();
    await window.waitForTimeout(800);
    const box = await card.boundingBox();
    const point = {
      x: Math.round(box.x + box.width * 0.4),
      y: Math.round(box.y + box.height / 2),
    };
    await window.mouse.move(point.x, point.y);
    await window.waitForTimeout(500);
    const swipeX = () =>
      window.evaluate(() =>
        Number.parseFloat(
          document
            .querySelector('[data-testid="toast-stack-card"]')
            ?.style.getPropertyValue('--toast-swipe-x') || '0',
        ),
      );

    // The card moves from the first pixel, before the drag owns the pointer.
    await window.mouse.down();
    await window.mouse.move(point.x + 3, point.y);
    await expect.poll(swipeX).toBe(3);
    await window.mouse.move(point.x + 40, point.y);
    await expect.poll(swipeX).toBe(40);
    // Swipe state belongs to the transform-bearing card, not its text tree.
    const childOffset = await card.evaluate((element) => {
      const content = element.querySelector('.canopy-toast-content');
      if (!content) throw new Error('Missing toast content');
      return getComputedStyle(content)
        .getPropertyValue('--toast-swipe-x')
        .trim();
    });
    expect(childOffset).toBe('0px');
    // Held still, then let go short of a quarter of the card: it returns.
    await window.waitForTimeout(200);
    await window.mouse.up();
    await expect.poll(swipeX).toBe(0);
    await expect(card).not.toHaveAttribute('data-swipe-settling', '');
    await expect(card).toBeVisible();

    // A flick, still short of a quarter of the card: it leaves, and the
    // toast closes.
    await flickInPage(window, point, [
      [15, 0],
      [30, 0],
      [45, 0],
      [60, 0],
    ]);
    await expect(card).toHaveCount(0);
    await expect(window.getByRole('dialog')).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('a toast in a top corner can also be swiped up off the window', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: 'Swipe me up',
      type: 'success',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    await expect(card).toBeVisible();
    await expect(window.getByTestId('toast-live-region')).toHaveAttribute(
      'data-edge',
      'top',
    );
    await window.waitForTimeout(800);
    const box = await card.boundingBox();
    const point = {
      x: Math.round(box.x + box.width * 0.4),
      y: Math.round(box.y + box.height / 2),
    };
    await mouseDrag(window, point, [
      [0, -10],
      [1, -20],
      [1, -30],
      [1, -40],
    ]);
    await expect(card).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('a toast in a bottom corner can be swiped down off the window, and resists going up', async () => {
  const { userDataDir } = seed({
    enabled: true,
    placement: 'bottom-right',
    placementChosen: true,
  });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: 'Swipe me down',
      type: 'success',
      meta: { persistent: true },
    });
    const card = window.getByTestId('toast-stack-card');
    await expect(card).toBeVisible();
    await expect(window.getByTestId('toast-live-region')).toHaveAttribute(
      'data-edge',
      'bottom',
    );
    await window.waitForTimeout(800);
    const box = await card.boundingBox();
    const point = {
      x: Math.round(box.x + box.width * 0.4),
      y: Math.round(box.y + box.height / 2),
    };
    const swipeY = () =>
      window.evaluate(() =>
        Number.parseFloat(
          document
            .querySelector('[data-testid="toast-stack-card"]')
            ?.style.getPropertyValue('--toast-swipe-y') || '0',
        ),
      );

    // Up, away from the bottom edge: the card gives a little, then returns.
    await window.mouse.move(point.x, point.y);
    await window.waitForTimeout(500);
    await window.mouse.down();
    for (const dy of [-10, -30, -60]) {
      await window.mouse.move(point.x, point.y + dy);
      await window.waitForTimeout(16);
    }
    const lifted = await swipeY();
    expect(lifted).toBeLessThan(0);
    expect(lifted).toBeGreaterThan(-60);
    await window.waitForTimeout(200);
    await window.mouse.up();
    await expect.poll(swipeY).toBe(0);
    // Back in its place (a drag picks a returning card up where it is drawn).
    await expect(card).not.toHaveAttribute('data-swipe-settling', '');
    await expect(card).toBeVisible();

    // Down, toward the bottom edge, past half the card: it leaves. The
    // drag starts near the card's top so the pointer stays in the window.
    await mouseDrag(window, { x: point.x, y: Math.round(box.y + 6) }, [
      [0, 10],
      [1, 20],
      [1, 30],
      [1, 40],
    ]);
    await expect(card).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

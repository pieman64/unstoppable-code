import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Dev/E2E-only Notice States gallery: every inline notice rendered through
// the shared `Notice` with its real copy and actions. The gallery is the
// one place the whole family can be reviewed, so this spec keeps its entry
// point and its structural contract (sections, the primitive matrix, the
// dismiss control, the below-placed action row) from silently breaking.
test('the Notice States gallery renders every notice family', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-notice-states-page-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
    // Every dev page lives behind one More entry with tabs.
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-notice-states').click();

    const page = window.getByTestId('page-notice-states');
    await expect(page).toBeVisible();

    for (const section of [
      'composer-preview',
      'primitive',
      'composer',
      'transcript',
      'pipelines',
      'settings',
    ]) {
      await expect(
        page.getByTestId(`notice-gallery-section-${section}`),
      ).toBeVisible();
    }

    // The composer preview mounts the shipping composer and raises the
    // picked notice above it. Switching the picker swaps which notice shows.
    const surface = page.getByTestId('notice-preview-surface');
    await expect(surface.locator('[data-chat-composer-root]')).toBeVisible();
    // Pick the target explicitly: new gallery entries can change the default.
    await page.getByTestId('notice-preview-pick-usage-limit-offer').click();
    await expect(
      surface.getByTestId('notice-gallery-usage-limit-offer'),
    ).toBeVisible();
    await page.getByTestId('notice-preview-pick-ollama-unreachable').click();
    await expect(
      surface.getByTestId('notice-gallery-ollama-unreachable'),
    ).toBeVisible();
    await expect(
      surface.getByTestId('notice-gallery-usage-limit-offer'),
    ).toHaveCount(0);
    await page.getByTestId('notice-preview-pick-none').click();
    await expect(
      surface.getByTestId('notice-gallery-ollama-unreachable'),
    ).toHaveCount(0);

    // The preview composer is pointed at a chat that cannot exist, so the
    // controls that would otherwise fall back to the selected worktree's
    // active tab are withheld. Plan mode is hidden outright. These two only
    // bite when a worktree is selected, since the control keys on that as
    // well; the notice count below is the unconditional guard.
    await expect(
      surface.getByTestId('chat-input-plan-mode-button'),
    ).toHaveCount(0);
    await expect(
      surface.getByTestId('chat-input-plan-mode-inline-button'),
    ).toHaveCount(0);
    // With the picker cleared the surface holds no notice at all: the live
    // banner stack stands down because the preview passes an inert
    // `onSendMessage` without `nativeSessionComposer`.
    await expect(surface.locator('[data-notice-intent]')).toHaveCount(0);

    // The primitive matrix: one row per intent, each on the same surface with
    // a dismiss control and a trailing action pair.
    for (const intent of ['neutral', 'attention', 'destructive', 'positive']) {
      const row = page.getByTestId(`notice-gallery-intent-${intent}`);
      await expect(row).toHaveAttribute('data-notice-intent', intent);
      await expect(row.getByRole('button', { name: 'Dismiss' })).toBeVisible();
      await expect(
        row.getByRole('button', { name: 'Recommended' }),
      ).toBeVisible();
    }

    // The usage-limit offer: a short title, a message that ends with the
    // question, and three short text-only answers on their own row with the
    // accent action, the per-chat Just this chat, last (CAN-5159).
    // Scoped to the section: the preview above renders the same entry with
    // the same test id while it is picked, so an unscoped lookup would match
    // two elements.
    const usageLimit = page
      .getByTestId('notice-gallery-section-composer')
      .getByTestId('notice-gallery-usage-limit-offer');
    await usageLimit.scrollIntoViewIfNeeded();
    await expect(usageLimit).toContainText('Claude usage limit reached');
    await expect(usageLimit).toContainText(
      'Do you want to use AI Credits to keep going?',
    );
    const below = usageLimit.locator('[data-notice-actions="below"]');
    await expect(below).toBeVisible();
    const buttons = below.getByRole('button');
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(0)).toHaveText('No, resume at 6:00 PM');
    await expect(buttons.nth(1)).toHaveText('Always');
    await expect(buttons.nth(2)).toHaveText('Just this chat');
    for (let index = 0; index < 3; index += 1) {
      await expect(buttons.nth(index).locator('svg')).toHaveCount(0);
    }

    // The share suggestion (CAN-3611) has a skill and a plugin variant: the
    // same neutral notice, one primary Share action and a dismiss control.
    for (const [variant, title, message] of [
      [
        'skill',
        'You use release-notes often',
        'Share it so others can use it too.',
      ],
      [
        'plugin',
        'You use Release tools often',
        'Share the plugin so others can use its skills too.',
      ],
    ]) {
      const nudge = page
        .getByTestId('notice-gallery-section-composer')
        .getByTestId(`notice-gallery-skill-share-nudge-${variant}`);
      await nudge.scrollIntoViewIfNeeded();
      await expect(nudge).toHaveAttribute('data-notice-intent', 'neutral');
      await expect(nudge).toContainText(title);
      await expect(nudge).toContainText(message);
      await expect(nudge.getByRole('button', { name: 'Share' })).toBeVisible();
      await expect(
        nudge.getByRole('button', { name: 'Dismiss' }),
      ).toBeVisible();
    }

    // The repeat-task skill suggestion (CAN-385) has a repeated-request and a
    // skill-chain variant: the same neutral notice with Dismiss and a primary
    // Create skill action.
    for (const [variant, title, message] of [
      [
        'prompt',
        "You've asked for this 4 times",
        "Turn it into a skill so it's one step next time.",
      ],
      [
        'chain',
        "You've asked for this 3 times",
        'Turn these 3 skills into one skill.',
      ],
    ]) {
      const suggestion = page
        .getByTestId('notice-gallery-section-composer')
        .getByTestId(`notice-gallery-skill-suggestion-${variant}`);
      await suggestion.scrollIntoViewIfNeeded();
      await expect(suggestion).toHaveAttribute('data-notice-intent', 'neutral');
      await expect(suggestion).toContainText(title);
      await expect(suggestion).toContainText(message);
      await expect(
        suggestion.getByRole('button', { name: 'Create skill' }),
      ).toBeVisible();
      await expect(
        suggestion.getByRole('button', { name: 'Dismiss' }),
      ).toBeVisible();
    }

    // Static prose renders without a live region.
    const privacy = page
      .getByTestId('notice-gallery-section-settings')
      .getByTestId('notice-gallery-import-privacy');
    await privacy.scrollIntoViewIfNeeded();
    await expect(privacy).not.toHaveAttribute('role', /.+/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('notice recovery actions stay inside narrow frames and wrap long labels', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-notice-overflow-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-notice-states').click();
    const notice = window.getByTestId('notice-gallery-intent-attention');
    await expect(notice).toBeVisible();
    await notice.scrollIntoViewIfNeeded();
    for (const width of [640, 280]) {
      await notice.evaluate((element, nextWidth) => {
        element.style.width = `${nextWidth}px`;
        element.style.maxWidth = '100%';
      }, width);
      for (const longLabels of [false, true]) {
        await notice
          .locator('[data-notice-actions] button')
          .evaluateAll((buttons, longLabels) => {
            buttons.forEach((button, index) => {
              button.textContent = longLabels
                ? 'Continue using available credits when the provider quota resets'
                : index === 0
                  ? 'Resume at reset'
                  : 'Always use credits';
            });
          }, longLabels);
        await expect
          .poll(() =>
            notice.evaluate((element) => {
              const frame = element.getBoundingClientRect();
              return (
                [...element.querySelectorAll('button')].every((button) => {
                  const box = button.getBoundingClientRect();
                  return (
                    box.left >= frame.left &&
                    box.right <= frame.right + 1 &&
                    box.top >= frame.top &&
                    box.bottom <= frame.bottom + 1 &&
                    button.scrollWidth <= button.clientWidth + 1 &&
                    button.scrollHeight <= button.clientHeight + 1
                  );
                }) && element.scrollWidth <= element.clientWidth + 1
              );
            }),
          )
          .toBe(true);
      }
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

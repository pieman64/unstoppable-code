import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Early access gives a worktree row's second line to a live status instead
 * of the branch (setup, teardown, git setup, split progress). Work in
 * progress shimmers; a split waiting on the user reads still. Off keeps the
 * branch with the status after a dot.
 */

async function setEarlyAccess(window, enabled) {
  await window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: value,
      }),
    enabled,
  );
}

test('early access shows live statuses in place of the branch', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await expect(window.getByTestId('sidebar-more')).toBeVisible();
    await setEarlyAccess(window, true);

    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-worktree-states').click();
    const page = window.getByTestId('page-worktree-states');
    await expect(page).toHaveAttribute('data-status-model', 'focused');

    const status = (id) =>
      window
        .getByTestId(`gallery-worktree-row-${id}`)
        .getByTestId('worktree-row-subtitle-status');

    await expect(status('setup-running')).toHaveText('Running setup…');
    await expect(status('setup-running')).toHaveClass(/canopy-text-shimmer/);
    await expect(status('setup-git-pending')).toHaveText('Setting up…');
    await expect(status('teardown')).toHaveText('Running teardown…');
    await expect(status('split-active')).toHaveText(
      'Carving child branch (2/4)',
    );
    await expect(status('split-active')).toHaveClass(/canopy-text-shimmer/);
    await expect(status('idle')).toHaveCount(0);

    // Off keeps the classic subtitle.
    await setEarlyAccess(window, false);
    await expect(page).toHaveAttribute('data-status-model', 'classic');
    await expect(
      window.getByTestId('worktree-row-subtitle-status'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

import { expect, test } from '@playwright/test';
import {
  githubScenario,
  openMergeFixture,
  PR_URL,
  queueTab,
} from './helpers/merge-queue-fixture.mjs';

// Real-handler standard baseline and queue-routing regression. Provider
// execution uses the harness's deterministic loopback fixtures.
test('standard Merge calls the direct endpoint with the verified head', async () => {
  test.setTimeout(180_000);
  const fixture = await openMergeFixture({ queue: false });
  try {
    const { window, token, userDataDir } = fixture;
    const merge = window.getByTestId('pr-status-bar-merge-pr');
    await expect(merge).toBeVisible({ timeout: 60_000 });
    // A direct merge keeps the plain treatment: no chat will open.
    await expect(merge).toHaveAttribute('data-merge-via', 'direct');
    await merge.click();
    await expect
      .poll(
        async () => (await githubScenario(token)).mergeRequests?.length ?? 0,
      )
      .toBe(1);
    expect((await githubScenario(token)).mergeRequests[0]).toMatchObject({
      sha: 'a'.repeat(40),
      number: 101,
      owner: 'canopy-e2e',
      repo: 'ts-pnpm-vite',
    });
    // The toast lands once the merge IPC returns, which is after main's real
    // post-merge PR status refresh against the loopback GitHub fixture. That
    // refresh is unstubbed here and has run past the default expect timeout
    // on CI (cause unconfirmed), so wait as long as the other real-poller
    // steps. The poll above already proves the merge itself landed.
    await expect(
      window.getByText('Merged 1 pull request.', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    expect(queueTab(userDataDir)).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

for (const provider of ['claude', 'codex']) {
  test(`${provider} Merge opens and focuses a persisted merge queue skill chat without direct merging`, async () => {
    test.setTimeout(180_000);
    const fixture = await openMergeFixture({ provider });
    try {
      const { window, token, userDataDir } = fixture;
      const merge = window.getByTestId('pr-status-bar-merge-pr');
      await expect(merge).toBeVisible({ timeout: 60_000 });
      // The button says up front that a chat will drive this merge.
      await expect(merge).toHaveAttribute('data-merge-via', 'chat');
      await merge.hover();
      await expect(
        window.getByRole('tooltip', {
          name: 'Start a chat that adds this pull request to the merge queue and watches it until it merges',
        }),
      ).toBeVisible();
      await merge.click();
      // The pointer is still on the button. The direct merge checklist must
      // not open: no GitHub API merge runs, and the chat reports progress.
      await expect(
        window.getByTestId('pr-status-bar-merge-pr-tooltip'),
      ).toHaveCount(0);
      await expect(window.getByText('Merging pull request')).toHaveCount(0);
      await expect
        .poll(
          async () =>
            Boolean(queueTab(userDataDir)) ||
            ((await githubScenario(token)).enqueueRequests?.length ?? 0) > 0,
          { timeout: 60_000 },
        )
        .toBe(true);
      expect(queueTab(userDataDir)?.title).toBe(
        'Merge ts-pnpm-vite through the merge queue',
      );
      const tab = queueTab(userDataDir);
      expect(tab.providerType).toBe(provider);
      expect(tab.approvalMode).toBe('auto');
      expect(JSON.stringify(tab.messages)).toContain(
        `${provider === 'claude' ? '/' : '$'}builtin-gh:merge-pr ${PR_URL}`,
      );
      // A rendered marker in the visible chat proves focus, rather than only
      // checking a tab that was created offscreen.
      await expect(
        window.getByText(/Chat initiated by Merge queue at/),
      ).toBeVisible();
      await expect(
        window.getByText(
          /This chat can add the pull request to the queue, watch it, and help resolve failures/,
        ),
      ).toBeVisible();
      expect((await githubScenario(token)).mergeRequests ?? []).toHaveLength(0);
      expect((await githubScenario(token)).enqueueRequests ?? []).toHaveLength(
        0,
      );
      await expect(
        window.getByText('Merged 1 pull request.', { exact: true }),
      ).toHaveCount(0);
      await expect(
        window.getByText(/Cannot merge .*not mergeable/),
      ).toHaveCount(0);
      await expect(merge).not.toHaveAttribute('aria-label', 'Cancel merge');
    } finally {
      await fixture.cleanup();
    }
  });
}

test('Never setting makes Merge add the pull request to the merge queue without a chat', async () => {
  test.setTimeout(180_000);
  const fixture = await openMergeFixture({ mergeQueueAgentHandling: 'never' });
  try {
    const { window, token, userDataDir } = fixture;
    const merge = window.getByTestId('pr-status-bar-merge-pr');
    await expect(merge).toBeVisible({ timeout: 60_000 });
    // The button says up front that it enters the merge queue itself.
    await expect(merge).toHaveAttribute('data-merge-via', 'queue');
    await merge.hover();
    await expect(
      window.getByRole('tooltip', {
        name: 'Add this pull request to the merge queue',
      }),
    ).toBeVisible();
    await merge.click();
    await expect
      .poll(
        async () => (await githubScenario(token)).enqueueRequests?.length ?? 0,
        { timeout: 60_000 },
      )
      .toBe(1);
    expect((await githubScenario(token)).mergeRequests ?? []).toHaveLength(0);
    // See the direct-merge test: the toast waits on main's real refresh.
    await expect(
      window.getByText('Added 1 pull request to the merge queue.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    expect(queueTab(userDataDir)).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

test('Settings > Git switches Merge from a chat to the merge queue', async () => {
  test.setTimeout(180_000);
  const fixture = await openMergeFixture({});
  try {
    const { window, app } = fixture;
    const merge = window.getByTestId('pr-status-bar-merge-pr');
    await expect(merge).toBeVisible({ timeout: 60_000 });
    // Default: no "PR Removed From Merge Queue" hook, so a chat oversees it.
    await expect(merge).toHaveAttribute('data-merge-via', 'chat');
    await app.openSettings();
    await app.openSettingsSection('git');
    const section = window.getByTestId('settings-git-merge-queue');
    await expect(section).toBeVisible();
    await expect(
      section.getByTestId('settings-git-merge-queue-agent-when-hook-absent'),
    ).toBeChecked();
    await expect(
      section.getByTestId('settings-git-merge-queue-tip'),
    ).toContainText('merge-pr');
    await section.getByTestId('settings-git-merge-queue-agent-never').check();
    await app.closeSettings();
    await expect(merge).toHaveAttribute('data-merge-via', 'queue');
  } finally {
    await fixture.cleanup();
  }
});

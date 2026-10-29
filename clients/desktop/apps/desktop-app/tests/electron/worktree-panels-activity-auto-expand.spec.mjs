// CAN-2836 reopen half — a rail Canopy collapsed by default opens itself the
// first time the worktree produces work worth showing; a rail the USER
// collapsed stays shut forever.
//
// `ensureDefaultWorktreeLayout` seeds `group-activity` collapsed and marks the
// collapse `auto` on the persisted descriptor. `useAutoExpandActivityRail`
// (mounted inside the still-mounted-while-collapsed activity adapter) watches
// the adapter's own `sectionHasContent` map and routes a reopen through
// `expandActivityRailFromContent`, which spends the flag by clearing
// `collapsed` outright. This spec drives that end to end through the real
// renderer, using the PR-status IPC broadcast as the content signal — the same
// channel the main-process poller uses, so no GitHub remote, token, or poll is
// involved and the run stays deterministic.
//
// Run: pnpm run test:electron:built worktree-panels-activity-auto-expand.spec.mjs --reporter=line

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';
import { buildPrStatusEvent, injectGithubPrStatus } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

/** The activity rail leaf, or `undefined` before the layout hydrates. */
async function railLeaf(window) {
  const layout = await getLayout(window);
  return collectLeaves(layout?.root).find(
    (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
  );
}

/**
 * The activity rail leaf's collapse EDGE (e.g. `'right'`), or `null` when
 * expanded.
 *
 * Note this is the test API's flattened projection, not a
 * `PanelCollapsedState` object — reading `.auto` off it would silently yield
 * `undefined` and assert nothing. Use {@link railCollapsedIsAuto} for
 * provenance.
 */
async function railCollapsed(window) {
  return (await railLeaf(window))?.collapsed ?? null;
}

/**
 * Whether the rail's current collapse is Canopy's own seeded default rather
 * than the user's, read from the additive `collapsedAuto` test-API field.
 */
async function railCollapsedIsAuto(window) {
  return (await railLeaf(window))?.collapsedAuto === true;
}

test('a rail Canopy collapsed reopens itself when the worktree produces work', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const activityGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.activity}`,
    );

    // Seeded collapsed, and the seed fixture (demo workspace + one chat tab)
    // reports no work — nothing has opened it.
    await expect(
      activityGroup.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
      ),
    ).toBeVisible();
    expect(await railCollapsed(window)).not.toBeNull();
    // Anchors the `collapsedAuto` probe: the seeded collapse really does
    // carry the flag, so the `toBe(false)` assertion in the user-collapse
    // test below is discriminating rather than vacuously true.
    expect(await railCollapsedIsAuto(window)).toBe(true);

    // The worktree produces work: a pull request appears.
    //
    // Retry the injection rather than firing once. The worktree's PR store
    // entry can lose a very early event — the same race
    // `header-pr-state.scenario.mjs` retries away — and this test injects
    // EARLIER in its run than the user-collapse test below does, so it is the
    // more exposed of the two. `injectGithubPrStatus` is idempotent, so
    // re-sending is free; without this, a lost event surfaces as an opaque
    // visibility timeout with no hint the content signal never landed.
    const prEvent = buildPrStatusEvent({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      prNumber: 823,
    });

    // The rail opens itself, with no user action.
    await expect
      .poll(
        async () => {
          await injectGithubPrStatus(electronApp, prEvent);
          return activityGroup
            .getByTestId('panel-content-activity-section')
            .isVisible()
            .catch(() => false);
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    // The flag is spent: `collapsed` is gone outright, so the reopen is a
    // one-time decision rather than a standing policy.
    await expect.poll(() => railCollapsed(window)).toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a rail the user collapsed is never reopened by new work', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const activityGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.activity}`,
    );

    // The user opens the rail by hand — which spends Canopy's pending
    // decision — and then closes it by hand. That collapse carries no `auto`.
    await activityGroup
      .getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    await expect(
      activityGroup.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await activityGroup
      .getByTestId(`panel-group-collapse-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    await expect(
      activityGroup.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
      ),
    ).toBeVisible();

    // The very same work that would have opened a seeded rail arrives.
    //
    // Assert DELIVERY before asserting the rail stayed shut. `toBeHidden()`
    // and a `collapsed !== null` poll both pass on their very first
    // evaluation, which can happen before the injected event has been
    // processed by the renderer at all — so on their own they would prove
    // nothing about the user-collapse guarantee this test names. The
    // `pr-status-bar` header is an observer OUTSIDE the rail, so waiting for
    // it to render `#823` establishes that the content signal genuinely
    // landed while the rail was collapsed. (Injection is retried because the
    // worktree's PR store entry can lose a very early event, the same race
    // `header-pr-state.scenario.mjs` retries away.)
    const prEvent = buildPrStatusEvent({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      prNumber: 823,
    });
    const prStatusBar = window.getByTestId('pr-status-bar');
    await expect
      .poll(
        async () => {
          await injectGithubPrStatus(electronApp, prEvent);
          return prStatusBar
            .getByText('#823')
            .first()
            .isVisible()
            .catch(() => false);
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // The user's choice wins, permanently: the work is demonstrably present,
    // and the rail is still shut with the user's own (flag-less) collapse.
    await expect(
      activityGroup.getByTestId('panel-content-activity-section'),
    ).toBeHidden();
    expect(await railCollapsed(window)).not.toBeNull();
    // The surviving collapse is the USER's: no `auto` flag, so nothing will
    // ever reopen it. Read through the additive `collapsedAuto` test-API field
    // — the `collapsed` projection is flattened to an edge string, so probing
    // `.auto` on it would pass vacuously no matter what the real flag is.
    expect(await railCollapsedIsAuto(window)).toBe(false);
    await expect(
      activityGroup.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
      ),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Activation notification campaign engine (CAN-1967).
 *
 * Covers the one property unit tests cannot: that the real app, on a real
 * launch, anchors the journey, evaluates it against real product state, and
 * delivers `activation-marketplace` exactly once across restarts.
 *
 * Playwright cannot click a native OS banner, so click routing is covered by
 * the unit suite (`activation-campaign-click-router.test.ts`) rather than here.
 */

const ACTIVATION_FLAG_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-activation-journey-enabled': true,
  }),
  // Native notification delivery depends on host authorization. Keep this
  // journey test deterministic while the unit suite covers OS rejection.
  CANOPY_E2E_ASSUME_OS_NOTIFICATION_SUCCESS: '1',
};

const NINE_HOURS_MS = 9 * 60 * 60 * 1000;

function journeyFilePath(userDataDir) {
  return path.join(userDataDir, 'activation-journey.json');
}

function seedDueJourney(userDataDir) {
  // Nine hours after first open: past the campaign's 8h offset and well
  // inside its 48h lateness bound.
  const anchor = new Date(Date.now() - NINE_HOURS_MS).toISOString();
  writeFileSync(
    journeyFilePath(userDataDir),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: anchor,
        firstOpenAt: anchor,
        // Recent, so the abandonment-anchored campaigns are not yet due and
        // this spec exercises the first-open campaign alone.
        lastActiveAt: new Date().toISOString(),
        holdout: false,
        campaigns: {},
        signals: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // `skipWhenFocused` must be off: the E2E window is focused for the whole
  // run, which would otherwise suppress every campaign as `app-focused`.
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          osNotifications: {
            enabled: true,
            skipWhenFocused: false,
            categories: { activation: true },
          },
          // Quiet hours default to 22:00-08:00, which would make this spec
          // pass or fail depending on what time of day CI runs it.
          activationQuietHours: {
            enabled: false,
            startHour: 22,
            endHour: 8,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function readJourney(userDataDir) {
  return JSON.parse(readFileSync(journeyFilePath(userDataDir), 'utf8'));
}

test('delivers the marketplace campaign once it is due', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-1967-'));
  seedDueJourney(userDataDir);

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ACTIVATION_FLAG_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await expect
      .poll(
        () =>
          readJourney(userDataDir).campaigns?.['activation-marketplace']
            ?.sentAt ?? null,
        { timeout: 30_000 },
      )
      .not.toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('does not re-deliver the campaign on a later launch', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-1967-once-'));
  seedDueJourney(userDataDir);

  const first = await launchCanopy({
    userDataDir,
    env: ACTIVATION_FLAG_ENV,
  });
  let sentAt;
  try {
    const window = await first.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          readJourney(userDataDir).campaigns?.['activation-marketplace']
            ?.sentAt ?? null,
        { timeout: 30_000 },
      )
      .not.toBeNull();
    sentAt =
      readJourney(userDataDir).campaigns['activation-marketplace'].sentAt;
  } finally {
    // Preserve the first launch's send latch for the relaunch assertion below.
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // The send latch is the at-most-once contract; a relaunch must not re-fire.
  const second = await launchCanopy({
    userDataDir,
    env: ACTIVATION_FLAG_ENV,
  });
  try {
    const window = await second.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await window.waitForTimeout(5_000);
    expect(
      readJourney(userDataDir).campaigns['activation-marketplace'].sentAt,
    ).toBe(sentAt);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

/**
 * Getting Started notification sequence (CAN-3013).
 *
 * Same property as above for the daily checklist sequence: on a real launch,
 * against the real checklist evaluator, exactly one step is delivered -- the
 * first incomplete one in canonical order -- and a second evaluation inside
 * the 24-hour window does not deliver another.
 */
const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;
const LONG_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

function seedDueSequence(userDataDir, preferences = {}) {
  const anchor = new Date(Date.now() - TWENTY_FIVE_HOURS_MS).toISOString();
  writeFileSync(
    journeyFilePath(userDataDir),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: anchor,
        firstOpenAt: anchor,
        lastActiveAt: new Date().toISOString(),
        holdout: false,
        // Every activation campaign already sent, long enough ago to sit
        // outside the shared daily cap, so the sequence is the only thing
        // that can deliver here.
        campaigns: {
          'activation-first-task': { sentAt: LONG_AGO },
          'activation-role-branch': { sentAt: LONG_AGO },
          'activation-marketplace': { sentAt: LONG_AGO },
          'activation-mobile': { sentAt: LONG_AGO },
        },
        signals: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          osNotifications: { enabled: true, skipWhenFocused: false },
          activationQuietHours: { enabled: false, startHour: 22, endHour: 8 },
          ...preferences,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function sentSteps(userDataDir) {
  const steps = readJourney(userDataDir).gettingStarted?.steps ?? {};
  return Object.entries(steps)
    .filter(([, record]) => typeof record.sentAt === 'string')
    .map(([itemId]) => itemId);
}

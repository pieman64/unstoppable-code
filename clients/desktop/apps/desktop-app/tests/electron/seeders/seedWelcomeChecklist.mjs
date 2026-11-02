import { seedUserPreferences } from './seedUserPreferences.mjs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './registerScenario.mjs';

/** Deliver the assistant action through the real renderer bridge, without an agent run. */
export async function setOnboardingRoleFromAssistant(electronApp, role) {
  await electronApp.evaluate(({ BrowserWindow }, selectedRole) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!mainWindow) throw new Error('Main window not found');
    mainWindow.webContents.send('app-advisor:tool-request', {
      kind: 'dispatch_action',
      requestId: `onboarding-assistant-role-change-${Date.now()}`,
      action: { type: 'settings.set_profile_role', role: selectedRole },
    });
  }, role);
}

/**
 * Deterministic completed welcome activities, shared by behavior and capture specs.
 *
 * @param {object} [options]
 * @param {boolean} [options.fresh]
 * @param {string} [options.dismissedEntry]
 * @param {string} [options.pendingEntry]
 * @param {string[]} [options.pendingEntries]
 * @param {string[]} [options.enabledPlugins]
 * @param {boolean} [options.startedChat]
 * @param {string[]} [options.roles] Saved profile roles; defaults to a
 *   software engineer unless `fresh`.
 * @param {'completed' | 'dismissed'} [options.legacyNotifications] Also write
 *   the retired `notifications` checklist record (CAN-4005), which answers
 *   the one-time notification offer.
 */
export function seedWelcomeChecklist({
  fresh = false,
  dismissedEntry,
  pendingEntry,
  pendingEntries = [],
  enabledPlugins = [],
  startedChat = false,
  roles = fresh ? [] : ['software-engineer'],
  legacyDismissed = false,
  retired = false,
  exhausted = false,
  legacyNotifications,
} = {}) {
  // `legacyDismissed` writes a pre-module install: there is no
  // `homeOnboardingSuggestions` block for the module-state options to land
  // in, so accepting them would hand back a fixture silently missing the
  // state the caller asked for. Fail loudly instead. (`fresh` stays legal —
  // it still selects whether a profile role is seeded.)
  if (legacyDismissed) {
    const ignored = [
      ['retired', retired],
      ['pendingEntry', pendingEntry !== undefined],
      ['pendingEntries', pendingEntries.length > 0],
      ['dismissedEntry', dismissedEntry !== undefined],
      ['exhausted', exhausted],
      ['legacyNotifications', legacyNotifications !== undefined],
    ]
      .filter(([, set]) => set)
      .map(([name]) => name);
    if (ignored.length > 0) {
      throw new Error(
        `seedWelcomeChecklist: legacyDismissed seeds no module state, so ${ignored.join(', ')} cannot apply. Drop legacyDismissed or drop those options.`,
      );
    }
  }
  const at = '2026-09-01T12:00:00.000Z';
  const ids = [
    'focus-shortcut',
    'launch-at-login',
    'add-repo',
    'github',
    'agent-connections',
    'import-projects',
    'plugin:universal:google',
    'plugin:universal:slack',
    'plugin:universal:notion',
    'plugin:universal:datadog',
    ...(exhausted
      ? ['github', 'linear', 'generic-dev'].flatMap((tool) =>
          Array.from(
            { length: tool === 'linear' ? 4 : 5 },
            (_, index) => `advanced:${tool}:${index}`,
          ),
        )
      : []),
  ];
  // Compatibility for #5220/#5222 and migration tests. Keep authentic legacy
  // progress until both sibling seeders use independent preference fixtures.
  const userDataDir = seedUserPreferences({
    roles,
    enabledPlugins,
    preferences: {
      // A pre-module install that dismissed the CAN-2411 card: the legacy
      // preference is the only welcome state on disk. The explicit empty
      // `onboardingCompleted` keeps `launchCanopy` from seeding the
      // wizard-completed marker, so the fixture stays a faithful pre-wizard
      // install (the marker no longer gates the module either way).
      ...(legacyDismissed
        ? { onboardingCompleted: [], homeOnboardingDismissedAt: at }
        : {
            homeOnboardingSuggestions: {
              startedAt: at,
              // Written by the removed whole-module retirement callback.
              ...(retired ? { retiredAt: at } : {}),
              entries: {
                ...(fresh
                  ? {}
                  : Object.fromEntries(
                      ids.map((id) => [
                        id,
                        id === pendingEntry || pendingEntries.includes(id)
                          ? {}
                          : id === dismissedEntry
                            ? { dismissedAt: at }
                            : { completedAt: at },
                      ]),
                    )),
                ...(legacyNotifications === undefined
                  ? {}
                  : {
                      notifications:
                        legacyNotifications === 'dismissed'
                          ? { dismissedAt: at }
                          : { completedAt: at },
                    }),
              },
            },
          }),
    },
  });
  if (startedChat)
    writeJson(path.join(userDataDir, 'onboarding-checklist.json'), {
      version: 1,
      updatedAt: at,
      completedItems: { 'start-chat': at },
      dismissedAt: null,
      snoozedUntil: null,
      providersNotUsed: [],
    });
  return userDataDir;
}

export async function registerWelcomeCreditsScenario(
  key,
  credits,
  allowance = 50,
  orgFundingAvailable = false,
) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    authUsage: { scenario: 'unauthenticated' },
    cloud: {
      aiCreditsSubscription: { active: false, source: 'canopy' },
      aiCreditsBalance: {
        credits,
        dailyDripCapCredits: allowance,
        ...(orgFundingAvailable === null ? {} : { orgFundingAvailable }),
        orgPool: null,
        eligible: credits > 0,
        source: 'canopy',
      },
    },
  });
}

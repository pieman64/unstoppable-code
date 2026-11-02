import {
  openMergeFixture,
  githubScenario,
  PR_URL,
} from './helpers/merge-queue-fixture.mjs';
import { copilotRuntimeFixture } from './fixtures/copilot-runtime.mjs';
import { openCodeConnectionFixture } from './fixtures/opencode-connection.mjs';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import { launchDesktop, pairDevices } from './helpers/remoteAccess.mjs';
import {
  defaultHostedSettingsOrganizations,
  HOSTED_SETTINGS_ORG_IDS,
  HOSTED_SETTINGS_VIEWER,
} from './mock-server/routes/hosted-settings-fixtures.mjs';
import {
  seedDeliveryCoworkWorkspace,
  expandCoworkWorkspace,
  WORKSPACE_ID as COWORK_WORKSPACE_ID,
  ENTRY_ID as COWORK_ENTRY_ID,
} from './coworkWorkEntryDoneFixture.mjs';
// CAN-3111 / CAN-3114 / CAN-3117 / CAN-3118: real SDK egress, flag
// evaluations, synthetic routes, and masked replay on loopback only.
// Build and run with CANOPY_POSTHOG_ENABLED=true,
// CANOPY_POSTHOG_PROJECT_KEY=phc_e2e_browser, and
// CANOPY_POSTHOG_STUB_URL=http://127.0.0.1:18763, and
// CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE=100.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  closeCanopy,
  launchCanopy,
  prepareIsolatedProviderState,
} from './launchCanopy.mjs';
import {
  seedExternalProjectImportFixture,
  externalProjectCandidateIdFor,
  IMPORT_FIXTURE_GIT_PROJECT,
  IMPORT_FIXTURE_FOLDER_PROJECT,
  IMPORT_FIXTURE_GIT_SESSION_ID,
  IMPORT_FIXTURE_FOLDER_SESSION_ID,
} from './seeders/seedExternalProjectImportFixture.mjs';
import {
  decodePostHogSnapshotData,
  mainReplaySince,
  readPostHogCapture,
  recordedChildren,
  replayNodes,
  startPostHogCapture,
} from './posthogCapture.mjs';
import {
  writeJson,
  registerScenario,
  clearScenario,
  connectMockCloudAccount,
  injectChatEvent,
  DEFAULT_MOCK_BASE_URL,
  seedWorktreeChat,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  seedOrgContextScoping,
  registerHostedSettingsScenario,
} from './seeders/index.mjs';

const DATADOG_ID = '11111111-1111-4111-8111-111111111111';
const POSTHOG_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PRIMARY_CHAT_ID = 'private-chat-primary';
const ALTERNATE_CHAT_ID = 'private-chat-alternate';
const PRIVATE_FIXTURE = Object.freeze({
  workspace: 'Private Acquisitions Workspace 9f4c',
  branch: 'private/board-acquisition-9f4c',
  chat: 'Private acquisition thread 9f4c',
  file: 'board-acquisition-9f4c.txt',
  browser: 'private-browser-9f4c',
  // One distinctive word shape: rrweb masking keeps whitespace, so this text
  // would still appear as `***** ****: ****…` if the transcript were recorded.
  transcript:
    'Transcript 9f4c: quarterly-board-acquisition-memorandum-draft-for-review',
});

// Operation events carry the release version bundled by the build, resolved
// exactly as electron.vite.config.ts does for `__CANOPY_APP_VERSION__`.
const BUNDLED_APP_VERSION =
  process.env.CANOPY_VERSION?.trim() ||
  JSON.parse(
    readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
  ).version;

// `desktop:app_start` reports the bundled flavor, resolved exactly as
// electron.vite.config.ts does for `__CANOPY_RELEASE_FLAVOR__`.
const BUNDLED_RELEASE_CHANNEL =
  process.env.CANOPY_RELEASE_FLAVOR?.trim() || 'stable';

// CAN-4635: exercise discovery/import IPC and the real renderer tracker/SDK.
// Each flow has a fresh install identity; no synthetic operation emission.
for (const { outcome, signedOut } of [
  { outcome: 'skipped', signedOut: false },
  { outcome: 'continued_empty', signedOut: false },
  { outcome: 'imported', signedOut: false },
  { outcome: 'imported', signedOut: true },
]) {
  test(`PostHog ${signedOut ? 'signed-out ' : ''}first-run import reports ${outcome} through the collector`, async () => {
    test.setTimeout(180_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    const collector = await startPostHogCapture();
    const apiKey = 'csk_can4635_signed_out_import';
    if (signedOut)
      await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
        authUsage: { scenario: 'unauthenticated' },
      });
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'can4635-import-'));
    const fixture =
      outcome === 'continued_empty'
        ? undefined
        : seedExternalProjectImportFixture({
            userDataDir,
            activityTimestamps: {
              gitApp: new Date().toISOString(),
              notes: new Date().toISOString(),
            },
          });
    if (!fixture) {
      prepareIsolatedProviderState(userDataDir);
      writeJson(
        path.join(userDataDir, 'provider-state', 'claude', '.claude.json'),
        {},
      );
    }
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: { onboardingCompleted: [] },
    });
    let launched;
    try {
      launched = await launchCanopy({
        userDataDir,
        env: {
          ...fixture?.env,
          ...(signedOut ? { CANOPY_MOCK_API_KEY: apiKey } : {}),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      });
      const window = await launched.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible();
      if (signedOut) {
        // These rows share the real auth hooks with the telemetry producer.
        // Wait for confirmed producer output before submitting the import.
        for (const provider of ['claude', 'codex'])
          await expect(
            page.getByTestId(`auth-panel-${provider}`),
          ).toContainText('Not connected');
      }
      if (fixture) {
        for (const root of [fixture.gitApp, fixture.notes])
          await expect(
            page.getByTestId(
              `first-run-import-row-${externalProjectCandidateIdFor(root)}`,
            ),
          ).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(page.getByTestId('first-run-import-empty')).toBeVisible({
          timeout: 30_000,
        });
      }
      if (outcome === 'imported') {
        const selectAll = page
          .getByTestId('first-run-import-select-all')
          .getByRole('checkbox');
        if (!(await selectAll.isChecked())) await selectAll.check();
        await page.getByTestId('first-run-import-submit').click();
      } else {
        await page.getByTestId('first-run-import-skip').click();
      }
      await expect(page).toHaveCount(0, { timeout: 120_000 });
      const events = (name) =>
        collector.events.filter((event) => event.event === name);
      await expect
        .poll(() => events('onboarding:first_run_import_end').length, {
          timeout: 30_000,
        })
        .toBe(1);
      expect(events('onboarding:first_run_import_view')).toHaveLength(1);
      const view = events('onboarding:first_run_import_view')[0].properties;
      const end = events('onboarding:first_run_import_end')[0].properties;
      if (signedOut)
        expect(end).toMatchObject({
          claude_connection: 'not_connected',
          codex_connection: 'not_connected',
        });
      for (const facts of [view, end]) {
        expect(['connected', 'not_connected', 'unknown']).toContain(
          facts.claude_connection,
        );
        expect(['connected', 'not_connected', 'unknown']).toContain(
          facts.codex_connection,
        );
      }
      expect(end).toMatchObject({
        outcome,
        scan_outcome: outcome === 'continued_empty' ? 'empty' : 'found',
        found_count: fixture ? 2 : 0,
        imported_count: outcome === 'imported' ? 2 : 0,
        submission_count: outcome === 'imported' ? 1 : 0,
        failed_submission_count: 0,
        picked_folder: false,
        status: 'success',
        surface: 'main',
        duration_ms: expect.any(Number),
      });
      expect(end.duration_ms).toBeGreaterThanOrEqual(0);
      if (outcome === 'imported') {
        await expect.poll(() => events('projects:import_end').length).toBe(1);
        expect(events('projects:import_end')[0].properties).toMatchObject({
          source: 'first_run',
          outcome: 'imported',
          status: 'success',
          selected_count: 2,
          imported_count: 2,
          failed_count: 0,
          found_claude_count: 2,
          found_codex_count: 0,
          imported_claude_count: 2,
          imported_codex_count: 0,
          chats_imported_count: 0,
          duration_ms: expect.any(Number),
          ...(signedOut
            ? {
                claude_connection: 'not_connected',
                codex_connection: 'not_connected',
              }
            : {}),
        });
        expect(end.duration_ms).toBeGreaterThanOrEqual(
          events('projects:import_end')[0].properties.duration_ms,
        );
      } else expect(events('projects:import_end')).toHaveLength(0);
      const wire = JSON.stringify(
        collector.requests.map((request) => request.payload),
      );
      for (const secret of [
        userDataDir,
        IMPORT_FIXTURE_GIT_PROJECT,
        IMPORT_FIXTURE_FOLDER_PROJECT,
        IMPORT_FIXTURE_GIT_SESSION_ID,
        IMPORT_FIXTURE_FOLDER_SESSION_ID,
        ...(fixture
          ? [
              fixture.gitApp,
              fixture.notes,
              externalProjectCandidateIdFor(fixture.gitApp),
              externalProjectCandidateIdFor(fixture.notes),
            ]
          : []),
      ])
        expect(wire).not.toContain(secret);
      expect(collector.parseErrors).toEqual([]);
    } finally {
      if (launched) await closeCanopy(launched.electronApp, userDataDir);
      fixture?.cleanup();
      if (signedOut) await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      await collector.shutdown();
    }
  });
}

test('PostHog pairing joins real computer lifecycle events to distinct install identities', async () => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const collector = await startPostHogCapture();
  const relay = await startDeviceRelay();
  const apiKey = 'csk_can4635_pairing';
  let host;
  let controller;
  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'private-can4635-relay-user',
        },
      },
    });
    host = await launchDesktop({ label: 'can4635-host', apiKey });
    controller = await launchDesktop({ label: 'can4635-controller', apiKey });
    await pairDevices(controller, host);
    const ends = () =>
      collector.events.filter((event) => event.event === 'remote:pairing_end');
    await expect.poll(() => ends().length, { timeout: 30_000 }).toBe(2);
    expect(
      collector.events.filter(
        (event) => event.event === 'remote:pairing_start',
      ),
    ).toHaveLength(2);
    expect(
      ends()
        .map((event) => event.properties.pairing_kind)
        .sort(),
    ).toEqual(['computer_incoming', 'computer_outgoing']);
    expect(
      new Set(
        ends().map(
          (event) => event.distinct_id ?? event.properties.distinct_id,
        ),
      ).size,
    ).toBe(2);
    for (const event of ends())
      expect(event.properties).toMatchObject({
        outcome: 'approved',
        status: 'success',
        duration_ms: expect.any(Number),
        surface: 'background',
      });
    const privateDevices = await Promise.all(
      [host, controller].map((desktop) =>
        desktop.window.evaluate(
          async () => (await window.api.remoteControl.getState()).thisDevice,
        ),
      ),
    );
    const wire = JSON.stringify(
      collector.requests.map((request) => request.payload),
    );
    for (const value of [
      apiKey,
      relay.secret,
      'private-can4635-relay-user',
      host.userDataDir,
      controller.userDataDir,
      ...privateDevices.flatMap((device) => [device.deviceId, device.name]),
    ])
      expect(wire).not.toContain(value);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (controller)
      await closeCanopy(controller.electronApp, controller.userDataDir);
    if (host) await closeCanopy(host.electronApp, host.userDataDir);
    await relay.stop();
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    await collector.shutdown();
  }
});

test('PostHog organization send and accept share a reference across distinct desktop installs', async () => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const collector = await startPostHogCapture();
  const senderKey = 'csk_can4635_invite_sender';
  const recipientKey = 'csk_can4635_invite_recipient';
  const email = 'private-can4635-recipient@example.test';
  const flags = {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-desktop-hosted-settings': true,
      'canopy-shared-org-projects-enabled': true,
    }),
  };
  let sender;
  let recipient;
  try {
    await registerHostedSettingsScenario(senderKey);
    sender = await launchCanopy({ env: flags });
    const senderWindow = await sender.electronApp.firstWindow();
    await new CanopyAppDriver(senderWindow).waitForShell();
    await connectMockCloudAccount(senderWindow, senderKey);
    const sent = await senderWindow.evaluate(
      async ({ organizationId, email }) => {
        const account = await window.api.loadCanopyCloudAccount();
        return window.api.accountOrganizationSettings.write({
          accountId: account.account.id,
          operation: 'organization.members.invite',
          input: { organizationId, email, role: 'MEMBER' },
        });
      },
      { organizationId: HOSTED_SETTINGS_ORG_IDS.owner, email },
    );
    expect(sent.ok).toBe(true);
    const inviteId = sent.result.id;
    const organization = defaultHostedSettingsOrganizations()[1];
    await registerHostedSettingsScenario(
      recipientKey,
      'hosted-settings-signed-in',
      {
        overrides: {
          incomingInvitations: [
            {
              id: inviteId,
              organization: {
                ...organization,
                members: organization.members.filter(
                  (member) => member.id !== HOSTED_SETTINGS_VIEWER.id,
                ),
              },
              enforcedSettings: [],
              role: 'MEMBER',
              invitedByName: 'Private sender CAN4635',
              createdAt: new Date().toISOString(),
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
        },
      },
    );
    recipient = await launchCanopy({ env: flags });
    const recipientWindow = await recipient.electronApp.firstWindow();
    await new CanopyAppDriver(recipientWindow).waitForShell();
    await connectMockCloudAccount(recipientWindow, recipientKey);
    const accepted = await recipientWindow.evaluate(async (inviteId) => {
      const account = await window.api.loadCanopyCloudAccount();
      return window.api.accountOrganizationSettings.write({
        accountId: account.account.id,
        operation: 'organization.invitations.respond',
        input: { inviteId, action: 'accept' },
      });
    }, inviteId);
    expect(accepted.ok).toBe(true);
    const invitations = () =>
      collector.events.filter(
        (event) =>
          event.event === 'sharing:invite_send' ||
          event.event === 'sharing:invite_accept',
      );
    await expect.poll(() => invitations().length, { timeout: 30_000 }).toBe(2);
    const send = invitations().find(
      (event) => event.event === 'sharing:invite_send',
    );
    const accept = invitations().find(
      (event) => event.event === 'sharing:invite_accept',
    );
    expect(send.properties.invite_ref).toMatch(/^[a-f0-9]{16}$/);
    expect(accept.properties).toMatchObject({
      invite_type: 'organization',
      invite_ref: send.properties.invite_ref,
      is_first_accept_on_install: true,
      install_age_days: 0,
    });
    expect(send.distinct_id ?? send.properties.distinct_id).not.toBe(
      accept.distinct_id ?? accept.properties.distinct_id,
    );
    const wire = JSON.stringify(
      collector.requests.map((request) => request.payload),
    );
    for (const value of [
      inviteId,
      email,
      senderKey,
      recipientKey,
      sender.userDataDir,
      recipient.userDataDir,
      'Private sender CAN4635',
    ])
      expect(wire).not.toContain(value);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (recipient)
      await closeCanopy(recipient.electronApp, recipient.userDataDir);
    if (sender) await closeCanopy(sender.electronApp, sender.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, senderKey);
    await clearScenario(DEFAULT_MOCK_BASE_URL, recipientKey);
    await collector.shutdown();
  }
});

// Every recorded copy of node `id` is an rrweb block placeholder: rrweb's
// generated size attributes and nothing recorded inside it.
function analyticsEvents(events) {
  return events.filter(
    (event) =>
      event &&
      typeof event.event === 'string' &&
      event.properties &&
      typeof event.properties === 'object',
  );
}

function screenEvents(events, surface) {
  return analyticsEvents(events).filter(
    (event) =>
      event.properties.surface === surface &&
      (event.event === '$pageview' || event.event === '$pageleave'),
  );
}

async function expectScreenTransition(events, surface, start, from, to) {
  await expect
    .poll(() =>
      screenEvents(events, surface)
        .slice(start, start + 2)
        .map((event) => [event.event, event.properties.screen_route]),
    )
    .toEqual([
      ['$pageleave', from],
      ['$pageview', to],
    ]);
}

test('PostHog background and app windows share an anonymous identity and converge after rotation', async () => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  if (
    process.env.CANOPY_POSTHOG_ENABLED !== 'true' ||
    !process.env.CANOPY_POSTHOG_PROJECT_KEY?.startsWith('phc_e2e_') ||
    process.env.CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE !== '100'
  ) {
    throw new Error(
      'CANOPY_POSTHOG_STUB_URL requires CANOPY_POSTHOG_ENABLED=true, a phc_e2e_ project key, and CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE=100',
    );
  }
  const apiKey = 'csk_posthog_identity_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const collector = await startPostHogCapture({
    holdResponse: ({ events }) =>
      events.some((event) => event.event === 'retry_before_disable'),
  });
  const { events, parseErrors } = collector;
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'canopy-posthog-'));
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  writeJson(path.join(userDataDir, 'feature-flags-context.json'), {
    version: 1,
    anonymousKey: DATADOG_ID,
  });
  writeJson(path.join(userDataDir, 'posthog-context.json'), {
    version: 1,
    anonymousKey: POSTHOG_ID,
  });
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const seededWorkspace = seed.workspaces[0];
  expect(seededWorkspace?.worktreePath).toBeTruthy();
  execFileSync('git', ['branch', '-m', PRIVATE_FIXTURE.branch], {
    cwd: seededWorkspace.worktreePath,
  });
  const workspaceIndexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, 'utf8'));
  workspaceIndex.workspaces[0].name = PRIVATE_FIXTURE.workspace;
  writeJson(workspaceIndexPath, workspaceIndex);
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees.json',
  );
  const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  worktrees.worktrees[0].branchName = PRIVATE_FIXTURE.branch;
  writeJson(worktreesPath, worktrees);
  const privateFilePath = path.join(
    seededWorkspace.worktreePath,
    PRIVATE_FIXTURE.file,
  );
  writeFileSync(privateFilePath, 'private fixture content\n', 'utf8');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: PRIMARY_CHAT_ID,
    tabs: [
      {
        id: PRIMARY_CHAT_ID,
        title: PRIVATE_FIXTURE.chat,
        messages: [
          {
            id: 'private-transcript-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Summarize the memo.' }],
            timestamp: Date.UTC(2026, 8, 1),
          },
          {
            id: 'private-transcript-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: PRIVATE_FIXTURE.transcript }],
            timestamp: Date.UTC(2026, 8, 1, 0, 0, 10),
          },
        ],
      },
      {
        id: ALTERNATE_CHAT_ID,
        title: 'Second private acquisition thread 9f4c',
        messages: [],
      },
      {
        id: 'private-file-tab',
        title: PRIVATE_FIXTURE.file,
        kind: 'file',
        filePath: privateFilePath,
        fileViewMode: 'raw',
        description: privateFilePath,
        messages: [],
      },
    ],
  });
  let electronApp;
  try {
    const launched = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          ...JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}'),
          'canopy-desktop-posthog-capture-enabled': true,
          'canopy-desktop-posthog-session-replay-sample-rate': 100,
        }),
      },
      // PostHog rejects navigator.webdriver as bot traffic. Match the real
      // app navigator while keeping Electron hidden and the SDK unmodified.
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    electronApp = launched.electronApp;
    const requests = [];
    electronApp
      .context()
      .on('request', (request) =>
        requests.push({ url: request.url(), type: request.resourceType() }),
      );
    const mainWindow = await electronApp.firstWindow();
    const app = new CanopyAppDriver(mainWindow);
    await app.waitForShell();
    const account = await connectMockCloudAccount(
      await electronApp.firstWindow(),
      apiKey,
    );
    await expect
      .poll(() => events.filter((event) => event.event === 'app_opened').length)
      .toBe(1);
    // CAN-3113: allowlisted operations arrive as one completion event each,
    // from an app window and from the background process. The session and
    // identity assertions below cover these events too.
    const operationEvents = (name) =>
      analyticsEvents(events)
        .filter((event) => event.event === name)
        .map(({ properties }) => ({
          action: properties.action,
          app_version: properties.app_version,
          profile_role: properties.profile_role,
          prompt_surface: properties.prompt_surface,
          status: properties.status,
          surface: properties.surface,
        }));
    // A renderer operation: Home's suggested-prompt impression.
    await expect(
      mainWindow.getByTestId('suggested-prompt-chips'),
    ).toBeVisible();
    await expect
      .poll(() => operationEvents('chat:suggested_prompt_update'))
      .toEqual(
        expect.arrayContaining([
          {
            action: 'impression',
            app_version: BUNDLED_APP_VERSION,
            profile_role: undefined,
            prompt_surface: 'home',
            status: 'success',
            surface: 'main',
          },
        ]),
      );
    await mainWindow.evaluate(() =>
      window.api.savePreferences({ profileRole: 'designer' }),
    );
    await expect
      .poll(() => operationEvents('onboarding:profile_update'))
      .toEqual([
        {
          action: undefined,
          app_version: BUNDLED_APP_VERSION,
          profile_role: 'designer',
          prompt_surface: undefined,
          status: 'success',
          surface: 'background',
        },
      ]);
    expect(
      analyticsEvents(events).some((event) =>
        event.event.startsWith('canopy.'),
      ),
    ).toBe(false);
    const evaluationValues = (source, surface) =>
      source
        .filter(
          (event) =>
            event.event === '$feature_flag_called' &&
            event.properties.$feature_flag ===
              'canopy-desktop-posthog-session-replay-sample-rate' &&
            event.properties.surface === surface,
        )
        .map((event) => event.properties.$feature_flag_response);
    // Initial hydration races the asynchronous SDK import/identity lookup.
    await expect.poll(() => evaluationValues(events, 'main')).toEqual([100]);
    const initialMainEvents = screenEvents(events, 'main');
    expect(
      initialMainEvents.map((event) => [
        event.event,
        event.properties.screen_route,
      ]),
    ).toEqual([['$pageview', 'app://main/home']]);
    const initialViewIndex = analyticsEvents(events).indexOf(
      initialMainEvents[0],
    );
    const initialOpenedIndex = analyticsEvents(events).findIndex(
      (event) =>
        event.event === 'app_opened' && event.properties.surface === 'main',
    );
    expect(initialViewIndex).toBeGreaterThanOrEqual(0);
    expect(initialOpenedIndex).toBeGreaterThan(initialViewIndex);

    // The request observer is installed at the first harness opportunity.
    // This fully observed reload pins the page-exit leave, new initial view,
    // identity persistence, and absence of a CDN/ingestion escape.
    let transitionStart = screenEvents(events, 'main').length;
    await mainWindow.reload();
    await app.waitForShell();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://main/home',
      'app://main/home',
    );

    transitionStart = screenEvents(events, 'main').length;
    await app.selectWorktree(WORKTREE_ID, {
      expandDefaultActivityRail: false,
    });
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://main/home',
      'app://main/worktree-chat',
    );

    // Switching between chats stays in the same screen category and must not
    // manufacture another view.
    const sameCategoryCount = screenEvents(events, 'main').length;
    await mainWindow
      .getByTestId(`panel-tab-panel-chat-${ALTERNATE_CHAT_ID}`)
      .click();
    await expect(
      mainWindow.getByTestId(`panel-tab-panel-chat-${ALTERNATE_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    await mainWindow
      .getByTestId(`panel-tab-panel-chat-${PRIMARY_CHAT_ID}`)
      .click();
    await expect(
      mainWindow.getByTestId(`panel-tab-panel-chat-${PRIMARY_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    await mainWindow.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(screenEvents(events, 'main')).toHaveLength(sameCategoryCount);

    transitionStart = screenEvents(events, 'main').length;
    await app.openKanbanPage();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://main/worktree-chat',
      'app://main/kanban',
    );
    transitionStart = screenEvents(events, 'main').length;
    await app.openMainPage();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://main/kanban',
      'app://main/worktree-chat',
    );
    await mainWindow.waitForTimeout(200);
    expect(
      screenEvents(events, 'main')
        .slice(transitionStart)
        .map((event) => [event.event, event.properties.screen_route]),
    ).toEqual([
      ['$pageleave', 'app://main/kanban'],
      ['$pageview', 'app://main/worktree-chat'],
    ]);

    transitionStart = screenEvents(events, 'main').length;
    await app.openSettings();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://main/worktree-chat',
      'app://settings/canopy',
    );
    transitionStart = screenEvents(events, 'main').length;
    await app.openSettingsSection('display');
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://settings/canopy',
      'app://settings/display',
    );
    transitionStart = screenEvents(events, 'main').length;
    await app.openSettingsSection('account');
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://settings/display',
      'app://settings/account',
    );
    const selectedSettingsCount = screenEvents(events, 'main').length;
    await app.openSettingsSection('account');
    await mainWindow.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(screenEvents(events, 'main')).toHaveLength(selectedSettingsCount);
    transitionStart = screenEvents(events, 'main').length;
    await app.openSettingsSection('code-graph');
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://settings/account',
      'app://settings/code-graph',
    );
    transitionStart = screenEvents(events, 'main').length;
    await app.closeSettings();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://settings/code-graph',
      'app://main/worktree-chat',
    );

    // A real focused Browser panel overrides the containing chat route. Its
    // private website URL is deliberately unrelated to the fixed route value.
    transitionStart = screenEvents(events, 'main').length;
    await mainWindow.getByTestId('panel-add-tab-group-chat').click();
    await expect(mainWindow.getByTestId('panel-add-menu')).toBeVisible();
    await mainWindow.getByTestId('panel-add-menu-item-browser').click();
    await expect(mainWindow.getByTestId('browser-panel-surface')).toBeVisible();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://main/worktree-chat',
      'app://panel/browser',
    );
    const privateBrowserUrl = `${collector.url}/${PRIVATE_FIXTURE.browser}`;
    const browserInput = mainWindow.getByTestId('browser-url-input');
    await browserInput.fill(privateBrowserUrl);
    await browserInput.press('Enter');
    await expect(browserInput).toHaveValue(privateBrowserUrl);
    const browserRouteCount = screenEvents(events, 'main').length;
    await mainWindow.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(screenEvents(events, 'main')).toHaveLength(browserRouteCount);
    transitionStart = screenEvents(events, 'main').length;
    await mainWindow
      .getByTestId(`panel-tab-panel-chat-${PRIMARY_CHAT_ID}`)
      .click();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://panel/browser',
      'app://main/worktree-chat',
    );

    await app.openAppAdvisorWindow(electronApp);
    await expect
      .poll(() =>
        analyticsEvents(events)
          .filter((event) => event.event === 'app_opened')
          .map((event) => event.properties.surface)
          .sort(),
      )
      .toEqual(['app-advisor', 'main', 'main']);
    expect(parseErrors).toEqual([]);
    await expect
      .poll(() => ({
        eventNames: events.map((event) => event.event),
        requestPaths: collector.requests.map((request) => request.path),
        parseErrors: [...parseErrors],
      }))
      .toEqual(
        expect.objectContaining({
          eventNames: expect.arrayContaining(['desktop:app_start']),
        }),
      );
    // Every app window must inherit the main-owned session, including reloads.
    expect(
      new Set(
        analyticsEvents(events).map((event) => event.properties.$session_id),
      ).size,
    ).toBe(1);
    for (const event of analyticsEvents(events)) {
      expect(event.distinct_id ?? event.properties.distinct_id).toBe(
        POSTHOG_ID,
      );
      expect(event.properties.$is_identified).not.toBe(true);
      expect(event.properties.email).toBeUndefined();
      if (event.properties.surface === 'main') {
        expect(event.properties.screen_route).toMatch(/^app:\/\//);
        expect(event.properties.$current_url).toBe(
          event.properties.screen_route,
        );
      }
      if (event.properties.surface === 'app-advisor') {
        expect(event.properties.screen_route).toBe('app://app-advisor');
        expect(event.properties.$current_url).toBe('app://app-advisor');
      }
      for (const key of ['$prev_pageview_pathname', '$prev_pageview_url']) {
        if (key in event.properties) {
          expect(event.properties[key]).toBe(event.properties.screen_route);
        }
      }
    }
    expect(
      screenEvents(events, 'main').some(
        (event) => event.properties.screen_route === 'app://settings',
      ),
    ).toBe(false);
    expect(
      analyticsEvents(events)
        .filter((event) => event.event === 'desktop:app_start')
        .every(
          (event) =>
            event.properties.screen_route === undefined &&
            event.properties.$current_url === undefined,
        ),
    ).toBe(true);
    const wire = JSON.stringify(analyticsEvents(events));
    expect(wire).not.toContain(DATADOG_ID);
    expect(wire).not.toContain(apiKey);
    expect(account.account.account?.email).toBe('portal-e2e@example.test');
    expect(wire).not.toContain(account.account.account.email);
    expect(wire).not.toContain(account.account.account.id);
    expect(wire).not.toContain(userDataDir);
    expect(wire).not.toContain('$identify');
    expect(wire).not.toContain('file:///');
    expect(wire).not.toMatch(
      /(?:Applications|AppData|app\.asar|renderer\/index\.html)/i,
    );
    for (const privateValue of Object.values(PRIVATE_FIXTURE)) {
      expect(wire).not.toContain(privateValue);
    }
    expect(analyticsEvents(events).length).toBeGreaterThan(0);
    expect(
      readPostHogCapture(collector).requests.some(({ path: requestPath }) =>
        /^\/(?:batch|(?:i\/v\d+\/)?[es])\/?(?:\?|$)/.test(requestPath),
      ),
    ).toBe(true);
    expect(
      requests.filter(
        ({ url, type }) =>
          /posthog.*\.com/.test(url) ||
          (type === 'script' && !url.startsWith('file:')),
      ),
    ).toEqual([]);

    // Import the built SDK chunk already used by the app. This drives its real
    // rotation callback without introducing a production or preload test API.
    const assetsDir = path.resolve(
      fileURLToPath(new URL('../../../../', import.meta.url)),
      process.env.CANOPY_E2E_OUT_DIR || 'out-e2e',
      'renderer/assets',
    );
    const sdkChunk = readdirSync(assetsDir).find(
      (name) =>
        name.endsWith('.js') &&
        readFileSync(path.join(assetsDir, name), 'utf8').includes(
          'Bootstrap sessionID cannot be in the future',
        ),
    );
    expect(sdkChunk).toBeTruthy();
    // `electronApp.windows()` also includes the native Browser panel's
    // WebContentsView page. Only file-backed app renderers own the SDK and
    // observability preload used below.
    const windows = electronApp
      .windows()
      .filter((page) => page.url().startsWith('file:'));
    expect(windows).toHaveLength(2);
    for (const page of windows) {
      await page.evaluate(async (chunk) => {
        window.__testPostHog = (await import(`./assets/${chunk}`)).default;
      }, sdkChunk);
    }
    const initialSession = events.find(
      (event) => event.event === 'desktop:app_start',
    ).properties.$session_id;
    await windows[1].evaluate(() => {
      window.__testPostHog.sessionManager.resetSessionId();
      window.__testPostHog.capture('rotation_trigger');
    });
    await expect
      .poll(async () => {
        const ids = await Promise.all(
          windows.map((page) =>
            page.evaluate(() => window.__testPostHog.get_session_id()),
          ),
        );
        return ids[0] !== initialSession && ids.every((id) => id === ids[0]);
      })
      .toBe(true);
    const adopted = await windows[0].evaluate(() =>
      window.__testPostHog.get_session_id(),
    );
    expect(
      await windows[0].evaluate(() =>
        window.api.observability.getPostHogSession(),
      ),
    ).toEqual({ sessionId: adopted, revision: 1 });
    for (const page of windows)
      await page.evaluate(() => window.__testPostHog.capture('after_rotation'));
    await expect
      .poll(
        () =>
          events.filter((event) =>
            ['rotation_trigger', 'after_rotation'].includes(event.event),
          ).length,
      )
      .toBe(3);
    for (const event of events.filter((event) =>
      ['rotation_trigger', 'after_rotation'].includes(event.event),
    )) {
      expect(event.properties.$session_id).toBe(adopted);
      expect(event.properties.$current_url).toBe(event.properties.screen_route);
      expect(event.properties.screen_route).toBe(
        event.properties.surface === 'app-advisor'
          ? 'app://app-advisor'
          : 'app://main/worktree-chat',
      );
    }
    expect(
      events.find((event) => event.event === 'rotation_trigger').properties
        .screen_route,
    ).toBe('app://app-advisor');

    // A newly initialized renderer must inherit the adopted session too.
    transitionStart = screenEvents(events, 'main').length;
    await windows[0].reload();
    await app.waitForShell();
    await expectScreenTransition(
      events,
      'main',
      transitionStart,
      'app://main/worktree-chat',
      'app://main/home',
    );
    await expect
      .poll(() => events.filter((event) => event.event === 'app_opened').length)
      .toBe(4);
    expect(
      events.filter((event) => event.event === 'app_opened').at(-1).properties
        .$session_id,
    ).toBe(adopted);
    await windows[0].evaluate(async (chunk) => {
      window.__testPostHog = (await import(`./assets/${chunk}`)).default;
    }, sdkChunk);
    // CAN-3164: drive the real main-owned snapshot refresh in both windows.
    const setCapture = async (enabled, rate = 5) => {
      await electronApp.evaluate(
        (_electron, value) => {
          process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify({
            ...JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}'),
            'canopy-desktop-posthog-capture-enabled': value.enabled,
            'canopy-desktop-posthog-session-replay-sample-rate': value.rate,
          });
        },
        { enabled, rate },
      );
      await mainWindow.evaluate(() => window.api.featureFlags.refreshContext());
    };
    // CAN-3114: unchanged snapshots do not duplicate evaluations, while a
    // change and a return to the original value each report in both renderers.
    const evaluationStart = events.length;
    await setCapture(true, 75);
    for (const surface of ['main', 'app-advisor']) {
      await expect
        .poll(() => evaluationValues(events.slice(evaluationStart), surface))
        .toEqual([75]);
    }
    await setCapture(true, 75);
    for (const page of windows) {
      await page.evaluate(() =>
        window.__testPostHog.capture('flag_repeat_observed'),
      );
    }
    await expect
      .poll(
        () =>
          events.filter((event) => event.event === 'flag_repeat_observed')
            .length,
      )
      .toBe(windows.length);
    for (const surface of ['main', 'app-advisor']) {
      expect(evaluationValues(events.slice(evaluationStart), surface)).toEqual([
        75,
      ]);
    }
    await setCapture(true, 100);
    for (const surface of ['main', 'app-advisor']) {
      await expect
        .poll(() => evaluationValues(events.slice(evaluationStart), surface))
        .toEqual([75, 100]);
    }
    // The 75 -> 100 increase takes effect on the next shared session.
    await windows[1].evaluate(() => {
      window.__testPostHog.sessionManager.resetSessionId();
      window.__testPostHog.capture('replay_rotation');
    });
    await expect
      .poll(async () => {
        const ids = await Promise.all(
          windows.map((page) =>
            page.evaluate(() => window.__testPostHog.get_session_id()),
          ),
        );
        return ids.every((id) => id === ids[0]);
      })
      .toBe(true);
    for (const page of windows) {
      await expect
        .poll(() =>
          page.evaluate(() => window.__testPostHog.sessionRecordingStarted()),
        )
        .toBe(true);
      await page.evaluate(() =>
        window.__testPostHog.capture(
          'retry_before_disable',
          {},
          { send_instantly: true },
        ),
      );
    }
    await expect.poll(() => collector.heldResponseCount).toBe(windows.length);
    await setCapture(true, 0);
    for (const page of windows) {
      await expect
        .poll(() =>
          page.evaluate(() => window.__testPostHog.sessionRecordingStarted()),
        )
        .toBe(false);
      expect(
        await page.evaluate(() => window.__testPostHog.is_capturing()),
      ).toBe(true);
    }
    await setCapture(true, 100);
    await windows[1].evaluate(() => {
      window.__testPostHog.sessionManager.resetSessionId();
      window.__testPostHog.capture('replay_restart_rotation');
    });
    await expect
      .poll(async () => {
        const ids = await Promise.all(
          windows.map((page) =>
            page.evaluate(() => window.__testPostHog.get_session_id()),
          ),
        );
        return ids.every((id) => id === ids[0]);
      })
      .toBe(true);
    for (const page of windows) {
      await expect
        .poll(() =>
          page.evaluate(() => window.__testPostHog.sessionRecordingStarted()),
        )
        .toBe(true);
    }

    await test.step('replay records text and attributes, masking inputs and blocked content, in both windows', async () => {
      for (const [index, page] of windows.entries()) {
        await page.evaluate((suffix) => {
          const button = document.createElement('button');
          button.setAttribute('data-posthog-fixture', `fixture-data-${suffix}`);
          button.title = `fixture-title-${suffix}`;
          button.setAttribute('aria-label', `fixture-aria-${suffix}`);
          button.textContent = `fixture-prose-${suffix}`;
          button.style.cssText =
            'position:fixed;top:4px;left:4px;z-index:99999';
          const input = document.createElement('input');
          input.placeholder = `fixture-placeholder-${suffix}`;
          input.value = `fixture-input-${suffix}`;
          const link = document.createElement('a');
          link.href = `https://example.test/fixture-href-${suffix}`;
          link.textContent = `fixture-link-${suffix}`;
          const blocked = document.createElement('div');
          blocked.className = 'ph-no-capture';
          blocked.textContent = `fixture-blocked-${suffix}`;
          document.body.append(button, input, link, blocked);
        }, index);
        await page.locator('button[data-posthog-fixture]').click();
      }
      const sharedSession = await windows[0].evaluate(() =>
        window.__testPostHog.get_session_id(),
      );
      await expect
        .poll(() => {
          const current = readPostHogCapture(collector).events.filter(
            (event) =>
              event.event === '$snapshot' &&
              event.properties.$session_id === sharedSession,
          );
          return ['main', 'app-advisor'].every((surface) =>
            current
              .filter((event) => event.properties.surface === surface)
              .flatMap(decodePostHogSnapshotData)
              .some((event) => event.type === 2),
          );
        })
        .toBe(true);
      const snapshots = readPostHogCapture(collector).events.filter(
        (event) =>
          event.event === '$snapshot' &&
          event.properties.$session_id === sharedSession,
      );
      for (const surface of ['main', 'app-advisor']) {
        const surfaceSnapshots = snapshots.filter(
          (event) => event.properties.surface === surface,
        );
        expect(surfaceSnapshots.length).toBeGreaterThan(0);
        const decoded = surfaceSnapshots.flatMap(decodePostHogSnapshotData);
        expect(decoded.some((event) => event.type === 2)).toBe(true);
        const meta = decoded.filter((event) => event.type === 4);
        expect(meta.length).toBeGreaterThan(0);
        expect(
          meta.every((event) => event.data.href.startsWith('app://')),
        ).toBe(true);
        const wire = JSON.stringify(decoded);
        // Window order is not stable, so accept either window's suffix.
        for (const fixture of [
          'prose',
          'title',
          'aria',
          'placeholder',
          'data',
          'href',
          'link',
        ]) {
          expect(wire).toMatch(new RegExp(`fixture-${fixture}-[01]`));
        }
        for (const fixture of ['input', 'blocked']) {
          for (const index of [0, 1])
            expect(wire).not.toContain(`fixture-${fixture}-${index}`);
        }
      }
      expect(
        new Set(snapshots.map((event) => event.properties.$window_id)).size,
      ).toBe(2);
      expect(
        readPostHogCapture(collector).requests.filter(({ path: requestPath }) =>
          /\/array\/|\/static\//.test(requestPath),
        ),
      ).toEqual([]);
      expect(
        requests.filter(
          ({ url, type }) =>
            /posthog.*\.com/.test(url) ||
            (type === 'script' && !url.startsWith('file:')),
        ),
      ).toEqual([]);
    });

    await test.step('replay blocks the chat transcript but keeps navigation into it', async () => {
      const replayStart = readPostHogCapture(collector).events.length;
      await app.selectWorktree(WORKTREE_ID, {
        expandDefaultActivityRail: false,
      });
      const transcript = mainWindow.getByTestId('chat-message-list-content');
      await expect(
        transcript.getByText(PRIVATE_FIXTURE.transcript),
      ).toBeVisible();
      // Interaction releases the recorder's upload hold for this epoch.
      await mainWindow
        .locator('[data-chat-textarea][contenteditable="true"]:visible')
        .first()
        .click();
      const mainReplay = () => mainReplaySince(collector, replayStart);
      const chatPageview = (decoded) =>
        decoded.some(
          (event) =>
            event.type === 5 &&
            event.data?.tag === '$pageview' &&
            event.data?.payload?.href === 'app://main/worktree-chat',
        );
      await expect.poll(() => chatPageview(mainReplay())).toBe(true);
      // The whole session's DOM, since the chat panel may have been mounted
      // (hidden) before this navigation and captured by the full snapshot.
      const sessionId = await mainWindow.evaluate(() =>
        window.__testPostHog.get_session_id(),
      );
      const sessionNodes = replayNodes(
        readPostHogCapture(collector)
          .events.filter(
            (event) =>
              event.event === '$snapshot' &&
              event.properties.surface === 'main' &&
              event.properties.$session_id === sessionId,
          )
          .flatMap(decodePostHogSnapshotData),
      );
      // Masking alone would still record the transcript's text shape.
      const wire = JSON.stringify(sessionNodes);
      expect(
        wire.includes(PRIVATE_FIXTURE.transcript.replace(/\S/g, '*')),
        'the transcript text shape must not be recorded',
      ).toBe(false);
      const placeholders = sessionNodes.filter(
        (node) =>
          node.tagName === 'div' &&
          node.attributes?.rr_width !== undefined &&
          node.attributes?.rr_height !== undefined,
      );
      expect(placeholders.length).toBeGreaterThan(0);
      for (const placeholder of placeholders) {
        expect(recordedChildren(sessionNodes, placeholder)).toEqual([]);
      }
      // CAN-3119: the composer's editable is recorded so focusing it counts
      // as activity and releases the upload hold; each draft paragraph inside
      // it is a placeholder. Find the editable by its live rrweb node id.
      const editableId = await mainWindow
        .locator('[data-chat-textarea][contenteditable="true"]:visible')
        .first()
        .evaluate(
          (editable) =>
            window.__PosthogExtensions__?.rrweb?.record?.mirror?.getId(
              editable,
            ) ?? null,
        );
      const editableNodes = sessionNodes.filter(
        (node) => node.id === editableId,
      );
      expect
        .soft(editableNodes.length, 'the composer editable must be recorded')
        .toBeGreaterThan(0);
      for (const editable of editableNodes) {
        for (const child of recordedChildren(sessionNodes, editable)) {
          expect
            .soft(
              child.attributes?.rr_width !== undefined &&
                recordedChildren(sessionNodes, child).length === 0,
              'every draft paragraph must be an empty placeholder',
            )
            .toBe(true);
        }
      }
      expect
        .soft(
          mainReplay().some(
            (event) =>
              event.type === 3 &&
              event.data?.source === 2 &&
              event.data?.type === 5 &&
              event.data?.id === editableId,
          ),
          'focusing the composer must reach the recorder as an interaction',
        )
        .toBe(true);
    });
    await test.step('replay records the plugin picker card and blocks picker and composer menu rows', async () => {
      const replayStart = readPostHogCapture(collector).events.length;
      await mainWindow.getByTestId('chat-input-plus-button').click();
      await mainWindow.getByTestId('chat-plugins-button').click();
      const dialog = mainWindow
        .locator('[role="dialog"]')
        .filter({ hasText: 'Plugins' });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.locator('[data-testid="unified-table"] tbody tr').first(),
      ).toBeVisible();
      const pickerCardId = await dialog.evaluate((card) =>
        window.__PosthogExtensions__.rrweb.record.mirror.getId(card),
      );
      expect(pickerCardId).toBeGreaterThan(0);
      await dialog.getByPlaceholder('Search by name…').click();
      await mainWindow.evaluate(() => {
        window.__PosthogExtensions__.rrweb.record.addCustomEvent(
          'can-3119-picker-flush',
          {},
        );
      });
      await expect
        .poll(
          () =>
            mainReplaySince(collector, replayStart).some(
              (event) =>
                event.type === 5 && event.data?.tag === 'can-3119-picker-flush',
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      const pickerNodes = () =>
        replayNodes(mainReplaySince(collector, replayStart));
      // Dialogs are recorded; the picker's rows (`UnifiedTable` body) are
      // the block.
      const isPickerPlaceholder = (node) =>
        node.tagName === 'tbody' &&
        node.attributes?.class?.split(/\s+/).includes('ph-no-capture') &&
        node.attributes?.rr_width !== undefined &&
        node.attributes?.rr_height !== undefined;
      await expect
        .poll(() => pickerNodes().some(isPickerPlaceholder))
        .toBe(true);
      await expect
        .poll(() => {
          const nodes = pickerNodes();
          return nodes.some(
            (node) =>
              node.id === pickerCardId &&
              recordedChildren(nodes, node).length > 0,
          );
        })
        .toBe(true);
      const nodes = pickerNodes();
      for (const placeholder of nodes.filter(isPickerPlaceholder)) {
        expect(recordedChildren(nodes, placeholder)).toEqual([]);
      }
      // The + menu opened on the way: no menu row was recorded, while each
      // group kept its heading beside an empty rows placeholder.
      expect(
        nodes.some(
          (node) => node.attributes && 'data-action-row' in node.attributes,
        ),
      ).toBe(false);
      const isPlaceholder = (node) =>
        node.attributes?.rr_width !== undefined &&
        node.attributes?.rr_height !== undefined;
      const menuGroups = nodes.filter((node) => {
        if (!node.attributes || !('aria-label' in node.attributes))
          return false;
        const children = recordedChildren(nodes, node);
        const hasHeading = children.some(
          (child) =>
            child.tagName === 'div' &&
            !isPlaceholder(child) &&
            recordedChildren(nodes, child).some((text) => text.type === 3),
        );
        const hasBlockedRows = children.some(
          (child) =>
            child.tagName === 'div' &&
            isPlaceholder(child) &&
            recordedChildren(nodes, child).length === 0,
        );
        return hasHeading && hasBlockedRows;
      });
      expect(menuGroups.length).toBeGreaterThan(0);
      await mainWindow.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
    for (const page of windows) {
      await page.evaluate(() =>
        window.__testPostHog.capture('queued_before_disable'),
      );
    }
    const backgroundOperationsBeforeDisable = operationEvents(
      'onboarding:profile_update',
    ).length;
    await mainWindow.evaluate(() =>
      window.api.savePreferences({ profileRole: 'software-engineer' }),
    );
    const screenCountsBeforeDisable = {
      main: screenEvents(events, 'main').length,
      advisor: screenEvents(events, 'app-advisor').length,
    };
    await setCapture(false);
    for (const page of windows) {
      await expect
        .poll(() => page.evaluate(() => window.__testPostHog.is_capturing()))
        .toBe(false);
      await expect
        .poll(() =>
          page.evaluate(() => window.__testPostHog.sessionRecordingStarted()),
        )
        .toBe(false);
      await page.evaluate(() => {
        window.__testPostHog.capture('captured_while_disabled');
        window.__testPostHog._handle_unload();
      });
    }
    await app.openSettings();
    await app.openSettingsSection('display');
    await mainWindow.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(screenEvents(events, 'main')).toHaveLength(
      screenCountsBeforeDisable.main,
    );
    expect(screenEvents(events, 'app-advisor')).toHaveLength(
      screenCountsBeforeDisable.advisor,
    );
    const afterDisable = events.length;
    // Cover the SDK's batch flush interval as well as unload above.
    await mainWindow.waitForTimeout(3500);
    expect(events).toHaveLength(afterDisable);
    expect(operationEvents('onboarding:profile_update')).toHaveLength(
      backgroundOperationsBeforeDisable,
    );
    await setCapture(true);
    await expect
      .poll(() =>
        screenEvents(events, 'main')
          .slice(screenCountsBeforeDisable.main)
          .map((event) => [event.event, event.properties.screen_route]),
      )
      .toEqual([['$pageview', 'app://settings/display']]);
    await expect
      .poll(() =>
        screenEvents(events, 'app-advisor')
          .slice(screenCountsBeforeDisable.advisor)
          .map((event) => [event.event, event.properties.screen_route]),
      )
      .toEqual([['$pageview', 'app://app-advisor']]);
    for (const page of windows) {
      await expect
        .poll(() => page.evaluate(() => window.__testPostHog.is_capturing()))
        .toBe(true);
      await page.evaluate(() =>
        window.__testPostHog.capture('capture_restored'),
      );
    }
    await expect
      .poll(
        () =>
          events.filter((event) => event.event === 'capture_restored').length,
      )
      .toBe(windows.length);
    for (const event of events.filter(
      (event) => event.event === 'capture_restored',
    )) {
      expect(event.properties.$current_url).toBe(event.properties.screen_route);
      expect(event.properties.screen_route).toBe(
        event.properties.surface === 'app-advisor'
          ? 'app://app-advisor'
          : 'app://settings/display',
      );
    }
    // Fail the old requests only AFTER re-enabling. Their late retry callbacks
    // must retain the old capture epoch and be discarded, including on unload.
    collector.releaseHeldResponses();
    for (const page of windows) {
      await expect
        .poll(() =>
          page.evaluate(() => window.__testPostHog._retryQueue.length),
        )
        .toBe(1);
      await page.evaluate(() => {
        const queue = window.__testPostHog._retryQueue;
        for (const item of queue._queue) item.retryAt = Date.now() - 1;
        queue._flush();
        queue.unload();
      });
    }
    await mainWindow.waitForTimeout(500);
    expect(
      events.filter((event) => event.event === 'retry_before_disable'),
    ).toHaveLength(windows.length);
    expect(
      events.some(
        (event) =>
          event.event === 'queued_before_disable' ||
          event.event === 'captured_while_disabled',
      ),
    ).toBe(false);

    // A new renderer must obey the disabled startup snapshot too.
    await setCapture(false);
    const beforeReload = events.length;
    await mainWindow.reload();
    await app.waitForShell();
    await mainWindow.waitForTimeout(3500);
    expect(events).toHaveLength(beforeReload);

    expect(
      JSON.parse(
        readFileSync(path.join(userDataDir, 'feature-flags-context.json')),
      ).anonymousKey,
    ).toBe(DATADOG_ID);
    expect(readPostHogCapture(collector).parseErrors).toEqual([]);
  } finally {
    collector.releaseHeldResponses();
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await collector.shutdown();
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// Account metadata stays domain-only across the background process and both
// app windows, including a sign-out initiated in just one window.
test('PostHog email domains filter events and replays and clear across windows on sign-out', async () => {
  test.setTimeout(90_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const apiKey = 'csk_posthog_domain_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const collector = await startPostHogCapture();
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'canopy-posthog-domain-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  writeJson(path.join(userDataDir, 'posthog-context.json'), {
    version: 1,
    anonymousKey: POSTHOG_ID,
  });
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  let electronApp;
  try {
    const launched = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
          'canopy-desktop-posthog-session-replay-sample-rate': 100,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    electronApp = launched.electronApp;
    const mainWindow = await electronApp.firstWindow();
    const app = new CanopyAppDriver(mainWindow);
    await app.waitForShell();
    await connectMockCloudAccount(mainWindow, apiKey);
    const personEvents = (domain) =>
      analyticsEvents(collector.events).filter(
        (event) =>
          event.event === '$set' &&
          (event.$set ?? event.properties.$set)?.email_domain === domain,
      );
    await expect
      .poll(() =>
        personEvents('example.test').some(
          (event) => event.properties.surface === undefined,
        ),
      )
      .toBe(true);
    await app.openAppAdvisorWindow(electronApp);
    await expect
      .poll(() =>
        ['main', 'app-advisor'].every((surface) =>
          collector.events.some(
            (event) =>
              event.event === '$snapshot' &&
              event.properties.surface === surface &&
              event.properties.email_domain === 'example.test',
          ),
        ),
      )
      .toBe(true);

    const beforeSignOut = collector.events.length;
    await mainWindow.evaluate(async () => {
      await window.api.disconnectCanopyCloudAccount();
    });
    await expect
      .poll(() =>
        collector.events
          .slice(beforeSignOut)
          .some(
            (event) =>
              event.event === '$set' &&
              event.properties.surface === undefined &&
              (event.$set ?? event.properties.$set)?.email_domain === null,
          ),
      )
      .toBe(true);
    for (const page of electronApp.windows()) {
      // Cause a recorder mutation in each window after the domain was cleared.
      await page.evaluate(() =>
        document.body.appendChild(document.createElement('span')),
      );
    }
    await expect
      .poll(() =>
        ['main', 'app-advisor'].every((surface) =>
          collector.events
            .slice(beforeSignOut)
            .some(
              (event) =>
                event.event === '$snapshot' &&
                event.properties.surface === surface &&
                event.properties.email_domain === null,
            ),
        ),
      )
      .toBe(true);
    const wire = JSON.stringify(collector.events);
    expect(wire).not.toContain('portal-e2e');
    expect(wire).not.toContain(apiKey);
    expect(wire).not.toContain('$identify');
    for (const event of analyticsEvents(collector.events)) {
      if (event.event === '$set')
        expect(event.properties.surface).toBeUndefined();
      expect(event.distinct_id ?? event.properties.distinct_id).toBe(
        POSTHOG_ID,
      );
      expect(event.properties.email).toBeUndefined();
      expect(event.properties.$is_identified).not.toBe(true);
    }
    expect(readPostHogCapture(collector).parseErrors).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await collector.shutdown();
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// The launch that creates the analytics identity is a new install only when
// the data directory holds no earlier install data; later launches are neither.
test('PostHog desktop:app_start marks first launches, returning launches, and reinstalls', async () => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const collector = await startPostHogCapture();
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'canopy-posthog-launch-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  const appStarts = () =>
    analyticsEvents(collector.events).filter(
      (event) => event.event === 'desktop:app_start',
    );
  async function launchAndReadAppStart() {
    const seen = appStarts().length;
    const { electronApp } = await launchCanopy({
      userDataDir,
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    try {
      await expect
        .poll(() => appStarts().length, { timeout: 20_000 })
        .toBe(seen + 1);
      return appStarts()[seen].properties;
    } finally {
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    }
  }
  const release = {
    app_version: BUNDLED_APP_VERSION,
    release_channel: BUNDLED_RELEASE_CHANNEL,
  };
  try {
    expect(await launchAndReadAppStart()).toEqual(
      expect.objectContaining({
        ...release,
        is_first_launch: true,
        is_reinstall: false,
        is_invited_install: false,
      }),
    );
    expect(await launchAndReadAppStart()).toEqual(
      expect.objectContaining({
        ...release,
        is_first_launch: false,
        is_reinstall: false,
        is_invited_install: false,
      }),
    );
    // Exercise main's persisted marker projection with the real SDK. Claims
    // themselves are covered through the sole writer's concurrency tests.
    const identityFile = path.join(userDataDir, 'posthog-context.json');
    const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
    writeJson(identityFile, { ...identity, invitedInstall: true });
    expect(await launchAndReadAppStart()).toEqual(
      expect.objectContaining({ is_invited_install: true }),
    );
    delete identity.invitedInstall;
    delete identity.createdAt;
    writeJson(identityFile, identity);
    expect(await launchAndReadAppStart()).not.toHaveProperty(
      'is_invited_install',
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    rmSync(path.join(userDataDir, 'posthog-context.json'));
    expect(await launchAndReadAppStart()).toEqual(
      expect.objectContaining({
        ...release,
        is_first_launch: false,
        is_reinstall: true,
        is_invited_install: false,
      }),
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    await collector.shutdown();
  }
});

for (const provider of ['claude', 'codex']) {
  test(`a chat composer submit reports chat:message_send with ${provider} before dispatch, without message content`, async () => {
    test.setTimeout(90_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    const collector = await startPostHogCapture();
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), 'canopy-posthog-message-send-'),
    );
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: { onboardingCompleted: ['v1'] },
    });
    writeJson(path.join(userDataDir, 'posthog-context.json'), {
      version: 1,
      anonymousKey: POSTHOG_ID,
    });
    const model = provider === 'codex' ? 'e2e-send-provider' : 'sonnet';
    if (provider === 'codex') {
      // The model defaults to Claude, but this chat explicitly chose Codex.
      writeJson(
        path.join(userDataDir, '.cache/model-catalog/ai-gateway-v1.json'),
        {
          cacheVersion: 8,
          serverOrigin: DEFAULT_MOCK_BASE_URL,
          brandApiNamespace: 'desktop-app',
          fetchedAt: new Date().toISOString(),
          catalog: {
            version: 8,
            models: [
              {
                id: model,
                gatewayId: 'anthropic/e2e-send-provider',
                label: 'E2E Send Provider',
                family: 'anthropic',
                familyLabel: 'Anthropic',
                recommendedHarness: 'claude',
                contextWindow: 128_000,
                supportsPromptCaching: false,
                requiresLocalHarnessSupport: false,
                showMoreOnly: false,
                supportedThinkingLevels: ['low', 'medium', 'high'],
                toolSchemaProfile: 'standard',
              },
            ],
          },
        },
      );
    }
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: provider,
      tabs: [
        {
          id: 'message-send-chat',
          title: 'Message send',
          model,
          executionHarness: provider,
          executionHarnessExplicitlyChosen: true,
          planMode: true,
        },
      ],
    });
    const privateMessage = 'Private message-send body 7d2e';
    let electronApp;
    try {
      const launched = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-desktop-posthog-capture-enabled': true,
            // This case verifies custom-operation privacy across mode clicks.
            'canopy-desktop-posthog-autocapture-enabled': false,
          }),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      });
      electronApp = launched.electronApp;
      const mainWindow = await electronApp.firstWindow();
      const app = new CanopyAppDriver(mainWindow);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const editor = mainWindow
        .locator('[data-slate-editor="true"]:visible')
        .first();
      await expect(editor).toBeVisible();
      await expect(
        mainWindow.getByTestId('chat-model-picker-provider-icon'),
      ).toHaveAttribute('data-provider', provider);
      await expect(mainWindow.getByTestId('chat-model-picker')).toContainText(
        provider === 'codex' ? 'E2E Send Provider' : 'Sonnet',
      );
      // The send never reaches an agent: main rejects it, as a send that fails
      // before its turn starts would. The event must still arrive.
      await electronApp.evaluate(({ ipcMain }) => {
        globalThis.__messageSendRequests = 0;
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', () => {
          globalThis.__messageSendRequests += 1;
          throw new Error('dispatch refused before the turn started');
        });
      });
      const sends = () =>
        analyticsEvents(collector.events).filter(
          (event) => event.event === 'chat:message_send',
        );
      // CAN-5382: each submit reports the composer mode it was sent in. The
      // seeded tab starts in plan mode; the second send follows a toggle off.
      const planToggle = mainWindow.getByTestId(
        'chat-input-plan-mode-inline-button',
      );
      await expect(planToggle).toHaveAttribute('aria-pressed', 'true');
      const submissions = [
        { mode: 'plan', text: privateMessage },
        { mode: 'default', text: `${privateMessage} again` },
      ];
      for (const [index, { mode, text }] of submissions.entries()) {
        if (mode === 'default') {
          await planToggle.click();
          await expect(planToggle).toHaveCount(0);
        }
        await editor.fill(text);
        await editor.press('Enter');
        await expect
          .poll(() =>
            electronApp.evaluate(() => globalThis.__messageSendRequests),
          )
          .toBe(index + 1);
        await expect.poll(() => sends().length).toBe(index + 1);
        const { properties } = sends()[index];
        expect(properties).toEqual(
          expect.objectContaining({
            chat_surface: 'worktree_chat',
            composer_mode: mode,
            is_suggested_prompt: false,
            provider,
            model,
            status: 'success',
            surface: 'main',
            app_version: BUNDLED_APP_VERSION,
          }),
        );
        expect(properties).not.toHaveProperty('is_first_message');
        expect(typeof properties.model).toBe('string');
        expect(typeof properties.is_ai_credits_billed).toBe('boolean');
      }
      const wire = JSON.stringify(collector.events);
      expect(wire).not.toContain(privateMessage);
      expect(wire).not.toContain('message-send-chat');
      expect(readPostHogCapture(collector).parseErrors).toEqual([]);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await collector.shutdown();
    }
  });
}

for (const scenario of ['unavailable cowork control', 'read-only harness']) {
  test(`chat composer mode uses effective state with ${scenario}`, async () => {
    test.setTimeout(90_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    const collector = await startPostHogCapture();
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), 'canopy-posthog-effective-composer-mode-'),
    );
    const cowork = scenario === 'unavailable cowork control';
    const managed = cowork ? undefined : await copilotRuntimeFixture();
    let electronApp;
    try {
      if (cowork) seedDeliveryCoworkWorkspace(userDataDir);
      else {
        seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
        writeJson(path.join(userDataDir, 'preferences.json'), {
          version: 1,
          preferences: { onboardingCompleted: ['v1'] },
        });
      }
      managed?.seedConnected(userDataDir);
      const target = {
        projectId: cowork ? COWORK_WORKSPACE_ID : WORKSPACE_ID,
        worktreeId: cowork ? COWORK_ENTRY_ID : WORKTREE_ID,
      };
      seedWorktreeChat({
        userDataDir,
        workspaceId: target.projectId,
        worktreeId: target.worktreeId,
        providerType: cowork ? 'claude' : 'copilot',
        tabs: [
          {
            id: 'effective-mode-chat',
            title: 'Effective composer mode',
            model: cowork ? 'sonnet' : 'copilot:fixture-model',
            planMode: true,
          },
        ],
      });
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...managed?.env,
          ...managed?.credentialEnv(),
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            ...(managed
              ? JSON.parse(managed.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS)
              : {}),
            'canopy-desktop-posthog-capture-enabled': true,
            'canopy-desktop-posthog-autocapture-enabled': false,
          }),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (cowork) {
        await expandCoworkWorkspace(window, COWORK_WORKSPACE_ID);
        await window
          .getByTestId(`sidebar-work-entry-${COWORK_ENTRY_ID}`)
          .click();
      } else {
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_ID);
        await expect(
          window.getByTestId('chat-model-picker-provider-icon'),
        ).toHaveAttribute('data-provider', 'copilot');
      }
      const panel = window.getByTestId('panel-content-chat');
      const planControl = panel.getByTestId(
        'chat-input-plan-mode-inline-button',
      );
      if (cowork) await expect(planControl).toHaveCount(0);
      else await expect(planControl).toHaveAttribute('aria-pressed', 'true');
      // Verify the stale raw flag really survived restoration. The assertion
      // below must exercise availability gating, not a fixture reset to false.
      const tabs = await window.evaluate(
        (scope) => window.api.chat.loadTabs(scope),
        target,
      );
      expect(
        tabs.tabs.find((tab) => tab.id === 'effective-mode-chat')?.planMode,
      ).toBe(true);
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', () => {
          throw new Error('dispatch refused before the turn started');
        });
      });
      const privateMessage = 'Private effective composer-mode body c5382';
      const editor = panel.locator('[data-slate-editor="true"]').first();
      await editor.fill(privateMessage);
      await editor.press('Enter');
      const sends = () =>
        analyticsEvents(collector.events).filter(
          (event) => event.event === 'chat:message_send',
        );
      await expect.poll(() => sends().length).toBe(1);
      await closeCanopy(electronApp, userDataDir);
      electronApp = undefined;
      expect(sends()).toHaveLength(1);
      expect(sends()[0].properties.composer_mode).toBe(
        cowork ? 'default' : 'plan',
      );
      const wire = JSON.stringify(collector.events);
      expect(wire).not.toContain(privateMessage);
      expect(wire).not.toContain('effective-mode-chat');
      expect(readPostHogCapture(collector).parseErrors).toEqual([]);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await managed?.close();
      await collector.shutdown();
    }
  });
}

for (const draft of ['blank', 'scheduled']) {
  test(`Home ${draft} submit does not report chat:message_send`, async () => {
    test.setTimeout(90_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    const collector = await startPostHogCapture();
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), 'canopy-posthog-home-send-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-desktop-posthog-capture-enabled': true,
          }),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      await home.getByTestId('home-branch-picker-button').click();
      await window.getByTestId('home-branch-picker-worktree-demo-main').click();
      if (draft === 'scheduled') {
        await home
          .getByTestId('home-composer-editor')
          .fill('Send this tomorrow');
        await home.getByTestId('home-composer-plus-button').click();
        await window
          .getByTestId('home-composer-plus-menu')
          .getByTestId('home-schedule-button')
          .click();
        await expect(
          window.getByTestId('schedule-message-modal'),
        ).toBeVisible();
        // Far enough in the future in every timezone; no automation fires.
        await window.getByTestId('schedule-message-date').fill('2100-01-01');
        await window.getByTestId('schedule-message-time').fill('12:00');
        await window.getByTestId('schedule-message-save').click();
        await expect(
          home.getByTestId('home-scheduled-send-pill'),
        ).toBeVisible();
      }
      await home.getByTestId('home-send-button').click();
      await expect(home).toHaveCount(0);
      if (draft === 'scheduled')
        await expect(
          window.getByTestId('chat-input-scheduled-send-pill'),
        ).toBeVisible();

      // A subsequent explicit message is a positive delivery control: the
      // collector must work, and the non-message Home submit must add nothing.
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', () => {
          throw new Error('dispatch refused before the turn started');
        });
      });
      await window.getByTestId('sidebar-create-task').click();
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      await home
        .getByTestId('home-composer-editor')
        .fill('Actual immediate message');
      await home.getByTestId('home-send-button').click();
      const sends = () =>
        analyticsEvents(collector.events).filter(
          (event) => event.event === 'chat:message_send',
        );
      await expect.poll(() => sends().length).toBeGreaterThan(0);
      await closeCanopy(electronApp, userDataDir);
      electronApp = undefined;
      expect(sends()).toHaveLength(1);
      expect(sends()[0].properties.chat_surface).toBe('home');
      expect(sends()[0].properties.composer_mode).toBe('default');
      expect(sends()[0].properties).not.toHaveProperty('is_first_message');
      expect(readPostHogCapture(collector).parseErrors).toEqual([]);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await collector.shutdown();
    }
  });
}

test('Home submits report the composer mode each draft was sent in', async () => {
  test.setTimeout(90_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const collector = await startPostHogCapture();
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'canopy-posthog-home-composer-mode-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // A rejected dispatch must still leave exactly one submit event per send.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:send-message');
      ipcMain.handle('chat:send-message', () => {
        throw new Error('dispatch refused before the turn started');
      });
    });
    const home = window.getByTestId('page-home');
    const sends = () =>
      analyticsEvents(collector.events).filter(
        (event) => event.event === 'chat:message_send',
      );
    const privateMessage = 'Private home composer-mode body 4b1c';
    // The toggle persists across Home visits; the second send turns it off.
    for (const [index, mode] of ['plan', 'default'].entries()) {
      await window.getByTestId('sidebar-create-task').click();
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      const planToggle = home.getByTestId('home-plan-mode-inline-button');
      if (mode === 'plan') {
        await home.getByTestId('home-composer-plus-button').click();
        await window
          .getByTestId('home-composer-plus-menu')
          .getByTestId('home-plan-mode-button')
          .click();
        await expect(planToggle).toHaveAttribute('aria-pressed', 'true');
      } else {
        await expect(planToggle).toHaveAttribute('aria-pressed', 'true');
        await planToggle.click();
        await expect(planToggle).toHaveCount(0);
      }
      await home
        .getByTestId('home-composer-editor')
        .fill(`${privateMessage} ${mode}`);
      await home.getByTestId('home-send-button').click();
      await expect(home).toHaveCount(0);
      await expect.poll(() => sends().length).toBe(index + 1);
    }
    await closeCanopy(electronApp, userDataDir);
    electronApp = undefined;
    expect(sends().map((event) => event.properties)).toEqual([
      expect.objectContaining({ chat_surface: 'home', composer_mode: 'plan' }),
      expect.objectContaining({
        chat_surface: 'home',
        composer_mode: 'default',
      }),
    ]);
    expect(JSON.stringify(collector.events)).not.toContain(privateMessage);
    expect(readPostHogCapture(collector).parseErrors).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await collector.shutdown();
  }
});

// PR6664: a failed save remains a routing credential, not a confirmed
// analytics connection. Only the external gateway response is a fixture;
// settings, preload, main handlers, durable storage and PostHog stay real.
for (const failureStatus of [503, 401]) {
  test(`provider connection analytics: gateway HTTP ${failureStatus} save and reads stay unconfirmed until valid retry`, async () => {
    test.setTimeout(120_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    let validationStatus = failureStatus;
    const validationRequests = [];
    const gateway = createServer((request, response) => {
      if (request.url === '/v1/models') {
        validationRequests.push(request.headers.authorization);
        response.writeHead(validationStatus, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      response.writeHead(307, {
        location: `${DEFAULT_MOCK_BASE_URL}${request.url}`,
      });
      response.end();
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (!address || typeof address === 'string')
      throw new Error('Gateway fixture failed to listen');
    const apiKey = `csk_posthog_gateway_${failureStatus}`;
    const gatewayKey = 'sk_posthog_gateway_retry_e2e';
    const baseUrl = 'https://gateway.analytics.test';
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'posthog-gateway-'));
    seedOrgContextScoping(userDataDir);
    const gatewayScenario = {
      cloud: {
        organizations: [
          {
            id: ORG_CONTEXT_A,
            name: 'Analytics gateway fixture',
            createdAt: '2026-09-08T00:00:00.000Z',
            updatedAt: '2026-09-08T00:00:00.000Z',
          },
        ],
        enforcedSettings: [
          {
            organizationId: ORG_CONTEXT_A,
            organizationName: 'Analytics gateway fixture',
            policies: [
              {
                kind: 'model-gateway',
                baseUrl,
                enforced: true,
                promptCachePassthrough: true,
                models: [
                  {
                    id: 'analytics-gateway-sonnet',
                    gatewayId: 'vertex/claude-sonnet',
                    label: 'Gateway Sonnet',
                    harness: 'claude',
                    contextWindow: 200_000,
                    supportedThinkingLevels: [],
                    toolSchemaProfile: 'standard',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, gatewayScenario);
    const collector = await startPostHogCapture();
    const connections = () =>
      collector.events.filter(
        (event) =>
          event.event === 'provider:account_connect' &&
          event.properties.provider === 'model_gateway',
      );
    let launched;
    try {
      launched = await launchCanopy({
        userDataDir,
        env: {
          ...ORG_CONTEXT_ENV,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          CANOPY_MOCK_LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            ...JSON.parse(
              ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
            ),
            'canopy-desktop-posthog-capture-enabled': true,
          }),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      });
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectMockCloudAccount(window, apiKey);
      await window.evaluate(() => {
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      });
      await app.openSettings();
      await app.openSettingsSection('account');
      const section = window.getByTestId('settings-model-gateway-credential');
      const input = section.getByTestId('settings-model-gateway-key-input');
      await expect(input).toBeEnabled();
      await input.fill(gatewayKey);
      await expect
        .poll(
          () =>
            collector.events.filter(
              (event) =>
                event.event === 'provider:account_connect_fail' &&
                event.properties.provider === 'model_gateway',
            ).length,
        )
        .toBe(1);
      // Settings remount and Retry both load the durable record. Neither may
      // promote an HTTP/network failure to a successful external connection.
      await app.closeSettings();
      await app.openSettings();
      await app.openSettingsSection('account');
      await expect(input).toHaveValue(gatewayKey);
      const records = await window.evaluate(
        async (organizationId) => [
          await window.api.loadModelGatewayCredential(organizationId),
          await window.api.loadModelGatewayCredential(organizationId),
        ],
        ORG_CONTEXT_A,
      );
      for (const record of records) {
        expect(record.apiKey).toBe(gatewayKey);
        expect(record.baseUrlAtSave).toBe(baseUrl);
        expect(Boolean(record.lastError)).toBe(failureStatus === 401);
      }
      // A validation-only retry is not a durable connection either.
      validationStatus = 200;
      const credential = {
        organizationId: ORG_CONTEXT_A,
        baseUrl,
        apiKey: gatewayKey,
      };
      expect(
        await window.evaluate(
          (value) => window.api.validateModelGatewayCredential(value),
          credential,
        ),
      ).toMatchObject({ valid: true });
      await window.evaluate(() =>
        window.api.savePreferences({ profileRole: 'designer' }),
      );
      await expect
        .poll(() =>
          collector.events.some(
            (event) => event.event === 'onboarding:profile_update',
          ),
        )
        .toBe(true);
      expect(connections()).toEqual([]);

      expect(
        await window.evaluate(
          (value) => window.api.saveModelGatewayCredential(value),
          credential,
        ),
      ).toMatchObject({ valid: true });
      await expect.poll(() => connections().length).toBe(1);
      expect(connections()[0].properties).toMatchObject({
        provider: 'model_gateway',
        connect_source: 'in_app',
        connection_method: 'api_key',
        surface: 'background',
      });
      // Same key and URL: successful resaves and subsequent reads dedupe.
      expect(
        await window.evaluate(
          (value) => window.api.saveModelGatewayCredential(value),
          credential,
        ),
      ).toMatchObject({ valid: true });
      const confirmed = await window.evaluate(
        (organizationId) =>
          window.api.loadModelGatewayCredential(organizationId),
        ORG_CONTEXT_A,
      );
      expect(confirmed.lastError).toBeUndefined();
      expect(
        validationRequests.filter(
          (authorization) => authorization === `Bearer ${gatewayKey}`,
        ),
      ).toHaveLength(4);
      if (failureStatus === 503) {
        // An outage while re-saving a confirmed key must not erase its
        // validation history or turn recovery into a second connection.
        validationStatus = 503;
        expect(
          await window.evaluate(
            (value) => window.api.saveModelGatewayCredential(value),
            credential,
          ),
        ).toMatchObject({ valid: false });
        await app.closeSettings();
        await app.openSettings();
        await app.openSettingsSection('account');
        await expect(input).toHaveValue(gatewayKey);
        validationStatus = 200;
        expect(
          await window.evaluate(
            (value) => window.api.saveModelGatewayCredential(value),
            credential,
          ),
        ).toMatchObject({ valid: true });
      }
      if (failureStatus === 401) {
        // Pause only the filesystem result of one read. The real handler,
        // credential writer and observer still run while Settings saves a key.
        await launched.electronApp.evaluate(() => {
          const { createRequire, syncBuiltinESMExports } =
            process.getBuiltinModule('node:module');
          const require = createRequire(`${process.cwd()}/package.json`);
          const fs = require('node:fs/promises');
          const { basename } = require('node:path');
          const original = fs.readFile;
          globalThis.__gatewayReadHeld = false;
          fs.readFile = async (...args) => {
            if (basename(String(args[0])) !== 'model-gateway-credentials.json')
              return original(...args);
            fs.readFile = original;
            syncBuiltinESMExports();
            const bytes = await original(...args);
            await new Promise((resolve) => {
              globalThis.__releaseGatewayRead = resolve;
              globalThis.__gatewayReadHeld = true;
            });
            return bytes;
          };
          syncBuiltinESMExports();
        });
        await window.evaluate((organizationId) => {
          globalThis.__pendingGatewayRead =
            window.api.loadModelGatewayCredential(organizationId);
        }, ORG_CONTEXT_A);
        await expect
          .poll(() =>
            launched.electronApp.evaluate(() => globalThis.__gatewayReadHeld),
          )
          .toBe(true);
        const replacementKey = `${gatewayKey}_replacement`;
        await input.fill(replacementKey);
        await expect.poll(() => connections().length).toBe(2);
        await launched.electronApp.evaluate(() =>
          globalThis.__releaseGatewayRead(),
        );
        await window.evaluate(() => globalThis.__pendingGatewayRead);
        await app.closeSettings();
        await app.openSettings();
        await app.openSettingsSection('account');
        await expect(input).toHaveValue(replacementKey);
      }
      if (failureStatus === 503) {
        // Two owners in one organization have independent credential baselines.
        // Switch through the real account API, then remount the Settings form.
        const originalAccount = await window.evaluate(() =>
          window.api.loadCanopyCloudAccount(),
        );
        const secondKey = `${gatewayKey}_second_owner`;
        await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
          ...gatewayScenario,
          cloud: {
            ...gatewayScenario.cloud,
            account: {
              ...originalAccount.account,
              id: 'gateway-second-owner',
            },
          },
        });
        await app.closeSettings();
        await connectMockCloudAccount(window, apiKey, {
          expectedAccount: { account: { id: 'gateway-second-owner' } },
        });
        await app.openSettings();
        await app.openSettingsSection('account');
        await expect(input).toBeEnabled();
        await input.fill(secondKey);
        await expect.poll(() => connections().length).toBe(2);
        await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
          ...gatewayScenario,
          cloud: { ...gatewayScenario.cloud, account: originalAccount.account },
        });
        await app.closeSettings();
        await connectMockCloudAccount(window, apiKey, {
          expectedAccount: { account: { id: originalAccount.account.id } },
        });
        await app.openSettings();
        await app.openSettingsSection('account');
        await expect(input).toHaveValue(gatewayKey);
      }
      await closeCanopy(launched.electronApp, launched.userDataDir);
      launched = undefined;
      expect(connections()).toHaveLength(2);
      expect(collector.parseErrors).toEqual([]);
    } finally {
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      await collector.shutdown();
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      gateway.closeAllConnections();
      await new Promise((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

test('provider connection analytics: Ollama unchanged saved port does not reconnect', async () => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  test.skip(
    process.platform !== 'darwin' && process.platform !== 'win32',
    'Requires a desktop build with Ollama enabled',
  );
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url === '/api/version' ? { version: '0.14.1' } : { models: [] },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Ollama fixture failed to listen');
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'posthog-ollama-baseline-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      ollamaConnectionMode: 'manual',
      ollamaServerPort: address.port,
    },
  });
  const collector = await startPostHogCapture();
  const connections = () =>
    collector.events.filter(
      (event) =>
        event.event === 'provider:account_connect' &&
        event.properties.provider === 'ollama',
    );
  let launched;
  try {
    launched = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // The saved endpoint already exists at launch. The first explicit Test
    // connection must establish a baseline, not a new funnel connection.
    const state = await window.evaluate(() => window.api.getOllamaState());
    expect(state).toMatchObject({ mode: 'manual', port: address.port });
    await app.openSettings();
    await app.openSettingsSection('ollama');
    await expect(window.getByTestId('ollama-port-input')).toHaveValue(
      String(address.port),
    );
    await window.getByTestId('ollama-test-connection').click();
    await expect(window.getByTestId('ollama-connection-result')).toBeVisible();
    // Save the exact same mode/port through the real Settings control, then
    // explicitly probe twice. A no-op save must not clear analytics identity.
    await window.getByTestId('ollama-save').click();
    await expect(window.getByTestId('ollama-save')).toBeEnabled();
    const results = await window.evaluate(
      async (port) => [
        await window.api.testOllamaConnection(port),
        await window.api.testOllamaConnection(port),
      ],
      address.port,
    );
    expect(
      results.every((result) => result.ok && result.port === address.port),
    ).toBe(true);
    expect(
      requests.filter((url) => url === '/api/version').length,
    ).toBeGreaterThanOrEqual(3);
    await closeCanopy(launched.electronApp, launched.userDataDir);
    launched = undefined;
    expect(connections()).toEqual([]);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    await collector.shutdown();
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('provider connection analytics: Ollama stale probe cannot replace a committed endpoint', async () => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  test.skip(
    process.platform !== 'darwin' && process.platform !== 'win32',
    'Requires a desktop build with Ollama enabled',
  );
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url === '/api/version' ? { version: '0.14.1' } : { models: [] },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Ollama fixture failed to listen');
  const nextServer = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url === '/api/version' ? { version: '0.14.1' } : { models: [] },
      ),
    );
  });
  nextServer.listen(0, '127.0.0.1');
  await once(nextServer, 'listening');
  const nextAddress = nextServer.address();
  if (!nextAddress || typeof nextAddress === 'string')
    throw new Error('Expected a second loopback port');
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'posthog-ollama-baseline-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      ollamaConnectionMode: 'manual',
      ollamaServerPort: address.port,
    },
  });
  const collector = await startPostHogCapture();
  const connections = () =>
    collector.events.filter(
      (event) =>
        event.event === 'provider:account_connect' &&
        event.properties.provider === 'ollama',
    );
  let launched;
  try {
    launched = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // The saved endpoint already exists at launch. The first explicit Test
    // connection must establish a baseline, not a new funnel connection.
    const state = await window.evaluate(() => window.api.getOllamaState());
    expect(state).toMatchObject({ mode: 'manual', port: address.port });
    await app.openSettings();
    await app.openSettingsSection('ollama');
    await expect(window.getByTestId('ollama-port-input')).toHaveValue(
      String(address.port),
    );
    await window.getByTestId('ollama-test-connection').click();
    await expect(window.getByTestId('ollama-connection-result')).toBeVisible();
    // Delay delivery of one real decoded response, rather than racing the
    // probe's 1.5-second transport deadline against UI interaction timings.
    await launched.electronApp.evaluate((_electron, port) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        if (String(args[0]) !== `http://127.0.0.1:${port}/api/version`)
          return originalFetch(...args);
        globalThis.fetch = originalFetch;
        const response = await originalFetch(...args);
        const payload = await response.json();
        response.json = async () => {
          await new Promise((resolve) => {
            globalThis.__releaseOllamaProbe = resolve;
            globalThis.__ollamaProbeHeld = true;
          });
          return payload;
        };
        return response;
      };
    }, address.port);
    await window.evaluate(() => {
      globalThis.__pendingOllamaProbe = window.api.testOllamaConnection();
    });
    await expect
      .poll(() =>
        launched.electronApp.evaluate(() => globalThis.__ollamaProbeHeld),
      )
      .toBe(true);
    await window
      .getByTestId('ollama-port-input')
      .fill(String(nextAddress.port));
    await window.getByTestId('ollama-save').click();
    await expect(window.getByTestId('ollama-save')).toBeEnabled();
    expect(
      await window.evaluate(() => window.api.getOllamaState()),
    ).toMatchObject({ port: nextAddress.port });
    await window.getByTestId('ollama-test-connection').click();
    await expect(window.getByTestId('ollama-connection-result')).toBeVisible();
    await launched.electronApp.evaluate(() =>
      globalThis.__releaseOllamaProbe(),
    );
    expect(
      await window.evaluate(() => globalThis.__pendingOllamaProbe),
    ).toMatchObject({ ok: true, port: address.port });
    await window.evaluate(() => window.api.testOllamaConnection());
    await closeCanopy(launched.electronApp, launched.userDataDir);
    launched = undefined;
    expect(
      connections().map((event) => event.properties.connect_source),
    ).toEqual(['in_app']);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    await collector.shutdown();
    nextServer.closeAllConnections();
    await new Promise((resolve, reject) =>
      nextServer.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('provider connection analytics: Copilot sign-out discards pending credential observations', async () => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const fixture = await copilotRuntimeFixture();
  const collector = await startPostHogCapture();
  let launched;
  try {
    launched = await launchCanopy({
      env: {
        ...fixture.env,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          ...JSON.parse(fixture.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS),
          'canopy-desktop-posthog-capture-enabled': true,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await window.getByTestId('copilot-connect').click();
    await expect(window.getByTestId('copilot-device-code')).toBeVisible();
    await fixture.approveDeviceCode(window);
    await expect(window.getByTestId('copilot-connection-status')).toHaveText(
      'Copilot connected',
    );
    await launched.electronApp.evaluate(() => {
      const { createRequire, syncBuiltinESMExports } =
        process.getBuiltinModule('node:module');
      const require = createRequire(`${process.cwd()}/package.json`);
      const fs = require('node:fs/promises');
      const original = fs.readFile;
      globalThis.__copilotReadHeld = false;
      fs.readFile = async (...args) => {
        if (
          require('node:path').basename(String(args[0])) !==
          'copilot-account.enc'
        )
          return original(...args);
        fs.readFile = original;
        syncBuiltinESMExports();
        const bytes = await original(...args);
        await new Promise((resolve) => {
          globalThis.__releaseCopilotRead = resolve;
          globalThis.__copilotReadHeld = true;
        });
        return bytes;
      };
      syncBuiltinESMExports();
    });
    await window.evaluate(() => {
      globalThis.__pendingCopilotStatus = window.api.copilotConnection.status();
    });
    await expect
      .poll(() =>
        launched.electronApp.evaluate(() => globalThis.__copilotReadHeld),
      )
      .toBe(true);
    await window.getByTestId('copilot-connect').click();
    await expect(window.getByTestId('copilot-connection-status')).toHaveText(
      'Ready to connect',
    );
    await launched.electronApp.evaluate(() =>
      globalThis.__releaseCopilotRead(),
    );
    const stale = await window.evaluate(
      () => globalThis.__pendingCopilotStatus,
    );
    expect(stale).toMatchObject({
      enabled: false,
      account: null,
      phase: 'idle',
    });
    await window.getByTestId('copilot-connect').click();
    await expect(window.getByTestId('copilot-device-code')).toBeVisible();
    await fixture.approveDeviceCode(window);
    await expect(window.getByTestId('copilot-connection-status')).toHaveText(
      'Copilot connected',
    );
    await window.evaluate(() => window.api.copilotConnection.status());
    await closeCanopy(launched.electronApp, launched.userDataDir);
    launched = undefined;
    expect(
      collector.events
        .filter(
          (event) =>
            event.event === 'provider:account_connect' &&
            event.properties.provider === 'copilot',
        )
        .map((event) => event.properties.connect_source),
    ).toEqual(['in_app', 'in_app']);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (launched) {
      await launched.electronApp
        .evaluate(() => globalThis.__releaseCopilotRead?.())
        .catch(() => {});
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
    await collector.shutdown();
    await fixture.close();
  }
});

for (const mode of ['manual', 'managed']) {
  test(`provider connection analytics: Ollama ${mode} startup failures are counted once per explicit action`, async () => {
    test.setTimeout(120_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    test.skip(
      process.platform !== 'darwin',
      'The executable fixture requires macOS',
    );
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a loopback port');
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), 'posthog-ollama-failure-'),
    );
    const executable = path.join(userDataDir, 'ollama');
    writeFileSync(
      executable,
      `#!${process.execPath}
if (process.argv.includes('--version')) console.log('ollama version 0.14.1');
else process.exit(1);
`,
    );
    chmodSync(executable, 0o755);
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        ollamaConnectionMode: mode,
        ollamaServerPort: address.port,
        ollamaExecutablePath: executable,
      },
    });
    const collector = await startPostHogCapture();
    let launched;
    try {
      launched = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-desktop-posthog-capture-enabled': true,
          }),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      });
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.openSettingsSection('ollama');
      await expect(window.getByTestId('ollama-port-input')).toHaveValue(
        String(address.port),
      );
      const initial = await window.evaluate(() => window.api.getOllamaState());
      expect(initial).toMatchObject({ mode, installation: { ready: true } });
      // Installation validation stays real; remove the validated executable
      // before the explicit demands to exercise a native ENOENT startup.
      if (mode === 'managed') rmSync(executable);
      const results = await window.evaluate(async () => {
        const results = [];
        for (const action of ['pull', 'delete', 'refresh']) {
          try {
            if (action === 'pull')
              await window.api.pullOllamaModel({ model: 'llama3:8b' });
            else if (action === 'delete')
              await window.api.deleteOllamaModel({ model: 'llama3:8b' });
            else await window.api.refreshOllamaModels();
            results.push({ action, failed: false });
          } catch {
            results.push({ action, failed: true });
          }
        }
        return results;
      });
      expect(results).toEqual([
        { action: 'pull', failed: true },
        { action: 'delete', failed: true },
        { action: 'refresh', failed: true },
      ]);
      await closeCanopy(launched.electronApp, launched.userDataDir);
      launched = undefined;
      const events = collector.events.filter(
        (event) =>
          event.properties.provider === 'ollama' &&
          [
            'provider:account_connect',
            'provider:account_connect_fail',
          ].includes(event.event),
      );
      expect(
        events.map((event) => ({
          event: event.event,
          source: event.properties.connect_source,
          reason: event.properties.failure_reason,
        })),
      ).toEqual(
        Array.from({ length: 3 }, () => ({
          event: 'provider:account_connect_fail',
          source: 'in_app',
          reason: mode === 'manual' ? 'network' : 'runtime_unavailable',
        })),
      );
      expect(collector.parseErrors).toEqual([]);
    } finally {
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      await collector.shutdown();
    }
  });
}

for (const action of ['pull', 'delete', 'chat']) {
  test(`provider connection analytics: Ollama managed ${action} start attribution`, async () => {
    test.setTimeout(120_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    test.skip(
      process.platform !== 'darwin',
      'The managed executable fixture requires macOS',
    );
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a loopback port');
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), 'posthog-ollama-managed-'),
    );
    if (action === 'chat') {
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'ollama',
        tabs: [
          {
            id: PRIMARY_CHAT_ID,
            title: 'Ollama automatic restart',
            providerType: 'ollama',
            executionHarness: 'claude',
            executionHarnessExplicitlyChosen: true,
            model: 'ollama-llama3:8b',
          },
        ],
      });
      writeJson(path.join(userDataDir, 'ollama-model-cache.json'), {
        version: 1,
        byPort: {
          [address.port]: {
            refreshedAt: new Date().toISOString(),
            models: [
              {
                id: 'ollama-llama3:8b',
                rawModelId: 'llama3:8b',
                label: 'llama3:8b',
                show: { capabilities: ['completion', 'tools'] },
              },
            ],
          },
        },
      });
    }
    const executable = path.join(userDataDir, 'ollama');
    const requestLog = path.join(userDataDir, 'requests.jsonl');
    // Only the external binary/HTTP service is fake. Installation validation,
    // managed spawn, model IPC, observations and PostHog SDK transport stay real.
    writeFileSync(
      executable,
      `#!${process.execPath}
const { createServer } = require('node:http');
const { appendFileSync } = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('ollama version 0.14.1');
} else {
  const server = createServer((request, response) => {
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request.url) + '\\n');
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/v1/messages') {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (name, data) => response.write('event: ' + name + '\\ndata: ' + JSON.stringify(data) + '\\n\\n');
        send('message_start', { type: 'message_start', message: { id: 'msg_local_ollama', type: 'message', role: 'assistant', model: 'llama3:8b', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local managed Ollama response' } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
        send('message_stop', { type: 'message_stop' });
        response.end();
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(pathname === '/api/version' ? { version: '0.14.1' }
      : pathname === '/api/pull' || pathname === '/api/delete' ? { status: 'success' }
      : pathname === '/api/tags' ? { models: [{ name: 'llama3:8b', model: 'llama3:8b' }] }
      : pathname === '/api/show' ? { capabilities: ['completion', 'tools'] }
      : pathname === '/v1/messages/count_tokens' ? { input_tokens: 12 }
      : { models: [] }) + '\\n');
  });
  server.listen(${address.port}, '127.0.0.1');
}
`,
    );
    chmodSync(executable, 0o755);
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        ollamaConnectionMode: 'managed',
        ollamaServerPort: address.port,
        ollamaExecutablePath: executable,
      },
    });
    const collector = await startPostHogCapture();
    let launched;
    try {
      launched = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-desktop-posthog-capture-enabled': true,
          }),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      });
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const initial = await window.evaluate(() => window.api.getOllamaState());
      expect(initial).toMatchObject({
        mode: 'managed',
        ...(action === 'chat' ? {} : { status: 'stopped' }),
        installation: { ready: true },
      });
      if (action === 'chat') {
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_ID);
        const panel = window
          .locator('[data-testid="panel-content-chat"]:visible')
          .first();
        const composer = panel.locator('[data-chat-composer-root]');
        await expect(panel.getByTestId('chat-model-picker')).toContainText(
          'llama3:8b',
        );
        await composer.getByRole('textbox').fill('Report local status.');
        await composer.getByRole('button', { name: 'Send message' }).click();
        await expect(
          panel
            .getByText('Local managed Ollama response', { exact: false })
            .first(),
        ).toBeVisible({ timeout: 60_000 });
        expect(readFileSync(requestLog, 'utf8')).toContain('/v1/messages');
      } else {
        await window.evaluate(async (operation) => {
          if (operation === 'pull')
            await window.api.pullOllamaModel({ model: 'llama3:8b' });
          else await window.api.deleteOllamaModel({ model: 'llama3:8b' });
          await window.api.refreshOllamaModels();
          await window.api.testOllamaConnection();
        }, action);
        expect(readFileSync(requestLog, 'utf8')).toContain(`/api/${action}`);
      }
      await closeCanopy(launched.electronApp, launched.userDataDir);
      launched = undefined;
      const connections = collector.events.filter(
        (event) =>
          event.event === 'provider:account_connect' &&
          event.properties.provider === 'ollama',
      );
      expect(
        connections.map((event) => event.properties.connect_source),
      ).toEqual(action === 'chat' ? [] : ['in_app']);
      expect(collector.parseErrors).toEqual([]);
    } finally {
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      await collector.shutdown();
    }
  });
}

// CAN-4632: real provider observations, operation mapping and SDK egress.
test('provider connection analytics: existing accounts stay out of the funnel', async () => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const apiKey = 'csk_provider_connection_regression';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    authUsage: { scenario: 'authed-low-usage' },
  });
  const collector = await startPostHogCapture();
  let launched;
  try {
    launched = await launchCanopy({
      env: {
        CANOPY_MOCK_API_KEY: apiKey,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('account');
    await expect(window.getByTestId('auth-panel-claude')).toBeVisible();
    const statuses = await window.evaluate(async () => [
      await window.api.getClaudeAuthStatus({ forceRefresh: true }),
      await window.api.getCodexAuthStatus({ forceRefresh: true }),
    ]);
    expect(statuses.every((status) => status.authenticated)).toBe(true);
    await window.evaluate(() =>
      window.api.savePreferences({ profileRole: 'designer' }),
    );
    await expect
      .poll(() =>
        collector.events.some(
          (event) => event.event === 'onboarding:profile_update',
        ),
      )
      .toBe(true);
    const connections = collector.events.filter(
      (event) => event.event === 'provider:account_connect',
    );
    expect(connections).toEqual([]);
    // A different account observed twice crosses the production auth confirmation boundary.
    const replacementScenario = {
      authUsage: {
        claude: {
          auth: {
            loggedIn: true,
            email: 'changed@example.test',
            authMethod: 'api_key',
          },
        },
      },
    };
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, replacementScenario);
    await window.evaluate(async () => {
      await window.api.getClaudeAuthStatus({ forceRefresh: true });
      await window.api.getClaudeAuthStatus({ forceRefresh: true });
    });
    await expect
      .poll(
        () =>
          collector.events.filter(
            (event) => event.event === 'provider:account_connect',
          ).length,
      )
      .toBe(1);
    const connected = collector.events.find(
      (event) => event.event === 'provider:account_connect',
    );
    expect(connected.properties).toMatchObject({
      provider: 'claude',
      connect_source: 'external_change',
      connection_method: 'api_key',
      is_first_connection: false,
      first_connected_provider: 'unknown',
    });
    await window.evaluate(() =>
      window.api.getClaudeAuthStatus({ forceRefresh: true }),
    );

    await closeCanopy(launched.electronApp, launched.userDataDir);
    launched = undefined;
    expect(
      collector.events.filter(
        (event) => event.event === 'provider:account_connect',
      ),
    ).toHaveLength(1);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    await collector.shutdown();
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

for (const cancel of [false, true]) {
  test(`provider connection analytics: OpenCode ${cancel ? 'cancellation' : 'setup'} reaches the real SDK`, async () => {
    test.setTimeout(120_000);
    test.skip(
      !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    const fixture = await openCodeConnectionFixture({ holdArchive: true });
    const collector = await startPostHogCapture();
    let launched;
    try {
      launched = await launchCanopy({
        env: {
          ...fixture.env,
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            ...JSON.parse(fixture.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS),
            'canopy-desktop-posthog-capture-enabled': true,
          }),
        },
        electronArgs: ['--disable-blink-features=AutomationControlled'],
      });
      const window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await window.goto(fixture.url);
      await expect(window.getByTestId('availability')).toHaveText(
        'unavailable',
      );
      await window.getByTestId('connect').click();
      const eventName = cancel
        ? 'provider:account_connect_fail'
        : 'provider:account_connect';
      if (cancel) {
        await expect.poll(fixture.archiveRequests).toBe(1);
        await window.evaluate(() => window.api.opencodeConnection.cancel());
        await expect(window.getByTestId('operation')).not.toHaveText('pending');
      } else {
        await expect.poll(fixture.archiveRequests).toBe(1);
        // A read begun during setup must not overwrite the committed baseline.
        // Hold one native installer result while setup uses the real archive.
        await launched.electronApp.evaluate(() => {
          const { createRequire, syncBuiltinESMExports } =
            process.getBuiltinModule('node:module');
          const require = createRequire(`${process.cwd()}/package.json`);
          const fs = require('node:fs/promises');
          const original = fs.lstat;
          globalThis.__openCodeSetupReadHeld = false;
          fs.lstat = async (...args) => {
            if (!String(args[0]).includes('opencode')) return original(...args);
            fs.lstat = original;
            syncBuiltinESMExports();
            const outcome = await original(...args).then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
            await new Promise((resolve) => {
              globalThis.__releaseOpenCodeSetupRead = resolve;
              globalThis.__openCodeSetupReadHeld = true;
            });
            if (outcome.error) throw outcome.error;
            return outcome.value;
          };
          syncBuiltinESMExports();
        });
        await window.evaluate(() => {
          globalThis.__pendingOpenCodeSetupRead =
            window.api.opencodeConnection.status();
        });
        await expect
          .poll(() =>
            launched.electronApp.evaluate(
              () => globalThis.__openCodeSetupReadHeld,
            ),
          )
          .toBe(true);
        fixture.releaseArchive();
        await expect(window.getByTestId('operation')).toHaveText('connect', {
          timeout: 30_000,
        });
        await expect(window.getByTestId('availability')).toHaveText(
          'available',
        );
        await launched.electronApp.evaluate(() =>
          globalThis.__releaseOpenCodeSetupRead(),
        );
        await window.evaluate(() => globalThis.__pendingOpenCodeSetupRead);
        await window.evaluate(() => window.api.opencodeConnection.status());
        // Repeating setup for the same runtime must not add a funnel event.
        await window.getByTestId('connect').click();
        await expect(window.getByTestId('operation')).toHaveText('connect', {
          timeout: 30_000,
        });
        // Hold only one installer filesystem result across a real Disconnect.
        // The stale status read must not count as another connection.
        await launched.electronApp.evaluate(() => {
          const { createRequire, syncBuiltinESMExports } =
            process.getBuiltinModule('node:module');
          const require = createRequire(`${process.cwd()}/package.json`);
          const fs = require('node:fs/promises');
          const original = fs.lstat;
          globalThis.__openCodeStatusHeld = false;
          fs.lstat = async (...args) => {
            if (!String(args[0]).includes('opencode')) return original(...args);
            fs.lstat = original;
            syncBuiltinESMExports();
            const stat = await original(...args);
            await new Promise((resolve) => {
              globalThis.__releaseOpenCodeStatus = resolve;
              globalThis.__openCodeStatusHeld = true;
            });
            return stat;
          };
          syncBuiltinESMExports();
        });
        await window.evaluate(() => {
          globalThis.__pendingOpenCodeStatus =
            window.api.opencodeConnection.status();
        });
        await expect
          .poll(() =>
            launched.electronApp.evaluate(
              () => globalThis.__openCodeStatusHeld,
            ),
          )
          .toBe(true);
        await window.getByTestId('disconnect').click();
        await expect(window.getByTestId('operation')).toHaveText('disconnect');
        await launched.electronApp.evaluate(() =>
          globalThis.__releaseOpenCodeStatus(),
        );
        await window.evaluate(() => globalThis.__pendingOpenCodeStatus);
        await expect(window.getByTestId('availability')).toHaveText(
          'unavailable',
        );
      }
      const matches = () =>
        collector.events.filter(
          (event) =>
            event.event === eventName &&
            event.properties.provider === 'opencode',
        );
      await expect.poll(() => matches().length).toBe(1);
      expect(matches()[0].properties.connect_source).toBe('in_app');
      if (cancel)
        expect(matches()[0].properties.failure_reason).toBe('cancelled');
      await closeCanopy(launched.electronApp, launched.userDataDir);
      launched = undefined;
      expect(matches()).toHaveLength(1);
      expect(
        collector.events.filter(
          (event) =>
            event.event === 'provider:account_connect' &&
            event.properties.connect_source === 'at_startup',
        ),
      ).toEqual([]);
      expect(collector.parseErrors).toEqual([]);
    } finally {
      fixture.releaseArchive();
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      await collector.shutdown();
      await fixture.close();
    }
  });
}

// CAN-4633: the successful balance grant survives a failed parallel read.
// Only the subscription transport fails; real IPC, recorder and SDK emit it.
test('PostHog reports a daily credit grant when Usage subscription loading fails', async () => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const apiKey = 'csk_posthog_daily_grant_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      aiCreditsBalance: {
        credits: 10,
        dailyDripOutcome: 'granted',
        dailyDripGrantedCredits: 10,
      },
    },
  });
  const collector = await startPostHogCapture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'canopy-posthog-grant-'));
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
          'canopy-desktop-posthog-session-replay-sample-rate': 100,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    }));
    await electronApp.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).pathname === '/api/v1/ai-credits/subscription') {
          return Promise.resolve(
            Response.json(
              { error: 'Subscription unavailable' },
              { status: 503 },
            ),
          );
        }
        return originalFetch(input, options);
      };
    });
    const win = await electronApp.firstWindow();
    const app = new CanopyAppDriver(win);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(win, apiKey);
    await app.openUsagePage();
    await expect(win.getByTestId('usage-card-ai-credits-error')).toBeVisible({
      timeout: 30_000,
    });
    const grantEvents = () =>
      collector.events.filter(
        (event) => event.event === 'billing:daily_credit_grant_update',
      );
    await expect.poll(() => grantEvents().length).toBe(1);
    expect(grantEvents()[0].properties).toMatchObject({
      grant_status: 'granted',
      grant_amount: 10,
      grant_source: 'balance_read',
    });
    expect(readPostHogCapture(collector).parseErrors).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await collector.shutdown();
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// CAN-4634: explicit local Commit, real commit handler/recorder/SDK and a fresh
// identity. Only model-generated prose is fixed; no git or telemetry result is
// replaced. Asserting commitOnly proves this is not a push-failure fallback.
test('git shipping analytics: explicit Commit records independent first and repeat outcomes privately', async () => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const collector = await startPostHogCapture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'can-4634-private-'));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspace = seed.workspaces[0];
  const privateBranch = 'private/shipping-4634-audit';
  execFileSync('git', ['branch', '-m', privateBranch], {
    cwd: workspace.worktreePath,
  });
  const worktreeListPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees.json',
  );
  const worktrees = JSON.parse(readFileSync(worktreeListPath, 'utf8'));
  worktrees.worktrees[0].branchName = privateBranch;
  writeJson(worktreeListPath, worktrees);
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'], reviewCommitMessage: true },
  });
  const privateFile = 'private-shipping-4634.txt';
  const filePath = path.join(workspace.worktreePath, privateFile);
  writeFileSync(filePath, 'first private change\n');
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
        }),
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    }));
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('github:generate-commit-messages');
      ipcMain.handle('github:generate-commit-messages', () => ({
        repos: [
          {
            repoId: '__single_repo__',
            repoName: 'private-shipping-repository',
            message: 'Update local files',
          },
        ],
        skippedRepos: [],
        failedRepos: [],
      }));
      const commit = ipcMain._invokeHandlers.get('github:commit-and-push');
      globalThis.__shippingCommitRequests = [];
      ipcMain.removeHandler('github:commit-and-push');
      ipcMain.handle('github:commit-and-push', (event, request) => {
        if (request.commitOnly !== true)
          throw new Error('Expected explicit Commit');
        globalThis.__shippingCommitRequests.push(request);
        return commit(event, request);
      });
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const commitEvents = () =>
      collector.events.filter((event) => event.event === 'git:commit_create');
    const hashes = [];
    for (let index = 0; index < 2; index++) {
      if (index) {
        writeFileSync(filePath, 'second private change\n');
        // Production focus refresh picks up filesystem changes between actions.
        await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      }
      const commit = window.getByTestId('pr-status-bar-local-commit');
      await expect(commit).toBeVisible({ timeout: 30_000 });
      await expect(commit).toHaveText('Commit');
      await commit.click();
      const review = window.getByRole('dialog', {
        name: 'Review commit messages',
      });
      await expect(review).toBeVisible();
      await review.getByRole('button', { name: 'Commit', exact: true }).click();
      await expect
        .poll(() => commitEvents().length, { timeout: 30_000 })
        .toBe(index + 1);
      expect(commitEvents()[index].properties).toMatchObject({
        source: 'manual',
        workspace_type: 'single-repo',
        flow: 'commit',
        repo_count: 1,
        is_install_first: index === 0,
        status: 'success',
        surface: 'background',
        app_version: BUNDLED_APP_VERSION,
      });
      hashes.push(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: workspace.worktreePath,
          encoding: 'utf8',
        }).trim(),
      );
    }
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(
      await electronApp.evaluate(
        () => globalThis.__shippingCommitRequests.length,
      ),
    ).toBe(2);
    await closeCanopy(electronApp, userDataDir);
    electronApp = undefined;
    expect(commitEvents()).toHaveLength(2);
    const payload = JSON.stringify(
      collector.requests.map((request) => request.payload),
    );
    for (const secret of [
      privateBranch,
      privateFile,
      'private-shipping-repository',
      workspace.worktreePath,
      workspace.repoPath,
      userDataDir,
      WORKSPACE_ID,
      WORKTREE_ID,
      ...hashes,
    ])
      expect(payload).not.toContain(secret);
    expect(
      collector.events.filter(
        (event) =>
          event.event === 'git:pull_request_open' ||
          event.event === 'git:pull_request_merge',
      ),
    ).toEqual([]);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await collector.shutdown();
  }
});

test('git shipping analytics: confirmed direct Merge reaches the real collector', async () => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const collector = await startPostHogCapture();
  let fixture;
  try {
    fixture = await openMergeFixture({
      queue: false,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-posthog-capture-enabled': true,
        }),
      },
    });
    const merge = fixture.window.getByTestId('pr-status-bar-merge-pr');
    await expect(merge).toBeVisible({ timeout: 60_000 });
    await expect(merge).toHaveAttribute('data-merge-via', 'direct');
    await merge.click();
    await expect
      .poll(
        async () =>
          (await githubScenario(fixture.token)).mergeRequests?.length ?? 0,
      )
      .toBe(1);
    const mergeEvents = () =>
      collector.events.filter(
        (event) => event.event === 'git:pull_request_merge',
      );
    await expect.poll(() => mergeEvents().length, { timeout: 30_000 }).toBe(1);
    expect(mergeEvents()[0].properties).toMatchObject({
      source: 'manual',
      workspace_type: 'single-repo',
      flow: 'merge',
      repo_count: 1,
      is_install_first: true,
      status: 'success',
      surface: 'background',
    });
    const secrets = [
      fixture.userDataDir,
      fixture.token,
      PR_URL,
      WORKSPACE_ID,
      WORKTREE_ID,
      'canopy-e2e/ts-pnpm-vite',
      'a'.repeat(40),
    ];
    await fixture.cleanup();
    fixture = undefined;
    expect(mergeEvents()).toHaveLength(1);
    const payload = JSON.stringify(
      collector.requests.map((request) => request.payload),
    );
    for (const secret of secrets) expect(payload).not.toContain(secret);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (fixture) await fixture.cleanup();
    await collector.shutdown();
  }
});

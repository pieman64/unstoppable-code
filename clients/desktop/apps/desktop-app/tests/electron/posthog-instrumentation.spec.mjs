// CAN-3111 / CAN-3114 / CAN-3117 / CAN-3118: real SDK egress, flag
// evaluations, synthetic routes, and masked replay on loopback only.
// Build and run with CANOPY_POSTHOG_ENABLED=true,
// CANOPY_POSTHOG_PROJECT_KEY=phc_e2e_browser, and
// CANOPY_POSTHOG_STUB_URL=http://127.0.0.1:18763, and
// CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE=100.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
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
  DEFAULT_MOCK_BASE_URL,
  seedWorktreeChat,
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
    await mainWindow.getByTestId('panel-add-panel-group-chat').click();
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

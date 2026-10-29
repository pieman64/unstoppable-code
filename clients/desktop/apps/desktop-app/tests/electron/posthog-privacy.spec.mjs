// CAN-3119 / CAN-3120 / CAN-3122 / CAN-3124: payload-level session-replay,
// click capture, and heatmap privacy. Judges the replay DOM contract and click events by what
// reaches the loopback PostHog stub, never by what the app renders. Build and run with the same opt-in environment as
// posthog-instrumentation.spec.mjs:
//
//   CANOPY_POSTHOG_ENABLED=true CANOPY_POSTHOG_PROJECT_KEY=phc_e2e_browser \
//   CANOPY_POSTHOG_STUB_URL=http://127.0.0.1:18763 \
//   CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE=100 pnpm run build:e2e
//   pnpm run test:electron:built posthog-privacy.spec.mjs --reporter=line
//
// One launch drives every seeded surface, then each expectation group below
// reports on its own (`expect.soft`) so a partial tree shows exactly which
// rows of the transport plan's acceptance table (C7) still fail:
//
//   - leaks: no blocked content or input value anywhere; no `file://` URL
//     anywhere, including `$current_url` and inlined stylesheets
//   - file input: the preset image picker's marker-bearing file name
//   - class: `class` attributes survive
//   - stylesheets: at least one stylesheet arrives as `_cssText`
//   - placeholders: each seeded content surface is an empty, same-size block
//   - recorded: seeded names and planted attributes reach the payload
//   - dialogs: the MCP server dialog card is recorded
//   - static labels: a sidebar nav label and a Settings heading are recorded
//     as text
//   - clicks: click, rage-click, and dead-click events arrive, name the
//     clicked control, and never carry the unstructured element chain
//   - heatmaps: heatmap batches are keyed by synthetic routes only, carry
//     coordinates only, and file the rage click under the Workflows route
//
// Recorded surfaces are found by rrweb node id (read from the live recorder's
// mirror) and by structure, never by test id.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedVisibleBrowserPanel,
  spawnPanelTerminal,
} from './panelHarness.mjs';
import {
  decodePostHogSnapshotData,
  decodedCaptureWire,
  readPostHogCapture,
  recordedAttributeValues,
  recordedChildren,
  recordedTextValues,
  replayNodes,
  startPostHogCapture,
} from './posthogCapture.mjs';
import {
  seedMcpServers,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PRIMARY_CHAT_ID = 'replay-privacy-chat';
const FILE_TAB_ID = 'replay-privacy-diff';
const MCP_SERVER_ID = 'c3119a01';
const MCP_CONFIG_ID = 'c3119c01';
const DIFF_FILE = 'README.md';

// The recorder's block marker (`POSTHOG_REPLAY_BLOCK_CLASS`).
const BLOCK_CLASS = 'ph-no-capture';
// Allowlisted static text the spec expects unmasked: a main sidebar nav label
// (`SidebarNavRow`) and the `<h1>` of a Settings section classified
// `reviewed` with a literal `SettingsPage` title.
const SIDEBAR_NAV_LABEL = 'Workflows';
const SETTINGS_SECTION = 'display';
const SETTINGS_HEADING = 'Display';

// One marker secret that every dynamic value and planted attribute carries.
const MARKER = 'zq7replay9f4c';
// The preset image picker's file name carries its own marker: on an unchanged
// tree rrweb records a `file` input as `C:\fakepath\<name>`, and that known
// leak must not also turn the general marker row red.
const FILE_INPUT_MARKER = 'presetpick7b2e';
const SEEDED = Object.freeze({
  prose: 'Harbor lanterns drift past the quiet orchard before dawn',
  marker: MARKER,
  email: 'harbor.lantern.9f4c@orchard.example',
  homePath: '/Users/harborlantern9f4c/Documents/orchard-memo.md',
  workspace: `Acquisitions ${MARKER} workspace`,
  branch: `private/${MARKER}-board`,
  chatTitle: `Board thread ${MARKER}`,
  fileTitle: `${MARKER}-diff-tab`,
  diffLine: `Diff line ${MARKER} for the orchard memo`,
  browserPath: `${MARKER}-browser-page`,
  terminalTitle: `${MARKER}-terminal-title`,
  terminalOutput: `${MARKER}-terminal-output`,
  mcpServer: `${MARKER} MCP server`,
  mcpSecret: `${MARKER}-mcp-token`,
  environment: `${MARKER} environment`,
  environmentKey: `${MARKER.toUpperCase()}_KEY`,
  environmentValue: `${MARKER}-env-secret`,
  accountName: `Wren ${MARKER} Halloway`,
  accountEmail: `wren.${MARKER}@orchard.example`,
});
// Replay records names, titles, and attributes; only input values and the
// blocked content kinds stay out. These seeds live only in transcripts, the
// composer draft, file and diff content, terminal output, input values, or a
// person's identity (the signed-in account's name and email).
const PRIVATE_SEEDS = Object.freeze({
  prose: SEEDED.prose,
  email: SEEDED.email,
  accountName: SEEDED.accountName,
  accountEmail: SEEDED.accountEmail,
  homePath: SEEDED.homePath,
  diffLine: SEEDED.diffLine,
  terminalOutput: SEEDED.terminalOutput,
  mcpSecret: SEEDED.mcpSecret,
  environmentValue: SEEDED.environmentValue,
});
// These render as names and titles in recorded chrome.
const RECORDED_SEEDS = Object.freeze({
  mcpServer: SEEDED.mcpServer,
  environment: SEEDED.environment,
});
// User-authored titles carry the mask class: replay text shows them as `*`
// with spaces kept. Their attributes (`title`, `aria-label`) stay recorded.
const MASKED_TITLE_SEEDS = Object.freeze({
  workspace: SEEDED.workspace,
  branch: SEEDED.branch,
  chatTitle: SEEDED.chatTitle,
  worktreeIdentity: WORKTREE_ID,
});
// Planted on recorded chrome; attributes are recorded verbatim.
const PLANTED = Object.freeze({
  href: `https://example.test/${MARKER}-href`,
  src: `about:blank#${MARKER}-src`,
  style: `${MARKER}-style`,
  id: `${MARKER}-id`,
  ariaLabel: `${MARKER}-aria-label`,
  data: `${MARKER}-data`,
  dataState: `${MARKER}-data-state`,
  role: `${MARKER}-role`,
  mutatedDataState: `${MARKER}-mutated-state`,
  mutatedData: `${MARKER}-mutated-data`,
  mutatedAriaDescription: `${MARKER}-mutated-aria`,
});
const PRESET_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
const FLUSH_TAG = 'can-3119-privacy-flush';
const CLICK_EVENTS = new Set(['$autocapture', '$rageclick', '$dead_click']);
const HEATMAP_EVENT = '$$heatmap';
// The sidebar step rage-clicks the Workflows row on its Library tab
// (CAN-3981), so its heatmap samples key under that page's route.
const RAGE_CLICK_ROUTE = 'app://main/workflows-library';

function analyticsEvents(events) {
  return events.filter(
    (event) =>
      event &&
      typeof event.event === 'string' &&
      event.properties &&
      typeof event.properties === 'object',
  );
}

function classTokens(value) {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

/** A short excerpt around the first occurrence of `value`, or null. */
function leakContext(wire, value) {
  const index = wire.indexOf(value);
  if (index === -1) return null;
  return wire.slice(Math.max(0, index - 160), index + value.length + 160);
}

/**
 * Locate the outermost replay block around a visible live element and read
 * its rrweb node id from the recorder's mirror. Nested blocks are never
 * serialized, so only the outermost one can appear in the payload. A missing
 * block is reported, not thrown, so the placeholder rows stay soft.
 */
async function replayBlockOf(locator) {
  await expect(locator).toBeVisible();
  const read = () =>
    locator.evaluate((element, blockClass) => {
      let block = null;
      for (let node = element; node; node = node.parentElement) {
        if (node.classList.contains(blockClass)) block = node;
      }
      const mirror = window.__PosthogExtensions__?.rrweb?.record?.mirror;
      return {
        blocked: block !== null,
        id: block && mirror ? mirror.getId(block) : null,
      };
    }, BLOCK_CLASS);
  let surface = await read();
  if (surface.blocked) {
    // rrweb assigns ids when its mutation observer serializes the node.
    await expect
      .poll(async () => {
        surface = await read();
        return surface.id;
      })
      .toBeGreaterThan(0);
  }
  return surface;
}

/**
 * Resolve once the page has gone `quietMs` without any DOM mutation. A dead
 * click needs 2.5 s with no mutation anywhere, so a page still settling after
 * navigation would suppress it.
 */
async function waitForQuietDom(page, quietMs = 3_000, timeoutMs = 20_000) {
  const quiet = await page.evaluate(
    ({ quietMs, timeoutMs }) =>
      new Promise((resolve) => {
        let timer;
        const finish = (value) => {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(deadline);
          resolve(value);
        };
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => finish(true), quietMs);
        });
        observer.observe(document, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        timer = setTimeout(() => finish(true), quietMs);
        const deadline = setTimeout(() => finish(false), timeoutMs);
      }),
    { quietMs, timeoutMs },
  );
  expect(quiet, 'the page must settle before a dead click').toBe(true);
}

function placeholderStatus(nodes, surface) {
  if (!surface.blocked) return 'not inside a replay block in the live DOM';
  const recorded = nodes.filter((node) => node.id === surface.id);
  if (recorded.length === 0) return 'block never recorded';
  for (const node of recorded) {
    if (
      node.attributes?.rr_width === undefined ||
      node.attributes?.rr_height === undefined
    ) {
      return 'block recorded without placeholder size';
    }
    if (!classTokens(node.attributes?.class).includes(BLOCK_CLASS)) {
      return 'block recorded without the block class';
    }
    if (recordedChildren(nodes, node).length > 0) {
      return 'children recorded inside the block';
    }
  }
  return 'placeholder';
}

function seedPrivacyFixture(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      // The resource pill re-renders every 2 s, and a dead click needs 2.5 s
      // without any DOM mutation.
      showDiagnosticsPill: false,
    },
  });
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('demo worktree was not seeded');

  // Project and worktree names a user chose.
  execFileSync('git', ['branch', '-m', SEEDED.branch], { cwd: worktreePath });
  const workspaceIndexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, 'utf8'));
  workspaceIndex.workspaces[0].name = SEEDED.workspace;
  writeJson(workspaceIndexPath, workspaceIndex);
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees.json',
  );
  const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  worktrees.worktrees[0].branchName = SEEDED.branch;
  writeJson(worktreesPath, worktrees);

  // A working-tree change for the file diff panel.
  const diffFilePath = path.join(worktreePath, DIFF_FILE);
  appendFileSync(diffFilePath, `\n${SEEDED.diffLine}\n`, 'utf8');
  writeFileSync(
    path.join(worktreePath, `${MARKER}-notes.txt`),
    `${SEEDED.prose}\n`,
    'utf8',
  );

  const transcript = [
    SEEDED.prose,
    `Marker ${SEEDED.marker}.`,
    `Reach ${SEEDED.email}.`,
    `Saved at ${SEEDED.homePath}.`,
  ].join(' ');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: PRIMARY_CHAT_ID,
    tabs: [
      {
        id: PRIMARY_CHAT_ID,
        title: SEEDED.chatTitle,
        messages: [
          {
            id: 'replay-privacy-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Summarize the orchard memo.' }],
            timestamp: Date.UTC(2026, 8, 1),
          },
          {
            id: 'replay-privacy-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: transcript }],
            timestamp: Date.UTC(2026, 8, 1, 0, 0, 10),
          },
        ],
      },
      {
        id: FILE_TAB_ID,
        title: SEEDED.fileTitle,
        kind: 'file',
        filePath: diffFilePath,
        fileViewMode: 'diff',
        description: diffFilePath,
        messages: [],
      },
    ],
  });

  const now = new Date().toISOString();
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: MCP_SERVER_ID,
          name: SEEDED.mcpServer,
          description: `Seeded ${MARKER} server`,
          type: 'http',
          url: `https://mcp.example.test/${MARKER}/mcp`,
          headers: { Authorization: `Bearer ${SEEDED.mcpSecret}` },
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: MCP_CONFIG_ID,
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: { 'X-Replay-Secret': SEEDED.mcpSecret },
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
}

test('PostHog replay payload keeps user content private and chrome readable', async ({}, testInfo) => {
  test.setTimeout(300_000);
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
  const collector = await startPostHogCapture();
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'canopy-replay-privacy-'),
  );
  seedPrivacyFixture(userDataDir);
  const surfaces = {};
  let dialogCardBlocked;
  let electronApp;
  let failed = false;
  try {
    const launched = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          ...JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}'),
          'canopy-desktop-posthog-capture-enabled': true,
          'canopy-desktop-posthog-session-replay-sample-rate': 100,
          'canopy-desktop-posthog-autocapture-enabled': true,
        }),
      },
      // PostHog rejects navigator.webdriver as bot traffic. Match the real
      // app navigator while keeping Electron hidden and the SDK unmodified.
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    });
    electronApp = launched.electronApp;
    const mainWindow = await electronApp.firstWindow();
    const app = new CanopyAppDriver(mainWindow);
    await app.waitForShell();
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            () =>
              typeof window.__PosthogExtensions__?.rrweb?.record?.mirror?.getId,
          ),
        { message: 'the replay recorder mirror must be reachable' },
      )
      .toBe('function');

    await test.step('seed the chat transcript and composer', async () => {
      await app.selectWorktree(WORKTREE_ID, {
        expandDefaultActivityRail: false,
      });
      await expect(
        mainWindow
          .getByTestId('chat-message-list-content')
          .getByText(SEEDED.prose, { exact: false }),
      ).toBeVisible();
      surfaces['chat transcript'] = await replayBlockOf(
        mainWindow.getByTestId('chat-message-list-content'),
      );
      // Interaction also releases the recorder's upload hold.
      await mainWindow
        .locator('[data-chat-textarea][contenteditable="true"]:visible')
        .first()
        .click();
      await mainWindow.keyboard.type(
        `${SEEDED.prose} ${SEEDED.marker} ${SEEDED.email} ${SEEDED.homePath}`,
      );
      await mainWindow.keyboard.press('Escape');
    });

    await test.step('plant marker attributes on reviewed chrome', async () => {
      await mainWindow.evaluate((planted) => {
        const sidebar = document.querySelector('[data-testid="app-sidebar"]');
        if (!sidebar) throw new Error('app sidebar is not mounted');
        const container = document.createElement('div');
        container.hidden = true;
        const link = document.createElement('a');
        link.href = planted.href;
        const image = document.createElement('img');
        image.src = planted.src;
        const span = document.createElement('span');
        span.id = planted.id;
        span.style.setProperty('--replay-plant', `"${planted.style}"`);
        span.setAttribute('aria-label', planted.ariaLabel);
        span.setAttribute('data-replay-plant', planted.data);
        span.setAttribute('data-state', planted.dataState);
        span.setAttribute('role', planted.role);
        container.append(link, image, span);
        sidebar.append(container);
        // Later attribute mutations, on the plant and on existing chrome.
        requestAnimationFrame(() => {
          span.setAttribute('data-state', planted.mutatedDataState);
          sidebar.setAttribute('data-replay-plant', planted.mutatedData);
          sidebar.setAttribute(
            'aria-description',
            planted.mutatedAriaDescription,
          );
        });
      }, PLANTED);
    });

    await test.step('sign in an account named in the sidebar footer', async () => {
      await electronApp.evaluate(
        ({ ipcMain }, account) => {
          ipcMain.removeHandler('settings:load-canopy-cloud-account');
          ipcMain.handle('settings:load-canopy-cloud-account', () => ({
            read: 'ok',
            hasApiKey: true,
            authMode: 'oauth',
            credentialSource: 'oauth_desktop',
            capabilities: [],
            storageAvailable: true,
            account: {
              id: 'replay-privacy-account',
              name: account.name,
              email: account.email,
              role: 'DEVELOPER',
            },
          }));
        },
        { name: SEEDED.accountName, email: SEEDED.accountEmail },
      );
      await mainWindow.evaluate(() => {
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      });
      const identity = mainWindow.getByTestId('sidebar-account-identity');
      await expect(identity).toHaveText(SEEDED.accountName);
      surfaces['sidebar account name'] = await replayBlockOf(identity);
    });

    await test.step('open a file diff', async () => {
      await mainWindow
        .getByTestId(`panel-tab-panel-file-${FILE_TAB_ID}`)
        .click();
      const panel = mainWindow.locator(
        `[data-testid="panel-content-file-diff"][data-panel-id="panel-file-${FILE_TAB_ID}"]`,
      );
      await expect(panel.getByTestId('file-panel-diff')).toBeVisible({
        timeout: 20_000,
      });
      surfaces['file diff'] = await replayBlockOf(panel);
    });

    await test.step('open the in-app browser panel', async () => {
      const { panelId } = await seedVisibleBrowserPanel(
        mainWindow,
        {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          url: `${collector.url}/${SEEDED.browserPath}`,
        },
        { originChatTabId: PRIMARY_CHAT_ID },
      );
      await mainWindow.getByTestId(`panel-tab-${panelId}`).click();
      // The browser bar and title are recorded; the page area is blocked.
      surfaces['browser page area'] = await replayBlockOf(
        mainWindow
          .getByTestId('browser-panel-surface')
          .getByTestId('browser-page-area'),
      );
    });

    await test.step('open the terminal panel', async () => {
      const pane = await spawnPanelTerminal(mainWindow);
      await pane.click();
      await mainWindow.keyboard.type(
        `printf '\\033]0;%s\\007' ${SEEDED.terminalTitle}; echo ${SEEDED.terminalOutput}`,
      );
      await mainWindow.keyboard.press('Enter');
      await expect(pane).toContainText(SEEDED.terminalOutput, {
        timeout: 20_000,
      });
      surfaces['terminal panel'] = await replayBlockOf(pane);
    });

    await test.step('navigate Settings and pick a preset image file', async () => {
      await app.openSettings();
      // CAN-4421: the cloud sign-in is the hosted Account page's
      // "Signed in on this computer" card.
      await app.openAccountSettingsPage('account');
      const accountStatus = mainWindow
        .getByTestId('account-device-card-cloud-account')
        .getByTestId('settings-account-canopy-cloud-oauth');
      const accountEmail = accountStatus.getByText(SEEDED.accountEmail, {
        exact: true,
      });
      await expect(accountEmail).toBeVisible();
      // The identity spans keep their own block class inside the device card,
      // whatever the hosted page wrapper's classification.
      await expect(accountEmail).toHaveClass(
        new RegExp(`\\b${BLOCK_CLASS}\\b`),
      );
      await expect(
        accountStatus.getByText(SEEDED.accountName, { exact: true }),
      ).toHaveClass(new RegExp(`\\b${BLOCK_CLASS}\\b`));
      surfaces['account email'] = await replayBlockOf(accountEmail);
      await app.openSettingsSection(SETTINGS_SECTION);
      await expect(
        mainWindow
          .getByTestId(`settings-tab-${SETTINGS_SECTION}`)
          .getByRole('heading', { name: SETTINGS_HEADING, exact: true }),
      ).toBeVisible();
      await app.openSettingsSection('terminal');
      const terminalSettings = mainWindow.getByTestId('settings-tab-terminal');
      await expect(terminalSettings).not.toHaveClass(
        new RegExp(`\\b${BLOCK_CLASS}\\b`),
      );
      // Settings sections are recorded.
      await expect(
        terminalSettings.locator(':scope > div').last(),
      ).not.toHaveClass(new RegExp(`\\b${BLOCK_CLASS}\\b`));
      await mainWindow.getByTestId('terminal-preset-add').click();
      const editor = mainWindow.getByTestId('terminal-preset-editor');
      await editor.getByLabel('Image or SVG').setInputFiles({
        name: `${FILE_INPUT_MARKER}.svg`,
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(PRESET_IMAGE_SVG),
      });
      await expect(
        editor.getByTestId('terminal-preset-image-light-preview'),
      ).toHaveAttribute('src', /^data:image\/svg\+xml/);
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await app.closeSettings();
    });

    await test.step('open the MCP server form dialog', async () => {
      await app.openPluginsPage();
      await app.openPluginsTab('mcp');
      const row = mainWindow
        .getByTestId('plugins-management-section-mcp')
        .locator('tr', { hasText: SEEDED.mcpServer });
      await row.getByTestId('mcp-server-edit-button').click();
      const dialog = mainWindow.getByRole('dialog', {
        name: 'Edit MCP server',
      });
      const nameInput = dialog.getByPlaceholder('My MCP server');
      await expect(nameInput).toHaveValue(SEEDED.mcpServer);
      // The dialog is recorded; the header value is an input, so the
      // recorder masks it (checked by the private-seed leak step).
      dialogCardBlocked = await dialog.evaluate(
        (card, blockClass) => card.closest(`.${blockClass}`) !== null,
        BLOCK_CLASS,
      );
      await mainWindow.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      // The management view swaps the main sidebar for its own page nav.
      await mainWindow.getByTestId('plugins-management-back').click();
      await expect(
        mainWindow.getByTestId('plugins-management-view'),
      ).toBeHidden();
    });

    await test.step('navigate the sidebar', async () => {
      // `openAutomationsPage` clicks the main nav row whose label is
      // SIDEBAR_NAV_LABEL, then opens the Library tab. The row stays put on
      // every Workflows tab, so a repeat click below changes nothing.
      await app.openAutomationsPage();
      await expect(
        mainWindow
          .getByTestId('sidebar-nav-workflows')
          .getByText(SIDEBAR_NAV_LABEL, { exact: true }),
      ).toBeVisible();
    });

    await test.step('rage-click the open page nav row', async () => {
      // Clicking the already-open page changes nothing: a rage click, and
      // once the DOM stays quiet, a dead click.
      const navRow = mainWindow.getByTestId('sidebar-nav-workflows');
      const captured = (name) =>
        readPostHogCapture(collector).events.some(
          (event) => event.event === name,
        );
      await waitForQuietDom(mainWindow);
      await navRow.click({ clickCount: 3 });
      await expect
        .poll(() => captured('$rageclick'), {
          timeout: 30_000,
          message: 'rage clicks must reach the stub',
        })
        .toBe(true);
      // The SDK drops a dead click if anything in the document mutates within
      // 2.5 s of it, and a late background response can land in that window
      // after the DOM looked quiet. Such a click was not dead, so click the
      // row again once the DOM settles.
      let attempt = 0;
      await expect(async () => {
        if (attempt++ > 0 && !captured('$dead_click')) {
          await waitForQuietDom(mainWindow);
          await navRow.click();
        }
        await expect
          .poll(() => captured('$dead_click'), { timeout: 8_000 })
          .toBe(true);
      }, 'dead clicks must reach the stub').toPass({ timeout: 60_000 });
    });

    await test.step('open the environment variable editor', async () => {
      // CAN-4269: the editor lives in Settings → Environments.
      await app.openSettings();
      const environmentNav = mainWindow.getByTestId('settings-nav-environment');
      await expect(environmentNav).toBeVisible();
      // Dispatch movement and navigation in one renderer task so the route
      // changes before the SDK's 500 ms mousemove debounce can complete.
      await environmentNav.evaluate(async (button) => {
        button.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 171,
            clientY: 193,
          }),
        );
        button.click();
        // Let the old timeout expire before generating a new-route sample.
        await new Promise((resolve) => setTimeout(resolve, 600));
        document.body.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 211,
            clientY: 233,
          }),
        );
      });
      const page = mainWindow.getByTestId('settings-tab-environment');
      await expect(page).toBeVisible();
      const environmentSamples = () =>
        readPostHogCapture(collector)
          .events.filter((event) => event.event === HEATMAP_EVENT)
          .flatMap(
            (event) =>
              event.properties.$heatmap_data?.['app://settings/environment'] ??
              [],
          );
      await expect
        .poll(
          () =>
            environmentSamples().some(
              (sample) =>
                sample.type === 'mousemove' &&
                sample.x === 211 &&
                sample.y === 233,
            ),
          {
            timeout: 30_000,
            message: 'new-route mousemove must reach the heatmap collector',
          },
        )
        .toBe(true);
      expect(
        environmentSamples().filter(
          (sample) =>
            sample.type === 'mousemove' && sample.x === 171 && sample.y === 193,
        ),
        'pending movement from the previous route must not reach the Environments heatmap',
      ).toEqual([]);
      await page.getByTestId('environments-new-environment').click();
      await page
        .getByTestId('environments-name-input')
        .fill(SEEDED.environment);
      await page.getByTestId('environment-editor-add-row').click();
      await page
        .locator('input[data-testid^="environment-editor-key-"]')
        .last()
        .fill(SEEDED.environmentKey);
      await page
        .locator('[data-testid^="environment-editor-value-"]')
        .last()
        .fill(SEEDED.environmentValue);
    });

    // Everything above is in the recorder's buffer before this custom event,
    // so its arrival proves the whole flow has been uploaded.
    await mainWindow.evaluate((tag) => {
      window.__PosthogExtensions__.rrweb.record.addCustomEvent(tag, {});
    }, FLUSH_TAG);
    const mainReplay = () =>
      readPostHogCapture(collector)
        .events.filter(
          (event) =>
            event.event === '$snapshot' && event.properties?.surface === 'main',
        )
        .flatMap(decodePostHogSnapshotData);
    await expect
      .poll(
        () =>
          mainReplay().some(
            (event) => event.type === 5 && event.data?.tag === FLUSH_TAG,
          ),
        { timeout: 30_000, message: 'the flushed replay must reach the stub' },
      )
      .toBe(true);

    const capture = readPostHogCapture(collector);
    const decoded = mainReplay();
    const nodes = replayNodes(decoded);
    // Without a capture nothing below can pass or fail meaningfully.
    expect(analyticsEvents(capture.events).length).toBeGreaterThan(0);
    expect(decoded.some((event) => event.type === 2)).toBe(true);
    expect(capture.parseErrors).toEqual([]);

    await test.step('C7 leaks: no blocked content or input value in any event or snapshot', async () => {
      const wire = decodedCaptureWire(capture.events);
      for (const [name, value] of Object.entries(PRIVATE_SEEDS)) {
        expect
          .soft(leakContext(wire, value), `seeded ${name} leaked`)
          .toBe(null);
      }
      // rrweb rewrites relative stylesheet URLs against the page's `file://`
      // base, which names the install path (and, for per-user installs, the
      // OS account). No recorded value may carry a local file URL.
      expect
        .soft(
          leakContext(wire, 'file://'),
          'no file:// URL may appear in any event or snapshot',
        )
        .toBe(null);
      expect
        .soft(
          analyticsEvents(capture.events)
            .map((event) => event.properties.$current_url)
            .filter(
              (url) => typeof url === 'string' && url.startsWith('file://'),
            ),
          'no $current_url may start with file://',
        )
        .toEqual([]);
    });

    await test.step('C7 file input: the picked file name never appears', async () => {
      const wire = decodedCaptureWire(capture.events);
      expect
        .soft(
          leakContext(wire, FILE_INPUT_MARKER),
          'the preset image file name leaked',
        )
        .toBe(null);
    });

    await test.step('C7 class: class attributes survive', async () => {
      const classes = recordedAttributeValues(decoded, 'class');
      expect
        .soft(
          classes.some((value) => /[a-z]/i.test(value)),
          'recorded class values must keep their text',
        )
        .toBe(true);
      expect
        .soft(
          classes.some((value) => classTokens(value).includes(BLOCK_CLASS)),
          'the block marker must be visible in recorded classes',
        )
        .toBe(true);
    });

    await test.step('C7 stylesheets: a stylesheet arrives as _cssText', async () => {
      expect
        .soft(
          recordedAttributeValues(decoded, '_cssText').some((value) =>
            /\{[^}]*:[^}]*\}/.test(value),
          ),
          'at least one inlined stylesheet must be recorded',
        )
        .toBe(true);
    });

    await test.step('C7 placeholders: content surfaces are blocked', async () => {
      for (const [name, surface] of Object.entries(surfaces)) {
        expect
          .soft(placeholderStatus(nodes, surface), `${name} replay placeholder`)
          .toBe('placeholder');
      }
    });

    await test.step('C7 titles: project, worktree, and chat titles are masked in replay text', async () => {
      const texts = recordedTextValues(decoded);
      for (const [name, value] of Object.entries(MASKED_TITLE_SEEDS)) {
        expect
          .soft(
            texts.filter((text) => text.includes(value)),
            `seeded ${name} must not be recorded as readable text`,
          )
          .toEqual([]);
        expect
          .soft(
            texts.some((text) => text === value.replace(/\S/g, '*')),
            `seeded ${name} must be recorded masked`,
          )
          .toBe(true);
      }
    });

    await test.step('C7 recorded: names and planted attributes reach the payload', async () => {
      const wire = decodedCaptureWire(capture.events);
      for (const [name, value] of Object.entries(RECORDED_SEEDS)) {
        expect
          .soft(wire.includes(value), `seeded ${name} must be recorded`)
          .toBe(true);
      }
      for (const name of ['href', 'ariaLabel', 'data', 'id']) {
        expect
          .soft(
            wire.includes(PLANTED[name]),
            `planted ${name} attribute must be recorded`,
          )
          .toBe(true);
      }
    });

    await test.step('C8 clicks: click events name the control and nothing else', async () => {
      const clicks = analyticsEvents(capture.events).filter((event) =>
        CLICK_EVENTS.has(event.event),
      );
      for (const name of CLICK_EVENTS) {
        expect
          .soft(
            clicks.some((event) => event.event === name),
            `a ${name} event must be captured`,
          )
          .toBe(true);
      }
      const namesNavRow = (event) =>
        Array.isArray(event.properties.$elements) &&
        event.properties.$elements.some(
          (element) =>
            element?.['attr__data-testid'] === 'sidebar-nav-workflows',
        );
      expect
        .soft(
          clicks.some(
            (event) =>
              event.event === '$rageclick' &&
              namesNavRow(event) &&
              event.properties.$el_text === SIDEBAR_NAV_LABEL,
          ),
          'the rage click must name the Workflows nav row',
        )
        .toBe(true);
      expect
        .soft(
          analyticsEvents(capture.events)
            .filter((event) => '$elements_chain' in event.properties)
            .map((event) => event.event),
          'no event may carry the unstructured element chain',
        )
        .toEqual([]);
      expect
        .soft(
          analyticsEvents(capture.events).some(
            (event) => event.event === '$copy_autocapture',
          ),
          'copied text is never captured',
        )
        .toBe(false);
    });

    await test.step('C9 heatmaps: samples are keyed by route and carry coordinates only', async () => {
      const heatmapData = () =>
        analyticsEvents(readPostHogCapture(collector).events)
          .filter((event) => event.event === HEATMAP_EVENT)
          .map((event) => event.properties.$heatmap_data);
      // Leaving Workflows › Library flushes its samples under its route.
      await expect
        .poll(
          () =>
            heatmapData().some(
              (data) =>
                Array.isArray(data?.[RAGE_CLICK_ROUTE]) &&
                data[RAGE_CLICK_ROUTE].some(
                  (sample) => sample?.type === 'rageclick',
                ),
            ),
          {
            timeout: 30_000,
            message: 'the Workflows rage click must reach a heatmap batch',
          },
        )
        .toBe(true);
      const batches = heatmapData();
      expect
        .soft(
          batches
            .flatMap((data) =>
              data && typeof data === 'object' ? Object.keys(data) : [data],
            )
            .filter(
              (key) => typeof key !== 'string' || !key.startsWith('app://'),
            ),
          'every heatmap key must be a synthetic app:// route',
        )
        .toEqual([]);
      expect
        .soft(
          batches
            .flatMap((data) => Object.values(data ?? {}).flat())
            .filter(
              (sample) =>
                JSON.stringify(Object.keys(sample ?? {}).sort()) !==
                JSON.stringify(['target_fixed', 'type', 'x', 'y']),
            ),
          'heatmap samples carry only coordinates and type',
        )
        .toEqual([]);
    });

    await test.step('C7 dialogs: the dialog card is recorded', async () => {
      expect
        .soft(
          dialogCardBlocked,
          'the MCP server dialog card must not be blocked',
        )
        .toBe(false);
    });

    await test.step('C7 static labels: reviewed chrome text is unmasked', async () => {
      const elements = new Map(
        nodes.filter((node) => node.type === 2).map((node) => [node.id, node]),
      );
      const unmaskedText = (text, parentMatches) =>
        nodes.some(
          (node) =>
            node.type === 3 &&
            node.textContent?.trim() === text &&
            parentMatches(elements.get(node.parentId)),
        );
      expect
        .soft(
          unmaskedText(
            SIDEBAR_NAV_LABEL,
            (parent) =>
              parent?.tagName === 'button' &&
              'data-sidebar-nav-row' in (parent.attributes ?? {}),
          ),
          `the "${SIDEBAR_NAV_LABEL}" sidebar nav label must be unmasked`,
        )
        .toBe(true);
      expect
        .soft(
          unmaskedText(SETTINGS_HEADING, (parent) => parent?.tagName === 'h1'),
          `the "${SETTINGS_HEADING}" Settings heading must be unmasked`,
        )
        .toBe(true);
      expect
        .soft(
          unmaskedText('Edit MCP server', (parent) => parent?.tagName === 'h2'),
          'the static MCP server dialog title must be unmasked',
        )
        .toBe(true);
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed || testInfo.errors.length > 0) {
      const capture = readPostHogCapture(collector);
      const capturePath = testInfo.outputPath('posthog-capture.json');
      mkdirSync(path.dirname(capturePath), { recursive: true });
      writeFileSync(
        capturePath,
        JSON.stringify(
          {
            surfaces,
            requests: capture.requests.map(({ method, path: requestPath }) => ({
              method,
              path: requestPath,
            })),
            parseErrors: capture.parseErrors,
            events: JSON.parse(decodedCaptureWire(capture.events)),
          },
          null,
          1,
        ),
      );
      await testInfo.attach('posthog-capture.json', {
        path: capturePath,
        contentType: 'application/json',
      });
    }
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await collector.shutdown();
  }
});

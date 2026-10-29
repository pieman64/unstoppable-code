import { selectModelOption } from './model-selection-fixture.mjs';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  saveWorkflowEdit,
} from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedHomeChatLayout,
  delayHomeChatHydration,
} from './seeders/seedHomeChatLayout.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { seedStaleWorktreeBase } from './seeders/seedStaleWorktreeBase.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setUiScale } from './uiScale.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { INVOCABLE_INVENTORY_CACHE_VERSION } from './seeders/invocableInventoryCache.mjs';
import {
  CHAT_EFFORT_TRIGGER_TEST_ID,
  closeEffortPanel,
  openEffortSlider,
  stepEffortAway,
} from './effortPanel.mjs';

// Task B7 (Home surface Plan B) — Electron UI automation for the chat-centric
// `'home'` page (`HomePage` / `HomeSurface` variant="page") reached via the
// sidebar's "New Task" button. `code-tab-empty-state.spec.mjs` already pins
// the embedded `HomeSurface` variant hosted inside the empty Code tab
// (including the cowork-only-install "composer stays enabled" invariant from
// CAN-337 / Task B6), and `workspace-create-auto-worktree.spec.mjs` /
// `helper-flows.spec.mjs` already exercise pieces of the send flow. This file
// focuses on what those don't cover: sidebar navigation to the standalone
// page variant, the seeded-workspace composer's default picker/mode-pill
// state, Pipeline-mode's control-hiding + branch-lock + `task_ready` modal
// launch, and the end-to-end chat-mode send (worktree creation through a
// visible transcript message).

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const HOME_SUGGESTED_PROMPTS = new Set([
  'Research a topic and write up what matters',
  'Plan a project and break it into steps',
  'Turn rough notes into a polished document',
  'Draft an email, post, or announcement',
  'Make sense of a spreadsheet or data file',
  'Build a small tool from scratch',
]);
const DEV_SUGGESTED_PROMPTS = [
  'Explain the architecture of this codebase',
  'Find and fix a small bug worth cleaning up',
  'Review my latest changes and suggest fixes',
  'Add tests to the least-tested code',
  'Write docs for an undocumented area',
];

async function openHomeComposerPlusMenu(window, homePage) {
  await homePage.getByTestId('home-composer-plus-button').click();
  const menu = window.getByTestId('home-composer-plus-menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function clickHomeComposerAction(window, homePage, testId) {
  const menu = await openHomeComposerPlusMenu(window, homePage);
  await menu.getByTestId(testId).click();
}

async function waitForHomeWorkspaceSelection(homePage) {
  await expect(homePage.getByTestId('home-surface')).toHaveAttribute(
    'data-workspace-selected',
    'true',
  );
}

// Electron names the standard arrow `pointer` and the pointing hand `hand`.
const ARROW_CURSOR = 'pointer';

/**
 * Follows the cursor the renderer asks the OS to show. Screenshots leave the
 * cursor out, so `cursor-changed` is the one place to read what Chromium
 * actually picked, including over a styled scrollbar.
 */
async function trackNativeCursor(electronApp) {
  await electronApp.evaluate(({ webContents }) => {
    const latest = { type: null };
    Reflect.set(globalThis, '__canopyE2eNativeCursor', latest);
    for (const contents of webContents.getAllWebContents()) {
      contents.on('cursor-changed', (_event, type) => {
        latest.type = type;
      });
    }
  });
  return () =>
    electronApp.evaluate(
      () => Reflect.get(globalThis, '__canopyE2eNativeCursor').type,
    );
}

// Task F2 fixtures — mirrors `slash-invocable-inventory.spec.mjs`'s seeding
// approach (a plugins-cache.json + invocable-inventory-cache.json pair) so
// the Home composer's merged shared composer menu have Canopy-managed
// workspace-default skill/plugin rows to assert against.
const MARKETPLACE_ID = 'demo/market';
const PLUGIN_NAME = 'available-plugin';
const COMMAND_NAME = 'say-hi';
const SKILL_SOURCE_ID = 'custom:home-e2e';
const SKILL_NAME = 'home-managed-skill';

function seedInventoryCache(userDataDir) {
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    // A mismatched version is rebuilt from disk, which has no source for the
    // seeded custom skill.
    version: INVOCABLE_INVENTORY_CACHE_VERSION,
    builtAt: '2026-06-20T00:00:00.000Z',
    entries: [
      {
        id: `claude:skill:${encodeURIComponent(SKILL_SOURCE_ID)}:${SKILL_NAME}`,
        provider: 'claude',
        kind: 'skill',
        name: SKILL_NAME,
        displayName: `/${SKILL_NAME}`,
        description: 'Seeded managed skill',
        insertText: `/${SKILL_NAME} `,
        invocationKey: `/${SKILL_NAME}`,
        enableRef: {
          kind: 'skill',
          sourceId: SKILL_SOURCE_ID,
          skillName: SKILL_NAME,
        },
        sourceLabel: 'Custom',
      },
      {
        id: `claude:plugin_command:${MARKETPLACE_ID}:${PLUGIN_NAME}:${COMMAND_NAME}`,
        provider: 'claude',
        kind: 'plugin_command',
        name: COMMAND_NAME,
        displayName: `/${COMMAND_NAME}`,
        description: 'Seeded command',
        insertText: `/${COMMAND_NAME} `,
        invocationKey: `/${COMMAND_NAME}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
        sourceLabel: PLUGIN_NAME,
      },
    ],
  });
}

function seedWorkspaceManagedSelections(userDataDir) {
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeJson(configPath, {
    ...config,
    defaultPluginSelections: {
      collectionIds: [],
      skillRefs: [{ sourceId: SKILL_SOURCE_ID, skillName: SKILL_NAME }],
      pluginRefs: [
        {
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
      ],
      mcpServerRefs: [],
    },
  });
}

function seedPluginCache(userDataDir) {
  const details = {
    skills: [],
    agents: [],
    commands: [
      {
        name: COMMAND_NAME,
        description: 'Seeded command',
        filePath: 'commands/say-hi.md',
      },
    ],
    apps: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };

  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: '2026-06-20T00:00:00.000Z',
    lastProviderRefreshAt: '2026-06-20T00:00:00.000Z',
    marketplaces: [
      {
        id: MARKETPLACE_ID,
        name: 'Demo Market',
        sourceType: 'github',
        sourceUrl: 'demo/market',
        installLocation: '/tmp/demo-market',
        pluginCount: 1,
        plugins: [
          {
            name: PLUGIN_NAME,
            description: 'Seeded plugin',
            sourcePath: '',
            marketplaceId: MARKETPLACE_ID,
            providerSupport: { claude: 'native', codex: 'none' },
            facets: {
              claude: {
                provider: 'claude',
                mode: 'native',
                name: PLUGIN_NAME,
                installLocation: '',
                sourcePath: '',
                details,
              },
            },
          },
        ],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-06-20T00:00:00.000Z',
          },
        },
        validProviders: ['claude'],
      },
    ],
  });
}

test.describe('Home surface', () => {
  for (const baseSource of [
    'default remote',
    'reselected remote',
    'explicit local',
  ]) {
    test(`New task uses the ${baseSource} base when the local default is stale`, async () => {
      test.setTimeout(120_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-home-stale-base-'),
      );
      const seed = seedDemoWorkspaces({
        userDataDir,
        apps: [DEMO_APP_ID],
        createWorktrees: false,
      });
      const repoPath = seed.workspaces[0].repoPath;
      const base = seedStaleWorktreeBase(userDataDir, repoPath);
      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell();
        await window.getByTestId('sidebar-create-task').click();
        const home = window.getByTestId('page-home');
        await expect(home).toBeVisible();
        await waitForHomeWorkspaceSelection(home);
        await expect(
          home.getByTestId('home-base-branch-picker-button'),
        ).toContainText(base.branchName);
        if (baseSource !== 'default remote') {
          await home.getByTestId('home-base-branch-picker-button').click();
          await window
            .getByTestId(
              `home-base-branch-picker-branch-${base.branchName}-${baseSource === 'explicit local' ? 'local' : 'remote'}`,
            )
            .click();
        }
        const remoteHeadAtSend = base.advanceRemote();
        await home
          .getByTestId('home-composer-editor')
          .fill('Check the task base without changing any files.');
        await home.getByTestId('home-send-button').click();
        await expect(window.getByTestId('panel-content-chat')).toBeVisible();
        const worktreesFile = path.join(
          userDataDir,
          'workspaces',
          WORKSPACE_ID,
          'worktrees.json',
        );
        const readCreated = () =>
          JSON.parse(readFileSync(worktreesFile, 'utf8')).worktrees[0];
        await expect.poll(() => readCreated()?.setupPhase).toBe('git-ready');
        const created = readCreated();
        const worktreePath = path.join(
          userDataDir,
          'workspaces',
          WORKSPACE_ID,
          'worktrees',
          created.id,
        );
        const head = (cwd) =>
          execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd,
            encoding: 'utf8',
          }).trim();
        expect(head(worktreePath)).toBe(
          baseSource === 'explicit local' ? base.localHead : remoteHeadAtSend,
        );
        expect(head(repoPath)).toBe(base.localHead);
        expect(created.trackedBaseBranch).toBe(base.branchName);
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('sidebar New Task navigates to the standalone Home page with the Add-a-workspace CTA', async () => {
    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      await window.getByTestId('sidebar-create-task').click();

      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await expect(
        homePage.locator('[data-testid="home-surface"][data-variant="page"]'),
      ).toBeVisible();

      await expect(homePage.getByTestId('home-composer')).toBeVisible();

      // The heading is picked from the curated pool and held while mounted.
      const heading = homePage.getByTestId('home-heading');
      await expect(heading).toBeVisible();
      await expect(heading).not.toHaveText('');

      // The heading is picked once per mount and HELD — re-clicking "New
      // Task" while already on the Home page must not remount HomeSurface
      // (HomePage stays the active lazy page), so the text must not change.
      const headingTextBeforeReclick = await heading.textContent();
      // Mirrors HOME_HEADINGS for CAN-2697.
      expect([
        "Say what you'd like to get done",
        'Describe what you need, in your own words',
        "Share what you're working on today",
        'Start with a goal, a question, or a rough idea',
        "Get help with whatever's on your plate today",
        'Explain what you need and let the work begin',
      ]).toContain(headingTextBeforeReclick);
      await window.getByTestId('sidebar-create-task').click();
      await expect(homePage).toBeVisible();
      await expect(homePage.getByTestId('home-composer')).toBeVisible();
      await expect(heading).toHaveText(headingTextBeforeReclick ?? '');

      // The always-present default Cowork workspace IS a selectable send
      // target, so the composer stays fully enabled here rather than locked
      // — the same "cowork-only fresh install" invariant
      // `code-tab-empty-state.spec.mjs` already pins for the embedded
      // variant of this same surface.
      await expect(
        homePage.getByTestId('home-composer-editor'),
      ).toHaveAttribute('contenteditable', 'true');
      // With only Chats available, the picker names the send destination and
      // keeps the New project action available.
      await expect(homePage.getByTestId('home-workspace-select')).toBeVisible();
      await expect(homePage.getByTestId('home-composer-context')).toBeVisible();
      const editor = homePage.getByTestId('home-composer-editor');
      await editor.fill('Single-workspace task');
      await expect(editor).toContainText('Single-workspace task');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a long prompt scrolls the box, and its scrollbar shows the arrow rather than the text cursor', async () => {
    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      const readCursor = await trackNativeCursor(electronApp);

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      const editor = homePage.getByTestId('home-composer-editor');
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      // Enough text to pass the box's maximum height.
      await editor.fill('Describe the change in a few more words. '.repeat(40));

      // The editable's parent is the box that scrolls.
      const scroller = editor.locator('xpath=..');
      await expect
        .poll(() =>
          scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(0);
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      const box = await scroller.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const borderLeft = parseFloat(style.borderLeftWidth);
        const borderRight = parseFloat(style.borderRightWidth);
        const gutter =
          element.offsetWidth - element.clientWidth - borderLeft - borderRight;
        return {
          left: rect.left,
          top: rect.top,
          bottom: rect.bottom,
          gutter,
          scrollbarX: rect.right - borderRight - gutter / 2,
          clientHeight: element.clientHeight,
          thumbHeight: element.clientHeight ** 2 / element.scrollHeight,
        };
      });
      expect(box.gutter).toBeGreaterThan(0);
      // Scrolled to the top, the thumb sits at the top of the bar and the
      // track shows below it.
      expect(box.thumbHeight).toBeLessThan(box.clientHeight - 16);
      const text = { x: box.left + 40, y: box.top + 30 };
      const scrollbar = {
        thumb: { x: box.scrollbarX, y: box.top + box.thumbHeight / 2 },
        track: { x: box.scrollbarX, y: box.bottom - 6 },
      };

      for (const [part, point] of Object.entries(scrollbar)) {
        await window.mouse.move(text.x, text.y);
        await expect.poll(readCursor).toBe('text');
        await window.mouse.move(point.x, point.y);
        await expect
          .poll(readCursor, { message: `cursor over the scrollbar ${part}` })
          .toBe(ARROW_CURSOR);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('pasting a clipboard image into the composer stages it as an attachment pill', async () => {
    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      // Wait for the MRU-seed effect to select the default cowork workspace —
      // the paste handler no-ops while `workspaceId` is still null.
      await waitForHomeWorkspaceSelection(homePage);

      const editor = homePage.getByTestId('home-composer-editor');
      await editor.click();

      // Synthesize the "pasted a screenshot" shape: a pathless image File on
      // the clipboard (`ClipboardEvent.clipboardData.items` with kind
      // 'file'), which the handler must round-trip through the clipboard
      // attachment import rather than Slate's default text insertion.
      await editor.evaluate((el) => {
        // 1x1 transparent PNG.
        const base64 =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'pasted-image.png', {
          type: 'image/png',
        });
        const clipboardData = new DataTransfer();
        clipboardData.items.add(file);
        el.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      // The imported attachment renders as a pill above the controls row
      // (same `AttachmentPillCarousel` the worktree chat composer uses).
      await expect(
        homePage
          .getByTestId('home-composer')
          .locator('[title="pasted-image.png"]'),
      ).toBeVisible();
      await expect(homePage.getByTestId('home-composer-error')).toHaveCount(0);

      // The pasted file must not leak into the editor as text.
      await expect(editor).not.toContainText('pasted-image');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('seeded project: picker, branch target, and mode pill default to Chat with controls visible', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      // Auto-seeded by HomeSurface's MRU-fallback-to-first-workspace effect
      // since only one workspace exists.
      await waitForHomeWorkspaceSelection(homePage);

      const suggestedPromptChips = homePage.getByTestId(
        'suggested-prompt-chip',
      );
      await expect(suggestedPromptChips).toHaveCount(3);
      const suggestedPromptTexts = await suggestedPromptChips.allTextContents();
      expect(
        suggestedPromptTexts.every((text) => HOME_SUGGESTED_PROMPTS.has(text)),
      ).toBe(true);
      expect(
        suggestedPromptTexts.some((text) =>
          DEV_SUGGESTED_PROMPTS.includes(text),
        ),
      ).toBe(false);

      // `NEW_WORKTREE_TARGET` is the store's default branch target
      // regardless of whether the seeded workspace already has a worktree.
      await expect(homePage.getByTestId('home-branch-picker')).toContainText(
        'New worktree',
      );

      // A single-repo New worktree target exposes an explicit base selector.
      // It defaults to the repository's known default branch and mirrors the
      // source picker without offering Issues or a nested New worktree row.
      const baseBranchPicker = homePage.getByTestId('home-base-branch-picker');
      await expect(baseBranchPicker).toBeVisible();
      await expect(
        homePage.getByTestId('home-base-branch-picker-button'),
      ).toContainText('main');
      await expect(
        homePage.getByTestId('home-base-branch-picker-selected-icon-branch'),
      ).toBeVisible();
      // The base picker sits directly in the selector overhang now — no
      // chevron separator between it and the branch picker.
      await expect(
        homePage.getByTestId('home-base-branch-separator'),
      ).toHaveCount(0);

      await homePage.getByTestId('home-base-branch-picker-button').click();
      const baseBranchMenu = window.getByTestId('home-base-branch-picker-menu');
      await expect(baseBranchMenu).toBeVisible();
      await expect(baseBranchMenu.getByRole('tab')).toHaveText([
        'Worktrees',
        'PRs',
        'Branches',
      ]);
      await expect(
        baseBranchMenu.getByTestId('home-base-branch-picker-tab-issues'),
      ).toHaveCount(0);
      await expect(
        baseBranchMenu.getByTestId('home-base-branch-picker-new-worktree'),
      ).toHaveCount(0);

      await baseBranchMenu
        .getByTestId('home-base-branch-picker-branch-demo-main')
        .click();
      await expect(baseBranchMenu).toBeHidden();
      await expect(
        homePage.getByTestId('home-base-branch-picker-button'),
      ).toContainText('demo-main');
      await expect(
        window.getByTestId('home-base-branch-picker-tooltip'),
      ).toBeHidden();

      await homePage.getByTestId('home-base-branch-picker-button').hover();
      await expect(
        window.getByTestId('home-base-branch-picker-tooltip'),
      ).toContainText(/base branch/i);

      // The inverse tone keeps the reversed sheet in light mode and uses the
      // regular tooltip surface in dark mode rather than a white sheet.
      const wasDark = await window.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      );
      for (const dark of [false, true]) {
        await window.evaluate(
          (isDark) => document.documentElement.classList.toggle('dark', isDark),
          dark,
        );
        const colors = await window
          .getByTestId('home-base-branch-picker-tooltip')
          .evaluate((tip) => {
            const probe = document.createElement('div');
            document.body.append(probe);
            const resolve = (value) => {
              probe.style.backgroundColor = value;
              return getComputedStyle(probe).backgroundColor;
            };
            const resolved = {
              surface: getComputedStyle(tip).backgroundColor,
              ink: getComputedStyle(tip).color,
              inverse: resolve('var(--bg-inverse)'),
              base: resolve('var(--bg-base)'),
              quaternary: resolve('var(--bg-quaternary)'),
              primary: resolve('var(--fg-primary)'),
            };
            probe.remove();
            return resolved;
          });
        expect(colors.surface).toBe(dark ? colors.quaternary : colors.inverse);
        expect(colors.ink).toBe(dark ? colors.primary : colors.base);
      }
      await window.evaluate(
        (isDark) => document.documentElement.classList.toggle('dark', isDark),
        wasDark,
      );

      // The model, effort and permission sit in the box's row; Plan mode,
      // Pipeline and the secondary chat actions live in the shared plus menu.
      const plusButton = homePage.getByTestId('home-composer-plus-button');
      await expect(plusButton).toBeVisible();
      const toolbar = homePage.getByTestId('home-composer-toolbar');
      await expect(toolbar.getByTestId('chat-model-picker')).toBeVisible();
      await expect(toolbar.getByTestId('approval-mode-picker')).toBeVisible();

      // The working-directory picker is a multi-repo-only affordance — a
      // single-repo workspace must not render it.
      await expect(homePage.getByTestId('home-directory-picker')).toHaveCount(
        0,
      );

      // Opening the plus menu shows attachment and the chat-only secondary
      // actions. CAN-2709: connecting Linear lives in Account settings, so
      // the ticket picker appears only once a connection exists — this
      // fixture has none.
      await plusButton.click();
      const plusMenu = window.getByTestId('home-composer-plus-menu');
      await expect(plusMenu).toBeVisible();
      await expect(
        plusMenu.getByTestId('home-composer-plus-attachment'),
      ).toBeVisible();
      await expect(
        plusMenu.getByTestId('home-composer-plus-linear'),
      ).toHaveCount(0);
      await expect(plusMenu.getByTestId('home-plugins-button')).toBeVisible();
      await expect(plusMenu.getByTestId('home-plan-mode-button')).toBeVisible();
      const pipelineRow = plusMenu.getByTestId('home-pipeline-mode-button');
      await expect(pipelineRow).toHaveAttribute('aria-pressed', 'false');
      await expect(pipelineRow).toContainText('predefined automated steps');
      await expect(plusMenu.getByRole('textbox')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the permission level is named without a glyph', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      // The box row names the permission level (Ask / Accept edits /
      // Full access) with no glyph and no chevron, as the chat composer does.
      const trigger = homePage
        .getByTestId('home-composer-toolbar')
        .getByTestId('approval-mode-picker');
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveText(/^(Ask|Accept edits|Full access)$/);
      // The glyph stays mounted for automation but is folded away.
      await expect(
        trigger.locator(
          '[data-fold-open]:has([data-testid="approval-mode-icon"])',
        ),
      ).toHaveAttribute('data-fold-open', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('branch picker typeahead restores the selected row when reopened', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      const trigger = homePage.getByTestId('home-branch-picker-button');
      await trigger.click();
      const search = window.getByTestId('home-branch-picker-search');
      await search.fill('demo');
      await search.press('ArrowDown');
      await search.press('Enter');
      await expect(trigger).toContainText('demo-main');

      await trigger.click();
      await window
        .getByTestId('home-branch-picker-search')
        .fill('nothing-matches');
      await window.getByTestId('home-branch-picker-search').press('Escape');
      await trigger.click();

      await expect(window.getByTestId('home-branch-picker-search')).toHaveValue(
        '',
      );
      await expect(
        window.getByTestId('home-branch-picker-worktree-demo-main'),
      ).toHaveAttribute('data-active', 'true');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('project picker supports typeahead and keyboard navigation', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['go-cli', 'ts-npm-nest-monorepo'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      const trigger = homePage.getByTestId('home-workspace-select');
      await trigger.click();
      const search = window.getByTestId('home-workspace-search');
      await search.fill('nest');
      const nestOption = window.getByTestId(
        'home-workspace-option-demo-ts-npm-nest-monorepo',
      );
      await expect(nestOption).toBeVisible();
      await expect(
        window.getByTestId('home-workspace-option-demo-go-cli'),
      ).toHaveCount(0);

      await search.press('ArrowUp');
      await expect(nestOption).toHaveAttribute('data-active', 'true');
      await search.press('ArrowDown');
      await expect(nestOption).toHaveAttribute('data-active', 'true');
      await search.press('Enter');
      await expect(trigger).toContainText('TypeScript npm Nest Monorepo');

      await trigger.click();
      await window.getByTestId('home-workspace-search').fill('nothing-matches');
      await expect(window.getByTestId('home-workspace-empty')).toBeVisible();
      await window.getByTestId('home-workspace-search').press('Escape');
      await expect(window.getByTestId('home-workspace-search')).toHaveCount(0);
      // The shared workspace combobox follows the standard dismissal
      // contract and restores focus to its trigger.
      await expect(trigger).toBeFocused();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-repo project: working-directory picker renders left of Plugins and scopes to a child repo', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-home-wd-'));
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'home-wd-fixture-'));
    const workspaceId = 'home-wd-test';

    const git = (cwd, args) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });
    const initRepo = (repoPath, fileName) => {
      mkdirSync(repoPath, { recursive: true });
      git(repoPath, ['init']);
      git(repoPath, ['config', 'user.email', 'test@example.com']);
      git(repoPath, ['config', 'user.name', 'Canopy Test']);
      writeFileSync(path.join(repoPath, fileName), 'seed\n', 'utf8');
      git(repoPath, ['add', fileName]);
      git(repoPath, ['commit', '-m', 'initial']);
    };

    const sourceRepoPath = path.join(fixtureDir, 'source');
    const webRepoPath = path.join(fixtureDir, 'web');
    const apiRepoPath = path.join(fixtureDir, 'api');
    initRepo(sourceRepoPath, 'README.md');
    initRepo(webRepoPath, 'web.md');
    initRepo(apiRepoPath, 'api.md');

    const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: workspaceId,
          name: 'Home WD Test',
          type: 'multi-repo',
          color: '#38bdf8',
          collapsed: false,
          order: 0,
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'web', name: 'Web Repo', repoPath: webRepoPath },
        { id: 'api', name: 'Api Repo', repoPath: apiRepoPath },
      ],
      sourceRepoPath,
      alwaysShow: true,
    });
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      // The picker defaults to the workspace root in the composer context row.
      const picker = homePage.getByTestId('home-directory-picker');
      await expect(picker).toBeVisible();
      await expect(picker).toContainText('Project root');
      await expect(homePage.getByTestId('home-base-branch-picker')).toHaveCount(
        0,
      );
      // Open the menu (portaled listbox) and scope the draft to a child repo.
      await picker.getByRole('button').click();
      const menu = window.getByRole('listbox', {
        name: 'Working directory options',
      });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('option')).toHaveText([
        'Project root',
        'Web Repo',
        'Api Repo',
      ]);
      await menu.getByRole('option', { name: 'Web Repo' }).click();
      await expect(picker).toContainText('Web Repo');

      // The selection round-trips: reopening marks the child repo selected.
      await picker.getByRole('button').click();
      await expect(
        window
          .getByRole('listbox', { name: 'Working directory options' })
          .getByRole('option', { name: 'Web Repo' }),
      ).toHaveAttribute('aria-selected', 'true');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('Pipeline mode hides chat controls, keeps the branch picker active, and Send opens the task_ready picker', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );
      const pipelineMenu = await openHomeComposerPlusMenu(window, homePage);
      await expect(
        pipelineMenu.getByTestId('home-pipeline-mode-button'),
      ).toHaveAttribute('aria-pressed', 'true');
      await window.keyboard.press('Escape');

      // The chat-only controls cluster fully unmounts in pipeline mode (it is
      // not merely disabled) — `HomeComposerControls` only renders
      // `HomeComposerLeftCluster` / voice input while `isChatMode`. The `+`
      // attach/Linear menu is mode-independent (Task D3) and stays mounted so
      // a pipeline-mode draft can still stage attachments/Linear tickets into
      // its synthesized task text.
      await expect(
        homePage.getByTestId('home-composer-plus-button'),
      ).toBeVisible();
      await expect(homePage.getByTestId('chat-model-picker')).toHaveCount(0);

      // Task C4 lifted the Plan-B pipeline-mode lock: the branch picker
      // stays fully interactive in pipeline mode (pipeline runs honor the
      // selected branch target instead of always provisioning a new
      // worktree).
      await expect(
        homePage.getByTestId('home-branch-picker-locked'),
      ).toHaveCount(0);
      const branchPickerButton = homePage.getByTestId(
        'home-branch-picker-button',
      );
      await expect(branchPickerButton).toBeVisible();
      await expect(branchPickerButton).toBeEnabled();
      await expect(branchPickerButton).toContainText('New worktree');

      await homePage
        .getByTestId('home-composer-editor')
        .fill('Add a billing metrics panel to the dashboard.');
      await homePage.getByTestId('home-send-button').click();

      // Pipeline-mode send opens the `task_ready` pipeline picker
      // (`TaskReadyPipelineModal` wraps `PipelineTriggerModal`) instead of
      // sending immediately.
      await expect(window.getByTestId('pipeline-trigger-modal')).toBeVisible();
      await expect(
        window.getByRole('heading', { name: 'Run task pipeline' }),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const workspaceKind of ['code', 'cowork']) {
    for (const draftText of ['', '   ']) {
      test(`blank Chat submission creates an empty ${workspaceKind} work area (${JSON.stringify(draftText)})`, async () => {
        test.setTimeout(120_000);
        const userDataDir = mkdtempSync(
          path.join(os.tmpdir(), 'canopy-home-empty-'),
        );
        seedDemoWorkspaces({
          userDataDir,
          apps: [DEMO_APP_ID],
          createWorktrees: false,
        });
        if (workspaceKind === 'code') seedHomeChatLayout(userDataDir);
        const { electronApp } = await launchCanopy({ userDataDir });
        try {
          const window = await electronApp.firstWindow();
          const app = new CanopyAppDriver(window);
          await app.waitForShell({ timeout: 30_000 });
          if (workspaceKind === 'code')
            await delayHomeChatHydration(electronApp);
          await electronApp.evaluate(({ ipcMain }) => {
            globalThis.__blankHomeSendCount = 0;
            ipcMain.removeHandler('chat:send-message');
            ipcMain.handle('chat:send-message', () => {
              globalThis.__blankHomeSendCount += 1;
              throw new Error('Blank Home submission must not send a message');
            });
          });
          await window.getByTestId('sidebar-create-task').click();
          const homePage = window.getByTestId('page-home');
          await waitForHomeWorkspaceSelection(homePage);
          if (workspaceKind === 'cowork') {
            // Clearing the project is how a draft targets the catch-all.
            await homePage.getByTestId('home-workspace-clear').click();
            // The catch-all is a real project underneath, but the trigger
            // declines to name it and the list never offers it as a row, so
            // it cannot read as a project the chat was filed into.
            await expect(
              homePage.getByTestId('home-workspace-select'),
            ).toContainText('Choose project');
            await expect(
              homePage.getByTestId('home-workspace-clear'),
            ).toHaveCount(0);
            await homePage.getByTestId('home-workspace-select').click();
            await expect(
              window.getByTestId('home-workspace-option-cowork-default'),
            ).toHaveCount(0);
            await window.keyboard.press('Escape');
          }
          await homePage.getByTestId('home-composer-editor').fill(draftText);
          if (draftText) {
            await homePage
              .getByTestId('home-composer-editor')
              .evaluate((el) => {
                const clipboardData = new DataTransfer();
                clipboardData.items.add(
                  new File(['draft context'], 'draft-context.txt', {
                    type: 'text/plain',
                  }),
                );
                el.dispatchEvent(
                  new ClipboardEvent('paste', {
                    clipboardData,
                    bubbles: true,
                    cancelable: true,
                  }),
                );
              });
            await expect(
              homePage.locator('[title="draft-context.txt"]'),
            ).toBeVisible();
          }
          const send = homePage.getByTestId('home-send-button');
          await clickHomeComposerAction(
            window,
            homePage,
            'home-pipeline-mode-button',
          );
          if (draftText) await expect(send).toBeEnabled();
          else await expect(send).toBeDisabled();
          await clickHomeComposerAction(
            window,
            homePage,
            'home-pipeline-mode-button',
          );
          await expect(send).toBeEnabled();
          await send.click();
          await expect(homePage).toHaveCount(0);
          const draftPanel = window.locator(
            '[data-testid="panel-content-chat"]:visible',
          );
          await expect(draftPanel).toBeVisible();
          if (draftText) {
            await expect(
              draftPanel.locator('[title="draft-context.txt"]'),
            ).toBeVisible();
          }
          if (workspaceKind === 'code') {
            await expect(window.getByTestId('worktree-row')).toHaveCount(1);
            await expect
              .poll(() =>
                electronApp.evaluate(
                  () => globalThis.__homeChatHydrationFinished,
                ),
              )
              .toBe(true);
          }
          const projectId =
            workspaceKind === 'code' ? WORKSPACE_ID : 'cowork-default';
          await expect
            .poll(async () => {
              const indexPath = path.join(
                userDataDir,
                'workspaces',
                projectId,
                workspaceKind === 'code'
                  ? 'worktrees.json'
                  : 'work-entries.json',
              );
              const index = JSON.parse(readFileSync(indexPath, 'utf8'));
              const entries =
                workspaceKind === 'code' ? index.worktrees : index.entries;
              if (entries.length !== 1) return null;
              const persisted = await window.evaluate(
                (target) => window.api.chat.loadTabs(target),
                { projectId, worktreeId: entries[0].id },
              );
              // The submission takes over the entry's pristine starter chat
              // instead of opening beside it (CAN-4557).
              return {
                activeEmpty: persisted.tabs.some(
                  (tab) =>
                    tab.id === persisted.activeTabId &&
                    tab.messages.length === 0,
                ),
                allEmpty: persisted.tabs.every(
                  (tab) => tab.messages.length === 0,
                ),
                tabCount: persisted.tabs.length,
              };
            })
            .toEqual({ activeEmpty: true, allEmpty: true, tabCount: 1 });
          if (workspaceKind === 'code') {
            await expect(
              window
                .getByTestId('panel-group-group-chat')
                .getByTestId('panel-content-chat'),
            ).toBeVisible();
            await expect(
              window
                .getByTestId('panel-group-group-changed-files')
                .getByTestId('panel-content-chat'),
            ).toHaveCount(0);
          }
          expect(
            await electronApp.evaluate(() => globalThis.__blankHomeSendCount),
          ).toBe(0);
        } finally {
          await closeCanopy(electronApp, userDataDir);
        }
      });
    }
  }

  for (const destination of ['code', 'existing', 'cowork']) {
    for (const selectedSpeed of ['fast', 'ultrafast']) {
      test(`initial draft settings survive the ${destination} handoff (${selectedSpeed})`, async () => {
        test.setTimeout(120_000);
        const userDataDir = mkdtempSync(
          path.join(os.tmpdir(), 'home-settings-'),
        );
        const scenarioKey = `home-speed-${destination}-${selectedSpeed}`;
        await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
          codexAccountModels: [
            {
              id: 'gpt-6-astra',
              model: 'gpt-6-astra',
              serviceTiers: [
                {
                  id: 'priority',
                  name: 'Fast',
                  description: 'Faster inference',
                },
                {
                  id: 'ultrafast',
                  name: 'Ultra fast',
                  description: 'Highest speed',
                },
              ],
            },
          ],
        });
        seedDemoWorkspaces({
          userDataDir,
          apps: [DEMO_APP_ID],
          createWorktrees: destination === 'existing',
        });
        const { electronApp } = await launchCanopy({
          userDataDir,
          env: { CANOPY_MOCK_API_KEY: scenarioKey },
        });
        try {
          const window = await electronApp.firstWindow();
          await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
          await window.getByTestId('sidebar-create-task').click();
          const home = window.getByTestId('page-home');
          await waitForHomeWorkspaceSelection(home);
          await home.getByTestId('chat-model-picker').click();
          await selectModelOption(window, 'gpt-6-astra');
          await clickHomeComposerAction(window, home, 'home-plan-mode-button');
          // Speed rides in the effort panel's bolt: Regular → Fast → Ultra
          // fast (purple) where the model offers it.
          const thinking = home.getByTestId('home-thinking-level-button');
          const slider = await openEffortSlider(
            window,
            thinking,
            'home-thinking-level-button',
          );
          const bolt = window.getByTestId(
            'home-thinking-level-button-fast-mode',
          );
          await bolt.click();
          await expect(bolt).toHaveAttribute('data-speed', 'fast');
          if (selectedSpeed === 'ultrafast') {
            // Ultra fast joins the cycle once its availability is confirmed.
            await expect(async () => {
              if ((await bolt.getAttribute('data-speed')) !== 'ultrafast') {
                await bolt.click();
              }
              await expect(bolt).toHaveAttribute('data-speed', 'ultrafast', {
                timeout: 1_000,
              });
            }).toPass({ timeout: 15_000 });
          }
          const speedLabel =
            selectedSpeed === 'ultrafast' ? 'ultra fast mode' : 'fast mode';
          await stepEffortAway(slider);
          await closeEffortPanel(window);
          const level = await thinking.getAttribute('data-thinking-level');
          if (destination === 'cowork') {
            // Clearing the project is how a draft targets the catch-all.
            await home.getByTestId('home-workspace-clear').click();
          } else if (destination === 'existing') {
            await home.getByTestId('home-branch-picker-button').click();
            await window
              .getByTestId('home-branch-picker-worktree-demo-main')
              .click();
          }
          // The draft indicator follows Plan even for the cowork catch-all.
          // The persisted cowork expectation below still omits Plan on send.
          await expect(
            home.getByTestId('home-plan-mode-inline-button'),
          ).toBeVisible();
          await home.getByTestId('home-send-button').click();
          await expect(home).toHaveCount(0);
          const panel = window.getByTestId('panel-content-chat');
          await expect(panel.getByTestId('chat-model-picker')).toContainText(
            'GPT 6 Astra',
          );
          const chatEffort = panel.getByTestId(CHAT_EFFORT_TRIGGER_TEST_ID);
          await expect(chatEffort).toHaveAttribute(
            'data-thinking-level',
            level,
          );
          await expect(chatEffort).toHaveAttribute(
            'aria-label',
            new RegExp(`, ${speedLabel} on$`),
          );
          const projectId =
            destination === 'cowork' ? 'cowork-default' : WORKSPACE_ID;
          await expect
            .poll(async () => {
              const index = JSON.parse(
                readFileSync(
                  path.join(
                    userDataDir,
                    'workspaces',
                    projectId,
                    destination === 'cowork'
                      ? 'work-entries.json'
                      : 'worktrees.json',
                  ),
                  'utf8',
                ),
              );
              const worktreeId =
                destination === 'existing'
                  ? 'demo-main'
                  : (index.entries ?? index.worktrees)[0].id;
              const persisted = await window.evaluate(
                (target) => window.api.chat.loadTabs(target),
                { projectId, worktreeId },
              );
              const tab = persisted.tabs.find(
                (tab) => tab.id === persisted.activeTabId,
              );
              return {
                model: tab?.model,
                speed: tab?.modelConfig?.speed,
                fastMode: tab?.modelConfig?.fastMode,
                planMode: tab?.planMode ?? false,
                thinkingLevel:
                  tab?.modelConfig?.thinkingLevel ??
                  tab?.thinkingLevel ??
                  'high',
                messageCount: tab?.messages.length,
              };
            })
            .toEqual({
              model: 'gpt-6-astra',
              speed: selectedSpeed,
              fastMode: selectedSpeed === 'fast',
              planMode: destination !== 'cowork',
              thinkingLevel: level,
              messageCount: 0,
            });
        } finally {
          await closeCanopy(electronApp, userDataDir);
        }
      });
    }
  }

  test('Chat mode send creates a worktree, navigates to Code, and the message reaches the transcript', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-send-'),
    );
    // No pre-existing worktree so the post-send worktree-row count
    // unambiguously proves the Home send created one (mirrors
    // workspace-create-auto-worktree.spec.mjs's assertion style).
    seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      // Keep the approval lookup in flight long enough for a premature Code
      // navigation to become a user-visible empty frame. The fixed flow keeps
      // Home mounted until the starter tab has consumed this result.
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('approval:resolved-default');
        ipcMain.handle('approval:resolved-default', async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return 'ask';
        });
      });

      const taskText = 'Investigate the failing health-check endpoint.';
      await window.evaluate(() => {
        window.__homeSendNoChatSeen = false;
        window.__homeSendTransitionChecked = false;
        let transitionCheckScheduled = false;
        let homeWasMounted = Boolean(
          document.querySelector('[data-testid="page-home"]'),
        );
        new MutationObserver(() => {
          const homeIsMounted = Boolean(
            document.querySelector('[data-testid="page-home"]'),
          );
          if (homeWasMounted && !homeIsMounted && !transitionCheckScheduled) {
            transitionCheckScheduled = true;
            setTimeout(() => {
              const chatPanelIsMounted = document.querySelector(
                '[data-testid="panel-content-chat"]',
              );
              if (!chatPanelIsMounted) window.__homeSendNoChatSeen = true;
              window.__homeSendTransitionChecked = true;
            }, 100);
          }
          homeWasMounted = homeIsMounted;
        }).observe(document.body, { childList: true, subtree: true });
      });
      await homePage.getByTestId('home-composer-editor').click();
      await homePage.getByTestId('home-composer-editor').fill(taskText);
      await homePage.getByTestId('home-send-button').click();

      // Task I1: `dispatchHomeSend`'s new-worktree route does ONE transition —
      // the (now reservation-only, sub-second) create resolves, the created
      // worktree is selected, then it navigates to Code. The Home page unmounts.
      await expect(homePage).toHaveCount(0);

      // The first (and only) new Code-page surface is the real chat panel —
      // there is no special pending page anymore. It is NEVER the embedded
      // no-selection HomeSurface (the "looks broken" regression of earlier
      // rounds).
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('home-surface')).toHaveCount(0);
      await window.waitForFunction(
        () => window.__homeSendTransitionChecked === true,
      );
      expect(await window.evaluate(() => window.__homeSendNoChatSeen)).toBe(
        false,
      );

      const rows = window.getByTestId('worktree-row');
      await expect(rows).toHaveCount(1, { timeout: 60_000 });

      // The user's message shows in the transcript (queued beneath the
      // `pending_setup_info` block while git-pending, or processed once ready).
      await expect(panel.getByText(taskText).first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const registrationSetupPhase of ['git-pending', 'git-ready']) {
    test(`Chat mode send keeps Home mounted until the ${registrationSetupPhase} worktree panel layout is ready`, async () => {
      test.setTimeout(120_000);

      const userDataDir = mkdtempSync(
        path.join(
          os.tmpdir(),
          `canopy-home-surface-layout-barrier-${registrationSetupPhase}-`,
        ),
      );
      seedDemoWorkspaces({
        userDataDir,
        apps: [DEMO_APP_ID],
        createWorktrees: false,
      });

      const { electronApp } = await launchCanopy({ userDataDir });

      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });

        await electronApp.evaluate(({ ipcMain }, setupPhase) => {
          if (setupPhase === 'git-ready') {
            const originalCreateHandler =
              ipcMain._invokeHandlers?.get('worktree:create');
            if (!originalCreateHandler) {
              throw new Error('worktree:create handler is unavailable');
            }
            ipcMain.removeHandler('worktree:create');
            ipcMain.handle('worktree:create', async (event, request) => {
              const response = await originalCreateHandler(event, request);
              return { ...response, setupPhase: 'git-ready' };
            });
          }

          globalThis.__homePanelLayoutLoadRequested = false;
          globalThis.__resolveHomePanelLayoutLoad = undefined;
          ipcMain.removeHandler('panel-layout:load');
          ipcMain.handle('panel-layout:load', () => {
            globalThis.__homePanelLayoutLoadRequested = true;
            return new Promise((resolve) => {
              globalThis.__resolveHomePanelLayoutLoad = () => {
                resolve({ layout: null });
              };
            });
          });
        }, registrationSetupPhase);

        await window.getByTestId('sidebar-create-task').click();
        const homePage = window.getByTestId('page-home');
        await expect(homePage).toBeVisible();
        await homePage
          .getByTestId('home-composer-editor')
          .fill('Investigate the failing health-check endpoint.');
        await homePage.getByTestId('home-send-button').click();

        await expect
          .poll(() =>
            electronApp.evaluate(
              () => globalThis.__homePanelLayoutLoadRequested === true,
            ),
          )
          .toBe(true);

        await expect(homePage).toBeVisible();
        await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);

        await electronApp.evaluate(() => {
          globalThis.__resolveHomePanelLayoutLoad?.();
        });

        await expect(homePage).toHaveCount(0);
        await expect(window.getByTestId('panel-content-chat')).toBeVisible({
          timeout: 30_000,
        });
      } finally {
        await electronApp.evaluate(() => {
          globalThis.__resolveHomePanelLayoutLoad?.();
        });
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('Task G1: Shift+Enter inserts a newline (no send), Enter sends and restores the queued-worktree UX', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-enter-send-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      const editor = homePage.getByTestId('home-composer-editor');
      const firstLine = 'Investigate the flaky login test.';
      const secondLine = 'Also check the retry backoff.';
      await editor.click();
      await editor.fill(firstLine);
      await window.keyboard.press('Shift+Enter');
      await window.keyboard.type(secondLine);

      // Shift+Enter must insert a newline rather than sending — the composer
      // (and Home page) stay mounted with both lines present.
      await expect(homePage).toBeVisible();
      await expect(editor).toContainText(firstLine);
      await expect(editor).toContainText(secondLine);

      // Plain Enter routes through the same send path as the Send button.
      // Fix round 2 ordering: the route now awaits createWorktree AND
      // selects the created worktree BEFORE navigating, so the user stays on
      // Home until the chat panel can render directly — Home unmounting is
      // itself the signal that the worktree exists and is selected.
      await window.keyboard.press('Enter');
      await expect(homePage).toHaveCount(0);

      // Restored queued-worktree UX: because selection precedes navigation,
      // the first Code-page state is the NEW worktree's chat panel — never
      // the embedded no-selection HomeSurface (this workspace was seeded
      // with zero worktrees and nothing selected, so any `home-surface`
      // appearing here would be that regression) and never a stale worktree.
      // These first-settle assertions pass without waiting through any
      // intermediate flash.
      await expect(window.getByTestId('home-surface')).toHaveCount(0);
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // The message reaches the transcript. Task H3 fix 3 made the
      // queue-for-setup decision LIVE (re-read immediately before dispatch)
      // instead of a post-create snapshot: when this tiny fixture's git setup
      // completes during the post-create awaits, the message correctly
      // processes immediately and no `pending_setup_info` banner exists; when
      // setup is still pending at dispatch, the banner is a persisted
      // transcript entry that survives the setup-complete flush. Both
      // terminal states are correct by design, so the banner is no longer
      // asserted unconditionally here — both live-decision branches are
      // pinned at the unit level (homeSend.test.ts) and the queued-path UI is
      // covered by the H3 exact-repro spec below whenever the harness catches
      // the pending phase.
      await expect(panel.getByText(firstLine).first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task I1: exact repro — a stale selection in project A is never visible while sending to project B (single transition, message lands in B)', async () => {
    test.setTimeout(120_000);

    // The user's exact repro trace: their PREVIOUS selection was a worktree in
    // a DIFFERENT workspace (A) than the one the Home composer targets (B).
    // Task I1 does one transition — deselect up front, create, select B, then
    // navigate — so A's chat is never rendered and B's real chat is the first
    // and only new Code surface.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-stale-sel-'),
    );
    // Workspace A: seeded WITH its demo-main worktree (the stale selection).
    seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: true,
    });
    // Workspace B: seeded WITHOUT worktrees, so the post-send row count and
    // chat panel unambiguously belong to the worktree this send creates. The
    // seeder preserves non-conflicting existing entries, so A survives.
    seedDemoWorkspaces({
      userDataDir,
      apps: ['go-cli'],
      createWorktrees: false,
    });
    // A distinctive transcript marker in A's chat: "A's chat is visible" ⇔
    // this text is in the DOM, which is what the repro assertions poll for.
    const staleChatMarker = 'STALE-A-CHAT-MARKER unify the flux capacitors';
    seedWorktreeChat({
      userDataDir,
      workspaceId: `demo-${DEMO_APP_ID}`,
      worktreeId: 'demo-main',
      providerType: 'claude',
      tabs: [
        {
          id: 't1',
          title: 'Chat',
          blocks: [{ type: 'text', text: staleChatMarker }],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Step 1: select A's worktree — its chat (with the marker) is visible.
      await app.selectWorktree('demo-main');
      const chatPanel = window.getByTestId('panel-content-chat');
      await expect(chatPanel).toBeVisible({ timeout: 15_000 });
      await expect(chatPanel.getByText(staleChatMarker).first()).toBeVisible({
        timeout: 15_000,
      });

      // Step 2: navigate Home and compose to workspace B + New worktree + chat.
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await homePage.getByTestId('home-workspace-select').click();
      await window.getByTestId('home-workspace-option-demo-go-cli').click();
      await expect(homePage.getByTestId('home-workspace-select')).toContainText(
        'Go CLI',
      );
      await expect(homePage.getByTestId('home-branch-picker')).toContainText(
        'New worktree',
      );

      const taskText = 'Add a --version flag to the CLI.';
      await homePage.getByTestId('home-composer-editor').click();
      await homePage.getByTestId('home-composer-editor').fill(taskText);

      // Step 3: Send. Task I1 does ONE transition: the route clears the stale
      // selection up front, creates the (reservation-only, fast) worktree,
      // selects it, and only then navigates — so the FIRST Code frame is
      // workspace B's brand-new chat, never project A's stale chat.
      await homePage.getByTestId('home-send-button').click();
      await expect(homePage).toHaveCount(0);

      // The first (and only) new Code surface is B's real chat panel carrying
      // the typed message — never workspace A's chat (the stale-selection
      // regression this repro guards) and never the embedded HomeSurface empty
      // state. A's distinctive marker must NEVER be in the DOM at any point.
      await expect(chatPanel).toBeVisible({ timeout: 15_000 });
      await expect(chatPanel.getByText(taskText).first()).toBeVisible({
        timeout: 30_000,
      });
      expect(await window.getByText(staleChatMarker).count()).toBe(0);
      expect(await window.getByTestId('home-surface').count()).toBe(0);

      // Step 4: final state — B's NEW worktree row appears (B was seeded with
      // zero worktrees, so its row proves the send created it; A's demo-main
      // row makes 2 total), and A's stale marker still never reappears.
      await expect(window.getByTestId('worktree-row')).toHaveCount(2, {
        timeout: 60_000,
      });
      expect(await window.getByText(staleChatMarker).count()).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task H1: Add project modal overlays the current page (Home stays visible)', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      // Open the composer workspace picker and trigger its "New project"
      // row.
      await homePage.getByTestId('home-workspace-select').click();
      await window.getByTestId('home-workspace-add').click();

      // The Add Workspace modal is now hosted at App level, so it opens ON TOP
      // of Home rather than yanking the user to the Code page first (the old
      // `openAddWorkspaceModal` forced `activePage: 'main'`). The modal is
      // visible AND Home stays mounted/visible underneath it.
      await expect(
        window.getByTestId('add-workspace-mode-existing'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(homePage).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task G1: plus menu groups composer actions in a stable order', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      const plusButton = homePage.getByTestId('home-composer-plus-button');
      await expect(plusButton).toBeVisible();
      const plusClassTokens = await plusButton.evaluate((button) => [
        ...button.classList,
      ]);
      // The chat composer's + recipe: a flat subtle fill with an inset
      // hairline, stepping up to muted on hover (no raised variant).
      expect(plusClassTokens).toContain('bg-subtle');
      expect(plusClassTokens).toContain('enabled:hover:bg-muted');
      expect(plusClassTokens).toContain('ring-inset');
      expect(plusClassTokens).not.toContain('shadow-sm');
      const plusBackgrounds = await plusButton.evaluate((button) => {
        const probe = document.createElement('div');
        probe.style.position = 'fixed';
        probe.style.pointerEvents = 'none';
        probe.style.backgroundColor = 'var(--bg-subtle)';
        document.body.append(probe);
        const subtle = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = 'var(--bg-muted)';
        const muted = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          current: getComputedStyle(button).backgroundColor,
          subtle,
          muted,
        };
      });
      expect(plusBackgrounds.current).toBe(plusBackgrounds.subtle);
      await plusButton.hover();
      await expect
        .poll(() =>
          plusButton.evaluate(
            (button) => getComputedStyle(button).backgroundColor,
          ),
        )
        .toBe(plusBackgrounds.muted);
      // Plan mode and Pipeline sit in + at every width, after the add rows.
      const menu = await openHomeComposerPlusMenu(window, homePage);
      const orderedIds = await menu
        .locator('[data-action-row]')
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-testid')),
        );
      expect(orderedIds).toEqual(
        expect.arrayContaining([
          'home-composer-plus-attachment',
          'home-plugins-button',
          'home-schedule-button',
          'home-plan-mode-button',
          'home-pipeline-mode-button',
        ]),
      );
      const planRow = menu.getByTestId('home-plan-mode-button');
      await expect(planRow).toHaveAttribute('aria-pressed', 'false');
      await planRow.click();
      // An active Plan mode shows its tile beside +, as in a chat; + itself
      // only lights for Pipeline.
      await expect(
        homePage.getByTestId('home-plan-mode-inline-button'),
      ).toBeVisible();
      await expect(plusButton).not.toHaveAttribute('data-active', 'true');
      const reopened = await openHomeComposerPlusMenu(window, homePage);
      await expect(
        reopened.getByTestId('home-plan-mode-button'),
      ).toHaveAttribute('aria-pressed', 'true');
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('CAN-3792: Plan mode shows its tile beside + before the first send', async () => {
    test.setTimeout(90_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      const plusButton = homePage.getByTestId('home-composer-plus-button');
      const tile = homePage.getByTestId('home-plan-mode-inline-button');
      const editor = homePage.getByTestId('home-composer-editor');
      const send = homePage.getByTestId('home-send-button');
      const expectPlanRow = async (pressed) => {
        const menu = await openHomeComposerPlusMenu(window, homePage);
        await expect(menu.getByTestId('home-plan-mode-button')).toHaveAttribute(
          'aria-pressed',
          String(pressed),
        );
        await window.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      };

      // No tile until Plan is on.
      await expect(tile).toHaveCount(0);

      // Enabling from + shows the active tile at once, beside +.
      await clickHomeComposerAction(window, homePage, 'home-plan-mode-button');
      await expect(tile).toBeVisible();
      await expect(tile).toHaveAttribute('aria-pressed', 'true');
      await expect(tile).toHaveAttribute('aria-label', 'Disable plan mode');
      await expect(tile).toContainText('Plan');
      await expect(tile.locator('[data-plan-remove]')).toHaveCount(1);
      await expect(plusButton).not.toHaveAttribute('data-active', 'true');
      await expectPlanRow(true);

      // Same row as + and send, after +, with no overlap.
      const expectAligned = async () => {
        await expect(plusButton).toBeVisible();
        await expect(tile).toBeVisible();
        await expect(send).toBeVisible();
        const [plusRect, tileRect, sendRect] = await Promise.all([
          plusButton.boundingBox(),
          tile.boundingBox(),
          send.boundingBox(),
        ]);
        const centerY = (rect) => rect.y + rect.height / 2;
        expect(Math.abs(centerY(tileRect) - centerY(plusRect))).toBeLessThan(2);
        expect(Math.abs(centerY(sendRect) - centerY(plusRect))).toBeLessThan(2);
        expect(tileRect.x).toBeGreaterThanOrEqual(plusRect.x + plusRect.width);
        expect(sendRect.x).toBeGreaterThanOrEqual(tileRect.x + tileRect.width);
        // Visibility alone allows partially clipped elements. Check viewport
        // containment and that each control still owns its actual hit target.
        for (const control of [plusButton, tile, send]) {
          expect(
            await control.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const hit = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              return (
                rect.left >= 0 &&
                rect.top >= 0 &&
                rect.right <= innerWidth &&
                rect.bottom <= innerHeight &&
                hit !== null &&
                element.contains(hit)
              );
            }),
          ).toBe(true);
        }
      };
      await expectAligned();

      // Pipeline lights + and hides the tile; back in a chat, Plan is still on.
      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );
      await expect(plusButton).toHaveAttribute('data-active', 'true');
      await expect(tile).toHaveCount(0);
      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );
      await expect(plusButton).not.toHaveAttribute('data-active', 'true');
      await expect(tile).toBeVisible();

      // A narrow window keeps +, the tile and send on one row; as in a chat,
      // a narrow box draws the tile as the glyph alone, still saying what a
      // click does, and the model picker keeps its place.
      const originalViewport = window.viewportSize();
      try {
        // 800×500 is the main window's supported minimum at 100% scale.
        for (const height of [700, 500]) {
          await window.setViewportSize({ width: 800, height });
          await expect(tile).toBeVisible();
          await expect(tile).not.toContainText('Plan');
          await expect(tile).toHaveAttribute('aria-label', 'Disable plan mode');
          await expect(homePage.getByTestId('chat-model-picker')).toBeVisible();
          await expectAligned();
        }
      } finally {
        if (originalViewport) await window.setViewportSize(originalViewport);
      }
      await expect(tile).toContainText('Plan');

      // Existing active drafts retain their tile across a real Home unmount.
      await app.openAutomationsPage();
      await expect(homePage).toHaveCount(0);
      await window.getByTestId('sidebar-create-task').click();
      await expect(homePage).toBeVisible();
      await expect(tile).toContainText('Plan');

      // Clicking the tile turns Plan off and returns focus to the editor.
      await tile.click();
      await expect(tile).toHaveCount(0);
      await expect(editor).toBeFocused();
      await expectPlanRow(false);

      // The keyboard dismisses it too.
      await clickHomeComposerAction(window, homePage, 'home-plan-mode-button');
      await expect(tile).toBeVisible();
      await tile.focus();
      await window.keyboard.press('Enter');
      await expect(tile).toHaveCount(0);
      await expect(editor).toBeFocused();

      // Turning Plan off from + removes the tile.
      await clickHomeComposerAction(window, homePage, 'home-plan-mode-button');
      await expect(tile).toBeVisible();
      await clickHomeComposerAction(window, homePage, 'home-plan-mode-button');
      await expect(tile).toHaveCount(0);
      await expectPlanRow(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task G1: project dropdown menu decouples from the trigger width and safely truncates long names', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['go-cli', 'ts-npm-nest-monorepo'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      // Select the SHORT-named workspace first so the trigger renders
      // narrow — this is what previously coupled the menu's width (the old
      // `absolute left-0 right-0` sizing matched the trigger's container).
      // Demo-seeded workspace ids are deterministically `demo-<app id>`.
      const trigger = homePage.getByTestId('home-workspace-select');
      await trigger.click();
      await window.getByTestId('home-workspace-option-demo-go-cli').click();
      await expect(trigger).toContainText('Go CLI');

      await trigger.click();
      const longOption = window.getByTestId(
        'home-workspace-option-demo-ts-npm-nest-monorepo',
      );
      await expect(longOption).toBeVisible();
      await expect(longOption).toContainText('TypeScript npm Nest Monorepo');

      const menu = window.getByTestId('home-workspace-popover');
      const [triggerBox, menuBox] = await Promise.all([
        trigger.boundingBox(),
        menu.boundingBox(),
      ]);
      expect(triggerBox).not.toBeNull();
      expect(menuBox).not.toBeNull();
      expect(menuBox.width).toBeGreaterThan(triggerBox.width);

      // The standardized shared picker has its own stable width and safely
      // ellipsizes names that exceed it instead of coupling to the trigger.
      // Target the shared PickerMenu's label span specifically: the option row
      // also carries a truncating layout wrapper, so a bare `span.truncate`
      // trips Playwright strict mode with two matches.
      const label = longOption.locator('span.canopy-picker-menu-option-label');
      await menu.evaluate((popover) => {
        popover.style.setProperty('width', '12rem', 'important');
        popover.style.setProperty('max-width', '12rem', 'important');
      });
      const { scrollWidth, clientWidth } = await label.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrollWidth).toBeGreaterThan(clientWidth);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task C3: schedule button hides in pipeline mode; staging/clearing a schedule toggles the pill', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      // Chat mode (the default): schedule is offered in the plus menu.
      let plusMenu = await openHomeComposerPlusMenu(window, homePage);
      await expect(plusMenu.getByTestId('home-schedule-button')).toBeVisible();
      await expect(
        homePage.getByTestId('home-scheduled-send-pill'),
      ).toHaveCount(0);

      // Pipeline mode omits the schedule affordance from the plus menu.
      await homePage.getByTestId('home-composer-plus-button').click();
      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );
      plusMenu = await openHomeComposerPlusMenu(window, homePage);
      await expect(plusMenu.getByTestId('home-schedule-button')).toHaveCount(0);

      // Toggle back to chat mode and stage a schedule.
      await homePage.getByTestId('home-composer-plus-button').click();
      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );
      await clickHomeComposerAction(window, homePage, 'home-schedule-button');

      const modal = window.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();

      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pad = (value) => String(value).padStart(2, '0');
      const dateValue = `${future.getUTCFullYear()}-${pad(
        future.getUTCMonth() + 1,
      )}-${pad(future.getUTCDate())}`;
      const timeValue = `${pad(future.getUTCHours())}:${pad(
        future.getUTCMinutes(),
      )}`;
      await window.getByTestId('schedule-message-date').fill(dateValue);
      await window.getByTestId('schedule-message-time').fill(timeValue);
      await window.getByTestId('schedule-message-save').click();

      await expect(modal).toBeHidden();
      const pill = homePage.getByTestId('home-scheduled-send-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toContainText(/Scheduled send\s+\S/);

      // The pill's X clears the staged schedule without touching Send.
      await homePage.getByTestId('home-scheduled-send-pill-clear').click();
      await expect(pill).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task C5: scheduled send to an existing worktree creates the tab now with the in-chat pill plus an Automations activity', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      // Target the existing seeded worktree instead of the New-worktree
      // default — "existing worktree" scheduled sends create the tab now
      // (queued+scheduled) rather than deferring provisioning.
      await homePage.getByTestId('home-branch-picker-button').click();
      await window.getByTestId('home-branch-picker-worktree-demo-main').click();
      await expect(
        homePage.getByTestId('home-branch-picker-button'),
      ).toContainText('demo-main');

      const taskText = 'Ship the scheduled release notes.';
      await homePage.getByTestId('home-composer-editor').click();
      await homePage.getByTestId('home-composer-editor').fill(taskText);

      await clickHomeComposerAction(window, homePage, 'home-schedule-button');
      const modal = window.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();

      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pad = (value) => String(value).padStart(2, '0');
      const dateValue = `${future.getUTCFullYear()}-${pad(
        future.getUTCMonth() + 1,
      )}-${pad(future.getUTCDate())}`;
      const timeValue = `${pad(future.getUTCHours())}:${pad(
        future.getUTCMinutes(),
      )}`;
      await window.getByTestId('schedule-message-date').fill(dateValue);
      await window.getByTestId('schedule-message-time').fill(timeValue);
      await window.getByTestId('schedule-message-save').click();
      await expect(modal).toBeHidden();
      await expect(
        homePage.getByTestId('home-scheduled-send-pill'),
      ).toBeVisible();

      await homePage.getByTestId('home-send-button').click();

      // The chat tab is created and navigated to immediately — only the
      // actual send is deferred to `runAt` via the backing automation.
      // `dispatchHomeSend` always creates a fresh tab for the "worktree"
      // branch target even when the worktree already has one open (e.g. from
      // startup badge hydration), so more than one `panel-content-chat` can
      // be on screen here — the scheduled-send pill only lives on the new
      // tab, so assert on it directly rather than a single panel.
      await expect(homePage).toHaveCount(0);
      await expect(
        window.getByTestId('panel-content-chat').first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByTestId('chat-input-scheduled-send-pill'),
      ).toBeVisible({ timeout: 15_000 });

      await app.openAutomationsPage();
      const rows = window.locator(
        '[data-testid="workflows-library-row"][data-row-kind="automation"]',
      );
      await expect(rows).toHaveCount(1, { timeout: 15_000 });
      await expect(rows.first()).toContainText('Scheduled message');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task C5: provision-scheduled send (new worktree) surfaces a toast that deep-links to the Automations edit form', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);
      // Default branch target is "New worktree" — provisioning is deferred
      // entirely to the extended `worktree_prompt` automation's fire time
      // (Task C1), so nothing exists yet to attach an in-chat pill to.
      await expect(homePage.getByTestId('home-branch-picker')).toContainText(
        'New worktree',
      );

      const taskText = 'Investigate the flaky release pipeline overnight.';
      await homePage.getByTestId('home-composer-editor').click();
      await homePage.getByTestId('home-composer-editor').fill(taskText);

      await clickHomeComposerAction(window, homePage, 'home-schedule-button');
      const modal = window.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();

      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pad = (value) => String(value).padStart(2, '0');
      const dateValue = `${future.getUTCFullYear()}-${pad(
        future.getUTCMonth() + 1,
      )}-${pad(future.getUTCDate())}`;
      const timeValue = `${pad(future.getUTCHours())}:${pad(
        future.getUTCMinutes(),
      )}`;
      await window.getByTestId('schedule-message-date').fill(dateValue);
      await window.getByTestId('schedule-message-time').fill(timeValue);
      await window.getByTestId('schedule-message-save').click();
      await expect(modal).toBeHidden();
      await expect(
        homePage.getByTestId('home-scheduled-send-pill'),
      ).toBeVisible();

      await homePage.getByTestId('home-send-button').click();

      // No worktree/tab exists yet for this target, so success surfaces only
      // via the "Scheduled task automation created" toast (Task C2), and the
      // composer draft (incl. the pill) is reset.
      const toastText = window.getByText('Scheduled task automation created');
      await expect(toastText).toBeVisible({ timeout: 15_000 });
      await expect(
        homePage.getByTestId('home-scheduled-send-pill'),
      ).toHaveCount(0);

      // Post-send desync fix (final-review Critical): a scheduled-provision
      // send does NOT navigate away, so HomeSurface stays mounted. The editor
      // must be cleared of the stale prompt (not just the store) — proven by
      // the composer no longer containing the task text and Send staying enabled
      // to create an empty work area — and the workspace picker must remain
      // selected (the selection is re-seeded rather than left null, which
      // would otherwise strand the composer without a send target since the
      // seed effect only runs once).
      await expect(
        homePage.getByTestId('home-composer-editor'),
      ).not.toContainText(taskText);
      await expect(homePage.getByTestId('home-send-button')).toBeEnabled();
      await waitForHomeWorkspaceSelection(homePage);

      await toastText.click();

      // The toast opens the automation in the Workflows edit shell.
      const form = window.getByTestId('workflow-edit-shell');
      await expect(form).toBeVisible({ timeout: 15_000 });
      await expect(form).toHaveAttribute('data-kind', 'automation');
      await expect(form).toHaveAttribute('data-dirty', 'false');
      await expect(window.getByTestId('automations-form-name')).toHaveValue(
        'Scheduled task',
      );
      await window.getByTestId('automations-form-base-worktree').click();
      await window.getByRole('option', { name: /New Task/ }).click();
      await expect(
        window.getByTestId('automations-form-base-worktree'),
      ).toContainText('New Task');
      await saveWorkflowEdit(window);
      await expect(window.getByTestId('automations-form-error')).toHaveCount(0);
      await backFromWorkflowEdit(window);
      await expect(form).toBeHidden();
      await expect(
        window.getByTestId('automations-mutation-error'),
      ).toHaveCount(0);
      const persistedActivities = await window.evaluate(() =>
        window.api.automations.list(),
      );
      expect(persistedActivities.activities).toHaveLength(1);
      expect(persistedActivities.activities[0].action).toMatchObject({
        type: 'worktree_prompt',
        baseWorktreeId: 'demo-main',
      });
      expect(persistedActivities.activities[0].action).not.toHaveProperty(
        'baseBranch',
      );
      const rows = window.locator(
        '[data-testid="workflows-library-row"][data-row-kind="automation"]',
      );
      await expect(rows).toHaveCount(1);
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('scheduled send to a cowork project defers chat creation to the automation and surfaces the toast', async () => {
    test.setTimeout(60_000);

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      // Target the catch-all by clearing the project — it has no worktree
      // concept, so
      // the branch picker unmounts and a scheduled send fires the deferred
      // `standalone_prompt` automation action (chat creation happens at fire
      // time, exactly like the new-worktree `worktree_prompt` path).
      await homePage.getByTestId('home-workspace-clear').click();
      await expect(homePage.getByTestId('home-branch-picker')).toHaveCount(0);
      // Whatever the cleared trigger reads, it must still read the same after
      // the scheduled send round trip.
      const coworkName = (
        await homePage.getByTestId('home-workspace-select').innerText()
      ).trim();

      const taskText = 'Summarize this week of research notes.';
      await homePage.getByTestId('home-composer-editor').click();
      await homePage.getByTestId('home-composer-editor').fill(taskText);

      await clickHomeComposerAction(window, homePage, 'home-schedule-button');
      const modal = window.getByTestId('schedule-message-modal');
      await expect(modal).toBeVisible();

      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pad = (value) => String(value).padStart(2, '0');
      const dateValue = `${future.getUTCFullYear()}-${pad(
        future.getUTCMonth() + 1,
      )}-${pad(future.getUTCDate())}`;
      const timeValue = `${pad(future.getUTCHours())}:${pad(
        future.getUTCMinutes(),
      )}`;
      await window.getByTestId('schedule-message-date').fill(dateValue);
      await window.getByTestId('schedule-message-time').fill(timeValue);
      await window.getByTestId('schedule-message-save').click();
      await expect(modal).toBeHidden();
      await expect(
        homePage.getByTestId('home-scheduled-send-pill'),
      ).toBeVisible();

      await homePage.getByTestId('home-send-button').click();

      // No cowork chat exists yet — success surfaces only via the
      // automation-created toast, nothing navigates, and the composer draft
      // (incl. the pill) is reset while the workspace selection is re-seeded.
      const toastText = window.getByText('Scheduled task automation created');
      await expect(toastText).toBeVisible({ timeout: 15_000 });
      await expect(homePage).toBeVisible();
      await expect(
        homePage.getByTestId('home-scheduled-send-pill'),
      ).toHaveCount(0);
      await expect(
        homePage.getByTestId('home-composer-editor'),
      ).not.toContainText(taskText);
      await expect(homePage.getByTestId('home-send-button')).toBeEnabled();
      await expect(homePage.getByTestId('home-workspace-select')).toContainText(
        coworkName,
      );

      await toastText.click();

      const form = window.getByTestId('workflow-edit-shell');
      await expect(form).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('automations-form-name')).toHaveValue(
        'Scheduled message',
      );
      await backFromWorkflowEdit(window);
      const rows = window.locator(
        '[data-testid="workflows-library-row"][data-row-kind="automation"]',
      );
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText('Scheduled message');
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task C5: pipeline mode execution scope follows the branch target (worktree vs. cowork directory)', async () => {
    test.setTimeout(60_000);

    const WORKTREE_TASK_PIPELINE_YAML = [
      'name: Worktree Task Pipeline',
      'scope: worktree',
      'on: task_ready',
      'jobs:',
      '  run:',
      '    steps:',
      '      - run: echo task',
      '',
    ].join('\n');
    const DIRECTORY_TASK_PIPELINE_YAML = [
      'name: Directory Task Pipeline',
      'scope: directory',
      'on: task_ready',
      'jobs:',
      '  run:',
      '    steps:',
      '      - run: echo task',
      '',
    ].join('\n');

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-pipeline-scope-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    seedStoredPipeline({
      userDataDir,
      id: 'worktree-task-pipeline',
      name: 'Worktree Task Pipeline',
      yaml: WORKTREE_TASK_PIPELINE_YAML,
    });
    seedStoredPipeline({
      userDataDir,
      id: 'directory-task-pipeline',
      name: 'Directory Task Pipeline',
      yaml: DIRECTORY_TASK_PIPELINE_YAML,
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );

      // An existing-worktree branch target resolves to `worktree` execution
      // scope, which (via the worktree ⊇ directory capability relation) also
      // lists `directory`-scoped pipelines.
      await homePage.getByTestId('home-branch-picker-button').click();
      await window.getByTestId('home-branch-picker-worktree-demo-main').click();

      await homePage
        .getByTestId('home-composer-editor')
        .fill('Add integration tests for the billing webhook.');
      await homePage.getByTestId('home-send-button').click();

      const modal = window.getByTestId('pipeline-trigger-modal');
      await expect(modal).toBeVisible();
      const modalBody = window.getByTestId('pipeline-trigger-modal-body');
      await expect(
        modalBody.getByRole('button', { name: 'Worktree Task Pipeline' }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        modalBody.getByRole('button', { name: 'Directory Task Pipeline' }),
      ).toBeVisible();

      await window.getByTestId('pipeline-trigger-modal-cancel').click();
      await expect(modal).toBeHidden();

      // Clear the project to target the catch-all: it has no worktree
      // concept, so the branch picker unmounts and the launcher resolves
      // `directory`
      // execution scope against the cowork root instead — the
      // worktree-only-scoped pipeline must NOT be listed there.
      await homePage.getByTestId('home-workspace-clear').click();
      await expect(homePage.getByTestId('home-branch-picker')).toHaveCount(0);

      await homePage.getByTestId('home-send-button').click();

      await expect(modal).toBeVisible();
      await expect(
        modalBody.getByRole('button', { name: 'Directory Task Pipeline' }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        modalBody.getByRole('button', { name: 'Worktree Task Pipeline' }),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task F3: @ mention against an existing-worktree target opens the file typeahead with real files and inserts a pill', async () => {
    test.setTimeout(60_000);

    // Exercises the `worktree` file-index target — it delegates directly to
    // the existing worktree-checkout walker (`buildFileIndexes`), so this
    // covers the target-aware IPC + renderer typeahead wiring end-to-end
    // without depending on a shadow checkout. The `new-worktree` default
    // target instead indexes a repo-shadow checkout (`ensureRepoShadow`),
    // which requires a git remote to resolve a default branch from — the
    // seeded demo fixtures (`demo-apps/lib/git.mjs`) are plain local repos
    // with no `origin` configured, so that path cannot be driven end-to-end
    // here. Baseline/shadow coverage lives at the unit level instead:
    // `apps/desktop-app/src/main/__tests__/home-surface.test.ts` (IPC per
    // target kind, including the shadow-keyed cache), `homeSend.test.ts`
    // (the shadow → new-worktree-cwd rewrite), and
    // `useFileTypeahead.test.tsx` / `file-reference-paths.test.ts` (the
    // renderer-side pill/rewrite mechanics).
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      await homePage.getByTestId('home-branch-picker-button').click();
      await window.getByTestId('home-branch-picker-worktree-demo-main').click();

      const editor = homePage.getByTestId('home-composer-editor');
      await editor.click();
      await editor.fill('Check @package');

      const menu = window.getByTestId('home-composer-plus-menu');
      await expect(menu).toBeVisible();
      const option = menu
        .getByRole('button', { name: /package\.json/ })
        .first();
      await expect(option).toBeVisible({ timeout: 15_000 });
      await option.click();

      // Selecting a file replaces the `@package` trigger with a pill; the
      // menu closes and the pill's rendered label (the bare filename) is
      // visible in the editor.
      await expect(menu).toHaveCount(0);
      await expect(editor).toContainText('package.json');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Startup MRU: an explicit null lastActiveContext lands on the Home page on first paint', async () => {
    // A true quit+relaunch cycle is exercised elsewhere for persisted-write
    // flush behavior (preferences-recovery.spec.mjs). What Plan B actually
    // needs pinned is the startup *routing decision* in App.tsx's
    // `useLayoutEffect` (ctx === null and no legacy lastSelectedWorktree*
    // fields -> navigate('home')) — seeding that exact preferences shape
    // before a single launch exercises the same branch far more cheaply than
    // a real relaunch would, with no loss of coverage.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-mru-'),
    );
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify(
        {
          version: 1,
          preferences: {
            onboardingCompleted: ['v1'],
            legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
            legalConsentTosVersion: '2026-07-06',
            lastActiveContext: null,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await expect(window.getByTestId('app-sidebar')).toBeVisible();

      // No navigation call here — this must be the app's own startup choice.
      await expect(window.getByTestId('page-home')).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Task F2: mode-specific placeholders, and managed project defaults remain available in the shared composer menu', async () => {
    test.setTimeout(90_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-slash-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    seedWorkspaceManagedSelections(userDataDir);
    seedInventoryCache(userDataDir);
    seedPluginCache(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      const editor = homePage.getByTestId('home-composer-editor');

      // Chat mode (the default) placeholder.
      await expect(editor).toContainText('@ to mention, / skills and commands');

      // Pipeline mode swaps the placeholder to task-oriented copy.
      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );
      await expect(editor).toContainText('Describe the task we are working on');
      await clickHomeComposerAction(
        window,
        homePage,
        'home-pipeline-mode-button',
      );
      await expect(editor).toContainText('@ to mention, / skills and commands');

      // Target the existing seeded worktree so discovery (feeding the
      // "Available to enable" gate) resolves against a real checkout rather
      // than the slower new-worktree baseline shadow.
      await homePage.getByTestId('home-branch-picker-button').click();
      await window.getByTestId('home-branch-picker-worktree-demo-main').click();
      await expect(
        homePage.getByTestId('home-branch-picker-button'),
      ).toContainText('demo-main');

      await editor.click();
      await editor.fill('/');

      const slashMenu = window.getByTestId('home-composer-plus-menu');
      await expect(slashMenu).toBeVisible();
      await expect(
        slashMenu.getByRole('group', { name: 'Available to enable' }),
      ).toBeVisible({ timeout: 30_000 });
      for (const managedName of [SKILL_NAME, COMMAND_NAME]) {
        const inlineRow = window
          .getByTestId(`home-composer-capability-${managedName}`)
          .first();
        await expect(inlineRow).toBeVisible();
      }

      // Home exposes the same managed skills and commands through the +
      // menu, including workspace defaults awaiting provider discovery.
      await editor.press('Escape');
      await expect(slashMenu).toHaveCount(0);

      await homePage.getByTestId('home-composer-plus-button').click();
      const popup = window.getByTestId('home-composer-plus-menu');
      await expect(popup).toBeVisible();
      await expect(popup.getByTestId('home-plugins-button')).toBeVisible();
      await expect(
        popup.getByTestId(`home-composer-capability-${SKILL_NAME}`),
      ).toBeVisible();
      await expect(
        popup.getByTestId(`home-composer-capability-${COMMAND_NAME}`),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('project skills from an external repository shadow appear for the new-worktree target', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-shadow-skills-'),
    );
    const seedResult = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
    });
    const workspace = seedResult.workspaces.find(
      (candidate) => candidate.id === WORKSPACE_ID,
    );
    if (!workspace?.repoPath) {
      throw new Error('Seeded project repository was not found');
    }

    const skillName = 'shadow-only-home-e2e';
    const aliasChainSkillName = 'shadow-alias-chain-e2e';
    const hiddenSkillName = 'shadow-hidden-home-e2e';
    const hookMarkerPath = path.join(userDataDir, 'shadow-hook-ran');
    const apiKeyHelperMarkerPath = path.join(
      userDataDir,
      'shadow-api-key-helper-ran',
    );
    const commandPluginMarkerPath = path.join(
      userDataDir,
      'shadow-command-plugin-ran',
    );
    const apiKeyHelperPath = path.join(
      workspace.repoPath,
      '.claude',
      'api-key-helper.sh',
    );
    const skillDir = path.join(
      workspace.repoPath,
      '.claude',
      'skills',
      skillName,
    );
    const commandsDir = path.join(workspace.repoPath, '.claude', 'commands');
    const aliasChainSkillDir = path.join(
      workspace.repoPath,
      '.claude',
      'skills',
      aliasChainSkillName,
    );
    const hiddenSkillDir = path.join(
      workspace.repoPath,
      '.claude',
      'skills',
      hiddenSkillName,
    );
    const commandPluginDir = path.join(
      workspace.repoPath,
      '.claude',
      'shadow-command-plugin',
    );
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(aliasChainSkillDir, { recursive: true });
    mkdirSync(hiddenSkillDir, { recursive: true });
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(path.join(commandPluginDir, '.claude-plugin'), {
      recursive: true,
    });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: ignored-shadow-skill-alias',
        'description: Project skill discovered from the repository shadow',
        '---',
        '',
        '# Shadow-only skill',
      ].join('\n'),
    );
    writeFileSync(
      path.join(commandsDir, `${skillName}.md`),
      [
        '---',
        'description: Legacy command must not shadow the project skill',
        '---',
      ].join('\n'),
    );
    writeFileSync(
      path.join(aliasChainSkillDir, 'SKILL.md'),
      [
        '---',
        'node-0: &node-0 { value: x }',
        'node-1: &node-1 { <<: *node-0, value: x }',
        'disabled: &disabled false',
        'user-invocable: *disabled',
        'description: *disabled',
        '---',
      ].join('\n'),
    );
    writeFileSync(
      path.join(hiddenSkillDir, 'SKILL.md'),
      [
        '---',
        'user-invocable: False # internal skill',
        'description: This skill must remain hidden',
        '---',
      ].join('\n'),
    );
    writeFileSync(
      path.join(commandsDir, 'legacy-path-name.md'),
      [
        '---',
        'name: ignored-frontmatter-name',
        'description: Legacy command keeps its path-derived name',
        '---',
      ].join('\n'),
    );
    writeFileSync(
      path.join(commandsDir, 'research-repo.md'),
      [
        '---',
        'name: research',
        '# Metadata comment',
        'allowed-tools: Bash',
        '# Research a GitHub Repository',
        '',
        'Investigate the repository and document its architecture.',
      ].join('\n'),
    );
    writeFileSync(
      apiKeyHelperPath,
      [
        '#!/bin/sh',
        `touch "${apiKeyHelperMarkerPath}"`,
        "printf 'test-api-key\\n'",
      ].join('\n'),
    );
    chmodSync(apiKeyHelperPath, 0o755);
    writeJson(path.join(commandPluginDir, '.claude-plugin', 'plugin.json'), {
      name: 'shadow-command-plugin',
      version: '1.0.0',
    });
    writeJson(path.join(workspace.repoPath, '.claude', 'settings.json'), {
      apiKeyHelper: apiKeyHelperPath,
      enabledPlugins: {
        'shadow-command-plugin@shadow-inline-marketplace': true,
      },
      extraKnownMarketplaces: {
        'shadow-inline-marketplace': {
          source: {
            source: 'settings',
            name: 'shadow-inline-marketplace',
            plugins: [
              {
                name: 'shadow-command-plugin',
                source: {
                  source: 'command',
                  command: `touch "${commandPluginMarkerPath}"; printf '%s\\n' "${commandPluginDir}"`,
                },
              },
            ],
          },
        },
      },
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      },
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `touch "${hookMarkerPath}"`,
              },
            ],
          },
        ],
      },
    });
    execFileSync('git', ['add', '.claude'], {
      cwd: workspace.repoPath,
    });
    execFileSync('git', ['commit', '-m', 'Add shadow discovery skill'], {
      cwd: workspace.repoPath,
    });

    const remotePath = path.join(userDataDir, 'shadow-origin.git');
    execFileSync('git', ['clone', '--bare', workspace.repoPath, remotePath]);
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: workspace.repoPath,
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);
      await expect(
        homePage.getByTestId('home-branch-picker-button'),
      ).toContainText('New worktree');

      const editor = homePage.getByTestId('home-composer-editor');
      await editor.click();
      await editor.fill(`/${skillName}`);

      const projectSkill = window.getByTestId(
        `home-composer-capability-${skillName}`,
      );
      await expect(projectSkill).toBeVisible({ timeout: 45_000 });
      await expect(projectSkill).toContainText(
        'Project skill discovered from the repository shadow',
      );
      await expect(projectSkill).not.toContainText(
        'Legacy command must not shadow the project skill',
      );
      await expect(
        window.getByTestId(
          'home-composer-capability-ignored-shadow-skill-alias',
        ),
      ).toHaveCount(0);

      await editor.press('ControlOrMeta+A');
      await editor.press('Backspace');
      await editor.fill('/' + `${aliasChainSkillName}`);
      await expect(
        window.getByTestId(`home-composer-capability-${aliasChainSkillName}`),
      ).toBeVisible();

      await editor.press('ControlOrMeta+A');
      await editor.press('Backspace');
      await editor.fill('/' + `${hiddenSkillName}`);
      await expect(
        window.getByTestId(`home-composer-capability-${hiddenSkillName}`),
      ).toHaveCount(0);

      await editor.press('ControlOrMeta+A');
      await editor.press('Backspace');
      await editor.fill('/' + 'legacy-path-name');
      const legacyCommand = window.getByTestId(
        'home-composer-capability-legacy-path-name',
      );
      await expect(legacyCommand).toBeVisible();
      await expect(legacyCommand).toContainText(
        'Legacy command keeps its path-derived name',
      );
      await expect(
        window.getByTestId('home-composer-capability-ignored-frontmatter-name'),
      ).toHaveCount(0);
      expect(existsSync(hookMarkerPath)).toBe(false);
      expect(existsSync(apiKeyHelperMarkerPath)).toBe(false);
      expect(existsSync(commandPluginMarkerPath)).toBe(false);

      await editor.press('ControlOrMeta+A');
      await editor.press('Backspace');
      await editor.fill('/' + 'research-repo');
      const researchCommand = window.getByTestId(
        'home-composer-capability-research-repo',
      );
      await expect(researchCommand).toBeVisible();
      await expect(researchCommand).toContainText(
        'Research a GitHub Repository',
      );
      // The slash entry point inserts the project command into the draft.
      await researchCommand.click();
      await expect(editor).toContainText('/research-repo');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the effort panel commits the constrained declared set in the Home composer', async () => {
    test.setTimeout(60_000);

    // CAN-2540 §3: the shared ThinkingLevelControl is fully controlled — its
    // onChange hands the host the `next` level computed from the set it
    // DISPLAYS, and the Home composer commits exactly that value
    // (`setThinkingLevel(next)`; the store no longer re-derives the cycle for
    // button clicks). This spec constrains the registry's only Claude model
    // to a declared ['off', 'high'] set so a click at High must land on Off —
    // the unconstrained Claude fallback cycle (off/medium/high/xhigh/max)
    // would advance High → XHigh instead — and proves the click COMMITTED by
    // unmounting the Home page and returning: an uncommitted draft would
    // resolve back to the preferences default (High).
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await electronApp.evaluate(
        ({ BrowserWindow }, { channel }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) throw new Error('No BrowserWindow available');
          win.webContents.send(channel, {
            claude: [
              {
                id: 'opus[1m]',
                label: 'Opus',
                supportedThinkingLevels: ['off', 'high'],
              },
            ],
            codex: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
            ollama: [],
            agents: [],
            aliases: {},
            aiGatewayModels: [],
            gatewayRoutes: [],
          });
        },
        { channel: 'model-registry:updated' },
      );

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      // The lane default repairs onto the only registry Claude model, whose
      // constrained declared set drives both display and cycle.
      await expect(homePage.getByTestId('chat-model-picker')).toContainText(
        'Opus',
        { timeout: 30_000 },
      );

      const thinking = homePage.getByTestId('home-thinking-level-button');
      await expect(thinking).toBeVisible({ timeout: 15_000 });
      // The preferences default level ('high') is in the declared set, so the
      // untouched draft displays High.
      await expect(thinking).toHaveAttribute('data-thinking-level', 'high');
      await expect(thinking).toContainText('High');

      // The effort panel offers exactly the declared set (None and High), and
      // the displayed and committed levels move together.
      const slider = await openEffortSlider(
        window,
        thinking,
        'home-thinking-level-button',
      );
      await expect(slider).toHaveAttribute('aria-valuemax', '1');
      await expect(slider).toHaveAttribute('aria-valuetext', 'High');
      await stepEffortAway(slider);
      await expect(slider).toHaveAttribute('aria-valuetext', 'None');
      await closeEffortPanel(window);
      await expect(thinking).toHaveAttribute('data-thinking-level', 'off');
      await expect(thinking).toContainText('None');

      // Committed: leave Home entirely (the standalone page unmounts, taking
      // the control's render state with it) and come back. None surviving the
      // round trip proves the store committed the panel's level — an
      // uncommitted draft would remount showing the High default.
      await app.openAutomationsPage();
      await expect(window.getByTestId('page-home')).toHaveCount(0);
      await window.getByTestId('sidebar-create-task').click();
      await expect(homePage).toBeVisible();
      const remounted = homePage.getByTestId('home-thinking-level-button');
      await expect(remounted).toHaveAttribute('data-thinking-level', 'off');
      await expect(remounted).toContainText('None');

      // The committed value keeps moving on the same declared set.
      await stepEffortAway(
        await openEffortSlider(window, remounted, 'home-thinking-level-button'),
      );
      await closeEffortPanel(window);
      await expect(remounted).toHaveAttribute('data-thinking-level', 'high');
      await expect(remounted).toContainText('High');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// CAN-4557: the first Home prompt lands in the starter chat that opening the
// default Chats project seeds, instead of opening beside it.
test.describe('Home first send into Chats', () => {
  const COWORK_PROJECT_ID = 'cowork-default';

  async function launchFirstSendScenario(scenarioKey) {
    await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
      llm: {
        steps: [{ text: 'CAN-4557 scripted reply.', stopReason: 'end_turn' }],
      },
    });
    return launchCanopy({ env: { CANOPY_MOCK_API_KEY: scenarioKey } });
  }

  /** Persisted Chats entries with each tab's user prompts and message roles. */
  async function readCoworkChats(window, userDataDir) {
    const indexPath = path.join(
      userDataDir,
      'workspaces',
      COWORK_PROJECT_ID,
      'work-entries.json',
    );
    if (!existsSync(indexPath)) return [];
    const { entries } = JSON.parse(readFileSync(indexPath, 'utf8'));
    return Promise.all(
      entries.map(async (entry) => {
        const persisted = await window.evaluate(
          (target) => window.api.chat.loadTabs(target),
          { projectId: COWORK_PROJECT_ID, worktreeId: entry.id },
        );
        return {
          entryId: entry.id,
          activeTabId: persisted.activeTabId,
          tabs: persisted.tabs.map((tab) => ({
            id: tab.id,
            prompts: tab.messages
              .filter((message) => message.role === 'user')
              .map((message) =>
                (message.blocks ?? [])
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join(''),
              ),
            replied: tab.messages.some(
              (message) => message.role === 'assistant',
            ),
          })),
        };
      }),
    );
  }

  /** The entry and tab holding `prompt` once its reply has persisted. */
  async function waitForRepliedPrompt(window, userDataDir, prompt) {
    let found;
    await expect
      .poll(
        async () => {
          for (const entry of await readCoworkChats(window, userDataDir)) {
            const tab = entry.tabs.find((candidate) =>
              candidate.prompts.includes(prompt),
            );
            if (tab?.replied) {
              const sessions = await window.evaluate(
                (target) => window.api.chat.activeSessions(target),
                { projectId: COWORK_PROJECT_ID, worktreeId: entry.entryId },
              );
              if (
                sessions.sessions?.some(
                  (session) => session.chatId === tab.id && session.turnActive,
                )
              )
                continue;
              found = { entry, tab };
              return true;
            }
          }
          return false;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    return found;
  }

  async function sendFromHome(window, prompt) {
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await waitForHomeWorkspaceSelection(home);
    await home.getByTestId('home-composer-editor').fill(prompt);
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    const panel = window.locator('[data-testid="panel-content-chat"]:visible');
    await expect(panel.getByText(prompt).first()).toBeVisible({
      timeout: 30_000,
    });
    return panel;
  }

  const chatTabs = (window) =>
    window.locator('[data-testid^="panel-tab-panel-chat-"]:visible');

  test('a fresh install opens one chat for the first prompt and keeps it when a second prompt starts another', async () => {
    test.setTimeout(180_000);
    const { electronApp, userDataDir } = await launchFirstSendScenario(
      'can4557-first-and-second',
    );
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });

      const firstPrompt = 'Summarize what a work area is for.';
      await sendFromHome(window, firstPrompt);
      const first = await waitForRepliedPrompt(
        window,
        userDataDir,
        firstPrompt,
      );
      // Settled after the reply, so a late hydration cannot hide a tab.
      expect(first.entry.tabs).toEqual([first.tab]);
      expect(first.entry.activeTabId).toBe(first.tab.id);
      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toHaveCount(1);
      await expect(chatTabs(window)).toHaveCount(1);
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${first.tab.id}`),
      ).toBeVisible();

      const secondPrompt = 'List three ways to name a work area.';
      await sendFromHome(window, secondPrompt);
      const second = await waitForRepliedPrompt(
        window,
        userDataDir,
        secondPrompt,
      );
      expect(second.tab.id).not.toBe(first.tab.id);
      // The first entry has a conversation, so the second prompt gets its own.
      expect(second.entry.entryId).not.toBe(first.entry.entryId);
      expect(second.entry.tabs).toEqual([second.tab]);
      expect(second.entry.activeTabId).toBe(second.tab.id);
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${second.tab.id}`),
      ).toBeVisible();
      await expect(chatTabs(window)).toHaveCount(1);
      const entries = await readCoworkChats(window, userDataDir);
      expect(
        entries.find((entry) => entry.entryId === first.entry.entryId)?.tabs,
      ).toEqual([first.tab]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a saved draft in the starter chat stays beside the chat a Home prompt opens', async () => {
    test.setTimeout(180_000);
    const { electronApp, userDataDir } = await launchFirstSendScenario(
      'can4557-saved-draft',
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openChatPage();
      await window.getByTestId('empty-new-chat').click();
      await expect(window.getByTestId('cowork-top-bar')).toBeVisible();

      let starter;
      await expect
        .poll(async () => {
          const entries = await readCoworkChats(window, userDataDir);
          starter =
            entries.length === 1 && entries[0].tabs.length === 1
              ? { entryId: entries[0].entryId, tabId: entries[0].tabs[0].id }
              : undefined;
          return starter !== undefined;
        })
        .toBe(true);
      const draft = 'Unsent idea to keep for later';
      const starterComposer = window
        .locator('[data-testid="panel-content-chat"]:visible')
        .getByRole('textbox')
        .first();
      await starterComposer.fill(draft);
      await expect(starterComposer).toContainText(draft);

      const prompt = 'Draft a short status update.';
      await sendFromHome(window, prompt);
      const sent = await waitForRepliedPrompt(window, userDataDir, prompt);

      // Entry reuse is fine; the drafted starter must survive beside it.
      expect(sent.entry.entryId).toBe(starter.entryId);
      expect(sent.entry.tabs.map((tab) => tab.id)).toEqual([
        starter.tabId,
        sent.tab.id,
      ]);
      expect(sent.entry.activeTabId).toBe(sent.tab.id);
      await expect(chatTabs(window)).toHaveCount(2);

      await window.getByTestId(`panel-tab-panel-chat-${starter.tabId}`).click();
      await expect(
        window
          .locator('[data-testid="panel-content-chat"]:visible')
          .getByRole('textbox')
          .first(),
      ).toContainText(draft);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

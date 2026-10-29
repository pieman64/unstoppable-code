// Panel-grid test harness (Phase 3 panel cutover).
//
// The worktree content area is a VS Code-style panel grid: `worktree-part`
// hosts `panel-grid-root`, whose default layout is three groups with stable
// group ids — `group-chat` (the worktree's chat tabs as per-tab bound
// panels), `group-terminal` (panel `panel-terminal`, kind `terminal`) split
// below the chat, and `group-activity` (panel `panel-activity`, kind
// `activity-section`) on the right. Chat/file panels are instance-bound with
// DERIVED panel ids (`panel-chat-<chatTabId>` / `panel-file-<fileTabId>`);
// this harness seeds one chat tab with a fixed id so the default chat panel
// id is deterministic (`DEFAULT_PANEL_IDS.chat`). Group roots carry
// `data-testid="panel-group-<groupId>"`; each mounted panel's content frame
// carries `data-testid="panel-content-<kind>"`.
//
// E2E builds install `window.__canopyPanelTestApi` whenever a worktree is
// selected on the main page. Every op dispatches through the same panel layout
// store the real chrome buttons and DnD use. The helpers here are thin wrappers
// over that API plus the common seed-and-select launch flow.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver, expandDefaultActivityRail } from './canopyApp.mjs';
import {
  captureFixtureCatalog,
  createBoundaryRecorder,
  reportOwnedSetupFailure,
} from './browser-profile-test-lifecycle.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, getMainWindow, launchCanopy } from './launchCanopy.mjs';

/** Stable ids of the default per-worktree layout (default-layout.ts). */
export const DEFAULT_GROUP_IDS = {
  chat: 'group-chat',
  terminal: 'group-terminal',
  activity: 'group-activity',
};

/** Chat tab id seeded by {@link seedPanelWorktree} — fixed so the bound
 * chat panel id (`panel-chat-<tabId>`) is deterministic. */
export const SEEDED_CHAT_TAB_ID = 'seed-chat';

/** Stable/derived panel ids of the default per-worktree layout. */
export const DEFAULT_PANEL_IDS = {
  chat: `panel-chat-${SEEDED_CHAT_TAB_ID}`,
  terminal: 'panel-terminal',
  activity: 'panel-activity',
};

function createDefaultPanelSetupBoundary(launchOptions, ownsFreshSetup) {
  const directory = process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim();
  if (!ownsFreshSetup || !directory) return undefined;
  try {
    mkdirSync(directory, { recursive: true });
    const base = path.resolve(
      directory,
      `default-panel-setup-${process.pid}-${randomUUID()}`,
    );
    const record = createBoundaryRecorder(`${base}-fixture.jsonl`);
    const explicitDiagnosticEnv = Object.hasOwn(
      launchOptions.env ?? {},
      'CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS',
    );
    const mainIdentityStream = explicitDiagnosticEnv
      ? 'unavailable-explicit-diagnostic-env'
      : `${base}-main.jsonl`;
    const env = { ...(launchOptions.env ?? {}) };
    if (!explicitDiagnosticEnv) {
      env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS = JSON.stringify({
        file: mainIdentityStream,
        mode: 'setup',
      });
    }
    return {
      explicitDiagnosticEnv,
      launchOptions: { ...launchOptions, env },
      mainIdentityStream,
      record,
    };
  } catch {
    return undefined;
  }
}

function boundedEvidenceString(value, maximumJsonBytes) {
  const text = String(value);
  if (Buffer.byteLength(JSON.stringify(text)) <= maximumJsonBytes) return text;
  let low = 0,
    high = Math.min(text.length, maximumJsonBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(JSON.stringify(text.slice(0, middle))) <=
      maximumJsonBytes
    )
      low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function captureDefaultFixtureCatalog(userDataDir, workspaceIds) {
  try {
    return {
      status: 'available',
      catalog: captureFixtureCatalog(userDataDir, workspaceIds),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      userDataDir: boundedEvidenceString(userDataDir, 1_024),
      error: boundedEvidenceString(error?.message ?? error, 2_048),
    };
  }
}

function projectDefaultIdentities(identities) {
  let truncated = identities.length > 8;
  const projected = identities.slice(0, 8).map((identity) =>
    Object.fromEntries(
      ['id', 'kind', 'type', 'workspaceId', 'worktreeId', 'branchName'].flatMap(
        (key) => {
          if (typeof identity?.[key] !== 'string') return [];
          const value = boundedEvidenceString(identity[key], 128);
          if (value !== identity[key]) truncated = true;
          return [[key, value]];
        },
      ),
    ),
  );
  return { projected, truncated };
}

function recordDefaultFixtureCatalog(record, phase, capture) {
  if (capture.status === 'unavailable') {
    record('default-panel-setup-catalog', {
      phase,
      status: capture.status,
      userDataDir: capture.userDataDir,
      error: capture.error,
      fileCount: 0,
      recordedFileCount: 0,
      truncated: false,
    });
    return;
  }
  const { catalog } = capture;
  const header = {
    phase,
    status: capture.status,
    userDataDir: boundedEvidenceString(catalog.userDataDir, 1_024),
    indexPath: boundedEvidenceString(catalog.indexPath, 1_024),
    fileCount: catalog.files.length,
    recordedFileCount: 0,
    truncated: false,
  };
  // Each phase gets its own budget so a large prelaunch catalog cannot erase
  // failure-time evidence. Reserve envelope/summary space and leave the real
  // recorder's remaining capacity available to page and cleanup boundaries.
  const lineBytes = (stage, details) =>
    Buffer.byteLength(JSON.stringify({ stage, ...details })) + 256;
  const rows = [];
  let bytes = lineBytes('default-panel-setup-catalog', header) + 1_024;
  for (const [index, file] of catalog.files.slice(0, 17).entries()) {
    const identities = projectDefaultIdentities(file.identities ?? []);
    const row = {
      phase,
      index,
      path: boundedEvidenceString(file.path, 1_024),
      status: boundedEvidenceString(file.status, 128),
      code:
        file.code === undefined
          ? undefined
          : boundedEvidenceString(file.code, 128),
      sizeBytes: file.sizeBytes,
      sha256:
        file.sha256 === undefined
          ? undefined
          : boundedEvidenceString(file.sha256, 128),
      version: file.version,
      identities: identities.projected,
      truncated: Boolean(file.truncated) || identities.truncated,
    };
    const size = lineBytes('default-panel-setup-catalog-file', row);
    if (bytes + size > 16 * 1_024) break;
    bytes += size;
    rows.push(row);
  }
  header.recordedFileCount = rows.length;
  header.truncated = rows.length < catalog.files.length;
  record('default-panel-setup-catalog', header);
  for (const row of rows) record('default-panel-setup-catalog-file', row);
  record('default-panel-setup-catalog-summary', {
    phase,
    fileCount: catalog.files.length,
    recordedFileCount: rows.length,
    omittedFileCount: catalog.files.length - rows.length,
    truncated: header.truncated,
  });
}

function captureCachedPageField(window, field) {
  if (!window) return { status: 'unavailable', reason: 'page-not-produced' };
  try {
    const value = window[field]();
    if (typeof value !== 'string' && typeof value !== 'boolean')
      return { status: 'unavailable', reason: 'unexpected-cached-value-type' };
    return {
      status: 'available',
      value:
        typeof value === 'string' ? boundedEvidenceString(value, 2_048) : value,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: boundedEvidenceString(error?.message ?? error, 2_048),
    };
  }
}

function captureDefaultPanelSetupEvidence(context, boundary, workspaceIds) {
  const { error, userDataDir, window, app } = context;
  boundary.record('default-panel-setup-failure', {
    error: {
      name: boundedEvidenceString(error?.name ?? 'Error', 128),
      message: boundedEvidenceString(error?.message ?? error, 2_048),
    },
    mainIdentityStream: boundedEvidenceString(
      boundary.mainIdentityStream,
      1_024,
    ),
    setupValues: {
      window: window === undefined ? 'not-produced' : 'produced',
      app: app === undefined ? 'not-produced' : 'produced',
    },
  });
  if (boundary.explicitDiagnosticEnv)
    boundary.record('default-panel-setup-diagnostic-env-collision', {
      mainIdentityStream: 'unavailable-explicit-diagnostic-env',
    });
  recordDefaultFixtureCatalog(
    boundary.record,
    'prelaunch',
    boundary.prelaunchCatalog,
  );
  recordDefaultFixtureCatalog(
    boundary.record,
    'failure',
    captureDefaultFixtureCatalog(userDataDir, workspaceIds),
  );
  boundary.record('default-panel-setup-page', {
    url: captureCachedPageField(window, 'url'),
    isClosed: captureCachedPageField(window, 'isClosed'),
    domRows: {
      status: 'unavailable',
      reason: 'live-renderer-transport-omitted-to-preserve-bounded-cleanup',
    },
  });
}

/**
 * Launches the app with a seeded demo workspace plus one fixed-id chat tab
 * (`SEEDED_CHAT_TAB_ID`, so the default chat panel id is deterministic),
 * opens the main page, selects the worktree, and waits for the panel grid
 * (and the panel test API) to be ready. Returns
 * `{ electronApp, userDataDir, window, app, demoSeed }`; the caller still
 * owns teardown via `closeCanopy(electronApp, userDataDir)`.
 *
 * Options: `apps` (demo app ids, default `['ts-pnpm-vite']`), `branch`
 * (worktree row to select, default `demo-main`),
 * `onSelectWorktreeFailure` (optional best-effort diagnostic callback), plus
 * any extra `launchCanopy` options. Callers passing their own `userDataDir`
 * (two-phase seeding) own their own demo/chat seeding.
 */
export async function seedPanelWorktree(options = {}) {
  const {
    apps = ['ts-pnpm-vite'],
    branch = 'demo-main',
    onSelectWorktreeFailure,
    onBeforeLaunch,
    onSetupFailure,
    providerType = 'claude',
    ...launchOptions
  } = options;
  const ownsFreshSetup =
    launchOptions.userDataDir === undefined &&
    onSetupFailure === undefined &&
    onSelectWorktreeFailure === undefined;
  const defaultBoundary = createDefaultPanelSetupBoundary(
    launchOptions,
    ownsFreshSetup,
  );
  const effectiveLaunchOptions =
    defaultBoundary?.launchOptions ?? launchOptions;

  let launched;
  if (launchOptions.userDataDir === undefined) {
    // Two-phase seed: demo workspaces + one fixed-id chat tab BEFORE launch,
    // so the default layout binds `panel-chat-<SEEDED_CHAT_TAB_ID>`.
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-panels-'));
    const demoSeed = seedDemoWorkspaces({ userDataDir, apps });
    seedWorktreeChat({
      userDataDir,
      workspaceId: `demo-${apps[0]}`,
      worktreeId: branch,
      providerType,
      tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Chat' }],
    });
    const worktreeDataDir = path.join(
      userDataDir,
      'workspaces',
      `demo-${apps[0]}`,
      'worktree-data',
      branch,
    );
    mkdirSync(worktreeDataDir, { recursive: true });
    writeFileSync(
      path.join(worktreeDataDir, 'panel-layout-mode.json'),
      JSON.stringify({ version: 1, mode: 'advanced' }),
      'utf8',
    );
    const workspaceIds = apps.map((id) => `demo-${id}`);
    if (defaultBoundary) {
      defaultBoundary.prelaunchCatalog = captureDefaultFixtureCatalog(
        userDataDir,
        workspaceIds,
      );
    }
    try {
      onBeforeLaunch?.({
        userDataDir,
        workspaceIds,
      });
    } catch {
      /* Fixture observation only. */
    }
    launched = {
      ...(await launchCanopy({
        userDataDir,
        ...effectiveLaunchOptions,
      })),
    };
    launched.demoSeed = demoSeed;
  } else {
    launched = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: apps,
      ...effectiveLaunchOptions,
    });
  }

  let window, app;
  try {
    window = await getMainWindow(launched.electronApp);
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    try {
      await app.selectWorktree(branch, { expandDefaultActivityRail: false });
    } catch (error) {
      if (typeof onSelectWorktreeFailure === 'function') {
        try {
          await onSelectWorktreeFailure({
            ...launched,
            window,
            app,
            branch,
            error,
          });
        } catch (diagnosticError) {
          console.error(
            'Failed to capture worktree selection diagnostics:',
            diagnosticError,
          );
        }
      }
      throw error;
    }

    await expect(window.getByTestId('panel-grid-root')).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
        timeout: 15_000,
      })
      .toBe(true);

    if (launchOptions.userDataDir === undefined) {
      // The seeded chat tab's bound panel may materialize asynchronously (the
      // ensure-layout path can run before chat hydration seeds it, in which
      // case the sync bridge adds it on its next sweep) — wait until it exists
      // so specs can assert the settled default layout.
      await expect
        .poll(
          async () => {
            const layout = await getLayout(window);
            if (!layout) {
              return false;
            }
            return collectLeaves(layout.root).some((leaf) =>
              leaf.panels.some(
                (panel) => panel.instance?.chatTabId === SEEDED_CHAT_TAB_ID,
              ),
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    }

    return { ...launched, window, app };
  } catch (error) {
    const context = { ...launched, window, app, branch, error };
    if (onSetupFailure) {
      try {
        await onSetupFailure(context);
      } catch {
        /* The original setup failure remains authoritative. */
      }
    } else if (ownsFreshSetup) {
      const workspaceIds = apps.map((id) => `demo-${id}`);
      await reportOwnedSetupFailure(context, error, {
        capture: defaultBoundary
          ? () =>
              captureDefaultPanelSetupEvidence(
                context,
                defaultBoundary,
                workspaceIds,
              )
          : undefined,
        close: (electronApp, userDataDir) =>
          closeCanopy(electronApp, userDataDir, {
            boundaryRecord: defaultBoundary?.record,
          }),
        record: defaultBoundary?.record,
      });
    }
    throw error;
  }
}

export { expandDefaultActivityRail };

/**
 * The VISIBLE chat panel content frame. Every open chat tab keeps its
 * `panel-content-chat` frame mounted (hidden-tab no-remount contract), so a
 * bare `getByTestId('panel-content-chat')` violates strict mode as soon as a
 * worktree has more than one chat tab; scope to the one actually shown.
 * Optionally pass `chatTabId` to address a specific bound panel
 * (`panel-chat-<chatTabId>`) instead of visibility.
 */
export function chatPanelLocator(page, chatTabId = null) {
  if (chatTabId !== null) {
    return page.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatTabId}"]`,
    );
  }
  return page.locator('[data-testid="panel-content-chat"]:visible');
}

/**
 * Reads the serialized layout of the visible worktree's grid, or `null` when
 * the test API is not installed (no worktree selected / non-E2E build).
 * Shape: `{ root, width, height, activeGroupId }` where `root` is a
 * leaf/branch tree (`SerializedPanelLayout`, doc-09 projection).
 */
export function getLayout(page) {
  return page.evaluate(
    () => window.__canopyPanelTestApi?.getSerializedLayout() ?? null,
  );
}

/**
 * Waits for the selected worktree's panel test seam and required groups to
 * expose one coherent serialized layout. Use this before reading geometry or
 * mutating layout immediately after navigation/reload.
 */
export async function waitForPanelLayout(
  page,
  { requiredGroupIds = [], timeout = 15_000 } = {},
) {
  let settledLayout = null;
  await expect
    .poll(
      async () => {
        const layout = await getLayout(page);
        const groupIds = new Set(
          layout ? collectLeaves(layout.root).map((leaf) => leaf.groupId) : [],
        );
        if (
          layout &&
          requiredGroupIds.every((groupId) => groupIds.has(groupId))
        ) {
          settledLayout = layout;
          return true;
        }
        return false;
      },
      { timeout },
    )
    .toBe(true);
  return settledLayout;
}

/** Flattens a serialized node tree into its leaves, in document order. */
export function collectLeaves(node) {
  if (!node) {
    return [];
  }
  if (node.type === 'leaf') {
    return [node];
  }
  return node.children.flatMap((child) => collectLeaves(child));
}

/** Counts the leaf groups of the visible worktree's grid. */
export async function countLeaves(page) {
  const layout = await getLayout(page);
  return layout ? collectLeaves(layout.root).length : 0;
}

/** The active (focused) group id, or `null`. */
export function getActiveGroupId(page) {
  return page.evaluate(
    () => window.__canopyPanelTestApi?.getActiveGroupId() ?? null,
  );
}

/**
 * Splits `groupId` in `direction` ('up' | 'down' | 'left' | 'right') via the
 * test API and returns the new group's id.
 */
export function splitViaApi(page, groupId, direction) {
  return page.evaluate(
    ([id, dir]) => {
      const api = window.__canopyPanelTestApi;
      if (!api) {
        throw new Error('__canopyPanelTestApi is not installed');
      }
      return api.splitPanel(id, dir);
    },
    [groupId, direction],
  );
}

/**
 * Moves `panelId` onto `targetGroupId` at `edge`
 * ('top' | 'bottom' | 'left' | 'right' | 'center') via the test API.
 */
export function movePanelViaApi(page, panelId, targetGroupId, edge) {
  return page.evaluate(
    ([id, target, dropEdge]) => {
      const api = window.__canopyPanelTestApi;
      if (!api) {
        throw new Error('__canopyPanelTestApi is not installed');
      }
      api.movePanel(id, target, dropEdge);
    },
    [panelId, targetGroupId, edge],
  );
}

/**
 * Creates a real browser through the preload API and places that exact browser
 * in the visible worktree through the E2E panel-placement bridge. Optionally
 * moves it to an explicit group and edge using the same layout operation as
 * DnD.
 */
export async function seedVisibleBrowserPanel(
  page,
  request,
  {
    originChatTabId = SEEDED_CHAT_TAB_ID,
    moveToGroupId,
    moveEdge = 'center',
  } = {},
) {
  const { browser, placed } = await page.evaluate(
    async ({ createRequest, chatTabId }) => {
      const api = window.__canopyPanelTestApi;
      if (!api) {
        throw new Error('__canopyPanelTestApi is not installed');
      }
      const browser = await api.createBrowser(createRequest);
      const placed = await api.requestBrowserPanel(browser.id, chatTabId);
      return { browser, placed };
    },
    { createRequest: request, chatTabId: originChatTabId },
  );
  const panelId = `panel-browser-${browser.id}`;
  if (!placed) {
    throw new Error(`Failed to place browser panel ${panelId}`);
  }
  if (moveToGroupId) {
    await movePanelViaApi(page, panelId, moveToGroupId, moveEdge);
  }
  return { browser, panelId };
}

/**
 * Spawns the first terminal in the terminal panel group and waits for the
 * xterm pane. A fresh unbound terminal panel shows only "Start terminal".
 */
export async function spawnPanelTerminal(window) {
  const expand = window.locator(
    `[data-testid="panel-group-expand-${DEFAULT_GROUP_IDS.terminal}"]:visible`,
  );
  if ((await expand.count()) > 0) {
    await expand.first().click();
  }

  const surface = window.getByTestId('terminal-panel-surface');
  await expect(surface).toBeVisible();

  const pane = window.getByTestId('terminal-pane');
  const startButton = surface.getByRole('button', {
    name: 'Start terminal',
    exact: true,
  });

  // Expanding the group now auto-starts an unbound terminal, so at this
  // instant the pane may be mid-spawn while the Start button has already
  // gone. A point-in-time `count()` on either locator races that handoff:
  // wait for whichever outcome actually materializes, and only click Start
  // if the button is the one that resolved. The fallback is kept so a
  // genuine spawn failure (which re-renders the empty state) still fails
  // loudly rather than hanging.
  // Keep the reason: swallowing it burns the full timeout and then fails on
  // the unrelated `toBeVisible` below, pointing triage at the wrong thing.
  let revealError;
  await Promise.race([
    pane.waitFor({ state: 'visible', timeout: 20_000 }),
    startButton.waitFor({ state: 'visible', timeout: 20_000 }),
  ]).catch((error) => {
    revealError = error;
  });
  if (revealError !== undefined) {
    throw new Error(
      `Terminal panel revealed neither a pane nor a Start terminal button: ${revealError}`,
    );
  }

  if ((await pane.count()) === 0 && (await startButton.count()) > 0) {
    // The workspace panel tab is the only terminal tab chrome.
    await startButton.click();
  }
  await expect(pane).toBeVisible({ timeout: 20_000 });
  return pane;
}

// Plan workspace panel helpers (plan-workspace-panels phases 03–06).
//
// A tracked plan opens as a `plan` document panel (`panel-plan-<planId>`) and
// can split its diagram into one `plan-diagram` panel
// (`panel-plan-diagram-<planId>`). Both are reached from Add Panel → Plans
// (`panel-add-panel-<groupId>` → `panel-add-menu` →
// `panel-add-menu-plans-submenu` → `panel-add-menu-item-plan-<planId>`; since
// phase 09 the submenu leads with All plans,
// `panel-add-menu-item-activity-card-plans`, and with no visible plan Plans is
// that one row), and
// since phase 06 every other plan entry point (the plan list, a chat's
// pending plan, the command palette, App Advisor, the Audit Trail) opens the
// same document panel.
//
// These helpers build on `panelHarness.mjs` without changing it (that harness
// is byte-pinned by the performance harness identity check): they seed
// tracked plans into the demo worktrees before launch (optionally in a
// Minimal layout or across two workspaces), drive the Plans submenu and App
// Advisor actions, read plan panels across the main layout and its auxiliary
// windows, and broadcast tracked-plan changes the way main does for writers
// outside the renderer (agents, pipelines, the portal).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { closePanelTab } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  expandDefaultActivityRail,
  getLayout,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
} from './panelHarness.mjs';
import {
  buildTrackedPlan,
  dataModelDiffFor,
  logicDiffFor,
  readyDiagramArtifacts,
  seedTrackedPlans,
  sequenceGraphFor,
} from './seeders/index.mjs';

/** The demo worktree `seedPanelWorktree()` selects. */
export const PLAN_PANEL_WORKSPACE_ID = 'demo-ts-pnpm-vite';
export const PLAN_PANEL_WORKTREE_ID = 'demo-main';
/**
 * The second demo workspace {@link seedPlanPanelWorkspaces} adds; its
 * worktree is also `PLAN_PANEL_WORKTREE_ID`, and it has no seeded chat.
 */
export const PLAN_PANEL_OTHER_WORKSPACE_ID = 'demo-ts-npm-next';

/**
 * The working copy of a demo-worktree plan that agents edit:
 * `workspaces/<workspace>/worktree-data/<worktree>/plan-explore/<planId>/plan.md`
 * under the app's data directory. Main writes it from the plan's latest
 * content when a chat message is sent with the plan active, and turns an
 * edited copy into one plan revision once the last turn in the worktree ends.
 */
export function planFilePath(userDataDir, planId) {
  return path.join(
    userDataDir,
    'workspaces',
    PLAN_PANEL_WORKSPACE_ID,
    'worktree-data',
    PLAN_PANEL_WORKTREE_ID,
    'plan-explore',
    planId,
    'plan.md',
  );
}

/**
 * Start recording every `tracked-plans:updated` event the main window
 * receives; read them back with {@link recordedTrackedPlanUpdates}.
 */
export function recordTrackedPlanUpdates(page) {
  return page.evaluate(() => {
    window.__planUpdateEvents = [];
    window.api.activity.onTrackedPlansUpdated((event) => {
      window.__planUpdateEvents.push(event);
    });
  });
}

/** The `tracked-plans:updated` events recorded so far, oldest first. */
export function recordedTrackedPlanUpdates(page) {
  return page.evaluate(() => window.__planUpdateEvents ?? []);
}

/** Deterministic id of a plan's document panel. */
export function planPanelId(planId) {
  return `panel-plan-${planId}`;
}

/** Deterministic id of a plan's split diagram panel. */
export function planDiagramPanelId(planId) {
  return `panel-plan-diagram-${planId}`;
}

/**
 * Build a tracked plan in the demo worktree (or `projectId`'s demo-main
 * worktree). `withDiagrams` seeds ready sequence/logic/data-model diagrams
 * for the current revision, so showing the diagram never asks an agent to
 * generate one. `latestRevisionNumber` adds earlier revisions ("Earlier
 * draft (revision N).") below the latest content; `summary` replaces the
 * latest content's first paragraph (`Plan body for <title>.`).
 *
 * @param {{
 *   id: string,
 *   title: string,
 *   updatedAt: string,
 *   hidden?: boolean,
 *   withDiagrams?: boolean,
 *   projectId?: string,
 *   latestRevisionNumber?: number,
 *   linkedExecutionIds?: string[],
 *   summary?: string,
 * }} options
 */
export function buildPanelPlan({
  id,
  title,
  updatedAt,
  hidden,
  withDiagrams = false,
  projectId = PLAN_PANEL_WORKSPACE_ID,
  latestRevisionNumber = 1,
  linkedExecutionIds = [],
  summary = `Plan body for ${title}.`,
}) {
  const sections = [
    {
      id: `${id}-phase-1`,
      title: 'Phase 1: Prepare',
      tasks: [
        { id: `${id}-task-1-1`, title: 'Seed the fixtures.' },
        { id: `${id}-task-1-2`, title: 'Record the baseline.' },
      ],
    },
    {
      id: `${id}-phase-2`,
      title: 'Phase 2: Ship',
      tasks: [{ id: `${id}-task-2-1`, title: 'Open the plan as a panel.' }],
    },
  ];
  const content = [
    `# ${title}`,
    '',
    summary,
    '',
    ...sections.flatMap((section) => [
      `## ${section.title}`,
      '',
      ...section.tasks.map((task) => `- ${task.title}`),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
  return buildTrackedPlan({
    id,
    projectId,
    worktreeId: PLAN_PANEL_WORKTREE_ID,
    title,
    content,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt,
    latestRevisionNumber,
    linkedExecutionIds,
    ...(hidden === undefined ? {} : { hidden }),
    ...(withDiagrams
      ? {
          diagrams: readyDiagramArtifacts({
            revision: latestRevisionNumber,
            generatedAt: updatedAt,
            sequence: sequenceGraphFor(sections, { planTitle: title }),
            logicDiff: logicDiffFor(sections),
            dataModelDiff: dataModelDiffFor([sections[0].id]),
          }),
        }
      : {}),
  });
}

/**
 * Merge `fields` into the chat tab `seedPanelWorktree()` seeded (for example
 * `{ interfaceMode: 'auto' }` for a terminal-backed Claude chat). Runs before
 * launch, while the chat is still in its legacy seeded file.
 */
function patchSeededChatTab(userDataDir, fields) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    PLAN_PANEL_WORKSPACE_ID,
    'chats',
    `${PLAN_PANEL_WORKTREE_ID}.json`,
  );
  const file = JSON.parse(readFileSync(filePath, 'utf8'));
  file.tabs = file.tabs.map((tab) =>
    tab.id === SEEDED_CHAT_TAB_ID ? { ...tab, ...fields } : tab,
  );
  writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');
}

/** Select the demo worktree's layout mode (`seedPanelWorktree` writes Advanced). */
function writeDemoLayoutMode(userDataDir, mode) {
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    PLAN_PANEL_WORKSPACE_ID,
    'worktree-data',
    PLAN_PANEL_WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode }),
    'utf8',
  );
}

/**
 * Seed `planSets` (`{ workspaceId, plans }`, each in that workspace's
 * demo-main worktree) and launch through `seedPanelWorktree()`. An Advanced
 * layout gets its activity rail expanded; a Minimal one keeps its seeded
 * (collapsed) Side Panel.
 */
async function launchWithPlans({
  planSets,
  chatTab,
  layoutMode = 'advanced',
  onBeforeLaunch,
  ...options
}) {
  let seedError;
  const launched = await seedPanelWorktree({
    ...options,
    onBeforeLaunch: (context) => {
      try {
        for (const { workspaceId, plans } of planSets) {
          seedTrackedPlans({
            userDataDir: context.userDataDir,
            workspaceId,
            worktreeId: PLAN_PANEL_WORKTREE_ID,
            plans,
          });
        }
        if (chatTab !== undefined) {
          patchSeededChatTab(context.userDataDir, chatTab);
        }
        if (layoutMode === 'minimal') {
          writeDemoLayoutMode(context.userDataDir, 'minimal');
        }
        onBeforeLaunch?.(context);
      } catch (error) {
        // seedPanelWorktree swallows hook errors; surface them after launch.
        seedError = error;
      }
    },
  });
  if (seedError !== undefined) {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    throw seedError;
  }
  if (layoutMode !== 'minimal') {
    await expandDefaultActivityRail(launched.window);
  }
  return launched;
}

/**
 * `seedPanelWorktree()` with `plans` seeded into the demo worktree before
 * launch, and the activity rail expanded so its group's chrome (and the
 * Plans section) is on screen. `chatTab` adds fields to the seeded chat tab;
 * `layoutMode: 'minimal'` launches the worktree in a Minimal layout (its
 * Side Panel, which holds the activity section, stays collapsed);
 * `onBeforeLaunch({ userDataDir, workspaceIds })` seeds anything else.
 * Returns the `seedPanelWorktree()` result.
 *
 * @param {{
 *   plans: object[],
 *   chatTab?: object,
 *   layoutMode?: 'advanced' | 'minimal',
 *   onBeforeLaunch?: (context: { userDataDir: string, workspaceIds: string[] }) => void,
 * } & Record<string, unknown>} options
 */
export function seedPlanPanelWorktree({ plans, ...options }) {
  return launchWithPlans({
    ...options,
    planSets: [{ workspaceId: PLAN_PANEL_WORKSPACE_ID, plans }],
  });
}

/**
 * {@link seedPlanPanelWorktree} across two demo workspaces: the demo worktree
 * (`PLAN_PANEL_WORKSPACE_ID`, selected, with the seeded chat) and
 * `PLAN_PANEL_OTHER_WORKSPACE_ID`'s demo-main worktree. `plansByWorkspace`
 * maps a workspace id to the plans seeded into its demo-main worktree.
 *
 * @param {{
 *   plansByWorkspace: Record<string, object[]>,
 *   chatTab?: object,
 *   onBeforeLaunch?: (context: { userDataDir: string, workspaceIds: string[] }) => void,
 * } & Record<string, unknown>} options
 */
export function seedPlanPanelWorkspaces({ plansByWorkspace, ...options }) {
  return launchWithPlans({
    ...options,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
    planSets: Object.entries(plansByWorkspace).map(([workspaceId, plans]) => ({
      workspaceId,
      plans,
    })),
  });
}

/**
 * Deliver one App Advisor action to the main window the way the Advisor's
 * tool bridge does (`app-advisor:tool-request`), and resolve with the
 * renderer's `app-advisor:tool-response` (`{ requestId, ok, result?,
 * error? }`).
 */
export function dispatchAdvisorAction(electronApp, requestId, action) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, request) => {
      const responseChannel = 'app-advisor:tool-response';
      const mainWindow = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return url !== 'about:blank' && !url.includes('surface=app-advisor');
      });
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor tool')),
          10_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== request.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send('app-advisor:tool-request', request);
      });
    },
    {
      kind: 'dispatch_action',
      requestId,
      originWorktreeId: 'e2e-advisor-entry',
      action,
    },
  );
}

/**
 * The group holding `planId`'s `kind` panel (`plan` by default) anywhere in
 * the selected worktree's layout family, or `null` when it is not open.
 */
export async function planGroupOf(electronApp, window, planId, kind = 'plan') {
  const panels = await familyPlanPanels(electronApp, window);
  return (
    panels.find((panel) => panel.kind === kind && panel.planId === planId)
      ?.groupId ?? null
  );
}

/**
 * Make main's next `dialog.showOpenDialog` resolve with `filePaths` (one
 * shot) instead of showing the native picker.
 */
export function stubOpenDialog(electronApp, filePaths) {
  return electronApp.evaluate(({ dialog }, paths) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: paths };
    };
  }, filePaths);
}

/** The document panel content frame of `planId`. */
export function planDocumentPanel(page, planId) {
  return page.locator(
    `[data-testid="panel-content-plan"][data-panel-id="${planPanelId(planId)}"]`,
  );
}

/** The split diagram panel content frame of `planId`. */
export function planDiagramPanel(page, planId) {
  return page.locator(
    `[data-testid="panel-content-plan-diagram"][data-panel-id="${planDiagramPanelId(planId)}"]`,
  );
}

/** Open the Add Panel menu of `groupId` in the main window `page`. */
export async function openAddPanelMenu(page, groupId) {
  await page.getByTestId(`panel-add-panel-${groupId}`).click();
  const menu = page.getByTestId('panel-add-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-group-id', groupId);
  return menu;
}

/** Open Add Panel → Plans for `groupId`; returns the submenu locator. */
export async function openPlansSubmenu(page, groupId) {
  await openAddPanelMenu(page, groupId);
  await page.getByTestId('panel-add-menu-plans-submenu').click();
  const submenu = page.getByTestId('panel-add-menu-plans-group');
  await expect(submenu).toBeVisible();
  return submenu;
}

/**
 * The Plans submenu's plan entries, in order, as `{ testId, label }` (the
 * leading All plans row is asserted on its own).
 */
export function plansSubmenuEntries(page) {
  return page
    .getByTestId('panel-add-menu-plans-group')
    .locator('[role="menuitem"][data-testid^="panel-add-menu-item-plan-"]')
    .evaluateAll((items) =>
      items.map((item) => ({
        testId: item.getAttribute('data-testid'),
        label: item.textContent ?? '',
      })),
    );
}

/** Add Panel → Plans → `planId` from `groupId`'s menu; the menu closes. */
export async function choosePlanFromMenu(page, groupId, planId) {
  await openPlansSubmenu(page, groupId);
  await page.getByTestId(`panel-add-menu-item-plan-${planId}`).click();
  await expect(page.getByTestId('panel-add-menu')).toHaveCount(0);
}

/** Dismiss an open Add Panel menu. */
export async function closeAddPanelMenu(page) {
  await page.keyboard.press('Escape');
  if ((await page.getByTestId('panel-add-menu').count()) > 0) {
    await page.keyboard.press('Escape');
  }
  await expect(page.getByTestId('panel-add-menu')).toHaveCount(0);
}

/** Close a panel tab through its tab-strip close button. */
export function closePlanTab(page, panelId) {
  return closePanelTab(page, panelId);
}

/** The open auxiliary panel windows (`about:blank` pages). */
export function auxPages(electronApp) {
  return electronApp.windows().filter((page) => page.url() === 'about:blank');
}

/** Wait for an auxiliary window to exist and show its panel root. */
export async function waitForAuxPage(electronApp, { timeout = 30_000 } = {}) {
  let aux;
  await expect
    .poll(
      () => {
        aux = auxPages(electronApp)[0];
        return aux !== undefined;
      },
      { timeout, message: 'an auxiliary panel window should open' },
    )
    .toBe(true);
  await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible({
    timeout,
  });
  return aux;
}

/** The auxiliary window id rendered by an aux page's root. */
export function auxWindowIdOf(aux) {
  return aux
    .getByTestId('panel-aux-window-root')
    .getAttribute('data-aux-window-id');
}

/** Pop out `groupId` of the main layout; resolves to the aux page. */
export async function popOutGroup(electronApp, window, groupId) {
  const opened = electronApp.waitForEvent('window');
  await window.evaluate(
    (id) => window.__canopyPanelTestApi.popOutPanel(id),
    groupId,
  );
  const aux = await opened;
  await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
  return aux;
}

/** OS-close every auxiliary window (merge-back semantics apply). */
export async function closeAuxWindows(electronApp) {
  const pages = auxPages(electronApp);
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL() === 'about:blank') win.close();
    }
  });
  for (const page of pages) {
    await expect.poll(() => page.isClosed()).toBe(true);
  }
}

function toPanelRecords(where, root) {
  return collectLeaves(root).flatMap((leaf) =>
    leaf.panels.map((panel) => ({
      where,
      groupId: leaf.groupId,
      panelId: panel.panelId,
      kind: panel.kind,
      planId: panel.instance?.planId,
      active: leaf.activePanelId === panel.panelId,
      maximized: leaf.maximized === true,
    })),
  );
}

/**
 * Every panel across the worktree's layout family: the main layout (`where:
 * 'main'`) plus each open auxiliary window (`where: <auxWindowId>`).
 */
export async function familyPanels(electronApp, window) {
  const main = await getLayout(window);
  const records = main ? toPanelRecords('main', main.root) : [];
  for (const aux of auxPages(electronApp)) {
    const auxWindowId = await auxWindowIdOf(aux);
    if (auxWindowId === null) continue;
    const file = await window.evaluate(
      (id) => window.__canopyPanelTestApi.getAuxSerializedLayout(id),
      auxWindowId,
    );
    records.push(...toPanelRecords(auxWindowId, file.grid.root));
  }
  return records;
}

/** The family's plan panels, as `{ where, groupId, panelId, kind, planId }`. */
export async function familyPlanPanels(electronApp, window) {
  return (await familyPanels(electronApp, window)).filter(
    (panel) => panel.kind === 'plan' || panel.kind === 'plan-diagram',
  );
}

/**
 * Update a tracked plan through the plans IPC, then deliver the
 * `tracked-plans:updated` event main sends for writers outside the renderer.
 * Resolves to the updated plan.
 */
export async function broadcastTrackedPlanUpdate(
  electronApp,
  window,
  planId,
  patch,
) {
  const request = {
    projectId: PLAN_PANEL_WORKSPACE_ID,
    worktreeId: PLAN_PANEL_WORKTREE_ID,
    planId,
    ...patch,
  };
  const plan = await window.evaluate(
    (updateRequest) => window.api.activity.plans.update(updateRequest),
    request,
  );
  if (plan === null) throw new Error(`Tracked plan ${planId} was not found`);
  await sendTrackedPlansUpdated(electronApp, {
    projectId: PLAN_PANEL_WORKSPACE_ID,
    worktreeId: PLAN_PANEL_WORKTREE_ID,
    plan,
  });
  return plan;
}

/** Delete a tracked plan and deliver main's removal event. */
export async function broadcastTrackedPlanRemoval(electronApp, window, planId) {
  const ref = {
    projectId: PLAN_PANEL_WORKSPACE_ID,
    worktreeId: PLAN_PANEL_WORKTREE_ID,
    planId,
  };
  await window.evaluate(
    (deleteRequest) => window.api.activity.plans.delete(deleteRequest),
    ref,
  );
  await sendTrackedPlansUpdated(electronApp, { ...ref, change: 'remove' });
}

function sendTrackedPlansUpdated(electronApp, event) {
  return electronApp.evaluate(({ BrowserWindow }, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.getURL() !== 'about:blank') {
        win.webContents.send('tracked-plans:updated', payload);
      }
    }
  }, event);
}

/** The retired Plan Explore takeover's sentinel chat project id. */
export const LEGACY_PLAN_CHAT_PROJECT_ID = 'plan-explore-chat';

function legacyPlanChatRegistryPath(userDataDir) {
  return path.join(userDataDir, 'plan-explore-chats', 'registry.json');
}

/**
 * Seed a dedicated plan chat left behind by the retired Plan Explore
 * takeover: its registry row (owned by `owner`, a `{ projectId, worktreeId }`
 * pair) and its legacy `plan-explore-chats/<planId>.json` tabs file, which
 * main migrates into canonical chat storage on first read.
 */
export function seedLegacyPlanChat({
  userDataDir,
  planId,
  owner,
  chatId,
  messages = [],
}) {
  const registryPath = legacyPlanChatRegistryPath(userDataDir);
  const targets = existsSync(registryPath)
    ? (JSON.parse(readFileSync(registryPath, 'utf8')).targets ?? {})
    : {};
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({ version: 1, targets: { ...targets, [planId]: owner } }),
  );
  const tab = {
    id: chatId,
    title: 'Legacy plan chat',
    providerType: 'claude',
    interfaceMode: 'canopy',
    thinkingLevel: 'off',
    createdAt: '2026-09-01T12:00:00.000Z',
    messages,
  };
  const tabsPath = path.join(
    userDataDir,
    'plan-explore-chats',
    `${planId}.json`,
  );
  writeFileSync(
    tabsPath,
    JSON.stringify({ version: 1, tabs: [tab], activeTabId: chatId }),
  );
  return { registryPath, tabsPath };
}

/** The registry row for a legacy plan chat, or `null`. */
export function legacyPlanChatOwner(userDataDir, planId) {
  const registryPath = legacyPlanChatRegistryPath(userDataDir);
  if (!existsSync(registryPath)) return null;
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  return registry.targets?.[planId] ?? null;
}

/**
 * Whether a legacy plan chat still exists: its registry row plus either its
 * legacy tabs file or its migrated canonical chat storage.
 */
export function legacyPlanChatExists(userDataDir, planId) {
  if (legacyPlanChatOwner(userDataDir, planId) === null) return false;
  return (
    existsSync(
      path.join(userDataDir, 'plan-explore-chats', `${planId}.json`),
    ) ||
    existsSync(
      path.join(userDataDir, 'chat-storage-v2', `plan-explore-chats-${planId}`),
    )
  );
}

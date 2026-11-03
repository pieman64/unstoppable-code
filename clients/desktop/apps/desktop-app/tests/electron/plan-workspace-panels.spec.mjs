// Plan workspace panels (plan-workspace-panels phases 03–06, verification
// P1–P14).
//
// Tracked plans open as normal workspace panels: a `plan` document panel per
// plan (`panel-plan-<planId>`) with Document and Diagram inner tabs, and an
// optional split `plan-diagram` panel (`panel-plan-diagram-<planId>`). Each
// kind/plan pair exists once across the worktree's layout family (main grid
// plus auxiliary windows). The split state is derived from the live layout:
// closing the diagram panel merges it back into the document's Diagram tab.
// Since phase 06 every plan entry point opens the document panel; the
// full-window plan takeover (`plan-explore-modal`) and its dedicated plan
// chat are gone.
//
// Flows (all headless; P9–P11 and P13 run an agent, against the mock LLM):
//   P1  A plan list row, a card's Explore, and a hidden plan's row open the
//       Plan panel (no takeover, no plan chat session or registry); the
//       worktree chat stays usable beside it.
//   P1b Main refuses a turn for a dedicated plan chat the retired takeover
//       left behind, whichever entry point sends it: no session starts and
//       its stored transcript is unchanged.
//   P2  Placement follows the side-open policy: a list open joins the chat's
//       reusable content group (the group a file mention opened); without
//       one, the first open splits a new group right of the chat and
//       collapses the full-height activity rail, and later opens reuse or
//       reveal that group (leaving a maximized group, expanding a collapsed
//       one). In a Minimal layout list opens go to the Side Panel.
//   P3  Add Panel → Plans creates the plan in the menu's group; the entry
//       stays listed; hidden plans are not listed.
//   P4  Choosing an open plan again reveals it (leaving a maximized group,
//       re-selecting its tab) and never duplicates it, including when it
//       lives in an auxiliary window. (Auxiliary windows have no Add Panel
//       menu of their own; their owner scoping is unit-tested.)
//   P5  Diagram inner tab → stage a note → Split → move → close the diagram:
//       the Diagram tab and Split return and the draft survives. Show diagram
//       and Show document appear only while the other split panel is off
//       screen (behind another tab, or hidden by a maximized group).
//   P6  Close the document while split → Add Panel recreates the document in
//       the menu's group and leaves the diagram where it is.
//   P7  Pop the diagram out → closing the window keeps the split; closing the
//       diagram tab in the window merges; relaunches reconcile the family,
//       and a layout file with invalid/duplicate/orphaned plan entries still
//       restores its unrelated groups.
//   P8  Rename/hide/unhide while the menu is open update it live; the submenu
//       leaves when every plan is hidden (also through the plan list's own
//       hide button); open panels stay intact; deleting a plan closes both
//       of its panels.
//   P9  Submit sends a plan panel's staged document and diagram-node comments
//       to the worktree's ordinary chat (the mock agent answers; no dedicated
//       plan chat is created). When the chat is a Claude terminal whose
//       launch fails, the comments stay pending with an error and no queued
//       copy is left behind. The shared-plan flows, refused sends, and the
//       agent's file-comment tool replies are in `plan-sharing.spec.mjs`.
//   P10 A message sent from the composer while a plan panel is active names
//       the plan's working copy (`planFilePath`) to the agent. The agent's
//       Bash edit of that file becomes no revision while its turn runs, even
//       when the panel forces a check, and exactly one agent revision once
//       the turn ends: stale diagrams, an outdated comment thread, and the
//       panel on the new revision.
//   P11 An edit made after the plan's panel closed and another plan became
//       active still becomes one revision of the plan the turn was sent
//       with; the other plan is never materialized or named to the agent.
//   In P10/P11 the mock agent runs a real Bash command (so the chat is put in
//   full-access mode) that waits for a gate file the test creates, which
//   decides when the turn ends.
//   P13 The Plan panel header's follow-ups on an older revision: Share is
//       disabled with its guidance, Implement sends the latest plan to the
//       worktree chat and keeps the panel, a linked run opens its details
//       with the panel still in the layout, and the actions stay reachable
//       in a narrow window.
//   Plan panel search goes through the shared find bar; see
//   `find-plan-and-diagram.spec.mjs`.
//   P17 Implement shows the receiving chat as soon as it is chosen (leaving a
//       maximize), while the send is still held, and never moves focus again
//       when the send settles.
//   P18 Plans is its own Add Panel entry: a submenu led by All plans (which
//       opens or reveals the plans list) when plans are visible, else one
//       Plans row; Activity no longer lists it.
//   P14 The other entry points open the same panel: a chat's pending plan
//       (created on demand, beside that chat), the command palette and App
//       Advisor (both switching to the owning worktree first), Advisor
//       `panel.add_tab` for plan and diagram panels, and Audit Trail
//       Inspect; the retired plan-chat Advisor actions are refused.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';
import {
  chatPanelLocator,
  collectLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  expandDefaultActivityRail,
  getActiveGroupId,
  getLayout,
  movePanelViaApi,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  splitViaApi,
} from './panelHarness.mjs';
import {
  broadcastTrackedPlanRemoval,
  broadcastTrackedPlanUpdate,
  buildPanelPlan,
  choosePlanFromMenu,
  closeAddPanelMenu,
  closeAuxWindows,
  closePlanTab,
  dispatchAdvisorAction,
  familyPlanPanels,
  LEGACY_PLAN_CHAT_PROJECT_ID,
  openAddPanelMenu,
  openPlansSubmenu,
  planDiagramPanel,
  planDiagramPanelId,
  planDocumentPanel,
  planFilePath,
  planGroupOf,
  planPanelId,
  PLAN_PANEL_OTHER_WORKSPACE_ID,
  PLAN_PANEL_WORKSPACE_ID,
  PLAN_PANEL_WORKTREE_ID,
  plansSubmenuEntries,
  popOutGroup,
  recordedTrackedPlanUpdates,
  recordTrackedPlanUpdates,
  seedLegacyPlanChat,
  seedPlanPanelWorkspaces,
  seedPlanPanelWorktree,
  waitForAuxPage,
} from './planPanelHarness.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
} from './pipelineUi.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  buildPlanCommentThread,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  diagramNodeAnchor,
  documentAnchor,
  getScenarioActivity,
  registerScenario,
  seedObservabilityAudit,
  seedPipelineExecution,
  seedStoredPipeline,
  userComment,
} from './seeders/index.mjs';

const ROADMAP = 'plan-roadmap';
const ROADMAP_TITLE = 'Ship plan panels';
const IMPORTER = 'plan-importer';
const IMPORTER_TITLE = 'Rewrite the importer';
const ARCHIVED = 'plan-archived';
const ARCHIVED_TITLE = 'Old full-window notes';
const NOTE = 'Check the Minimal layout before we reuse groups.';

/** Plan-list order is newest first: roadmap, importer, then the hidden one. */
function seededPlans() {
  return [
    buildPanelPlan({
      id: ROADMAP,
      title: ROADMAP_TITLE,
      updatedAt: '2026-06-03T00:00:00.000Z',
      withDiagrams: true,
    }),
    buildPanelPlan({
      id: IMPORTER,
      title: IMPORTER_TITLE,
      updatedAt: '2026-06-02T00:00:00.000Z',
    }),
    buildPanelPlan({
      id: ARCHIVED,
      title: ARCHIVED_TITLE,
      updatedAt: '2026-06-01T00:00:00.000Z',
      hidden: true,
    }),
  ];
}

function planEntry(planId, label) {
  return { testId: `panel-add-menu-item-plan-${planId}`, label };
}

/** Sorted `where:groupId:kind:planId` lines for exact family assertions. */
async function planPanelSummary(electronApp, window) {
  const panels = await familyPlanPanels(electronApp, window);
  return panels
    .map((panel) =>
      [
        panel.where === 'main' ? 'main' : 'aux',
        panel.groupId,
        panel.kind,
        panel.planId,
        panel.panelId,
      ].join(':'),
    )
    .sort();
}

function summaryLine(where, groupId, kind, planId) {
  const panelId =
    kind === 'plan' ? planPanelId(planId) : planDiagramPanelId(planId);
  return [where, groupId, kind, planId, panelId].join(':');
}

async function findPlanPanel(electronApp, window, kind, planId) {
  const panels = await familyPlanPanels(electronApp, window);
  return (
    panels.find((panel) => panel.kind === kind && panel.planId === planId) ??
    null
  );
}

async function mainLeaf(window, groupId) {
  const layout = await getLayout(window);
  return (
    collectLeaves(layout?.root).find((leaf) => leaf.groupId === groupId) ?? null
  );
}

async function maximizedGroupIds(window) {
  const layout = await getLayout(window);
  return collectLeaves(layout?.root)
    .filter((leaf) => leaf.maximized)
    .map((leaf) => leaf.groupId);
}

/** Ready sequence diagram nodes inside `scope`. */
function sequenceNodes(scope) {
  return scope
    .getByTestId('plan-sequence-diagram')
    .locator('.react-flow__node');
}

function layoutFilePath(userDataDir) {
  return path.join(
    userDataDir,
    'workspaces',
    PLAN_PANEL_WORKSPACE_ID,
    'worktree-data',
    PLAN_PANEL_WORKTREE_ID,
    'panel-layout.json',
  );
}

function findPersistedLeaf(node, groupId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.groupId === groupId ? node : null;
  for (const child of node.children ?? []) {
    const found = findPersistedLeaf(child, groupId);
    if (found) return found;
  }
  return null;
}

function persistedGroupIds(node) {
  return collectLeaves(node).map((leaf) => leaf.groupId);
}

// --- P1/P2/P13/P14 helpers ---------------------------------------------------

const DEFAULT_GROUP_ID_SET = new Set(Object.values(DEFAULT_GROUP_IDS));
/** Minimal layouts' Side Panel, which also hosts the activity section. */
const MINIMAL_SIDE_GROUP_ID = 'group-extras';

/**
 * The leaf directly right of `groupId` in a left-to-right (horizontal)
 * branch of the test-API layout, or `null` when there is none.
 */
function rightNeighborOf(node, groupId) {
  if (!node || node.type === 'leaf') return null;
  const index = node.children.findIndex(
    (child) => child.type === 'leaf' && child.groupId === groupId,
  );
  if (index !== -1 && node.orientation === 'horizontal') {
    const next = node.children[index + 1];
    return next?.type === 'leaf' ? next.groupId : null;
  }
  for (const child of node.children) {
    const found = rightNeighborOf(child, groupId);
    if (found !== null) return found;
  }
  return null;
}

async function rightNeighborOfChat(window) {
  const layout = await getLayout(window);
  return rightNeighborOf(layout?.root, DEFAULT_GROUP_IDS.chat);
}

async function mainGroupIds(window) {
  const layout = await getLayout(window);
  return collectLeaves(layout?.root).map((leaf) => leaf.groupId);
}

/** A plan list row in the main window's plan list. */
function planRow(window, planId) {
  return window.getByTestId(`activity-plan-row-${planId}`);
}

/** The full-window plan takeover retired in phase 06 never mounts. */
async function expectNoTakeover(window) {
  await expect(window.getByTestId('plan-explore-modal')).toHaveCount(0);
}

/** Live chat sessions in the retired takeover's dedicated plan chat scope. */
async function legacyPlanChatSessions(window, planId) {
  const result = await window.evaluate(
    (scope) => window.api.chat.activeSessions(scope),
    { projectId: LEGACY_PLAN_CHAT_PROJECT_ID, worktreeId: planId },
  );
  return result?.sessions ?? [];
}

/**
 * A legacy plan chat's stored transcript: its legacy tabs file and every
 * canonical transcript file, by relative path. Unchanged means no turn ran.
 */
function legacyPlanChatTranscript(userDataDir, planId) {
  const files = {};
  const legacyTabs = path.join(
    userDataDir,
    'plan-explore-chats',
    `${planId}.json`,
  );
  if (existsSync(legacyTabs)) {
    files['plan-explore-chats'] = readFileSync(legacyTabs, 'utf8');
  }
  const transcripts = path.join(
    userDataDir,
    'chat-storage-v2',
    `plan-explore-chats-${planId}`,
    'transcripts',
  );
  if (existsSync(transcripts)) {
    const entries = readdirSync(transcripts, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(entry.parentPath, entry.name);
      files[`transcripts/${path.relative(transcripts, filePath)}`] =
        readFileSync(filePath, 'utf8');
    }
  }
  return files;
}

/**
 * Open Plans from the Minimal Side Panel's empty-state picker.
 */
async function showMinimalActivity(window) {
  const group = window.getByTestId(`panel-group-${MINIMAL_SIDE_GROUP_ID}`);
  if (!(await group.isVisible())) {
    await window.getByTestId('workspace-layout-side-panel-toggle').click();
  }
  await group.getByTestId('side-panel-empty-item-plans').click();
  await expect(window.getByTestId('activity-plans-section')).toBeVisible({
    timeout: 30_000,
  });
  return (await mainLeaf(window, MINIMAL_SIDE_GROUP_ID)).activePanelId;
}

/** The selected sidebar worktree row of `workspaceId`'s demo-main worktree. */
function selectedWorktreeRow(window, workspaceId) {
  return window.locator(
    `[data-sidebar-selected-item] [data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${PLAN_PANEL_WORKTREE_ID}"]`,
  );
}

function isInside(inner, outer) {
  return (
    inner !== null &&
    outer !== null &&
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

// --- P1/P2: the plan list opens the Plan panel -------------------------------

test('P1: plan list rows and Explore open the Plan panel, with no takeover or plan chat', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    await planRow(window, ROADMAP).click();
    const roadmap = planDocumentPanel(window, ROADMAP);
    const roadmapView = roadmap.getByTestId('plan-panel-view');
    await expect(roadmapView).toHaveAttribute('data-plan-id', ROADMAP);
    await expect(roadmapView).toHaveAttribute(
      'data-plan-inner-tab',
      'document',
    );
    await expect(roadmap.getByTestId('plan-explore-plan-panel')).toContainText(
      `Plan body for ${ROADMAP_TITLE}.`,
    );
    await expect(
      window.getByTestId(`panel-tab-${planPanelId(ROADMAP)}`),
    ).toContainText(ROADMAP_TITLE);
    await expectNoTakeover(window);
    const roadmapGroupId = await planGroupOf(electronApp, window, ROADMAP);
    expect(await planPanelSummary(electronApp, window)).toEqual([
      summaryLine('main', roadmapGroupId, 'plan', ROADMAP),
    ]);

    // No dedicated plan chat exists: no session in the legacy plan-chat
    // scope and no plan-chat registry on disk.
    expect(await legacyPlanChatSessions(window, ROADMAP)).toEqual([]);
    expect(
      existsSync(path.join(userDataDir, 'plan-explore-chats', 'registry.json')),
    ).toBe(false);

    // The worktree's own chat stays on screen and usable beside the plan.
    const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(chat).toBeVisible();
    const composer = chat.getByRole('textbox').first();
    await composer.fill('Discuss the plan here.');
    await expect(composer).toContainText('Discuss the plan here.');

    // A card's Explore opens its plan the same way (the list rail reopens
    // first: the first open collapsed it to make room beside the chat).
    await expandDefaultActivityRail(window);
    await window.getByTestId(`activity-plan-${IMPORTER}-explore`).click();
    await expect(
      planDocumentPanel(window, IMPORTER).getByTestId('plan-panel-view'),
    ).toHaveAttribute('data-plan-id', IMPORTER);
    await expectNoTakeover(window);

    // Hidden plans open normally from the hidden list.
    await window.getByTestId('activity-plans-hidden-toggle').click();
    await planRow(window, ARCHIVED).click();
    const archived = planDocumentPanel(window, ARCHIVED);
    await expect(archived.getByTestId('plan-explore-plan-panel')).toContainText(
      `Plan body for ${ARCHIVED_TITLE}.`,
    );
    await expectNoTakeover(window);
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', roadmapGroupId, 'plan', ROADMAP),
        summaryLine('main', roadmapGroupId, 'plan', IMPORTER),
        summaryLine('main', roadmapGroupId, 'plan', ARCHIVED),
      ].sort(),
    );
    expect(await legacyPlanChatSessions(window, IMPORTER)).toEqual([]);
    expect(await legacyPlanChatSessions(window, ARCHIVED)).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P1b: main refuses a turn for a legacy plan chat', async () => {
  test.setTimeout(120_000);
  const legacyChatId = 'legacy-plan-chat';
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
    onBeforeLaunch: ({ userDataDir: dataDir }) => {
      seedLegacyPlanChat({
        userDataDir: dataDir,
        planId: ROADMAP,
        owner: {
          projectId: PLAN_PANEL_WORKSPACE_ID,
          worktreeId: PLAN_PANEL_WORKTREE_ID,
        },
        chatId: legacyChatId,
        messages: [
          {
            id: 'legacy-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Tighten the rollout step.' }],
            timestamp: Date.parse('2026-09-01T12:00:00.000Z'),
          },
          {
            id: 'legacy-assistant-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Rollout step tightened.' }],
            timestamp: Date.parse('2026-09-01T12:00:05.000Z'),
          },
        ],
      });
    },
  });

  try {
    const before = legacyPlanChatTranscript(userDataDir, ROADMAP);
    // Every entry point (the portal, automations, resume, queue drains)
    // reaches main's dispatch; the renderer guard is not the only line.
    const outcome = await window.evaluate(
      async (request) => {
        try {
          const result = await window.api.chat.sendMessage(request);
          return { resolved: result ?? null };
        } catch (error) {
          return { rejected: String(error) };
        }
      },
      {
        projectId: LEGACY_PLAN_CHAT_PROJECT_ID,
        worktreeId: ROADMAP,
        chatId: legacyChatId,
        userMessageId: 'probe-1',
        text: 'probe',
      },
    );
    expect(outcome).toEqual({
      rejected: expect.stringMatching(/This plan chat is no longer available/),
    });
    expect(await legacyPlanChatSessions(window, ROADMAP)).toEqual([]);
    expect(legacyPlanChatTranscript(userDataDir, ROADMAP)).toEqual(before);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P2: a list open joins the content group a file mention opened beside the chat', async () => {
  test.setTimeout(180_000);
  const mentionedFile = 'README.md';
  const { electronApp, userDataDir, window, demoSeed } =
    await seedPlanPanelWorktree({
      plans: seededPlans(),
      chatTab: {
        messages: [
          {
            id: 'p2-mention-assistant',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: `**Open ${mentionedFile}** before the plan review.`,
              },
            ],
            timestamp: Date.parse('2026-06-03T12:00:00.000Z'),
          },
        ],
      },
    });

  try {
    const worktreePath = demoSeed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    const filePath = path.join(worktreePath, mentionedFile);
    const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    const mention = chat.getByRole('button', {
      name: `Open ${mentionedFile}`,
    });
    await expect(mention).toBeVisible({ timeout: 30_000 });
    await mention.click();

    // The file opens in a content group right of the chat.
    let fileGroupId = null;
    await expect
      .poll(
        async () => {
          const layout = await getLayout(window);
          fileGroupId =
            collectLeaves(layout?.root).find((leaf) =>
              leaf.panels.some(
                (panel) =>
                  panel.kind === 'file-diff' &&
                  panel.instance?.filePath === filePath,
              ),
            )?.groupId ?? null;
          return fileGroupId;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();
    expect(DEFAULT_GROUP_ID_SET.has(fileGroupId)).toBe(false);
    expect(await rightNeighborOfChat(window)).toBe(fileGroupId);

    // The plan joins that group rather than splitting another one.
    await expandDefaultActivityRail(window);
    const groupsBefore = await mainGroupIds(window);
    await planRow(window, ROADMAP).click();
    await expect(
      planDocumentPanel(window, ROADMAP).getByTestId('plan-panel-view'),
    ).toBeVisible();
    expect(await planGroupOf(electronApp, window, ROADMAP)).toBe(fileGroupId);
    expect(await mainLeaf(window, fileGroupId)).toMatchObject({
      activePanelId: planPanelId(ROADMAP),
    });
    expect(await mainGroupIds(window)).toEqual(groupsBefore);
    await expectNoTakeover(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P2: the first list open splits beside the chat; later opens reuse or reveal that group', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    // No content group yet: a new group opens right of the chat, and the
    // full-height activity rail collapses to make room (side-open policy).
    await planRow(window, ROADMAP).click();
    const roadmapView = planDocumentPanel(window, ROADMAP).getByTestId(
      'plan-panel-view',
    );
    await expect(roadmapView).toBeVisible();
    const planGroupId = await planGroupOf(electronApp, window, ROADMAP);
    expect(planGroupId).not.toBeNull();
    expect(DEFAULT_GROUP_ID_SET.has(planGroupId)).toBe(false);
    expect(await rightNeighborOfChat(window)).toBe(planGroupId);
    expect(
      (await mainLeaf(window, DEFAULT_GROUP_IDS.activity))?.collapsed,
    ).toBe('right');
    const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(chat).toBeVisible();
    const chatBox = await chat.boundingBox();
    const planBox = await window
      .getByTestId(`panel-group-${planGroupId}`)
      .boundingBox();
    expect(planBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 2);
    await expectNoTakeover(window);

    // The next plan reuses that group; the rail stays open.
    await expandDefaultActivityRail(window);
    await planRow(window, IMPORTER).click();
    await expect(
      planDocumentPanel(window, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', planGroupId, 'plan', ROADMAP),
        summaryLine('main', planGroupId, 'plan', IMPORTER),
      ].sort(),
    );
    expect(await mainLeaf(window, planGroupId)).toMatchObject({
      activePanelId: planPanelId(IMPORTER),
    });
    expect(
      (await mainLeaf(window, DEFAULT_GROUP_IDS.activity))?.collapsed,
    ).toBeNull();

    // An open plan is revealed in place, leaving a maximized group (here the
    // group holding the plan list itself).
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, true),
      DEFAULT_GROUP_IDS.activity,
    );
    await expect
      .poll(() => maximizedGroupIds(window))
      .toEqual([DEFAULT_GROUP_IDS.activity]);
    await planRow(window, ROADMAP).click();
    await expect.poll(() => maximizedGroupIds(window)).toEqual([]);
    expect(await mainLeaf(window, planGroupId)).toMatchObject({
      activePanelId: planPanelId(ROADMAP),
    });
    await expect(roadmapView).toBeVisible();

    // A collapsed plan group expands to reveal the plan.
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      planGroupId,
    );
    await expect
      .poll(async () => (await mainLeaf(window, planGroupId))?.collapsed)
      .not.toBeNull();
    await planRow(window, IMPORTER).click();
    await expect
      .poll(async () => (await mainLeaf(window, planGroupId))?.collapsed)
      .toBeNull();
    expect(await mainLeaf(window, planGroupId)).toMatchObject({
      activePanelId: planPanelId(IMPORTER),
    });
    await expect(
      planDocumentPanel(window, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', planGroupId, 'plan', ROADMAP),
        summaryLine('main', planGroupId, 'plan', IMPORTER),
      ].sort(),
    );
    await expectNoTakeover(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P2: in a Minimal layout, plan list opens go to the Side Panel', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
    layoutMode: 'minimal',
  });

  try {
    const groupsBefore = (await mainGroupIds(window)).sort();
    expect(groupsBefore).toEqual(
      [
        DEFAULT_GROUP_IDS.chat,
        DEFAULT_GROUP_IDS.terminal,
        MINIMAL_SIDE_GROUP_ID,
      ].sort(),
    );
    const plansPanelId = await showMinimalActivity(window);

    await planRow(window, ROADMAP).click();
    await expect(
      planDocumentPanel(window, ROADMAP).getByTestId('plan-panel-view'),
    ).toBeVisible();
    expect(await planGroupOf(electronApp, window, ROADMAP)).toBe(
      MINIMAL_SIDE_GROUP_ID,
    );
    expect(await mainLeaf(window, MINIMAL_SIDE_GROUP_ID)).toMatchObject({
      activePanelId: planPanelId(ROADMAP),
    });
    // Minimal's fixed topology never splits.
    expect((await mainGroupIds(window)).sort()).toEqual(groupsBefore);
    await expectNoTakeover(window);

    await window.getByTestId(`panel-tab-${plansPanelId}`).click();
    await planRow(window, IMPORTER).click();
    await expect(
      planDocumentPanel(window, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', MINIMAL_SIDE_GROUP_ID, 'plan', ROADMAP),
        summaryLine('main', MINIMAL_SIDE_GROUP_ID, 'plan', IMPORTER),
      ].sort(),
    );
    expect((await mainGroupIds(window)).sort()).toEqual(groupsBefore);
    await expectNoTakeover(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P3/P4: Add Panel → Plans creates the plan in its group and reveals it without duplicates', async () => {
  test.setTimeout(240_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    // --- P3: create in the menu's group -----------------------------------
    await openPlansSubmenu(window, DEFAULT_GROUP_IDS.activity);
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([
        planEntry(ROADMAP, ROADMAP_TITLE),
        planEntry(IMPORTER, IMPORTER_TITLE),
      ]);
    await expect(
      window.getByTestId(`panel-add-menu-item-plan-${ARCHIVED}`),
    ).toHaveCount(0);
    await window.getByTestId(`panel-add-menu-item-plan-${IMPORTER}`).click();
    await expect(window.getByTestId('panel-add-menu')).toHaveCount(0);

    const importer = planDocumentPanel(window, IMPORTER);
    const importerView = importer.getByTestId('plan-panel-view');
    await expect(importerView).toHaveAttribute('data-plan-id', IMPORTER);
    await expect(importerView).toHaveAttribute(
      'data-plan-inner-tab',
      'document',
    );
    await expect(importer.getByTestId('plan-explore-plan-panel')).toContainText(
      `Plan body for ${IMPORTER_TITLE}.`,
    );
    await expect(
      window.getByTestId(`panel-tab-${planPanelId(IMPORTER)}`),
    ).toContainText(IMPORTER_TITLE);
    expect(await planPanelSummary(electronApp, window)).toEqual([
      summaryLine('main', DEFAULT_GROUP_IDS.activity, 'plan', IMPORTER),
    ]);
    expect(await mainLeaf(window, DEFAULT_GROUP_IDS.activity)).toMatchObject({
      activePanelId: planPanelId(IMPORTER),
    });

    // The open plan stays listed: the menu is an open-or-reveal catalog.
    await openPlansSubmenu(window, DEFAULT_GROUP_IDS.activity);
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([
        planEntry(ROADMAP, ROADMAP_TITLE),
        planEntry(IMPORTER, IMPORTER_TITLE),
      ]);
    await closeAddPanelMenu(window);

    // --- P4: reveal from another group while a group is maximized ----------
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.activity}`).click();
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, true),
      DEFAULT_GROUP_IDS.chat,
    );
    await expect
      .poll(() => maximizedGroupIds(window))
      .toEqual([DEFAULT_GROUP_IDS.chat]);

    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, IMPORTER);
    await expect.poll(() => maximizedGroupIds(window)).toEqual([]);
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.activity);
    expect(await mainLeaf(window, DEFAULT_GROUP_IDS.activity)).toMatchObject({
      activePanelId: planPanelId(IMPORTER),
    });
    await expect(importerView).toBeVisible();

    // Selecting it again from the same menu is still a reveal.
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, IMPORTER);
    expect(await planPanelSummary(electronApp, window)).toEqual([
      summaryLine('main', DEFAULT_GROUP_IDS.activity, 'plan', IMPORTER),
    ]);

    // --- P4: one instance across the family, including a popped-out plan --
    const planGroupId = await splitViaApi(
      window,
      DEFAULT_GROUP_IDS.chat,
      'right',
    );
    await movePanelViaApi(window, planPanelId(IMPORTER), planGroupId, 'center');
    await expect
      .poll(() => planPanelSummary(electronApp, window))
      .toEqual([summaryLine('main', planGroupId, 'plan', IMPORTER)]);
    const aux = await popOutGroup(electronApp, window, planGroupId);
    await expect(
      planDocumentPanel(aux, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();

    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, IMPORTER);
    await expect(planDocumentPanel(window, IMPORTER)).toHaveCount(0);
    expect(await planPanelSummary(electronApp, window)).toEqual([
      summaryLine('aux', planGroupId, 'plan', IMPORTER),
    ]);
    await expect(
      planDocumentPanel(aux, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P5/P6: split, move, and close the diagram; Add Panel reasserts a closed document', async () => {
  test.setTimeout(240_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, ROADMAP);
    const doc = planDocumentPanel(window, ROADMAP);
    const view = doc.getByTestId('plan-panel-view');
    const tray = doc.getByTestId('plan-explore-comments-tray');
    await expect(view).toHaveAttribute('data-plan-inner-tab', 'document');

    // --- P5: stage a note, look at the Diagram tab, then split ------------
    await doc.getByTestId('plan-comment-add-note').click();
    await doc.getByTestId('plan-comment-note-input').fill(NOTE);
    await doc.getByTestId('plan-comment-note-save').click();
    await expect(tray).toContainText(NOTE);

    await doc.getByTestId('plan-panel-tab-diagram').click();
    await expect(view).toHaveAttribute('data-plan-inner-tab', 'diagram');
    await expect(sequenceNodes(doc)).not.toHaveCount(0);

    await doc.getByTestId('plan-panel-split').click();
    const diagram = planDiagramPanel(window, ROADMAP);
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();
    await expect(sequenceNodes(diagram)).not.toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-${planDiagramPanelId(ROADMAP)}`),
    ).toContainText(`${ROADMAP_TITLE} (Diagram)`);
    // The document keeps its identity and shows only its Document tab. Both
    // panels are on screen, so neither offers to show the other.
    await expect(view).toHaveAttribute('data-plan-inner-tab', 'document');
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-split')).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-show-diagram')).toHaveCount(0);
    await expect(diagram.getByTestId('plan-diagram-show-document')).toHaveCount(
      0,
    );
    await expect(tray).toContainText(NOTE);

    const split = await findPlanPanel(
      electronApp,
      window,
      'plan-diagram',
      ROADMAP,
    );
    expect(split?.groupId).not.toBe(DEFAULT_GROUP_IDS.chat);
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
        summaryLine('main', split.groupId, 'plan-diagram', ROADMAP),
      ].sort(),
    );
    // The diagram opened beside (to the right of) the document.
    const docBox = await doc.boundingBox();
    const diagramBox = await diagram.boundingBox();
    expect(diagramBox.x).toBeGreaterThanOrEqual(docBox.x + docBox.width - 2);

    // With the document behind the chat tab, the diagram offers Show
    // document, which brings the document's tab forward again.
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`).click();
    await expect(view).toBeHidden();
    await diagram.getByTestId('plan-diagram-show-document').click();
    await expect(view).toBeVisible();
    await expect(diagram.getByTestId('plan-diagram-show-document')).toHaveCount(
      0,
    );

    // Maximizing the document's group (Cmd/Ctrl+Shift+F) hides the diagram,
    // so the document offers Show diagram, which leaves the maximize and
    // brings the split diagram forward.
    await window.getByTestId(`panel-tab-${planPanelId(ROADMAP)}`).click();
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.chat);
    await window.keyboard.press('ControlOrMeta+Shift+F');
    await expect
      .poll(() => maximizedGroupIds(window))
      .toEqual([DEFAULT_GROUP_IDS.chat]);
    // Cmd/Ctrl+Shift+F belongs to maximize, not the find bar.
    await expect(window.getByTestId('surface-find-bar')).toHaveCount(0);
    await doc.getByTestId('plan-panel-show-diagram').click();
    await expect.poll(() => getActiveGroupId(window)).toBe(split.groupId);
    await expect.poll(() => maximizedGroupIds(window)).toEqual([]);
    await expect(doc.getByTestId('plan-panel-show-diagram')).toHaveCount(0);

    // Moving the diagram keeps the plan split.
    await movePanelViaApi(
      window,
      planDiagramPanelId(ROADMAP),
      DEFAULT_GROUP_IDS.activity,
      'center',
    );
    await expect
      .poll(() => planPanelSummary(electronApp, window))
      .toEqual(
        [
          summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
          summaryLine(
            'main',
            DEFAULT_GROUP_IDS.activity,
            'plan-diagram',
            ROADMAP,
          ),
        ].sort(),
      );
    // Behind another tab of its new group, the diagram is off screen.
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.activity}`).click();
    await expect(diagram).toBeHidden();
    await expect(doc.getByTestId('plan-panel-show-diagram')).toBeVisible();

    // Closing the diagram tab merges it back into the document.
    await closePlanTab(window, planDiagramPanelId(ROADMAP));
    await expect(diagram).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toBeVisible();
    await expect(doc.getByTestId('plan-panel-split')).toBeVisible();
    await expect(doc.getByTestId('plan-panel-show-diagram')).toHaveCount(0);
    await expect(view).toHaveAttribute('data-plan-inner-tab', 'document');
    await expect(tray).toContainText(NOTE);
    expect(await planPanelSummary(electronApp, window)).toEqual([
      summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
    ]);

    // --- P6: close the document while split, then reassert it -------------
    await doc.getByTestId('plan-panel-split').click();
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();
    const diagramBefore = await findPlanPanel(
      electronApp,
      window,
      'plan-diagram',
      ROADMAP,
    );
    expect(diagramBefore?.groupId).not.toBe(DEFAULT_GROUP_IDS.chat);

    await closePlanTab(window, planPanelId(ROADMAP));
    await expect(doc).toHaveCount(0);
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();

    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, ROADMAP);
    await expect(view).toBeVisible();
    // Still split, with the diagram on screen beside it.
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-show-diagram')).toHaveCount(0);
    await expect(tray).toContainText(NOTE);
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', DEFAULT_GROUP_IDS.activity, 'plan', ROADMAP),
        summaryLine('main', diagramBefore.groupId, 'plan-diagram', ROADMAP),
      ].sort(),
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P7: a popped-out diagram keeps the split when its window closes and merges when its tab closes', async () => {
  test.setTimeout(240_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, ROADMAP);
    const doc = planDocumentPanel(window, ROADMAP);
    await doc.getByTestId('plan-panel-split').click();
    await expect(
      planDiagramPanel(window, ROADMAP).getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();
    const split = await findPlanPanel(
      electronApp,
      window,
      'plan-diagram',
      ROADMAP,
    );

    // Pop the diagram out: it renders in its own window and the document
    // still knows its diagram is split.
    const aux = await popOutGroup(electronApp, window, split.groupId);
    const auxDiagram = planDiagramPanel(aux, ROADMAP);
    await expect(
      auxDiagram.getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();
    await expect(sequenceNodes(auxDiagram)).not.toHaveCount(0);
    // The popped-out diagram is on screen in its window.
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-show-diagram')).toHaveCount(0);
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
        summaryLine('aux', split.groupId, 'plan-diagram', ROADMAP),
      ].sort(),
    );

    // Choosing the plan again re-selects the document tab and leaves the
    // popped-out diagram where it is.
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`).click();
    await expect(doc.getByTestId('plan-panel-view')).toBeHidden();
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, ROADMAP);
    await expect(doc.getByTestId('plan-panel-view')).toBeVisible();
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toHaveCount(0);
    await expect(
      auxDiagram.getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
        summaryLine('aux', split.groupId, 'plan-diagram', ROADMAP),
      ].sort(),
    );

    // Closing the window merges its tabs back: the plan stays split.
    await closeAuxWindows(electronApp);
    await expect(
      planDiagramPanel(window, ROADMAP).getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toHaveCount(0);
    const merged = await findPlanPanel(
      electronApp,
      window,
      'plan-diagram',
      ROADMAP,
    );
    expect(merged?.where).toBe('main');
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
        summaryLine('main', merged.groupId, 'plan-diagram', ROADMAP),
      ].sort(),
    );

    // Closing the diagram tab inside a window is the merge.
    const secondAux = await popOutGroup(electronApp, window, merged.groupId);
    await expect(
      planDiagramPanel(secondAux, ROADMAP).getByTestId(
        'plan-diagram-panel-view',
      ),
    ).toBeVisible();
    await closePlanTab(secondAux, planDiagramPanelId(ROADMAP));
    await expect(planDiagramPanel(secondAux, ROADMAP)).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toBeVisible();
    await expect(doc.getByTestId('plan-panel-split')).toBeVisible();
    await expect(doc.getByTestId('plan-panel-show-diagram')).toHaveCount(0);
    await closeAuxWindows(electronApp);
    expect(await planPanelSummary(electronApp, window)).toEqual([
      summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P7: relaunches reconcile a popped-out split, and bad plan entries never cost unrelated groups', async () => {
  test.setTimeout(360_000);

  // ---- Launch 1: document + popped-out diagram + a plan in its own group --
  const first = await seedPlanPanelWorktree({ plans: seededPlans() });
  const { userDataDir } = first;
  let importerGroupId;
  let diagramGroupId;
  try {
    const { electronApp, window } = first;
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, ROADMAP);
    await planDocumentPanel(window, ROADMAP)
      .getByTestId('plan-panel-split')
      .click();
    await expect(
      planDiagramPanel(window, ROADMAP).getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();
    diagramGroupId = (
      await findPlanPanel(electronApp, window, 'plan-diagram', ROADMAP)
    ).groupId;

    importerGroupId = await splitViaApi(
      window,
      DEFAULT_GROUP_IDS.activity,
      'down',
    );
    await choosePlanFromMenu(window, importerGroupId, IMPORTER);
    await expect(
      planDocumentPanel(window, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();

    await popOutGroup(electronApp, window, diagramGroupId);
    expect(await planPanelSummary(electronApp, window)).toEqual(
      [
        summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
        summaryLine('main', importerGroupId, 'plan', IMPORTER),
        summaryLine('aux', diagramGroupId, 'plan-diagram', ROADMAP),
      ].sort(),
    );
    // Renderer save debounce is 500ms; give it margin.
    await window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const expectedFamily = [
    summaryLine('main', DEFAULT_GROUP_IDS.chat, 'plan', ROADMAP),
    summaryLine('main', importerGroupId, 'plan', IMPORTER),
    summaryLine('aux', diagramGroupId, 'plan-diagram', ROADMAP),
  ].sort();

  // ---- Launch 2: the family restores and the document stays split -------
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  try {
    const aux = await waitForAuxPage(second.electronApp);
    await expect(
      planDiagramPanel(aux, ROADMAP).getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();
    // Chat restore re-activates the chat tab; select the plan's tab.
    await second.window
      .getByTestId(`panel-tab-${planPanelId(ROADMAP)}`)
      .click();
    const secondDoc = planDocumentPanel(second.window, ROADMAP);
    await expect(secondDoc.getByTestId('plan-panel-view')).toBeVisible();
    await expect(secondDoc.getByTestId('plan-panel-tab-diagram')).toHaveCount(
      0,
    );
    await expect
      .poll(() => planPanelSummary(second.electronApp, second.window))
      .toEqual(expectedFamily);
  } finally {
    await closeCanopy(second.electronApp, userDataDir, { keepUserData: true });
  }

  // ---- Seed invalid, duplicate, and orphaned plan entries into the file ---
  const layoutPath = layoutFilePath(userDataDir);
  const file = JSON.parse(readFileSync(layoutPath, 'utf8'));
  const mainGroupIds = persistedGroupIds(file.grid.root);
  expect(mainGroupIds).toEqual(
    expect.arrayContaining([DEFAULT_GROUP_IDS.chat, importerGroupId]),
  );
  expect(file.poppedOut).toHaveLength(1);
  findPersistedLeaf(file.grid.root, DEFAULT_GROUP_IDS.chat).panels.push(
    { panelId: 'panel-plan-unbound', kind: 'plan', title: 'Unbound plan' },
    {
      panelId: 'panel-plan-roadmap-copy',
      kind: 'plan',
      title: ROADMAP_TITLE,
      instance: { planId: ROADMAP },
    },
  );
  findPersistedLeaf(file.grid.root, importerGroupId).panels.push({
    panelId: 'panel-plan-plan-deleted',
    kind: 'plan',
    title: 'Deleted plan',
    instance: { planId: 'plan-deleted' },
  });
  findPersistedLeaf(file.poppedOut[0].grid.root, diagramGroupId).panels.push({
    panelId: 'panel-plan-diagram-copy',
    kind: 'plan-diagram',
    title: `${ROADMAP_TITLE} (Diagram)`,
    instance: { planId: ROADMAP },
  });
  writeFileSync(layoutPath, JSON.stringify(file, null, 2), 'utf8');

  // ---- Launch 3: unrelated groups survive; plan entries reconcile --------
  const third = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  try {
    const aux = await waitForAuxPage(third.electronApp);
    await expect(
      planDiagramPanel(aux, ROADMAP).getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();
    // The persisted grid restored (not the default layout) with every group.
    const layout = await getLayout(third.window);
    expect(collectLeaves(layout.root).map((leaf) => leaf.groupId)).toEqual(
      mainGroupIds,
    );
    await expect(
      third.window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`),
    ).toHaveCount(1);
    // Invalid and duplicate entries were pruned; the orphaned plan panel
    // closes once the worktree's plan inventory has loaded.
    await expect
      .poll(() => planPanelSummary(third.electronApp, third.window), {
        timeout: 20_000,
      })
      .toEqual(expectedFamily);
    for (const panelId of [
      'panel-plan-unbound',
      'panel-plan-roadmap-copy',
      'panel-plan-plan-deleted',
      'panel-plan-diagram-copy',
    ]) {
      await expect(
        third.window.getByTestId(`panel-tab-${panelId}`),
      ).toHaveCount(0);
      await expect(aux.getByTestId(`panel-tab-${panelId}`)).toHaveCount(0);
    }
    await third.window.getByTestId(`panel-tab-${planPanelId(ROADMAP)}`).click();
    const thirdDoc = planDocumentPanel(third.window, ROADMAP);
    await expect(thirdDoc.getByTestId('plan-panel-view')).toBeVisible();
    await expect(thirdDoc.getByTestId('plan-panel-tab-diagram')).toHaveCount(0);
  } finally {
    await closeCanopy(third.electronApp, userDataDir);
  }
});

test('P8: the Plans submenu follows renames and hiding live; deleting a plan closes its panels', async () => {
  test.setTimeout(240_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, ROADMAP);
    const doc = planDocumentPanel(window, ROADMAP);
    await doc.getByTestId('plan-panel-split').click();
    const diagram = planDiagramPanel(window, ROADMAP);
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();

    // --- Menu open while the plans change elsewhere ------------------------
    await openPlansSubmenu(window, DEFAULT_GROUP_IDS.chat);
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([
        planEntry(ROADMAP, ROADMAP_TITLE),
        planEntry(IMPORTER, IMPORTER_TITLE),
      ]);

    // A rename updates the entry (a revised plan moves to the top).
    const renamed = 'Rewrite the importer in place';
    await broadcastTrackedPlanUpdate(electronApp, window, IMPORTER, {
      title: renamed,
    });
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([
        planEntry(IMPORTER, renamed),
        planEntry(ROADMAP, ROADMAP_TITLE),
      ]);

    // Hiding an open plan removes its entry and leaves its panels alone.
    await broadcastTrackedPlanUpdate(electronApp, window, ROADMAP, {
      hidden: true,
    });
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([planEntry(IMPORTER, renamed)]);
    await expect(doc.getByTestId('plan-panel-view')).toHaveAttribute(
      'data-plan-id',
      ROADMAP,
    );
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();

    // Unhiding restores entries.
    await broadcastTrackedPlanUpdate(electronApp, window, ARCHIVED, {
      hidden: false,
    });
    await broadcastTrackedPlanUpdate(electronApp, window, ROADMAP, {
      hidden: false,
    });
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([
        planEntry(ROADMAP, ROADMAP_TITLE),
        planEntry(ARCHIVED, ARCHIVED_TITLE),
        planEntry(IMPORTER, renamed),
      ]);

    // Hiding every plan turns the submenu into the plain Plans row in the
    // open menu.
    for (const planId of [ROADMAP, ARCHIVED, IMPORTER]) {
      await broadcastTrackedPlanUpdate(electronApp, window, planId, {
        hidden: true,
      });
    }
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
    await expect(
      window.getByTestId('panel-add-menu-plans-submenu'),
    ).toHaveCount(0);
    await expect(window.getByTestId('panel-add-menu-plans-group')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('panel-add-menu-item-activity-card-plans'),
    ).toHaveText('Plans');
    await expect(
      window.getByTestId('panel-add-menu-usage-submenu'),
    ).toBeVisible();

    // Unhiding one brings it back.
    await broadcastTrackedPlanUpdate(electronApp, window, IMPORTER, {
      hidden: false,
    });
    await window.getByTestId('panel-add-menu-plans-submenu').click();
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([planEntry(IMPORTER, renamed)]);
    await closeAddPanelMenu(window);

    // --- The plan list's own hide button empties the menu too --------------
    const importerRow = window.getByTestId(`activity-plan-row-${IMPORTER}`);
    await importerRow.hover();
    await window.getByTestId(`activity-plan-toggle-hidden-${IMPORTER}`).click();
    await expect(importerRow).toHaveCount(0);
    await openAddPanelMenu(window, DEFAULT_GROUP_IDS.chat);
    await expect(
      window.getByTestId('panel-add-menu-usage-submenu'),
    ).toBeVisible();
    await expect(
      window.getByTestId('panel-add-menu-plans-submenu'),
    ).toHaveCount(0);
    await closeAddPanelMenu(window);

    // Hidden plans keep their open panels and staged work.
    await expect(doc.getByTestId('plan-explore-plan-panel')).toContainText(
      `Plan body for ${ROADMAP_TITLE}.`,
    );
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();

    // --- Deleting the plan closes both of its panels ----------------------
    await broadcastTrackedPlanRemoval(electronApp, window, ROADMAP);
    await expect(doc).toHaveCount(0);
    await expect(diagram).toHaveCount(0);
    expect(await planPanelSummary(electronApp, window)).toEqual([]);
    await expect(
      window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P9: Submit sends document and diagram comments to the ordinary worktree chat', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CPLANP9';
  const documentThreadId = 'p9-document-thread';
  const nodeThreadId = 'p9-node-thread';
  const documentBody = `[${marker}] Record the baseline before seeding?`;
  const nodeBody = 'Split shipping into two steps.';
  const agentAnswer = 'Looked at both plan comments.';
  const phaseOne = [ROADMAP_TITLE, 'Phase 1: Prepare'];
  const phaseTwo = [ROADMAP_TITLE, 'Phase 2: Ship'];
  const [roadmap, ...rest] = seededPlans();
  // An unshared plan with one staged comment on a document passage and one on
  // a sequence diagram node.
  const plans = [
    {
      ...roadmap,
      commentThreads: [
        buildPlanCommentThread({
          id: documentThreadId,
          anchor: documentAnchor({
            quote: '- Record the baseline.',
            renderedText: 'Record the baseline.',
            lineStart: 8,
            lineEnd: 8,
            headingPath: phaseOne,
          }),
          comments: [
            userComment({
              id: 'p9-document-1',
              body: documentBody,
              staged: true,
            }),
          ],
        }),
        buildPlanCommentThread({
          id: nodeThreadId,
          anchor: diagramNodeAnchor({
            diagramKind: 'sequence',
            planNodeId: `${ROADMAP}-phase-2`,
            title: 'Phase 2: Ship',
            headingPath: phaseTwo,
          }),
          comments: [
            userComment({ id: 'p9-node-1', body: nodeBody, staged: true }),
          ],
        }),
      ],
    },
    ...rest,
  ];
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: agentAnswer, stopReason: 'end_turn' }] },
  });
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans,
  });

  try {
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, ROADMAP);
    const doc = planDocumentPanel(window, ROADMAP);
    const submit = doc.getByTestId('plan-comments-submit');
    await expect(submit).toHaveText('Submit 2 comments');
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.activity);

    await submit.click();
    // The worktree's own chat receives the handoff, names the plan, and
    // describes both the passage and the diagram node; its agent answers.
    const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(chat).toContainText(
      `I have 2 comment threads on the plan "${ROADMAP_TITLE}" (plan ${ROADMAP}).`,
      { timeout: 30_000 },
    );
    await expect(chat).toContainText(documentBody);
    await expect(chat).toContainText(
      `Comment on the sequence diagram node "Phase 2: Ship" (thread ${nodeThreadId})`,
    );
    await expect(chat).toContainText(nodeBody);
    await expect(chat).toContainText(agentAnswer, { timeout: 60_000 });
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.chat);

    // Both drafts are now submitted, and nothing is left to send.
    await expect(submit).toHaveCount(0);
    await expect
      .poll(async () => {
        const plan = await window.evaluate(
          (ref) => window.api.activity.plans.get(ref),
          {
            projectId: PLAN_PANEL_WORKSPACE_ID,
            worktreeId: PLAN_PANEL_WORKTREE_ID,
            planId: ROADMAP,
          },
        );
        return (plan?.commentThreads ?? []).flatMap((thread) =>
          thread.comments.map((comment) => [comment.id, comment.staged]),
        );
      })
      .toEqual([
        ['p9-document-1', false],
        ['p9-node-1', false],
      ]);
    // No dedicated plan chat was created for the handoff.
    expect(
      existsSync(path.join(userDataDir, 'plan-explore-chats', 'registry.json')),
    ).toBe(false);
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P9: a failed Claude terminal launch keeps plan comments pending and leaves no queued copy', async () => {
  test.setTimeout(180_000);
  const commentId = 'p9-launch-1';
  const commentBody = 'Record the baseline before seeding?';
  const [roadmap, ...rest] = seededPlans();
  const plans = [
    {
      ...roadmap,
      commentThreads: [
        buildPlanCommentThread({
          id: 'p9-launch-thread',
          anchor: documentAnchor({
            quote: '- Record the baseline.',
            renderedText: 'Record the baseline.',
            lineStart: 8,
            lineEnd: 8,
            headingPath: [ROADMAP_TITLE, 'Phase 1: Prepare'],
          }),
          comments: [
            userComment({ id: commentId, body: commentBody, staged: true }),
          ],
        }),
      ],
    },
    ...rest,
  ];
  // A terminal-backed Claude chat with no live terminal: Submit launches one
  // with the handoff as its initial prompt.
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans,
    chatTab: { interfaceMode: 'auto' },
  });

  try {
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__planLaunchRequests = [];
      ipcMain.removeHandler('claude-terminal:launch');
      ipcMain.handle('claude-terminal:launch', async (_event, request) => {
        globalThis.__planLaunchRequests.push(request);
        throw new Error('Terminal launch failed for test');
      });
    });
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, ROADMAP);
    const doc = planDocumentPanel(window, ROADMAP);
    const submit = doc.getByTestId('plan-comments-submit');
    await expect(submit).toHaveText('Submit 1 comment');

    await submit.click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__planLaunchRequests.length),
      )
      .toBe(1);
    expect(
      await electronApp.evaluate(
        () => globalThis.__planLaunchRequests[0]?.initialPrompt,
      ),
    ).toContain(
      `I have 1 comment thread on the plan "${ROADMAP_TITLE}" (plan ${ROADMAP}).`,
    );

    // The prompt never reached Claude and only this window held it, so it is
    // not a send: the user is told, and can retry.
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: "Couldn't send comments to chat. Try again." }),
    ).toBeVisible();
    // Nothing was acknowledged, so a restart cannot drop comments marked sent.
    await expect(submit).toHaveText('Submit 1 comment');
    const plan = await window.evaluate(
      (ref) => window.api.activity.plans.get(ref),
      {
        projectId: PLAN_PANEL_WORKSPACE_ID,
        worktreeId: PLAN_PANEL_WORKTREE_ID,
        planId: ROADMAP,
      },
    );
    expect(
      (plan?.commentThreads ?? []).flatMap((thread) =>
        thread.comments.map((comment) => [
          comment.id,
          comment.staged === true,
          comment.submittedToChat === true,
        ]),
      ),
    ).toEqual([[commentId, true, false]]);
    // The parked copy was withdrawn, so a retry cannot deliver it twice.
    await expect(
      chatPanelLocator(window, SEEDED_CHAT_TAB_ID).getByTestId(
        'queued-message-bubble',
      ),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// --- P10/P11: the agent edits the active plan's working copy ---------------

const BASELINE_THREAD_ID = 'baseline-thread';
const BASELINE_QUOTE = '- Record the baseline.';
const NEW_TASK = 'Measure the plan file sync.';
const AGENT_DONE = 'Updated the plan file.';

/**
 * The seeded plans with one submitted document thread on ROADMAP's
 * "Record the baseline." task, plus ROADMAP's revised content: that task
 * removed (so the thread goes outdated) and a new Phase 2 task added.
 */
function plansWithBaselineThread() {
  const [roadmap, ...rest] = seededPlans();
  const revised = `${roadmap.content.replace(`${BASELINE_QUOTE}\n`, '')}\n- ${NEW_TASK}`;
  expect(revised).not.toContain(BASELINE_QUOTE);
  const plans = [
    {
      ...roadmap,
      commentThreads: [
        buildPlanCommentThread({
          id: BASELINE_THREAD_ID,
          anchor: documentAnchor({
            quote: BASELINE_QUOTE,
            renderedText: 'Record the baseline.',
            lineStart: 8,
            lineEnd: 8,
            headingPath: [ROADMAP_TITLE, 'Phase 1: Prepare'],
          }),
          comments: [
            userComment({
              id: 'baseline-1',
              body: 'Do we still need the baseline?',
            }),
          ],
        }),
      ],
    },
    ...rest,
  ];
  return { plans, original: roadmap.content, revised };
}

function readPanelPlan(window, planId) {
  return window.evaluate((ref) => window.api.activity.plans.get(ref), {
    projectId: PLAN_PANEL_WORKSPACE_ID,
    worktreeId: PLAN_PANEL_WORKTREE_ID,
    planId,
  });
}

/** The persisted revision state of `planId`, for exact comparisons. */
async function planRevisionState(window, planId) {
  const plan = await readPanelPlan(window, planId);
  return plan
    ? {
        latestRevisionNumber: plan.latestRevisionNumber,
        revisionNumbers: plan.revisions.map(
          (revision) => revision.revisionNumber,
        ),
        content: plan.content,
        lastEditSource: plan.lastEditSource ?? null,
      }
    : null;
}

/**
 * Seed the plans, launch with the repository's staged binaries (the agent
 * runs a real Bash command), and register the mock agent: its first step
 * runs `command(files)` through Bash, its second answers AGENT_DONE. The
 * provider request is observed for either plan's working-copy path.
 */
async function launchPlanEditTurn({ marker, plans, command }) {
  const launched = await withBundledBinaryOverridesScrubbed(() =>
    seedPlanPanelWorktree({ plans }),
  );
  const { userDataDir } = launched;
  const files = {
    roadmap: planFilePath(userDataDir, ROADMAP),
    importer: planFilePath(userDataDir, IMPORTER),
    revised: path.join(userDataDir, 'revised-plan.md'),
    gate: path.join(userDataDir, 'agent-turn-gate'),
  };
  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        requestTextObservers: [
          { key: 'roadmap-file', text: `plan-explore/${ROADMAP}/plan.md` },
          { key: 'importer-file', text: `plan-explore/${IMPORTER}/plan.md` },
        ],
        steps: [
          {
            toolCalls: [{ name: 'Bash', input: { command: command(files) } }],
            stopReason: 'tool_use',
          },
          { text: AGENT_DONE, stopReason: 'end_turn' },
        ],
      },
    });
  } catch (error) {
    await closeCanopy(launched.electronApp, userDataDir);
    throw error;
  }
  return { ...launched, files };
}

/** Full access (the Bash call runs unprompted), then send from the composer. */
async function sendFromComposer(window, marker, prompt) {
  const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
  await chat.getByTestId('approval-mode-picker').click();
  await window.getByTestId('approval-mode-option-full-access').click();
  await chat.getByRole('textbox').first().fill(`[${marker}] ${prompt}`);
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  return chat;
}

async function scenarioActivity(marker) {
  return (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker)).activity;
}

function bashToolCard(chat) {
  return chat
    .locator('[data-testid="chat-tool-call"][data-tool-name="Bash"]')
    .first();
}

test('P10: an agent edit of the active plan becomes one revision when its turn ends', async () => {
  test.setTimeout(240_000);
  const marker = 'Canopy-CPLANP10';
  const { plans, original, revised } = plansWithBaselineThread();
  const { electronApp, userDataDir, window, files } = await launchPlanEditTurn({
    marker,
    plans,
    command: ({ revised: from, roadmap, gate }) =>
      `cp ${JSON.stringify(from)} ${JSON.stringify(roadmap)} && until test -f ${JSON.stringify(gate)}; do sleep 1; done`,
  });

  try {
    writeFileSync(files.revised, revised, 'utf8');
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, ROADMAP);
    const doc = planDocumentPanel(window, ROADMAP);
    await expect(doc.getByTestId('plan-panel-view')).toContainText(
      '• Revision 1',
    );
    await expect(
      doc.getByTestId(`plan-comment-thread-${BASELINE_THREAD_ID}`),
    ).toBeVisible();
    // The working copy only exists once a turn is sent with the plan active.
    expect(existsSync(files.roadmap)).toBe(false);
    await recordTrackedPlanUpdates(window);

    const chat = await sendFromComposer(
      window,
      marker,
      'Drop the baseline task and add the sync measurement.',
    );
    // Main materialized the plan and named its file to the agent, and the
    // agent's Bash call replaced it; the turn is still running.
    await expect
      .poll(
        () =>
          existsSync(files.roadmap)
            ? readFileSync(files.roadmap, 'utf8')
            : null,
        { timeout: 90_000, message: 'the agent should edit the plan file' },
      )
      .toBe(revised);
    expect(
      (await scenarioActivity(marker))['llmObserved:roadmap-file'] ?? 0,
    ).toBeGreaterThanOrEqual(1);
    await expect(bashToolCard(chat)).toBeVisible();

    // Hiding and revealing the panel checks the file at once; mid-turn the
    // edit stays in the working copy.
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, IMPORTER);
    await expect(planDocumentPanel(window, IMPORTER)).toBeVisible();
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, ROADMAP);
    await expect(doc).toBeVisible();
    await window.waitForTimeout(3_000);
    expect(await planRevisionState(window, ROADMAP)).toEqual({
      latestRevisionNumber: 1,
      revisionNumbers: [1],
      content: original,
      lastEditSource: null,
    });
    expect(
      (await recordedTrackedPlanUpdates(window)).filter(
        (event) =>
          event.plan?.id === ROADMAP && event.plan.latestRevisionNumber > 1,
      ),
    ).toEqual([]);
    expect(readFileSync(files.roadmap, 'utf8')).toBe(revised);

    // Ending the turn applies the edit as one agent revision.
    writeFileSync(files.gate, 'done', 'utf8');
    await expect(chat).toContainText(AGENT_DONE, { timeout: 60_000 });
    await expect
      .poll(() => planRevisionState(window, ROADMAP), { timeout: 30_000 })
      .toEqual({
        latestRevisionNumber: 2,
        revisionNumbers: [1, 2],
        content: revised,
        lastEditSource: 'agent',
      });
    const updates = await recordedTrackedPlanUpdates(window);
    const firstRevisionTwo = updates.find(
      (event) =>
        event.plan?.id === ROADMAP && event.plan.latestRevisionNumber === 2,
    );
    expect({
      sequence: firstRevisionTwo?.plan.diagrams?.sequence?.status,
      threads: (firstRevisionTwo?.plan.commentThreads ?? []).map((thread) => [
        thread.id,
        thread.anchorState,
      ]),
    }).toEqual({
      sequence: 'stale',
      threads: [[BASELINE_THREAD_ID, 'outdated']],
    });

    // Nothing else turns the same edit into a second revision.
    await window.waitForTimeout(3_000);
    expect(await planRevisionState(window, ROADMAP)).toEqual({
      latestRevisionNumber: 2,
      revisionNumbers: [1, 2],
      content: revised,
      lastEditSource: 'agent',
    });

    // The open panel follows: the new revision and task, and the outdated
    // thread moved to the archived list.
    await expect(doc.getByTestId('plan-panel-view')).toContainText(
      '• Revision 2',
    );
    await expect(doc.getByTestId('plan-explore-plan-panel')).toContainText(
      NEW_TASK,
    );
    await expect(
      doc.getByTestId(`plan-comment-thread-${BASELINE_THREAD_ID}`),
    ).toHaveCount(0);
    const archivedToggle = doc.getByTestId('plan-comments-archived-toggle');
    await expect(archivedToggle).toContainText('resolved & outdated (1)');
    await archivedToggle.click();
    await expect(
      doc.getByTestId(`plan-comment-thread-${BASELINE_THREAD_ID}`),
    ).toBeVisible();
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P11: an edit after the panel closed and another plan became active still revises the sent plan', async () => {
  test.setTimeout(240_000);
  const marker = 'Canopy-CPLANP11';
  const { plans, revised } = plansWithBaselineThread();
  const { electronApp, userDataDir, window, files } = await launchPlanEditTurn({
    marker,
    plans,
    command: ({ revised: from, roadmap, gate }) =>
      `until test -f ${JSON.stringify(gate)}; do sleep 1; done; cp ${JSON.stringify(from)} ${JSON.stringify(roadmap)}`,
  });

  try {
    writeFileSync(files.revised, revised, 'utf8');
    // The loaded plan's view registers it as the worktree's active plan.
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, ROADMAP);
    await expect(
      planDocumentPanel(window, ROADMAP).getByTestId('plan-panel-view'),
    ).toContainText('• Revision 1');
    const chat = await sendFromComposer(
      window,
      marker,
      'Drop the baseline task once I say so.',
    );
    await expect(bashToolCard(chat)).toBeVisible({ timeout: 90_000 });
    expect(
      (await scenarioActivity(marker))['llmObserved:roadmap-file'] ?? 0,
    ).toBeGreaterThanOrEqual(1);

    // While the agent waits: close the plan's panel and make another plan
    // active.
    await closePlanTab(window, planPanelId(ROADMAP));
    await expect(planDocumentPanel(window, ROADMAP)).toHaveCount(0);
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, IMPORTER);
    await expect(planDocumentPanel(window, IMPORTER)).toBeVisible();

    // The agent edits the file at the end of its turn.
    writeFileSync(files.gate, 'done', 'utf8');
    await expect(chat).toContainText(AGENT_DONE, { timeout: 60_000 });
    await expect
      .poll(() => planRevisionState(window, ROADMAP), { timeout: 30_000 })
      .toEqual({
        latestRevisionNumber: 2,
        revisionNumbers: [1, 2],
        content: revised,
        lastEditSource: 'agent',
      });
    expect(await planDocumentPanel(window, ROADMAP).count()).toBe(0);

    // The newly active plan was never part of that turn.
    expect(
      (await planRevisionState(window, IMPORTER))?.revisionNumbers,
    ).toEqual([1]);
    expect(existsSync(files.importer)).toBe(false);
    expect(
      (await scenarioActivity(marker))['llmObserved:importer-file'] ?? 0,
    ).toBe(0);

    // Reopening the plan shows the agent's revision.
    await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.activity, ROADMAP);
    const doc = planDocumentPanel(window, ROADMAP);
    await expect(doc.getByTestId('plan-panel-view')).toContainText(
      '• Revision 2',
    );
    await expect(doc.getByTestId('plan-explore-plan-panel')).toContainText(
      NEW_TASK,
    );
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
  }
});

// --- P13: the Plan panel header's follow-ups ---------------------------------

test('P13: on an older revision the Plan panel shares nothing, implements the latest plan, and opens linked runs', async () => {
  test.setTimeout(240_000);
  const marker = 'Canopy-CPLANP13';
  const executionId = 'p13-linked-run';
  const pipelineName = 'Plan follow-up run';
  const agentAnswer = 'Implementing the latest plan now.';
  const latestSummary = `[${marker}] Latest plan body for ${ROADMAP_TITLE}.`;
  const [, importer] = seededPlans();
  const plans = [
    buildPanelPlan({
      id: ROADMAP,
      title: ROADMAP_TITLE,
      updatedAt: '2026-06-03T00:00:00.000Z',
      latestRevisionNumber: 2,
      linkedExecutionIds: [executionId],
      summary: latestSummary,
    }),
    importer,
  ];
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: agentAnswer, stopReason: 'end_turn' }] },
  });
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans,
    onBeforeLaunch: (context) => {
      seedPipelineExecution({
        userDataDir: context.userDataDir,
        workspaceId: PLAN_PANEL_WORKSPACE_ID,
        worktreeId: PLAN_PANEL_WORKTREE_ID,
        execution: {
          id: executionId,
          pipelineName,
          status: 'success',
          startedAt: '2026-06-03T01:00:00.000Z',
          completedAt: '2026-06-03T01:01:00.000Z',
        },
      });
    },
  });

  try {
    await planRow(window, ROADMAP).click();
    const doc = planDocumentPanel(window, ROADMAP);
    const view = doc.getByTestId('plan-panel-view');
    const body = doc.getByTestId('plan-explore-plan-panel');
    await expect(view).toContainText('• Revision 2');
    await expect(body).toContainText(latestSummary);
    const planGroupId = await planGroupOf(electronApp, window, ROADMAP);

    // --- Viewing revision 1 -------------------------------------------------
    await chooseSettingsOption(
      doc.getByTestId('plan-panel-revision-select'),
      '1',
    );
    await expect(view).toContainText('• Revision 1');
    await expect(body).toContainText('Earlier draft (revision 1).');
    await expect(body).not.toContainText(marker);

    // Share needs the latest revision and says so.
    const share = doc.getByTestId('plan-panel-share');
    await expect(share).toBeVisible();
    await expect(share).toBeDisabled();
    await share.hover({ force: true });
    await expect(window.getByRole('tooltip')).toContainText(
      'Switch to Latest to share this plan.',
    );

    // --- Implement sends the latest plan and keeps the panel ----------------
    await doc.getByTestId('plan-panel-execute').click();
    await window.getByTestId('plan-panel-execute-implement').click();
    const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(chat).toContainText('Implement this plan:', {
      timeout: 30_000,
    });
    await expect(chat).toContainText(latestSummary);
    await expect(chat).not.toContainText('Earlier draft (revision 1).');
    await expect(chat).toContainText(agentAnswer, { timeout: 60_000 });
    // The chat is revealed; the plan stays open beside it.
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.chat);
    await expect(chat).toBeVisible();
    await expect(view).toBeVisible();
    expect(await planGroupOf(electronApp, window, ROADMAP)).toBe(planGroupId);
    await expectNoTakeover(window);

    // --- A linked run opens in its own panel; the plan stays ---------------
    await doc.getByTestId('plan-panel-executions').click();
    const linkedRun = window
      .getByTestId('plan-panel-executions-menu')
      .getByRole('menuitem', {
        name: new RegExp(`^(${pipelineName}|${executionId.slice(0, 8)})`),
      });
    // Each loaded run shows when it was dispatched beside its status.
    await expect(linkedRun).toContainText(/Dispatched /, { timeout: 15_000 });
    await linkedRun.click();
    await expectPipelineRunPanel(window, executionId, { timeout: 30_000 });
    expect(await planGroupOf(electronApp, window, ROADMAP)).toBe(planGroupId);
    await expect(view).toBeVisible();
    await closePipelineRunPanels(window);
    await expect(view).toBeVisible();

    // --- A narrow window keeps the actions inside the panel ----------------
    // (launchCanopy fixes the main window's viewport; narrow it the same way.)
    await window.setViewportSize({ width: 1000, height: 700 });
    await expect
      .poll(() => window.evaluate(() => window.innerWidth))
      .toBe(1000);
    // The finished chat implementation put Open first and moved the
    // retries behind the overflow menu, the row's last control.
    await expect(doc.getByTestId('plan-panel-execute')).toHaveCount(0);
    for (const testId of ['plan-panel-open', 'plan-panel-more']) {
      const control = doc.getByTestId(testId);
      await expect(control).toBeVisible();
      await expect
        .poll(async () =>
          isInside(await control.boundingBox(), await doc.boundingBox()),
        )
        .toBe(true);
    }
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
  }
});

// --- P14: the other entry points ---------------------------------------------

const PENDING = 'plan-pending';
const PENDING_TITLE = 'Pending plan';
const OTHER = 'plan-other';
const OTHER_TITLE = 'Tune the Next build cache';
const AUDIT_ENTRY_ID = 'p14-plan-audit';

function planAuditEntry(planId) {
  const nowMs = Date.now();
  return {
    id: AUDIT_ENTRY_ID,
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Plan review turn',
    startedAt: new Date(nowMs - 10 * 60_000).toISOString(),
    completedAt: new Date(nowMs - 9 * 60_000).toISOString(),
    durationMs: 60_000,
    model: 'claude-sonnet-4-6',
    totalCostUsd: 0.001,
    tokens: {
      input: 100,
      output: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: {},
    projectId: PLAN_PANEL_WORKSPACE_ID,
    worktreeId: PLAN_PANEL_WORKTREE_ID,
    chatId: SEEDED_CHAT_TAB_ID,
    hasTranscript: false,
    linkTarget: {
      page: 'main',
      kind: 'worktree-chat',
      projectId: PLAN_PANEL_WORKSPACE_ID,
      worktreeId: PLAN_PANEL_WORKTREE_ID,
      chatId: SEEDED_CHAT_TAB_ID,
      planId,
    },
  };
}

async function openPalette(window) {
  await window.keyboard.press(
    process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
  );
  await expect(window.getByTestId('command-palette')).toBeVisible();
  return window.getByTestId('command-palette-input');
}

test('P14: pending plans, the palette, App Advisor, and the Audit Trail open the Plan panel', async () => {
  test.setTimeout(300_000);
  const [roadmap, importer] = seededPlans();
  const other = buildPanelPlan({
    id: OTHER,
    title: OTHER_TITLE,
    updatedAt: '2026-06-04T00:00:00.000Z',
    projectId: PLAN_PANEL_OTHER_WORKSPACE_ID,
  });
  const { electronApp, userDataDir, window, app } =
    await seedPlanPanelWorkspaces({
      plansByWorkspace: {
        [PLAN_PANEL_WORKSPACE_ID]: [roadmap, importer],
        [PLAN_PANEL_OTHER_WORKSPACE_ID]: [other],
      },
      // The seeded chat is waiting on a plan-mode exit whose plan was never
      // tracked.
      chatTab: {
        trackedPlanId: PENDING,
        pendingPlanExit: {
          plan: `# ${PENDING_TITLE}\n\nShip the pending plan.`,
        },
      },
      onBeforeLaunch: (context) => {
        seedObservabilityAudit({
          userDataDir: context.userDataDir,
          entries: [planAuditEntry(IMPORTER)],
        });
      },
    });

  try {
    await expect(
      selectedWorktreeRow(window, PLAN_PANEL_WORKSPACE_ID),
    ).toHaveCount(1);
    const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);

    // --- (a) A chat's pending plan: created on demand, beside that chat ----
    await chat.getByTestId('chat-plan-explore').click();
    const pending = planDocumentPanel(window, PENDING);
    await expect(pending.getByTestId('plan-explore-plan-panel')).toContainText(
      'Ship the pending plan.',
    );
    await expect(
      window.getByTestId(`panel-tab-${planPanelId(PENDING)}`),
    ).toContainText(PENDING_TITLE);
    const sideGroupId = await planGroupOf(electronApp, window, PENDING);
    expect(await rightNeighborOfChat(window)).toBe(sideGroupId);
    await expect(chat).toBeVisible();
    const created = await window.evaluate(
      (ref) => window.api.activity.plans.get(ref),
      {
        projectId: PLAN_PANEL_WORKSPACE_ID,
        worktreeId: PLAN_PANEL_WORKTREE_ID,
        planId: PENDING,
      },
    );
    expect(created).toMatchObject({
      id: PENDING,
      title: PENDING_TITLE,
      reviewStatus: 'pending',
    });
    // Opening it again reveals the same panel.
    await chat.getByTestId('chat-plan-explore').click();
    expect(
      (await familyPlanPanels(electronApp, window)).filter(
        (panel) => panel.planId === PENDING,
      ),
    ).toHaveLength(1);
    await expectNoTakeover(window);

    // --- (b) The palette switches to the plan's worktree first -------------
    await app.openPipelinesPage();
    const input = await openPalette(window);
    await input.fill(OTHER_TITLE);
    await window
      .locator('[data-palette-section="plans"]')
      .getByRole('option')
      .filter({ hasText: OTHER_TITLE })
      .click();
    await app.expectMainPage();
    await expect(
      selectedWorktreeRow(window, PLAN_PANEL_OTHER_WORKSPACE_ID),
    ).toHaveCount(1);
    await expect(
      planDocumentPanel(window, OTHER).getByTestId('plan-explore-plan-panel'),
    ).toContainText(`Plan body for ${OTHER_TITLE}.`);
    await expectNoTakeover(window);

    // --- (c) App Advisor opens a plan in another worktree -------------------
    await app.openAutomationsPage();
    const openExplore = await dispatchAdvisorAction(
      electronApp,
      'p14-advisor-open-explore',
      {
        type: 'tracked-plan.open_explore',
        projectId: PLAN_PANEL_WORKSPACE_ID,
        worktreeId: PLAN_PANEL_WORKTREE_ID,
        planId: ROADMAP,
      },
    );
    expect(openExplore).toMatchObject({
      ok: true,
      result: {
        plan: { id: ROADMAP },
        panel: { panelId: planPanelId(ROADMAP), revealed: false },
      },
    });
    expect(JSON.stringify(openExplore.result)).not.toContain('chatScope');
    await app.expectMainPage();
    await expect(
      selectedWorktreeRow(window, PLAN_PANEL_WORKSPACE_ID),
    ).toHaveCount(1);
    await expect(
      planDocumentPanel(window, ROADMAP).getByTestId('plan-explore-plan-panel'),
    ).toContainText(`Plan body for ${ROADMAP_TITLE}.`);
    await expectNoTakeover(window);

    // --- (d) Advisor panel.add_tab opens plan and diagram panels ------------
    const addPlan = {
      type: 'panel.add_tab',
      kind: 'plan',
      planId: IMPORTER,
      groupId: DEFAULT_GROUP_IDS.chat,
    };
    expect(
      await dispatchAdvisorAction(electronApp, 'p14-add-plan', addPlan),
    ).toMatchObject({ ok: true, result: { panelId: planPanelId(IMPORTER) } });
    expect(await planGroupOf(electronApp, window, IMPORTER)).toBe(
      DEFAULT_GROUP_IDS.chat,
    );
    await expect(
      planDocumentPanel(window, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();
    // Adding it again reveals the one instance.
    expect(
      await dispatchAdvisorAction(electronApp, 'p14-add-plan-again', addPlan),
    ).toMatchObject({ ok: true, result: { panelId: planPanelId(IMPORTER) } });
    expect(
      (await familyPlanPanels(electronApp, window)).filter(
        (panel) => panel.planId === IMPORTER,
      ),
    ).toHaveLength(1);
    expect(
      await dispatchAdvisorAction(electronApp, 'p14-add-diagram', {
        type: 'panel.add_tab',
        kind: 'plan-diagram',
        planId: ROADMAP,
      }),
    ).toMatchObject({
      ok: true,
      result: { panelId: planDiagramPanelId(ROADMAP) },
    });
    await expect(
      planDiagramPanel(window, ROADMAP).getByTestId('plan-diagram-panel-view'),
    ).toBeVisible();

    // --- (e) The retired plan-chat actions are refused ----------------------
    const listTabs = await dispatchAdvisorAction(
      electronApp,
      'p14-plan-chat-list',
      { type: 'plan-explore-chat.list_tabs', planId: ROADMAP },
    );
    expect(listTabs).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(await legacyPlanChatSessions(window, ROADMAP)).toEqual([]);

    // --- (f) Audit Trail Inspect opens the entry's plan beside its chat ----
    // (Close the Advisor-added panel first so Inspect has to place it.)
    await closePlanTab(window, planPanelId(IMPORTER));
    await expect(planDocumentPanel(window, IMPORTER)).toHaveCount(0);
    await app.openAuditPage();
    await window.getByTestId(`audit-inspect-button-${AUDIT_ENTRY_ID}`).click();
    await app.expectMainPage();
    await expect(
      planDocumentPanel(window, IMPORTER).getByTestId('plan-panel-view'),
    ).toBeVisible();
    // It joins the content group beside the entry's chat.
    expect(await planGroupOf(electronApp, window, IMPORTER)).toBe(sideGroupId);
    expect(await mainLeaf(window, sideGroupId)).toMatchObject({
      activePanelId: planPanelId(IMPORTER),
    });
    await expectNoTakeover(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** The open plans list cards (`activity-card` / `plans`) in the main layout. */
async function plansListCards(window) {
  const layout = await getLayout(window);
  return collectLeaves(layout?.root).flatMap((leaf) =>
    (leaf.panels ?? [])
      .filter(
        (panel) =>
          panel.kind === 'activity-card' &&
          panel.instance?.sectionId === 'plans',
      )
      .map((panel) => ({
        groupId: leaf.groupId,
        panelId: panel.panelId,
        active: leaf.activePanelId === panel.panelId,
      })),
  );
}

test('P17: Implement shows its chat at once, expanding its group and leaving a maximize, before the send settles', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    // The plan opens beside the chat, whose group is then collapsed.
    await planRow(window, ROADMAP).click();
    const doc = planDocumentPanel(window, ROADMAP);
    const view = doc.getByTestId('plan-panel-view');
    await expect(view).toBeVisible();
    const planGroupId = await planGroupOf(electronApp, window, ROADMAP);
    expect(planGroupId).not.toBe(DEFAULT_GROUP_IDS.chat);
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      DEFAULT_GROUP_IDS.chat,
    );
    await expect
      .poll(
        async () => (await mainLeaf(window, DEFAULT_GROUP_IDS.chat))?.collapsed,
      )
      .not.toBeNull();
    const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(chat).toBeHidden();

    // Hold the send so it cannot settle: the chat shows anyway.
    await window.evaluate(() => {
      window.__canopyPanelTestApi.holdChatSends();
    });
    await doc.getByTestId('plan-panel-execute').click();
    await window.getByTestId('plan-panel-execute-implement').click();
    await expect
      .poll(
        async () => (await mainLeaf(window, DEFAULT_GROUP_IDS.chat))?.collapsed,
      )
      .toBeNull();
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.chat);
    await expect(chat).toBeVisible();
    await expect(view).toBeVisible();

    // The user moves on; the send settling never pulls focus back.
    await window.getByTestId(`panel-tab-${planPanelId(ROADMAP)}`).click();
    await expect.poll(() => getActiveGroupId(window)).toBe(planGroupId);
    await window.evaluate(() => {
      window.__canopyPanelTestApi.releaseHeldChatSends();
    });
    await expect(chat).toContainText('Implement this plan:', {
      timeout: 30_000,
    });
    // The linked implementation turn finishes; Open replaces Execute.
    await expect(doc.getByTestId('plan-panel-status-badge')).toHaveText(
      'Finished in chat',
      { timeout: 30_000 },
    );
    await expect.poll(() => getActiveGroupId(window)).toBe(planGroupId);

    // From a maximized plan group, Implement again (now in the overflow
    // menu) leaves the maximize too.
    await window.keyboard.press('ControlOrMeta+Shift+F');
    await expect.poll(() => maximizedGroupIds(window)).toEqual([planGroupId]);
    await expect(chat).toBeHidden();
    await window.evaluate(() => {
      window.__canopyPanelTestApi.holdChatSends();
    });
    await doc.getByTestId('plan-panel-more').click();
    await expect(window.getByTestId('plan-panel-execute-implement')).toHaveText(
      'Implement again in chat',
    );
    await window.getByTestId('plan-panel-execute-implement').click();
    await expect.poll(() => maximizedGroupIds(window)).toEqual([]);
    await expect(chat).toBeVisible();
    await window.evaluate(() => {
      window.__canopyPanelTestApi.releaseHeldChatSends();
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-5166: workflow outcomes and retries update both plan surfaces and open the selected run', async () => {
  test.setTimeout(180_000);
  const plan = buildPanelPlan({
    id: ROADMAP,
    title: ROADMAP_TITLE,
    updatedAt: '2026-06-02T00:00:00.000Z',
  });
  const names = {
    success: 'CAN5166 success',
    failure: 'CAN5166 failure',
    cancel: 'CAN5166 cancel',
  };
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: [plan],
    chatTab: {
      trackedPlanId: ROADMAP,
      trackedPlanSource: 'claude',
      trackedPlanReviewStatus: 'pending',
      pendingPlanExitRequestId: 'can-5166-workflow-review',
      pendingPlanExit: {
        plan: plan.content,
        source: 'claude',
        reviewMode: 'manual',
      },
    },
    onBeforeLaunch: ({ userDataDir }) => {
      for (const [kind, name] of Object.entries(names)) {
        const command =
          kind === 'failure'
            ? 'exit 7'
            : `while [ ! -f .can5166-${kind} ]; do sleep 0.05; done`;
        seedStoredPipeline({
          userDataDir,
          id: `can5166-${kind}`,
          name,
          yaml: `name: ${name}\non: plan_ready\nscope: worktree\njobs:\n  main:\n    steps:\n      - run: ${command}\n`,
        });
      }
    },
  });
  const scope = {
    projectId: PLAN_PANEL_WORKSPACE_ID,
    worktreeId: PLAN_PANEL_WORKTREE_ID,
  };
  try {
    await planRow(window, ROADMAP).click();
    const doc = planDocumentPanel(window, ROADMAP);
    const header = doc.getByTestId('plan-panel-status-badge');
    const card = window.getByTestId(`activity-plan-status-${ROADMAP}`);
    let firstLaunch = true;
    const launch = async (kind) => {
      if (firstLaunch) {
        await chatPanelLocator(window, SEEDED_CHAT_TAB_ID)
          .getByTestId('chat-plan-pipeline')
          .click();
        firstLaunch = false;
      } else {
        // Once Open replaces Execute, retries live in the overflow menu.
        const more = doc.getByTestId('plan-panel-more');
        if (await more.isVisible()) await more.click();
        else await doc.getByTestId('plan-panel-execute').click();
        await window.getByTestId('plan-panel-execute-pipeline').click();
      }
      const modal = window.getByTestId('pipeline-trigger-modal');
      await modal
        .getByTestId('pipeline-trigger-modal-selector')
        .getByRole('button')
        .filter({ hasText: names[kind] })
        .click();
      const run = modal.getByTestId('pipeline-trigger-modal-run');
      await expect(run).toBeEnabled();
      const configuring = (await run.textContent())?.includes('Continue');
      await run.click();
      if (configuring) {
        await expect(run).toBeEnabled();
        await run.click();
      }
      await expect(modal).toBeHidden();
      const result = await window.evaluate(async (name) => {
        const result = await window.pipelines.listExecutions();
        return result.data
          ?.filter((run) => run.pipeline_name === name)
          .sort((left, right) =>
            right.started_at.localeCompare(left.started_at),
          )[0]?.id;
      }, names[kind]);
      expect(typeof result).toBe('string');
      return result;
    };
    await launch('failure');
    await expect(header).toHaveText('Approved');
    await expect(card).toHaveText('Approved');
    await expect(
      doc.getByTestId('plan-panel-status-note-outcome'),
    ).toContainText('Workflow failed');
    const successfulRun = await launch('success');
    await expect(header).toHaveText('Implementing in workflow');
    await expect(card).toHaveText('Implementing in workflow');
    await expect(doc.getByTestId('plan-panel-execute')).toHaveCount(0);
    await doc.getByTestId('plan-panel-open').click();
    await expectPipelineRunPanel(window, successfulRun);
    await closePipelineRunPanels(window);
    const cwd = await window.evaluate(
      (scope) => window.api.getWorktreePath(scope),
      scope,
    );
    writeFileSync(path.join(cwd, '.can5166-success'), 'release');
    await expect(header).toHaveText('Implemented in workflow');
    await expect(card).toHaveText('Implemented in workflow');
    await launch('failure');
    await expect(header).toHaveText('Implemented in workflow');
    await expect(
      doc.getByTestId('plan-panel-status-note-outcome'),
    ).toContainText('Workflow failed');
    const cancelledRun = await launch('cancel');
    await expect(header).toHaveText('Implementing in workflow');
    await window.evaluate(
      (id) => window.pipelines.cancelExecution(id),
      cancelledRun,
    );
    await expect(header).toHaveText('Implemented in workflow');
    await expect(card).toHaveText('Implemented in workflow');
    await expect(
      doc.getByTestId('plan-panel-status-note-outcome'),
    ).toContainText('Workflow cancelled');
    await expect(doc.getByTestId('plan-panel-execute')).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-open')).toHaveAttribute(
      'aria-label',
      'Open run',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function releasePlanImplementationBarrier(
  marker,
  name = 'implementation',
) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: marker, name }),
  });
  expect(response.ok).toBe(true);
}

for (const entry of ['chat approval', 'Plan Implement']) {
  test(`CAN-5166/CAN-5359: ${entry} approves before the linked send, then follows that turn to Finished in chat`, async () => {
    test.setTimeout(180_000);
    const marker = `Canopy-CAN5166-${entry.replaceAll(' ', '-')}`;
    const plan = buildPanelPlan({
      id: ROADMAP,
      title: ROADMAP_TITLE,
      updatedAt: '2026-06-02T00:00:00.000Z',
      summary: `[${marker}] Implement this change.`,
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            text: 'Implementation finished.',
            stopReason: 'end_turn',
            waitFor: 'implementation',
            barrierTimeoutMs: 90_000,
          },
          {
            text: 'Unrelated follow-up finished.',
            stopReason: 'end_turn',
            waitFor: 'follow-up',
            barrierTimeoutMs: 90_000,
          },
        ],
      },
    });
    const pending =
      entry === 'chat approval'
        ? {
            trackedPlanId: ROADMAP,
            trackedPlanSource: 'claude',
            trackedPlanReviewStatus: 'pending',
            // Main records the reviewed revision with each plan exit.
            latestRevisionNumber: 1,
            pendingPlanExitRequestId: 'can-5166-review',
            pendingPlanExit: {
              plan: plan.content,
              source: 'claude',
              reviewMode: 'manual',
            },
          }
        : undefined;
    const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
      plans: [plan],
      chatTab: pending,
    });
    try {
      await planRow(window, ROADMAP).click();
      const doc = planDocumentPanel(window, ROADMAP);
      const header = doc.getByTestId('plan-panel-status-badge');
      const card = window.getByTestId(`activity-plan-status-${ROADMAP}`);
      await expandDefaultActivityRail(window);
      await expect(header).toHaveText('Pending');
      await expect(card).toHaveText('Pending');
      // Record every badge label from approval onward, so a transient
      // return to Pending cannot hide behind the endpoint assertions.
      await window.evaluate(() => {
        const seen = [];
        const read = () => {
          const text = document.querySelector(
            '[data-testid="plan-panel-status-badge"]',
          )?.textContent;
          if (text && seen.at(-1) !== text) seen.push(text);
        };
        new MutationObserver(read).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
        Reflect.set(window, '__can5359BadgeLabels', seen);
      });
      await window.evaluate(() => window.__canopyPanelTestApi.holdChatSends());
      if (entry === 'chat approval') {
        await chatPanelLocator(window, SEEDED_CHAT_TAB_ID)
          .getByTestId('chat-plan-implement')
          .click();
      } else {
        await doc.getByTestId('plan-panel-execute').click();
        await window.getByTestId('plan-panel-execute-implement').click();
      }
      // Before admission supplies active evidence, both surfaces still
      // guard chat and workflow dispatch through the same pending request.
      await expect(header).toHaveText('Approved', { timeout: 30_000 });
      await expect(card).toHaveText('Approved');
      await doc.getByTestId('plan-panel-execute').click();
      await expect(
        window.getByTestId('plan-panel-execute-pipeline'),
      ).toBeDisabled();
      await expect(
        window.getByTestId('plan-panel-execute-implement'),
      ).toBeDisabled();
      await window.keyboard.press('Escape');
      await window.getByTestId(`activity-plan-${ROADMAP}-execute`).click();
      await expect(
        window.getByTestId(`activity-plan-${ROADMAP}-execute-pipeline`),
      ).toBeDisabled();
      await expect(
        window.getByTestId(`activity-plan-${ROADMAP}-execute-implement`),
      ).toBeDisabled();
      await window.keyboard.press('Escape');
      await window.evaluate(() =>
        window.__canopyPanelTestApi.releaseHeldChatSends(),
      );
      // Hold the actual provider response, not just the renderer callback,
      // so the active state is observed on both surfaces before completion.
      await expect(header).toHaveText('Implementing in chat', {
        timeout: 30_000,
      });
      await expect(card).toHaveText('Implementing in chat');
      await expect(card).toBeVisible();
      await doc.getByTestId('plan-panel-more').click();
      await expect(
        window.getByTestId('plan-panel-execute-pipeline'),
      ).toBeDisabled();
      await expect(
        window.getByTestId('plan-panel-execute-implement'),
      ).toBeDisabled();
      await window.keyboard.press('Escape');
      await expect(
        doc.getByTestId('plan-panel-status-badge-spinner'),
      ).toBeVisible();
      await expect(doc.getByTestId('plan-panel-execute')).toHaveCount(0);
      await expect(
        window.getByTestId(`activity-plan-${ROADMAP}-execute`),
      ).toHaveCount(0);
      const chat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
      await chat
        .getByRole('textbox')
        .last()
        .fill(`[${marker}] An unrelated follow-up.`);
      await chat.getByRole('textbox').last().press('Enter');
      await expect(chat.getByTestId('queued-message-bubble')).toContainText(
        'An unrelated follow-up.',
      );
      // Main links the admitted send to this plan revision and settles the
      // link with that exact turn's end.
      await window.evaluate(() =>
        window.__canopyPanelTestApi.releaseHeldChatSends(),
      );
      await releasePlanImplementationBarrier(marker);
      await expect(header).toHaveText('Finished in chat', { timeout: 60_000 });
      await expect(card).toHaveText('Finished in chat');
      // A queued follow-up can now run, but cannot become this implementation.
      await expect
        .poll(
          async () => {
            const response = await fetch(
              `${DEFAULT_MOCK_BASE_URL}/__mock/barrier?key=${encodeURIComponent(marker)}`,
            );
            const { barriers } = await response.json();
            return barriers.some(
              (barrier) => barrier.name === 'follow-up' && barrier.waiting > 0,
            );
          },
          { timeout: 45_000 },
        )
        .toBe(true);
      await expect(header).toHaveText('Finished in chat');
      await expect(doc.getByTestId('plan-panel-execute')).toHaveCount(0);
      await expect(
        window.getByTestId(`activity-plan-${ROADMAP}-execute`),
      ).toHaveCount(0);
      const labels = await window.evaluate(() =>
        Reflect.get(window, '__can5359BadgeLabels'),
      );
      const firstReviewed = labels.findIndex((label) => label !== 'Pending');
      expect(firstReviewed).toBeGreaterThanOrEqual(0);
      expect(labels.slice(firstReviewed)).not.toContain('Pending');
      await doc.getByTestId('plan-panel-open').click();
      await expect(chatPanelLocator(window, SEEDED_CHAT_TAB_ID)).toBeVisible();
      const more = doc.getByTestId('plan-panel-more');
      await more.focus();
      await more.press('ArrowDown');
      await expect(
        window.getByTestId('plan-panel-execute-pipeline'),
      ).toBeFocused();
      await window.keyboard.press('ArrowDown');
      await expect(
        window.getByTestId('plan-panel-execute-implement'),
      ).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(more).toBeFocused();
      const activityMore = window.getByTestId(`activity-plan-${ROADMAP}-more`);
      await activityMore.focus();
      await activityMore.press('ArrowDown');
      await expect(
        window.getByTestId(`activity-plan-${ROADMAP}-execute-pipeline`),
      ).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(activityMore).toBeFocused();
      // Action focus must not swallow the app's global shortcuts.
      await openPalette(window);
      await window.keyboard.press('Escape');
      await window.reload();
      // Reload returns to Home; re-open this worktree before checking its
      // durably hydrated plan rather than depending on navigation restore.
      await window
        .locator(`[data-worktree-id="${PLAN_PANEL_WORKTREE_ID}"]`)
        .first()
        .click();
      await expandDefaultActivityRail(window);
      await planRow(window, ROADMAP).click();
      await expect(
        planDocumentPanel(window, ROADMAP).getByTestId(
          'plan-panel-status-badge',
        ),
      ).toHaveText('Finished in chat');
      await expect(
        window.getByTestId(`activity-plan-status-${ROADMAP}`),
      ).toHaveText('Finished in chat');
      await expect(
        planDocumentPanel(window, ROADMAP).getByTestId('plan-panel-open'),
      ).toHaveAccessibleName('Open chat');
      await releasePlanImplementationBarrier(marker, 'follow-up');
    } finally {
      await releasePlanImplementationBarrier(marker).catch(() => undefined);
      await releasePlanImplementationBarrier(marker, 'follow-up').catch(
        () => undefined,
      );
      await window
        .evaluate(() => window.__canopyPanelTestApi.releaseHeldChatSends())
        .catch(() => undefined);
      await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const outcome of ['failed', 'stopped']) {
  test(`CAN-5359: a sole ${outcome} chat implementation keeps Approved with its outcome note and Execute`, async () => {
    test.setTimeout(180_000);
    const marker = `Canopy-CAN5359-${outcome}`;
    const plan = buildPanelPlan({
      id: ROADMAP,
      title: ROADMAP_TITLE,
      summary: `[${marker}] Implement this change.`,
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            waitFor: 'implementation',
            barrierTimeoutMs: 90_000,
            ...(outcome === 'failed'
              ? {
                  error: {
                    status: 400,
                    message: 'The implementation request failed.',
                  },
                }
              : {
                  text: 'This response should be stopped.',
                  stopReason: 'end_turn',
                }),
          },
        ],
      },
    });
    const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
      plans: [plan],
    });
    try {
      await planRow(window, ROADMAP).click();
      await expandDefaultActivityRail(window);
      const doc = planDocumentPanel(window, ROADMAP);
      const header = doc.getByTestId('plan-panel-status-badge');
      const card = window.getByTestId(`activity-plan-status-${ROADMAP}`);
      await doc.getByTestId('plan-panel-execute').click();
      await window.getByTestId('plan-panel-execute-implement').click();
      await expect(header).toHaveText('Implementing in chat');
      await expect(card).toHaveText('Implementing in chat');
      if (outcome === 'stopped') {
        await chatPanelLocator(window, SEEDED_CHAT_TAB_ID)
          .getByTestId('chat-stop-generation')
          .click();
      }
      await releasePlanImplementationBarrier(marker);
      await expect(header).toHaveText('Approved', { timeout: 60_000 });
      await expect(card).toHaveText('Approved');
      const note = outcome === 'failed' ? 'Chat failed' : 'Chat stopped';
      await expect(
        doc.getByTestId('plan-panel-status-note-outcome'),
      ).toContainText(note);
      await expect(
        window.getByTestId(`activity-plan-status-note-${ROADMAP}`),
      ).toContainText(note);
      await expect(doc.getByTestId('plan-panel-execute')).toBeVisible();
      await expect(
        window.getByTestId(`activity-plan-${ROADMAP}-execute`),
      ).toBeVisible();
      await expect(doc.getByTestId('plan-panel-open')).toHaveCount(0);
      await doc.getByTestId('plan-panel-status-note-chat-outcome').click();
      await expect(chatPanelLocator(window, SEEDED_CHAT_TAB_ID)).toBeVisible();
    } finally {
      await releasePlanImplementationBarrier(marker).catch(() => undefined);
      await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('P18: Plans has its own Add Panel entry that opens or reveals the plans list', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: seededPlans(),
  });

  try {
    // Plans is no longer listed under Activity.
    await openAddPanelMenu(window, DEFAULT_GROUP_IDS.chat);
    await expect(
      window
        .getByTestId('panel-add-menu-activity-group')
        .getByTestId('panel-add-menu-item-activity-card-plans'),
    ).toHaveCount(0);

    // The submenu leads with All plans, then the plans.
    await window.getByTestId('panel-add-menu-plans-submenu').click();
    const submenu = window.getByTestId('panel-add-menu-plans-group');
    await expect(submenu).toBeVisible();
    const items = submenu.locator('[role="menuitem"]');
    await expect(items.first()).toHaveAttribute(
      'data-testid',
      'panel-add-menu-item-activity-card-plans',
    );
    await expect(items.first()).toHaveText('All plans');
    await expect
      .poll(() => plansSubmenuEntries(window))
      .toEqual([
        planEntry(ROADMAP, ROADMAP_TITLE),
        planEntry(IMPORTER, IMPORTER_TITLE),
      ]);

    // All plans opens the plans list in the menu's group.
    await items.first().click();
    await expect(window.getByTestId('panel-add-menu')).toHaveCount(0);
    await expect
      .poll(() => plansListCards(window))
      .toEqual([
        expect.objectContaining({
          groupId: DEFAULT_GROUP_IDS.chat,
          active: true,
        }),
      ]);

    // Chosen again while open, it brings the same list forward.
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`).click();
    await expect
      .poll(async () => (await plansListCards(window))[0]?.active)
      .toBe(false);
    await openPlansSubmenu(window, DEFAULT_GROUP_IDS.chat);
    await window
      .getByTestId('panel-add-menu-plans-group')
      .getByTestId('panel-add-menu-item-activity-card-plans')
      .click();
    await expect
      .poll(() => plansListCards(window))
      .toEqual([
        expect.objectContaining({
          groupId: DEFAULT_GROUP_IDS.chat,
          active: true,
        }),
      ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('P18: with no tracked plan, Plans is one row that opens the plans list', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
    plans: [],
  });

  try {
    await openAddPanelMenu(window, DEFAULT_GROUP_IDS.chat);
    await expect(
      window.getByTestId('panel-add-menu-plans-submenu'),
    ).toHaveCount(0);
    const row = window.getByTestId('panel-add-menu-item-activity-card-plans');
    await expect(row).toHaveText('Plans');
    await row.click();
    await expect(window.getByTestId('panel-add-menu')).toHaveCount(0);
    await expect
      .poll(() => plansListCards(window))
      .toEqual([
        expect.objectContaining({
          groupId: DEFAULT_GROUP_IDS.chat,
          active: true,
        }),
      ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

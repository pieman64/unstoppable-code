import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  addSharedPlanReply,
  addSharedPlanThread,
  buildPlanCommentThread,
  buildTrackedPlan,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  diagramNodeAnchor,
  documentAnchor,
  emitSharedPlanSignal,
  generalAnchor,
  readSharedPlanDetail,
  readSharedPlanRequests,
  registerScenario,
  registerSharedPlanScenario,
  registerShareMembership,
  remoteComment,
  SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
  SHARE_MEMBERSHIP_TEAM,
  SHARED_PLAN_TEAMMATES,
  seedStoredPipeline,
  setSharedPlanThreadStatus,
  seedTrackedPlans,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  sharedPlanServerSeed,
  teamShareState,
  toWireCommentThreads,
  userComment,
  writeJson,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  chatPanelLocator,
  expandDefaultActivityRail,
  getActiveGroupId,
  splitViaApi,
} from './panelHarness.mjs';
import {
  buildPanelPlan,
  choosePlanFromMenu,
  closeAuxWindows,
  closePlanTab,
  planDiagramPanel,
  planDocumentPanel,
  planGroupOf,
  planPanelId,
  popOutGroup,
} from './planPanelHarness.mjs';
import { readChatStorageMessages } from './readChatStorage.mjs';
import {
  closeSharedPlanOwner,
  launchSharedPlanOwner,
  readTrackedPlan,
  waitForSharedPlanStartupSync,
} from './sharedPlanOwnerFixture.mjs';
import {
  closeSharedPlanStreams,
  launchSharedPlanOwnerInWorkspaces,
  OTHER_WORKSPACE_ID,
  revealedDiagramNodeIds,
  selectWorkspaceWorktree,
  setSharedPlanGetFault,
  sharedPlanCounters,
  threadComments,
  waitForSharedPlanGets,
} from './sharedPlanCommentHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const PLAN_ID = 'plan-e2e';
const PLAN_TITLE = 'Shareable plan from e2e';
const CLOUD_API_KEY = 'csk_plan_share_e2e';
const PIPELINE_NAME = 'Plan Explore E2E Pipeline';
const PIPELINE_YAML = [
  `name: ${PIPELINE_NAME}`,
  'on: plan_ready',
  'jobs:',
  '  main:',
  '    steps:',
  '      - run: echo plan-ready',
  '',
].join('\n');

function makeTrackedPlan() {
  const createdAt = '2026-06-11T12:00:00.000Z';
  return {
    id: PLAN_ID,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: PLAN_TITLE,
    content: `# ${PLAN_TITLE}\n\n| Step | Status |\n| --- | --- |\n| Share | Ready |\n\n- Share through the tracked plan UI.`,
    reviewStatus: 'pending',
    createdAt,
    updatedAt: createdAt,
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: `# ${PLAN_TITLE}\n\n| Step | Status |\n| --- | --- |\n| Share | Ready |\n\n- Share through the tracked plan UI.`,
        source: 'claude',
        reviewStatus: 'pending',
        createdAt,
      },
    ],
    linkedExecutionIds: [],
  };
}

test('tracked plan Share button opens the Cloud share modal controls', async () => {
  // Plans are shared with a team or organization, so the account needs one.
  await registerShareMembership(CLOUD_API_KEY);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-plan-share-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedTrackedPlans({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    plans: [makeTrackedPlan()],
  });
  seedStoredPipeline({
    userDataDir,
    id: 'plan-explore-e2e',
    name: PIPELINE_NAME,
    yaml: PIPELINE_YAML,
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() => {
      localStorage.removeItem('canopy.planExplore.commentsCollapsed.v1');
    });
    await app.openMainPage();

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      CLOUD_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);
    expect(saveResult.account.hasApiKey).toBe(true);

    await app.selectWorktree(WORKTREE_BRANCH);
    // The activity panel renders expanded inside the panel grid (no collapse
    // chrome); wait for its content to mount before using its sections.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    const plansSection = window.getByTestId('activity-plans-section');
    await expect(plansSection).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId(`activity-plan-row-${PLAN_ID}`),
    ).toContainText(PLAN_TITLE);

    // The plan list row opens the plan's Plan panel, which uses the same
    // collapsible comments tray as Code Review. Exercise both directions in
    // the real Electron surface before returning to the activity card's share
    // action.
    await window.getByTestId(`activity-plan-row-${PLAN_ID}`).click();
    const planPanel = planDocumentPanel(window, PLAN_ID);
    await expect(planPanel).toBeVisible();
    await expect(planPanel.locator('table[data-sourcepos]')).toHaveCount(1);
    await expect(planPanel.locator('ul[data-sourcepos]')).toHaveCount(1);
    const commentsTray = planPanel.getByTestId('plan-explore-comments-tray');
    const commentsBody = commentsTray.getByTestId(
      'plan-explore-comments-tray-body',
    );
    const commentsToggle = commentsTray.getByTestId(
      'plan-comments-collapse-toggle',
    );
    await expect(commentsBody).toBeVisible();
    await commentsToggle.click();
    await expect(commentsToggle).toHaveAttribute(
      'aria-label',
      'Expand comments',
    );
    await expect(commentsBody).toBeHidden();
    await commentsToggle.click();
    await expect(commentsToggle).toHaveAttribute(
      'aria-label',
      'Collapse comments',
    );
    await expect(commentsBody).toBeVisible();

    await planPanel.getByTestId('plan-panel-execute').click();
    await planPanel.getByTestId('plan-panel-execute-pipeline').click();

    const pipelineModal = window.getByTestId('pipeline-trigger-modal');
    await expect(pipelineModal).toBeVisible();
    await expect(pipelineModal).toContainText(PIPELINE_NAME);
    await expect(pipelineModal.locator('..')).toHaveClass(
      /(?:^|\s)z-modal(?:\s|$)/,
    );

    await window.getByTestId('pipeline-trigger-modal-cancel').click();
    await expect(pipelineModal).toHaveCount(0);
    await expect(planPanel).toBeVisible();

    // Opening beside the chat collapses the activity rail that holds the plan
    // list (the side-open placement); bring it back for the card's Share.
    await expandDefaultActivityRail(window);
    await window.getByTestId(`activity-plan-${PLAN_ID}-share`).click();

    const modal = window.getByTestId('share-plan-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(PLAN_TITLE);
    await expect(window.getByTestId('share-plan-scope')).toBeVisible({
      timeout: 30_000,
    });
    // There is no Private audience: Team is preselected, Organization is the
    // only other choice, and Public is not offered for plans.
    await expect(modal.getByRole('radio')).toHaveCount(2);
    await expect(modal.getByRole('radio', { name: 'Private' })).toHaveCount(0);
    await expect(window.getByRole('radio', { name: 'Team' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(window.getByRole('radio', { name: 'Team' })).toBeEnabled();
    await expect(
      window.getByRole('radio', { name: 'Organization' }),
    ).toBeEnabled();
    // A team share names its team before it can be sent.
    await modal
      .getByTestId(`share-plan-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();
    await expect(window.getByTestId('share-plan-submit')).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// ── Shared-plan teammate comments (plan workspace panels SC1/SC2) ──────────
//
// These flows traverse the real desktop path: the mock cloud's shared-plan
// routes (`mock-server/routes/shared-plans.mjs`) → the main-process cloud
// client → persistence merge → `trackedPlansUpdated` → the plan renderer. The
// owner launches twice (`launchSharedPlanOwner`) so its credential exists when
// startup enrolls the shared plan for sync and realtime.

const SHARED_PLAN_QUOTE = '- Share through the tracked plan UI.';
const SHARED_PLAN_RENDERED_QUOTE = 'Share through the tracked plan UI.';
/** A shorter passage of the same line, for a second anchor. */
const SHARED_PLAN_UI_PHRASE = 'tracked plan UI';
const PLAN_REF_DEFAULTS = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };

function sharedPlanFixture({
  planId,
  title,
  remoteId,
  commentThreads,
  projectId = WORKSPACE_ID,
}) {
  return buildTrackedPlan({
    id: planId,
    projectId,
    worktreeId: WORKTREE_ID,
    title,
    // Same document as `makeTrackedPlan`; the quote sits on line 7.
    content: `# ${title}\n\n| Step | Status |\n| --- | --- |\n| Share | Ready |\n\n${SHARED_PLAN_QUOTE}`,
    share: teamShareState({ remoteId }),
    ...(commentThreads ? { commentThreads } : {}),
  });
}

function sharedPlanAnchor(title) {
  return documentAnchor({
    quote: SHARED_PLAN_QUOTE,
    renderedText: SHARED_PLAN_RENDERED_QUOTE,
    lineStart: 7,
    lineEnd: 7,
    headingPath: [title],
  });
}

async function openPlanFromActivity(window, app, planId) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
  await expect(window.getByTestId('activity-plans-section')).toBeVisible({
    timeout: 30_000,
  });
  await window.getByTestId(`activity-plan-row-${planId}`).click();
  const planPanel = planDocumentPanel(window, planId);
  await expect(planPanel).toBeVisible();
  return planPanel;
}

/** Inbound teammate comments must never start an agent turn by themselves. */
async function expectNoAgentTurn(window, planId) {
  const activeTurns = await window.evaluate(
    async ({ projectId, worktreeId, plan }) => {
      const scopes = [
        { projectId, worktreeId },
        // The legacy plan chat scope (the retired takeover's dedicated chat).
        { projectId: 'plan-explore-chat', worktreeId: plan },
      ];
      const results = await Promise.all(
        scopes.map((scope) => window.api.chat.activeSessions(scope)),
      );
      return results.flatMap((result) =>
        (result.sessions ?? [])
          .filter((session) => session.turnActive)
          .map((session) => session.chatId),
      );
    },
    { ...PLAN_REF_DEFAULTS, plan: planId },
  );
  expect(activeTurns).toEqual([]);
  await expect(
    chatPanelLocator(window).getByRole('button', { name: 'Stop generation' }),
  ).toHaveCount(0);
}

function startupPutShape(put) {
  return JSON.stringify(put.body);
}

test('SC1: opening a team-shared plan fetches a teammate thread without starting an agent', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_plan_share_sc1_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000001';
  const planId = 'plan-share-sc1';
  const title = 'Shared plan comments on open';
  const threadId = 'sc1-remote-thread';
  const commentBody = 'Can we land the parser before the renderer?';
  const plan = sharedPlanFixture({ planId, title, remoteId });
  const ref = { ...PLAN_REF_DEFAULTS, planId };

  // The stream stays off so the only way the thread can arrive is the
  // pull-on-open refresh.
  await registerSharedPlanScenario(apiKey, {
    stream: 'disabled',
    plans: [sharedPlanServerSeed({ remoteId, plan, commentThreads: [] })],
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({ apiKey, plans: [plan] });
    const { window, app } = owner;

    const { requests } = await waitForSharedPlanStartupSync(window, {
      apiKey,
      remoteId,
      planId,
    });
    const [startupPut] = requests.puts;
    expect(startupPut.expectedSnapshotHashMatched).toBe(true);
    expect(startupPut.body.expectedSnapshotHash).toBe(
      SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
    );
    expect(startupPut.body.content).toBe(plan.content);
    expect(startupPut.body).not.toHaveProperty('commentThreads');
    expect(startupPutShape(startupPut)).not.toMatch(
      /"(?:staged|submittedToChat)"/,
    );
    expect(
      ((await readTrackedPlan(window, ref))?.commentThreads ?? []).map(
        (thread) => thread.id,
      ),
    ).not.toContain(threadId);

    // A teammate comments on the web. No signal: the owner only sees it by
    // opening the plan.
    await addSharedPlanThread(
      apiKey,
      remoteId,
      {
        id: threadId,
        status: 'open',
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor(title),
        anchorState: 'matched',
        comments: [
          {
            id: 'sc1-remote-comment-1',
            author: 'remote',
            remoteAuthor: SHARED_PLAN_TEAMMATES.ada,
            body: commentBody,
            createdAt: '2026-06-11T12:30:00.000Z',
          },
        ],
      },
      { signal: false },
    );
    const getsBefore = (await readSharedPlanRequests(apiKey, remoteId)).gets;

    const planPanel = await openPlanFromActivity(window, app, planId);
    const thread = planPanel.getByTestId(`plan-comment-thread-${threadId}`);
    await expect(thread).toBeVisible({ timeout: 15_000 });
    await expect(thread).toContainText(commentBody);
    await expect(thread).toContainText(SHARED_PLAN_TEAMMATES.ada.displayName);
    await expect(thread).toContainText(`“${SHARED_PLAN_RENDERED_QUOTE}”`);
    await expect(thread).toContainText('Open');
    await expect(thread).toContainText('1 comment');
    await expect(thread).toContainText('pending');
    await expect(
      thread.getByRole('button', { name: 'Jump to this passage in the plan' }),
    ).toBeVisible();
    await expect(
      planPanel.getByTestId('plan-explore-comments-tray'),
    ).toContainText('Comments (1)');
    await expect(planPanel.getByTestId('plan-comments-submit')).toHaveText(
      'Submit 1 comment',
    );
    // The anchor resolves against the rendered plan and highlights the quote.
    await expect
      .poll(() =>
        window.evaluate(() =>
          [...(CSS.highlights.get('plan-comment-anchor') ?? [])].map(String),
        ),
      )
      .toEqual([SHARED_PLAN_RENDERED_QUOTE]);

    const after = await readSharedPlanRequests(apiKey, remoteId);
    expect(after.gets).toBeGreaterThan(getsBefore);
    // Pulling comments never pushes the plan back.
    expect(after.puts).toHaveLength(1);

    await expectNoAgentTurn(window, planId);
    const persisted = await readTrackedPlan(window, ref);
    const persistedThread = persisted?.commentThreads?.find(
      (candidate) => candidate.id === threadId,
    );
    expect(persistedThread?.comments).toEqual([
      expect.objectContaining({
        id: 'sc1-remote-comment-1',
        author: 'remote',
        remoteAuthor: SHARED_PLAN_TEAMMATES.ada,
      }),
    ]);
    expect(persistedThread?.comments[0]).not.toHaveProperty('submittedToChat');
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

test('SC2: a realtime teammate reply updates the open plan without reopening or duplicating', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_plan_share_sc2_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000002';
  const planId = 'plan-share-sc2';
  const title = 'Shared plan live replies';
  const threadId = 'sc2-remote-thread';
  const replyBody = 'Agreed — ship the parser first.';
  const ref = { ...PLAN_REF_DEFAULTS, planId };
  const localThreads = [
    buildPlanCommentThread({
      id: threadId,
      createdAt: '2026-06-11T12:30:00.000Z',
      anchor: sharedPlanAnchor(title),
      comments: [
        remoteComment({
          id: 'sc2-remote-comment-1',
          author: SHARED_PLAN_TEAMMATES.ada,
          body: 'Can we land the parser before the renderer?',
          createdAt: '2026-06-11T12:30:00.000Z',
        }),
      ],
    }),
  ];
  const plan = sharedPlanFixture({
    planId,
    title,
    remoteId,
    commentThreads: localThreads,
  });

  // The server already has the thread the owner has cached locally.
  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    plans: [sharedPlanServerSeed({ remoteId, plan })],
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({ apiKey, plans: [plan] });
    const { window, app } = owner;

    const { requests } = await waitForSharedPlanStartupSync(window, {
      apiKey,
      remoteId,
      planId,
    });
    const [startupPut] = requests.puts;
    expect(startupPut.expectedSnapshotHashMatched).toBe(true);
    expect(startupPut.body.commentThreads).toEqual(
      toWireCommentThreads(localThreads),
    );
    expect(startupPutShape(startupPut)).not.toMatch(
      /"(?:staged|submittedToChat)"/,
    );
    // Startup opened exactly one realtime stream for the remote plan.
    await expect
      .poll(
        async () =>
          (await readSharedPlanRequests(apiKey, remoteId)).openStreams,
        { timeout: 30_000 },
      )
      .toBe(1);

    const getsBeforeOpen = (await readSharedPlanRequests(apiKey, remoteId))
      .gets;
    const planPanel = await openPlanFromActivity(window, app, planId);
    const thread = planPanel.getByTestId(`plan-comment-thread-${threadId}`);
    await expect(thread).toBeVisible({ timeout: 15_000 });
    await expect(thread).toContainText('1 comment');
    await expect(planPanel.getByTestId('plan-comments-submit')).toHaveText(
      'Submit 1 comment',
    );
    await expect
      .poll(async () => (await readSharedPlanRequests(apiKey, remoteId)).gets)
      .toBeGreaterThan(getsBeforeOpen);
    // Barrier: the desktop coalesces concurrent GETs of one remote plan, so a
    // signal that lands while the pull-on-open GET is still in flight would
    // join that older response. Awaiting a refresh here joins (or follows)
    // that GET, so the reply below can only arrive through the realtime
    // signal.
    await window.evaluate(
      (request) => window.api.activity.plans.refreshComments(request),
      ref,
    );
    const getsBeforeReply = (await readSharedPlanRequests(apiKey, remoteId))
      .gets;

    // A teammate replies on the web; the server signals `plan.detail`.
    const reply = await addSharedPlanReply(apiKey, remoteId, threadId, {
      id: 'sc2-remote-comment-2',
      author: 'remote',
      remoteAuthor: SHARED_PLAN_TEAMMATES.grace,
      body: replyBody,
      createdAt: '2026-06-11T12:45:00.000Z',
    });
    expect(reply.eventId).not.toBeNull();

    // The open view updates in place: no row click, no reopen.
    await expect(thread).toContainText(replyBody, { timeout: 15_000 });
    await expect(thread).toContainText(SHARED_PLAN_TEAMMATES.grace.displayName);
    await expect(thread).toContainText('2 comments');
    await expect(
      planPanel.getByTestId(`plan-comment-thread-${threadId}`),
    ).toHaveCount(1);
    await expect(thread.locator('ul > li')).toHaveCount(2);
    await expect(planPanel.getByTestId('plan-comments-submit')).toHaveText(
      'Submit 2 comments',
    );
    await expect(planPanel).toBeVisible();
    expect(
      (await readSharedPlanRequests(apiKey, remoteId)).gets,
    ).toBeGreaterThan(getsBeforeReply);
    const commentIds = async () =>
      (await readTrackedPlan(window, ref))?.commentThreads
        ?.find((candidate) => candidate.id === threadId)
        ?.comments.map((comment) => comment.id);
    expect(await commentIds()).toEqual([
      'sc2-remote-comment-1',
      'sc2-remote-comment-2',
    ]);

    // A repeated signal refreshes again without duplicating the reply.
    const getsBeforeEcho = (await readSharedPlanRequests(apiKey, remoteId))
      .gets;
    await emitSharedPlanSignal(apiKey, remoteId);
    await expect
      .poll(async () => (await readSharedPlanRequests(apiKey, remoteId)).gets)
      .toBeGreaterThan(getsBeforeEcho);
    await expect(thread.locator('ul > li')).toHaveCount(2);
    expect(await commentIds()).toEqual([
      'sc2-remote-comment-1',
      'sc2-remote-comment-2',
    ]);

    await expectNoAgentTurn(window, planId);
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

// ── Plan comments through the ordinary chat (plan workspace panels SC5–SC8) ─
//
// The plan panel's Submit hands every pending comment (teammate web comments
// and the owner's staged drafts) to the owning worktree's ordinary chat, and
// the agent answers through the ordinary file-comment tools. These flows run
// the real path: Add Panel → Plans → plan panel Submit → renderer dispatch →
// `chat:send-message` → Claude SDK against the mock LLM → GetFileComments /
// RespondToFileComment → plan persistence → `trackedPlansUpdated` → panel,
// and the outbound shared-plan PUT the mock cloud records. The plan opens in
// the activity group, so revealing the chat never remounts it (no second
// pull-on-open while a reply waits to be pushed).

const ORDINARY_CHAT_ID = 'regular-chat';
const ACTIVITY_GROUP_ID = 'group-activity';
const CHAT_GROUP_ID = 'group-chat';
const PLAN_SEND_REJECTED_TOAST = "Couldn't send comments to chat. Try again.";

/**
 * Local state the owner needs before its first launch: one ordinary Claude
 * chat (the worktree's only chat, so it is where Submit sends), the Advanced
 * layout that offers Add Panel, and optionally a default approval mode.
 */
function seedOrdinaryChatOwner(userDataDir, { approvalMode } = {}) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: ORDINARY_CHAT_ID,
    tabs: [
      {
        id: ORDINARY_CHAT_ID,
        title: 'Implementation',
        providerType: 'claude',
        messages: [],
      },
    ],
  });
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktree-data',
      WORKTREE_ID,
      'panel-layout-mode.json',
    ),
    { version: 1, mode: 'advanced' },
  );
  if (approvalMode) {
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: approvalMode,
    });
  }
}

/**
 * Select the owner's worktree, open the plan as a panel in the activity group
 * (Add Panel → Plans), and wait for its pull-on-open refresh to settle.
 */
async function openPlanPanelInActivityGroup(
  { window, app },
  { apiKey, remoteId, planId },
) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(chatPanelLocator(window, ORDINARY_CHAT_ID)).toBeVisible({
    timeout: 30_000,
  });
  const getsBeforeOpen = (await readSharedPlanRequests(apiKey, remoteId)).gets;
  await choosePlanFromMenu(window, ACTIVITY_GROUP_ID, planId);
  const panel = planDocumentPanel(window, planId);
  await expect(panel.getByTestId('plan-panel-view')).toHaveAttribute(
    'data-plan-id',
    planId,
  );
  await expect
    .poll(async () => (await readSharedPlanRequests(apiKey, remoteId)).gets)
    .toBeGreaterThan(getsBeforeOpen);
  // Barrier (see SC2): join the pull-on-open GET, so a later teammate reply
  // can only arrive through its own realtime signal.
  await window.evaluate(
    (request) => window.api.activity.plans.refreshComments(request),
    { ...PLAN_REF_DEFAULTS, planId },
  );
  await expect.poll(() => getActiveGroupId(window)).toBe(ACTIVITY_GROUP_ID);
  return panel;
}

/**
 * Hold every `chat:send-message` request in main until the spec releases it
 * with `releasePlanSend` as `'reject'` (the handler throws, like a refused
 * dispatch) or `'accept'` (the real handler runs).
 */
function installPlanSendGate(electronApp) {
  return electronApp.evaluate(({ ipcMain }) => {
    const channel = 'chat:send-message';
    const original = ipcMain._invokeHandlers.get(channel);
    if (typeof original !== 'function') {
      throw new Error(`Expected a registered ${channel} handler`);
    }
    const gate = { original, requests: [], releases: [] };
    globalThis.__planCommentSendGate = gate;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, request) => {
      const index = gate.requests.push(request) - 1;
      const outcome = await new Promise((resolve) => {
        gate.releases[index] = resolve;
      });
      if (outcome !== 'accept') {
        throw new Error('Plan comment send rejected by test');
      }
      return original(event, request);
    });
  });
}

/** Put the real handler back, refusing any send still held. */
function restorePlanSendGate(electronApp) {
  return electronApp
    .evaluate(({ ipcMain }) => {
      const gate = globalThis.__planCommentSendGate;
      if (!gate) return;
      for (const release of gate.releases) release?.('reject');
      ipcMain.removeHandler('chat:send-message');
      ipcMain.handle('chat:send-message', gate.original);
      delete globalThis.__planCommentSendGate;
    })
    .catch(() => undefined);
}

function readPlanSends(electronApp) {
  return electronApp.evaluate(() =>
    (globalThis.__planCommentSendGate?.requests ?? []).map((request) => ({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
      text: request.text,
      hiddenContext: request.hiddenContext ?? null,
    })),
  );
}

/** Wait until `count` sends are held; resolves to every captured request. */
async function waitForPlanSends(electronApp, count) {
  let sends = [];
  await expect
    .poll(
      async () => {
        sends = await readPlanSends(electronApp);
        return sends.length;
      },
      { timeout: 30_000, message: `${count} chat send(s) should be held` },
    )
    .toBe(count);
  return sends;
}

async function releasePlanSend(electronApp, index, outcome) {
  await expect
    .poll(() =>
      electronApp.evaluate(
        (_electron, held) =>
          typeof globalThis.__planCommentSendGate?.releases[held] ===
          'function',
        index,
      ),
    )
    .toBe(true);
  await electronApp.evaluate(
    (_electron, release) => {
      globalThis.__planCommentSendGate.releases[release.index](release.outcome);
    },
    { index, outcome },
  );
}

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

/** `commentId:state` per thread: draft, pending, submitted, or the author. */
function handoffStates(plan) {
  const stateOf = (comment) => {
    if (comment.staged === true) return 'draft';
    if (comment.author === 'remote') {
      return comment.submittedToChat === true ? 'submitted' : 'pending';
    }
    return comment.author === 'user' ? 'submitted' : comment.author;
  };
  return Object.fromEntries(
    (plan?.commentThreads ?? []).map((thread) => [
      thread.id,
      thread.comments.map((comment) => `${comment.id}:${stateOf(comment)}`),
    ]),
  );
}

function activeAgentTurns(window) {
  return window.evaluate(async (scope) => {
    const result = await window.api.chat.activeSessions(scope);
    return (result.sessions ?? [])
      .filter((session) => session.turnActive)
      .map((session) => session.chatId);
  }, PLAN_REF_DEFAULTS);
}

/**
 * The tool results in one chat's durable transcript in the owner's worktree,
 * in order, each named by the call it answers. A Claude result block carries
 * only the call id, and the mock LLM numbers call ids per response, so a
 * result is paired with the latest preceding call of that id.
 */
function readChatToolResults(userDataDir, chatId) {
  const callNames = new Map();
  const results = [];
  const messages = readChatStorageMessages(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    WORKTREE_ID,
    chatId,
  );
  for (const block of messages.flatMap((message) => message.blocks ?? [])) {
    if (block.type === 'tool_use') {
      callNames.set(block.toolUseId, block.toolName);
    } else if (block.type === 'tool_result') {
      results.push({
        toolName: callNames.get(block.toolUseId) ?? block.toolName,
        output: block.output,
        isError: block.isError,
      });
    }
  }
  return results;
}

test('SC5/SC6/SC8: plan comments reach the ordinary chat once, and only the accepted snapshot is acknowledged', async () => {
  test.setTimeout(240_000);
  const apiKey = 'csk_plan_share_sc5_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000005';
  const planId = 'plan-share-sc5';
  const title = 'Shared plan comments to chat';
  const marker = 'Canopy-CPLANSC5';
  const adaThreadId = 'sc5-thread-ada';
  const noteThreadId = 'sc5-thread-note';
  const adaBody = 'Should the parser land before the renderer?';
  const noteBody = `[${marker}] Keep the parser behind a flag.`;
  // Teammate replies that arrive while a dispatch is pending: the first
  // during the refused send, the second during the accepted one.
  const replyDuringRefusal = 'Parser first gets my vote too.';
  const replyDuringAcceptance = 'One more thing: log the parse time.';
  const agentAnswer = 'Noted the plan comments.';
  const header = `I have 2 comment threads on the plan "${title}" (plan ${planId}).`;
  const ref = { ...PLAN_REF_DEFAULTS, planId };
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const plan = sharedPlanFixture({
    planId,
    title,
    remoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: adaThreadId,
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor(title),
        comments: [
          remoteComment({
            id: 'sc5-ada-1',
            author: ada,
            body: adaBody,
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
        ],
      }),
      buildPlanCommentThread({
        id: noteThreadId,
        createdAt: '2026-06-11T12:35:00.000Z',
        anchor: generalAnchor(),
        comments: [
          userComment({
            id: 'sc5-note-1',
            body: noteBody,
            createdAt: '2026-06-11T12:35:00.000Z',
            staged: true,
          }),
        ],
      }),
    ],
  });
  const expectRequestTarget = (request) => {
    expect(request).toMatchObject({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: ORDINARY_CHAT_ID,
      hiddenContext: { kind: 'file-comment-instructions' },
    });
    expect(request.hiddenContext.text).toContain('GetFileComments');
    expect(request.text.startsWith(header)).toBe(true);
  };

  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    plans: [sharedPlanServerSeed({ remoteId, plan })],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: agentAnswer, stopReason: 'end_turn' }] },
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({
      apiKey,
      plans: [plan],
      beforeFirstLaunch: ({ userDataDir }) =>
        seedOrdinaryChatOwner(userDataDir),
    });
    const { electronApp, window } = owner;
    await waitForSharedPlanStartupSync(window, { apiKey, remoteId, planId });
    await expect
      .poll(
        async () =>
          (await readSharedPlanRequests(apiKey, remoteId)).openStreams,
        { timeout: 30_000 },
      )
      .toBe(1);

    const panel = await openPlanPanelInActivityGroup(owner, {
      apiKey,
      remoteId,
      planId,
    });
    const submit = panel.getByTestId('plan-comments-submit');
    const adaThread = panel.getByTestId(`plan-comment-thread-${adaThreadId}`);
    const chat = chatPanelLocator(window, ORDINARY_CHAT_ID);
    await expect(submit).toHaveText('Submit 2 comments');
    await installPlanSendGate(electronApp);

    // --- SC5/SC6: the owning chat refuses the first dispatch ---------------
    await submit.click();
    const [refused] = await waitForPlanSends(electronApp, 1);
    expectRequestTarget(refused);
    expect(refused.text).toContain(
      `Comment (from ${ada.displayName}): ${adaBody}`,
    );
    expect(refused.text).toContain(`Comment: ${noteBody}`);

    // A teammate replies on the web while that dispatch is pending.
    await addSharedPlanReply(apiKey, remoteId, adaThreadId, {
      id: 'sc5-grace-1',
      author: 'remote',
      remoteAuthor: grace,
      body: replyDuringRefusal,
      createdAt: '2026-06-11T12:40:00.000Z',
    });
    await expect(adaThread).toContainText(replyDuringRefusal, {
      timeout: 15_000,
    });
    await expect(submit).toHaveText('Submit 3 comments');

    await releasePlanSend(electronApp, 0, 'reject');
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: PLAN_SEND_REJECTED_TOAST }),
    ).toBeVisible();
    // Nothing was acknowledged: every comment, old and new, stays pending,
    // and a refused send does not bring the chat forward.
    await expect(submit).toHaveText('Submit 3 comments');
    expect(handoffStates(await readTrackedPlan(window, ref))).toEqual({
      [adaThreadId]: ['sc5-ada-1:pending', 'sc5-grace-1:pending'],
      [noteThreadId]: ['sc5-note-1:draft'],
    });
    expect(await getActiveGroupId(window)).toBe(ACTIVITY_GROUP_ID);

    // --- SC5/SC6: the retry carries each pending comment exactly once -------
    await submit.click();
    const sends = await waitForPlanSends(electronApp, 2);
    const retried = sends[1];
    expectRequestTarget(retried);
    for (const body of [adaBody, replyDuringRefusal, noteBody]) {
      expect(occurrences(retried.text, body)).toBe(1);
    }
    expect(retried.text).toContain(
      `Comment (from ${grace.displayName}): ${replyDuringRefusal}`,
    );

    // Another teammate reply lands while the accepted dispatch is pending.
    await addSharedPlanReply(apiKey, remoteId, adaThreadId, {
      id: 'sc5-grace-2',
      author: 'remote',
      remoteAuthor: grace,
      body: replyDuringAcceptance,
      createdAt: '2026-06-11T12:45:00.000Z',
    });
    await expect(adaThread).toContainText(replyDuringAcceptance, {
      timeout: 15_000,
    });
    await expect(submit).toHaveText('Submit 4 comments');
    expect(occurrences(retried.text, replyDuringAcceptance)).toBe(0);

    await releasePlanSend(electronApp, 1, 'accept');
    // The chat comes forward with the handoff, and only the snapshot that
    // was sent is acknowledged: the late reply stays pending.
    await expect(chat).toContainText(header, { timeout: 30_000 });
    await expect.poll(() => getActiveGroupId(window)).toBe(CHAT_GROUP_ID);
    await expect(submit).toHaveText('Submit 1 comment');
    const acknowledged = {
      [adaThreadId]: [
        'sc5-ada-1:submitted',
        'sc5-grace-1:submitted',
        'sc5-grace-2:pending',
      ],
      [noteThreadId]: ['sc5-note-1:submitted'],
    };
    await expect
      .poll(async () => handoffStates(await readTrackedPlan(window, ref)))
      .toEqual(acknowledged);
    const note = (await readTrackedPlan(window, ref)).commentThreads.find(
      (thread) => thread.id === noteThreadId,
    ).comments[0];
    expect(note.staged).toBe(false);

    // The agent answers in that same ordinary chat and finishes its turn.
    await expect(chat).toContainText(agentAnswer, { timeout: 60_000 });
    await expect
      .poll(() => activeAgentTurns(window), { timeout: 60_000 })
      .toEqual([]);

    // --- SC8: a server echo keeps the acknowledgment ------------------------
    const getsBeforeEcho = (await readSharedPlanRequests(apiKey, remoteId))
      .gets;
    await emitSharedPlanSignal(apiKey, remoteId);
    await expect
      .poll(async () => (await readSharedPlanRequests(apiKey, remoteId)).gets)
      .toBeGreaterThan(getsBeforeEcho);
    // Joins (or follows) the signal's GET, so its merge has landed.
    await window.evaluate(
      (request) => window.api.activity.plans.refreshComments(request),
      ref,
    );
    expect(handoffStates(await readTrackedPlan(window, ref))).toEqual(
      acknowledged,
    );
    await expect(adaThread.locator('ul > li')).toHaveCount(3);
    await expect(submit).toHaveText('Submit 1 comment');
    // No repeated handoff: the refused send and the accepted retry only.
    expect(await readPlanSends(electronApp)).toHaveLength(2);
  } finally {
    if (owner) await restorePlanSendGate(owner.electronApp);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    await closeSharedPlanOwner(owner, apiKey);
  }
});

test('SC7: the agent reads, answers, and resolves a shared plan thread through the file-comment tools', async () => {
  test.setTimeout(240_000);
  const apiKey = 'csk_plan_share_sc7_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000007';
  const planId = 'plan-share-sc7';
  const title = 'Shared plan agent replies';
  const marker = 'Canopy-CPLANSC7';
  const adaThreadId = 'sc7-thread-ada';
  const noteThreadId = 'sc7-thread-note';
  const resolvedThreadId = 'sc7-thread-resolved';
  const adaBody = 'Which step checks the share scope?';
  const noteBody = `[${marker}] Please answer Ada in her thread.`;
  const privateDraft = 'Private draft: keep this out of the agent context.';
  const agentReply = 'The Share step checks the scope before it sends.';
  const agentFinal = 'Answered and resolved the plan thread.';
  const ref = { ...PLAN_REF_DEFAULTS, planId };
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const plan = sharedPlanFixture({
    planId,
    title,
    remoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: adaThreadId,
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor(title),
        comments: [
          remoteComment({
            id: 'sc7-ada-1',
            author: ada,
            body: adaBody,
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
        ],
      }),
      buildPlanCommentThread({
        id: noteThreadId,
        createdAt: '2026-06-11T12:35:00.000Z',
        anchor: generalAnchor(),
        comments: [
          userComment({
            id: 'sc7-note-1',
            body: noteBody,
            createdAt: '2026-06-11T12:35:00.000Z',
            staged: true,
          }),
        ],
      }),
      // Resolved threads are never submitted, so the owner's draft reply in
      // this one is still private when the agent reads the thread.
      buildPlanCommentThread({
        id: resolvedThreadId,
        status: 'resolved',
        createdAt: '2026-06-11T12:20:00.000Z',
        anchor: generalAnchor(),
        comments: [
          remoteComment({
            id: 'sc7-grace-1',
            author: grace,
            body: 'Settled: ship behind the flag.',
            createdAt: '2026-06-11T12:20:00.000Z',
            submittedToChat: true,
          }),
          userComment({
            id: 'sc7-draft-1',
            body: privateDraft,
            createdAt: '2026-06-11T12:25:00.000Z',
            staged: true,
          }),
        ],
      }),
    ],
  });

  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    plans: [sharedPlanServerSeed({ remoteId, plan })],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          // The agent reads for a few seconds first. Acknowledging the
          // submitted comments queues a (debounced) shared-plan sync of its
          // own; this lets that sync finish before the reply, so the pushed
          // resolution below can only come from the reply's own sync.
          text: 'Reading the plan comment threads.',
          streamMs: 6_000,
          chunkChars: 4,
          toolCalls: [
            {
              name: 'mcp__canopy__GetFileComments',
              input: { threadId: adaThreadId },
            },
            {
              name: 'mcp__canopy__GetFileComments',
              input: { threadId: resolvedThreadId },
            },
          ],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            {
              name: 'mcp__canopy__RespondToFileComment',
              input: { threadId: adaThreadId, body: agentReply, resolve: true },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: agentFinal, stopReason: 'end_turn' },
      ],
    },
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({
      apiKey,
      plans: [plan],
      // Tool approval prompts are covered elsewhere; this flow is about the
      // comment tools themselves.
      beforeFirstLaunch: ({ userDataDir }) =>
        seedOrdinaryChatOwner(userDataDir, { approvalMode: 'full-access' }),
    });
    const { window } = owner;
    await waitForSharedPlanStartupSync(window, { apiKey, remoteId, planId });

    const panel = await openPlanPanelInActivityGroup(owner, {
      apiKey,
      remoteId,
      planId,
    });
    const submit = panel.getByTestId('plan-comments-submit');
    const chat = chatPanelLocator(window, ORDINARY_CHAT_ID);
    // The resolved thread's draft is not pending submission.
    await expect(submit).toHaveText('Submit 2 comments');
    await submit.click();
    await expect(chat).toContainText(
      `I have 2 comment threads on the plan "${title}" (plan ${planId}).`,
      { timeout: 30_000 },
    );

    // The agent's reply and resolution land in the plan's own thread.
    await expect
      .poll(
        async () => {
          const thread = (
            await readTrackedPlan(window, ref)
          )?.commentThreads?.find((candidate) => candidate.id === adaThreadId);
          return {
            status: thread?.status,
            comments: thread?.comments.map((comment) => [
              comment.author,
              comment.body,
            ]),
          };
        },
        { timeout: 90_000 },
      )
      .toEqual({
        status: 'resolved',
        comments: [
          ['remote', adaBody],
          ['agent', agentReply],
        ],
      });

    // ...and in the open panel, live: the thread moves to the resolved list.
    await expect(
      panel.getByTestId(`plan-comment-thread-${adaThreadId}`),
    ).toHaveCount(0);
    const archivedToggle = panel.getByTestId('plan-comments-archived-toggle');
    await expect(archivedToggle).toContainText('resolved & outdated (2)');
    await archivedToggle.click();
    const adaThread = panel.getByTestId(`plan-comment-thread-${adaThreadId}`);
    await expect(adaThread).toContainText(agentReply);
    await expect(adaThread).toContainText('Agent');
    await expect(adaThread).toContainText('Resolved');
    await expect(submit).toHaveCount(0);

    // The teammate gets the reply and the resolution through the shared-plan
    // update, without any local-only handoff flags.
    let resolvedPut;
    await expect
      .poll(
        async () => {
          const { puts } = await readSharedPlanRequests(apiKey, remoteId);
          resolvedPut = puts.find((put) =>
            (put.body.commentThreads ?? []).some(
              (thread) =>
                thread.id === adaThreadId &&
                thread.status === 'resolved' &&
                thread.comments.some(
                  (comment) =>
                    comment.author === 'agent' && comment.body === agentReply,
                ),
            ),
          );
          return resolvedPut !== undefined;
        },
        { timeout: 30_000, message: 'the resolution should be pushed' },
      )
      .toBe(true);
    expect(resolvedPut.expectedSnapshotHashMatched).toBe(true);
    expect(startupPutShape(resolvedPut)).not.toMatch(
      /"(?:staged|submittedToChat)"/,
    );
    const detail = await readSharedPlanDetail(apiKey, remoteId);
    const serverThread = detail.commentThreads.find(
      (thread) => thread.id === adaThreadId,
    );
    expect(serverThread.status).toBe('resolved');
    expect(
      serverThread.comments.map((comment) => [comment.author, comment.body]),
    ).toEqual([
      ['remote', adaBody],
      ['agent', agentReply],
    ]);

    // The turn ran in the ordinary chat and is over.
    await expect(chat).toContainText(agentFinal, { timeout: 60_000 });
    await expect
      .poll(() => activeAgentTurns(window), { timeout: 60_000 })
      .toEqual([]);

    // The tools read the plan thread with its owner and history, and never
    // exposed the owner's private draft.
    let results = [];
    await expect
      .poll(() => {
        results = readChatToolResults(owner.userDataDir, ORDINARY_CHAT_ID);
        return results.map((result) => result.toolName);
      })
      .toEqual([
        'mcp__canopy__GetFileComments',
        'mcp__canopy__GetFileComments',
        'mcp__canopy__RespondToFileComment',
      ]);
    const reads = results.filter(
      (result) => result.toolName === 'mcp__canopy__GetFileComments',
    );
    expect(reads).toHaveLength(2);
    const adaRead = reads.find((result) =>
      result.output.includes(`Thread ${adaThreadId} `),
    );
    const resolvedRead = reads.find((result) =>
      result.output.includes(`Thread ${resolvedThreadId} `),
    );
    expect(adaRead?.isError).toBe(false);
    expect(adaRead.output).toContain(
      `Plan "${title}" (plan ${planId}, latest revision 1)`,
    );
    expect(adaRead.output).toContain(
      `Thread ${adaThreadId} [open] (anchor matched)`,
    );
    expect(adaRead.output).toContain('Source: document passage');
    expect(adaRead.output).toContain(`[remote: ${ada.displayName}]`);
    expect(adaRead.output).toContain(adaBody);
    expect(resolvedRead?.isError).toBe(false);
    expect(resolvedRead.output).toContain(
      `Thread ${resolvedThreadId} [resolved]`,
    );
    expect(resolvedRead.output).toContain('[redacted draft]');
    expect(JSON.stringify(results)).not.toContain(privateDraft);
    await expect(chat).not.toContainText(privateDraft);
    const replies = results.filter(
      (result) => result.toolName === 'mcp__canopy__RespondToFileComment',
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].isError).toBe(false);
    expect(replies[0].output).toContain(
      `Reply posted to plan comment thread ${adaThreadId} and the thread was resolved.`,
    );
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    await closeSharedPlanOwner(owner, apiKey);
  }
});

// ── Shared-plan comment edge cases (plan workspace panels SC3, SC4, SC9–SC12) ─
//
// The same real path as SC1/SC2 (mock cloud → main-process cloud client →
// persistence merge → `trackedPlansUpdated` → plan renderer), now through
// split views, a racing draft, thread status and anchor changes, failures,
// two local plans of one remote plan, and the ways a plan view leaves and
// comes back. Failure controls and the two-workspace owner live in
// `sharedPlanCommentHarness.mjs`.

const PLAN_REPLY_PLACEHOLDER =
  'Reply… (Enter to send, Shift+Enter for a new line)';
const SUBSCRIBED_ONCE = { streamConnections: 1, openStreams: 1 };

/** A team-shared plan with ready diagrams (`buildPanelPlan`'s sections). */
function sharedDiagramPlan({ planId, title, remoteId, commentThreads }) {
  return buildTrackedPlan({
    ...buildPanelPlan({
      id: planId,
      title,
      updatedAt: '2026-06-11T12:00:00.000Z',
      withDiagrams: true,
    }),
    share: teamShareState({ remoteId }),
    commentThreads,
  });
}

function teammateReply(id, author, body, createdAt) {
  return { id, author: 'remote', remoteAuthor: author, body, createdAt };
}

async function subscriptionCounters(apiKey, remoteId) {
  const { streamConnections, openStreams } = await sharedPlanCounters(
    apiKey,
    remoteId,
  );
  return { streamConnections, openStreams };
}

async function persistedCommentIds(window, ref, threadId) {
  return threadComments(await readTrackedPlan(window, ref), threadId).map(
    ([id]) => id,
  );
}

test('SC3: a split plan keeps teammate comments current while its document is closed and recreated, and both views share the node threads', async () => {
  test.setTimeout(240_000);
  const apiKey = 'csk_plan_share_sc3_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000003';
  const planId = 'plan-share-sc3';
  const title = 'Shared plan split views';
  const nodeThreadId = 'sc3-node-thread';
  const shipNode = `${planId}-phase-2`;
  const prepareNode = `${planId}-phase-1`;
  const adaQuestion = 'Can Ship wait for the baseline?';
  const graceReply = 'Only if the baseline lands first.';
  const adaFollowUp = 'Then split Ship into two steps.';
  const ownerNodeNote = 'Prepare needs a rollback step.';
  const ref = { ...PLAN_REF_DEFAULTS, planId };
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const plan = sharedDiagramPlan({
    planId,
    title,
    remoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: nodeThreadId,
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: diagramNodeAnchor({
          diagramKind: 'sequence',
          planNodeId: shipNode,
          title: 'Phase 2: Ship',
          headingPath: [title, 'Phase 2: Ship'],
        }),
        comments: [
          remoteComment({
            id: 'sc3-ada-1',
            author: ada,
            body: adaQuestion,
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
        ],
      }),
    ],
  });

  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    plans: [sharedPlanServerSeed({ remoteId, plan })],
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({
      apiKey,
      plans: [plan],
      beforeFirstLaunch: ({ userDataDir }) =>
        seedOrdinaryChatOwner(userDataDir),
    });
    const { electronApp, window } = owner;
    await waitForSharedPlanStartupSync(window, { apiKey, remoteId, planId });
    await expect
      .poll(() => subscriptionCounters(apiKey, remoteId), { timeout: 30_000 })
      .toEqual(SUBSCRIBED_ONCE);

    const doc = await openPlanPanelInActivityGroup(owner, {
      apiKey,
      remoteId,
      planId,
    });
    const nodeThread = doc.getByTestId(`plan-comment-thread-${nodeThreadId}`);
    await expect(nodeThread).toContainText(adaQuestion);
    await expect(nodeThread).toContainText('1 comment');

    // Split the diagram into its own panel.
    await doc.getByTestId('plan-panel-split').click();
    const diagram = planDiagramPanel(window, planId);
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();
    await expect(
      diagram.locator(`.react-flow__node[data-id="${shipNode}"]`),
    ).toBeVisible();

    // A teammate reply reaches the split document live.
    await addSharedPlanReply(
      apiKey,
      remoteId,
      nodeThreadId,
      teammateReply(
        'sc3-grace-1',
        grace,
        graceReply,
        '2026-06-11T12:40:00.000Z',
      ),
    );
    await expect(nodeThread).toContainText(graceReply);
    await expect(nodeThread).toContainText('2 comments');

    // Close the document; the split diagram stays open on its own.
    await closePlanTab(window, planPanelId(planId));
    await expect(doc).toHaveCount(0);
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();

    // With only the diagram open, the next reply still lands...
    await addSharedPlanReply(
      apiKey,
      remoteId,
      nodeThreadId,
      teammateReply('sc3-ada-2', ada, adaFollowUp, '2026-06-11T12:50:00.000Z'),
    );
    await expect
      .poll(() => persistedCommentIds(window, ref, nodeThreadId), {
        timeout: 15_000,
      })
      .toEqual(['sc3-ada-1', 'sc3-grace-1', 'sc3-ada-2']);

    // ...and the owner comments on another node from the diagram.
    await diagram
      .locator(`.react-flow__node[data-id="${prepareNode}"]`)
      .click();
    await diagram.getByTestId('plan-node-add-comment').click();
    await diagram.getByTestId('plan-node-comment-input').fill(ownerNodeNote);
    await diagram.getByTestId('plan-node-comment-save').click();
    let draftThreadId;
    await expect
      .poll(async () => {
        const threads =
          (await readTrackedPlan(window, ref))?.commentThreads ?? [];
        draftThreadId = threads.find((thread) =>
          thread.comments.some((comment) => comment.body === ownerNodeNote),
        )?.id;
        return threads.length;
      })
      .toBe(2);
    expect(typeof draftThreadId).toBe('string');

    // Show document recreates the document; it has every comment, once.
    await diagram.getByTestId('plan-diagram-show-document').click();
    await expect(doc.getByTestId('plan-panel-view')).toBeVisible();
    // The plan is still split, and with both panels on screen neither offers
    // to bring the other forward.
    await expect(diagram.getByTestId('plan-diagram-panel-view')).toBeVisible();
    await expect(doc.getByTestId('plan-panel-tab-diagram')).toHaveCount(0);
    await expect(doc.getByTestId('plan-panel-show-diagram')).toHaveCount(0);
    await expect(diagram.getByTestId('plan-diagram-show-document')).toHaveCount(
      0,
    );
    await expect(nodeThread).toContainText(adaFollowUp);
    await expect(nodeThread).toContainText(graceReply);
    await expect(nodeThread).toContainText('3 comments');
    await expect(nodeThread.locator('ul > li')).toHaveCount(3);
    const draftThread = doc.getByTestId(`plan-comment-thread-${draftThreadId}`);
    await expect(draftThread).toContainText(ownerNodeNote);
    await expect(doc.locator('[data-comment-card]')).toHaveCount(2);
    await expect(doc.getByTestId('plan-comments-submit')).toHaveText(
      'Submit 4 comments',
    );

    // Each thread of the recreated document reveals its node in the split
    // diagram.
    const diagramGroupId = await planGroupOf(
      electronApp,
      window,
      planId,
      'plan-diagram',
    );
    await nodeThread
      .getByRole('button', { name: 'Open “Phase 2: Ship” in the diagram' })
      .click();
    await expect
      .poll(() => revealedDiagramNodeIds(diagram))
      .toEqual([shipNode]);
    await expect.poll(() => getActiveGroupId(window)).toBe(diagramGroupId);
    await draftThread
      .getByRole('button', { name: 'Open “Phase 1: Prepare” in the diagram' })
      .click();
    await expect
      .poll(() => revealedDiagramNodeIds(diagram))
      .toEqual([prepareNode]);

    // Still the same two threads, over the one subscription.
    expect(
      ((await readTrackedPlan(window, ref))?.commentThreads ?? []).map(
        (thread) => thread.id,
      ),
    ).toEqual([nodeThreadId, draftThreadId]);
    expect(await subscriptionCounters(apiKey, remoteId)).toEqual(
      SUBSCRIBED_ONCE,
    );
    await expectNoAgentTurn(window, planId);
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

test('SC4: a teammate reply racing the owner keeps every comment and the open draft edit', async () => {
  test.setTimeout(240_000);
  const apiKey = 'csk_plan_share_sc4_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000004';
  const planId = 'plan-share-sc4';
  const title = 'Shared plan draft races';
  const threadId = 'sc4-thread';
  const draftId = 'sc4-draft-1';
  const adaBody = 'Should the share step validate the team first?';
  const draftBody = 'Yes, and it should say which team.';
  const editedBody = 'Yes, and it should name the team it picked.';
  const graceFirst = 'Naming the team helps reviewers too.';
  const graceSecond = 'Also log the team id.';
  const ownerReply = 'Will do both.';
  const ref = { ...PLAN_REF_DEFAULTS, planId };
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const plan = sharedPlanFixture({
    planId,
    title,
    remoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: threadId,
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor(title),
        comments: [
          remoteComment({
            id: 'sc4-ada-1',
            author: ada,
            body: adaBody,
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
          userComment({
            id: draftId,
            body: draftBody,
            createdAt: '2026-06-11T12:35:00.000Z',
            staged: true,
          }),
        ],
      }),
    ],
  });

  // Every read of the remote plan takes a while, so the owner's writes below
  // land while a teammate refresh is still in flight.
  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    getDelayMs: 2_500,
    plans: [sharedPlanServerSeed({ remoteId, plan })],
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({
      apiKey,
      plans: [plan],
      beforeFirstLaunch: ({ userDataDir }) =>
        seedOrdinaryChatOwner(userDataDir),
    });
    const { window } = owner;
    await waitForSharedPlanStartupSync(window, { apiKey, remoteId, planId });
    await expect
      .poll(() => subscriptionCounters(apiKey, remoteId), { timeout: 30_000 })
      .toEqual(SUBSCRIBED_ONCE);

    const panel = await openPlanPanelInActivityGroup(owner, {
      apiKey,
      remoteId,
      planId,
    });
    const thread = panel.getByTestId(`plan-comment-thread-${threadId}`);
    await expect(thread).toContainText(draftBody);
    await expect(thread.locator('ul > li')).toHaveCount(2);

    // --- The owner is mid-edit when a teammate reply lands -----------------
    await panel.getByTestId(`plan-comment-edit-${draftId}`).click();
    const editInput = panel.getByTestId(`plan-comment-edit-input-${draftId}`);
    await editInput.fill(editedBody);
    await addSharedPlanReply(
      apiKey,
      remoteId,
      threadId,
      teammateReply(
        'sc4-grace-1',
        grace,
        graceFirst,
        '2026-06-11T12:40:00.000Z',
      ),
    );
    await expect(thread).toContainText(graceFirst, { timeout: 20_000 });
    await expect(thread.locator('ul > li')).toHaveCount(3);
    // The edit is still open with the owner's unsaved text, and the stored
    // draft is untouched until it is saved.
    await expect(editInput).toBeVisible();
    await expect(editInput).toHaveValue(editedBody);
    expect(
      threadComments(await readTrackedPlan(window, ref), threadId),
    ).toEqual([
      ['sc4-ada-1', 'remote', adaBody, false],
      [draftId, 'user', draftBody, true],
      ['sc4-grace-1', 'remote', graceFirst, false],
    ]);
    await panel.getByTestId(`plan-comment-edit-save-${draftId}`).click();
    await expect(editInput).toHaveCount(0);
    await expect(thread).toContainText(editedBody);
    await expect
      .poll(async () =>
        threadComments(await readTrackedPlan(window, ref), threadId),
      )
      .toEqual([
        ['sc4-ada-1', 'remote', adaBody, false],
        [draftId, 'user', editedBody, true],
        ['sc4-grace-1', 'remote', graceFirst, false],
      ]);

    // --- A new reply is saved while the next teammate refresh is in flight --
    await thread.getByPlaceholder(PLAN_REPLY_PLACEHOLDER).fill(ownerReply);
    const getsBeforeRace = (await sharedPlanCounters(apiKey, remoteId)).gets;
    await addSharedPlanReply(
      apiKey,
      remoteId,
      threadId,
      teammateReply(
        'sc4-grace-2',
        grace,
        graceSecond,
        '2026-06-11T12:45:00.000Z',
      ),
    );
    await thread.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(thread).toContainText(ownerReply);
    // The teammate read had not answered when the owner's reply was saved.
    expect((await sharedPlanCounters(apiKey, remoteId)).gets).toBe(
      getsBeforeRace,
    );
    await expect(thread).toContainText(graceSecond, { timeout: 20_000 });
    await expect(thread.locator('ul > li')).toHaveCount(5);
    let ownerReplyId;
    await expect
      .poll(
        async () => {
          const comments = threadComments(
            await readTrackedPlan(window, ref),
            threadId,
          );
          ownerReplyId = comments.find(
            ([, author, body]) => author === 'user' && body === ownerReply,
          )?.[0];
          return comments.map(([id, ...rest]) => [
            id === ownerReplyId ? 'owner-reply' : id,
            ...rest,
          ]);
        },
        { timeout: 20_000 },
      )
      .toEqual([
        ['sc4-ada-1', 'remote', adaBody, false],
        [draftId, 'user', editedBody, true],
        ['sc4-grace-1', 'remote', graceFirst, false],
        ['sc4-grace-2', 'remote', graceSecond, false],
        ['owner-reply', 'user', ownerReply, true],
      ]);

    // The owner's reply reaches the shared plan with its own id, beside every
    // teammate comment.
    await expect
      .poll(
        async () =>
          (await readSharedPlanDetail(apiKey, remoteId)).commentThreads
            .find((candidate) => candidate.id === threadId)
            ?.comments.map((comment) => comment.id),
        { timeout: 20_000 },
      )
      .toEqual([
        'sc4-ada-1',
        draftId,
        'sc4-grace-1',
        'sc4-grace-2',
        ownerReplyId,
      ]);

    // A later signal re-reads the plan without losing or doubling anything.
    const getsBeforeEcho = (await sharedPlanCounters(apiKey, remoteId)).gets;
    await emitSharedPlanSignal(apiKey, remoteId);
    await expect
      .poll(async () => (await sharedPlanCounters(apiKey, remoteId)).gets, {
        timeout: 20_000,
      })
      .toBeGreaterThan(getsBeforeEcho);
    await window.evaluate(
      (request) => window.api.activity.plans.refreshComments(request),
      ref,
    );
    await expect(thread.locator('ul > li')).toHaveCount(5);
    expect(await persistedCommentIds(window, ref, threadId)).toEqual([
      'sc4-ada-1',
      draftId,
      'sc4-grace-1',
      'sc4-grace-2',
      ownerReplyId,
    ]);
    await expect(panel.getByTestId('plan-comments-submit')).toHaveText(
      'Submit 5 comments',
    );
    await expectNoAgentTurn(window, planId);
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

test('SC9: a teammate resolving, reopening, or re-anchoring threads updates the plan without a new revision', async () => {
  test.setTimeout(240_000);
  const apiKey = 'csk_plan_share_sc9_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000009';
  const planId = 'plan-share-sc9';
  const title = 'Shared plan thread status';
  const threadId = 'sc9-thread-ada';
  const staleThreadId = 'sc9-thread-stale';
  const uiThreadId = 'sc9-thread-ui';
  const adaBody = 'Is the share step covered by the plan UI?';
  const staleBody = 'The legacy flow needs a migration note.';
  const uiBody = 'Say which tracked plan UI.';
  const ref = { ...PLAN_REF_DEFAULTS, planId };
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const plan = sharedPlanFixture({
    planId,
    title,
    remoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: threadId,
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor(title),
        comments: [
          remoteComment({
            id: 'sc9-ada-1',
            author: ada,
            body: adaBody,
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
        ],
      }),
    ],
  });
  const unchangedRevision = {
    latestRevisionNumber: 1,
    revisions: 1,
    content: plan.content,
  };

  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    plans: [sharedPlanServerSeed({ remoteId, plan })],
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({
      apiKey,
      plans: [plan],
      beforeFirstLaunch: ({ userDataDir }) =>
        seedOrdinaryChatOwner(userDataDir),
    });
    const { window } = owner;
    const revisionState = async () => {
      const current = await readTrackedPlan(window, ref);
      return {
        latestRevisionNumber: current?.latestRevisionNumber,
        revisions: current?.revisions.length,
        content: current?.content,
      };
    };
    const threadState = async (id) => {
      const thread = (await readTrackedPlan(window, ref))?.commentThreads?.find(
        (candidate) => candidate.id === id,
      );
      return thread ? `${thread.status}/${thread.anchorState}` : null;
    };
    await waitForSharedPlanStartupSync(window, { apiKey, remoteId, planId });
    await expect
      .poll(() => subscriptionCounters(apiKey, remoteId), { timeout: 30_000 })
      .toEqual(SUBSCRIBED_ONCE);

    const panel = await openPlanPanelInActivityGroup(owner, {
      apiKey,
      remoteId,
      planId,
    });
    const submit = panel.getByTestId('plan-comments-submit');
    const archivedToggle = panel.getByTestId('plan-comments-archived-toggle');
    const thread = panel.getByTestId(`plan-comment-thread-${threadId}`);
    await expect(thread).toContainText('Open');
    await expect(submit).toHaveText('Submit 1 comment');

    // --- The teammate resolves the thread on the web ----------------------
    await setSharedPlanThreadStatus(apiKey, remoteId, threadId, 'resolved');
    await expect(thread).toHaveCount(0, { timeout: 15_000 });
    await expect(archivedToggle).toContainText('resolved & outdated (1)');
    // A resolved thread has nothing pending.
    await expect(submit).toHaveCount(0);
    await archivedToggle.click();
    await expect(thread).toContainText('Resolved');
    await expect(thread).toContainText(adaBody);
    expect(await threadState(threadId)).toBe('resolved/matched');
    expect(await revisionState()).toEqual(unchangedRevision);

    // --- ...and reopens it ---------------------------------------------------
    await setSharedPlanThreadStatus(apiKey, remoteId, threadId, 'open');
    await expect(thread).toContainText('Open', { timeout: 15_000 });
    await expect(thread).not.toContainText('Resolved');
    await expect(submit).toHaveText('Submit 1 comment');
    expect(await threadState(threadId)).toBe('open/matched');

    // --- The local plan decides each new thread's anchor -------------------
    // The server calls this passage matched, but the owner's plan no longer
    // has it.
    await addSharedPlanThread(apiKey, remoteId, {
      id: staleThreadId,
      status: 'open',
      createdAt: '2026-06-11T12:50:00.000Z',
      anchor: documentAnchor({
        quote: '- Share through the legacy flow.',
        renderedText: 'Share through the legacy flow.',
        lineStart: 7,
        lineEnd: 7,
        headingPath: [title],
      }),
      anchorState: 'matched',
      comments: [
        teammateReply(
          'sc9-grace-1',
          grace,
          staleBody,
          '2026-06-11T12:50:00.000Z',
        ),
      ],
    });
    // The server calls this one outdated, but the plan still has it.
    await addSharedPlanThread(apiKey, remoteId, {
      id: uiThreadId,
      status: 'open',
      createdAt: '2026-06-11T12:55:00.000Z',
      anchor: documentAnchor({
        quote: SHARED_PLAN_UI_PHRASE,
        renderedText: SHARED_PLAN_UI_PHRASE,
        lineStart: 7,
        lineEnd: 7,
        headingPath: [title],
      }),
      anchorState: 'outdated',
      comments: [
        teammateReply('sc9-ada-2', ada, uiBody, '2026-06-11T12:55:00.000Z'),
      ],
    });
    const uiThread = panel.getByTestId(`plan-comment-thread-${uiThreadId}`);
    await expect(uiThread).toContainText(uiBody, { timeout: 15_000 });
    await expect(uiThread).not.toContainText('outdated');
    await expect(archivedToggle).toContainText('resolved & outdated (1)');
    const staleThread = panel.getByTestId(
      `plan-comment-thread-${staleThreadId}`,
    );
    if ((await staleThread.count()) === 0) {
      await archivedToggle.click();
    }
    await expect(staleThread).toContainText(staleBody);
    await expect(staleThread).toContainText('outdated');
    await expect
      .poll(async () => ({
        ada: await threadState(threadId),
        stale: await threadState(staleThreadId),
        ui: await threadState(uiThreadId),
      }))
      .toEqual({
        ada: 'open/matched',
        stale: 'open/outdated',
        ui: 'open/matched',
      });
    // Only the matched passages are highlighted.
    await expect
      .poll(() =>
        window.evaluate(() =>
          [...(CSS.highlights.get('plan-comment-anchor') ?? [])]
            .map(String)
            .sort(),
        ),
      )
      .toEqual([SHARED_PLAN_RENDERED_QUOTE, SHARED_PLAN_UI_PHRASE].sort());
    // Every open thread's comment is pending, outdated or not.
    await expect(submit).toHaveText('Submit 3 comments');

    // None of this made a plan revision or pushed new plan content.
    expect(await revisionState()).toEqual(unchangedRevision);
    const { puts } = await readSharedPlanRequests(apiKey, remoteId);
    expect(puts.every((put) => put.body.content === plan.content)).toBe(true);
    await expectNoAgentTurn(window, planId);
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

test('SC10: a dropped stream and failing reads keep cached comments and drafts usable, and reopening recovers', async () => {
  test.setTimeout(300_000);
  const apiKey = 'csk_plan_share_sc10_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000010';
  const planId = 'plan-share-sc10';
  const title = 'Shared plan offline comments';
  const threadId = 'sc10-thread';
  const noteThreadId = 'sc10-note';
  const noteId = 'sc10-note-1';
  const adaBody = 'Does the share step work offline?';
  const noteBody = 'Check the retry banner copy.';
  const editedNote = 'Check the retry banner copy and its timing.';
  const replayedReply = 'Missed this while you were disconnected.';
  const fallbackReply = 'The read is failing, but this still arrives.';
  const recoveredReply = 'And this one waits for a reopen.';
  const ref = { ...PLAN_REF_DEFAULTS, planId };
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const plan = sharedPlanFixture({
    planId,
    title,
    remoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: threadId,
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor(title),
        comments: [
          remoteComment({
            id: 'sc10-ada-1',
            author: ada,
            body: adaBody,
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
        ],
      }),
      buildPlanCommentThread({
        id: noteThreadId,
        createdAt: '2026-06-11T12:35:00.000Z',
        anchor: generalAnchor(),
        comments: [
          userComment({
            id: noteId,
            body: noteBody,
            createdAt: '2026-06-11T12:35:00.000Z',
            staged: true,
          }),
        ],
      }),
    ],
  });

  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    plans: [sharedPlanServerSeed({ remoteId, plan })],
  });
  let owner;
  try {
    owner = await launchSharedPlanOwner({
      apiKey,
      plans: [plan],
      beforeFirstLaunch: ({ userDataDir }) =>
        seedOrdinaryChatOwner(userDataDir),
    });
    const { window } = owner;
    await waitForSharedPlanStartupSync(window, { apiKey, remoteId, planId });
    await expect
      .poll(() => subscriptionCounters(apiKey, remoteId), { timeout: 30_000 })
      .toEqual(SUBSCRIBED_ONCE);

    const panel = await openPlanPanelInActivityGroup(owner, {
      apiKey,
      remoteId,
      planId,
    });
    const thread = panel.getByTestId(`plan-comment-thread-${threadId}`);
    const note = panel.getByTestId(`plan-comment-thread-${noteThreadId}`);
    const submit = panel.getByTestId('plan-comments-submit');
    await expect(thread).toContainText(adaBody);
    await expect(note).toContainText(noteBody);
    await expect(submit).toHaveText('Submit 2 comments');

    // --- Realtime drop: the reconnect replays what it missed ---------------
    // A first signal gives the stream a point to resume from.
    let counters = await sharedPlanCounters(apiKey, remoteId);
    await emitSharedPlanSignal(apiKey, remoteId);
    await waitForSharedPlanGets(apiKey, remoteId, counters.gets + 1);
    expect((await closeSharedPlanStreams(apiKey, remoteId)).closed).toBe(1);
    await expect
      .poll(
        async () => (await sharedPlanCounters(apiKey, remoteId)).openStreams,
      )
      .toBe(0);
    await addSharedPlanReply(
      apiKey,
      remoteId,
      threadId,
      teammateReply(
        'sc10-grace-1',
        grace,
        replayedReply,
        '2026-06-11T12:40:00.000Z',
      ),
    );
    // The desktop reconnects on its own (after its backoff) and the replayed
    // signal brings the reply into the open panel.
    await expect(thread).toContainText(replayedReply, { timeout: 30_000 });
    expect(await subscriptionCounters(apiKey, remoteId)).toEqual({
      streamConnections: 2,
      openStreams: 1,
    });
    await expect(submit).toHaveText('Submit 3 comments');

    // --- Failing reads (503): bounded retries; cached comments stay usable --
    await setSharedPlanGetFault(apiKey, remoteId, { status: 503 });
    counters = await sharedPlanCounters(apiKey, remoteId);
    await addSharedPlanReply(
      apiKey,
      remoteId,
      threadId,
      teammateReply(
        'sc10-grace-2',
        grace,
        fallbackReply,
        '2026-06-11T12:45:00.000Z',
      ),
    );
    // The signalled read is retried twice, then given up.
    await waitForSharedPlanGets(apiKey, remoteId, counters.gets + 3, {
      message: 'a 503 read should be tried three times',
    });
    await expect(thread).not.toContainText(fallbackReply);
    await expect(thread).toContainText(replayedReply);
    await expect(note).toContainText(noteBody);
    await expect(submit).toHaveText('Submit 3 comments');

    // The owner's draft is still editable.
    await panel.getByTestId(`plan-comment-edit-${noteId}`).click();
    await panel
      .getByTestId(`plan-comment-edit-input-${noteId}`)
      .fill(editedNote);
    await panel.getByTestId(`plan-comment-edit-save-${noteId}`).click();
    await expect(note).toContainText(editedNote);
    // Saving it pushes the plan's comments, and the push's reply carries the
    // teammate comment the failing read missed (the existing fallback).
    await expect
      .poll(
        async () =>
          (await readSharedPlanRequests(apiKey, remoteId)).puts.some((put) =>
            (put.body.commentThreads ?? []).some((candidate) =>
              candidate.comments.some(
                (comment) =>
                  comment.id === noteId && comment.body === editedNote,
              ),
            ),
          ),
        { timeout: 20_000, message: 'the edited draft should be pushed' },
      )
      .toBe(true);
    await expect(thread).toContainText(fallbackReply, { timeout: 20_000 });
    expect((await sharedPlanCounters(apiKey, remoteId)).gets).toBe(
      counters.gets + 3,
    );
    await expect(submit).toHaveText('Submit 4 comments');

    // --- Rejected credentials (401): reopening shows the cache, then recovers
    await setSharedPlanGetFault(apiKey, remoteId, {
      status: 401,
      body: { error: 'Invalid API key.' },
    });
    await addSharedPlanReply(
      apiKey,
      remoteId,
      threadId,
      teammateReply(
        'sc10-grace-3',
        grace,
        recoveredReply,
        '2026-06-11T12:50:00.000Z',
      ),
      { signal: false },
    );
    await closePlanTab(window, planPanelId(planId));
    await expect(panel).toHaveCount(0);
    counters = await sharedPlanCounters(apiKey, remoteId);
    await choosePlanFromMenu(window, ACTIVITY_GROUP_ID, planId);
    // The pull-on-open read is refused once and not retried.
    await waitForSharedPlanGets(apiKey, remoteId, counters.gets + 1, {
      message: 'a 401 read should be tried once',
    });
    await expect(thread).toContainText(fallbackReply);
    await expect(thread).not.toContainText(recoveredReply);
    await expect(note).toContainText(editedNote);
    await expect(submit).toHaveText('Submit 4 comments');

    await setSharedPlanGetFault(apiKey, remoteId, null);
    await closePlanTab(window, planPanelId(planId));
    await expect(panel).toHaveCount(0);
    await choosePlanFromMenu(window, ACTIVITY_GROUP_ID, planId);
    await expect(thread).toContainText(recoveredReply, { timeout: 15_000 });
    await expect(submit).toHaveText('Submit 5 comments');
    expect(
      threadComments(await readTrackedPlan(window, ref), threadId),
    ).toEqual([
      ['sc10-ada-1', 'remote', adaBody, false],
      ['sc10-grace-1', 'remote', replayedReply, false],
      ['sc10-grace-2', 'remote', fallbackReply, false],
      ['sc10-grace-3', 'remote', recoveredReply, false],
    ]);
    expect(
      threadComments(await readTrackedPlan(window, ref), noteThreadId),
    ).toEqual([[noteId, 'user', editedNote, true]]);
    // The failing reads never touched the realtime subscription.
    expect(await subscriptionCounters(apiKey, remoteId)).toEqual({
      streamConnections: 2,
      openStreams: 1,
    });
    await expectNoAgentTurn(window, planId);
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

test('SC11: two local plans of one remote plan share one subscription and one read, and both update', async () => {
  test.setTimeout(300_000);
  const apiKey = 'csk_plan_share_sc11_e2e';
  const remoteId = '66666666-6666-4666-8666-000000000011';
  const unrelatedRemoteId = '66666666-6666-4666-8666-000000000012';
  const mainPlanId = 'plan-share-sc11-main';
  const otherPlanId = 'plan-share-sc11-other';
  const unrelatedPlanId = 'plan-share-sc11-unrelated';
  const title = 'Shared plan in two worktrees';
  const threadId = 'sc11-thread';
  const unrelatedThreadId = 'sc11-unrelated-thread';
  const adaBody = 'Which worktree ships first?';
  const graceReply = 'The main one; the other follows.';
  const mainRef = { ...PLAN_REF_DEFAULTS, planId: mainPlanId };
  const otherRef = {
    projectId: OTHER_WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    planId: otherPlanId,
  };
  const unrelatedRef = { ...PLAN_REF_DEFAULTS, planId: unrelatedPlanId };
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const sharedThread = () => [
    buildPlanCommentThread({
      id: threadId,
      createdAt: '2026-06-11T12:30:00.000Z',
      anchor: sharedPlanAnchor(title),
      comments: [
        remoteComment({
          id: 'sc11-ada-1',
          author: ada,
          body: adaBody,
          createdAt: '2026-06-11T12:30:00.000Z',
        }),
      ],
    }),
  ];
  const mainPlan = sharedPlanFixture({
    planId: mainPlanId,
    title,
    remoteId,
    commentThreads: sharedThread(),
  });
  const otherPlan = sharedPlanFixture({
    planId: otherPlanId,
    title,
    remoteId,
    projectId: OTHER_WORKSPACE_ID,
    commentThreads: sharedThread(),
  });
  const unrelatedPlan = sharedPlanFixture({
    planId: unrelatedPlanId,
    title: 'Unrelated shared plan',
    remoteId: unrelatedRemoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: unrelatedThreadId,
        createdAt: '2026-06-11T12:20:00.000Z',
        anchor: sharedPlanAnchor('Unrelated shared plan'),
        comments: [
          remoteComment({
            id: 'sc11-unrelated-1',
            author: grace,
            body: 'Nothing to do with the other plan.',
            createdAt: '2026-06-11T12:20:00.000Z',
          }),
        ],
      }),
    ],
  });

  // Both local plans push their own snapshot at startup, so the second push
  // cannot carry the first one's snapshot hash; this flow is about the shared
  // subscription and read, not about that conflict. Reads take a moment, so a
  // signal's refreshes of both local plans overlap.
  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    enforceSnapshotHash: false,
    getDelayMs: 1_500,
    plans: [
      sharedPlanServerSeed({ remoteId, plan: mainPlan }),
      sharedPlanServerSeed({
        remoteId: unrelatedRemoteId,
        plan: unrelatedPlan,
      }),
    ],
  });
  let owner;
  try {
    owner = await launchSharedPlanOwnerInWorkspaces({
      apiKey,
      plansByWorkspace: {
        [WORKSPACE_ID]: [mainPlan, unrelatedPlan],
        [OTHER_WORKSPACE_ID]: [otherPlan],
      },
    });
    const { window, app } = owner;

    // Startup enrolls both local plans against the one remote plan...
    await waitForSharedPlanStartupSync(window, {
      apiKey,
      remoteId,
      planId: mainPlanId,
      expectedPuts: 2,
    });
    await expect
      .poll(async () => (await readTrackedPlan(window, otherRef))?.share, {
        timeout: 30_000,
      })
      .toMatchObject({ remoteId, syncStatus: 'synced' });
    await waitForSharedPlanStartupSync(window, {
      apiKey,
      remoteId: unrelatedRemoteId,
      planId: unrelatedPlanId,
    });
    // ...over one realtime subscription per remote plan.
    await expect
      .poll(() => subscriptionCounters(apiKey, remoteId), { timeout: 30_000 })
      .toEqual(SUBSCRIBED_ONCE);
    await expect
      .poll(() => subscriptionCounters(apiKey, unrelatedRemoteId), {
        timeout: 30_000,
      })
      .toEqual(SUBSCRIBED_ONCE);

    await app.openMainPage();
    await selectWorkspaceWorktree(window, WORKSPACE_ID);
    await expect(window.getByTestId('activity-plans-section')).toBeVisible({
      timeout: 30_000,
    });
    await window.getByTestId(`activity-plan-row-${mainPlanId}`).click();
    const mainPanel = planDocumentPanel(window, mainPlanId);
    const mainThread = mainPanel.getByTestId(`plan-comment-thread-${threadId}`);
    await expect(mainThread).toContainText(adaBody, { timeout: 15_000 });
    // Barrier (see SC2): join the pull-on-open read.
    await window.evaluate(
      (request) => window.api.activity.plans.refreshComments(request),
      mainRef,
    );
    const before = await sharedPlanCounters(apiKey, remoteId);
    const unrelatedBefore = await sharedPlanCounters(apiKey, unrelatedRemoteId);
    const unrelatedThreads = (await readTrackedPlan(window, unrelatedRef))
      .commentThreads;

    // One teammate reply, one signal.
    await addSharedPlanReply(
      apiKey,
      remoteId,
      threadId,
      teammateReply(
        'sc11-grace-1',
        grace,
        graceReply,
        '2026-06-11T12:40:00.000Z',
      ),
    );
    await expect(mainThread).toContainText(graceReply, { timeout: 15_000 });
    await expect(mainThread).toContainText('2 comments');
    await expect
      .poll(() => persistedCommentIds(window, otherRef, threadId), {
        timeout: 15_000,
      })
      .toEqual(['sc11-ada-1', 'sc11-grace-1']);
    expect(await persistedCommentIds(window, mainRef, threadId)).toEqual([
      'sc11-ada-1',
      'sc11-grace-1',
    ]);
    // Both local plans were refreshed by one coalesced read.
    expect((await sharedPlanCounters(apiKey, remoteId)).gets).toBe(
      before.gets + 1,
    );
    // The unrelated shared plan was neither read nor changed.
    expect((await sharedPlanCounters(apiKey, unrelatedRemoteId)).gets).toBe(
      unrelatedBefore.gets,
    );
    expect(
      (await readTrackedPlan(window, unrelatedRef)).commentThreads,
    ).toEqual(unrelatedThreads);

    // The other worktree's plan shows the reply too.
    await selectWorkspaceWorktree(window, OTHER_WORKSPACE_ID);
    await expect(window.getByTestId('activity-plans-section')).toBeVisible({
      timeout: 30_000,
    });
    await window.getByTestId(`activity-plan-row-${otherPlanId}`).click();
    const otherThread = planDocumentPanel(window, otherPlanId).getByTestId(
      `plan-comment-thread-${threadId}`,
    );
    await expect(otherThread).toContainText(graceReply, { timeout: 15_000 });
    await expect(otherThread.locator('ul > li')).toHaveCount(2);

    expect(await subscriptionCounters(apiKey, remoteId)).toEqual(
      SUBSCRIBED_ONCE,
    );
    expect(await subscriptionCounters(apiKey, unrelatedRemoteId)).toEqual(
      SUBSCRIBED_ONCE,
    );
    await expectNoAgentTurn(window, mainPlanId);
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

/**
 * Two team-shared plans in the demo worktree for SC12, each with one teammate
 * thread.
 */
function sc12Plans({ roadmapRemoteId, rolloutRemoteId }) {
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const roadmap = sharedPlanFixture({
    planId: 'plan-share-sc12-roadmap',
    title: 'Shared roadmap',
    remoteId: roadmapRemoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: 'sc12-roadmap-thread',
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor('Shared roadmap'),
        comments: [
          remoteComment({
            id: 'sc12-roadmap-1',
            author: ada,
            body: 'Roadmap: who owns the share step?',
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
        ],
      }),
    ],
  });
  const rollout = sharedPlanFixture({
    planId: 'plan-share-sc12-rollout',
    title: 'Shared rollout',
    remoteId: rolloutRemoteId,
    commentThreads: [
      buildPlanCommentThread({
        id: 'sc12-rollout-thread',
        createdAt: '2026-06-11T12:30:00.000Z',
        anchor: sharedPlanAnchor('Shared rollout'),
        comments: [
          remoteComment({
            id: 'sc12-rollout-1',
            author: grace,
            body: 'Rollout: stage it behind a flag?',
            createdAt: '2026-06-11T12:30:00.000Z',
          }),
        ],
      }),
    ],
  });
  return { roadmap, rollout };
}

/**
 * Launch the SC12 owner across both demo workspaces, wait for both plans'
 * startup sync and single subscription, select the demo worktree, and open
 * both plans as tabs of a new group below the activity panel (rollout
 * active).
 */
async function openSc12Plans({
  apiKey,
  roadmapRemoteId,
  rolloutRemoteId,
  roadmap,
  rollout,
}) {
  await registerSharedPlanScenario(apiKey, {
    stream: 'enabled',
    plans: [
      sharedPlanServerSeed({ remoteId: roadmapRemoteId, plan: roadmap }),
      sharedPlanServerSeed({ remoteId: rolloutRemoteId, plan: rollout }),
    ],
  });
  const owner = await launchSharedPlanOwnerInWorkspaces({
    apiKey,
    plansByWorkspace: { [WORKSPACE_ID]: [roadmap, rollout] },
    beforeFirstLaunch: ({ userDataDir }) => seedOrdinaryChatOwner(userDataDir),
  });
  const { window, app } = owner;
  for (const [remoteId, plan] of [
    [roadmapRemoteId, roadmap],
    [rolloutRemoteId, rollout],
  ]) {
    await waitForSharedPlanStartupSync(window, {
      apiKey,
      remoteId,
      planId: plan.id,
    });
    await expect
      .poll(() => subscriptionCounters(apiKey, remoteId), { timeout: 30_000 })
      .toEqual(SUBSCRIBED_ONCE);
  }

  await app.openMainPage();
  await selectWorkspaceWorktree(window, WORKSPACE_ID);
  await expect(chatPanelLocator(window, ORDINARY_CHAT_ID)).toBeVisible({
    timeout: 30_000,
  });
  const planGroupId = await splitViaApi(window, ACTIVITY_GROUP_ID, 'down');
  for (const plan of [roadmap, rollout]) {
    await choosePlanFromMenu(window, planGroupId, plan.id);
    await expect(
      planDocumentPanel(window, plan.id).getByTestId('plan-panel-view'),
    ).toHaveAttribute('data-plan-id', plan.id);
    // Barrier (see SC2): join the pull-on-open read.
    await window.evaluate(
      (request) => window.api.activity.plans.refreshComments(request),
      { ...PLAN_REF_DEFAULTS, planId: plan.id },
    );
  }
  return { owner, planGroupId };
}

function selectPlanTab(page, planId) {
  return page.getByTestId(`panel-tab-${planPanelId(planId)}`).click();
}

test('SC12: plan and worktree switches, hiding the page, and a reload keep each plan its own comments without extra subscriptions', async () => {
  test.setTimeout(360_000);
  const apiKey = 'csk_plan_share_sc12_e2e';
  const roadmapRemoteId = '66666666-6666-4666-8666-000000000013';
  const rolloutRemoteId = '66666666-6666-4666-8666-000000000014';
  const { roadmap, rollout } = sc12Plans({ roadmapRemoteId, rolloutRemoteId });
  const roadmapRef = { ...PLAN_REF_DEFAULTS, planId: roadmap.id };
  const rolloutRef = { ...PLAN_REF_DEFAULTS, planId: rollout.id };
  const roadmapThreadId = 'sc12-roadmap-thread';
  const rolloutThreadId = 'sc12-rollout-thread';
  const whileOtherPlan = 'Roadmap reply while the rollout tab was shown.';
  const whileOtherWorktree = 'Rollout reply while another worktree was open.';
  const whileHidden = 'Roadmap reply while the main page was hidden.';
  const duringReload = 'Rollout reply that landed during a reload.';
  const { ada, grace } = SHARED_PLAN_TEAMMATES;
  const expectSubscribedOnce = async () => {
    expect(await subscriptionCounters(apiKey, roadmapRemoteId)).toEqual(
      SUBSCRIBED_ONCE,
    );
    expect(await subscriptionCounters(apiKey, rolloutRemoteId)).toEqual(
      SUBSCRIBED_ONCE,
    );
  };
  let owner;
  try {
    ({ owner } = await openSc12Plans({
      apiKey,
      roadmapRemoteId,
      rolloutRemoteId,
      roadmap,
      rollout,
    }));
    const { window, app } = owner;
    const roadmapPanel = planDocumentPanel(window, roadmap.id);
    const rolloutPanel = planDocumentPanel(window, rollout.id);
    const roadmapThread = roadmapPanel.getByTestId(
      `plan-comment-thread-${roadmapThreadId}`,
    );
    const rolloutThread = rolloutPanel.getByTestId(
      `plan-comment-thread-${rolloutThreadId}`,
    );
    await expect(rolloutPanel.getByTestId('plan-panel-view')).toBeVisible();
    await expect(roadmapPanel.getByTestId('plan-panel-view')).toBeHidden();

    // --- Plan switch: the hidden plan's reply waits in its own plan --------
    await addSharedPlanReply(
      apiKey,
      roadmapRemoteId,
      roadmapThreadId,
      teammateReply(
        'sc12-roadmap-2',
        grace,
        whileOtherPlan,
        '2026-06-11T12:40:00.000Z',
      ),
    );
    await expect
      .poll(() => persistedCommentIds(window, roadmapRef, roadmapThreadId), {
        timeout: 15_000,
      })
      .toEqual(['sc12-roadmap-1', 'sc12-roadmap-2']);
    await expect(rolloutPanel).not.toContainText(whileOtherPlan);
    await selectPlanTab(window, roadmap.id);
    await expect(roadmapThread).toContainText(whileOtherPlan);
    await expect(roadmapThread.locator('ul > li')).toHaveCount(2);

    // --- Worktree switch: a reply lands while another worktree is open -----
    await selectWorkspaceWorktree(window, OTHER_WORKSPACE_ID);
    await addSharedPlanReply(
      apiKey,
      rolloutRemoteId,
      rolloutThreadId,
      teammateReply(
        'sc12-rollout-2',
        ada,
        whileOtherWorktree,
        '2026-06-11T12:45:00.000Z',
      ),
    );
    await expect
      .poll(() => persistedCommentIds(window, rolloutRef, rolloutThreadId), {
        timeout: 15_000,
      })
      .toEqual(['sc12-rollout-1', 'sc12-rollout-2']);
    await selectWorkspaceWorktree(window, WORKSPACE_ID);
    await expect(roadmapThread).toContainText(whileOtherPlan, {
      timeout: 15_000,
    });
    await selectPlanTab(window, rollout.id);
    await expect(rolloutThread).toContainText(whileOtherWorktree);
    await expect(rolloutThread.locator('ul > li')).toHaveCount(2);
    await expect(rolloutPanel).not.toContainText(whileOtherPlan);

    // --- Hide: another page is shown while a reply lands --------------------
    await selectPlanTab(window, roadmap.id);
    await app.openPipelinesPage();
    await expect(roadmapPanel.getByTestId('plan-panel-view')).toBeHidden();
    await addSharedPlanReply(
      apiKey,
      roadmapRemoteId,
      roadmapThreadId,
      teammateReply(
        'sc12-roadmap-3',
        ada,
        whileHidden,
        '2026-06-11T12:50:00.000Z',
      ),
    );
    await expect
      .poll(() => persistedCommentIds(window, roadmapRef, roadmapThreadId), {
        timeout: 15_000,
      })
      .toEqual(['sc12-roadmap-1', 'sc12-roadmap-2', 'sc12-roadmap-3']);
    await app.openMainPage();
    await expect(roadmapThread).toContainText(whileHidden);
    await expect(roadmapThread.locator('ul > li')).toHaveCount(3);
    await expectSubscribedOnce();

    // --- Reload: a reply that lands meanwhile is there after the reload -----
    await addSharedPlanReply(
      apiKey,
      rolloutRemoteId,
      rolloutThreadId,
      teammateReply(
        'sc12-rollout-3',
        grace,
        duringReload,
        '2026-06-11T12:55:00.000Z',
      ),
      { signal: false },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await selectWorkspaceWorktree(window, WORKSPACE_ID);
    await selectPlanTab(window, rollout.id);
    await expect(rolloutThread).toContainText(duringReload, {
      timeout: 15_000,
    });
    await expect(rolloutThread.locator('ul > li')).toHaveCount(3);
    await selectPlanTab(window, roadmap.id);
    await expect(roadmapThread.locator('ul > li')).toHaveCount(3);

    // No cross-plan contamination, and still one subscription per plan.
    expect(
      (await readTrackedPlan(window, roadmapRef)).commentThreads.map(
        (thread) => [thread.id, thread.comments.map((comment) => comment.id)],
      ),
    ).toEqual([
      [roadmapThreadId, ['sc12-roadmap-1', 'sc12-roadmap-2', 'sc12-roadmap-3']],
    ]);
    expect(
      (await readTrackedPlan(window, rolloutRef)).commentThreads.map(
        (thread) => [thread.id, thread.comments.map((comment) => comment.id)],
      ),
    ).toEqual([
      [rolloutThreadId, ['sc12-rollout-1', 'sc12-rollout-2', 'sc12-rollout-3']],
    ]);
    await expectSubscribedOnce();
    await expectNoAgentTurn(window, roadmap.id);
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

test('SC12: a popped-out plan shows teammate replies, and closing its window keeps them', async () => {
  test.setTimeout(300_000);
  const apiKey = 'csk_plan_share_sc12_aux_e2e';
  const roadmapRemoteId = '66666666-6666-4666-8666-000000000015';
  const rolloutRemoteId = '66666666-6666-4666-8666-000000000016';
  const { roadmap, rollout } = sc12Plans({ roadmapRemoteId, rolloutRemoteId });
  const roadmapRef = { ...PLAN_REF_DEFAULTS, planId: roadmap.id };
  const roadmapThreadId = 'sc12-roadmap-thread';
  const whilePoppedOut = 'Roadmap reply while the plan was popped out.';
  const { grace } = SHARED_PLAN_TEAMMATES;
  let owner;
  try {
    let planGroupId;
    ({ owner, planGroupId } = await openSc12Plans({
      apiKey,
      roadmapRemoteId,
      rolloutRemoteId,
      roadmap,
      rollout,
    }));
    const { electronApp, window } = owner;
    await selectPlanTab(window, roadmap.id);

    const aux = await popOutGroup(electronApp, window, planGroupId);
    const auxThread = planDocumentPanel(aux, roadmap.id).getByTestId(
      `plan-comment-thread-${roadmapThreadId}`,
    );
    await expect(auxThread).toContainText('Roadmap: who owns the share step?');

    await addSharedPlanReply(
      apiKey,
      roadmapRemoteId,
      roadmapThreadId,
      teammateReply(
        'sc12-roadmap-2',
        grace,
        whilePoppedOut,
        '2026-06-11T12:40:00.000Z',
      ),
    );
    await expect
      .poll(() => persistedCommentIds(window, roadmapRef, roadmapThreadId), {
        timeout: 15_000,
      })
      .toEqual(['sc12-roadmap-1', 'sc12-roadmap-2']);
    // The popped-out plan shows the reply live.
    await expect(auxThread).toContainText(whilePoppedOut, { timeout: 15_000 });

    // Closing the window brings the plans back with every comment.
    await closeAuxWindows(electronApp);
    const roadmapThread = planDocumentPanel(window, roadmap.id).getByTestId(
      `plan-comment-thread-${roadmapThreadId}`,
    );
    await selectPlanTab(window, roadmap.id);
    await expect(roadmapThread).toContainText(whilePoppedOut);
    await expect(roadmapThread.locator('ul > li')).toHaveCount(2);
    await expect(planDocumentPanel(window, rollout.id)).not.toContainText(
      whilePoppedOut,
    );
    expect(await subscriptionCounters(apiKey, roadmapRemoteId)).toEqual(
      SUBSCRIBED_ONCE,
    );
    expect(await subscriptionCounters(apiKey, rolloutRemoteId)).toEqual(
      SUBSCRIBED_ONCE,
    );
  } finally {
    await closeSharedPlanOwner(owner, apiKey);
  }
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { mergeSeedPreferences } from './seeders/mergePreferences.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { interactiveQuestions } from './seeders/seedInteractiveQuestion.mjs';
import {
  COWORK_RESUME_CHAT_TITLE,
  COWORK_RESUME_MESSAGE,
  COWORK_RESUME_WORKSPACE_NAME,
  seedCoworkResumeChecklist,
} from './seeders/seedCoworkResumeChecklist.mjs';

// ---------------------------------------------------------------------------
// Startup Resume offer — the app never auto-navigates to the MRU
// workspace/worktree/chat on launch anymore. Startup always lands on the Home
// composer; when the persisted `lastActiveContext` still resolves to a live
// target, the Home surface shows a "Continue" recommendation row
// (`home-resume-card`) whose SuggestionRow action performs the navigation the
// old auto-redirect used to do.
//
// Offer lifecycle under test:
//   - a seeded worktree MRU lands on Home (page-main stays hidden) WITH the
//     recommendation row, showing workspace + worktree details;
//   - navigating to another app area (Pipelines) and back preserves it;
//   - clicking Resume navigates to the Code page with the offered worktree's
//     chat panel mounted, and the offer is gone afterwards;
//   - manually navigating into any worktree (sidebar row click) clears the
//     offer without ever visiting the card.
//
// Determinism: no live agents, no network. Everything is seeded persisted
// JSON plus the demo-workspace fixture.
// ---------------------------------------------------------------------------

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';
const CHAT_TITLE = 'Seeded resume chat';
// The seeded worktree keeps its generated default branch, displayed as this
// placeholder; Last viewed names it by its chat title instead (CAN-5008).
const DEFAULT_BRANCH_PLACEHOLDER = 'New Task';

function seedResumeData() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-startup-resume-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
  // A titled chat tab so the Resume card's details line can surface the
  // active chat (tabs hydrate eagerly at startup via loadAllWorktreeTabs).
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [{ id: 'seeded-resume-chat', title: CHAT_TITLE }],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
          legalConsentTosVersion: '2026-07-06',
          lastActiveContext: {
            kind: 'worktree',
            workspaceId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return userDataDir;
}

// CAN-5008: an unlabeled worktree on a named branch is named by its chat
// title, with the branch as secondary context; a label still wins.
const NAMED_WORKTREE_ID = 'checkout-labels';
const NAMED_BRANCH = 'checkout-form-labels';
const NAMED_CHAT_TITLE = 'Label checkout form inputs';
const NAMED_CHAT_MESSAGE = 'Seeded checkout label message.';
const NAMED_WORKTREE_LABEL = 'Storefront fixes';

function seedNamedBranchResume({ label } = {}) {
  const userDataDir = seedResumeData();
  const directory = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  // Create the branch in the seeded checkout so git refresh agrees with the
  // persisted worktree metadata.
  execFileSync(
    'git',
    [
      '-C',
      path.join(directory, 'worktrees', WORKTREE_ID),
      'worktree',
      'add',
      '-b',
      NAMED_BRANCH,
      path.join(directory, 'worktrees', NAMED_WORKTREE_ID),
      'HEAD',
    ],
    { stdio: 'pipe' },
  );
  const file = path.join(directory, 'worktrees.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeJson(file, {
    ...data,
    worktrees: [
      ...data.worktrees,
      {
        id: NAMED_WORKTREE_ID,
        branchName: NAMED_BRANCH,
        createdAt: '2026-10-29T00:00:00.000Z',
        trackedBaseBranch: 'main',
        ...(label === undefined ? {} : { label }),
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: NAMED_WORKTREE_ID,
    tabs: [
      {
        id: 'checkout-labels-chat',
        title: NAMED_CHAT_TITLE,
        blocks: [{ type: 'text', text: NAMED_CHAT_MESSAGE }],
      },
    ],
  });
  mergeSeedPreferences(userDataDir, {
    lastActiveContext: {
      kind: 'worktree',
      workspaceId: WORKSPACE_ID,
      worktreeId: NAMED_WORKTREE_ID,
    },
  });
  return userDataDir;
}

// Home Continue attention (CAN-4958): the Last viewed destination is the
// second workspace's worktree, while the first workspace's worktree carries a
// real ask-user question and two finished unread chats. Each worktree has
// several tabs, and an unread result is active, so opening another attention
// chat must not acknowledge the unseen restored tab.
const ATTENTION_DEMO_APP_ID = 'ts-npm-next';
const ATTENTION_LAST_VIEWED_WORKSPACE_ID = 'demo-ts-npm-next';

function seedAttentionData() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-startup-attention-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: [DEMO_APP_ID, ATTENTION_DEMO_APP_ID],
  });
  const finished = (id, title, timestamp) => ({
    id,
    title,
    lastAcceptedUserMessageId: `${id}-user`,
    turnEnds: { [`${id}-user`]: { outcome: 'completed', endedAt: timestamp } },
    unread: true,
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        timestamp: timestamp - 1000,
        blocks: [{ type: 'text', text: 'Finish this task.' }],
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        timestamp,
        blocks: [{ type: 'text', text: `${title} is done.` }],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: 'finished-c',
    tabs: [
      { id: 'idle', title: 'Idle chat', messages: [] },
      {
        id: 'interactive',
        title: 'Release details',
        messages: [
          {
            id: 'question-user',
            role: 'user',
            timestamp: 1788782300000,
            blocks: [{ type: 'text', text: 'Prepare the release.' }],
          },
          {
            id: 'interactive-message',
            role: 'assistant',
            timestamp: 1788782400000,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'interactive-tool',
                toolName: 'mcp__canopy__AskUserQuestion',
                input: JSON.stringify({ questions: interactiveQuestions }),
              },
            ],
          },
        ],
      },
      finished('finished-c', 'Finished C', 1788782500000),
      finished('finished-d', 'Finished D', 1788782600000),
    ],
    pendingQuestions: [
      {
        requestId: 'interactive-request',
        chatId: 'interactive',
        toolUseId: 'interactive-tool',
        questions: interactiveQuestions,
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: ATTENTION_LAST_VIEWED_WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      { id: 'viewed-a', title: 'Viewed chat' },
      { id: 'viewed-b', title: 'Second viewed chat' },
    ],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
          legalConsentTosVersion: '2026-07-06',
          lastActiveContext: {
            kind: 'worktree',
            workspaceId: ATTENTION_LAST_VIEWED_WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return userDataDir;
}

test.describe('Startup Resume offer', () => {
  test('lands on Home with the Resume card; other-page navigation preserves it; dismiss hides it', async () => {
    const userDataDir = seedResumeData();
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Startup routing must land on Home — no auto-redirect to the Code
      // page despite the live worktree MRU.
      await expect(window.getByTestId('page-home')).toBeVisible();
      await expect(window.getByTestId('page-main')).toBeHidden();

      const card = window
        .getByTestId('page-home')
        .getByTestId('home-resume-card');
      await expect(card).toBeVisible({ timeout: 15_000 });
      const details = card.getByTestId('home-resume-details');
      await expect(details).toContainText(WORKSPACE_NAME);
      await expect(details.getByTestId('home-resume-destination')).toHaveText(
        CHAT_TITLE,
      );
      await expect(details).not.toContainText(DEFAULT_BRANCH_PLACEHOLDER);
      await expect(details.getByTestId('home-resume-chat-title')).toHaveCount(
        0,
      );
      await expect(
        details.getByTestId('home-resume-worktree-name'),
      ).toHaveCount(0);

      // Navigating to another app area (not a workspace/worktree/chat) must
      // NOT clear the offer. (The card has no dismiss control; it clears via
      // Resume or by navigating to any workspace/worktree/chat.)
      await app.openPipelinesPage();
      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await expect(card).toBeVisible();
      await expect(card.getByTestId('home-resume-dismiss')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Resume click navigates to the offered worktree chat and consumes the offer', async () => {
    const userDataDir = seedResumeData();
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const card = window
        .getByTestId('page-home')
        .getByTestId('home-resume-card');
      await expect(card).toBeVisible({ timeout: 15_000 });

      await card.getByTestId('home-resume-button').click();

      // The old auto-redirect destination, now reached only on click: the
      // Code page with the offered worktree selected and its chat mounted.
      await app.expectMainPage();
      await expect(window.getByTestId('panel-content-chat')).toBeVisible({
        timeout: 15_000,
      });

      // Back on Home the offer is gone — it was consumed by resuming.
      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await expect(card).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('manually navigating into a worktree clears the offer', async () => {
    const userDataDir = seedResumeData();
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const card = window
        .getByTestId('page-home')
        .getByTestId('home-resume-card');
      await expect(card).toBeVisible({ timeout: 15_000 });

      // Select the worktree directly from the sidebar instead of using the
      // card — navigating into any workspace/worktree/chat retires the offer.
      await app.selectWorktree(WORKTREE_ID);
      await app.expectMainPage();

      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await expect(card).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('names an unlabeled named-branch worktree by its chat title across relaunch (CAN-5008)', async () => {
    const userDataDir = seedNamedBranchResume();
    let { electronApp } = await launchCanopy({ userDataDir });
    let keepUserData = true;

    const expectTitleNamedRow = async (window) => {
      const details = window
        .getByTestId('page-home')
        .getByTestId('home-resume-details');
      await expect(details.getByTestId('home-resume-destination')).toHaveText(
        NAMED_CHAT_TITLE,
        { timeout: 15_000 },
      );
      await expect(details.getByTestId('home-resume-worktree-name')).toHaveText(
        NAMED_BRANCH,
      );
      await expect(details.getByTestId('home-resume-chat-title')).toHaveCount(
        0,
      );
      await expect(details).toContainText(
        `${NAMED_BRANCH} · ${WORKSPACE_NAME}`,
      );
      return details;
    };

    try {
      let window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await expectTitleNamedRow(window);

      const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
      await expect
        .poll(() => {
          const persisted = readChatStorageTabs(
            workspaceRoot,
            NAMED_WORKTREE_ID,
          );
          const manifest = JSON.parse(
            readFileSync(path.join(workspaceRoot, 'worktrees.json'), 'utf8'),
          );
          return {
            title: persisted.tabs.find(
              (tab) => tab.id === 'checkout-labels-chat',
            )?.title,
            branch: manifest.worktrees.find(
              (worktree) => worktree.id === NAMED_WORKTREE_ID,
            )?.branchName,
          };
        })
        .toEqual({ title: NAMED_CHAT_TITLE, branch: NAMED_BRANCH });

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      ({ electronApp } = await launchCanopy({ userDataDir }));
      keepUserData = false;
      window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const details = await expectTitleNamedRow(window);

      await details.getByTestId('home-resume-button').click();
      await app.expectMainPage();
      await expect(window.getByTestId('panel-content-chat')).toContainText(
        NAMED_CHAT_MESSAGE,
        { timeout: 15_000 },
      );
      await expect
        .poll(async () => {
          const snapshot = (await getAdvisorUiState(electronApp)).uiState
            ?.snapshot;
          return {
            projectId: snapshot?.selectedWorktree?.projectId,
            worktreeId: snapshot?.selectedWorktree?.worktreeId,
            chatId: snapshot?.activeChat?.chatId,
          };
        })
        .toEqual({
          projectId: WORKSPACE_ID,
          worktreeId: NAMED_WORKTREE_ID,
          chatId: 'checkout-labels-chat',
        });
    } finally {
      await closeCanopy(electronApp, userDataDir, { keepUserData });
    }
  });

  test('keeps a labeled worktree named by its label with the chat title secondary (CAN-5008)', async () => {
    const userDataDir = seedNamedBranchResume({ label: NAMED_WORKTREE_LABEL });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const details = window
        .getByTestId('page-home')
        .getByTestId('home-resume-details');
      await expect(details.getByTestId('home-resume-destination')).toHaveText(
        NAMED_WORKTREE_LABEL,
        { timeout: 15_000 },
      );
      await expect(details.getByTestId('home-resume-chat-title')).toHaveText(
        NAMED_CHAT_TITLE,
      );
      await expect(
        details.getByTestId('home-resume-worktree-name'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-4746: advanced Getting started suggestions used to replace the
  // Continue row entirely, so a returning user lost their way back.
  test('keeps Continue above ordinary suggestions across relaunch and resume', async () => {
    const userDataDir = seedCoworkResumeChecklist();
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // The embedded Home in MainPage renders the same test ids; scope every
      // locator to the visible page-variant Home.
      // Replay renderer hydration with a sampler installed before its first
      // frame. A settled screenshot cannot detect a three-row flash.
      await window.addInitScript(() => {
        window.__resumeHomeFrames = [];
        const sample = () => {
          const home = document.querySelector('[data-testid="page-home"]');
          if (home?.getBoundingClientRect().height) {
            const resume = home.querySelector(
              '[data-testid="home-resume-details"]',
            );
            const rows = home.querySelectorAll(
              '[data-testid="suggested-prompt-chip"]',
            );
            window.__resumeHomeFrames.push({
              resume: Boolean(resume),
              rows: rows.length,
              composerY: home
                .querySelector('[data-testid="home-composer"]')
                ?.getBoundingClientRect().y,
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      const home = window.getByTestId('page-home');
      await expect(home).toBeVisible();
      const suggestions = home.getByTestId('suggested-prompt-chips');
      const rows = suggestions.locator('[data-testid="suggested-prompt-chip"]');
      await expect(suggestions).toBeVisible({ timeout: 15_000 });

      const card = home.getByTestId('home-resume-card');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId('home-resume-details')).toContainText(
        COWORK_RESUME_WORKSPACE_NAME,
      );

      // Continue sits directly below the composer, ahead of Getting started.
      const followingSuggestions = suggestions;
      expect(
        await card.evaluate(
          (resume, other) =>
            Boolean(
              resume.compareDocumentPosition(other) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          await followingSuggestions.elementHandle(),
        ),
      ).toBe(true);
      const cardBox = await card.boundingBox();
      const onboardingBox = await followingSuggestions.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(onboardingBox).not.toBeNull();
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(onboardingBox.y);

      await expect(rows.first()).toBeVisible();
      await expect
        .poll(() =>
          window.evaluate(
            () =>
              window.__resumeHomeFrames.filter(
                (frame) => frame.resume && frame.rows > 0,
              ).length,
          ),
        )
        .toBeGreaterThan(1);
      await card.getByTestId('home-resume-button').click();
      await app.expectChatPage();
      // Friday's chat, by its unique seeded title and message.
      const chatPage = window.getByTestId('page-chat');
      await expect(chatPage).toContainText(COWORK_RESUME_CHAT_TITLE, {
        timeout: 15_000,
      });
      await expect(chatPage).toContainText(COWORK_RESUME_MESSAGE);

      // Back on Home the consumed offer stays gone and the normal
      // suggestion window returns.
      await window.getByTestId('sidebar-create-task').click();
      await expect(home).toBeVisible();
      await expect(card).toHaveCount(0);
      await expect(suggestions).toBeVisible();
      await expect.poll(() => rows.count()).toBeGreaterThan(0);
      await expect
        .poll(() =>
          window.evaluate(
            () =>
              window.__resumeHomeFrames.filter(
                (frame) => !frame.resume && frame.rows > 0,
              ).length,
          ),
        )
        .toBeGreaterThan(1);
      const composerPositions = await window.evaluate(() =>
        window.__resumeHomeFrames
          .filter(
            (frame) => frame.rows > 0 && typeof frame.composerY === 'number',
          )
          .map((frame) => frame.composerY),
      );
      expect(composerPositions.length).toBeGreaterThan(1);
      expect(
        Math.max(...composerPositions) - Math.min(...composerPositions),
      ).toBeLessThanOrEqual(0.5);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('ranks attention above Last viewed and opens the exact chat (CAN-4958)', async () => {
    const userDataDir = seedAttentionData();
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const card = window
        .getByTestId('page-home')
        .getByTestId('home-resume-card');
      const question = card.getByTestId('home-continue-question-row');
      await expect(question).toBeVisible({ timeout: 15_000 });
      await expect(question).toHaveAttribute('data-chat-id', 'interactive');
      await expect(question).toContainText(
        'Release details is waiting for your answer',
      );
      await expect(question).toContainText(WORKSPACE_NAME);

      const unreadRows = card.getByTestId('home-continue-unread-row');
      await expect(unreadRows).toHaveCount(2);
      // The check icon says they finished: no summary heading, and the
      // status phrase is read by screen readers only.
      await expect(unreadRows.nth(0)).toContainText('Finished D finished');
      await expect(unreadRows.nth(1)).toContainText('Finished C finished');
      await expect(
        unreadRows.nth(0).getByText('finished', { exact: true }),
      ).toHaveClass('sr-only');
      await expect(
        card.getByTestId('home-continue-unread-summary'),
      ).toHaveCount(0);

      const order = await card
        .locator('[data-attention-kind], [data-testid="home-resume-details"]')
        .evaluateAll((elements) =>
          elements.map(
            (element) =>
              element.getAttribute('data-attention-kind') ?? 'last-viewed',
          ),
        );
      expect(order).toEqual(['question', 'unread', 'unread', 'last-viewed']);
      await expect(card.getByTestId('home-resume-button')).toContainText(
        'Last viewed:',
      );

      // Opening D must not read the worktree's restored active result C.
      await unreadRows.nth(0).getByRole('button').click();
      await app.expectMainPage();
      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await expect(unreadRows).toHaveCount(1);
      await expect(unreadRows.nth(0)).toContainText('Finished C');

      await question.getByRole('button').focus();
      await question.getByRole('button').press('Enter');
      await app.expectMainPage();
      const prompt = window.getByTestId('chat-question-prompt');
      await expect(prompt).toBeVisible({ timeout: 15_000 });
      await expect(
        prompt.getByRole('button', { name: 'Yes', exact: true }),
      ).toBeVisible();
      await expect(prompt).toBeInViewport();
      // Closing the composer prompt is a local presentation preference, not
      // dismissal of the question. Continue must reveal it again on arrival.
      await prompt.getByTestId('chat-question-close').click();
      await expect(prompt).toHaveCount(0);

      // Opening the question does not answer it: back on Home it is still
      // waiting, while Last viewed followed its usual clearing on navigation.
      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await expect(question).toBeVisible();
      await expect(card.getByTestId('home-resume-details')).toHaveCount(0);

      await question.getByRole('button').click();
      await expect(prompt).toBeInViewport();
      await window.getByTestId('sidebar-create-task').click();
      await expect(question).toBeVisible();

      // Resolve through the normal composer flow; navigation alone left it
      // pending, but delivering the answer removes it from Home.
      await question.getByRole('button').click();
      await expect(prompt).toBeInViewport();
      await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
      const composer = window
        .locator('[data-chat-composer-root]')
        .filter({ has: prompt });
      await composer.locator('[contenteditable=true]').fill('Example project');
      await composer.getByTestId('chat-question-send').click();
      await prompt
        .getByRole('button', { name: 'Staging', exact: true })
        .click();
      await expect(prompt).toHaveCount(0);
      await window.getByTestId('sidebar-create-task').click();
      await expect(question).toHaveCount(0);
      await expect(unreadRows).toHaveCount(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

async function getAdvisorUiState(electronApp) {
  const request = {
    kind: 'get_current_ui_state',
    requestId: `app-advisor-bulk-ui-state-${Date.now()}-${Math.random()}`,
  };
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      // The full App Advisor window hosts App Advisor's page as a view, so
      // its own contents are not the main renderer either.
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          candidate.getTitle() !== 'App Advisor' &&
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');

      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor UI state')),
          5_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, rendererRequest);
      });
    },
    request,
  );
}

test('Home section close and restore preserve the Continue destination', async () => {
  const userDataDir = seedResumeData();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    const home = window.getByTestId('page-home');
    const section = home.getByTestId('home-resume-card');
    await expect(section).toBeVisible();
    await expect
      .poll(
        async () =>
          (await getAdvisorUiState(electronApp)).uiState?.snapshot?.home
            ?.continueAttention?.lastViewedVisible,
      )
      .toBe(true);
    const destination = await section
      .getByTestId('home-resume-destination')
      .textContent();
    const more = section.getByRole('button', {
      name: 'More actions for Continue',
      exact: true,
    });
    await more.focus();
    await more.press('Enter');
    await window
      .getByRole('menuitem', { name: 'Hide section', exact: true })
      .press('Enter');
    await expect(section).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await getAdvisorUiState(electronApp)).uiState?.snapshot?.home
            ?.continueAttention,
      )
      .toBeUndefined();
    await expect
      .poll(
        async () =>
          (await getAdvisorUiState(electronApp)).uiState?.snapshot?.home
            ?.startupResumeOfferVisible,
      )
      .toBe(false);
    const restore = home.getByRole('button', {
      name: 'Show hidden sections (1)',
      exact: true,
    });
    await expect(restore).toBeFocused();
    await restore.press('Space');
    await expect(
      section.getByRole('heading', { name: 'Continue', exact: true }),
    ).toBeFocused();
    await expect(section.getByTestId('home-resume-destination')).toHaveText(
      destination,
    );
    await expect
      .poll(
        async () =>
          (await getAdvisorUiState(electronApp)).uiState?.snapshot?.home
            ?.continueAttention?.lastViewedVisible,
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await getAdvisorUiState(electronApp)).uiState?.snapshot?.home
            ?.startupResumeOfferVisible,
      )
      .toBe(true);
    await section.getByTestId('home-resume-button').click();
    await expect(window.getByTestId('page-main')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

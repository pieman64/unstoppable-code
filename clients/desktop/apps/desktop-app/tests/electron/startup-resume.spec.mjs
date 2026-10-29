import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
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
const WORKTREE_LABEL = 'New Task';

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
      await expect(details).toContainText(WORKTREE_LABEL);

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

  // CAN-4746: advanced Getting started suggestions used to replace the
  // Continue row entirely, so a returning user lost their way back.
  test('keeps Continue above one Getting started row on relaunch, then restores the window', async () => {
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
              '[data-testid^="home-onboarding-advanced-prompt-"]:not([data-testid*="-dismiss-"])',
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
      const suggestions = home.getByTestId('home-onboarding-advanced-prompts');
      const rows = suggestions.locator(
        '[data-testid^="home-onboarding-advanced-prompt-"]:not([data-testid*="-dismiss-"])',
      );
      await expect(suggestions).toBeVisible({ timeout: 15_000 });

      const card = home.getByTestId('home-resume-card');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId('home-resume-details')).toContainText(
        COWORK_RESUME_WORKSPACE_NAME,
      );

      // Continue sits directly below the composer, ahead of Getting started.
      const onboarding = home.getByTestId('home-onboarding-suggestions');
      expect(
        await card.evaluate(
          (resume, other) =>
            Boolean(
              resume.compareDocumentPosition(other) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          await onboarding.elementHandle(),
        ),
      ).toBe(true);
      const cardBox = await card.boundingBox();
      const onboardingBox = await onboarding.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(onboardingBox).not.toBeNull();
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(onboardingBox.y);

      await expect(rows).toHaveCount(1);
      await expect
        .poll(() =>
          window.evaluate(
            () =>
              window.__resumeHomeFrames.filter(
                (frame) => frame.resume && frame.rows === 1,
              ).length,
          ),
        )
        .toBeGreaterThan(1);
      expect(
        await window.evaluate(() =>
          window.__resumeHomeFrames.filter(
            (frame) => frame.resume && frame.rows > 1,
          ),
        ),
      ).toEqual([]);
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
      await expect.poll(() => rows.count()).toBeGreaterThan(1);
      await expect
        .poll(() =>
          window.evaluate(
            () =>
              window.__resumeHomeFrames.filter(
                (frame) => !frame.resume && frame.rows > 1,
              ).length,
          ),
        )
        .toBeGreaterThan(1);
      expect(
        await window.evaluate(() =>
          window.__resumeHomeFrames.filter(
            (frame) => frame.resume && frame.rows > 1,
          ),
        ),
      ).toEqual([]);
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
});

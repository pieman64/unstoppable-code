// Shared deterministic CAN-5006 flow for durable coverage and retained captures.
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from '../seeders/index.mjs';
import {
  mergeSeedPreferences,
  readPersistedPreferences,
} from '../seeders/mergePreferences.mjs';

export const IDLE_FIXTURE_VERSION = '99.0.0';

export function seedReleaseHighlightsResume() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5006-resume-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    tabs: [{ id: 'release-resume-chat', title: 'Release resume fixture' }],
  });
  // Seeders can rewrite preferences; preserve the upgrade watermark last.
  mergeSeedPreferences(userDataDir, {
    onboardingCompleted: ['v1'],
    legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
    legalConsentTosVersion: '2026-07-06',
    releaseHighlightsLastSeenVersion: '98.0.0',
    lastActiveContext: {
      kind: 'worktree',
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
    },
  });
  return userDataDir;
}

export async function startDelayedReleaseFeed() {
  let released = false;
  let requests = 0;
  let completions = 0;
  const pending = [];
  const server = createServer((req, res) => {
    if (
      new URL(req.url, 'http://localhost').pathname !== '/api/v1/release-notes'
    ) {
      res.writeHead(404).end();
      return;
    }
    requests += 1;
    res.once('finish', () => {
      completions += 1;
    });
    const respond = () => {
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              version: IDLE_FIXTURE_VERSION,
              releasedOn: '2026-01-01',
              headline: 'Release highlights fixture for {app}.',
              highlights: [
                { title: 'One fixture highlight' },
                { title: 'Another fixture highlight' },
                { title: 'Final fixture highlight' },
              ],
            },
          ],
        }),
      );
    };
    if (released) respond();
    else pending.push(respond);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const release = () => {
    released = true;
    for (const respond of pending.splice(0)) respond();
  };
  return {
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-release-notes-enabled': true,
      }),
      CANOPY_E2E_APP_VERSION: IDLE_FIXTURE_VERSION,
      CANOPY_E2E_CLOUD_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    },
    get requests() {
      return requests;
    },
    get completions() {
      return completions;
    },
    release,
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function installReleaseHighlightsFocus(window) {
  // Hidden native windows cannot own OS focus. Like notification-offer.spec,
  // simulate only application focus/visibility; real element focus is untouched.
  await window.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.__can5006Mounts = 0;
    const selector = '[data-testid="release-highlights-dialog"]';
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches(selector) || node.querySelector(selector))
          ) {
            window.__can5006Mounts += 1;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__can5006StopMountObserver = () => observer.disconnect();
  });
}

export async function exerciseReleaseHighlightsIdle(
  window,
  userDataDir,
  feed,
  { capture = async () => {}, before = false } = {},
) {
  const dialog = window.getByTestId('release-highlights-dialog');
  const home = window.getByTestId('page-home');
  await expect(home).toBeVisible();
  const resume = home.getByTestId('home-resume-button');
  await expect(resume).toBeVisible({ timeout: 15_000 });
  await installReleaseHighlightsFocus(window);
  await expect
    .poll(() => feed.requests, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await resume.hover();
  await capture('continue', home);
  await resume.click();
  await expect(window.getByTestId('page-main')).toBeVisible();
  const editor = window
    .getByTestId('panel-content-chat')
    .locator('[data-chat-textarea]:visible')
    .first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // Actual response completion, not just request arrival, is the barrier oracle.
  feed.release();
  await expect
    .poll(() => feed.completions, { timeout: 10_000 })
    .toBeGreaterThan(0);
  if (before) {
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await capture('interruption', window.locator('body'));
    return;
  }
  await expect(window.getByTestId('release-highlights-host')).toHaveAttribute(
    'data-status',
    /^(queued|presented)$/,
  );
  await expect(dialog).toHaveCount(0);
  await editor.fill('A draft that must never be interrupted');
  // Deliberately exceeds both the 1s quiet window and the 2s safety interval.
  await window.waitForTimeout(2_200);
  await expect(dialog).toHaveCount(0);
  expect(await window.evaluate(() => window.__can5006Mounts)).toBe(0);
  expect(
    readPersistedPreferences(userDataDir).releaseHighlightsLastSeenVersion,
  ).toBe('98.0.0');
  await capture('resumed-composer', window.getByTestId('page-main'));
  await editor.fill('');
  await window.getByTestId('sidebar-create-task').click();
  await expect(home).toBeVisible();
  await expect(
    home.locator('[data-chat-textarea]:visible').first(),
  ).toBeFocused();
  await window.waitForTimeout(1_100);
  await expect(dialog).toHaveCount(0);
  // Focus is explicitly established immediately before presentation.
  const known = window.getByTestId('sidebar-create-task');
  const focusedBeforePresentation = await known.evaluate((node) => {
    node.focus();
    return document.activeElement === node;
  });
  expect(focusedBeforePresentation).toBe(true);
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  expect(await window.evaluate(() => window.__can5006Mounts)).toBe(1);
  await expect
    .poll(
      () =>
        readPersistedPreferences(userDataDir).releaseHighlightsLastSeenVersion,
    )
    .toBe(IDLE_FIXTURE_VERSION);
  await capture('eventual-dialog', window.locator('body'));
  await window.getByTestId('release-highlights-got-it').click();
  await expect(dialog).toHaveCount(0);
  await expect(known).toBeFocused();
  await window.waitForTimeout(1_100);
  expect(await window.evaluate(() => window.__can5006Mounts)).toBe(1);
}

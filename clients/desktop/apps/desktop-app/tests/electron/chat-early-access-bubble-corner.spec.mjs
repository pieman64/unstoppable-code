// Early access: user bubble corner actions and the width-matched steps banner.
//
// On a narrow transcript (the App Advisor surface, phone layout tier below
// 640px) the user bubble shrinks to its text and sits flush right. Under
// early access the desktop puts its Copy and Revert badges on the bubble's
// top-right corner, with no clearance padding reserved inside the bubble, and
// the collapsed "Agent steps" banner below it takes the bubble's width and
// right edge. Without early access both keep develop's behavior: the badges
// sit inside the bubble behind `pr-9`/`pr-17` clearance, and the banner spans
// the column.
//
// Both depend on real layout (a viewport media query, the bubble's measured
// width, and a ResizeObserver), so this pins them in the real App Advisor
// surface, resized to 420px wide, rather than in jsdom.
//
// Determinism: the App Advisor transcript is seeded on disk with a completed
// turn (user prompt, two tool calls, a reply, and a turn timer). No live
// agents, no provider calls, no network.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';

const ENTRY_ID = 'bubble-corner-entry';
const CHAT_ID = 'bubble-corner-chat';
const PROMPT = 'Prepare the deployment report for the release team.';
const REPLY = 'The deployment report is ready for the release team.';
const BASE = Date.parse('2026-10-01T12:00:00.000Z');
/** Inside the phone layout tier (max-width: 639px). */
const NARROW_VIEWPORT = { width: 420, height: 760 };
const PHONE_MAX_WIDTH_PX = 639;

/**
 * Resizes the floating native view under early access, or the classic
 * window, so the renderer's own `matchMedia` reaches the phone layout tier.
 */
async function resizeAdvisorWindow(electronApp, advisor, size, earlyAccess) {
  if (earlyAccess) {
    await advisor.evaluate(
      (dimensions) => window.api.appAdvisor.setFloatingSize(dimensions),
      size,
    );
    return;
  }
  await electronApp.evaluate(({ BrowserWindow }, { width, height }) => {
    const advisorWindow = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!advisorWindow) throw new Error('App Advisor window not found');
    advisorWindow.setContentSize(width, height);
  }, size);
}

function seedAdvisorTranscript(userDataDir, { earlyAccess }) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
      // A narrow popout keeps its entry nav collapsed so the transcript
      // gets the window's width.
      appAdvisorNavCollapsed: true,
    },
  });
  if (earlyAccess) seedEarlyAccess({ userDataDir });

  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      {
        id: ENTRY_ID,
        createdAt: '2026-10-01T12:00:00.000Z',
        title: 'Deployment report',
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Deployment report',
        createdAt: '2026-10-01T12:00:00.000Z',
        providerType: 'claude',
        model: 'sonnet',
        messages: [
          {
            id: 'bubble-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: PROMPT }],
            timestamp: BASE,
          },
          ...[1, 2].map((step) => ({
            id: `bubble-tool-${step}`,
            role: 'assistant',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: `bubble-tool-use-${step}`,
                toolName: 'Bash',
                input: '{"command":"ls"}',
              },
            ],
            timestamp: BASE + step * 100,
          })),
          {
            id: 'bubble-reply-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: REPLY }],
            timestamp: BASE + 1_000,
          },
          {
            id: 'bubble-timer-1',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: BASE,
                completedAt: BASE + 2_000,
              },
            ],
            timestamp: BASE + 2_000,
          },
        ],
      },
    ],
  });
}

/**
 * Opens the App Advisor window from its default-layout row in the sidebar
 * nav, whether early access is on or off.
 */
async function openAdvisorWindow(electronApp, mainWindow) {
  const newWindowPromise = electronApp.waitForEvent('window');
  await mainWindow.getByTestId('sidebar-nav-app-advisor').click();
  const advisor = await newWindowPromise;
  await advisor.waitForLoadState('domcontentloaded');
  await expect(
    advisor.getByTestId('app-advisor-workspace-surface'),
  ).toBeVisible();
  await expect(
    advisor.getByTestId('app-advisor-workspace-loading'),
  ).toHaveCount(0, { timeout: 30_000 });
  return advisor;
}

async function openNarrowAdvisorTranscript({ earlyAccess }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bubble-corner-e2e-'),
  );
  seedAdvisorTranscript(userDataDir, { earlyAccess });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const mainWindow = await electronApp.firstWindow();
    const app = new CanopyAppDriver(mainWindow);
    await app.waitForShell({ timeout: 30_000 });
    const advisor = await openAdvisorWindow(electronApp, mainWindow);
    await resizeAdvisorWindow(
      electronApp,
      advisor,
      NARROW_VIEWPORT,
      earlyAccess,
    );
    const chatPanel = advisor.getByTestId(
      earlyAccess ? 'app-advisor-floating' : 'panel-content-chat',
    );
    await expect(chatPanel.getByText(REPLY)).toBeVisible({ timeout: 30_000 });
    const bubble = chatPanel
      .locator('[data-role="user"]')
      .filter({ hasText: PROMPT })
      .first();
    const bannerToggle = chatPanel
      .getByRole('button', { name: /^Agent steps:/ })
      .first();
    // The banner is the summary row that wraps the toggle, its outcome and
    // its chips; the toggle button only spans its own words. The row is
    // what takes the bubble's width.
    const banner = earlyAccess
      ? chatPanel.getByTestId('turn-work-header').first()
      : bannerToggle.locator('xpath=ancestor::*[@data-turn-summary-row][1]');
    await expect(bubble).toBeVisible();
    await expect(bannerToggle).toBeVisible();
    await expect(banner).toBeVisible();
    // The phone tier is what shrinks the bubble to its text.
    await expect
      .poll(() => advisor.evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(PHONE_MAX_WIDTH_PX);
    return { electronApp, userDataDir, bubble, banner };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir);
    throw error;
  }
}

/** Bubble, action-badge cluster, and steps banner geometry. */
async function readGeometry(bubble, banner) {
  const bubbleGeometry = await bubble.evaluate((wrapper) => {
    const copy = wrapper.querySelector(
      'button[aria-label="Copy your message"]',
    );
    let cluster = copy;
    while (cluster && cluster.parentElement !== wrapper) {
      cluster = cluster.parentElement;
    }
    const surface = wrapper.querySelector(
      '[data-testid="portal-chat-message-content"]',
    );
    if (!cluster || !surface) {
      throw new Error('Missing the bubble badge cluster or surface');
    }
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        width: box.width,
      };
    };
    return {
      wrapper: rect(wrapper),
      surface: rect(surface),
      cluster: rect(cluster),
      surfaceClasses: surface.className.split(/\s+/),
    };
  });
  const bannerRect = await banner.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width };
  });
  return { ...bubbleGeometry, banner: bannerRect };
}

test('Clean chat preserves corner bubble actions beneath a full-width work header', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, bubble, banner } =
    await openNarrowAdvisorTranscript({ earlyAccess: true });
  try {
    const geometry = await readGeometry(bubble, banner);
    const detail = JSON.stringify(geometry);

    // The phone-tier bubble is narrower than the column.
    expect(geometry.wrapper.width, detail).toBeLessThan(
      NARROW_VIEWPORT.width * 0.9,
    );

    // Actions overhang the bubble's top-right corner…
    expect(geometry.cluster.right, detail).toBeGreaterThan(
      geometry.surface.right,
    );
    expect(geometry.cluster.top, detail).toBeLessThan(geometry.surface.top);
    // …so the bubble reserves no clearance for them.
    expect(geometry.surfaceClasses, detail).not.toContain('pr-9');
    expect(geometry.surfaceClasses, detail).not.toContain('pr-17');

    // Clean chat's work header spans the turn rather than matching the
    // narrow user bubble. It still contains the bubble's horizontal bounds.
    expect(geometry.banner.width, detail).toBeGreaterThanOrEqual(
      geometry.wrapper.width,
    );
    expect(geometry.banner.left, detail).toBeLessThanOrEqual(
      geometry.wrapper.left + 1,
    );
    expect(geometry.banner.right, detail).toBeGreaterThanOrEqual(
      geometry.wrapper.right - 1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('without early access the bubble keeps its actions inside and the steps banner spans the column', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, bubble, banner } =
    await openNarrowAdvisorTranscript({ earlyAccess: false });
  try {
    const geometry = await readGeometry(bubble, banner);
    const detail = JSON.stringify(geometry);

    expect(geometry.wrapper.width, detail).toBeLessThan(
      NARROW_VIEWPORT.width * 0.9,
    );

    // Actions sit inside the bubble's bounds, behind reserved clearance.
    expect(geometry.cluster.right, detail).toBeLessThanOrEqual(
      geometry.surface.right,
    );
    expect(geometry.cluster.top, detail).toBeGreaterThanOrEqual(
      geometry.surface.top,
    );
    expect(
      geometry.surfaceClasses.some(
        (name) => name === 'pr-9' || name === 'pr-17',
      ),
      detail,
    ).toBe(true);

    // The banner is not width-matched: it spans the column, wider than the
    // flush-right bubble.
    expect(geometry.banner.width, detail).toBeGreaterThan(
      geometry.wrapper.width + 20,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

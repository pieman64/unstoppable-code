// @capture-keep: standing reusable visual evidence for the message bubble system
// @capture-reference: docs/chat-message-bubbles.md
// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// PR #2529 — chat message bubble restyle (visual evidence only).
//
// The user bubble moved from a 20%-accent tint to `rounded-xl bg-tertiary`
// with the UI-Kit `shadow-sm`, and its corner actions became circular
// bg-quaternary badges, joined on hover by a completion timestamp. The
// four-row clamp on long content is unchanged in intent, but it now measures
// real line boxes instead of `line-height × rows`, so the fourth row is
// actually rendered and faded rather than the cut landing a row early; its
// Show more pill is revealed on hover instead of sitting permanently over the
// text. These are judgement calls about surface and rhythm, so they need
// side-by-side captures rather than assertions.
//
// Stages:
//   CAN2529_STAGE=before — run against the unmodified tree. The gallery page
//                          does not exist there, so this stage captures the
//                          real seeded transcript only.
//   (default: after)     — captures the gallery catalog (collapsed and
//                          expanded long message, queued variants) plus the
//                          same transcript for a like-for-like comparison.
//
// Run both stages in both color modes:
//   CAN2529_STAGE=before pnpm run test:electron:captures can-2529-message-bubbles.capture-spec.ts --reporter=line
//   CAN2529_STAGE=before pnpm run test:electron:captures:built can-2529-message-bubbles.capture-spec.ts --reporter=line --dark-mode
//   # apply the change, then rebuild with `pnpm run build:e2e`
//   CAN2529_STAGE=after pnpm run test:electron:captures:built can-2529-message-bubbles.capture-spec.ts --reporter=line
//   CAN2529_STAGE=after pnpm run test:electron:captures:built can-2529-message-bubbles.capture-spec.ts --reporter=line --dark-mode
//
// Determinism: the gallery is a pure props-driven catalog and the transcript
// is seeded on disk — no live agents, no provider calls, no network. Captures
// disable animations.
//
// Dark-mode follow-up (Slack, Aug 31): the `bg-tertiary` bubble on a
// near-black `bg-base` had only the black `shadow-sm` to separate it, which
// is invisible there. The bubble now sits on `bg-quaternary` with an inset
// hairline on `--line-secondary`. Beyond the captures, the `after` stage
// asserts that on the seeded transcript from computed styles: the inset ring
// must be a non-transparent box-shadow, and the bubble's luminance must sit
// further from `bg-base` than the old `bg-tertiary` surface did (strictly in
// dark, where the two tokens differ; light keeps them both white).

const STAGE = process.env.CAN2529_STAGE === 'before' ? 'before' : 'after';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, and the
 * `color(display-p3 ...)` / `color(srgb ...)` forms the generated theme tokens
 * take on wide-gamut displays (Chromium keeps them unconverted in computed
 * style). P3 channels are read as sRGB: the contrast thresholds here are
 * coarse, and the gamut difference is well inside them.
 */
function parseCssColor(value: string): Rgba {
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((digit) => digit + digit).join('');
    }
    const channel = (offset: number): number =>
      Number.parseInt(digits.slice(offset, offset + 2), 16);
    return {
      r: channel(0),
      g: channel(2),
      b: channel(4),
      a: digits.length === 8 ? channel(6) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(([^)]*)\)$/i.exec(trimmed);
  if (rgb) {
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const predefined = /^color\((display-p3|srgb)\s+([^)]*)\)$/i.exec(trimmed);
  if (predefined) {
    const parts = predefined[2]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number);
    return {
      r: Math.round(parts[0] * 255),
      g: Math.round(parts[1] * 255),
      b: Math.round(parts[2] * 255),
      a: parts[3] ?? 1,
    };
  }
  throw new Error(`Unparseable CSS color: ${value}`);
}

/** WCAG relative luminance of an opaque sRGB color, in [0, 1]. */
function relativeLuminance({ r, g, b }: Rgba): number {
  const linear = (channel: number): number => {
    const scaled = channel / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

interface BubbleSurfaceMetrics {
  dark: boolean;
  backgroundColor: string;
  boxShadow: string;
  bgBase: string;
  bgTertiary: string;
}

/**
 * The inset-ring segment of a computed `box-shadow`. Chromium serializes
 * each shadow as `<color> <offsets> [inset]`, comma-separated, and colors
 * carry their own commas inside parentheses.
 */
function insetShadowSegment(boxShadow: string): string | undefined {
  return boxShadow
    .split(/,(?![^(]*\))/)
    .map((segment) => segment.trim())
    .find((segment) => segment.endsWith('inset'));
}

function expectBubbleSeparatedFromBase(metrics: BubbleSurfaceMetrics): void {
  const inset = insetShadowSegment(metrics.boxShadow);
  expect(
    inset,
    `bubble box-shadow should carry an inset hairline; got: ${metrics.boxShadow}`,
  ).toBeDefined();
  const ringColor = /color\([^)]*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}/i.exec(
    inset ?? '',
  )?.[0];
  expect(
    ringColor,
    `inset segment should name a color: ${inset}`,
  ).toBeDefined();
  expect(parseCssColor(ringColor ?? '').a).toBeGreaterThan(0);

  const base = relativeLuminance(parseCssColor(metrics.bgBase));
  const bubbleDelta = Math.abs(
    relativeLuminance(parseCssColor(metrics.backgroundColor)) - base,
  );
  const previousDelta = Math.abs(
    relativeLuminance(parseCssColor(metrics.bgTertiary)) - base,
  );
  if (metrics.dark) {
    expect(
      bubbleDelta,
      `dark bubble ${metrics.backgroundColor} should sit further from bg-base ${metrics.bgBase} than bg-tertiary ${metrics.bgTertiary} did`,
    ).toBeGreaterThan(previousDelta);
  } else {
    expect(bubbleDelta).toBeGreaterThanOrEqual(previousDelta);
  }
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-2529');

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

/**
 * A seeded two-turn transcript. This is the comparable surface: it renders in
 * BOTH stages, so the before/after pair actually shows the bubble restyle
 * rather than only the presence of a new gallery page.
 */
function seedTranscript(userDataDir: string): void {
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: 'can-2529-chat',
        title: 'Bubble surface',
        providerType: 'claude',
        messages: [
          {
            id: 'user-0',
            role: 'user',
            timestamp: 1_700_000_000_000,
            blocks: [
              { type: 'text', text: 'Restyle the chat message bubbles.' },
            ],
          },
          {
            id: 'assistant-0',
            role: 'assistant',
            timestamp: 1_700_000_000_500,
            blocks: [
              {
                type: 'text',
                text: 'Done — the bubble now uses the shared tertiary surface with the UI-Kit shadow, and the corner actions match the voice indicator.',
              },
            ],
          },
          {
            id: 'timer-0',
            role: 'system',
            timestamp: 1_700_000_001_000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: 1_700_000_000_000,
                completedAt: 1_700_000_001_000,
              },
            ],
          },
        ],
      },
    ],
  });
}

test('message bubble surface captures', async () => {
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2529-capture-'),
  );
  seedDemoWorkspaces({ userDataDir });
  seedTranscript(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Stage-independent: the real transcript, which is the like-for-like
    // before/after comparison of the bubble surface itself.
    await app.openMainPage();
    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();
    const transcript = window.getByTestId('chat-message-list-content');
    await expect(transcript).toBeVisible({ timeout: 20_000 });
    await transcript.screenshot({
      path: path.join(captureDir, `transcript-${STAGE}.png`),
      animations: 'disabled',
    });

    if (STAGE === 'after') {
      // Computed-style evidence for the dark-mode separation, read off the
      // real sent bubble rather than the class list (`border-*` is inert in
      // this app and a class name proves nothing about paint).
      const surface = transcript
        .locator('[data-testid="portal-chat-message-content"]')
        .first();
      await expect(surface).toBeVisible();
      const metrics = await surface.evaluate(
        (element: Element): BubbleSurfaceMetrics => {
          const style = getComputedStyle(element);
          const root = getComputedStyle(document.documentElement);
          return {
            dark: document.documentElement.classList.contains('dark'),
            backgroundColor: style.backgroundColor,
            boxShadow: style.boxShadow,
            bgBase: root.getPropertyValue('--bg-base'),
            bgTertiary: root.getPropertyValue('--bg-tertiary'),
          };
        },
      );
      expectBubbleSeparatedFromBase(metrics);
    }

    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();

    if (STAGE === 'before') {
      // The gallery is introduced by this change, so its absence is the
      // evidence that the surface is new.
      await expect(
        window.getByTestId('sidebar-more-item-message-bubble-states'),
      ).toHaveCount(0);
      await window.getByTestId('sidebar-more-menu').screenshot({
        path: path.join(captureDir, `more-menu-${STAGE}.png`),
        animations: 'disabled',
      });
      return;
    }

    // Every dev page lives behind one More entry with tabs.
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-message-bubble-states').click();
    const page = window.getByTestId('page-message-bubble-states');
    await expect(page).toBeVisible();

    // The user-bubble catalog: surface, corner badges, insets, and the
    // clamped long message with its Show more control.
    const userSection = window.getByTestId(
      'bubble-gallery-section-user-bubbles',
    );
    await expect(userSection).toBeVisible();
    await userSection.screenshot({
      path: path.join(captureDir, `user-bubbles-${STAGE}.png`),
      animations: 'disabled',
    });

    // Collapsed at rest, collapsed under hover, then expanded — a triple,
    // because the cut row and the pill that reveals over it are the whole
    // point and the pill is invisible at rest.
    const longRow = window.getByTestId('bubble-gallery-row-very-long');
    await longRow.screenshot({
      path: path.join(captureDir, `long-collapsed-${STAGE}.png`),
      animations: 'disabled',
    });
    await longRow.getByTestId('user-message-content').hover();
    await longRow.screenshot({
      path: path.join(captureDir, `long-collapsed-hover-${STAGE}.png`),
      animations: 'disabled',
    });
    await longRow.getByTestId('user-message-show-more').click();
    await expect(longRow.getByTestId('user-message-show-less')).toContainText(
      'Show less',
    );
    await longRow.screenshot({
      path: path.join(captureDir, `long-expanded-${STAGE}.png`),
      animations: 'disabled',
    });
    await longRow.getByTestId('user-message-show-less').click();

    // Hover reveals the corner action badges (copy/revert), which are the
    // restyled chrome this change shares with the queued bubble.
    await longRow.hover();
    await longRow.screenshot({
      path: path.join(captureDir, `bubble-hover-actions-${STAGE}.png`),
      animations: 'disabled',
    });

    const queuedSection = window.getByTestId(
      'bubble-gallery-section-queued-bubbles',
    );
    await expect(queuedSection).toBeVisible();
    await queuedSection.screenshot({
      path: path.join(captureDir, `queued-bubbles-${STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
